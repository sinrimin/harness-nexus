import type { ComponentType } from 'react';
import type { TopologyStyle } from '@/skins/registry.js';
import { MeshTopology } from './mesh-topology.js';
import { PlateTopology } from './plate-topology.js';
import { RadarTopology } from './radar-topology.js';
import type { TopologyProps } from './topology-frame.js';

/**
 * The dashboard hero's renderers, by skin (04-contract.md §3 — `SkinManifest.topology`
 * finally has a consumer).
 *
 * A skin picks the SHAPE of the picture, not its data: every renderer takes the
 * same `TopologyProps` and shows the same facts with real states (the legend
 * documents them, overflow is named on both sides, nothing is invented).
 *
 * - `constellation` — the SVG fan-in/fan-out (the product's signature).
 * - `plate` — the same mesh as a two-column list; also what `constellation`
 *   steps aside for when its labels would render too small (mesh-topology.tsx).
 * - `radar` — the mesh as an instrument sweep (radar-topology.tsx). Built in
 *   P7, where the flexibility drill selects it for real: before that the key
 *   resolved to `constellation`, which proved the field was decorative.
 *
 * P8 kept `radar` although no shipped skin selects it: the key is part of the
 * frozen `TopologyStyle` contract (`04-contract.md §3`), it is a real renderer
 * with real coverage, and a third skin gets it by editing its manifest alone —
 * deleting it now would make the contract's three shapes a lie again.
 */
export const TOPOLOGY_RENDERERS: Record<TopologyStyle, ComponentType<TopologyProps>> = {
  constellation: MeshTopology,
  plate: PlateTopology,
  radar: RadarTopology,
};

export function topologyRenderer(style: TopologyStyle): ComponentType<TopologyProps> {
  return TOPOLOGY_RENDERERS[style] ?? MeshTopology;
}
