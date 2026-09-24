import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  ListIcon,
  BotIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { StateSignal } from '@/components/state-signal';
import {
  appSocket,
  emitWithAck,
  type ChatChannelView,
  type ChatEventEnvelope,
  type ChatHistoryEvent,
  type ChatSessionClosedPush,
  type ChatSessionFailedPush,
  type ChatSessionReadyPush,
} from '@/realtime';
import {
  HarnessNexusError,
  type AgentInstanceMachineView,
  type AgentInstanceView,
  type NativeSessionView,
} from '@harness-nexus/sdk';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ChatStream } from '@/components/chat/chat-stream.js';
import { ChannelTabs } from '@/components/chat/channel-tabs.js';
import { useChatChannels } from '@/components/chat/use-chat-channels.js';
import {
  Composer,
  queuedPreview,
  type ComposerConfig,
  type DraftFileRef,
} from '@/components/chat/composer.js';
import { usePageTitle } from '@/components/shell/page-slots';
import { TodoPanel } from '@/components/chat/todo-panel.js';
import { DirPicker } from '@/components/chat/dir-picker.js';
import { FilePicker } from '@/components/chat/file-picker.js';
import {
  attachmentsBytes,
  fileToAttachment,
  ImageAttachError_,
  MAX_IMAGES_PER_TURN,
  MAX_TOTAL_IMAGE_BYTES,
  type DraftAttachment,
} from '@/components/chat/image-attach.js';
import { createFoldState, fold, type UserBlock } from '@/components/chat/fold.js';
import type { ChatConfigSetPayload, PromptBlock } from '@/realtime';

/**
 * The Agent session page (Phase 9 W6, rewired 9 W7) — left: the AGENT'S OWN
 * session list (fetched live from the target's native store through the
 * daemon; grouped by workspace cwd; click = RESUME). Right: the portal-style
 * row stream + composer. The platform persists nothing session-shaped:
 * "disconnect" ends the channel only — the conversation stays with the agent.
 * The live-turn indicator is this view's single `--signal` spend.
 */

type Phase = 'idle' | 'connecting' | 'ready' | 'closed';

/**
 * Rejoin pushes that raced the open ack (9 W11, user-found): the server
 * re-pushes `ready` + resync history while processing `chat:session.open`,
 * which can arrive BEFORE this page re-attaches its sessionId-keyed
 * listeners (switching tabs mid-conversation occasionally left the pane
 * empty forever — nothing ever re-delivers the history). The stable
 * listener below buffers the LATEST per-session pushes; the sessionId
 * effect replays them after the pane reset. Terminal markers win over
 * `ready` (applied last).
 */
interface SwitchRaceBuffer {
  ready?: ChatSessionReadyPush;
  failed?: ChatSessionFailedPush;
  closed?: ChatSessionClosedPush;
  history?: ChatHistoryEvent['items'];
}

/** Rail data: the daemon-routed listing or the gate that blocked it. */
type RailState =
  | { state: 'loading' }
  | { state: 'ready'; supported: boolean; sessions: NativeSessionView[] }
  | { state: 'offline' }
  | { state: 'daemon-old' }
  | { state: 'error'; message: string };

interface SessionGroup {
  cwd: string;
  sessions: NativeSessionView[];
  newest: number;
}

function groupSessions(sessions: NativeSessionView[]): SessionGroup[] {
  const map = new Map<string, NativeSessionView[]>();
  for (const s of sessions) {
    const list = map.get(s.cwd);
    if (list === undefined) map.set(s.cwd, [s]);
    else list.push(s);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of map) {
    list.sort(
      (a, b) =>
        (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) ||
        b.sessionId.localeCompare(a.sessionId),
    );
    groups.push({ cwd, sessions: list, newest: Date.parse(list[0]!.updatedAt ?? '') || 0 });
  }
  groups.sort((a, b) => b.newest - a.newest);
  return groups;
}

function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const last = trimmed.split('/').pop();
  return last === undefined || last === '' ? cwd : last;
}

