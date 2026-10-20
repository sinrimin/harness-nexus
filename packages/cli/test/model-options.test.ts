// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { rewriteHistoryItems, rewriteSessionConfigOptions } from '../src/daemon/model-options.js';
import type { HistoryItem, SessionConfigOption } from '@harness-nexus/shared';

/**
 * 9 W13 — the model-option rewrite matrix. Ground truth per adapter in
 * wiki research-phase-9-w13-multi-model-picker.md; the wiring points in
 * chat.ts are covered by the integration test in chat.test.ts.
 */

const modelRow = (over: Partial<SessionConfigOption> = {}): SessionConfigOption => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'gw-large',
  options: [
    { value: 'gw-large', name: 'GW Large' },
    { value: 'builtin-1', name: 'Built-in One' },
    { value: 'gw-mini', name: 'GW Mini' },
  ],
  ...over,
});

const effortRow: SessionConfigOption = {
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'high', name: 'High' },
  ],
};

describe('rewriteSessionConfigOptions (9 W13)', () => {
  it('codex: keeps the configured set, drops the built-ins', () => {
    const out = rewriteSessionConfigOptions([modelRow(), effortRow], {
      target: 'codex',
      modelOptions: ['gw-large', 'gw-mini'],
    });
    expect(out[0]!.options?.map((o) => o.value)).toEqual(['gw-large', 'gw-mini']);
    // non-model categories pass through untouched
    expect(out[1]).toBe(effortRow);
  });

  it('opencode: allowed values carry the harness-nexus/ prefix', () => {
    const row = modelRow({
      // a real opencode row's current value is prefixed too (provider/model)
      currentValue: 'harness-nexus/gw-large',
      options: [
        { value: 'harness-nexus/gw-large', name: 'GW Large' },
        { value: 'anthropic/claude-x', name: 'Claude' },
        { value: 'harness-nexus/gw-mini', name: 'GW Mini' },
      ],
    });
    const out = rewriteSessionConfigOptions([row], {
      target: 'opencode',
      modelOptions: ['gw-large', 'gw-mini'],
    });
    expect(out[0]!.options?.map((o) => o.value)).toEqual([
      'harness-nexus/gw-large',
      'harness-nexus/gw-mini',
    ]);
  });

  it('a currentValue outside the kept list is appended verbatim', () => {
    const out = rewriteSessionConfigOptions(
      [modelRow({ currentValue: 'builtin-9', options: [{ value: 'gw-large', name: 'GW Large' }] })],
      { target: 'codex', modelOptions: ['gw-large'] },
    );
    expect(out[0]!.options).toEqual([
      { value: 'gw-large', name: 'GW Large' },
      { value: 'builtin-9', name: 'builtin-9' },
    ]);
  });

  it('codex: builds entries for configured extras the adapter never listed', () => {
    // codex only advertises presets + the CURRENT model verbatim — a custom
    // extra id is absent from its own list, yet selectable (raw ids accepted
    // on set; rig-found: an intersection filter here dropped every extra).
    const row = modelRow({
      options: [
        { value: 'gw-large', name: 'GW Large' },
        { value: 'gpt-5-pro', name: 'GPT' },
      ],
    });
    const out = rewriteSessionConfigOptions([row], {
      target: 'codex',
      modelOptions: ['gw-large', 'gw-mini'],
    });
    expect(out[0]!.options).toEqual([
      { value: 'gw-large', name: 'GW Large' },
      { value: 'gw-mini', name: 'gw-mini' },
    ]);
  });

  it('opencode: empty intersection leaves the row untouched (hand-managed install)', () => {
    const row = modelRow({
      options: [{ value: 'anthropic/claude-x', name: 'Claude' }],
    });
    const out = rewriteSessionConfigOptions([row], {
      target: 'opencode',
      modelOptions: ['gw-large'],
    });
    expect(out[0]!.options?.map((o) => o.value)).toEqual(['anthropic/claude-x']);
  });

  it('no configured set → identity (old server / no stored config)', () => {
    const row = modelRow();
    for (const target of ['codex', 'opencode']) {
      const out = rewriteSessionConfigOptions([row], { target });
      expect(out[0]!.options?.map((o) => o.value)).toEqual(['gw-large', 'builtin-1', 'gw-mini']);
    }
  });

  it('deepseek: intersects on the JSON [provider, model] tuple values', () => {
    // dsh-acp's model row after daemon-side group flattening (9 W13)
    const row = modelRow({
      currentValue: '["harness-nexus","gw-large"]',
      options: [
        { value: '["deepseek-official","deepseek-chat"]', name: 'DeepSeek Chat' },
        { value: '["harness-nexus","gw-large"]', name: 'GW Large', group: 'harness-nexus' },
        { value: '["harness-nexus","gw-mini"]', name: 'GW Mini', group: 'harness-nexus' },
      ],
    });
    const out = rewriteSessionConfigOptions([row], {
      target: 'deepseek',
      modelOptions: ['gw-large', 'gw-mini'],
    });
    expect(out[0]!.options?.map((o) => o.value)).toEqual([
      '["harness-nexus","gw-large"]',
      '["harness-nexus","gw-mini"]',
    ]);
    // empty intersection (serialization drift / hand-managed catalog) → untouched
    const row2 = modelRow({
      options: [{ value: '["deepseek-official","deepseek-chat"]', name: 'DeepSeek Chat' }],
    });
    const out2 = rewriteSessionConfigOptions([row2], {
      target: 'deepseek',
      modelOptions: ['gw-large'],
    });
    expect(out2[0]!.options?.length).toBe(1);
  });

  it('claude-code / chat-only targets are identity (writer/native own it)', () => {
    const row = modelRow();
    for (const target of ['claude-code', 'hermes', 'zcode', 'generic']) {
      const out = rewriteSessionConfigOptions([row], { target, modelOptions: ['gw-large'] });
      expect(out[0]!.options?.length).toBe(3);
    }
  });

  it('a model row without options is untouched', () => {
    const row: SessionConfigOption = { id: 'model', name: 'Model', category: 'model' };
    expect(rewriteSessionConfigOptions([row], { target: 'codex', modelOptions: ['x'] })[0]).toBe(
      row,
    );
  });

  it('idempotent: applying twice equals applying once', () => {
    const ctx = { target: 'codex', modelOptions: ['gw-large', 'gw-mini'] } as const;
    const once = rewriteSessionConfigOptions([modelRow()], ctx);
    expect(rewriteSessionConfigOptions(once, ctx)).toEqual(once);
  });
});

