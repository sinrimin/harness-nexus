// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import type { AssistantToolGroup } from '@harness-nexus/core';
import {
  AppError,
  createResourceSchema,
  updateResourceSchema,
  createProfileSchema,
  updateProfileSchema,
} from '@harness-nexus/shared';
import {
  createResource,
  getResource,
  listResources,
  updateResource,
} from '../services/resources.js';
import { createProfile, getProfile, listProfiles, updateProfile } from '../services/profiles.js';
import { listMcpServers } from '../services/mcp-servers.js';
import { listMachines } from '../services/machines.js';
import { listMachineAgents } from '../services/agent-instances.js';
import { listMachineJobs } from '../services/jobs.js';
import { getSystemInfo } from '../services/system.js';
import { searchSkills, type SkillsDeps } from '../services/skills.js';
import type { Principal, ServiceDeps } from '../services/principal.js';
import type { AssistantDispatchService } from '../realtime/assistant-dispatch.js';

/**
 * The assistant's v1 tool surface (#52 §5): read-heavy, grouped, and
 * deliberately WITHOUT delete/credential tools — destructive operations stay
 * human. Every tool calls a #53 service directly with the SESSION OWNER as
 * principal: the service layer is the single authorization point, so the
 * assistant exercises exactly the permissions its user has — never more, and
 * with the same 404-hiding the REST door applies.
 *
 * Complex payloads (resource/profile bodies) arrive as loose JSON and are
 * parsed with the SHARED zod schemas server-side — the tool parameter schema
 * never leaves the server, and validation failures reach the model as error
 * results it can react to.
 */

export interface AssistantToolDeps extends ServiceDeps {
  skills: SkillsDeps;
  /**
   * #67 — the client-agent dispatch coordinator (realtime seam, injected by
   * the plugin after ChatService exists). Absent (tests) = no dispatch tools.
   */
  dispatch?: AssistantDispatchService;
}

/** Cap a tool result's model-facing text (rows can be huge; the model needs bounded input). */
const MAX_TOOL_OUTPUT = 30_000;

interface ToolOut {
  content: { type: 'text'; text: string }[];
  details: Record<string, never>;
  isError?: boolean;
}

function textResult(data: unknown): string {
  const json = JSON.stringify(data, null, 2) ?? 'null';
  return json.length > MAX_TOOL_OUTPUT
    ? `${json.slice(0, MAX_TOOL_OUTPUT)}\n… (truncated at ${String(MAX_TOOL_OUTPUT)} characters)`
    : json;
}

function ok(data: unknown): ToolOut {
  return { content: [{ type: 'text', text: textResult(data) }], details: {} };
}

/** Run a service call; AppError → an isError result the model can react to. */
async function call(fn: () => Promise<unknown>): Promise<ToolOut> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof AppError) {
      return {
        content: [{ type: 'text', text: `error ${err.statusCode} ${err.code}: ${err.message}` }],
        details: {},
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `error: ${message}` }], details: {}, isError: true };
  }
}

/** Inference helper — keeps `execute` params typed from each tool's schema. */
export function tool<T extends TSchema>(t: AgentTool<T>): AgentTool<T> {
  return t;
}

/** Compact list rows — ids and identity only; `*_get` fetches the bodies. */
function resourceSummary(r: {
  id: string;
  key: string;
  kind: string;
  name: string;
  scope: string;
  version: string;
}) {
  return { id: r.id, key: r.key, kind: r.kind, name: r.name, scope: r.scope, version: r.version };
}

function profileSummary(p: { id: string; name: string; scope: string; version: string }) {
  return { id: p.id, name: p.name, scope: p.scope, version: p.version };
}

/**
 * Build the enabled groups' tools for one turn. The principal is captured at
 * TURN START (the runner re-reads the owner's role from the DB there), so a
 * disable/demote takes effect on the next turn. `session` (#68) routes the
 * dispatch backflow (user-op notes, completion pushes) to the assistant
 * session the tools run for.
 */