function relativeTime(iso: string | null | undefined, locale: string): string {
  if (iso === undefined || iso === null || iso === '') return '';
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

/**
 * #10 — the parked queue slot, floating ABOVE the Sender card (right-aligned:
 * it is the user's next outgoing message). Kept OUT of the composer — inside
 * it the chip read as an attachment preview — and OUT of the row stream: it
 * is a sender affordance, not a transcript row. Pending semantics stay
 * honest: dashed border + clock, never the solid look of a sent message.
 */
function QueuedMessage({
  blocks,
  onEdit,
  onCancel,
}: {
  blocks: PromptBlock[];
  onEdit: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="animate-in fade-in slide-in-from-bottom-1 mb-2 flex justify-end duration-200">
        <span
          className="bg-background inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs shadow-sm"
          title={t('chat.queuedLabel')}
        >
          <ClockIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground shrink-0">{t('chat.queuedLabel')}</span>
          <span className="truncate font-mono">{queuedPreview(blocks)}</span>
          <span className="bg-border mx-0.5 h-3.5 w-px shrink-0" />
          <button
            type="button"
            onClick={onEdit}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label={t('chat.queuedEditAria')}
            title={t('chat.queuedEditAria')}
          >
            <PencilIcon className="size-3" />
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label={t('chat.queuedCancelAria')}
            title={t('chat.queuedCancelAria')}
          >
            <XIcon className="size-3.5" />
          </button>
        </span>
      </div>
    </>
  );
}

/**
 * The session rail: new session + the agent's native sessions grouped by cwd.
 *
 * Rendered TWICE (P5): as the left column from `md` up, and inside the phone's
 * drawer below it — before this the rail was `hidden md:flex` with no
 * alternative, so a phone could not reach a session that already existed.
 *
 * The rail is pure presentation over data the page owns: every callback is
 * passed in, and the live-channel overlay (`channelByNative`) is the page's
 * map, not a second subscription.
 */
function SessionRail({
  rail,
  groups,
  collapsedCwds,
  nativeSessionId,
  firstPromptText,
  machine,
  channelByNative,
  onToggleCwd,
  onOpenChannel,
  onNewSession,
  onRefresh,
  showBack,
}: {
  rail: RailState;
  groups: SessionGroup[];
  collapsedCwds: Set<string>;
  nativeSessionId: string | null;
  firstPromptText: string | null;
  machine: AgentInstanceMachineView | null;
  channelByNative: Map<string, ChatChannelView>;
  onToggleCwd: (cwd: string) => void;
  onOpenChannel: (
    rejoinId?: string,
    directory?: string,
    resume?: { sessionId: string; cwd: string },
  ) => Promise<void>;
  onNewSession: () => void;
  onRefresh: () => void;
  /** The drawer keeps no back-to-list button: closing it IS the way back. */
  showBack?: boolean;
}) {
  const { t, lang } = useI18n();
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        {showBack === true ? (
          <Button asChild variant="ghost" size="sm" className="gap-1.5 px-2">
            <Link to="/chat">
              <ArrowLeftIcon className="size-3.5" />
              <span className="text-xs">{t('chat.backToAgents')}</span>
            </Link>
          </Button>
        ) : null}
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={t('common.refresh')}
          onClick={() => void onRefresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="border-b p-3">
        <Button
          className="w-full"
          size="sm"
          onClick={() => onNewSession()}
          disabled={machine === null || !machine.online || !machine.remoteChatEnabled}
        >
          <PlusIcon className="size-4" />
          {t('chat.newSession')}
        </Button>
        <p className="text-muted-foreground mt-1.5 text-center text-[11px]">
          {t('chat.disconnectHint')}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rail.state === 'loading' ? (
          <p className="text-muted-foreground px-2 py-4 text-xs">{t('common.loading')}</p>
        ) : rail.state === 'offline' ? (
          <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.sessionsOffline')}</p>
        ) : rail.state === 'daemon-old' ? (
          <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.sessionsDaemonOld')}</p>
        ) : rail.state === 'error' ? (
          <p className="text-muted-foreground px-2 py-4 text-xs">{rail.message}</p>
        ) : !rail.supported && rail.sessions.length === 0 ? (
          <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.sessionsUnsupported')}</p>
        ) : (
          <>
            {/* 9 W13 — even where the agent keeps no listable native
                      history (opencode), live channels are real, rejoinable
                      rows: render them instead of hiding the rail. */}
            {!rail.supported ? (
              <p className="text-muted-foreground px-2 pt-2 text-[11px]">
                {t('chat.sessionsUnsupportedPartial')}
              </p>
            ) : null}
            {groups.length === 0 ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.noSessions')}</p>
            ) : (
              groups.map((group) => {
                // #13 — folders COLLAPSE (ZCode-style); per-cwd state,
                // default open.
                const collapsed = collapsedCwds.has(group.cwd);
                return (
                  <div key={group.cwd} className="mb-1">
                    {/* Folder header: click toggles; hover reveals the
                            new-session button which starts a channel with
                            THIS cwd — no picker round-trip. */}
                    <div className="group/folder text-muted-foreground flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
                        title={group.cwd}
                        onClick={() => onToggleCwd(group.cwd)}
                      >
                        <ChevronRightIcon
                          className={cn(
                            'size-3 shrink-0 transition-transform',
                            !collapsed && 'rotate-90',
                          )}
                        />
                        <FolderIcon className="size-3 shrink-0" />
                        <span className="truncate">{cwdBasename(group.cwd)}</span>
                      </button>
                      <button
                        type="button"
                        className="hover:text-foreground shrink-0 opacity-0 group-hover/folder:opacity-100"
                        title={t('chat.newSessionHere', { dir: cwdBasename(group.cwd) })}
                        aria-label={t('chat.newSessionHere', { dir: cwdBasename(group.cwd) })}
                        onClick={() => void onOpenChannel(undefined, group.cwd)}
                      >
                        <PlusIcon className="size-3.5" />
                      </button>
                    </div>
                    {!collapsed
                      ? group.sessions.map((s) => {
                          const active = s.sessionId === nativeSessionId;
                          const stale = s.staleReason !== undefined;
                          // Live truth ONLY (#13 fix): the listing's
                          // `openChannelId` stamp is a moment-in-time
                          // snapshot that goes stale the moment a channel
                          // closes elsewhere (the user-wide `chat:channels`
                          // push is already realtime for every window), so
                          // consulting it left a dead blue dot on the row.
                          // The channel map IS the open state.
                          const attached = channelByNative.get(s.sessionId);
                          // #12 — RUNNING is the attached channel's live busy
                          // flag: a green dot, never gated on the row merely
                          // being viewed.
                          const running = attached?.busy === true;
                          return (
                            <button
                              key={s.sessionId}
                              type="button"
                              disabled={stale && !active}
                              onClick={() => {
                                if (active || stale) return;
                                // With a live channel this is a REJOIN;
                                // without one (fresh page, or after a
                                // server restart — channels are
                                // server-memory only) it is a fresh RESUME
                                // of the same native session. Both keep the
                                // row's promise: open this conversation
                                // (#22 — the no-channel case used to be a
                                // silent no-op).
                                if (attached !== undefined) {
                                  void onOpenChannel(attached.sessionId, undefined, {
                                    sessionId: s.sessionId,
                                    cwd: s.cwd,
                                  });
                                } else {
                                  void onOpenChannel(undefined, undefined, {
                                    sessionId: s.sessionId,
                                    cwd: s.cwd,
                                  });
                                }
                              }}
                              className={cn(
                                'flex w-full items-center gap-1 rounded-md py-1 pl-4 pr-1.5 text-left text-xs',
                                active
                                  ? 'bg-accent'
                                  : stale
                                    ? 'cursor-default'
                                    : 'hover:bg-accent/60',
                                stale && !active && 'opacity-50',
                              )}
                              title={
                                stale
                                  ? t('chat.staleModel', { model: s.model ?? '?' })
                                  : attached !== undefined && !active
                                    ? t('chat.channelOpenHint')
                                    : (s.title ?? s.cwd)
                              }
                            >
                              {/* The status gutter: green running, blue
                                      opened, empty otherwise (#12/#13). */}
                              <span className="flex w-2 shrink-0 justify-center">
                                <StateSignal
                                  state={
                                    running ? 'busy' : attached !== undefined ? 'live' : 'idle'
                                  }
                                  className="size-1.5"
                                />
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {s.title ??
                                  (s.sessionId === nativeSessionId ? firstPromptText : undefined) ??
                                  t('chat.untitled')}
                              </span>
                              <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                                {relativeTime(s.updatedAt, dateLocale(lang))}
                              </span>
                            </button>
                          );
                        })
                      : null}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </>
  );
}

export function AgentSessionPage() {
  const { agentId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [agent, setAgent] = useState<AgentInstanceView | null>(null);
  const [machine, setMachine] = useState<AgentInstanceMachineView | null>(null);
  // Phone-only drawer holding the same rail (P5) — the rail is `hidden md:flex`
  // and used to have no narrow-screen alternative at all.
  const [railOpen, setRailOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rail, setRail] = useState<RailState>({ state: 'loading' });
  const [sessionId, setSessionId] = useState('');
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // #13 — collapsed cwd groups on the session rail (ZCode-style folders).
  const [collapsedCwds, setCollapsedCwds] = useState<Set<string>>(new Set());
  const toggleCwd = (cwd: string): void => {
    setCollapsedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };
  // 9 W9 — composer controls state.
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [fileRefs, setFileRefs] = useState<DraftFileRef[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  /** From the ready push's promptCapabilities — gates image attach. */
  const [imageSupported, setImageSupported] = useState(false);
  const [conversation, dispatch] = useReducer(fold, undefined, createFoldState);
  /** 9 W11 B — the tab strip's live-channel truth (snapshot pushes). */
  const channels = useChatChannels();
  /** Phase carried by an open ack (consumed by the sessionId effect). */
  const pendingPhaseRef = useRef<'ready' | null>(null);
  /**
   * The live channel id, for row hops WITHIN the page (leave-before-enter)
   * and the lost-ready-push recovery. Since W11 the page exit no longer
   * closes the channel: the tab bar makes live channels visible and
   * closable (×, 一键清理), and viewer-gone + the machine budget bound them.
   */
  const liveChannelRef = useRef('');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const connectTargetRef = useRef<string | null>(null);
  /** Latest per-session pushes caught by the stable listener below. */
  const switchBufferRef = useRef(new Map<string, SwitchRaceBuffer>());

  // 9 W11 — a STABLE (non-keyed) listener: rejoin pushes can predate the
  // sessionId-keyed listeners' attach; buffer them for the switch replay.
  // Bounded — a wire session id is never reused after close, evicted
  // entries are dead weight only.
  useEffect(() => {
    const socket = appSocket();
    const entry = (sid: string): SwitchRaceBuffer => {
      let e = switchBufferRef.current.get(sid);
      if (e === undefined) {
        if (switchBufferRef.current.size >= 16) {
          const oldest = switchBufferRef.current.keys().next().value;
          if (oldest !== undefined) switchBufferRef.current.delete(oldest);
        }
        e = {};
        switchBufferRef.current.set(sid, e);
      }
      return e;
    };
    const onReady = (push: ChatSessionReadyPush): void => {
      entry(push.sessionId).ready = push;
    };
    const onFailed = (push: ChatSessionFailedPush): void => {
      entry(push.sessionId).failed = push;
    };
    const onClosed = (push: ChatSessionClosedPush): void => {
      entry(push.sessionId).closed = push;
    };
    const onHistory = (push: ChatHistoryEvent): void => {
      entry(push.sessionId).history = push.items;
    };
    socket.on('chat:session.ready', onReady);
    socket.on('chat:session.failed', onFailed);
    socket.on('chat:session.closed', onClosed);
    socket.on('chat:history', onHistory);
    return () => {
      socket.off('chat:session.ready', onReady);
      socket.off('chat:session.failed', onFailed);
      socket.off('chat:session.closed', onClosed);
      socket.off('chat:history', onHistory);
    };
  }, []);

  useEffect(() => {
    setAgent(null);
    setMachine(null);
    setLoadFailed(false);
    setSessionId('');
    setNativeSessionId(null);
    setPhase('idle');
    void (async () => {
      try {
        const res = await withAuthGuard(() => api.getAgentInstance(agentId), logout);
        setAgent(res.agent);
        setMachine(res.machine);
        // Issue #3 — best-effort adapter pre-warm now that the rail is about
        // to render (a resume click is the likely next action). The server
        // acks false when the target's switch is off / unsupported — fire and
        // forget either way.
        appSocket().emit('chat:adapter.prewarm', { agentInstanceId: agentId });
      } catch {
        setLoadFailed(true);
      }
    })();
  }, [agentId, logout]);

  const refreshSessions = useCallback(
    async (bypassCache = false) => {
      if (agentId === '') return;
      try {
        const res = await withAuthGuard(
          () => api.listAgentSessions(agentId, bypassCache ? { refresh: true } : {}),
          logout,
        );
        setRail({ state: 'ready', supported: res.supported, sessions: res.sessions });
      } catch (e) {
        const code = e instanceof HarnessNexusError ? e.code : '';
        if (code === 'MACHINE_OFFLINE') setRail({ state: 'offline' });
        else if (code === 'DAEMON_NO_SESSIONS') setRail({ state: 'daemon-old' });
        else setRail({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
    [agentId, logout],
  );

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // 9 W11 B — arriving via a CHANNEL TAB of another agent: `?ch=<wireId>`
  // rejoins that channel once the agent data loaded (the tab bar stays
  // source-of-truth: if the channel died meanwhile, the rejoin bounces and
  // the rail shows its native session for a fresh resume).
  const chParam = searchParams.get('ch');
  useEffect(() => {
    if (chParam === null || agentId === '' || agent === null) return;
    setSearchParams({}, { replace: true });
    void openChannel(chParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chParam, agentId, agent]);

  // Reset the pane whenever the channel changes.
  useEffect(() => {
    dispatch({ type: 'reset' });
    setNativeSessionId(null);
    setAttachments([]);
    setFileRefs([]);
    setImageSupported(false);
    if (sessionId === '') {
      setPhase('idle');
      return;
    }
    setPhase(pendingPhaseRef.current === 'ready' ? 'ready' : 'connecting');
    pendingPhaseRef.current = null;
    // Replay the rejoin pushes that raced ahead of this switch (see
    // SwitchRaceBuffer): the buffer holds the LATEST snapshot per session,
    // consumed here so the keyed listeners own everything live afterwards.
    const buffered = switchBufferRef.current.get(sessionId);
    if (buffered === undefined) return;
    switchBufferRef.current.delete(sessionId);
    if (buffered.history !== undefined) dispatch({ type: 'history', items: buffered.history });
    if (buffered.ready !== undefined) {
      setPhase('ready');
      if (buffered.ready.nativeSessionId !== undefined) {
        setNativeSessionId(buffered.ready.nativeSessionId);
      }
      if (buffered.ready.promptCapabilities?.image === true) setImageSupported(true);
    }
    if (buffered.failed !== undefined) {
      setPhase('closed');
      setError(buffered.failed.error);
    }
    if (buffered.closed !== undefined) {
      setPhase('closed');
      liveChannelRef.current = '';
      if (buffered.closed.reason === 'evicted') setError(t('chat.evicted'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live channel wiring — the same contract as the C5 page, plus 9 W7 history.
  useEffect(() => {
    if (sessionId === '') return;
    const socket = appSocket();
    const onEvent = (envelope: ChatEventEnvelope): void => {
      if (envelope.sessionId !== sessionId) return;
      dispatch({ type: 'event', event: envelope.event });
    };
    const onHistory = (push: ChatHistoryEvent): void => {
      if (push.sessionId !== sessionId) return;
      dispatch({ type: 'history', items: push.items });
    };
    const onReady = (push: ChatSessionReadyPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('ready');
      setError(null);
      if (push.nativeSessionId !== undefined) setNativeSessionId(push.nativeSessionId);
      setImageSupported(push.promptCapabilities?.image === true);
      // Re-list so the just-opened row flips to its 已打开 (channel attached)
      // state instead of still offering a fresh resume.
      void refreshSessions();
    };
    const onFailed = (push: ChatSessionFailedPush): void => {
      if (push.sessionId !== sessionId) return;
      liveChannelRef.current = '';
      setPhase('closed');
      setError(push.error);
    };
    const onClosed = (push: ChatSessionClosedPush): void => {
      if (push.sessionId !== sessionId) return;
      liveChannelRef.current = '';
      // A user-initiated close (tab ×, 断开) needs no tombstone — the pane
      // returns to its welcome state (the reset effect on sessionId==='').
      // Server-side closures keep the closed pane so their reason shows.
      if (push.reason === 'user') {
        setSessionId('');
        void refreshSessions();
        return;
      }
      setPhase('closed');
      // An evicted channel deserves its own explanation — the user did not
      // close anything; the machine's channel budget did.
      if (push.reason === 'evicted') setError(t('chat.evicted'));
      void refreshSessions();
    };
    socket.on('chat:event', onEvent);
    socket.on('chat:history', onHistory);
    socket.on('chat:session.ready', onReady);
    socket.on('chat:session.failed', onFailed);
    socket.on('chat:session.closed', onClosed);
    return () => {
      socket.off('chat:event', onEvent);
      socket.off('chat:history', onHistory);
      socket.off('chat:session.ready', onReady);
      socket.off('chat:session.failed', onFailed);
      socket.off('chat:session.closed', onClosed);
    };
  }, [sessionId, refreshSessions]);

  async function openChannel(
    rejoinId?: string,
    directory?: string,
    resume?: { sessionId: string; cwd: string },
  ): Promise<void> {
    if (agentId === '') return;
    setRailOpen(false);
    setError(null);
    // 9 W11: an open NEVER closes other channels. The pre-tab
    // leave-before-enter (free the CHAT_MAX_SESSIONS_PER_MACHINE slot before
    // the new open is judged) is obsolete — the server EVICTS the oldest
    // non-busy channel at the cap instead of rejecting, and every channel is
    // a visible, closable tab. Closing happens only through explicit actions
    // (tab ×, 断开, 一键清理) or the server's own lifecycle (viewer-gone,
    // eviction, daemon loss).
    const ack = await emitWithAck<{
      sessionId?: string;
      phase?: 'starting' | 'ready';
      error?: string;
    }>('chat:session.open', {
      agentInstanceId: agentId,
      ...(rejoinId !== undefined ? { sessionId: rejoinId } : {}),
      ...(directory !== undefined ? { directory } : {}),
      ...(resume !== undefined ? { resume } : {}),
    });
    if (ack.error !== undefined || ack.sessionId === undefined) {
      const code = ack.error ?? 'unknown error';
      // A rejoin of a rail row whose channel died between listing and click
      // (evicted, disconnected) falls back to a fresh RESUME of the same
      // native session — the row's original promise still holds.
      if (code === 'SESSION_NOT_FOUND' && rejoinId !== undefined && resume !== undefined) {
        await openChannel(undefined, undefined, resume);
        return;
      }
      // The rejoin target is gone and nothing was replaced: surface the
      // error, but the pane stays on the PREVIOUS channel — it was never
      // closed (opens don't close), its listeners are still attached.
      setError(
        code === 'REMOTE_CHAT_DISABLED'
          ? t('chat.errRemoteChatDisabled')
          : code === 'MACHINE_OFFLINE'
            ? t('chat.errMachineOffline')
            : code === 'DAEMON_NO_CHAT'
              ? t('chat.errDaemonNoChat')
              : code === 'SESSION_LIMIT_REACHED'
                ? t('chat.errSessionLimit')
                : code === 'MACHINE_BUSY'
                  ? t('chat.errMachineBusy')
                  : code === 'SESSION_NOT_FOUND'
                    ? t('chat.errSessionGone')
                    : code === 'WORKSPACE_NOT_SET'
                      ? t('chat.errWorkspaceNotSet')
                      : code === 'WORKSPACE_INVALID'
                        ? t('chat.errWorkspaceInvalid')
                        : code,
      );
      return;
    }
    pendingPhaseRef.current = ack.phase === 'ready' ? 'ready' : null;
    liveChannelRef.current = ack.sessionId;
    setSessionId(ack.sessionId);
    if (ack.phase !== 'ready') {
      // One-shot recovery for a ready push lost to the ack/listener race.
      const target = ack.sessionId;
      connectTargetRef.current = target;
      window.setTimeout(() => {
        if (phaseRef.current === 'connecting' && connectTargetRef.current === target) {
          connectTargetRef.current = null;
          void openChannel(target);
        }
      }, 12000);
    }
  }

  /** Draft edits — a trailing `@` opens the file-reference picker (9 W9 C). */
  function changeDraft(value: string): void {
    setDraft(value);
    if (value.endsWith('@') && phase === 'ready' && machine?.baseWorkspace != null) {
      setFilePickerOpen(true);
    }
  }

  /** Compress + append picked/pasted/dropped images (9 W9 B). */
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

  /** A picked workspace file becomes a `resource_link` chip (9 W9 C). */
  function pickFile(file: { name: string; path: string }): void {
    setFileRefs((prev) =>
      prev.some((f) => f.uri === `file://${file.path}`)
        ? prev
        : [...prev, { name: file.name, uri: `file://${file.path}` }],
    );
    // Strip the trailing `@` that opened the picker, if any.
    setDraft((prev) => (prev.endsWith('@') ? prev.slice(0, -1) : prev));
  }

  /** Switch the session's mode / a config option (9 W9 A) — state settles
   *  through session_config events; there is no browser-side optimism. */
  async function configSet(set: ChatConfigSetPayload): Promise<void> {
    if (sessionId === '') return;
    const ack = await emitWithAck<{ accepted?: boolean; error?: string }>('chat:config.set', {
      sessionId,
      ...set,
    });
    if (ack.error !== undefined) {
      toast.error(t('chat.configSetFailed', { error: ack.error }));
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    const canSend = text !== '' || attachments.length > 0 || fileRefs.length > 0;
    if (!canSend || sessionId === '' || phase !== 'ready') return;
    const blocks: UserBlock[] = [
      ...(text !== '' ? [{ type: 'text' as const, text }] : []),
      ...fileRefs.map((f) => ({ type: 'resource_link' as const, name: f.name, uri: f.uri })),
      ...attachments.map((a) => ({
        type: 'image' as const,
        data: a.data,
        mimeType: a.mimeType,
      })),
    ];
    setDraft('');
    setAttachments([]);
    setFileRefs([]);
    // #11 — NO optimistic user row anymore: the server broadcasts a
    // user_message echo to the room on both send paths, and every viewer
    // (sender included) paints the row from that — one source of truth.
    // Mid-turn the message QUEUES instead (#10): the chip is the
    // queue_state projection until the flush echo starts the turn.
    const ack = await emitWithAck<{ accepted?: boolean; queued?: boolean; error?: string }>(
      'chat:message.send',
      {
        sessionId,
        content: blocks,
      },
    );
    if (ack.error !== undefined) {
      // The turn never started — put everything back so nothing is lost.
      setDraft(text);
      setAttachments(attachments);
      setFileRefs(fileRefs);
      toast.error(
        ack.error === 'QUEUE_FULL'
          ? t('chat.queueFull')
          : ack.error === 'MACHINE_BUSY'
            ? t('chat.errMachineBusy')
            : ack.error,
      );
    } else if (ack.queued === true) {
      toast.info(t('chat.queuedToast'));
    }
  }

  /** #10 — drop the parked queue entry (the chip's ×). */
  async function queueCancel(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:queue.cancel', { sessionId });
  }

  /** #10 — "edit" = take the chip back into the draft, then drop the slot. */
  function queueEdit(): void {
    const parked = conversation.queued;
    if (parked === null) return;
    const text = parked
      .filter((b): b is Extract<PromptBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text !== '') setDraft(text);
    setFileRefs(
      parked.flatMap((b) => (b.type === 'resource_link' ? [{ name: b.name, uri: b.uri }] : [])),
    );
    setAttachments((prev) => [
      ...prev,
      ...parked.flatMap((b, i) =>
        b.type === 'image'
          ? [
              {
                id: `queued-${String(i)}`,
                name: `image-${String(i + 1)}`,
                data: b.data,
                mimeType: b.mimeType,
              },
            ]
          : [],
      ),
    ]);
    void queueCancel();
  }

  async function cancelTurn(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:turn.cancel', { sessionId });
  }

  async function respondPermission(requestId: string, optionId?: string): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:permission.respond', {
      sessionId,
      requestId,
      ...(optionId !== undefined ? { optionId } : {}),
    });
  }

  /** 9 W14.1 — answer an agent question; values ride verbatim as ACP content. */
  async function respondElicitation(
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    values?: Record<string, string | number | boolean | string[]>,
  ): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:elicitation.respond', {
      sessionId,
      requestId,
      action,
      ...(values !== undefined ? { values } : {}),
    });
  }

  /** Channel-only teardown — the native session survives (9 W7). The pane
   *  returns to its welcome state (the pane is "empty", not "closed"). */
  async function disconnectChannel(): Promise<void> {
    if (sessionId === '') return;
    liveChannelRef.current = '';
    await emitWithAck('chat:session.close', { sessionId, reason: 'user' });
    setSessionId('');
    void refreshSessions();
  }

  // ---- 9 W11 B — live-channel tab handlers ----

  /** Tab click: same agent → in-page switch keeping the previous channel
   *  alive; another agent → route there and rejoin via `?ch=`. */
  function activateChannel(channel: ChatChannelView): void {
    if (channel.sessionId === sessionId) return;
    if (channel.agentInstanceId === agentId) {
      void openChannel(channel.sessionId);
    } else {
      navigate(`/chat/agents/${channel.agentInstanceId}?ch=${channel.sessionId}`);
    }
  }

  /** Tab × — close that one channel (the page reacts via chat:session.closed
   *  when it is the current one; a background tab just leaves the snapshot). */
  function closeChannelTab(channel: ChatChannelView): void {
    void emitWithAck('chat:session.close', {
      sessionId: channel.sessionId,
      reason: 'user',
    });
  }

  /** 清理 menu — close-all (busy defer) or 只清理闲置 (busy untouched, 9 W11 D6).
   *  The confirm itself lives in `ChannelTabs`. */
  async function cleanupChannels(idleOnly: boolean): Promise<void> {
    const res = await emitWithAck<{ closed?: number; deferred?: number }>(
      'chat:channels.closeAll',
      { idleOnly },
    );
    toast.success(
      t('chat.tabsCleanupDone', { closed: res.closed ?? 0, deferred: res.deferred ?? 0 }),
    );
  }

  const groups = useMemo(
    () => (rail.state === 'ready' ? groupSessions(rail.sessions) : []),
    [rail],
  );
  /**
   * 9 W11 B — live-channel truth OVERLAID onto rail rows by native id: the
   * listing's `open` stamps are a moment-in-time snapshot, the pushes are
   * current. Rows between listing refreshes stay truthful.
   */
  const channelByNative = useMemo(() => {
    const m = new Map<string, ChatChannelView>();
    for (const ch of channels) {
      if (ch.nativeSessionId !== undefined) m.set(ch.nativeSessionId, ch);
    }
    return m;
  }, [channels]);
  const currentCwd =
    rail.state === 'ready'
      ? (rail.sessions.find((s) => s.sessionId === nativeSessionId)?.cwd ?? undefined)
      : undefined;
  // #14 — the ACTIVE channel's optimistic title: the fold's first user
  // prompt, the same source every target titles its sessions from. Shown
  // while the vendor title hasn't been pulled yet; CSS truncates, the row
  // tooltip carries the full text.
  const firstPromptText = useMemo(() => {
    for (const r of conversation.rows) {
      if (r.row !== 'user') continue;
      const text = r.blocks.find(
        (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
      );
      const trimmed = text?.text.trim() ?? '';
      if (trimmed === '') continue;
      return trimmed;
    }
    return undefined;
  }, [conversation.rows]);
  // #14 — turn end: re-pull the listing ONCE so the target's native title
  // (written around the first turn) replaces the optimistic first-prompt
  // title without waiting for the next unrelated refresh. Deliberately
  // simple: no polling — a LATE async rewrite (claude's summary replacing
  // the raw prompt) surfaces on the next turn end or a manual refresh.
  const lastTurnActiveRef = useRef(false);
  useEffect(() => {
    const was = lastTurnActiveRef.current;
    lastTurnActiveRef.current = conversation.turnActive;
    if (was && !conversation.turnActive) void refreshSessions(true);
  }, [conversation.turnActive, refreshSessions]);

  // The page's identity: which agent, on which machine. Published to the topbar
  // (a string — `page-slots.tsx` explains why it is not a portal).
  usePageTitle(
    agent === null
      ? t('chat.title')
      : `${agent.name}${machine !== null ? ` · ${machine.name}` : ''}`,
  );

  if (loadFailed) {
    return (
      <>
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-16 text-sm">
          <p>{t('chat.errSessionGone')}</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/chat">{t('chat.backToAgents')}</Link>
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <ChannelTabs
          channels={channels}
          activeSessionId={sessionId}
          onActivate={activateChannel}
          onClose={closeChannelTab}
          onCleanup={(idleOnly) => cleanupChannels(idleOnly)}
        />
        <div className="flex h-full min-h-0">
          {/* Left rail: new session + the agent's native sessions, grouped by
              cwd. Below md it would leave the phone with NO way to reach a
              session, so the same content ships as a drawer opened from the
              session bar (P5). */}
          <aside className="bg-sidebar/40 hidden w-72 shrink-0 flex-col border-r md:flex">
            <SessionRail
              rail={rail}
              groups={groups}
              collapsedCwds={collapsedCwds}
              nativeSessionId={nativeSessionId}
              firstPromptText={firstPromptText ?? null}
              machine={machine}
              channelByNative={channelByNative}
              onToggleCwd={toggleCwd}
              onOpenChannel={openChannel}
              onNewSession={() => setPickerOpen(true)}
              onRefresh={() => void refreshSessions(true)}
              showBack
            />
          </aside>

          {/* The phone's rail: the same component, in a drawer. Radix traps
              focus and Esc closes it; opening a session closes it too, so a tap
              does one thing. */}
          <DialogPrimitive.Root open={railOpen} onOpenChange={setRailOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="bg-scrim/45 absolute inset-0 z-40 md:hidden" />
              <DialogPrimitive.Content
                className="bg-background text-foreground absolute inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r shadow-lg md:hidden"
                aria-description={t('chat.railOpen')}
              >
                <SessionRail
                  rail={rail}
                  groups={groups}
                  collapsedCwds={collapsedCwds}
                  nativeSessionId={nativeSessionId}
                  firstPromptText={firstPromptText ?? null}
                  machine={machine}
                  channelByNative={channelByNative}
                  onToggleCwd={toggleCwd}
                  onOpenChannel={openChannel}
                  onNewSession={() => {
                    setRailOpen(false);
                    setPickerOpen(true);
                  }}
                  onRefresh={() => void refreshSessions(true)}
                />
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>

          {/* Right: toolbar + stream + composer */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
              {/* Below md the rail is a drawer, so the session list needs a door. */}
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
              <span className="truncate text-sm font-medium">{agent?.name ?? t('chat.title')}</span>
              {agent !== null ? (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {agent.target}
                </Badge>
              ) : null}
              {phase === 'connecting' ? (
                <span className="text-muted-foreground text-xs">{t('chat.connecting')}</span>
              ) : null}
              {phase === 'ready' && conversation.turnActive ? (
                <span className="text-signal flex items-center gap-1.5 text-xs">
                  <StateSignal state="live" pulse className="size-1.5 shrink-0" />
                  {t('chat.working')}
                </span>
              ) : null}
              {phase === 'closed' ? (
                <span className="text-muted-foreground truncate text-xs">
                  {error !== null ? t('chat.closedWithError', { error }) : t('chat.closed')}
                </span>
              ) : null}
              <span className="min-w-0 flex-1" />
              {phase === 'ready' || phase === 'connecting' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void disconnectChannel()}
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
              cwd={currentCwd}
              onPermissionRespond={(requestId, optionId) =>
                void respondPermission(requestId, optionId)
              }
              onElicitationRespond={(requestId, action, values) =>
                void respondElicitation(requestId, action, values)
              }
            />

            <div className="shrink-0 p-3">
              <div className="mx-auto w-full max-w-3xl">
                {/* 9 W14 — the agent's todo/plan snapshot (full-replace ACP
                    state; hidden when the agent never announced one). */}
                <TodoPanel entries={conversation.plan ?? []} />
                {conversation.queued !== null ? (
                  <QueuedMessage
                    blocks={conversation.queued}
                    onEdit={queueEdit}
                    onCancel={() => void queueCancel()}
                  />
                ) : null}
                <Composer
                  value={draft}
                  onChange={changeDraft}
                  phase={phase}
                  turnActive={conversation.turnActive}
                  usage={conversation.usage}
                  onSend={() => void send()}
                  onCancel={() => void cancelTurn()}
                  attachments={attachments}
                  fileRefs={fileRefs}
                  onRemoveAttachment={(id) =>
                    setAttachments((prev) => prev.filter((a) => a.id !== id))
                  }
                  onRemoveFileRef={(uri) =>
                    setFileRefs((prev) => prev.filter((f) => f.uri !== uri))
                  }
                  onPickImages={(files) => void addImages(files)}
                  onOpenFilePicker={() => setFilePickerOpen(true)}
                  imageSupported={imageSupported}
                  config={conversation.config satisfies ComposerConfig}
                  onConfigSet={(set) => void configSet(set)}
                  commands={conversation.commands}
                />
              </div>
            </div>
          </section>
        </div>
      </div>

      {machine !== null ? (
        <FilePicker
          open={filePickerOpen}
          onClose={() => setFilePickerOpen(false)}
          machineId={machine.id}
          baseWorkspace={machine.baseWorkspace}
          onPick={pickFile}
        />
      ) : null}
      {machine !== null ? (
        <DirPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          machineId={machine.id}
          baseWorkspace={machine.baseWorkspace}
          onBaseWorkspaceSaved={(base) =>
            setMachine((prev) => (prev === null ? prev : { ...prev, baseWorkspace: base }))
          }
          onPick={(directory) => void openChannel(undefined, directory)}
        />
      ) : null}
    </>
  );
}
