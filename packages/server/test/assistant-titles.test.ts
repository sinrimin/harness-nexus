// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #109 — assistant session titles: the prompt-time fallback's
 * derivation (ANSI/OSC stripping, whitespace collapse, CODEPOINT truncation
 * so surrogate pairs never split), the refine reply validator, the one-shot
 * refine call against the scripted faux provider (valid / rejected / error),
 * and the realtime wiring — the fallback lands at TURN START (before the
 * turn settles) and a rejected refine keeps it. No network, ever.
 */
import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import type { UnitOfWork } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import {
  deriveFallbackTitle,
  refineSessionTitle,
  validateRefinedTitle,
} from '../src/assistant/titles.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };

describe('deriveFallbackTitle (#109)', () => {
  it('joins text blocks, collapses whitespace, keeps it readable', () => {
    expect(
      deriveFallbackTitle([
        { type: 'text', text: '  why   does\n\nthe build ' },
        { type: 'text', text: 'fail on \t tuesday?' },
        { type: 'image', ref: 'x' },
      ]),
    ).toBe('why does the build fail on tuesday?');
  });

  it('strips ANSI/OSC escapes and control characters', () => {
    const noisy = '\x1b]0;window-title\x07plain\x1b[31m red \x1b[0mtext\x00\x07';
    expect(deriveFallbackTitle([{ type: 'text', text: noisy }])).toBe('plain red text');
  });

  it('truncates by CODEPOINTS — a surrogate pair never splits', () => {
    // 39 safe codepoints + one emoji (2 UTF-16 units): the cut lands after
    // the pair, not between its halves.
    const text = `${'a'.repeat(39)}😀${'b'.repeat(10)}`;
    expect(deriveFallbackTitle([{ type: 'text', text }])).toBe(`${'a'.repeat(39)}😀`);
    // And a long CJK opener survives the same way.
    expect(Array.from(deriveFallbackTitle([{ type: 'text', text: '字'.repeat(50) }]))).toHaveLength(
      40,
    );
  });

  it('an all-noise prompt derives an empty title (the rail keeps "untitled")', () => {
    expect(deriveFallbackTitle([{ type: 'text', text: '\x1b[2K\x1b[?25l' }])).toBe('');
  });
});

describe('validateRefinedTitle (#109)', () => {
  it('accepts a plain one-liner, zh included', () => {
    expect(validateRefinedTitle('Docker logs investigation')).toBe('Docker logs investigation');
    expect(validateRefinedTitle('  构建失败排查  ')).toBe('构建失败排查');
    expect(validateRefinedTitle('line one\nline two')).toBe('line one line two');
  });

  it('rejects markdown shapes, quotes, fences, and over-long replies', () => {
    for (const bad of [
      '**Bold title**',
      '# Heading',
      '> quoted',
      '"quoted"',
      '`code`',
      '- list item',
      '1. numbered',
      '```\nfenced\n```',
      'x'.repeat(61),
      '   ',
    ]) {
      expect(validateRefinedTitle(bad)).toBe('');
    }
  });
});

describe('refineSessionTitle (#109, faux provider)', () => {
  it('returns the validated reply from one small call', async () => {
    const uow = createMemoryUnitOfWork();
    const faux = piAi.fauxProvider({
      models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    });
    const models = piAi.createModels();
    models.setProvider(faux.provider);
    faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('Kubernetes ingress debugging')])]);
    const out = await refineSessionTitle(
      {
        uow,
        credentialEncryptionKey: KEY,
        buildModel: async () => ({
          model: faux.getModel('gw-large'),
          streamFn: models.streamSimple.bind(models),
        }),
      },
      {
        ownerId: 'u-owner',
        provider: { credentialName: 'gw-key' } as never,
        modelId: 'gw-large',
        firstPrompt: 'why does my ingress return 502 on tuesdays',
      },
    );
    expect(out).toBe('Kubernetes ingress debugging');
  });

  it('a junk reply and a build failure both resolve empty (keep the fallback)', async () => {
    const uow = createMemoryUnitOfWork();
    const faux = piAi.fauxProvider({
      models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    });
    const models = piAi.createModels();
    models.setProvider(faux.provider);
    faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('* definitely not a title')])]);
    const deps = {
      uow,
      credentialEncryptionKey: KEY,
      buildModel: async () => ({
        model: faux.getModel('gw-large'),
        streamFn: models.streamSimple.bind(models),
      }),
    };
    const input = {
      ownerId: 'u-owner',
      provider: { credentialName: 'gw-key' } as never,
      modelId: 'gw-large',
      firstPrompt: 'hello',
    } as const;
    expect(await refineSessionTitle(deps, input)).toBe('');
    // Setup drift (the real resolution path throws) — still empty, never a throw.
    expect(await refineSessionTitle({ uow, credentialEncryptionKey: KEY }, input)).toBe('');
  });
});

