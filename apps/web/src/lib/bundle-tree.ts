/**
 * The skill bundle's tree view (09-p4-resource-kinds.md §4).
 *
 * A bundle is stored as a flat `path → content` map — that is the shape the
 * server takes and the profile emitter replays, so it stays. What a reader
 * needs to see is the *tree* those paths describe: a skill with
 * `references/a.md` and `scripts/run.sh` is two folders, not a list where the
 * slashes are the only structure.
 *
 * Directories are therefore derived, and derived things are easy to get wrong
 * (ordering, a name that is both a file and a folder) — hence a pure module
 * with its own tests, next to `list-query.ts`.
 */

/** One node of the bundle tree. */
export interface BundleNode {
  /** Last path segment. */
  name: string;
  /** Full path from the bundle root (`references/notes.md`). */
  path: string;
  dir: boolean;
  children: BundleNode[];
}

/**
 * Fold flat paths into a tree: folders first, then files, each alphabetical —
 * the order a file explorer uses, so "where is that file" has one answer.
 */
export function buildBundleTree(paths: readonly string[]): BundleNode[] {
  const root: BundleNode = { name: '', path: '', dir: true, children: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let cursor = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      // `dir !== isFile` keeps a file and a folder that share a name apart
      // (`notes.md` and `notes.md/extra.md` are legal paths in the map).
      let next = cursor.children.find((c) => c.name === part && c.dir !== isFile);
      if (next === undefined) {
        next = { name: part, path: parts.slice(0, i + 1).join('/'), dir: !isFile, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    });
  }
  const sortRec = (node: BundleNode): void => {
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

/**
 * A bundle path is a key in a flat map: relative, forward slashes, no escapes.
 * `SKILL.md` itself is the primary body, not an extra file.
 */
export function bundlePathError(path: string): 'invalid' | null {
  if (path === 'SKILL.md' || path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    return 'invalid';
  }
  return null;
}
