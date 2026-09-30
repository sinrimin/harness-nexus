import * as zlib from 'node:zlib';
import type { ChatStreamEvent, HistoryItem } from '@harness-nexus/shared';
import { hasTokenCounts, normalizeUsage } from './usage.js';

/**
 * dsh native session store reader (Phase 9 W7).
 * wiki design-phase-9-w7-native-sessions.md § ground truth.
 *
 * dsh persists every session at `~/.dsh/sessions/<cwd-slug>/<uuid>/
 * session.jsonl.zstd` as MULTI-FRAME zstd — one frame per write batch (the
 * engine appends every LLM chunk as a `assistant/chunk` session event; a
 * bounded write-behind window coalesces them ~100–300ms apart). Node's
 * one-shot AND stream zstd decoders stop after the first frame, so the reader
 * scans the frame magic (`28 B5 2F FD`), slices, and decodes each frame
 * separately. Delta runs reach disk in TWO shapes — packed `text-chunks`/
 * `reasoning-chunks`/`tool-call-chunks` rows (runs of ≥3 seq-contiguous
 * same-block deltas) and verbatim `assistant/chunk` events below that
 * (MIN_RUN=3 fall-through; shapes verified against dsh 0.1.2-rc.1 source).
 * Everything here is pure/bounded and injectable for tests; the zstd binding
 * is feature-detected (needs Node ≥ 22.15 — machines running dsh already
 * require it, but the daemon degrades gracefully below it).
 *
 * dsh's ACP adapter surfaces only COMMITTED updates — a whole reasoning/text
 * block arrives as ONE chunk when the turn ends, so there is no streaming
 * over the protocol. The transcript file, however, is appended LIVE with the
 * token batches, which is what `TranscriptTail` turns into real-time deltas.
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

// ---- listing ----

export interface DshSessionSummary {
  sessionId: string;
  cwd: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The model route the session pinned (`request/header.config.model`). */
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
 * found; bounded read so a huge transcript costs at most `maxBytes`. NB: the
 * `session` HEADER entry carries its fields at the TOP level (no `data`
 * wrapper), unlike every other entry type.
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
  // LIVED-IN session from dsh's config-preamble-only files (every fresh
  // session writes session/permission-preset/sandbox-mode/approval-policy
  // rows before any conversation, so header presence is NOT enough).
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
      const file = `${sessionsDir}/${slug}/${id}/session.jsonl.zstd`;
      let buf: Buffer;
      try {
        buf = fs.readFile(file);
      } catch {
        continue;
      }
      const { header, title, model, hasTurn } = scanSummary(buf, decompress);
      // Header-only/config-preamble transcripts are NOT conversations: every
      // dsh spawn writes them before any turn, and the -32605 startup-race
      // retry leaves one behind per lost race (the "two unnamed sessions"
      // double). Listing only lived-in sessions matches claude-code's
      // transcript-on-first-message semantics; a live-but-still-empty channel
      // still shows via the server's synthesized open row.
      if (!hasTurn) continue;
      if (header === null) continue;
      if (typeof header.cwd !== 'string' || header.cwd === '' || !header.cwd.startsWith('/')) {
        continue;
      }
      if (header.parentSession !== undefined || header.delegationDepth !== 0) continue;
      let mtimeMs: number;
      try {
        mtimeMs = fs.stat(file).mtimeMs;
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

/** Parse dsh's tool `arguments` (a JSON string) into a bounded rawInput map. */
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

/** The `tool/call` shape — in_progress with parsed arguments (shared: history + live tail). */
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

/** The `tool/result` shape — completed with the joined output text (shared). */
function toolResultEvent(message: UnknownRecord | null): ChatStreamEvent | null {
  const source = message !== null && isRecord(message['source']) ? message['source'] : null;
  const callId = source !== null ? source['callId'] : undefined;
  if (typeof callId !== 'string' || callId === '') return null;
  const texts: string[] = [];
  const content = message !== null ? message['content'] : undefined;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!isRecord(c)) continue;
      const inner = c['content'];
      if (!Array.isArray(inner)) continue;
      for (const piece of inner) {
        if (isRecord(piece) && piece['type'] === 'text' && typeof piece['text'] === 'string') {
          texts.push(piece['text']);
        }
      }
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

/** The `turn:step` dedup key, or null when the entry carries no coordinates. */
function stepKey(data: UnknownRecord): string | null {
  const turn = data['turn'];
  const step = data['step'];
  return typeof turn === 'number' && typeof step === 'number' ? `${turn}:${step}` : null;
}

/** A usage event from a commit's `usage` payload (null when absent/malformed). */
function usageEvent(raw: unknown): ChatStreamEvent | null {
  if (!isRecord(raw)) return null;
  const fields = normalizeUsage(raw);
  if (!hasTokenCounts(fields)) return null;
  return { kind: 'usage', ...fields };
}

/** The usage marker of a verbatim `assistant/chunk` row (history path). */
export function usageFromChunk(entry: UnknownRecord): ChatStreamEvent | null {
  const data = isRecord(entry['data']) ? (entry['data'] as UnknownRecord) : null;
  if (data === null) return null;
  const chunk = isRecord(data['chunk']) ? (data['chunk'] as UnknownRecord) : null;
  if (chunk === null || chunk['type'] !== 'usage') return null;
  return usageEvent(chunk['usage']);
}

/**
 * The stateful LIVE mapper: one dsh transcript entry → 0..n stream events.
 * Mirrors the semantics of dsh's own in-process bridge mapper (reference:
 * `updates.js` `createEventMapper`, engine/storage shapes verified against
 * dsh 0.1.2-rc.1 — the exact rig version):
 *
 * - Deltas arrive in TWO on-disk shapes: packed `text-chunks`/
 *   `reasoning-chunks` rows (runs of ≥3 seq-contiguous same-block deltas) and
 *   verbatim `assistant/chunk` events (shorter runs — the codec's MIN_RUN=3
 *   falls through). Both map; skipping either would silently drop content.
 * - Committed `assistant/message` carries the step's dedup key: if deltas for
 *   that `turn:step` were already emitted, ONLY the usage rides through
 *   (re-sending the full block would double-render); if none were (late tail
 *   attach, block-only adapters), the complete blocks are emitted — the wire's
 *   committed chunk is suppressed while the tail is live, so this fallback is
 *   the only copy. Tool-call blocks are skipped: the `tool/call` row owns them.
 * - Turn markers and user inputs never map live — the prompt response owns
 *   turn_result, and the browser echoes the user's own prompt.
 */
export type DshLiveMapper = (entry: UnknownRecord) => ChatStreamEvent[];

export function createDshLiveMapper(): DshLiveMapper {
  const stepsWithDeltas = new Set<string>();
  return (entry) => {
    const data = isRecord(entry['data']) ? (entry['data'] as UnknownRecord) : null;
    if (data === null) return [];
    switch (entry['type']) {
      case 'text-chunks':
      case 'reasoning-chunks': {
        const texts = data['texts'];
        if (!Array.isArray(texts)) return [];
        const delta = bounded(
          texts.filter((t): t is string => typeof t === 'string').join(''),
          100_000,
        );
        if (delta === undefined || delta === '') return [];
        const key = stepKey(data);
        if (key !== null) stepsWithDeltas.add(key);
        return [
          {
            kind: entry['type'] === 'reasoning-chunks' ? 'thought_delta' : 'message_delta',
            delta,
          },
        ];
      }
      case 'assistant/chunk': {
        // Verbatim delta events (runs below the codec's MIN_RUN). The usage /
        // block-start / block-end / finish / tool-call-delta chunks carry no
        // renderable text — usage rides the commit instead.
        const chunk = isRecord(data['chunk']) ? (data['chunk'] as UnknownRecord) : null;
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
        const key = stepKey(data);
        if (key !== null) stepsWithDeltas.add(key);
        return [{ kind, delta: text }];
      }
      case 'assistant/message': {
        const out: ChatStreamEvent[] = [];
        const key = stepKey(data);
        const streamed = key !== null && stepsWithDeltas.delete(key);
        if (!streamed) {
          const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
          const content = message !== null ? message['content'] : undefined;
          if (Array.isArray(content)) {
            for (const rawBlock of content) {
              if (!isRecord(rawBlock)) continue;
              const block = rawBlock as UnknownRecord;
              if (block['type'] !== 'text' && block['type'] !== 'reasoning') continue;
              const text = bounded(block['text'], 100_000);
              if (text !== undefined && text !== '') {
                out.push({
                  kind: block['type'] === 'reasoning' ? 'thought_delta' : 'message_delta',
                  delta: text,
                });
              }
            }
          }
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
        const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
        const event = toolResultEvent(message);
        return event === null ? [] : [event];
      }
      default:
        return [];
    }
  };
}

/**
 * Map dsh transcript entries onto history items (user blocks + ordinary
 * stream events — ONE fold path in the browser). Genuine user turns are the
 * `agent/inbox/spliced` inserts; `user/message` echoes and the synthesized
 * runtime-context messages are skipped.
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
        const content = message !== null ? message['content'] : data['content'];
        if (!Array.isArray(content)) break;
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
        break;
      }
      case 'tool/call': {
        const event = toolStartEvent(data['callId'], data['name'], data['arguments']);
        if (event !== null) items.push({ type: 'event', event });
        break;
      }
      case 'tool/result': {
        const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
        const event = toolResultEvent(message);
        if (event !== null) items.push({ type: 'event', event });
        break;
      }
      case 'assistant/chunk': {
        // Only the usage marker rides the history (the text chunks are
        // superseded by assistant/message's complete blocks).
        const event = usageFromChunk(entry);
        if (event !== null) items.push({ type: 'event', event });
        break;
      }
      case 'turn/end': {
        const reason = isRecord(data['reason']) ? (data['reason'] as UnknownRecord) : null;
        items.push({
          type: 'event',
          event: {
            kind: 'turn_result',
            stopReason: reason?.['kind'] === 'cancelled' ? 'cancelled' : 'end_turn',
          },
        });
        break;
      }
      default:
        break; // presets, request/*, step markers, deltas, title — not history
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

// ---- live transcript tail (dsh's streaming source) ----

/** Locate a session's transcript by id across the slug dirs (null = absent). */
export function findTranscript(
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
    const candidate = `${sessionsDir}/${slug}/${sessionId}/session.jsonl.zstd`;
    try {
      readdir(`${sessionsDir}/${slug}/${sessionId}`);
      return candidate; // the session dir exists — the file follows on first write
    } catch {
      // not under this slug
    }
  }
  return null;
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
 * Tails a dsh transcript for LIVE token streaming. Ground truth (dsh
 * 0.1.2-rc.1 write path): every engine `assistant/chunk` event rides the
 * session bus into a bounded write-behind batch (~100–300ms window) and lands
 * as one zstd frame per batch — so polling the file yields token batches
 * roughly one write window behind the model, while dsh's ACP adapter stays
 * silent until commit. New bytes are split into frames, decoded, and mapped
 * through a stateful `createDshLiveMapper` (packed rows AND verbatim chunk
 * events, with the `turn:step` committed-dedup — see its doc).
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
      for (const event of this.mapper(entry)) this.onEvent(event);
    }
  }
}
