// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { PermissionCardState } from './fold.js';
import { toolArgumentsPreview } from './tool-meta.js';

/** #104 — the named reason a delegated review could not conclude. */
const ESCALATION_REASON_KEY: Record<
  NonNullable<PermissionCardState['escalation']>['reason'],
  TranslationKey
> = {
  'no-model': 'chat.delegationReasonNoModel',
  timeout: 'chat.delegationReasonTimeout',
  http: 'chat.delegationReasonHttp',
  shape: 'chat.delegationReasonShape',
};

/**
 * #104 — the delegation was ON but could not answer; the card is the human's.
 * One muted line, same weight as the advisory: the fallback is safe, it just
 * must not be silent.
 */
function EscalationLine({
  escalation,
}: {
  escalation: NonNullable<PermissionCardState['escalation']>;
}) {
  const { t } = useI18n();
  return (
    <p className="text-muted-foreground mb-2 text-xs">
      {t('chat.delegationUnavailable', {
        reason: t(ESCALATION_REASON_KEY[escalation.reason]),
      })}
    </p>
  );
}

/**
 * #92 — the gate's escalated lean, rendered ONLY while the card is still
 * pending: one muted line, explicitly advisory (the human decides — the
 * model's opinion is context, never the verdict). v2: when the model
 * produced them, its severity grade and intent match ride along.
 */
function AdvisoryLine({ advisory }: { advisory: NonNullable<PermissionCardState['advisory']> }) {
  const { t } = useI18n();
  const lean = t(
    advisory.lean === 'allow' ? 'chat.approvalsLeanAllow' : 'chat.approvalsLeanReject',
  );
  return (
    <p className="text-muted-foreground mb-2 text-xs">
      {advisory.severity !== undefined && advisory.intent !== undefined
        ? t('chat.approvalsAdvisoryVerdict', {
            severity: advisory.severity.toFixed(1),
            intent: advisory.intent.toFixed(2),
            lean,
          })
        : t('chat.approvalsAdvisory', {
            lean,
            confidence: advisory.confidence.toFixed(2),
          })}
      {advisory.reason !== undefined
        ? ` · ${t(`chat.approvalsReason.${advisory.reason}` as never)}`
        : ''}
    </p>
  );
}

/**
 * Inline permission cards (Phase 9 W6, unchanged C5 semantics): rendered
 * straight from the request's `options` — option ids pass through VERBATIM,
 * never hardcoded allow/deny. Warn tones (a pending tool permission is a
 * decision, not a failure).
 */
export function PermissionCards({
  permissions,
  onRespond,
}: {
  permissions: PermissionCardState[];
  onRespond: (requestId: string, optionId?: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {permissions.map((p) => (
        <div key={p.requestId} className="border-warn/50 bg-warn/5 rounded-md border p-3 text-sm">
          <p className="mb-1.5 font-medium">
            {p.toolCall.title !== undefined
              ? t('chat.permissionAskTitle', { title: p.toolCall.title })
              : t('chat.permissionAsk')}
          </p>
          {(() => {
            const preview = toolArgumentsPreview({
              callId: p.toolCall.toolCallId,
              toolName: p.toolCall.toolName,
              title: p.toolCall.title,
              kind: p.toolCall.kind,
              status: 'running',
              rawInput: p.toolCall.rawInput,
              content: p.toolCall.content,
              output: p.toolCall.output,
              locations: p.toolCall.locations,
              startedAt: 0,
            });
            return preview !== '' ? (
              <p className="text-muted-foreground mb-2 font-mono text-xs break-all">{preview}</p>
            ) : null;
          })()}
          {p.escalation !== undefined ? <EscalationLine escalation={p.escalation} /> : null}
          {p.advisory !== undefined ? <AdvisoryLine advisory={p.advisory} /> : null}
          <div className="flex flex-wrap gap-2">
            {p.options.map((o) => (
              <Button
                key={o.optionId}
                size="sm"
                variant={o.kind.startsWith('reject') ? 'outline' : 'default'}
                onClick={() => onRespond(p.requestId, o.optionId)}
              >
                {o.name}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
