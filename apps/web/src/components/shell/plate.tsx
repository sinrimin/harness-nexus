import { NavLink } from 'react-router-dom';
import type { Posture } from '@harness-nexus/sdk';
import { useI18n } from '@/i18n';
import { NAV_GROUPS, groupRoutes, type RouteId } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The plate (01-skeleton.md §3) — brand, sectioned navigation, account block.
 *
 * A nav entry's count comes from the same posture aggregate the topbar reads
 * (D2), so `Machines 5` and the readout's `5/5` can never disagree. Counts are
 * absent — not zero — while the aggregate is unknown, and a fraction is used
 * where the denominator carries the meaning (`0/1` mcp: one configured, none
 * connected).
 */
export function Plate({
  activeRouteId,
  isAdmin,
  posture,
  className,
}: {
  activeRouteId: RouteId | undefined;
  isAdmin: boolean;
  posture: Posture | null;
  className?: string;
}) {
  const { t } = useI18n();

  return (
    <nav
      data-region="nav"
      aria-label={t('app.primaryNav')}
      className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 py-3', className)}
    >
      {NAV_GROUPS.map((group) => {
        const routes = groupRoutes(group.id, isAdmin);
        if (routes.length === 0) return null;
        return (
          <div key={group.id} data-nav-group={group.id} className="flex flex-col">
            {group.plateHeading === true ? (
              <span
                data-nav-heading={group.id}
                className="role-label-sm text-muted-foreground px-2.5 pt-4 pb-1.5"
              >
                {group.label}
              </span>
            ) : (
              <span aria-hidden="true" className="pt-2" />
            )}
            {routes.map((route) => {
              const Icon = route.nav?.icon;
              const count = navCount(route.id, posture);
              const active = route.id === activeRouteId;
              return (
                <NavLink
                  key={route.id}
                  to={route.path}
                  end={route.nav?.end}
                  data-nav-group={group.id}
                  data-state={active ? 'live' : 'inactive'}
                  className={cn(
                    'flex min-h-7 items-center gap-2.5 rounded-(--radius-well) border-l-2 px-2.5 py-1.5 text-sm',
                    active
                      ? 'border-l-foreground bg-tray text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-tray/60 hover:text-foreground border-l-transparent font-medium',
                  )}
                >
                  {Icon !== undefined ? (
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    {t(route.navLabelKey ?? route.titleKey)}
                  </span>
                  {count !== null ? (
                    <span className="role-data-sm text-muted-foreground nums shrink-0">
                      {count}
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

/** Same figures as the readout strip — only where a count is honest. */
function navCount(routeId: RouteId, posture: Posture | null): string | null {
  if (posture === null) return null;
  switch (routeId) {
    case 'chat':
      return String(posture.channels);
    case 'machines':
      return String(posture.machines.total);
    case 'mcp':
      return `${posture.mcp.connected}/${posture.mcp.total}`;
    default:
      return null;
  }
}
