// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Phase 8 — a user's machine enrolled with this instance via the Harness
 * Nexus client (`hnx enroll`). The daemon on the machine authenticates to the
 * realtime channel (`/ctl`) with a dedicated machine PAT bound to the
 * `Machine` row. See wiki design-phase-8-client.md.
 */

/**
 * Issue #3 — which Agent targets of THIS machine get a pre-warmed ACP adapter
 * (booted to a completed `initialize`, no session) while the owner sits on a
 * chat session page. Machine-scoped on purpose: the idle processes live on
 * this machine, so its owner decides. Absent = `DEFAULT_CHAT_PREWARM_SETTINGS`.
 * Mirrors the zod schema in `@harness-nexus/shared` (`schemas/machine.ts`).
 */
export interface ChatPrewarmSettings {
  'claude-code': boolean;
  codex: boolean;
  deepseek: boolean;
  opencode: boolean;
}

/**
 * deepseek gains the most (~1.3s of its 1.5s open); the others get OFF by
 * default — opencode (#4) included: its open drops 2.5s → ~1.0s, but the
 * idle process weighs ~316 MB, the heaviest of the set.
 */
export const DEFAULT_CHAT_PREWARM_SETTINGS: ChatPrewarmSettings = {
  'claude-code': false,
  codex: false,
  deepseek: true,
  opencode: false,
};

/**
 * Issue #49 — per-target DEFAULT chat permission modes, machine-scoped like
 * `chatPrewarm` (mid-session switches already ride the W9 lane). claude-code
 * only today: its ACP wrapper always resolves an EXPLICIT mode at
 * session/new (CC 2.1.285's own auto default therefore never reaches an ACP
 * session), so the platform supplies the initial mode itself. The value is
 * the adapter's OPAQUE mode id ('auto', 'acceptEdits', …); null = unset
 * (adapter default). Mirrors the zod schema in `@harness-nexus/shared`
 * (`schemas/machine.ts`).
 */
export interface ChatDefaultModeSettings {
  'claude-code': string | null;
}

/**
 * Issue #92 — delegated approvals, machine-scoped like `chatPrewarm` /
 * `chatDefaultMode` but deliberately NOT per-target: the gate answers ACP
 * `session/request_permission`, which is target-agnostic. `responder` is the
 * machine DEFAULT (sessions override it live through the W9-style lane);
 * `manual` (and an absent map) = every surfaced request goes to the human
 * card, exactly as before. Mirrors the zod schema in `@harness-nexus/shared`
 * (`schemas/machine.ts`).
 */
export interface ChatApprovalsSettings {
  responder: 'manual' | 'delegated';
  /**
   * #95 — machine-level override of the decision model: a provider row with
   * the `systemone` wire + one of its `models[]` with `apiKind: 'systemone'`
   * (resolved + validated at save). BOTH optional: omitting the pair follows
   * the USER-level default decision model.
   */
  providerId?: string | undefined;
  modelId?: string | undefined;
  /** Both the choice confidence AND the `covered` noul must clear it. */
  confidenceThreshold: number;
  /**
   * L3 floor: case-insensitive substrings matched against the toolCall title
   * BEFORE the model is ever consulted — a hit hard-denies everywhere (safety
   * outranks stalling). Kept deliberately dumb; patterns are owner-authored.
   */
  neverAllow: string[];
  /**
   * On targets with no deny-reason channel (everything but claude-code today),
   * a floor deny injects a platform-authored correction note as the next
   * prompt (the #10 queue lane) so the agent does not end its turn believing
   * the user refused. Default on.
   */
  denyNote: boolean;
}

export interface Machine {
  id: string;
  ownerId: string;
  /** User-assigned display name. */
  name: string;
  /** Daemon-reported metadata, refreshed on every `machine:hello`. */
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemonVersion: string | null;
  /** Feature tags the daemon advertises (e.g. future 'mcp-shim', 'deploy', 'acp'). */
  capabilities: string[];
  /**
   * Gates interactive chat sessions (C5). Off by default — talking to an
   * agent drives tool execution on the host machine.
   */
  remoteChatEnabled: boolean;
  /**
   * Phase 9 W6 — the machine's base workspace: the directory root under
   * which chat sessions pick their project cwd (the picker lists only its
   * subdirectories, routed through the daemon). Null = not configured; the
   * chat UI prompts the owner to set it before creating a session.
   */
  baseWorkspace: string | null;
  /** Issue #3 — per-target adapter pre-warm switches for this machine. */
  chatPrewarm?: ChatPrewarmSettings;
  /** Issue #49 — per-target default chat permission modes for this machine. */
  chatDefaultMode?: ChatDefaultModeSettings;
  /** Issue #92 — delegated-approvals gate config for this machine. */
  chatApprovals?: ChatApprovalsSettings;
  /**
   * The machine PAT issued once at enrollment. Deleting the machine (or this
   * PAT) revokes realtime access immediately.
   */
  enrollmentPatId: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  // NOTE: online/offline is NOT stored — it is derived from live socket
  // presence in the realtime layer (`MachinePresence`).
}
