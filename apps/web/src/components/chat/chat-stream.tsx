// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { FoldState } from './fold.js';
import { AssistantStepRow, SystemNote, TurnTail, UserMessage } from './rows.js';
import { ToolCallRow } from './tool-card.js';
import { SubagentRow } from './subagent-card.js';
import { PermissionCards } from './permission-cards.js';
import type { PermissionCardState } from './fold.js';
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
  /**
   * History paging: bumps when a page was PREPENDED — the scroller adds the
   * height delta to scrollTop so the viewport stays put (otherwise the
   * browser clamps to the top and the position jumps).
   */
  prependKey?: number;
  /** Fired when the user scrolls within the top sliver — page older history. */
  onTopReached?: () => void;
  onPermissionRespond: (requestId: string, optionId?: string) => void;
  onElicitationRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    values?: Record<string, string | number | boolean | string[]>,
  ) => void;
  /** #88 — present when the surface offers 保存为笔记 on settled steps. */
  onCaptureStep?: (markdown: string) => void;
}

export function ChatStream({
  state,
  cwd,
  prependKey = 0,
  onTopReached,
  onPermissionRespond,
  onElicitationRespond,
  onCaptureStep,
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

  // Paging: fire once per approach to the top until the user leaves the
  // sliver again (scroll events fire in bursts).
  const topFiredRef = useRef(false);
  const handleScroll = useCallback(() => {
    if (programmaticRef.current) return;
    const el = containerRef.current;
    if (el === null) return;
    if (el.scrollTop < 60) {
      if (!topFiredRef.current) {
        topFiredRef.current = true;
        onTopReached?.();
      }
    } else {
      topFiredRef.current = false;
    }
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  }, [onTopReached]);

  // Prepend viewport-hold: on a prependKey bump, grow scrollTop by the height
  // the older rows added. prevHeightRef tracks every render's scrollHeight so
  // the delta is exactly the prepended content's.
  const prevHeightRef = useRef(0);
  const prevKeyRef = useRef(prependKey);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    if (prependKey !== prevKeyRef.current) {
      const delta = el.scrollHeight - prevHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
      prevKeyRef.current = prependKey;
    }
    prevHeightRef.current = el.scrollHeight;
  });

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
  const settled = state.permissions.filter((p) => p.settled);
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
                return (
                  <AssistantStepRow
                    key={row.key}
                    step={row.step}
                    {...(onCaptureStep !== undefined ? { onCapture: onCaptureStep } : {})}
                  />
                );
              case 'tool':
                return <ToolCallRow key={row.key} node={row.root} cwd={cwd} />;
              case 'subagent':
                return <SubagentRow key={row.key} agent={row.agent} cwd={cwd} />;
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
          {settled.length > 0 ? <SettledPermissions permissions={settled} /> : null}
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

/**
 * Settled permission cards collapse to a single muted line. #92 — the line
 * grows a delegated summary when the gate answered any of them, so the
 * interruption-absorbing stays visible after the cards vanish.
 */
const SettledPermissions = memo(function SettledPermissions({
  permissions,
}: {
  permissions: PermissionCardState[];
}) {
  const { t } = useI18n();
  if (permissions.length === 0) return null;
  const delegated = permissions.filter((p) => p.resolution?.responder === 'delegated');
  const allowed = delegated.filter((p) => p.resolution?.denialReason === undefined);
  const denied = delegated.filter((p) => p.resolution?.denialReason !== undefined);
  return (
    <span className="text-muted-foreground/60 text-[11px]">
      {t('chat.permissionsSettled', { count: permissions.length })}
      {delegated.length > 0
        ? ` · ${t('chat.approvalsSettledSummary', {
            delegated: delegated.length,
            allowed: allowed.length,
            denied: denied.length,
          })}`
        : ''}
    </span>
  );
});
