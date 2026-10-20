// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Component, memo, useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  SquareTerminalIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileEditIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  SendIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { StateSignal } from '@/components/state-signal';
import type { ToolCallNode } from './fold.js';
import { useChatChannels } from './use-chat-channels.js';
import {
  bashCommandParts,
  editDiffParts,
  firstOutputLine,
  langFromPath,
  mainPath,
  parseReadLines,
  parseSearchOutput,
  relativizeToCwd,
  toolArgumentsPreview,
} from './tool-meta.js';
import { DiffBlock, IoCard, ReadBlock, SearchBlock, TerminalBlock, TodoList } from './blocks.js';

/**
 * Tool rows (Phase 9 W6): a 24px-high disclosure row — status-marked icon,
 * tool name, separator dot, summary (file tools show the cwd-relative path;
 * Bash shows the description or command; failed rows show the error's first
 * line in danger color). Expanding reveals the Block family body. Three-tier
 * resolution guarantees every tool a decent card: exact `toolName` → ACP
 * `kind` → generic IN/OUT — wrapped in an error boundary so a malformed
 * payload degrades to one line instead of a white screen.
 */

interface ToolCardProps {
  node: ToolCallNode;
  cwd?: string;
}

/** Card-level boundary — data anomalies degrade, never white-screen. */
class CardErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="text-destructive flex items-center gap-2 py-1 text-xs">
          <StateSignal state="failed" aria-hidden className="size-1.5" />
          tool card failed to render
        </div>
      );
    }
    return this.props.children;
  }
}

// ---- specialized cards ----

const ReadCard = memo(function ReadCard({ node, cwd }: ToolCardProps) {
  const fullPath = mainPath(node) ?? node.title ?? '';
  const display = relativizeToCwd(fullPath, cwd);
  const text = node.content?.find((c) => c.type === 'content')?.content?.text ?? node.output ?? '';
  const parsed = parseReadLines(text);
  return (
    <ToolCardShell
      node={node}
      icon={<BookOpenIcon className="size-3.5" />}
      title={node.toolName ?? 'Read'}
      summary={display !== '' ? display : undefined}
      summaryIsPath
      errorSummary={firstOutputLine(node)}
      body={
        parsed.lines.length > 0 ? (
          <ReadBlock label={display} lines={parsed.lines} totalLines={parsed.totalLines} />
        ) : undefined
      }
    />
  );
});

const BashCard = memo(function BashCard({ node, cwd }: ToolCardProps) {
  const { command, description } = bashCommandParts(node);
  return (
    <ToolCardShell
      node={node}
      icon={<SquareTerminalIcon className="size-3.5" />}
      title={node.toolName ?? 'Bash'}
      summary={description ?? command}
      errorSummary={firstOutputLine(node)}
      body={
        <TerminalBlock
          command={command}
          cwd={cwd}
          output={node.output}
          running={node.status === 'running'}
          failed={node.status === 'failed'}
        />
      }
    />
  );
});

const EditCard = memo(function EditCard({ node, cwd }: ToolCardProps) {
  const parts = editDiffParts(node);
  const fullPath = parts?.path || mainPath(node) || node.title || '';
  const display = relativizeToCwd(fullPath, cwd);
  return (
    <ToolCardShell
      node={node}
      icon={<FileEditIcon className="size-3.5" />}
      title={node.toolName ?? 'Edit'}
      summary={display !== '' ? display : undefined}
      summaryIsPath
      errorSummary={firstOutputLine(node)}
      body={
        parts !== null && parts.newText !== null ? (
          <DiffBlock diffs={[{ path: display, oldText: parts.oldText, newText: parts.newText }]} />
        ) : node.output !== undefined ? (
          <IoCard output={node.output} failed={node.status === 'failed'} />
        ) : undefined
      }
    />
  );
});

