import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { ResourcesPage } from '@/pages/Resources';
import { SkillHubPanel } from '@/pages/SkillHub';

/**
 * Skills (#23 P2, README §5.3/§5.4) — one page, two tabs.
 *
 * "My skills" is the skill-kind resource list; "Skill hub" is the market /
 * multi-source search. They belong on one page because the hub *produces*
 * skill resources: saving used to drop you somewhere else to look at the
 * result. The tab is a URL parameter (`?tab=hub`), so a hub link is shareable
 * and a browser back returns to the list — the old page kept this in local
 * state, which a refresh threw away.
 *
 * P4 turns this into the kind page proper (bundle columns, the file-tree
 * editor, the hub's trust badges); the split is already in the right place.
 */
export function SkillsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'hub' ? 'hub' : 'mine';
  // `?highlight=` is not a list parameter — it is this page's "look here"
  // pointer, set by the hub's save and read by the list (09 §5). The list's
  // own vocabulary (q/scope/sort) never touches it, and `clear()` only removes
  // what the list declared.
  const highlight = params.get('highlight');

  const select = (next: 'mine' | 'hub'): void => {
    const params2 = new URLSearchParams(params);
    if (next === 'mine') params2.delete('tab');
    else params2.set('tab', 'hub');
    setParams(params2, { replace: true });
  };

  /** The hub saved a skill: show it where it now lives. */
  const revealSaved = (key: string): void => {
    const params2 = new URLSearchParams(params);
    params2.delete('tab');
    params2.set('highlight', key);
    setParams(params2, { replace: true });
    // The toast belongs to the page you end up on, not the one you left.
    toast.success(t('skillHub.savedToast'));
  };

  return (
    <>
      <div
        role="tablist"
        aria-label={t('app.navSkills')}
        /* Same slots as the kit's Radix tabs: a skin styles the section tab
           strip once, whether it is this hand-rolled one or `ui/tabs`. */
        data-slot="tabs-list"
        className="mb-(--gap) flex items-center gap-1 border-b"
      >
        <TabButton active={tab === 'mine'} onClick={() => select('mine')}>
          {t('resources.tabMine')}
        </TabButton>
        <TabButton active={tab === 'hub'} onClick={() => select('hub')}>
          {t('skillHub.tabHub')}
        </TabButton>
      </div>

      {tab === 'mine' ? (
        <ResourcesPage
          fixedKind="skill"
          {...(highlight !== null ? { highlightKey: highlight } : {})}
        />
      ) : (
        <SkillHubPanel onSavedSkill={revealSaved} />
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-slot="tabs-trigger"
        data-state={active ? 'live' : 'inactive'}
        onClick={onClick}
        className={cn(
          'role-label -mb-px border-b-2 px-3 py-2',
          active
            ? 'border-b-signal text-foreground'
            : 'text-muted-foreground hover:text-foreground border-b-transparent',
        )}
      >
        {children}
      </button>
    </>
  );
}
