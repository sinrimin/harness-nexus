// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachSessionsHandlers } from '../src/daemon/sessions.js';
import type { AgentConnection } from '../src/daemon/acp/agent-connection.js';

/**
 * sessions:delete (#55) — the rail's delete, per target arm:
 *
 *   claude-code/codex/opencode — `session/delete` on a live connection or a
 *     short-lived adapter spawn, capability-gated (codex-acp / opencode 1.x
 *     advertise no `delete` and must fail with a clear reason, not a
 *     method-not-found);
 *   deepseek — rm -rf of `~/.dsh/sessions/<slug>/<id>/` (idempotent);
 *   pi — unlink of the session file (idempotent);
 *   every arm — a live channel on the session refuses the delete.
 */

const FIXTURE = new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname;

class FakeSocket {
  emitted: { event: string; payload: unknown; ack?: (res: unknown) => void }[] = [];
  handlers = new Map<string, (payload: unknown, ack?: (res: unknown) => void) => void>();

  emit(event: string, payload: unknown, ack?: (res: unknown) => void): boolean {
    if (ack !== undefined) this.emitted.push({ event, payload, ack });
    else this.emitted.push({ event, payload });
    return true;
  }

  on(event: string, handler: (payload: unknown, ack?: (res: unknown) => void) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  receive(event: string, payload: unknown, ack?: (res: unknown) => void): void {
    this.handlers.get(event)?.(payload, ack);
  }

  deleteResultOf(requestId: string): { error?: string } | undefined {
    for (const e of this.emitted) {
      if (e.event !== 'sessions:delete:result') continue;
      const p = e.payload as { requestId?: string };
      if (p.requestId === requestId) return e.payload as { error?: string };
    }
    return undefined;
  }
}

function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const ENV = (command: string): NodeJS.ProcessEnv => ({
  HN_ACP_COMMAND_CLAUDE_CODE: command,
  HN_ACP_COMMAND_CODEX: command,
  HN_ACP_COMMAND_OPENCODE: command,
  PATH: process.env.PATH ?? '',
});

/** A dsh-shaped home: one session directory under a cwd slug. */
function makeDshHome(sessionId: string): string {
  const home = mkdtempSync(join(tmpdir(), 'hnx-del-dsh-'));
  const dir = join(home, '.dsh', 'sessions', 'tmp', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '');
  return home;
}

/** A pi-shaped home: one session file under a cwd group. */
function makePiHome(sessionId: string): string {
  const home = mkdtempSync(join(tmpdir(), 'hnx-del-pi-'));
  const group = join(home, '.pi', 'agent', 'sessions', '----tmp--');
  mkdirSync(group, { recursive: true });
  writeFileSync(
    join(group, `1760000000000_${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'session', version: 1, id: sessionId, cwd: '/tmp' })}\n`,
  );
  return home;
}

const LIVE: AgentConnection = {
  pgid: null,
  request: async () => ({}),
  respondPermission: () => {},
  respondElicitation: () => {},
  setNotificationHandler: () => {},
  setPermissionHandler: () => {},
  setElicitationHandler: () => {},
  onExit: () => {},
  isGroupAlive: () => false,
  kill: () => {},
};

describe('sessions:delete (#55)', () => {
  it('claude-code — the spawn path forwards session/delete to the adapter', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'hnx-del-log-')), 'deletes');
    process.env.FIXTURE_DELETE_LOG = log;
    try {
      const socket = new FakeSocket();
      attachSessionsHandlers(socket as never, {
        env: ENV(`node ${FIXTURE}`),
        homeDir: mkdtempSync(join(tmpdir(), 'hnx-del-home-')),
      });

      socket.receive('sessions:delete', {
        requestId: 'd1',
        target: 'claude-code',
        sessionId: 'fx-1',
      });
      const result = await waitFor(() => socket.deleteResultOf('d1'));
      expect(result.error).toBeUndefined();
      // The request reached the AGENT (the fixture logged the id).
      expect(readFileSync(log, 'utf8')).toBe('fx-1\n');
    } finally {
      delete process.env.FIXTURE_DELETE_LOG;
    }
  });

  it('claude-code — a live connection answers with zero spawns', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'hnx-del-log-')), 'deletes');
    process.env.FIXTURE_DELETE_LOG = log;
    const socket = new FakeSocket();
    let liveDeletes = 0;
    const live: AgentConnection = {
      ...LIVE,
      request: async (method) => {
        if (method === 'session/delete') liveDeletes++;
        return {};
      },
    };
    attachSessionsHandlers(socket as never, {
      env: ENV(`node ${FIXTURE}`),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-del-home-')),
      liveConnectionFor: () => live,
    });

    socket.receive('sessions:delete', {
      requestId: 'd2',
      target: 'claude-code',
      sessionId: 'fx-2',
    });
    const result = await waitFor(() => socket.deleteResultOf('d2'));
    expect(result.error).toBeUndefined();
    expect(liveDeletes).toBe(1);
    // The spawn path never ran — the fixture logged nothing.
    expect(existsSync(log)).toBe(false);
  });

  it('an adapter without the delete capability fails with a clear reason', async () => {
    process.env.FIXTURE_ACP_NO_DELETE = '1';
    try {
      const socket = new FakeSocket();
      attachSessionsHandlers(socket as never, {
        env: ENV(`node ${FIXTURE}`),
        homeDir: mkdtempSync(join(tmpdir(), 'hnx-del-home-')),
      });

      // opencode 1.x shape: the adapter advertises no `delete` cap. (codex
      // no longer routes here — Phase B rides the CLI, see the codex block.)
      socket.receive('sessions:delete', { requestId: 'd3', target: 'opencode', sessionId: 'x' });
      const result = await waitFor(() => socket.deleteResultOf('d3'));
      expect(result.error).toContain('does not support session/delete');
    } finally {
      delete process.env.FIXTURE_ACP_NO_DELETE;
    }
  });

  it('deepseek — removes the session directory, idempotently', async () => {
    const home = makeDshHome('ds-1');
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: { PATH: process.env.PATH ?? '' },
      homeDir: home,
    });

    socket.receive('sessions:delete', { requestId: 'd4', target: 'deepseek', sessionId: 'ds-1' });
    const r1 = await waitFor(() => socket.deleteResultOf('d4'));
    expect(r1.error).toBeUndefined();
    expect(existsSync(join(home, '.dsh', 'sessions', 'tmp', 'ds-1'))).toBe(false);

    // Already gone — still a success (ACP idempotency, kept for files too).
    socket.receive('sessions:delete', { requestId: 'd5', target: 'deepseek', sessionId: 'ds-1' });
    const r2 = await waitFor(() => socket.deleteResultOf('d5'));
    expect(r2.error).toBeUndefined();
  });

  it('pi — unlinks the session file, idempotently', async () => {
    const home = makePiHome('pi-1');
    const file = join(home, '.pi', 'agent', 'sessions', '----tmp--', '1760000000000_pi-1.jsonl');
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: { PATH: process.env.PATH ?? '' },
      homeDir: home,
    });

    socket.receive('sessions:delete', { requestId: 'd6', target: 'pi', sessionId: 'pi-1' });
    const r1 = await waitFor(() => socket.deleteResultOf('d6'));
    expect(r1.error).toBeUndefined();
    expect(existsSync(file)).toBe(false);

    socket.receive('sessions:delete', { requestId: 'd7', target: 'pi', sessionId: 'pi-1' });
    const r2 = await waitFor(() => socket.deleteResultOf('d7'));
    expect(r2.error).toBeUndefined();
  });

  it('a live channel on the session refuses the delete, for every arm', async () => {
    for (const target of ['claude-code', 'deepseek', 'pi'] as const) {
      const socket = new FakeSocket();
      const home =
        target === 'deepseek'
          ? makeDshHome('live-1')
          : target === 'pi'
            ? makePiHome('live-1')
            : mkdtempSync(join(tmpdir(), 'hnx-del-home-'));
      attachSessionsHandlers(socket as never, {
        env: ENV(`node ${FIXTURE}`),
        homeDir: home,
        liveNativeIdsFor: (t) => (t === target ? new Set(['live-1']) : new Set()),
      });

      socket.receive('sessions:delete', {
        requestId: `d-${target}`,
        target,
        sessionId: 'live-1',
      });
      const result = await waitFor(() => socket.deleteResultOf(`d-${target}`));
      expect(result.error).toContain('close it first');
      // The dsh directory survived the refusal.
      if (target === 'deepseek') {
        expect(existsSync(join(home, '.dsh', 'sessions', 'tmp', 'live-1'))).toBe(true);
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('rejects malformed payloads and answers unsupported targets', async () => {
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV(`node ${FIXTURE}`),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-del-home-')),
    });

    const ackResults: unknown[] = [];
    const ack = (res: unknown): void => {
      ackResults.push(res);
    };
    socket.receive('sessions:delete', 'nonsense', ack);
    socket.receive('sessions:delete', { requestId: 'x1', target: 'hermes', sessionId: 's' }, ack);
    const result = await waitFor(() => socket.deleteResultOf('x1'));
    expect(result.error).toContain('no native session surface');
    expect(ackResults).toEqual([{ error: 'proto:invalid' }, { accepted: true }]);
  });
});

