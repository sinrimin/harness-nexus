import { memo, useEffect, useRef, useState } from 'react';
import { BrainIcon, ChevronDownIcon, FileTextIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { MarkdownText } from './markdown-text.js';
import type { TurnStats, UserBlock } from './fold.js';

/**
 * Row renderers for the conversation stream (Phase 9 W6), ported from the
 * portal reference into the Signal system. User = right-aligned muted bubble;
 * system = one-line tone note; turn-tail = one muted mono stats line;
 * reasoning = 24px disclosure row whose summary follows the stream (last
 * line while running, first line once settled) and expands to the full text.
 */

/**
 * 9 W9 — the user row renders BLOCKS: text (as before), image thumbnails
 * (click → lightbox), and file-reference chips. One bubble still: the blocks
 * stack in send order inside it.
 */
export const UserMessage = memo(function UserMessage({ blocks }: { blocks: UserBlock[] }) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState<Extract<UserBlock, { type: 'image' }> | null>(null);
  const texts = blocks.filter((b): b is Extract<UserBlock, { type: 'text' }> => b.type === 'text');
  const others = blocks.filter((b) => b.type !== 'text');
  return (
    <div className="flex flex-col items-end">
      <div className="bg-muted text-foreground flex max-w-[min(34rem,82%)] flex-col gap-2 rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
        {others.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {others.map((b, i) =>
              b.type === 'image' ? (
                <button
                  key={i}
                  type="button"
                  onClick={() => setZoom(b)}
                  className="ring-border hover:ring-ring overflow-hidden rounded-md ring-1 transition-[box-shadow]"
                  title={t('chat.imagePreview')}
                >
                  <img
                    src={`data:${b.mimeType};base64,${b.data}`}
                    alt={t('chat.imagePreview')}
                    className="max-h-24 max-w-[10rem] object-cover"
                  />
                </button>
              ) : (
                <span
                  key={i}
                  className="bg-background inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs"
                  title={b.uri}
                >
                  <FileTextIcon className="size-3 shrink-0" />
                  <span className="truncate">@{b.name}</span>
                </span>
              ),
            )}
          </div>
        ) : null}
        {texts.length > 0 ? (
          <div className="whitespace-pre-wrap break-words">
            {texts.map((b, i) => (
              <span key={i}>{b.text}</span>
            ))}
          </div>
        ) : null}
      </div>
      {zoom !== null ? (
        <Dialog open onOpenChange={(o) => (o ? undefined : setZoom(null))}>
          <DialogContent className="max-w-3xl p-3">
            <DialogTitle className="sr-only">{t('chat.imagePreview')}</DialogTitle>
            <img
              src={`data:${zoom.mimeType};base64,${zoom.data}`}
              alt={t('chat.imagePreview')}
              className="max-h-[75vh] w-full object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
});

export const SystemNote = memo(function SystemNote({
  text,
  tone,
}: {
  text: string;
  tone: 'info' | 'success' | 'error';
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-1.5 text-xs',
        tone === 'error'
          ? 'text-destructive border-danger/40 bg-danger/5'
          : tone === 'success'
            ? 'text-ok border-ok/40 bg-ok/5'
            : 'text-muted-foreground',
      )}
    >
      {text}
    </div>
  );
});

function fmtTokens(n: number | undefined): string | null {
  if (n === undefined || n <= 0) return null;
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 400) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export const TurnTail = memo(function TurnTail({ stats }: { stats: TurnStats }) {
  const { t } = useI18n();
  const parts: string[] = [];
  const dur = fmtDuration(stats.durationMs);
  if (dur) parts.push(dur);
  const u = stats.usage;
  if (u !== undefined) {
    const inT = fmtTokens(u.inputTokens);
    const outT = fmtTokens(u.outputTokens);
    if (inT !== null || outT !== null) parts.push(`↑${inT ?? '0'} ↓${outT ?? '0'}`);
    // dsh reports context occupancy rather than per-turn counts.
    const used = fmtTokens(u.contextUsed);
    if (used !== null) {
      const size = fmtTokens(u.contextSize);
      parts.push(`ctx ${used}${size !== null ? `/${size}` : ''}`);
    }
  }
  if (stats.stopReason === 'cancelled') parts.push(t('chat.turnCancelled'));
  if (stats.stopReason === 'max_tokens') parts.push(t('chat.turnMaxTokens'));
  if (parts.length === 0) return null;
  return <div className="text-muted-foreground font-mono text-[11px]">{parts.join(' · ')}</div>;
});

function firstLine(text: string): string {
  const i = text.indexOf('\n');
  return i === -1 ? text : text.slice(0, i);
}

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const i = visible.lastIndexOf('\n');
  return i === -1 ? visible : visible.slice(i + 1);
}

function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const empty = text.length === 0;
  const summary = empty ? t('chat.thinking') : running ? latestLine(text) : firstLine(text);

  // Follow the stream: scroll the summary to its tail while running.
  useEffect(() => {
    const el = summaryRef.current;
    if (el === null) return;
    el.scrollLeft = running ? el.scrollWidth - el.clientWidth : 0;
  }, [running, summary]);

  return (
    <div className="text-muted-foreground text-xs" data-state={running ? 'running' : 'ok'}>
      <button
        type="button"
        disabled={empty}
        aria-expanded={expanded && !empty}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex h-6 w-full items-center gap-1.5 rounded-sm text-left',
          !empty && 'hover:text-foreground',
          running && 'lamp-breath',
        )}
      >
        <BrainIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 text-[11px] font-medium">{t('chat.thought')}</span>
        {!empty ? <ChevronDownIcon className="size-3 shrink-0" /> : null}
        <span className="min-w-0 flex-1" />
        <span
          ref={summaryRef}
          className="max-w-[60%] truncate overflow-hidden whitespace-nowrap"
          title={summary}
        >
          {summary}
        </span>
      </button>
      {expanded && !empty ? (
        <div className="border-border/60 mt-1 mb-2 ml-5 max-h-48 overflow-y-auto rounded-md border px-3 py-2 whitespace-pre-wrap">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** One assistant step: ordered blocks + the interrupted marker. */
export const AssistantStepRow = memo(function AssistantStepRow({
  step,
}: {
  step: {
    status: 'running' | 'settled' | 'interrupted';
    blocks: { type: 'text' | 'reasoning'; text: string }[];
  };
}) {
  const { t } = useI18n();
  const streaming = step.status === 'running';
  const last = step.blocks.length - 1;
  if (step.blocks.length === 0 && !streaming) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {step.blocks.map((b, i) =>
        b.type === 'text' ? (
          <MarkdownText key={i} text={b.text} streaming={streaming && i === last} />
        ) : (
          <ReasoningRow key={i} text={b.text} running={streaming && i === last} />
        ),
      )}
      {step.blocks.length === 0 && streaming ? <ReasoningRow text="" running /> : null}
      {step.status === 'interrupted' ? (
        <span className="bg-muted text-muted-foreground w-fit rounded px-1.5 text-[11px] leading-5">
          {t('chat.stopped')}
        </span>
      ) : null}
    </div>
  );
});
