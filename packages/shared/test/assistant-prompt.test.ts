// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_SYSTEM_PROMPT } from '../src/index.js';

/** #69 — the default prompt's anchors: it is ONE constant (server builds
 *  turns from it, the web dialog shows it) and it carries the client-agent
 *  dispatch discipline that makes a driven session safe to reuse. */
describe('#69 default assistant system prompt', () => {
  it('carries the dispatch discipline', () => {
    for (const anchor of [
      'agent_dispatch',
      'notices[]',
      'resume {sessionId, cwd}',
      'never assume the last dispatch',
    ]) {
      expect(DEFAULT_ASSISTANT_SYSTEM_PROMPT).toContain(anchor);
    }
  });

  it('keeps the platform baseline sections', () => {
    expect(DEFAULT_ASSISTANT_SYSTEM_PROMPT).toContain('exactly their permissions');
    expect(DEFAULT_ASSISTANT_SYSTEM_PROMPT).toContain('Destructive operations');
    expect(DEFAULT_ASSISTANT_SYSTEM_PROMPT).toContain('Answer in the user');
  });
});
