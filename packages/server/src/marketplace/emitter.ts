// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Marketplace emitter (Phase 3.5) — turns a user's visible claude-code-target
 * profiles into a Claude Code plugin marketplace served over plain HTTP:
 *
 *   claude plugin marketplace add <PUBLIC_BASE_URL>/api/marketplace/<PAT>/marketplace.json
 *   claude plugin install <profile>@harness-nexus-<username>
 *
 * Claude Code then owns the whole lifecycle (install/update/uninstall) via
 * `archive` plugin sources (HTTPS zip downloads — no git, no npm). This module
 * only EMITS a catalog and per-profile zips; it never touches a client
 * filesystem, which is why no install-state ledger is needed on this path
 * (contrast with the CLI adapter pipeline, 3.3/3.4).
 *
 * Auth is PAT-in-path (claude sends no headers we can rely on — the spike
 * showed configured headers only apply on some internal refresh paths). The
 * route module resolves the token; this service is transport-free and talks
 * only to the UnitOfWork, mirroring how `mcp/registry.ts` stays decoupled.
 *
 * Ground truth: wiki design-phase-3.5-marketplace-emitter.md +
 * wiki research-phase-3.5-marketplace-emitter-spike.md (every client-side
 * constraint cited here was verified against a live claude install cycle).
 */
import JSZip from 'jszip';
import type { FastifyBaseLogger } from 'fastify';
import type { McpServer, Profile, Resource } from '@harness-nexus/core';
import type { UnitOfWork } from '@harness-nexus/core';
import { HOOK_SUPPORT, isUnsafeRelativePath, type HookEvent } from '@harness-nexus/shared';

export interface MarketplaceEmitterOptions {
  uow: UnitOfWork;
  /** Absolute origin the Agent tool reaches this server at (no trailing slash). */
  publicBaseUrl: string;
  logger: FastifyBaseLogger;
  /**
   * Phase 8 C2 — how `.mcp.json` entries are emitted:
   *   client (default) — ONE stdio entry invoking the `hnx mcp serve` shim
   *     (no PAT env var; requires `hnx` enrolled on the machine).
   *   server — the pre-C2 shape: the aggregated `/mcp` endpoint + a
   *     `${HN_PAT_*}` env placeholder; the no-`hnx` fallback.
   */
  emitMode?: 'client' | 'server';
}

/** A plugin name / directory segment, sanitized to claude's expectations. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'harness-nexus-profile'
  );
}

/** The env var a user must export for the aggregated proxy MCP endpoint. */
function patEnvKeyFor(profileSlug: string): string {
  return `HN_PAT_${profileSlug.replace(/-/g, '_').toUpperCase()}`;
}

/** Marketplace identity — unique per user (claude rejects name/URL remixing). */
export function marketplaceNameFor(username: string): string {
  return `harness-nexus-${slugify(username)}`;
}

export class MarketplaceEmitter {
  private readonly uow: UnitOfWork;
  private readonly base: string;
  private readonly log: FastifyBaseLogger;
  private readonly emitMode: 'client' | 'server';

  constructor(opts: MarketplaceEmitterOptions) {
    this.uow = opts.uow;
    this.base = opts.publicBaseUrl;
    this.log = opts.logger;
    this.emitMode = opts.emitMode ?? 'client';
  }

  /**
   * Build the marketplace.json catalog for a user: every claude-code-target
   * profile they can see (own personal + global), one plugin per profile.
   * Each entry's `source` is an `archive` pointing back at this server under
   * the SAME token, so authentication rides in the URL alone (spike §4).
   */
  async buildCatalog(
    userId: string,
    username: string,
    token: string,
  ): Promise<Record<string, unknown>> {
    const [personal, global] = await Promise.all([
      this.uow.profiles.list({ scope: 'personal', ownerId: userId }),
      this.uow.profiles.list({ scope: 'global' }),
    ]);
    const seen = new Set<string>();
    const plugins: Record<string, unknown>[] = [];
    for (const profile of [...personal, ...global]) {
      if (profile.target !== 'claude-code' || seen.has(profile.id)) continue;
      seen.add(profile.id);
      plugins.push({
        name: slugify(profile.name),
        description:
          profile.description ?? `Harness Nexus profile '${profile.name}' v${profile.version}.`,
        version: profile.version,
        category: 'harness-nexus',
        source: {
          source: 'archive',
          url: `${this.base}/api/marketplace/${token}/archives/${profile.id}.zip`,
        },
      });
    }
    return {
      name: marketplaceNameFor(username),
      description: `Harness Nexus profiles for ${username} (target: claude-code).`,
      owner: { name: 'Harness Nexus' },
      plugins,
    };
  }

