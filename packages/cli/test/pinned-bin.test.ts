import { describe, expect, it } from 'vitest';
import { pinnedBinCandidates } from '../src/daemon/acp/adapters.js';

/** #34 — a pinned adapter bin must resolve `.cmd` first on Windows. */
describe('pinned adapter bin candidates (#34)', () => {
  it('win32 prefers <bin>.cmd over the extensionless sh shim', () => {
    expect(pinnedBinCandidates('C:/x/.bin/claude-agent-acp', true)).toEqual([
      'C:/x/.bin/claude-agent-acp.cmd',
      'C:/x/.bin/claude-agent-acp',
    ]);
  });

  it('POSIX keeps the extensionless bin alone', () => {
    expect(pinnedBinCandidates('/home/x/.bin/claude-agent-acp', false)).toEqual([
      '/home/x/.bin/claude-agent-acp',
    ]);
  });
});