export function buildAssistantTools(
  deps: AssistantToolDeps,
  principal: Principal,
  groups: readonly AssistantToolGroup[],
  session?: { sessionId: string },
): AgentTool<TSchema>[] {
  const enabled = new Set<AssistantToolGroup>(groups);
  const tools: AgentTool<TSchema>[] = [];

  if (enabled.has('resources')) {
    tools.push(
      tool({
        name: 'resources_list',
        label: 'List resources',
        description:
          'List Harness Nexus resources (skills, hooks, sub-agents, rules, commands). Returns compact rows; use resources_get for full bodies.',
        parameters: Type.Object({
          kind: Type.Optional(
            Type.String({
              description: 'Filter by kind: skill | hook | sub_agent | rule | mcp | command',
            }),
          ),
          scope: Type.Optional(Type.String({ description: 'Filter by scope: global | personal' })),
        }),
        execute: async (_id, params) =>
          call(() =>
            listResources(deps, principal, {
              ...(params.kind !== undefined ? { kind: params.kind as never } : {}),
            }).then((rows) => rows.map(resourceSummary)),
          ),
      }),
      tool({
        name: 'resources_get',
        label: 'Get resource',
        description: 'Fetch one resource by id, including its full source body.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => call(() => getResource(deps, principal, params.id)),
      }),
      tool({
        name: 'resources_create',
        label: 'Create resource',
        description:
          'Create a resource. `resource` must match the create schema: { key, kind, name, description?, version?, source: {type:"inline",content}|{type:"inline-bundle",files}|…, scope, targets?, labels? }. Skills must use inline or inline-bundle sources.',
        parameters: Type.Object({ resource: Type.Any() }),
        execute: async (_id, params) =>
          call(() => createResource(deps, principal, createResourceSchema.parse(params.resource))),
      }),
      tool({
        name: 'resources_update',
        label: 'Update resource',
        description:
          'Update a resource by id. `patch` may carry key/name/description/version/source/targets/labels (kind and scope are immutable).',
        parameters: Type.Object({ id: Type.String(), patch: Type.Any() }),
        execute: async (_id, params) =>
          call(() =>
            updateResource(deps, principal, params.id, updateResourceSchema.parse(params.patch)),
          ),
      }),
    );
  }

  if (enabled.has('profiles')) {
    tools.push(
      tool({
        name: 'profiles_list',
        label: 'List profiles',
        description: 'List installable profiles (reference bundles of resources).',
        parameters: Type.Object({}),
        execute: async () =>
          call(() => listProfiles(deps, principal).then((rows) => rows.map(profileSummary))),
      }),
      tool({
        name: 'profiles_get',
        label: 'Get profile',
        description: 'Fetch one profile by id with its entries.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => call(() => getProfile(deps, principal, params.id)),
      }),
      tool({
        name: 'profiles_create',
        label: 'Create profile',
        description:
          'Create a profile. `profile` must match: { name, description?, target, entries, scope } — entries reference resources by id.',
        parameters: Type.Object({ profile: Type.Any() }),
        execute: async (_id, params) =>
          call(() => createProfile(deps, principal, createProfileSchema.parse(params.profile))),
      }),
      tool({
        name: 'profiles_update',
        label: 'Update profile',
        description: 'Update a profile by id (name/description/entries; a new version is derived).',
        parameters: Type.Object({ id: Type.String(), patch: Type.Any() }),
        execute: async (_id, params) =>
          call(() =>
            updateProfile(deps, principal, params.id, updateProfileSchema.parse(params.patch)),
          ),
      }),
    );
  }

  if (enabled.has('mcp')) {
    tools.push(
      tool({
        name: 'mcp_servers_list',
        label: 'List MCP servers',
        description:
          'List the registered MCP servers visible to the user (transport, dial site, scope).',
        parameters: Type.Object({}),
        execute: async () => call(() => listMcpServers(deps, principal, {})),
      }),
    );
  }

  if (enabled.has('skills-hub')) {
    tools.push(
      tool({
        name: 'skills_search',
        label: 'Search skill hub',
        description:
          'Search the multi-source skill hub (marketplaces, GitHub, well-known catalogs) for installable skills.',
        parameters: Type.Object({
          q: Type.String({ description: 'Search query' }),
          limit: Type.Optional(Type.Number({ description: 'Max results (1-200, default 50)' })),
        }),
        execute: async (_id, params) =>
          call(() =>
            searchSkills(deps.skills, principal, {
              q: params.q,
              ...(params.limit !== undefined ? { limit: String(params.limit) } : {}),
            }),
          ),
      }),
    );
  }

  if (enabled.has('machines')) {
    tools.push(
      tool({
        name: 'machines_list',
        label: 'List machines',
        description:
          "List the user's enrolled machines (online state, capabilities, daemon version).",
        parameters: Type.Object({}),
        execute: async () => call(() => listMachines(deps, principal)),
      }),
      tool({
        name: 'machine_agents_list',
        label: 'List machine agents',
        description: 'List the agent instances deployed/detected on one machine.',
        parameters: Type.Object({ machineId: Type.String() }),
        execute: async (_id, params) =>
          call(() => listMachineAgents(deps, principal, params.machineId)),
      }),
      tool({
        name: 'machine_jobs_list',
        label: 'List machine jobs',
        description: 'List the deploy/harness jobs of one machine (status history).',
        parameters: Type.Object({ machineId: Type.String() }),
        execute: async (_id, params) =>
          call(() => listMachineJobs(deps, principal, params.machineId)),
      }),
    );
  }

  if (enabled.has('agent-dispatch') && deps.dispatch !== undefined) {
    const dispatch = deps.dispatch;
    tools.push(
      tool({
        name: 'agent_dispatch',
        label: 'Dispatch client agent',
        description:
          "Send a prompt to a client agent (AgentInstance) on one of the user's machines and return a handle immediately — the agent runs ASYNC; poll the outcome with agent_dispatch_poll. To CONTINUE a previous dispatch's native session, pass resume = { sessionId, cwd } exactly as that dispatch's poll result reported them. The channel shows in the user's web chat tabs; permission prompts the driven agent raises are answerable there, and anything the USER does on it (stopping it, interjecting, closing it) comes back via poll notices.",
        parameters: Type.Object({
          agentInstanceId: Type.String({
            description: 'The agent instance to drive (machine_agents_list).',
          }),
          prompt: Type.String({ description: 'The prompt for the agent.' }),
          directory: Type.Optional(
            Type.String({
              description:
                "Optional project directory for a NEW session (must be the machine baseWorkspace or under it); omit to use the agent's own directory.",
            }),
          ),
          resume: Type.Optional(
            Type.Object({
              sessionId: Type.String({
                description: 'The native session id from a previous dispatch result.',
              }),
              cwd: Type.String({ description: 'The cwd from that dispatch result (verbatim).' }),
            }),
          ),
        }),
        execute: async (_id, params) =>
          call(() =>
            dispatch.dispatch(principal.userId, {
              agentInstanceId: params.agentInstanceId,
              prompt: params.prompt,
              ...(session !== undefined ? { assistantSessionId: session.sessionId } : {}),
              ...(params.directory !== undefined ? { directory: params.directory } : {}),
              ...(params.resume !== undefined ? { resume: params.resume } : {}),
            }),
          ),
      }),
      tool({
        name: 'agent_dispatch_poll',
        label: 'Poll dispatched agent',
        description:
          "Fetch a dispatch's outcome. status running/starting = still working (optionally waitMs to block for a change, max 60000); done carries the turn's final text, stopReason, usage, and the nativeSessionId+cwd continuation handle; closed/failed are terminal and explain themselves. pendingPermission=true means the driven agent waits on a permission card the user must answer in the web chat tab. notices[] lists USER operations on the driven channel since your last poll (the user stopped/interjected/reconfigured it) — they carry the user's intent, not failures.",
        parameters: Type.Object({
          channelId: Type.String({ description: 'The handle agent_dispatch returned.' }),
          waitMs: Type.Optional(
            Type.Number({
              description: 'Wait up to this many ms for a state change (0-60000, default 0).',
            }),
          ),
        }),
        execute: async (_id, params) =>
          call(async () =>
            dispatch.poll(
              principal.userId,
              params.channelId,
              Math.max(0, Math.min(60_000, params.waitMs ?? 0)),
            ),
          ),
      }),
    );
  }

  if (enabled.has('system')) {
    tools.push(
      tool({
        name: 'system_info',
        label: 'System info',
        description: 'The platform version.',
        parameters: Type.Object({}),
        execute: async () => ok(getSystemInfo(principal)),
      }),
    );
  }

  return tools;
}

/**
 * The MUTATING tools — every call requires explicit user approval mid-turn
 * (M3): the runner routes these through the approval seam, which surfaces an
 * ACP-shaped `permission_request` card and waits for the browser's answer or
 * the timeout (both deny). Reads never gate.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'resources_create',
  'resources_update',
  'profiles_create',
  'profiles_update',
  // #67 — dispatching drives an agent on the user's machine: the highest
  // blast radius in the platform, gated per call like the other writes.
  'agent_dispatch',
]);

/**
 * Tool names per group — STATIC (the runner's `beforeToolCall` allowlist and
 * the audit trail key off it; `buildAssistantTools` is the single builder,
 * this index is its name shadow).
 */
export const TOOL_NAMES_BY_GROUP: Record<AssistantToolGroup, readonly string[]> = {
  resources: ['resources_list', 'resources_get', 'resources_create', 'resources_update'],
  profiles: ['profiles_list', 'profiles_get', 'profiles_create', 'profiles_update'],
  mcp: ['mcp_servers_list'],
  'skills-hub': ['skills_search'],
  machines: ['machines_list', 'machine_agents_list', 'machine_jobs_list'],
  'agent-dispatch': ['agent_dispatch', 'agent_dispatch_poll'],
  system: ['system_info'],
};
