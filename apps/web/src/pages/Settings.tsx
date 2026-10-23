// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Chip, PageIntro, Panel, PanelBody } from '@/components/kit';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Field } from '@/components/kit/field.js';
import { XIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
    <Panel label={t('settings.retention')} className="max-w-xl mb-(--gap)">
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

/**
 * #85 — the API tool outbound policy: the DEFAULT action (allow ⇒ the rule
 * lists are blacklists, deny ⇒ whitelists) plus the external/internal rule
 * lists. Instance-level config, hence THIS page — saved atomically.
 */
function OutboundPanel() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [mode, setMode] = useState<'allow' | 'deny' | null>(null);
  const [rules, setRules] = useState<{ external: string[]; internal: string[] } | null>(null);
  const [drafts, setDrafts] = useState<{ external: string; internal: string }>({
    external: '',
    internal: '',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    withAuthGuard(() => api.getApiToolOutbound(), logout)
      .then((r) => {
        setMode(r.mode);
        setRules(r.rules);
      })
      .catch(() => {
        setMode(null);
        setRules(null);
      });
  }, [logout]);

  function addRule(side: 'external' | 'internal'): void {
    const v = drafts[side].trim();
    if (v === '' || rules === null || rules[side].includes(v)) return;
    setRules({ ...rules, [side]: [...rules[side], v] });
    setDrafts({ ...drafts, [side]: '' });
  }

  function removeRule(side: 'external' | 'internal', rule: string): void {
    if (rules === null) return;
    setRules({ ...rules, [side]: rules[side].filter((x) => x !== rule) });
  }

  async function save(): Promise<void> {
    if (mode === null || rules === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.setApiToolOutbound(mode, rules), logout);
      toast.success(t('settings.outboundSaved'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  const ruleGroup = (side: 'external' | 'internal'): React.ReactNode => (
    <div className="flex flex-col gap-2 rounded-(--radius-well) border p-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">
          {side === 'external' ? t('settings.outboundExternal') : t('settings.outboundInternal')}
        </Label>
        <span className="text-muted-foreground role-data-sm">
          {rules === null ? '…' : rules[side].length}
        </span>
      </div>
      {rules !== null && rules[side].length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {rules[side].map((rule) => (
            <Chip
              key={rule}
              tone="muted"
              title={t('settings.outboundRemove', { rule })}
              onClick={() => removeRule(side, rule)}
            >
              {rule} <XIcon aria-hidden className="inline" />
            </Chip>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground text-xs">{t('settings.outboundEmpty')}</span>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={drafts[side]}
          onChange={(e) => setDrafts({ ...drafts, [side]: e.target.value })}
          placeholder={side === 'external' ? 'api.example.com / 203.0.113.0/24' : '10.0.0.0/8'}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addRule(side);
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => addRule(side)}>
          {t('settings.outboundAdd')}
        </Button>
      </div>
    </div>
  );

  return (
    <Panel label={t('settings.outboundTitle')} className="max-w-xl">
      <PanelBody variant="pad" className="flex flex-col gap-3">
        <p className="text-muted-foreground max-w-[68ch] text-sm">
          {mode === 'deny' ? t('settings.outboundHintDeny') : t('settings.outboundHintAllow')}
        </p>
        <div className="flex items-end justify-between gap-3 rounded-(--radius-well) border p-4">
          <Field label={t('settings.outboundModeLabel')} className="max-w-xs">
            <Select
              value={mode ?? 'allow'}
              onValueChange={(v) => setMode(v === 'deny' ? 'deny' : 'allow')}
              disabled={mode === null}
            >
              <SelectTrigger aria-label={t('settings.outboundModeLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">{t('settings.outboundModeAllow')}</SelectItem>
                <SelectItem value="deny">{t('settings.outboundModeDeny')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Badge variant={mode === 'deny' ? 'secondary' : 'default'}>
            {mode === 'deny' ? t('settings.outboundModeDeny') : t('settings.outboundModeAllow')}
          </Badge>
        </div>
        {ruleGroup('external')}
        {ruleGroup('internal')}
        <p className="text-muted-foreground text-xs">{t('settings.outboundRuleHint')}</p>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={busy || mode === null || rules === null}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}

export function SettingsPage() {
  const { logout, user } = useAuth();
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

      <Panel label={t('settings.registration')} className="max-w-xl mb-(--gap)">
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
                  <Badge variant={allow ? 'default' : 'secondary'}>
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

      {user?.role === 'admin' ? <OutboundPanel /> : null}
    </>
  );
}
