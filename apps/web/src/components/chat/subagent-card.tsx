// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { memo, useState } from 'react';
import { BotIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { StateSignal, type SignalState } from '@/components/state-signal';
import type { SubagentNode } from './fold.js';
import { AssistantStepRow, SystemNote, UserMessage } from './rows.js';
import { ToolCallRow } from './tool-card.js';

/**
 * #71 — a native sub-agent row (claude's Task/Agent children): the same
 * 24px-high disclosure shape as a tool row — state dot, name, separator dot,
 * task (truncated), duration, running label — expanding into the CHILD's own
 * transcript rendered with the ordinary row components. The child's activity
 * lives in here, never interleaved with the main agent's stream.
 */
const CHILD_STATE_SIGNAL: Record<SubagentNode['state'], SignalState> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  disconnected: 'offline',
};

export const SubagentRow = memo(function SubagentRow({
  agent,
  cwd,
}: {
  agent: SubagentNode;
  cwd?: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const running = agent.state === 'running';
  const duration =
    agent.endedAt !== undefined && agent.endedAt - agent.startedAt > 400
      ? `${((agent.endedAt - agent.startedAt) / 1000).toFixed(1)}s`
      : null;
  const name = agent.name !== '' ? agent.name : agent.subagentId;

  return (
    <div
      className={cn('flex flex-col rounded-sm text-xs', running && 'lamp-breath')}
      data-subagent-state={agent.state}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
        >
          <StateSignal
            state={CHILD_STATE_SIGNAL[agent.state]}
            label={agent.state}
            pulse={running}
            className="size-1.5"
          />
          <ChevronDownIcon
            className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-180')}
          />
          <span className="text-muted-foreground shrink-0 font-medium">{name}</span>
          <span className="text-muted-foreground/40" aria-hidden>
            ·
          </span>
          {agent.task !== '' ? (
            <span className="text-muted-foreground min-w-0 truncate">{agent.task}</span>
          ) : null}
          <span className="min-w-0 flex-1" />
          {duration !== null ? (
            <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] tabular-nums">
              {duration}
            </span>
          ) : null}
          {running ? (
            <span className="text-muted-foreground shrink-0 text-[10px]">{t('chat.running')}</span>
          ) : null}
        </button>
        <BotIcon className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
      </div>
      {expanded ? (
        <div
          data-surface="well"
          className="bg-muted/50 mt-1 mb-2 flex max-h-72 min-w-0 flex-col gap-2 overflow-y-auto rounded-md border px-2 py-2"
          aria-label={t('chat.subagentTranscript')}
        >
          {agent.task !== '' ? (
            <span className="text-muted-foreground/70 text-[11px] leading-5">
              {t('chat.subagentTaskLabel')}: {agent.task}
            </span>
          ) : null}
          {agent.fold.rows.map((row) => {
            switch (row.row) {
              case 'user':
                return <UserMessage key={row.key} blocks={row.blocks} />;
              case 'assistant':
                return <AssistantStepRow key={row.key} step={row.step} />;
              case 'tool':
                return <ToolCallRow key={row.key} node={row.root} cwd={cwd} />;
              case 'system':
                return <SystemNote key={row.key} text={row.text} tone={row.tone} />;
              default:
                return null;
            }
          })}
        </div>
      ) : null}
    </div>
  );
});
