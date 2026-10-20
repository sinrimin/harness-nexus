// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  workspaceListRequestSchema,
  type WorkspaceDirectory,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import { prepareWorkspaceListing } from '../services/workspace.js';

/**
 * Workspace directory listing routes (Phase 9 W6) — the HTTP shell over the
 * pure decisions in `services/workspace.ts` (#53 slice 12) plus the daemon
 * round-trip, which is inherently realtime and stays HERE: one level of
 * subdirectories under the machine's base workspace for the chat session
 * picker, fetched via `workspace:list` over /ctl (the machine must be online
 * and advertise the `workspace` capability). The daemon only ever returns
 * directory names — containment is enforced in the service BEFORE anything
 * is emitted.
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/machines/:id/workspace',
    guard,
    async (req) => {
      const { machine, requested } = await prepareWorkspaceListing(
        { uow: app.uow },
        principalOf(req),
        req.params.id,
        req.query.path,
      );

      // #53 residue: everything below is the daemon round-trip — presence,
      // the capability the LIVE daemon advertised, the ctl emit, and the
      // waiter are realtime-only concerns (services decide, callers act).
      // Order matters: an offline machine (capabilities not yet mirrored
      // onto the row) must answer MACHINE_OFFLINE, not DAEMON_NO_WORKSPACE.
      if (!app.realtime.presence.isOnline(machine.id)) {
        throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
      }
      if (!machine.capabilities.includes('workspace')) {
        throw new AppError(
          'Daemon does not advertise the workspace capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_WORKSPACE',
        );
      }

      const requestId = randomUUID();
      const request = workspaceListRequestSchema.parse({ requestId, path: requested });
      const { done } = app.realtime.workspace.awaitList(machine.id, requestId);
      app.io.of('/ctl').to(`machine:${machine.id}`).emit('workspace:list', request);
      const outcome = await done;
      if (!outcome.ok) {
        if (outcome.error !== undefined) {
          throw new AppError(outcome.error, 502, 'DAEMON_WORKSPACE_FAILED');
        }
        if (outcome.reason === 'disconnected') {
          throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
        }
        throw new AppError('Daemon did not answer the listing in time', 504, 'WORKSPACE_TIMEOUT');
      }
      const directories: WorkspaceDirectory[] = outcome.directories ?? [];
      // 9 W9 C — regular files at the level, for the composer's @-reference
      // picker (old daemons omit the arm; an empty list is honest).
      return { path: requested, directories, files: outcome.files ?? [] };
    },
  );
}
