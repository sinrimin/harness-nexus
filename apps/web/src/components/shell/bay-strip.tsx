import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { groupLanding, visibleGroups, type NavGroupId } from '@/nav';
import { cn } from '@/lib/utils';

/**
 * The mobile bay strip (01-skeleton.md §6) — the spine, lying down.
 *
 * Sections as a horizontal, non-wrapping, scrollable strip: the drawer still
 * carries the full navigation (entries, account, toggles), but the sections
 * themselves are one tap away instead of two. The active section keeps its 2px
 * underline; nothing here uses the accent as decoration.
 */
export function BayStrip({
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
      data-region="baystrip"
      aria-label={t('app.sectionsJump')}
      className={cn(
        'bg-sidebar text-sidebar-foreground flex shrink-0 items-stretch gap-0 overflow-x-auto border-b',
        'min-[900px]:hidden',
        className,
      )}
    >
      {groups.map((group) => {
        const landing = groupLanding(group.id, isAdmin);
        if (!landing) return null;
        const active = group.id === activeGroup;
        return (
          <Link
            key={group.id}
            to={landing.path}
            data-bay-number={group.number}
            data-state={active ? 'live' : 'inactive'}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex min-h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 py-1.5',
              active
                ? 'border-b-signal text-foreground'
                : 'text-muted-foreground border-b-transparent',
            )}
          >
            <span className="role-label-sm nums">{group.number}</span>
            {group.labelKey !== undefined ? (
              <span className="role-label-sm">{t(group.labelKey)}</span>
            ) : (
              <span className="role-label-sm">{t(landing.titleKey)}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
