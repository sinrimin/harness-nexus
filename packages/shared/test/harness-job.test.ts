// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  createMachineJobSchema,
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  jobViewSchema,
} from '../src/index.js';

/** Phase 9 W2 — the harness job payload union and its REST wrapper. */

describe('harnessJobPayloadSchema', () => {
  it('accepts install/upgrade without a version and pin with one', () => {
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'install',
        target: 'deepseek',
      }).success,
    ).toBe(true);
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'upgrade',
        target: 'claude-code',
      }).success,
    ).toBe(true);
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'pin',
        target: 'codex',
        version: '0.12.1',
      }).success,
    ).toBe(true);
  });

  it('accepts opencode as a harness job target (9 W12)', () => {
    expect(
      harnessJobPayloadSchema.safeParse({ type: 'harness', action: 'install', target: 'opencode' })
        .success,
    ).toBe(true);
  });

  it('rejects pin without a version, non-runtime targets, and stray actions', () => {
    expect(
      harnessJobPayloadSchema.safeParse({ type: 'harness', action: 'pin', target: 'codex' })
        .success,
    ).toBe(false);
    expect(
      harnessJobPayloadSchema.safeParse({ type: 'harness', action: 'install', target: 'hermes' })
        .success,
    ).toBe(false);
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'uninstall',
        target: 'codex',
      }).success,
    ).toBe(false);
  });
});

describe('createMachineJobSchema', () => {
  it('defaults a type-less body to deploy (pre-W2 SDK compatibility)', () => {
    const parsed = createMachineJobSchema.parse({ profileId: 'p1', directory: '/tmp/x' });
    expect(parsed).toEqual({ type: 'deploy', profileId: 'p1', directory: '/tmp/x' });
  });

  it('routes explicit types through the union', () => {
    expect(
      createMachineJobSchema.parse({ type: 'harness', action: 'install', target: 'deepseek' }),
    ).toEqual({ type: 'harness', action: 'install', target: 'deepseek' });
    expect(createMachineJobSchema.safeParse({ type: 'harness', profileId: 'p1' }).success).toBe(
      false,
    );
    expect(createMachineJobSchema.safeParse({ type: 'deploy', action: 'install' }).success).toBe(
      false,
    );
  });
});

describe('jobViewSchema / harnessResultDataSchema', () => {
  it('job views carry the harness type; result data round-trips a probe', () => {
    const view = jobViewSchema.parse({
      id: 'j1',
      machineId: 'm1',
      ownerId: 'u1',
      type: 'harness',
      status: 'succeeded',
      payload: { type: 'harness', action: 'pin', target: 'codex', version: '0.12.1' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(view.type).toBe('harness');

    const data = harnessResultDataSchema.parse({
      target: 'codex',
      action: 'pin',
      version: 'codex-cli 0.12.1',
      binPath: '/usr/local/bin/codex',
      installMethod: 'npm',
      warning: 'settings.json unreadable — left untouched',
    });
    expect(data.installMethod).toBe('npm');
    expect(harnessResultDataSchema.safeParse({ target: 'hermes', action: 'install' }).success).toBe(
      false,
    );
  });
});
