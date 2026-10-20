// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BotIcon, CheckIcon, ChevronsUpDownIcon, StarIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StateSignal } from '@/components/state-signal';
import { toast } from 'sonner';
import type { AgentInstanceView, AssistantConfigView, MachineView } from '@harness-nexus/sdk';
import { useMachineStatus } from '@/components/shell/use-presence.js';

/**
 * #52 — the chat 端 (endpoint) switcher. Lives where the old `- All agents`
 * back-link sat in the session rail's header: the assistant 端 pinned on
 * top, the machine agents grouped by machine with their live state lamps.
 * The star next to it pins the DEFAULT 端 (`localStorage hnx.chat.defaultEnd`
 * — no server per-user pref store exists and none is created); clicking a
 * pinned star UNPINS (back to the platform default, the assistant 端).
 */

const DEFAULT_END_KEY = 'hnx.chat.defaultEnd';

export type ChatEnd =
  | 'assistant'
  | {
      agentInstanceId: string;
      /** Display name of the current agent (falls back while loading). */ agentName?: string;
    };

export function readDefaultEnd(): string {
  return localStorage.getItem(DEFAULT_END_KEY) ?? 'assistant';
}

export function writeDefaultEnd(value: string): void {
  localStorage.setItem(DEFAULT_END_KEY, value);
}

/** Which 端 this page currently shows. */
function endKey(end: ChatEnd): string {
  return end === 'assistant' ? 'assistant' : `agent:${end.agentInstanceId}`;
}

export function EndSwitcher({
  current,
  fromDrawer,
}: {
  current: ChatEnd;
  /** The pick happens inside the phone's session drawer — navigate with the
   *  one-shot ?rail marker so the DESTINATION page lands with its session
   *  drawer open (after switching ends, the next thing you want is picking
   *  or creating a SESSION — not reopening menus). Desktop navigates
   *  plainly (its rail is always visible). */
  fromDrawer?: boolean;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [assistants, setAssistants] = useState<AssistantConfigView[] | null>(null);
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [agentsByMachine, setAgentsByMachine] = useState<Map<string, AgentInstanceView[]>>(
    new Map(),
  );
  // The pin star's truth — localStorage read once per mount (each session page
  // mounts its own switcher), then kept in state so unpin re-renders.
  const [pinned, setPinned] = useState(() => readDefaultEnd() === endKey(current));

  // The lists load when the popover first opens (the rail header stays cheap).
  useEffect(() => {
    if (!open || assistants !== null) return;
    void (async () => {
      try {
        const [list, assistantList] = await Promise.all([
          withAuthGuard(() => api.listMachines(), logout),
          withAuthGuard(() => api.listAssistants(), logout),
        ]);
        setMachines(list);
        setAssistants(assistantList);
        const entries = await Promise.all(
          list.map(async (m) => [m.id, await api.listMachineAgents(m.id).catch(() => [])] as const),
        );
        setAgentsByMachine(new Map(entries));
      } catch {
        setAssistants([]);
        setMachines([]);
      }
    })();
  }, [open, assistants, logout]);

  // Live machine presence — the group lamps (seeded from the loaded list,
  // patched by pushes).
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setPresence(Object.fromEntries((machines ?? []).map((m) => [m.id, m.online])));
  }, [machines]);
  useMachineStatus((e) => setPresence((prev) => ({ ...prev, [e.machineId]: e.online })));

  const groups = useMemo(
    () =>
      (machines ?? [])
        .map((m) => ({ machine: m, agents: agentsByMachine.get(m.id) ?? [] }))
        .filter((g) => g.agents.length > 0),
    [machines, agentsByMachine],
  );

  function pick(end: ChatEnd): void {
    // The menu always collapses after a pick (dropdown norm) — what carries
    // over is the SESSION drawer: same-route picks keep it open anyway, and
    // a drawer pick carries ?rail so the destination page opens its own.
    setOpen(false);
    if (endKey(end) === endKey(current)) return;
    const target = end === 'assistant' ? '/chat/assistants' : `/chat/agents/${end.agentInstanceId}`;
    navigate(fromDrawer === true ? `${target}?rail=1` : target);
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 px-2">
            <BotIcon className="size-3.5 shrink-0" />
            <span className="max-w-32 truncate text-xs">
              {current === 'assistant'
                ? t('assistants.endAssistant')
                : (current.agentName ?? t('chat.backToAgents'))}
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground size-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <button
            type="button"
            onClick={() => pick('assistant')}
            className="hover:bg-tray flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
          >
            <BotIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t('assistants.endAssistant')}</span>
              <span className="text-muted-foreground block truncate text-[11px]">
                {t('assistants.endAssistantDesc')}
              </span>
            </span>
            {current === 'assistant' ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </button>
          {groups.map(({ machine, agents }) => (
            <div key={machine.id} className="mt-1">
              <div className="text-muted-foreground flex items-center gap-1.5 px-2 py-1">
                <StateSignal state={presence[machine.id] ? 'live' : 'idle'} className="size-1.5" />
                {/* A machine name is an identity, not a label — no uppercase
                    (the design system reserves that for label roles). */}
                <span className="truncate text-[11px] font-medium tracking-wide">
                  {machine.name}
                </span>
              </div>
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => pick({ agentInstanceId: agent.id })}
                  className="hover:bg-tray flex w-full items-center gap-2 rounded-sm px-2 py-1.5 pl-5 text-left text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                    {agent.target}
                  </span>
                  {current !== 'assistant' && current.agentInstanceId === agent.id ? (
                    <CheckIcon className="size-3.5 shrink-0" />
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        className="size-(--control-h-sm) shrink-0"
        title={pinned ? t('assistants.unpinDefault') : t('assistants.pinDefault')}
        onClick={() => {
          if (pinned) {
            localStorage.removeItem(DEFAULT_END_KEY);
            setPinned(false);
            toast.success(t('assistants.unpinnedToast'));
          } else {
            writeDefaultEnd(endKey(current));
            setPinned(true);
            toast.success(t('assistants.pinnedToast'));
          }
        }}
      >
        <StarIcon className={'size-3.5' + (pinned ? ' fill-current' : '')} aria-hidden={pinned} />
      </Button>
    </div>
  );
}
