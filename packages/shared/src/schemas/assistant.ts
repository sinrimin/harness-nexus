// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';
import { historyItemSchema, promptBlocksBudgetedSchema, promptBlockSchema } from '../realtime.js';

/**
 * Issue #52 — the platform assistant's wire shapes: REST (configs, sessions,
 * transcript) + the `/app` `assistant:*` socket family. All owner-only.
 *
 * Live turns REUSE the `ChatStreamEvent` family (`assistant:event` carries the
 * same envelope shape as `chat:event`), and history replays as
 * `historyItem`s — the web folds both on the one existing path. The model /
 * agent selects ride the W9 `session_config` option surface with OPAQUE
 * values (`configId: 'agent' | 'model'`), exactly like a machine agent's
 * sender controls.
 */

// ---- tool groups ----

export const ASSISTANT_TOOL_GROUPS = [
  'resources',
  'profiles',
  'mcp',
  'skills-hub',
  'machines',
  // #67 — client-agent dispatch; deliberately NOT in the defaults (opt-in).
  'agent-dispatch',
  'system',
] as const;

export const assistantToolGroupSchema = z.enum(ASSISTANT_TOOL_GROUPS);
export type AssistantToolGroup = z.infer<typeof assistantToolGroupSchema>;

/** The default groups a new config starts from: reads everywhere, writes on resources/profiles. */
export const DEFAULT_ASSISTANT_TOOL_GROUPS: readonly AssistantToolGroup[] = [
  'resources',
  'profiles',
  'mcp',
  'skills-hub',
  'machines',
  'system',
];

// ---- config REST ----

export const assistantConfigCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  providerId: z.string().min(1).max(64),
  /** Must be a `type:'chat'` entry on that provider's registry (service-validated). */
  defaultModel: z.string().min(1).max(128),
  systemPromptOverride: z.string().max(32_000).optional(),
  enabledToolGroups: z
    .array(assistantToolGroupSchema)
    .max(16)
    .default([...DEFAULT_ASSISTANT_TOOL_GROUPS]),
  /** M2 — full replace; visibility validated in the service. */
  mcpServerIds: z.array(z.string().min(1).max(64)).max(32).default([]),
  skillResourceIds: z.array(z.string().min(1).max(64)).max(64).default([]),
  /** M3 — null/unset = unlimited. */
  dailyTokenBudget: z.number().int().positive().max(2_000_000_000).nullable().optional(),
});
export type AssistantConfigCreateInput = z.input<typeof assistantConfigCreateSchema>;

/** PATCH body — `name` uniqueness is per owner; empty update rejected. */
export const assistantConfigUpdateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    description: z.string().max(512).nullable().optional(),
    providerId: z.string().min(1).max(64).optional(),
    defaultModel: z.string().min(1).max(128).optional(),
    systemPromptOverride: z.string().max(32_000).nullable().optional(),
    enabledToolGroups: z.array(assistantToolGroupSchema).max(16).optional(),
    mcpServerIds: z.array(z.string().min(1).max(64)).max(32).optional(),
    skillResourceIds: z.array(z.string().min(1).max(64)).max(64).optional(),
    /** M3 — `null` clears back to unlimited. */
    dailyTokenBudget: z.number().int().positive().max(2_000_000_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty update' });
export type AssistantConfigUpdateInput = z.input<typeof assistantConfigUpdateSchema>;

export const assistantConfigViewSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  providerId: z.string().min(1),
  defaultModel: z.string().min(1).max(128),
  systemPromptOverride: z.string().max(32_000).optional(),
  enabledToolGroups: z.array(assistantToolGroupSchema),
  mcpServerIds: z.array(z.string()),
  skillResourceIds: z.array(z.string()),
  dailyTokenBudget: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AssistantConfigView = z.infer<typeof assistantConfigViewSchema>;

// ---- session REST ----

export const assistantSessionViewSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  assistantId: z.string().min(1),
  title: z.string().max(256),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
});
export type AssistantSessionView = z.infer<typeof assistantSessionViewSchema>;

/** One live assistant channel in the per-user `assistant:sessions` push (the rail's busy truth). */
export const assistantLiveSessionViewSchema = assistantSessionViewSchema.extend({
  /** A turn is generating on this session right now (per-user single-turn gate). */
  busy: z.boolean(),
});
export type AssistantLiveSessionView = z.infer<typeof assistantLiveSessionViewSchema>;

