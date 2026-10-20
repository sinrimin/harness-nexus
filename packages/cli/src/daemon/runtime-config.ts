// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { homedir } from 'node:os';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  CLAUDE_CODE_TIERS,
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  OPENCODE_PROVIDER_ID,
  PI_PROVIDER_ID,
  stripClaudeOneMarker,
  type JobView,
  type RuntimeConfigSpec,
} from '@harness-nexus/shared';
import { HarnessNexusClient } from '@harness-nexus/sdk';
import { beginMarker, endMarker, DSH_PATCH_FILENAME } from '../install/adapters/deepseek.js';
import { mergeTomlSection } from '../install/adapters/codex.js';
import { dshNodeWarning, piNodeWarning } from './runtime.js';
import { logOp } from './logbook.js';

/**
 * Provider-config apply (Phase 9 W3) — the daemon half of
 * wiki design-phase-9-harness-runtime.md §4.3.
 *
 * `apply-config` harness jobs fetch the resolved `{spec, secret}` bundle with
 * the machine PAT (execution-time resolution: a requeued job after a spec or
 * credential edit applies the CURRENT value) and write each harness's NATIVE
 * slots. All writes are merge-preserving and idempotent (re-apply = upgrade);
 * every touched file ends 0600. Ground truth per target:
 *
 *  - claude-code: `~/.claude/settings.json` — `env.ANTHROPIC_BASE_URL` (only
 *    while the spec sets one; a later unset REMOVES ours), the key on
 *    `env.ANTHROPIC_AUTH_TOKEN` or `env.ANTHROPIC_API_KEY` (#60 panel choice),
 *    top-level `model` (base URL alone doesn't switch the model),
 *    and top-level `availableModels` = unique([model, ...models]) (9 W13 —
 *    the ACP wrapper restricts its model configOption to this allowlist, so
 *    the session dropdown lists only gateway-servable ids; it also narrows
 *    the machine's terminal /model picker, which is the documented Claude
 *    Code semantics for a managed route). #60 adds the dedicated claude-code
 *    panel knobs (`spec.claudeCode`): alias-tier pins
 *    (`ANTHROPIC_DEFAULT_{TIER}_MODEL` + `_NAME`/`_SUPPORTED_CAPABILITIES`),
 *    `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_MAX_{OUTPUT,CONTEXT}_TOKENS`,
 *    `CLAUDE_CODE_EXTRA_BODY` — all in the env block, all with the same
 *    unset-REMOVES-ours revert semantics; `[1m]` markers stay on the model
 *    slots and are stripped from the allowlist.
 *  - codex: `~/.codex/config.toml` — root keys `model` + `model_provider`, and
 *    the `[model_providers.harness_nexus]` block with `requires_openai_auth =
 *    true` (the built-in provider's own shape — auth comes from auth.json, no
 *    env var). `~/.codex/auth.json` — apikey mode with the key as
 *    `OPENAI_API_KEY`. `wire_api` is NOT set: current codex removed `chat`, so
 *    every route speaks Responses — gateways must be Responses-compatible.
 *    #63 adds the panel dials (`spec.codex`): `model_reasoning_effort`,
 *    `model_reasoning_summary`, `model_verbosity`,
 *    `model_context_window` (panel value > the #51 modelEntries seed of the
 *    default model > key removed), `model_auto_compact_token_limit`, and
 *    `check_for_update_on_startup = false` while the switch is on — all
 *    TOP-LEVEL keys with the claude-code unset-REMOVES-ours revert semantic.
 *  - deepseek: the SETTINGS layer (`~/.dsh/settings.yaml`, namespace
 *    `llm-pi-ai` with the provider route + `agent-default-model` selecting
 *    it). NOT loader-entry inserts in `cordis.patch.yml` — the dsh
 *    composition already mounts both plugins, and a second insert
 *    double-registers them ("configurable provider … already declared" /
 *    "service agentDefaultModel has been registered") and crashes
 *    `--profile acp`. A legacy W3 patch region is retired by the same apply.
 *    The key goes to `~/.dsh/.env` under `HARNESS_NEXUS_API_KEY` — dsh's own
 *    user-env credential layer, read on EVERY launch (user shells included).
 *    #64 adds per-model detail on the `models:` entries (`name` /
 *    `contextWindow` / `maxTokens` / `input` for vision) with the opencode
 *    precedence — panel value (`spec.deepseek`) > #51 modelEntries seed >
 *    key omitted (the route's own defaults apply; never a guessed value).
 */

/** dsh resolves this name through process env > ~/.dsh/.credentials.yaml > ./.env > ~/.dsh/.env. */
const DSH_API_KEY_ENV = 'HARNESS_NEXUS_API_KEY';

