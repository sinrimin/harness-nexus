// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { lookup } from 'node:dns/promises';
import type { ApiToolAllowlistEntry, ApiToolDef, ApiToolService } from '@harness-nexus/core';
import { decryptSecret } from '../infra/crypto.js';
import type { ServiceDeps } from '../services/principal.js';

/**
 * Issue #80 slice 2 — the API tool RUNTIME: outbound HTTP surface #3, the
 * same discipline as marketplace fetch (#7.2). One choke point: default-deny
 * host allowlist (admin-managed), resolved-IP validation before connect
 * (anti DNS-rebinding — the validate→fetch window is narrow but nonzero;
 * documented residual risk), cloud-metadata ranges hard-denied even for
 * internal-flagged entries. Envelope/errors/truncation follow the wiki
 * design's fixed matrix; errors are ALWAYS tool errors, never
 * success-shaped.
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESULT_CHARS = 10_000;
/** Protects server memory BEFORE truncation applies. */
const RAW_BODY_READ_CAP = 2_000_000;
/** The error-path body snippet the model may see. */
const ERROR_SNIPPET_CHARS = 500;

// ---- allowlist + IP classification (pure) ----

export function matchAllowlist(
  host: string,
  entries: readonly ApiToolAllowlistEntry[],
): ApiToolAllowlistEntry | null {
  const h = host.toLowerCase();
  for (const e of entries) {
    const pattern = e.host.toLowerCase();
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      if (h.endsWith(`.${base}`) || h === base) return e;
    } else if (pattern === h) {
      return e;
    }
  }
  return null;
}

export type IpClass = 'loopback' | 'link-local' | 'private' | 'public';

/** Textbook classifiers — string prefixes (v4) + the v6 homes we care about. */
export function ipClassOf(ip: string): IpClass {
  if (ip === '::1' || ip === '0.0.0.0' || ip.startsWith('127.')) return 'loopback';
  if (ip.startsWith('fe80:') || ip.startsWith('169.254.')) return 'link-local';
  if (
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  ) {
    return 'private';
  }
  return 'public';
}

export function isLiteralIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

// ---- response shaping (pure) ----