  /**
   * Assemble one profile as a claude-code plugin zip. Layout is claude-native
   * (`.claude-plugin/plugin.json` one folder deep — spike §3):
   *
   *   <slug>/.claude-plugin/plugin.json
   *   <slug>/.mcp.json                       (only with MCP entries)
   *   <slug>/skills/<name>/SKILL.md          (skills; rule resources wrapped)
   *   <slug>/commands/<name>.md
   *   <slug>/agents/<name>.md
   *   <slug>/hooks/hooks.json                (claude-supported events only)
   *
   * Emission limitations surface as a bracketed warning suffix on the plugin
   * description — the only channel claude shows the user post-install.
   */
  async buildPluginZip(profile: Profile): Promise<Buffer> {
    const slug = slugify(profile.name);
    const zip = new JSZip();
    const dir = zip.folder(slug)!;
    const warnings: string[] = [];

    // ---- resolve entries → artifacts ----
    const resources: Resource[] = [];
    const mcpServers: McpServer[] = [];
    for (const entry of profile.entries) {
      // Soft-deleted rows are skipped (two-stage delete).
      if (entry.kind === 'mcp') {
        const server = await this.uow.mcpServers.findById(entry.resourceId);
        if (server && server.deletedAt === undefined) mcpServers.push(server);
      } else {
        const resource = await this.uow.resources.findById(entry.resourceId);
        if (resource && resource.deletedAt === undefined) resources.push(resource);
      }
    }

    // ---- resource files ----
    for (const resource of resources) {
      this.emitResource(dir, resource, warnings);
    }

    // ---- .mcp.json ----
    if (mcpServers.length > 0) {
      const block: Record<string, unknown> = {};
      if (this.emitMode === 'client') {
        // Phase 8 C2: one stdio shim entry per profile — no PAT env var, no
        // inlined credentials. The shim (spawned by claude per session) fetches
        // its resolved config from the server with hnx's own enrollment token.
        block['harness-nexus'] = {
          type: 'stdio',
          command: 'hnx',
          args: ['mcp', 'serve', '--profile', profile.id, '--server', this.base],
        };
        warnings.push('MCP requires the hnx client on PATH (hnx enroll) on this machine');
      } else {
        // 'server' mode — the pre-C2 output: everything through the aggregated
        // `/mcp` endpoint with a PAT env placeholder (the no-`hnx` fallback).
        block['harness-nexus'] = {
          type: 'http',
          url: `${this.base}/mcp?profile=${profile.id}`,
          headers: { Authorization: `Bearer \${${patEnvKeyFor(slug)}}` },
        };
        warnings.push(`export ${patEnvKeyFor(slug)} with a Harness Nexus PAT before use`);
      }
      dir.file('.mcp.json', JSON.stringify({ mcpServers: block }, null, 2));
    }

    // ---- .claude-plugin/plugin.json (last, so it carries all warnings) ----
    dir.file(
      '.claude-plugin/plugin.json',
      JSON.stringify(
        {
          name: slug,
          version: profile.version,
          description:
            (profile.description ?? `Harness Nexus profile '${profile.name}'.`) +
            (warnings.length > 0 ? ` [${warnings.join('; ')}]` : ''),
          author: { name: 'Harness Nexus' },
        },
        null,
        2,
      ),
    );

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    this.log.debug({ profileId: profile.id, slug }, 'marketplace emitter: built plugin zip');
    return buf;
  }
  /** Dispatch one resource to its plugin file slot, collecting warnings. */
  private emitResource(dir: JSZip, resource: Resource, warnings: string[]): void {
    const src = resource.source;
    const inlineContent = src.type === 'inline' ? src.content : null;

    switch (resource.kind) {
      case 'skill': {
        const skillDir = dir.folder(`skills/${slugify(resource.name)}`)!;
        if (src.type === 'inline') {
          skillDir.file('SKILL.md', src.content);
        } else if (src.type === 'inline-bundle') {
          for (const [relPath, content] of Object.entries(src.files)) {
            // #21: entries become paths in the consumer's extractor — never
            // zip a key that could walk out of the plugin directory.
            if (isUnsafeRelativePath(relPath)) {
              warnings.push(
                `skill:${resource.key} has an unsafe bundle path "${relPath}" — entry skipped`,
              );
              continue;
            }
            skillDir.file(relPath, content);
          }
        } else {
          warnings.push(`skill:${resource.key} has non-inline source — skipped`);
        }
        break;
      }
      case 'rule': {
        // Claude Code plugins have no always-on rules concept; wrap as a skill
        // so the content is at least available on invoke.
        if (inlineContent !== null) {
          const name = slugify(resource.name);
          dir.file(
            `skills/${name}/SKILL.md`,
            [
              '---',
              `name: ${name}`,
              `description: Rules: ${resource.description ?? resource.name}`,
              '---',
              '',
              inlineContent,
              '',
            ].join('\n'),
          );
        } else {
          warnings.push(`rule:${resource.key} has non-inline source — skipped`);
        }
        break;
      }
      case 'command': {
        if (inlineContent !== null) {
          dir.file(`commands/${slugify(resource.name)}.md`, inlineContent);
        } else {
          warnings.push(`command:${resource.key} has non-inline source — skipped`);
        }
        break;
      }
      case 'sub_agent': {
        if (inlineContent !== null) {
          dir.file(`agents/${slugify(resource.name)}.md`, inlineContent);
        } else {
          warnings.push(`sub_agent:${resource.key} has non-inline source — skipped`);
        }
        break;
      }
      case 'hook': {
        if (inlineContent === null) {
          warnings.push(`hook:${resource.key} has non-inline source — skipped`);
          break;
        }
        this.emitHooks(dir, inlineContent, warnings);
        break;
      }
      case 'mcp': {
        // Resources of kind 'mcp' don't exist (MCP servers are managed via
        // /api/mcp-servers and enter profiles as kind:'mcp' entries); kept
        // exhaustive for the switch.
        break;
      }
    }
  }

