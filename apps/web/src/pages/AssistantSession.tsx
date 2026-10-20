// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { BotIcon, ListIcon, PencilIcon, PlusIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { StateSignal } from '@/components/state-signal';
import { ConfirmDialog, DataText, EmptyState } from '@/components/kit';
import {
  appSocket,
  emitWithAck,
  onAppResubscribe,
  type AssistantClosedPush,
  type AssistantDispatchesPush,
  type AssistantDispatchView,
  type AssistantEventEnvelope,
  type AssistantHistoryEvent,
  type AssistantReadyPush,
} from '@/realtime';
import {
  HarnessNexusError,
  type AssistantConfigView,
  type LlmProviderView,
} from '@harness-nexus/sdk';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ChatStream } from '@/components/chat/chat-stream.js';
import { WelcomePane, type WelcomeCard } from '@/components/chat/welcome-pane.js';
import { ChannelTabs } from '@/components/chat/channel-tabs.js';
import { SessionRow } from '@/components/chat/session-row.js';
import { useChatChannels } from '@/components/chat/use-chat-channels.js';
import { useAssistantSessions } from '@/components/chat/use-assistant-sessions.js';
import { Composer, type ComposerConfig } from '@/components/chat/composer.js';
import { usePageTitle } from '@/components/shell/page-slots';
import { TodoPanel } from '@/components/chat/todo-panel.js';
import { EndSwitcher } from '@/components/chat/end-switcher.js';
import { createFoldState, fold, type UserBlock } from '@/components/chat/fold.js';
import type { ChatConfigSetPayload, PromptBlock } from '@/realtime';
import {
  attachmentsBytes,
  fileToAttachment,
  ImageAttachError_,
  MAX_IMAGES_PER_TURN,
  MAX_TOTAL_IMAGE_BYTES,
  type DraftAttachment,
} from '@/components/chat/image-attach.js';

/**
 * The assistant 端 session page (#52 §8) — the AgentSession skeleton with the
 * branch points the design names: the `assistant:*` socket family, a
 * new-session flow with no cwd, and no machine-online gate (the per-user
 * busy gate replaces it, visible as the rail rows' running lamps). The
 * transcript is platform-owned: rows survive everything, history replays on
 * every open, and the composer's Agent/Model selects ride the ordinary
 * `session_config` option surface.
 */

type Phase = 'idle' | 'ready' | 'closed';

/**
 * Open-race buffer (the AgentSession SwitchRaceBuffer pattern): the server
 * pushes ready/history/config into the room DURING the open ack, which can
 * predate this page's sessionId-keyed listeners (the ack resolves before
 * React re-renders). A STABLE listener buffers the LATEST per-session
 * pushes; the sessionId effect replays them after the pane reset.
 */
interface OpenRaceBuffer {
  history?: AssistantHistoryEvent['items'];
  configDone?: boolean;
}

/** The last-used assistant config (localStorage — same stance as the 端 pin). */
const AGENT_KEY = 'hnx.chat.agent';

