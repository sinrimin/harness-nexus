#!/usr/bin/env node
// Throwaway E2E for the `hnx mcp serve` stdio shim (Phase 8 C2):
//   memory-mode server → personal cred + stdio upstream (placeholder arg) →
//   profile → spawn the shim → connect as a (hand-rolled NDJSON) MCP client →
//   assert the namespaced tool list + a call round-trip carrying the resolved
//   secret (config fetch + in-memory resolution + stdio dial + aggregation).
// Zero deps on purpose; run AFTER `pnpm -r build`.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7791;
const B = `http://127.0.0.1:${PORT}`;
let pass = 0;
let fail = 0;
const expect = (label, got, want) => {
  const ok = got === want;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
  ok ? pass++ : fail++;
};

async function req(method, url, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(B + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hand-rolled newline-delimited JSON-RPC MCP client over a child's stdio. */
function ndjsonClient(child) {
  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* ignore */
    }
  });
  let nextId = 1;
  return {
    send(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    request(method, params, timeoutMs = 10000) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

async function main() {
  // 1. boot the server
  const server = spawn('node', [path.join(ROOT, 'packages/server/dist/server.js')], {
    env: {
      ...process.env,
      JWT_SECRET: 'shim-e2e-secret-0123456789',
      STORAGE_DRIVER: 'memory',
      PORT: String(PORT),
      LOG_LEVEL: 'fatal',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      const ok = await fetch(`${B}/healthz`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      await sleep(100);
    }

    // 2. seed: user + cred + stdio upstream + profile
    const reg = await req('POST', '/api/auth/register', {
      body: { username: 'shim', password: 'hunter2hunter2' },
    });
    const token = reg.json.token;
    await req('POST', '/api/credentials', {
      token,
      body: { name: 'e2e', secret: 'e2e-resolved-secret', scope: 'personal' },
    });
    const serverCreate = await req('POST', '/api/mcp-servers', {
      token,
      body: {
        name: 'echo upstream',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [path.join(ROOT, 'scripts/fixtures/echo-mcp.mjs'), '${cred:e2e}'],
        },
        dialSite: 'auto',
        scope: 'personal',
      },
    });
    expect('stdio upstream created', serverCreate.status, 201);
    const profile = await req('POST', '/api/profiles', {
      token,
      body: {
        name: 'shim-e2e',
        target: 'claude-code',
        scope: 'personal',
        entries: [{ mcpServerId: serverCreate.json.mcpServer.id }],
      },
    });
    const profileId = profile.json.profile.id;

    // 3. spawn the shim
    const shim = spawn(
      'node',
      [
        path.join(ROOT, 'packages/cli/dist/index.js'),
        'mcp',
        'serve',
        '--profile',
        profileId,
        '--server',
        B,
        '--token',
        token,
      ],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    const client = ndjsonClient(shim);

    try {
      // 4. handshake + tools/list + tools/call
      const init = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'shim-e2e-client', version: '1.0.0' },
      });
      expect('initialize ok', init.result?.serverInfo?.name, 'hnx-mcp-serve');
      client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const list = await client.request('tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      expect('namespaced tool present', names.join(','), 'echo_upstream__echo');
      expect(
        'description carries the resolved secret',
        list.result.tools[0].description.includes('e2e-resolved-secret'),
        true,
      );

      const call = await client.request('tools/call', {
        name: 'echo_upstream__echo',
        arguments: { text: 'hello' },
      });
      expect(
        'call round-trip returns resolved content',
        call.result.content[0].text,
        'hello via e2e-resolved-secret',
      );
    } finally {
      shim.kill('SIGTERM');
    }
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('shim e2e crashed:', e);
  process.exit(1);
});
