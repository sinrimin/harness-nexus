// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import type { AggregatedTool } from '@harness-nexus/mcp-runtime';
import { tool } from './tools.js';
import type { AssistantConfig, Resource } from '@harness-nexus/core';

/**
 * #52 M2 — the turn's EXTRA context beyond the v1 tool groups: configured
 * skills (prompt index + `read_skill`, progressive disclosure) and configured
 * MCP servers (their pooled tools wrapped as `AgentTool`s named
 * `<server>__<tool>`, executed via the registry — credential resolution and
 * namespacing already live in the pool).
 *
 * Everything here resolves at TURN START against live rows and the pool's
 * current posture; what cannot serve the turn is skipped WITH A NOTE in the
 * prompt (honesty over disappearance — the model must know a configured
 * capability is unavailable, not wonder).
 */

/** The narrow registry seam the runner needs (tests stub this). */
export interface AssistantMcpDeps {
  /** Aggregated tools of the configured server-dialed set (pool truth). */
  listTools(serverIds: string[]): AggregatedTool[];
  /** Execute one namespaced tool (`<server>__<tool>`). */
  callTool(namespacedName: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** A resolved, readable skill (visibility + kind + source checked). */
interface ResolvedSkill {
  resource: Resource;
  /** inline content or bundle files */
  files: Map<string, string>;
}

const MAX_SKILL_FILE = 60_000;

function resolveSkill(resource: Resource): ResolvedSkill | null {
  if (resource.kind !== 'skill') return null;
  const source = resource.source;
  if (source.type === 'inline') {
    return { resource, files: new Map([['SKILL.md', source.content]]) };
  }
  if (source.type === 'inline-bundle') {
    return {
      resource,
      files: new Map(Object.entries(source.files).slice(0, 128)),
    };
  }
  return null;
}

export interface TurnExtras {
  tools: AgentTool<TSchema>[];
  /** Sections appended to the system prompt (skills index, availability notes). */
  promptAddendum: string;
}

/** One MCP CallToolResult content block → display text. */
function mcpResultToText(result: unknown): { text: string; isError: boolean } {
  if (result === null || typeof result !== 'object') {
    return { text: JSON.stringify(result) ?? 'null', isError: false };
  }
  const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean };
  const text = (r.content ?? [])
    .map((c) => (c.type === 'text' && c.text !== undefined ? c.text : JSON.stringify(c)))
    .join('\n');
  const bounded =
    text.length > MAX_SKILL_FILE ? `${text.slice(0, MAX_SKILL_FILE)}… (truncated)` : text;
  return { text: bounded === '' ? '(empty result)' : bounded, isError: r.isError === true };
}

/**
 * Build the extra tools + prompt sections for one turn. `visibleResources`
 * are the config's skill rows AS SEEN BY THE OWNER (the caller resolves them
 * through the same visibility rule the service applies at save time; a row
 * deleted since resolves to nothing and notes honestly).
 */
export async function buildTurnExtras(input: {
  config: AssistantConfig;
  resolveSkill: (id: string) => Promise<Resource | null>;
  mcp?: AssistantMcpDeps;
}): Promise<TurnExtras> {
  const { config } = input;
  const notes: string[] = [];
  const tools: AgentTool<TSchema>[] = [];

  // ---- skills ----
  const skills: ResolvedSkill[] = [];
  const skippedSkills: string[] = [];
  for (const id of config.skillResourceIds ?? []) {
    const resource = await input.resolveSkill(id);
    const resolved = resource === null ? null : resolveSkill(resource);
    if (resolved === null) {
      skippedSkills.push(id);
      continue;
    }
    skills.push(resolved);
  }

  if (skills.length > 0) {
    const index = skills
      .map((s) => {
        const desc = s.resource.description ?? s.resource.name;
        const fileList = [...s.files.keys()];
        return `- ${s.resource.name} (id: ${s.resource.id}): ${desc}${
          fileList.length > 1 || fileList[0] !== 'SKILL.md'
            ? ` [files: ${fileList.join(', ')}]`
            : ''
        }`;
      })
      .join('\n');
    const addendum = [
      '# Available skills',
      'The user configured these platform skills for you. Their names and descriptions are listed here; the FULL bodies are NOT in your context — call the `read_skill` tool with the skill id (and optional file name for bundles) before relying on a skill.',
      index,
    ].join('\n');

    const byId = new Map(skills.map((s) => [s.resource.id, s]));
    const byName = new Map(skills.map((s) => [s.resource.name.toLowerCase(), s]));
    tools.push(
      tool({
        name: 'read_skill',
        label: 'Read skill',
        description:
          'Read the full body of a configured platform skill. `skill` is the skill id or its name; `file` picks one file of a bundle (omit for SKILL.md / the single body).',
        parameters: Type.Object({
          skill: Type.String({ description: 'Skill id or name' }),
          file: Type.Optional(Type.String({ description: 'Bundle file name' })),
        }),
        execute: async (_id, params) => {
          const skill = byId.get(params.skill) ?? byName.get(params.skill.toLowerCase().trim());
          if (skill === undefined) {
            return {
              content: [
                { type: 'text', text: `error: no configured skill matches "${params.skill}"` },
              ],
              details: {},
              isError: true,
            };
          }
          const wanted =
            params.file ??
            (skill.files.has('SKILL.md') ? 'SKILL.md' : skill.files.keys().next().value);
          const body = wanted !== undefined ? skill.files.get(wanted) : undefined;
          if (body === undefined) {
            const available = [...skill.files.keys()].join(', ');
            return {
              content: [
                {
                  type: 'text',
                  text: `error: file "${wanted ?? '?'}" not in skill; available: ${available}`,
                },
              ],
              details: {},
              isError: true,
            };
          }
          const bounded =
            body.length > MAX_SKILL_FILE ? `${body.slice(0, MAX_SKILL_FILE)}… (truncated)` : body;
          return { content: [{ type: 'text', text: bounded }], details: {} };
        },
      }),
    );
    notes.push(addendum);
  }
  if (skippedSkills.length > 0) {
    notes.push(
      `# Unavailable skills\nConfigured skill resources that could not be loaded (deleted or unreadable since the config was saved): ${skippedSkills.join(', ')}. Do not attempt to use them.`,
    );
  }

  // ---- MCP ----
  const mcpIds = config.mcpServerIds ?? [];
  if (mcpIds.length > 0) {
    // Per-id listing: `listTools([id])` filters the pool by upstream id, so
    // availability is exact per configured server (deleted / client-dialed /
    // offline all yield []).
    const toolsByServer = new Map(
      mcpIds.map((id) => [id, input.mcp !== undefined ? input.mcp.listTools([id]) : []]),
    );
    const aggregated = [...toolsByServer.values()].flat();
    for (const agg of aggregated.slice(0, 128)) {
      const schema = (agg.inputSchema ?? {}) as TSchema;
      tools.push(
        tool({
          name: agg.name,
          label: agg.name,
          description:
            agg.description ?? `MCP tool ${agg.name} (exposed by a configured MCP server)`,
          parameters: Type.Unsafe(schema),
          execute: async (_callId, params) => {
            if (input.mcp === undefined) {
              return {
                content: [{ type: 'text', text: 'error: MCP is not available' }],
                details: {},
                isError: true,
              };
            }
            try {
              const { text, isError } = mcpResultToText(
                await input.mcp.callTool(agg.name, params as Record<string, unknown>),
              );
              return {
                content: [{ type: 'text', text }],
                details: {},
                ...(isError ? { isError } : {}),
              };
            } catch (err) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `error: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                details: {},
                isError: true,
              };
            }
          },
        }),
      );
    }
    // Availability note: configured servers the pool served nothing for.
    const unavailable = mcpIds.filter((id) => (toolsByServer.get(id) ?? []).length === 0);
    if (unavailable.length > 0) {
      notes.push(
        `# Unavailable MCP servers\nSome configured MCP servers are not serving tools right now (client-dialed, offline, or unresolvable): ${unavailable.length} of ${mcpIds.length}. Their tools are not present — do not call them; tell the user if they ask.`,
      );
    }
  }

  return { tools, promptAddendum: notes.join('\n\n') };
}
