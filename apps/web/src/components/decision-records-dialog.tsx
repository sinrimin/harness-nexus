// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { api } from '@/api';
import { Note, Skeleton, Well } from '@/components/kit';
import { StateSignal, type SignalState } from '@/components/state-signal';
import { Button } from '@/components/ui/button';
import { FormDialog } from '@/components/ui/form-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { dateLocale, useI18n } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { DecisionRecordView } from '@harness-nexus/sdk';

/**
 * #97 — the delegated-decision audit trail, one read-only dialog with two
 * entry modes: session-scoped (the chat settled-line button) and full (the
 * LLM providers defaults dialog). Verdict truth renders through StateSignal
 * (`data-state`); the arguments preview is protocol material, so it lives in
 * a Well; every figure column is tabular. Pages walk backward on an
 * exclusive createdAt cursor — newest-first, the same order the port pins.
 */

const PAGE = 50;

type OutcomeFilter = '' | 'allow' | 'deny' | 'escalate';

const VERDICT_KEY: Record<DecisionRecordView['outcome'], TranslationKey> = {
  allow: 'decisions.verdictAllow',
  deny: 'decisions.verdictDeny',
  escalate: 'decisions.verdictEscalate',
};

/** allow→ok, escalate→warn, deny→danger — the semantic palette's only meaning-bearers. */
function verdictState(outcome: DecisionRecordView['outcome']): SignalState {
  return outcome === 'allow' ? 'succeeded' : outcome === 'deny' ? 'failed' : 'warn';
}

function humanResponseKey(
  response: NonNullable<DecisionRecordView['humanResponse']>,
): TranslationKey {
  switch (response) {
    case 'allow':
      return 'decisions.hrAllow';
    case 'reject':
      return 'decisions.hrReject';
    case 'timeout':
      return 'decisions.hrTimeout';
    default:
      return 'decisions.hrCancel';
  }
}

interface DecisionRecordsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Present ⇒ session mode: this session's records only, no filter bar. */
  sessionId?: string;
}

export function DecisionRecordsDialog({ open, onClose, sessionId }: DecisionRecordsDialogProps) {
  const { t } = useI18n();
  const [records, setRecords] = useState<DecisionRecordView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeFilter>('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setRecords(null);
    try {
      const rows = await api.listDecisionRecords({
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(outcome !== '' ? { outcome } : {}),
        limit: PAGE,
      });
      setRecords(rows);
      setHasMore(rows.length === PAGE);
    } catch {
      setFailed(true);
    }
  }, [sessionId, outcome]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) {
      setRecords(null);
      setOutcome('');
      setHasMore(false);
    }
  }, [open]);

  const loadMore = async (): Promise<void> => {
    const last = records?.[records.length - 1];
    if (last === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const rows = await api.listDecisionRecords({
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(outcome !== '' ? { outcome } : {}),
        before: last.createdAt,
        limit: PAGE,
      });
      setRecords((prev) => [...(prev ?? []), ...rows]);
      setHasMore(rows.length === PAGE);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('decisions.title')}
      size="xl"
      description={sessionId !== undefined ? undefined : t('llmProviders.decisionHint')}
    >
      {sessionId === undefined ? (
        <div className="mb-3 flex items-center justify-end">
          <Select
            value={outcome === '' ? 'all' : outcome}
            onValueChange={(v) => setOutcome(v === 'all' ? '' : (v as OutcomeFilter))}
          >
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('decisions.allOutcomes')}</SelectItem>
              <SelectItem value="allow">{t('decisions.verdictAllow')}</SelectItem>
              <SelectItem value="deny">{t('decisions.verdictDeny')}</SelectItem>
              <SelectItem value="escalate">{t('decisions.verdictEscalate')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {failed ? (
        <div className="flex flex-col items-start gap-2 py-4">
          <Note tone="fail">{t('decisions.errorLoad')}</Note>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t('kit.retry')}
          </Button>
        </div>
      ) : records === null ? (
        <div className="space-y-3 py-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-xs">
          {sessionId !== undefined ? t('decisions.emptySession') : t('decisions.emptyFull')}
        </p>
      ) : (
        <>
          <div className="min-w-0">
            {records.map((r) => (
              <DecisionRow key={r.id} record={r} />
            ))}
          </div>
          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {t('decisions.loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </FormDialog>
  );
}

/** One verdict row — module scope (never inside the dialog component). */
function DecisionRow({ record }: { record: DecisionRecordView }) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const verdict = VERDICT_KEY[record.outcome];
  return (
    <div className="border-border/60 py-2.5 first:pt-0 last:border-b-0 border-b">
      <div className="flex min-w-0 items-center gap-2">
        <StateSignal state={verdictState(record.outcome)} label={t(verdict)} />
        <span className="text-xs font-medium">{t(verdict)}</span>
        <span className="text-foreground/80 font-mono m-0 min-w-0 flex-1 truncate text-xs">
          {record.toolTitle}
        </span>
        <time className="text-muted-foreground nums shrink-0 text-[11px]">
          {new Date(record.createdAt).toLocaleString(dateLocale(lang), {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </time>
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span>
          {record.decidedBy === 'floor' ? t('decisions.byFloor') : t('decisions.byModel')}
        </span>
        {record.target !== undefined ? <span className="font-mono">{record.target}</span> : null}
        {record.severity !== undefined ? (
          <span className="nums">
            {t('decisions.severity')} {record.severity.toFixed(2)}
            {record.sevConfidence !== undefined
              ? ` (${Math.round(record.sevConfidence * 100)}%)`
              : ''}
          </span>
        ) : null}
        {record.intent !== undefined ? (
          <span className="nums">
            {t('decisions.intent')} {record.intent.toFixed(2)}
            {record.intentConfidence !== undefined
              ? ` (${Math.round(record.intentConfidence * 100)}%)`
              : ''}
          </span>
        ) : null}
        {/* `why` is a REJECT-reason taxonomy ("if this should NOT
            proceed…") — on an allow row the normalized 'fine'→'other'
            carries no meaning, so the tag only renders on non-allows. */}
        {record.why !== undefined && record.outcome !== 'allow' ? (
          <span>{t(`chat.approvalsReason.${record.why}` as TranslationKey)}</span>
        ) : null}
        {record.providerName !== undefined ? (
          <span className="font-mono truncate">
            {record.providerName}
            {record.modelId !== undefined ? `/${record.modelId}` : ''}
          </span>
        ) : null}
        {record.latencyMs !== undefined ? <span className="nums">{record.latencyMs}ms</span> : null}
        {record.humanResponse !== undefined ? (
          <span>
            {t('decisions.humanLabel')}: {t(humanResponseKey(record.humanResponse))}
          </span>
        ) : null}
      </div>
      {record.toolInputPreview !== undefined ? (
        expanded ? (
          <div className="mt-2 space-y-1">
            <Well className="max-h-40 overflow-y-auto font-mono text-[11px] break-all whitespace-pre-wrap">
              {record.toolInputPreview}
            </Well>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
              onClick={() => setExpanded(false)}
            >
              <ChevronUpIcon className="size-3" />
              {t('decisions.hideArgs')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground mt-1 inline-flex items-center gap-1 text-[11px]"
            onClick={() => setExpanded(true)}
          >
            <ChevronDownIcon className="size-3" />
            {t('decisions.showArgs')}
          </button>
        )
      ) : null}
    </div>
  );
}