const WriteCard = memo(function WriteCard({ node, cwd }: ToolCardProps) {
  const diff = node.content?.find((c) => c.type === 'diff');
  const fullPath = diff?.path || mainPath(node) || (node.title ?? '');
  const display = relativizeToCwd(fullPath, cwd);
  const raw = (node.rawInput ?? {}) as Record<string, unknown>;
  const newText = diff?.newText ?? (typeof raw.content === 'string' ? raw.content : undefined);
  return (
    <ToolCardShell
      node={node}
      icon={<FileEditIcon className="size-3.5" />}
      title={node.toolName ?? 'Write'}
      summary={display !== '' ? display : undefined}
      summaryIsPath
      errorSummary={firstOutputLine(node)}
      body={
        newText !== undefined ? (
          <DiffBlock diffs={[{ path: display, oldText: null, newText }]} />
        ) : undefined
      }
    />
  );
});

const SearchCard = memo(function SearchCard({ node, cwd }: ToolCardProps) {
  const raw = (node.rawInput ?? {}) as Record<string, unknown>;
  const pattern =
    typeof raw.pattern === 'string'
      ? raw.pattern
      : typeof raw.query === 'string'
        ? raw.query
        : toolArgumentsPreview(node);
  const parsed =
    node.output !== undefined && node.output !== '' ? parseSearchOutput(node.output) : null;
  return (
    <ToolCardShell
      node={node}
      icon={<SearchIcon className="size-3.5" />}
      title={node.toolName ?? 'Search'}
      summary={pattern}
      errorSummary={firstOutputLine(node)}
      body={
        parsed !== null ? (
          parsed.kind === 'matches' ? (
            <SearchBlock
              kind="matches"
              files={parsed.files.map((f) => ({
                path: relativizeToCwd(f.path, cwd),
                matches: f.matches,
              }))}
            />
          ) : (
            <SearchBlock kind="paths" paths={parsed.paths.map((p) => relativizeToCwd(p, cwd))} />
          )
        ) : undefined
      }
    />
  );
});

const WebCard = memo(function WebCard({ node }: ToolCardProps) {
  return (
    <ToolCardShell
      node={node}
      icon={<GlobeIcon className="size-3.5" />}
      title={node.toolName ?? 'Web'}
      summary={toolArgumentsPreview(node)}
      errorSummary={firstOutputLine(node)}
      body={
        node.output !== undefined && node.output !== '' ? (
          <IoCard output={node.output} failed={node.status === 'failed'} />
        ) : undefined
      }
    />
  );
});

const TaskCard = memo(function TaskCard({ node }: ToolCardProps) {
  const raw = (node.rawInput ?? {}) as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;
  return (
    <ToolCardShell
      node={node}
      icon={<FileEditIcon className="size-3.5" />}
      title={node.toolName ?? 'Task'}
      summary={toolArgumentsPreview(node)}
      errorSummary={firstOutputLine(node)}
      body={prompt !== undefined ? <IoCard body={prompt} /> : undefined}
    />
  );
});

const TodoCard = memo(function TodoCard({ node }: ToolCardProps) {
  const raw = (node.rawInput ?? {}) as Record<string, unknown>;
  const todos = Array.isArray(raw.todos)
    ? (raw.todos as { content?: string; status?: string }[]).filter(
        (t) => t !== null && typeof t === 'object',
      )
    : [];
  return (
    <ToolCardShell
      node={node}
      icon={<ListTodoIcon className="size-3.5" />}
      title={node.toolName ?? 'TodoWrite'}
      summary={todos.length > 0 ? `${todos.length}` : undefined}
      body={todos.length > 0 ? <TodoList todos={todos} /> : undefined}
      collapsible={false}
    />
  );
});

function prettyInput(node: ToolCallNode): string | null {
  const input = node.rawInput;
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object') return String(input);
  const s = JSON.stringify(input, null, 2);
  return s === '{}' ? null : s;
}

// ---- #67/#68 — the assistant's dispatch tools ----

/** The dispatch handle: the poll carries it in its args; the opener only in
 *  its (JSON) result. Null until either is available. */
