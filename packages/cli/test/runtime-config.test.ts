// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyRuntimeConfig,
  mergeEnvLine,
  mergeTomlRootKeys,
  runApplyConfigJob,
} from '../src/daemon/runtime-config.js';

/**
 * Provider-config writers (Phase 9 W3) against fixture HOMEs with planted
 * USER content — the load-bearing property is merge preservation: everything
 * outside the platform's managed keys/regions survives byte-for-byte, and
 * re-applying is idempotent. Ground truth per target in the W3 research notes.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-rc-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const spec = (over: Record<string, unknown> = {}): never =>
  ({
    providerLabel: 'team gateway',
    baseUrl: 'https://gw.example.com/v1',
    api: 'openai',
    model: 'gw-large',
    credentialName: 'gw-key',
    ...over,
  }) as never;

function writeRel(rel: string, content: string): string {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

describe('mergeTomlRootKeys', () => {
  it('sets keys in an empty document', () => {
    expect(mergeTomlRootKeys('', { model: 'a', model_provider: 'b' })).toBe(
      'model = "a"\nmodel_provider = "b"\n',
    );
  });

  it('replaces existing top-level keys in place and preserves sections + comments', () => {
    const doc = [
      '# user comment',
      'model = "old"',
      '',
      '[profiles.work]',
      'model = "profile-model"',
      '',
      '[mcp_servers.user-thing]',
      'command = "keep"',
    ].join('\n');
    const out = mergeTomlRootKeys(doc, { model: 'new', model_provider: 'harness_nexus' });
    expect(out).toContain('# user comment');
    expect(out).toContain('model = "new"');
    expect(out).toContain('model_provider = "harness_nexus"');
    expect(out).toContain('[profiles.work]');
    expect(out).toContain('model = "profile-model"'); // section key untouched
    expect(out).toContain('command = "keep"');
    // root keys must precede the first section header
    expect(out.indexOf('model_provider =')).toBeLessThan(out.indexOf('[profiles.work]'));
  });

  it('renders numbers/booleans bare and null REMOVES the key line (#63)', () => {
    const doc = 'a = "x"\nb = 2\nc = true\n[s]\nk = 1\n';
    expect(mergeTomlRootKeys(doc, { a: null, b: 7, c: false, d: 'e' })).toBe(
      'b = 7\nc = false\nd = "e"\n[s]\nk = 1\n',
    );
    // removing a key that is not there is a no-op, not an append
    expect(mergeTomlRootKeys('x = 1\n', { y: null })).toBe('x = 1\n');
  });

  it('inserts missing keys before the first section header when only sections exist', () => {
    const doc = '[servers.alpha]\nurl = "x"\n';
    const out = mergeTomlRootKeys(doc, { model: 'm' });
    expect(out.startsWith('model = "m"')).toBe(true);
    expect(out).toContain('[servers.alpha]');
  });
});

describe('mergeEnvLine', () => {
  it('appends to an empty file and replaces its own line while keeping others', () => {
    expect(mergeEnvLine('', 'K', 'v1')).toBe('K=v1\n');
    const doc = 'OTHER=1\n\nK=old\n# comment\n';
    const out = mergeEnvLine(doc, 'K', 'v2');
    expect(out).toBe('OTHER=1\n\nK=v2\n# comment\n');
  });

  it('single-quotes values that could inject extra env lines (#21)', () => {
    // A newline smuggled inside a secret must stay INSIDE a single-quoted
    // block — dotenv-style readers treat the whole quoted block as ONE value.
    const injected = mergeEnvLine('', 'K', 'x\nLD_PRELOAD=/home/u/evil.so');
    expect(injected.startsWith("K='")).toBe(true);
    expect(injected.endsWith("'\n")).toBe(true);
    const value = injected.slice("K='".length, injected.length - 2);
    expect(value).toBe('x\nLD_PRELOAD=/home/u/evil.so');

    // Embedded single quotes use the '\'' escape; leading-$ values quoted too.
    expect(mergeEnvLine('', 'K', "it's")).toBe("K='it'\\''s'\n");
    expect(mergeEnvLine('', 'K', '$HOME')).toBe("K='$HOME'\n");
  });
});

describe('applyRuntimeConfig — claude-code', () => {
  it('merges settings.json (user keys survive), 0600, idempotent', () => {
    const file = writeRel(
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash'] }, env: { CUSTOM: 'keep' } }),
    );
    const { files } = applyRuntimeConfig(
      'claude-code',
      spec({ api: 'anthropic-messages' }),
      'sk-ant-secret',
      home,
    );
    expect(files).toEqual(['~/.claude/settings.json']);
    const first = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect((first.permissions as { allow: string[] }).allow).toEqual(['Bash']);
    expect((first.env as Record<string, string>).CUSTOM).toBe('keep');
    expect((first.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-secret');
    expect((first.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      'https://gw.example.com/v1',
    );
    expect(first.model).toBe('gw-large');
    // 9 W13 — the picker allowlist rides along (single model = just it).
    expect(first.availableModels).toEqual(['gw-large']);
    expect(mode(file)).toBe(0o600);

    applyRuntimeConfig('claude-code', spec({ api: 'anthropic-messages' }), 'sk-ant-secret', home);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(first, null, 2) + '\n');
  });

  it('availableModels = unique([model, ...models]) and REPLACES a user array (9 W13)', () => {
    // a user's own allowlist is platform-owned while a spec exists (env kept —
    // later tests in this describe assert it survives re-applies)
    writeRel(
      '.claude/settings.json',
      JSON.stringify({ env: { CUSTOM: 'keep' }, availableModels: ['old-thing'] }),
    );
    applyRuntimeConfig(
      'claude-code',
      spec({ api: 'anthropic-messages', models: ['gw-mini', 'gw-large', 'gw-flash'] }),
      'k',
      home,
    );
    const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as {
      availableModels: string[];
    };
    expect(settings.availableModels).toEqual(['gw-large', 'gw-mini', 'gw-flash']);
  });

  it('a baseUrl-less re-apply REMOVES the managed base URL but keeps user env', () => {
    applyRuntimeConfig('claude-code', spec({ api: 'anthropic-messages' }), 'k', home);
    applyRuntimeConfig(
      'claude-code',
      spec({ api: 'anthropic-messages', baseUrl: undefined }),
      'k',
      home,
    );
    const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as {
      env: Record<string, string>;
    };
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.env.CUSTOM).toBe('keep');
  });

  it('refuses to clobber an unparseable settings file', () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'hnx-rc-bad-'));
    mkdirSync(path.join(bad, '.claude'), { recursive: true });
    writeFileSync(path.join(bad, '.claude/settings.json'), 'not json', 'utf8');
    expect(() => applyRuntimeConfig('claude-code', spec(), 'k', bad)).toThrow(/not valid JSON/);
    rmSync(bad, { recursive: true, force: true });
  });

  it('#60 — panel knobs: tier pins, subagent, token caps, extra body, auth slot', () => {
    // User state to preserve + a legacy pre-tier env we retire on sight.
    writeRel(
      '.claude/settings.json',
      JSON.stringify({
        env: {
          CUSTOM: 'keep',
          ANTHROPIC_SMALL_FAST_MODEL: 'legacy-haiku',
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'stale-name',
        },
      }),
    );
    applyRuntimeConfig(
      'claude-code',
      spec({
        api: 'anthropic-messages',
        model: 'gw-large[1m]',
        models: ['gw-mini'],
        claudeCode: {
          authField: 'ANTHROPIC_API_KEY',
          tiers: [
            {
              tier: 'sonnet',
              model: 'gw-large[1m]',
              displayName: 'Gateway Large',
              capabilities: ['effort', 'thinking'],
            },
            { tier: 'haiku', model: 'gw-mini' },
          ],
          subagentModel: 'gw-mini[1m]',
          maxOutputTokens: 64000,
          maxContextTokens: 983616,
          extraBody: { enable_thinking: true },
          switches: {
            attributionHidden: true,
            teammates: true,
            toolSearch: true,
            maxEffort: true,
            autoUpgradeDisabled: true,
            artifactsDisabled: true,
          },
        },
      }),
      'sk-gw',
      home,
    );
    const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as {
      env: Record<string, string>;
      model: string;
      availableModels: string[];
      attribution: { commit: string; pr: string; sessionUrl: boolean };
    };
    // auth slot swap: the key rides API_KEY, the other var is ours to remove
    expect(settings.env.ANTHROPIC_API_KEY).toBe('sk-gw');
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // the [1m] marker rides the model slot itself (settings `model` + tier env)
    expect(settings.model).toBe('gw-large[1m]');
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gw-large[1m]');
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('Gateway Large');
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(
      'effort,thinking',
    );
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw-mini');
    // unpinned tiers + legacy + user env
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
    expect(settings.env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(settings.env.CUSTOM).toBe('keep');
    // knobs
    expect(settings.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('gw-mini[1m]');
    expect(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000');
    expect(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('983616');
    expect(settings.env.CLAUDE_CODE_EXTRA_BODY).toBe('{"enable_thinking":true}');
    // behavior switches (#60) — two are deliberately UNPREFIXED env names
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(settings.env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(settings.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
    expect(settings.env.DISABLE_AUTOUPDATER).toBe('1');
    expect(settings.env.CLAUDE_CODE_DISABLE_ARTIFACT).toBe('1');
    expect(settings.attribution).toEqual({ commit: '', pr: '', sessionUrl: false });
    // allowlist: plain ids only (markers stripped), pins + subagent unioned in
    expect(settings.availableModels).toEqual(['gw-large', 'gw-mini']);

    // idempotent re-apply
    const first = readFileSync(path.join(home, '.claude/settings.json'), 'utf8');
    applyRuntimeConfig(
      'claude-code',
      spec({
        api: 'anthropic-messages',
        model: 'gw-large[1m]',
        models: ['gw-mini'],
        claudeCode: {
          authField: 'ANTHROPIC_API_KEY',
          tiers: [
            {
              tier: 'sonnet',
              model: 'gw-large[1m]',
              displayName: 'Gateway Large',
              capabilities: ['effort', 'thinking'],
            },
            { tier: 'haiku', model: 'gw-mini' },
          ],
          subagentModel: 'gw-mini[1m]',
          maxOutputTokens: 64000,
          maxContextTokens: 983616,
          extraBody: { enable_thinking: true },
          switches: {
            attributionHidden: true,
            teammates: true,
            toolSearch: true,
            maxEffort: true,
            autoUpgradeDisabled: true,
            artifactsDisabled: true,
          },
        },
      }),
      'sk-gw',
      home,
    );
    expect(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).toBe(first);
  });

  it('#60 — a knob-less re-apply REMOVES every panel env key (revert semantics)', () => {
    applyRuntimeConfig(
      'claude-code',
      spec({ api: 'anthropic-messages', model: 'gw-large', models: undefined }),
      'sk-gw',
      home,
    );
    const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as {
      env: Record<string, string>;
      availableModels: string[];
      attribution?: unknown;
    };
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'CLAUDE_CODE_EXTRA_BODY',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
      'ENABLE_TOOL_SEARCH',
      'CLAUDE_CODE_EFFORT_LEVEL',
      'DISABLE_AUTOUPDATER',
      'CLAUDE_CODE_DISABLE_ARTIFACT',
    ]) {
      expect(settings.env[key], key).toBeUndefined();
    }
    expect(settings.attribution).toBeUndefined();
    // back on the default auth slot, plain allowlist, user env intact
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-gw');
    expect(settings.availableModels).toEqual(['gw-large']);
    expect(settings.env.CUSTOM).toBe('keep');
  });
});

describe('applyRuntimeConfig — codex', () => {
  it('writes root keys + provider section + auth.json merge-preservingly, idempotent', () => {
    const cfg = writeRel(
      '.codex/config.toml',
      '# my config\n[profiles.fast]\nmodel = "fast"\n\n[mcp_servers.mine]\ncommand = "keep"\n',
    );
    const { files } = applyRuntimeConfig('codex', spec(), 'sk-codex', home);
    expect(files).toEqual(['~/.codex/config.toml', '~/.codex/auth.json']);

    const toml = readFileSync(cfg, 'utf8');
    expect(toml).toContain('# my config');
    expect(toml).toContain('model = "gw-large"');
    expect(toml).toContain('model_provider = "harness_nexus"');
    expect(toml).toContain('[model_providers.harness_nexus]');
    expect(toml).toContain('base_url = "https://gw.example.com/v1"');
    expect(toml).toContain('requires_openai_auth = true');
    // wire_api deliberately absent: current codex removed `chat` — every route speaks Responses.
    expect(toml).not.toContain('wire_api');
    expect(toml).toContain('[mcp_servers.mine]');

    const authFile = path.join(home, '.codex/auth.json');
    writeRel('.codex/auth.json', JSON.stringify({ tokens: { id_token: 'user-login' } }));
    applyRuntimeConfig('codex', spec(), 'sk-codex-2', home);
    const auth = JSON.parse(readFileSync(authFile, 'utf8')) as Record<string, unknown>;
    expect(auth.auth_mode).toBe('apikey');
    expect(auth.OPENAI_API_KEY).toBe('sk-codex-2');
    expect((auth.tokens as { id_token: string }).id_token).toBe('user-login');
    expect(mode(authFile)).toBe(0o600);

    applyRuntimeConfig('codex', spec(), 'sk-codex-2', home);
    expect(readFileSync(cfg, 'utf8')).toBe(toml);
  });

  it('omits base_url when the spec has none (OpenAI proper + managed key)', () => {
    applyRuntimeConfig('codex', spec({ baseUrl: undefined }), 'k', home);
    const toml = readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
    expect(toml).not.toContain('base_url');
    expect(toml).toContain('requires_openai_auth = true');
  });

  it('#63 — panel dials: effort/summary/verbosity, ints bare, seed fallback', () => {
    const cfg = writeRel('.codex/config.toml', '');
    applyRuntimeConfig(
      'codex',
      spec({
        modelEntries: [{ id: 'gw-large', contextWindow: 272000 }],
        codex: {
          reasoningEffort: 'high',
          reasoningSummary: 'detailed',
          verbosity: 'low',
          autoCompactTokenLimit: 900000,
          switches: { updateCheckDisabled: true },
        },
      }),
      'k',
      home,
    );
    const toml = readFileSync(cfg, 'utf8');
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).toContain('model_reasoning_summary = "detailed"');
    expect(toml).toContain('model_verbosity = "low"');
    // panel-unset contextWindow falls back to the DEFAULT model's seed entry…
    expect(toml).toContain('model_context_window = 272000');
    // …and integers render BARE — a quoted value is a TOML string, not i64
    expect(toml).not.toContain('model_context_window = "');
    expect(toml).toContain('model_auto_compact_token_limit = 900000');
    expect(toml).toContain('check_for_update_on_startup = false');
  });

  it('#63 — contextWindow: panel beats seed; no panel + no seed = key removed', () => {
    const cfg = writeRel('.codex/config.toml', 'model_context_window = 400000\n');
    applyRuntimeConfig(
      'codex',
      spec({
        modelEntries: [{ id: 'gw-large', contextWindow: 272000 }],
        codex: { contextWindow: 1000000 },
      }),
      'k',
      home,
    );
    expect(readFileSync(cfg, 'utf8')).toContain('model_context_window = 1000000');

    applyRuntimeConfig(
      'codex',
      spec({ modelEntries: [{ id: 'gw-large', contextWindow: 272000 }] }),
      'k',
      home,
    );
    expect(readFileSync(cfg, 'utf8')).toContain('model_context_window = 272000');

    applyRuntimeConfig('codex', spec(), 'k', home);
    expect(readFileSync(cfg, 'utf8')).not.toContain('model_context_window');
  });

  it('#63 — a knob-less re-apply REMOVES every managed dial (revert semantics)', () => {
    const cfg = writeRel(
      '.codex/config.toml',
      'model_reasoning_effort = "low"\nmodel_verbosity = "high"\ncheck_for_update_on_startup = false\n# keep\n[profiles.p]\nmodel = "p"\n',
    );
    applyRuntimeConfig('codex', spec(), 'k', home);
    const toml = readFileSync(cfg, 'utf8');
    expect(toml).not.toContain('model_reasoning_effort');
    expect(toml).not.toContain('model_verbosity');
    expect(toml).not.toContain('check_for_update_on_startup');
    expect(toml).toContain('# keep');
    expect(toml).toContain('[profiles.p]');
    expect(toml).toContain('model = "p"'); // section key, not ours
  });
});

describe('applyRuntimeConfig — deepseek', () => {
  it('writes settings + the acp patch override + ~/.dsh/.env; legacy region retired', () => {
    // A pre-existing patch carrying the W3-era INSERT region (it crashed the
    // ACP profile by double-registering plugins) plus a user row.
    writeRel(
      '.dsh/cordis.patch.yml',
      [
        '- insert:',
        '    - id: user-row',
        "      name: '@deepseek-ai/dsh-something'",
        '# BEGIN harness-nexus:provider (managed) — rewritten by hnx; keep edits outside the markers',
        '- insert:',
        '    - id: hnx-llm',
        "      name: '@deepseek-ai/dsh-llm-pi-ai'",
        '# END harness-nexus:provider (managed)',
      ].join('\n') + '\n',
    );
    writeRel('.dsh/.env', 'DEEPSEEK_API_KEY=user-key\n');

    const { files } = applyRuntimeConfig(
      'deepseek',
      spec({ api: 'anthropic-messages' }),
      'sk-dsh',
      home,
    );
    expect(files).toEqual(['~/.dsh/settings.yaml', '~/.dsh/cordis.patch.yml', '~/.dsh/.env']);

    const settings = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(settings).toContain('llm-pi-ai:');
    expect(settings).toContain('harness-nexus:');
    expect(settings).toContain('api: anthropic-messages');
    expect(settings).toContain('baseURL: "https://gw.example.com/v1"');
    expect(settings).toContain('apiKeyEnv: HARNESS_NEXUS_API_KEY');
    expect(settings).toContain('- id: "gw-large"');
    expect(settings).toContain('agent-default-model:');

    const patch = readFileSync(path.join(home, '.dsh/cordis.patch.yml'), 'utf8');
    expect(patch).toContain('user-row');
    expect(patch).not.toContain('hnx-llm'); // legacy inserts gone
    expect(patch).toContain('- id: acp');
    expect(patch).toContain('provider: harness-nexus');
    expect(patch).toContain('model: "gw-large"');

    const envDoc = readFileSync(path.join(home, '.dsh/.env'), 'utf8');
    expect(envDoc).toContain('DEEPSEEK_API_KEY=user-key');
    expect(envDoc).toContain('HARNESS_NEXUS_API_KEY=sk-dsh');
    expect(mode(path.join(home, '.dsh/.env'))).toBe(0o600);

    // Idempotent re-apply (both api flavors map).
    applyRuntimeConfig('deepseek', spec({ api: 'openai' }), 'sk-dsh', home);
    const settings2 = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(settings2).toContain('api: openai-completions');
    expect((settings2.match(/BEGIN harness-nexus \(managed\)/g) ?? []).length).toBe(1);
    const patch2 = readFileSync(path.join(home, '.dsh/cordis.patch.yml'), 'utf8');
    expect((patch2.match(/BEGIN harness-nexus:provider/g) ?? []).length).toBe(1);
    expect((patch2.match(/^- id: acp$/gm) ?? []).length).toBe(1);
  });

  it('W10 — writes the multi-model switchable list (default first, deduped)', () => {
    applyRuntimeConfig(
      'deepseek',
      spec({ models: ['gw-large', 'gw-mini', 'gw-flash'] }),
      'sk-dsh',
      home,
    );
    const settings = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    const modelsBlock = settings
      .split('models:\n')[1]!
      .split('agent-default-model:')[0]
      .trim()
      .split('\n')
      .map((l) => l.trim());
    // The default leads even when the extras list repeated it.
    expect(modelsBlock).toEqual(['- id: "gw-large"', '- id: "gw-mini"', '- id: "gw-flash"']);
    // The default selection + acp override stay pinned to the default model.
    expect(settings).toContain('model: "gw-large"');
    const patch = readFileSync(path.join(home, '.dsh/cordis.patch.yml'), 'utf8');
    expect(patch).toContain('model: "gw-large"');
    expect(patch).not.toContain('gw-mini');
  });

  it('#64 — per-model detail: panel wins per-field over the seed; vision claims images', () => {
    applyRuntimeConfig(
      'deepseek',
      spec({
        models: ['gw-mini'],
        modelEntries: [
          {
            id: 'gw-large',
            displayName: 'Seed Large',
            contextWindow: 200000,
            maxOutputTokens: 16000,
            vision: true,
          },
          { id: 'gw-mini', contextWindow: 64000 },
        ],
        deepseek: { models: [{ id: 'gw-large', name: 'Panel Large', maxOutputTokens: 8000 }] },
      }),
      'sk-dsh',
      home,
    );
    const settings = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    // Panel name + maxTokens beat the seed; contextWindow falls to the seed
    // (unquoted — a YAML number, not a string); vision rides the seed.
    expect(settings).toContain('- id: "gw-large"');
    expect(settings).toContain('name: "Panel Large"');
    expect(settings).toContain('contextWindow: 200000');
    expect(settings).toContain('maxTokens: 8000');
    expect(settings).toContain('input: ["text", "image"]');
    expect(settings).not.toContain('Seed Large');
    // Seed-only entry: its contextWindow, no name, no vision claim.
    expect(settings).toContain('- id: "gw-mini"');
    expect(settings).toMatch(
      /- id: "gw-mini"\s*\n\s*contextWindow: 64000\s*\n\s*agent-default-model:/,
    );
  });

  it('#64 — bare ids stay byte-identical with no detail and no seed (compat)', () => {
    applyRuntimeConfig('deepseek', spec(), 'sk-dsh', home);
    const doc = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(doc).toContain('models:\n        - id: "gw-large"\nagent-default-model:');
    // no detail keys leaked for a bare id
    expect(doc).not.toContain('contextWindow:');
    expect(doc).not.toContain('maxTokens:');
    expect(doc).not.toContain('input:');
  });

  it('a []-placeholder base is absorbed, not appended after (two docs = boot error)', () => {
    const only = mkdtempSync(path.join(tmpdir(), 'hnx-rc-empty-'));
    mkdirSync(path.join(only, '.dsh'), { recursive: true });
    writeFileSync(path.join(only, '.dsh/cordis.patch.yml'), '[]\n', 'utf8');
    applyRuntimeConfig('deepseek', spec(), 'k', only);
    const patch = readFileSync(path.join(only, '.dsh/cordis.patch.yml'), 'utf8');
    expect(patch.startsWith('# BEGIN harness-nexus:provider')).toBe(true);
    expect(patch).not.toContain('[]');
    rmSync(only, { recursive: true, force: true });
  });

  it('refuses a hand-managed namespace section or acp override (no clobbering)', () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'hnx-rc-dup-'));
    mkdirSync(path.join(bad, '.dsh'), { recursive: true });
    writeFileSync(
      path.join(bad, '.dsh/settings.yaml'),
      'llm-pi-ai:\n  providers:\n    mine: {}\n',
      'utf8',
    );
    expect(() => applyRuntimeConfig('deepseek', spec(), 'k', bad)).toThrow(/hand-managed/);
    writeFileSync(path.join(bad, '.dsh/settings.yaml'), '', 'utf8');
    writeFileSync(
      path.join(bad, '.dsh/cordis.patch.yml'),
      '- id: acp\n  config:\n    provider: mine\n',
      'utf8',
    );
    expect(() => applyRuntimeConfig('deepseek', spec(), 'k', bad)).toThrow(/"acp"/);
    expect(readFileSync(path.join(bad, '.dsh/cordis.patch.yml'), 'utf8')).toContain('mine');
    rmSync(bad, { recursive: true, force: true });
  });

  it('refuses a baseUrl-less deepseek spec (no catalog default for our route)', () => {
    const before = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(() => applyRuntimeConfig('deepseek', spec({ baseUrl: undefined }), 'k', home)).toThrow(
      /baseUrl/,
    );
    expect(readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8')).toBe(before);
  });
});

describe('applyRuntimeConfig — opencode (9 W12)', () => {
  const cfg = (): string => path.join(home, '.config/opencode/opencode.json');
  const key = (): string => path.join(home, '.config/opencode/harness-nexus.key');

  it('writes the provider block, model route, and 0600 key file; idempotent', () => {
    applyRuntimeConfig(
      'opencode',
      spec({ api: 'openai', model: 'gw-large', models: ['gw-mini'] }),
      'sk-test-1',
      home,
    );
    const parsed = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      model: string;
      provider: Record<
        string,
        {
          npm: string;
          name: string;
          options: Record<string, string>;
          models: Record<string, unknown>;
        }
      >;
    };
    expect(parsed.model).toBe('harness-nexus/gw-large');
    const block = parsed.provider['harness-nexus']!;
    expect(block.npm).toBe('@ai-sdk/openai-compatible'); // coarse openai → chat completions
    expect(block.name).toBe('team gateway');
    expect(block.options.baseURL).toBe('https://gw.example.com/v1');
    expect(block.options.apiKey).toBe('{file:~/.config/opencode/harness-nexus.key}');
    expect(Object.keys(block.models)).toEqual(['gw-large', 'gw-mini']); // default leads the switchable set
    // opencode ≥1.18 rejects bare `{}` model entries — every entry carries
    // BOTH limit keys (fallbacks when the registry has no curated value:
    // 1.18.31 rejects output-only entries with "Missing key …limit.context").
    expect(block.models['gw-large']).toEqual({ limit: { output: 8192, context: 128_000 } });
    expect(block.models['gw-mini']).toEqual({ limit: { output: 8192, context: 128_000 } });
    // RAW secret, no trailing newline — opencode reads the {file:} target
    // verbatim; a `\n` would ride the key and the gateway rejects it.
    expect(readFileSync(key(), 'utf8')).toBe('sk-test-1');
    expect(mode(cfg())).toBe(0o600);
    expect(mode(key())).toBe(0o600);

    applyRuntimeConfig(
      'opencode',
      spec({ api: 'openai', model: 'gw-large', models: ['gw-mini'] }),
      'sk-test-2',
      home,
    );
    expect(readFileSync(key(), 'utf8')).toBe('sk-test-2');
    expect(JSON.parse(readFileSync(cfg(), 'utf8'))).toEqual(parsed); // byte-stable re-apply
  });

  it('fills model name/limit from #51 registry entries; bare ids keep the fallback', () => {
    applyRuntimeConfig(
      'opencode',
      spec({
        api: 'openai',
        model: 'gw-large',
        models: ['gw-mini'],
        modelEntries: [
          {
            id: 'gw-large',
            displayName: 'Gateway Large',
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
          },
        ],
      }),
      'sk-entry',
      home,
    );
    const parsed = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      provider: Record<string, { models: Record<string, unknown> }>;
    };
    const models = parsed.provider['harness-nexus']!.models;
    expect(models['gw-large']).toEqual({
      name: 'Gateway Large',
      limit: { output: 16_384, context: 200_000 },
    });
    expect(models['gw-mini']).toEqual({ limit: { output: 8192, context: 128_000 } });
  });

  it('#62 — panel detail wins per-field over the seed; capabilities, options, small_model, autoupdate', () => {
    applyRuntimeConfig(
      'opencode',
      spec({
        api: 'openai',
        model: 'gw-large',
        models: ['gw-mini'],
        modelEntries: [
          {
            id: 'gw-large',
            displayName: 'Seeded Name',
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
          },
        ],
        opencode: {
          models: [
            {
              id: 'gw-large',
              name: 'Panel Name', // panel name wins over the seed
              maxOutputTokens: 32_000, // panel output wins; context still seeds
              reasoning: true,
              temperatureEnabled: true,
              vision: true,
              options: { enable_thinking: true },
            },
            { id: 'gw-mini', contextWindow: 65_536 }, // bare id gets panel-only context
          ],
          smallModel: 'gw-mini',
          autoupdateDisabled: true,
        },
      }),
      'sk-panel',
      home,
    );
    const parsed = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      small_model: string;
      autoupdate: boolean;
      provider: { 'harness-nexus'?: { models: Record<string, unknown> } };
    };
    const models = parsed.provider['harness-nexus']!.models;
    expect(models['gw-large']).toEqual({
      name: 'Panel Name',
      reasoning: true,
      temperature: true,
      attachment: true,
      options: { enable_thinking: true },
      limit: { output: 32_000, context: 200_000 },
    });
    expect(models['gw-mini']).toEqual({ limit: { output: 8192, context: 65_536 } });
    expect(parsed.small_model).toBe('harness-nexus/gw-mini');
    expect(parsed.autoupdate).toBe(false);

    // idempotent re-apply
    const first = readFileSync(cfg(), 'utf8');
    applyRuntimeConfig(
      'opencode',
      spec({
        api: 'openai',
        model: 'gw-large',
        models: ['gw-mini'],
        modelEntries: [
          {
            id: 'gw-large',
            displayName: 'Seeded Name',
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
          },
        ],
        opencode: {
          models: [
            {
              id: 'gw-large',
              name: 'Panel Name',
              maxOutputTokens: 32_000,
              reasoning: true,
              temperatureEnabled: true,
              vision: true,
              options: { enable_thinking: true },
            },
            { id: 'gw-mini', contextWindow: 65_536 },
          ],
          smallModel: 'gw-mini',
          autoupdateDisabled: true,
        },
      }),
      'sk-panel',
      home,
    );
    expect(readFileSync(cfg(), 'utf8')).toBe(first);
  });

  it('#62 — a knob-less re-apply REMOVES small_model/autoupdate; limits fall back', () => {
    applyRuntimeConfig(
      'opencode',
      spec({
        api: 'openai',
        model: 'gw-large',
        models: undefined,
        modelEntries: [{ id: 'gw-large', contextWindow: 131_072 }],
      }),
      'sk-panel',
      home,
    );
    const parsed = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      small_model?: string;
      autoupdate?: boolean;
      provider: { 'harness-nexus'?: { models: Record<string, unknown> } };
    };
    expect(parsed.small_model).toBeUndefined();
    expect(parsed.autoupdate).toBeUndefined();
    // capabilities gone, limits back to seed → fallback chain
    expect(parsed.provider['harness-nexus']!.models['gw-large']).toEqual({
      limit: { output: 8192, context: 131_072 },
    });
  });

  it('preserves user config keys and other providers', () => {
    writeRel(
      '.config/opencode/opencode.json',
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          theme: 'dark', // user key survives
          provider: { openai: { npm: '@ai-sdk/openai', options: {} } }, // other provider survives
          mcp: { myserver: { type: 'local', command: ['bun', 'x', 'mcp-thing'] } },
        },
        null,
        2,
      ),
    );
    applyRuntimeConfig('opencode', spec({ api: 'openai' }), 'sk-3', home);
    const parsed = JSON.parse(readFileSync(cfg(), 'utf8')) as Record<string, unknown> & {
      provider: Record<string, unknown>;
    };
    expect(parsed['$schema']).toBe('https://opencode.ai/config.json');
    expect(parsed.theme).toBe('dark');
    expect(Object.keys(parsed.provider)).toContain('openai');
    expect((parsed.mcp as { myserver: unknown }).myserver).toBeDefined();
  });

  it('anthropic flavor maps to @ai-sdk/anthropic; a baseUrl-less re-apply REMOVES ours', () => {
    applyRuntimeConfig('opencode', spec({ api: 'anthropic-messages' }), 'sk-4', home);
    const withBase = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      provider: { 'harness-nexus'?: { npm: string; options: Record<string, string> } };
    };
    expect(withBase.provider['harness-nexus']!.npm).toBe('@ai-sdk/anthropic');
    expect(withBase.provider['harness-nexus']!.options.baseURL).toBe('https://gw.example.com/v1');

    applyRuntimeConfig(
      'opencode',
      spec({ api: 'anthropic-messages', baseUrl: undefined }),
      'sk-4',
      home,
    );
    const noBase = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      provider: { 'harness-nexus'?: { options: Record<string, string> } };
    };
    expect(noBase.provider['harness-nexus']!.options.baseURL).toBeUndefined();
  });

  it('normalizes a /v1-less gateway base onto the AI SDK convention (rig-found)', () => {
    // claude-code takes Ark's `/api/coding` VERBATIM; the AI SDK appends only
    // the method path, so without `/v1` the request hits a nonexistent route
    // and the gateway auth-checks BEFORE routing — "Unauthorized", not 404.
    applyRuntimeConfig(
      'opencode',
      spec({ api: 'anthropic-messages', baseUrl: 'https://ark.example.com/api/coding' }),
      'sk-6',
      home,
    );
    const parsed = JSON.parse(readFileSync(cfg(), 'utf8')) as {
      provider: { 'harness-nexus'?: { options: Record<string, string> } };
    };
    expect(parsed.provider['harness-nexus']!.options.baseURL).toBe(
      'https://ark.example.com/api/coding/v1',
    );
  });

  it('refuses a commented (JSONC) config without touching it', () => {
    const jsonc = '{\n  // my hand-written comments\n  "theme": "dark"\n}\n';
    writeRel('.config/opencode/opencode.json', jsonc);
    expect(() => applyRuntimeConfig('opencode', spec({ api: 'openai' }), 'sk-5', home)).toThrow(
      /not valid JSON/,
    );
    expect(readFileSync(cfg(), 'utf8')).toBe(jsonc);
  });
});

describe('applyRuntimeConfig — pi (9 W16)', () => {
  const models = (): string => path.join(home, '.pi/agent/models.json');
  const settings = (): string => path.join(home, '.pi/agent/settings.json');
  const key = (): string => path.join(home, '.pi/agent/harness-nexus.key');

  it('writes the provider entry, settings defaults, and 0600 key file; idempotent', () => {
    applyRuntimeConfig(
      'pi',
      spec({ api: 'openai', model: 'gw-large', models: ['gw-mini'] }),
      'sk-pi-1',
      home,
    );
    const modelsDoc = JSON.parse(readFileSync(models(), 'utf8')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    const block = modelsDoc.providers['harness-nexus']!;
    expect(block.baseUrl).toBe('https://gw.example.com/v1');
    expect(block.api).toBe('openai-completions'); // coarse openai → chat completions
    // The key is read at REQUEST time via pi's !command syntax — TUI, bridge,
    // and headless all resolve it, quoting the absolute path for the shell.
    expect(block.apiKey).toBe(`!cat ${JSON.stringify(key())}`);
    expect(block.models).toEqual([{ id: 'gw-large' }, { id: 'gw-mini' }]); // default leads

    const settingsDoc = JSON.parse(readFileSync(settings(), 'utf8')) as Record<string, unknown>;
    expect(settingsDoc.defaultProvider).toBe('harness-nexus');
    expect(settingsDoc.defaultModel).toBe('gw-large');
    expect(settingsDoc.enabledModels).toEqual(['gw-large', 'gw-mini']);

    // RAW secret, no trailing newline — `!cat` hands the bytes over verbatim.
    expect(readFileSync(key(), 'utf8')).toBe('sk-pi-1');
    expect(mode(models())).toBe(0o600);
    expect(mode(settings())).toBe(0o600);
    expect(mode(key())).toBe(0o600);

    const before = readFileSync(models(), 'utf8');
    applyRuntimeConfig(
      'pi',
      spec({ api: 'openai', model: 'gw-large', models: ['gw-mini'] }),
      'sk-pi-2',
      home,
    );
    expect(readFileSync(key(), 'utf8')).toBe('sk-pi-2');
    expect(readFileSync(models(), 'utf8')).toBe(before); // byte-stable re-apply
  });

  it('maps the anthropic flavor and preserves user keys + other providers', () => {
    writeRel(
      '.pi/agent/settings.json',
      JSON.stringify({ theme: 'light', enabledModels: ['user-model'] }, null, 2),
    );
    writeRel(
      '.pi/agent/models.json',
      JSON.stringify({ providers: { openai: { baseUrl: 'https://api.openai.com/v1' } } }, null, 2),
    );
    applyRuntimeConfig('pi', spec({ api: 'anthropic-messages' }), 'sk-pi-3', home);
    const modelsDoc = JSON.parse(readFileSync(models(), 'utf8')) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(modelsDoc.providers['harness-nexus']!.api).toBe('anthropic-messages');
    expect(modelsDoc.providers.openai).toBeDefined(); // other provider survives
    const settingsDoc = JSON.parse(readFileSync(settings(), 'utf8')) as Record<string, unknown>;
    expect(settingsDoc.theme).toBe('light'); // user key survives
    expect(settingsDoc.enabledModels).toEqual(['gw-large']); // platform-owned key
  });

  it('refuses a baseUrl-less or malformed-JSON state without touching files', () => {
    const beforeModels = readFileSync(models(), 'utf8');
    expect(() => applyRuntimeConfig('pi', spec({ baseUrl: undefined }), 'k', home)).toThrow(
      /baseUrl/,
    );
    expect(readFileSync(models(), 'utf8')).toBe(beforeModels);

    const junk = '{\n  // hand-written\n}\n';
    writeRel('.pi/agent/models.json', junk);
    expect(() => applyRuntimeConfig('pi', spec(), 'k', home)).toThrow(/not valid JSON/);
    expect(readFileSync(models(), 'utf8')).toBe(junk);
  });
});

/** Minimal socket recorder (same trick as the W2 runtime-job tests). */
class FakeSocket extends EventEmitter {
  sent: { event: string; payload: unknown }[] = [];
  override emit(event: string, payload: unknown): boolean {
    this.sent.push({ event, payload });
    return true;
  }
  last<T = never>(event: string): { payload: T } | undefined {
    const hit = [...this.sent].reverse().find((e) => e.event === event);
    return hit as { payload: T } | undefined;
  }
}

