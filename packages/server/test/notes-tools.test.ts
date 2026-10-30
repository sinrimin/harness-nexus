// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal } from '../src/services/principal.js';
import { createNote, notesContextFor, promptTerms } from '../src/services/notes.js';
import { NOTES_TOOL_DEFS, applyEdits, executeNotesTool } from '../src/mcp/notes-tools.js';
import { TOOL_NAMES_BY_GROUP } from '../src/assistant/tools.js';

/**
 * #88 — the notes tool surface (both outlets) and the per-turn context
 * injection. The dispatcher is the one door /mcp and the assistant group
 * share: these tests cover it at the service level (the transport layers are
 * thin pass-throughs over exactly these calls).
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const other: Principal = { userId: 'u-other', role: 'user' };

async function seed(): Promise<ReturnType<typeof createMemoryUnitOfWork>> {
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
  return uow;
}

async function seedNotes(uow: ReturnType<typeof createMemoryUnitOfWork>) {
  const mcp = await createNote({ uow }, owner, {
    title: 'MCP 传输层演进调研',
    summary: 'Streamable HTTP 单端点传输成为主流。',
    contentMd: '正文：Streamable HTTP 将成为默认传输。',
    tags: ['调研', 'MCP'],
    source: { kind: 'manual' },
  });
  await createNote({ uow }, owner, {
    title: '记忆系统调研：mem0 / Letta 对比',
    summary: '记忆的关键在写入时机与淘汰策略。',
    contentMd: 'mem0 实用性一般。',
    tags: ['调研', 'Agent'],
    source: { kind: 'manual' },
  });
  const foreign = await createNote({ uow }, other, {
    title: '别人的私有笔记',
    summary: '不可见',
    contentMd: 'private body',
    tags: [],
    source: { kind: 'manual' },
  });
  return { mcp, foreign };
}

describe('executeNotesTool', () => {
  it('searches the owner library and returns compact JSON', async () => {
    const uow = await seed();
    await seedNotes(uow);
    const r = await executeNotesTool({ uow }, owner, 'notes__search', { query: '传输' });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as { total: number; results: { title: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.title).toContain('MCP');
  });

  it('gets a full note body with a metadata header', async () => {
    const uow = await seed();
    const { mcp } = await seedNotes(uow);
    const r = await executeNotesTool({ uow }, owner, 'notes__get', { id: mcp.id });
    expect(r.text).toContain('# MCP 传输层演进调研');
    expect(r.text).toContain('Streamable HTTP 将成为默认传输');
  });

  it('404-hides a foreign private note as an error result', async () => {
    const uow = await seed();
    const { foreign } = await seedNotes(uow);
    const r = await executeNotesTool({ uow }, owner, 'notes__get', { id: foreign.id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('NOTE_NOT_FOUND');
  });

  it('lists annotations with the state filter', async () => {
    const uow = await seed();
    const { mcp } = await seedNotes(uow);
    await uow.noteAnnotations.save({
      id: 'a1',
      noteId: mcp.id,
      noteVersion: 1,
      quote: 'Streamable HTTP 将成为默认传输',
      contextPrefix: '正文：',
      contextSuffix: '。',
      comment: '加规范号',
      state: 'open',
      authorId: owner.userId,
      createdAt: '2026-01-02T00:00:00.000Z',
      resolvedAt: null,
    });
    const r = await executeNotesTool({ uow }, owner, 'notes__annotations', {
      noteId: mcp.id,
      state: 'open',
    });
    const parsed = JSON.parse(r.text) as { total: number; annotations: { comment: string }[] };
    expect(parsed.total).toBe(1);
    expect(parsed.annotations[0]!.comment).toBe('加规范号');
  });

  it('applies a diff edit, bumps the version, and writes the snapshot', async () => {
    const uow = await seed();
    const { mcp } = await seedNotes(uow);
    const r = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 1,
      edits: [
        {
          oldText: 'Streamable HTTP 将成为默认传输',
          newText: 'Streamable HTTP（2025-03 规范）将成为默认传输',
        },
      ],
    });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.text) as { contentVersion: number; bodyChanged: boolean };
    expect(parsed.contentVersion).toBe(2);
    expect(parsed.bodyChanged).toBe(true);
    const row = await uow.notes.findById(mcp.id);
    expect(row?.contentMd).toContain('2025-03 规范');
    expect((await uow.notes.findVersion(mcp.id, 2))?.contentMd).toContain('2025-03 规范');
  });

  it('refuses a stale or missing expectVersion (read-before-write)', async () => {
    const uow = await seed();
    const { mcp } = await seedNotes(uow);
    const stale = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 99,
      edits: [{ oldText: '正文', newText: 'x' }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('version mismatch');
    expect(stale.text).toContain('notes__get');

    const missing = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      edits: [{ oldText: '正文', newText: 'x' }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('expectVersion is required');
  });

  it('rejects ambiguous and absent oldText instead of guessing', async () => {
    const uow = await seed();
    const { mcp } = await seedNotes(uow);
    // A body with a genuinely repeated span for the ambiguity case.
    await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 1,
      contentMd: 'alpha beta alpha gamma',
    });
    const absent = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 2,
      edits: [{ oldText: '不存在的句子', newText: 'x' }],
    });
    expect(absent.isError).toBe(true);
    expect(absent.text).toContain('not found');

    const ambiguous = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 2,
      edits: [{ oldText: 'alpha', newText: 'X' }],
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('times');
  });

  it('full replace works; metadata-only update does not bump the version', async () => {
    const uow = await seed();
    const { mcp } = await seedNotes(uow);
    const replaced = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 1,
      contentMd: '全新正文。',
    });
    expect(JSON.parse(replaced.text).contentVersion).toBe(2);

    const meta = await executeNotesTool({ uow }, owner, 'notes__update', {
      id: mcp.id,
      expectVersion: 2,
      title: 'MCP 调研（已修订）',
      status: 'read',
    });
    const parsed = JSON.parse(meta.text) as { contentVersion: number; bodyChanged: boolean };
    expect(parsed.contentVersion).toBe(2);
    expect(parsed.bodyChanged).toBe(false);
  });

  it('applyEdits unit: deletion via empty newText, ordered hunks', () => {
    const r = applyEdits('甲乙丙丁\nsecond line\n', [
      { oldText: '乙丙', newText: '' },
      { oldText: 'second line', newText: 'third line' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toBe('甲丁\nthird line\n');
  });

  it('rejects unknown tool names', async () => {
    const uow = await seed();
    const r = await executeNotesTool({ uow }, owner, 'notes__nuke', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('unknown tool');
  });
});

describe('promptTerms + notesContextFor', () => {
  it('extracts ASCII words and CJK bigrams', () => {
    const terms = promptTerms('帮我总结 MCP 传输层的调研，重点是 streamable http');
    expect(terms).toContain('mcp');
    expect(terms).toContain('streamable');
    expect(terms).toContain('传输');
    expect(terms).toContain('调研');
  });

  it('renders a <system_context> block for matching notes, empty otherwise', async () => {
    const uow = await seed();
    await seedNotes(uow);
    const hit = await notesContextFor({ uow }, owner, 'streamable http 传输 调研 结论是什么');
    expect(hit).toContain('<system_context>');
    expect(hit).toContain('MCP 传输层演进调研');
    expect(hit).toContain('notes_get');

    const miss = await notesContextFor({ uow }, owner, '今天天气怎么样');
    expect(miss).toBe('');
  });

  it('never surfaces another user\u2019s notes', async () => {
    const uow = await seed();
    await seedNotes(uow);
    const ctx = await notesContextFor({ uow }, owner, '别人的私有笔记');
    expect(ctx).toBe('');
  });
});

describe('tool group wiring', () => {
  it('the notes group index covers the dispatcher surface', () => {
    expect(TOOL_NAMES_BY_GROUP.notes).toEqual([
      'notes_search',
      'notes_get',
      'notes_annotations',
      'notes_create',
      'notes_update',
    ]);
    expect(NOTES_TOOL_DEFS.map((d) => d.name)).toEqual([
      'notes__search',
      'notes__get',
      'notes__annotations',
      'notes__create',
      'notes__update',
    ]);
  });
});
