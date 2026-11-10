// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #121 — ANSI escape handling for terminal output in the transcript. Agents
 * relay command output verbatim (the ESC byte survives daemon → server →
 * browser), and a browser does not draw ESC: `\x1b[0m\x1b[91m` used to show
 * up as the literal text `[0m[91m`. This is a small, dependency-free SGR
 * parser — no innerHTML anywhere; the renderer maps styles onto React spans
 * and the 16 base colours onto the `--ansi-*` theme tokens.
 *
 * Scope: SGR (16 / 256 / truecolour, bold, dim, italic, underline, inverse,
 * strikethrough, and their resets). Every other CSI (cursor moves, erase
 * line), OSC (titles, hyperlinks — the link TEXT stays), DCS/APC-family
 * string and two-byte escape is dropped. A bare `\r` overwrites the current
 * line (progress bars settle on their final state); `\b` deletes one char.
 * Not a terminal emulator: cursor-addressed full-screen output is out of
 * scope.
 */

/** A palette index (0–15 → `--ansi-N`) or a literal `rgb(…)` colour. */
export type AnsiColor = number | string;

export interface AnsiStyle {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

export type AnsiLine = AnsiSegment[];

const ESC = '\x1b';

/** Fast path: nothing to interpret. */
export function hasAnsiControls(text: string): boolean {
  return text.includes(ESC) || text.includes('\r') || text.includes('\b');
}

/** The text with every escape removed and `\r` / `\b` applied. */
export function stripAnsi(text: string): string {
  if (!hasAnsiControls(text)) return text;
  return parseAnsi(text)
    .map((line) => line.map((s) => s.text).join(''))
    .join('\n');
}

/** xterm 256-colour index → palette index (0–15) or an `rgb(…)` literal. */
function color256(n: number): AnsiColor | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${level(Math.floor(i / 36))} ${level(Math.floor(i / 6) % 6)} ${level(i % 6)})`;
}

function clampByte(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? undefined : Math.min(255, Math.max(0, n));
}

/** Apply one SGR parameter list to `style` (mutated). */
function applySgr(style: AnsiStyle, raw: string): void {
  // `:` sub-parameters (38:2::r:g:b) read like `;` for our purposes; an
  // empty list is a reset.
  const params = raw === '' ? [0] : raw.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]!;
    if (p === 0) {
      for (const k of Object.keys(style) as (keyof AnsiStyle)[]) delete style[k];
    } else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) style.underline = true;
    else if (p === 7) style.inverse = true;
    else if (p === 9) style.strike = true;
    else if (p === 21 || p === 22) {
      delete style.bold;
      delete style.dim;
    } else if (p === 23) delete style.italic;
    else if (p === 24) delete style.underline;
    else if (p === 27) delete style.inverse;
    else if (p === 29) delete style.strike;
    else if (p >= 30 && p <= 37) style.fg = p - 30;
    else if (p === 39) delete style.fg;
    else if (p >= 40 && p <= 47) style.bg = p - 40;
    else if (p === 49) delete style.bg;
    else if (p >= 90 && p <= 97) style.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) style.bg = p - 100 + 8;
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let color: AnsiColor | undefined;
      if (mode === 5) {
        color = color256(params[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        // 38;2;r;g;b — tolerate the colon form's empty colour-space slot.
        const rest = raw.includes(':') && params[i + 2] === 0 && params.length > i + 5 ? 1 : 0;
        const r = clampByte(params[i + 2 + rest]);
        const g = clampByte(params[i + 3 + rest]);
        const b = clampByte(params[i + 4 + rest]);
        if (r !== undefined && g !== undefined && b !== undefined) color = `rgb(${r} ${g} ${b})`;
        i += 4 + rest;
      } else {
        // Unknown colour mode — nothing sensible to consume.
        continue;
      }
      if (color === undefined) continue;
      if (p === 38) style.fg = color;
      else style.bg = color;
    }
    // Anything else (blink, fonts, overline…) is ignored.
  }
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike
  );
}

/**
 * Parse `text` into lines of styled segments. Style carries across lines
 * (an SGR set before `\n` still applies after it), exactly like a terminal.
 * Line shape mirrors a plain `split('\n')` after dropping one trailing
 * newline: a final line with no text (`…\n`, `…\n\x1b[0m`) is not a line,
 * and output that is only a newline has no lines.
 */
export function parseAnsi(input: string): AnsiLine[] {
  const text = input.replace(/\r\n/g, '\n');
  const lines: AnsiLine[] = [];
  let line: AnsiLine = [];
  const style: AnsiStyle = {};
  let buf = '';

  const flush = () => {
    if (buf === '') return;
    const last = line[line.length - 1];
    if (last !== undefined && sameStyle(last.style, style)) last.text += buf;
    else line.push({ text: buf, style: { ...style } });
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ESC) {
      const next = text[i + 1];
      if (next === '[') {
        // CSI: parameter bytes 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E.
        let j = i + 2;
        while (j < text.length && /[0-?]/.test(text[j]!)) j += 1;
        const params = text.slice(i + 2, j);
        while (j < text.length && /[ -/]/.test(text[j]!)) j += 1;
        const final = text[j];
        if (final === undefined) break; // unterminated at the end — drop it
        if (final === 'm') {
          flush();
          applySgr(style, params);
        }
        i = j + 1;
        continue;
      }
      if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        // OSC / DCS / SOS / PM / APC: a string terminated by BEL or ST.
        let j = i + 2;
        while (
          j < text.length &&
          text[j] !== '\x07' &&
          !(text[j] === ESC && text[j + 1] === '\\')
        ) {
          j += 1;
        }
        i = j >= text.length ? j : text[j] === '\x07' ? j + 1 : j + 2;
        continue;
      }
      if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#') {
        i += 3; // charset designation / line attributes: ESC ( B
        continue;
      }
      i += next === undefined ? 1 : 2; // any other two-byte escape
      continue;
    }
    if (ch === '\n') {
      flush();
      lines.push(line);
      line = [];
    } else if (ch === '\r') {
      // Carriage return: whatever follows overwrites this line.
      buf = '';
      line = [];
    } else if (ch === '\b') {
      if (buf !== '') buf = buf.slice(0, -1);
      else {
        const last = line[line.length - 1];
        if (last !== undefined) {
          last.text = last.text.slice(0, -1);
          if (last.text === '') line.pop();
        }
      }
    } else if (ch === '\t' || ch >= ' ') {
      buf += ch;
    }
    // Remaining C0 controls (BEL, NUL, …) are dropped.
    i += 1;
  }
  flush();
  if (line.length > 0) lines.push(line);
  return lines.length === 1 && lines[0]!.length === 0 ? [] : lines;
}
