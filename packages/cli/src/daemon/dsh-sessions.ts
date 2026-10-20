// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import * as zlib from 'node:zlib';
import type { ChatStreamEvent, HistoryItem } from '@harness-nexus/shared';
import { hasTokenCounts, normalizeUsage } from './usage.js';

/**
 * dsh native session store reader (Phase 9 W7; format ground truth dsh
 * 0.2.0-rc.2 — wiki design-phase-9-w7-native-sessions.md § ground truth).
 *
 * dsh persists every session at `~/.dsh/sessions/<cwd-slug>/<uuid>/` as a
 * GENERATION-VERSIONED multi-frame zstd log — `session.v4.jsonl.zstd` is the
 * current artifact (v0 was the unversioned `session.jsonl.zstd`). One
 * checksummed zstd frame per write batch (~100–300ms apart); Node's one-shot
 * AND stream zstd decoders stop after the first frame, so the reader scans
 * the frame magic (`28 B5 2F FD`), slices, and decodes each frame separately.
 * Since format v3 every physical row is ONE durable event: the v0 packed
 * `text-chunks` rows and the per-token `assistant/chunk` events are gone —
 * settlement `assistant/message` / `assistant/attempt` rows embed the exact
 * timed `stream[]` instead. #46: NO back-compat — the daemon understands only
 * the CURRENT generation (`SUPPORTED_SESSION_GENERATION`), and out-of-range
 * dsh clients are refused at connect time (adapters.ts `minVersion` + the
 * ACP version gate), so pre-v4 artifacts read as absent.
 *
 * dsh's ACP adapter surfaces only COMMITTED updates — a whole reasoning/text
 * block arrives as ONE chunk when the turn ends. Live per-token deltas exist
 * ONLY on the agent-scoped `agent/assistant-stream` frames (dsh ≥0.1.3; the
 * W7.1 tap's second subscription — `frame()` on the live mapper); the
 * transcript receives them embedded in the settlement row's `stream[]`, so
 * the tail fallback streams blocks at commit granularity. Everything here is
 * pure/bounded and injectable for tests; the zstd binding is feature-detected
 * (needs Node ≥ 22.15 — machines running dsh already require ≥22.19, but the
 * daemon degrades gracefully below it).
 */

/** zstd frame magic, big-endian as stored. */
const ZSTD_MAGIC = 0x28_b5_2f_fd;

export type FrameDecoder = (frame: Buffer) => Buffer;

/** The native `zlib.zstdDecompressSync`, or null on Node < 22.15. */
export function nativeZstd(): FrameDecoder | null {
  const fn = (zlib as unknown as { zstdDecompressSync?: FrameDecoder }).zstdDecompressSync;
  return typeof fn === 'function' ? fn : null;
}

/** Slice a concatenated-zstd buffer into its frames (magic scan). */
export function splitZstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32BE(i) === ZSTD_MAGIC) {
      if (start !== -1) frames.push(buf.subarray(start, i));
      start = i;
      i += 3;
    }
  }
  if (start !== -1) frames.push(buf.subarray(start));
  return frames;
}

/**
 * Decode every frame and parse the JSONL entries. Undecodable frames (a magic
 * hit inside compressed data — ~2^-32 per position) and non-JSON lines are
 * skipped, never fatal. Entries are capped so a runaway transcript can't
 * exhaust memory.
 */
export function decodeTranscript(
  buf: Buffer,
  decompress: FrameDecoder,
  maxEntries = 20000,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const frame of splitZstdFrames(buf)) {
    let text: string;
    try {
      text = decompress(frame).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entries.push(parsed as Record<string, unknown>);
          if (entries.length >= maxEntries) return entries;
        }
      } catch {
        // non-JSON noise — skip
      }
    }
  }
  return entries;
}

// ---- generation-versioned log discovery (dsh ≥0.1.3; #46) ----

/** Canonical generation-versioned log name: `session.jsonl.zstd` (v0) or `session.vN.jsonl.zstd`. */
const SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/;

