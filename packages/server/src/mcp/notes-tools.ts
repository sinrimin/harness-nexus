// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { UnitOfWork } from '@harness-nexus/core';
import type { NoteStatus } from '@harness-nexus/core';
import { AppError, createNoteSchema } from '@harness-nexus/shared';
import type { Principal, ServiceDeps } from '../services/principal.js';
import { createNote, getNote, listAnnotations, listNotes, updateNote } from '../services/notes.js';

/**
 * #88 notes tools — the owner's library as tools, on BOTH outlets:
 * the aggregated MCP surface (`/mcp?profile=…`, virtual `notes__` namespace,
 * the #80 api-tools pattern) and the platform assistant's `notes` tool group.
 * One dispatcher over the #53 services; the principal is the PAT owner (MCP)
 * or the session owner (assistant), so every scope decision stays in the
 * service — owner-only reads, 404 existence-hiding, all of it.
 *
 * Writes are read-gated by design (client-agent write-tool lessons):
 * - `notes__create` files agent output into the library, source pinned to
 *   `{kind:'agent'}` — visible in the UI, never masquerading as a capture.
 * - `notes__update` is diff-first (`edits: [{oldText, newText}]`, each
 *   oldText must occur EXACTLY once — a one-line change costs one hunk, not
 *   a full-body re-emit) with a full `contentMd` replace as the fallback for
 *   real rewrites. `expectVersion` is REQUIRED and must equal the note's
 *   current contentVersion — a stale or missing version is refused with
 *   "re-read first", so a blind write can never clobber content the agent
 *   never read. Body changes ride the existing version machinery (bump +
 *   immutable snapshot + quote re-anchoring).
 */

export const NOTES_TOOL_PREFIX = 'notes__';

export interface NotesToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const NOTES_TOOL_DEFS: NotesToolDef[] = [
  {
    name: 'notes__search',
    description:
      "Search the user's own notes (title, summary, body substring match; optional tag and status filters). Returns id, title, summary, tags, status, updatedAt per hit — fetch the full body with notes__get.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring matched against title, summary and body' },
        tag: { type: 'string', description: 'Exact tag filter' },
        status: {
          type: 'string',
          enum: ['inbox', 'to_read', 'reading', 'read'],
          description: 'Reading-pipeline status filter',
        },
        limit: { type: 'number', description: 'Max results (1-20, default 10)' },
      },
    },
  },
  {
    name: 'notes__get',
    description:
      "Fetch one note's full markdown body by id (metadata header first). Use ids from notes__search; private notes of other users do not exist to this tool.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id from notes__search' } },
      required: ['id'],
    },
  },
  {
    name: 'notes__annotations',
    description:
      "List one note's inline annotations (revision instructions with their quoted spans) — the owner's working material, owner-only. `state` filters open/done.",
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'Note id (must be owned by the user)' },
        state: { type: 'string', enum: ['open', 'done'], description: 'Filter by state' },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'notes__create',
    description:
      "Save a markdown document into the user's notes library (their inbox by default). Use when the user asks to keep/park/store a piece of writing, a research summary, or a report — pass the FULL markdown; the note is created as private/inbox and shows up in the web library with source=agent.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title (1-200 chars)' },
        contentMd: { type: 'string', description: 'The full markdown body (required, non-empty)' },
        summary: { type: 'string', description: 'Optional 1-2 sentence summary (≤1000 chars)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags (≤16, each ≤32 chars)',
        },
      },
      required: ['title', 'contentMd'],
    },
  },
  {
    name: 'notes__update',
    description:
      "Edit one of the user's notes. DIFF-FIRST: pass `edits` — an array of {oldText, newText} where oldText must occur EXACTLY ONCE in the current body (0 or >1 occurrences is an error; quote enough surrounding context to disambiguate). Use `contentMd` (full replacement) only for whole-document rewrites. `expectVersion` is REQUIRED and must equal the note's current contentVersion as returned by notes__get / notes__search — on mismatch the call is refused: re-read the note and re-apply your edits (this prevents overwriting content that changed since your read). Optional metadata (title/summary/tags/status) rides along; only body changes bump the version.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id' },
        expectVersion: {
          type: 'number',
          description: 'The contentVersion you based your edits on (from notes__get)',
        },
        edits: {
          type: 'array',
          description: 'Ordered diff hunks; preferred over contentMd',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Text to replace (must occur exactly once)' },
              newText: { type: 'string', description: 'Replacement ("" deletes)' },
            },
            required: ['oldText', 'newText'],
          },
        },
        contentMd: { type: 'string', description: 'Full replacement body (only without edits)' },
        title: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['inbox', 'to_read', 'reading', 'read'] },
      },
      required: ['id', 'expectVersion'],
    },
  },
];

