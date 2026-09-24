import { memo, useState } from 'react';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ListTodoIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import type { PlanEntry } from '@/realtime';

/**
 * The todo/plan strip (9 W14) — the agent's ACP `plan` snapshot rendered
 * above the composer. Full-replace semantics: this is SESSION STATE (the
 * fold's `plan` slice), not a transcript row — every ACP plan event carries
 * the complete list, so the panel always shows the agent's current todo
 * list and a resumed session replays to its final snapshot. Hidden when
 * empty; collapsed by default (portal-reference shape, Signal-styled).
 */

/** One entry's status glyph: done check (--ok), live ring (--warn), dashed pending. */
function StatusGlyph({ status }: { status: PlanEntry['status'] }) {
  if (status === 'completed') {
    return (
      <span className="border-ok text-ok mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border">
        <CheckIcon className="size-2" strokeWidth={3} />
      </span>
    );
  }
  if (status === 'in_progress') {
    // A step that is running right now: the same breathing motion as every
    // other live thing (03-interaction.md §6 has exactly four motions).
    return <span className="lamp-breath mt-0.5 size-3.5 shrink-0 rounded-full bg-warn" />;
  }
  return (
    <span className="border-muted-foreground/50 mt-0.5 size-3.5 shrink-0 rounded-full border border-dashed" />
  );
}

export const TodoPanel = memo(function TodoPanel({ entries }: { entries: PlanEntry[] }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(true);
  if (entries.length === 0) return null;

  const done = entries.filter((e) => e.status === 'completed').length;
  const active = entries.filter((e) => e.status === 'in_progress').length;
  const pending = entries.length - done - active;
  const summary = [
    ...(done > 0 ? [t('chat.todoDone', { count: done })] : []),
    ...(active > 0 ? [t('chat.todoActive', { count: active })] : []),
    ...(pending > 0 ? [t('chat.todoPending', { count: pending })] : []),
  ].join(' · ');

  return (
    <section
      className="bg-muted/40 mb-2 overflow-hidden rounded-xl border"
      aria-label={t('chat.todoTitle')}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
        className="hover:bg-accent/40 flex h-8 w-full items-center gap-2 px-3 text-left text-xs"
      >
        <ListTodoIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground shrink-0 font-medium">{t('chat.todoTitle')}</span>
        <span className="text-muted-foreground/80 font-mono text-[10px] tabular-nums">
          {summary}
        </span>
        <span className="min-w-0 flex-1" />
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {done}/{entries.length}
        </span>
        {collapsed ? (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
      </button>
      {!collapsed ? (
        <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto border-t px-3 py-2 text-xs">
          {entries.map((entry, i) => (
            <li
              key={`${i}:${entry.content}`}
              className="flex items-start gap-2"
              data-status={entry.status}
            >
              <StatusGlyph status={entry.status} />
              <span
                className={cn(
                  'min-w-0 truncate',
                  entry.status === 'completed' && 'text-muted-foreground line-through',
                  entry.priority === 'high' && entry.status !== 'completed' && 'font-medium',
                )}
                title={entry.content}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
});
