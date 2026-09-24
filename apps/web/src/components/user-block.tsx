import { LogOutIcon } from 'lucide-react';
import { useAuth } from '@/auth';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { LabelText } from '@/components/kit';

/**
 * Account block — the plate's foot on desktop, the drawer's foot on mobile.
 *
 * Initials in mono on the neutral step (colour encodes connection state, never
 * identity), name over role, sign-out as the block's trailing action. It wears
 * the well material (`bg-well` + `border-well-edge`) rather than nesting the
 * well primitive: the primitive owns a value/affordance layout this block does
 * not have, and one surface is a class contract, not a component.
 */
export function UserBlock() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const name = user?.username ?? '';

  return (
    <div
      data-region="signed-in"
      data-surface="well"
      className="bg-well border-well-edge flex items-center gap-2.5 rounded-(--radius-well) border p-2"
    >
      <span
        aria-hidden="true"
        className="bg-tray text-well-ink flex size-7 shrink-0 items-center justify-center rounded-(--radius-well) font-mono text-xs font-semibold uppercase"
      >
        {name.slice(0, 2) || '?'}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="text-well-ink block truncate text-sm font-semibold">{name}</span>
        <LabelText as="span" size="sm" className="text-well-dim block pt-0.5">
          {isAdmin ? t('common.roleAdmin') : t('common.roleUser')}
        </LabelText>
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={logout}
        aria-label={t('app.signOut')}
        title={t('app.signOut')}
        className="text-well-dim hover:text-destructive size-7 shrink-0"
      >
        <LogOutIcon className="size-4" />
      </Button>
    </div>
  );
}
