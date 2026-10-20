#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

//
// scripts/headers.mjs — add or check the SPDX file header on every first-party
// source file (#74). `--check` (default) lists files whose header is missing or
// off-canonical and exits 1 — CI runs it before install; `--fix` rewrites each
// offender to the canonical block (idempotent). Zero dependencies.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const COPYRIGHT = 'SPDX-FileCopyrightText: 2026 sinrimin';
const LICENSE = 'SPDX-License-Identifier: MIT';

const LINE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const BLOCK_EXTS = new Set(['.css']);

const ext = (path) => path.slice(path.lastIndexOf('.'));

const headerBlock = (e) =>
  LINE_EXTS.has(e) ? `// ${COPYRIGHT}\n//\n// ${LICENSE}` : `/* ${COPYRIGHT} */\n/* ${LICENSE} */`;

// Canonical form: [shebang] + header block + blank line + original body. A body
// whose first line is already our copyright line is stripped down to its
// SPDX-License-Identifier line first, so drifted variants converge instead of
// stacking a second block.
function canonicalize(text, block) {
  const shebang = text.match(/^#![^\n]*\n/)?.[0] ?? '';
  const body = text.slice(shebang.length).split('\n');
  let cut = 0;
  if (body[0]?.includes(COPYRIGHT)) {
    const lic = body.findIndex((l, i) => i > 0 && i <= 4 && l.includes(LICENSE));
    if (lic > 0) cut = lic + 1;
  }
  const rest = body.slice(cut).join('\n').replace(/^(?:\r?\n)+/, '');
  return `${shebang}${block}\n\n${rest}`;
}

const argv = process.argv.slice(2);
if (argv.some((a) => a !== '--fix' && a !== '--check')) {
  console.error('usage: node scripts/headers.mjs [--fix | --check]');
  process.exit(2);
}
const fix = argv.includes('--fix');

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => LINE_EXTS.has(ext(f)) || BLOCK_EXTS.has(ext(f)));

const offenders = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const canonical = canonicalize(text, headerBlock(ext(file)));
  if (canonical === text) continue;
  offenders.push(file);
  if (fix) writeFileSync(file, canonical);
}

if (offenders.length === 0) {
  console.log(`headers OK (${files.length} files)`);
} else {
  console.error(`${offenders.length} file(s) ${fix ? 'fixed' : 'missing or off-canonical header'}:`);
  for (const f of offenders) console.error(`  ${f}`);
  if (!fix) process.exit(1);
}
