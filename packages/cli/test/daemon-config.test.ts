// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { mergeDaemonConfig } from '../src/config.js';
import { InstallError } from '../src/errors.js';

/** #20 — the web-UI flow (`hnx daemon --server --token --machine-id`) must
 *  yield a complete, persistable identity so `hnx mcp serve` can read it. */
describe('mergeDaemonConfig', () => {
  it('builds a full identity from args alone (web-page enroll flow)', () => {
    expect(
      mergeDaemonConfig(
        { server: 'https://hnx.example.com', token: 'hnpat_x', machineId: 'm1' },
        null,
      ),
    ).toEqual({ server: 'https://hnx.example.com', token: 'hnpat_x', machineId: 'm1' });
  });

  it('args override the stored config; machineName carries over', () => {
    expect(
      mergeDaemonConfig(
        { token: 'hnpat_new' },
        { server: 'https://old', token: 'hnpat_old', machineId: 'm1', machineName: 'box' },
      ),
    ).toEqual({ server: 'https://old', token: 'hnpat_new', machineId: 'm1', machineName: 'box' });
  });

  it('throws when args + config still leave a gap', () => {
    expect(() => mergeDaemonConfig({ server: 'https://x' }, null)).toThrow(InstallError);
    expect(() => mergeDaemonConfig({}, { server: 'https://x', token: 't', machineId: '' })).toThrow(
      InstallError,
    );
  });
});