/**
 * The minimum session-log generation this daemon reads (dsh 0.2.0-rc.2 — the
 * version-gate floor — writes v4). Older generations are unsupported by
 * policy: their packed rows and `assistant/chunk` deltas do not parse, and
 * the gate already refuses the dsh builds that write them.
 */
export const SUPPORTED_SESSION_GENERATION = 4;

export interface SessionLog {
  file: string;
  generation: number;
}

/**
 * A session-owned directory's CURRENT log: the numerically highest canonical
 * generation (dsh's own selection rule — a resumed old session leaves the
 * historical file byte-identical and publishes the successor alongside it).
 * Directories whose best generation is below the supported floor read as
 * absent. When the directory exists but holds no log yet (a new session is
 * lazily materialized on its first append), the expected CURRENT name is
 * returned so a tail can poll for the file's appearance.
 */
export function currentSessionLog(
  dir: string,
  readdir: (path: string) => string[],
): SessionLog | null {
  let names: string[];
  try {
    names = readdir(dir);
  } catch {
    return null;
  }
  let best: SessionLog | null = null;
  for (const name of names) {
    const match = SESSION_LOG_RE.exec(name);
    if (match === null) continue;
    const generation = match[1] === undefined ? 0 : Number(match[1]);
    if (best === null || generation > best.generation) {
      best = { file: `${dir}/${name}`, generation };
    }
  }
  if (best !== null) {
    return best.generation >= SUPPORTED_SESSION_GENERATION ? best : null;
  }
  return {
    file: `${dir}/session.v${SUPPORTED_SESSION_GENERATION}.jsonl.zstd`,
    generation: SUPPORTED_SESSION_GENERATION,
  };
}

// ---- listing ----

export interface DshSessionSummary {
  sessionId: string;
  cwd: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The model route the session pinned (`request/header`). */
  model: string | null;
}

interface DshHeader {
  createdAt?: unknown;
  cwd?: unknown;
  delegationDepth?: unknown;
  parentSession?: unknown;
}

/**
 * Header + derived title + pinned model from the FRONT of a transcript
 * (dsh's own `session/list` exposes none of these). Stops as soon as all are
 * found; bounded read so a huge transcript costs at most `maxBytes`. The
 * `session` HEADER row carries its fields at the TOP level (no `data`
 * wrapper), unlike every other row; v4 adds `version`/`id`/`isSeeded` we do
 * not read.
 */
export function scanSummary(
  buf: Buffer,
  decompress: FrameDecoder,
  maxBytes = 64 * 1024,
): { header: DshHeader | null; title: string | null; model: string | null; hasTurn: boolean } {
  const bounded = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  let header: DshHeader | null = null;
  let title: string | null = null;
  let model: string | null = null;
  // A real user turn (`agent/inbox/spliced`) — the marker that separates a
  // LIVED-IN session from a never-appended one. Sessions materialize lazily
  // (nothing hits disk before the first turn's events flush), but a
  // header-only artifact (an explicit empty-session flush) is still not a
  // conversation, so the spliced marker stays the gate.
  let hasTurn = false;
  for (const frame of splitZstdFrames(bounded)) {
    let text: string;
    try {
      text = decompress(frame).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e['type'] === 'session' && header === null) {
          header = e as DshHeader; // top-level shape — see the doc comment
        } else if (e['type'] === 'session/title') {
          const t = (e['data'] as Record<string, unknown> | undefined)?.['title'];
          if (typeof t === 'string' && t !== '') title = t;
        } else if (e['type'] === 'request/header') {
          const hdr = (e['data'] as Record<string, unknown> | undefined)?.['header'];
          const config = isRecord(hdr) ? (hdr as UnknownRecord)['config'] : undefined;
          const m = isRecord(config) ? (config as UnknownRecord)['model'] : undefined;
          if (typeof m === 'string' && m !== '') model = m;
        } else if (e['type'] === 'agent/inbox/spliced') {
          hasTurn = true;
        }
      } catch {
        // skip
      }
    }
    if (header !== null && title !== null && model !== null && hasTurn) break;
  }
  return { header, title, model, hasTurn };
}

