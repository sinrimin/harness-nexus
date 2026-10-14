import { Agent, type AgentMessage, type AgentToolResult } from '@earendil-works/pi-agent-core';
import type { LlmProvider } from '@harness-nexus/core';
import type { AssistantConfig, AssistantMessageRow, AssistantSession } from '@harness-nexus/core';
import type { ChatStreamEvent, PromptBlock, ProviderModelConfig } from '@harness-nexus/shared';
import { decryptSecret, generateId } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import { buildGatewayModel, type GatewayModel } from './provider.js';
import { rowsToPiMessages, piStopToWire } from './history.js';
import { buildAssistantTools, TOOL_NAMES_BY_GROUP, type AssistantToolDeps } from './tools.js';
import { DEFAULT_ASSISTANT_SYSTEM_PROMPT } from './prompt.js';

/**
 * The assistant turn runner (#52 §2/§4). One call = one user prompt = one
 * Agent built FROM THE DB (config, provider, credential, transcript): the
 * platform owns the session persistence, so a server restart loses nothing —
 * the next turn rebuilds from the rows.
 *
 * Identity is the explicit principal (Plan B): the owner's role is re-read
 * from the DB at turn start, the tools close over that principal, and the
 * #53 services enforce every scope decision. No tokens, no self-HTTP.
 */

export interface AssistantRunnerDeps extends AssistantToolDeps {
  credentialEncryptionKey: string;
  /**
   * Test seam: replace the gateway-model build with a scripted faux
   * provider. Production leaves it unset — the real path resolves the
   * credential and dials nothing until the model streams.
   */
  buildModel?: (input: {
    provider: LlmProvider;
    modelId: string;
    ownerId: string;
  }) => Promise<{ model: GatewayModel['model']; streamFn: GatewayModel['streamFn'] }>;
}

/** Where live events go (the realtime service wires this to the room). */
export type AssistantEmit = (event: ChatStreamEvent) => void;

export interface RunningTurn {
  abort(): void;
  /** Resolves when the turn settled and its rows are persisted. */
  done: Promise<void>;
}

/** Resolve the provider row + registry entry the (possibly rebound) config points at. */
export async function resolveTurnModel(
  deps: AssistantRunnerDeps,
  ownerId: string,
  provider: LlmProvider,
  modelId: string,
) {
  const entry = provider.models.find((m) => m.id === modelId && m.type === 'chat');
  if (entry === undefined) {
    throw new TurnSetupError(
      `Model "${modelId}" is no longer configured on provider "${provider.name}"`,
    );
  }
  const credential = await findCredentialForOwner(deps.uow, provider.credentialName, ownerId);
  if (credential === null) {
    throw new TurnSetupError(
      `Credential "${provider.credentialName}" (provider "${provider.name}") not found`,
    );
  }
  const secret = decryptSecret(credential.secret, deps.credentialEncryptionKey);
  return buildGatewayModel({
    kind: provider.api,
    baseUrl: provider.baseUrl,
    providerLabel: provider.name,
    secret,
    entry: entry as ProviderModelConfig,
  });
}

/** A failure before any model call (provider/credential/model drift). */
export class TurnSetupError extends Error {}

const AUDIT_ARGS_MAX = 2000;
const TOOL_OUTPUT_EVENT_MAX = 4000;

function auditArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args) ?? 'null';
    return json.length > AUDIT_ARGS_MAX ? `${json.slice(0, AUDIT_ARGS_MAX)}…` : json;
  } catch {
    return '(unserializable args)';
  }
}

