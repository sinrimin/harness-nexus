import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { NAV_GROUPS, groupRoutes, type RouteId } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The mobile nav strip (01-skeleton.md §6) — every destination, one tap.
 *
 * What it replaces (`shell/bay-strip.tsx`, retired) carried the five BAYS: a tap
 * landed on a section's first page and nowhere else, so reaching an interior
 * page was still a drawer trip ("切换非常麻烦"). Carrying only the bays was the
 * mistake. The strip keeps its dress — numbered, hairline-separated, the
 * current one underlined in the accent, non-wrapping horizontal scroll — and
 * now carries the whole map: a browser's bookmarks row, not a table of
 * contents. Reported as "改为显示所有菜单项（用原分类菜单的样式）".
 *
 * The section address stays on every item: `03 技能`, `03 子代理` — the bays are
 * how this app names places (the desktop spine's `01`…`05`), and the numbers
 * tell you where one section ends and the next begins without a second label
 * row. The strip scrolls the CURRENT item into view, so what you see first is
 * the neighbourhood you are standing in rather than the first bay.
 *
 * Below 900px only: above that the plate lists everything already. The drawer
 * stays too — it is the one surface that also carries the account block.
 */
export function NavStrip({
  activeRouteId,
  isAdmin,
  className,
}: {
  activeRouteId: RouteId | undefined;
  isAdmin: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    // `block: 'nearest'` so centring the item sideways never scrolls the page
    // itself — on a phone the strip is the topmost band of a scrolling page.
    activeRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [activeRouteId]);

  return (
    <nav
      data-region="navstrip"
      aria-label={t('app.jumpToPage')}
      className={cn(
        'bg-sidebar text-sidebar-foreground flex shrink-0 items-stretch gap-0 overflow-x-auto border-b',
        'min-[900px]:hidden',
        className,
      )}
    >
      {NAV_GROUPS.map((group) => {
        const routes = groupRoutes(group.id, isAdmin);
        if (routes.length === 0) return null;
        return routes.map((route) => {
          const active = route.id === activeRouteId;
          return (
            <Link
              key={route.id}
              ref={active ? activeRef : undefined}
              to={route.path}
              data-nav-group={group.id}
              data-bay-number={group.number}
              data-state={active ? 'live' : 'inactive'}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5',
                active
                  ? 'border-b-signal text-foreground'
                  : 'text-muted-foreground border-b-transparent',
              )}
            >
              {/* The address is dimmer than the name: it says WHERE, the name
                  says what — fifteen items read as a list of pages, not as a
                  column of numbers. */}
              <span className="role-label-sm nums opacity-70">{group.number}</span>
              <span className="role-label-sm">{t(route.navLabelKey ?? route.titleKey)}</span>
            </Link>
          );
        });
      })}
    </nav>
  );
}