  /**
   * The stored hook document is a CC-style `hooks.json` (event→command map);
   * events claude-code doesn't support are filtered out per HOOK_SUPPORT.
   * Unparseable content is emitted verbatim rather than dropped.
   */
  private emitHooks(dir: JSZip, content: string, warnings: string[]): void {
    const supported = HOOK_SUPPORT['claude-code'];
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      dir.file('hooks/hooks.json', content);
      return;
    }
    const hooks =
      supported !== null &&
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { hooks?: unknown }).hooks !== null &&
      typeof (parsed as { hooks?: unknown }).hooks === 'object'
        ? (parsed as { hooks: Record<string, unknown> }).hooks
        : null;
    if (hooks === null) {
      dir.file('hooks/hooks.json', content);
      return;
    }
    const filtered: Record<string, unknown> = {};
    let dropped = 0;
    for (const [event, value] of Object.entries(hooks)) {
      if (supported!.has(event as HookEvent)) {
        filtered[event] = value;
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      warnings.push(`${dropped} hook event(s) unsupported by claude-code dropped`);
    }
    dir.file('hooks/hooks.json', JSON.stringify({ hooks: filtered }, null, 2));
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Phase 3.5 — the Claude Code marketplace catalog/zip emitter. */
    marketplaceEmitter: MarketplaceEmitter;
  }
}
