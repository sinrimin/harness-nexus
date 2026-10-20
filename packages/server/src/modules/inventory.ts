// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import type { Machine, MachineInventorySnapshot } from '@harness-nexus/core';
import {
  AppError,
  scanMachineInventorySchema,
  importMachineInventorySchema,
  captureMachineInventorySchema,
  SCANNABLE_TARGETS,
  type ImportMachineInventoryInput,
  type CaptureMachineInventoryInput,
  type InventoryItem,
  type InventoryPayloadEvent,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { principalOf } from './principal.js';
import { getMachine } from '../services/machines.js';
import {
  bundleImport,
  diffMachineInventory,
  listMachineInventory,
  resolveCaptureSelection,
  resolveImportSelection,
  type ImportResult,
} from '../services/inventory.js';

/**
 * Machine inventory, diff & one-click import routes (Phase 8 C3 · W1) — thin
 * HTTP adapters over the domain service (`services/inventory.ts`, #53 slice
 * 3). Ownership and every repo decision live in the service; what stays here
 * is the /ctl round-trip orchestration: the scan waiter flow, the
 * online/capability gate (presence is socket-layer truth), and the collect
 * emission between the service's resolve and bundle phases.
 */

export interface MachineInventoryView {
  target: MachineInventorySnapshot['target'];
  daemonVersion: string | null;
  reportedAt: string;
  scannedAt: string;
  agents: MachineInventorySnapshot['agents'];
  /** This target's harness runtime probe (Phase 9 W1; null = daemon doesn't probe). */
  runtime: MachineInventorySnapshot['runtime'];
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // #53 residue: presence (socket truth) + capability gate — no clean service
  // split exists without handing the service the socket layer, so the gate
  // stays at the route like the /ctl flows it guards.
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
    const snapshots = await listMachineInventory({ uow: app.uow }, principalOf(req), req.params.id);
    return { inventory: snapshots.map(itemView) };
  });

  // ---- POST /api/machines/:id/inventory/scan — trigger + await fresh reports ----
  // #53 residue: the whole handler is a realtime round-trip (beginScan waiter +
  // /ctl emit + await); only the ownership door runs through the service.
  app.post<{ Params: { id: string } }>('/api/machines/:id/inventory/scan', guard, async (req) => {
    const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
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
      const diff = await diffMachineInventory(
        { uow: app.uow },
        principalOf(req),
        req.params.id,
        req.query.profile,
      );
      return { diff };
    },
  );

  // ---- POST /api/machines/:id/inventory/import — collect bodies, create, bundle ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/inventory/import', guard, async (req) => {
    const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
    requireOnlineScanner(machine);
    const input = importMachineInventorySchema.parse(req.body) as ImportMachineInventoryInput;
    const snapshot = await resolveImportSelection({ uow: app.uow }, machine, input);
    const payloadItems = await collectBodies(machine, input.target, input.items);
    const result: ImportResult = await bundleImport(
      { uow: app.uow },
      {
        machine,
        snapshot,
        target: input.target,
        profileName: input.profileName,
        payloadItems,
        mode: 'import',
      },
    );
    return result;
  });

  // ---- POST /api/machines/:id/inventory/capture — W1: current state → profile ----
  // The C3 collect+import pipeline invoked WITHOUT a diff baseline: every
  // importable item of the latest snapshot. An Agent in default state captures
  // as a profile with zero entries.
  app.post<{ Params: { id: string } }>(
    '/api/machines/:id/inventory/capture',
    guard,
    async (req) => {
      const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
      requireOnlineScanner(machine);
      const input = captureMachineInventorySchema.parse(req.body) as CaptureMachineInventoryInput;
      const { snapshot, items } = await resolveCaptureSelection({ uow: app.uow }, machine, input);
      const payloadItems = await collectBodies(machine, input.target, items);
      const result: ImportResult = await bundleImport(
        { uow: app.uow },
        {
          machine,
          snapshot,
          target: input.target,
          profileName: input.profileName,
          payloadItems,
          mode: 'capture',
        },
      );
      return result;
    },
  );

  /**
   * #53 residue: the collect half of import/capture — a direct /ctl
   * request/response round-trip (emit + await the daemon's payload). An empty
   * selection skips the round-trip entirely.
   */
  const collectBodies = async (
    machine: Machine,
    target: MachineInventorySnapshot['target'],
    items: readonly { kind: InventoryItem['kind']; name: string }[],
  ): Promise<InventoryPayloadEvent['items']> => {
    if (items.length === 0) return [];
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
    return outcome.items ?? [];
  };
}
