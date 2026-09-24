import type { Posture } from '@harness-nexus/sdk';
import { useI18n } from '@/i18n';
import { Lamp } from '@/components/kit';
import { cn } from '@/lib/utils';

/**
 * The readout strip (D2) — the always-on answer to "is this instance alive".
 *
 * Four figures, each rendered the same way: a lamp where the number has a
 * state, the count in tabular mono, the label in the nameplate face. Scope is
 * part of the number, not a footnote: an admin's fleet figure says `all`, and a
 * figure that stays owner-scoped inside an all-scope answer says `own` (chat is
 * private to its owner even from an admin — see server `modules/status.ts`).
 *
 * No data, no strip: a failed fetch renders nothing at all rather than zeros.
 */
export function ReadoutStrip({
  posture,
  className,
}: {
  posture: Posture | null;
  className?: string;
}) {
  const { t } = useI18n();
  if (posture === null) return null;

  const { machines, mcp, scopes } = posture;
  // Presence earns the lamp: every machine online, none, or a mix.
  const machineLamp =
    machines.total === 0 ? 'inactive' : machines.online === machines.total ? 'online' : 'warn';
  const machineWord =
    machines.total === 0
      ? undefined
      : machines.online === machines.total
        ? undefined
        : t('machines.offlineCount', { count: machines.total - machines.online });

  return (
    <div
      data-region="watchbar"
      role="group"
      aria-label={t('app.readoutAria')}
      className={cn(
        'hidden h-(--shell-subbar-h) min-w-0 items-center gap-3.5 border-b px-[18px]',
        'min-[900px]:flex',
        className,
      )}
    >
      <Figure
        lamp={machineLamp}
        word={machineWord}
        value={machines.online}
        total={machines.total}
        label={t('app.readoutMachines')}
        /* The fleet figure is the caller's own until they are an admin — then
           the page-level `all` marker already says so. */
        scope={undefined}
      />
      <Figure
        lamp={mcp.total === 0 ? 'inactive' : mcp.connected === mcp.total ? 'connected' : 'warn'}
        value={mcp.connected}
        total={mcp.total}
        label={t('app.readoutMcp')}
      />
      <Figure value={posture.queuedJobs} label={t('app.readoutQueued')} />
      <Figure
        value={posture.channels}
        label={t('app.readoutChannels')}
        /* Owner-only even for admins: inside an all-scope strip this figure
           must say which rows it counted. */
        scope={posture.scope === 'all' && scopes.channels === 'self' ? 'self' : undefined}
      />
      {posture.scope === 'all' ? (
        <span
          className="role-label-sm text-muted-foreground ml-0.5 border-l pl-3"
          title={t('app.readoutAllHint')}
        >
          {t('app.readoutAll')}
        </span>
      ) : null}
    </div>
  );
}

function Figure({
  value,
  total,
  label,
  lamp,
  word,
  scope,
}: {
  value: number;
  total?: number;
  label: string;
  lamp?: 'online' | 'connected' | 'warn' | 'inactive';
  word?: string;
  scope?: 'self';
}) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-1.5" title={word}>
      {lamp !== undefined ? <Lamp state={lamp} size="sm" /> : null}
      <span className="flex items-baseline gap-0.5">
        <span className="role-data-sm text-foreground">{value}</span>
        {total !== undefined ? (
          <span className="role-data-sm text-muted-foreground">/{total}</span>
        ) : null}
      </span>
      <span className="role-label-sm text-muted-foreground">{label}</span>
      {scope !== undefined ? (
        <span
          className="role-label-sm text-muted-foreground/80 border-l pl-1.5"
          title={t('app.readoutOwnHint')}
        >
          {t('app.readoutOwn')}
        </span>
      ) : null}
    </span>
  );
}
