// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Hook event × target support matrix — the single source of truth for which
 * hook events each Agent tool supports. Used by the hook editor (Phase 4.5) to
 * validate bindings and by the install writer (Phase 3.2) to filter per target.
 *
 * See `wiki research-phase-4.5-hooks.md` for the per-target evidence.
 *
 * Format model: Claude Code and ZCode share a `hooks.json` event→command
 * declarative format. Claude Code supports ~30 events; ZCode a strict 7-event
 * subset. Hermes uses a structurally different model (Python plugins, not
 * declarative event bindings), so its support is `null` — meaning "this target
 * does not use the declarative hooks.json model at all."
 */

import type { AgentTarget } from './schemas/profile.js';

/** Canonical hook events across all declarative-hook targets (CC union). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'UserPromptExpansion',
  'PostToolBatch',
  'PermissionDenied',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Events each declarative-hook target supports.
 * - A `Set` means the target uses hooks.json; only listed events are valid.
 * - `null` means the target uses a different hook model (e.g. Hermes Python
 *   plugins) — a declarative hooks.json resource cannot target it.
 */
export const HOOK_SUPPORT: Readonly<Record<AgentTarget, ReadonlySet<HookEvent> | null>> = {
  'claude-code': new Set<HookEvent>(HOOK_EVENTS),
  // zcode has no install adapter (no reference material; Phase 3 out of scope).
  // The 7-event set is retained from prior research but is moot until an adapter
  // ships. See wiki research-phase-3-ecc-install-patterns.md.
  zcode: new Set<HookEvent>([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'Stop',
  ]),
  hermes: null,
  // Codex uses a config/prompts-based hook model (TOML config + generated
  // prompts), not declarative hooks.json — null, like Hermes.
  codex: null,
  // DeepSeek Harness has no declarative hook format of its own; its CC/Codex
  // hooks.json BRIDGES are opt-in per-profile packages an install cannot wire
  // (research § Hooks) — null, like Hermes/Codex.
  deepseek: null,
  // 9 W12 — opencode's plugin/extension surface is TS code, not a declarative
  // hooks.json — null, like Hermes/Codex/deepseek.
  opencode: null,
  // 9 W16 — pi's extension surface is TS code (tools/sub-agents/hooks ride
  // extensions), not a declarative hooks.json — null, like the class above.
  pi: null,
  // 'generic' assumes the full set — a permissive default for unknown targets.
  generic: new Set<HookEvent>(HOOK_EVENTS),
};

/**
 * The targets that accept a declarative hooks.json resource (i.e. not `null`).
 * Used by the route layer to reject Hermes as a hook target up front.
 */
export const DECLARATIVE_HOOK_TARGETS: ReadonlySet<AgentTarget> = new Set<AgentTarget>(
  (Object.keys(HOOK_SUPPORT) as AgentTarget[]).filter((t) => HOOK_SUPPORT[t] !== null),
);
