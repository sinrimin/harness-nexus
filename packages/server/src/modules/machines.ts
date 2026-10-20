// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  createMachineSchema,
  updateMachineSchema,
  type CreateMachineInput,
  type UpdateMachineInput,
} from '@harness-nexus/shared';
import { machineView } from './serialize.js';
import { principalOf } from './principal.js';
import {
  enrollMachine,
  getMachine,
  listMachines,
  purgeMachineRecords,
  updateMachine,
} from '../services/machines.js';

/**
 * Machine management routes (Phase 8 C1) — thin HTTP adapters over the domain
 * service (`services/machines.ts`, #53 slice 3). Ownership (owner-only, 404
 * existence-hiding) lives in the service; this file authenticates, parses, and
 * frames replies. Presence (`online`) and socket teardown are realtime truth
 * that stay here.
 */
export async function machinesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/machines (enroll) ----
  app.post('/api/machines', guard, async (req, reply) => {
    const input = createMachineSchema.parse(req.body) as CreateMachineInput;
    const { machine, token } = await enrollMachine({ uow: app.uow }, principalOf(req), input);
    // The raw machine token is returned exactly once (like a PAT reveal).
    return reply.code(201).send({ machine: machineView(machine, false), token });
  });

  // ---- GET /api/machines (own; an admin lists their own, not the fleet) ----
  app.get('/api/machines', guard, async (req) => {
    const machines = await listMachines({ uow: app.uow }, principalOf(req));
    return {
      machines: machines.map((m) => machineView(m, app.realtime.presence.isOnline(m.id))),
    };
  });

  // ---- GET /api/machines/:id ----
  app.get<{ Params: { id: string } }>('/api/machines/:id', guard, async (req) => {
    const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
    return { machine: machineView(machine, app.realtime.presence.isOnline(machine.id)) };
  });

  // ---- PATCH /api/machines/:id (rename / remote-chat toggle / base workspace) ----
  app.patch<{ Params: { id: string } }>('/api/machines/:id', guard, async (req) => {
    const input = updateMachineSchema.parse(req.body) as UpdateMachineInput;
    const updated = await updateMachine({ uow: app.uow }, principalOf(req), req.params.id, input);
    return { machine: machineView(updated, app.realtime.presence.isOnline(updated.id)) };
  });

  // ---- DELETE /api/machines/:id (revoke) ----
  app.delete<{ Params: { id: string } }>('/api/machines/:id', guard, async (req) => {
    const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
    // #53 residue: realtime teardown must run between the ownership decision
    // and the record purge — drop live sockets first (broadcasts offline), then
    // let the service revoke the PAT so the daemon can never reconnect and
    // remove the rows.
    app.realtime.disconnectMachine(machine);
    app.realtime.inventory.failMachine(machine.id);
    await app.realtime.jobs.purgeMachine(machine.id);
    await purgeMachineRecords({ uow: app.uow }, machine);
    return { ok: true };
  });
}
