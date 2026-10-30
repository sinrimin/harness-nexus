// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #100 — the decision-model capability breaker: consecutive-failure
 * trip, the cooldown window (clock-injected), half-open probing, re-open on
 * a failed probe, manual reset, and the fetch wrapper both gate axes ride
 * (blocks with the gate's own "uncertain" error shape while open; records
 * only REAL call outcomes). `listModelCapabilities` merges the breaker with
 * registry-validated slot refs.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { ModelCapabilities, listModelCapabilities } from '../src/services/model-capabilities.js';
import type { SystemOneFetch } from '../src/infra/systemone.js';

function breaker(now: () => number): ModelCapabilities {
  return new ModelCapabilities({ threshold: 3, cooldownMs: 600_000, now });
}

const okRes = () => ({ ok: true, status: 200, text: async () => '{}' });
const errRes = (status: number) => ({ ok: false, status, text: async () => 'x' });

describe('breaker window', () => {
  it('stays healthy below the threshold and trips at it', () => {
    let t = 1_000_000;
    const b = breaker(() => t);
    b.record('u', false, 'timeout 1');
    b.record('u', false, 'timeout 2');
    expect(b.degraded('u')).toBeNull(); // 2 < 3
    b.record('u', false, 'timeout 3');
    const d = b.degraded('u');
    expect(d).not.toBeNull();
    expect(d?.failures).toBe(3);
    expect(d?.until).toBe(t + 600_000);
    expect(d?.lastError).toBe('timeout 3');
  });

  it('a single success closes the breaker (counter resets)', () => {
    const b = breaker(() => 0);
    b.record('u', false, 'x');
    b.record('u', false, 'y');
    b.record('u', true);
    b.record('u', false, 'z');
    expect(b.degraded('u')).toBeNull(); // the counter restarted at 0
  });

  it('cooldown expiry is half-open: a probe may run', () => {
    let t = 1_000_000;
    const b = breaker(() => t);
    for (let i = 0; i < 3; i++) b.record('u', false, 'e');
    expect(b.degraded('u')).not.toBeNull();
    t += 600_001;
    expect(b.degraded('u')).toBeNull(); // expired ⇒ probe allowed
  });

  it('a failed probe re-opens with a fresh cooldown; a successful one closes', () => {
    let t = 1_000_000;
    const b = breaker(() => t);
    for (let i = 0; i < 3; i++) b.record('u', false, 'e');
    t += 700_000; // expired
    b.record('u', false, 'probe failed');
    const d = b.degraded('u');
    expect(d?.until).toBe(t + 600_000);
    expect(d?.failures).toBe(4);
    // and the recovery arm
    b.reset('u');
    for (let i = 0; i < 3; i++) b.record('u', false, 'e');
    t += 700_000;
    b.record('u', true);
    expect(b.degraded('u')).toBeNull();
  });

  it('reset clears everything (the manual clear-and-retry)', () => {
    const b = breaker(() => 0);
    for (let i = 0; i < 3; i++) b.record('u', false, 'e');
    b.reset('u');
    expect(b.degraded('u')).toBeNull();
    b.record('u', false, 'after reset');
    expect(b.degraded('u')).toBeNull(); // counter started over
  });

  it('state is per owner', () => {
    const b = breaker(() => 0);
    for (let i = 0; i < 3; i++) b.record('a', false, 'e');
    expect(b.degraded('a')).not.toBeNull();
    expect(b.degraded('b')).toBeNull();
  });
});

