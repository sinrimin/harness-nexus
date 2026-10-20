// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';
import { agentTargetSchema } from './profile.js';

/**
 * Machine inventory schemas (Phase 8 C3) — the normalized per-target snapshot
 * a daemon's scanners report, the artifact bodies an import collects, and the
 * diff/import REST shapes. See wiki design-phase-8-c3.md.
 *
 * The snapshot is metadata-only (≤200-char previews); full bodies are fetched
 * at import time via `inventory:collect` → `inventory:payload`. These mirror
 * the plain interfaces in @harness-nexus/core (`domain/inventory.ts`) — keep
 * them in sync.
 */

/**
 * Targets the C3 daemon scans — single source for the server route default,
 * the SDK, and the CLI scanner registry (kept in lockstep with
 * `packages/cli/src/inventory/scan.ts`).
 */
export const SCANNABLE_TARGETS = [
  'claude-code',
  'codex',
  'hermes',
  'deepseek',
  'opencode',
  'pi',
] as const;

/**
 * Targets whose harness RUNTIME the daemon probes (Phase 9 W1) — a subset of
 * SCANNABLE_TARGETS: hermes is unlisted (runtime management CANCELLED with
 * the user 2026-09-17; it stays scan + profile-deploy + ACP-chat only).
 * Kept in lockstep with `packages/cli/src/inventory/runtime.ts`.
 */
export const RUNTIME_TARGETS = ['claude-code', 'codex', 'deepseek', 'opencode', 'pi'] as const;
export const runtimeTargetSchema = z.enum(RUNTIME_TARGETS);
export type RuntimeTarget = z.infer<typeof runtimeTargetSchema>;

/**
 * 9 W13 — narrow a wide `AgentTarget` down to the runtime-managed set (the
 * RuntimeConfig repository is keyed by `RuntimeTarget`; chat-only targets
 * like hermes/zcode simply have no row).
 */
export function isRuntimeTarget(target: string): target is RuntimeTarget {
  return (RUNTIME_TARGETS as readonly string[]).includes(target);
}

/**
 * One probed harness runtime (Phase 9 W1). Metadata only — no config file
 * contents ride the snapshot (those are W4's redacted viewer).
 */
export const runtimeInfoSchema = z.object({
  target: runtimeTargetSchema,
  installed: z.boolean(),
  binPath: z.string().max(512).optional(),
  /** Raw `<bin> --version` output, trimmed. */
  version: z.string().max(64).optional(),
  installMethod: z.enum(['npm', 'native', 'brew', 'unknown']).optional(),
});
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

/** Kinds an inventory item can carry — `ResourceKind` minus `hook` (no target has a scanner for it in C3). */
export const inventoryItemKindSchema = z.enum(['skill', 'command', 'sub_agent', 'rule', 'mcp']);
export type InventoryItemKind = z.infer<typeof inventoryItemKindSchema>;

