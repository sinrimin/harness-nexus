import type { FastifyInstance } from 'fastify';
import type { Resource, ResourceKind, AgentTarget } from '@harness-nexus/core';
import {
  AppError,
  createResourceSchema,
  updateResourceSchema,
  HOOK_EVENTS,
  HOOK_SUPPORT,
  isUnsafeRelativePath,
  resolveTrustTier,
  type CreateResourceInput,
  type UpdateResourceInput,
  type HookEvent,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { resourceView } from './serialize.js';

/**
 * Resource management — versioned assets (sub-agents, rules, …) referenced by
 * profiles via `kind:key`.
 *
 * Scope rules (identical to credentials & mcp-servers):
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 *
 * Kind availability is gated by an allowlist (AVAILABLE_KINDS) at the route
 * layer, not in the zod schema, so 4.4–4.6 can enable new kinds without touching
 * shared schemas. `kind` and `scope` are immutable post-create.
 */
export async function resourcesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/resources ----
  app.post('/api/resources', guard, async (req, reply) => {
    const input = createResourceSchema.parse(req.body) as CreateResourceInput;

    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global resources', 403, 'FORBIDDEN');
    }
    assertKindAvailable(input.kind);
    validateHookResource(input.kind, input.targets, input.source as Resource['source']);
    validateSkillResource(input.kind, input.source as Resource['source']);

    const ownerId = input.scope === 'global' ? null : req.user!.id;
    const existing = await app.uow.resources.findByKey(
      input.key,
      input.scope,
      ownerId ?? undefined,
    );
    if (existing) {
      throw new AppError(
        `A resource with key "${input.key}" already exists in scope ${input.scope}`,
        409,
        'RESOURCE_KEY_TAKEN',
      );
    }

    const now = new Date().toISOString();
    // zod-inferred source/targets carry `| undefined` on optional fields; the
    // domain types do not (exactOptionalPropertyTypes). The shapes are identical
    // at runtime, so cast at this validated boundary (same pattern as mcp-servers
    // transport). Same for labels.
    const resource: Resource = {
      id: generateId(),
      key: input.key,
      kind: input.kind,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      version: input.version,
      source: input.source as Resource['source'],
      scope: input.scope,
      ownerId,
      targets: input.targets,
      ...(input.labels ? { labels: input.labels as Record<string, string> } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const trusted = withTrustLabels(resource);
    await app.uow.resources.save(trusted);
    return reply.code(201).send({ resource: resourceView(trusted) });
  });

  // ---- GET /api/resources ----
  // Returns the caller's personal resources + all global resources. Query params
  // (kind/scope/target) narrow the set; scope=global|personal filters the halves.
  app.get('/api/resources', guard, async (req) => {
    const q = req.query as {
      kind?: ResourceKind;
      scope?: 'global' | 'personal';
      target?: Resource['targets'][number];
      includeDeleted?: string;
    };
    // `includeDeleted=1` also returns soft-deleted rows (the profile editor
    // greys them out; management pages use the default view).
    const includeDeleted = q.includeDeleted === '1';

    const wantPersonal = q.scope !== 'global';
    const wantGlobal = q.scope !== 'personal';

    const [personal, global] = await Promise.all([
      wantPersonal
        ? app.uow.resources.list({
            ...(q.kind ? { kind: q.kind } : {}),
            scope: 'personal',
            ownerId: req.user!.id,
            ...(q.target ? { target: q.target } : {}),
            includeDeleted,
          })
        : Promise.resolve([]),
      wantGlobal
        ? app.uow.resources.list({
            ...(q.kind ? { kind: q.kind } : {}),
            scope: 'global',
            ...(q.target ? { target: q.target } : {}),
            includeDeleted,
          })
        : Promise.resolve([]),
    ]);
    return { resources: [...personal, ...global].map(resourceView) };
  });

  // ---- GET /api/resources/:id ----
  app.get<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const resource = await app.uow.resources.findById(req.params.id);
    if (!resource || !canManage(resource, req.user!.id, req.user!.role)) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }
    return { resource: resourceView(resource) };
  });

  // ---- PATCH /api/resources/:id ----
  app.patch<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const input = updateResourceSchema.parse(req.body) as UpdateResourceInput;
    const existing = await app.uow.resources.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }

    // kind/scope are immutable; they are not in updateResourceSchema, but guard
    // against a future schema change leaking them through.
    if (
      (input as { kind?: unknown }).kind !== undefined &&
      (input as { kind?: unknown }).kind !== existing.kind
    ) {
      throw new AppError('Resource kind is immutable', 409, 'RESOURCE_IMMUTABLE');
    }

    // If the key changed, ensure the new key is free in this scope.
    if (input.key !== undefined && input.key !== existing.key) {
      const clash = await app.uow.resources.findByKey(
        input.key,
        existing.scope,
        existing.ownerId ?? undefined,
      );
      if (clash) {
        throw new AppError(
          `A resource with key "${input.key}" already exists in scope ${existing.scope}`,
          409,
          'RESOURCE_KEY_TAKEN',
        );
      }
    }

    const next: Resource = {
      ...existing,
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.source !== undefined ? { source: input.source as Resource['source'] } : {}),
      ...(input.targets !== undefined ? { targets: input.targets } : {}),
      ...(input.labels !== undefined ? { labels: input.labels as Record<string, string> } : {}),
      updatedAt: new Date().toISOString(),
    };
    validateHookResource(next.kind, next.targets, next.source);
    validateSkillResource(next.kind, next.source);
    const trusted = withTrustLabels(next);
    await app.uow.resources.save(trusted);
    return { resource: resourceView(trusted) };
  });

  // ---- DELETE /api/resources/:id ----
  // ---- DELETE /api/resources/:id — two-stage (see mcp-servers) ----
  app.delete<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const existing = await app.uow.resources.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }
    if (existing.deletedAt === undefined) {
      const now = new Date().toISOString();
      await app.uow.resources.save({ ...existing, deletedAt: now, updatedAt: now });
      return { ok: true, mode: 'soft' as const };
    }
    const refs = (await app.uow.profiles.listAll()).filter((p) =>
      p.entries.some((e) => e.resourceId === existing.id),
    );
    if (refs.length > 0) {
      throw new AppError(
        `Still referenced by profile(s): ${refs.map((r) => r.name).join(', ')} — save those profiles (soft-deleted entries are stripped automatically) and delete again`,
        409,
        'ASSET_STILL_REFERENCED',
      );
    }
    await app.uow.resources.delete(existing.id);
    return { ok: true, mode: 'hard' as const };
  });
}

