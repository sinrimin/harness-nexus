// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { LlmProvider } from '@harness-nexus/core';
import { resolveTurnModel, type AssistantRunnerDeps } from './runner.js';

/**
 * #109 — assistant session titles. The FALLBACK is derived the moment the
 * first prompt is APPENDED (turn start, not settle): the rail shows a real
 * title from the first keystroke's send, including the turn-error path. The
 * REFINE is one fire-and-forget call on the session's OWN provider/model —
 * ANY failure keeps the fallback, and it replaces the stored title only
 * while that still equals the fallback it was fired with (a user rename
 * always wins). The title never enters the model context: the refine sees
 * only the first prompt text.
 */

const FALLBACK_MAX_CODEPOINTS = 40;
const REFINED_MAX_CODEPOINTS = 60;
const REFINE_TIMEOUT_MS = 20_000;
/** The refine sees only the first prompt; a novel-length opener is capped. */
const REFINE_PROMPT_CAP = 4000;

/**
 * Strip ANSI/OSC escapes and control characters, collapse whitespace to one
 * line, truncate by CODEPOINTS (~40) so surrogate pairs never split (the old
 * `.slice(0, 80)` UTF-16 cut could mojibake an emoji).
 */
export function deriveFallbackTitle(blocks: readonly unknown[]): string {
  const raw = blocks
    .map((b) =>
      typeof b === 'object' && b !== null && 'type' in b && (b as { type: unknown }).type === 'text'
        ? (b as { text?: unknown }).text
        : undefined,
    )
    .filter((t): t is string => typeof t === 'string')
    .join(' ');
  const clean = raw
    // OSC (ESC ] … BEL / ST) then CSI (ESC [ … final byte) sequences…
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, ' ')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    // …then any remaining escape and the C0/Delete controls.
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return '';
  const cps = Array.from(clean);
  return cps.length <= FALLBACK_MAX_CODEPOINTS
    ? clean
    : cps.slice(0, FALLBACK_MAX_CODEPOINTS).join('');
}

/**
 * The refine reply contract: ONE line of plain text, no Markdown. Rejects a
 * reply that starts with a Markdown/quote character, contains a fence or a
 * list marker, spans lines, or runs past the cap — ANY rejection returns ''
 * and the caller keeps the fallback.
 */
export function validateRefinedTitle(reply: string): string {
  const text = reply.replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  if (/^[*#>"'`]/.test(text)) return '';
  if (/^-(?:\s|$)/.test(text) || /^\d+\.\s/.test(text)) return '';
  if (/```/.test(text)) return '';
  if (Array.from(text).length > REFINED_MAX_CODEPOINTS) return '';
  return text;
}

/** Test seam — the same shape the runner exposes. */
type BuildModel = AssistantRunnerDeps['buildModel'];

const REFINE_SYSTEM_PROMPT = [
  'You title chat conversations.',
  'Reply with ONE line of plain text: a concise title for this conversation, in the SAME language as the user, about 5 words (or around 10 CJK characters).',
  'Plain text only — no Markdown, no quotes, no code, no list markers, no preamble.',
].join(' ');

/**
 * One small model call for the refined title. Never throws — every failure
 * path (setup drift, network, timeout, junk reply) resolves '' and the
 * caller keeps the fallback. No retry, 20s cap, tools empty: this is a
 * titling side-quest, not a turn.
 */
export async function refineSessionTitle(
  deps: {
    uow: AssistantRunnerDeps['uow'];
    credentialEncryptionKey: string;
    buildModel?: BuildModel;
  },
  input: { ownerId: string; provider: LlmProvider; modelId: string; firstPrompt: string },
): Promise<string> {
  try {
    const gateway = await (deps.buildModel !== undefined
      ? deps.buildModel({
          provider: input.provider,
          modelId: input.modelId,
          ownerId: input.ownerId,
        })
      : resolveTurnModel(deps, input.ownerId, input.provider, input.modelId));
    const agent = new Agent({
      initialState: {
        systemPrompt: REFINE_SYSTEM_PROMPT,
        model: gateway.model,
        tools: [],
        messages: [],
      },
      streamFn: gateway.streamFn,
    });
    const message: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: input.firstPrompt.slice(0, REFINE_PROMPT_CAP) }],
      timestamp: Date.now(),
    };
    const settled = (async () => {
      await agent.prompt(message);
      await agent.waitForIdle();
      const assistants = agent.state.messages.filter(
        (m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant',
      );
      const last = assistants[assistants.length - 1];
      if (last === undefined || last.stopReason === 'error') return '';
      return validateRefinedTitle(
        last.content
          .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
          .map((c) => c.text)
          .join(''),
      );
    })();
    return await Promise.race([
      settled,
      new Promise<string>((resolve) => {
        setTimeout(() => {
          agent.abort();
          resolve('');
        }, REFINE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return '';
  }
}