describe('wrapFetch (the seam both gate axes thread)', () => {
  it('passes through and records success / failure while closed', async () => {
    let t = 0;
    const b = breaker(() => t);
    let n = 0;
    const inner: SystemOneFetch = async () => {
      n += 1;
      return n === 1 ? okRes() : errRes(500);
    };
    const wrapped = b.wrapFetch('u', inner);
    await wrapped('https://x', {} as Parameters<SystemOneFetch>[1]);
    expect(b.degraded('u')).toBeNull();
    await wrapped('https://x', {} as Parameters<SystemOneFetch>[1]);
    expect(b.degraded('u')).toBeNull(); // 1 failure < 3
    const d = b.degraded.bind(b);
    expect(d('u')).toBeNull();
  });

  it('rejects with the gate error shape while degraded (and does not count it)', async () => {
    let t = 0;
    const b = breaker(() => t);
    for (let i = 0; i < 3; i++) b.record('u', false, 'e');
    let innerCalled = false;
    const wrapped = b.wrapFetch('u', async () => {
      innerCalled = true;
      return okRes();
    });
    await expect(wrapped('https://x', {} as Parameters<SystemOneFetch>[1])).rejects.toMatchObject({
      kind: 'shape',
    });
    expect(innerCalled).toBe(false);
    // the synthetic rejection was not recorded: still exactly 3 failures
    expect(b.degraded('u')?.failures).toBe(3);
  });

  it('counts non-ok HTTP as failures and network throws as failures', async () => {
    const b = breaker(() => 0);
    const http500: SystemOneFetch = async () => errRes(503);
    let calls = 0;
    const w1 = b.wrapFetch('u', async () => {
      calls += 1;
      return errRes(503);
    });
    await w1('https://x', {} as Parameters<SystemOneFetch>[1]);
    const w2 = b.wrapFetch('u', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(w2('https://x', {} as Parameters<SystemOneFetch>[1])).rejects.toThrow();
    expect(b.degraded('u')).toBeNull(); // 2 < 3
    await w1('https://x', {} as Parameters<SystemOneFetch>[1]);
    expect(b.degraded('u')?.lastError).toBe('HTTP 503');
  });
});

describe('listModelCapabilities (derived view)', () => {
  async function seed() {
    const uow = createMemoryUnitOfWork();
    const now = new Date().toISOString();
    const user = await uow.users.save({
      id: 'u1',
      username: 'u1',
      passwordHash: 'x',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await uow.llmProviders.save({
      id: 'p1',
      ownerId: user.id,
      name: 'sys',
      apis: [{ kind: 'systemone', path: null }],
      baseUrl: 'https://sys.example',
      credentialName: 'c',
      scope: 'personal',
      models: [{ id: 'd1', apiKind: 'systemone', type: 'decision' }],
      createdAt: now,
      updatedAt: now,
    });
    return { uow, user };
  }

  it('unconfigured / dead refs read configured:false, never degraded', async () => {
    const { uow, user } = await seed();
    const b = breaker(() => 0);
    for (let i = 0; i < 3; i++) b.record(user.id, false, 'e');
    await uow.users.save({
      ...user,
      defaultModels: { decision: { providerId: 'p1', modelId: 'gone' } },
      updatedAt: new Date().toISOString(),
    });
    const view = await listModelCapabilities({ uow }, user.id, b);
    expect(view.decision).toEqual({ configured: false, health: 'ok' });
    expect(view.embedding).toEqual({ configured: false, health: 'ok' });
    expect(view.rerank).toEqual({ configured: false, health: 'ok' });
  });

  it('a live decision ref reports degraded with the breaker state', async () => {
    let t = 5_000;
    const { uow, user } = await seed();
    await uow.users.save({
      ...user,
      defaultModels: { decision: { providerId: 'p1', modelId: 'd1' } },
      updatedAt: new Date().toISOString(),
    });
    const b = breaker(() => t);
    for (let i = 0; i < 3; i++) b.record(user.id, false, `e${i}`);
    const view = await listModelCapabilities({ uow }, user.id, b);
    expect(view.decision.configured).toBe(true);
    expect(view.decision.health).toBe('degraded');
    expect(view.decision.degradedUntil).toBe(t + 600_000);
    expect(view.decision.lastError).toBe('e2');
    expect(view.decision.consecutiveFailures).toBe(3);
  });

  it('a foreign provider row reads configured:false (scope rules hold)', async () => {
    const { uow, user } = await seed();
    const other = await uow.users.save({
      id: 'u2',
      username: 'u2',
      passwordHash: 'x',
      role: 'user',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await uow.users.save({
      ...user,
      defaultModels: { decision: { providerId: 'p1', modelId: 'd1' } },
      updatedAt: new Date().toISOString(),
    });
    const view = await listModelCapabilities(
      { uow },
      other.id,
      breaker(() => 0),
    );
    expect(view.decision.configured).toBe(false);
  });
});
