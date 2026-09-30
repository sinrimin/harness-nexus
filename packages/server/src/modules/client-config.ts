import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Credential, McpServer, McpTransport, Profile } from '@harness-nexus/core';
import {
  AppError,
  resolveDialSite,
  resolvePlaceholders,
  runtimeTargetSchema,
  transportPlaceholderNames,
  type ClientMcpConfig,
} from '@harness-nexus/shared';
import { decryptSecret, hashToken, PAT_PREFIX } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';

/**
 * Client config fetch (Phase 8 C2) — `GET /api/client/mcp-config?profile=<id>`.
 *
 * The single REST surface a `hnx mcp serve` shim talks to before serving an
 * agent tool. Auth is resolved HERE (not by the instance-level requireAuth
 * guard): an api PAT / JWT authenticates as its user, and — the one REST
 * exception for machine tokens — a `machine-ctl` PAT authenticates as its
 * machine's owner. Profile visibility follows the caller.
 *
 * Secret flow (the locked policy): transports are resolved to plaintext for
 * CLIENT-dialed servers only — which by derivation reference exclusively
 * distributable credentials. Server-dialed servers are listed without a
 * transport; the shim reaches them via the `/mcp` outlet. The plaintext of a
 * non-distributable credential NEVER enters any response here.
 */
export async function clientConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/client/mcp-config', async (req: FastifyRequest, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const profileId = (req.query as { profile?: string }).profile;
    if (!profileId) {
      throw new AppError('A profile query parameter is required', 400, 'PROFILE_REQUIRED');
    }
    const profile = await app.uow.profiles.findById(profileId);
    if (!profile || !visibleProfile(profile, caller.userId)) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }

    const key = app.credentialEncryptionKey;

    // #21: `${cred:NAME}` resolves within the SERVER ROW owner's namespace
    // (their personal rows shadow same-named global rows) so dial-site
    // derivation and decryption agree, and a same-named credential owned by
    // another tenant never decrypts here.
    const dialSiteFor = async (server: McpServer): Promise<'client' | 'server'> => {
      const dist = new Map<string, boolean>();
      for (const name of transportPlaceholderNames(server.transport)) {
        const cred = await findCredentialForOwner(app.uow, name, server.ownerId);
        dist.set(name, cred?.distributable === true);
      }
      return resolveDialSite(server, (name) => dist.get(name) === true);
    };

    const resolve = (input: string, ownerId: string | null): Promise<string> =>
      resolvePlaceholders(input, async (name) => {
        const cred: Credential | null = await findCredentialForOwner(app.uow, name, ownerId);
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
      const server = await app.uow.mcpServers.findById(entry.resourceId);
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

    const config: ClientMcpConfig = {
      profileId: profile.id,
      platform: anyServerDialed ? { baseUrl: app.publicBaseUrl } : null,
      servers,
    };
    return reply.send(config);
  });

  // ---- GET /api/client/deploy-bundle?profile=<id> (C4) ----
  // The resolved profile bundle a daemon's deploy job needs — exactly what
  // the CLI resolver would otherwise fetch N+1. Machine PAT exception #2:
  // same auth + visibility treatment as /api/client/mcp-config.
  app.get('/api/client/deploy-bundle', async (req, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const profileId = (req.query as { profile?: string }).profile;
    if (!profileId) {
      throw new AppError('A profile query parameter is required', 400, 'PROFILE_REQUIRED');
    }
    const profile = await app.uow.profiles.findById(profileId);
    if (!profile || !visibleProfile(profile, caller.userId)) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }

    const artifacts: unknown[] = [];
    for (const entry of profile.entries) {
      // Soft-deleted (or already physically removed) rows are skipped, not
      // fatal — two-stage delete keeps profiles deployable with dangling refs.
      if (entry.kind === 'mcp') {
        const server = await app.uow.mcpServers.findById(entry.resourceId);
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
        const resource = await app.uow.resources.findById(entry.resourceId);
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
    return reply.send({ profile, artifacts });
  });

  // ---- GET /api/client/runtime-config?target=<t> (Phase 9 W3) ----
  // The resolved provider bundle an apply-config job's daemon executor needs.
  // Machine PAT exception #3 — and the TIGHTEST one: this is the only surface
  // that ever carries the spec's plaintext, so a non-machine caller gets a
  // flat 404 (no existence leak), and even the machine PAT only ever sees its
  // OWN machine's row. Re-resolved on every fetch so a requeued job after a
  // credential rotation picks up the new value.
  app.get('/api/client/runtime-config', async (req, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    if (caller.machineId === undefined) {
      throw new AppError('Runtime config not found', 404, 'RUNTIME_CONFIG_NOT_FOUND');
    }
    const target = (req.query as { target?: string }).target;
    const parsedTarget = runtimeTargetSchema.safeParse(target);
    if (!parsedTarget.success) {
      throw new AppError('A target query parameter is required', 400, 'TARGET_REQUIRED');
    }
    const row = await app.uow.runtimeConfigs.findByMachineAndTarget(
      caller.machineId,
      parsedTarget.data,
    );
    if (!row) {
      throw new AppError('Runtime config not found', 404, 'RUNTIME_CONFIG_NOT_FOUND');
    }
    const cred = await findCredentialForOwner(app.uow, row.spec.credentialName, caller.userId);
    if (!cred || !cred.distributable) {
      // Deleted or locked since the PUT — the honest failure for the executor.
      throw new AppError(
        `Credential "${row.spec.credentialName}" is missing or no longer distributable`,
        409,
        'CREDENTIAL_NOT_DISTRIBUTABLE',
      );
    }
    const secret = decryptSecret(cred.secret, app.credentialEncryptionKey);
    return reply.send({ target: row.target, spec: row.spec, secret });
  });
}

/**
 * Resolve the caller from the Authorization header. Machine PATs
 * (`machine-ctl`) map to their machine's owner — the ONLY REST surfaces they
 * unlock (mcp-config + deploy-bundle); the root auth hook rejects them
 * everywhere else. Marketplace tokens
 * are rejected (their blast radius is the emitter URL only).
 */
async function resolveClientCaller(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ userId: string; role: 'admin' | 'user'; machineId?: string } | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const raw = header.slice('Bearer '.length).trim();

  if (raw.startsWith(PAT_PREFIX)) {
    const record = await app.uow.tokens.findByTokenHash(hashToken(raw));
    if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) return null;
    if (record.scopes.includes('marketplace')) return null;

    if (record.scopes.includes('machine-ctl')) {
      const machine = await app.uow.machines.findByEnrollmentPatId(record.id);
      if (!machine) return null;
      const user = await app.uow.users.findById(machine.ownerId);
      return user?.status === 'active'
        ? { userId: user.id, role: user.role, machineId: machine.id }
        : null;
    }
    const user = await app.uow.users.findById(record.userId);
    return user?.status === 'active' ? { userId: user.id, role: user.role } : null;
  }

  try {
    const payload = await app.jwt.verifyAccessToken(raw);
    const user = await app.uow.users.findById(payload.sub);
    return user?.status === 'active' ? { userId: user.id, role: user.role } : null;
  } catch {
    return null;
  }
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
