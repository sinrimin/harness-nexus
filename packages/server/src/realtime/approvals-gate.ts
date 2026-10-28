// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { UnitOfWork } from '@harness-nexus/core';
import {
  providerEndpointUrl,
  type ChatApprovalsView,
  type DelegationDenialReason,
} from '@harness-nexus/shared';
import { decryptSecret } from '../infra/crypto.js';
import {
  callSystemOne,
  systemOneErrorMessage,
  type SystemOneError,
  type SystemOneFetch,
} from '../infra/systemone.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';

/**
 * #92 — the delegated-approvals decision core, shared by the machine chat
 * axis and the platform assistant (#95 follow-up: the assistant's
 * `permissionMode:'delegated'` rides the SAME gate). The service on each axis
 * owns its own settlement/transport; everything that decides WHICH option a
 * decision model would pick — the never-allow floor, the one-shot-only
 * eligibility, the confidence threshold, the SystemOne call — lives here so
 * the two axes cannot drift.
 */

export interface ApprovalGateDeps {
  uow: UnitOfWork;
  credentialEncryptionKey: string;
  /** The decision-model call budget. */
  timeoutMs: number;
  log?: { warn: (msg: string) => void };
  /** Injectable for tests. */
  fetchImpl?: SystemOneFetch;
}

/** #92 — how many of the owner's own prompts the decision model may see. */
export const GATE_PROMPT_WINDOW = 3;
export const GATE_PROMPT_CHAR_CAP = 2_000;
/** The tool arguments view carries the same per-field budget as a prompt. */
export const GATE_TOOL_INPUT_CHAR_CAP = 2_000;
/** The tool's own description is platform-authored and short. */
export const GATE_TOOL_DESC_CHAR_CAP = 1_000;

/**
 * Compact text for the tool's ARGUMENTS — the thing the `covered` question
 * asks the model to judge ("tool and arguments"), which a bare tool name
 * cannot answer (the ds-web report: a web-search call with the query hidden
 * scored 0.16 because the model rightly could not verify coverage).
 * Callers hand over the raw args/rawInput object; bounding happens in the
 * gate so no call site can forget it.
 */
export function toolInputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    const s = JSON.stringify(raw);
    return s === undefined ? String(raw) : s;
  } catch {
    return String(raw);
  }
}

export interface ApprovalGatePolicy {
  /** Machine-scoped never-allow substrings (the L3 floor). */
  neverAllow?: readonly string[];
  confidenceThreshold?: number;
  /** Park a correction note on a floor denial (targets without a reason channel). */
  denyNote?: boolean;
  /** Machine override pair; absent = the owner's `defaultModels.decision`. */
  decision?: { providerId: string; modelId: string };
}

export interface ApprovalGateInput {
  ownerId: string;
  /** The agent target; decides whether a deny can carry a reason back. */
  target: string;
  /** The owner's own recent prompts (context hygiene: bounded, text only). */
  recentPrompts: readonly string[];
  /** Machine policy; absent for the platform assistant (user default only). */
  policy?: ApprovalGatePolicy;
  /** The resolved decision model's display provenance. */
  view: ChatApprovalsView;
  toolCall: {
    title?: string | undefined;
    kind?: string | undefined;
    /** Compact arguments text (`toolInputText`); bounded inside the gate. */
    input?: string | undefined;
    /** The tool's own description (assistant axis; bounded inside the gate). */
    description?: string | undefined;
  };
  options: readonly { optionId: string; kind: string; name: string }[];
}

export type ApprovalGateOutcome =
  | {
      kind: 'decide';
      optionId: string;
      decidedBy: 'floor' | 'model';
      confidence?: number;
      denial?: { reason: DelegationDenialReason };
      /** For targets where the agent's model can read the denial. */
      denyMessage?: string;
      /** Fallback correction note for targets without a reason channel. */
      queueNote?: string;
    }
  | {
      kind: 'advisory';
      lean: 'allow' | 'reject';
      confidence: number;
      reason?: DelegationDenialReason;
    }
  | { kind: 'escalate' };

/**
 * #92 — targets whose ACP reject can carry a REASON to the model (the patched
 * claude adapter wires `_meta.denyMessage` into the CC SDK's deny feedback).
 * Everywhere else the model's deny verdict escalates instead of hard-denying,
 * and a FLOOR denial falls back to the next-prompt correction note.
 */
const REASON_CHANNEL_TARGETS = new Set(['claude-code']);

function hasReasonChannel(target: string): boolean {
  return REASON_CHANNEL_TARGETS.has(target);
}

function pickRejectOption(
  options: readonly { optionId: string; kind: string }[],
): { optionId: string; kind: string } | undefined {
  return (
    options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  );
}

