import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachSessionsHandlers } from '../src/daemon/sessions.js';
import type { AgentConnection } from '../src/daemon/acp/agent-connection.js';

/**
 * sessions:list TTL cache (Phase 9 W11 D): a rail paint used to pay an
 * adapter spawn every time. The cache answers hits without spawning;
 * `refresh` bypasses; failures never cache; concurrent requests share the
 * in-flight computation. Spawn counting: the ACP command is a wrapper that
 * appends to a marker file then runs the fixture agent.
 */

const FIXTURE = new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname;

/** Minimal socket.io-client stand-in: records emits, lets tests deliver. */
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

  resultOf(requestId: string): { sessions?: unknown[]; supported?: boolean; error?: string } {
    for (const e of this.emitted) {
      if (e.event !== 'sessions:list:result') continue;
      const p = e.payload as { requestId?: string };
      if (p.requestId === requestId) return e.payload as Record<string, unknown>;
    }
    return {};
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

/** A wrapper ACP command that counts spawns, then runs the fixture agent. */
function makeCountedAdapter(): { command: string; spawns: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'hnx-sessions-cache-'));
  const marker = join(dir, 'spawns');
  const wrapper = join(dir, 'wrap.mjs');
  writeFileSync(marker, '');
  writeFileSync(
    wrapper,
    `import { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(marker)}, '1');\n` +
      `await import(${JSON.stringify(FIXTURE)});\n`,
  );
  return { command: `node ${wrapper}`, spawns: () => readFileSync(marker, 'utf8').length };
}

const ENV = (command: string): NodeJS.ProcessEnv => ({
  HN_ACP_COMMAND_CLAUDE_CODE: command,
  HN_ACP_COMMAND_CODEX: command,
  HN_ACP_COMMAND_OPENCODE: command,
  PATH: process.env.PATH ?? '',
});

