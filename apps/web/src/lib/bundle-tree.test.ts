import { describe, expect, it } from 'vitest';
import { buildBundleTree, bundlePathError, type BundleNode } from './bundle-tree.js';

/** Flatten a tree to `path` strings for readable assertions. */
function flatten(nodes: readonly BundleNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly BundleNode[]): void => {
    for (const n of list) {
      out.push(`${n.dir ? 'D' : 'F'} ${n.path}`);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

describe('buildBundleTree', () => {
  it('is empty for an empty bundle', () => {
    expect(buildBundleTree([])).toEqual([]);
  });

  it('keeps top-level files at the root', () => {
    expect(flatten(buildBundleTree(['LICENSE', 'notes.md']))).toEqual(['F LICENSE', 'F notes.md']);
  });

  it('derives folders from the paths, folders before files', () => {
    expect(flatten(buildBundleTree(['zzz.md', 'references/a.md', 'scripts/run.sh']))).toEqual([
      'D references',
      'F references/a.md',
      'D scripts',
      'F scripts/run.sh',
      'F zzz.md',
    ]);
  });

  it('sorts within a folder: folders first, then names case-insensitively', () => {
    const paths = ['pkg/b.md', 'pkg/a.md', 'pkg/sub/z.md', 'pkg/sub/a.md'];
    expect(flatten(buildBundleTree(paths))).toEqual([
      'D pkg',
      'D pkg/sub',
      'F pkg/sub/a.md',
      'F pkg/sub/z.md',
      'F pkg/a.md',
      'F pkg/b.md',
    ]);
  });

  it('keeps a file and a folder of the same name apart', () => {
    // Legal in a path map, and the kind of input that would make a tree builder
    // merge two unrelated things. The folder sorts first (folders-before-files
    // holds even when the names are identical), and the rows stay distinguishable
    // because a folder renders as `name/`.
    const tree = buildBundleTree(['notes.md', 'notes.md/extra.md']);
    expect(flatten(tree)).toEqual(['D notes.md', 'F notes.md/extra.md', 'F notes.md']);
  });

  it('does not mutate the input', () => {
    const paths = ['b/x.md', 'a.md'];
    const snapshot = [...paths];
    buildBundleTree(paths);
    expect(paths).toEqual(snapshot);
  });

  it('shares one folder node across many files', () => {
    const tree = buildBundleTree(['references/a.md', 'references/b.md', 'references/c.md']);
    expect(tree.length).toBe(1);
    expect(tree[0]?.children.length).toBe(3);
  });
});

describe('bundlePathError', () => {
  it('accepts ordinary relative paths', () => {
    for (const p of ['notes.md', 'references/a.md', 'scripts/run.sh', 'a/b/c/d.txt']) {
      expect(bundlePathError(p)).toBe(null);
    }
  });

  it('rejects SKILL.md, absolute paths, escapes and backslashes', () => {
    for (const p of ['SKILL.md', '/etc/passwd', 'references/../../x', 'a\\b.md']) {
      expect(bundlePathError(p)).toBe('invalid');
    }
  });
});
