import { describe, expect, it } from 'vitest';
import { isWithinWorkspace, normalizeWorkspacePath } from '../src/paths.js';

/**
 * #33 — workspace containment must not drag the server's own filesystem
 * semantics into machine-side paths. Windows findings from the public demo:
 * a Linux server's resolve() turned `D:\code` into `/app/D:\code`.
 */
describe('workspace path containment (#33)', () => {
  it('Windows paths pass through without the server cwd prepended', () => {
    expect(normalizeWorkspacePath('D:\\code')).toBe('D:/code');
    expect(normalizeWorkspacePath('D:/code/')).toBe('D:/code');
    expect(normalizeWorkspacePath('C:\\Users\\x\\proj')).toBe('C:/Users/x/proj');
  });

  it('POSIX paths keep resolve() behavior', () => {
    expect(normalizeWorkspacePath('/tmp/ws/')).toBe('/tmp/ws');
    expect(normalizeWorkspacePath('/tmp/ws/sub/../x')).toBe('/tmp/ws/x');
  });

  it('Windows containment is separator- and case-insensitive', () => {
    expect(isWithinWorkspace('D:\\code\\proj', 'D:/code')).toBe(true);
    expect(isWithinWorkspace('d:/CODE/proj/sub', 'D:\\code')).toBe(true);
    expect(isWithinWorkspace('C:\\other', 'D:/code')).toBe(false);
    // A sibling prefix is not inside.
    expect(isWithinWorkspace('D:/code-x', 'D:/code')).toBe(false);
  });

  it('POSIX containment unchanged', () => {
    expect(isWithinWorkspace('/home/x/ws/sub', '/home/x/ws')).toBe(true);
    expect(isWithinWorkspace('/home/x/ws', '/home/x/ws')).toBe(true);
    expect(isWithinWorkspace('/home/x/other', '/home/x/ws')).toBe(false);
    expect(isWithinWorkspace('/home/x/ws-x', '/home/x/ws')).toBe(false);
  });
});
