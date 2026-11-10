// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useState } from 'react';
import { PanelLeftOpenIcon, PlusIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
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
  newSessionLabel,
  newSessionDisabled = false,
  onNewSession,
  onExpand,
}: {
  tiles: readonly CollapsedRailTile[];
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
