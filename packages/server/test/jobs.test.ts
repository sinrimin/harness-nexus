import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobUpdateEvent, JobView } from '@harness-nexus/shared';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * Job lifecycle integration (Phase 8 C4) with a fake daemon on /ctl:
 * online dispatch → progress → result (AgentInstance registration), failure,
 * offline queue → reconnect replay, queued cancel, disconnect recovery with
 * the attempt cap (JOB_ABANDONED), and the route gates. Short ack/sweep
 * timeouts come from testConfig (700ms / 200ms, maxAttempts 3).
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
let daemon: Socket;
/** #45 — tracks whether `daemon` is still connected (serializes connectDaemon). */
let daemonConnected = false;
let appSock: Socket;
const jobUpdates: JobUpdateEvent[] = [];

const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp(testConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;

  // A hermes profile to deploy.
  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: authed(jwt),
    payload: { name: 'deployable', target: 'hermes', scope: 'personal', entries: [] },
  });
  if (profile.statusCode !== 201) throw new Error(`profile create failed: ${profile.body}`);
  deployProfileId = profile.json().profile.id;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: authed(jwt),
    payload: { name: 'deploy-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  appSock = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
  appSock.on('job:update', (e: JobUpdateEvent) => jobUpdates.push(e));
  await once(appSock, 'connect');
}, 20000);

afterAll(async () => {
  daemon?.close();
  appSock?.close();
  await app?.close();
});

let deployProfileId: string;

/**
 * Connect a fake daemon that HELLOs with the deploy capability. `beforeConnect`
 * lets tests attach listeners BEFORE the server's connect handler fires —
 * `dispatchPending` emits `job:dispatch` during connection, so a listener
 * attached after `connect` can miss it.
 */
async function connectDaemon(
  beforeConnect?: (sock: Socket) => void,
  capabilities: string[] = ['inventory', 'deploy'],
): Promise<Socket> {
  // #45 — the server refuses a second live socket per machine, so the suite
  // keeps EXACTLY ONE daemon socket at a time: connecting first closes (and
  // waits out) any previous one; `daemon` always aliases the live socket.
  if (daemonConnected) {
    daemon.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
    daemonConnected = false;
  }
  const sock = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  beforeConnect?.(sock);
  await once(sock, 'connect');
  await emitAck(sock, 'machine:hello', {
    daemonVersion: '0.3.0-test',
    capabilities,
  });
  daemon = sock;
  daemonConnected = true;
  return sock;
}

/** Wait for the LATEST update of a job to reach `status` (with `minAttempts`). */
const waitJobStatus = async (jobId: string, status: string, minAttempts = 0): Promise<JobView> => {
  let current: JobView | undefined;
  await waitFor(() => {
    for (let i = jobUpdates.length - 1; i >= 0; i--) {
      const j = jobUpdates[i].job;
      if (j.id !== jobId) continue;
      current = j;
      if (j.status === status && (j.attempts ?? 0) >= minAttempts) return true;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return true; // settled early
    }
    return false;
  });
  if (!current || current.status !== status || (current.attempts ?? 0) < minAttempts) {
    throw new Error(
      `job ${jobId}: wanted ${status} (attempts>=${minAttempts}), at ${current?.status}/${current?.attempts}`,
    );
  }
  return current;
};

describe('online deploy lifecycle', () => {
  it('create → dispatched → running → succeeded + agent instance registered', async () => {
    daemon = await connectDaemon();

    const created = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: deployProfileId },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().job as JobView;
    expect(job.status).toBe('dispatched'); // daemon online ⇒ immediate dispatch

    const dispatch = (await once(daemon, 'job:dispatch')) as { job: JobView };
    expect(dispatch.job.id).toBe(job.id);
    expect(dispatch.job.payload.profileId).toBe(deployProfileId);

    daemon.emit('job:progress', { jobId: job.id, phase: 'plan' });
    await waitJobStatus(job.id, 'running');

    daemon.emit('job:result', {
      jobId: job.id,
      ok: true,
      data: {
        name: 'deployable',
        directory: '/home/tester/.hermes',
        target: 'hermes',
        profileId: deployProfileId,
        profileVersion: '1.0.0',
      },
    });
    await waitJobStatus(job.id, 'succeeded');

    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(agents.json().agents).toHaveLength(1);
    expect(agents.json().agents[0].profileId).toBe(deployProfileId);
    expect(agents.json().agents[0].directory).toBe('/home/tester/.hermes');
  });

  it('failure result → failed with the daemon error', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: deployProfileId },
    });
    const job = created.json().job as JobView;
    await once(daemon, 'job:dispatch');
    daemon.emit('job:result', { jobId: job.id, ok: false, error: 'adapter exploded' });
    const settled = await waitJobStatus(job.id, 'failed');
    expect(settled.error).toBe('adapter exploded');
    // No second agent instance from a failed deploy.
    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(agents.json().agents).toHaveLength(1);
  });
});

