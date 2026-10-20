// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import {
  createAssistant,
  createAssistantSession,
  deleteAssistant,
  getAssistant,
  listAssistantMessages,
  listAssistants,
  listAssistantSessions,
  updateAssistant,
} from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';

/**
 * #52 — the assistant domain service, tested DIRECTLY against the memory
 * driver (the realtime runner calls this same door). Asserts the owner-only
 * rule (admin gets the same 404 as a stranger), name uniqueness per owner,
 * provider/model coherence against the #51 registry, and the soft-delete
 * lifecycle (pickers drop it, sessions stay readable).
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

const now = '2026-10-14T00:00:00.000Z';

async function seed() {
  const uow = createMemoryUnitOfWork();
  await uow.credentials.save({
    id: 'cred-1',
    name: 'k',
    secret: encryptSecret('sk', KEY),
    scope: 'personal',
    ownerId: owner.userId,
    distributable: true,
    createdAt: now,
    updatedAt: now,
  });
  await uow.llmProviders.save({
    id: 'prov-1',
    name: 'Gateway',
    api: 'openai-chat',
    baseUrl: null,
    credentialName: 'k',
    scope: 'personal',
    ownerId: owner.userId,
    models: [
      { id: 'chat-a', type: 'chat' },
      { id: 'embed-a', type: 'embedding' },
    ],
    createdAt: now,
    updatedAt: now,
  });
  return { uow };
}

describe('#52 assistant service', () => {
  it('creates with defaults, lists owner-only, and enforces per-owner name uniqueness', async () => {
    const { uow } = await seed();
    const a = await createAssistant({ uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'chat-a',
    });
    expect(a.enabledToolGroups).toContain('resources');
    expect(a.ownerId).toBe(owner.userId);

    // A foreign provider is invisible → 404, not 403.
    await expect(
      createAssistant({ uow }, stranger, {
        name: 'X',
        providerId: 'prov-1',
        defaultModel: 'chat-a',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'PROVIDER_NOT_FOUND' });

    await expect(
      createAssistant({ uow }, owner, {
        name: 'Ops',
        providerId: 'prov-1',
        defaultModel: 'chat-a',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ASSISTANT_NAME_TAKEN' });

    expect(await listAssistants({ uow }, owner)).toHaveLength(1);
    expect(await listAssistants({ uow }, stranger)).toHaveLength(0);
  });

  it('rejects models that are not configured chat entries on the provider', async () => {
    const { uow } = await seed();
    await expect(
      createAssistant({ uow }, owner, { name: 'A', providerId: 'prov-1', defaultModel: 'nope' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' });
    // The embedding entry exists but is not a chat model.
    await expect(
      createAssistant({ uow }, owner, { name: 'A', providerId: 'prov-1', defaultModel: 'embed-a' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' });
  });

  it('owner-only reads for every role (404 hiding), update coherence, soft delete', async () => {
    const { uow } = await seed();
    const a = await createAssistant({ uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'chat-a',
    });
    for (const p of [stranger, admin]) {
      await expect(getAssistant({ uow }, p, a.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'ASSISTANT_NOT_FOUND',
      });
    }

    // Updating only the model still validates against the provider pair.
    await expect(
      updateAssistant({ uow }, owner, a.id, { defaultModel: 'embed-a' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' });

    const renamed = await updateAssistant({ uow }, owner, a.id, { name: 'Ops2' });
    expect(renamed.name).toBe('Ops2');

    // Soft delete: gone from pickers, still readable by id (sessions stay
    // openable), and the NAME frees for reuse.
    await deleteAssistant({ uow }, owner, a.id);
    await deleteAssistant({ uow }, owner, a.id); // idempotent
    expect(await listAssistants({ uow }, owner)).toHaveLength(0);
    expect((await getAssistant({ uow }, owner, a.id)).deletedAt).toBeDefined();
    const reused = await createAssistant({ uow }, owner, {
      name: 'Ops2',
      providerId: 'prov-1',
      defaultModel: 'chat-a',
    });
    expect(reused.id).not.toBe(a.id);
  });

  it('sessions: owner-only, newest-activity order, no new sessions on deleted configs', async () => {
    const { uow } = await seed();
    const a = await createAssistant({ uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'chat-a',
    });
    const s1 = await createAssistantSession({ uow }, owner, a.id);
    const s2 = await createAssistantSession({ uow }, owner, a.id);
    await expect(createAssistantSession({ uow }, stranger, a.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSISTANT_NOT_FOUND',
    });

    // s2 has the newer activity → listed first. (Relative to the wall clock:
    // a fixed date crossed by midnight made this flip.)
    const ahead = new Date(Date.now() + 60_000).toISOString();
    await uow.assistants.saveSession({
      ...s2,
      lastMessageAt: ahead,
      updatedAt: ahead,
    });
    const sessions = await listAssistantSessions({ uow }, owner);
    expect(sessions.map((s) => s.id)).toEqual([s2.id, s1.id]);
    expect(await listAssistantSessions({ uow }, owner, a.id)).toHaveLength(2);
    await expect(listAssistantSessions({ uow }, stranger)).resolves.toHaveLength(0);

    // Transcript access is owner-only too.
    await uow.assistants.appendMessage(s1.id, {
      seq: 1,
      type: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
    });
    await expect(listAssistantMessages({ uow }, owner, s1.id)).resolves.toHaveLength(1);
    await expect(listAssistantMessages({ uow }, admin, s1.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'ASSISTANT_SESSION_NOT_FOUND',
    });

    await deleteAssistant({ uow }, owner, a.id);
    await expect(createAssistantSession({ uow }, owner, a.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSISTANT_DELETED',
    });
    // The existing session stays fully readable.
    await expect(listAssistantMessages({ uow }, owner, s1.id)).resolves.toHaveLength(1);
  });
});
