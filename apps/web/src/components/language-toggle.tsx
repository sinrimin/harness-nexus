import { LanguagesIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';

/** Language toggle button (en ↔ zh). Shown in the app header next to the theme
 * toggle — icon only (#40); the label rides aria-label + title. */
export function LanguageToggle() {
  const { lang, setLang } = useI18n();
  const next = lang === 'en' ? 'zh' : 'en';
  const label = lang === 'en' ? '切换到中文' : 'Switch to English';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => setLang(next)}
    >
      <LanguagesIcon className="size-4" />
    </Button>
  );
}
