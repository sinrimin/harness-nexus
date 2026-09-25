import {
  MeshFrame,
  truncate,
  upstreamVariant,
  variantFill,
  type FleetNode,
  type TopologyProps,
} from './topology-frame.js';

/**
 * The `radar` topology — the mesh as an instrument sweep (04-contract.md §3).
 *
 * The third renderer NIGHTWATCH's placeholder skin selects in P7's flexibility
 * drill. It is a real renderer, not a fallback: the same facts, the same
 * variants, the same frame and legend as the other two — upstreams on the left
 * arcs, machines on the right, the hub at the centre on a ring graticule. A
 * skin that declares `radar` gets this picture; before P7 the key resolved to
 * `constellation`, which proved nothing.
 *
 * Only the first four upstreams and three machines are labelled (the comp does
 * the same on its own hero); the rest are named in the legend's counts and are
 * reachable as `<title>` on their node, so nothing is silently dropped.
 */

const W = 1120;
const H = 366;
const CX = W / 2;
const CY = H / 2;
const RINGS = [52, 100, 148];

/** Place `count` nodes along an arc at `radius`, centred on `angle` degrees. */
function arc(count: number, radius: number, angle: number): { x: number; y: number }[] {
  if (count === 0) return [];
  const spread = 46;
  const step = count === 1 ? 0 : Math.min(spread, 34 / (count - 1)) * (180 / Math.PI);
  const start = angle - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => {
    const deg = start + i * step;
    const rad = (deg * Math.PI) / 180;
    return { x: CX + Math.cos(rad) * radius, y: CY - Math.sin(rad) * radius };
  });
}

export function RadarTopology({ servers, statuses, machines }: TopologyProps) {
  const fleet = machines ?? [];
  const upstreamNodes = arc(servers.length, RINGS[2] ?? 148, 180);
  const fleetNodes = arc(fleet.length, RINGS[2] ?? 148, 0);
  const online = fleet.filter((m) => m.online).length;
  const connected = statuses?.filter((s) => s.status === 'connected').length;

  return (
    <MeshFrame
      upstreamCount={servers.length}
      machineCount={fleet.length}
      {...(statuses !== undefined ? { statuses } : {})}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="text-border h-[240px] w-full sm:h-[300px]"
        role="img"
        aria-label={
          connected === undefined
            ? `${servers.length} upstreams, ${online}/${fleet.length} machines online`
            : `${connected}/${servers.length} upstreams connected, ${online}/${fleet.length} machines online`
        }
      >
        {/* Graticule: rings + spokes, drawn in the frame's rule colour. */}
        <g stroke="currentColor" fill="none" strokeWidth="1">
          {RINGS.map((r) => (
            <ellipse key={r} cx={CX} cy={CY} rx={r * 2.6} ry={r} />
          ))}
          <line x1={CX - 440} y1={CY} x2={CX + 440} y2={CY} />
          <line x1={CX} y1={CY - 168} x2={CX} y2={CY + 168} />
        </g>

        {/* The hub — the same live plate the constellation draws. */}
        <circle cx={CX} cy={CY} r={34} className="fill-signal/15" />
        <circle cx={CX} cy={CY} r={22} className="fill-signal" />
        <circle cx={CX} cy={CY} r={7} className="fill-background" />

        {/* Upstreams (left) and machines (right): one node per row of the data.
            The wiring is one accent at low alpha (the mesh draws it the same
            way); the node itself carries the state. */}
        <g stroke="currentColor" strokeWidth="1.5" className="text-signal/45">
          {servers.map((s, i) => {
            const variant = upstreamVariant(s.id, statuses);
            const p = upstreamNodes[i];
            if (p === undefined) return null;
            return (
              <g key={s.id}>
                <line x1={CX} y1={CY} x2={p.x} y2={p.y} />
                {variant === 'online' ? (
                  <circle cx={p.x} cy={p.y} r={7} className={variantFill(variant)} opacity="0.35" />
                ) : null}
                <circle cx={p.x} cy={p.y} r={4.2} className={variantFill(variant)} />
                <title>{`${s.name} — ${variant}`}</title>
              </g>
            );
          })}
          {fleet.map((m, i) => {
            const p = fleetNodes[i];
            if (p === undefined) return null;
            return (
              <g key={m.id}>
                <line x1={CX} y1={CY} x2={p.x} y2={p.y} />
                {m.online ? (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={7}
                    className={variantFill('online')}
                    opacity="0.35"
                  />
                ) : null}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={4.2}
                  className={variantFill(m.online ? 'online' : 'configured')}
                />
                <title>{`${m.name} — ${m.agentCount} agents`}</title>
              </g>
            );
          })}
        </g>

        {/* Four labels a side at most — the same discipline the constellation
            keeps, and the reason the counts stay on the frame. */}
        <g className="fill-foreground text-[13px]">
          {servers.slice(0, 4).map((s, i) => {
            const p = upstreamNodes[i];
            if (p === undefined) return null;
            return (
              <text key={s.id} x={p.x - 10} y={p.y + 4} textAnchor="end" className="font-mono">
                {truncate(s.name, 16)}
              </text>
            );
          })}
          {fleet.slice(0, 3).map((m, i) => {
            const p = fleetNodes[i];
            if (p === undefined) return null;
            return (
              <text key={m.id} x={p.x + 10} y={p.y + 4} textAnchor="start" className="font-mono">
                {truncate(m.name, 16)}
              </text>
            );
          })}
          <text x={CX} y={CY + 52} textAnchor="middle" className="text-[12px]">
            Harness Nexus
          </text>
        </g>
      </svg>
    </MeshFrame>
  );
}

/** Exported so a drill or a test can assert the arc maths without a DOM. */
export const RADAR_RINGS = RINGS;

export type { FleetNode };