/** Resource kinds that have shipped. Add a kind here when its sub-phase lands. */
const AVAILABLE_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'sub_agent',
  'rule',
  'command',
  'hook',
  'skill',
]);

function assertKindAvailable(kind: ResourceKind): void {
  if (!AVAILABLE_KINDS.has(kind)) {
    throw new AppError(`Resource kind "${kind}" is not available yet`, 409, 'KIND_NOT_AVAILABLE');
  }
}

/**
 * Hook-specific validation (Phase 4.5). A hook resource stores a `hooks.json`
 * document in `source.inline.content` and is only valid for targets that use the
 * declarative hooks.json model (CC/ZCode; not Hermes). Event keys in the JSON
 * must be supported by at least one declared target. See
 * `wiki research-phase-4.5-hooks.md`.
 */
function validateHookResource(
  kind: ResourceKind,
  targets: AgentTarget[],
  source: Resource['source'],
): void {
  if (kind !== 'hook') return;

  // Hermes uses a different hook model (Python plugins); reject it as a hook
  // target rather than silently dropping it.
  for (const t of targets) {
    if (HOOK_SUPPORT[t] === null) {
      throw new AppError(
        `Target "${t}" does not support declarative hooks.json`,
        409,
        'TARGET_NO_DECLARATIVE_HOOKS',
      );
    }
  }

  // Only validate the inline JSON content; other source variants are accepted
  // as-is (they arrive with later phases).
  if (source.type !== 'inline') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch {
    throw new AppError(
      'Hook content must be valid JSON (hooks.json shape)',
      400,
      'VALIDATION_ERROR',
    );
  }
  const events = (parsed as { hooks?: Record<string, unknown> })?.hooks;
  if (!events || typeof events !== 'object') {
    throw new AppError(
      'Hook content must be a hooks.json document: { "hooks": { "<Event>": [...] } }',
      400,
      'VALIDATION_ERROR',
    );
  }

  const validEvents = new Set<string>(HOOK_EVENTS);
  const unsupportedByAll: string[] = [];
  for (const event of Object.keys(events)) {
    if (!validEvents.has(event)) {
      unsupportedByAll.push(event);
      continue;
    }
    // Hard error only if NO declared target supports this event.
    const supportedBySome = targets.some((t) => HOOK_SUPPORT[t]?.has(event as HookEvent));
    if (!supportedBySome) {
      unsupportedByAll.push(event);
    }
  }
  if (unsupportedByAll.length > 0) {
    throw new AppError(
      `Hook event(s) unsupported by any declared target: ${unsupportedByAll.join(', ')}`,
      409,
      'HOOK_EVENT_UNSUPPORTED',
    );
  }
}

