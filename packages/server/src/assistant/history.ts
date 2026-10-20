// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, JsonObject } from '@earendil-works/pi-ai';
import type {
  AssistantMessageRow,
  AssistantPromptBlock,
  FileBlobRepository,
} from '@harness-nexus/core';
import type { ChatStreamEvent, HistoryItem, PromptBlock } from '@harness-nexus/shared';

/**
 * Transcript conversion (#52): the persisted role-bearing rows are the single
 * truth; both consumers derive from them.
 *
 *   rows → pi AgentMessage[]  (rebuild the Agent per turn — server restarts
 *                              lose nothing; usage is zeroed, the API does not
 *                              need historical billing)
 *   rows → HistoryItem[]      (the `assistant:history` replay — the SAME event
 *                              family the live turn streamed, so the web folds
 *                              one path)
 *
 * #59 — persisted image blocks are REFERENCES (`imageRef`); both consumers
 * resolve them against a preloaded `ImageMap` (or, for the replay, a resolver
 * callback). A ref that cannot be resolved — the blob expired or was swept —
 * degrades to a text placeholder IN THAT CONSUMER; the row itself never
 * changes, so the two consumers degrade independently and reversibly.
 */

/** pi stop ids for rebuilt history — historical aborts read as clean stops. */
function toPiStop(stopReason: string, hadToolCalls: boolean): 'stop' | 'length' | 'toolUse' {
  if (hadToolCalls) return 'toolUse';
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

/** Wire stop ids (the `turn_result` schema's enum). */
function toWireStop(stopReason: string): 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' {
  if (stopReason === 'max_tokens') return 'max_tokens';
  if (stopReason === 'aborted') return 'cancelled';
  if (stopReason === 'refusal') return 'refusal';
  return 'end_turn';
}

/**
 * #59 — what a stripped image becomes in the MODEL context. The transcript
 * keeps the real blocks (the UI replays them); only the LLM-facing rebuild
 * degrades, so a switch back to a vision model restores the images for free.
 */
export const IMAGE_CONTEXT_PLACEHOLDER = '[image omitted]';

/** #59 — what the replay renders where the blob behind a ref is gone. */
export const IMAGE_EXPIRED_PLACEHOLDER = '[image expired]';

/**
 * OpenAI-compatible wires reject user content that is images ONLY — the
 * placeholder part added when a turn would otherwise carry no text.
 */
const IMAGE_ONLY_PLACEHOLDER = '[image]';

/**
 * #58-3 — how many most-recent USER rows keep their images in the model
 * context. Older ones degrade to the placeholder: re-uploading every past
 * image on every turn bloats both the input bill and the provider's
 * per-request image limits.
 */
export const IMAGE_CONTEXT_TURNS = 3;

/** #58-3 — the turn's image policy, derived from the resolved model entry. */
export interface ImageContextPolicy {
  /** The registry entry's `vision` flag — false strips EVERY image. */
  vision: boolean;
  /** How many trailing user rows keep images (`IMAGE_CONTEXT_TURNS`). */
  keepTurns: number;
}

/**
 * #59 — ref → resolved payload for one build (null = gone/expired). Built
 * once per turn/replay by `loadImageMap`; the pure builders never touch the
 * repository themselves.
 */
export type ImageMap = Map<string, { data: string; mimeType: string } | null>;

/** #59 — preload every ref the builders will need (absent/expired → null). */
export async function loadImageMap(
  blobs: FileBlobRepository,
  refs: Iterable<string>,
  now: string,
): Promise<ImageMap> {
  const map: ImageMap = new Map();
  for (const ref of new Set(refs)) {
    const hit = await blobs.get(ref);
    map.set(
      ref,
      hit !== null && hit.row.expiresAt > now
        ? { data: Buffer.from(hit.data).toString('base64'), mimeType: hit.row.mimeType }
        : null,
    );
  }
  return map;
}

type PiUserContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * A resolved payload back into WIRE shape. The blob store's mimeType is a
 * plain string, but every ingest came from a wire-validated image block —
 * the four-value union holds by construction.
 */
function wireImage(hit: { data: string; mimeType: string }): PromptBlock {
  return {
    type: 'image',
    data: hit.data,
    mimeType: hit.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
  };
}

