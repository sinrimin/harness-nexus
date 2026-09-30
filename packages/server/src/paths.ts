import { resolve } from 'node:path';

/**
 * Workspace-path containment, without dragging THIS server's filesystem
 * semantics into paths that belong to a MACHINE (#33).
 *
 * The server is typically Linux while the daemon may be Windows: running
 * `path.resolve('D:\\code')` on the server prepends the server's own cwd and
 * garbles the drive (`/app/D:\code`) — sessions then land on the wrong drive
 * under an extra prefix directory. Windows-absolute paths (either separator,
 * any case) are therefore normalized as-is and compared case-insensitively;
 * POSIX-looking paths keep the resolve()-based behavior the containment
 * checks always had.
 */

const WIN_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

/** Is this a Windows-absolute path (`D:\…` / `D:/…`)? */
export function isWindowsPath(input: string): boolean {
  return WIN_ABSOLUTE.test(input);
}

/**
 * Normalize one workspace path: POSIX paths resolve() as before;
 * Windows-absolute paths get separators unified to `/` and a trailing
 * separator dropped (`D:\code\` → `D:/code`).
 */
export function normalizeWorkspacePath(input: string): string {
  if (!isWindowsPath(input)) return resolve(input);
  const norm = input.replace(/\\/g, '/');
  return norm.length > 3 && norm.endsWith('/') ? norm.slice(0, -1) : norm;
}

/** Must `wanted` denote the same dir as `root` or something inside it? */
export function isWithinWorkspace(wanted: string, root: string): boolean {
  if (isWindowsPath(root) || isWindowsPath(wanted)) {
    const w = normalizeWorkspacePath(wanted).toLowerCase();
    const r = normalizeWorkspacePath(root).toLowerCase();
    return w === r || w.startsWith(`${r}/`);
  }
  const w = normalizeWorkspacePath(wanted);
  const r = normalizeWorkspacePath(root);
  return w === r || w.startsWith(`${r}/`);
}
