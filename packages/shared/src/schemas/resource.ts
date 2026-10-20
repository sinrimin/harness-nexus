// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';
import { resourceKindSchema, agentTargetSchema } from './profile.js';

/**
 * Resource validation schemas — single source of truth for request shapes
 * across server, SDK, and web. See wiki design-phase-4-web-ui.md.
 *
 * These mirror the domain types in @harness-nexus/core; keep them in sync.
 *
 * The schemas are intentionally kind-agnostic (any `ResourceKind` is accepted
 * here). Which kinds are *currently available* is enforced at the route layer
 * via an allowlist (409 KIND_NOT_AVAILABLE), so 4.4–4.6 can enable new kinds
 * without touching this schema.
 *
 * `kind` and `scope` are immutable post-create — a resource's identity and
 * visibility don't change; mutate-by-recreate instead. PATCHing either is
 * rejected at the route layer (409 RESOURCE_IMMUTABLE).
 */

const scopeSchema = z.enum(['global', 'personal']);

/**
 * Where a resource's bytes live. The markdown editors (sub-agent/rule/command)
 * emit `inline`; the multi-file skill editor (4.6) emits `inline-bundle`. The
 * external-source variants (git/tarball/local) are accepted but arrive with
 * Phase 7.
 */
const resourceSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  z.object({
    type: z.literal('tarball'),
    url: z.string().min(1),
    checksum: z.string().optional(),
  }),
  z.object({ type: z.literal('local'), path: z.string().min(1) }),
  z.object({ type: z.literal('inline'), content: z.string() }),
  z.object({
    type: z.literal('inline-bundle'),
    files: z.record(z.string(), z.string()),
  }),
  // Phase 7.1 — a marketplace/plugin skill reference. The nested discriminated
  // union mirrors the CC marketplace.json `source` kinds. See
  // `wiki design-phase-7.1-plugin-source.md` Part 2a.
  z.object({
    type: z.literal('plugin'),
    source: z.discriminatedUnion('source', [
      z.object({
        source: z.literal('github'),
        repo: z.string().min(1),
        ref: z.string().optional(),
        sha: z.string().optional(),
        path: z.string().optional(),
      }),
      z.object({
        source: z.literal('url'),
        url: z.string().min(1),
        ref: z.string().optional(),
        sha: z.string().optional(),
        path: z.string().optional(),
      }),
      z.object({
        source: z.literal('git-subdir'),
        url: z.string().min(1),
        path: z.string().min(1),
        ref: z.string().optional(),
        sha: z.string().optional(),
      }),
      z.object({
        source: z.literal('npm'),
        package: z.string().min(1),
        version: z.string().min(1),
        registry: z.string().optional(),
      }),
    ]),
    plugin: z.string().min(1),
    version: z.string().optional(),
  }),
]);

export const createResourceSchema = z.object({
  key: z.string().min(1).max(128),
  kind: resourceKindSchema,
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  version: z.string().min(1).max(64).default('1.0.0'),
  source: resourceSourceSchema,
  scope: scopeSchema,
  targets: z.array(agentTargetSchema).default([]),
  labels: z.record(z.string(), z.string()).optional(),
});

// kind + scope deliberately omitted — immutable post-create.
export const updateResourceSchema = z.object({
  key: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2048).optional(),
  version: z.string().min(1).max(64).optional(),
  source: resourceSourceSchema.optional(),
  targets: z.array(agentTargetSchema).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export type CreateResourceInput = z.infer<typeof createResourceSchema>;
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>;
