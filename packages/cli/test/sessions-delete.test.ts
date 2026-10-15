import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

      socket.receive('sessions:delete', { requestId: 'd3', target: 'codex', sessionId: 'x' });
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