// ---- persisted transcript rows (validated at the storage write boundary) ----

export const assistantPromptBlockSchema = promptBlockSchema;

export const assistantToolCallItemSchema = z.object({
  id: z.string().min(1).max(128),
  tool: z.string().min(1).max(128),
  args: z.unknown(),
});

export const assistantToolResultItemSchema = z.object({
  toolCallId: z.string().min(1).max(128),
  tool: z.string().min(1).max(128),
  /** Model-facing output text (bounded at write time). */
  output: z.string().max(100_000),
  isError: z.boolean(),
  durationMs: z.number().int().min(0).optional(),
});

export const assistantMessageRowSchema = z.discriminatedUnion('type', [
  z.object({
    seq: z.number().int().min(0),
    type: z.literal('user'),
    blocks: z.array(promptBlockSchema).min(1).max(16),
  }),
  z.object({
    seq: z.number().int().min(0),
    type: z.literal('assistant'),
    text: z.string().max(200_000),
    thought: z.string().max(200_000),
    toolCalls: z.array(assistantToolCallItemSchema).max(64),
    stopReason: z.enum(['end_turn', 'max_tokens', 'refusal', 'aborted', 'error']),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
      })
      .optional(),
    error: z.string().max(2000).optional(),
  }),
  z.object({
    seq: z.number().int().min(0),
    type: z.literal('toolResult'),
    results: z.array(assistantToolResultItemSchema).min(1).max(64),
  }),
  z.object({
    seq: z.number().int().min(0),
    type: z.literal('note'),
    text: z.string().min(1).max(2000),
    /** #68 — also part of the model's context on the next turn (dispatch backflow). */
    modelVisible: z.literal(true).optional(),
  }),
]);
export type AssistantMessageRowWire = z.infer<typeof assistantMessageRowSchema>;

// ---- /app socket family (server ↔ browser) ----

/** browser → server: open (or idempotently rejoin) one assistant session's live channel. */
export const assistantSessionOpenRequestSchema = z.object({
  assistantId: z.string().min(1).max(64),
  /** Rejoin an already-live channel (the running turn keeps streaming to the room). */
  sessionId: z.string().min(1).max(64).optional(),
});

/** server → room: the channel is live (emitted on every open — the web settles its pane from it). */
export const assistantSessionReadyEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  assistantId: z.string().min(1).max(64),
  assistantName: z.string().max(64),
});

/** browser → server: send a turn prompt (string or blocks; busy parks in the depth-1 slot). */
export const assistantMessageSendRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  content: z.union([z.string().min(1).max(32000), promptBlocksBudgetedSchema]),
});

/** browser → server: abort the running turn (the transcript records `aborted`). */
export const assistantTurnCancelRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

/** browser → server: drop the parked queue entry (edit = cancel + re-draft). */
export const assistantQueueCancelRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

/**
 * browser → server: switch the assistant config (`agent`) or the model
 * (`model`) for the NEXT turn. OPAQUE values — `agent` is an assistant config
 * id, `model` a registry model id on the session's provider; the server
 * validates both at apply time, never trusts the browser's labels.
 */
export const assistantConfigSetRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  kind: z.literal('option'),
  configId: z.enum(['agent', 'model']),
  value: z.string().min(1).max(128),
});

/** browser → server: stop viewing (the live channel ends; the session row persists). */
export const assistantSessionCloseRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(64).optional(),
});

/** server → room: one live stream event (`ChatStreamEvent` shapes, like `chat:event`). */
export const assistantStreamEventEnvelopeSchema = z.object({
  sessionId: z.string().min(1).max(64),
  event: z.unknown(), // ChatStreamEvent — kept unknown here to avoid a realtime.ts import cycle
});

/** server → room: the transcript replay (the same items `chat:history` carries). */
export const assistantHistoryEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  items: z.array(historyItemSchema).max(5000),
});

/** server → room: the live channel ended (reason: user / config-deleted / server-shutdown). */
export const assistantSessionClosedEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(64),
});

/** server → room: the turn failed to run at all (provider/credential/model errors). */
export const assistantSessionFailedEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  error: z.string().max(512),
});

/** server → user room: the rail's truth (sessions + live busy flags), pushed on every change. */
export const assistantSessionsPushSchema = z.object({
  sessions: z.array(assistantLiveSessionViewSchema).max(1000),
});
export type AssistantSessionsPush = z.infer<typeof assistantSessionsPushSchema>;
