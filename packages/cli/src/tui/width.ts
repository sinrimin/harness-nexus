/**
 * #39 — display-width math for the TUI's box drawing.
 *
 * The daemon's logs and model ids carry CJK text (zh-CN UI, Chinese chat
 * content), so column alignment needs East Asian width, and pane lines must
 * be CLAMPED, never wrapped (a wrapped line would push the frame past the
 * terminal height and smear every pane below it). This is a pragmatic
 * wcwidth, not a full one: wide covers the CJK/Hangul/fullwidth/emoji planes
 * we actually render; combining marks and zero-width joiners count 0.
 * Iterate with for..of so surrogate pairs stay whole.
 */

/** Ranges that occupy two terminal cells. */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo leading consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols/punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compat (incl. ｦﾟ halfwidth edge)
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi syllables/radicals
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // emoji (misc symbols & pictographs … emotions)
  [0x1f900, 0x1faff], // supplemental symbols & pictographs
  [0x20000, 0x2fffd], // CJK Extension B–F
  [0x30000, 0x3fffd], // CJK Extension G+
];

/** Ranges that occupy no cell (combining marks, variation selectors, ZW*). */
const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x200b, 0x200f], // zero-width space/joiner, LRM/RLM
  [0xfe00, 0xfe0f], // variation selectors
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** Terminal cells this string occupies. Control characters count 0. */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue;
    if (inRanges(cp, ZERO)) continue;
    w += inRanges(cp, WIDE) ? 2 : 1;
  }
  return w;
}

/** Longest prefix of `s` fitting `max` cells (never splits a pair). */
export function truncateToWidth(s: string, max: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue;
    const cw = inRanges(cp, ZERO) ? 0 : inRanges(cp, WIDE) ? 2 : 1;
    if (w + cw > max) break;
    w += cw;
    out += ch;
  }
  return out;
}

/** Left-aligned `s` padded with spaces to exactly `w` cells (clamped). */
export function padEnd(s: string, w: number): string {
  const cut = truncateToWidth(s, w);
  return cut + ' '.repeat(Math.max(0, w - strWidth(cut)));
}

/** Right-aligned `s` in exactly `w` cells (clamped). */
export function padStart(s: string, w: number): string {
  const cut = truncateToWidth(s, w);
  return ' '.repeat(Math.max(0, w - strWidth(cut))) + cut;
}
