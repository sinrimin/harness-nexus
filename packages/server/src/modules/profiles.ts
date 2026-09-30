import type { FastifyInstance } from 'fastify';
import type { Profile, ProfileEntry } from '@harness-nexus/core';
import {
  AppError,
  createProfileSchema,
  updateProfileSchema,
  bumpProfileVersion,
  INITIAL_PROFILE_VERSION,
  type CreateProfileInput,
  type UpdateProfileInput,
  type ProfileEntryInput,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * Profile management — named bundles of MCP servers (and, later, other
 * resources) that Agent tools connect through via `?profile=<id>` on /mcp.
 *
 * Scope rules (see wiki design-phase-2.2-registry.md) match credentials / mcp-servers:
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 */
export async function profilesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/profiles ----
  app.post('/api/profiles', guard, async (req, reply) => {
    const input = createProfileSchema.parse(req.body) as CreateProfileInput;

    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global profiles', 403, 'FORBIDDEN');
    }
    const entries = await resolveEntries(app, input.entries, req.user!.id);

    const now = new Date().toISOString();
    const profile: Profile = {
      id: generateId(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      // Auto-numbered (#18): new profiles start at 0.1; the version bumps
      // only when entries change (decimal, carry at 16 — see shared
      // profile-version.ts). Client-sent versions are ignored.
      version: INITIAL_PROFILE_VERSION,
      target: input.target,
      scope: input.scope,
      ownerId: input.scope === 'global' ? null : req.user!.id,
      entries,
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.profiles.save(profile);
    return reply.code(201).send({ profile });
  });

  // ---- GET /api/profiles ----
  app.get('/api/profiles', guard, async (req) => {
    const [personal, global] = await Promise.all([
      app.uow.profiles.list({ scope: 'personal', ownerId: req.user!.id }),
      app.uow.profiles.list({ scope: 'global' }),
    ]);
    return { profiles: [...personal, ...global] };
  });

  // ---- GET /api/profiles/:id ----
  app.get<{ Params: { id: string } }>('/api/profiles/:id', guard, async (req) => {
    const profile = await app.uow.profiles.findById(req.params.id);
    if (!profile || !visibleTo(profile, req.user!.id)) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }
    return { profile };
  });

  // ---- PATCH /api/profiles/:id ----
  app.patch<{ Params: { id: string } }>('/api/profiles/:id', guard, async (req) => {
    const input = updateProfileSchema.parse(req.body) as UpdateProfileInput;
    // `target` is immutable post-create (Phase 3.2). updateProfileSchema omits
    // it, so zod strips it from `input`; inspect the raw body to give the
    // explicit 409 TARGET_IMMUTABLE code instead of silently ignoring the key.
    if (req.body && typeof req.body === 'object' && 'target' in req.body) {
      throw new AppError('Profile target is immutable', 409, 'TARGET_IMMUTABLE');
    }
    const existing = await app.uow.profiles.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }

    const entries =
      input.entries !== undefined
        ? await resolveEntries(app, input.entries, req.user!.id)
        : existing.entries;

    // Auto-version (#18): bump ONLY when the entries actually changed — the
    // bump is the Claude Code marketplace publish switch, and name/description
    // edits shouldn't trigger pointless reinstall rounds on machines.
    const entriesChanged =
      JSON.stringify(entries) !== JSON.stringify(existing.entries as ProfileEntry[]);

    const next: Profile = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(entriesChanged ? { version: bumpProfileVersion(existing.version) } : {}),
      entries,
      updatedAt: new Date().toISOString(),
    };
    await app.uow.profiles.save(next);
    return { profile: next };
  });

  // ---- DELETE /api/profiles/:id ----
  app.delete<{ Params: { id: string } }>('/api/profiles/:id', guard, async (req) => {
    const existing = await app.uow.profiles.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }
    await app.uow.profiles.delete(existing.id);
    return { ok: true };
  });
}

/**
 * Resolve input entries into domain ProfileEntry records, validating that
 * every referenced artifact is visible to the caller:
 *  - `{ mcpServerId }` (Phase 2.2) → kind 'mcp', resourceId = McpServer.id.
 *  - `{ resourceId, kind }` (Phase 3.5) → a Resource reference; 'mcp' is not
 *    accepted here (MCP servers enter via the mcpServerId arm).
 */
async function resolveEntries(
  app: FastifyInstance,
  entries: ProfileEntryInput[],
  userId: string,
): Promise<ProfileEntry[]> {
  const out: ProfileEntry[] = [];
  for (const e of entries) {
    if ('mcpServerId' in e) {
      const server = await app.uow.mcpServers.findById(e.mcpServerId);
      if (!server || server.deletedAt !== undefined || !serverVisible(server, userId)) {
        throw new AppError(
          `MCP server ${e.mcpServerId} not found or not accessible`,
          409,
          'ENTRY_TARGET_NOT_ACCESSIBLE',
        );
      }
      out.push({
        resourceId: e.mcpServerId,
        kind: 'mcp',
        ...(e.pinnedVersion ? { pinnedVersion: e.pinnedVersion } : {}),
      });
      continue;
    }
    const resource = await app.uow.resources.findById(e.resourceId);
    if (
      !resource ||
      resource.deletedAt !== undefined ||
      resource.kind !== e.kind ||
      !(resource.scope === 'global' || resource.ownerId === userId)
    ) {
      throw new AppError(
        `Resource ${e.resourceId} not found or not accessible`,
        409,
        'ENTRY_TARGET_NOT_ACCESSIBLE',
      );
    }
    out.push({
      resourceId: e.resourceId,
      kind: e.kind,
      ...(e.pinnedVersion ? { pinnedVersion: e.pinnedVersion } : {}),
      ...(e.installOptions ? { installOptions: e.installOptions } : {}),
    });
  }
  return out;
}

/** A profile is visible to a user iff global or personal + owned (#36). */
function visibleTo(p: Profile, userId: string): boolean {
  return p.scope === 'global' || p.ownerId === userId;
}

/** A profile is manageable iff owner (personal) or admin on a global row (#36). */
function canManage(p: Profile, userId: string, role: 'admin' | 'user'): boolean {
  return p.scope === 'global' ? role === 'admin' : p.ownerId === userId;
}

/** An MCP server is visible iff global or personal + owned (#36). */
function serverVisible(
  s: { scope: 'global' | 'personal'; ownerId: string | null },
  userId: string,
): boolean {
  return s.scope === 'global' || s.ownerId === userId;
}
