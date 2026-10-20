// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type {
  Credential,
  McpServer,
  McpTransport,
  Profile,
  Resource,
  RuntimeConfigSpecData,
} from '@harness-nexus/core';
import {
  AppError,
  resolveDialSite,
  resolvePlaceholders,
  runtimeTargetSchema,
  transportPlaceholderNames,
  type ClientMcpConfig,
} from '@harness-nexus/shared';
import { decryptSecret } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import type { ServiceDeps } from './principal.js';

/**
 * Client-config domain service (#53 slice 15, Phase 8 C2/C4 + 9 W3) — the
 * DECISION + RESOLUTION half of the machine-PAT surface: profile/entry
 * visibility, bundle assembly, credential resolution and decryption into the
 * bundle, dial-site filtering, and the mcp-config shape. Extracted verbatim
 * from the route handlers; only the door changed.
 *
 * What deliberately stays at the route (residue): caller AUTHENTICATION —
 * `resolveClientCaller` maps a `machine-ctl` PAT to its machine's owner (the
 * one REST exception) and is Fastify/jwt-coupled — plus the reply framing.
 *
 * Secret flow (the locked policy): transports are resolved to plaintext for
 * CLIENT-dialed servers only — which by derivation reference exclusively
 * distributable credentials. Server-dialed servers are listed without a
 * transport; the shim reaches them via the `/mcp` outlet. The plaintext of a
 * non-distributable credential NEVER enters any result built here.
 */

/**
 * Who is calling the client surface: an api PAT / JWT user, or — the machine
 * PAT exception — a `machine-ctl` token mapped to its machine's owner with
 * the machine pinned. Resolved at the route; consumed here.
 */
export interface ClientCaller {
  userId: string;
  role: 'admin' | 'user';
  machineId?: string;
}

/**
 * Per-call deps: the AES-GCM key material (the bundle decrypts the referenced
 * secret server-side) and the public base URL (the outlet arm) — both
 * app-decorated config, threaded by the caller (services stay env-free).
 */
export interface ClientConfigDeps extends ServiceDeps {
  credentialEncryptionKey: string;
  publicBaseUrl: string;
}

/** Substitute placeholders in a CLIENT-dialed transport (stdio included). */
async function resolveTransport(
  t: McpTransport,
  resolve: (input: string) => Promise<string>,
): Promise<Extract<ClientMcpConfig['servers'][number], { dialSite: 'client' }>['transport']> {
  if (t.type === 'stdio') {
    return {
      type: 'stdio',
      command: await resolve(t.command),
      ...(t.args ? { args: await Promise.all(t.args.map(resolve)) } : {}),
      ...(t.env
        ? {
            env: Object.fromEntries(
              await Promise.all(
                Object.entries(t.env).map(async ([k, v]) => [k, await resolve(v)] as const),
              ),
            ),
          }
        : {}),
    };
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers ?? {})) {
    headers[k] = await resolve(v);
  }
  return {
    type: t.type,
    url: await resolve(t.url),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function visibleProfile(profile: Profile, userId: string): boolean {
  return profile.scope === 'global' || profile.ownerId === userId;
}

function visibleServer(server: McpServer, userId: string): boolean {
  return server.scope === 'global' || server.ownerId === userId;
}

/** A visible profile or the 404 (the query parameter itself is a 400). */
async function getVisibleProfile(
  deps: ClientConfigDeps,
  caller: ClientCaller,
  profileId: string | undefined,
): Promise<Profile> {
  if (!profileId) {
    throw new AppError('A profile query parameter is required', 400, 'PROFILE_REQUIRED');
  }
  const profile = await deps.uow.profiles.findById(profileId);
  if (!profile || !visibleProfile(profile, caller.userId)) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }
  return profile;
}

/**
 * `GET /api/client/mcp-config?profile=` — the world model a `hnx mcp serve`
 * shim boots from: client-dialed servers with RESOLVED transports (plaintext
 * included), server-dialed servers by name only, plus the outlet arm when any
 * server is server-dialed.
 */
export async function buildClientMcpConfig(
  deps: ClientConfigDeps,
  caller: ClientCaller,
  profileId: string | undefined,
): Promise<ClientMcpConfig> {
  const profile = await getVisibleProfile(deps, caller, profileId);

  const key = deps.credentialEncryptionKey;

  // #21: `${cred:NAME}` resolves within the SERVER ROW owner's namespace
  // (their personal rows shadow same-named global rows) so dial-site
  // derivation and decryption agree, and a same-named credential owned by
  // another tenant never decrypts here.
  const dialSiteFor = async (server: McpServer): Promise<'client' | 'server'> => {
    const dist = new Map<string, boolean>();
    for (const name of transportPlaceholderNames(server.transport)) {
      const cred = await findCredentialForOwner(deps.uow, name, server.ownerId);
      dist.set(name, cred?.distributable === true);
    }
    return resolveDialSite(server, (name) => dist.get(name) === true);
  };

  const resolve = (input: string, ownerId: string | null): Promise<string> =>
    resolvePlaceholders(input, async (name) => {
      const cred: Credential | null = await findCredentialForOwner(deps.uow, name, ownerId);
      if (!cred) {
        throw new AppError(
          `credential "${name}" not found (referenced by a profile entry)`,
          409,
          'CREDENTIAL_NOT_FOUND',
        );
      }
      if (!cred.distributable) {
        throw new AppError(
          `credential "${name}" is no longer distributable (referenced by a profile entry)`,
          409,
          'CREDENTIAL_NOT_DISTRIBUTABLE',
        );
      }
      return decryptSecret(cred.secret, key);
    });

  const servers: ClientMcpConfig['servers'] = [];
  let anyServerDialed = false;
  for (const entry of profile.entries) {
    if (entry.kind !== 'mcp') continue;
    const server = await deps.uow.mcpServers.findById(entry.resourceId);
    // Soft-deleted (or already physically removed) rows are skipped, not
    // fatal — two-stage delete keeps profiles deployable with dangling refs.
    if (!server || server.deletedAt !== undefined) continue;
    if (!visibleServer(server, caller.userId)) {
      throw new AppError(
        'A profile entry references an MCP server you cannot access',
        403,
        'PROFILE_ENTRY_NOT_ACCESSIBLE',
      );
    }
    const site = await dialSiteFor(server);
    if (site === 'server') {
      anyServerDialed = true;
      servers.push({ id: server.id, name: server.name, dialSite: 'server' });
      continue;
    }
    servers.push({
      id: server.id,
      name: server.name,
      dialSite: 'client',
      transport: await resolveTransport(server.transport, (input) =>
        resolve(input, server.ownerId),
      ),
    });
  }

  return {
    profileId: profile.id,
    platform: anyServerDialed ? { baseUrl: deps.publicBaseUrl } : null,
    servers,
  };
}

