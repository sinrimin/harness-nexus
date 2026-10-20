// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  createMachineJobSchema,
  hasClaudeOneMarker,
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  runtimeConfigGetRequestSchema,
  runtimeConfigSpecSchema,
  runtimeConfigViewEventSchema,
  runtimeSpecUnsupportedReason,
  RUNTIME_API_SUPPORT,
  setClaudeOneMarker,
  stripClaudeOneMarker,
} from '../src/index.js';

/** Phase 9 W3 — the provider-config spec, its per-target policy, and the apply-config job arm. */

const validSpec = {
  providerLabel: 'team gateway',
  baseUrl: 'https://gw.example.com/v1',
  api: 'openai',
  model: 'gpt-5',
  credentialName: 'gw-key',
};

describe('runtimeConfigSpecSchema', () => {
  it('accepts a full spec and a baseUrl-less one', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, baseUrl: undefined }).success).toBe(
      true,
    );
  });

  it('rejects a malformed baseUrl and empty required fields', () => {
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, baseUrl: 'not-a-url' }).success).toBe(
      false,
    );
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, model: '' }).success).toBe(false);
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, credentialName: '' }).success).toBe(
      false,
    );
  });

  it('#60 — accepts a full claudeCode knob set and stays optional', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    const parsed = runtimeConfigSpecSchema.safeParse({
      ...validSpec,
      api: 'anthropic-messages',
      model: 'gw-large[1m]',
      claudeCode: {
        authField: 'ANTHROPIC_API_KEY',
        tiers: [
          {
            tier: 'sonnet',
            model: 'gw-large[1m]',
            displayName: 'Gateway Large',
            capabilities: ['effort', 'thinking'],
          },
          { tier: 'haiku', model: 'gw-mini' },
        ],
        subagentModel: 'gw-mini[1m]',
        maxOutputTokens: 64000,
        maxContextTokens: 983616,
        extraBody: { enable_thinking: true },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('#60 — rejects out-of-bounds knobs and unknown tiers', () => {
    const base = { ...validSpec, api: 'anthropic-messages' as const };
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        claudeCode: { maxOutputTokens: 200000 },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, claudeCode: { maxContextTokens: 0 } }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        claudeCode: { tiers: [{ tier: 'mythos' as never, model: 'x' }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, claudeCode: { tiers: [{ tier: 'opus' }] } })
        .success,
    ).toBe(false);
  });

  it('#62 — accepts a full opencode knob set and stays optional', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    const parsed = runtimeConfigSpecSchema.safeParse({
      ...validSpec,
      opencode: {
        models: [
          {
            id: 'gw-large',
            name: 'Gateway Large',
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
            reasoning: true,
            temperatureEnabled: true,
            vision: true,
            options: { enable_thinking: true },
          },
        ],
        smallModel: 'gw-mini',
        autoupdateDisabled: true,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('#62 — rejects non-positive limits and an id-less model detail', () => {
    const base = { ...validSpec, api: 'openai' as const };
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        opencode: { models: [{ id: 'x', contextWindow: 0 }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        opencode: { models: [{ id: 'x', maxOutputTokens: -1 }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, opencode: { models: [{ name: 'x' }] } }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, opencode: { smallModel: '' } }).success,
    ).toBe(false);
  });

  it('#63 — accepts a full codex knob set and stays optional', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    const parsed = runtimeConfigSpecSchema.safeParse({
      ...validSpec,
      codex: {
        reasoningEffort: 'xhigh',
        reasoningSummary: 'none',
        verbosity: 'low',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        switches: { updateCheckDisabled: true },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('#63 — rejects off-enum dials and non-positive token counts', () => {
    const base = { ...validSpec, api: 'openai' as const };
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        codex: { reasoningEffort: 'ultra' },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, codex: { verbosity: 'terse' } }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        codex: { reasoningSummary: 'verbose' },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, codex: { contextWindow: 0 } }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        codex: { autoCompactTokenLimit: 20_000_001 },
      }).success,
    ).toBe(false);
  });

  it('#64 — accepts a full deepseek detail set and stays optional', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    const parsed = runtimeConfigSpecSchema.safeParse({
      ...validSpec,
      api: 'anthropic-messages',
      deepseek: {
        models: [
          {
            id: 'gw-large',
            name: 'Gateway Large',
            contextWindow: 1_000_000,
            maxOutputTokens: 384_000,
            vision: true,
          },
          { id: 'gw-mini' },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('#64 — rejects non-positive detail numbers and an id-less entry', () => {
    const base = { ...validSpec, api: 'anthropic-messages' as const };
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        deepseek: { models: [{ id: 'x', contextWindow: 0 }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        deepseek: { models: [{ id: 'x', maxOutputTokens: -1 }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, deepseek: { models: [{ name: 'x' }] } }).success,
    ).toBe(false);
  });

  it('#65 — accepts a full pi detail set and stays optional', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    const parsed = runtimeConfigSpecSchema.safeParse({
      ...validSpec,
      pi: {
        models: [
          {
            id: 'gw-large',
            name: 'Gateway Large',
            contextWindow: 1_000_000,
            maxOutputTokens: 384_000,
            vision: true,
            reasoning: true,
            samplingParams: { enable_thinking: true, top_p: 0.9 },
          },
          { id: 'gw-mini' },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('#65 — rejects non-positive detail numbers and an id-less entry', () => {
    const base = { ...validSpec, api: 'openai' as const };
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        pi: { models: [{ id: 'x', contextWindow: 0 }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({
        ...base,
        pi: { models: [{ id: 'x', maxOutputTokens: -1 }] },
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, pi: { models: [{ name: 'x' }] } }).success,
    ).toBe(false);
  });
});

describe('claude-code [1m] marker helpers (#60)', () => {
  it('detects case-insensitively and round-trips strip/set', () => {
    expect(hasClaudeOneMarker('qwen-plus[1m]')).toBe(true);
    expect(hasClaudeOneMarker('qwen-plus[1M] ')).toBe(true);
    expect(hasClaudeOneMarker('qwen-plus')).toBe(false);
    expect(stripClaudeOneMarker('qwen-plus[1m]')).toBe('qwen-plus');
    expect(stripClaudeOneMarker('qwen-plus [1M]\t')).toBe('qwen-plus');
    expect(stripClaudeOneMarker('qwen-plus')).toBe('qwen-plus');
    expect(setClaudeOneMarker('qwen-plus', true)).toBe('qwen-plus[1m]');
    // setting is idempotent and stripping a bare id is a no-op
    expect(setClaudeOneMarker(setClaudeOneMarker(' qwen-plus ', true), true)).toBe('qwen-plus[1m]');
    expect(setClaudeOneMarker('qwen-plus[1m]', false)).toBe('qwen-plus');
    expect(setClaudeOneMarker('', true)).toBe('');
  });
});

describe('runtimeSpecUnsupportedReason', () => {
  it('bounds each target to the api flavors it speaks', () => {
    expect(RUNTIME_API_SUPPORT['claude-code']).toEqual(['anthropic-messages']);
    expect(RUNTIME_API_SUPPORT.codex).toEqual(['openai']);
    expect(RUNTIME_API_SUPPORT.deepseek).toContain('openai');
    // 9 W16 — pi's models.json api enum covers both coarse flavors.
    expect(RUNTIME_API_SUPPORT.pi).toEqual(['anthropic-messages', 'openai']);
  });

  it('rejects flavor mismatches (claude-code cannot speak openai)', () => {
    expect(runtimeSpecUnsupportedReason('claude-code', { ...validSpec, api: 'openai' })).toContain(
      'cannot speak',
    );
    expect(
      runtimeSpecUnsupportedReason('codex', { ...validSpec, api: 'anthropic-messages' }),
    ).toContain('cannot speak');
  });

  it('demands a baseUrl for deepseek (its route is not in the pi-ai catalog)', () => {
    const spec = { ...validSpec, api: 'openai' as const, baseUrl: undefined };
    expect(runtimeSpecUnsupportedReason('deepseek', spec)).toContain('baseUrl');
    expect(runtimeSpecUnsupportedReason('deepseek', validSpec)).toBeNull();
    // claude-code/codex may omit it (provider default endpoint).
    expect(
      runtimeSpecUnsupportedReason('claude-code', {
        ...validSpec,
        baseUrl: undefined,
        api: 'anthropic-messages' as const,
      }),
    ).toBeNull();
    expect(runtimeSpecUnsupportedReason('codex', { ...validSpec, baseUrl: undefined })).toBeNull();
  });

  it('demands a baseUrl for pi (the writer defines a custom models.json provider)', () => {
    const spec = { ...validSpec, baseUrl: undefined };
    expect(runtimeSpecUnsupportedReason('pi', spec)).toContain('baseUrl');
    expect(runtimeSpecUnsupportedReason('pi', validSpec)).toBeNull();
  });
});

describe('apply-config job arm', () => {
  it('accepts apply-config without a version; rejects it with one', () => {
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'apply-config',
        target: 'codex',
      }).success,
    ).toBe(true);
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'apply-config',
        target: 'codex',
        version: '1.0.0',
      }).success,
    ).toBe(false);
  });

  it('rides the REST job union (the route layer points callers at the PUT surface)', () => {
    const parsed = createMachineJobSchema.safeParse({
      type: 'harness',
      action: 'apply-config',
      target: 'deepseek',
    });
    expect(parsed.success).toBe(true);
  });

  it('result data carries the written files arm', () => {
    expect(
      harnessResultDataSchema.safeParse({
        target: 'codex',
        action: 'apply-config',
        files: ['~/.codex/config.toml', '~/.codex/auth.json'],
      }).success,
    ).toBe(true);
    // install results keep working unchanged
    expect(
      harnessResultDataSchema.safeParse({ target: 'codex', action: 'pin', version: '0.12.0' })
        .success,
    ).toBe(true);
  });
});

describe('runtime:config view events (W4)', () => {
  it('validates the request shape', () => {
    expect(
      runtimeConfigGetRequestSchema.safeParse({ requestId: 'r1', target: 'codex' }).success,
    ).toBe(true);
    expect(
      runtimeConfigGetRequestSchema.safeParse({ requestId: 'r1', target: 'hermes' }).success,
    ).toBe(false);
    expect(runtimeConfigGetRequestSchema.safeParse({ requestId: '' }).success).toBe(false);
  });

  it('validates the reply (files + redacted list, or the error arm)', () => {
    const ok = runtimeConfigViewEventSchema.safeParse({
      requestId: 'r1',
      target: 'codex',
      files: [
        { path: '~/.codex/auth.json', content: '{\\n  "OPENAI_API_KEY": "\\${redacted}"\\n}\\n' },
      ],
      redacted: ['~/.codex/auth.json:OPENAI_API_KEY'],
    });
    expect(ok.success).toBe(true);
    // redacted defaults to [] when absent
    const minimal = runtimeConfigViewEventSchema.parse({ requestId: 'r2', target: 'deepseek' });
    expect(minimal.redacted).toEqual([]);
    const errored = runtimeConfigViewEventSchema.safeParse({
      requestId: 'r3',
      target: 'codex',
      error: 'read failed',
    });
    expect(errored.success).toBe(true);
    // oversized content is rejected (the wire cap is the backstop)
    expect(
      runtimeConfigViewEventSchema.safeParse({
        requestId: 'r4',
        target: 'codex',
        files: [{ path: 'x', content: 'a'.repeat(131073) }],
      }).success,
    ).toBe(false);
  });
});
