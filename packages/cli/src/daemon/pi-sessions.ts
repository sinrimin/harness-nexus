// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { NativeSessionView } from '@harness-nexus/shared';

/**
 * pi session store (Phase 9 W16) — listing + replay parsing for
 * `~/.pi/agent/sessions/` (ground truth: pi.dev docs "Sessions" +
 * "Session format"; research §5). Pure functions over injectable fs, same
 * stance as dsh-sessions: the platform persists nothing session-shaped.
 *
 * Layout: `--<cwd-path>--/<timestamp>_<session-id>.jsonl` — the folder name
 * mangles the cwd (`/`, `\`, `:` → `-`), so identity ALWAYS comes from the
 * first line's header `{type:'session', version, id, timestamp, cwd}` —
 * never parsed back out of the folder name. Plain JSONL, no compression
 * (cheaper than the dsh arm). Entries link via `id`/`parentId` (tree); the
 * ACTIVE position is the chain ending at the last entry in file order.
 */

export interface PiListFs {
  readdir: (path: string) => string[];
  readFile: (path: string) => Buffer;
  stat: (path: string) => { mtimeMs: number };
}

export interface PiSessionSummary {
  sessionId: string;
  cwd: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The last `model_change` route (`provider/modelId` when both exist). */
  model: string | null;
}

/** Whole-file read cap — beyond this only the head is parsed (title may be missed, identity does not). */
const MAX_FULL_READ_BYTES = 4 * 1024 * 1024;
/** Head window for oversized files — the header lives on line 1. */
const HEAD_BYTES = 64 * 1024;

interface PiEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  session?: unknown;
  name?: unknown;
  provider?: unknown;
  modelId?: unknown;
  message?: unknown;
}

function parseEntries(text: string): PiEntry[] {
  const out: PiEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as PiEntry);
    } catch {
      // junk line — skip, never fail a whole listing for one bad row
    }
  }
  return out;
}

/** Read a session file bounded: whole when small, head-only when huge. */
function readBounded(fs: Pick<PiListFs, 'readFile'>, file: string): string {
  const buf = fs.readFile(file);
  return (buf.length > MAX_FULL_READ_BYTES ? buf.subarray(0, HEAD_BYTES) : buf).toString('utf8');
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * List pi sessions, newest first (mtime recency). Files without a parseable
 * `session` header are skipped (foreign/junk rows, not ours to guess at).
 */
export function piListSessions(
  sessionsDir: string,
  fs: PiListFs,
  opts: { maxSessions?: number } = {},
): PiSessionSummary[] {
  const max = opts.maxSessions ?? 200;
  const out: PiSessionSummary[] = [];
  let groups: string[];
  try {
    groups = fs.readdir(sessionsDir);
  } catch {
    return []; // no store yet — an honest empty listing
  }
  for (const group of groups) {
    let files: string[];
    try {
      files = fs.readdir(`${sessionsDir}/${group}`);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = `${sessionsDir}/${group}/${file}`;
      let entries: PiEntry[];
      let mtimeMs: number;
      try {
        entries = parseEntries(readBounded(fs, path));
        mtimeMs = fs.stat(path).mtimeMs;
      } catch {
        continue;
      }
      const header = entries.find((e) => e.type === 'session');
      const sessionId = asString(header?.id);
      const cwd = asString((header as { cwd?: unknown } | undefined)?.cwd);
      if (sessionId === null || cwd === null) continue;
      const title = asString([...entries].reverse().find((e) => e.type === 'session_info')?.name);
      const modelChange = [...entries].reverse().find((e) => e.type === 'model_change');
      const provider = asString(modelChange?.provider);
      const modelId = asString(modelChange?.modelId);
      out.push({
        sessionId,
        cwd,
        title,
        createdAt: asString(header?.timestamp),
        updatedAt: new Date(mtimeMs).toISOString(),
        model: modelId === null ? null : provider !== null ? `${provider}/${modelId}` : modelId,
      });
    }
  }
  out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return out.slice(0, max);
}

/** Map a listing to rail rows (the `staleReason` arm stays dsh-only today). */
export function piSessionViews(sessionsDir: string, fs: PiListFs): NativeSessionView[] {
  return piListSessions(sessionsDir, fs).map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    ...(s.title !== null ? { title: s.title } : {}),
    ...(s.updatedAt !== null ? { updatedAt: s.updatedAt } : {}),
    ...(s.model !== null ? { model: s.model } : {}),
  }));
}

// ---- replay (the chat history producer + the bridge's session/load arm) ----

/** One ACP `session/update` arm the replay emits (the dialect chat.ts maps). */
export type PiReplayUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_message_chunk'; content: { type: 'text'; text: string } }
  | { sessionUpdate: 'agent_thought_chunk'; content: { type: 'text'; text: string } }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      rawInput?: string;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      content?: { type: 'text'; text: string }[];
      status?: string;
    };

