// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { PrewarmPool } from '../src/daemon/prewarm.js';

/** Manual timer harness — the pool never sees real setTimeout this way. */
function harness() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t as unknown as NodeJS.Timeout;
    },
    clearTimer: (t: NodeJS.Timeout) => {
      (t as unknown as { cleared: boolean }).cleared = true;
    },
    fire: (ms: number) => {
      for (const t of [...timers]) {
        if (!t.cleared && t.ms === ms) {
          t.cleared = true;
          t.fn();
        }
      }
    },
  };
}

interface FakeValue {
  alive: boolean;
}

function makePool(overrides: Partial<Parameters<typeof PrewarmPool>[0]> = {}) {
  const spawned: string[] = [];
  const killed: string[] = [];
  const timers = harness();
  const pool = new PrewarmPool<FakeValue>({
    ttlMs: 1000,
    spawn: async (key) => {
      spawned.push(key);
      return { alive: true };
    },
    isAlive: (v) => v.alive,
    kill: () => {
      killed.push(spawned[killed.length] ?? '?');
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { pool, spawned, killed, timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PrewarmPool', () => {
  it('prewarm is idempotent per key (pending and ready)', async () => {
    const h = makePool();
    h.pool.prewarm('deepseek');
    h.pool.prewarm('deepseek'); // pending — no second spawn
    await tick();
    h.pool.prewarm('deepseek'); // ready — still no second spawn
    assert.equal(h.spawned.length, 1);
  });

  it('consume hands out the ready value exactly once', async () => {
    const h = makePool();
    h.pool.prewarm('deepseek');
    await tick();
    const v = h.pool.consume('deepseek');
    assert.ok(v !== null);
    assert.equal(h.pool.consume('deepseek'), null);
    assert.deepEqual(h.killed, []); // consumed ≠ killed
  });

  it('consume misses while pending (caller spawns fresh)', async () => {
    let release: ((v: FakeValue | null) => void) | null = null;
    const h = makePool({
      spawn: () => new Promise((res) => (release = res)),
    });
    h.pool.prewarm('deepseek');
    assert.equal(h.pool.consume('deepseek'), null);
    release?.({ alive: true });
    await tick();
    assert.ok(h.pool.consume('deepseek') !== null); // ready now
  });

  it('idle TTL kills the value and frees the slot', async () => {
    const h = makePool();
    h.pool.prewarm('deepseek');
    await tick();
    assert.deepEqual(h.pool.readyKeys(), ['deepseek']);
    h.timers.fire(1000);
    assert.deepEqual(h.pool.readyKeys(), []);
    assert.equal(h.killed.length, 1);
    // Slot freed: a new prewarm spawns again.
    h.pool.prewarm('deepseek');
    await tick();
    assert.equal(h.spawned.length, 2);
  });

  it('a dead value is replaced on the next prewarm, never consumed', async () => {
    let dead = false;
    const h = makePool({ isAlive: () => !dead });
    h.pool.prewarm('deepseek');
    await tick();
    dead = true;
    assert.equal(h.pool.consume('deepseek'), null); // dropped + killed
    assert.equal(h.killed.length, 1);
    h.pool.prewarm('deepseek');
    await tick();
    assert.equal(h.spawned.length, 2);
  });

  it('spawn failure drops the entry (retry possible)', async () => {
    const h = makePool({ spawn: async () => null });
    h.pool.prewarm('codex');
    await tick();
    assert.equal(h.pool.consume('codex'), null);
    assert.deepEqual(h.pool.readyKeys(), []);
  });

  it('a value resolving after teardownAll is killed immediately', async () => {
    let release: ((v: FakeValue | null) => void) | null = null;
    const killed: string[] = [];
    const timers = harness();
    const pool = new PrewarmPool<FakeValue>({
      ttlMs: 1000,
      spawn: () => new Promise((res) => (release = res)),
      isAlive: () => true,
      kill: () => killed.push('late'),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    pool.prewarm('claude-code');
    pool.teardownAll();
    release?.({ alive: true });
    await tick();
    assert.deepEqual(killed, ['late']);
    assert.deepEqual(pool.readyKeys(), []);
  });

  it('teardownAll kills ready values and clears their timers', async () => {
    const h = makePool();
    h.pool.prewarm('deepseek');
    h.pool.prewarm('codex');
    await tick();
    h.pool.teardownAll();
    assert.equal(h.killed.length, 2);
    assert.deepEqual(h.pool.readyKeys(), []);
  });
});
