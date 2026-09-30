import { describe, expect, it } from 'vitest';
import {
  binCandidates,
  classifyInstallMethod,
  npmGlobalDir,
  pathEntries,
} from '../src/inventory/runtime.js';

/**
 * #32 — the Windows halves of the runtime probe's helpers. Pure functions
 * with an explicit `isWin` so a Linux runner still exercises them.
 */
describe('runtime probe windows helpers (#32)', () => {
  it('pathEntries: Git Bash colon-style PATH is parsed and normalized', () => {
    expect(pathEntries('/c/Users/x/bin:/usr/local/bin', true)).toEqual([
      'C:/Users/x/bin',
      '/usr/local/bin',
    ]);
  });

  it('pathEntries: cmd.exe semicolon-style PATH is split on ;', () => {
    expect(pathEntries('C:\\Program Files\\nodejs;C:\\Windows\\system32', true)).toEqual([
      'C:\\Program Files\\nodejs',
      'C:\\Windows\\system32',
    ]);
  });

  it('pathEntries: POSIX PATH is untouched on non-Windows', () => {
    expect(pathEntries('/usr/local/bin:/usr/bin:/bin', false)).toEqual([
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it('binCandidates: Windows probes the PATHEXT executable subset', () => {
    expect(binCandidates('dsh', 'C:/Users/x/AppData/Roaming/npm', true)).toEqual([
      'C:/Users/x/AppData/Roaming/npm/dsh',
      'C:/Users/x/AppData/Roaming/npm/dsh.cmd',
      'C:/Users/x/AppData/Roaming/npm/dsh.bat',
      'C:/Users/x/AppData/Roaming/npm/dsh.exe',
    ]);
    expect(binCandidates('dsh', '/usr/local/bin', false)).toEqual(['/usr/local/bin/dsh']);
  });

  it('npmGlobalDir: %APPDATA%\\npm on Windows, null elsewhere', () => {
    expect(npmGlobalDir('C:/Users/x', true, 'C:/Users/x/AppData/Roaming')).toBe(
      'C:/Users/x/AppData/Roaming/npm',
    );
    expect(npmGlobalDir('C:/Users/x', true, undefined)).toBe('C:/Users/x/AppData/Roaming/npm');
    expect(npmGlobalDir('/home/x', false)).toBeNull();
  });

  it('classifyInstallMethod: Windows npm markers with backslashes', () => {
    expect(
      classifyInstallMethod('C:\\Users\\x\\AppData\\Roaming\\npm\\dsh.cmd', 'C:\\Users\\x', true),
    ).toBe('npm');
    expect(
      classifyInstallMethod(
        'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh',
        'C:\\Users\\x',
        true,
      ),
    ).toBe('npm');
  });

  it('classifyInstallMethod: POSIX behavior unchanged', () => {
    expect(classifyInstallMethod('/usr/lib/node_modules/dsh/bin/dsh', '/home/x', false)).toBe(
      'npm',
    );
    expect(classifyInstallMethod('/opt/homebrew/bin/claude', '/home/x', false)).toBe('brew');
    expect(classifyInstallMethod('/home/x/.local/bin/claude', '/home/x', false)).toBe('native');
    expect(classifyInstallMethod('/usr/bin/foo', '/home/x', false)).toBe('unknown');
  });
});
