// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  createAnnotationSchema,
  createNoteSchema,
  listNotesQuerySchema,
  updateNoteSchema,
} from '../src/index.js';

describe('createNoteSchema', () => {
  it('fills the light-capture defaults', () => {
    const parsed = createNoteSchema.parse({ title: 't', contentMd: '# body' });
    expect(parsed.status).toBe('inbox');
    expect(parsed.visibility).toBe('private');
    expect(parsed.source).toEqual({ kind: 'manual' });
    expect(parsed.tags).toEqual([]);
    expect(parsed.summary).toBeUndefined();
  });

  it('accepts a nullable summary and a chat source ref', () => {
    const parsed = createNoteSchema.parse({
      title: 't',
      contentMd: 'body',
      summary: null,
      source: { kind: 'chat', ref: 'sess-1' },
    });
    expect(parsed.summary).toBeNull();
    expect(parsed.source.kind).toBe('chat');
  });

  it('rejects an empty body', () => {
    expect(() => createNoteSchema.parse({ title: 't', contentMd: '' })).toThrow();
  });
});

describe('updateNoteSchema', () => {
  it('rejects an empty patch', () => {
    expect(() => updateNoteSchema.parse({})).toThrow();
  });

  it('accepts a metadata-only patch (no version bump)', () => {
    const parsed = updateNoteSchema.parse({ status: 'reading' });
    expect(parsed.contentMd).toBeUndefined();
  });
});

describe('createAnnotationSchema', () => {
  it('requires a quote and a comment, caps the context window', () => {
    const parsed = createAnnotationSchema.parse({
      quote: 'Streamable HTTP 将成为默认',
      contextPrefix: '综合各 SDK 的迁移节奏，',
      contextSuffix: '，新集成不应再基于 SSE。',
      comment: '标注数据来源',
    });
    expect(parsed.quote.length).toBeGreaterThan(0);
    expect(() =>
      createAnnotationSchema.parse({ quote: 'q', contextPrefix: 'x'.repeat(201), comment: 'c' }),
    ).toThrow();
  });
});

describe('listNotesQuerySchema', () => {
  it('coerces and bounds pagination', () => {
    const parsed = listNotesQuerySchema.parse({ limit: '5', offset: '10' });
    expect(parsed.limit).toBe(5);
    expect(parsed.offset).toBe(10);
    expect(() => listNotesQuerySchema.parse({ limit: '999' })).toThrow();
  });
});
