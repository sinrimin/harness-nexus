// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * Machine management request schemas (Phase 8 C1). See
 * wiki design-phase-8-client.md and wiki design-phase-8-c1.md.
 */

export const createMachineSchema = z.object({
  /** Display name for the machine (the daemon's hostname is a good default). */
  name: z.string().min(1).max(64),
});

/**
 * Issue #3 — per-target adapter pre-warm switches, MACHINE-scoped (the idle
 * processes live on the machine, so its owner decides). The zod layer mirrors
 * `core/domain/machine.ts`; keep the shapes in sync. pi is out of scope (it
 * chats through the in-daemon RPC façade); opencode joined in #4 (open
 * 2.5s → ~1.0s; OFF by default — its idle process weighs ~316 MB).
 */
export const chatPrewarmSettingsSchema = z.object({
  'claude-code': z.boolean(),
  codex: z.boolean(),
  deepseek: z.boolean(),
  opencode: z.boolean(),
});

/** Applied when the machine row predates the feature (NULL column) — mirrors core. */
export const DEFAULT_CHAT_PREWARM_SETTINGS = {
  'claude-code': false,
  codex: false,
  deepseek: true,
  opencode: false,
};

/**
 * Issue #49 — per-target default chat permission modes, machine-scoped
 * (mirrors `chatPrewarm` and `core/domain/machine.ts`; keep the shapes in
 * sync). claude-code only today — the only adapter whose ACP wrapper
 * advertises permission modes; its wrapper always resolves an explicit mode
 * at session/new, so the platform supplies the initial one. The value is the
 * adapter's OPAQUE mode id; explicit null clears it.
 */
export const chatDefaultModeSettingsSchema = z.object({
  'claude-code': z.string().min(1).max(64).nullable(),
});

export const updateMachineSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    /** Toggling remote chat on is a consent action — the web UI confirms first. */
    remoteChatEnabled: z.boolean().optional(),
    /**
     * Phase 9 W6 — the base workspace root (absolute path on the machine)
     * under which chat sessions may pick their cwd. Explicit `null` clears it.
     */
    baseWorkspace: z.string().min(1).max(1024).nullable().optional(),
    /** Issue #3 — replace-semantics per-target pre-warm map (full object). */
    chatPrewarm: chatPrewarmSettingsSchema.optional(),
    /** Issue #49 — replace-semantics per-target default mode map (full object). */
    chatDefaultMode: chatDefaultModeSettingsSchema.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.remoteChatEnabled !== undefined ||
      v.baseWorkspace !== undefined ||
      v.chatPrewarm !== undefined ||
      v.chatDefaultMode !== undefined,
    { message: 'at least one of name / remoteChatEnabled / baseWorkspace is required' },
  );

export type CreateMachineInput = z.infer<typeof createMachineSchema>;
export type UpdateMachineInput = z.infer<typeof updateMachineSchema>;

// ---- workspace directory listing (phase 9 W6) ----
//
// The chat directory picker browses ONE level of subdirectories under the
// machine's base workspace, routed through the daemon over /ctl.

/** server → daemon: list the direct child directories of `path`. */
export const workspaceListRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  path: z.string().min(1).max(1024),
});

export const workspaceDirectorySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(1024),
});

/** 9 W9 C — a plain file entry for the composer's @-reference picker. */
export const workspaceFileSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(1024),
});

/** daemon → server: the reply (or the `error` arm). */
export const workspaceListEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  directories: z.array(workspaceDirectorySchema).max(512).optional(),
  /** 9 W9 C — regular files at the listed level (old daemons omit it). */
  files: z.array(workspaceFileSchema).max(512).optional(),
  error: z.string().max(512).optional(),
});

export type WorkspaceListRequest = z.infer<typeof workspaceListRequestSchema>;
export type WorkspaceListEvent = z.infer<typeof workspaceListEventSchema>;
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
