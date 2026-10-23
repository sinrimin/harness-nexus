// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import type { AssistantPermissionMode, AssistantToolGroup } from '@harness-nexus/core';
import {
  AppError,
  apiToolServiceBundleSchema,
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
import {
  createApiToolService,
  deleteApiToolService,
  getApiToolService,
  listApiToolServices,
  updateApiToolService,
} from '../services/api-tools.js';
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
export function tool<T extends TSchema>(
  t: AgentTool<T> & { class: AssistantToolClass },
): AgentTool<T> {
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
 * #79 — an assistant tool's operation class, DECLARED where the tool is
 * built (never inferred from model behavior):
 *   read  — silent in every mode.
 *   write — approval card per call; silent under `permissionMode:'autoWrite'`.
 *   meta  — ALWAYS prompts; no silent tier exists (boundary-changing ops —
 *           the #81 API-tool config tools are the first real members).
 */
export type AssistantToolClass = 'read' | 'write' | 'meta';

/**
 * #79 — the approval gate's decision table: reads never prompt; writes
 * prompt unless the config pre-authorized them; meta ALWAYS prompts.
 */
export function toolNeedsApproval(
  cls: AssistantToolClass,
  mode: AssistantPermissionMode | undefined,
): boolean {
  return cls === 'meta' || (cls === 'write' && (mode ?? 'prompt') !== 'autoWrite');
}

/**
 * Build the enabled groups' tools for one turn. The principal is captured at
 * TURN START (the runner re-reads the owner's role from the DB there), so a
 * disable/demote takes effect on the next turn. `session` (#68) routes the
 * dispatch backflow (user-op notes, completion pushes) to the assistant
 * session the tools run for.
 *
 * Returns the tools AND their class map (#79) — the runner's approval gate
 * resolves `class × permissionMode` from it.
 */
export function buildAssistantTools(
  deps: AssistantToolDeps,
  principal: Principal,
  groups: readonly AssistantToolGroup[],
  session?: { sessionId: string; configId?: string },
): { tools: AgentTool<TSchema>[]; classOf: Map<string, AssistantToolClass> } {
  const enabled = new Set<AssistantToolGroup>(groups);
  const tools: AgentTool<TSchema>[] = [];

  if (enabled.has('resources')) {
    tools.push(
      tool({
        name: 'resources_list',
        class: 'read',
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
        class: 'read',
        label: 'Get resource',
        description: 'Fetch one resource by id, including its full source body.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => call(() => getResource(deps, principal, params.id)),
      }),
      tool({
        name: 'resources_create',
        class: 'write',
        label: 'Create resource',
        description:
          'Create a resource. `resource` must match the create schema: { key, kind, name, description?, version?, source: {type:"inline",content}|{type:"inline-bundle",files}|…, scope, targets?, labels? }. Skills must use inline or inline-bundle sources.',
        parameters: Type.Object({ resource: Type.Any() }),
        execute: async (_id, params) =>
          call(() => createResource(deps, principal, createResourceSchema.parse(params.resource))),
      }),
      tool({
        name: 'resources_update',
        class: 'write',
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
        class: 'read',
        label: 'List profiles',
        description: 'List installable profiles (reference bundles of resources).',
        parameters: Type.Object({}),
        execute: async () =>
          call(() => listProfiles(deps, principal).then((rows) => rows.map(profileSummary))),
      }),
      tool({
        name: 'profiles_get',
        class: 'read',
        label: 'Get profile',
        description: 'Fetch one profile by id with its entries.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => call(() => getProfile(deps, principal, params.id)),
      }),
      tool({
        name: 'profiles_create',
        class: 'write',
        label: 'Create profile',
        description:
          'Create a profile. `profile` must match: { name, description?, target, entries, scope } — entries reference resources by id.',
        parameters: Type.Object({ profile: Type.Any() }),
        execute: async (_id, params) =>
          call(() => createProfile(deps, principal, createProfileSchema.parse(params.profile))),
      }),
      tool({
        name: 'profiles_update',
        class: 'write',
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
        class: 'read',
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
        class: 'read',
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
        class: 'read',
        label: 'List machines',
        description:
          "List the user's enrolled machines (online state, capabilities, daemon version).",
        parameters: Type.Object({}),
        execute: async () => call(() => listMachines(deps, principal)),
      }),
      tool({
        name: 'machine_agents_list',
        class: 'read',
        label: 'List machine agents',
        description: 'List the agent instances deployed/detected on one machine.',
        parameters: Type.Object({ machineId: Type.String() }),
        execute: async (_id, params) =>
          call(() => listMachineAgents(deps, principal, params.machineId)),
      }),
      tool({
        name: 'machine_jobs_list',
        class: 'read',
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
        class: 'write',
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
        class: 'read',
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

  if (enabled.has('api-tools')) {
    // #81 — the config-management half of the group. The dynamic `api__*`
    // execution tools are built per turn by the runner from the config's
    // attached services; THESE are the static authoring tools that make the
    // loop close inside a conversation: the assistant reads API docs, writes
    // a bundle, and every save/delete rides the META class (#79) — opening or
    // changing an outbound surface never goes silent, in any permission mode.
    const apiToolSummary = (s: {
      id: string;
      name: string;
      scope: string;
      baseUrl: string;
      tools: unknown[];
    }) => ({
      id: s.id,
      name: s.name,
      scope: s.scope,
      baseUrl: s.baseUrl,
      toolCount: s.tools.length,
    });
    const resolveApiToolRef = async (ref: { id?: string; name?: string }) => {
      if (ref.id !== undefined) return getApiToolService(deps, principal, ref.id);
      if (ref.name === undefined) {
        throw new AppError('Pass either id or name', 422, 'API_TOOL_REF_REQUIRED');
      }
      const matches = (await listApiToolServices(deps, principal)).filter(
        (s) => s.name === ref.name,
      );
      if (matches.length === 0) {
        throw new AppError(
          `No visible API tool service named "${ref.name}"`,
          404,
          'API_TOOL_NOT_FOUND',
        );
      }
      if (matches.length > 1) {
        // global + the owner's personal may share a name — disambiguate by id.
        throw new AppError(
          `"${ref.name}" is ambiguous (global and personal rows share it) — pass the id: ${matches
            .map((s) => `${s.id} (${s.scope})`)
            .join(', ')}`,
          409,
          'API_TOOL_NAME_AMBIGUOUS',
        );
      }
      return matches[0]!;
    };
    tools.push(
      tool({
        name: 'api_tools_list',
        class: 'read',
        label: 'List API tool services',
        description:
          'List API tool services visible to the user (global + personal): id, name, scope, baseUrl, tool count.',
        parameters: Type.Object({}),
        execute: async () =>
          call(() => listApiToolServices(deps, principal).then((rows) => rows.map(apiToolSummary))),
      }),
      tool({
        name: 'api_tools_get',
        class: 'read',
        label: 'Get API tool service',
        description:
          'Fetch one service bundle by id or name — the FULL definition (baseUrl, headers, auth, every tool with params and envelope). This is the editing base: modify it and save it back with api_tools_save.',
        parameters: Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String({ description: 'Resolved against visible services.' })),
        }),
        execute: async (_id, params) => call(() => resolveApiToolRef(params)),
      }),
      tool({
        name: 'api_tools_save',
        class: 'meta',
        label: 'Create or replace an API tool service',
        description:
          'Create a service from a v1 bundle (no id) or fully replace an existing one (with id). ONE service = ONE API host: put that host\'s related endpoints in ONE service as multiple `tools` (service `name` = the API; each tool `name` = one endpoint) rather than one service per endpoint. Every tool REQUIRES a `description` (one sentence, what it returns) — it is the model\'s only spec for that tool; fill each param\'s `description` too whenever the name alone is unclear. On instances whose outbound policy is default-deny (whitelist), the baseUrl host must match a name rule in the whitelist; if save fails with API_TOOL_HOST_NOT_ALLOWED, tell the user an admin must whitelist that host (system settings) — do not retry unchanged. Bundle: {version:1, name, baseUrl (http/https), headers?, auth? ({style:"bearer",credentialName} or {style:"header",header,credentialName}), tools:[{name, description, method GET|POST|PUT|PATCH|DELETE, path ("/x/{slot}" for path params), params?:[{name, in path|query|header|body, type string|number|boolean, required, description?}], bodyType?:"json"|"form" (required when a body param exists), envelope?:{codeField?, success:[values that mean OK], payloadField?, errorFields?}, timeoutMs?, maxResultChars?}]}. Validation errors come back verbatim — fix the named fields and retry. Saved services attach to the CURRENT assistant config automatically; their tools join the next turn.',
        parameters: Type.Object({
          bundle: Type.Any({ description: 'The full v1 service bundle JSON.' }),
          id: Type.Optional(
            Type.String({
              description: 'Existing service id → full replace (scope/owner immutable).',
            }),
          ),
          scope: Type.Optional(
            Type.String({ description: 'global (admin-only) | personal (default).' }),
          ),
        }),
        execute: async (_id, params) =>
          call(async () => {
            // Pre-validate so zod issues reach the authoring loop as compact,
            // field-named errors instead of a raw ZodError blob.
            const parsed = apiToolServiceBundleSchema.safeParse(params.bundle);
            if (!parsed.success) {
              throw new AppError(
                parsed.error.issues
                  .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                  .join('; '),
                422,
                'API_TOOL_BUNDLE_INVALID',
              );
            }
            const saved =
              params.id !== undefined
                ? await updateApiToolService(deps, principal, params.id, { bundle: params.bundle })
                : await createApiToolService(deps, principal, {
                    ...(params.scope !== undefined
                      ? { scope: params.scope as 'global' | 'personal' }
                      : {}),
                    bundle: params.bundle,
                  });
            // Auto-attach to the calling config so the new tools join the NEXT
            // turn — an already-approved meta action; per-call class gating
            // (GET read / others write) still applies to every execution.
            let attached: 'attached' | 'already-attached' | 'not-attached' = 'not-attached';
            if (session?.configId !== undefined) {
              const config = await deps.uow.assistants.findById(session.configId);
              if (
                config !== null &&
                config.enabledToolGroups.includes('api-tools') &&
                !config.apiToolServiceIds.includes(saved.id)
              ) {
                await deps.uow.assistants.save({
                  ...config,
                  apiToolServiceIds: [...config.apiToolServiceIds, saved.id],
                  updatedAt: new Date().toISOString(),
                });
                attached = 'attached';
              } else if (config !== null && config.apiToolServiceIds.includes(saved.id)) {
                attached = 'already-attached';
              }
            }
            return {
              service: apiToolSummary(saved),
              configAttachment: attached,
              note: 'Tools join the turn AFTER this one (per-call permission classes still apply).',
            };
          }),
      }),
      tool({
        name: 'api_tools_delete',
        class: 'meta',
        label: 'Delete an API tool service',
        description:
          'Soft-delete a service by id or name. Configs referencing it simply stop seeing its tools; dangling references are harmless.',
        parameters: Type.Object({
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
        }),
        execute: async (_id, params) =>
          call(async () => {
            const service = await resolveApiToolRef(params);
            await deleteApiToolService(deps, principal, service.id);
            return { deleted: service.id, name: service.name };
          }),
      }),
    );
  }

  if (enabled.has('system')) {
    tools.push(
      tool({
        name: 'system_info',
        class: 'read',
        label: 'System info',
        description: 'The platform version.',
        parameters: Type.Object({}),
        execute: async () => ok(getSystemInfo(principal)),
      }),
    );
  }

  // #79 — collect the declared classes (the `class` prop rides each tool
  // literal; see the helper). The runner's approval gate resolves
  // `class × permissionMode` from this map.
  const classOf = new Map<string, AssistantToolClass>();
  for (const t of tools) {
    classOf.set(t.name, (t as AgentTool<TSchema> & { class: AssistantToolClass }).class);
  }

  return { tools, classOf };
}

/**
 * #79 — the MUTATING tools are now the `class: 'write'` declarations above
 * (plus dynamic extras the runner classifies); `buildAssistantTools`
 * returns the class map and the runner resolves `class × permissionMode`.
 * `meta` (always prompts, no silent tier) members: the #81 API-tool config
 * tools (`api_tools_save` / `api_tools_delete`).
 */

/**
 * Tool names per group — STATIC (the runner's `beforeToolCall` allowlist and
 * the audit trail key off it; `buildAssistantTools` is the single builder,
 * this index is its name shadow). The api-tools group ALSO carries dynamic
 * `api__<service>__<tool>` execution tools built per turn by the runner.
 */
export const TOOL_NAMES_BY_GROUP: Record<AssistantToolGroup, readonly string[]> = {
  resources: ['resources_list', 'resources_get', 'resources_create', 'resources_update'],
  profiles: ['profiles_list', 'profiles_get', 'profiles_create', 'profiles_update'],
  mcp: ['mcp_servers_list'],
  'skills-hub': ['skills_search'],
  machines: ['machines_list', 'machine_agents_list', 'machine_jobs_list'],
  'agent-dispatch': ['agent_dispatch', 'agent_dispatch_poll'],
  'api-tools': ['api_tools_list', 'api_tools_get', 'api_tools_save', 'api_tools_delete'],
  system: ['system_info'],
};
