// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import type { AssistantConfig, AssistantSession } from '@harness-nexus/core';
import {
  AppError,
  assistantConfigCreateSchema,
  assistantConfigUpdateSchema,
  type AssistantConfigView,
  type AssistantSessionView,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import {
  createAssistant,
  createAssistantSession,
  deleteAssistant,
  deleteAssistantSession,
  getAssistant,
  getAssistantSession,
  listAssistantMessages,
  listAssistantSessions,
  listAssistants,
  updateAssistant,
  updateAssistantSession,
} from '../services/assistant.js';

/**
 * Assistant REST routes (#52) — thin HTTP adapters over the domain service.
 * Owner-only rows: the service 404-hides foreign ids for every role (the
 * realtime runner calls the same service functions with the session owner as
 * principal — one door, rule 7).
 */
export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = () => ({ uow: app.uow });

  // ---- configs ----

  app.post('/api/assistants', guard, async (req, reply) => {
    const input = assistantConfigCreateSchema.parse(req.body);
    const config = await createAssistant(deps(), principalOf(req), input);
    return reply.code(201).send({ assistant: toConfigView(config) });
  });

  app.get('/api/assistants', guard, async (req) => {
    const configs = await listAssistants(deps(), principalOf(req));
    return { assistants: configs.map(toConfigView) };
  });

  app.get<{ Params: { id: string } }>('/api/assistants/:id', guard, async (req) => {
    const config = await getAssistant(deps(), principalOf(req), req.params.id);
    return { assistant: toConfigView(config) };
  });

  app.patch<{ Params: { id: string } }>('/api/assistants/:id', guard, async (req) => {
    const input = assistantConfigUpdateSchema.parse(req.body);
    const config = await updateAssistant(deps(), principalOf(req), req.params.id, input);
    return { assistant: toConfigView(config) };
  });

  app.delete<{ Params: { id: string } }>('/api/assistants/:id', guard, async (req) => {
    await deleteAssistant(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });

  // ---- sessions ----

  app.post<{ Params: { id: string } }>(
    '/api/assistants/:id/sessions',
    guard,
    async (req, reply) => {
      const session = await createAssistantSession(deps(), principalOf(req), req.params.id);
      return reply.code(201).send({ session: toSessionView(session) });
    },
  );

  app.get<{ Params: { id: string } }>('/api/assistants/:id/sessions', guard, async (req) => {
    const sessions = await listAssistantSessions(deps(), principalOf(req), req.params.id);
    return { sessions: sessions.map(toSessionView) };
  });

  app.get('/api/assistant-sessions', guard, async (req) => {
    const sessions = await listAssistantSessions(deps(), principalOf(req));
    return { sessions: sessions.map(toSessionView) };
  });

  app.get<{ Params: { id: string } }>('/api/assistant-sessions/:id', guard, async (req) => {
    const session = await getAssistantSession(deps(), principalOf(req), req.params.id);
    const config = await getAssistant(deps(), principalOf(req), session.assistantId);
    return { session: toSessionView(session), assistant: toConfigView(config) };
  });

  app.patch<{ Params: { id: string } }>('/api/assistant-sessions/:id', guard, async (req) => {
    const body = (req.body ?? {}) as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title : undefined;
    const session = await updateAssistantSession(deps(), principalOf(req), req.params.id, {
      ...(title !== undefined ? { title } : {}),
    });
    return { session: toSessionView(session) };
  });

  app.delete<{ Params: { id: string } }>('/api/assistant-sessions/:id', guard, async (req) => {
    // Ownership FIRST (the service 404-hides foreign ids for every role),
    // then the #55 live guard — a live channel would keep writing into
    // deleted rows. Realtime state, so the check lives here, not in the
    // service (#53).
    const session = await getAssistantSession(deps(), principalOf(req), req.params.id);
    if (app.realtime.assistant.isLive(session.id)) {
      throw new AppError('Session is open — close it first', 409, 'ASSISTANT_SESSION_LIVE');
    }
    await deleteAssistantSession(deps(), principalOf(req), session.id);
    // The rail's snapshot would otherwise keep the deleted row until the
    // next sync — push the fresh list to the owner.
    await app.realtime.assistant.pushSessions(principalOf(req).userId);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>(
    '/api/assistant-sessions/:id/messages',
    guard,
    async (req) => {
      const rows = await listAssistantMessages(deps(), principalOf(req), req.params.id);
      return { messages: rows };
    },
  );
}

function toConfigView(c: AssistantConfig): AssistantConfigView {
  return {
    id: c.id,
    ownerId: c.ownerId,
    name: c.name,
    ...(c.description !== undefined ? { description: c.description } : {}),
    providerId: c.providerId,
    defaultModel: c.defaultModel,
    ...(c.systemPromptOverride !== undefined
      ? { systemPromptOverride: c.systemPromptOverride }
      : {}),
    enabledToolGroups: c.enabledToolGroups,
    mcpServerIds: c.mcpServerIds ?? [],
    skillResourceIds: c.skillResourceIds ?? [],
    dailyTokenBudget: c.dailyTokenBudget ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function toSessionView(s: AssistantSession): AssistantSessionView {
  return {
    id: s.id,
    ownerId: s.ownerId,
    assistantId: s.assistantId,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastMessageAt: s.lastMessageAt,
  };
}
