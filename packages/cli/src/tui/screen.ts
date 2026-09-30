/**
 * #39 — the TUI's terminal surface: alternate screen, hidden cursor, raw
 * keys, resize handling, and diff-less full-frame repaint.
 *
 * Deliberately narrow: the app composes width-exact line arrays (width.ts
 * guarantees them), and Screen just clamps defensively, clears each row to
 * EOL (`\x1b[K`), and wipes below the frame (`\x1b[J`) — a repaint is one
 * `write` so the frame cannot tear. Raw keys: single printable characters
 * pass through; Ctrl-C arrives as 0x03 and as SIGINT (both exit); every
 * escape sequence (arrows, Fn, bracketed paste) is swallowed whole.
 */

import { truncateToWidth } from './width.js';

const ENTER_ALT = '\x1b[?1049h\x1b[?25l\x1b[2J';
const EXIT_ALT = '\x1b[?25h\x1b[?1049l';

export class Screen {
  readonly cols: number;
  readonly rows: number;
  #active = false;

  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly input: NodeJS.ReadStream & {
      setRawMode(mode: boolean): void;
      isRaw?: boolean;
    },
  ) {
    this.cols = out.columns ?? 80;
    this.rows = out.rows ?? 24;
  }

  /** Non-null when stdout/stdin are not both TTYs — the app refuses to paint. */
  static ttyError(out: NodeJS.WriteStream, input: NodeJS.ReadStream): string | null {
    if (!out.isTTY) return 'stdout is not a terminal';
    if (!input.isTTY) return 'stdin is not a terminal';
    return null;
  }

  /** Live terminal size (may change between frames via resize). */
  size(): { w: number; h: number } {
    return { w: this.out.columns ?? this.cols, h: this.out.rows ?? this.rows };
  }

  enter(): void {
    this.#active = true;
    this.out.write(ENTER_ALT);
    try {
      this.input.setRawMode(true);
    } catch {
      // Raw mode unavailable (exotic TTY) — render only, keys dead.
    }
    this.input.resume();
  }

  exit(): void {
    if (!this.#active) return;
    this.#active = false;
    try {
      if (this.input.isRaw) this.input.setRawMode(false);
    } catch {
      // Already restored.
    }
    this.out.write(EXIT_ALT);
  }

  /** Paint a full frame: `lines` top-aligned, width-clamped, EOL-cleared. */
  render(lines: string[]): void {
    if (!this.#active) return;
    const cols = this.out.columns ?? this.cols;
    const rows = this.out.rows ?? this.rows;
    const shown = lines.slice(0, rows).map((l) => truncateToWidth(l, cols));
    const body = `\x1b[H${shown.join('\r\n')}${shown.length < rows ? '\x1b[J' : ''}`;
    this.out.write(body);
  }

  /** Fires on terminal resize (SIGWINCH on POSIX, the event on Windows). */
  onResize(fn: () => void): () => void {
    this.out.on('resize', fn);
    return () => {
      this.out.off('resize', fn);
    };
  }

  /**
   * Raw key stream: `fn` receives single printable characters or 'ctrl-c'.
   * Escape sequences are dropped; multi-char bursts deliver each character.
   */
  onKey(fn: (key: string) => void): () => void {
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.startsWith('\x1b')) return; // CSI/SS3/OSC — nothing we bind
      for (const ch of text) {
        if (ch === '\x03') {
          fn('ctrl-c');
          continue;
        }
        if (ch >= ' ' && ch <= '~') fn(ch);
      }
    };
    this.input.on('data', onData);
    return () => {
      this.input.off('data', onData);
    };
  }
}
