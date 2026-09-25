import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { Lamp } from '@/components/kit';
import { groupLanding, visibleGroups, type NavGroupId } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The spine (01-skeleton.md §2) — the numbered section address column.
 *
 * Numbers are addresses, not counters: `01`…`05` come from the nav manifest, so
 * hiding a section (ADMIN for a non-admin) never renumbers anything. That is
 * why BAY's CSS `content: '01\A NAV'` had to go — it could not know the list.
 *
 * Narrow (#23, reported from a phone): 72px of column for two or three glyphs
 * was mostly air, so the bay runs SIDEWAYS now — the address stays legible
 * across (`01`), the engraved name reads down (`ACCESS`), and the strip costs
 * `--spine-w`. The name is the manifest's English label, never the translated
 * one: a bay is an address, and the same rail has to read the same in both
 * locales.
 *
 * Desktop only (≥900px): below that the plate hides too, and the sections move
 * into the topbar's nav menu + drawer.
 */
export function Spine({
  activeGroup,
  isAdmin,
  className,
}: {
  activeGroup: NavGroupId;
  isAdmin: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const groups = visibleGroups(isAdmin);

  return (
    <nav
      data-region="spine"
      aria-label={t('app.primaryNav')}
      className={cn(
        'bg-sidebar text-sidebar-foreground flex w-(--spine-w) shrink-0 flex-col border-r',
        className,
      )}
    >
      {/* Head band — shares the topbar's height so the spine starts at the
          very top of the window and the bays line up under it
          (theme-designs/01-bay: `.spine-head`). Deliberately EMPTY: the brand
          lives once, in the plate (mark + wordmark), and two marks side by side
          is just a double logo. BAY engraves its 「HN / RACK 6U」 plate here in
          P7 — the slot exists so the skin can, without touching the layout. */}
      <div data-slot="spine-head" className="h-(--shell-bar-h) shrink-0 border-b" />
      {groups.map((group) => {
        const landing = groupLanding(group.id, isAdmin);
        if (!landing) return null;
        const active = group.id === activeGroup;
        return (
          <Link
            key={group.id}
            to={landing.path}
            data-bay-number={group.number}
            data-tone={active ? 'live' : 'none'}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'relative flex min-h-(--bay-h) shrink-0 flex-col items-center justify-center gap-2 border-b px-1 py-3',
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50',
            )}
          >
            {/* The live bay keeps its 3px accent edge — one of the four places
                the accent is allowed to appear on a screen. */}
            {active ? (
              <span aria-hidden="true" className="bg-signal absolute inset-y-0 left-0 w-[3px]" />
            ) : null}
            <span className="flex items-center gap-1">
              <span className="role-label-sm nums">{group.number}</span>
              {/* The live bay is lit — one of the four places the accent may
                  appear, and the reason the plate's active item is ink, not
                  accent: one screen, one colour. Beside the address rather
                  than under the name: sideways there is no under. */}
              {active ? <Lamp state="live" size="sm" label={t(landing.titleKey)} /> : null}
            </span>
            <span
              className={cn(
                'role-label-sm role-label-vertical',
                active && 'text-foreground font-bold',
              )}
            >
              {group.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}