function normalizeWhy(choice: string | undefined): DelegationDenialReason {
  switch (choice) {
    case 'not_covered':
    case 'destructive':
    case 'sensitive':
    case 'risky':
    case 'other':
      return choice;
    default:
      return 'other';
  }
}

/**
 * Platform-authored deny feedback — the model receives it IN THE SAME TURN
 * (claude-code, via `_meta.denyMessage` + the dist patch). Deliberately
 * states the delegation: the unpatched adapter would otherwise tell the
 * model "User refused", which stalls the session on a question to an absent
 * owner.
 */
export function denyMessage(view: ChatApprovalsView, reason: DelegationDenialReason): string {
  const by =
    view.providerName !== undefined && view.modelId !== undefined
      ? ` (${view.providerName}/${view.modelId})`
      : '';
  return `[delegated approvals] rejected by the decision model${by}: ${reason}. This was NOT a manual user denial — adjust the approach, or ask the user.`.slice(
    0,
    512,
  );
}

/** The fallback correction note (next-prompt lane, targets without a channel). */
export function correctionNote(title: string, reason: DelegationDenialReason): string {
  return `[delegated approvals] The tool call "${title.slice(0, 120)}" was rejected: ${reason} (never-allow floor). This was NOT a manual user denial — adjust the approach, or wait for the user.`.slice(
    0,
    512,
  );
}

/**
 * #92 — the delegated gate. Ordering is normative: L3 floor (deterministic,
 * BEFORE the model) → eligible `*_once` options → the decision call →
 * answer or escalate. Every thrown/rejected path = escalation (the card
 * stays with the human); the gate NEVER fail-opens. The caller arbitrates
 * races (the human may have answered while the model ran) before applying
 * the outcome.
 */
