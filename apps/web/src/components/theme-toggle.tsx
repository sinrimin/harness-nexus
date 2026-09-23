import { MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useI18n } from '@/i18n';
import { useSkin } from '@/components/skin-provider';
import { Button } from '@/components/ui/button';

/**
 * Light/dark toggle button. Shown in the app header. Skins declare which
 * modes they ship — a single-mode skin locks the toggle.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { manifest } = useSkin();
  const { t } = useI18n();
  const isDark = resolvedTheme === 'dark';
  const locked = manifest.modes.length === 1;
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={locked}
      title={locked ? t('app.themeLockedBySkin') : undefined}
      aria-label={isDark ? t('app.themeToLight') : t('app.themeToDark')}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
