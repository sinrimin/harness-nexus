// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import type { Principal } from '../src/services/principal.js';
import { createNote } from '../src/services/notes.js';
import {
  resolveNotesModel,
  reviseNoteByAnnotations,
  summarizeNoteContent,
  type NotesAiDeps,
} from '../src/services/notes-ai.js';
import { AppError } from '@harness-nexus/shared';

/**
 * #88 notes AI passes — the one-shot completion service, driven with pi-ai's
 * scripted FAUX provider through the same `buildModel` seam the assistant
 * runtime uses (no network, ever). Covers: default-model resolution and the
 * no-provider 409, the summary pass, and the revision loop's version bump +
 * open-annotations-resolved contract.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };

const BODY = [
  '# 调研结论',
  '',
  '综合来看，Streamable HTTP 将在一年内成为默认传输。',
  '选型上建议 sqlite-vec。',
].join('\n');

interface Harness {
  deps: NotesAiDeps;
  faux: ReturnType<typeof piAi.fauxProvider>;
}

async function setup(withProvider = true): Promise<Harness> {
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
  if (withProvider) {
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
      models: [
        {
          id: 'gw-large',
          type: 'chat',
          displayName: 'Gateway Large',
          contextWindow: 64_000,
          maxOutputTokens: 4_000,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    tokensPerSecond: 1_000_000,
  });
  const models = piAi.createModels();
  models.setProvider(faux.provider);

  const deps: NotesAiDeps = {
    uow,
    credentialEncryptionKey: KEY,
    buildModel: async () => ({
      model: faux.getModel('gw-large'),
      streamFn: models.streamSimple.bind(models),
    }),
  };
  return { deps, faux };
}

describe('resolveNotesModel', () => {
  it('picks the owner-visible provider with a chat model', async () => {
    const { deps } = await setup();
    const picked = await resolveNotesModel(deps, owner.userId);
    expect(picked.provider.id).toBe('prov-1');
    expect(picked.modelId).toBe('gw-large');
  });

  it('409s honestly when no provider is configured', async () => {
    const { deps } = await setup(false);
    await expect(resolveNotesModel(deps, owner.userId)).rejects.toMatchObject({
      code: 'NOTE_AI_NO_PROVIDER',
      statusCode: 409,
    });
  });
});

describe('summarizeNoteContent', () => {
  it('returns the scripted summary text', async () => {
    const { deps, faux } = await setup();
    faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('一段摘要。')])]);
    const result = await summarizeNoteContent(deps, owner, {
      title: 'MCP 调研',
      contentMd: BODY,
    });
    expect(result.summary).toBe('一段摘要。');
  });

  it('surfaces the no-provider 409 untouched', async () => {
    const { deps } = await setup(false);
    await expect(summarizeNoteContent(deps, owner, { contentMd: BODY })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe('reviseNoteByAnnotations', () => {
  it('mints the next version and resolves every open annotation', async () => {
    const { deps, faux } = await setup();
    const note = await createNote(deps, owner, {
      title: 'MCP 调研',
      contentMd: BODY,
      tags: [],
      source: { kind: 'manual' },
    });
    await deps.uow.noteAnnotations.save({
      id: 'ann-1',
      noteId: note.id,
      noteVersion: 1,
      quote: 'Streamable HTTP 将在一年内成为默认传输',
      contextPrefix: '综合来看，',
      contextSuffix: '。',
      comment: '加上规范版本号。',
      state: 'open',
      authorId: owner.userId,
      createdAt: '2026-01-02T00:00:00.000Z',
      resolvedAt: null,
    });
    await deps.uow.noteAnnotations.save({
      id: 'ann-done',
      noteId: note.id,
      noteVersion: 1,
      quote: '选型上建议 sqlite-vec',
      contextPrefix: '',
      contextSuffix: '。',
      comment: 'already addressed',
      state: 'done',
      authorId: owner.userId,
      createdAt: '2026-01-02T00:00:00.000Z',
      resolvedAt: '2026-01-02T01:00:00.000Z',
    });

    const revisedBody = BODY.replace(
      'Streamable HTTP 将在一年内成为默认传输',
      'Streamable HTTP（2025-03 规范）将在一年内成为默认传输',
    );
    faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText(revisedBody)])]);

    const result = await reviseNoteByAnnotations(deps, owner, note.id);
    expect(result.note.contentVersion).toBe(2);
    expect(result.note.contentMd).toBe(revisedBody);
    expect(result.resolved.map((a) => a.id)).toEqual(['ann-1']);
    expect(result.resolved[0]!.state).toBe('done');
    expect(result.resolved[0]!.resolvedAt).not.toBeNull();

    // The immutable v1 snapshot is still there — the anchor target survived.
    const v1 = await deps.uow.notes.findVersion(note.id, 1);
    expect(v1?.contentMd).toBe(BODY);
    const v2 = await deps.uow.notes.findVersion(note.id, 2);
    expect(v2?.contentMd).toBe(revisedBody);
  });

  it('unwraps a fenced answer before saving', async () => {
    const { deps, faux } = await setup();
    const note = await createNote(deps, owner, {
      title: 'T',
      contentMd: '正文一段。',
      tags: [],
      source: { kind: 'manual' },
    });
    await deps.uow.noteAnnotations.save({
      id: 'ann-1',
      noteId: note.id,
      noteVersion: 1,
      quote: '正文一段',
      contextPrefix: '',
      contextSuffix: '。',
      comment: '改为两段。',
      state: 'open',
      authorId: owner.userId,
      createdAt: '2026-01-02T00:00:00.000Z',
      resolvedAt: null,
    });
    faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('```\n正文两段。\n```')])]);
    const result = await reviseNoteByAnnotations(deps, owner, note.id);
    expect(result.note.contentMd).toBe('正文两段。');
  });

  it('refuses when nothing is open (400)', async () => {
    const { deps } = await setup();
    const note = await createNote(deps, owner, {
      title: 'T',
      contentMd: '正文。',
      tags: [],
      source: { kind: 'manual' },
    });
    await expect(reviseNoteByAnnotations(deps, owner, note.id)).rejects.toMatchObject({
      code: 'NOTE_NO_OPEN_ANNOTATIONS',
      statusCode: 400,
    });
  });

  it('404-hides a foreign note', async () => {
    const { deps } = await setup();
    await expect(
      reviseNoteByAnnotations(deps, { userId: 'u-other', role: 'user' }, 'nope'),
    ).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', statusCode: 404 });
  });
});
