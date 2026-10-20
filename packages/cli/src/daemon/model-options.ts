// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { DSH_PROVIDER_ID, OPENCODE_PROVIDER_ID, PI_PROVIDER_ID } from '@harness-nexus/shared';
import type { HistoryItem, SessionConfigOption } from '@harness-nexus/shared';

/**
 * 9 W13 — the model-option rewrite. The session-config model selector lists
 * whatever the ADAPTER advertises; under a W3 gateway push everything except
 * the configured default is the agent's own built-in catalog — dead entries.
 * This module narrows the `category === 'model'` select row to the models
 * the platform configured (`chat:session.start` `modelOptions`,
 * `unique([model, ...models])` from the stored RuntimeConfig), at every
 * point adapter options enter OUR wire. The adapters themselves are never
 * touched: values still flow verbatim (`session/set_config_option` accepts
 * raw ids on codex; opencode's registry contains our W12 provider models).
 *
 * claude-code needs no rewrite (the W3 writer's `availableModels` allowlist
 * constrains the wrapper's own option list) and deepseek's native picker
 * already reads the W10 catalog — both fall through as identity.
 * wiki design-phase-9-w13-multi-model.md.
 */

/** What the rewrite needs to know about the channel. */
export interface ModelOptionRewrite {
  target: string;
  /** Configured model set; absent = no stored config (or a pre-W13 server). */
  modelOptions?: readonly string[] | undefined;
}

/**
 * Per-target allowed VALUES for the model-category row. Null = leave the
 * adapter's list untouched (identity targets, or no configured set).
 */
function allowedModelValues(ctx: ModelOptionRewrite): readonly string[] | null {
  if (ctx.modelOptions === undefined || ctx.modelOptions.length === 0) return null;
  switch (ctx.target) {
    case 'codex':
      // codex-acp takes raw model ids on set (no list validation).
      return ctx.modelOptions;
    case 'opencode':
      // opencode validates against its provider registry — our W12 writer's
      // `models` map IS that registry for these ids.
      return ctx.modelOptions.map((id) => `${OPENCODE_PROVIDER_ID}/${id}`);
    case 'pi':
      // 9 W16 — pi model refs are `provider/id`-shaped (the --model flag
      // syntax) and validated against its own registry; our models.json
      // provider models ARE that registry for these ids. Intersect stance,
      // like opencode (the pi façade synthesizes the option row).
      return ctx.modelOptions.map((id) => `${PI_PROVIDER_ID}/${id}`);
    case 'deepseek':
      // dsh's model option values are JSON [provider, model] tuples (compact
      // serialization, verified against dsh-acp 0.1.2-rc.1); its catalog also
      // carries the built-in deepseek-official group, so intersect to ours.
      return ctx.modelOptions.map((id) => JSON.stringify([DSH_PROVIDER_ID, id]));
    default:
      return null;
  }
}

function rewriteModelOption(
  option: SessionConfigOption,
  ctx: ModelOptionRewrite,
  allowed: readonly string[],
): SessionConfigOption {
  if (option.category !== 'model' || option.options === undefined) return option;

  if (ctx.target === 'codex') {
    // BUILD the list from the configured set, not filter the adapter's: codex
    // only ever advertises its remote presets plus the CURRENT model as a
    // verbatim entry, so configured extras never appear in its own list —
    // yet set_config_option takes raw ids, so the entries are genuinely
    // selectable (rig-found on 0.16.0: an intersection filter here silently
    // dropped every extra beyond the current model).
    const byValue = new Map(option.options.map((o) => [o.value, o]));
    const options = allowed.map((v) => byValue.get(v) ?? { value: v, name: v });
    const current = option.currentValue;
    if (current !== undefined && !options.some((o) => o.value === current)) {
      options.push({ value: current, name: current });
    }
    return { ...option, options };
  }

  // opencode — intersect with the adapter's list: set validates against the
  // provider registry, so only values the adapter itself offers are certain
  // to be selectable. Empty intersection = a hand-managed install (or a set
  // the live config no longer describes): the full list is the honest state.
  const kept = option.options.filter((o) => allowed.includes(o.value));
  if (kept.length === 0) return option;
  // A currentValue outside the kept list stays selectable verbatim — mirrors
  // the adapters' own out-of-picker semantics (e.g. a resumed session
  // running a model outside our set).
  const current = option.currentValue;
  const options =
    current !== undefined && !kept.some((o) => o.value === current)
      ? [...kept, { value: current, name: current }]
      : kept;
  return { ...option, options };
}

/** Narrow one admitted configOptions array (establishment snapshot or push). */
export function rewriteSessionConfigOptions(
  options: readonly SessionConfigOption[],
  ctx: ModelOptionRewrite,
): SessionConfigOption[] {
  const allowed = allowedModelValues(ctx);
  if (allowed === null) return options.slice();
  return options.map((o) => rewriteModelOption(o, ctx, allowed));
}

/**
 * Narrow the `session_config` events inside a captured history batch (the
 * session/load replay path). The establishment response's snapshot is
 * last-wins anyway, but a resync replay should not flash an unfiltered list.
 */
export function rewriteHistoryItems(
  items: readonly HistoryItem[],
  ctx: ModelOptionRewrite,
): HistoryItem[] {
  const allowed = allowedModelValues(ctx);
  if (allowed === null) return items.slice();
  return items.map((item) => {
    if (item.type !== 'event') return item;
    const event = item.event;
    if (event.kind !== 'session_config' || event.configOptions === undefined) return item;
    return {
      ...item,
      event: {
        ...event,
        configOptions: event.configOptions.map((o) => rewriteModelOption(o, ctx, allowed)),
      },
    };
  });
}
