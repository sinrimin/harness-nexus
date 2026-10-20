// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type {
  Machine,
  MachineInventorySnapshot,
  McpServer,
  McpTransport,
  Profile,
  ProfileEntry,
  Resource,
  ResourceSource,
} from '@harness-nexus/core';
import {
  AppError,
  diffInventory,
  isUnsafeRelativePath,
  transportPlaceholderNames,
  type CaptureMachineInventoryInput,
  type ImportMachineInventoryInput,
  type InventoryArtifact,
  type InventoryDiff,
  type InventoryDiffEntry,
  type InventoryItem,
  type InventoryPayloadEvent,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import { getMachine } from './machines.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Machine inventory, diff & one-click import domain service (#53 slice 3) —
 * Phase 8 C3 plus W1's capture-as-profile, extracted verbatim from the route
 * handlers. wiki design-phase-8-c3.md · phase-9-harness-runtime.md.
 *
 * All operations hang off a machine and inherit its owner-only guard with 404
 * existence-hiding (#36: admins are not tenant overseers). Scan and the
 * collect half of import are direct request/response flows over /ctl — those
 * realtime round-trips stay at the route (it calls the resolve* functions for
 * the decisions, performs the collect, then hands the bodies to
 * `bundleImport`).
 *
 * Import creates resources with reuse-or-create semantics — an identical body
 * under the same key is REUSED, so re-importing an unchanged machine is
 * idempotent; a changed body lands under a suffixed key. MCP items become
 * McpServer rows (never resources — the 4.2 rule), with env/header values
 * already redacted to `${cred:<KEY>}` placeholders daemon-side.
 */

/** The outcome of an import/capture: the bundled profile + per-item ledger. */
export interface ImportResult {
  profile: Profile;
  created: { kind: string; name: string; id: string; key?: string }[];
  reused: { kind: string; name: string; id: string; key?: string }[];
  failed: { kind: string; name: string; error: string }[];
  warnings: string[];
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'imported'
  );
}

/** Latest snapshots per target for the owner's machine. */
export async function listMachineInventory(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
): Promise<MachineInventorySnapshot[]> {
  const machine = await getMachine(deps, principal, machineId);
  return deps.uow.inventories.list(machine.id);
}

/** Diff a profile's entries against the machine's latest snapshot (per target). */
export async function diffMachineInventory(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
  profileId: string | undefined,
): Promise<InventoryDiff> {
  const machine = await getMachine(deps, principal, machineId);
  if (!profileId) throw new AppError('profile query param required', 400, 'PROFILE_REQUIRED');

  const profile = await deps.uow.profiles.findById(profileId);
  const profileVisible =
    profile && (profile.scope === 'global' || profile.ownerId === principal.userId);
  if (!profile || !profileVisible) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }
  const snapshot = await deps.uow.inventories.findLatest(machine.id, profile.target);
  if (!snapshot) {
    throw new AppError(
      `No ${profile.target} inventory for this machine — scan first`,
      404,
      'INVENTORY_NOT_SCANNED',
    );
  }

  // Resolve entries to {kind, name} pairs; mcp entries carry the McpServer
  // name (stored as {resourceId: serverId, kind: 'mcp'} since 2.2). Hook
  // entries are skipped — no target has a hook scanner in C3, so they can
  // never match and would read as permanent drift.
  const entries: { kind: InventoryDiffEntry['kind']; name: string }[] = [];
  for (const entry of profile.entries) {
    if (entry.kind === 'hook') continue;
    if (entry.kind === 'mcp') {
      const server = await deps.uow.mcpServers.findById(entry.resourceId);
      entries.push({ kind: 'mcp', name: server?.name ?? `#${entry.resourceId}` });
    } else {
      const resource = await deps.uow.resources.findById(entry.resourceId);
      entries.push({ kind: entry.kind, name: resource?.name ?? `#${entry.resourceId}` });
    }
  }
  const items: InventoryItem[] = snapshot.agents.flatMap((a) => a.items);
  const body = diffInventory(entries, items);
  return { profileId: profile.id, target: profile.target, ...body };
}

/**
 * Import phase 1 (after the route's online/capability gate): load the latest
 * snapshot for the target and validate every selected item against it. The
 * machine must already have been resolved through `getMachine` (the owner
 * door) by the caller.
 */
