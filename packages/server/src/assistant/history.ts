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
 * Rebuild the LLM context. `api`/`model` label the reconstructed assistant
 * messages for the provider (informational fields on the wire).
 */
export function rowsToPiMessages(
  rows: readonly AssistantMessageRow[],
  api: Api,
  model: string,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  const now = Date.now();
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.type === 'user') {
      out.push({ role: 'user', content: row.blocks.map(blockToUserContent), timestamp: now });
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
