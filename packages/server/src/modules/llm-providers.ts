// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import type { LlmProvider } from '@harness-nexus/core';
import {
  llmProviderCreateSchema,
  llmProviderUpdateSchema,
  providerModelsQuerySchema,
  type LlmProviderCreateInput,
  type LlmProviderUpdateInput,
  type LlmProviderView,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import {
  createLlmProvider,
  deleteLlmProvider,
  listLlmProviders,
  queryProviderModels,
  updateLlmProvider,
} from '../services/llm-providers.js';

/**
 * LLM provider routes (Phase 9 W10) — thin HTTP adapters over the domain
 * service (`services/llm-providers.ts`, #53 slice 6). Every scope/credential
 * gate lives in the service; this file authenticates, parses the wire shape
 * (the credential plaintext never reaches the browser), and frames the view.
 */
export async function llmProviderRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const deps = () => ({
    uow: app.uow,
    credentialEncryptionKey: app.credentialEncryptionKey,
    providerModelsTimeoutMs: app.providerModelsTimeoutMs,
  });

  // ---- POST /api/llm-providers ----
  app.post('/api/llm-providers', guard, async (req, reply) => {
    const input = llmProviderCreateSchema.parse(req.body) as LlmProviderCreateInput & {
      scope: 'global' | 'personal';
    };
    const provider = await createLlmProvider(deps(), principalOf(req), input);
    return reply.code(201).send({ provider: toView(provider) });
  });

  // ---- GET /api/llm-providers ----
  app.get('/api/llm-providers', guard, async (req) => {
    const providers = await listLlmProviders(deps(), principalOf(req));
    return { providers: providers.map(toView) };
  });

  // ---- PATCH /api/llm-providers/:id ----
  app.patch<{ Params: { id: string } }>('/api/llm-providers/:id', guard, async (req) => {
    const input = llmProviderUpdateSchema.parse(req.body) as LlmProviderUpdateInput;
    const provider = await updateLlmProvider(deps(), principalOf(req), req.params.id, input);
    return { provider: toView(provider) };
  });

  // ---- DELETE /api/llm-providers/:id ----
  app.delete<{ Params: { id: string } }>('/api/llm-providers/:id', guard, async (req) => {
    await deleteLlmProvider(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });

  // ---- POST /api/llm-providers/query-models — the 获取模型 button ----
  app.post('/api/llm-providers/query-models', guard, async (req) => {
    const input = providerModelsQuerySchema.parse(req.body);
    const models = await queryProviderModels(deps(), principalOf(req), input);
    return { models };
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
    models: p.models ?? [],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
