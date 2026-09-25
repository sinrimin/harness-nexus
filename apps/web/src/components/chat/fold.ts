import type {
  AcpToolContentItem,
  ChatStreamEvent,
  ChatToolCallView,
  CommandView,
  ElicitationField,
  HistoryItem,
  PlanEntry,
  PromptBlock,
  SessionConfigOption,
  SessionMode,
} from '@/realtime';

/**
 * 9 W9 — a user row's blocks: text, attached images, and file references.
 * Same shape as the wire's PromptBlock minus what only the agent consumes.
 */
export type UserBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      data: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    }
  | { type: 'resource_link'; name: string; uri: string };

/**
 * The conversation fold (Phase 9 W6) — adapted from the portal reference's
 * row-sequence model (wiki research-phase-9-portal-chat-ui.md §2): the stream
 * is a LIST OF ROWS, not a list of bubbles — user rows, assistant STEPS (one
 * segment of model output, split by tool calls), independent tool rows with a
 * lifecycle, system notes, and turn-tail stats. Pure reducer, O(1) hot path
 * (append to last block / upsert tool row by callId); only touched rows get
 * new object identities so memoized row components skip the rest.
 *
 * Permissions stay a SEPARATE slice (rendered from payload options — the C5
 * rule that option sets are never hardcoded holds).
 *
 * 9 W7 — `{type:'history'}` ingests a native-session batch (resume or
 * page-refresh resync) through the SAME event path: user items append user
 * rows without live-turn side effects, events fold sequentially.
 */

export interface ToolCallNode {
  callId: string;
  /** Registry key ('Read'/'Bash'/…) — `_meta.claudeCode.toolName` upstream. */
  toolName?: string;
  title?: string;
  kind?: string;
  status: 'running' | 'completed' | 'failed';
  rawInput?: Record<string, unknown>;
  content?: AcpToolContentItem[];
  output?: string;
  locations?: ChatToolCallView['locations'];
  startedAt: number;
  endedAt?: number;
}

interface ContentBlock {
  type: 'text' | 'reasoning';
  text: string;
}

interface AssistantStep {
  stepId: string;
  status: 'running' | 'settled' | 'interrupted';
  blocks: ContentBlock[];
  startedAt: number;
}

export interface TurnStats {
  stopReason: string;
  error?: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    contextUsed?: number;
    contextSize?: number;
  };
}

type ConversationRow =
  | { row: 'user'; key: string; blocks: UserBlock[] }
  | { row: 'assistant'; key: string; step: AssistantStep }
  | { row: 'tool'; key: string; root: ToolCallNode }
  | { row: 'system'; key: string; text: string; tone: 'info' | 'success' | 'error' }
  | { row: 'turn-tail'; key: string; stats: TurnStats };

export interface PermissionCardState {
  requestId: string;
  toolCall: ChatToolCallView;
  options: { optionId: string; name: string; kind: string }[];
  settled: boolean;
}

/** 9 W14.1 — an open agent question (ACP elicitation, form mode). */
export interface ElicitationCardState {
  requestId: string;
  message: string;
  fields: ElicitationField[];
  toolCallId?: string;
  settled: boolean;
}

export interface FoldState {
  rows: ConversationRow[];
  toolRowIndex: Map<string, number>;
  currentStepIdx: number;
  stepClosed: boolean;
  seq: number;
  turnStartedAt: number | null;
  /**
   * 9 W9 A — the session's mode/config state, patch-merged from
   * `session_config` events (the composer's selectors read it; nothing
   * else mutates it — there is NO browser-side optimism by design).
   */
  config: {
    currentModeId?: string;
    availableModes?: SessionMode[];
    configOptions?: SessionConfigOption[];
  };
  /**
   * 9 W14 — the agent's todo/task plan (ACP `plan` snapshots, FULL replace:
   * every event carries the complete list). `null` = never announced; `[]`
   * = announced then cleared. History replay converges through the same arm.
   */
  plan: PlanEntry[] | null;
  /**
   * 9 W15 — the agent's slash-command catalog (ACP
   * `available_commands_update`, full replace). Empty = none advertised
   * (dsh/hermes) — the `/` palette simply does not open.
   */
  commands: CommandView[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    contextUsed?: number;
    contextSize?: number;
  } | null;
  /**
   * #10 — the server-owned send queue (depth 1) as a fold slice: the parked
   * prompt renders as a chip floating above the composer, never a transcript
   * row. Pure slot projection — the flushed row comes from the user_message
   * echo (#11), not from folding the parked blocks here.
   */
  queued: PromptBlock[] | null;
  permissions: PermissionCardState[];
  elicitations: ElicitationCardState[];
  turnActive: boolean;
}

