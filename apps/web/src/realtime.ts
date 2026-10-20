// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { io, type Socket } from 'socket.io-client';
import { createResubscribeGate } from '@/lib/resubscribe';
import { TOKEN_KEY } from './api.js';

/**
 * The browser's `/app` realtime channel (Phase 8): server-push events only in
 * C1 (`machine:status`). One lazily-created singleton socket; the auth
 * callback re-reads the stored token on EVERY (re)connect attempt, so a
 * refreshed JWT after re-login needs no extra protocol support. Browsers
 * never talk to daemons — the platform is the only routing point.
 */

/** Wire shape of `inventory:updated` (mirrors shared/realtime.ts). */
export interface InventoryUpdatedEvent {
  machineId: string;
  target: string;
  reportedAt: string;
}

/** Wire shape of `machine:status` (mirrors shared/realtime.ts). */
export interface MachineStatusEvent {
  machineId: string;
  online: boolean;
  lastSeenAt: string | null;
  daemonVersion?: string | null;
}

let socket: Socket | null = null;

const resubscribeGate = createResubscribeGate();

/**
 * Register a recovery action for /app RE-connects (the #66 silent-blip case:
 * weak network, lock screen). The callback runs on connect-after-disconnect;
 * unregister on unmount.
 */
export function onAppResubscribe(fn: () => void): () => void {
  return resubscribeGate.subscribe(fn);
}

export function appSocket(): Socket {
  if (socket === null) {
    socket = io('/app', {
      auth: (cb) => cb({ token: localStorage.getItem(TOKEN_KEY) ?? '' }),
    });
    socket.on('connect', () => resubscribeGate.onConnect());
  }
  return socket;
}

// ---- chat (Phase 8 C5) — mirrors shared/realtime.ts ----

/** One semantic chat event (`chat:event` → `{ sessionId, event }`). */
export type ChatStreamEvent =
  | { kind: 'message_delta'; delta: string }
  | { kind: 'thought_delta'; delta: string }
  | {
      kind: 'tool_call';
      call: ChatToolCallView;
    }
  | {
      kind: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      /** dsh dialect: context occupancy instead of per-turn token counts. */
      contextUsed?: number;
      contextSize?: number;
    }
  | {
      kind: 'permission_request';
      requestId: string;
      toolCall: ChatToolCallView;
      options: { optionId: string; name: string; kind: string }[];
    }
  | {
      kind: 'permission_resolved';
      requestId: string;
      outcome: 'selected' | 'cancelled' | 'timeout';
      optionId?: string;
    }
  | {
      /** 9 W14.1 — the agent asked a structured question (ACP elicitation). */
      kind: 'elicitation_request';
      requestId: string;
      message: string;
      fields: ElicitationField[];
      toolCallId?: string;
    }
  | {
      kind: 'elicitation_resolved';
      requestId: string;
      outcome: 'accepted' | 'declined' | 'cancelled' | 'timeout';
    }
  | { kind: 'turn_result'; stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' }
  | { kind: 'session_status'; state: 'active' | 'idle' }
  | {
      /** #10 — the server-owned send queue slot (depth 1). `flushed`
       * distinguishes a clear-because-it-runs from a clear-because-cancelled. */
      kind: 'queue_state';
      prompt: PromptBlock[] | null;
      flushed: boolean;
    }
  | {
      /** #11 — the prompt echo (SERVER-emitted on both send paths): every
       * viewer paints the user row from this, never local optimism. */
      kind: 'user_message';
      blocks: PromptBlock[];
    }
  | ({ kind: 'session_config' } & SessionConfigPatch)
  | ({ kind: 'plan' } & PlanPatch)
  | ({ kind: 'commands' } & CommandsPatch)
  | { kind: 'raw'; method: string; params: unknown }
  /** #71 — native sub-agent sessions (wrapped daemon-side by frame sessionId). */
  | { kind: 'subagent_spawned'; subagentId: string; name: string; task: string }
  | { kind: 'subagent_update'; subagentId: string; event: SubagentChildEvent }
  | {
      kind: 'subagent_done';
      subagentId: string;
      state: 'completed' | 'failed' | 'cancelled' | 'disconnected';
    };

/** #71 — the child-side event set a `subagent_update` may carry. */
export type SubagentChildEvent =
  | { kind: 'message_delta'; delta: string }
  | { kind: 'thought_delta'; delta: string }
  | { kind: 'tool_call'; call: ChatToolCallView }
  | { kind: 'raw'; method: string; params: unknown };

// ---- 9 W14 — ACP plan (todo) snapshots (mirrors shared/realtime.ts) ----

type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One todo/task row. Full-REPLACE semantics: every `plan` event carries the
 * complete list (ACP contract); `content` of an in_progress row is often the
 * agent's activeForm text — display verbatim.
 */
export interface PlanEntry {
  content: string;
  status: PlanEntryStatus;
  priority?: 'high' | 'medium' | 'low';
}

interface PlanPatch {
  entries: PlanEntry[];
}

// ---- 9 W15 — the agent's slash-command catalog (mirrors shared/realtime.ts) ----

/**
 * One advertised slash command (`available_commands_update`, full replace).
 * `name` is the VERBATIM adapter name (may carry `mcp:`); the UI adds the
 * `/`. Invocation is an ordinary prompt `/name args` — no dedicated RPC.
 */
export interface CommandView {
  name: string;
  description: string;
  hint?: string;
}

interface CommandsPatch {
  commands: CommandView[];
}

// ---- 9 W14.1 — ACP elicitation form fields (mirrors shared/realtime.ts) ----

/** One bounded rendering hint extracted daemon-side from `requestedSchema`. */
export interface ElicitationField {
  name: string;
  type: 'text' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi';
  title?: string;
  description?: string;
  placeholder?: string;
  options?: { value: string; label?: string; description?: string }[];
  required?: boolean;
}

// ---- 9 W9 A — ACP session modes & configuration (mirrors shared/realtime.ts) ----

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

interface SessionConfigValue {
  value: string;
  name: string;
  description?: string;
  /** dsh groups model options by provider — display grouping only. */
  group?: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue?: string;
  options?: SessionConfigValue[];
}

/**
 * PATCH semantics: `availableModes` / `configOptions` replace when present;
 * a lone `currentModeId` patches the current mode. The daemon emits full
 * merged snapshots; option VALUES are opaque adapter keys (dsh model values
 * are JSON `[provider, model]` — compare by equality, never parse).
 */
interface SessionConfigPatch {
  modes?: { currentModeId?: string; availableModes?: SessionMode[] };
  configOptions?: SessionConfigOption[];
}

/** 9 W9 A — the set payload (what the composer emits). */
export type ChatConfigSetPayload =
  { kind: 'mode'; modeId: string } | { kind: 'option'; configId: string; value: string };

/** 9 W9 A — browser → server: switch the session's mode / one option. */

/** 9 W6 — one ACP ToolCallContent item (diff / content / terminal). */
export interface AcpToolContentItem {
  type: 'content' | 'diff' | 'terminal';
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}

/** Shared shape of a tool-call view (rows + permission cards). */
export interface ChatToolCallView {
  toolCallId: string;
  title?: string;
  toolName?: string;
  kind?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string; line?: number; lineEnd?: number }[];
  rawInput?: Record<string, unknown>;
  content?: AcpToolContentItem[];
  output?: string;
}

