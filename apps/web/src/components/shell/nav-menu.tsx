import { useNavigate } from 'react-router-dom';
import { ChevronDownIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { NAV_GROUPS, groupRoutes, type RouteId } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The section menu (#23) — what the phone carries instead of the bay strip.
 *
 * The strip (shell/bay-strip.tsx, retired) was five BAYS: a tap landed you on a
 * section's first page and nowhere else, so getting from one interior page to
 * another meant opening the drawer and reading a list — reported from a phone as
 * "顶部显示为菜单，而不是分类，不然切换非常麻烦". The menu is the whole map
 * instead: every destination the viewer may reach, grouped under the same
 * engraved bay names the desktop spine carries, one tap from anywhere to
 * anywhere — and the row the strip occupied goes back to the content.
 *
 * Rendered only where the plate is hidden (<900px): above that the plate already
 * lists every entry, and the same list twice in one bar is noise. The entries
 * come from the route manifest, so this can never disagree with the plate about
 * what exists, what it is called, or who may see it.
 */
export function NavMenu({
  activeRouteId,
  isAdmin,
  className,
}: {
  activeRouteId: RouteId | undefined;
  isAdmin: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-nav-menu="trigger"
          className={cn('size-6 shrink-0', className)}
          title={t('app.openNavMenu')}
          aria-label={t('app.openNavMenu')}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      {/* `align="start"` keeps the list under the page identity rather than
          centred on a 24px caret; the height cap is the phone's, where the
          keyboard is not the only thing eating the viewport. */}
      <DropdownMenuContent align="start" className="max-h-[70svh] w-60 overflow-y-auto">
        {NAV_GROUPS.map((group) => {
          const routes = groupRoutes(group.id, isAdmin);
          if (routes.length === 0) return null;
          return (
            <div key={group.id} data-nav-group={group.id}>
              {/* `role-label-sm` + the manifest's English label: the menu's
                  headings are the same engravings the spine shows, so a section
                  has ONE name on every surface. */}
              <DropdownMenuLabel className="role-label-sm text-muted-foreground flex items-center gap-1.5 px-2 pt-2 pb-1">
                <span className="nums">{group.number}</span>
                <span>{group.label}</span>
              </DropdownMenuLabel>
              {routes.map((route) => {
                const Icon = route.nav?.icon;
                const active = route.id === activeRouteId;
                return (
                  <DropdownMenuItem
                    key={route.id}
                    data-state={active ? 'live' : 'inactive'}
                    aria-current={active ? 'page' : undefined}
                    onSelect={() => navigate(route.path)}
                    className={cn('gap-2.5', active && 'text-foreground font-semibold')}
                  >
                    {Icon !== undefined ? (
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {t(route.navLabelKey ?? route.titleKey)}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}