// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { PageIntro, Panel, PanelBody } from '@/components/kit';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * #59 — the retention editor. The value only affects FUTURE ingests (each
 * blob's expiry is stamped at its own write time), which the description
 * states plainly — no control on this page rewrites history.
 */
function RetentionPanel() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [days, setDays] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getImageRetention()
      .then((r) => {
        setDays(r.imageRetentionDays);
        setDraft(String(r.imageRetentionDays));
      })
      .catch(() => setDays(null));
  }, []);

  async function save() {
    const parsed = Number(draft.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
      toast.error(t('settings.retentionInvalid'));
      return;
    }
    setBusy(true);
    try {
      await withAuthGuard(() => api.setImageRetention(parsed), logout);
      setDays(parsed);
      toast.success(t('settings.retentionSaved', { count: parsed }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel label={t('settings.retention')} className="max-w-xl">
      <PanelBody variant="pad" className="flex flex-col gap-3">
        <p className="text-muted-foreground max-w-[68ch] text-sm">{t('settings.retentionDesc')}</p>
        <div className="flex items-end justify-between gap-3 rounded-(--radius-well) border p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="image-retention" className="text-sm font-medium">
              {t('settings.retentionDays')}
            </Label>
            <span className="text-muted-foreground text-xs">
              {days === null
                ? t('settings.currentState')
                : t('settings.retentionCurrent', { count: days })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="image-retention"
              type="number"
              min={1}
              max={3650}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs tabular-nums w-24"
              autoComplete="off"
              inputMode="numeric"
              spellCheck={false}
              disabled={days === null}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy || days === null || draft.trim() === String(days)}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

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

      <RetentionPanel />
    </>
  );
}
