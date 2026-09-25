import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { PageIntro, Panel, PanelBody } from '@/components/kit';
import { PageSlot } from '@/components/shell/page-slots';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

export function SettingsPage() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [allow, setAllow] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRegistration().then((r) => setAllow(r.allowRegistration));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await withAuthGuard(() => api.setRegistration(next), logout);
      setAllow(next);
      toast.success(next ? t('settings.registrationOpened') : t('settings.registrationClosed'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageIntro sub={<>{t('settings.subtitle')}</>} />

      <Panel label={t('settings.registration')} className="max-w-xl">
        <PanelBody variant="pad" className="flex flex-col gap-3">
          <p className="text-muted-foreground max-w-[68ch] text-sm">
            {t('settings.registrationDesc')}
          </p>
          <div className="flex items-center justify-between rounded-(--radius-well) border p-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="reg-switch" className="text-sm font-medium">
                {t('settings.allowPublicRegistration')}
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">{t('settings.currentState')}</span>
                {allow === null ? (
                  <span className="text-muted-foreground text-xs">…</span>
                ) : (
                  <Badge variant={allow ? 'default' : 'secondary'} className="text-[10px]">
                    {allow ? t('settings.open') : t('settings.closed')}
                  </Badge>
                )}
              </div>
            </div>
            <Switch
              id="reg-switch"
              checked={allow === true}
              disabled={busy || allow === null}
              onCheckedChange={(v) => toggle(v)}
            />
          </div>
        </PanelBody>
      </Panel>
    </>
  );
}
