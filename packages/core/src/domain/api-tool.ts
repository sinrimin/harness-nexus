// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #80 — API tools: a stored SERVICE bundle (base URL + auth + endpoint
 * tools) the platform assistant calls as tools and client agents receive via
 * the aggregated MCP endpoint. The wire shape (zod, upload/download) lives in
 * `@harness-nexus/shared`; this is the domain row. LLM-authored JSON in,
 * probe-validated behavior — no forms.
 */

export type ApiToolParamLocation = 'path' | 'query' | 'header' | 'body';
export type ApiToolParamType = 'string' | 'number' | 'boolean';

export interface ApiToolParam {
  name: string;
  in: ApiToolParamLocation;
  type: ApiToolParamType;
  required: boolean;
  description?: string | undefined;
}

/**
 * The common Chinese-API envelope, declaratively unwrapped: `{code, message,
 * body}` — `codeField`/`success` (String()-coerced compare) decide, the
 * `payloadField` becomes the tool result, `errorFields` speak on failure.
 * Field addressing is DOT PATHS ONLY — no DSL (jsonata/jslt deliberately
 * rejected: LLM blind-write accuracy).
 */
export interface ApiToolEnvelope {
  codeField?: string | undefined;
  success: (string | number)[];
  payloadField?: string | undefined;
  errorFields?: string[] | undefined;
}

export type ApiToolAuth =
  | { style: 'bearer'; credentialName: string }
  | { style: 'header'; header: string; credentialName: string };

export interface ApiToolDef {
  name: string;
  /**
   * REQUIRED (#85): this text is the model's only spec for the tool — it
   * rides the `api__<service>__<tool>` definition into the LLM's context.
   */
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  params: ApiToolParam[];
  bodyType?: 'json' | 'form' | undefined;
  timeoutMs?: number | undefined;
  maxResultChars?: number | undefined;
  envelope?: ApiToolEnvelope | undefined;
  treatBodyOnNon2xx?: boolean | undefined;
}

/**
 * One admin-managed allowlist entry (default-DENY, see the runtime): `host`
 * matches exactly or via a `*.domain` wildcard; `internal` permits
 * private/loopback resolutions for named intranet hosts (link-local and
 * cloud-metadata ranges stay hard-denied regardless).
 */
export interface ApiToolOutboundRules {
  external: string[];
  internal: string[];
}

/** One stored API tool service. The bundle mirrors the shared wire schema. */
export interface ApiToolService {
  id: string;
  scope: 'global' | 'personal';
  /** null for global rows (admin-owned); the owner for personal rows. */
  ownerId: string | null;
  name: string;
  description?: string;
  baseUrl: string;
  headers: Record<string, string>;
  auth?: ApiToolAuth;
  tools: ApiToolDef[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