/** The MODEL-context mapping for one block, under the policy + resolved map. */
function toPiUserContent(
  b: AssistantPromptBlock,
  keepImage: boolean,
  images: ImageMap | undefined,
): PiUserContent {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'resource_link') {
    // resource_link has no pi arm — render as text (the model cannot fetch it).
    return { type: 'text', text: `[file reference] ${b.name}: ${b.uri}` };
  }
  if (b.type === 'imageRef') {
    if (!keepImage) return { type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER };
    const hit = images?.get(b.ref);
    return hit !== undefined && hit !== null
      ? { type: 'image', data: hit.data, mimeType: hit.mimeType }
      : { type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER };
  }
  // Legacy inline arm (pre-#59 rows).
  if (!keepImage) return { type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER };
  return { type: 'image', data: b.data, mimeType: b.mimeType };
}

/** A user turn must not be images-only on OpenAI-compatible wires. */
function withImageOnlyGuard(content: PiUserContent[]): PiUserContent[] {
  const hasText = content.some((c) => c.type === 'text');
  const hasImage = content.some((c) => c.type === 'image');
  return hasImage && !hasText
    ? [{ type: 'text', text: IMAGE_ONLY_PLACEHOLDER }, ...content]
    : content;
}

/** The CURRENT turn's prompt blocks under the same policy (it is the newest). */
export function promptBlocksToPiContent(
  blocks: readonly AssistantPromptBlock[],
  policy: ImageContextPolicy,
  images?: ImageMap,
): PiUserContent[] {
  return withImageOnlyGuard(blocks.map((b) => toPiUserContent(b, policy.vision, images)));
}

/**
 * Rebuild the LLM context. `api`/`model` label the reconstructed assistant
 * messages for the provider (informational fields on the wire).
 *
 * `images` (#58-3 + #59): when given, image blocks degrade to the placeholder
 * in every user row OUTSIDE the policy — a non-vision model strips ALL of them
 * (a mid-session switch must not feed images the wire would reject); a vision
 * model keeps only the `keepTurns` most recent user rows'. Omitted = legacy
 * keep-everything behavior (inline arms pass through; refs degrade). The
 * transcript rows themselves are untouched.
 */
export function rowsToPiMessages(
  rows: readonly AssistantMessageRow[],
  api: Api,
  model: string,
  images?: ImageContextPolicy,
  imageMap?: ImageMap,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  const now = Date.now();
  const keepRows = new Set<number>();
  if (images !== undefined && images.vision) {
    const userIdxs: number[] = [];
    rows.forEach((row, idx) => {
      if (row.type === 'user') userIdxs.push(idx);
    });
    for (const idx of userIdxs.slice(-images.keepTurns)) keepRows.add(idx);
  }
  let i = 0;
  // #68 — modelVisible notes (dispatch backflow) ride ALONG the conversation,
  // never as standalone turns: they prepend to the NEXT user row, so a note
  // that landed mid-turn (between a toolCall and its toolResult in seq order
  // would break provider alternation) reaches the model exactly one turn
  // later — which is also the earliest the running turn could see it anyway.
  const pendingNotes: string[] = [];
  const takeNotes = (): string | null => {
    if (pendingNotes.length === 0) return null;
    const text = pendingNotes.map((n) => `[platform note] ${n}`).join('\n');
    pendingNotes.length = 0;
    return text;
  };
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.type === 'user') {
      const keep = images === undefined ? true : keepRows.has(i);
      const note = takeNotes();
      out.push({
        role: 'user',
        content: withImageOnlyGuard([
          ...(note !== null ? [{ type: 'text' as const, text: note }] : []),
          ...row.blocks.map((b) => toPiUserContent(b, keep, imageMap)),
        ]),
        timestamp: now,
      });
    } else if (row.type === 'assistant') {
      out.push({
        role: 'assistant',
        content: [
          ...(row.thought !== '' ? [{ type: 'thinking' as const, thinking: row.thought }] : []),
          ...(row.text !== '' ? [{ type: 'text' as const, text: row.text }] : []),
          ...row.toolCalls.map((c) => ({
            type: 'toolCall' as const,
            id: c.id,
            name: c.tool,
            arguments: (rowToolArgs(c.args) ?? {}) as JsonObject,
          })),
        ],
        api,
        provider: 'harness-nexus-assistant',
        model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: toPiStop(row.stopReason, row.toolCalls.length > 0),
        ...(row.error !== undefined ? { errorMessage: row.error } : {}),
        timestamp: now,
      });
    } else if (row.type === 'toolResult') {
      for (const r of row.results) {
        out.push({
          role: 'toolResult',
          toolCallId: r.toolCallId,
          toolName: r.tool,
          content: [{ type: 'text', text: r.output }],
          isError: r.isError,
          timestamp: now,
        });
      }
    }
    // note rows are platform annotations — only the modelVisible arm (#68)
    // reaches the model, folded into the next user turn (see pendingNotes).
    if (row.type === 'note' && row.modelVisible === true) pendingNotes.push(row.text);
    i += 1;
  }
  // Trailing notes (e.g. a completion note after the last assistant turn):
  // merge into a trailing user row when one exists, else a final user turn.
  const trailing = takeNotes();
  if (trailing !== null) {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === 'user') {
      const prev = last.content;
      last.content = [
        ...(typeof prev === 'string' ? [{ type: 'text' as const, text: prev }] : prev),
        { type: 'text' as const, text: trailing },
      ];
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: trailing }], timestamp: now });
    }
  }
  return out;
}

