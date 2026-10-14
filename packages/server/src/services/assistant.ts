import type {
  AssistantConfig,
  AssistantMessageRow,
  AssistantSession,
  AssistantToolGroup,
} from '@harness-nexus/core';
import {
  AppError,
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
    enabledToolGroups: input.enabledToolGroups as AssistantToolGroup[],
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
    updatedAt: new Date().toISOString(),
  };
  await deps.uow.assistants.save(next);
  return next;
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
  await deps.uow.assistants.deleteSession(sessionId);
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
