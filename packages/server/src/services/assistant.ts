// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type {
  AssistantConfig,
  AssistantMessageRow,
  AssistantSession,
  AssistantToolGroup,
} from '@harness-nexus/core';
import {
  AppError,
  DEFAULT_ASSISTANT_TOOL_GROUPS,
  type AssistantConfigCreateInput,
  type AssistantConfigUpdateInput,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Assistant domain service (#52) — configs, sessions, and the persisted
 * transcript. Every row is OWNER-ONLY (#36 personal rule with no admin arm):
 * a stranger and an admin get the same 404. The runner (realtime/assistant)
 * calls these too — same door, no HTTP.
 *
 * A config's provider/model pair is validated against the #51 registry on
 * write (the picker only offers configured chat models, so a direct API
 * caller passing anything else is a 409, not a runtime surprise). A LATER
 * registry edit can still orphan a config's defaultModel — session build
 * then fails honestly with a failed event, by design.
 */

/** The provider must be readable by the owner (personal or global row). */
async function requireVisibleProvider(deps: ServiceDeps, principal: Principal, providerId: string) {
  const provider = await deps.uow.llmProviders.findById(providerId);
  if (!provider || (provider.scope === 'personal' && provider.ownerId !== principal.userId)) {
    throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
  }
  return provider;
}

/** The default model must be a configured `type:'chat'` entry on that provider. */
function assertModelOnProvider(
  defaultModel: string,
  models: { id: string; type: 'chat' | 'embedding' }[],
) {
  const model = models.find((m) => m.id === defaultModel);
  if (model === undefined || model.type !== 'chat') {
    throw new AppError(
      `Model "${defaultModel}" is not a configured chat model on this provider`,
      409,
      'ASSISTANT_MODEL_NOT_ON_PROVIDER',
    );
  }
}

export async function createAssistant(
  deps: ServiceDeps,
  principal: Principal,
  input: AssistantConfigCreateInput,
): Promise<AssistantConfig> {
  const provider = await requireVisibleProvider(deps, principal, input.providerId);
  assertModelOnProvider(input.defaultModel, provider.models);
  if (await deps.uow.assistants.findByName(principal.userId, input.name)) {
    throw new AppError(
      `Assistant name "${input.name}" is already taken`,
      409,
      'ASSISTANT_NAME_TAKEN',
    );
  }

  const now = new Date().toISOString();
  const config: AssistantConfig = {
    id: generateId(),
    ownerId: principal.userId,
    name: input.name,
    ...(input.description !== undefined && input.description !== ''
      ? { description: input.description }
      : {}),
    providerId: input.providerId,
    defaultModel: input.defaultModel,
    ...(input.systemPromptOverride !== undefined && input.systemPromptOverride !== ''
      ? { systemPromptOverride: input.systemPromptOverride }
      : {}),
    // Route-parsed input always carries the zod default; direct callers
    // (tests, future in-process doors) may omit it — same default applies.
    enabledToolGroups: (input.enabledToolGroups as AssistantToolGroup[] | undefined) ?? [
      ...DEFAULT_ASSISTANT_TOOL_GROUPS,
    ],
    mcpServerIds: await visibleMcpServerIds(deps, principal, input.mcpServerIds ?? []),
    skillResourceIds: await readableSkillResourceIds(deps, principal, input.skillResourceIds ?? []),
    ...(input.dailyTokenBudget !== undefined && input.dailyTokenBudget !== null
      ? { dailyTokenBudget: input.dailyTokenBudget }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  await deps.uow.assistants.save(config);
  return config;
}

export async function listAssistants(
  deps: ServiceDeps,
  principal: Principal,
): Promise<AssistantConfig[]> {
  return deps.uow.assistants.listByOwner(principal.userId);
}

/**
 * By id, soft-deleted included — a deleted config's sessions stay readable,
 * so the session page must still resolve its name. Only the OWNER ever gets
 * a row back.
 */
export async function getAssistant(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<AssistantConfig> {
  const config = await deps.uow.assistants.findById(id);
  if (!config || config.ownerId !== principal.userId) {
    throw new AppError('Assistant not found', 404, 'ASSISTANT_NOT_FOUND');
  }
  return config;
}

export async function updateAssistant(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: AssistantConfigUpdateInput,
): Promise<AssistantConfig> {
  const existing = await getAssistant(deps, principal, id);

  if (input.name !== undefined && input.name !== existing.name) {
    if (await deps.uow.assistants.findByName(principal.userId, input.name)) {
      throw new AppError(
        `Assistant name "${input.name}" is already taken`,
        409,
        'ASSISTANT_NAME_TAKEN',
      );
    }
  }
  // The new pair must be coherent WHENEVER either half moves.
  if (input.providerId !== undefined || input.defaultModel !== undefined) {
    const providerId = input.providerId ?? existing.providerId;
    const defaultModel = input.defaultModel ?? existing.defaultModel;
    const provider = await requireVisibleProvider(deps, principal, providerId);
    assertModelOnProvider(defaultModel, provider.models);
  }

  const next: AssistantConfig = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description === null ? undefined : input.description }
      : {}),
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
    ...(input.systemPromptOverride !== undefined
      ? {
          systemPromptOverride:
            input.systemPromptOverride === null ? undefined : input.systemPromptOverride,
        }
      : {}),
    ...(input.enabledToolGroups !== undefined
      ? { enabledToolGroups: input.enabledToolGroups as AssistantToolGroup[] }
      : {}),
    ...(input.mcpServerIds !== undefined
      ? { mcpServerIds: await visibleMcpServerIds(deps, principal, input.mcpServerIds) }
      : {}),
    ...(input.skillResourceIds !== undefined
      ? {
          skillResourceIds: await readableSkillResourceIds(deps, principal, input.skillResourceIds),
        }
      : {}),
    ...(input.dailyTokenBudget !== undefined
      ? {
          dailyTokenBudget: input.dailyTokenBudget === null ? undefined : input.dailyTokenBudget,
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  await deps.uow.assistants.save(next);
  return next;
}

/**
 * M2 — every referenced MCP server must be VISIBLE to the owner (a foreign
 * personal row 404-hides like everywhere else). Dialability is NOT judged
 * here: the server-dial pool is the truth at turn time, and an unavailable
 * row notes honestly in the prompt (the picker greys stored-dialSite 'client'
 * rows, 'auto' resolves per its credentials).
 */
async function visibleMcpServerIds(
  deps: ServiceDeps,
  principal: Principal,
  ids: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const server = await deps.uow.mcpServers.findById(id);
    if (
      !server ||
      server.deletedAt !== undefined ||
      (server.scope === 'personal' && server.ownerId !== principal.userId)
    ) {
      throw new AppError(`MCP server ${id} not found`, 404, 'MCP_SERVER_NOT_FOUND');
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * M2 — every referenced skill resource must be a VISIBLE, LIVE skill whose
 * source the platform can read in-process (inline / inline-bundle; external
 * sources need fetching and are rejected — pick content-borne skills).
 */
async function readableSkillResourceIds(
  deps: ServiceDeps,
  principal: Principal,
  ids: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const resource = await deps.uow.resources.findById(id);
    if (
      !resource ||
      resource.deletedAt !== undefined ||
      (resource.scope === 'personal' && resource.ownerId !== principal.userId)
    ) {
      throw new AppError(`Skill resource ${id} not found`, 404, 'RESOURCE_NOT_FOUND');
    }
    if (resource.kind !== 'skill') {
      throw new AppError(
        `Resource "${resource.name}" is a ${resource.kind}, not a skill`,
        409,
        'ASSISTANT_SKILL_NOT_SKILL',
      );
    }
    if (resource.source.type !== 'inline' && resource.source.type !== 'inline-bundle') {
      throw new AppError(
        `Skill "${resource.name}" uses an external source (${resource.source.type}); the assistant can only read inline or inline-bundle skills`,
        409,
        'ASSISTANT_SKILL_SOURCE_UNREADABLE',
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Soft-delete: pickers drop it, sessions stay readable. Idempotent. */
export async function deleteAssistant(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await getAssistant(deps, principal, id);
  if (existing.deletedAt !== undefined) return;
  await deps.uow.assistants.save({
    ...existing,
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// ---- sessions ----

export async function createAssistantSession(
  deps: ServiceDeps,
  principal: Principal,
  assistantId: string,
): Promise<AssistantSession> {
  const config = await getAssistant(deps, principal, assistantId);
  if (config.deletedAt !== undefined) {
    throw new AppError('This assistant was deleted', 409, 'ASSISTANT_DELETED');
  }
  const now = new Date().toISOString();
  const session: AssistantSession = {
    id: generateId(),
    ownerId: principal.userId,
    assistantId: config.id,
    title: '',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
  };
  await deps.uow.assistants.saveSession(session);
  return session;
}

/** The owner's sessions (all, or one assistant's), newest activity first. */
export async function listAssistantSessions(
  deps: ServiceDeps,
  principal: Principal,
  assistantId?: string,
): Promise<AssistantSession[]> {
  return deps.uow.assistants.listSessions(principal.userId, assistantId);
}

export async function getAssistantSession(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
): Promise<AssistantSession> {
  const session = await deps.uow.assistants.findSessionById(sessionId);
  if (!session || session.ownerId !== principal.userId) {
    throw new AppError('Session not found', 404, 'ASSISTANT_SESSION_NOT_FOUND');
  }
  return session;
}

/** Rename (title edit). Empty title clears back to the optimistic first-prompt. */
export async function updateAssistantSession(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  input: { title?: string },
): Promise<AssistantSession> {
  const existing = await getAssistantSession(deps, principal, sessionId);
  const next: AssistantSession = {
    ...existing,
    ...(input.title !== undefined ? { title: input.title.slice(0, 256) } : {}),
    updatedAt: new Date().toISOString(),
  };
  await deps.uow.assistants.saveSession(next);
  return next;
}

/** Hard delete — the transcript and audit rows cascade. */
export async function deleteAssistantSession(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
): Promise<void> {
  await getAssistantSession(deps, principal, sessionId);
  // #59 — the rows' image blobs die with them (no dedup: one ingest, one
  // object, one owner row). Collect BEFORE the rows cascade away.
  const rows = await deps.uow.assistants.listMessages(sessionId);
  const refs = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'user') continue;
    for (const b of row.blocks) {
      if (b.type === 'imageRef') refs.add(b.ref);
    }
  }
  await deps.uow.assistants.deleteSession(sessionId);
  for (const ref of refs) {
    await deps.uow.fileBlobs.delete(ref);
  }
}

// ---- transcript ----

export async function listAssistantMessages(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
): Promise<AssistantMessageRow[]> {
  await getAssistantSession(deps, principal, sessionId);
  return deps.uow.assistants.listMessages(sessionId);
}

/** The next transcript seq for a session (caller-allocated seq = max + 1). */
export async function nextAssistantSeq(deps: ServiceDeps, sessionId: string): Promise<number> {
  const rows = await deps.uow.assistants.listMessages(sessionId);
  return rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
}