/**
 * Skill-specific validation (Phase 4.6 local skills + Phase 7.1 plugin sources).
 * A skill may use:
 *   - `inline`        — single-file SKILL.md as content (4.6).
 *   - `inline-bundle` — multi-file: a path→content map whose keys are relative
 *                       paths and one must be `SKILL.md` (4.6).
 *   - `plugin`        — a marketplace/plugin reference (7.1); see
 *                       `validatePluginSource`.
 * Other source variants (`git`/`tarball`/`local`) are rejected for skills — a
 * plugin source is the correct external-skill representation (it preserves the
 * plugin namespace). File paths are validated for safety (no absolute, no `..`
 * traversal, no leading slash) since the install writer materializes them.
 */
function validateSkillResource(kind: ResourceKind, source: Resource['source']): void {
  if (kind !== 'skill') return;
  switch (source.type) {
    case 'inline':
      return; // single-file skill: content is the SKILL.md body
    case 'inline-bundle':
      validateBundlePaths(source.files);
      return;
    case 'plugin':
      validatePluginSource(source);
      return;
    default:
      // git / tarball / local: use 'plugin' for an external skill instead.
      throw new AppError(
        `A skill source must be 'inline', 'inline-bundle', or 'plugin', got '${source.type}'`,
        409,
        'INVALID_SKILL_SOURCE',
      );
  }
}

/**
 * Validate an `inline-bundle` skill's file map. Non-empty, contains `SKILL.md`
 * at root, and every path is relative with no traversal (the install writer
 * joins these onto a target directory).
 */
function validateBundlePaths(files: Record<string, string>): void {
  const paths = Object.keys(files);
  if (paths.length === 0) {
    throw new AppError('A skill bundle must contain at least one file', 400, 'VALIDATION_ERROR');
  }
  // One key must be exactly SKILL.md (at root).
  if (!paths.includes('SKILL.md')) {
    throw new AppError(
      "A skill bundle must contain a 'SKILL.md' at its root",
      409,
      'SKILL_BUNDLE_MISSING_SKILL_MD',
    );
  }
  for (const p of paths) {
    assertSafeRelativePath(p, 'skill bundle');
  }
}

/**
 * Validate a `plugin` skill source (Phase 7.1). Path safety on the optional
 * `path` field (the install writer joins it onto a target dir — same traversal
 * risk as bundle paths), and `npm` requires a version (the schema enforces
 * non-empty, but be explicit).
 */
function validatePluginSource(source: Extract<Resource['source'], { type: 'plugin' }>): void {
  const inner = source.source;
  if ('path' in inner && inner.path !== undefined) {
    assertSafeRelativePath(inner.path, 'plugin source');
  }
  if (inner.source === 'npm' && !inner.version) {
    throw new AppError('An npm plugin source requires a version', 400, 'VALIDATION_ERROR');
  }
}

/**
 * Reject paths that are unsafe to join onto a target directory: empty, absolute
 * (leading `/`), backslash, or `..` traversal. Windows-style backslashes are
 * rejected too.
 */
function assertSafeRelativePath(p: string, ctx: 'skill bundle' | 'plugin source'): void {
  if (isUnsafeRelativePath(p)) {
    throw new AppError(
      `Unsafe file path in ${ctx}: "${p}" (must be a relative path with no '..')`,
      400,
      'VALIDATION_ERROR',
    );
  }
}

/**
 * Phase 7.1 — stamp trust/provenance labels onto a `plugin`-source resource.
 * Trust and provenance are derived from the spec (a function of the repo
 * owner), so they ride on the existing `labels` field rather than new columns
 * — no migration needed. Other source kinds pass through unchanged.
 *
 * Authoritative label keys (overwrite any user-supplied value with the same
 * key; user labels coexist for everything else):
 *   - `trust`       — 'builtin' | 'trusted' | 'community' (from resolveTrustTier)
 *   - `pin`         — the sha / version string, omitted when floating
 *   - `provenance`  — short human string, e.g. 'anthropics/skills@sha:abc123'
 */
function withTrustLabels(resource: Resource): Resource {
  if (resource.source.type !== 'plugin') return resource;
  const tier = resolveTrustTier(resource.source.source);
  const inner = resource.source.source;
  const pin = 'sha' in inner && inner.sha ? inner.sha : resource.source.version;
  const ownerRepo = 'repo' in inner ? inner.repo : 'url' in inner ? inner.url : inner.package;
  const pinSuffix = pin ? `@${'sha' in inner && inner.sha ? 'sha:' + inner.sha : 'v' + pin}` : '';
  const provenance = `${ownerRepo}${pinSuffix}`;
  return {
    ...resource,
    labels: {
      ...(resource.labels ?? {}),
      trust: tier,
      ...(pin ? { pin } : {}),
      provenance,
    },
  };
}

/** A record is manageable iff owner (personal) or admin on a global row (#36). */
function canManage(r: Resource, userId: string, role: 'admin' | 'user'): boolean {
  return r.scope === 'global' ? role === 'admin' : r.ownerId === userId;
}
