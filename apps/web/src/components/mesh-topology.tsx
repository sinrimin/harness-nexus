import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';
import { Link } from 'react-router-dom';
import { PlusIcon, ServerIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import {
  Dot,
  MeshFrame,
  TopologyPending,
  truncate,
  upstreamVariant,
  variantFill,
  type TopologyProps,
} from './topology-frame.js';
import { PlateTopology } from './plate-topology.js';

/**
 * Dashboard signature: the CONSTELLATION. Upstream MCP servers fan in from
 * the left, the Harness Nexus hub sits at the center, and the machine FLEET
 * fans out on the right — the picture is the product: upstreams converge on
 * the nexus, and the nexus reaches out to manage the machines' Agents.
 *
 * Every dot reflects a REAL state: upstream dots come from the live registry
 * (`connected` → `--ok`, `connecting` muted, `error` → `--warn`); machine
 * dots come from presence (`online` → `--ok`, offline muted) and flip live
 * on `machine:status` pushes. The legend documents the states so the diagram
 * never lies, and overflow is summarized on both sides so it never lies by
 * omission either.
 *
 * One measured limit (P5): the SVG's labels are set in viewBox units, so they
 * scale with the container — at 390px the 13px label renders ~6.7px. Below a
 * legible floor this renderer steps aside for `plate` (the list), which carries
 * the same facts in a shape a phone can read. The threshold is measured from the
 * container width (ResizeObserver), not guessed from the viewport.
 */

const MAX_NAMED_UPSTREAMS = 4;
const MAX_NAMED_MACHINES = 5;
// Geometric constants hoisted out of render (static across renders).
const W = 760;
const HUB_X = W / 2;
const UPSTREAM_X = 70;
const MACHINE_X = W - 78;
const LABEL_PX = 13;
/** Below this the rendered label is too small to read — hand over to `plate`. */
const MIN_RENDERED_LABEL_PX = 9.5;
/** Canvas height follows the tallest fan — sparse fleets get a compact card
 *  instead of a single row floating in 300px of dead whitespace. */
const canvasH = (upCount: number, machineCount: number): number =>
  Math.min(300, Math.max(176, 88 + Math.max(upCount, machineCount) * 48));

export function MeshTopology(props: TopologyProps) {
  const { servers, loading, statuses, machines } = props;
  const { t } = useI18n();
  const [measureRef, width] = useMeasuredWidth();

  return (
    // The measured wrapper is rendered on EVERY branch (loading, empty, svg,
    // plate): a ref that only exists in one of them never attaches, and the
    // observer then never fires — which is exactly how the first version of this
    // stayed on the SVG at 390px.
    <div ref={measureRef} className="min-w-0">
      <MeshBody {...props} width={width} />
    </div>
  );
}

function MeshBody({
  servers,
  loading,
  statuses,
  machines,
  width,
}: TopologyProps & { width: number | null }) {
  const { t } = useI18n();
  if (loading) {
    return (
      <TopologyPending loading>
        <></>
      </TopologyPending>
    );
  }

  if (servers.length === 0) {
    return (
      <TopologyPending loading={false}>
        <ServerIcon className="text-muted-foreground size-6" />
        <div>
          <p className="text-foreground text-sm font-medium">{t('dashboard.noServers')}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t('dashboard.noServersHint')}</p>
        </div>
        <Button asChild size="sm" className="mt-1">
          <Link to="/mcp-servers">
            <PlusIcon className="size-4" /> {t('dashboard.addConnection')}
          </Link>
        </Button>
      </TopologyPending>
    );
  }

  // Too narrow to read the labels at their rendered size → the list renderer.
  if (width !== null && (width * LABEL_PX) / W < MIN_RENDERED_LABEL_PX) {
    return (
      <PlateTopology
        servers={servers}
        loading={loading}
        {...(statuses !== undefined ? { statuses } : {})}
        {...(machines !== undefined ? { machines } : {})}
      />
    );
  }

  const shownUp = servers.slice(0, MAX_NAMED_UPSTREAMS);
  const overflowUp = Math.max(0, servers.length - MAX_NAMED_UPSTREAMS);
  const fleet = machines ?? [];
  const shownMachines = fleet.slice(0, MAX_NAMED_MACHINES);
  const overflowMachines = Math.max(0, fleet.length - MAX_NAMED_MACHINES);
  const H = canvasH(shownUp.length, shownMachines.length);
  const HUB_Y = H / 2;

  // Spread each fan evenly across the vertical span, inset from the edges.
  const spread = (count: number): ((i: number) => number) => {
    const top = 34;
    const bottom = H - 34;
    if (count <= 1) return () => HUB_Y;
    const step = (bottom - top) / (count - 1);
    return (i: number) => top + i * step;
  };
  const upY = spread(shownUp.length);
  const machineY = spread(shownMachines.length);

  return (
    <MeshFrame
      upstreamCount={servers.length}
      machineCount={fleet.length}
      {...(statuses !== undefined ? { statuses } : {})}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ aspectRatio: `${W} / ${H}` }}
        role="img"
        aria-label={t('dashboard.meshAria', {
          count: servers.length + fleet.length,
        })}
      >
        {/* signal lines: upstreams -> nexus */}
        <g stroke="currentColor" strokeWidth="1.5" className="text-signal/45">
          {shownUp.map((s, i) => (
            <line key={`l-${s.id}`} x1={UPSTREAM_X} y1={upY(i)} x2={HUB_X - 16} y2={HUB_Y} />
          ))}
        </g>

        {/* upstream nodes — label sits right of the dot */}
        {shownUp.map((s, i) => {
          const y = upY(i);
          const variant = upstreamVariant(s.id, statuses);
          return (
            <g key={s.id}>
              <circle cx={UPSTREAM_X} cy={y} r={5} className={variantFill(variant)} />
              <text
                x={UPSTREAM_X + 16}
                y={y + 1}
                className="fill-foreground"
                fontSize="13"
                fontFamily="var(--app-font-mono)"
                dominantBaseline="middle"
              >
                {truncate(s.name, 20)}
              </text>
            </g>
          );
        })}

        {overflowUp > 0 && (
          <text
            x={UPSTREAM_X + 16}
            y={H - 14}
            className="fill-muted-foreground"
            fontSize="12"
            fontFamily="var(--app-font-mono)"
          >
            {t('dashboard.moreCount', { count: overflowUp })}
          </text>
        )}

        {/* the nexus node */}
        <circle cx={HUB_X} cy={HUB_Y} r={14} className="fill-signal" />
        <circle cx={HUB_X} cy={HUB_Y} r={14} fill="none" className="stroke-card" strokeWidth={1} />
        <text
          x={HUB_X}
          y={HUB_Y + 34}
          className="fill-foreground"
          fontSize="12"
          fontWeight={600}
          textAnchor="middle"
        >
          Harness Nexus
        </text>

        {/* signal lines: nexus -> machines */}
        <g stroke="currentColor" strokeWidth="1.5" className="text-signal/45">
          {shownMachines.map((m, i) => (
            <line key={`lm-${m.id}`} x1={HUB_X + 16} y1={HUB_Y} x2={MACHINE_X} y2={machineY(i)} />
          ))}
        </g>

        {/* machine nodes — label sits LEFT of the dot, agent count under it */}
        {shownMachines.map((m, i) => {
          const y = machineY(i);
          return (
            <g key={m.id}>
              <circle
                cx={MACHINE_X}
                cy={y}
                r={5}
                className={variantFill(m.online ? 'online' : 'configured')}
              />
              <text
                x={MACHINE_X - 16}
                y={y - 4}
                className="fill-foreground"
                fontSize="13"
                fontFamily="var(--app-font-mono)"
                textAnchor="end"
                dominantBaseline="middle"
              >
                {truncate(m.name, 18)}
              </text>
              <text
                x={MACHINE_X - 16}
                y={y + 13}
                className="fill-muted-foreground"
                fontSize="11"
                fontFamily="var(--app-font-mono)"
                textAnchor="end"
                dominantBaseline="middle"
              >
                {t(m.agentCount === 1 ? 'dashboard.agentOne' : 'dashboard.agentMany', {
                  count: m.agentCount,
                })}
              </text>
            </g>
          );
        })}

        {overflowMachines > 0 && (
          <text
            x={MACHINE_X - 16}
            y={H - 14}
            className="fill-muted-foreground"
            fontSize="12"
            fontFamily="var(--app-font-mono)"
            textAnchor="end"
          >
            {t('dashboard.moreMachines', { count: overflowMachines })}
          </text>
        )}

        {fleet.length === 0 && (
          <text
            x={MACHINE_X - 10}
            y={HUB_Y + 1}
            className="fill-muted-foreground"
            fontSize="12"
            textAnchor="end"
            dominantBaseline="middle"
          >
            {t('dashboard.noMachinesNode')}
          </text>
        )}
      </svg>
    </MeshFrame>
  );
}

/**
 * The measured width of the node the returned ref is attached to, and the ref
 * itself. A CALLBACK ref, not `useRef`: the effect version binds once, and any
 * branch that does not render the node on the first commit leaves it bound to
 * nothing (`null`) forever — which is how the first attempt stayed on the SVG.
 */
function useMeasuredWidth(): [RefCallback<HTMLDivElement | null>, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback<RefCallback<HTMLDivElement | null>>((el) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el === null) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}
