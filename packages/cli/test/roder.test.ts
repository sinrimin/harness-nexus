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
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
  PROVIDER_API_SUPPORT,
  runtimeConfigSpecSchema,
  runtimeSpecUnsupportedReason,
} from '@harness-nexus/shared';
import { applyRuntimeConfig } from '../src/daemon/runtime-config.js';
import { readRuntimeConfigView } from '../src/daemon/config-view.js';
import { roderInstallCommand } from '../src/daemon/roder-runtime.js';
import { harnessCommand, runHarnessJob } from '../src/daemon/runtime.js';
import { findRuntimeBin, probeRuntime } from '../src/inventory/runtime.js';
import { collectItems, scanTarget } from '../src/inventory/scan.js';
import { resolveAcpCommand } from '../src/daemon/acp/adapters.js';
import { AcpAgentConnection } from '../src/daemon/acp/agent-connection.js';

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hnx-roder-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const spec = runtimeConfigSpecSchema.parse({
  providerLabel: 'Test Responses gateway',
  api: 'openai',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  credentialName: 'test-key',
});

describe('Roder provider config', () => {
  it('preserves unrelated TOML values, applies the native route, and re-applies idempotently', () => {
    const dir = home();
    mkdirSync(join(dir, '.roder'));
    const file = join(dir, '.roder', 'config.toml');
    writeFileSync(file, 'reasoning = "high"\n[providers.other]\nbase_url = "https://other.test"\n');
    expect(applyRuntimeConfig('roder', spec, 'test-secret', dir)).toEqual({
      files: ['~/.roder/config.toml'],
    });
    const first = readFileSync(file, 'utf8');
    expect(parse(first)).toMatchObject({
      reasoning: 'high',
      provider: 'harness-nexus',
      model: 'test-model',
      providers: {
        other: { base_url: 'https://other.test' },
        'harness-nexus': { base_url: spec.baseUrl, api_key: 'test-secret' },
      },
    });
    applyRuntimeConfig('roder', spec, 'test-secret', dir);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fails on malformed TOML before writing and enforces Responses routing', () => {
    const dir = home();
    mkdirSync(join(dir, '.roder'));
    const file = join(dir, '.roder', 'config.toml');
    writeFileSync(file, 'invalid = [');
    expect(() => applyRuntimeConfig('roder', spec, 'secret', dir)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('invalid = [');
    expect(PROVIDER_API_SUPPORT.roder).toEqual(['openai-responses']);
    expect(runtimeSpecUnsupportedReason('roder', { ...spec, api: 'anthropic-messages' })).toContain(
      'cannot speak',
    );
    const { baseUrl: _baseUrl, ...noEndpoint } = spec;
    expect(runtimeSpecUnsupportedReason('roder', noEndpoint)).toContain('baseUrl');
    expect(() => applyRuntimeConfig('roder', noEndpoint, 'secret', dir)).toThrow('baseUrl');
  });

  it('redacts escaped and multiline credentials structurally, and masks invalid TOML wholesale', () => {
    const dir = home();
    applyRuntimeConfig('roder', spec, 'line-one\nline-two"\\', dir);
    let view = readRuntimeConfigView('roder', dir);
    expect(view.files[0]?.content).toContain('test-model');
    expect(view.files[0]?.content).not.toContain('line-one');
    expect(view.files[0]?.content).not.toContain('line-two');
    expect(view.redacted).toContain('~/.roder/config.toml:providers.harness-nexus.api_key');
    writeFileSync(
      join(dir, '.roder', 'config.toml'),
      '[providers.foo]\napi_key = """multiline\nprivate-value\n"""\n',
    );
    expect(readRuntimeConfigView('roder', dir).files[0]?.content).not.toContain('private-value');
    writeFileSync(
      join(dir, '.roder', 'config.toml'),
      '[credentials]\nvalues = ["nested-secret"]\n',
    );
    expect(readRuntimeConfigView('roder', dir).files[0]?.content).not.toContain('nested-secret');
    writeFileSync(join(dir, '.roder', 'config.toml'), 'api_key = "unterminated-secret');
    view = readRuntimeConfigView('roder', dir);
    expect(view.files[0]?.content).toBe('${redacted}\n');
  });
});

describe('Roder runtime and inventory', () => {
  it('uses the native installer for install, upgrade, and version pins without interpolating shell code', () => {
    for (const action of ['install', 'upgrade']) {
      const cmd = roderInstallCommand({ action }, undefined, 'linux');
      expect(cmd).toMatchObject({ command: 'bash' });
      if ('args' in cmd)
        expect(cmd.args.at(-1)).toBe('https://github.com/RoderAI/roder/releases/download/latest');
    }
    const cmd = harnessCommand({ action: 'pin', target: 'roder', version: '0.3.19' }, 'native');
    if ('error' in cmd) throw new Error(cmd.error);
    expect(cmd.args.at(-1)).toBe(
      'https://github.com/RoderAI/roder/releases/download/roder/v0.3.19',
    );
    expect(cmd.args[1]).not.toContain('0.3.19');
    expect(roderInstallCommand({ action: 'install' }, undefined, 'win32')).toHaveProperty('error');
    expect(roderInstallCommand({ action: 'upgrade' }, 'brew', 'darwin')).toHaveProperty('error');
    expect(roderInstallCommand({ action: 'apply-config' }, undefined)).toHaveProperty('error');
  });

  it('downloads the installer before execution, passes the selected release, and stops on download failure', () => {
    const dir = home();
    const curl = join(dir, 'curl');
    const marker = join(dir, 'installed');
    writeFileSync(
      curl,
      `#!/bin/sh
cat > "$4" <<'INSTALLER'
printf "%s" "$RODER_DOWNLOAD_BASE_URL" > "$HNX_TEST_MARKER"
INSTALLER
`,
    );
    chmodSync(curl, 0o755);
    const cmd = roderInstallCommand({ action: 'pin', version: '0.3.19' }, undefined, 'linux');
    if ('error' in cmd) throw new Error(cmd.error);
    const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, HNX_TEST_MARKER: marker };
    execFileSync(cmd.command, cmd.args, { env });
    expect(readFileSync(marker, 'utf8')).toBe(
      'https://github.com/RoderAI/roder/releases/download/roder/v0.3.19',
    );
    rmSync(marker);
    writeFileSync(curl, '#!/bin/sh\nexit 22\n');
    expect(() => execFileSync(cmd.command, cmd.args, { env, stdio: 'ignore' })).toThrow();
    expect(() => readFileSync(marker, 'utf8')).toThrow();
  });

  it('settles a native install job only after re-probing and reporting the Roder runtime', async () => {
    const dir = home();
    const shim = join(dir, 'shim');
    mkdirSync(shim);
    writeFileSync(
      join(shim, 'curl'),
      `#!/bin/sh
cat > "$4" <<'INSTALLER'
mkdir -p "$RODER_INSTALL_DIR"
printf '#!/bin/sh\\nexec "%s" "%s"\\n' "$HNX_TEST_NODE" "$HNX_TEST_FIXTURE" > "$RODER_INSTALL_DIR/roder"
chmod +x "$RODER_INSTALL_DIR/roder"
INSTALLER
`,
    );
    chmodSync(join(shim, 'curl'), 0o755);
    const events: { event: string; payload: unknown }[] = [];
    const socket = {
      emit: (event: string, payload: unknown) => {
        events.push({ event, payload });
        return true;
      },
    };
    const job = {
      id: 'roder-install',
      payload: { type: 'harness', action: 'install', target: 'roder' },
    };
    await runHarnessJob(
      socket as Parameters<typeof runHarnessJob>[0],
      job as Parameters<typeof runHarnessJob>[1],
      {
        homeDir: dir,
        env: {
          ...process.env,
          PATH: `${shim}:/usr/bin:/bin`,
          HNX_TEST_NODE: process.execPath,
          HNX_TEST_FIXTURE: new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname,
        },
      },
    );
    expect(events.find((e) => e.event === 'job:result')?.payload).toMatchObject({
      ok: true,
      data: { target: 'roder', version: 'ACP 0.1.0' },
    });
    expect(events.find((e) => e.event === 'inventory:report')?.payload).toMatchObject({
      runtimes: [{ target: 'roder', installed: true }],
    });
  }, 30000);

  it('finds native installs when the daemon PATH omits ~/.local/bin and uses them for ACP', async () => {
    const dir = home();
    const bin = join(dir, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    const fixture = new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname;
    writeFileSync(join(bin, 'roder'), `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`);
    chmodSync(join(bin, 'roder'), 0o755);
    expect(await findRuntimeBin('roder', { homeDir: dir, pathEnv: '' })).toBe(join(bin, 'roder'));
    expect(
      await probeRuntime('roder', { homeDir: dir, pathEnv: '', timeoutMs: 10000 }),
    ).toMatchObject({
      installed: true,
      version: 'ACP 0.1.0',
    });
    expect(resolveAcpCommand('roder', { PATH: '' }, { homeDir: dir })).toEqual({
      command: join(bin, 'roder'),
      args: ['acp'],
    });
    expect(
      resolveAcpCommand(
        'roder',
        { PATH: '', HN_ACP_COMMAND_RODER: 'node local.mjs' },
        { homeDir: dir },
      ),
    ).toEqual({ command: 'node', args: ['local.mjs'] });
  }, 20000);

  it('scans and collects global skill bundles without reading credentials', async () => {
    const dir = home();
    const skill = join(dir, '.codex', 'skills', 'example');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '# Example\nTest skill.\n');
    writeFileSync(join(skill, 'helper.txt'), 'helper');
    mkdirSync(join(dir, '.roder'));
    writeFileSync(join(dir, '.roder', 'config.toml'), 'api_key = "private-secret"');
    const snapshot = scanTarget('roder', dir);
    expect(snapshot.agents[0]?.items).toMatchObject([
      { kind: 'skill', name: 'example', origin: 'local', meta: { multi: true } },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('private-secret');
    expect(await collectItems('roder', [{ kind: 'skill', name: 'example' }], dir)).toMatchObject([
      { ok: true, artifact: { files: { 'helper.txt': 'helper' } } },
    ]);
  });
});

it('routes the Roder ACP override through initialize, session/new, prompt, and streaming', async () => {
  const dir = home();
  const fixture = new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname;
  const cmd = resolveAcpCommand('roder', {
    HN_ACP_COMMAND_RODER: `${process.execPath} ${fixture}`,
  })!;
  const { conn } = await AcpAgentConnection.start(cmd.command, cmd.args, { cwd: dir });
  try {
    const updates: unknown[] = [];
    conn.setNotificationHandler((method, params) => {
      if (method === 'session/update') updates.push(params);
    });
    const session = (await conn.request('session/new', { cwd: dir, mcpServers: [] }, 5000)) as {
      sessionId: string;
    };
    const result = await conn.request(
      'session/prompt',
      { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hello roder' }] },
      5000,
    );
    expect(result).toMatchObject({ stopReason: 'end_turn' });
    expect(JSON.stringify(updates)).toContain('hello roder');
  } finally {
    conn.kill();
  }
}, 20000);