type FoldAction =
  | { type: 'reset' }
  | {
      type: 'event';
      event: ChatStreamEvent;
    }
  | { type: 'history'; items: HistoryItem[] };

export function createFoldState(): FoldState {
  return {
    rows: [],
    toolRowIndex: new Map(),
    currentStepIdx: -1,
    stepClosed: true,
    seq: 0,
    turnStartedAt: null,
    config: {},
    plan: null,
    commands: [],
    usage: null,
    permissions: [],
    elicitations: [],
    turnActive: false,
    queued: null,
  };
}

const nextKey = (state: FoldState, prefix: string): string => `r${state.seq++}-${prefix}`;

function appendBlock(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last !== undefined && last.type === block.type) {
    const next = blocks.slice();
    next[next.length - 1] = { ...last, text: last.text + block.text };
    return next;
  }
  return [...blocks, block];
}

function currentStep(state: FoldState): AssistantStep | null {
  if (state.currentStepIdx < 0 || state.stepClosed) return null;
  const row = state.rows[state.currentStepIdx];
  return row !== undefined && row.row === 'assistant' ? row.step : null;
}

/** Tool rows settle the current step — later text opens a NEW one (order feel). */
function settleCurrentStep(state: FoldState): FoldState {
  const idx = state.currentStepIdx;
  if (idx < 0) return state;
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'assistant' || row.step.status !== 'running') return state;
  const rows = state.rows.slice();
  rows[idx] = { ...row, step: { ...row.step, status: 'settled' } };
  return { ...state, rows };
}

function openStep(state: FoldState, block: ContentBlock): FoldState {
  const step: AssistantStep = {
    stepId: nextKey(state, 'step'),
    status: 'running',
    blocks: [block],
    startedAt: Date.now(),
  };
  const rows = [
    ...state.rows,
    { row: 'assistant', key: `a-${step.stepId}`, step } as ConversationRow,
  ];
  return { ...state, rows, currentStepIdx: rows.length - 1, stepClosed: false };
}

function patchStep(state: FoldState, block: ContentBlock): FoldState {
  const idx = state.currentStepIdx;
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'assistant') return openStep(state, block);
  const rows = state.rows.slice();
  rows[idx] = { ...row, step: { ...row.step, blocks: appendBlock(row.step.blocks, block) } };
  return { ...state, rows };
}

/** ACP statuses fold to the three render states. */
function toNodeStatus(status: ChatToolCallView['status']): ToolCallNode['status'] {
  if (status === 'completed' || status === 'failed') return status;
  return 'running';
}