/** One discovered artifact on the machine. */
export const inventoryItemSchema = z.object({
  kind: inventoryItemKindSchema,
  /** Artifact name — for platform-written items this is the resource/MCP name (name-stable round trip). */
  name: z.string().min(1).max(128),
  /** `platform` = written by hnx (ledger / `harness-nexus[-*]` markers) — derived, never guessed from content. */
  origin: z.enum(['platform', 'local']),
  /** Path relative to the agent home dir. Display only — collect re-derives paths from a fresh scan. */
  path: z.string().min(1).max(512),
  /** First meaningful line (≤120 chars) for the diff/import UI. */
  summary: z.string().max(120).optional(),
  contentPreview: z.string().max(200).optional(),
  /** False for binary/oversized/otherwise unimportable artifacts. */
  importable: z.boolean(),
  /** Why `importable` is false, or the evidence behind `origin: 'platform'`. */
  note: z.string().max(200).optional(),
  meta: z
    .object({
      /** Skill with more than SKILL.md (→ `inline-bundle` on import). */
      multi: z.boolean().optional(),
      transport: z.enum(['stdio', 'sse', 'http']).optional(),
      command: z.string().max(256).optional(),
      url: z.string().max(512).optional(),
      /** For claude-code plugin-cache items: `<marketplace>/<plugin>/<version>`. */
      plugin: z.string().max(160).optional(),
    })
    .optional(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/** One agent installation (C3: exactly one per target — the default home). */
export const inventoryAgentSchema = z.object({
  name: z.string().min(1).max(128),
  /** Absolute home dir, e.g. `/home/me/.claude`. */
  directory: z.string().min(1).max(512),
  /** Did any hnx install/marketplace touch this home? null = unknown. */
  profileApplied: z.boolean().nullable(),
  items: z.array(inventoryItemSchema).max(500),
});
export type InventoryAgent = z.infer<typeof inventoryAgentSchema>;

export const inventorySnapshotSchema = z.object({
  target: agentTargetSchema,
  /** ISO timestamp on the daemon's clock. */
  scannedAt: z.string().datetime(),
  agents: z.array(inventoryAgentSchema).min(1).max(8),
});
export type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;

// ---- import artifacts (daemon → server bodies; env/header VALUES are already
// redacted to `${cred:<KEY>}` placeholders daemon-side) ----

/** The transport an imported MCP item carries. Lenient on `url` — strict validation happens at McpServer creation. */
export const redactedMcpTransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1).max(512),
    args: z.array(z.string().max(512)).max(64).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('sse'),
    url: z.string().min(1).max(1024),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().min(1).max(1024),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type RedactedMcpTransport = z.infer<typeof redactedMcpTransportSchema>;

/** The body payload per kind. Skills are ALWAYS a files map (single-file = only `SKILL.md`). */
export const inventoryArtifactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill'), files: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal('command'), content: z.string() }),
  z.object({ kind: z.literal('sub_agent'), content: z.string() }),
  z.object({ kind: z.literal('rule'), content: z.string() }),
  z.object({ kind: z.literal('mcp'), transport: redactedMcpTransportSchema }),
]);
export type InventoryArtifact = z.infer<typeof inventoryArtifactSchema>;

// ---- REST shapes ----

export const scanMachineInventorySchema = z.object({
  targets: z.array(agentTargetSchema).min(1).max(8).optional(),
});
export type ScanMachineInventoryInput = z.infer<typeof scanMachineInventorySchema>;

export const importMachineInventorySchema = z.object({
  target: agentTargetSchema,
  profileName: z.string().min(1).max(64),
  items: z
    .array(z.object({ kind: inventoryItemKindSchema, name: z.string().min(1).max(128) }))
    .min(1)
    .max(200),
});
export type ImportMachineInventoryInput = z.infer<typeof importMachineInventorySchema>;

/**
 * Capture-as-profile (Phase 9 W1): import the Agent's CURRENT state (all
 * importable items of the latest snapshot, no diff baseline). An Agent in
 * default state captures as a profile with zero entries.
 */
export const captureMachineInventorySchema = z.object({
  target: agentTargetSchema,
  profileName: z.string().min(1).max(64),
});
export type CaptureMachineInventoryInput = z.infer<typeof captureMachineInventorySchema>;

/** One row of a diff result (`GET /api/machines/:id/inventory/diff?profile=`). */
export const inventoryDiffEntrySchema = z.object({
  kind: inventoryItemKindSchema,
  name: z.string(),
});
export type InventoryDiffEntry = z.infer<typeof inventoryDiffEntrySchema>;

export const inventoryDiffSchema = z.object({
  profileId: z.string(),
  target: agentTargetSchema,
  /** Profile entries found on the machine (matched by kind+name; records the item's origin). */
  upToDate: z.array(
    z.object({
      kind: inventoryItemKindSchema,
      name: z.string(),
      origin: z.enum(['platform', 'local']),
    }),
  ),
  /** Profile entries with no matching artifact — drift (profile applied incompletely or edited away). */
  missingOnMachine: z.array(inventoryDiffEntrySchema),
  /** Local-origin items no profile entry claims — exactly the import candidates. */
  notInProfile: z.array(inventoryItemSchema),
  summary: z.object({
    profileEntries: z.number().int().min(0),
    applied: z.number().int().min(0),
    missing: z.number().int().min(0),
    candidates: z.number().int().min(0),
  }),
});
export type InventoryDiff = z.infer<typeof inventoryDiffSchema>;
