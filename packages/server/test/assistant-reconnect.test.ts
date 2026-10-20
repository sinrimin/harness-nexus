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
 * #66 — the assistant channel's reconnect replay: rows batch-persist at turn
 * END, so a viewer resyncing MID-turn would otherwise miss the in-flight
 * generation (history stops at the last complete turn; live deltas resume
 * mid-message). The per-channel ring closes that gap: resync/rejoin replay
 * history (complete turns) then the ring (the current turn), the ring
 * excludes `user_message` echoes (the user row is persisted at turn START —
 * history already carries it), and it is cleared when the turn settles.
 *
 * The mid-turn state is deterministic: the turn's model call parks on a gate
 * inside a wrapped streamFn — no timing races with token streaming.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

interface IoCall {
  event: string;
  payload: { sessionId?: string; event?: ChatStreamEvent };
}

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

  // The deterministic mid-turn hold: the turn's model call parks on this
  // gate until the test releases it.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const streamFn = (...args: unknown[]) =>
    gate.then(() => (models.streamSimple as (...a: unknown[]) => unknown)(...args)) as never;

  const calls: IoCall[] = [];
  const io: AssistantIO = {
    toChannel: (sid, event, payload) =>
      calls.push({ event, payload: payload as IoCall['payload'] }),
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
        streamFn,
      }),
    },
    io,
  );
  return { svc, uow, faux, calls, releaseGate: () => release!() };
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

describe('#66 assistant ring — mid-turn resync', () => {
  it('replays history then the in-flight ring (no user_message duplication), and clears at settle', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('the full reply')])]);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';

    // The turn parks on the model gate: the user row is PERSISTED (turn
    // start) and session_status active is out, but nothing has settled.
    await h.svc.onMessageSend(owner.userId, sessionId, 'held prompt');
    await (async () => {
      for (let i = 0; i < 500; i += 1) {
        const rows = await h.uow.assistants.listMessages(sessionId);
        if (rows.length > 0 && rows[0]!.type === 'user') return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('turn did not start');
    })();

    // A viewer reconnects mid-turn: sync replays ready + history + RING.
    h.calls.length = 0;
    expect(await h.svc.resync(owner.userId, sessionId, 'sock-2')).toBe(true);
    const historyIdx = h.calls.findIndex(
      (c) => c.event === 'assistant:history' && c.payload.sessionId === sessionId,
    );
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    // History (built from rows) already carries the turn's user row.
    const historyItems = h.calls[historyIdx]!.payload as unknown as {
      items: { type: string }[];
    };
    expect(historyItems.items.some((i) => i.type === 'user')).toBe(true);
    // The ring replays AFTER history: the in-flight turn's status event —
    // and NEVER a user_message echo (that would duplicate the user row).
    const afterHistory = h.calls.slice(historyIdx + 1);
    expect(
      afterHistory.some(
        (c) =>
          c.event === 'assistant:event' &&
          c.payload.event?.kind === 'session_status' &&
          c.payload.event.state === 'active',
      ),
    ).toBe(true);
    expect(
      afterHistory.some(
        (c) => c.event === 'assistant:event' && c.payload.event?.kind === 'user_message',
      ),
    ).toBe(false);

    // Release the gate: the turn completes and persists.
    h.releaseGate();
    await settle(h.uow, sessionId);

    // A post-settle sync replays history only — the ring is empty (any
    // assistant:event in the window is the fresh session_config push).
    h.calls.length = 0;
    expect(await h.svc.resync(owner.userId, sessionId, 'sock-3')).toBe(true);
    const kinds = h.calls
      .filter((c) => c.event === 'assistant:event' && c.payload.sessionId === sessionId)
      .map((c) => c.payload.event?.kind);
    expect(kinds.every((k) => k === 'session_config')).toBe(true);
  }, 15000);

  it('resync is owner-only (another user gets SESSION_NOT_FOUND, nothing pushed)', async () => {
    const h = await setup();
    const id = await makeConfig(h.uow);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    // No turn needed — the live channel exists from the open alone (#54's
    // pending row rides it), and ownership is checked before any push.

    h.calls.length = 0;
    expect(await h.svc.resync('u-stranger', sessionId, 'sock-evil')).toBe(false);
    expect(h.calls).toEqual([]);
    // The owner still can.
    expect(await h.svc.resync(owner.userId, sessionId, 'sock-2')).toBe(true);
  });
});
