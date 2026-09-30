import { MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useI18n } from '@/i18n';
import { useSkin } from '@/components/skin-provider';
import { Button } from '@/components/ui/button';

/**
 * Light/dark toggle button. Shown in the app header. Skins declare which
 * modes they ship — a single-mode skin has no mode axis to toggle, so the
 * toggle does not render at all (#41): a disabled-but-normal-looking icon
 * is a dead touch target, and on phones a tap that slips off it hits the
 * neighbor (star link / skin picker) instead.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { manifest } = useSkin();
  const { t } = useI18n();
  const isDark = resolvedTheme === 'dark';
  if (manifest.modes.length === 1) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? t('app.themeToLight') : t('app.themeToDark')}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
