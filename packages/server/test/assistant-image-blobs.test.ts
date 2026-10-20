// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import { deleteAssistantSession } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * #59 — the assistant image-blob flow, end to end through the realtime
 * coordinator on the memory driver: the send path splits wire image blocks
 * into blob stores + persisted `imageRef` blocks (bytes never enter a row),
 * the expiry stamp comes from the retention setting AT INGEST (changes are
 * not retroactive), the replay resolves refs back to inline data, an expired
 * blob degrades to a placeholder, and deleting the session deletes its blobs.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };

const IMG_B64 = Buffer.from('fake-png-bytes').toString('base64');

async function setup() {
  const uow = createMemoryUnitOfWork();
  await uow.users.save({
    id: owner.userId,
    username: 'owner',
    email: null,
    passwordHash: null,
    role: 'user',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await uow.credentials.save({
    id: 'cred-1',
    name: 'gw-key',
    secret: encryptSecret('sk-test', KEY),
    scope: 'personal',
    ownerId: owner.userId,
    distributable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await uow.llmProviders.save({
    id: 'prov-1',
    name: 'Gateway',
    api: 'openai-chat',
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [{ id: 'gw-large', type: 'chat', vision: true }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'G', contextWindow: 64_000 }],
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
    userSockets: async () => [],
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

  const config = await createAssistant({ uow }, owner, {
    name: 'Ops',
    providerId: 'prov-1',
    defaultModel: 'gw-large',
    enabledToolGroups: ['system'],
  });
  return { svc, uow, faux, events, configId: config.id };
}

/**
 * Wait until the session holds exactly `wantUsers` user rows, the LAST user
 * row already has its assistant answer (a queued send must actually FLUSH —
 * turn-1's idle event alone must not pass this), and the stream went idle.
 */
async function settle(
  h: {
    uow: ReturnType<typeof createMemoryUnitOfWork>;
    events: { sessionId: string; event: ChatStreamEvent }[];
  },
  sessionId: string,
  wantUsers: number,
): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const rows = await h.uow.assistants.listMessages(sessionId);
    const types = rows.map((r) => r.type);
    const lastUserIdx = types.lastIndexOf('user');
    const answered =
      lastUserIdx !== -1 && rows.slice(lastUserIdx + 1).some((r) => r.type === 'assistant');
    if (
      types.filter((t) => t === 'user').length >= wantUsers &&
      answered &&
      h.events.at(-1)?.event.kind === 'session_status'
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('turn did not settle');
}

describe('#59 assistant image blobs (realtime, memory driver)', () => {
  it('send splits image blocks into blob + imageRef; the row never holds bytes', async () => {
    const h = await setup();
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('ok')])]);

    const send = await h.svc.onMessageSend(owner.userId, sessionId, [
      { type: 'text', text: 'look' },
      { type: 'image', data: IMG_B64, mimeType: 'image/png' },
    ]);
    expect(send.ok).toBe(true);
    await settle(h, sessionId, 1);
    const rows = await h.uow.assistants.listMessages(sessionId);
    const userRow = rows.find((r) => r.type === 'user');
    expect(userRow && userRow.type === 'user').toBe(true);
    const blocks = userRow!.type === 'user' ? userRow.blocks : [];
    expect(blocks.map((b) => b.type)).toEqual(['text', 'imageRef']);
    const ref = blocks[1]!;
    if (ref.type !== 'imageRef') throw new Error('expected imageRef');
    const blob = await h.uow.fileBlobs.get(ref.ref);
    expect(blob).not.toBeNull();
    expect(Buffer.from(blob!.data).toString('base64')).toBe(IMG_B64);

    // The user_message echo carried the INLINE wire view (UI shows the image).
    const echo = h.events.find((e) => e.event.kind === 'user_message');
    expect(
      echo && echo.event.kind === 'user_message' ? echo.event.blocks.map((b) => b.type) : [],
    ).toEqual(['text', 'image']);
  });

  it('retention is stamped at ingest; changing the setting is not retroactive', async () => {
    const h = await setup();
    await h.uow.settings.save({
      ...(await h.uow.settings.get()),
      imageRetentionDays: 1,
      updatedAt: new Date().toISOString(),
    });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('a')])]);
    await h.svc.onMessageSend(owner.userId, sessionId, [
      { type: 'image', data: IMG_B64, mimeType: 'image/png' },
    ]);
    await settle(h, sessionId, 1);

    const firstRef = async (): Promise<string> => {
      const rows = await h.uow.assistants.listMessages(sessionId);
      const u = rows.find((r) => r.type === 'user');
      const b =
        u !== undefined && u.type === 'user'
          ? u.blocks.find((x) => x.type === 'imageRef')
          : undefined;
      if (b === undefined || b.type !== 'imageRef') throw new Error('no imageRef');
      return b.ref;
    };
    const r1 = await firstRef();
    const blob1 = await h.uow.fileBlobs.get(r1);
    const day1 = 86_400_000;
    expect(blob1!.row.expiresAt > new Date(Date.now() + day1 - 60_000).toISOString()).toBe(true);

    // Change the setting AFTER the ingest — the first blob keeps its stamp.
    await h.uow.settings.save({
      ...(await h.uow.settings.get()),
      imageRetentionDays: 30,
      updatedAt: new Date().toISOString(),
    });
    const before = blob1!.row.expiresAt;

    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('b')])]);
    await h.svc.onMessageSend(owner.userId, sessionId, [
      { type: 'image', data: IMG_B64, mimeType: 'image/png' },
    ]);
    await settle(h, sessionId, 2);

    const rows = await h.uow.assistants.listMessages(sessionId);
    const userRows = rows.filter((r) => r.type === 'user');
    const refs = userRows
      .flatMap((r) => (r.type === 'user' ? r.blocks : []))
      .filter((b): b is Extract<typeof b, { type: 'imageRef' }> => b.type === 'imageRef')
      .map((b) => b.ref);
    expect(refs).toHaveLength(2);
    const stillFirst = await h.uow.fileBlobs.get(refs[0]!);
    expect(stillFirst!.row.expiresAt).toBe(before); // untouched
    const second = await h.uow.fileBlobs.get(refs[1]!);
    expect(second!.row.expiresAt > new Date(Date.now() + 29 * day1).toISOString()).toBe(true); // the new stamp rides the new setting
  });

  it('replay resolves refs; an expired blob degrades to the placeholder', async () => {
    const h = await setup();
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('a')])]);
    await h.svc.onMessageSend(owner.userId, sessionId, [
      { type: 'image', data: IMG_B64, mimeType: 'image/png' },
    ]);
    await settle(h, sessionId, 1);

    // Fresh: the replay inlines the image.
    const fresh = await h.svc.historyFor(sessionId);
    const freshUser = fresh.find((i) => i.type === 'user');
    expect(
      freshUser !== undefined && freshUser.type === 'user'
        ? freshUser.blocks.map((b) => b.type)
        : [],
    ).toEqual(['image']);

    // Expire the blob (sweep forward) — the SAME row replays as placeholder.
    await h.uow.fileBlobs.purgeExpired('2999-01-01T00:00:00.000Z');
    const expired = await h.svc.historyFor(sessionId);
    const expiredUser = expired.find((i) => i.type === 'user');
    expect(
      expiredUser !== undefined && expiredUser.type === 'user' ? expiredUser.blocks[0] : undefined,
    ).toEqual({ type: 'text', text: '[image expired]' });
  });

  it('deleting the session deletes its blobs', async () => {
    const h = await setup();
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('a')])]);
    await h.svc.onMessageSend(owner.userId, sessionId, [
      { type: 'image', data: IMG_B64, mimeType: 'image/png' },
    ]);
    await settle(h, sessionId, 1);
    const rows = await h.uow.assistants.listMessages(sessionId);
    const u = rows.find((r) => r.type === 'user');
    const ref =
      u !== undefined && u.type === 'user'
        ? u.blocks.find((b): b is Extract<typeof b, { type: 'imageRef' }> => b.type === 'imageRef')
        : undefined;
    expect(ref).toBeDefined();

    await h.svc.close(owner.userId, sessionId, 'user');
    await deleteAssistantSession({ uow: h.uow }, owner, sessionId);
    expect(await h.uow.fileBlobs.get(ref!.ref)).toBeNull();
  });
});