export function getByDotPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** `…[truncated, N/M chars]` — the marker carries the TRUE total length. */
export function truncateWithMarker(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated, ${max}/${text.length} chars]`;
}

function looseEquals(a: unknown, b: string | number): boolean {
  return String(a) === String(b);
}

/**
 * The fixed four-case matrix (plus the text arm and the WAF/login-page
 * diagnosis). Pure — the probe panel and the unit tests share it.
 */
export function applyResponse(
  tool: ApiToolDef,
  status: number,
  contentType: string,
  bodyText: string,
): { output: string; isError: boolean } {
  const maxChars = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const isJson =
    tool.envelope !== undefined ||
    /\bjson\b/i.test(contentType) ||
    bodyText.trimStart().startsWith('{') ||
    bodyText.trimStart().startsWith('[');

  // No envelope declared: the body IS the payload (json pretty or raw text).
  if (tool.envelope === undefined) {
    if (status < 200 || status >= 300) {
      return {
        output: `error: HTTP ${status} ${statusText(status)} — ${truncateWithMarker(bodyText, ERROR_SNIPPET_CHARS)}`,
        isError: true,
      };
    }
    let payload = bodyText;
    if (isJson) {
      try {
        payload = JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        // fall through: raw text below (a 2xx html page on a text-declared
        // tool is legitimate; a declared-json tool hits the snippet path
        // only when an envelope expected JSON — see below).
      }
    }
    return { output: truncateWithMarker(payload, maxChars), isError: false };
  }

  // Envelope path — expects JSON on the wire. Case 3 first: a non-2xx the
  // config did NOT opt into envelope-parsing reports status + capped body
  // without requiring parseable JSON at all.
  const non2xx = status < 200 || status >= 300;
  if (non2xx && tool.treatBodyOnNon2xx !== true) {
    return {
      output: `error: HTTP ${status} ${statusText(status)} — ${truncateWithMarker(bodyText, ERROR_SNIPPET_CHARS)}`,
      isError: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      output: `error: expected JSON but could not parse (content-type ${contentType || 'unknown'}) — ${snippet(bodyText, 200)}`,
      isError: true,
    };
  }
  const envelope = tool.envelope;

  // Cases 1/2/4 share one path: HTTP ok (or treated non-2xx) → decide by
  // the envelope code (the HTTP status stands in when no codeField).
  const code = envelope.codeField !== undefined ? getByDotPath(parsed, envelope.codeField) : status;
  if (envelope.success.some((s) => looseEquals(code, s))) {
    const payload =
      envelope.payloadField !== undefined ? getByDotPath(parsed, envelope.payloadField) : parsed;
    return {
      output: truncateWithMarker(JSON.stringify(payload, null, 2) ?? 'null', maxChars),
      isError: false,
    };
  }
  const errText = firstNonEmpty(parsed, envelope.errorFields ?? ['message', 'desc']);
  return {
    output: `error: API code ${String(code)}${non2xx ? ` (HTTP ${status})` : ''}: ${String(errText ?? 'unknown error')}`,
    isError: true,
  };
}

function firstNonEmpty(parsed: unknown, fields: string[]): unknown {
  for (const f of fields) {
    const v = getByDotPath(parsed, f);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function snippet(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function statusText(status: number): string {
  return status >= 500 ? 'server error' : status >= 400 ? 'client error' : 'ok';
}

// ---- execution ----

export interface ApiToolExecDeps extends ServiceDeps {
  credentialEncryptionKey: string;
}

export interface ApiToolExecResult {
  output: string;
  isError: boolean;
  /** Probe-panel extras (never shown to the model as-is). */
  debug?: { method: string; url: string; status: number; contentType: string };
}

/** Injectable for tests; the default resolves through the OS resolver. */
export type DnsResolver = (host: string) => Promise<string[]>;

const defaultResolve: DnsResolver = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address);

function err(output: string): ApiToolExecResult {
  return { output, isError: true };
}

function coerce(
  v: unknown,
  type: 'string' | 'number' | 'boolean',
  name: string,
): { ok: true; value: string | number | boolean } | { ok: false; message: string } {
  if (type === 'string') return { ok: true, value: String(v) };
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return { ok: true, value: n };
    return { ok: false, message: `param ${name}: not a number (${String(v)})` };
  }
  if (typeof v === 'boolean') return { ok: true, value: v };
  if (v === 'true' || v === 'false') return { ok: true, value: v === 'true' };
  return { ok: false, message: `param ${name}: not a boolean (${String(v)})` };
}

/**
 * Run one tool call end to end. Every failure lands as `{ isError: true }`
 * with a model-readable reason — the model reacts, the transcript records.
 */
export async function executeApiTool(
  deps: ApiToolExecDeps,
  service: ApiToolService,
  toolName: string,
  args: Record<string, unknown>,
  opts: { resolveDns?: DnsResolver } = {},
): Promise<ApiToolExecResult> {
  const tool = service.tools.find((t) => t.name === toolName);
  if (tool === undefined) return err(`error: unknown tool ${toolName} on ${service.name}`);

  // ---- args: coerce + required ----
  const values = new Map<string, string | number | boolean>();
  for (const p of tool.params) {
    const raw = args[p.name];
    if (raw === undefined) {
      if (p.required) return err(`error: missing required param ${p.name}`);
      continue;
    }
    const c = coerce(raw, p.type, p.name);
    if (!c.ok) return err(`error: ${c.message}`);
    values.set(p.name, c.value);
  }

  // ---- URL ----
  const base = new URL(service.baseUrl);
  let path = tool.path;
  for (const p of tool.params.filter((x) => x.in === 'path')) {
    path = path.replaceAll(`{${p.name}}`, encodeURIComponent(String(values.get(p.name))));
  }
  const url = new URL(path, base);
  for (const p of tool.params.filter((x) => x.in === 'query')) {
    const v = values.get(p.name);
    if (v !== undefined) url.searchParams.set(p.name, String(v));
  }

  // ---- network guard (outbound surface #3; #85 policy switch) ----
  // `open` (the default): any host dials — only the metadata/link-local
  // ranges stay hard-denied (that guard is not a policy). `restricted`:
  // the #80 default-deny allowlist, internal-flagged entries included.
  const settings = await deps.uow.settings.get();
  const restricted = (settings.apiToolOutbound ?? 'open') === 'restricted';
  let entry: ApiToolAllowlistEntry | null = null;
  if (restricted) {
    entry = matchAllowlist(url.hostname, settings.apiToolAllowlist ?? []);
    if (entry === null) {
      return err(`error: host ${url.hostname} is not on the API tool allowlist`);
    }
  }
  const resolve = opts.resolveDns ?? defaultResolve;
  let ips: string[];
  try {
    ips = isLiteralIp(url.hostname) ? [url.hostname] : await resolve(url.hostname);
  } catch {
    return err(`error: DNS resolution failed for ${url.hostname}`);
  }
  if (ips.length === 0) return err(`error: no addresses for ${url.hostname}`);
  for (const ip of ips) {
    const cls = ipClassOf(ip);
    // Metadata/link-local is hard-denied in EVERY policy, even internal
    // entries — cloud metadata is never a legitimate API tool target.
    if (cls === 'link-local')
      return err(`error: ${url.hostname} resolves to link-local ${ip} — denied`);
    if (restricted && cls !== 'public' && entry !== null && entry.internal !== true) {
      return err(
        `error: ${url.hostname} resolves to ${cls} ${ip}; only internal-flagged allowlist entries may reach it`,
      );
    }
  }

  // ---- headers (static + header params + auth-injected secret) ----
  const headers: Record<string, string> = { ...service.headers };
  for (const p of tool.params.filter((x) => x.in === 'header')) {
    const v = values.get(p.name);
    if (v !== undefined) headers[p.name] = String(v);
  }
  if (service.auth !== undefined) {
    const credential = await resolveCredential(deps, service);
    if (credential === null) {
      return err(`error: credential "${service.auth.credentialName}" is no longer available`);
    }
    if (service.auth.style === 'bearer') headers.Authorization = `Bearer ${credential}`;
    else headers[service.auth.header] = credential;
  }

  // ---- body ----
  let body: string | undefined;
  const bodyParams = tool.params.filter((x) => x.in === 'body');
  if (bodyParams.length > 0) {
    const single = bodyParams.length === 1 ? values.get(bodyParams[0]!.name) : undefined;
    if (tool.bodyType === 'form') {
      const form = new URLSearchParams();
      for (const p of bodyParams) form.set(p.name, String(values.get(p.name)));
      body = form.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(
        single !== undefined
          ? single
          : Object.fromEntries(bodyParams.map((p) => [p.name, values.get(p.name)])),
      );
      headers['Content-Type'] = 'application/json';
    }
  }

  // ---- fetch (timeout; body read capped) ----
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: tool.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const elapsed = Date.now() - started;
    const reason = e instanceof Error ? e.message : String(e);
    return err(`error: request failed after ${elapsed}ms: ${reason}`);
  }

  let text: string;
  try {
    text = await readCapped(res);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(`error: reading response failed: ${reason}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  const shaped = applyResponse(tool, res.status, contentType, text);
  return {
    ...shaped,
    debug: { method: tool.method, url: url.toString(), status: res.status, contentType },
  };
}

async function resolveCredential(
  deps: ApiToolExecDeps,
  service: ApiToolService,
): Promise<string | null> {
  if (service.auth === undefined) return null;
  const name = service.auth.credentialName;
  const global = await deps.uow.credentials.findByName(name, 'global');
  const personal =
    global === null && service.ownerId !== null
      ? await deps.uow.credentials.findByName(name, 'personal', service.ownerId)
      : null;
  const row = global ?? personal;
  if (row === null) return null;
  return decryptSecret(row.secret, deps.credentialEncryptionKey);
}

async function readCapped(res: Response): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RAW_BODY_READ_CAP) {
      throw new Error(`response body exceeds the ${RAW_BODY_READ_CAP} byte read cap`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
