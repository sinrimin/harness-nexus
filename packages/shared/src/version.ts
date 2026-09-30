/**
 * Version comparison (#37) — zero-dependency, semver-shaped:
 * `MAJOR.MINOR.PATCH` with an optional `-prerelease` tail. Tolerant of the
 * shapes this project actually stamps (`0.1.0-alpha.7`, `0.1.0`, a bare
 * `0.1`); anything unparseable compares by core zeroes so callers can still
 * order rows, and `null`/absent fields never crash a chip's math.
 *
 * Rules (semver §11, the parts that matter here): compare the numeric core
 * left to right; a version WITHOUT a prerelease outranks the same core WITH
 * one; prerelease identifiers compare pairwise — numeric identifiers compare
 * numerically and rank BELOW alphanumeric ones; a shorter identifier list
 * ranks below a longer one once all shared positions tie.
 */

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa.core[i] ?? 0;
    const y = pb.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // No prerelease on either side (or on both, equal cores) → equal.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i] ?? '';
    const y = pb.pre[i] ?? '';
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const xn2 = Number(x);
      const yn2 = Number(y);
      if (xn2 !== yn2) return xn2 < yn2 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (pa.pre.length !== pb.pre.length) {
    return pa.pre.length < pb.pre.length ? -1 : 1;
  }
  return 0;
}

function parse(v: string): { core: number[]; pre: string[] | null } {
  const [coreRaw = '0', preRaw] = v.trim().split('-', 2) as [string, string | undefined];
  const parts = coreRaw.split('.').map((p) => Number(p));
  const core = [0, 1, 2].map((i) => {
    const n = parts[i];
    return n !== undefined && Number.isFinite(n) ? n : 0;
  });
  const pre = preRaw === undefined ? null : preRaw.split('.').filter((p) => p !== '');
  return { core, pre };
}