/** codex provider id — also the `model_provider` root key value. */
const CODEX_PROVIDER_ID = 'harness_nexus';

const PROVIDER_REGION = 'provider';

function readJson(file: string): Record<string, unknown> {
  let raw = '{}';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {}; // absent file — nothing to merge
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — fix or remove it and re-apply`,
    );
  }
}

function writeSecretFile(file: string, content: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
  chmodSync(file, 0o600);
  return file;
}

/** Display path (`~/.codex/config.toml`) for job result data — never leaks the home dir. */
const display = (homeDir: string, file: string): string =>
  `~${file.startsWith(homeDir) ? file.slice(homeDir.length) : file}`;

// ---- claude-code ----

function applyClaudeConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.claude');
  const file = join(dir, 'settings.json');
  const settings = readJson(file);
  const cc = spec.claudeCode;
  const env: Record<string, string> = {
    ...((settings.env as Record<string, string> | undefined) ?? {}),
  };
  // #60 — the key rides the panel's chosen auth slot; the other one is ours
  // to remove (claude-code warns when both are set).
  const authField = cc?.authField ?? 'ANTHROPIC_AUTH_TOKEN';
  env[authField] = secret;
  delete env[authField === 'ANTHROPIC_AUTH_TOKEN' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'];
  if (spec.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = spec.baseUrl;
  else delete env.ANTHROPIC_BASE_URL; // the platform owns the route — unset means revert to default
  // #60 — alias-tier pins. Every tier slot is platform-owned: an unpinned
  // tier removes whatever we wrote there before (revert semantics), and the
  // legacy pre-tier background-model env is retired on sight.
  for (const tier of CLAUDE_CODE_TIERS) {
    const row = cc?.tiers?.find((t) => t.tier === tier);
    const prefix = `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;
    if (row !== undefined) {
      env[prefix] = row.model;
      if (row.displayName !== undefined && row.displayName !== '') {
        env[`${prefix}_NAME`] = row.displayName;
      } else delete env[`${prefix}_NAME`];
      if (row.capabilities !== undefined && row.capabilities.length > 0) {
        env[`${prefix}_SUPPORTED_CAPABILITIES`] = row.capabilities.join(',');
      } else delete env[`${prefix}_SUPPORTED_CAPABILITIES`];
    } else {
      delete env[prefix];
      delete env[`${prefix}_NAME`];
      delete env[`${prefix}_SUPPORTED_CAPABILITIES`];
    }
  }
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  const knob = (key: string, value: string | undefined): void => {
    if (value !== undefined) env[key] = value;
    else delete env[key];
  };
  knob('CLAUDE_CODE_SUBAGENT_MODEL', cc?.subagentModel);
  knob('CLAUDE_CODE_MAX_OUTPUT_TOKENS', cc?.maxOutputTokens?.toString());
  knob('CLAUDE_CODE_MAX_CONTEXT_TOKENS', cc?.maxContextTokens?.toString());
  knob(
    'CLAUDE_CODE_EXTRA_BODY',
    cc?.extraBody !== undefined ? JSON.stringify(cc.extraBody) : undefined,
  );
  // #60 behavior switches — on writes the managed key, off removes ours (the
  // attribution object is a settings-level key with BASE_URL-style ownership:
  // while any spec exists, an unchecked toggle reverts it to claude-code's
  // default, same as an unset base URL).
  const sw = cc?.switches;
  knob('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', sw?.teammates === true ? '1' : undefined);
  knob('ENABLE_TOOL_SEARCH', sw?.toolSearch === true ? 'true' : undefined);
  knob('CLAUDE_CODE_EFFORT_LEVEL', sw?.maxEffort === true ? 'max' : undefined);
  knob('DISABLE_AUTOUPDATER', sw?.autoUpgradeDisabled === true ? '1' : undefined);
  knob('CLAUDE_CODE_DISABLE_ARTIFACT', sw?.artifactsDisabled === true ? '1' : undefined);
  // 9 W13 — the picker allowlist. Written whenever a spec exists (even a
  // single model: under a gateway the built-in catalog is dead entries, same
  // policy as dsh/opencode). Platform-owned key: re-apply overwrites whatever
  // the user had there. #60: the allowlist matches PLAIN ids — `[1m]` markers
  // ride the model slots (settings `model` + the tier envs), not the list —
  // and tier-pinned / subagent ids join so the locks never reject a pin.
  const pinned = (cc?.tiers ?? []).map((t) => t.model);
  if (cc?.subagentModel !== undefined) pinned.push(cc.subagentModel);
  const availableModels = [
    ...new Set([spec.model, ...(spec.models ?? []), ...pinned].map(stripClaudeOneMarker)),
  ];
  const managed: Record<string, unknown> = { ...settings, env, model: spec.model, availableModels };
  if (sw?.attributionHidden === true) {
    managed.attribution = { commit: '', pr: '', sessionUrl: false };
  } else {
    delete managed.attribution;
  }
  writeSecretFile(file, `${JSON.stringify(managed, null, 2)}\n`);
  return [display(homeDir, file)];
}

