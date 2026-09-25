/**
 * Shared view shapes for the machine detail tabs — the server view of
 * `GET /api/machines/:id/inventory` (loaded once by the page shell in
 * `index.tsx`, consumed by every tab).
 */

/** One row of the inventory listing. */
export interface InventoryEntry {
  target: string;
  daemonVersion: string | null;
  reportedAt: string;
  scannedAt: string;
  agents: {
    name: string;
    directory: string;
    profileApplied: boolean | null;
    items: InventoryItemView[];
  }[];
  /** Phase 9 W1 — null when the daemon build does not probe runtimes. */
  runtime: RuntimeInfoView | null;
}

export interface RuntimeInfoView {
  target: string;
  installed: boolean;
  binPath?: string;
  version?: string;
  installMethod?: 'npm' | 'native' | 'brew' | 'unknown';
}

interface InventoryItemView {
  kind: string;
  name: string;
  origin: 'platform' | 'local';
  path: string;
  summary?: string;
  contentPreview?: string;
  importable: boolean;
  note?: string;
  meta?: { multi?: boolean; transport?: string; command?: string; url?: string };
}