describe('runApplyConfigJob', () => {
  it('settles a malformed payload as a failed job (never hangs the daemon)', async () => {
    const sock = new FakeSocket();
    await runApplyConfigJob(
      sock as never,
      { server: 'http://127.0.0.1:1', token: 'x' },
      { id: 'j1', payload: { type: 'harness', action: 'install', target: 'codex' } } as never,
      home,
    );
    const result = sock.last<{ ok: boolean; error?: string }>('job:result')!.payload;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('harness payload invalid');
  });
});

describe('applyRuntimeConfig — pi modelEntries (#51)', () => {
  const models = (): string => path.join(home, '.pi/agent/models.json');

  beforeAll(() => {
    // The malformed-JSON refusal test above leaves a poisoned models.json
    // behind (it must not touch it); start this describe from a clean .pi.
    rmSync(path.join(home, '.pi'), { recursive: true, force: true });
  });

  it('enriches registry ids with name/contextWindow/maxTokens/input; bare ids stay bare', () => {
    applyRuntimeConfig(
      'pi',
      spec({
        api: 'openai',
        model: 'gw-large',
        models: ['gw-mini', 'gw-unknown'],
        modelEntries: [
          {
            id: 'gw-large',
            displayName: 'Gateway Large',
            contextWindow: 256_000,
            maxOutputTokens: 32_000,
          },
          { id: 'gw-mini', displayName: 'Mini', contextWindow: 128_000, vision: true },
        ],
      }),
      'sk-pi-9',
      home,
    );
    const modelsDoc = JSON.parse(readFileSync(models(), 'utf8')) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const entries = modelsDoc.providers['harness-nexus']!.models;
    expect(entries).toEqual([
      {
        id: 'gw-large',
        name: 'Gateway Large',
        contextWindow: 256_000,
        maxTokens: 32_000,
      },
      { id: 'gw-mini', name: 'Mini', contextWindow: 128_000, input: ['text', 'image'] },
      { id: 'gw-unknown' }, // absent from the registry → honest bare id
    ]);
  });

  it('#65 — panel overlay wins per-field; reasoning + samplingParams are panel-only', () => {
    rmSync(path.join(home, '.pi'), { recursive: true, force: true });
    applyRuntimeConfig(
      'pi',
      spec({
        api: 'openai',
        model: 'gw-large',
        modelEntries: [
          {
            id: 'gw-large',
            displayName: 'Seed Large',
            contextWindow: 256_000,
            maxOutputTokens: 32_000,
            vision: true,
          },
        ],
        pi: {
          models: [
            {
              id: 'gw-large',
              name: 'Panel Large',
              contextWindow: 128_000,
              reasoning: true,
              samplingParams: { enable_thinking: true, top_p: 0.9 },
            },
          ],
        },
      }),
      'sk-pi-10',
      home,
    );
    const modelsDoc = JSON.parse(readFileSync(models(), 'utf8')) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const entry = modelsDoc.providers['harness-nexus']!.models[0]!;
    // panel name + contextWindow beat the seed; maxTokens falls to the seed;
    // vision rides the seed (panel left it unset); the two panel-only knobs ride along
    expect(entry).toEqual({
      id: 'gw-large',
      name: 'Panel Large',
      contextWindow: 128_000,
      maxTokens: 32_000,
      input: ['text', 'image'],
      reasoning: true,
      samplingParams: { enable_thinking: true, top_p: 0.9 },
    });

    // a knob-less re-apply drops the panel overlay and returns to the seed shape
    applyRuntimeConfig(
      'pi',
      spec({
        api: 'openai',
        model: 'gw-large',
        modelEntries: [{ id: 'gw-large', displayName: 'Seed Large', contextWindow: 256_000 }],
      }),
      'sk-pi-10',
      home,
    );
    const resealed = JSON.parse(readFileSync(models(), 'utf8')) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(resealed.providers['harness-nexus']!.models[0]).toEqual({
      id: 'gw-large',
      name: 'Seed Large',
      contextWindow: 256_000,
    });
  });
});
