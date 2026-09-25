// @vitest-environment node
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two hand-declared latin `@font-face` rules (`fonts/ibm-plex-sans-latin.css`,
 * `skins/bay/archivo-latin.css`) reference woff2 files inside Fontsource
 * packages by path. Nothing else checks that path: if an upgrade renames the
 * file, vite still builds and the UI silently re-renders in a system font —
 * the kind of failure a screenshot baseline would blame on something else.
 *
 * So: resolve each package the way vite does and assert the file is there.
 */
const require = createRequire(import.meta.url);

const FACES: { label: string; pkg: string; file: string }[] = [
  {
    label: 'IBM Plex Sans Variable (Signal UI sans)',
    pkg: '@fontsource-variable/ibm-plex-sans/package.json',
    file: 'files/ibm-plex-sans-latin-wght-normal.woff2',
  },
  {
    label: 'Archivo Variable (BAY display/label)',
    pkg: '@fontsource-variable/archivo/package.json',
    file: 'files/archivo-latin-wght-normal.woff2',
  },
];

describe('hand-declared latin font faces', () => {
  it.each(FACES)('$label points at a file the package really ships', ({ pkg, file }) => {
    const pkgDir = dirname(require.resolve(pkg));
    expect(existsSync(join(pkgDir, file))).toBe(true);
  });
});