describe('sessions:list TTL cache (9 W11 D)', () => {
  it('a hit answers without spawning; refresh bypasses and respawns', async () => {
    const adapter = makeCountedAdapter();
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV(adapter.command),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
      cacheTtlMs: 60_000,
    });

    socket.receive('sessions:list', { requestId: 'r1', target: 'claude-code' });
    const r1 = await waitFor(() => {
      const r = socket.resultOf('r1');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(r1.sessions).toHaveLength(1);
    expect(adapter.spawns()).toBe(1);

    // Cache hit — same rows, no new adapter process.
    socket.receive('sessions:list', { requestId: 'r2', target: 'claude-code' });
    const r2 = await waitFor(() => {
      const r = socket.resultOf('r2');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(r2.sessions).toEqual(r1.sessions);
    expect(adapter.spawns()).toBe(1);

    // `refresh` bypasses the cache and pays the spawn again.
    socket.receive('sessions:list', { requestId: 'r3', target: 'claude-code', refresh: true });
    await waitFor(() => {
      const r = socket.resultOf('r3');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(adapter.spawns()).toBe(2);
  });

  it('expired entries recompute on the next request', async () => {
    const adapter = makeCountedAdapter();
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV(adapter.command),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
      cacheTtlMs: 40,
    });

    socket.receive('sessions:list', { requestId: 'r1', target: 'codex' });
    await waitFor(() => {
      const r = socket.resultOf('r1');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(adapter.spawns()).toBe(1);

    await new Promise((r) => setTimeout(r, 80));
    socket.receive('sessions:list', { requestId: 'r2', target: 'codex' });
    await waitFor(() => {
      const r = socket.resultOf('r2');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(adapter.spawns()).toBe(2);
  });

  it('opencode rides the adapter arm (9 W13 — its ACP has list/load/resume)', async () => {
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV(`node ${FIXTURE}`),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
    });

    socket.receive('sessions:list', { requestId: 'oc1', target: 'opencode' });
    const r = await waitFor(() => {
      const res = socket.resultOf('oc1');
      return res.sessions !== undefined ? res : undefined;
    });
    expect(r.sessions).toHaveLength(1);
  });

  it('concurrent requests share one in-flight computation', async () => {
    const adapter = makeCountedAdapter();
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV(adapter.command),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
      cacheTtlMs: 60_000,
    });

    socket.receive('sessions:list', { requestId: 'a', target: 'claude-code' });
    socket.receive('sessions:list', { requestId: 'b', target: 'claude-code' });
    const [ra, rb] = await Promise.all([
      waitFor(() => {
        const r = socket.resultOf('a');
        return r.sessions !== undefined ? r : undefined;
      }),
      waitFor(() => {
        const r = socket.resultOf('b');
        return r.sessions !== undefined ? r : undefined;
      }),
    ]);
    expect(ra.sessions).toEqual(rb.sessions);
    expect(adapter.spawns()).toBe(1);
  });

  it('failures never cache — the next request retries the spawn', async () => {
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: { HN_ACP_COMMAND_CLAUDE_CODE: 'definitely-not-a-command-12345', PATH: '/nonexistent' },
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
      cacheTtlMs: 60_000,
    });

    socket.receive('sessions:list', { requestId: 'e1', target: 'claude-code' });
    const e1 = await waitFor(() => {
      const r = socket.resultOf('e1');
      return r.error !== undefined ? r : undefined;
    });
    expect(e1.error).toBeTruthy();

    // Not cached: the same failure path runs again (and would succeed if
    // the command were fixed).
    socket.receive('sessions:list', { requestId: 'e2', target: 'claude-code' });
    await waitFor(() => {
      const r = socket.resultOf('e2');
      return r.error !== undefined ? r : undefined;
    });
  });

  it('acks, rejects malformed payloads, and passes unsupported targets through', async () => {
    const socket = new FakeSocket();
    attachSessionsHandlers(socket as never, {
      env: ENV(makeCountedAdapter().command),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
    });

    const ackResults: unknown[] = [];
    const ack = (res: unknown): void => {
      ackResults.push(res);
    };
    socket.receive('sessions:list', 'nonsense', ack);
    socket.receive('sessions:list', { requestId: 'x1', target: 'hermes' }, ack);
    await waitFor(() => {
      const r = socket.resultOf('x1');
      return r.supported === false ? r : undefined;
    });
    // Malformed → proto:invalid ack, no result event; unsupported target →
    // accepted ack + `supported:false` result.
    expect(ackResults).toEqual([{ error: 'proto:invalid' }, { accepted: true }]);
  });

  it('issue #2 — a live channel answers session/list with zero spawns', async () => {
    const adapter = makeCountedAdapter();
    const socket = new FakeSocket();
    let liveRequests = 0;
    const live: AgentConnection = {
      pgid: null,
      request: async () => {
        liveRequests++;
        return {
          sessions: [{ sessionId: 'native-1', cwd: '/root', title: 'from live channel' }],
        };
      },
      respondPermission: () => {},
      respondElicitation: () => {},
      setNotificationHandler: () => {},
      setPermissionHandler: () => {},
      setElicitationHandler: () => {},
      onExit: () => {},
      isGroupAlive: () => false,
      kill: () => {},
    };
    attachSessionsHandlers(socket as never, {
      env: ENV(adapter.command),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
      liveConnectionFor: (target) => (target === 'claude-code' ? live : null),
    });

    socket.receive('sessions:list', { requestId: 'l1', target: 'claude-code' });
    const r1 = await waitFor(() => {
      const r = socket.resultOf('l1');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(r1.sessions).toEqual([
      { sessionId: 'native-1', cwd: '/root', title: 'from live channel' },
    ]);
    expect(liveRequests).toBe(1);
    expect(adapter.spawns()).toBe(0);

    // Manual refresh also rides the live connection — it is the freshest
    // possible source, not a cached one.
    socket.receive('sessions:list', { requestId: 'l2', target: 'claude-code', refresh: true });
    await waitFor(() => {
      const r = socket.resultOf('l2');
      return r.sessions !== undefined ? r : undefined;
    });
    expect(liveRequests).toBe(2);
    expect(adapter.spawns()).toBe(0);
  });

  it('issue #2 — a failing live connection falls back to the spawn', async () => {
    const adapter = makeCountedAdapter();
    const socket = new FakeSocket();
    const live: AgentConnection = {
      pgid: null,
      request: async () => {
        throw new Error('agent process is not running');
      },
      respondPermission: () => {},
      respondElicitation: () => {},
      setNotificationHandler: () => {},
      setPermissionHandler: () => {},
      setElicitationHandler: () => {},
      onExit: () => {},
      isGroupAlive: () => false,
      kill: () => {},
    };
    attachSessionsHandlers(socket as never, {
      env: ENV(adapter.command),
      homeDir: mkdtempSync(join(tmpdir(), 'hnx-sessions-home-')),
      liveConnectionFor: () => live,
    });

    socket.receive('sessions:list', { requestId: 'f1', target: 'claude-code' });
    const r1 = await waitFor(() => {
      const r = socket.resultOf('f1');
      return r.sessions !== undefined ? r : undefined;
    });
    // The fixture agent's session row — i.e. the spawn path answered.
    expect(r1.sessions).toHaveLength(1);
    expect(adapter.spawns()).toBe(1);
  });
});

describe('parseSessionList cwd flavors (#43)', () => {
  it('keeps Windows drive-letter cwds — the /-only check once emptied the whole rail', async () => {
    const { parseSessionList, isAbsoluteCwd } = await import('../src/daemon/sessions.js');
    expect(isAbsoluteCwd('/home/u/proj')).toBe(true);
    expect(isAbsoluteCwd('D:\\workspace\\chat')).toBe(true);
    expect(isAbsoluteCwd('D:/workspace/chat')).toBe(true);
    expect(isAbsoluteCwd('relative/path')).toBe(false);
    expect(isAbsoluteCwd('Ddrive-not-absolute')).toBe(false);

    const rows = parseSessionList({
      sessions: [
        {
          sessionId: 'win-1',
          cwd: 'D:\\workspace\\chat',
          title: '你好',
          updatedAt: '2026-09-30T15:24:43.000Z',
        },
        { sessionId: 'nix-1', cwd: '/home/u/proj' },
        { sessionId: 'rel-1', cwd: 'workspace/chat' }, // dropped — not absolute anywhere
      ],
    });
    expect(rows.map((r) => r.sessionId)).toEqual(['win-1', 'nix-1']);
    expect(rows[0]!.cwd).toBe('D:\\workspace\\chat');
    expect(rows[0]!.title).toBe('你好');
  });
});
