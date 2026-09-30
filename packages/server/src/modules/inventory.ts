import type { FastifyInstance } from 'fastify';
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
  captureMachineInventorySchema,
  diffInventory,
  importMachineInventorySchema,
  isUnsafeRelativePath,
  scanMachineInventorySchema,
  transportPlaceholderNames,
  SCANNABLE_TARGETS,
  type InventoryArtifact,
  type InventoryDiff,
  type InventoryDiffEntry,
  type InventoryItem,
  type InventoryPayloadEvent,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';

/**
 * Machine inventory, diff & one-click import (Phase 8 C3), plus W1's
 * capture-as-profile. wiki design-phase-8-c3.md · phase-9-harness-runtime.md.
 *
 * All endpoints hang off a machine and inherit its owner-or-admin guard with
 * 404 existence-hiding. Scan and import are direct request/response flows over
 * /ctl (C4's job system absorbs them later); both require the daemon online.
 *
 * Import creates resources with reuse-or-create semantics — an identical body
 * under the same key is REUSED, so re-importing an unchanged machine is
 * idempotent; a changed body lands under a suffixed key. MCP items become
 * McpServer rows (never resources — the 4.2 rule), with env/header values
 * already redacted to `${cred:<KEY>}` placeholders daemon-side.
 */

// Default scan list comes from shared (single source with the SDK + CLI).

export interface MachineInventoryView {
  target: MachineInventorySnapshot['target'];
  daemonVersion: string | null;
  reportedAt: string;
  scannedAt: string;
  agents: MachineInventorySnapshot['agents'];
  /** This target's harness runtime probe (Phase 9 W1; null = daemon doesn't probe). */
  runtime: MachineInventorySnapshot['runtime'];
}

export interface ImportResultView {
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

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const visible = async (id: string, requester: { id: string }): Promise<Machine | null> => {
    const machine = await app.uow.machines.findById(id);
    if (!machine) return null;
    if (machine.ownerId !== requester.id) return null;
    return machine;
  };

  const notFound = (): AppError => new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');

  const requireOnlineScanner = (machine: Machine): void => {
    if (!app.realtime.presence.isOnline(machine.id)) {
      throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
    }
    if (!machine.capabilities.includes('inventory')) {
      throw new AppError(
        'Daemon does not advertise the inventory capability (upgrade hnx on the machine)',
        409,
        'DAEMON_NO_INVENTORY',
      );
    }
  };

  const emitToMachine = (machineId: string, event: string, payload: unknown): void => {
    app.io.of('/ctl').to(`machine:${machineId}`).emit(event, payload);
  };

  const itemView = (s: MachineInventorySnapshot): MachineInventoryView => ({
    target: s.target,
    daemonVersion: s.daemonVersion,
    reportedAt: s.reportedAt,
    scannedAt: s.scannedAt,
    agents: s.agents,
    runtime: s.runtime,
  });

  // ---- GET /api/machines/:id/inventory — latest snapshot per target ----
  app.get<{ Params: { id: string } }>('/api/machines/:id/inventory', guard, async (req) => {
    const machine = await visible(req.params.id, req.user!);
    if (!machine) throw notFound();
    const snapshots = await app.uow.inventories.list(machine.id);
    return { inventory: snapshots.map(itemView) };
  });

  // ---- POST /api/machines/:id/inventory/scan — trigger + await fresh reports ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/inventory/scan', guard, async (req) => {
    const machine = await visible(req.params.id, req.user!);
    if (!machine) throw notFound();
    requireOnlineScanner(machine);
    const input = scanMachineInventorySchema.parse(req.body ?? {});

