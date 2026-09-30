import { randomUUID } from 'node:crypto';
import { normalizeWorkspacePath, isWithinWorkspace } from '../paths.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  workspaceListRequestSchema,
  type WorkspaceDirectory,
} from '@harness-nexus/shared';

/**
 * Workspace directory listing (Phase 9 W6) — one level of subdirectories
 * under the machine's base workspace, for the chat session picker. Owner-only
 * read with 404-hiding (#36 — same convention as the other machine routes);
 * listing rides the daemon (`workspace:list` over /ctl), so the machine must
 * be online and advertise the `workspace` capability. Containment (the
 * requested path must BE the root or sit under it) is enforced HERE, before
 * anything is emitted — the daemon only ever returns directory names.
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/machines/:id/workspace',
    guard,
    async (req) => {
      const machine = await app.uow.machines.findById(req.params.id);
      if (!machine || machine.ownerId !== req.user!.id) {
        throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
      }
      if (machine.baseWorkspace === null) {
        throw new AppError(
          'Base workspace is not configured for this machine',
          400,
          'WORKSPACE_ROOT_NOT_SET',
        );
      }

      // #33: normalize WITHOUT the server's own filesystem semantics — the
      // path belongs to the (possibly Windows) machine, and a Linux server's
      // resolve() would garble `D:\code` into `/app/D:\code`.
      const root = normalizeWorkspacePath(machine.baseWorkspace);
      const requested = normalizeWorkspacePath(
        req.query.path && req.query.path !== '' ? req.query.path : root,
      );
      if (!isWithinWorkspace(requested, root)) {
        throw new AppError(
          'Path is outside the machine base workspace',
          400,
          'WORKSPACE_OUTSIDE_ROOT',
        );
      }
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