function nodeFromCall(call: ChatToolCallView): ToolCallNode {
  return {
    callId: call.toolCallId,
    ...(call.toolName !== undefined ? { toolName: call.toolName } : {}),
    ...(call.title !== undefined ? { title: call.title } : {}),
    ...(call.kind !== undefined ? { kind: call.kind } : {}),
    ...(call.locations !== undefined ? { locations: call.locations } : {}),
    ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
    ...(call.content !== undefined ? { content: call.content } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
    status: toNodeStatus(call.status),
    startedAt: Date.now(),
  };
}

function patchToolRow(state: FoldState, call: ChatToolCallView): FoldState {
  const idx = state.toolRowIndex.get(call.toolCallId);
  if (idx === undefined) {
    const node = nodeFromCall(call);
    const rows = [
      ...state.rows,
      { row: 'tool', key: `t-${node.callId}`, root: node } as ConversationRow,
    ];
    const toolRowIndex = new Map(state.toolRowIndex);
    toolRowIndex.set(node.callId, rows.length - 1);
    return settleCurrentStep({ ...state, rows, toolRowIndex, stepClosed: true });
  }
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'tool') return state;
  const nextStatus = toNodeStatus(call.status);
  const root: ToolCallNode = {
    ...row.root,
    ...('title' in call && call.title !== undefined ? { title: call.title } : {}),
    ...(call.toolName !== undefined ? { toolName: call.toolName } : {}),
    ...(call.kind !== undefined ? { kind: call.kind } : {}),
    ...(call.status !== undefined ? { status: nextStatus } : {}),
    ...(call.locations !== undefined ? { locations: call.locations } : {}),
    ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
    ...(call.content !== undefined && call.content.length > 0 ? { content: call.content } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(nextStatus !== 'running' && row.root.endedAt === undefined ? { endedAt: Date.now() } : {}),
  };
  const rows = state.rows.slice();
  rows[idx] = { ...row, root };
  return { ...state, rows };
}

/** Sweep every running step/tool — the idempotent turn tail guard. */
function sweepRows(state: FoldState, interrupted: boolean): ConversationRow[] {
  return state.rows.map((row, idx) => {
    if (row.row === 'assistant' && row.step.status === 'running') {
      return {
        ...row,
        step: {
          ...row.step,
          status:
            interrupted && idx === state.currentStepIdx
              ? ('interrupted' as const)
              : ('settled' as const),
        },
      };
    }
    if (row.row === 'tool' && row.root.status === 'running') {
      return { ...row, root: { ...row.root, status: 'completed' as const } };
    }
    return row;
  });
}

/**
 * A user message starts a turn: sweep leftovers, append the user row, open a
 * running step (renders the "thinking…" placeholder until the first chunk).
 */
function startUserTurn(state: FoldState, blocks: UserBlock[]): FoldState {
  const swept = sweepRows(state, false);
  const step: AssistantStep = {
    stepId: nextKey(state, 'step'),
    status: 'running',
    blocks: [],
    startedAt: Date.now(),
  };
  const rows: ConversationRow[] = [
    ...swept,
    { row: 'user', key: nextKey(state, 'u'), blocks },
    { row: 'assistant', key: `a-${step.stepId}`, step },
  ];
  return {
    ...state,
    rows,
    currentStepIdx: rows.length - 1,
    stepClosed: false,
    turnStartedAt: Date.now(),
    turnActive: true,
  };
}

function applyEvent(state: FoldState, event: ChatStreamEvent): FoldState {
  switch (event.kind) {
    case 'message_delta':
    case 'thought_delta': {
      const block: ContentBlock =
        event.kind === 'message_delta'
          ? { type: 'text', text: event.delta }
          : { type: 'reasoning', text: event.delta };
      if (currentStep(state) !== null) return patchStep(state, block);
      return openStep(state, block);
    }
    case 'tool_call':
      return patchToolRow(state, event.call);
    case 'usage':
      return {
        ...state,
        usage: {
          ...(state.usage ?? {}),
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.contextUsed !== undefined ? { contextUsed: event.contextUsed } : {}),
          ...(event.contextSize !== undefined ? { contextSize: event.contextSize } : {}),
        },
      };
    case 'permission_request':
      return {
        ...state,
        permissions: [
          ...state.permissions.filter((p) => p.requestId !== event.requestId),
          {
            requestId: event.requestId,
            toolCall: event.toolCall,
            options: event.options,
            settled: false,
          },
        ],
      };
    case 'permission_resolved':
      return {
        ...state,
        permissions: state.permissions.map((p) =>
          p.requestId === event.requestId ? { ...p, settled: true } : p,
        ),
      };
    case 'elicitation_request':
      return {
        ...state,
        elicitations: [
          ...state.elicitations.filter((e) => e.requestId !== event.requestId),
          {
            requestId: event.requestId,
            message: event.message,
            fields: event.fields,
            ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
            settled: false,
          },
        ],
      };
    case 'elicitation_resolved':
      return {
        ...state,
        elicitations: state.elicitations.map((e) =>
          e.requestId === event.requestId ? { ...e, settled: true } : e,
        ),
      };
    case 'turn_result': {
      const interrupted = event.stopReason === 'cancelled';
      const next: FoldState = state;
      const rows = sweepRows(next, interrupted);
      const lastRow = rows[rows.length - 1];
      const noRunning = rows.every((r) =>
        r.row === 'assistant'
          ? r.step.status !== 'running'
          : r.row !== 'tool' || r.root.status !== 'running',
      );
      if (noRunning && lastRow !== undefined && lastRow.row === 'turn-tail') {
        return { ...next, rows };
      }
      const durationMs = next.turnStartedAt !== null ? Date.now() - next.turnStartedAt : undefined;
      const tail: ConversationRow = {
        row: 'turn-tail',
        key: nextKey(next, 'tail'),
        stats: {
          stopReason: event.stopReason,
          ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
          ...(next.usage !== undefined && next.usage !== null ? { usage: next.usage } : {}),
        },
      };
      return {
        ...next,
        rows: [...rows, tail],
        currentStepIdx: -1,
        stepClosed: true,
        turnActive: false,
        turnStartedAt: null,
      };
    }
    case 'session_status':
      return { ...state, turnActive: event.state === 'active' };
    case 'user_message':
      // #11 — the server's prompt echo: EVERY viewer (sender included)
      // paints the user row and opens the running step from this event; the
      // old optimistic dispatch is gone (single source of truth).
      return startUserTurn(state, promptBlocksToUserBlocks(event.blocks));
    case 'queue_state':
      // #10 — the slot projection only: park, clear-on-cancel, clear-on-
      // flush. The flushed row itself comes from the user_message echo the
      // server emits right after the flush clear.
      return { ...state, queued: event.prompt };
    case 'session_config':
      return {
        ...state,
        config: {
          ...state.config,
          ...(event.modes?.currentModeId !== undefined
            ? { currentModeId: event.modes.currentModeId }
            : {}),
          ...(event.modes?.availableModes !== undefined
            ? { availableModes: event.modes.availableModes }
            : {}),
          ...(event.configOptions !== undefined ? { configOptions: event.configOptions } : {}),
        },
      };
    case 'plan':
      // 9 W14 — full-replace snapshot; empty = cleared (the panel hides).
      return { ...state, plan: event.entries };
    case 'commands':
      // 9 W15 — full-replace catalog; empty = none (the palette hides).
      return { ...state, commands: event.commands };
    case 'raw':
      if (event.method === 'hnx/prompt-error') {
        const message = (event.params as { message?: string } | undefined)?.message;
        if (message !== undefined && message !== '') {
          return {
            ...state,
            rows: [
              ...state.rows,
              { row: 'system', key: nextKey(state, 'err'), text: message, tone: 'error' },
            ],
          };
        }
      }
      return state;
    default:
      return state;
  }
}

