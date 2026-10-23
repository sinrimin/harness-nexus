// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { LlmProvider, Note, NoteAnnotation } from '@harness-nexus/core';
import { AppError, type SummarizeNoteInput } from '@harness-nexus/shared';
import type { Principal, ServiceDeps } from './principal.js';
import { resolveTurnModel } from '../assistant/runner.js';
import type { GatewayModel } from '../assistant/provider.js';
import { updateNote, updateAnnotation } from './notes.js';

/**
 * Notes AI passes (#88) — one-shot LLM completions over note content: the
 * summary generator (capture dialog + editor) and the annotation-driven
 * revision loop. NO agent, NO tools, NO session: the platform's provider
 * registry + credentials resolve a model exactly like an assistant turn
 * (#52 §4), a bare pi Agent runs a single prompt to idle, and the text comes
 * back. Long-running by LLM standards — callers hold the HTTP request open
 * and the UI shows a busy state.
 */

export interface NotesAiDeps extends ServiceDeps {
  credentialEncryptionKey: string;
  /** Test seam: script the model instead of dialing a provider. */
  buildModel?: (input: {
    provider: LlmProvider;
    modelId: string;
    ownerId: string;
  }) => Promise<GatewayModel>;
}

/** Body slices past this are marked truncated in the prompt (bounded input). */
const PROMPT_CONTENT_CAP = 60_000;

/**
 * The default model for note passes: the owner's personal providers first
 * (deliberate configuration beats shared defaults), then global ones — each
 * in creation order, the first with a chat entry wins. Deterministic, and
 * honest about not existing (NOTE_AI_NO_PROVIDER, 409).
 */
export async function resolveNotesModel(
  deps: NotesAiDeps,
  ownerId: string,
): Promise<{ provider: LlmProvider; modelId: string }> {
  const pools = [
    await deps.uow.llmProviders.list({ scope: 'personal', ownerId }),
    await deps.uow.llmProviders.list({ scope: 'global' }),
  ];
  for (const pool of pools) {
    for (const provider of pool) {
      const chat = provider.models.find((m) => m.type === 'chat');
      if (chat !== undefined) return { provider, modelId: chat.id };
    }
  }
  throw new AppError(
    'No LLM provider with a chat model is configured for this account',
    409,
    'NOTE_AI_NO_PROVIDER',
  );
}

/** Run one prompt through a bare agent and return the final assistant text. */
async function completeOnce(
  deps: NotesAiDeps,
  ownerId: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const { provider, modelId } = await resolveNotesModel(deps, ownerId);
  const gateway: GatewayModel = await (deps.buildModel !== undefined
    ? deps.buildModel({ provider, modelId, ownerId })
    : resolveTurnModel(deps, ownerId, provider, modelId));

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: gateway.model,
      tools: [],
      messages: [],
    },
    streamFn: gateway.streamFn,
  });
  await agent.prompt({
    role: 'user',
    content: [{ type: 'text', text: userPrompt }],
    timestamp: Date.now(),
  });
  await agent.waitForIdle();

  const assistants = agent.state.messages.filter(
    (m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant',
  );
  const last = assistants[assistants.length - 1];
  if (last === undefined || last.stopReason === 'error') {
    throw new AppError(
      last?.errorMessage ?? 'The model returned no content',
      502,
      'NOTE_AI_TURN_FAILED',
    );
  }
  return last.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
}

function capContent(contentMd: string): string {
  if (contentMd.length <= PROMPT_CONTENT_CAP) return contentMd;
  return `${contentMd.slice(0, PROMPT_CONTENT_CAP)}\n\n[truncated]`;
}

/** Models love wrapping single-document answers in a code fence. Unwrap it. */
function stripFence(text: string): string {
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  return match !== null ? match[1]! : text;
}

export async function summarizeNoteContent(
  deps: NotesAiDeps,
  caller: Principal,
  input: SummarizeNoteInput,
): Promise<{ summary: string }> {
  const summary = await completeOnce(
    deps,
    caller.userId,
    [
      'You summarize notes for a knowledge library.',
      'Write ONE dense paragraph of 1–2 sentences (at most ~120 words) in the SAME language as the note.',
      'Capture what the note concludes or decides, not its table of contents.',
      'Answer with the summary text ONLY — no preamble, no quotes, no markdown formatting.',
    ].join(' '),
    [
      input.title !== undefined ? `Title: ${input.title}\n\n` : '',
      capContent(input.contentMd),
    ].join(''),
  );
  return { summary: summary.slice(0, 1000) };
}

/**
 * The revision loop: every OPEN annotation (its quote + comment) plus the
 * current body goes to the model; the rewritten markdown saves as the NEXT
 * IMMUTABLE VERSION (the service bumps it), and the addressed annotations
 * flip to done — their instructions are spent. Annotations whose quotes
 * survive stay visible as done marks; lost ones surface in the pane.
 */
export async function reviseNoteByAnnotations(
  deps: NotesAiDeps,
  caller: Principal,
  noteId: string,
): Promise<{ note: Note; resolved: NoteAnnotation[] }> {
  const note = await deps.uow.notes.findById(noteId);
  if (!note || note.ownerId !== caller.userId) {
    throw new AppError('Note not found', 404, 'NOTE_NOT_FOUND');
  }
  const open = (await deps.uow.noteAnnotations.listByNote(noteId)).filter(
    (a) => a.state === 'open',
  );
  if (open.length === 0) {
    throw new AppError(
      'This note has no open annotations to revise by',
      400,
      'NOTE_NO_OPEN_ANNOTATIONS',
    );
  }

  const annotationLines = open
    .map((a, i) => `${i + 1}. Quote: «${a.quote}»\n   Instruction: ${a.comment}`)
    .join('\n');
  const revised = stripFence(
    await completeOnce(
      deps,
      caller.userId,
      [
        'You revise a markdown note by applying numbered inline annotations.',
        'For every annotation: find its quoted span and apply the instruction to that span.',
        'Keep everything NOT covered by an annotation byte-for-byte unchanged — same language, same structure, same formatting.',
        'Do not add commentary, do not add or remove sections, do not wrap the answer in a code fence.',
        'Answer with the COMPLETE revised markdown document ONLY.',
      ].join(' '),
      `Title: ${note.title}\n\n${capContent(note.contentMd)}\n\nAnnotations:\n${annotationLines}`,
    ),
  );
  if (revised === '') {
    throw new AppError('The model returned an empty revision', 502, 'NOTE_AI_TURN_FAILED');
  }

  const next = await updateNote(deps, caller, noteId, { contentMd: revised });
  const resolved: NoteAnnotation[] = [];
  for (const a of open) {
    resolved.push(
      await updateAnnotation(deps, caller, noteId, a.id, { state: 'done' }),
    );
  }
  return { note: next, resolved };
}
