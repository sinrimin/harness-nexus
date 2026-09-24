import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import {
  Dot,
  MeshFrame,
  truncate,
  upstreamVariant,
  type FleetNode,
  type TopologyProps,
} from './topology-frame.js';

/**
 * The `plate` topology — the same mesh as a two-column list (04-contract.md §3).
 *
 * Two reasons it is real rather than a placeholder. First, a phone: the
 * constellation's labels are SVG text in viewBox units, so at 390px they render
 * around 6.7px and the picture stops being readable — `mesh-topology.tsx`
 * measures its container and hands over to this renderer below the legible
 * floor. Second, P7's flexibility drill needs a second renderer a skin can
 * actually select, or `topology` is a decorative field.
 *
 * It shows the same facts with the same states: upstreams on the left (live
 * variant when a status report exists), the hub in the middle, machines on the
 * right with their agent counts. Overflow is named, never dropped.
 */
export function PlateTopology({ servers, statuses, machines }: TopologyProps) {
  const { t } = useI18n();
  const fleet = machines ?? [];
  const connected = statuses?.filter((s) => s.status === 'connected').length;
  const online = fleet.filter((m) => m.online).length;

  return (
    <MeshFrame
      upstreamCount={servers.length}
      machineCount={fleet.length}
      {...(statuses !== undefined ? { statuses } : {})}
    >
      <div className="grid gap-0 sm:grid-cols-2">
        <PlateSide
          heading={t('dashboard.upstreamSide')}
          figure={
            connected === undefined
              ? undefined
              : t('dashboard.connectedFigure', { count: connected, total: servers.length })
          }
        >
          {servers.map((s) => (
            <PlateRow
              key={s.id}
              variant={upstreamVariant(s.id, statuses)}
              name={s.name}
              meta={null}
            />
          ))}
        </PlateSide>
        <PlateSide
          heading={t('dashboard.fleetSide')}
          figure={t('dashboard.onlineFigure', { count: online, total: fleet.length })}
          className="border-border sm:border-l"
        >
          {fleet.length === 0 ? (
            <p className="text-muted-foreground px-4 py-3 text-xs">
              {t('dashboard.noMachinesNode')}
            </p>
          ) : (
            fleet.map((m: FleetNode) => (
              <PlateRow
                key={m.id}
                variant={m.online ? 'online' : 'configured'}
                name={m.name}
                to={`/machines/${m.id}`}
                meta={t(m.agentCount === 1 ? 'dashboard.agentOne' : 'dashboard.agentMany', {
                  count: m.agentCount,
                })}
              />
            ))
          )}
        </PlateSide>
      </div>
    </MeshFrame>
  );
}

function PlateSide({
  heading,
  figure,
  className,
  children,
}: {
  heading: string;
  figure?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`min-w-0 ${className ?? ''}`}>
      <header className="border-border flex items-center gap-2 border-b px-4 py-1.5">
        <span className="role-label-sm text-muted-foreground">{heading}</span>
        {figure !== undefined ? (
          <span className="text-muted-foreground nums ml-auto text-[11px]">{figure}</span>
        ) : null}
      </header>
      <div className="max-h-64 overflow-y-auto">{children}</div>
    </section>
  );
}

function PlateRow({
  variant,
  name,
  meta,
  to,
}: {
  variant: 'configured' | 'pending' | 'online' | 'warn';
  name: string;
  meta: string | null;
  to?: string;
}) {
  const body = (
    <>
      <Dot variant={variant} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{truncate(name, 40)}</span>
      {meta !== null ? (
        <span className="text-muted-foreground nums shrink-0 text-[11px]">{meta}</span>
      ) : null}
    </>
  );
  if (to !== undefined && variant === 'online') {
    return (
      <Link
        to={to}
        className="hover:bg-muted/40 flex items-center gap-2 px-4 py-1.5 transition-colors"
      >
        {body}
      </Link>
    );
  }
  return <div className="flex items-center gap-2 px-4 py-1.5">{body}</div>;
}
