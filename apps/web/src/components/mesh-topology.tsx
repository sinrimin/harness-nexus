import { Link } from 'react-router-dom';
import { ServerIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StateSignal, SIGNAL_FILL_CLASS, type SignalState } from '@/components/state-signal';
import { useI18n } from '@/i18n';

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
 */

import type { McpServerStatus } from '@harness-nexus/sdk';

type Upstream = { id: string; name: string };
export type FleetNode = { id: string; name: string; online: boolean; agentCount: number };

/** Map a live status to a Dot variant for rendering. */
function dotVariantFor(
  id: string,
  statuses: McpServerStatus[] | undefined,
): 'configured' | 'pending' | 'online' | 'warn' {
  if (!statuses) return 'configured';
  const s = statuses.find((x) => x.id === id);
  if (!s) return 'configured';
  if (s.status === 'connected') return 'online';
  if (s.status === 'connecting') return 'pending';
  if (s.status === 'error') return 'warn';
  return 'configured';
}

const MAX_NAMED_UPSTREAMS = 4;
const MAX_NAMED_MACHINES = 5;
// Geometric constants hoisted out of render (static across renders).
const W = 760;
const HUB_X = W / 2;
const UPSTREAM_X = 70;
const MACHINE_X = W - 78;
/** Canvas height follows the tallest fan — sparse fleets get a compact card
 *  instead of a single row floating in 300px of dead whitespace. */
const canvasH = (upCount: number, machineCount: number): number =>
  Math.min(300, Math.max(176, 88 + Math.max(upCount, machineCount) * 48));

export function MeshTopology({
  servers,
  loading,
  statuses,
  machines,
}: {
  servers: Upstream[];
  loading: boolean;
  statuses?: McpServerStatus[];
  machines?: FleetNode[];
}) {
  const { t } = useI18n();
  const shownUp = servers.slice(0, MAX_NAMED_UPSTREAMS);
  const overflowUp = Math.max(0, servers.length - MAX_NAMED_UPSTREAMS);
  const fleet = machines ?? [];
  const shownMachines = fleet.slice(0, MAX_NAMED_MACHINES);
  const overflowMachines = Math.max(0, fleet.length - MAX_NAMED_MACHINES);
  const hasLive = !!statuses;
  const H = canvasH(shownUp.length, shownMachines.length);
  const HUB_Y = H / 2;

  if (loading) {
    return (
      <div
        className="border-muted-foreground/20 bg-muted/30 flex h-[240px] items-center justify-center rounded-xl border border-dashed"
        role="status"
        aria-live="polite"
      >
        <span className="text-muted-foreground text-sm">{t('dashboard.loadingMesh')}</span>
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="border-muted-foreground/20 bg-muted/30 flex h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center">
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
      </div>
    );
  }

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
    <div
      data-surface="mesh"
      className="border-border bg-card overflow-hidden rounded-xl border"
    >
      <div className="border-border flex items-center justify-between gap-4 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium">{t('dashboard.yourMesh')}</span>
          <span className="text-muted-foreground text-xs nums">
            {t(servers.length === 1 ? 'dashboard.upOne' : 'dashboard.upMany', {
              count: servers.length,
            })}
          </span>
        </div>
        {/* Legend — documents the live states on both sides of the hub. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {hasLive ? (
            <>
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Dot variant="online" /> {t('dashboard.legendConnected')}
              </span>
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Dot variant="warn" /> {t('dashboard.legendError')}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Dot variant="configured" /> {t('dashboard.legendConfigured')}
            </span>
          )}
          <span className="bg-border mx-1 inline-block h-3 w-px" aria-hidden="true" />
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Dot variant="online" /> {t('dashboard.legendOnline')}
          </span>
          <span className="text-muted-foreground flex items-center gap-1.5">
            <Dot variant="configured" /> {t('dashboard.legendOffline')}
          </span>
        </div>
      </div>
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
          const variant = dotVariantFor(s.id, statuses);
          return (
            <g key={s.id}>
              <circle cx={UPSTREAM_X} cy={y} r={5} className={nodeFill(variant)} />
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
                className={SIGNAL_FILL_CLASS[m.online ? 'online' : 'offline']}
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
    </div>
  );
}

/**
 * Status dot for the legend — a thin wrapper over the shared StateSignal so
 * the topology's states stay skin-addressable like every other dot.
 * `configured`/`pending` are muted; `online` carries the live `--ok` accent;
 * `warn` signals a connection error.
 */
const DOT_VARIANT_STATE: Record<'configured' | 'pending' | 'online' | 'warn', SignalState> = {
  configured: 'configured',
  pending: 'inactive',
  online: 'online',
  warn: 'warn',
};

function Dot({ variant }: { variant: 'configured' | 'pending' | 'online' | 'warn' }) {
  return <StateSignal state={DOT_VARIANT_STATE[variant]} aria-hidden />;
}

/** SVG fill class for an upstream node circle, matching the Dot semantics. */
function nodeFill(variant: 'configured' | 'pending' | 'online' | 'warn'): string {
  return SIGNAL_FILL_CLASS[DOT_VARIANT_STATE[variant]];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