describe('offline queue + replay', () => {
  it('a job created while offline queues, then drains when the daemon connects', async () => {
    daemon.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));

    const created = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: deployProfileId },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().job as JobView;
    expect(job.status).toBe('queued');

    let dispatchP: Promise<unknown> = Promise.resolve();
    daemon = await connectDaemon((sock) => {
      dispatchP = once(sock, 'job:dispatch');
    });
    await dispatchP; // queue drained on connect
    await waitJobStatus(job.id, 'dispatched');
    daemon.emit('job:result', {
      jobId: job.id,
      ok: true,
      data: {
        name: 'deployable',
        directory: '/home/tester/.hermes',
        target: 'hermes',
        profileId: deployProfileId,
      },
    });
    await waitJobStatus(job.id, 'succeeded');

    // Re-deploy upserts: still ONE agent instance, upgraded by this job.
    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(agents.json().agents).toHaveLength(1);
    expect(agents.json().agents[0].jobId).toBe(job.id);
  });

  it('queued cancel settles immediately; cancelling again is a 409', async () => {
    daemon.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
    const created = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: deployProfileId },
    });
    const job = created.json().job as JobView;
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/cancel`,
      headers: authed(jwt),
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().job.status).toBe('cancelled');

    const again = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/cancel`,
      headers: authed(jwt),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('JOB_NOT_CANCELLABLE');

    daemon = await connectDaemon();
  });
});

describe('recovery', () => {
  it('disconnect mid-flight requeues with attempts+1; repeated abandon hits the cap', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: deployProfileId },
    });
    const job = created.json().job as JobView;
    await once(daemon, 'job:dispatch');

    // Cycle 1: disconnect without a result → requeue (attempts 1).
    daemon.close();
    let settled = await waitJobStatus(job.id, 'queued', 1);
    expect(settled.attempts).toBe(1);

    // Cycle 2: reconnect (re-dispatch) → disconnect → requeue (attempts 2).
    let dispatchP: Promise<unknown> = Promise.resolve();
    daemon = await connectDaemon((sock) => {
      dispatchP = once(sock, 'job:dispatch');
    });
    await dispatchP;
    daemon.close();
    settled = await waitJobStatus(job.id, 'queued', 2);
    expect(settled.attempts).toBe(2);

    // Cycle 3: attempts reach maxAttempts ⇒ failed JOB_ABANDONED.
    dispatchP = Promise.resolve();
    daemon = await connectDaemon((sock) => {
      dispatchP = once(sock, 'job:dispatch');
    });
    await dispatchP;
    daemon.close();
    settled = await waitJobStatus(job.id, 'failed');
    expect(settled.error).toContain('abandoned');

    daemon = await connectDaemon();
  });

  it('ack-timeout sweep reverts a dispatched job the daemon never started', async () => {
    // A daemon that acks nothing: dispatch, then don't run the job.
    // #45 — one live socket per machine: drop the tracked daemon first, then
    // this bespoke silent one is the machine's only daemon.
    if (daemonConnected) {
      daemon.close();
      await waitFor(() => !app.realtime.presence.isOnline(machineId));
      daemonConnected = false;
    }
    const silent = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    try {
      await once(silent, 'connect');
      await emitAck(silent, 'machine:hello', {
        daemonVersion: '0.3.0-test',
        capabilities: ['deploy'],
      });
      const created = await app.inject({
        method: 'POST',
        url: `/api/machines/${machineId}/jobs`,
        headers: authed(jwt),
        payload: { profileId: deployProfileId },
      });
      const job = created.json().job as JobView;
      const heard = await once(silent, 'job:dispatch');
      expect((heard as { job: JobView }).job.id).toBe(job.id);
      // No progress arrives → sweep reverts after ackTimeout (700ms).
      const settled = await waitJobStatus(job.id, 'queued', 1);
      expect(settled.attempts).toBeGreaterThanOrEqual(1);
    } finally {
      silent.close();
    }
    daemon = await connectDaemon();
  });
});

