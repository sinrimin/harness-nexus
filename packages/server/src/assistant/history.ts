import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, JsonObject } from '@earendil-works/pi-ai';
import type { AssistantMessageRow, AssistantPromptBlock } from '@harness-nexus/core';
import type { ChatStreamEvent, HistoryItem } from '@harness-nexus/shared';

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

function blockToUserContent(
  b: AssistantPromptBlock,
): { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image') return { type: 'image', data: b.data, mimeType: b.mimeType };
  // resource_link has no pi arm — render as text (the model cannot fetch it).
  return { type: 'text', text: `[file reference] ${b.name}: ${b.uri}` };
}

/**
 * #58-3 — what a stripped image becomes in the MODEL context. The transcript
 * keeps the real blocks (the UI replays them); only the LLM-facing rebuild
 * degrades, so a switch back to a vision model restores the images for free.
 */
export const IMAGE_CONTEXT_PLACEHOLDER = '[image omitted]';

/**
 * #58-3 — how many most-recent USER rows keep their images in the model
 * context. Older ones degrade to the placeholder: re-uploading every past
 * image on every turn bloats both the input bill and the provider's
 * per-request image limits (the Claude Code precedent — recent turns only).
 */
export const IMAGE_CONTEXT_TURNS = 3;

/** #58-3 — the turn's image policy, derived from the resolved model entry. */
export interface ImageContextPolicy {
  /** The registry entry's `vision` flag — false strips EVERY image. */
  vision: boolean;
  /** How many trailing user rows keep images (`IMAGE_CONTEXT_TURNS`). */
  keepTurns: number;
}

function toUserContent(
  b: AssistantPromptBlock,
  keepImage: boolean,
): { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } {
  if (b.type === 'image' && !keepImage) {
    return { type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER };
  }
  return blockToUserContent(b);
}

/** The CURRENT turn's prompt blocks under the same policy (it is the newest). */
export function promptBlocksToPiContent(
  blocks: readonly AssistantPromptBlock[],
  policy: ImageContextPolicy,
): ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
  return blocks.map((b) => toUserContent(b, policy.vision));
}

/**
 * Rebuild the LLM context. `api`/`model` label the reconstructed assistant
 * messages for the provider (informational fields on the wire).
 *
 * `images` (#58-3): when given, image blocks degrade to the placeholder in
 * every user row OUTSIDE the policy — a non-vision model strips ALL of them
 * (a mid-session switch must not feed images the wire would reject); a vision
 * model keeps only the `keepTurns` most recent user rows'. Omitted = legacy
 * keep-everything behavior (the transcript rows themselves are untouched).
 */
export function rowsToPiMessages(
  rows: readonly AssistantMessageRow[],
  api: Api,
  model: string,
  images?: ImageContextPolicy,
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
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.type === 'user') {
      const keep = images === undefined ? true : keepRows.has(i);
      out.push({
        role: 'user',
        content: row.blocks.map((b) => toUserContent(b, keep)),
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
    // note rows are platform annotations — display-only, never model context.
    i += 1;
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
 */
export function rowsToHistoryItems(rows: readonly AssistantMessageRow[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.type === 'user') {
      items.push({ type: 'user', blocks: row.blocks });
      continue;
    }
    if (row.type === 'note') {
      // Failure annotations surface as error system rows; informational notes
      // (rebinds) render nothing in M1 — the config selects show the truth.
      if (row.text.startsWith('error:')) {
        items.push({
          type: 'event',
          event: { kind: 'raw', method: 'hnx/prompt-error', params: { message: row.text } },
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
