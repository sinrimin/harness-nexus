// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  sessionsDeleteRequestSchema,
  sessionsListRequestSchema,
  type NativeSessionView,
} from '@harness-nexus/shared';
import { AcpAgentConnection, type AgentConnection } from './acp/agent-connection.js';
import { resolveAcpCommand } from './acp/adapters.js';
import {
  currentCatalogModels,
  dshListSessions,
  findSessionDir,
  nativeZstd,
} from './dsh-sessions.js';
import { piFindSessionFile, piSessionViews } from './pi-sessions.js';

/**
 * Native session listing (Phase 9 W7) — the chat rail's data source. The
 * platform persists nothing session-shaped; this answers `sessions:list` from
 * whatever the TARGET itself holds:
 *
 *   claude-code / codex / opencode — a short-lived ACP adapter spawn +
 *     `session/list` (the adapter IS the vendor's session list; no
 *     storage-format coupling). opencode joined 9 W13: its ACP surface has
 *     list + load + resume with full SessionInfo (title/cwd/updatedAt) —
 *     verified against 1.18.31 on the rig; the W12 "no session/list" note
 *     was wrong.
 *   deepseek — a pure file scan of `~/.dsh/sessions` (no spawn, no auth; dsh's
 *     own list returns neither title nor time, so both come from the
 *     transcript header + mtime).
 *   pi — a pure file scan of `~/.pi/agent/sessions` (9 W16): plain JSONL,
 *     identity/cwd from the `session` header line, title from the last
 *     `session_info`, model from the last `model_change`, recency = mtime.
 *   hermes / zcode / generic — no verified native surface: `supported:false`.
 */

export interface SessionsHandlersOptions {
  /** Env source for `HN_ACP_COMMAND_<TARGET>` overrides. */
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests. */
  homeDir?: string;
  /**
   * 9 W11 D — listing cache TTL override (tests). Env: `SESSIONS_CACHE_TTL_MS`,
   * default 15s, 0 = off.
   */
  cacheTtlMs?: number;
  /**
   * Issue #2 — live-channel lookup from `attachChatHandlers`' handle. When a
   * channel for the target is live, its adapter connection answers
   * `session/list` directly (a concurrent JSON-RPC request — no spawn);
   * absent or failing falls back to the short-lived spawn.
   */
  liveConnectionFor?: (target: string) => AgentConnection | null;
  /**
   * #55 — the target's live channels' NATIVE session ids (the delete guard:
   * a session an open channel is attached to must be closed first).
   */
  liveNativeIdsFor?: (target: string) => Set<string>;
}