export interface ChatEventEnvelope {
  sessionId: string;
  event: ChatStreamEvent;
}

export interface ChatSessionReadyPush {
  sessionId: string;
  agentName?: string;
  agentVersion?: string;
  /** 9 W7 — the agent's OWN session id behind this channel (rail highlight). */
  nativeSessionId?: string;
  /** 9 W9 B — prompt-content capabilities (gates the attach affordance). */
  promptCapabilities?: { image: boolean; audio?: boolean; embeddedContext?: boolean };
}
export interface ChatSessionFailedPush {
  sessionId: string;
  error: string;
}
export interface ChatSessionClosedPush {
  sessionId: string;
  reason: string;
}

// ---- 9 W11 B — live-channel snapshot (mirrors shared/realtime.ts) ----

/** One live channel in the per-user `chat:channels` snapshot push. */
export interface ChatChannelView {
  /** The CHANNEL (wire) id — `chat:session.open {sessionId}` rejoins it. */
  sessionId: string;
  agentInstanceId: string;
  machineId: string;
  /** Agent target (`claude-code` / `codex` / `deepseek` / …) — the tab badge. */
  target: string;
  phase: 'starting' | 'ready';
  /** A turn is generating on this channel right now. */
  busy: boolean;
  /** Viewers left mid-turn — the channel closes itself when the turn ends. */
  deferred: boolean;
  nativeSessionId?: string;
  /** Epoch ms — the eviction order (oldest first). */
  openedAt: number;
  /** 9 W11 D6 — epoch ms of the last turn's END (open time until then). */
  lastActiveAt: number;
}

export interface ChatChannelsPush {
  channels: ChatChannelView[];
}

// ---- #68 — assistant dispatch backflow (mirrors server assistant-dispatch.ts) ----

/** One dispatch record of an assistant session, as pushed to the owner. */
export interface AssistantDispatchView {
  channelId: string;
  agentInstanceId: string;
  status: 'starting' | 'running' | 'done' | 'failed' | 'closed';
  busy: boolean;
}

/** The per-session dispatch snapshot (on open/sync and every lifecycle change). */
export interface AssistantDispatchesPush {
  sessionId: string;
  dispatches: AssistantDispatchView[];
}

// ---- 9 W7 — native session history (mirrors shared/realtime.ts) ----

/** One prompt block the browser may send / one history user item carries. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; name: string; uri: string }
  | {
      type: 'image';
      data: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    };

/** One item of a channel's history batch: a user turn, or an ordinary event. */
export type HistoryItem =
  { type: 'user'; blocks: PromptBlock[] } | { type: 'event'; event: ChatStreamEvent };

export interface ChatHistoryEvent {
  sessionId: string;
  items: HistoryItem[];
}

/** Emit with an ack callback; resolves the ack object (rejects on timeout). */
export function emitWithAck<T>(event: string, payload: unknown, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for '${event}'`)), timeoutMs);
    appSocket().emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

// ---- #52 — the platform assistant's /app family (mirrors shared schemas) ----

export interface AssistantSessionView {
  id: string;
  ownerId: string;
  assistantId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

export type AssistantLiveSessionView = AssistantSessionView & { busy: boolean };

export interface AssistantSessionsPush {
  sessions: AssistantLiveSessionView[];
}

export interface AssistantReadyPush {
  sessionId: string;
  assistantId: string;
  assistantName: string;
}

export interface AssistantEventEnvelope {
  sessionId: string;
  event: ChatStreamEvent;
}

export interface AssistantHistoryEvent {
  sessionId: string;
  items: HistoryItem[];
}

export interface AssistantClosedPush {
  sessionId: string;
  reason: string;
}