export function fold(state: FoldState, action: FoldAction): FoldState {
  switch (action.type) {
    case 'reset':
      return createFoldState();

    case 'event':
      return applyEvent(state, action.event);

    case 'history': {
      // 9 W7 — (re)build from a transcript batch. Idempotent by construction:
      // a resync re-ingest starts from a FRESH state, so every viewer ends up
      // with the same rows regardless of what they saw before.
      let next = createFoldState();
      for (const item of action.items) {
        if (item.type === 'user') {
          // A user item is a turn BOUNDARY (#8): close whatever step is open
          // so the next deltas open a NEW step BELOW this row. Replay batches
          // (load capture, resync ring) carry no per-turn turn_result — the
          // only other closer — so without this, turn N's text patched turn
          // N-1's still-open step and rendered ABOVE this question. The
          // boundary applies even when the item renders no blocks: the turn
          // break is real regardless.
          next = { ...next, currentStepIdx: -1, stepClosed: true };
          const blocks = promptBlocksToUserBlocks(item.blocks);
          if (blocks.length === 0) continue;
          next = {
            ...next,
            rows: [...next.rows, { row: 'user', key: nextKey(next, 'u'), blocks }],
            turnStartedAt: Date.now(),
          };
        } else {
          next = applyEvent(next, item.event);
        }
      }
      // A batch that never ended with a turn marker (adapter replay quirk):
      // sweep so no row stays "running".
      if (next.turnActive || next.rows.some(isRunningRow)) {
        next = applyEvent(next, { kind: 'turn_result', stopReason: 'end_turn' });
      }
      return next;
    }

    default:
      return state;
  }
}

/** Wire prompt blocks → user-row blocks (drops nothing the UI renders). */
function promptBlocksToUserBlocks(blocks: readonly PromptBlock[]): UserBlock[] {
  const out: UserBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text !== '') out.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      out.push({ type: 'image', data: b.data, mimeType: b.mimeType });
    } else {
      out.push({ type: 'resource_link', name: b.name, uri: b.uri });
    }
  }
  return out;
}

function isRunningRow(r: ConversationRow): boolean {
  if (r.row === 'assistant') return r.step.status === 'running';
  if (r.row === 'tool') return r.root.status === 'running';
  return false;
}