describe('gates', () => {
  it('deploy to a claude-code profile: online daemon without marketplace-deploy → 409', async () => {
    const profile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authed(jwt),
      payload: { name: 'cc-profile', target: 'claude-code', scope: 'personal', entries: [] },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: profile.json().profile.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_MARKETPLACE_DEPLOY');
  });

  it('harness job: payload union, pin-needs-version, and bad targets are 400', async () => {
    for (const body of [
      { type: 'harness', action: 'pin', target: 'codex' }, // pin without version
      { type: 'harness', action: 'install', target: 'hermes' }, // not a runtime target
      { type: 'harness', action: 'uninstall', target: 'codex' }, // stray action
      { type: 'harness', profileId: deployProfileId }, // harness arm needs action+target
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/machines/${machineId}/jobs`,
        headers: authed(jwt),
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('harness job accepts the opencode target (9 W12 — schema-driven, no route code)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { type: 'harness', action: 'install', target: 'opencode' },
    });
    // The suite's daemon is ONLINE without the 'harness' capability → the SOFT
    // gate 409s. Reaching the gate (not 400) is the point: an unknown target
    // fails schema parse BEFORE any gate — opencode passed the schema.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_HARNESS');
  });

  it('harness job is owner-only — an admin does not even see the machine (#36)', async () => {
    // Make the requesting user an admin (bootstrap 'root' already is — so use
    // a second user owning a second machine, and have root (admin) try).
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'harnessowner', password: 'hunter2hunter2' },
    });
    const ownerJwt = reg.json().token;
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: authed(ownerJwt),
      payload: { name: 'harness-box' },
    });
    const otherMachine = enroll.json().machine.id;
    // The admin cannot read the machine (404, no existence leak)…
    const view = await app.inject({
      method: 'GET',
      url: `/api/machines/${otherMachine}`,
      headers: authed(jwt),
    });
    expect(view.statusCode).toBe(404);
    // …so the job route hides it too — the harness branch is unreachable for
    // a non-owner, no 403 needed anymore.
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${otherMachine}/jobs`,
      headers: authed(jwt),
      payload: { type: 'harness', action: 'install', target: 'codex' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('MACHINE_NOT_FOUND');
    // The owner would be allowed — but the daemon is offline, so it queues
    // (capability is only knowable once the daemon says hello).
    const ownerRes = await app.inject({
      method: 'POST',
      url: `/api/machines/${otherMachine}/jobs`,
      headers: authed(ownerJwt),
      payload: { type: 'harness', action: 'install', target: 'codex' },
    });
    expect(ownerRes.statusCode).toBe(201);
    expect(ownerRes.json().job.type).toBe('harness');
    expect(ownerRes.json().job.status).toBe('queued');
  });

  it('harness job: an online daemon without the harness capability → 409 DAEMON_NO_HARNESS', async () => {
    const sock = await connectDaemon();
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { type: 'harness', action: 'upgrade', target: 'deepseek' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_HARNESS');
    sock.close();
  });

  it('harness job round-trip: dispatch → progress → result (no AgentInstance side effects)', async () => {
    const sock = await connectDaemon((s) => {
      s.on('job:dispatch', (e: { job: JobView }) => {
        const job = e.job;
        if (job.type !== 'harness') return;
        s.emit('job:progress', { jobId: job.id, phase: 'install', message: 'npm i -g' });
        s.emit('job:result', {
          jobId: job.id,
          ok: true,
          data: {
            target: 'deepseek',
            action: 'pin',
            version: '0.1.2-rc.1',
            installMethod: 'npm',
          },
        });
      });
    });
    await emitAck(sock, 'machine:hello', {
      daemonVersion: '0.6.0-test',
      capabilities: ['inventory', 'deploy', 'harness'],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { type: 'harness', action: 'pin', target: 'deepseek', version: '0.1.2-rc.1' },
    });
    expect(res.statusCode).toBe(201);
    const job = res.json().job;
    expect(job.type).toBe('harness');
    expect(job.payload).toEqual({
      type: 'harness',
      action: 'pin',
      target: 'deepseek',
      version: '0.1.2-rc.1',
    });

    const done = await waitJobStatus(job.id, 'succeeded');
    expect(done.result).toMatchObject({ target: 'deepseek', version: '0.1.2-rc.1' });

    // Harness jobs never create agent instances — no deepseek row appears
    // (the earlier deploy test's hermes instance is the only deploy row).
    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(
      agents
        .json()
        .agents.filter(
          (a: { source: string; target: string }) =>
            a.source === 'deploy' && a.target === 'deepseek',
        ),
    ).toHaveLength(0);
    sock.close();
  });

  it('another user sees 404 (existence hiding) on job endpoints', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'jobother', password: 'hunter2hunter2' },
    });
    const otherJwt = reg.json().token;
    for (const [method, url] of [
      ['GET', `/api/machines/${machineId}/jobs`],
      ['POST', `/api/machines/${machineId}/jobs`],
      ['GET', `/api/machines/${machineId}/agents`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authed(otherJwt),
        ...(method === 'POST' ? { payload: { profileId: deployProfileId } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('deploy-bundle needs auth and honors profile visibility', async () => {
    const anon = await app.inject({
      method: 'GET',
      url: `/api/client/deploy-bundle?profile=${deployProfileId}`,
    });
    expect(anon.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'GET',
      url: `/api/client/deploy-bundle?profile=${deployProfileId}`,
      headers: authed(jwt),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().profile.id).toBe(deployProfileId);
    expect(Array.isArray(ok.json().artifacts)).toBe(true);
  });
});

describe('claude-code marketplace deploy (#6)', () => {
  it('dispatch carries the marketplace arm and never registers an agent instance', async () => {
    const profile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authed(jwt),
      payload: { name: 'cc-kit', target: 'claude-code', scope: 'personal', entries: [] },
    });
    const ccProfileId = profile.json().profile.id;

    // Daemon advertising the marketplace-deploy capability (#6).
    daemon.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
    daemon = await connectDaemon(undefined, ['inventory', 'deploy', 'marketplace-deploy']);

    const created = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: ccProfileId },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().job as JobView;
    const arm = (job.payload as { marketplace?: Record<string, string> }).marketplace;
    expect(arm).toBeDefined();
    expect(arm!.baseUrl).toBe(app.publicBaseUrl);
    expect(arm!.marketplaceName).toBe('harness-nexus-root');
    expect(arm!.pluginName).toBe('cc-kit');

    const dispatch = (await once(daemon, 'job:dispatch')) as { job: JobView };
    expect((dispatch.job.payload as { marketplace?: unknown }).marketplace).toBeDefined();
    daemon.emit('job:result', {
      jobId: job.id,
      ok: true,
      data: {
        name: 'cc-kit',
        directory: '/root/.claude/plugins',
        target: 'claude-code',
        profileId: ccProfileId,
        method: 'marketplace',
        installedVersion: '1.0.0',
      },
    });
    await waitJobStatus(job.id, 'succeeded');
    // claude-code deploys create NO AgentInstance — chat keys off the runtime
    // detector's instance (9 W1), a plugin install is not a runtime install.
    // (Earlier suites registered hermes instances on this machine — assert no
    // instance exists for THIS profile, not an empty table.)
    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(
      agents.json().agents.some((a: { profileId: string }) => a.profileId === ccProfileId),
    ).toBe(false);
  });

  it("the emitter accepts the daemon's machine PAT (machine-ctl scope) for the catalog", async () => {
    const catalog = await app.inject({
      method: 'GET',
      url: `/api/marketplace/${machineToken}/marketplace.json`,
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().name).toBe('harness-nexus-root');
    // The archive URLs carry the SAME machine token (auth rides in the URL).
    const sources = JSON.stringify(catalog.json());
    expect(sources).toContain(`/api/marketplace/${machineToken}/archives/`);

    // An unknown token stays a 404 (no existence leak).
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/marketplace/hnpat_doesnotexist0000000000000000000/marketplace.json',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("a foreign personal claude-code profile is not in the owner's marketplace → 404", async () => {
    // alice's personal profile is invisible to root (admin included, #36) —
    // and the machine's marketplace belongs to the machine owner (root), so
    // alice's profile could never deploy there anyway.
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'wonderlandwonderland' },
    });
    const aliceJwt = reg.json().token;
    const profile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authed(aliceJwt),
      payload: { name: 'alice-cc', target: 'claude-code', scope: 'personal', entries: [] },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: authed(jwt),
      payload: { profileId: profile.json().profile.id },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('PROFILE_NOT_FOUND');
  });

  it('PATCH /api/profiles/:id ignores client versions; entry changes are the publish switch (#18)', async () => {
    const profile = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authed(jwt),
      payload: { name: 'cc-bump', target: 'claude-code', scope: 'personal', entries: [] },
    });
    const id = profile.json().profile.id;
    expect(profile.json().profile.version).toBe('0.1');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}`,
      headers: authed(jwt),
      payload: { version: '9.9.9', name: 'cc-bump-2' },
    });
    expect(res.statusCode).toBe(200);
    // auto-numbered: the client-sent version is stripped, and a name-only
    // edit does not bump (profile-version.test.ts covers the bump path).
    expect(res.json().profile.version).toBe('0.1');
    expect(res.json().profile.name).toBe('cc-bump-2');
    // target stays immutable.
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}`,
      headers: authed(jwt),
      payload: { target: 'codex' },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toBe('TARGET_IMMUTABLE');
  });
});
