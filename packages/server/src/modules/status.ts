import type { FastifyInstance } from 'fastify';

/**
 * Read-only posture aggregate (D2 of the UI refactor, #23) — the numbers the
 * topbar readout strip and the nav counters render.
 *
 * The one rule this endpoint exists for: **a figure must mean what the list
 * page it links to means.** Every count below re-derives its row set with the
 * same rule its owning module uses (cited per figure), and each figure carries
 * its own scope marker.
 *
 * #36 — personal resources are owner-only for EVERY role (admins are curators
 * of the global library, not tenant overseers), so every figure here is
 * `self`: the caller's own machines/agents/jobs, own personal + global MCP
 * rows, own personal + global LLM providers, own channels. The `scopes` map
 * stays on the wire (it is the SDK contract) but never says `all` anymore.
 */
export type PostureScope = 'self' | 'all';

/** Which row set a figure counted — the strip labels a number `all` only when it is. */
export interface PostureScopes {
  machines: PostureScope;
  agents: PostureScope;
  queuedJobs: PostureScope;
  mcp: PostureScope;
  llmProviders: PostureScope;
  channels: PostureScope;
}

export interface Posture {
  /** Headline scope — `self` for every role since #36. */
  scope: PostureScope;
  /** Per-figure truth — the headline is a summary, this is what each number means. */
  scopes: PostureScopes;
  generatedAt: string;
  machines: { online: number; total: number };
  agents: number;
  mcp: { connected: number; total: number };
  llmProviders: number;
  queuedJobs: number;
  channels: number;
}

/**
 * Per-viewer TTL cache. The figures are cheap but polled; `ttlMs = 0` disables
 * it (tests). `invalidate()` is driven by realtime events — a machine going
 * offline must not keep a lamp lit for the rest of the TTL window.
 */
export class PostureCache {
  private entries = new Map<string, { at: number; value: Posture }>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, compute: () => Promise<Posture>): Promise<Posture> {
    if (this.ttlMs > 0) {
      const hit = this.entries.get(key);
      if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    }
    const value = await compute();
    this.entries.set(key, { at: Date.now(), value });
    return value;
  }

  invalidate(): void {
    this.entries.clear();
  }
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- GET /api/status/posture — the readout strip's only data source ----
  app.get('/api/status/posture', guard, async (req) => {
    const user = req.user!;
    return app.posture.get(`${user.id}:${user.role}`, () => computePosture(app, user));
  });
}

async function computePosture(
  app: FastifyInstance,
  user: { id: string; role: 'admin' | 'user' },
): Promise<Posture> {
  const generatedAt = new Date().toISOString();

  // Machines — same rule as GET /api/machines (machines.ts): own only, every
  // role (#36).
  const machines = await app.uow.machines.list({ ownerId: user.id });
  const machineIds = new Set(machines.map((m) => m.id));
  const online = machines.filter((m) => app.realtime.presence.isOnline(m.id)).length;

  // Agents — deployed + detected instances on the caller's machines, i.e. the
  // sum of GET /api/machines/:id/agents over the visible machines.
  let agents = 0;
  for (const machine of machines) {
    agents += (await app.uow.agentInstances.listByMachine(machine.id)).length;
  }

  // Queued jobs — machine-scoped, the same gate POST/GET /api/machines/:id/jobs
  // applies (jobs.ts `visibleMachine`). `listRecoverable` is the only
  // cross-machine read the job port offers, and queued ⊆ non-terminal.
  const queuedJobs = (await app.uow.jobs.listRecoverable()).filter(
    (job) => job.status === 'queued' && machineIds.has(job.machineId),
  ).length;

  // MCP — same rule as GET /api/mcp-servers (own personal + global, every
  // role); connected is that row set intersected with the registry's live
  // statuses (the visibility filter of GET /api/mcp-servers/status).
  const [personalMcp, globalMcp] = await Promise.all([
    app.uow.mcpServers.list({ scope: 'personal', ownerId: user.id }),
    app.uow.mcpServers.list({ scope: 'global' }),
  ]);
  const mcpIds = new Set([...personalMcp, ...globalMcp].map((s) => s.id));
  const connected = (app.mcpRegistry?.getStatuses() ?? []).filter(
    (s) => mcpIds.has(s.id) && s.status === 'connected',
  ).length;

  // LLM providers — own personal + global (llm-providers.ts list).
  const [personalLlm, globalLlm] = await Promise.all([
    app.uow.llmProviders.list({ scope: 'personal', ownerId: user.id }),
    app.uow.llmProviders.list({ scope: 'global' }),
  ]);

  // Channels — live ACP chat channels; owner-only by design, so this figure is
  // the caller's own for every role.
  const channels = app.realtime.chat.snapshotFor(user.id).channels.length;

  return {
    scope: 'self',
    scopes: {
      machines: 'self',
      agents: 'self',
      queuedJobs: 'self',
      mcp: 'self',
      llmProviders: 'self',
      channels: 'self',
    },
    generatedAt,
    machines: { online, total: machines.length },
    agents,
    mcp: { connected, total: mcpIds.size },
    llmProviders: personalLlm.length + globalLlm.length,
    queuedJobs,
    channels,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** D2 posture aggregate — per-viewer TTL cache, invalidated by realtime events. */
    posture: PostureCache;
  }
}