describe('realtime wiring (#109)', () => {
  async function setup(): Promise<{
    svc: AssistantRealtimeService;
    uow: UnitOfWork;
    faux: ReturnType<typeof piAi.fauxProvider>;
  }> {
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
      apis: [{ kind: 'openai-chat', path: null }],
      baseUrl: 'https://gw.example.com/v1',
      credentialName: 'gw-key',
      scope: 'personal',
      ownerId: owner.userId,
      models: [
        {
          id: 'gw-large',
          apiKind: 'openai-chat',
          displayName: 'Gateway Large',
          contextWindow: 64_000,
          maxOutputTokens: 4_000,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // Slow enough that the turn is still streaming when the fallback is
    // asserted — the fallback must NOT wait for the settle.
    const faux = piAi.fauxProvider({
      models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
      tokensPerSecond: 40,
    });
    const models = piAi.createModels();
    models.setProvider(faux.provider);
    const io: AssistantIO = {
      toChannel: () => undefined,
      toUser: () => undefined,
      joinChannel: () => undefined,
      userSockets: async () => [],
    };
    // NOTE: no `titleRefine: false` — the refine runs in these tests.
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
    return { svc, uow, faux, assistantId: config.id };
  }

  async function settleIdle(svc: AssistantRealtimeService, sessionId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (!svc.isLive(sessionId) || !svc.isBusy(sessionId)) {
        if (!svc.isBusy(sessionId)) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  it('the fallback lands at TURN START, before the turn settles', async () => {
    const h = await setup();
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxText('Streaming build postmortem')]),
      piAi.fauxAssistantMessage([piAi.fauxText('long reply body '.repeat(40))]),
    ]);
    const res = await h.svc.open(owner.userId, h.assistantId, undefined, 'sock-1');
    if (!res.ok) throw new Error('open failed: ' + JSON.stringify(res));
    await h.svc.onMessageSend(
      owner.userId,
      res.sessionId,
      '\x1b]0;x\x07why does the build fail???\x1b[0m',
    );
    // The turn is still streaming (40 tok/s) — yet the title is already
    // there. onMessageSend acks before startTurn's append, so poll briefly.
    let title = '';
    for (let i = 0; i < 60 && title === ''; i++) {
      await new Promise((r) => setTimeout(r, 50));
      title = (await h.uow.assistants.findSessionById(res.sessionId))?.title ?? '';
    }
    expect(h.svc.isBusy(res.sessionId)).toBe(true); // mid-turn, not settled
    expect(title).toBe('why does the build fail???');
    await settleIdle(h.svc, res.sessionId);
  });

  it('a valid refine replaces the fallback once the turn is done', async () => {
    const h = await setup();
    // Both scripted replies are valid title-shaped texts: whichever of the
    // refine/turn consumes first, the landed title is a refined one.
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxText('Build failure postmortem')]),
      piAi.fauxAssistantMessage([piAi.fauxText('Ingress config review')]),
    ]);
    const res = await h.svc.open(owner.userId, h.assistantId, undefined, 'sock-1');
    if (!res.ok) throw new Error('open failed');
    await h.svc.onMessageSend(
      owner.userId,
      res.sessionId,
      'a very long chatty opener about builds',
    );
    await settleIdle(h.svc, res.sessionId);
    const row = await h.uow.assistants.findSessionById(res.sessionId);
    expect(row?.title).not.toBe('a very long chatty opener about builds');
    expect(['Build failure postmortem', 'Ingress config review']).toContain(row?.title);
  });

  it('a rejected refine keeps the fallback; the second turn never re-refines', async () => {
    const h = await setup();
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxText('* definitely not a title')]),
      piAi.fauxAssistantMessage([piAi.fauxText('reply one')]),
      piAi.fauxAssistantMessage([piAi.fauxText('reply two')]),
    ]);
    const res = await h.svc.open(owner.userId, h.assistantId, undefined, 'sock-1');
    if (!res.ok) throw new Error('open failed');
    await h.svc.onMessageSend(owner.userId, res.sessionId, 'only prompt that will be titled');
    await settleIdle(h.svc, res.sessionId);
    const row = await h.uow.assistants.findSessionById(res.sessionId);
    expect(row?.title).toBe('only prompt that will be titled');
    // The second prompt is NOT a first — no refine, no fallback rewrite.
    await h.svc.onMessageSend(owner.userId, res.sessionId, 'second prompt arrives later');
    await settleIdle(h.svc, res.sessionId);
    const after = await h.uow.assistants.findSessionById(res.sessionId);
    expect(after?.title).toBe('only prompt that will be titled');
  });
});
