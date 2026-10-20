// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type { RuntimeInfo } from '@harness-nexus/shared';
import { acpMinVersion } from '../src/daemon/acp/adapters.js';
import { checkAcpVersion } from '../src/daemon/acp/version-gate.js';

/**
 * #46 — the ACP client version gate: fast-moving targets (dsh) get NO
 * back-compat; the daemon refuses to connect below the ground-truth floor and
 * tells the operator how to upgrade. The probe is injected here — the real
 * path is `<bin> --version` via the W1 runtime probe.
 */

const info = (version: string | undefined, installed = true): RuntimeInfo => ({
  target: 'deepseek',
  installed,
  ...(version !== undefined ? { version } : {}),
});

describe('acpMinVersion', () => {
  it('declares the dsh floor and skips it for override-managed command lines', () => {
    expect(acpMinVersion('deepseek', {})).toBe('0.2.0-rc.2');
    expect(acpMinVersion('deepseek', { HN_ACP_COMMAND_DEEPSEEK: 'node /fixture.mjs' })).toBeNull();
    // Whitespace-only override is not an override (adapters.ts convention).
    expect(acpMinVersion('deepseek', { HN_ACP_COMMAND_DEEPSEEK: '   ' })).toBe('0.2.0-rc.2');
  });

  it('has no floor for targets without one (yet — table-driven)', () => {
    expect(acpMinVersion('claude-code', {})).toBeNull();
    expect(acpMinVersion('codex', {})).toBeNull();
    expect(acpMinVersion('opencode', {})).toBeNull();
  });
});

describe('checkAcpVersion', () => {
  it('refuses below the floor with the upgrade hint (prerelease-aware)', async () => {
    const probe = vi.fn(async () => info('0.2.0-rc.1'));
    const result = await checkAcpVersion('deepseek', {}, { probe });
    expect(probe).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.version).toBe('0.2.0-rc.1');
      expect(result.min).toBe('0.2.0-rc.2');
      expect(result.message).toContain('dsh 0.2.0-rc.1 is not supported');
      expect(result.message).toContain('npm install -g @deepseek-ai/dsh@latest');
    }
  });

  it('refuses the whole unsupported line (0.1.x, 0.2.1-alpha is ABOVE)', async () => {
    for (const v of ['0.1.2-rc.1', '0.1.5-rc.3', '0.1.7-rc.2', '0.2.0-rc.1']) {
      const result = await checkAcpVersion('deepseek', {}, { probe: async () => info(v) });
      expect(result.ok, v).toBe(false);
    }
    for (const v of ['0.2.0-rc.2', '0.2.0', '0.2.1-alpha.2', '0.3.0']) {
      const result = await checkAcpVersion('deepseek', {}, { probe: async () => info(v) });
      expect(result.ok, v).toBe(true);
    }
  });

  it('takes the first token of a decorated version string', async () => {
    const result = await checkAcpVersion(
      'deepseek',
      {},
      {
        probe: async () => info('0.2.0-rc.2 (build 123)'),
      },
    );
    expect(result.ok).toBe(true);
  });

  it('passes through when the version is absent or unparseable (spawn surfaces the real failure)', async () => {
    for (const probe of [
      async () => info(undefined),
      async () => info('', false),
      async () => ({ target: 'deepseek', installed: false }) as RuntimeInfo,
      async () => info('not-a-version'),
      async () => null,
    ]) {
      expect((await checkAcpVersion('deepseek', {}, { probe })).ok).toBe(true);
    }
  });

  it('never probes override-managed or ungated targets', async () => {
    const probe = vi.fn(async () => info('0.0.1'));
    expect(
      (
        await checkAcpVersion(
          'deepseek',
          { HN_ACP_COMMAND_DEEPSEEK: 'node /fixture.mjs' },
          { probe },
        )
      ).ok,
    ).toBe(true);
    expect((await checkAcpVersion('claude-code', {}, { probe })).ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