export async function resolveImportSelection(
  deps: ServiceDeps,
  machine: Machine,
  input: ImportMachineInventoryInput,
): Promise<MachineInventorySnapshot> {
  const snapshot = await requireSnapshot(deps, machine.id, input.target);
  const byKey = new Map(
    snapshot.agents.flatMap((a) => a.items).map((item) => [`${item.kind}:${item.name}`, item]),
  );
  for (const sel of input.items) {
    const item = byKey.get(`${sel.kind}:${sel.name}`);
    if (!item) {
      throw new AppError(
        `${sel.kind} '${sel.name}' is not in the latest snapshot — rescan`,
        409,
        'INVENTORY_ITEM_MISSING',
      );
    }
    if (!item.importable) {
      throw new AppError(
        `${sel.kind} '${sel.name}' is not importable (${item.note ?? 'unknown reason'})`,
        409,
        'INVENTORY_ITEM_NOT_IMPORTABLE',
      );
    }
  }
  return snapshot;
}

/**
 * Capture phase 1 (after the route's online/capability gate): the latest
 * snapshot plus its importable items as the selection — the C3 collect+import
 * pipeline invoked WITHOUT a diff baseline. An Agent in default state captures
 * as a profile with zero entries.
 */
export async function resolveCaptureSelection(
  deps: ServiceDeps,
  machine: Machine,
  input: CaptureMachineInventoryInput,
): Promise<{
  snapshot: MachineInventorySnapshot;
  items: { kind: InventoryItem['kind']; name: string }[];
}> {
  const snapshot = await requireSnapshot(deps, machine.id, input.target);
  const items = snapshot.agents
    .flatMap((a) => a.items)
    .filter((item) => item.importable)
    .map((item) => ({ kind: item.kind, name: item.name }));
  return { snapshot, items };
}

async function requireSnapshot(
  deps: ServiceDeps,
  machineId: string,
  target: MachineInventorySnapshot['target'],
): Promise<MachineInventorySnapshot> {
  const snapshot = await deps.uow.inventories.findLatest(machineId, target);
  if (!snapshot) {
    throw new AppError(
      `No ${target} inventory for this machine — scan first`,
      404,
      'INVENTORY_NOT_SCANNED',
    );
  }
  return snapshot;
}

/** The `bundleImport` arguments: everything the persist phase needs. */
export interface BundleImportArgs {
  machine: Machine;
  snapshot: MachineInventorySnapshot;
  target: MachineInventorySnapshot['target'];
  profileName: string;
  /** Collected bodies from the daemon (empty selection → empty list). */
  payloadItems: InventoryPayloadEvent['items'];
  mode: 'import' | 'capture';
}

/**
 * Import/capture phase 2: reuse-or-create resources + MCP rows from the
 * collected bodies, bundle everything into a personal profile. Capture
 * (`mode: 'capture'`, Phase 9 W1) also bundles an Agent in default state into
 * a zero-entry profile.
 */