/**
 * The model ids of OUR managed provider region in `~/.dsh/settings.yaml`
 * (the W3 writer's own format — a `models:` list of `- id:` entries). Null
 * when the region is absent/unparseable: the caller then annotates nothing.
 */
export function currentCatalogModels(settingsYaml: string): Set<string> | null {
  const region = settingsYaml.match(
    /# BEGIN harness-nexus \(managed\)([\s\S]*?)# END harness-nexus \(managed\)/,
  );
  if (region === null) return null;
  const ids = new Set<string>();
  for (const m of region[1]!.matchAll(/- id:\s*"?([^"\s\n]+)"?/g)) ids.add(m[1]!);
  return ids.size > 0 ? ids : null;
}

export interface DshListFs {
  readdir: (path: string) => string[];
  readFile: (path: string) => Buffer;
  stat: (path: string) => { mtimeMs: number };
}

/**
 * List dsh's ROOT sessions (subagent sessions carry `parentSession`/depth and
 * are dsh's own resume-exclusions). Pure given the fs shims; newest first.
 */
export function dshListSessions(
  sessionsDir: string,
  fs: DshListFs,
  decompress: FrameDecoder,
  opts: { maxSessions?: number } = {},
): DshSessionSummary[] {
  const max = opts.maxSessions ?? 100;
  const out: DshSessionSummary[] = [];
  let slugs: string[];
  try {
    slugs = fs.readdir(sessionsDir);
  } catch {
    return []; // no store yet — an honest empty listing
  }
  for (const slug of slugs) {
    let ids: string[];
    try {
      ids = fs.readdir(`${sessionsDir}/${slug}`);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (out.length >= max) break;
      // Post-W8: sessions with a live channel are LISTED (no longer hidden) —
      // the server marks them `open` and the rail offers a rejoin. dsh itself
      // still refuses a fresh resume of an active session; that failure path
      // is exactly why the row must rejoin the existing channel instead.
      const log = currentSessionLog(`${sessionsDir}/${slug}/${id}`, fs.readdir);
      if (log === null) continue; // pre-v4 artifact only — unsupported (#46)
      let buf: Buffer;
      try {
        buf = fs.readFile(log.file);
      } catch {
        continue; // lazily materialized — nothing durable yet
      }
      const { header, title, model, hasTurn } = scanSummary(buf, decompress);
      // Header-only artifacts are NOT conversations: listing only lived-in
      // sessions matches claude-code's transcript-on-first-message semantics;
      // a live-but-still-empty channel still shows via the server's
      // synthesized open row.
      if (!hasTurn) continue;
      if (header === null) continue;
      if (typeof header.cwd !== 'string' || header.cwd === '' || !header.cwd.startsWith('/')) {
        continue;
      }
      if (header.parentSession !== undefined || header.delegationDepth !== 0) continue;
      let mtimeMs: number;
      try {
        mtimeMs = fs.stat(log.file).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      out.push({
        sessionId: id,
        cwd: header.cwd,
        title,
        model,
        createdAt:
          typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
            ? new Date(header.createdAt).toISOString()
            : null,
        updatedAt: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null,
      });
    }
  }
  const stamp = (s: DshSessionSummary): number =>
    Date.parse(s.updatedAt ?? '') || Date.parse(s.createdAt ?? '') || 0;
  out.sort((a, b) => stamp(b) - stamp(a) || b.sessionId.localeCompare(a.sessionId));
  return out;
}

// ---- history (resume without replay — the transcript becomes the batch) ----

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const OUTPUT_MAX = 100_000;

function bounded(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return raw.length <= max ? raw : raw.slice(0, max);
}

/** Parse dsh tool `arguments` (a JSON string) into a bounded rawInput map. */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // malformed — the toolName/title still render
  }
  return undefined;
}