/**
 * #55 Phase B — the codex arm rides the codex CLI's own `codex delete
 * --force <uuid>` (adapter ≤0.16.0 has no session/delete; only the CLI
 * cleans the rollout + index + state together). The CLI is NOT idempotent —
 * the ROLLOUT FILE is the arm's truth, so: absent = success without a
 * spawn; a nonzero exit with the file verifiably gone = success (race).
 */
describe('sessions:delete — codex rides codex delete (Phase B)', () => {
  /** A fake `codex` bin: logs argv, removes the matching rollout (cwd = home). */
  function makeFakeCodex(): { binDir: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-del-codex-'));
    const marker = join(dir, 'argv');
    const script = join(dir, 'codex');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `echo "$@" >> ${JSON.stringify(marker)}`,
        'id="$3"',
        // boom-*: fail like the real CLI without touching the file.
        'case "$id" in boom-*) echo "failed to delete session" >&2; exit 1;; esac',
        'f=$(find .codex/sessions -name "*$id*" | head -1)',
        'if [ -z "$f" ]; then echo "failed to delete session" >&2; exit 1; fi',
        'rm "$f"',
        // race-*: the file went away but the CLI still reports failure.
        'case "$id" in race-*) echo "failed to delete session" >&2; exit 1;; esac',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(script, 0o755);
    return { binDir: dir, marker };
  }

  /** A codex-shaped home: one rollout file under the YYYY/MM/DD tree. */
  function makeCodexHome(sessionId: string): string {
    const home = mkdtempSync(join(tmpdir(), 'hnx-del-cxhome-'));
    const dir = join(home, '.codex', 'sessions', '2026', '10', '15');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-15T00-00-00-${sessionId}.jsonl`), '{}\n');
    return home;
  }

  const ENV_CODEX = (binDir: string): NodeJS.ProcessEnv => ({
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  });

  it('happy path — codex delete --force <uuid> runs and the rollout goes', async () => {
    const { binDir, marker } = makeFakeCodex();
    const home = makeCodexHome('cx-1');
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, { env: ENV_CODEX(binDir), homeDir: home });

    socket.receive('sessions:delete', { requestId: 'c1', target: 'codex', sessionId: 'cx-1' });
    const result = await waitFor(() => socket.deleteResultOf('c1'));
    expect(result.error).toBeUndefined();
    expect(readFileSync(marker, 'utf8').trim()).toBe('delete --force cx-1');
    // The CLI removed the rollout file (its day dir may stay — not our truth).
    expect(existsSync(join(home, '.codex', 'sessions', '2026', '10', '15'))).toBe(true);
    expect(readdirSync(join(home, '.codex', 'sessions', '2026', '10', '15'))).toEqual([]);
  });

  it('absent rollout = success WITHOUT spawning the CLI (idempotent)', async () => {
    const { binDir, marker } = makeFakeCodex();
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV_CODEX(binDir),
      homeDir: makeCodexHome('other-id'),
    });

    socket.receive('sessions:delete', { requestId: 'c2', target: 'codex', sessionId: 'cx-x' });
    const result = await waitFor(() => socket.deleteResultOf('c2'));
    expect(result.error).toBeUndefined();
    expect(existsSync(marker)).toBe(false); // the CLI never ran
  });

  it('a CLI failure with the file still present surfaces the error', async () => {
    const { binDir } = makeFakeCodex();
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV_CODEX(binDir),
      homeDir: makeCodexHome('boom-1'),
    });

    socket.receive('sessions:delete', { requestId: 'c3', target: 'codex', sessionId: 'boom-1' });
    const result = await waitFor(() => socket.deleteResultOf('c3'));
    expect(result.error).toContain('codex delete failed');
  });

  it('a CLI failure with the file verifiably gone still counts (race)', async () => {
    const { binDir } = makeFakeCodex();
    const home = makeCodexHome('race-1');
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, { env: ENV_CODEX(binDir), homeDir: home });

    socket.receive('sessions:delete', { requestId: 'c4', target: 'codex', sessionId: 'race-1' });
    const result = await waitFor(() => socket.deleteResultOf('c4'));
    expect(result.error).toBeUndefined();
  });
});