function dispatchChannelId(node: ToolCallNode): string | null {
  const input = node.rawInput;
  const fromArgs =
    typeof input === 'object' && input !== null
      ? (input as { channelId?: unknown }).channelId
      : undefined;
  if (typeof fromArgs === 'string' && fromArgs !== '') return fromArgs;
  if (node.output !== undefined && node.output !== '') {
    try {
      const parsed = JSON.parse(node.output) as { channelId?: unknown };
      if (typeof parsed.channelId === 'string' && parsed.channelId !== '') return parsed.channelId;
    } catch {
      // a non-JSON result (error text) — no handle to link
    }
  }
  return null;
}

function dispatchSummary(node: ToolCallNode): string | undefined {
  const input = node.rawInput;
  if (
    node.toolName === 'agent_dispatch' &&
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { prompt?: unknown }).prompt === 'string'
  ) {
    const prompt = (input as { prompt: string }).prompt;
    return prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  }
  if (node.output !== undefined && node.output !== '') {
    try {
      const parsed = JSON.parse(node.output) as { status?: unknown; stopReason?: unknown };
      if (typeof parsed.status === 'string') {
        return (
          parsed.status + (typeof parsed.stopReason === 'string' ? ` (${parsed.stopReason})` : '')
        );
      }
    } catch {
      // fall through to the generic preview
    }
  }
  return toolArgumentsPreview(node);
}

const DispatchCard = memo(function DispatchCard({ node }: ToolCardProps) {
  const { t } = useI18n();
  const channels = useChatChannels();
  // #68 — the live-session link exists exactly while the channel does (the
  // driven channel closes itself at the dispatch's turn end).
  const channelId = dispatchChannelId(node);
  const channel = channelId !== null ? channels.find((c) => c.sessionId === channelId) : undefined;
  const liveLink =
    channel !== undefined && channelId !== null ? (
      <Link
        to={`/chat/agents/${channel.agentInstanceId}?ch=${encodeURIComponent(channelId)}`}
        className="text-signal hover:text-signal/80 flex h-6 shrink-0 items-center gap-1 text-[11px] font-medium"
      >
        {t('chat.dispatchLiveLink')}
        <ExternalLinkIcon className="size-3" aria-hidden />
      </Link>
    ) : undefined;
  return (
    <ToolCardShell
      node={node}
      icon={<SendIcon className="size-3.5" />}
      title={node.toolName ?? 'agent_dispatch'}
      summary={dispatchSummary(node)}
      errorSummary={firstOutputLine(node)}
      headerTrailing={liveLink}
      body={
        prettyInput(node) !== null || (node.output ?? '') !== '' ? (
          <IoCard
            body={prettyInput(node)}
            output={node.output === '' ? null : node.output}
            failed={node.status === 'failed'}
          />
        ) : undefined
      }
    />
  );
});

const GenericToolCard = memo(function GenericToolCard({ node }: ToolCardProps) {
  const bodyText =
    node.content?.find((c) => c.type === 'content')?.content?.text ?? node.output ?? null;
  const body =
    prettyInput(node) !== null || bodyText !== null ? (
      <IoCard
        body={prettyInput(node)}
        output={bodyText === '' ? null : bodyText}
        failed={node.status === 'failed'}
      />
    ) : undefined;
  return (
    <ToolCardShell
      node={node}
      icon={<SquareTerminalIcon className="size-3.5" />}
      title={node.toolName ?? 'Tool'}
      summary={node.title ?? toolArgumentsPreview(node)}
      errorSummary={firstOutputLine(node)}
      body={body}
    />
  );
});

// ---- resolution ----

const toolCardRegistry: Record<string, ComponentType<ToolCardProps>> = {
  Read: ReadCard,
  Bash: BashCard,
  Edit: EditCard,
  Write: WriteCard,
  Glob: SearchCard,
  Grep: SearchCard,
  WebSearch: WebCard,
  WebFetch: WebCard,
  Task: TaskCard,
  Agent: TaskCard,
  TaskOutput: TaskCard,
  TodoWrite: TodoCard,
  agent_dispatch: DispatchCard,
  agent_dispatch_poll: DispatchCard,
};

