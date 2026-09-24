import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth';
import { useI18n } from '@/i18n';
import { Brand } from '@/components/brand-mark';
import { MobileNav } from '@/components/mobile-nav';
import { UserBlock } from '@/components/user-block';
import { Plate } from '@/components/shell/plate';
import { Spine } from '@/components/shell/spine';
import { Topbar } from '@/components/shell/topbar';
import { BayStrip } from '@/components/shell/bay-strip';
import { ReadoutStrip } from '@/components/shell/readout-strip';
import { PageSlotsProvider, usePageSlots } from '@/components/shell/page-slots';
import { usePosture } from '@/components/shell/use-posture';
import { matchRoute } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The console shell (01-skeleton.md §1).
 *
 * Three columns on desktop — spine (72px, the numbered section address) +
 * plate (168px, entries and counts) + content — and a full-width topbar. The
 * two left columns together are exactly the 240px the old `w-60` sidebar used,
 * so the upgrade costs no content width; below 900px the plate folds into the
 * drawer and the spine lies down into the bay strip.
 *
 * Everything the shell needs about the current page comes from the route
 * manifest (`nav.ts`) — the nav list, the breadcrumb trail, the title, and
 * whether the page owns its own scrolling. `PageSlotsProvider` is how a page
 * puts buttons and a dynamic title in the chrome.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const isAdmin = user?.role === 'admin';
  const route = matchRoute(location.pathname);
  const { posture } = usePosture();
  const { value: slots, ref } = usePageSlots();
  // `panes` hands scrolling to the page (chat: rail + stream + composer);
  // `flow` is the default content frame.
  const panes = route?.layout === 'panes';

  return (
    <div className="bg-background text-foreground relative flex h-svh flex-col overflow-hidden">
      {/* Skip link — first focusable element, jumps to the content frame. */}
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        {t('app.skipToContent')}
      </a>

      <Topbar
        route={route}
        isAdmin={isAdmin}
        titleRef={ref('title')}
        actionsRef={ref('actions')}
        titleClaimed={slots.claims.title === true}
        leading={
          <MobileNav>
            <Plate
              activeRouteId={route?.id}
              isAdmin={isAdmin}
              posture={posture}
              className="px-0 py-0"
            />
          </MobileNav>
        }
      />

      <div className="flex min-h-0 flex-1">
        <Spine activeGroup={route?.group ?? 'nav'} isAdmin={isAdmin} />

        {/* Plate (desktop ≥900) — brand, entries with counts, account block. */}
        <aside
          data-region="plate"
          className="bg-sidebar text-sidebar-foreground hidden w-(--plate-w) shrink-0 flex-col overflow-hidden border-r min-[900px]:flex"
        >
          <div
            data-region="brand"
            className="flex h-(--shell-subbar-h) shrink-0 items-center border-b px-4"
          >
            <Link to="/" aria-label={t('app.brandHome')}>
              <Brand size={20} />
            </Link>
          </div>
          <Plate activeRouteId={route?.id} isAdmin={isAdmin} posture={posture} />
          <div className="shrink-0 p-2.5">
            <UserBlock />
          </div>
        </aside>

        {/* Content column — the only column that scrolls (or, for `panes`
            pages, the column that holds panes which scroll themselves). */}
        <div className="flex min-w-0 flex-1 flex-col">
          <BayStrip activeGroup={route?.group ?? 'nav'} isAdmin={isAdmin} />
          {/* Readout strip: its own band so the topbar is not asked to hold a
              page identity AND four figures AND the toggles in 56px. */}
          <ReadoutStrip posture={posture} />
          <main
            id="main"
            data-region="main"
            className={cn('min-h-0 flex-1', panes ? 'overflow-hidden' : 'overflow-y-auto')}
          >
            <div
              className={cn(
                panes
                  ? 'flex h-full min-h-0 flex-col'
                  : 'w-full px-[18px] pt-[18px] pb-11 max-[640px]:px-0 max-[640px]:pt-4',
              )}
            >
              <PageSlotsProvider value={slots}>{children}</PageSlotsProvider>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
