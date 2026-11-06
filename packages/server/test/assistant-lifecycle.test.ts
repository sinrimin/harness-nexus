// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

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

async function setup(
  opts: {
    viewerGraceMs?: number;
    tokensPerSecond?: number;
    /**
     * #120 — omit the buildModel seam so the turn runs the REAL
     * resolveTurnModel (whose credential decrypt is the crash path under
     * test), optionally under a key that cannot decrypt the stored
     * credential.
     */
    noBuildModel?: boolean;
    serviceKey?: string;
  } = {},
) {
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
    apis: [{ kind: 'openai-chat', path: null }],
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [{ id: 'gw-large', apiKind: 'openai-chat' }],
    createdAt: now,
    updatedAt: now,
  });

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    tokensPerSecond: opts.tokensPerSecond ?? 1_000_000,
  });
  const models = piAi.createModels();
  models.setProvider(faux.provider);

  const events: { sessionId: string; event: ChatStreamEvent }[] = [];
  /** #57 — the owner's live /app sockets, driven per test. */
  const sockets: string[] = [];
  const io: AssistantIO = {
    toChannel: (_sid, event, payload) => {
      if (event === 'assistant:event') {
        events.push(payload as { sessionId: string; event: ChatStreamEvent });
      }
    },
    toUser: () => undefined,
    joinChannel: () => undefined,
    userSockets: async () => [...sockets],
  };
  const svc = new AssistantRealtimeService(
    {
      uow,
      credentialEncryptionKey: opts.serviceKey ?? KEY,
      skills: {
        search: { search: async () => ({ results: [], partial: false }) } as never,
        catalog: {} as never,
        allowlist: [],
      },
      titleRefine: false,
      ...(opts.noBuildModel === true
        ? {}
        : {
            buildModel: async () => ({
              model: faux.getModel('gw-large'),
              streamFn: models.streamSimple.bind(models),
            }),
          }),
    },
    io,
    undefined,
    {
      permissionTimeoutMs: 120_000,
      viewerGraceMs: opts.viewerGraceMs ?? 0,
    },
  );
  return { svc, uow, faux, events, sockets };
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

/** #120 — poll until `minCount` `error:` notes have landed (failed settles). */
async function settleErrorNote(
  uow: ReturnType<typeof createMemoryUnitOfWork>,
  sessionId: string,
  minCount = 1,
): Promise<string> {
  for (let i = 0; i < 500; i += 1) {
    const rows = await uow.assistants.listMessages(sessionId);
    const notes = rows.filter((r) => r.type === 'note' && r.text.startsWith('error: '));
    if (notes.length >= minCount) return notes[notes.length - 1]!.text;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('failed turn did not settle an error note');
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

describe('#120 — an unexpected turn failure ends the turn, never the process', () => {
  it('a credential that cannot decrypt settles an internal-error note and releases the gate', async () => {
    // The service runs the REAL resolveTurnModel (no buildModel seam) under
    // a key that cannot decrypt the stored credential: decryptSecret throws
    // a plain crypto error mid-setup. Pre-#120 that rejection escaped the
    // `void this.startTurn(...)` fire and killed the process (an unhandled
    // rejection fails this file too, so passing IS the no-crash proof).
    const h = await setup({ noBuildModel: true, serviceKey: 'a-different-key' });
    const id = await makeConfig(h.uow);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');

    const text = await settleErrorNote(h.uow, sessionId);
    expect(text).toContain('internal error:');
    // The busy gate released — the user is not wedged.
    expect(h.svc.isBusy(sessionId)).toBe(false);

    // A SECOND send on the same session settles the same honest way — the
    // service is fully alive after the failure.
    await h.svc.onMessageSend(owner.userId, sessionId, 'again');
    await settleErrorNote(h.uow, sessionId, 2);
    expect(h.svc.isBusy(sessionId)).toBe(false);
  });
});

describe('#57 — abrupt viewer loss reaps the live channel under grace', () => {
  it('grace 0 (legacy semantics): last socket gone closes an idle channel — the flag no longer leaks', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('hello there')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    await settle(h.svc, h.uow, sessionId);
    expect(h.svc.isLive(sessionId)).toBe(true);

    // The tab dies without assistant:session.close — with no other socket
    // of the owner, the channel closes immediately (grace 0).
    await h.svc.onViewerGone(owner.userId);
    expect(h.svc.isLive(sessionId)).toBe(false);
    // The rail unpaints with it.
    expect(
      (await h.svc.snapshotFor(owner.userId)).sessions.find((x) => x.id === sessionId)?.busy,
    ).toBe(false);
  });

  it('a live sibling socket keeps the channel (liveness is user-scoped)', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('hello there')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    await settle(h.svc, h.uow, sessionId);

    h.sockets.push('sock-2'); // another window of the same user
    await h.svc.onViewerGone(owner.userId);
    expect(h.svc.isLive(sessionId)).toBe(true);
  });

  it('grace > 0: a reconnect within the window cancels the reap', async () => {
    const h = await setup({ viewerGraceMs: 10_000 });
    const id = await makeConfig(h.uow);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';

    await h.svc.onViewerGone(owner.userId); // arms the timer
    h.svc.onViewerBack(owner.userId); // the browser came back in time
    await new Promise((r) => setTimeout(r, 30));
    expect(h.svc.isLive(sessionId)).toBe(true);
  });

  it('grace > 0: the reap fires after the window', async () => {
    const h = await setup({ viewerGraceMs: 25 });
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('hello there')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    await settle(h.svc, h.uow, sessionId);

    await h.svc.onViewerGone(owner.userId);
    await new Promise((r) => setTimeout(r, 80));
    expect(h.svc.isLive(sessionId)).toBe(false);
  });

  it('isBusy tracks the running turn — the #75 delete branch', async () => {
    // A slow stream (not the 1M-tokens/s default) keeps the turn running
    // across the assertions.
    const h = await setup({ tokensPerSecond: 40 });
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('still working on it')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    // Idle live channel: live, not busy — deletable via close-then-delete.
    expect(h.svc.isLive(sessionId)).toBe(true);
    expect(h.svc.isBusy(sessionId)).toBe(false);
    const sent = h.svc.onMessageSend(owner.userId, sessionId, 'go');
    await new Promise((r) => setTimeout(r, 30)); // the turn starts
    expect(h.svc.isBusy(sessionId)).toBe(true); // running: delete must refuse
    await sent;
    await settle(h.svc, h.uow, sessionId);
    expect(h.svc.isBusy(sessionId)).toBe(false); // back to idle
  });

  it('a mid-turn loss never aborts the run: the channel closes at settle', async () => {
    const h = await setup({ viewerGraceMs: 0 });
    const id = await makeConfig(h.uow);
    // A slow provider: the turn is still streaming when the viewer dies.
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxText('still working…')], { partial: true }),
      piAi.fauxAssistantMessage([piAi.fauxText('all done')]),
    ]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    const sent = h.svc.onMessageSend(owner.userId, sessionId, 'go');

    await h.svc.onViewerGone(owner.userId); // mid-turn: flips closeWhenIdle
    expect(h.svc.isLive(sessionId)).toBe(true); // the run is protected
    await sent;
    await settle(h.svc, h.uow, sessionId);
    // Settle closed the channel; the transcript still persisted.
    expect(h.svc.isLive(sessionId)).toBe(false);
    const rows = await h.uow.assistants.listMessages(sessionId);
    expect(rows.some((r) => r.type === 'assistant')).toBe(true);
  });
});
