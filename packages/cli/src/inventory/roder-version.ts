// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { AcpAgentConnection } from '../daemon/acp/agent-connection.js';

/** Roder exposes its version in ACP initialize; --version starts its TUI. */
export async function probeRoderVersion(
  binPath: string,
  home: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { conn, agentInfo } = await AcpAgentConnection.start(binPath, ['acp'], {
      cwd: home,
      initializeTimeoutMs: timeoutMs,
    });
    try {
      return typeof agentInfo.version === 'string' ? `ACP ${agentInfo.version.slice(0, 60)}` : null;
    } finally {
      conn.kill();
    }
  } catch {
    return null;
  }
}
