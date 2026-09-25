import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { FoldState } from './fold.js';
import { AssistantStepRow, SystemNote, TurnTail, UserMessage } from './rows.js';
import { ToolCallRow } from './tool-card.js';
import { PermissionCards } from './permission-cards.js';
import { ElicitationCards } from './elicitation-cards.js';

/**
 * Scroll container + row dispatch (Phase 9 W6) — stick-to-bottom ONLY while
 * the user is already at the bottom (80px threshold): a programmatic-scroll
 * flag suppresses the between-frames misjudgment, a ResizeObserver follows
 * late height growth (highlight/images), and a session load jumps to the
 * bottom with one catch-up tick. Unsettled permission cards render inline at
 * the stream tail — from the payload's options, never hardcoded; unsettled
 * agent questions (9 W14.1 elicitations) render right after them.
 */

const BOTTOM_THRESHOLD = 80;

interface ChatStreamProps {
  state: FoldState;
  cwd?: string;
  onPermissionRespond: (requestId: string, optionId?: string) => void;
  onElicitationRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    values?: Record<string, string | number | boolean | string[]>,
  ) => void;
}

export function ChatStream({
  state,
  cwd,
  onPermissionRespond,
  onElicitationRespond,
}: ChatStreamProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const programmaticRef = useRef(false);
  const loadedRef = useRef(false);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    programmaticRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmaticRef.current = false;
    });
  }, []);

  const handleScroll = useCallback(() => {
    if (programmaticRef.current) return;
    const el = containerRef.current;
    if (el === null) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  }, []);

  useEffect(() => {
    if (atBottomRef.current) jumpToBottom();
  }, [state.rows, jumpToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && !programmaticRef.current) jumpToBottom();
    });
    ro.observe(el.firstElementChild ?? el);
    return () => ro.disconnect();
  }, [jumpToBottom]);

  useEffect(() => {
    if (state.rows.length === 0) {
      loadedRef.current = false;
      atBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    if (loadedRef.current) return;
    loadedRef.current = true;
    jumpToBottom();
    const raf = requestAnimationFrame(jumpToBottom);
    const t1 = window.setTimeout(jumpToBottom, 400);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
    };
  }, [state.rows, jumpToBottom]);

  const unsettled = state.permissions.filter((p) => !p.settled);
  const openQuestions = state.elicitations.filter((e) => !e.settled);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label={t('chat.streamLabel')}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {state.rows.length === 0 && unsettled.length === 0 && openQuestions.length === 0 ? (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
              <p>{t('chat.emptyConversation')}</p>
            </div>
          ) : null}
          {state.rows.map((row) => {
            switch (row.row) {
              case 'user':
                return <UserMessage key={row.key} blocks={row.blocks} />;
              case 'assistant':
                return <AssistantStepRow key={row.key} step={row.step} />;
              case 'tool':
                return <ToolCallRow key={row.key} node={row.root} cwd={cwd} />;
              case 'system':
                return <SystemNote key={row.key} text={row.text} tone={row.tone} />;
              case 'turn-tail':
                return <TurnTail key={row.key} stats={row.stats} />;
              default:
                return null;
            }
          })}
          {unsettled.length > 0 ? (
            <PermissionCards permissions={unsettled} onRespond={onPermissionRespond} />
          ) : null}
          {openQuestions.length > 0 ? (
            <ElicitationCards elicitations={openQuestions} onRespond={onElicitationRespond} />
          ) : null}
        </div>
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={() => {
            programmaticRef.current = true;
            atBottomRef.current = true;
            setAtBottom(true);
            const el = containerRef.current;
            if (el !== null) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            window.setTimeout(() => {
              programmaticRef.current = false;
            }, 500);
          }}
          className="bg-background text-muted-foreground hover:text-foreground absolute bottom-3 left-1/2 rounded-full border p-1.5 shadow-sm transition-colors"
          aria-label={t('chat.jumpBottom')}
        >
          <ArrowDownIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Settled permission cards are collapsed to a single muted line. */
const SettledPermissions = memo(function SettledPermissions({ count }: { count: number }) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <span className="text-muted-foreground/60 text-[11px]">
      {t('chat.permissionsSettled', { count })}
    </span>
  );
});
