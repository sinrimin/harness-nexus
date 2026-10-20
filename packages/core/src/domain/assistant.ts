// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #52 — the platform assistant: a server-embedded agent (pi-agent-core
 * + pi-ai) that operates Harness Nexus as its owning user. All rows are
 * OWNER-ONLY (the #36 personal rule with no admin bypass — an admin gets the
 * same 404 as a stranger).
 *
 * The transcript is stored as role-bearing items (user / assistant /
 * toolResult) — the LLM-shaped truth. The view layer (shared
 * `historyItemSchema`) is derived from it; live turns stream as
 * `ChatStreamEvent`s, and history replay maps these rows onto the same event
 * family, so the web folds both on one path.
 */

/**
 * Tool groups the assistant may call (v1: read-heavy, NO delete/credential
 * tools). `agent-dispatch` (#67, DEFAULT OFF) drives client agents on the
 * owner's machines — the platform's highest-blast-radius surface, opt-in per
 * config and approval-gated per call.
 */
export type AssistantToolGroup =
  'resources' | 'profiles' | 'mcp' | 'skills-hub' | 'machines' | 'agent-dispatch' | 'system';

/** One named assistant configuration — many per user, name unique per owner. */
export interface AssistantConfig {
  id: string;
  ownerId: string;
  name: string;
  /** `| undefined` for exactOptionalPropertyTypes — updates clear via null (#51 pattern). */
  description?: string | undefined;
  /** The LlmProvider row whose credential + registry serve the model calls. */
  providerId: string;
  /** A `type:'chat'` model id from that provider's #51 registry. */
  defaultModel: string;
  /** Replaces the platform's default assistant prompt when set. */
  systemPromptOverride?: string | undefined;
  enabledToolGroups: AssistantToolGroup[];
  /**
   * M2 — server-dialed MCP servers the assistant may call (visibility is
   * validated at save; the pool decides dialability at turn time, unavailable
   * rows note honestly in the prompt).
   */
  mcpServerIds: string[];
  /**
   * M2 — platform skill resources (inline / inline-bundle) injected as a
   * prompt index + the `read_skill` tool (progressive disclosure).
   */
  skillResourceIds: string[];
  /**
   * M3 — the config's sessions may spend this many tokens (input+output,
   * summed over assistant turns) per UTC day before further turns refuse
   * honestly. Absent = unlimited. A cost guard, not a security boundary.
   */
  dailyTokenBudget?: number | undefined;
  createdAt: string;
  updatedAt: string;
  /**
   * Soft-delete: the config vanishes from pickers and its sessions stop
   * starting new turns, but existing sessions stay readable. Absent = live.
   */
  deletedAt?: string;
}

export interface AssistantSession {
  id: string;
  ownerId: string;
  assistantId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

/**
 * The MIME set an image block may carry (mirrors the shared wire schema's
 * `promptImageMimeSchema`).
 */
export type AssistantImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * Prompt content blocks. Text and resource_link mirror the shared
 * `promptBlockSchema`; images come in TWO persisted arms — `image` is the
 * LEGACY inline-base64 shape (pre-#59 rows stay readable; the ingest path no
 * longer produces it), `imageRef` is what the send path persists: a
 * `FileObject` id, with the bytes in the file-blob store (#59).
 */
export type AssistantPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; name: string; uri: string }
  | {
      /** Legacy inline arm (pre-#59 rows). */
      type: 'image';
      data: string;
      mimeType: AssistantImageMime;
    }
  | {
      /** #59 — reference arm: a `FileObject` id; the bytes never enter the DB. */
      type: 'imageRef';
      ref: string;
      mimeType: AssistantImageMime;
    };

/** One tool call an assistant turn requested (normalized from the pi stream). */
export interface AssistantToolCallItem {
  id: string;
  tool: string;
  args: unknown;
}

/** The tool results that settled one turn's calls (one row per call). */
export interface AssistantToolResultItem {
  toolCallId: string;
  tool: string;
  /** Model-facing text output (truncated at write time). */
  output: string;
  isError: boolean;
  durationMs?: number;
}

/**
 * The persisted transcript, append-only per session. `seq` is the fold order.
 * The `note` arm records platform-side annotations (rebind to another
 * assistant config, refusal-to-run reasons). Notes are display-only by
 * default; `modelVisible: true` (#68 — dispatch backflow) marks notes the
 * MODEL must also see on its next turn (user operations on a dispatched
 * client agent, dispatch completions) — they fold into the following user
 * turn at context-build time, never between a toolCall and its toolResult.
 */
export type AssistantMessageRow =
  | { seq: number; type: 'user'; blocks: AssistantPromptBlock[] }
  | {
      seq: number;
      type: 'assistant';
      text: string;
      /** Thinking/reasoning content, when the model streamed any. */
      thought: string;
      toolCalls: AssistantToolCallItem[];
      stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'aborted' | 'error';
      usage?: { inputTokens?: number; outputTokens?: number };
      error?: string;
    }
  | { seq: number; type: 'toolResult'; results: AssistantToolResultItem[] }
  | { seq: number; type: 'note'; text: string; modelVisible?: true };

/** Audit row — one per tool execution, written from the pi after-hook. */
export interface AssistantToolCallAudit {
  id: string;
  sessionId: string;
  userId: string;
  tool: string;
  /** Truncated argument snapshot (bounded, never secrets by construction). */
  args: string;
  status: 'ok' | 'error' | 'blocked';
  durationMs: number;
  createdAt: string;
}