export function attachSessionsHandlers(socket: Socket, opts: SessionsHandlersOptions = {}): void {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const ttlMs =
    opts.cacheTtlMs ??
    (() => {
      const raw = Number.parseInt(env.SESSIONS_CACHE_TTL_MS ?? '', 10);
      return Number.isFinite(raw) ? Math.max(raw, 0) : 15_000;
    })();

  /**
   * 9 W11 D — listing TTL cache, keyed by target (one machine per daemon).
   * Every rail paint otherwise pays an adapter spawn (claude/codex) or a
   * zstd file walk (dsh); a hit answers without either. `refresh` bypasses
   * (the rail's manual refresh button), failures never cache, and
   * concurrent requests share the in-flight computation.
   */
  const cache = new Map<string, { expiresAt: number; sessions: NativeSessionView[] }>();
  const inFlight = new Map<string, Promise<NativeSessionView[]>>();
  const listCached = (
    target: string,
    refresh: boolean,
    compute: () => Promise<NativeSessionView[]>,
  ): Promise<NativeSessionView[]> => {
    const cached = cache.get(target);
    if (!refresh && cached !== undefined && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.sessions);
    }
    let p = inFlight.get(target);
    if (p === undefined) {
      p = compute().then((sessions) => {
        if (ttlMs > 0) cache.set(target, { expiresAt: Date.now() + ttlMs, sessions });
        return sessions;
      });
      p.finally(() => inFlight.delete(target)).catch(() => {});
      inFlight.set(target, p);
    }
    return p;
  };

  socket.on('sessions:list', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = sessionsListRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, target, refresh } = parsed.data;
    void (async () => {
      try {
        if (target === 'claude-code' || target === 'codex' || target === 'opencode') {
          socket.emit('sessions:list:result', {
            requestId,
            sessions: await listCached(target, refresh === true, () =>
              listAdapterSessions(target, env, opts.liveConnectionFor),
            ),
          });
          return;
        }
        if (target === 'deepseek') {
          socket.emit('sessions:list:result', {
            requestId,
            sessions: await listCached(target, refresh === true, async () => listDsh(home)),
          });
          return;
        }
        if (target === 'pi') {
          socket.emit('sessions:list:result', {
            requestId,
            sessions: await listCached(target, refresh === true, async () =>
              piSessionViews(join(home, '.pi', 'agent', 'sessions'), {
                readdir: (p) => readdirSync(p),
                readFile: (p) => readFileSync(p),
                stat: (p) => statSync(p),
              }),
            ),
          });
          return;
        }
        socket.emit('sessions:list:result', { requestId, supported: false });
      } catch (e) {
        socket.emit('sessions:list:result', {
          requestId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });

  /**
   * #55 — delete one of the target's native sessions. Same
   * request/result round-trip as the listing; idempotent (a session that is
   * already gone succeeds — ACP `session/delete` semantics, kept for the
   * file-backed targets too). A successful delete also drops the target's
   * listing cache so the next rail paint reflects the removal.
   */
  socket.on('sessions:delete', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = sessionsDeleteRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, target, sessionId } = parsed.data;
    void (async () => {
      try {
        await deleteNativeSession(target, sessionId, {
          env,
          home,
          ...(opts.liveConnectionFor !== undefined
            ? { liveConnectionFor: opts.liveConnectionFor }
            : {}),
          ...(opts.liveNativeIdsFor !== undefined
            ? { liveNativeIdsFor: opts.liveNativeIdsFor }
            : {}),
        });
        cache.delete(target);
        socket.emit('sessions:delete:result', { requestId });
      } catch (e) {
        socket.emit('sessions:delete:result', {
          requestId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });
}

/** Per-target deletion (#55) — mirrors the listing's dispatch table. */
async function deleteNativeSession(
  target: string,
  sessionId: string,
  opts: {
    env: NodeJS.ProcessEnv;
    home: string;
    liveConnectionFor?: (target: string) => AgentConnection | null;
    liveNativeIdsFor?: (target: string) => Set<string>;
  },
): Promise<void> {
  // Live-channel guard (all targets): the server refuses live rows first,
  // this re-checks against the daemon's own channel table so a racing open
  // cannot slip under the delete.
  if (opts.liveNativeIdsFor?.(target).has(sessionId) === true) {
    throw new Error('session is open in a live channel — close it first');
  }
  if (target === 'claude-code' || target === 'opencode') {
    return deleteAdapterSession(target, sessionId, opts.env, opts.liveConnectionFor);
  }
  if (target === 'codex') {
    // Phase B: the adapter (≤0.16.0) has no session/delete, and codex
    // sessions are NOT safely unlinkable — the CLI's own `codex delete`
    // cleans the rollout file, the session index, and SQLite state together.
    return deleteCodexSession(sessionId, { env: opts.env, home: opts.home });
  }
  if (target === 'deepseek') {
    // The session id IS the directory name under a cwd slug; the whole
    // directory (log + whatever else dsh keeps beside it) goes.
    const dir = findSessionDir(join(opts.home, '.dsh', 'sessions'), sessionId, readdirSync);
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    return; // absent = already gone = success (idempotent)
  }
  if (target === 'pi') {
    const file = piFindSessionFile(
      join(opts.home, '.pi', 'agent', 'sessions'),
      {
        readdir: (p) => readdirSync(p),
        readFile: (p) => readFileSync(p),
      },
      sessionId,
    );
    if (file !== null) rmSync(file, { force: true });
    return; // idempotent, same as dsh
  }
  throw new Error(`target '${target}' has no native session surface`);
}

/**
 * The ACP pair: `session/delete` (stabilized 2026-06) on a live channel's
 * connection when one is up, else a short-lived adapter spawn — the same
 * two-path shape as the listing. The spawn path is CAPABILITY-GATED: an
 * adapter that did not advertise `sessionCapabilities.delete` (opencode 1.x
 * today) gets a clear unsupported error instead of a method-not-found
 * rejection.
 */
async function deleteAdapterSession(
  target: 'claude-code' | 'opencode',
  sessionId: string,
  env: NodeJS.ProcessEnv,
  liveConnectionFor?: (target: string) => AgentConnection | null,
): Promise<void> {
  const live = liveConnectionFor?.(target) ?? null;
  if (live !== null) {
    try {
      await live.request('session/delete', { sessionId }, 10_000);
      return;
    } catch {
      // fall through — the spawn path is the fallback, never a dead end
    }
  }
  const cmd = resolveAcpCommand(target, env);
  if (cmd === null) throw new Error(`no ACP adapter for target '${target}'`);
  const { conn, sessionCaps } = await AcpAgentConnection.start(cmd.command, cmd.args, {
    cwd: homedir(),
    // #70 — daemon env as the base, target env layered on top.
    env: { ...process.env, ...(cmd.env ?? {}) },
  });
  try {
    if (!sessionCaps.delete) {
      throw new Error(`adapter for '${target}' does not support session/delete`);
    }
    await conn.request('session/delete', { sessionId }, 10_000);
  } finally {
    conn.kill();
  }
}

/**
 * #55 Phase B — codex deletion rides the codex CLI's own `codex delete
 * --force <uuid>` (the app-server thread/delete path: rollout file + session
 * index + SQLite state cleaned together; rig-verified on codex-cli 0.154.0 —
 * the ACP sessionId IS the rollout uuid, and `--force` is required
 * headless). The CLI is NOT idempotent (a repeat exits 1 "failed to delete
 * session"), so the ROLLOUT FILE is this arm's truth: absent = already gone
 * = success, and a nonzero exit still counts when the file verifiably went
 * away (a race settled in our favor).
 */
async function deleteCodexSession(
  sessionId: string,
  opts: { env: NodeJS.ProcessEnv; home: string },
): Promise<void> {
  const sessionsDir = join(opts.home, '.codex', 'sessions');
  if (findCodexRollout(sessionsDir, sessionId) === null) return; // idempotent
  const res = await runCodex(['delete', '--force', sessionId], opts);
  if (!res.ok && findCodexRollout(sessionsDir, sessionId) === null) return;
  if (!res.ok) throw new Error(`codex delete failed: ${res.stderr}`);
}

/** The session's rollout file by id under the YYYY/MM/DD tree (null = absent). */
export function findCodexRollout(sessionsDir: string, sessionId: string): string | null {
  const readDir = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const year of readDir(sessionsDir)) {
    for (const month of readDir(join(sessionsDir, year))) {
      for (const day of readDir(join(sessionsDir, year, month))) {
        const dir = join(sessionsDir, year, month, day);
        for (const file of readDir(dir)) {
          if (file.includes(sessionId)) return join(dir, file);
        }
      }
    }
  }
  return null;
}

/** Run the codex CLI (bounded, stderr kept short for the error arm). */
function runCodex(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; home: string },
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('codex', args, { cwd: opts.home, env: opts.env });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-512);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr: stderr.trim() });
    });
  });
}