/** The `tool/call` shape — in_progress with parsed arguments (shared: history + live). */
function toolStartEvent(callId: unknown, name: unknown, args: unknown): ChatStreamEvent | null {
  if (typeof callId !== 'string' || callId === '') return null;
  return {
    kind: 'tool_call',
    call: {
      toolCallId: callId,
      ...(typeof name === 'string' && name !== '' ? { toolName: bounded(name, 128) } : {}),
      status: 'in_progress',
      ...(parseArguments(args) !== undefined
        ? { rawInput: parseArguments(args) as Record<string, unknown> }
        : {}),
    },
  };
}

/**
 * The `tool/result` shape (v4): a first-class tool-role message — FLAT
 * `content: ContentBlock[]` with `toolCallId`/`isError` on the message (the
 * v0 shape nested one block under `content[0].content`; `source.callId`
 * survives and stays the fallback id). Completed with the joined output text.
 */
function toolResultEvent(data: UnknownRecord): ChatStreamEvent | null {
  const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
  if (message === null) return null;
  const direct = typeof message['toolCallId'] === 'string' ? message['toolCallId'] : undefined;
  const source = isRecord(message['source']) ? (message['source'] as UnknownRecord) : null;
  const fallback = typeof source?.['callId'] === 'string' ? source['callId'] : undefined;
  const callId = direct !== undefined && direct !== '' ? direct : fallback;
  if (callId === undefined || callId === '') return null;
  const texts: string[] = [];
  if (Array.isArray(message['content'])) {
    for (const c of message['content']) {
      if (isRecord(c) && c['type'] === 'text' && typeof c['text'] === 'string')
        texts.push(c['text']);
    }
  }
  return {
    kind: 'tool_call',
    call: {
      toolCallId: callId,
      status: 'completed',
      ...(texts.length > 0 ? { output: bounded(texts.join('\n'), OUTPUT_MAX) } : {}),
    },
  };
}

/** The `turn:step` dedup key, or null when the record carries no coordinates. */
function stepKey(data: UnknownRecord): string | null {
  const turn = data['turn'];
  const step = data['step'];
  return typeof turn === 'number' && typeof step === 'number' ? `${turn}:${step}` : null;
}

/** A usage event from an `assistant/message` commit's `usage` payload (null when absent/malformed). */
function usageEvent(raw: unknown): ChatStreamEvent | null {
  if (!isRecord(raw)) return null;
  const fields = normalizeUsage(raw);
  if (!hasTokenCounts(fields)) return null;
  return { kind: 'usage', ...fields };
}

/**
 * Flat `ContentBlock[]` → bounded deltas (text and reasoning only — the
 * `tool/call` row owns tool-call blocks).
 */
function blockDeltas(content: unknown, out: ChatStreamEvent[]): void {
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw['type'] !== 'text' && raw['type'] !== 'reasoning') continue;
    const text = bounded(raw['text'], 100_000);
    if (text === undefined || text === '') continue;
    out.push({
      kind: raw['type'] === 'reasoning' ? 'thought_delta' : 'message_delta',
      delta: text,
    });
  }
}

/** The live mapper's two intake arms (see `createDshLiveMapper`). */
export interface DshLiveMapper {
  /**
   * One durable SessionEvent row (transcript tail OR the tap's `session/event`
   * bus arm) → 0..n stream events. Settlement `assistant/message` carries the
   * step's dedup key: if tap frames already streamed deltas for that
   * `turn:step`, ONLY the usage rides through (re-sending the complete blocks
   * would double-render); if none did (late tail attach, tap-less fallback),
   * the complete blocks are emitted — the wire's committed chunk is
   * suppressed while a streaming source is live, so this fallback is the only
   * copy. `assistant/attempt` (a failed/retried attempt that committed no
   * surface message) maps to nothing. Turn markers and user inputs never map
   * live — the prompt response owns turn_result, and the browser echoes the
   * user's own prompt.
   */
  event(entry: UnknownRecord): ChatStreamEvent[];
  /**
   * One `agent/assistant-stream` frame (the tap's delta arm) → 0..n events.
   * `start` records the attempt's `turn:step` (chunk frames carry only the
   * attemptId); `chunk` maps text/reasoning deltas and marks the step
   * streamed (the settlement dedup key); every other frame kind/chunk type —
   * block markers, tool-call deltas, usage (rides the commit), finish — maps
   * to nothing.
   */
  frame(frame: UnknownRecord): ChatStreamEvent[];
}

