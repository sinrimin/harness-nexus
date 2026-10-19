import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * #54 — lazy session persistence: an assistant open that never sends leaves
 * NOTHING behind (no row, no rail entry); the first message is what turns
 * the ephemeral open into a persisted session. Legacy empty rows (written by
 * the pre-#54 open) stay hidden from the snapshot.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

async function setup() {
  const uow = createMemoryUnitOfWork();
  await uow.users.save({
    id: owner.userId,
    username: 'owner',
    email: null,
    passwordHash: null,
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await uow.credentials.save({
    id: 'cred-1',
    name: 'gw-key',
    secret: encryptSecret('sk-test', KEY),
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
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [{ id: 'gw-large', type: 'chat' }],
    createdAt: now,
    updatedAt: now,
  });

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    tokensPerSecond: 1_000_000,
  });
  const models = piAi.createModels();
  models.setProvider(faux.provider);

  const events: { sessionId: string; event: ChatStreamEvent }[] = [];
  const io: AssistantIO = {
    toChannel: (_sid, event, payload) => {
      if (event === 'assistant:event') {
        events.push(payload as { sessionId: string; event: ChatStreamEvent });
      }
    },
    toUser: () => undefined,
    joinChannel: () => undefined,
  };
  const svc = new AssistantRealtimeService(
    {
      uow,
      credentialEncryptionKey: KEY,
      skills: {
        search: { search: async () => ({ results: [], partial: false }) } as never,
        catalog: {} as never,
        allowlist: [],
      },
      buildModel: async () => ({
        model: faux.getModel('gw-large'),
        streamFn: models.streamSimple.bind(models),
      }),
    },
    io,
  );
  return { svc, uow, faux, events };
}

async function makeConfig(uow: ReturnType<typeof createMemoryUnitOfWork>): Promise<string> {
  const a = await createAssistant({ uow }, owner, {
    name: 'Ops',
    providerId: 'prov-1',
    defaultModel: 'gw-large',
    enabledToolGroups: ['system'],
  });
  return a.id;
}

async function settle(
  svc: AssistantRealtimeService,
  uow: ReturnType<typeof createMemoryUnitOfWork>,
  sessionId: string,
): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const rows = await uow.assistants.listMessages(sessionId);
    if (rows.length > 0 && rows[rows.length - 1]!.type === 'assistant') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('turn did not settle');
}

describe('#54 — lazy session persistence', () => {
  it('an open with no send leaves no row and no snapshot entry', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';
    expect(sessionId).not.toBe('');
    // The channel works (the ack returned a session id), but nothing hit the
    // DB — a refresh finds no such session.
    expect(await h.uow.assistants.findSessionById(sessionId)).toBeNull();
    expect((await h.svc.snapshotFor(owner.userId)).sessions).toEqual([]);
  });

  it('the FIRST message persists the session and it joins the snapshot', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('hello there')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    await settle(h.svc, h.uow, sessionId);
    expect(await h.uow.assistants.findSessionById(sessionId)).not.toBeNull();
    const snap = await h.svc.snapshotFor(owner.userId);
    expect(snap.sessions.map((s) => s.id)).toContain(sessionId);
    expect(snap.sessions.find((s) => s.id === sessionId)?.busy).toBe(false);
  });

  it('a legacy empty row (no messages, no live channel) stays hidden', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    await h.uow.assistants.saveSession({
      id: 'legacy-empty',
      ownerId: owner.userId,
      assistantId: id,
      title: '',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    });
    const snap = await h.svc.snapshotFor(owner.userId);
    expect(snap.sessions.map((s) => s.id)).not.toContain('legacy-empty');
  });
});

describe("#68 — mid-turn notes survive the turn's settle batch", () => {
  it('a dispatch-backflow note written mid-turn keeps its row and its seq', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('done talking')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    // The backflow note lands while the turn is still streaming — its seq
    // allocation must not collide with the turn's settle-time row batch
    // (pre-#68 the batch overwrote the note: both claimed max(seq)+1).
    await h.svc.addDispatchNote(sessionId, 'dispatch c1: the user stopped the driven agent turn');
    await settle(h.svc, h.uow, sessionId);
    const rows = await h.uow.assistants.listMessages(sessionId);
    const note = rows.find((r) => r.type === 'note' && r.text.includes('user stopped'));
    expect(note).toBeDefined();
    expect(note!.type === 'note' && note!.modelVisible).toBe(true);
    expect(rows.some((r) => r.type === 'assistant')).toBe(true);
    const seqs = rows.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
