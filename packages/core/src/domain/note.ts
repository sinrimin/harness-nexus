// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Notes — the first pillar of the knowledge-base / notes / memory trio (#88).
 *
 * A note is owner-owned markdown content captured from daily work (articles,
 * AI research reports, write-ups). It carries a FIRST-CLASS summary (feeds and
 * future context injection prefer it over the full text), a single tree-node
 * category plus flat tags, a reading-pipeline status (the board's grouping
 * axis), a visibility (public notes appear in the read-only square), and a
 * monotonic content version that inline annotations pin to.
 *
 * Deliberately NOT a `Resource`: resources are installable agent config with
 * version/targets/profile-reference semantics; notes are content, not config.
 * Mirrored in `@harness-nexus/shared` (`schemas/note.ts`); keep the shapes in
 * sync. Durable design: wiki `design-notes.md`.
 */

/** Reading-pipeline status — the board's grouping axis (English on the wire). */
export type NoteStatus = 'inbox' | 'to_read' | 'reading' | 'read';

/** `public` grants other users read of the note row itself (the square) — nothing else. */
export type NoteVisibility = 'private' | 'public';

/** How the note entered the library. */
export type NoteSourceKind = 'manual' | 'chat' | 'url';

export interface NoteSource {
  kind: NoteSourceKind;
  /** e.g. the chat session id, or the origin URL. */
  ref?: string;
}

export interface Note {
  id: string;
  /** Notes are always personal-owned; `visibility` widens read, never write. */
  ownerId: string;
  title: string;
  /**
   * First-class field: feed cards show it (2-line clamp) and context injection
   * prefers it over the full body. AI-pregenerated on chat capture, editable.
   */
  summary: string | null;
  contentMd: string;
  /**
   * Monotonic per-note version of `contentMd` (v1, v2, …), bumped on every
   * content save. Each bump writes an immutable snapshot (NoteVersion) — the
   * anchor target for annotations.
   */
  contentVersion: number;
  /** Tree node (NoteCategory) or null = uncategorized. */
  categoryId: string | null;
  tags: string[];
  status: NoteStatus;
  visibility: NoteVisibility;
  source: NoteSource;
  createdAt: string;
  updatedAt: string;
}

/** Immutable snapshot of one note's content at one version. */
export interface NoteVersion {
  noteId: string;
  version: number;
  contentMd: string;
  createdAt: string;
}

/**
 * An inline annotation ("划词批注") — a revision instruction aimed at an agent,
 * not a collaboration comment. Anchored by the exact quoted span plus
 * surrounding context, pinned to the content version it was drawn on; when the
 * content moves to a newer version the anchor re-resolves by quote search and
 * a span that no longer matches surfaces as `lost` (never silently dropped).
 */
export interface NoteAnnotation {
  id: string;
  noteId: string;
  /** The `Note.contentVersion` the anchor was drawn on. */
  noteVersion: number;
  /** The exact selected text. */
  quote: string;
  /** Disambiguation context: the text immediately before / after the quote. */
  contextPrefix: string;
  contextSuffix: string;
  comment: string;
  state: 'open' | 'done';
  authorId: string;
  createdAt: string;
  resolvedAt: string | null;
}

/** Category tree node — one parent, per owner; `null` parentId = root. */
export interface NoteCategory {
  id: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
}