/**
 * The stateful LIVE mapper for dsh ≥0.1.3: durable settlement rows + live
 * `agent/assistant-stream` frames → stream events (shapes verified against
 * dsh 0.2.0-rc.2 source — wiki research-phase-9-w7-native-sessions.md).
 */
export function createDshLiveMapper(): DshLiveMapper {
  /** (turn:step) keys whose deltas were streamed from tap frames. */
  const stepsWithDeltas = new Set<string>();
  /** attemptId → its step key (frames carry turn/step only on `start`). */
  const attemptSteps = new Map<string, string>();

  const event = (entry: UnknownRecord): ChatStreamEvent[] => {
    const data = isRecord(entry['data']) ? (entry['data'] as UnknownRecord) : null;
    if (data === null) return [];
    switch (entry['type']) {
      case 'assistant/message': {
        const out: ChatStreamEvent[] = [];
        const key = stepKey(data);
        const streamed = key !== null && stepsWithDeltas.delete(key);
        if (!streamed) {
          const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
          blockDeltas(message !== null ? message['content'] : undefined, out);
        }
        const usage = usageEvent(data['usage']);
        if (usage !== null) out.push(usage);
        return out;
      }
      case 'tool/call': {
        const event = toolStartEvent(data['callId'], data['name'], data['arguments']);
        return event === null ? [] : [event];
      }
      case 'tool/result': {
        const event = toolResultEvent(data);
        return event === null ? [] : [event];
      }
      default:
        return [];
    }
  };

  const frame = (raw: UnknownRecord): ChatStreamEvent[] => {
    const attemptId = typeof raw['attemptId'] === 'string' ? raw['attemptId'] : null;
    if (raw['type'] === 'start') {
      if (attemptId !== null) {
        const key = stepKey(raw); // start frames carry turn/step at the top level
        if (key !== null) attemptSteps.set(attemptId, key);
      }
      return [];
    }
    if (raw['type'] !== 'chunk') return [];
    const chunk = isRecord(raw['chunk']) ? (raw['chunk'] as UnknownRecord) : null;
    if (chunk === null) return [];
    const kind =
      chunk['type'] === 'text-delta'
        ? 'message_delta'
        : chunk['type'] === 'reasoning-delta'
          ? 'thought_delta'
          : null;
    if (kind === null) return [];
    const text = bounded(chunk['text'], 100_000);
    if (text === undefined || text === '') return [];
    if (attemptId !== null) {
      const key = attemptSteps.get(attemptId);
      if (key !== undefined) stepsWithDeltas.add(key);
    }
    return [{ kind, delta: text }];
  };

  return { event, frame };
}

/**
 * Map dsh transcript rows onto history items (user blocks + ordinary stream
 * events — ONE fold path in the browser). Genuine user turns are the
 * `agent/inbox/spliced` inserts; `user/message` echoes and the synthesized
 * runtime-context messages are skipped. Usage rides each `assistant/message`
 * commit (v4 — the v0 `assistant/chunk` usage markers are gone).
 */
