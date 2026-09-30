import type { FastifyInstance } from 'fastify';
import type { Credential, LlmProvider } from '@harness-nexus/core';
import {
  AppError,
  llmProviderCreateSchema,
  llmProviderUpdateSchema,
  providerModelsQuerySchema,
  type LlmProviderCreateInput,
  type LlmProviderUpdateInput,
  type LlmProviderView,
  type ProviderApiKind,
} from '@harness-nexus/shared';
import { generateId, decryptSecret } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import { ProviderModelsError, fetchProviderModels } from '../infra/provider-models.js';

/**
 * LLM provider management (Phase 9 W10) — cc-switch-style reusable routes.
 * wiki design-phase-9-w10-llm-providers.md.
 *
 * A provider is the ROUTE, never the secret: the API key lives in the
 * Credential store (referenced by name). Scope rules mirror credentials —
 * global: any user reads, admin mutates; personal: owner-only — with 404
 * existence-hiding for foreign rows. Model-list discovery resolves + decrypts
 * the credential SERVER-SIDE (the plaintext never reaches the browser) and
 * is the platform's second deliberate outbound HTTP surface.
 */
export async function llmProviderRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const key = app.credentialEncryptionKey;

  /**
   * The credential must exist AND be resolvable in the caller's namespace
   * (#21). A GLOBAL credential additionally only travels to a
   * caller-controlled URL when the admin allowed it: admins may always, and
   * regular users only when the URL comes from a stored (admin-chosen)
   * provider config or the secret is marked distributable — a locked global
   * secret never leaves for an endpoint the caller picked.
   */
  const visibleCredential = async (
    name: string,
    caller: { id: string; role: 'admin' | 'user' },
    callerControlsUrl: boolean,
  ): Promise<Credential> => {
    const cred = await findCredentialForOwner(app.uow, name, caller.id);
    if (!cred) {
      throw new AppError(`Credential "${name}" not found`, 404, 'CREDENTIAL_NOT_FOUND');
    }
    if (
      cred.scope === 'global' &&
      caller.role !== 'admin' &&
      callerControlsUrl &&
      !cred.distributable
    ) {
      throw new AppError(
        `Credential "${name}" is a locked global secret — it cannot be used from a caller-chosen endpoint (ask an admin, or mark it distributable)`,
        403,
        'CREDENTIAL_NOT_DISTRIBUTABLE',
      );
    }
    return cred;
  };

  const nameTaken = async (
    name: string,
    scope: 'global' | 'personal',
    ownerId: string | null,
    exceptId?: string,
  ): Promise<boolean> => {
    const existing = await app.uow.llmProviders.findByName(
      name,
      scope,
      scope === 'global' ? undefined : (ownerId ?? undefined),
    );
    return existing !== null && existing.id !== exceptId;
  };

  // ---- POST /api/llm-providers ----
  app.post('/api/llm-providers', guard, async (req, reply) => {
    const input = llmProviderCreateSchema.parse(req.body) as LlmProviderCreateInput & {
      scope: 'global' | 'personal';
    };

    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global providers', 403, 'FORBIDDEN');
    }
    // A personal provider's baseUrl is caller-chosen; a global provider's is
    // admin-chosen (admin-only create) — drives the credential gate above.
    await visibleCredential(input.credentialName, req.user!, input.scope === 'personal');
    const ownerId = input.scope === 'global' ? null : req.user!.id;
    if (await nameTaken(input.name, input.scope, ownerId)) {
      throw new AppError(
        `Provider name "${input.name}" is already taken in this scope`,
        409,
        'PROVIDER_NAME_TAKEN',
      );
    }

    const now = new Date().toISOString();
    const provider: LlmProvider = {
      id: generateId(),
      name: input.name,
      api: input.api,
      baseUrl: input.baseUrl ?? null,
      credentialName: input.credentialName,
      scope: input.scope,
      ownerId,
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.llmProviders.save(provider);
    return reply.code(201).send({ provider: toView(provider) });
  });

  // ---- GET /api/llm-providers ----
  app.get('/api/llm-providers', guard, async (req) => {
    const [personal, global] = await Promise.all([
      app.uow.llmProviders.list({ scope: 'personal', ownerId: req.user!.id }),
      app.uow.llmProviders.list({ scope: 'global' }),
    ]);
    return { providers: [...personal, ...global].map(toView) };
  });

  // ---- PATCH /api/llm-providers/:id ----
  app.patch<{ Params: { id: string } }>('/api/llm-providers/:id', guard, async (req) => {
    const input = llmProviderUpdateSchema.parse(req.body) as LlmProviderUpdateInput;
    const existing = await app.uow.llmProviders.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
    }

    if (input.credentialName !== undefined && input.credentialName !== existing.credentialName) {
      await visibleCredential(input.credentialName, req.user!, existing.scope === 'personal');
    }
    if (input.name !== undefined && input.name !== existing.name) {
      if (await nameTaken(input.name, existing.scope, existing.ownerId, existing.id)) {
        throw new AppError(
          `Provider name "${input.name}" is already taken in this scope`,
          409,
          'PROVIDER_NAME_TAKEN',
        );
      }
    }

    const next: LlmProvider = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.api !== undefined ? { api: input.api } : {}),
      // `baseUrl: null` clears the override back to the official endpoint.
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.credentialName !== undefined ? { credentialName: input.credentialName } : {}),
      updatedAt: new Date().toISOString(),
    };
    await app.uow.llmProviders.save(next);
    return { provider: toView(next) };
  });

  // ---- DELETE /api/llm-providers/:id ----
  app.delete<{ Params: { id: string } }>('/api/llm-providers/:id', guard, async (req) => {
    const existing = await app.uow.llmProviders.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    await app.uow.llmProviders.delete(existing.id);
    return { ok: true };
  });

  // ---- POST /api/llm-providers/query-models — the 获取模型 button ----
  // Accepts a stored `providerId` OR explicit `{api, baseUrl?, credentialName}`
  // (the create dialog / machine-page manual arm use it BEFORE anything is
  // saved, mirroring cc-switch's fetch-from-form behavior).
  app.post('/api/llm-providers/query-models', guard, async (req) => {
    const input = providerModelsQuerySchema.parse(req.body);

    let api: ProviderApiKind;
    let baseUrl: string | undefined;
    let credentialName: string;
    /** Who chose the endpoint: stored rows carry their owner's trust level. */
    let callerControlsUrl: boolean;
    if (input.providerId !== undefined) {
      const provider = await app.uow.llmProviders.findById(input.providerId);
      if (!provider || !visibleTo(provider, req.user!.id)) {
        throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
      }
      api = provider.api;
      baseUrl = provider.baseUrl ?? undefined;
      credentialName = provider.credentialName;
      callerControlsUrl = provider.scope === 'personal';
    } else {
      api = input.api!;
      baseUrl = input.baseUrl;
      credentialName = input.credentialName!;
      callerControlsUrl = true;
    }

    const cred = await visibleCredential(credentialName, req.user!, callerControlsUrl);
    const secret = decryptSecret(cred.secret, key);
    try {
      const models = await fetchProviderModels(
        { api, ...(baseUrl !== undefined ? { baseUrl } : {}), apiKey: secret },
        { timeoutMs: app.providerModelsTimeoutMs },
      );
      return { models };
    } catch (err) {
      if (err instanceof ProviderModelsError) {
        if (err.kind === 'timeout') {
          throw new AppError(err.message, 504, 'PROVIDER_MODELS_TIMEOUT');
        }
        throw new AppError(err.message, 502, 'PROVIDER_MODELS_FAILED');
      }
      throw err;
    }
  });
}

function toView(p: LlmProvider): LlmProviderView {
  return {
    id: p.id,
    name: p.name,
    api: p.api,
    baseUrl: p.baseUrl,
    credentialName: p.credentialName,
    scope: p.scope,
    ownerId: p.ownerId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** A row is manageable iff owner (personal) or admin on a global row (#36). */
function canManage(p: LlmProvider, userId: string, role: 'admin' | 'user'): boolean {
  return p.scope === 'global' ? role === 'admin' : p.ownerId === userId;
}

/** A row is readable iff admin, owner, or global (credentials' read rule). */
function visibleTo(p: LlmProvider, userId: string): boolean {
  return p.scope === 'global' || p.ownerId === userId;
}
