import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { LabelText } from '@/components/kit';
import { LanguageToggle } from '@/components/language-toggle';
import { SkinToggle } from '@/components/skin-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { NAV_GROUPS, groupLanding, routeTrail, type RouteDef } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The topbar (01-skeleton.md §4) — where the page identity and its actions live.
 *
 * Identity form: the trail opens with the `▸` accent (its one permitted
 * decorative use) and lists the SECTION, then any ancestor page, then the page
 * itself as the `<h1>`. Ancestors link; the section crumb is dropped when the
 * only ancestor is the section's own landing page (no duplicate targets).
 * Expected names come from the route manifest; a page with a dynamic name (a
 * machine, a session) portals its own content into the title slot — see
 * `PageSlot` for why the slot is a DOM node rather than a context value.
 */
export function Topbar({
  route,
  isAdmin,
  title,
  actionsRef,
  titleClaimed,
  leading,
  className,
}: {
  route: RouteDef | undefined;
  isAdmin: boolean;
  /** A page's own title (it may not exist yet — the route title stands in). */
  title: string | null;
  actionsRef: (el: HTMLElement | null) => void;
  /** A page claimed the title — the route-derived fallback is dropped. */
  titleClaimed: boolean;
  leading?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const trail = route !== undefined ? routeTrail(route) : [];
  const group = NAV_GROUPS.find((g) => g.id === route?.group);
  const landing = route !== undefined ? groupLanding(route.group, isAdmin) : undefined;

  // Section nameplate → the section's first page. Dropped when the only
  // ancestor IS that page (then the ancestor link says the same thing).
  const ancestors = trail.slice(0, -1).filter((r) => r.id !== landing?.id);
  const sectionCrumb =
    group?.labelKey !== undefined && landing !== undefined && landing.id !== ancestors[0]?.id
      ? { label: t(group.labelKey), to: landing.path }
      : undefined;

  return (
    <header
      data-region="header"
      className={cn(
        'bg-background/95 supports-[backdrop-filter]:bg-background/75 flex h-(--shell-bar-h-sm) shrink-0 items-center gap-3 border-b px-3 backdrop-blur',
        'min-[640px]:h-(--shell-bar-h) min-[640px]:px-[18px]',
        className,
      )}
    >
      {leading}

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {/* The `▸` accent leads the identity everywhere; below 640 the bay
            strip names the section one row down, so only the crumb CHAIN folds
            away and the page title keeps the line. The `<h1>` and the actions
            seat render ALWAYS, even before a route resolves: they are portal
            targets, and a target that can vanish under a mounted portal is how
            this shell broke once (see `page-slots.tsx`). */}
        <span aria-hidden="true" className="text-signal role-label-sm shrink-0">
          ▸
        </span>
        <nav
          aria-label="Breadcrumb"
          data-slot="breadcrumb"
          className="hidden shrink-0 items-center gap-1.5 min-[640px]:flex"
        >
          {sectionCrumb !== undefined ? (
            <Crumb to={sectionCrumb.to} label={sectionCrumb.label} />
          ) : null}
          {ancestors.map((ancestor) => (
            <Crumb key={ancestor.id} to={ancestor.path} label={t(ancestor.titleKey)} />
          ))}
        </nav>
        <h1
          data-slot="page-title"
          className="text-foreground min-w-0 truncate font-semibold tracking-[-0.015em] text-(length:--shell-title-size)"
        >
          {/* One writer, one text child: the page's title wins, the route
              metadata is the fallback. */}
          {titleClaimed && title !== null
            ? title
            : trail.length > 0
              ? t(trail[trail.length - 1]!.titleKey)
              : null}
        </h1>
      </div>

      {/* Page actions portal here (PageSlot slot="actions") — the page owns the
          buttons, the chrome only owns the seat. */}
      <div ref={actionsRef} data-slot="page-actions" className="flex shrink-0 items-center gap-2" />

      <div className="flex shrink-0 items-center gap-0.5 border-l pl-1.5">
        <LanguageToggle />
        <SkinToggle />
        <ThemeToggle />
      </div>
    </header>
  );
}

/** Ancestor link + the `/` that separates it from what follows. */
function Crumb({ to, label }: { to: string; label: string }) {
  return (
    <>
      <Link to={to} className="text-muted-foreground hover:text-foreground shrink-0">
        <LabelText size="sm">{label}</LabelText>
      </Link>
      <span aria-hidden="true" className="text-border role-label-sm shrink-0">
        /
      </span>
    </>
  );
}