export function dshHistoryItems(entries: UnknownRecord[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    const type = entry['type'];
    const data = isRecord(entry['data']) ? (entry['data'] as UnknownRecord) : null;
    if (data === null) continue;
    switch (type) {
      case 'agent/inbox/spliced': {
        const inserted = data['inserted'];
        if (!Array.isArray(inserted)) break;
        for (const raw of inserted) {
          if (!isRecord(raw)) continue;
          const source = isRecord(raw['source']) ? (raw['source'] as UnknownRecord) : null;
          if (source === null || source['kind'] !== 'user') continue;
          const blocks = toPromptBlocks(raw['content']);
          if (blocks.length > 0) items.push({ type: 'user', blocks });
        }
        break;
      }
      case 'assistant/message': {
        const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
        const content = message !== null ? message['content'] : undefined;
        if (Array.isArray(content)) {
          for (const rawBlock of content) {
            if (!isRecord(rawBlock)) continue;
            const block = rawBlock as UnknownRecord;
            if (block['type'] === 'reasoning') {
              const text = bounded(block['text'], 100_000);
              if (text !== undefined && text !== '') {
                items.push({ type: 'event', event: { kind: 'thought_delta', delta: text } });
              }
            } else if (block['type'] === 'text') {
              const text = bounded(block['text'], 100_000);
              if (text !== undefined && text !== '') {
                items.push({ type: 'event', event: { kind: 'message_delta', delta: text } });
              }
            } else if (block['type'] === 'tool-call') {
              const event = toolStartEvent(block['id'], block['name'], block['arguments']);
              if (event !== null) items.push({ type: 'event', event });
            }
          }
        }
        const usage = usageEvent(data['usage']);
        if (usage !== null) items.push({ type: 'event', event: usage });
        break;
      }
      case 'tool/call': {
        const event = toolStartEvent(data['callId'], data['name'], data['arguments']);
        if (event !== null) items.push({ type: 'event', event });
        break;
      }
      case 'tool/result': {
        const event = toolResultEvent(data);
        if (event !== null) items.push({ type: 'event', event });
        break;
      }
      case 'turn/end': {
        const reason = isRecord(data['reason']) ? (data['reason'] as UnknownRecord) : null;
        items.push({
          type: 'event',
          event: {
            kind: 'turn_result',
            stopReason: reason?.['kind'] === 'aborted' ? 'cancelled' : 'end_turn',
          },
        });
        break;
      }
      default:
        break; // presets, request/*, step markers, attempts, title — not history
    }
  }
  return items;
}

/** dsh content blocks → prompt blocks (text only in v1, matching our wire). */
function toPromptBlocks(content: unknown): { type: 'text'; text: string }[] {
  const blocks: { type: 'text'; text: string }[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const raw of content) {
    if (isRecord(raw) && raw['type'] === 'text' && typeof raw['text'] === 'string') {
      if (raw['text'] !== '') blocks.push({ type: 'text', text: bounded(raw['text'], 32_000)! });
    }
  }
  return blocks;
}

// ---- live transcript tail (the tap-down streaming fallback) ----

