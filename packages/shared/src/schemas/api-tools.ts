// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * Issue #80 — API tools: declarative HTTP APIs as assistant tools (+ MCP
 * exposure). A SERVICE bundle is the unit of upload/download — compact,
 * LLM-authored JSON (no forms; the probe panel is the feedback loop).
 *
 * Deliberate cuts (see the wiki design): no SSE/WebSocket/long-polling
 * (request/response only), no file upload (multipart rejected), no binary
 * responses (json/text only), no spill-to-file — `maxResultChars` truncates
 * with a marker and a server-side raw-body read cap protects memory.
 */

export const API_TOOL_SCHEMA_VERSION = 1;

const dotPath = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'dot path segments only — no DSL');

export const apiToolParamSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'param names are url-safe identifiers'),
  in: z.enum(['path', 'query', 'header', 'body']),
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean(),
  description: z.string().max(2000).optional(),
});
export type ApiToolParamInput = z.infer<typeof apiToolParamSchema>;

export const apiToolEnvelopeSchema = z.object({
  /** Dot path to the status field; absent = HTTP status alone decides. */
  codeField: dotPath.optional(),
  /** Values meaning success — compared AFTER String() coercion (0 === '0'). */
  success: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .max(16),
  /** Dot path to the payload; absent = the whole body IS the payload. */
  payloadField: dotPath.optional(),
  /** On business failure, the first non-empty of these is the error text. */
  errorFields: z.array(z.string().min(1).max(128)).max(8).optional(),
});
export type ApiToolEnvelopeInput = z.infer<typeof apiToolEnvelopeSchema>;

export const apiToolDefSchema = z
  .object({
    /** The assistant-facing tool name; unique within the bundle. */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'snake_case tool names'),
    description: z.string().max(4000).optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** URL path with `{param}` slots (must match declared path params). */
    path: z.string().min(1).max(512),
    params: z.array(apiToolParamSchema).max(32).default([]),
    /** Required iff a `body` param exists; multipart is rejected outright. */
    bodyType: z.enum(['json', 'form']).optional(),
    timeoutMs: z.number().int().min(500).max(60_000).optional(),
    maxResultChars: z.number().int().min(200).max(100_000).optional(),
    envelope: apiToolEnvelopeSchema.optional(),
    /** Parse the body through `envelope` even on non-2xx (envelopes on 4xx). */
    treatBodyOnNon2xx: z.boolean().optional(),
  })
  .superRefine((t, ctx) => {
    const slots = [...t.path.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map((m) => m[1]!);
    const declared = new Set(t.params.filter((p) => p.in === 'path').map((p) => p.name));
    for (const slot of slots) {
      if (!declared.has(slot)) {
        ctx.addIssue({
          code: 'custom',
          message: `path slot {${slot}} has no matching path param`,
        });
      }
    }
    for (const p of t.params.filter((x) => x.in === 'path')) {
      if (!slots.includes(p.name)) {
        ctx.addIssue({ code: 'custom', message: `path param ${p.name} is not a {slot}` });
      }
      if (!p.required) {
        ctx.addIssue({ code: 'custom', message: `path param ${p.name} must be required` });
      }
    }
    const hasBody = t.params.some((p) => p.in === 'body');
    if (hasBody && t.bodyType === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a body param requires bodyType (json | form)' });
    }
    if (!hasBody && t.bodyType !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'bodyType set but no body param exists' });
    }
    if (t.envelope !== undefined && t.envelope.success.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'envelope.success must list at least one value' });
    }
  });
export type ApiToolDefInput = z.input<typeof apiToolDefSchema>;

const authSchema = z.discriminatedUnion('style', [
  /** `Authorization: Bearer <secret>` — the secret never leaves the server. */
  z.object({ style: z.literal('bearer'), credentialName: z.string().min(1).max(64) }),
  /** The named header carries the secret (e.g. `X-API-Key`). */
  z.object({
    style: z.literal('header'),
    header: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9-]+$/, 'header names are simple tokens'),
    credentialName: z.string().min(1).max(64),
  }),
]);

/**
 * The upload/download bundle. `version` is the format version — uploaders
 * (LLMs) carry it; the server rejects unknown versions honestly.
 */
export const apiToolServiceBundleSchema = z
  .object({
    version: z.literal(API_TOOL_SCHEMA_VERSION),
    name: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
    baseUrl: z
      .string()
      .url()
      .max(2048)
      .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
        message: 'baseUrl must be http(s)',
      }),
    /** Static headers (no secrets here — the auth block is the only door). */
    headers: z.record(z.string().min(1).max(64), z.string().max(2048)).default({}),
    auth: authSchema.optional(),
    tools: z.array(apiToolDefSchema).min(1).max(64),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const t of s.tools) {
      if (seen.has(t.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate tool name ${t.name}` });
      }
      seen.add(t.name);
    }
    for (const [k, v] of Object.entries(s.headers)) {
      if (/authorization|cookie/i.test(k) || /\{|\$|\{cred/.test(v)) {
        ctx.addIssue({
          code: 'custom',
          message: `header ${k}: secrets belong in the auth block, never in headers`,
        });
      }
    }
  });
export type ApiToolServiceBundleInput = z.input<typeof apiToolServiceBundleSchema>;
export type ApiToolServiceBundle = z.infer<typeof apiToolServiceBundleSchema>;

/** The stored/returned row (the bundle + identity/scope). */
export const apiToolServiceViewSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['global', 'personal']),
  ownerId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  bundle: apiToolServiceBundleSchema,
});
export type ApiToolServiceView = z.infer<typeof apiToolServiceViewSchema>;
