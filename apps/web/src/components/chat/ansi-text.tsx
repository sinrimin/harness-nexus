// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Fragment, memo, useMemo, type CSSProperties } from 'react';
import {
  hasAnsiControls,
  parseAnsi,
  type AnsiColor,
  type AnsiLine,
  type AnsiStyle,
} from '@/lib/ansi';

/**
 * #121 — terminal output with its ANSI styling rendered (see `lib/ansi.ts`).
 * The 16 base colours resolve to the `--ansi-*` theme tokens (red / green /
 * yellow are the well's own status inks, so a skin's LCD window carries
 * them); 256-colour and truecolour values render literally. Inverse swaps
 * against the surface's own ink and ground.
 */

function colorValue(c: AnsiColor): string {
  return typeof c === 'number' ? `var(--ansi-${String(c)})` : c;
}

function segmentStyle(s: AnsiStyle): CSSProperties | undefined {
  const out: CSSProperties = {};
  const fg = s.fg !== undefined ? colorValue(s.fg) : undefined;
  const bg = s.bg !== undefined ? colorValue(s.bg) : undefined;
  if (s.inverse) {
    out.color = bg ?? 'var(--background)';
    out.backgroundColor = fg ?? 'var(--foreground)';
  } else {
    if (fg !== undefined) out.color = fg;
    if (bg !== undefined) out.backgroundColor = bg;
  }
  if (s.bold) out.fontWeight = 600;
  if (s.dim) out.opacity = 0.65;
  if (s.italic) out.fontStyle = 'italic';
  const decoration = [s.underline ? 'underline' : '', s.strike ? 'line-through' : '']
    .filter((d) => d !== '')
    .join(' ');
  if (decoration !== '') out.textDecoration = decoration;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One parsed line's segments (no wrapper — the caller owns the line box). */
export function AnsiSpans({ line }: { line: AnsiLine }) {
  return (
    <>
      {line.map((s, i) => (
        <span key={i} style={segmentStyle(s.style)}>
          {s.text}
        </span>
      ))}
    </>
  );
}

/** A whole text block for a `<pre>`: lines joined by real newlines. */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const lines = useMemo(() => (hasAnsiControls(text) ? parseAnsi(text) : null), [text]);
  if (lines === null) return <>{text}</>;
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? '\n' : null}
          <AnsiSpans line={line} />
        </Fragment>
      ))}
    </>
  );
});
