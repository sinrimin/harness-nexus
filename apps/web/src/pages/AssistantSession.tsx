import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { BotIcon, ListIcon, PlusIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { StateSignal } from '@/components/state-signal';
import { DataText, EmptyState } from '@/components/kit';
import {
  appSocket,
  emitWithAck,
  type AssistantClosedPush,
  type AssistantEventEnvelope,
  type AssistantHistoryEvent,
  type AssistantReadyPush,
} from '@/realtime';
import type { AssistantConfigView } from '@harness-nexus/sdk';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ChatStream } from '@/components/chat/chat-stream.js';
import { ChannelTabs } from '@/components/chat/channel-tabs.js';
import { useChatChannels } from '@/components/chat/use-chat-channels.js';
import { useAssistantSessions } from '@/components/chat/use-assistant-sessions.js';
import { Composer, type ComposerConfig } from '@/components/chat/composer.js';
import { usePageTitle } from '@/components/shell/page-slots';
import { TodoPanel } from '@/components/chat/todo-panel.js';
import { EndSwitcher } from '@/components/chat/end-switcher.js';
import { createFoldState, fold, type UserBlock } from '@/components/chat/fold.js';
import type { ChatConfigSetPayload, PromptBlock } from '@/realtime';

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

  // The 端's default agent: ?a= (a picker hand-off) → the pinned one → the
  // first config. Persisted so the next visit opens where the user left off.
  const assistantId =
    searchParams.get('a') ?? localStorage.getItem(AGENT_KEY) ?? assistants?.[0]?.id ?? '';
  const assistant = useMemo(
    () => assistants?.find((c) => c.id === assistantId) ?? null,
    [assistants, assistantId],
  );
  useEffect(() => {
    if (assistantId !== '') localStorage.setItem(AGENT_KEY, assistantId);
  }, [assistantId]);

  const refreshSessions = useCallback(() => {
    // The push hook owns the rail's truth; this exists to re-ask after a
    // config page round-trip (a deleted config changes what can open).
    const socket = appSocket();
    socket.emit('assistant:sessions.sync', {}, () => undefined);
  }, []);

  // Reset the pane whenever the channel changes.
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (sessionId === '') {
      setPhase('idle');
      return;
    }
    setPhase('ready');
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
    socket.on('assistant:event', onEvent);
    socket.on('assistant:history', onHistory);
    socket.on('assistant:session.ready', onReady);
    socket.on('assistant:session.closed', onClosed);
    return () => {
      socket.off('assistant:event', onEvent);
      socket.off('assistant:history', onHistory);
      socket.off('assistant:session.ready', onReady);
      socket.off('assistant:session.closed', onClosed);
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
          : (ack.error ?? 'unknown error'),
      );
      return;
    }
    setSessionId(ack.sessionId);
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text === '' || sessionId === '' || phase !== 'ready') return;
    setDraft('');
    const blocks: UserBlock[] = [{ type: 'text', text }];
    const ack = await emitWithAck<{ accepted?: boolean; queued?: boolean; error?: string }>(
      'assistant:message.send',
      { sessionId, content: blocks },
    );
    if (ack.error !== undefined) {
      setDraft(text);
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

  usePageTitle(assistant !== null ? assistant.name : t('assistants.endAssistant'));

  const sortedSessions = useMemo(() => [...sessions].reverse(), [sessions]);

  const rail = (
    <>
      <div className="flex items-center gap-1 border-b px-2 py-2.5">
        <EndSwitcher current="assistant" />
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
            return (
              <button
                key={s.id}
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
                    {relativeTime(s.lastMessageAt ?? s.updatedAt, dateLocale(lang))}
                  </DataText>
                </span>
              </button>
            );
          })
        )}
      </div>
    </>
  );

  if (loaded && (assistants ?? []).length === 0) {
    return (
      <EmptyState
        title={t('assistants.noAssistants')}
        hint={t('assistants.noAssistantsHint')}
        action={
          <Button asChild size="sm" className="gap-1.5">
            <Link to="/assistants">{t('assistants.createAssistantCta')}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <ChannelTabs
          channels={channels}
          activeSessionId=""
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
            {rail}
          </aside>
          <DialogPrimitive.Root open={railOpen} onOpenChange={setRailOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="bg-scrim/45 absolute inset-0 z-40 md:hidden" />
              <DialogPrimitive.Content
                className="bg-background text-foreground absolute inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r shadow-lg md:hidden"
                aria-description={t('chat.railOpen')}
              >
                {rail}
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

            {error !== null && phase !== 'closed' ? (
              <p className="text-destructive border-destructive/30 bg-destructive/5 border-b px-4 py-2 text-xs">
                {error}
              </p>
            ) : null}

            <ChatStream
              state={conversation}
              cwd={undefined}
              onPermissionRespond={() => undefined}
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
                      >
                        <XIcon className="size-3" />
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
                  onCancel={() => void cancelTurn()}
                  attachments={[]}
                  fileRefs={[]}
                  onRemoveAttachment={() => undefined}
                  onRemoveFileRef={() => undefined}
                  onPickImages={() => undefined}
                  onOpenFilePicker={() => undefined}
                  imageSupported={false}
                  config={conversation.config satisfies ComposerConfig}
                  onConfigSet={(set) => void configSet(set)}
                  commands={conversation.commands}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
