// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentInstance, Machine } from '@harness-nexus/core';
import { AppError } from '@harness-nexus/shared';
import { getMachine } from './machines.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Agent-instance reads (#53 slice 3) — the two pure read paths that lived in
 * the jobs module (`GET /api/machines/:id/agents`, `GET /api/agent-instances/
 * :id`). The module's other agent-instance surface (the sessions rail) is a
 * live /ctl round-trip and stays at the route (#53 residue, slice 10).
 */

/** Deployed agent instances for the owner's machine. */
export async function listMachineAgents(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
): Promise<AgentInstance[]> {
  const machine = await getMachine(deps, principal, machineId);
  return deps.uow.agentInstances.listByMachine(machine.id);
}

/**
 * One agent instance + its machine. Chat is owner-ONLY by design, so the
 * lookup is too: a non-owner (admin included) gets the 404 rather than a
 * machine reveal.
 */
export async function getAgentInstance(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<{ agent: AgentInstance; machine: Machine }> {
  const agent = await deps.uow.agentInstances.findById(id);
  if (!agent || agent.ownerId !== principal.userId) {
    throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
  }
  // A dangling machine row reads the same as a missing agent (same 404 code).
  const machine = await deps.uow.machines.findById(agent.machineId);
  if (!machine) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
  return { agent, machine };
}
