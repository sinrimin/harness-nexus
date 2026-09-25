import type { LucideIcon } from 'lucide-react';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A page's action in the topbar (`PageSlot slot="actions"`).
 *
 * The bar is 48px on a phone and already holds the drawer button, the page's
 * identity and three toggles, so the action shrinks to its ICON below `sm` —
 * the label moves into `aria-label`/`title` where it is still announced — and
 * shows icon + label from `sm` up. Every topbar action is a create today
 * (`+`), which is what made the inconsistency visible: two pages had grown
 * their own `hidden sm:inline` span while six had not, so the same bar showed a
 * `+` on one page and a wide labelled button on another. Reported as "统一显示
 * 为 + 号就行了" — one component, so "uniform" is a property of the code rather
 * than of remembering.
 */
export function PageAction({
  label,
  onClick,
  icon: Icon = PlusIcon,
  disabled,
  busy,
}: {
  /** Already-translated action name; also the icon-only accessible name. */
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  /** The action is running: the icon spins (the label already says so). */
  busy?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="gap-1.5 max-sm:w-(--control-h) max-sm:px-0"
    >
      <Icon className={cn('size-4', busy === true && 'animate-spin')} />
      <span className="max-sm:hidden">{label}</span>
    </Button>
  );
}