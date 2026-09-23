import { CheckIcon, PaletteIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSkin } from '@/components/skin-provider';
import { SKINS } from '@/skins/registry';

/**
 * Skin picker for the app header. Hidden entirely until a second skin is
 * registered — the axis ships silent until it has something to switch to.
 */
export function SkinToggle() {
  const { skin, setSkin } = useSkin();
  const { t } = useI18n();
  if (SKINS.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('app.skinPicker')}>
          <PaletteIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SKINS.map((s) => (
          <DropdownMenuItem
            key={s.id}
            aria-checked={skin === s.id}
            onSelect={() => setSkin(s.id)}
          >
            <span className="flex w-full items-center justify-between gap-4">
              {t(s.nameKey)}
              {skin === s.id ? <CheckIcon className="size-4" /> : <span className="size-4" />}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