/** dsh's file-scan listing, mapped to rail rows (pure — no spawn, no auth). */
function listDsh(home: string): NativeSessionView[] {
  const zstd = nativeZstd();
  if (zstd === null) {
    throw new Error('dsh session transcripts need Node >= 22.15 (zstd) on the daemon');
  }
  const catalog = (() => {
    try {
      return currentCatalogModels(readFileSync(join(home, '.dsh', 'settings.yaml'), 'utf8'));
    } catch {
      return null; // no settings yet — nothing to compare against
    }
  })();
  return dshListSessions(
    join(home, '.dsh', 'sessions'),
    {
      readdir: (p) => readdirSync(p),
      readFile: (p) => readFileSync(p),
      stat: (p) => statSync(p),
    },
    zstd,
    { maxSessions: 200 },
  ).map((s): NativeSessionView => {
    // dsh validates the session's PINNED (provider, model) against
    // the live catalog at resume — a provider-config change orphans
    // old sessions. Flag them here so the rail explains instead of
    // offering a guaranteed failure.
    if (s.model !== null && catalog !== null && !catalog.has(s.model)) {
      return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        ...(s.title !== null ? { title: s.title } : {}),
        ...(s.updatedAt !== null ? { updatedAt: s.updatedAt } : {}),
        model: s.model,
        staleReason: 'model-missing',
      };
    }
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      ...(s.title !== null ? { title: s.title } : {}),
      ...(s.updatedAt !== null ? { updatedAt: s.updatedAt } : {}),
      ...(s.model !== null ? { model: s.model } : {}),
    };
  });
}