function resultText(result: AgentToolResult): string {
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return text.length > TOOL_OUTPUT_EVENT_MAX ? `${text.slice(0, TOOL_OUTPUT_EVENT_MAX)}…` : text;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Run one turn. The user row must ALREADY be persisted (the caller appends
 * it before starting, so a crash mid-turn keeps the prompt); this appends
 * the assistant/toolResult rows and updates the session stamp on completion.
 */
export function startAssistantTurn(
  deps: AssistantRunnerDeps,
  input: {
    session: AssistantSession;
    config: AssistantConfig;
    modelId: string;
    /** This turn's prompt blocks (the user row is already persisted). */
    prompt: readonly PromptBlock[];
    /** The transcript BEFORE this turn (rebuild context — prompt rides separately). */
    rows: readonly AssistantMessageRow[];
    emit: AssistantEmit;
    /** Persist helper (seq-allocated by the caller's uow access). */
    append: (row: AssistantMessageRow) => Promise<void>;
    /** Called with the final session stamp fields when the turn settles. */
    settle: (summary: { lastMessageAt: string; title?: string }) => Promise<void>;
  },
): RunningTurn {
  const { session, config, emit } = input;
  // Armed by the async body once the Agent exists; a cancel during setup is a
  // no-op (nothing is streaming yet).
  const abortRef: { abort: () => void } = { abort: () => undefined };

  const done = (async (): Promise<void> => {
    // Fresh principal — disable/demote lands on the NEXT turn, by design.
    const owner = await deps.uow.users.findById(session.ownerId);
    if (owner === null || owner.status !== 'active') {
      throw new TurnSetupError('The session owner is no longer active');
    }
    const principal = { userId: owner.id, role: owner.role };

    const provider = await deps.uow.llmProviders.findById(config.providerId);
    if (provider === null) {
      throw new TurnSetupError('The configured LLM provider no longer exists');
    }
    const gateway =
      deps.buildModel !== undefined
        ? await deps.buildModel({ provider, modelId: input.modelId, ownerId: session.ownerId })
        : await resolveTurnModel(deps, session.ownerId, provider, input.modelId);

    const tools = buildAssistantTools(deps, principal, config.enabledToolGroups);

    const agent = new Agent({
      initialState: {
        systemPrompt: config.systemPromptOverride ?? DEFAULT_ASSISTANT_SYSTEM_PROMPT,
        model: gateway.model,
        tools,
        messages: rowsToPiMessages(input.rows, gateway.model.api, gateway.model.id),
      },
      streamFn: gateway.streamFn,
      beforeToolCall: async ({ toolCall }) => {
        // Belt-and-braces group gate — the toolset is already built from the
        // enabled groups, this catches rebind races and rogue names.
        const group = Object.entries(TOOL_NAMES_BY_GROUP).find(([, names]) =>
          names.includes(toolCall.name),
        )?.[0];
        if (group === undefined || !config.enabledToolGroups.includes(group as never)) {
          return {
            block: true,
            reason: `tool "${toolCall.name}" is not enabled on this assistant`,
          };
        }
        return undefined;
      },
    });
    abortRef.abort = () => agent.abort();

    let lastUsage: { inputTokens?: number; outputTokens?: number } | undefined;
    agent.subscribe((event) => {
      switch (event.type) {
        case 'agent_start':
          emit({ kind: 'session_status', state: 'active' });
          return;
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          if (inner.type === 'text_delta') emit({ kind: 'message_delta', delta: inner.delta });
          else if (inner.type === 'thinking_delta')
            emit({ kind: 'thought_delta', delta: inner.delta });
          return;
        }
        case 'tool_execution_start':
          emit({
            kind: 'tool_call',
            call: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: 'in_progress',
              ...(isRecord(event.args) ? { rawInput: event.args } : {}),
            },
          });
          return;
        case 'tool_execution_end': {
          emit({
            kind: 'tool_call',
            call: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: event.isError ? 'failed' : 'completed',
              output: resultText(event.result),
            },
          });
          // One audit row per execution (status + duration live here).
          void deps.uow.assistants.appendToolCallAudit({
            id: generateId(),
            sessionId: session.id,
            userId: session.ownerId,
            tool: event.toolName,
            args: auditArgs((event as { args?: unknown }).args),
            status: event.isError ? 'error' : 'ok',
            durationMs: event.durationMs ?? 0,
            createdAt: new Date().toISOString(),
          });
          return;
        }
        case 'turn_end': {
          // turn_end always carries an assistant message on the wire; the
          // union type says AgentMessage, so narrow.
          if (event.message.role !== 'assistant') return;
          const usage = event.message.usage;
          if (usage !== undefined && (usage.input > 0 || usage.output > 0)) {
            lastUsage = { inputTokens: usage.input, outputTokens: usage.output };
            emit({ kind: 'usage', inputTokens: usage.input, outputTokens: usage.output });
          }
          if (event.message.stopReason === 'error' && event.message.errorMessage !== undefined) {
            emit({
              kind: 'raw',
              method: 'hnx/prompt-error',
              params: { message: event.message.errorMessage },
            });
          }
          return;
        }
        case 'agent_end':
          return;
        default:
          return;
      }
    });

    await agent.prompt({
      role: 'user',
      content: input.prompt.map((b) =>
        b.type === 'text'
          ? { type: 'text' as const, text: b.text }
          : b.type === 'image'
            ? { type: 'image' as const, data: b.data, mimeType: b.mimeType }
            : { type: 'text' as const, text: `[file reference] ${b.name}: ${b.uri}` },
      ),
      timestamp: Date.now(),
    });
    await agent.waitForIdle();

    // ---- persist the turn's rows (everything after the last user message) ----
    const messages = agent.state.messages;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    const turnMessages = messages.slice(lastUserIdx + 1) as AgentMessage[];
    let seq = input.rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1;

    let i = 0;
    type TurnAssistant = Extract<AgentMessage, { role: 'assistant' }>;
    type TurnToolResult = Extract<AgentMessage, { role: 'toolResult' }>;
    while (i < turnMessages.length) {
      const m = turnMessages[i]!;
      if (m.role === 'assistant') {
        const text = m.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('');
        const thought = m.content
          .filter((c) => c.type === 'thinking')
          .map((c) => c.thinking)
          .join('');
        const toolCalls = m.content
          .filter((c) => c.type === 'toolCall')
          .map((c) => ({ id: c.id, tool: c.name, args: c.arguments as unknown }));
        await input.append({
          seq: seq++,
          type: 'assistant',
          text,
          thought,
          toolCalls,
          stopReason:
            m.stopReason === 'length'
              ? 'max_tokens'
              : m.stopReason === 'aborted'
                ? 'aborted'
                : m.stopReason === 'error'
                  ? 'error'
                  : 'end_turn',
          ...(m.usage !== undefined && (m.usage.input > 0 || m.usage.output > 0)
            ? { usage: { inputTokens: m.usage.input, outputTokens: m.usage.output } }
            : {}),
          ...(m.errorMessage !== undefined ? { error: m.errorMessage } : {}),
        });
      } else if (m.role === 'toolResult') {
        // Batch every consecutive toolResult into one row.
        const results = [];
        let j = i;
        while (j < turnMessages.length && turnMessages[j]!.role === 'toolResult') {
          const tr = turnMessages[j]! as TurnToolResult;
          results.push({
            toolCallId: tr.toolCallId,
            tool: tr.toolName,
            output: tr.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
            isError: tr.isError,
            ...(tr.durationMs !== undefined ? { durationMs: tr.durationMs } : {}),
          });
          j += 1;
        }
        await input.append({ seq: seq++, type: 'toolResult', results });
        i = j;
        continue;
      }
      i += 1;
    }

    emit({
      kind: 'turn_result',
      stopReason: piStopToWire(
        // The turn's LAST assistant message decides the wire stop; empty
        // (aborted before any output) reads as cancelled.
        [...turnMessages].reverse().find((m): m is TurnAssistant => m.role === 'assistant')
          ?.stopReason ?? (turnMessages.length === 0 ? 'aborted' : 'stop'),
      ),
      ...(lastUsage !== undefined
        ? {
            usage: {
              ...lastUsage,
              totalTokens: (lastUsage.inputTokens ?? 0) + (lastUsage.outputTokens ?? 0),
            },
          }
        : {}),
    });
    emit({ kind: 'session_status', state: 'idle' });

    // Optimistic title from the first prompt (same stance as the machine
    // rail's #14); a manual rename (session.title) always wins. This turn IS
    // the first when the rebuilt transcript holds no earlier user row.
    const hadEarlierTurn = input.rows.some((r) => r.type === 'user');
    const title =
      session.title === '' && !hadEarlierTurn
        ? input.prompt
            .filter((b): b is Extract<PromptBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .slice(0, 80)
        : undefined;
    await input.settle({
      lastMessageAt: new Date().toISOString(),
      ...(title !== undefined && title !== '' ? { title } : {}),
    });
  })();

  return {
    abort: () => abortRef.abort(),
    done,
  };
}
