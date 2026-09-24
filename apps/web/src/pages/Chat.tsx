import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRightIcon, BotIcon, LaptopIcon, MessageSquareIcon } from 'lucide-react';
import { api } from '@/api';
import { PageIntro } from '@/components/kit';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale, type Lang } from '@/i18n';
import { emitWithAck } from '@/realtime';
import { useMachineStatus } from '@/components/shell/use-presence.js';
import { patchMachineList } from '@/lib/machine-presence.js';
import { ChannelTabs } from '@/components/chat/channel-tabs.js';
import { useChatChannels } from '@/components/chat/use-chat-channels.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  async function cleanupChannels(idleOnly: boolean): Promise<void> {
    if (!confirm(idleOnly ? t('chat.tabsCleanupIdleConfirm') : t('chat.tabsCleanupConfirm'))) {
      return;
    }
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
        onCleanup={(idleOnly) => void cleanupChannels(idleOnly)}
      />
      <PageIntro sub={t('chat.subtitle')} />

      {machines === null ? (
        <p className="text-muted-foreground py-12 text-center text-sm">{t('common.loading')}</p>
      ) : groups.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-16 text-sm">
          <MessageSquareIcon className="size-8" />
          <p>{machines.length === 0 ? t('chat.noMachines') : t('chat.noAgentsAtAll')}</p>
          {machines.length === 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/machines">{t('app.navMachines')}</Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(({ machine, agents }) => (
            <section key={machine.id} aria-label={machine.name}>
              <div className="mb-3 flex items-center gap-2">
                <LaptopIcon className="text-muted-foreground size-4" />
                <Link
                  to={`/machines/${machine.id}`}
                  className="text-sm font-medium hover:underline"
                >
                  {machine.name}
                </Link>
                <span
                  className={`inline-block size-2 rounded-full ${
                    machine.online ? 'bg-ok' : 'bg-muted-foreground/40'
                  }`}
                  aria-label={machine.online ? t('machines.online') : t('machines.offline')}
                />
                <span className="text-muted-foreground text-xs tabular-nums">
                  {t('chat.agentsCount', { count: agents.length })}
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {agents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} machine={machine} lang={lang} />
                ))}
              </div>
            </section>
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
    <>
      <Card className={blocked ? 'border-dashed' : ''}>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <BotIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate font-medium">{agent.name}</span>
            </div>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {agent.target}
            </Badge>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span>
              {agent.source === 'deploy' ? t('chat.sourceDeploy') : t('chat.sourceDetected')}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono" title={agent.directory}>
              {agent.directory}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {new Date(agent.updatedAt).toLocaleDateString(dateLocale(lang), {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
          {blocked ? (
            <p className="text-warn text-xs">
              {!machine.online ? t('chat.cardOffline') : t('chat.cardChatOff')}
            </p>
          ) : null}
          <Button
            asChild
            variant={blocked ? 'outline' : 'default'}
            size="sm"
            className="self-start"
          >
            <Link to={`/chat/agents/${agent.id}`} className="gap-1.5">
              <MessageSquareIcon className="size-3.5" />
              {t('chat.cardEnter')}
              <ArrowRightIcon className="size-3.5" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
