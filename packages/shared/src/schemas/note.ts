// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * Notes request schemas (#88). Mirrors `core/domain/note.ts`; keep the shapes
 * in sync. Durable design: wiki `design-notes.md`.
 */

export const NOTE_STATUSES = ['inbox', 'to_read', 'reading', 'read'] as const;
export const NOTE_VISIBILITIES = ['private', 'public'] as const;
export const NOTE_SOURCE_KINDS = ['manual', 'chat', 'url'] as const;

export const noteStatusSchema = z.enum(NOTE_STATUSES);
export const noteVisibilitySchema = z.enum(NOTE_VISIBILITIES);
export const noteSourceKindSchema = z.enum(NOTE_SOURCE_KINDS);

/** Capture stays light: everything except the body has a sensible default. */
export const createNoteSchema = z.object({
  title: z.string().min(1).max(200),
  /** First-class: feed cards and future context injection prefer it over the body. */
  summary: z.string().max(1000).nullable().optional(),
  contentMd: z.string().min(1),
  categoryId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  status: noteStatusSchema.default('inbox'),
  visibility: noteVisibilitySchema.default('private'),
  source: z
    .object({
      kind: noteSourceKindSchema,
      /** e.g. the chat session id, or the origin URL. */
      ref: z.string().min(1).max(512).optional(),
    })
    .default({ kind: 'manual' }),
});

/**
 * Replace-semantics update. A `contentMd` change is the version boundary: the
 * service bumps `contentVersion`, writes the immutable snapshot, and open
 * annotations re-anchor by quote (a lost span surfaces, never silently drops).
 */
export const updateNoteSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    summary: z.string().max(1000).nullable().optional(),
    contentMd: z.string().min(1).optional(),
    categoryId: z.string().min(1).nullable().optional(),
    tags: z.array(z.string().min(1).max(32)).max(16).optional(),
    status: noteStatusSchema.optional(),
    visibility: noteVisibilitySchema.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.summary !== undefined ||
      v.contentMd !== undefined ||
      v.categoryId !== undefined ||
      v.tags !== undefined ||
      v.status !== undefined ||
      v.visibility !== undefined,
    { message: 'at least one field is required' },
  );

export const listNotesQuerySchema = z.object({
  categoryId: z.string().min(1).optional(),
  /** `uncategorized` selects the null bucket explicitly. */
  category: z.enum(['uncategorized']).optional(),
  status: noteStatusSchema.optional(),
  visibility: noteVisibilitySchema.optional(),
  tag: z.string().min(1).max(32).optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listSquareQuerySchema = z.object({
  tag: z.string().min(1).max(32).optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * An annotation's anchor is quote + surrounding context, never character
 * offsets (edits invalidate them). The context window is capped so an anchor
 * stays searchable without dragging the whole body along.
 */
export const createAnnotationSchema = z.object({
  quote: z.string().min(1).max(2000),
  contextPrefix: z.string().max(200),
  contextSuffix: z.string().max(200),
  comment: z.string().min(1).max(2000),
});

export const updateAnnotationSchema = z.object({
  comment: z.string().min(1).max(2000).optional(),
  state: z.enum(['open', 'done']).optional(),
});

export const createCategorySchema = z.object({
  parentId: z.string().min(1).nullable().default(null),
  name: z.string().min(1).max(64),
});

export const updateCategorySchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(64).optional(),
});

/**
 * #88 AI helpers — one-shot LLM passes over note content (the capture
 * dialog's summary seed, the editor's 生成 button, the revision loop).
 * Content cap keeps a single paste from becoming an unbounded prompt.
 */
export const summarizeNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  contentMd: z.string().min(1).max(200_000),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
export type ListSquareQuery = z.infer<typeof listSquareQuerySchema>;
export type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>;
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type SummarizeNoteInput = z.infer<typeof summarizeNoteSchema>;
