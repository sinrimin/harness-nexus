/**
 * Cross-platform CLI spawn (#32).
 *
 * Windows npm-installed CLIs (`npm`, `npx`, `claude`, `dsh`, the ACP
 * adapter shims) are `.cmd` batch files: `spawn('npm')` fails there with
 * ENOENT, and Node ≥ 20 refuses to run a `.cmd` without a shell while
 * `shell: true` would mis-quote arguments like semver ranges. cross-spawn
 * resolves the shim and quotes arguments for cmd.exe properly; on POSIX it
 * is the plain `child_process.spawn` passthrough.
 *
 * Every spawn of a CLI by bare name — or of a path that may be a `.cmd`
 * shim found on PATH — must go through this module.
 */
export { spawn } from 'cross-spawn';
