// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi, type AnsiLine } from './ansi';

/** Compact view: `text{fg,bg,b,d,i,u,r,s}` per segment, lines joined by `|`. */
function show(lines: AnsiLine[]): string {
  return lines
    .map((line) =>
      line
        .map((s) => {
          const f: string[] = [];
          if (s.style.fg !== undefined) f.push(`fg=${String(s.style.fg)}`);
          if (s.style.bg !== undefined) f.push(`bg=${String(s.style.bg)}`);
          if (s.style.bold) f.push('b');
          if (s.style.dim) f.push('d');
          if (s.style.italic) f.push('i');
          if (s.style.underline) f.push('u');
          if (s.style.inverse) f.push('r');
          if (s.style.strike) f.push('s');
          return f.length > 0 ? `${s.text}{${f.join(',')}}` : s.text;
        })
        .join(''),
    )
    .join('|');
}

describe('parseAnsi', () => {
  it('passes plain text through as lines', () => {
    expect(show(parseAnsi('one\ntwo'))).toBe('one|two');
    expect(parseAnsi('')).toEqual([]);
    expect(parseAnsi('\n')).toEqual([]);
  });

  it('mirrors split-after-trailing-newline line shapes', () => {
    expect(show(parseAnsi('a\n'))).toBe('a');
    expect(show(parseAnsi('a\n\n'))).toBe('a|');
    // A reset after the final newline must not open a phantom line.
    expect(show(parseAnsi('a\n\x1b[0m'))).toBe('a');
  });

  it('maps the 16 base colours and their resets (the reported [0m[91m case)', () => {
    expect(show(parseAnsi('\x1b[0m\x1b[91merror\x1b[0m done'))).toBe('error{fg=9} done');
    expect(show(parseAnsi('\x1b[32m✓\x1b[39m ok'))).toBe('✓{fg=2} ok');
    expect(show(parseAnsi('\x1b[41mbg\x1b[49m \x1b[104mbb'))).toBe('bg{bg=1} bb{bg=12}');
  });

  it('handles attributes and their individual resets', () => {
    expect(show(parseAnsi('\x1b[1;3;4mx\x1b[22my\x1b[23;24mz'))).toBe('x{b,i,u}y{i,u}z');
    expect(show(parseAnsi('\x1b[2md\x1b[7mr\x1b[27;22m\x1b[9ms\x1b[29m.'))).toBe('d{d}r{d,r}s{s}.');
    expect(show(parseAnsi('\x1b[1mb\x1b[mreset'))).toBe('b{b}reset');
  });

  it('resolves 256-colour and truecolour forms', () => {
    expect(show(parseAnsi('\x1b[38;5;9ma'))).toBe('a{fg=9}');
    expect(show(parseAnsi('\x1b[38;5;196mb'))).toBe('b{fg=rgb(255 0 0)}');
    expect(show(parseAnsi('\x1b[38;5;244mc'))).toBe('c{fg=rgb(128 128 128)}');
    expect(show(parseAnsi('\x1b[48;2;10;20;30md'))).toBe('d{bg=rgb(10 20 30)}');
    expect(show(parseAnsi('\x1b[38:2::1:2:3me'))).toBe('e{fg=rgb(1 2 3)}');
  });

  it('carries style across lines like a terminal', () => {
    expect(show(parseAnsi('\x1b[33mwarn\nstill\x1b[0m\nplain'))).toBe(
      'warn{fg=3}|still{fg=3}|plain',
    );
  });

  it('drops non-SGR CSI, OSC (keeping hyperlink text) and two-byte escapes', () => {
    expect(show(parseAnsi('\x1b[2K\x1b[1Gline\x1b[?25l'))).toBe('line');
    expect(show(parseAnsi('\x1b]0;title\x07after'))).toBe('after');
    expect(show(parseAnsi('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\ end'))).toBe('link end');
    expect(show(parseAnsi('\x1b(Bascii\x1b=ok'))).toBe('asciiok');
  });

  it('applies carriage-return overwrite and backspace', () => {
    expect(show(parseAnsi('10%\r50%\r100%\ndone'))).toBe('100%|done');
    expect(show(parseAnsi('progress\r'))).toBe('');
    expect(show(parseAnsi('ab\bc'))).toBe('ac');
    expect(show(parseAnsi('a\r\nb'))).toBe('a|b');
  });

  it('survives truncated sequences and stray controls', () => {
    expect(show(parseAnsi('ok\x1b['))).toBe('ok');
    expect(show(parseAnsi('ok\x1b'))).toBe('ok');
    expect(show(parseAnsi('bell\x07!'))).toBe('bell!');
    expect(show(parseAnsi('tab\there'))).toBe('tab\there');
  });
});

describe('stripAnsi', () => {
  it('returns plain text for copying and one-line summaries', () => {
    expect(stripAnsi('\x1b[0m\x1b[91mError:\x1b[0m boom')).toBe('Error: boom');
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
    expect(stripAnsi('50%\r100%')).toBe('100%');
  });
});
