import { useI18n } from '@/i18n';
import { useServerVersion } from '@/version';

/**
 * The build version line (#37) — one muted mono line rendered above the
 * account block in the plate foot (desktop) and the drawer foot (mobile). It
 * costs a single line inside surfaces that are already scrollable/collapsible,
 * so the phone keeps its chrome while the version stays one tap away. Unknown
 * version renders nothing (honesty over decoration).
 */
export function VersionLine() {
  const { t } = useI18n();
  const version = useServerVersion();
  if (version === null) return null;
  return (
    <p
      className="role-data-sm text-muted-foreground/80 nums px-1 pb-1 font-mono"
      title={t('app.versionHint')}
    >
      v{version}
    </p>
  );
}
