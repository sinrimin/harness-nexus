import type { ComponentType } from 'react';
import type { TopologyStyle } from '@/skins/registry.js';
import { MeshTopology } from './mesh-topology.js';
import { PlateTopology } from './plate-topology.js';
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
 * - `radar` — not built. It resolves to `constellation` on purpose, so a skin
 *   declaring a renderer we do not have still draws the mesh; P7's placeholder
 *   skin drills exactly this key to prove the registry is real, not decorative.
 */
export const TOPOLOGY_RENDERERS: Record<TopologyStyle, ComponentType<TopologyProps>> = {
  constellation: MeshTopology,
  plate: PlateTopology,
  radar: MeshTopology,
};

export function topologyRenderer(style: TopologyStyle): ComponentType<TopologyProps> {
  return TOPOLOGY_RENDERERS[style] ?? MeshTopology;
}