    const targets = input.targets ?? SCANNABLE_TARGETS;
    const waiter = app.realtime.inventory.beginScan(machine.id, targets);
    if (!waiter) {
      throw new AppError('A scan is already in progress for this machine', 409, 'SCAN_IN_PROGRESS');
    }
    emitToMachine(machine.id, 'inventory:scan', { requestId: waiter.requestId, targets });
    const outcome = await waiter.done;
    if (!outcome.ok) {
      if (outcome.reason === 'timeout') {
        throw new AppError(
          `Inventory scan timed out (${outcome.missing.join(', ')} outstanding)`,
          504,
          'INVENTORY_SCAN_TIMEOUT',
        );
      }
      throw new AppError('Machine daemon disconnected during scan', 409, 'MACHINE_OFFLINE');
    }
    return { inventory: outcome.snapshots.map(itemView) };
  });

  // ---- GET /api/machines/:id/inventory/diff?profile=<id> ----
  app.get<{ Params: { id: string }; Querystring: { profile?: string } }>(
    '/api/machines/:id/inventory/diff',
    guard,
    async (req) => {
      const machine = await visible(req.params.id, req.user!);
      if (!machine) throw notFound();
      const profileId = req.query.profile;
      if (!profileId) throw new AppError('profile query param required', 400, 'PROFILE_REQUIRED');

      const profile = await app.uow.profiles.findById(profileId);
      const profileVisible =
        profile && (profile.scope === 'global' || profile.ownerId === req.user!.id);
      if (!profile || !profileVisible) {
        throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
      }
      const snapshot = await app.uow.inventories.findLatest(machine.id, profile.target);
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
          const server = await app.uow.mcpServers.findById(entry.resourceId);
          entries.push({ kind: 'mcp', name: server?.name ?? `#${entry.resourceId}` });
        } else {
          const resource = await app.uow.resources.findById(entry.resourceId);
          entries.push({ kind: entry.kind, name: resource?.name ?? `#${entry.resourceId}` });
        }
      }
      const items: InventoryItem[] = snapshot.agents.flatMap((a) => a.items);
      const body = diffInventory(entries, items);
      const diff: InventoryDiff = { profileId: profile.id, target: profile.target, ...body };
      return { diff };
    },
  );

  // ---- POST /api/machines/:id/inventory/import — collect bodies, create, bundle ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/inventory/import', guard, async (req) => {
    const machine = await visible(req.params.id, req.user!);
    if (!machine) throw notFound();
    requireOnlineScanner(machine);
    const input = importMachineInventorySchema.parse(req.body);

    const snapshot = await app.uow.inventories.findLatest(machine.id, input.target);
    if (!snapshot) {
      throw new AppError(
        `No ${input.target} inventory for this machine — scan first`,
        404,
        'INVENTORY_NOT_SCANNED',
      );
    }
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

    return collectAndBundle(
      machine,
      snapshot,
      input.target,
      input.profileName,
      input.items,
      'import',
    );
  });

  // ---- POST /api/machines/:id/inventory/capture — W1: current state → profile ----
  // The C3 collect+import pipeline invoked WITHOUT a diff baseline: every
  // importable item of the latest snapshot. An Agent in default state captures
  // as a profile with zero entries.
  app.post<{ Params: { id: string } }>(
    '/api/machines/:id/inventory/capture',
    guard,
    async (req) => {
      const machine = await visible(req.params.id, req.user!);
      if (!machine) throw notFound();
      requireOnlineScanner(machine);
      const input = captureMachineInventorySchema.parse(req.body);

      const snapshot = await app.uow.inventories.findLatest(machine.id, input.target);
      if (!snapshot) {
        throw new AppError(
          `No ${input.target} inventory for this machine — scan first`,
          404,
          'INVENTORY_NOT_SCANNED',
        );
      }
      const items = snapshot.agents
        .flatMap((a) => a.items)
        .filter((item) => item.importable)
        .map((item) => ({ kind: item.kind, name: item.name }));
      return collectAndBundle(machine, snapshot, input.target, input.profileName, items, 'capture');
    },
  );

  /**
   * Shared core of import & capture: collect bodies over /ctl (unless nothing
   * was selected), reuse-or-create resources + MCP rows, bundle everything
   * into a personal profile. Capture (`mode: 'capture'`, Phase 9 W1) also
   * bundles an Agent in default state into a zero-entry profile.
   */
  const collectAndBundle = async (
    machine: Machine,
    snapshot: MachineInventorySnapshot,
    target: MachineInventorySnapshot['target'],
    profileName: string,
    items: readonly { kind: InventoryItem['kind']; name: string }[],
    mode: 'import' | 'capture',
  ): Promise<ImportResultView> => {
    const byKey = new Map(
      snapshot.agents.flatMap((a) => a.items).map((item) => [`${item.kind}:${item.name}`, item]),
    );

    let payloadItems: InventoryPayloadEvent['items'] = [];
    if (items.length > 0) {
      const requestId = generateId();
      const payloadPromise = app.realtime.inventory.awaitPayload(machine.id, requestId);
      emitToMachine(machine.id, 'inventory:collect', {
        requestId,
        target,
        items,
      });
      const outcome = await payloadPromise;
      if (!outcome.ok) {
        if (outcome.reason === 'timeout') {
          throw new AppError('Import body collection timed out', 504, 'INVENTORY_COLLECT_TIMEOUT');
        }
        throw new AppError('Machine daemon disconnected during import', 409, 'MACHINE_OFFLINE');
      }
      payloadItems = outcome.items ?? [];
    }

    const created: ImportResultView['created'] = [];
    const reused: ImportResultView['reused'] = [];
    const failed: ImportResultView['failed'] = [];
    const warnings = new Set<string>();
    const entries: ProfileEntry[] = [];

    const noteMissingCredentials = async (
      transport: McpTransport,
      ownerId: string | null,
    ): Promise<void> => {
      for (const name of transportPlaceholderNames(transport)) {
        const cred = await findCredentialForOwner(app.uow, name, ownerId);
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
            await app.uow.mcpServers.list({ scope: 'personal', ownerId: machine.ownerId })
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
            await app.uow.mcpServers.save(server);
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
          const existing = await app.uow.resources.findByKey(key, 'personal', machine.ownerId);
          if (!existing) break;
          const sameBody =
            existing.kind === part.kind &&
            JSON.stringify(existing.source) === JSON.stringify(source);
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
        await app.uow.resources.save(resource);
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
    await app.uow.profiles.save(profile);

    return {
      profile,
      created,
      reused,
      failed,
      warnings: [...warnings],
    };
  };
}