/**
 * Map ONE pi message entry (the `message_end.message` shape — identical in
 * the live RPC stream and the transcript file) to ACP replay updates.
 * Unknown content-block types are skipped field-by-field, never fatal.
 */
export function piMessageToReplayUpdates(message: unknown): PiReplayUpdate[] {
  const m = (message ?? {}) as {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    output?: unknown;
  };
  const role = typeof m.role === 'string' ? m.role : '';
  const blocks = Array.isArray(m.content) ? m.content : [];
  const out: PiReplayUpdate[] = [];
  if (role === 'user') {
    const text = blocks
      .map((b) => {
        const block = (b ?? {}) as { type?: unknown; text?: unknown };
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('');
    if (text.length > 0)
      out.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
    return out;
  }
  if (role === 'assistant') {
    for (const b of blocks) {
      const block = (b ?? {}) as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        tool?: unknown;
        toolCallId?: unknown;
        arguments?: unknown;
      };
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        out.push({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: block.text },
        });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        out.push({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: block.thinking },
        });
      } else if (block.type === 'toolCall' && typeof block.tool === 'string') {
        out.push({
          sessionUpdate: 'tool_call',
          toolCallId: String(block.toolCallId ?? block.tool),
          title: block.tool,
          ...(block.arguments !== undefined ? { rawInput: JSON.stringify(block.arguments) } : {}),
        });
      }
    }
    return out;
  }
  if (role === 'toolResult' || role === 'bashExecution') {
    const callId = asString(m.toolCallId);
    if (callId === null) return out;
    const content = (Array.isArray(m.output) ? m.output : [])
      .map((b) => {
        const block = (b ?? {}) as { type?: unknown; text?: unknown };
        return block.type === 'text' && typeof block.text === 'string'
          ? { type: 'text' as const, text: block.text }
          : null;
      })
      .filter((b): b is { type: 'text'; text: string } => b !== null);
    out.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      ...(content.length > 0 ? { content } : {}),
      status: 'completed',
    });
  }
  return out; // system / custom / branchSummary / compactionSummary — not chat history
}

/** History is capped like the live ring (W7: ≤2000 items). */
const MAX_REPLAY_UPDATES = 2000;

/**
 * Replay the ACTIVE leaf chain of a session file as ACP updates: walk the
 * entries in file order, keep those on the chain ending at the LAST entry
 * (pi appends as it goes; branches leave the old tip behind), and map the
 * `message` entries. The bridge emits these as `session/update`
 * notifications DURING `session/load` — the daemon's existing capture path
 * folds them into history, exactly like claude's native replay.
 */
export function piSessionReplay(text: string): PiReplayUpdate[] {
  const entries = parseEntries(text).filter((e) => e.type !== 'session' && e.id !== undefined);
  if (entries.length === 0) return [];
  // Build the child set, then walk backwards from the last entry to a root.
  const ids = new Set(entries.map((e) => String(e.id)));
  const onChain = new Set<string>();
  let cursor: string | undefined = String(entries[entries.length - 1]!.id);
  while (cursor !== undefined && ids.has(cursor)) {
    if (onChain.has(cursor)) break; // defensive: cycle in a corrupt file
    onChain.add(cursor);
    const entry = entries.find((e) => String(e.id) === cursor);
    const parent = entry?.parentId;
    cursor = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
  }
  const out: PiReplayUpdate[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || !onChain.has(String(entry.id))) continue;
    for (const update of piMessageToReplayUpdates(entry.message)) {
      if (out.length >= MAX_REPLAY_UPDATES) return out;
      out.push(update);
    }
  }
  return out;
}

/**
 * Resolve a session id (partials accepted — pi's own convention) to its
 * file: filename match first (`<timestamp>_<id>.jsonl`), then header ids.
 */
export function piFindSessionFile(
  sessionsDir: string,
  fs: Pick<PiListFs, 'readdir' | 'readFile'>,
  sessionId: string,
): string | null {
  let groups: string[];
  try {
    groups = fs.readdir(sessionsDir);
  } catch {
    return null;
  }
  const byFilename: string[] = [];
  const byHeader: string[] = [];
  for (const group of groups) {
    let files: string[];
    try {
      files = fs.readdir(`${sessionsDir}/${group}`);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = `${sessionsDir}/${group}/${file}`;
      if (file.includes(sessionId)) byFilename.push(path);
      else byHeader.push(path);
    }
  }
  if (byFilename.length > 0) return byFilename[0]!;
  for (const path of byHeader) {
    try {
      const header = parseEntries(readBounded(fs, path)).find((e) => e.type === 'session');
      if (asString(header?.id)?.includes(sessionId)) return path;
    } catch {
      // unreadable — try the next
    }
  }
  return null;
}