function relativeTime(iso: string | null, locale: string): string {
  if (iso === null || iso === '') return '';
  const diff = Date.now() - (Date.parse(iso) || 0);
  const minutes = Math.round(diff / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(diff / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(-days, 'day');
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function AssistantSessionPage() {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  /** The config this page opens NEW sessions with (`?a=` or the pinned one). */
  const [assistants, setAssistants] = useState<AssistantConfigView[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  /** #58-3 — the model registry (vision flags gate the composer's images). */
  const [providers, setProviders] = useState<LlmProviderView[] | null>(null);
  const [conversation, dispatch] = useReducer(fold, undefined, createFoldState);
  /** 9 W11 B — the tab strip (machine channels only in M1). */
  const channels = useChatChannels();
  const sessions = useAssistantSessions();
  const [railOpen, setRailOpen] = useState(false);

  const refreshAssistants = useCallback(async () => {
    try {
      setAssistants(await withAuthGuard(() => api.listAssistants(), logout));
    } catch {
      setAssistants([]);
    } finally {
      setLoaded(true);
    }
  }, [logout]);

  useEffect(() => {
    void refreshAssistants();
  }, [refreshAssistants]);

  // #58-3 — the registry ride-along: vision flags live on the provider model
  // entries, so the composer's image gate needs them. Best-effort (failure
  // just keeps images off — the honest default).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await withAuthGuard(() => api.listLlmProviders(), logout);
        if (!cancelled) setProviders(rows);
      } catch {
        /* keep null — image attach stays gated off */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logout]);

  // ?s=<id> — a busy-assistant tab hand-off from another page: open that
  // session once the configs loaded (the open itself validates ownership).
  const sParam = searchParams.get('s');
  useEffect(() => {
    if (sParam === null || !loaded) return;
    setSearchParams({}, { replace: true });
    void openSession(sParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sParam, loaded]);

  // ?rail — an end-switch hand-off (a pick from the phone drawer on the
  // machine page): land with the SESSION drawer open so a conversation can
  // be picked or created right away, then drop the one-shot param.
  useEffect(() => {
    if (searchParams.get('rail') === null) return;
    setSearchParams({}, { replace: true });
    setRailOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The 端's default agent: ?a= (a picker hand-off) → the pinned one → the
  // first config. Persisted so the next visit opens where the user left off;
  // a STALE pin (deleted config, another server's data) falls back to the
  // first config instead of dead-ending the page.
  const requestedId = searchParams.get('a') ?? localStorage.getItem(AGENT_KEY) ?? '';
  const assistant = useMemo(
    () => assistants?.find((c) => c.id === requestedId) ?? assistants?.[0] ?? null,
    [assistants, requestedId],
  );
  const assistantId = assistant?.id ?? '';
  useEffect(() => {
    if (assistantId !== '') localStorage.setItem(AGENT_KEY, assistantId);
  }, [assistantId]);

  /**
   * Zero configs is NOT a dead end: the page (rail + 端 switcher + tabs) still
   * renders and the content area becomes a welcome that links to /assistants —
   * the machine ends stay reachable through the switcher (review #52 fix).
   */
  const noAssistants = loaded && (assistants ?? []).length === 0;

  // #68 — the open session's dispatch snapshot (assistant:dispatches pushes).
  // LIVE entries drive the stop-choice: cancelling the assistant turn alone
  // would leave the driven client agents running (or wake it on completion).
  const [dispatches, setDispatches] = useState<AssistantDispatchView[]>([]);
  useEffect(() => {
    setDispatches([]);
  }, [sessionId]);
  const liveDispatches = dispatches.filter(
    (d) => d.status === 'starting' || d.status === 'running',
  );

  const refreshSessions = useCallback(() => {
    // The push hook owns the rail's truth; this exists to re-ask after a
    // config page round-trip (a deleted config changes what can open).
    const socket = appSocket();
    socket.emit('assistant:sessions.sync', {}, () => undefined);
  }, []);

  const raceBufferRef = useRef(new Map<string, OpenRaceBuffer>());

  // STABLE (non-keyed) listener — buffers the open-race pushes.
  useEffect(() => {
    const socket = appSocket();
    const entry = (sid: string): OpenRaceBuffer => {
      let e = raceBufferRef.current.get(sid);
      if (e === undefined) {
        if (raceBufferRef.current.size >= 16) {
          const oldest = raceBufferRef.current.keys().next().value;
          if (oldest !== undefined) raceBufferRef.current.delete(oldest);
        }
        e = {};
        raceBufferRef.current.set(sid, e);
      }
      return e;
    };
    const onHistory = (push: AssistantHistoryEvent): void => {
      entry(push.sessionId).history = push.items;
    };
    const onEvent = (envelope: AssistantEventEnvelope): void => {
      if (envelope.event.kind === 'session_config') entry(envelope.sessionId).configDone = true;
    };
    socket.on('assistant:history', onHistory);
    socket.on('assistant:event', onEvent);
    return () => {
      socket.off('assistant:history', onHistory);
      socket.off('assistant:event', onEvent);
    };
  }, []);

  // Reset the pane whenever the channel changes; replay the buffered pushes.
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (sessionId === '') {
      setPhase('idle');
      return;
    }
    setPhase('ready');
    const buffered = raceBufferRef.current.get(sessionId);
    if (buffered === undefined) return;
    raceBufferRef.current.delete(sessionId);
    if (buffered.history !== undefined) dispatch({ type: 'history', items: buffered.history });
    // configDone: the session_config push raced ahead; ask the server to
    // re-emit it (idempotent, room-scoped).
    if (buffered.configDone === true) {
      appSocket().emit('assistant:session.sync', { sessionId }, () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // #66 — silent /app reconnect (weak network, lock screen): the socket lost
  // every chan-room membership while this pane stayed mounted. Re-sync the
  // open session; the server re-joins the socket, re-pushes ready + history
  // (+ the in-flight turn's ring), so the timeline continues seamlessly.
  useEffect(() => {
    if (sessionId === '') return;
    return onAppResubscribe(() => {
      appSocket().emit('assistant:session.sync', { sessionId }, () => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live wiring — the assistant:* family.
  useEffect(() => {
    if (sessionId === '') return;
    const socket = appSocket();
    const onEvent = (envelope: AssistantEventEnvelope): void => {
      if (envelope.sessionId !== sessionId) return;
      dispatch({ type: 'event', event: envelope.event });
    };
    const onHistory = (push: AssistantHistoryEvent): void => {
      if (push.sessionId !== sessionId) return;
      dispatch({ type: 'history', items: push.items });
    };
    const onReady = (push: AssistantReadyPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('ready');
      setError(null);
    };
    const onClosed = (push: AssistantClosedPush): void => {
      if (push.sessionId !== sessionId) return;
      if (push.reason === 'user') {
        setSessionId('');
        return;
      }
      setPhase('closed');
      setError(push.reason);
    };
    // #68 — this session's dispatch snapshot (the stop-choice UI's truth).
    const onDispatches = (push: AssistantDispatchesPush): void => {
      if (push.sessionId !== sessionId) return;
      setDispatches(push.dispatches);
    };
    socket.on('assistant:event', onEvent);
    socket.on('assistant:history', onHistory);
    socket.on('assistant:session.ready', onReady);
    socket.on('assistant:session.closed', onClosed);
    socket.on('assistant:dispatches', onDispatches);
    return () => {
      socket.off('assistant:event', onEvent);
      socket.off('assistant:history', onHistory);
      socket.off('assistant:session.ready', onReady);
      socket.off('assistant:session.closed', onClosed);
      socket.off('assistant:dispatches', onDispatches);
    };
  }, [sessionId]);

  /** Open (or rejoin) a session: `openSession(row.id)` or `openSession()` for new. */
  async function openSession(rejoinId?: string): Promise<void> {
    if (assistantId === '') return;
    setRailOpen(false);
    setError(null);
    // Drop the ?a= hand-off once consumed (it would pin the URL otherwise).
    if (searchParams.get('a') !== null) setSearchParams({}, { replace: true });
    const ack = await emitWithAck<{
      sessionId?: string;
      assistantName?: string;
      error?: string;
    }>('assistant:session.open', {
      assistantId,
      ...(rejoinId !== undefined ? { sessionId: rejoinId } : {}),
    });
    if (ack.error !== undefined || ack.sessionId === undefined) {
      setError(
        ack.error === 'ASSISTANT_NOT_FOUND' || ack.error === 'ASSISTANT_DELETED'
          ? t('assistants.errNoAssistant')
          : (ack.error ?? t('assistants.errUnknown')),
      );
      return;
    }
    setSessionId(ack.sessionId);
  }

  /**
   * #58-3 — the image gate: the CURRENT model entry's registry `vision`
   * flag. The config event's model value is the `providerId/modelId`
   * compound (#58-4), so the lookup spans providers and re-derives the
   * instant a switch settles. Unknown/absent = gated off (honest default).
   */
  const modelCurrentValue = conversation.config.configOptions?.find(
    (o) => o.category === 'model',
  )?.currentValue;
  const imageSupported = useMemo(() => {
    if (providers === null || modelCurrentValue === undefined) return false;
    const slash = modelCurrentValue.indexOf('/');
    const pid = slash === -1 ? '' : modelCurrentValue.slice(0, slash);
    const mid = modelCurrentValue.slice(slash + 1);
    return providers.find((p) => p.id === pid)?.models.find((m) => m.id === mid)?.vision === true;
  }, [providers, modelCurrentValue]);

  /** Compress + append picked/pasted/dropped images (the 9 W9 B path). */
  async function addImages(files: File[]): Promise<void> {
    for (const file of files) {
      if (attachments.length >= MAX_IMAGES_PER_TURN) {
        toast.error(t('chat.imageCountLimit', { count: MAX_IMAGES_PER_TURN }));
        return;
      }
      try {
        const attachment = await fileToAttachment(file);
        if (attachmentsBytes([...attachments, attachment]) > MAX_TOTAL_IMAGE_BYTES) {
          toast.error(t('chat.imageBudget'));
          return;
        }
        setAttachments((prev) => [...prev, attachment]);
      } catch (e) {
        if (e instanceof ImageAttachError_) {
          toast.error(
            e.code === 'too-large'
              ? t('chat.imageTooLarge', { name: e.name_ })
              : e.code === 'bad-type'
                ? t('chat.imageBadType', { name: e.name_ })
                : t('chat.imageDecodeFailed', { name: e.name_ }),
          );
        }
      }
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if ((text === '' && attachments.length === 0) || sessionId === '' || phase !== 'ready') return;
    const blocks: UserBlock[] = [
      ...(text !== '' ? [{ type: 'text' as const, text }] : []),
      ...attachments.map((a) => ({
        type: 'image' as const,
        data: a.data,
        mimeType: a.mimeType,
      })),
    ];
    setDraft('');
    setAttachments([]);
    const ack = await emitWithAck<{ accepted?: boolean; queued?: boolean; error?: string }>(
      'assistant:message.send',
      { sessionId, content: blocks },
    );
    if (ack.error !== undefined) {
      // The turn never started — put everything back so nothing is lost.
      setDraft(text);
      setAttachments(attachments);
      toast.error(ack.error === 'QUEUE_FULL' ? t('chat.queueFull') : ack.error);
    } else if (ack.queued === true) {
      toast.info(t('chat.queuedToast'));
    }
  }

  async function queueCancel(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('assistant:queue.cancel', { sessionId });
  }

  function queueEdit(): void {
    const parked = conversation.queued;
    if (parked === null) return;
    const text = parked
      .filter((b): b is Extract<PromptBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text !== '') setDraft(text);
    void queueCancel();
  }

  async function cancelTurn(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('assistant:turn.cancel', { sessionId });
  }

  // #68 — a turn with LIVE dispatches stops by CHOICE: only the driven client
  // agents (this turn keeps running and learns the stop through the backflow),
  // or both (clients FIRST — a completing client would otherwise wake the
  // aborted turn — then this turn). The cancels ride the ordinary chat verb,
  // so each one lands in the assistant session as a user-stopped note.
  const [stopChoice, setStopChoice] = useState(false);
  async function stopDispatchedClients(): Promise<void> {
    for (const d of liveDispatches) {
      await emitWithAck('chat:turn.cancel', { sessionId: d.channelId });
    }
  }
  function requestStop(): void {
    if (liveDispatches.length > 0) setStopChoice(true);
    else void cancelTurn();
  }

  async function configSet(set: ChatConfigSetPayload): Promise<void> {
    if (sessionId === '' || set.kind !== 'option') return;
    const ack = await emitWithAck<{ accepted?: boolean; error?: string }>('assistant:config.set', {
      sessionId,
      kind: 'option',
      configId: set.configId,
      value: set.value,
    });
    if (ack.error !== undefined) {
      toast.error(t('chat.configSetFailed', { error: ack.error }));
      return;
    }
    if (set.configId === 'agent') {
      localStorage.setItem(AGENT_KEY, set.value);
      void refreshAssistants();
    }
  }

  /** Stop viewing — the session row persists, the live channel ends. */
  async function disconnect(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('assistant:session.close', { sessionId, reason: 'user' });
    setSessionId('');
    refreshSessions();
  }

  // #55 — platform session deletion: the rail asks (hover trash / swipe),
  // the page confirms. Rows that are live (viewed) or busy never offer it.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const deleteSession = async (): Promise<void> => {
    if (pendingDelete === null) return;
    try {
      await withAuthGuard(() => api.deleteAssistantSession(pendingDelete.id), logout);
    } catch (e) {
      toast.error(
        t('chat.deleteFailed', {
          error: e instanceof HarnessNexusError ? e.message : String(e),
        }),
      );
    }
    setPendingDelete(null);
    // The server pushes the fresh snapshot on success; refetch covers the
    // error path leaving a stale row behind.
    refreshSessions();
  };

  usePageTitle(assistant !== null ? assistant.name : t('assistants.endAssistant'));

  const sortedSessions = useMemo(() => [...sessions].reverse(), [sessions]);

  /** #54 — the welcome's recent cards: this config's conversations, newest
   *  first (the sessions push arrives newest-first from the server). */
  const welcomeCards = useMemo<WelcomeCard[]>(
    () =>
      sessions
        .filter((s) => s.assistantId === assistantId)
        .slice(0, 5)
        .map((s) => ({
          id: s.id,
          title: s.title !== '' ? s.title : t('chat.untitled'),
          timeLabel: relativeTime(s.lastMessageAt ?? s.updatedAt, dateLocale(lang)),
          onClick: () => void openSession(s.id),
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, assistantId, t, lang],
  );

  // The rail renders TWICE (desktop aside + phone drawer) with one flag:
  // only the drawer's picks carry the ?rail hand-off.
  const rail = (inDrawer: boolean) => (
    <>
      <div className="flex items-center gap-1 border-b px-2 py-2.5">
        <EndSwitcher current="assistant" fromDrawer={inDrawer} />
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-(--control-h-sm) shrink-0"
          title={t('common.refresh')}
          onClick={refreshSessions}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="border-b p-3">
        <Button
          className="w-full"
          size="sm"
          onClick={() => void openSession()}
          disabled={assistantId === ''}
        >
          <PlusIcon className="size-4" />
          {t('assistants.newAssistantSession')}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sortedSessions.length === 0 ? (
          <p className="text-muted-foreground px-2 py-4 text-xs">{t('assistants.noSessions')}</p>
        ) : (
          sortedSessions.map((s) => {
            const active = s.id === sessionId;
            // #55 — the delete affordance skips rows the server would refuse:
            // the viewed one holds a live channel, a busy one is mid-turn.
            const deletable = !active && !s.busy;
            return (
              <SessionRow
                key={s.id}
                deleteLabel={t('chat.deleteSessionAction')}
                onDelete={
                  deletable
                    ? () => setPendingDelete({ id: s.id, title: s.title || t('chat.untitled') })
                    : undefined
                }
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!active) void openSession(s.id);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 border-b px-3 py-2 text-left last:border-b-0',
                    active ? 'bg-tray' : 'hover:bg-tray/60',
                  )}
                  title={s.title || t('chat.untitled')}
                >
                  <span className="mt-1 flex w-2 shrink-0 justify-center">
                    <StateSignal
                      state={s.busy ? 'busy' : active ? 'live' : 'idle'}
                      className="size-1.5"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-xs',
                        active && 'text-foreground font-semibold',
                      )}
                    >
                      {s.title || t('chat.untitled')}
                    </span>
                    <DataText size="sm" tone="dim" className="mt-0.5 block truncate">
                      {relativeTime(s.lastMessageAt ?? s.updatedAt, dateLocale(lang))} ·{' '}
                      {s.id.slice(0, 8)}
                    </DataText>
                  </span>
                </button>
              </SessionRow>
            );
          })
        )}
      </div>
    </>
  );

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <ChannelTabs
          channels={channels}
          activeSessionId={sessionId}
          assistantBusy={sessions.filter((s) => s.busy)}
          onActivateAssistant={(s) => {
            if (s.id !== sessionId) void openSession(s.id);
          }}
          onStopAssistant={(s) => {
            void emitWithAck('assistant:turn.cancel', { sessionId: s.id });
          }}
          onActivate={(ch) => navigate(`/chat/agents/${ch.agentInstanceId}?ch=${ch.sessionId}`)}
          onClose={(ch) =>
            void emitWithAck('chat:session.close', { sessionId: ch.sessionId, reason: 'user' })
          }
          onCleanup={(idleOnly) => {
            void emitWithAck('chat:channels.closeAll', { idleOnly }).then((res) =>
              toast.success(
                t('chat.tabsCleanupDone', {
                  closed: (res as { closed?: number }).closed ?? 0,
                  deferred: (res as { deferred?: number }).deferred ?? 0,
                }),
              ),
            );
          }}
        />
        <div className="flex h-full min-h-0">
          <aside className="bg-sidebar/40 hidden w-72 shrink-0 flex-col border-r md:flex">
            {rail(false)}
          </aside>
          <DialogPrimitive.Root open={railOpen} onOpenChange={setRailOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="bg-scrim/45 absolute inset-0 z-40 md:hidden" />
              <DialogPrimitive.Content
                className="bg-background text-foreground absolute inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r shadow-lg md:hidden"
                aria-description={t('chat.railOpen')}
              >
                {rail(true)}
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 md:hidden"
                aria-label={t('chat.railOpen')}
                onClick={() => setRailOpen(true)}
              >
                <ListIcon className="size-4" />
              </Button>
              <BotIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate text-sm font-medium">
                {assistant?.name ?? t('assistants.endAssistant')}
              </span>
              {phase === 'ready' && conversation.turnActive ? (
                <span className="text-signal flex items-center gap-1.5 text-xs">
                  <StateSignal state="live" pulse className="size-1.5 shrink-0" />
                  {t('chat.working')}
                </span>
              ) : null}
              {phase === 'closed' ? (
                <span className="text-muted-foreground truncate text-xs">
                  {error ?? t('chat.closed')}
                </span>
              ) : null}
              <span className="min-w-0 flex-1" />
              {phase === 'ready' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void disconnect()}
                  title={t('chat.disconnectHint')}
                >
                  <XIcon className="size-3.5" />
                  <span className="hidden sm:inline">{t('chat.disconnect')}</span>
                </Button>
              ) : null}
            </div>

            {noAssistants ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <EmptyState
                  title={t('assistants.noAssistants')}
                  hint={t('assistants.noAssistantsHint')}
                  action={
                    <Button asChild size="sm" className="gap-1.5">
                      <Link to="/assistants">{t('assistants.createAssistantCta')}</Link>
                    </Button>
                  }
                />
              </div>
            ) : sessionId === '' ? (
              // #54 — the rich welcome replaces the empty stream + sender:
              // the button and the recent-conversation cards are the entries.
              <WelcomePane
                greeting={t('chat.welcomeGreeting')}
                sub={t('chat.welcomeSub')}
                actionLabel={t('assistants.newAssistantSession')}
                onAction={() => void openSession()}
                cards={welcomeCards}
              />
            ) : (
              <>
                {error !== null && phase !== 'closed' ? (
                  <p className="text-destructive border-destructive/30 bg-destructive/5 border-b px-4 py-2 text-xs">
                    {error}
                  </p>
                ) : null}

                <ChatStream
                  state={conversation}
                  cwd={undefined}
                  onPermissionRespond={(requestId, optionId) => {
                    void emitWithAck('assistant:permission.respond', {
                      sessionId,
                      requestId,
                      ...(optionId !== undefined ? { optionId } : {}),
                    });
                  }}
                  onElicitationRespond={() => undefined}
                />

                <div className="shrink-0 p-3">
                  <div className="mx-auto w-full max-w-3xl">
                    <TodoPanel entries={conversation.plan ?? []} />
                    {conversation.queued !== null ? (
                      <div className="mb-2 flex justify-end">
                        <span
                          className="bg-background inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs shadow-sm"
                          title={t('chat.queuedLabel')}
                        >
                          <span className="text-muted-foreground shrink-0">
                            {t('chat.queuedLabel')}
                          </span>
                          <span className="truncate font-mono">
                            {conversation.queued
                              .filter((b) => b.type === 'text')
                              .map((b) => (b as { text: string }).text)
                              .join(' ')
                              .slice(0, 120)}
                          </span>
                          <button
                            type="button"
                            onClick={queueEdit}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                            aria-label={t('chat.queuedEditAria')}
                            title={t('chat.queuedEditAria')}
                          >
                            <PencilIcon className="size-3" />
                          </button>
                        </span>
                      </div>
                    ) : null}
                    <Composer
                      value={draft}
                      onChange={setDraft}
                      phase={phase}
                      turnActive={conversation.turnActive}
                      usage={conversation.usage}
                      onSend={() => void send()}
                      onCancel={requestStop}
                      attachments={attachments}
                      fileRefs={[]}
                      onRemoveAttachment={(id) =>
                        setAttachments((prev) => prev.filter((a) => a.id !== id))
                      }
                      onRemoveFileRef={() => undefined}
                      onPickImages={(files) => void addImages(files)}
                      onOpenFilePicker={() => undefined}
                      filePickerAvailable={false}
                      imageSupported={imageSupported}
                      config={conversation.config satisfies ComposerConfig}
                      onConfigSet={(set) => void configSet(set)}
                      commands={conversation.commands}
                    />
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      {pendingDelete !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPendingDelete(null);
          }}
          title={t('chat.deleteSessionTitle')}
          consequence={t('chat.deleteSessionConsequence')}
          impact={[{ value: pendingDelete.title }]}
          actionLabel={t('chat.deleteSessionAction')}
          tone="danger"
          irreversible
          onConfirm={() => void deleteSession()}
        />
      ) : null}

      {stopChoice ? (
        <ConfirmDialog
          open
          onOpenChange={setStopChoice}
          title={t('assistants.stopChoiceTitle')}
          consequence={t('assistants.stopChoiceConsequence', { count: liveDispatches.length })}
          actionLabel={t('assistants.stopAll')}
          secondaryAction={{
            label: t('assistants.stopClientsOnly'),
            onAction: () => {
              setStopChoice(false);
              void stopDispatchedClients();
            },
          }}
          hazard
          irreversible={false}
          onConfirm={() => {
            setStopChoice(false);
            void (async () => {
              await stopDispatchedClients();
              await cancelTurn();
            })();
          }}
        />
      ) : null}
    </>
  );
}
