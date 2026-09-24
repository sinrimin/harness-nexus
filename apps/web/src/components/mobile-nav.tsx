import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { MenuIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { LanguageToggle } from '@/components/language-toggle';
import { SkinToggle } from '@/components/skin-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserBlock } from '@/components/user-block';
import { Brand } from '@/components/brand-mark';

/**
 * Mobile navigation drawer (01-skeleton.md §6).
 *
 * The plate is hidden below 900px, so this carries the FULL navigation: every
 * section's entries, the account block, and the three toggles. It auto-closes
 * on route change so a tap navigates and dismisses in one motion, and traps
 * focus while open (Radix Dialog).
 *
 * Positioned `absolute` against the shell root rather than `fixed`: the scrim
 * comes from `--scrim` (it used to hardcode `bg-foreground/40`, which ignored
 * the skin) and nothing here should depend on what a skin does to the body.
 */
export function MobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { t } = useI18n();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="min-[900px]:hidden"
          aria-label={t('app.mobileOpenNav')}
        >
          <MenuIcon className="size-5" />
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="bg-scrim/45 absolute inset-0 z-40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="bg-background text-foreground absolute inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          aria-description={t('app.primaryNav')}
        >
          <div className="flex h-(--shell-bar-h-sm) shrink-0 items-center justify-between border-b px-3">
            <Brand size={20} />
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label={t('app.mobileCloseNav')}>
                <XIcon className="size-5" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 py-3">{children}</div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t p-3">
            <div className="flex items-center gap-0.5">
              <LanguageToggle />
              <SkinToggle />
              <ThemeToggle />
            </div>
            <UserBlock />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