describe('rewriteHistoryItems (9 W13)', () => {
  it('rewrites session_config events inside a captured batch, keeps the rest', () => {
    const items: HistoryItem[] = [
      { type: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      { type: 'event', event: { kind: 'user_echo' } },
      {
        type: 'event',
        event: { kind: 'session_config', configOptions: [modelRow(), effortRow] },
      },
      { type: 'event', event: { kind: 'session_config', modes: undefined } },
    ];
    const out = rewriteHistoryItems(items, { target: 'codex', modelOptions: ['gw-mini'] });
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toBe(items[1]);
    const cfg = out[2];
    if (cfg.type !== 'event' || cfg.event.kind !== 'session_config') throw new Error('unreachable');
    // kept gw-mini; the out-of-list currentValue (gw-large) rides verbatim
    expect(cfg.event.configOptions?.[0]!.options?.map((o) => o.value)).toEqual([
      'gw-mini',
      'gw-large',
    ]);
    expect(out[3]).toBe(items[3]);
  });

  it('identity without a configured set', () => {
    const items: HistoryItem[] = [
      {
        type: 'event',
        event: { kind: 'session_config', configOptions: [modelRow()] },
      },
    ];
    const out = rewriteHistoryItems(items, { target: 'codex' });
    expect(out[0]).toEqual(items[0]);
  });
});
