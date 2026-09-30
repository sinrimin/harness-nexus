import { homedir } from 'node:os';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  OPENCODE_PROVIDER_ID,
  PI_PROVIDER_ID,
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
 *    while the spec sets one; a later unset REMOVES ours), `env.ANTHROPIC_AUTH_TOKEN`
 *    (the key), top-level `model` (base URL alone doesn't switch the model),
 *    and top-level `availableModels` = unique([model, ...models]) (9 W13 —
 *    the ACP wrapper restricts its model configOption to this allowlist, so
 *    the session dropdown lists only gateway-servable ids; it also narrows
 *    the machine's terminal /model picker, which is the documented Claude
 *    Code semantics for a managed route).
 *  - codex: `~/.codex/config.toml` — root keys `model` + `model_provider`, and
 *    the `[model_providers.harness_nexus]` block with `requires_openai_auth =
 *    true` (the built-in provider's own shape — auth comes from auth.json, no
 *    env var). `~/.codex/auth.json` — apikey mode with the key as
 *    `OPENAI_API_KEY`. `wire_api` is NOT set: current codex removed `chat`, so
 *    every route speaks Responses — gateways must be Responses-compatible.
 *  - deepseek: the SETTINGS layer (`~/.dsh/settings.yaml`, namespace
 *    `llm-pi-ai` with the provider route + `agent-default-model` selecting
 *    it). NOT loader-entry inserts in `cordis.patch.yml` — the dsh
 *    composition already mounts both plugins, and a second insert
 *    double-registers them ("configurable provider … already declared" /
 *    "service agentDefaultModel has been registered") and crashes
 *    `--profile acp`. A legacy W3 patch region is retired by the same apply.
 *    The key goes to `~/.dsh/.env` under `HARNESS_NEXUS_API_KEY` — dsh's own
 *    user-env credential layer, read on EVERY launch (user shells included).
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
  const env: Record<string, string> = {
    ...((settings.env as Record<string, string> | undefined) ?? {}),
    ANTHROPIC_AUTH_TOKEN: secret,
  };
  if (spec.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = spec.baseUrl;
  else delete env.ANTHROPIC_BASE_URL; // the platform owns the route — unset means revert to default
  // 9 W13 — the picker allowlist. Written whenever a spec exists (even a
  // single model: under a gateway the built-in catalog is dead entries, same
  // policy as dsh/opencode). Platform-owned key: re-apply overwrites whatever
  // the user had there.
  const availableModels = [...new Set([spec.model, ...(spec.models ?? [])])];
  writeSecretFile(
    file,
    `${JSON.stringify({ ...settings, env, model: spec.model, availableModels }, null, 2)}\n`,
  );
  return [display(homeDir, file)];
}

// ---- codex ----

/**
 * Set TOP-LEVEL `key = "value"` pairs in a TOML document, preserving every
 * other byte. Only the region before the first `[section]` header is ours to
 * edit (a `model` inside a section belongs to that section); missing keys are
 * appended to that region. JSON string escaping is valid TOML basic-string
 * escaping.
 */
export function mergeTomlRootKeys(existing: string, values: Record<string, string>): string {
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
    if (key !== undefined && hit !== undefined) {
      rewritten.push(`${key} = ${JSON.stringify(hit)}`);
      remaining.delete(key);
    } else {
      rewritten.push(line);
    }
  }
  // Append missing keys at the end of the top-level region (before trailing
  // blank lines so a header below keeps its spacing).
  let insertAt = rewritten.length;
  while (insertAt > 0 && rewritten[insertAt - 1]!.trim() === '') insertAt--;
  rewritten.splice(
    insertAt,
    0,
    ...[...remaining.entries()].map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
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
  const sectionBody = [
    `name = ${JSON.stringify(spec.providerLabel)}`,
    ...(spec.baseUrl !== undefined ? [`base_url = ${JSON.stringify(spec.baseUrl)}`] : []),
    'requires_openai_auth = true',
  ].join('\n');
  cfg = mergeTomlSection(
    mergeTomlRootKeys(cfg, { model: spec.model, model_provider: CODEX_PROVIDER_ID }),
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
    ...modelIds.map((id) => `        - id: ${yq(id)}`),
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
      models: Object.fromEntries(
        [...new Set([spec.model, ...(spec.models ?? [])])].map((id) => [id, {}]),
      ),
    },
  };
  writeSecretFile(
    cfgPath,
    `${JSON.stringify(
      {
        ...cfg,
        provider: providers,
        model: `${OPENCODE_PROVIDER_ID}/${spec.model}`,
      },
      null,
      2,
    )}\n`,
  );
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
  const providers = {
    ...((modelsDoc.providers as Record<string, unknown> | undefined) ?? {}),
    [PI_PROVIDER_ID]: {
      name: spec.providerLabel,
      baseUrl: spec.baseUrl,
      api: PI_API[spec.api],
      apiKey: `!cat ${JSON.stringify(keyPath)}`,
      models: modelIds.map((id) => ({ id })),
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