const kindCardRegistry: Record<string, ComponentType<ToolCardProps>> = {
  read: ReadCard,
  edit: EditCard,
  execute: BashCard,
  search: SearchCard,
  fetch: WebCard,
};

function resolveCard(node: ToolCallNode): ComponentType<ToolCardProps> {
  if (node.toolName !== undefined && toolCardRegistry[node.toolName] !== undefined) {
    return toolCardRegistry[node.toolName]!;
  }
  if (node.kind !== undefined && kindCardRegistry[node.kind] !== undefined) {
    return kindCardRegistry[node.kind]!;
  }
  return GenericToolCard;
}

export const ToolCallRow = memo(function ToolCallRow({ node, cwd }: ToolCardProps) {
  const Card = resolveCard(node);
  return (
    <div data-status={node.status}>
      <CardErrorBoundary>
        <Card node={node} cwd={cwd} />
      </CardErrorBoundary>
    </div>
  );
});

// ---- shared shell ----

interface ToolCardShellProps {
  node: ToolCallNode;
  icon: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  summaryIsPath?: boolean;
  errorSummary?: string | null;
  body?: ReactNode;
  collapsible?: boolean;
  /** #68 — a non-interactive action zone at the header's END (outside the
   *  expand button — interactive content may not nest in it). */
  headerTrailing?: ReactNode;
}

function ToolCardShell({
  node,
  icon,
  title,
  summary,
  summaryIsPath,
  errorSummary,
  body,
  collapsible = true,
  headerTrailing,
}: ToolCardShellProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const expandable = body !== undefined && collapsible;
  const open = collapsible ? expanded && expandable : true;
  const failed = node.status === 'failed';
  const showSummary = failed && errorSummary != null ? errorSummary : summary;
  const duration =
    node.endedAt !== undefined && node.endedAt - node.startedAt > 400
      ? `${((node.endedAt - node.startedAt) / 1000).toFixed(1)}s`
      : null;

  const statusMark =
    node.status === 'failed' ? (
      <StateSignal state="failed" label="failed" className="size-1.5" />
    ) : node.status === 'running' ? (
      <StateSignal state="running" label="running" pulse className="size-1.5" />
    ) : (
      <StateSignal state="completed" label="completed" className="size-1.5" />
    );

  return (
    <div
      className={cn('flex flex-col rounded-sm text-xs', node.status === 'running' && 'lamp-breath')}
      data-tool-status={node.status}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'flex h-6 min-w-0 flex-1 items-center gap-1.5 text-left',
            expandable && 'hover:text-foreground',
            !expandable && 'cursor-default',
          )}
        >
          {/* #72 — the leading mark never flex-shrinks: a long summary (the
              dispatch card's 80-char prompt preview) squeezed the svg to
              ~11px while sibling cards kept 14px. The status dot already
              carries shrink-0 in its base class. */}
          <span className="flex shrink-0 items-center">
            {node.status === 'running' || node.status === 'failed' ? statusMark : icon}
          </span>
          {expandable ? (
            <ChevronDownIcon
              className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
            />
          ) : null}
          <span className="text-muted-foreground shrink-0 font-medium">{title}</span>
          <span className="text-muted-foreground/40" aria-hidden>
            ·
          </span>
          {showSummary !== undefined && showSummary !== '' ? (
            <span
              className={cn(
                'min-w-0 truncate',
                failed && errorSummary != null
                  ? 'text-destructive'
                  : summaryIsPath
                    ? 'text-muted-foreground font-mono'
                    : 'text-muted-foreground',
              )}
            >
              {showSummary}
            </span>
          ) : null}
          <span className="min-w-0 flex-1" />
          {duration !== null ? (
            <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] tabular-nums">
              {duration}
            </span>
          ) : null}
          {node.status === 'running' ? (
            <span className="text-muted-foreground shrink-0 text-[10px]">{t('chat.running')}</span>
          ) : null}
        </button>
        {headerTrailing}
      </div>
      {open && body !== undefined ? <div className="mt-1 mb-2 min-w-0">{body}</div> : null}
    </div>
  );
}