/** One resolved artifact of a deploy bundle. */
export type DeployBundleArtifact =
  | { entryId: string; kind: 'mcp'; mcpServer: McpServer }
  | { entryId: string; kind: Resource['kind']; resource: Resource };

export interface DeployBundle {
  profile: Profile;
  artifacts: DeployBundleArtifact[];
}

/**
 * `GET /api/client/deploy-bundle?profile=` (C4) — the resolved profile bundle
 * a daemon's deploy job needs, exactly what the CLI resolver would otherwise
 * fetch N+1. Same visibility treatment as the mcp-config: soft-deleted rows
 * skip, invisible rows 403.
 */
export async function buildDeployBundle(
  deps: ClientConfigDeps,
  caller: ClientCaller,
  profileId: string | undefined,
): Promise<DeployBundle> {
  const profile = await getVisibleProfile(deps, caller, profileId);

  const artifacts: DeployBundleArtifact[] = [];
  for (const entry of profile.entries) {
    // Soft-deleted (or already physically removed) rows are skipped, not
    // fatal — two-stage delete keeps profiles deployable with dangling refs.
    if (entry.kind === 'mcp') {
      const server = await deps.uow.mcpServers.findById(entry.resourceId);
      if (!server || server.deletedAt !== undefined) continue;
      if (!visibleServer(server, caller.userId)) {
        throw new AppError(
          'A profile entry references an MCP server you cannot access',
          403,
          'PROFILE_ENTRY_NOT_ACCESSIBLE',
        );
      }
      artifacts.push({ entryId: entry.resourceId, kind: 'mcp', mcpServer: server });
    } else {
      const resource = await deps.uow.resources.findById(entry.resourceId);
      if (!resource || resource.deletedAt !== undefined) continue;
      if (
        resource.kind !== entry.kind ||
        !(resource.scope === 'global' || resource.ownerId === caller.userId)
      ) {
        throw new AppError(
          'A profile entry references a resource you cannot access',
          403,
          'PROFILE_ENTRY_NOT_ACCESSIBLE',
        );
      }
      artifacts.push({ entryId: entry.resourceId, kind: entry.kind, resource });
    }
  }
  return { profile, artifacts };
}

export interface RuntimeConfigBundle {
  target: string;
  spec: RuntimeConfigSpecData;
  secret: string;
}

/**
 * `GET /api/client/runtime-config?target=` (Phase 9 W3) — the TIGHTEST machine
 * PAT exception: the only surface that ever carries the spec's plaintext, so
 * a non-machine caller gets a flat 404 (no existence leak), and even the
 * machine PAT only ever sees its OWN machine's row. Re-resolved on every
 * fetch so a requeued job after a credential rotation picks up the new value.
 */
export async function buildRuntimeConfigBundle(
  deps: ClientConfigDeps,
  caller: ClientCaller,
  target: string | undefined,
): Promise<RuntimeConfigBundle> {
  if (caller.machineId === undefined) {
    throw new AppError('Runtime config not found', 404, 'RUNTIME_CONFIG_NOT_FOUND');
  }
  const parsedTarget = runtimeTargetSchema.safeParse(target);
  if (!parsedTarget.success) {
    throw new AppError('A target query parameter is required', 400, 'TARGET_REQUIRED');
  }
  const row = await deps.uow.runtimeConfigs.findByMachineAndTarget(
    caller.machineId,
    parsedTarget.data,
  );
  if (!row) {
    throw new AppError('Runtime config not found', 404, 'RUNTIME_CONFIG_NOT_FOUND');
  }
  const cred = await findCredentialForOwner(deps.uow, row.spec.credentialName, caller.userId);
  if (!cred || !cred.distributable) {
    // Deleted or locked since the PUT — the honest failure for the executor.
    throw new AppError(
      `Credential "${row.spec.credentialName}" is missing or no longer distributable`,
      409,
      'CREDENTIAL_NOT_DISTRIBUTABLE',
    );
  }
  const secret = decryptSecret(cred.secret, deps.credentialEncryptionKey);
  return { target: row.target, spec: row.spec, secret };
}