export async function decideApproval(
  deps: ApprovalGateDeps,
  input: ApprovalGateInput,
): Promise<ApprovalGateOutcome> {
  const policy = input.policy;

  // 1 — the floor. Safety outranks stalling: it hard-denies on EVERY
  // target; the reason reaches the model where a channel exists, and via
  // the correction note where it does not. The pattern matches the title
  // AND the arguments text — a `rm -rf`-shaped floor that only ever saw
  // tool names could not fire on the one place the pattern lives.
  const title = input.toolCall.title ?? '';
  const inputText =
    input.toolCall.input === undefined
      ? undefined
      : input.toolCall.input.slice(0, GATE_TOOL_INPUT_CHAR_CAP);
  const descText =
    input.toolCall.description === undefined || input.toolCall.description === ''
      ? undefined
      : input.toolCall.description.slice(0, GATE_TOOL_DESC_CHAR_CAP);
  const haystack = inputText === undefined ? title : `${title}\n${inputText}`;
  const hit = (policy?.neverAllow ?? []).find(
    (p) => p !== '' && haystack.toLowerCase().includes(p.toLowerCase()),
  );
  if (hit !== undefined) {
    const reject = pickRejectOption(input.options);
    if (reject === undefined) return { kind: 'escalate' }; // no reject option offered ⇒ human
    return {
      kind: 'decide',
      optionId: reject.optionId,
      decidedBy: 'floor',
      denial: { reason: 'policy' },
      ...(hasReasonChannel(input.target) ? { denyMessage: denyMessage(input.view, 'policy') } : {}),
      ...((policy?.denyNote ?? true) && !hasReasonChannel(input.target)
        ? { queueNote: correctionNote(title, 'policy') }
        : {}),
    };
  }

  // 2 — eligible options: one-shot only. A delegation never grants
  // persistence, so allow_always/reject_always are never chosen. Without
  // an allow_once there is no answer we may safely give (only persistent
  // allows or a deny we cannot justify) ⇒ the human decides.
  const allowOnce = input.options.find((o) => o.kind === 'allow_once');
  if (allowOnce === undefined) return { kind: 'escalate' };
  const rejectOnce = input.options.find((o) => o.kind === 'reject_once');
  const eligible = rejectOnce === undefined ? [allowOnce] : [allowOnce, rejectOnce];

  // 3 — resolve the decision model (machine override, else the user's
  // default slot) + its provider + credential. Any miss ⇒ human.
  const ref =
    policy?.decision ??
    (await deps.uow.users.findById(input.ownerId).catch(() => null))?.defaultModels?.decision;
  if (ref === undefined) return { kind: 'escalate' };
  const provider = await deps.uow.llmProviders.findById(ref.providerId).catch(() => null);
  if (provider === null) return { kind: 'escalate' };
  const systemoneApi = provider.apis.find((a) => a.kind === 'systemone');
  if (systemoneApi === undefined) return { kind: 'escalate' };
  if (!provider.models.some((m) => m.id === ref.modelId && m.apiKind === 'systemone')) {
    return { kind: 'escalate' };
  }
  const endpoint = providerEndpointUrl('systemone', {
    baseUrl: provider.baseUrl,
    path: systemoneApi.path,
  });
  if (endpoint === null) return { kind: 'escalate' };
  const credential = await findCredentialForOwner(
    deps.uow,
    provider.credentialName,
    input.ownerId,
  ).catch(() => null);
  if (credential === null) return { kind: 'escalate' };
  const secret = decryptSecret(credential.secret, deps.credentialEncryptionKey);

  // 4 — the call. State = the user's own recent prompts + the bounded tool
  // view (title, kind, the bounded ARGUMENTS text, and where the axis has
  // it the tool's own description — the `covered` question judges "tool and
  // arguments", so the arguments travel along; outputs and file bodies
  // still never do) + the eligible options (context hygiene: the supervised
  // agent cannot talk its way past).
  const state = {
    userPrompts: [...input.recentPrompts],
    toolCall: {
      title,
      kind: input.toolCall.kind ?? '',
      ...(inputText !== undefined ? { input: inputText } : {}),
      ...(descText !== undefined ? { description: descText } : {}),
    },
    options: eligible.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
  };
  const questions = {
    pick: {
      type: 'choice' as const,
      instructions:
        'Which option should answer this permission request? Choose the reject option when the call is unsafe or outside what the user asked for.',
      criteria: Object.fromEntries(eligible.map((o) => [o.optionId, o.name])),
    },
    covered: {
      type: 'noul' as const,
      instructions:
        "Did the user's own requests plausibly call for this exact tool action (tool and arguments)?",
    },
    why: {
      type: 'choice' as const,
      instructions:
        'If this call should NOT proceed, pick the closest reason; pick "fine" when it should proceed.',
      criteria: {
        fine: 'the call is fine',
        not_covered: 'the user did not ask for this',
        destructive: 'irreversible or destructive',
        sensitive: 'touches credentials or secrets',
        risky: 'dangerous command shape',
        other: 'some other problem',
      },
    },
  };
  let answers;
  try {
    const result = await callSystemOne(
      {
        url: endpoint,
        apiKey: secret,
        model: ref.modelId,
        state,
        questions,
      },
      {
        timeoutMs: deps.timeoutMs,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      },
    );
    answers = result.answers;
  } catch (e) {
    const msg =
      e !== null && typeof e === 'object' && 'kind' in e
        ? systemOneErrorMessage(e as SystemOneError)
        : String(e);
    deps.log?.warn(`approvals gate (#92) provider call failed: ${msg}`);
    return { kind: 'escalate' }; // uncertain ⇒ human
  }

  const pick = answers.pick;
  const covered = answers.covered?.noul;
  const why = normalizeWhy(answers.why?.choice);
  const threshold = policy?.confidenceThreshold ?? 0.9;

  // 5 — the verdict. Allow needs BOTH confidences; a model DENY only
  // hard-denies where the reason can reach the model (claude-code) —
  // everywhere else it escalates (an inexplicable deny just stalls).
  const allowId = allowOnce.optionId;
  if (
    pick?.choice !== undefined &&
    pick.choice === allowId &&
    pick.confidence !== undefined &&
    pick.confidence >= threshold &&
    covered !== undefined &&
    covered >= threshold
  ) {
    return {
      kind: 'decide',
      optionId: pick.choice,
      decidedBy: 'model',
      confidence: pick.confidence,
    };
  }
  if (
    pick?.choice !== undefined &&
    pick.choice !== allowId &&
    pick.confidence !== undefined &&
    pick.confidence >= threshold &&
    hasReasonChannel(input.target)
  ) {
    const reject = input.options.find((o) => o.optionId === pick.choice);
    if (reject !== undefined && reject.kind === 'reject_once') {
      return {
        kind: 'decide',
        optionId: pick.choice,
        decidedBy: 'model',
        confidence: pick.confidence,
        denial: { reason: why },
        denyMessage: denyMessage(input.view, why),
      };
    }
  }

  // 6 — escalate with the model's lean as an advisory (never a decision).
  if (pick?.choice !== undefined && pick.confidence !== undefined) {
    const lean = pick.choice === allowId ? 'allow' : 'reject';
    return {
      kind: 'advisory',
      lean,
      confidence: pick.confidence,
      ...(why !== undefined && lean === 'reject' ? { reason: why } : {}),
    };
  }
  return { kind: 'escalate' };
}
