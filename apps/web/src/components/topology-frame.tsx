import type { ReactNode } from 'react';
import type { McpServerStatus } from '@harness-nexus/sdk';
import { StateSignal, SIGNAL_FILL_CLASS, type SignalState } from '@/components/state-signal';
import { useI18n } from '@/i18n';

/**
 * The dashboard hero's shared parts (04-contract.md §3, topology registry).
 *
 * The frame — panel chrome, the title with its upstream count, and the legend —
 * belongs to the SIGNATURE, not to one renderer: a skin that swaps the picture
 * still gets the same documented states, and the legend is generated from the
 * same variant table every renderer draws from. That is what keeps "the diagram
 * never lies" true across renderers instead of true in one file.
 */
export type { McpServerStatus };
export type Upstream = { id: string; name: string };
export type FleetNode = { id: string; name: string; online: boolean; agentCount: number };

/** What every renderer receives. Nothing here is optional-but-fake: `statuses`
 *  absent means "no live report", which the legend states differently. */
export interface TopologyProps {
  servers: Upstream[];
  loading: boolean;
  statuses?: McpServerStatus[];
  machines?: FleetNode[];
}

/** The four upstream variants a live status resolves to. */
export type UpstreamVariant = 'configured' | 'pending' | 'online' | 'warn';

/** Map a live status to a variant. Absent/unknown status is `configured`. */
export function upstreamVariant(
  id: string,
  statuses: McpServerStatus[] | undefined,
): UpstreamVariant {
  if (!statuses) return 'configured';
  const s = statuses.find((x) => x.id === id);
  if (!s) return 'configured';
  if (s.status === 'connected') return 'online';
  if (s.status === 'connecting') return 'pending';
  if (s.status === 'error') return 'warn';
  return 'configured';
}

const VARIANT_STATE: Record<UpstreamVariant, SignalState> = {
  configured: 'configured',
  pending: 'inactive',
  online: 'online',
  warn: 'warn',
};

/** SVG fill class for a node circle, matching the Dot semantics. */
export function variantFill(variant: UpstreamVariant): string {
  return SIGNAL_FILL_CLASS[VARIANT_STATE[variant]];
}

/** The status dot for lists and legends — the shared device, never hand-rolled. */
export function Dot({ variant }: { variant: UpstreamVariant }) {
  return <StateSignal state={VARIANT_STATE[variant]} aria-hidden />;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * The frame: panel chrome + the mesh title + the legend. `children` is the
 * renderer's picture; `className` lets a renderer decide the body's height.
 */
export function MeshFrame({
  upstreamCount,
  machineCount,
  statuses,
  children,
}: {
  upstreamCount: number;
  machineCount: number;
  statuses?: McpServerStatus[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  const hasLive = statuses !== undefined;
  return (
    <div data-surface="mesh" className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="border-border flex items-center justify-between gap-4 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium">{t('dashboard.yourMesh')}</span>
          <span className="text-muted-foreground nums text-xs">
            {t(upstreamCount === 1 ? 'dashboard.upOne' : 'dashboard.upMany', {
              count: upstreamCount,
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
          <span className="text-muted-foreground/70 nums">{machineCount}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Loading and no-upstreams states, shared by every renderer. */
export function TopologyPending({ loading, children }: { loading: boolean; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div
      className="border-muted-foreground/20 bg-muted/30 flex h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center"
      role="status"
      aria-live="polite"
    >
      {loading ? (
        <span className="text-muted-foreground text-sm">{t('dashboard.loadingMesh')}</span>
      ) : (
        children
      )}
    </div>
  );
}