// ---- codex ----

/**
 * Set TOP-LEVEL key/value pairs in a TOML document, preserving every other
 * byte. Only the region before the first `[section]` header is ours to edit
 * (a `model` inside a section belongs to that section); missing keys are
 * appended to that region. Values render TOML-native: strings JSON-escaped
 * (valid TOML basic-string escaping), numbers/booleans bare. A `null` value
 * REMOVES the key's line (0.154-era codex ignores unknown keys, but a stale
 * managed value must not linger after the panel clears it) — the claude-code
 * writer's unset-REMOVES-ours revert semantic, here in TOML.
 */
export function mergeTomlRootKeys(
  existing: string,
  values: Record<string, string | number | boolean | null>,
): string {
  const render = (v: string | number | boolean): string =>
    typeof v === 'string' ? JSON.stringify(v) : String(v);
  const headerRe = /^\s*\[/;
  const lines = existing.split('\n');
  const firstHeader = lines.findIndex((l) => headerRe.test(l));
  const topEnd = firstHeader === -1 ? lines.length : firstHeader;
  const top = lines.slice(0, topEnd);
  const rest = lines.slice(topEnd);

  const remaining = new Map(Object.entries(values));
  const rewritten: string[] = [];
  for (const line of top) {
    const key = /^(\s*[A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]?.trim();
    const hit = key !== undefined ? remaining.get(key) : undefined;
    if (key !== undefined && hit != null) {
      rewritten.push(`${key} = ${render(hit)}`);
      remaining.delete(key);
    } else if (key !== undefined && hit === null) {
      remaining.delete(key); // removal — drop the managed line entirely
    } else {
      rewritten.push(line);
    }
  }
  // Append missing keys at the end of the top-level region (before trailing
  // blank lines so a header below keeps its spacing). Null-valued keys that
  // never matched a line are pure removals of absent keys — nothing to append.
  let insertAt = rewritten.length;
  while (insertAt > 0 && rewritten[insertAt - 1]!.trim() === '') insertAt--;
  rewritten.splice(
    insertAt,
    0,
    ...[...remaining.entries()]
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k} = ${render(v as string | number | boolean)}`),
  );

  const out = [...rewritten, ...rest].join('\n').replace(/\s+$/, '');
  return `${out}${out.length > 0 ? '\n' : ''}`;
}

function applyCodexConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.codex');
  const cfgPath = join(dir, 'config.toml');
  let cfg = '';
  try {
    cfg = readFileSync(cfgPath, 'utf8');
  } catch {
    cfg = ''; // absent file — fresh document
  }
  const cx = spec.codex;
  // #63 — the panel's dials are TOP-LEVEL keys, single global value per
  // install, platform-owned while a spec exists: configured writes ours,
  // unset REMOVES ours. `model_context_window` is the one layered exception —
  // an untouched panel still writes the #51 seed of the default model (a real
  // registry window beats codex's 272k assumption for unknown slugs); with no
  // seed either, the key comes off and codex assumes 272k.
  const seedWindow = (spec.modelEntries ?? []).find((e) => e.id === spec.model)?.contextWindow;
  const sectionBody = [
    `name = ${JSON.stringify(spec.providerLabel)}`,
    ...(spec.baseUrl !== undefined ? [`base_url = ${JSON.stringify(spec.baseUrl)}`] : []),
    'requires_openai_auth = true',
  ].join('\n');
  cfg = mergeTomlSection(
    mergeTomlRootKeys(cfg, {
      model: spec.model,
      model_provider: CODEX_PROVIDER_ID,
      model_reasoning_effort: cx?.reasoningEffort ?? null,
      model_reasoning_summary: cx?.reasoningSummary ?? null,
      model_verbosity: cx?.verbosity ?? null,
      model_context_window: cx?.contextWindow ?? seedWindow ?? null,
      model_auto_compact_token_limit: cx?.autoCompactTokenLimit ?? null,
      check_for_update_on_startup: cx?.switches?.updateCheckDisabled === true ? false : null,
    }),
    `model_providers.${CODEX_PROVIDER_ID}`,
    sectionBody,
  );
  writeSecretFile(cfgPath, cfg);

  const authPath = join(dir, 'auth.json');
  const auth = readJson(authPath);
  writeSecretFile(
    authPath,
    `${JSON.stringify({ ...auth, auth_mode: 'apikey', OPENAI_API_KEY: secret }, null, 2)}\n`,
  );
  return [display(homeDir, cfgPath), display(homeDir, authPath)];
}

// ---- deepseek ----

/** Replace (or append) one `KEY=VALUE` line in a dotenv document, preserving the rest. */
export function mergeEnvLine(existing: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  // #21: single-quote values with anything beyond a conservative charset — a
  // secret containing newlines/`$`/spaces/quotes must not inject extra
  // KEY=VALUE lines into a file read on every launch. dotenv keeps
  // single-quoted values literal; embedded quotes use the `'\''` escape.
  // Plain values stay unquoted (byte-identical to previous deploys).
  const safe = /^[A-Za-z0-9_./@+=-]*$/.test(value);
  const rendered = safe ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const line = `${key}=${rendered}`;
  const base = re.test(existing)
    ? existing.replace(re, line)
    : existing.replace(/\s+$/, '') + (existing.trim().length > 0 ? '\n' : '') + line;
  return `${base.replace(/\s+$/, '')}\n`;
}

const DSH_API_MAP: Record<RuntimeConfigSpec['api'], string> = {
  // pi-ai KnownApi values (verified against the installed catalog types).
  'anthropic-messages': 'anthropic-messages',
  openai: 'openai-completions',
};

/** Settings namespaces our managed region owns (verified against the plugins). */
const DSH_LLM_NS = 'llm-pi-ai';
const DSH_DEFAULT_MODEL_NS = 'agent-default-model';

const SETTINGS_BEGIN =
  '# BEGIN harness-nexus (managed) — rewritten by hnx; keep edits outside the markers';
const SETTINGS_END = '# END harness-nexus (managed)';

/**
 * Strip a marked block (full-line comment markers) from a document. Returns
 * the remainder with collapsed surrounding blank lines. A base that is JUST
 * an empty placeholder (`[]` / `{}`) is treated as empty — appending entries
 * after it would produce two YAML documents (a boot-time parse error).
 */
export function stripMarkedBlock(existing: string, begin: string, end: string): string {
  const b = existing.indexOf(begin);
  let doc = existing;
  if (b !== -1) {
    const e = existing.indexOf(end, b);
    if (e !== -1) {
      const before = existing.slice(0, b);
      const after = existing.slice(e + end.length).replace(/^\n+/, '');
      doc = `${before.replace(/\s+$/, '')}${before.trim().length > 0 ? '\n\n' : ''}${after}`;
    }
  }
  const trimmed = doc.trim();
  return trimmed === '[]' || trimmed === '{}' ? '' : doc;
}

/**
 * Manage the dsh provider route across its THREE native slots:
 *
 *  1. `~/.dsh/settings.yaml` (`dsh-settings-file`) — the `llm-pi-ai` namespace
 *     (the provider route; dormant until a section appears) and
 *     `agent-default-model` (the default selection). The general channel for
 *     already-mounted plugins; a hand-managed namespace section is refused
 *     (duplicate keys brick boot).
 *  2. `~/.dsh/cordis.patch.yml` — an id-targeted CONFIG OVERRIDE of the `acp`
 *     entry: the dsh-acp-app composition pins `provider: deepseek-official`
 *     on the acp plugin itself, and a plugin's explicit config beats the
 *     settings default for its sessions — without this override CHAT keeps
 *     hitting the old route. (The W3 build INSERTED duplicate plugins here,
 *     which double-registered and crashed `--profile acp`; inserts are gone,
 *     and the same apply retires any legacy region.)
 *  3. `~/.dsh/.env` — the key under `HARNESS_NEXUS_API_KEY`, dsh's user-env
 *     credential layer (read on every launch, user shells included).
 */
function applyDshConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.dsh');
  const files: string[] = [];
  const patchPath = join(dir, DSH_PATCH_FILENAME);

  // 1. The settings document.
  const settingsPath = join(dir, 'settings.yaml');
  let doc = '';
  try {
    doc = readFileSync(settingsPath, 'utf8');
  } catch {
    doc = ''; // absent document — fresh store
  }
  const base = stripMarkedBlock(doc, SETTINGS_BEGIN, SETTINGS_END);
  for (const ns of [DSH_LLM_NS, DSH_DEFAULT_MODEL_NS]) {
    if (new RegExp(`^${ns}:`, 'm').test(base)) {
      throw new Error(
        `~/.dsh/settings.yaml already has a hand-managed "${ns}" section — hnx will not overwrite it; ` +
          'remove or rename that section and re-apply',
      );
    }
  }
  const yq = JSON.stringify; // JSON quoting is valid YAML 1.2 double-quoting
  // W10 — dsh's per-provider `models:` list IS the session-switchable set;
  // the default model leads. (The server already dedupes against `model`,
  // this is belt-and-braces for hand-queued bundles.)
  const modelIds = [...new Set([spec.model, ...(spec.models ?? [])])];
  // #64 — per-model detail overlays the #51 seed per field; an id with
  // neither stays a BARE entry (byte-identical to the pre-#64 emission, so
  // an untouched spec re-applies unchanged). `vision: true` claims images
  // (`input: ["text","image"]` — JSON flow is valid YAML); absent stays the
  // route default (text), the pi-writer stance of never guessing.
  const entriesById = new Map((spec.modelEntries ?? []).map((e) => [e.id, e]));
  const detailById = new Map((spec.deepseek?.models ?? []).map((m) => [m.id, m]));
  const modelEntryLines = modelIds.flatMap((id) => {
    const e = entriesById.get(id);
    const d = detailById.get(id);
    const name = d?.name ?? e?.displayName;
    const contextWindow = d?.contextWindow ?? e?.contextWindow;
    const maxTokens = d?.maxOutputTokens ?? e?.maxOutputTokens;
    const vision = d?.vision === true || e?.vision === true;
    return [
      `        - id: ${yq(id)}`,
      ...(name !== undefined && name !== '' ? [`          name: ${yq(name)}`] : []),
      ...(contextWindow !== undefined ? [`          contextWindow: ${contextWindow}`] : []),
      ...(maxTokens !== undefined ? [`          maxTokens: ${maxTokens}`] : []),
      ...(vision ? ['          input: ["text", "image"]'] : []),
    ];
  });
  const region = [
    SETTINGS_BEGIN,
    `${DSH_LLM_NS}:`,
    `  providers:`,
    `    harness-nexus:`,
    `      displayName: ${yq(spec.providerLabel)}`,
    `      api: ${DSH_API_MAP[spec.api]}`,
    `      baseURL: ${yq(spec.baseUrl!)}`,
    `      apiKeyEnv: ${DSH_API_KEY_ENV}`,
    `      models:`,
    ...modelEntryLines,
    `${DSH_DEFAULT_MODEL_NS}:`,
    `  provider: harness-nexus`,
    `  model: ${yq(spec.model)}`,
    SETTINGS_END,
  ].join('\n');
  const nextDoc = `${base.replace(/\s+$/, '')}${base.trim().length > 0 ? '\n\n' : ''}${region}\n`;
  writeSecretFile(settingsPath, nextDoc);
  files.push(display(homeDir, settingsPath));

  // 3. The ACP app pins its OWN provider in the dsh-acp-app composition
  //    (`- id: acp … config: {provider: deepseek-official…}`), and a plugin's
  //    explicit config beats the settings-layer default for its sessions —
  //    chat would keep hitting the old route. The patch layer's id-targeted
  //    CONFIG OVERRIDE (its documented purpose) reroutes it; an insert would
  //    double-register, an override does not.
  let patchDoc = '';
  try {
    patchDoc = readFileSync(patchPath, 'utf8');
  } catch {
    patchDoc = '[]\n'; // absent file — a fresh empty entry list
  }
  const patchBase = stripMarkedBlock(
    patchDoc,
    beginMarker(PROVIDER_REGION),
    endMarker(PROVIDER_REGION),
  );
  if (/^- id: acp$/m.test(patchBase)) {
    throw new Error(
      '~/.dsh/cordis.patch.yml already overrides the "acp" entry by hand — hnx will not touch it; ' +
        'remove that override and re-apply',
    );
  }
  const patchRegion = [
    `${beginMarker(PROVIDER_REGION)} — rewritten by hnx; keep edits outside the markers`,
    `- id: acp`,
    `  config:`,
    `    provider: harness-nexus`,
    `    model: ${yq(spec.model)}`,
    endMarker(PROVIDER_REGION),
  ].join('\n');
  const patchNext = `${patchBase.replace(/\s+$/, '')}${patchBase.trim().length > 0 ? '\n\n' : ''}${patchRegion}\n`;
  writeSecretFile(patchPath, patchNext);
  files.push(display(homeDir, patchPath));

  // 4. The key itself — dsh's user-env credential layer.
  const envPath = join(dir, '.env');
  let envDoc = '';
  try {
    envDoc = readFileSync(envPath, 'utf8');
  } catch {
    envDoc = '';
  }
  writeSecretFile(envPath, mergeEnvLine(envDoc, DSH_API_KEY_ENV, secret));
  files.push(display(homeDir, envPath));
  return files;
}

// ---- opencode (9 W12) ----

/** The raw-secret key file under `~/.config/opencode/` (0600, no trailing newline). */
const OPENCODE_KEY_NAME = 'harness-nexus.key';

/**
 * The AI SDK package for the spec's coarse flavor (opencode's provider `npm`
 * key — the wire driver). anthropic → Messages; openai → chat completions
 * (see PROVIDER_API_SUPPORT[opencode] for why responses is excluded).
 */
const OPENCODE_SDK: Record<RuntimeConfigSpec['api'], string> = {
  'anthropic-messages': '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai-compatible',
};

/**
 * opencode (verified 1.18.31 on the rig) REQUIRES `limit.output` on every
 * `provider.<id>.models.<m>` entry — its config schema rejects the bare `{}`
 * this writer used to emit ("Missing key …models.<m>.limit.output"). Registry
 * entries without a curated maxOutputTokens get this conservative fallback
 * (the same stance as assistant/provider.ts) — never a guessed-high value.
 */
const OPENCODE_FALLBACK_MAX_OUTPUT = 8192;

/**
 * opencode 1.18.31's config schema requires BOTH `limit.output` AND
 * `limit.context` on every `provider.<id>.models.<m>` entry (rig-found
 * 2026-10-15: a push with only `output` answered "Missing key
 * …models.<m>.limit.context"). Registry entries without a curated
 * contextWindow get this conservative fallback — same stance as the output
 * fallback, never a guessed-high value.
 */
const OPENCODE_FALLBACK_CONTEXT = 128_000;

/**
 * The AI SDK baseURL convention (rig-found 2026-09-16): `@ai-sdk/anthropic`
 * and `@ai-sdk/openai-compatible` both expect the base to END WITH `/v1`
 * (their defaults do) and append only the method path (`/messages`,
 * `/chat/completions`). A gateway base without `/v1` — e.g. Ark's
 * `/api/coding`, which claude-code takes VERBATIM (it appends `/v1/…`
 * itself) — posts to a nonexistent path and the gateway auth-checks BEFORE
 * routing, so the failure reads "Unauthorized", not 404. Normalize: append
 * `/v1` unless the base already ends with it.
 */
export function opencodeSdkBaseURL(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * Two merge-preserving slots (research §3):
 *
 *  1. `~/.config/opencode/opencode.json` — top-level `model` =
 *     `harness-nexus/<model>` (the active route; W10 extras become sibling
 *     keys in the provider's `models` map = the in-session switchable set),
 *     and `provider['harness-nexus']` with the per-flavor AI SDK `npm`,
 *     `options.baseURL` (`/v1`-normalized; a baseUrl-less re-apply REMOVES
 *     ours), and `options.apiKey` referencing the key file via `{file:…}`
 *     substitution — which EVERY opencode invocation resolves (TUI, ACP,
 *     headless), unlike `{env:…}` (only opencode's own process env). A
 *     commented (JSONC) config fails `JSON.parse` → the job errors without
 *     touching the file.
 *  2. `~/.config/opencode/harness-nexus.key` — the secret, 0600, NO
 *     trailing newline (opencode reads the file RAW — a `\n` would ride
 *     the key and the gateway rejects it).
 */
function applyOpencodeConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.config', 'opencode');
  const cfgPath = join(dir, 'opencode.json');
  const keyPath = join(dir, OPENCODE_KEY_NAME);
  const cfg = readJson(cfgPath); // absent → fresh; JSONC → throws, file untouched
  const entriesById = new Map((spec.modelEntries ?? []).map((e) => [e.id, e]));
  // #62 — the panel's per-model detail WINS over the #51 seed, per field;
  // `limit.*` stay REQUIRED (schema), so unset means seed → fallback.
  const detailById = new Map((spec.opencode?.models ?? []).map((m) => [m.id, m]));

  const providers = {
    ...((cfg.provider as Record<string, unknown> | undefined) ?? {}),
    [OPENCODE_PROVIDER_ID]: {
      npm: OPENCODE_SDK[spec.api],
      name: spec.providerLabel,
      options: {
        ...(spec.baseUrl !== undefined ? { baseURL: opencodeSdkBaseURL(spec.baseUrl) } : {}),
        apiKey: `{file:~/.config/opencode/${OPENCODE_KEY_NAME}}`,
      },
      // W10 — the default model leads the switchable set; the server already
      // drops the default from extras, this dedupe is belt-and-braces.
      // #51 — registry metadata (snapshot in the spec) fills `name` and the
      // REQUIRED `limit` block (see OPENCODE_FALLBACK_MAX_OUTPUT); bare ids
      // get the fallback limit, never an empty entry. #62 — panel detail
      // overlays the seed and adds the capability/body-key knobs.
      models: Object.fromEntries(
        [...new Set([spec.model, ...(spec.models ?? [])])].map((id) => {
          const e = entriesById.get(id);
          const d = detailById.get(id);
          return [
            id,
            {
              ...(d?.name !== undefined
                ? { name: d.name }
                : e?.displayName !== undefined
                  ? { name: e.displayName }
                  : {}),
              ...(d?.reasoning === true ? { reasoning: true } : {}),
              ...(d?.temperatureEnabled === true ? { temperature: true } : {}),
              ...(d?.vision === true ? { attachment: true } : {}),
              ...(d?.options !== undefined && Object.keys(d.options).length > 0
                ? { options: d.options }
                : {}),
              limit: {
                output: d?.maxOutputTokens ?? e?.maxOutputTokens ?? OPENCODE_FALLBACK_MAX_OUTPUT,
                context: d?.contextWindow ?? e?.contextWindow ?? OPENCODE_FALLBACK_CONTEXT,
              },
            },
          ];
        }),
      ),
    },
  };
  // #62 — top-level `small_model`/`autoupdate` are BASE_URL-style owned:
  // configured → write, cleared → remove ours (a user's own value is
  // clobbered while configured and removed when cleared — same trade as the
  // managed base URL, documented in the design).
  const managed: Record<string, unknown> = {
    ...cfg,
    provider: providers,
    model: `${OPENCODE_PROVIDER_ID}/${spec.model}`,
  };
  if (spec.opencode?.smallModel !== undefined) {
    managed.small_model = `${OPENCODE_PROVIDER_ID}/${spec.opencode.smallModel}`;
  } else {
    delete managed.small_model;
  }
  if (spec.opencode?.autoupdateDisabled === true) {
    managed.autoupdate = false;
  } else {
    delete managed.autoupdate;
  }
  writeSecretFile(cfgPath, `${JSON.stringify(managed, null, 2)}\n`);
  writeSecretFile(keyPath, secret);
  return [display(homeDir, cfgPath), display(homeDir, keyPath)];
}

// ---- pi (9 W16) ----

/** The raw-secret key file under `~/.pi/agent/` (0600, no trailing newline). */
const PI_KEY_NAME = 'harness-nexus.key';

/** models.json `api` value per spec coarse flavor (pi-ai names the wire). */
const PI_API: Record<RuntimeConfigSpec['api'], string> = {
  'anthropic-messages': 'anthropic-messages',
  openai: 'openai-completions',
};

/**
 * Three merge-preserving slots (research §3 / design §S3):
 *
 *  1. `~/.pi/agent/models.json` — `providers['harness-nexus']` with the
 *     endpoint, the pi-ai `api` wire, an `apiKey` that READS the key file at
 *     request time via pi's `!command` value syntax (resolved per request —
 *     TUI, bridge, and headless alike), and a `models` array of bare ids
 *     (pi MERGES custom ids over built-ins per provider).
 *  2. `~/.pi/agent/settings.json` — `defaultProvider`/`defaultModel` (the
 *     active route) + `enabledModels` = `unique([model, ...extras])` (the
 *     W10/W13 switchable set).
 *  3. `~/.pi/agent/harness-nexus.key` — the secret, 0600, NO trailing
 *     newline (`!cat` hands the bytes to pi verbatim).
 *
 * #65 adds the panel overlay on the models array (`spec.pi.models`): per
 * field panel value > #51 modelEntries seed > omitted (the family
 * contract), plus the panel-only `reasoning: true` capability flag and
 * `samplingParams` (free body keys, effective on the openai wires,
 * silently ignored on anthropic). Bare ids stay `{ id }` byte-identical.
 *
 * Both JSON files fail `JSON.parse` if hand-mangled → the job errors without
 * touching them (same stance as opencode). A baseUrl-less spec is rejected
 * at the route AND re-checked here — pi's custom provider REQUIRES an
 * endpoint, so a stale queued job fails honestly instead of writing a
 * dead route.
 */
function applyPiConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  if (spec.baseUrl === undefined) {
    throw new Error('pi provider routes require a baseUrl');
  }
  const dir = join(homeDir, '.pi', 'agent');
  const modelsPath = join(dir, 'models.json');
  const settingsPath = join(dir, 'settings.json');
  const keyPath = join(dir, PI_KEY_NAME);

  const modelsDoc = readJson(modelsPath); // absent → fresh; malformed → throws, untouched
  const modelIds = [...new Set([spec.model, ...(spec.models ?? [])])];
  // #51 — metadata from the provider registry (snapshot in the spec): ids
  // with an entry get real contextWindow/maxTokens/name, so pi's usage
  // contextSize stops hiding (W16's honest degradation resolves). Ids without
  // stay bare — never guessed. #65 — the panel overlay wins per field
  // (`spec.pi.models`), and adds the panel-only `reasoning` flag and
  // `samplingParams`; a bare id with neither stays `{ id }`.
  const entriesById = new Map((spec.modelEntries ?? []).map((e) => [e.id, e]));
  const detailById = new Map((spec.pi?.models ?? []).map((m) => [m.id, m]));
  const providers = {
    ...((modelsDoc.providers as Record<string, unknown> | undefined) ?? {}),
    [PI_PROVIDER_ID]: {
      name: spec.providerLabel,
      baseUrl: spec.baseUrl,
      api: PI_API[spec.api],
      apiKey: `!cat ${JSON.stringify(keyPath)}`,
      models: modelIds.map((id) => {
        const e = entriesById.get(id);
        const d = detailById.get(id);
        if (e === undefined && d === undefined) return { id };
        const name = d?.name ?? e?.displayName;
        const contextWindow = d?.contextWindow ?? e?.contextWindow;
        const maxTokens = d?.maxOutputTokens ?? e?.maxOutputTokens;
        const vision = d?.vision === true || e?.vision === true;
        return {
          id,
          ...(name !== undefined && name !== '' ? { name } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(vision ? { input: ['text', 'image'] } : {}),
          ...(d?.reasoning === true ? { reasoning: true } : {}),
          ...(d?.samplingParams !== undefined && Object.keys(d.samplingParams).length > 0
            ? { samplingParams: d.samplingParams }
            : {}),
        };
      }),
    },
  };
  writeSecretFile(modelsPath, `${JSON.stringify({ ...modelsDoc, providers }, null, 2)}\n`);

  const settings = readJson(settingsPath);
  writeSecretFile(
    settingsPath,
    `${JSON.stringify(
      {
        ...settings,
        defaultProvider: PI_PROVIDER_ID,
        defaultModel: spec.model,
        enabledModels: modelIds,
      },
      null,
      2,
    )}\n`,
  );
  writeSecretFile(keyPath, secret);
  return [display(homeDir, modelsPath), display(homeDir, settingsPath), display(homeDir, keyPath)];
}

/** The per-target native writer — pure file surgery, no I/O beyond the harness homes. */
export function applyRuntimeConfig(
  target: 'claude-code' | 'codex' | 'deepseek' | 'opencode' | 'pi',
  spec: RuntimeConfigSpec,
  secret: string,
  homeDir: string,
): { files: string[] } {
  switch (target) {
    case 'claude-code':
      return { files: applyClaudeConfig(spec, secret, homeDir) };
    case 'codex':
      return { files: applyCodexConfig(spec, secret, homeDir) };
    case 'deepseek':
      if (spec.baseUrl === undefined) {
        // The route gate rejects this server-side; the daemon double-checks so
        // a stale queued job fails honestly instead of writing a broken row.
        throw new Error('deepseek provider routes require a baseUrl');
      }
      return { files: applyDshConfig(spec, secret, homeDir) };
    case 'opencode':
      return { files: applyOpencodeConfig(spec, secret, homeDir) };
    case 'pi':
      return { files: applyPiConfig(spec, secret, homeDir) };
  }
}

/**
 * The `apply-config` harness job executor: fetch the resolved bundle with the
 * machine PAT (REST — the secret never rides the job), write the native slots,
 * settle via `job:result`. No runtime re-probe (config files aren't in the
 * snapshot); the redacted read-back viewer is W4.
 */
export async function runApplyConfigJob(
  socket: Socket,
  opts: { server: string; token: string },
  job: JobView,
  homeDir: string = homedir(),
): Promise<void> {
  const startedAt = Date.now();
  const parsed = harnessJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success || parsed.data.action !== 'apply-config') {
    socket.emit('job:result', { jobId: job.id, ok: false, error: 'harness payload invalid' });
    return;
  }
  const target = parsed.data.target;
  const progress = (phase: string, message?: string): void => {
    socket.emit('job:progress', { jobId: job.id, phase, ...(message ? { message } : {}) });
  };
  progress('resolve', `fetching provider config for ${target}`);
  try {
    const client = new HarnessNexusClient({ baseUrl: opts.server, token: opts.token });
    const bundle = await client.getRuntimeConfigBundle(target);
    progress('apply', `writing ${target} config`);
    const { files } = applyRuntimeConfig(target, bundle.spec, bundle.secret, homeDir);
    const nodeWarning =
      target === 'deepseek' ? dshNodeWarning() : target === 'pi' ? piNodeWarning() : null;
    const data = harnessResultDataSchema.parse({
      target,
      action: 'apply-config',
      files,
      ...(nodeWarning !== null ? { warning: nodeWarning } : {}),
    });
    socket.emit('job:result', { jobId: job.id, ok: true, data });
    logOp({
      op: 'runtime-config-apply',
      target,
      outcome: 'ok',
      ms: Date.now() - startedAt,
      detail: `${String(files.length)} file(s)`,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    socket.emit('job:result', { jobId: job.id, ok: false, error });
    logOp({
      op: 'runtime-config-apply',
      target,
      outcome: 'error',
      ms: Date.now() - startedAt,
      detail: error,
    });
  }
}
