// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import type { ApiToolService } from '@harness-nexus/core';
import type { ApiToolServiceBundle, ApiToolServiceView } from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import { executeApiTool } from '../api-tools/runtime.js';
import {
  createApiToolService,
  deleteApiToolService,
  getApiToolService,
  listApiToolServices,
  updateApiToolService,
} from '../services/api-tools.js';

/**
 * Issue #80 — API tool service routes: thin adapters over the #53 service
 * slice. The JSON bundle IS the interface (LLM-authored, upload/download —
 * no forms); validation lives in the shared zod schema (service-parsed), so
 * upload errors reach the authoring loop verbatim. The probe endpoint joins
 * with the runtime slice (allowlist + fetch + envelope), not this one.
 */

function toView(s: ApiToolService): ApiToolServiceView {
  return {
    id: s.id,
    scope: s.scope,
    ownerId: s.ownerId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    bundle: {
      version: 1,
      name: s.name,
      ...(s.description !== undefined ? { description: s.description } : {}),
      baseUrl: s.baseUrl,
      headers: s.headers,
      ...(s.auth !== undefined ? { auth: s.auth } : {}),
      tools: s.tools,
    } satisfies ApiToolServiceBundle,
  };
}

export async function apiToolsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = () => ({ uow: app.uow });

  app.get('/api/api-tools', guard, async (req) => {
    const services = await listApiToolServices(deps(), principalOf(req));
    return { services: services.map(toView) };
  });

  app.post<{ Params: { id: string } }>('/api/api-tools', guard, async (req, reply) => {
    // Body: { scope?: 'global'|'personal', bundle: <the JSON document> }.
    // Scope defaults to personal; global is admin-only (service-enforced).
    const body = (req.body ?? {}) as { scope?: unknown; bundle?: unknown };
    const created = await createApiToolService(deps(), principalOf(req), {
      ...(body.scope === 'global' ? { scope: 'global' as const } : {}),
      bundle: body.bundle,
    });
    return reply.code(201).send({ service: toView(created) });
  });

  app.get<{ Params: { id: string } }>('/api/api-tools/:id', guard, async (req) => {
    const service = await getApiToolService(deps(), principalOf(req), req.params.id);
    return { service: toView(service) };
  });

  app.put<{ Params: { id: string } }>('/api/api-tools/:id', guard, async (req) => {
    const body = (req.body ?? {}) as { bundle?: unknown };
    const service = await updateApiToolService(deps(), principalOf(req), req.params.id, {
      bundle: body.bundle,
    });
    return { service: toView(service) };
  });

  app.delete<{ Params: { id: string } }>('/api/api-tools/:id', guard, async (req) => {
    await deleteApiToolService(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });

  /**
   * #80 — the probe: run one tool call against the REAL target and show
   * exactly what the model would see. This is the LLM config loop's
   * behavioral gate (upload → probe → fix). Outbound side effect, so the
   * call stays at the route (#53 residue).
   */
  app.post<{ Params: { id: string } }>('/api/api-tools/:id/probe', guard, async (req) => {
    const service = await getApiToolService(deps(), principalOf(req), req.params.id);
    const body = (req.body ?? {}) as { tool?: unknown; args?: unknown };
    const toolName = typeof body.tool === 'string' ? body.tool : '';
    const args =
      typeof body.args === 'object' && body.args !== null
        ? (body.args as Record<string, unknown>)
        : {};
    const result = await executeApiTool(
      { uow: app.uow, credentialEncryptionKey: app.credentialEncryptionKey },
      service,
      toolName,
      args,
    );
    return {
      result: { output: result.output, isError: result.isError },
      ...(result.debug !== undefined ? { debug: result.debug } : {}),
    };
  });
}