function rowToolArgs(args: unknown): JsonObject | null {
  if (args === null || typeof args !== 'object') return null;
  return args as JsonObject;
}

/**
 * The history replay: rows → history items. Tool outputs (the FOLLOWING
 * toolResult row) merge into their tool_call views so the fold renders one
 * row per call, like the live stream does.
 *
 * #59 — `resolve` turns an `imageRef` into a wire image block (or null when
 * the blob is gone/expired); unresolved refs replay as `[image expired]`
 * text. The legacy inline arm replays verbatim.
 */
export async function rowsToHistoryItems(
  rows: readonly AssistantMessageRow[],
  resolve?: (ref: string) => Promise<{ data: string; mimeType: string } | null>,
): Promise<HistoryItem[]> {
  const items: HistoryItem[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.type === 'user') {
      const blocks: PromptBlock[] = [];
      for (const b of row.blocks) {
        if (b.type === 'imageRef') {
          const hit = resolve !== undefined ? await resolve(b.ref) : null;
          blocks.push(
            hit !== null ? wireImage(hit) : { type: 'text', text: IMAGE_EXPIRED_PLACEHOLDER },
          );
        } else {
          blocks.push(b);
        }
      }
      items.push({ type: 'user', blocks });
      continue;
    }
    if (row.type === 'note') {
      // Failure annotations surface as error system rows; informational notes
      // (rebinds) render nothing in M1 — the config selects show the truth.
      // The modelVisible arm (#68 — dispatch backflow) renders as a neutral
      // annotation row, replaying exactly like the live raw event does.
      if (row.text.startsWith('error:')) {
        items.push({
          type: 'event',
          event: { kind: 'raw', method: 'hnx/prompt-error', params: { message: row.text } },
        });
      } else if (row.modelVisible === true) {
        items.push({
          type: 'event',
          event: { kind: 'raw', method: 'hnx/note', params: { message: row.text } },
        });
      }
      continue;
    }
    if (row.type === 'toolResult') continue; // merged below via lookahead
    // assistant row — lookahead for its results
    const next = i + 1 < rows.length ? rows[i + 1] : undefined;
    const results =
      next !== undefined && next.type === 'toolResult'
        ? (next.results as readonly {
            toolCallId: string;
            output: string;
            isError: boolean;
          }[])
        : [];
    const resultByCall = new Map(results.map((r) => [r.toolCallId, r]));
    if (row.thought !== '') {
      items.push({ type: 'event', event: { kind: 'thought_delta', delta: row.thought } });
    }
    if (row.text !== '') {
      items.push({ type: 'event', event: { kind: 'message_delta', delta: row.text } });
    }
    for (const c of row.toolCalls) {
      const r = resultByCall.get(c.id);
      items.push({
        type: 'event',
        event: {
          kind: 'tool_call',
          call: {
            toolCallId: c.id,
            toolName: c.tool,
            status: r === undefined ? 'completed' : r.isError ? 'failed' : 'completed',
            ...(isRecord(c.args) ? { rawInput: c.args } : {}),
            ...(r !== undefined ? { output: r.output.slice(0, 4000) } : {}),
          },
        },
      });
    }
    if (row.error !== undefined) {
      items.push({
        type: 'event',
        event: { kind: 'raw', method: 'hnx/prompt-error', params: { message: row.error } },
      });
    }
    if (row.usage !== undefined) {
      items.push({
        type: 'event',
        event: {
          kind: 'usage',
          ...(row.usage.inputTokens !== undefined ? { inputTokens: row.usage.inputTokens } : {}),
          ...(row.usage.outputTokens !== undefined ? { outputTokens: row.usage.outputTokens } : {}),
        },
      });
    }
    items.push({
      type: 'event',
      event: { kind: 'turn_result', stopReason: toWireStop(row.stopReason) },
    });
  }
  return items;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Wire stop for a live pi stopReason (the runner's turn tail). */
export function piStopToWire(stop: string): 'end_turn' | 'cancelled' | 'max_tokens' {
  if (stop === 'length') return 'max_tokens';
  if (stop === 'aborted') return 'cancelled';
  return 'end_turn';
}

export type { ChatStreamEvent };