export async function bundleImport(
  deps: ServiceDeps,
  args: BundleImportArgs,
): Promise<ImportResult> {
  const { machine, snapshot, target, profileName, payloadItems, mode } = args;
  const byKey = new Map(
    snapshot.agents.flatMap((a) => a.items).map((item) => [`${item.kind}:${item.name}`, item]),
  );

  const created: ImportResult['created'] = [];
  const reused: ImportResult['reused'] = [];
  const failed: ImportResult['failed'] = [];
  const warnings = new Set<string>();
  const entries: ProfileEntry[] = [];

  const noteMissingCredentials = async (
    transport: McpTransport,
    ownerId: string | null,
  ): Promise<void> => {
    for (const name of transportPlaceholderNames(transport)) {
      const cred = await findCredentialForOwner(deps.uow, name, ownerId);
      if (!cred) {
        warnings.add(
          `Credential '${name}' is referenced but not defined — create it before this server connects`,
        );
      }
    }
  };

  for (const part of payloadItems) {
    try {
      if (!part.ok || !part.artifact) {
        failed.push({
          kind: part.kind,
          name: part.name,
          error: part.error ?? 'collection failed',
        });
        continue;
      }
      const artifact: InventoryArtifact = part.artifact;

      if (artifact.kind === 'mcp') {
        const transport = artifact.transport as McpTransport;
        // Reuse by name within the machine owner's personal scope (no
        // name-uniqueness constraint exists — identical transport reuses,
        // anything else lands under a suffixed name).
        const existing = (
          await deps.uow.mcpServers.list({ scope: 'personal', ownerId: machine.ownerId })
        ).find((s) => s.name === part.name);
        let server: McpServer;
        if (existing && JSON.stringify(existing.transport) === JSON.stringify(transport)) {
          server = existing;
          reused.push({ kind: 'mcp', name: part.name, id: server.id });
        } else {
          const now = new Date().toISOString();
          let name = part.name;
          if (existing) name = `${part.name}-${slugify(machine.name)}`;
          server = {
            id: generateId(),
            name,
            transport,
            dialSite: 'auto',
            scope: 'personal',
            ownerId: machine.ownerId,
            createdAt: now,
            updatedAt: now,
          };
          await deps.uow.mcpServers.save(server);
          created.push({ kind: 'mcp', name, id: server.id });
        }
        entries.push({ resourceId: server.id, kind: 'mcp' });
        await noteMissingCredentials(transport, machine.ownerId);
        continue;
      }

      // Non-MCP artifact → Resource with reuse-or-create on `${kind}:${slug}`.
      let source: ResourceSource;
      let summary: string | undefined;
      if (artifact.kind === 'skill') {
        // #21: daemon-reported bundle keys become filesystem paths and zip
        // entries on deploy — the same relative-path rule the REST route
        // enforces (resources.ts) applies to this ingestion point too.
        const unsafe = Object.keys(artifact.files).find((k) => isUnsafeRelativePath(k));
        if (unsafe !== undefined) {
          throw new AppError(
            `Imported skill '${part.name}' carries an unsafe file path: "${unsafe}"`,
            400,
            'UNSAFE_BUNDLE_PATH',
          );
        }
        source =
          Object.keys(artifact.files).length > 1 || !('SKILL.md' in artifact.files)
            ? { type: 'inline-bundle', files: artifact.files }
            : { type: 'inline', content: artifact.files['SKILL.md']! };
      } else {
        source = { type: 'inline', content: artifact.content };
      }
      const item = byKey.get(`${part.kind}:${part.name}`);
      summary = item?.summary;

      const baseKey = `${part.kind}:${slugify(part.name)}`;
      let key = baseKey;
      let reuse: Resource | null = null;
      for (let n = 2; ; n++) {
        const existing = await deps.uow.resources.findByKey(key, 'personal', machine.ownerId);
        if (!existing) break;
        const sameBody =
          existing.kind === part.kind && JSON.stringify(existing.source) === JSON.stringify(source);
        if (sameBody) {
          reuse = existing;
          break;
        }
        key = `${baseKey}-${n}`;
      }
      if (reuse) {
        entries.push({ resourceId: reuse.id, kind: reuse.kind });
        reused.push({ kind: reuse.kind, name: reuse.name, id: reuse.id, key: reuse.key });
        continue;
      }

      const now = new Date().toISOString();
      const resource: Resource = {
        id: generateId(),
        key,
        kind: part.kind,
        name: part.name,
        ...(summary ? { description: summary } : {}),
        version: '0.1.0',
        source,
        scope: 'personal',
        ownerId: machine.ownerId,
        targets: [target],
        labels: { imported: 'true', 'imported-from': machine.name },
        createdAt: now,
        updatedAt: now,
      };
      await deps.uow.resources.save(resource);
      entries.push({ resourceId: resource.id, kind: resource.kind });
      created.push({
        kind: resource.kind,
        name: resource.name,
        id: resource.id,
        key: resource.key,
      });
    } catch (e) {
      failed.push({
        kind: part.kind,
        name: part.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (entries.length === 0 && mode !== 'capture') {
    throw new AppError(
      `No items could be imported (${failed.map((f) => `${f.kind}/${f.name}: ${f.error}`).join('; ')})`,
      409,
      'INVENTORY_COLLECT_FAILED',
    );
  }

  const now = new Date().toISOString();
  const profile: Profile = {
    id: generateId(),
    name: profileName,
    description:
      mode === 'capture'
        ? `Captured from machine '${machine.name}' (${target}) on ${now.slice(0, 10)}`
        : `Imported from machine '${machine.name}' (${target}) on ${now.slice(0, 10)}`,
    version: '0.1.0',
    target,
    scope: 'personal',
    ownerId: machine.ownerId,
    entries,
    createdAt: now,
    updatedAt: now,
  };
  await deps.uow.profiles.save(profile);

  return {
    profile,
    created,
    reused,
    failed,
    warnings: [...warnings],
  };
}
