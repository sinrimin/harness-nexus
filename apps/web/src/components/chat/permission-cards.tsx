// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import type { PermissionCardState } from './fold.js';
import { toolArgumentsPreview } from './tool-meta.js';

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
