#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// Minimal zero-dependency stdio MCP server used by scripts/test-hnx-mcp-serve.mjs.
// Speaks newline-delimited JSON-RPC (the MCP stdio framing) and exposes ONE
// tool, `echo`, whose description embeds argv[2] — which the test passes as a
// `${cred:NAME}` placeholder, proving the shim resolved it to plaintext.
import readline from 'node:readline';

const startupArg = process.argv[2] ?? '(none)';

const rl = readline.createInterface({ input: process.stdin });
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-mcp-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: `echo [configured-with: ${startupArg}]`,
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const text = msg.params?.arguments?.text ?? '';
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `${text} via ${startupArg}` }] },
    });
    return;
  }
  if (msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});
