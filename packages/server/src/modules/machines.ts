import type { FastifyInstance } from 'fastify';
import type { Machine } from '@harness-nexus/core';
import {
  AppError,
  createMachineSchema,
  updateMachineSchema,
  type CreateMachineInput,
  type UpdateMachineInput,
} from '@harness-nexus/shared';
import { generatePat, hashToken, patDisplayPrefix, generateId } from '../infra/crypto.js';
import { machineView } from './serialize.js';

/**
 * Machine management (Phase 8 C1). Machines are personal — the owner sees and
 * mutates them; anyone else (admin included, #36: admins are not tenant
 * overseers) gets 404 (existence-hiding, same convention as
 * credentials/mcp-servers). Enrolling creates the Machine plus its dedicated
 * machine PAT (scopes ['machine-ctl'], rejected by REST) whose raw token is
 * returned exactly once.
 */
export async function machinesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const visible = async (id: string, requester: { id: string }): Promise<Machine | null> => {
    const machine = await app.uow.machines.findById(id);
    if (!machine) return null;
    if (machine.ownerId !== requester.id) return null;
    return machine;
  };

  const notFound = (): AppError => new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');

  // ---- POST /api/machines (enroll) ----
  app.post('/api/machines', guard, async (req, reply) => {
    const input = createMachineSchema.parse(req.body) as CreateMachineInput;

    const rawToken = generatePat();
    const now = new Date().toISOString();
    // Machine token: scopes ['machine-ctl'] — accepted by the /ctl namespace
    // middleware only; the REST auth hook rejects it (blast radius = realtime).
    const pat = await app.uow.tokens.save({
      id: generateId(),
      userId: req.user!.id,
      name: `machine: ${input.name}`,
      tokenHash: hashToken(rawToken),
      prefix: patDisplayPrefix(rawToken),
      scopes: ['machine-ctl'],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: now,
    });

    const machine: Machine = {
      id: generateId(),
      ownerId: req.user!.id,
      name: input.name,
      hostname: null,
      os: null,
      arch: null,
      daemonVersion: null,
      capabilities: [],
      remoteChatEnabled: false,
      baseWorkspace: null,
      enrollmentPatId: pat.id,
      enrolledAt: now,
      lastSeenAt: null,
    };
    await app.uow.machines.save(machine);

    // The raw machine token is returned exactly once (like a PAT reveal).
    return reply.code(201).send({ machine: machineView(machine, false), token: rawToken });
  });

  // ---- GET /api/machines (own; an admin lists their own, not the fleet) ----
  app.get('/api/machines', guard, async (req) => {
    const machines = await app.uow.machines.list({ ownerId: req.user!.id });
    return {
      machines: machines.map((m) => machineView(m, app.realtime.presence.isOnline(m.id))),
    };
  });

  // ---- GET /api/machines/:id ----
  app.get<{ Params: { id: string } }>('/api/machines/:id', guard, async (req) => {
    const machine = await visible(req.params.id, req.user!);
    if (!machine) throw notFound();
    return { machine: machineView(machine, app.realtime.presence.isOnline(machine.id)) };
  });

  // ---- PATCH /api/machines/:id (rename / remote-chat toggle / base workspace) ----
  app.patch<{ Params: { id: string } }>('/api/machines/:id', guard, async (req) => {
    const machine = await visible(req.params.id, req.user!);
    if (!machine) throw notFound();
    const input = updateMachineSchema.parse(req.body) as UpdateMachineInput;
    const updated = await app.uow.machines.save({
      ...machine,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.remoteChatEnabled !== undefined
        ? { remoteChatEnabled: input.remoteChatEnabled }
        : {}),
      ...(input.baseWorkspace !== undefined ? { baseWorkspace: input.baseWorkspace } : {}),
      // Issue #3 — machine-scoped pre-warm switches (replace semantics).
      ...(input.chatPrewarm !== undefined ? { chatPrewarm: input.chatPrewarm } : {}),
    });
    return { machine: machineView(updated, app.realtime.presence.isOnline(updated.id)) };
  });

  // ---- DELETE /api/machines/:id (revoke) ----
  app.delete<{ Params: { id: string } }>('/api/machines/:id', guard, async (req) => {
    const machine = await visible(req.params.id, req.user!);
    if (!machine) throw notFound();
    // Drop live sockets first (broadcasts offline), then revoke the PAT so the
    // daemon can never reconnect, then remove the row.
    app.realtime.disconnectMachine(machine);
    app.realtime.inventory.failMachine(machine.id);
    await app.realtime.jobs.purgeMachine(machine.id);
    await app.uow.runtimeConfigs.deleteByMachine(machine.id);
    await app.uow.inventories.deleteByMachine(machine.id);
    await app.uow.tokens.delete(machine.enrollmentPatId);
    await app.uow.machines.delete(machine.id);
    return { ok: true };
  });
}
