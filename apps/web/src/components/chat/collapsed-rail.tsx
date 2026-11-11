// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useState, type ReactNode } from 'react';
import { MenuIcon, PanelLeftOpenIcon, PlusIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * #122 — the collapsed session rail: a 48px icon column (expand, new session,
 * and the #110 pinned sessions as initial tiles). The full rail is one toggle
 * away; nothing here is a second navigation concept, just the rail's shortcuts
 * with the labels moved to tooltips.
 *
 * #126 — shared by BOTH chat ends. The agent page grew this first and the
 * assistant page kept a fixed 288px rail, so switching ends changed the rail's
 * width under the same switcher. The collapse is one desk-setup preference for
 * the chat surface (`hnx.railCollapsed`), and the tiles are page-agnostic: each
 * end maps its own pinned sessions onto `CollapsedRailTile`.
 */

const STORAGE_KEY = 'hnx.railCollapsed';

/**
 * The desktop rail's collapsed flag, persisted: collapsing is a desk setup,
 * not a per-visit gesture. One key for both ends, so the end switcher never
 * changes the rail's width.
 */
export function useRailCollapsed(): [collapsed: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* private mode — the state still works for this visit */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

/** One pinned session in the collapsed column. */
export interface CollapsedRailTile {
  id: string;
  /** The session's name: the tile prints its first character, the tooltip all of it. */
  label: string;
  /** A second tooltip line (the agent end's cwd); omitted when there is none. */
  detail?: string;
  active: boolean;
  onClick: () => void;
}

export function CollapsedRail({
  tiles,
  sessionMenu,
  newSessionLabel,
  newSessionDisabled = false,
  onNewSession,
  onExpand,
}: {
  tiles: readonly CollapsedRailTile[];
  /**
   * #127 — the floating session switcher's content. The component owns the
   * chrome (trigger + popup shell) because the trigger belongs to the
   * column's device row; each END renders its own rows, because the two ends
   * list differently (cwd groups vs flat). Undefined = no switcher button.
   */
  sessionMenu?: ReactNode;
  /** The end's own wording for its new-session action (also the tooltip). */
  newSessionLabel: string;
  /** Mirrors the expanded rail's gate (machine offline, no assistant config). */
  newSessionDisabled?: boolean;
  onNewSession: () => void;
  onExpand: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-slot="collapsed-rail" className="flex h-full w-12 flex-col items-center">
      {/* #123 — the same h-12 band as the expanded header, so both rail
          widths keep their top line on the stream header's border. */}
      <div className="flex h-12 w-full shrink-0 items-center justify-center border-b">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t('chat.railExpand')}
          title={t('chat.railExpand')}
          onClick={onExpand}
        >
          <PanelLeftOpenIcon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 px-1 py-2">
        {/* #127 — switching without expanding: the hamburger opens the same
            list the expanded rail shows, floating beside the column. */}
        {sessionMenu !== undefined ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={t('chat.railOpen')}
                title={t('chat.railOpen')}
              >
                <MenuIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="right"
              align="start"
              sideOffset={8}
              className="max-h-96 w-72 overflow-y-auto"
            >
              {sessionMenu}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={newSessionLabel}
          title={newSessionLabel}
          disabled={newSessionDisabled}
          onClick={onNewSession}
        >
          <PlusIcon className="size-4" />
        </Button>
        {tiles.length > 0 ? (
          <div className="mt-1 flex min-h-0 w-full flex-col items-center gap-1.5 overflow-y-auto">
            {tiles.map((tile) => (
              <button
                key={tile.id}
                type="button"
                data-slot="collapsed-rail-tile"
                data-active={tile.active ? 'true' : 'false'}
                onClick={tile.onClick}
                title={tile.detail !== undefined ? `${tile.label}\n${tile.detail}` : tile.label}
                aria-label={tile.label}
                aria-current={tile.active ? 'true' : undefined}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-md border font-mono text-[11px] uppercase transition-colors',
                  tile.active
                    ? 'border-signal/60 bg-signal/10 text-signal'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground border-transparent',
                )}
              >
                {tile.label.slice(0, 1)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * #127 — one row of the floating session switcher. Two lines (title over a
 * dim mono meta), the ACTIVE session marked by the signal dot and kept
 * un-pickable (selecting it would close the menu for nothing), a stale native
 * session disabled with its reason on the tooltip — the same honesty rules as
 * the rail rows it mirrors.
 */
export function RailMenuRow({
  title,
  meta,
  active = false,
  disabled = false,
  indented = false,
  titleAttr,
  onPick,
}: {
  title: string;
  meta: string;
  active?: boolean;
  disabled?: boolean;
  /**
   * Under a group label (the agent end's cwd folders): the title aligns
   * with the LABEL'S NAME — label x (px-2) + folder icon (12) + gap (6) —
   * so the rows read as the folder's children, not siblings of the header.
   */
  indented?: boolean;
  titleAttr?: string;
  onPick: () => void;
}) {
  return (
    <DropdownMenuItem
      data-slot="rail-menu-row"
      data-active={active ? 'true' : 'false'}
      disabled={disabled}
      title={titleAttr}
      onSelect={(e) => {
        if (active) {
          // Keep the sheet open — the pick is a no-op, closing would read as
          // a failed switch.
          e.preventDefault();
          return;
        }
        onPick();
      }}
      className={cn('gap-2 py-1.5', indented && 'pl-[26px]')}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{title}</span>
        <span className="text-muted-foreground block truncate font-mono text-[10px] leading-4">
          {meta}
        </span>
      </span>
      {active ? (
        <span aria-hidden="true" className="bg-signal size-1.5 shrink-0 rounded-full" />
      ) : null}
    </DropdownMenuItem>
  );
}

/** #127 — the switcher's empty/offline states: a dim line, not a blank sheet. */
export function RailMenuHint({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-2 py-2 text-xs">{children}</p>;
}
