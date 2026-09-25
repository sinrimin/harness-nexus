/**
 * Skin registry — the contract every skin declares itself against.
 * Design source: wiki `design-skin-system.md` (and the local exploration under
 * docs/dev/theme-designs/). Rules:
 *
 * - A skin may override token VALUES (see index.css for the frozen contract)
 *   and add styles scoped under `[data-skin='<id>']` — nothing else.
 * - `modes` declares which light/dark modes the skin ships; single-mode skins
 *   lock the theme toggle.
 * - `topology` picks the mesh visualization renderer for the dashboard.
 * - A skin may NOT add DOM. The extra regions the skins-of-record want
 *   (NIGHTWATCH's watch bar, LEDGER's folio margin) ride the base's `Region`
 *   slots, which render nothing while empty — so a skin never needs a manifest
 *   field to own them. (`widgets` used to claim otherwise and was never
 *   implemented nor called: 04-contract.md §3.)
 * - `load()` injects the skin's tokens.css / skin.css / fonts at runtime;
 *   `signal` is the always-present baseline and loads nothing.
 */

export type SkinId = 'signal' | 'bay' | 'ledger' | 'nightwatch';
export type SkinMode = 'light' | 'dark';
export type StatusStyle = 'dot' | 'led' | 'lamp' | 'word';
export type TopologyStyle = 'constellation' | 'plate' | 'radar';

export interface SkinManifest {
  id: SkinId;
  /** i18n key resolving to the display name (product names stay untranslated). */
  nameKey: `app.skin${Capitalize<SkinId>}`;
  modes: SkinMode[];
  statusStyle: StatusStyle;
  topology: TopologyStyle;
  load: () => Promise<unknown>;
}

import { baySkin } from './bay/index.js';

export const SKINS: SkinManifest[] = [
  {
    id: 'signal',
    nameKey: 'app.skinSignal',
    modes: ['light', 'dark'],
    statusStyle: 'dot',
    topology: 'constellation',
    load: async () => {},
  },
  baySkin,
];

export const DEFAULT_SKIN: SkinId = 'signal';

export function isSkinId(value: string | null): value is SkinId {
  return SKINS.some((s) => s.id === value);
}

export function getSkin(id: SkinId): SkinManifest {
  const skin = SKINS.find((s) => s.id === id);
  if (!skin) throw new Error(`unknown skin: ${id}`);
  return skin;
}