/**
 * Issue #2 — answer the rail without a spawn whenever a live channel's
 * adapter can serve it: `session/list` is a plain concurrent request on the
 * channel's connection (the wrapper reads the session store off disk — no
 * session needed), the same trick the reference portal rides its resident
 * adapter for. Any failure (dead connection, mid-turn stall, no such method)
 * falls back to the short-lived spawn.
 */
async function listAdapterSessions(
  target: 'claude-code' | 'codex' | 'opencode',
  env: NodeJS.ProcessEnv,
  liveConnectionFor?: (target: string) => AgentConnection | null,
): Promise<NativeSessionView[]> {
  const live = liveConnectionFor?.(target) ?? null;
  if (live !== null) {
    try {
      return parseSessionList(await live.request('session/list', {}, 10_000));
    } catch {
      // fall through — spawn path is the fallback, never a dead end
    }
  }
  return listViaAdapter(target, env);
}

/** Spawn the target's adapter, `session/list`, kill. Bounded, best-effort. */
async function listViaAdapter(
  target: 'claude-code' | 'codex' | 'opencode',
  env: NodeJS.ProcessEnv,
): Promise<NativeSessionView[]> {
  const cmd = resolveAcpCommand(target, env);
  if (cmd === null) throw new Error(`no ACP adapter for target '${target}'`);
  const { conn, sessionCaps } = await AcpAgentConnection.start(cmd.command, cmd.args, {
    cwd: homedir(),
    // #70 — daemon env as the base, target env layered on top (the pinned
    // shims need a PATH for `#!/usr/bin/env node`).
    env: { ...process.env, ...(cmd.env ?? {}) },
  });
  try {
    if (!sessionCaps.list) throw new Error(`adapter for '${target}' does not support session/list`);
    return parseSessionList(await conn.request('session/list', {}, 10000));
  } finally {
    conn.kill();
  }
}

/** Absolute in EITHER flavor: POSIX `/…` or a Windows drive letter (#43 —
 * a `/`-only check silently dropped every Windows row and the rail showed
 * nothing, live sessions included). */
export function isAbsoluteCwd(cwd: string): boolean {
  return cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd);
}

/** A raw `session/list` result → bounded rail rows (shared by both paths). */
export function parseSessionList(result: unknown): NativeSessionView[] {
  const r0 = (result ?? {}) as { sessions?: unknown };
  const raw = Array.isArray(r0.sessions) ? (r0.sessions as unknown[]) : [];
  const out: NativeSessionView[] = [];
  for (const s of raw.slice(0, 200)) {
    if (s === null || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    if (typeof r['sessionId'] !== 'string' || r['sessionId'] === '') continue;
    if (typeof r['cwd'] !== 'string' || !isAbsoluteCwd(r['cwd'])) continue;
    out.push({
      sessionId: r['sessionId'],
      cwd: r['cwd'],
      ...(typeof r['title'] === 'string' && r['title'] !== ''
        ? { title: r['title'].slice(0, 256) }
        : {}),
      // Adapters speak different timestamp dialects (codex-acp's chrono
      // emits `+00:00` offsets). Normalize to ISO-Z when parseable and
      // DROP the field when not — a malformed timestamp must never fail
      // the whole listing downstream.
      ...isoTimestamp(r['updatedAt']),
    });
  }
  return out;
}

/** `{updatedAt}` only when the value parses as a real timestamp (ISO-Z normalized). */
function isoTimestamp(value: unknown): { updatedAt?: string } {
  if (typeof value !== 'string' || value === '') return {};
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return {};
  return { updatedAt: new Date(ms).toISOString() };
}