/** Locate a session's own directory by id across the slug dirs (null = absent). */
export function findSessionDir(
  sessionsDir: string,
  sessionId: string,
  readdir: (path: string) => string[],
): string | null {
  let slugs: string[];
  try {
    slugs = readdir(sessionsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const dir = `${sessionsDir}/${slug}/${sessionId}`;
    try {
      readdir(dir); // the session directory exists — the log follows on first write
    } catch {
      continue; // not under this slug
    }
    return dir;
  }
  return null;
}

/** Locate a session's current log by id across the slug dirs (null = absent/unsupported). */
export function findTranscript(
  sessionsDir: string,
  sessionId: string,
  readdir: (path: string) => string[],
): string | null {
  const dir = findSessionDir(sessionsDir, sessionId, readdir);
  return dir === null ? null : (currentSessionLog(dir, readdir)?.file ?? null);
}

/** The fs surface `TranscriptTail` needs (injectable for tests). */
export interface TailFs {
  /** Current byte size, or null while the file is absent. */
  size(path: string): number | null;
  /** The bytes from `start` to the current end (may grow mid-call — fine). */
  readEnd(path: string, start: number): Buffer;
}

/** Runtime knobs for `TranscriptTail`. */
export interface TailOptions {
  /** Poll interval (default 250ms — dsh flushes write batches ~100–300ms apart). */
  intervalMs?: number;
  /**
   * Fired when the file corrupts mid-stream (a bounded frame that fails to
   * decode): the tail stops itself and the caller should fall back to the
   * adapter's committed chunks (wire suppression must lift).
   */
  onFatal?: (reason: string) => void;
}

/**
 * Tails a dsh transcript as the FALLBACK streaming source (the tap is
 * preferred; #46-gated dsh ≥0.2.0-rc.2). Ground truth (v4 write path): every
 * durable append batch lands as one checksummed zstd frame, so polling the
 * file yields SETTLEMENT rows (blocks, tool events, usage) roughly one write
 * window behind — token-granular deltas ride only the tap's
 * `agent/assistant-stream` frames. New bytes are split into frames, decoded,
 * and mapped through a stateful live mapper's `event` arm (with the
 * `turn:step` committed-dedup against tap-streamed steps — see its doc).
 *
 * A trailing frame cut mid-write decodes only once its remaining bytes
 * arrive: the last undecodable slice is buffered for the next poll (the
 * writer completes it on the next batch or truncates it back on rollback).
 * `start()` skips existing bytes (history was already rendered);
 * `flush()` drains once more so a turn's final tokens stay ordered before
 * its turn_result. A BOUNDED frame that fails to decode is corruption —
 * `onFatal` fires and the tail stops (the committed path takes over).
 */
export class TranscriptTail {
  private pending = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private offset = 0;
  private readonly mapper = createDshLiveMapper();
  /** Wall-clock of the last `turn/end` row seen (0 = none). */
  private lastTurnEndAt = 0;

  constructor(
    private readonly file: string,
    private readonly fs: TailFs,
    private readonly decompress: FrameDecoder,
    private readonly onEvent: (event: ChatStreamEvent) => void,
    private readonly opts: TailOptions = {},
  ) {}

  /** Begin polling. `replayFromBeginning` re-maps the whole file instead of
   * skipping existing bytes — valid ONLY when nothing in it was ever
   * rendered (a lazily-materialized new-session transcript attached mid-turn:
   * replaying recovers the deltas that landed before the attach; the
   * caller guarantees no earlier turn ran through the committed path). */
  start(replayFromBeginning = false): void {
    this.offset = replayFromBeginning ? 0 : (this.fs.size(this.file) ?? 0);
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs ?? 250);
    this.timer.unref?.();
  }

  /** Whether a `turn/end` row landed since `since` (the settle signal). */
  turnEndSeenSince(since: number): boolean {
    return this.lastTurnEndAt >= since;
  }

  /** One synchronous drain (call before settling a turn). */
  flush(): void {
    if (!this.stopped) this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.pending = Buffer.alloc(0);
  }

  private poll(): void {
    const size = this.fs.size(this.file);
    if (size === null || size <= this.offset) return;
    let chunk: Buffer;
    try {
      chunk = this.fs.readEnd(this.file, this.offset);
    } catch {
      return;
    }
    this.offset += chunk.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    this.drain();
  }

  private drain(): void {
    const frames = splitZstdFrames(this.pending);
    let consumed = 0;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      let text: string;
      try {
        text = this.decompress(frame).toString('utf8');
      } catch {
        if (i === frames.length - 1) break; // partial trailing frame — wait
        // A bounded frame that won't decode is mid-file corruption: frames
        // are self-terminating, so the mapper can no longer be trusted to
        // see every commit. Stop and let the committed wire path take over.
        const reason = `transcript corrupt at byte ${this.offset}: undecodable frame`;
        this.stop();
        this.opts.onFatal?.(reason);
        return;
      }
      consumed += frame.length;
      this.emitLines(text);
    }
    this.pending = this.pending.subarray(consumed);
  }

  private emitLines(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      if (entry['type'] === 'turn/end') this.lastTurnEndAt = Date.now();
      for (const event of this.mapper.event(entry)) this.onEvent(event);
    }
  }
}