export interface NotesToolResult {
  text: string;
  isError: boolean;
}

/** Route one `notes__*` call to the services. Unknown names are an error. */
export async function executeNotesTool(
  deps: ServiceDeps,
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
): Promise<NotesToolResult> {
  try {
    switch (name) {
      case 'notes__search':
        return { text: await toolSearch(deps, principal, args), isError: false };
      case 'notes__get':
        return { text: await toolGet(deps, principal, args), isError: false };
      case 'notes__annotations':
        return { text: await toolAnnotations(deps, principal, args), isError: false };
      case 'notes__create':
        return { text: await toolCreate(deps, principal, args), isError: false };
      case 'notes__update':
        return { text: await toolUpdate(deps, principal, args), isError: false };
      default:
        return { text: `error: unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    return {
      text:
        e.statusCode !== undefined
          ? `error: ${e.message ?? 'request failed'} (${e.code ?? e.statusCode})`
          : `error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

async function toolSearch(
  deps: ServiceDeps,
  principal: Principal,
  args: Record<string, unknown>,
): Promise<string> {
  const limitRaw = typeof args.limit === 'number' ? args.limit : 10;
  const limit = Math.min(20, Math.max(1, Math.trunc(limitRaw)));
  const status = str(args.status) as NoteStatus | undefined;
  const notes = await listNotes(deps, principal, {
    ...(str(args.query) !== undefined ? { search: str(args.query)! } : {}),
    ...(str(args.tag) !== undefined ? { tag: str(args.tag)! } : {}),
    ...(status !== undefined && ['inbox', 'to_read', 'reading', 'read'].includes(status)
      ? { status }
      : {}),
    limit,
    offset: 0,
  });
  return JSON.stringify({
    total: notes.length,
    results: notes.map((n) => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      tags: n.tags,
      status: n.status,
      updatedAt: n.updatedAt,
      openAnnotations: n.openAnnotationCount,
    })),
  });
}

async function toolGet(
  deps: ServiceDeps,
  principal: Principal,
  args: Record<string, unknown>,
): Promise<string> {
  const id = str(args.id);
  if (id === undefined) return 'error: id is required';
  const note = await getNote(deps, principal, id);
  const header = [
    `# ${note.title}`,
    note.summary !== null ? `summary: ${note.summary}` : null,
    `tags: ${note.tags.join(', ')} · status: ${note.status} · v${String(note.contentVersion)} · updated ${note.updatedAt}`,
    '---',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return `${header}\n\n${note.contentMd}`;
}

async function toolAnnotations(
  deps: ServiceDeps,
  principal: Principal,
  args: Record<string, unknown>,
): Promise<string> {
  const noteId = str(args.noteId);
  if (noteId === undefined) return 'error: noteId is required';
  const state = str(args.state);
  const annotations = await listAnnotations(deps, principal, noteId);
  const rows = annotations
    .filter((a) => state === undefined || a.state === state)
    .map((a) => ({
      id: a.id,
      state: a.state,
      quote: a.quote,
      comment: a.comment,
      pinnedAtVersion: a.noteVersion,
      createdAt: a.createdAt,
    }));
  return JSON.stringify({ total: rows.length, annotations: rows });
}

/**
 * The one write: full zod validation (the service trusts its caller), source
 * pinned to `agent` regardless of what the caller passes. The result names
 * the row so the follow-up tools can reference it.
 */
async function toolCreate(
  deps: ServiceDeps,
  principal: Principal,
  args: Record<string, unknown>,
): Promise<string> {
  let parsed: ReturnType<typeof createNoteSchema.parse>;
  try {
    parsed = createNoteSchema.parse({
      title: args.title,
      contentMd: args.contentMd,
      ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
      ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
      source: { kind: 'agent' },
    });
  } catch (err) {
    const issues =
      err && typeof err === 'object' && 'issues' in err
        ? (err as { issues: { path: (string | number)[]; message: string }[] }).issues
        : undefined;
    throw new AppError(
      issues !== undefined
        ? `invalid note payload: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        : err instanceof Error
          ? err.message
          : 'invalid note payload',
      400,
      'NOTE_CREATE_INVALID',
    );
  }
  const note = await createNote(deps, principal, parsed);
  return JSON.stringify({
    created: true,
    id: note.id,
    title: note.title,
    status: note.status,
    visibility: note.visibility,
    contentVersion: note.contentVersion,
  });
}

const MAX_EDITS = 32;

/**
 * Apply diff hunks to a body: each oldText must occur EXACTLY once (the
 * client-agent Edit semantics — ambiguity is an error, never a guess).
 */
export function applyEdits(
  body: string,
  edits: { oldText: string; newText: string }[],
): { ok: true; body: string } | { ok: false; error: string } {
  let next = body;
  for (let i = 0; i < edits.length; i += 1) {
    const { oldText, newText } = edits[i]!;
    const count = next.split(oldText).length - 1;
    if (count === 0) {
      return {
        ok: false,
        error: `edits[${String(i)}].oldText not found in the current body — the note may have changed; re-read it with notes__get and rebuild your edits`,
      };
    }
    if (count > 1) {
      return {
        ok: false,
        error: `edits[${String(i)}].oldText occurs ${String(count)} times — include more surrounding context so it matches exactly once`,
      };
    }
    next = next.replace(oldText, newText);
  }
  return { ok: true, body: next };
}

/** The gated write: diff-first, read-before-write (expectVersion). */
async function toolUpdate(
  deps: ServiceDeps,
  principal: Principal,
  args: Record<string, unknown>,
): Promise<string> {
  const id = str(args.id);
  if (id === undefined) throw new AppError('id is required', 400, 'NOTE_UPDATE_INVALID');
  if (typeof args.expectVersion !== 'number' || !Number.isInteger(args.expectVersion)) {
    throw new AppError(
      'expectVersion is required (the contentVersion you based your edits on — get it from notes__get)',
      400,
      'NOTE_UPDATE_INVALID',
    );
  }

  // Owner-only 404 (getNote would let a public row through; updateNote checks,
  // but reading it first gives us the version to compare).
  const current = await deps.uow.notes.findById(id);
  if (!current || current.ownerId !== principal.userId) {
    throw new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
  }
  if (current.contentVersion !== args.expectVersion) {
    throw new AppError(
      `version mismatch — the note is at v${String(current.contentVersion)} but your edits are based on v${String(args.expectVersion)}. Re-read it with notes__get and re-apply your edits; writing blind would clobber changes you have not seen.`,
      409,
      'NOTE_VERSION_MISMATCH',
    );
  }

  const edits = Array.isArray(args.edits)
    ? args.edits
        .filter(
          (e): e is { oldText: string; newText: string } =>
            typeof (e as { oldText?: unknown }).oldText === 'string' &&
            typeof (e as { newText?: unknown }).newText === 'string',
        )
        .map((e) => ({ oldText: e.oldText, newText: e.newText }))
    : [];
  if (edits.length > MAX_EDITS) {
    throw new AppError(`at most ${String(MAX_EDITS)} edits per call`, 400, 'NOTE_UPDATE_INVALID');
  }
  const fullBody = typeof args.contentMd === 'string' ? args.contentMd : undefined;
  if (edits.length > 0 && fullBody !== undefined) {
    throw new AppError(
      'pass either edits (diff hunks) or contentMd (full replace), not both',
      400,
      'NOTE_UPDATE_INVALID',
    );
  }

  const bodyResult =
    edits.length > 0
      ? applyEdits(current.contentMd, edits)
      : fullBody !== undefined
        ? ({ ok: true, body: fullBody } as const)
        : ({ ok: true, body: current.contentMd } as const);
  if (!bodyResult.ok) throw new AppError(bodyResult.error, 409, 'NOTE_EDIT_UNAPPLICABLE');
  if (bodyResult.body.trim() === '' && (edits.length > 0 || fullBody !== undefined)) {
    throw new AppError('the resulting body would be empty', 400, 'NOTE_UPDATE_INVALID');
  }

  const note = await updateNote(deps, principal, id, {
    ...(bodyResult.body !== current.contentMd ? { contentMd: bodyResult.body } : {}),
    ...(str(args.title) !== undefined ? { title: str(args.title)! } : {}),
    ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
    ...(Array.isArray(args.tags)
      ? { tags: args.tags.filter((t): t is string => typeof t === 'string') }
      : {}),
    ...(str(args.status) !== undefined &&
    ['inbox', 'to_read', 'reading', 'read'].includes(str(args.status)!)
      ? { status: str(args.status)! as NoteStatus }
      : {}),
  });
  return JSON.stringify({
    updated: true,
    id: note.id,
    contentVersion: note.contentVersion,
    bodyChanged: bodyResult.body !== current.contentMd,
  });
}

/** Exposed for tests: the UnitOfWork-typed passthrough (ServiceDeps is it). */
export type NotesToolDeps = { uow: UnitOfWork };
