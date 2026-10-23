// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { UnitOfWork } from '@harness-nexus/core';
import type { NoteStatus } from '@harness-nexus/core';
import type { Principal, ServiceDeps } from '../services/principal.js';
import { getNote, listAnnotations, listNotes } from '../services/notes.js';

/**
 * #88 notes tools — the owner's library as tools, on BOTH outlets:
 * the aggregated MCP surface (`/mcp?profile=…`, virtual `notes__` namespace,
 * the #80 api-tools pattern) and the platform assistant's `notes` tool group.
 * One dispatcher over the #53 services; the principal is the PAT owner (MCP)
 * or the session owner (assistant), so every scope decision stays in the
 * service — owner-only reads, 404 existence-hiding, all of it.
 *
 * Reads only: the library's write path is the web UI / REST (capture,
 * annotate, revise) — agents consume, they don't mutate.
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

/** Exposed for tests: the UnitOfWork-typed passthrough (ServiceDeps is it). */
export type NotesToolDeps = { uow: UnitOfWork };
