/**
 * #39 — pane geometry for the nmon-style stacked-band TUI.
 *
 * Pure math, no I/O (unit-tested directly): a 1-row header on top, an
 * optional 1-row metrics bar under it, a 1-row keybar at the bottom, and the
 * VISIBLE panes as full-width horizontal bands between them. Every pane needs
 * at least `minRows` (border + one content row); when the terminal is too
 * short, trailing panes drop (deterministically, in declared order) rather
 * than squeeze to nothing. Leftover rows are dealt out one per pane from the
 * top, so growth is even and stable frame-to-frame.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneSpec {
  id: string;
  /** Rows including the pane's border box. */
  minRows: number;
}

export interface LayoutResult {
  header: Rect;
  /** Null when the metrics bar is toggled off. */
  metrics: Rect | null;
  keybar: Rect;
  /** Visible panes in declaration order, with their rects. */
  panes: Array<{ id: string; rect: Rect }>;
  /** Pane ids that did not fit (rendered nowhere this frame). */
  dropped: string[];
}

/** Rows reserved for chrome regardless of pane count. */
const HEADER_ROWS = 1;
const METRICS_ROWS = 1;
const KEYBAR_ROWS = 1;

export function computeLayout(
  width: number,
  height: number,
  metricsVisible: boolean,
  panes: PaneSpec[],
): LayoutResult {
  const keybar: Rect = { x: 0, y: Math.max(0, height - KEYBAR_ROWS), w: width, h: KEYBAR_ROWS };
  const header: Rect = { x: 0, y: 0, w: width, h: HEADER_ROWS };

  if (height < HEADER_ROWS + KEYBAR_ROWS + 1) {
    // Degenerate terminal: chrome only, nothing else fits.
    return { header, metrics: null, keybar, panes: [], dropped: panes.map((p) => p.id) };
  }

  let y = HEADER_ROWS;
  let metrics: Rect | null = null;
  if (metricsVisible) {
    metrics = { x: 0, y, w: width, h: METRICS_ROWS };
    y += METRICS_ROWS;
  }

  const avail = keybar.y - y;
  const fits: PaneSpec[] = [];
  const dropped: string[] = [];
  let needed = 0;
  for (const pane of panes) {
    if (needed + pane.minRows > avail) {
      dropped.push(pane.id);
      continue;
    }
    needed += pane.minRows;
    fits.push(pane);
  }

  // Leftover rows go round-robin so growth is even and no hole gapes above
  // the keybar (5 spare rows over 4 panes → 5,4,4,4, not 4,4,4,4+gap).
  const heights = fits.map((p) => p.minRows);
  let extra = avail - needed;
  let i = 0;
  while (extra > 0 && heights.length > 0) {
    heights[i % heights.length]! += 1;
    extra -= 1;
    i += 1;
  }
  const panesOut: Array<{ id: string; rect: Rect }> = [];
  for (let j = 0; j < fits.length; j++) {
    const h = heights[j]!;
    panesOut.push({ id: fits[j]!.id, rect: { x: 0, y, w: width, h } });
    y += h;
  }
  return { header, metrics, keybar, panes: panesOut, dropped };
}
