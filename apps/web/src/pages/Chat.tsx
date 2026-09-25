import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRightIcon, BotIcon, LaptopIcon, MessageSquareIcon } from 'lucide-react';
import { api } from '@/api';
import { EmptyState, Lamp, Note, PageIntro, Panel, PanelBody, Well } from '@/components/kit';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale, type Lang } from '@/i18n';
import { emitWithAck } from '@/realtime';
import { useMachineStatus } from '@/components/shell/use-presence.js';
import { patchMachineList } from '@/lib/machine-presence.js';
import { ChannelTabs } from '@/components/chat/channel-tabs.js';
import { useChatChannels } from '@/components/chat/use-chat-channels.js';
import { Button } from '@/components/ui/button';
import type { AgentInstanceView, MachineView } from '@harness-nexus/sdk';

/**
 * Chat landing (Phase 9 W6): one card per chatable AgentInstance (deployed or
 * detected), grouped by machine. Blocked states render as hints ON the card
 * (offline / remote-chat off) — visible, not hidden: the card says why it
 * cannot open rather than disappearing. Clicking enters the session page.
 */
export function ChatPage() {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [agentsByMachine, setAgentsByMachine] = useState<Map<string, AgentInstanceView[]>>(
    new Map(),
  );

  useEffect(() => {
    void (async () => {
      try {
        const list = await withAuthGuard(() => api.listMachines(), logout);
        setMachines(list);
        // Agents per machine — independent lists, parallel.
        const entries = await Promise.all(
          list.map(async (m) => [m.id, await api.listMachineAgents(m.id).catch(() => [])] as const),
        );
        setAgentsByMachine(new Map(entries));
      } catch {
        setMachines([]);
      }
    })();
  }, [logout]);

  // Live presence patch — the same pattern as the Machines page.
  useMachineStatus((e) => setMachines((prev) => patchMachineList(prev, e)));

  const groups = useMemo(
    () =>
      (machines ?? [])
        .map((m) => ({ machine: m, agents: agentsByMachine.get(m.id) ?? [] }))
        .filter((g) => g.agents.length > 0),
    [machines, agentsByMachine],
  );
  const totalAgents = groups.reduce((s, g) => s + g.agents.length, 0);

  // 9 W11 B — live channels as tabs (jump back into one from the cards page).
  const channels = useChatChannels();
  const navigate = useNavigate();
  /** The confirm itself lives in `ChannelTabs` — one dialog, both pages. */
  async function cleanupChannels(idleOnly: boolean): Promise<void> {
    const res = await emitWithAck<{ closed?: number; deferred?: number }>(
      'chat:channels.closeAll',
      { idleOnly },
    );
    toast.success(
      t('chat.tabsCleanupDone', { closed: res.closed ?? 0, deferred: res.deferred ?? 0 }),
    );
  }

  return (
    <>
      <ChannelTabs
        channels={channels}
        activeSessionId=""
        onActivate={(ch) => navigate(`/chat/agents/${ch.agentInstanceId}?ch=${ch.sessionId}`)}
        onClose={(ch) =>
          void emitWithAck('chat:session.close', { sessionId: ch.sessionId, reason: 'user' })
        }
        onCleanup={(idleOnly) => cleanupChannels(idleOnly)}
      />
      <PageIntro sub={t('chat.subtitle')} />

      {machines === null ? (
        <p className="text-muted-foreground py-12 text-center text-sm">{t('common.loading')}</p>
      ) : groups.length === 0 ? (
        <EmptyState
          title={machines.length === 0 ? t('chat.noMachines') : t('chat.noAgentsAtAll')}
          action={
            machines.length === 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/machines">{t('app.navMachines')}</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-(--gap)">
          {groups.map(({ machine, agents }) => (
            <Panel
              key={machine.id}
              label={t('chat.machineGroupLabel')}
              icon={<LaptopIcon />}
              meta={
                <>
                  <Lamp
                    state={machine.online ? 'online' : 'offline'}
                    word={machine.online ? t('machines.online') : t('machines.offline')}
                  />
                  <span className="nums">{t('chat.agentsCount', { count: agents.length })}</span>
                </>
              }
              density="compact"
            >
              <PanelBody variant="flush">
                {/* The machine's NAME is an identity, so it is prose (600), not a
                    nameplate label — the label role uppercases, and `A97BB4E68E22`
                    is a different string from the machine's name. */}
                <Link
                  to={`/machines/${machine.id}`}
                  className="border-border hover:text-signal flex items-center gap-2 border-b px-(--panel-pad) py-2 text-sm font-semibold transition-colors"
                >
                  {machine.name}
                  <span className="text-muted-foreground role-data-sm font-normal">
                    {machine.daemonVersion ?? '—'}
                  </span>
                </Link>
                <div className="grid gap-(--gap) p-(--panel-pad) sm:grid-cols-2 xl:grid-cols-3">
                  {agents.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} machine={machine} lang={lang} />
                  ))}
                </div>
              </PanelBody>
            </Panel>
          ))}
          {totalAgents === 0 ? (
            <p className="text-muted-foreground text-sm">{t('chat.noAgentsAtAll')}</p>
          ) : null}
        </div>
      )}
    </>
  );
}

function AgentCard({
  agent,
  machine,
  lang,
}: {
  agent: AgentInstanceView;
  machine: MachineView;
  lang: Lang;
}) {
  const { t } = useI18n();
  const blocked = !machine.online || !machine.remoteChatEnabled;
  return (
    <Panel
      label={agent.target}
      icon={<BotIcon />}
      meta={agent.source === 'deploy' ? t('chat.sourceDeploy') : t('chat.sourceDetected')}
      density="compact"
      className={blocked ? 'border-dashed' : undefined}
    >
      <PanelBody className="flex flex-col gap-3">
        {/* The agent's name is its identity → prose (02-content.md §4), while the
            target above is an enum and belongs in the nameplate. */}
        <span className="truncate text-sm font-semibold">{agent.name}</span>
        {/* The directory hugs its value (`self-start`): this body is a flex
            column, where an inline-flex Well would stretch to the card's full
            width — a black window across every card in BAY. The comps hug
            (a long path there is a well capped at 520px, never a full-width
            bar). */}
        <Well className="self-start" copy={agent.directory}>
          {agent.directory}
        </Well>
        <span className="text-muted-foreground role-data-sm">
          {new Date(agent.updatedAt).toLocaleDateString(dateLocale(lang), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </span>
        {/* A blocked card says why — visible, not hidden (Phase 9 W6). */}
        {blocked ? (
          <Note tone="warn">{!machine.online ? t('chat.cardOffline') : t('chat.cardChatOff')}</Note>
        ) : null}
        <Button asChild variant={blocked ? 'outline' : 'default'} size="sm" className="self-start">
          <Link to={`/chat/agents/${agent.id}`} className="gap-1.5">
            <MessageSquareIcon className="size-3.5" />
            {t('chat.cardEnter')}
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </Button>
      </PanelBody>
    </Panel>
  );
}
