/**
 * Generic pre-warm pool (Issue #3).
 *
 * Keeps at most ONE pre-warmed value per key: something expensive to produce
 * (an ACP adapter booted to a completed `initialize`) that a later
 * `chat:session.start` can adopt instead of paying the boot again. The pool
 * itself is key-typed and payload-agnostic — chat.ts supplies the spawn/kill
 * callbacks, so the dsh event tap, the adapter ledger, and every ACP detail
 * stay out of this file.
 *
 * Semantics (deliberately small — the start handler treats the pool as a
 * cache, never a dependency):
 *
 * - `prewarm(key)` is idempotent: a pending OR ready+alive entry is a no-op.
 * - A value that resolves after its entry vanished (TTL fired mid-spawn,
 *   `teardownAll`) is killed immediately — the pool no longer owns it.
 * - `consume(key)` hands out only READY values and removes them; a caller
 *   finding nothing spawns fresh exactly as before this feature existed.
 * - The idle TTL kills ready values (deliberate kill paths never unlink the
 *   adapter ledger — the periodic audit is the only runtime remover).
 * - `teardownAll()` is the /ctl-loss path: kill every ready value, drop
 *   pending entries (their late values get killed on resolve).
 */

export interface PrewarmPoolHooks<T> {
  /** Produce one value (null = failed; the entry is dropped). */
  spawn(key: string): Promise<T | null>;
  /** Is the value still usable? (a dead process must never be handed out) */
  isAlive(value: T): boolean;
  /** Retire a value the pool owns (TTL, teardown, late resolve). */
  kill(value: T): void;
  /** Idle retention once ready; default 120_000. */
  ttlMs?: number;
  /** Test seam for the TTL timer (default setTimeout/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
}

interface Entry<T> {
  state: 'pending' | 'ready';
  value: T | null;
  timer: NodeJS.Timeout | null;
  /** When the entry was created (#39 — the TUI's pool rows show an age). */
  bornAt: number;
}

export class PrewarmPool<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly hooks: PrewarmPoolHooks<T>) {}

  /** Idempotent per key — repeated nudges (page mounts, re-arms) are free. */
  prewarm(key: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (
        existing.state === 'ready' &&
        existing.value !== null &&
        !this.hooks.isAlive(existing.value)
      ) {
        // The process died on its own — replace it.
        this.dropEntry(key, existing);
      } else {
        return;
      }
    }
    const entry: Entry<T> = { state: 'pending', value: null, timer: null, bornAt: Date.now() };
    this.entries.set(key, entry);
    void this.hooks
      .spawn(key)
      .then((value) => {
        // The entry may have vanished (TTL cannot fire while pending, but
        // teardownAll can) or been replaced — the pool no longer owns the value.
        if (this.entries.get(key) !== entry) {
          if (value !== null) this.hooks.kill(value);
          return;
        }
        if (value === null) {
          this.entries.delete(key);
          return;
        }
        entry.value = value;
        entry.state = 'ready';
        entry.timer = this.setTimer(() => {
          const current = this.entries.get(key);
          if (current !== entry) return;
          this.dropEntry(key, current);
        }, this.ttlMs);
      })
      .catch(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
  }

  /** Take the ready value for `key`, or null (caller spawns fresh). */
  consume(key: string): T | null {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.state !== 'ready' || entry.value === null) return null;
    if (!this.hooks.isAlive(entry.value)) {
      this.dropEntry(key, entry);
      return null;
    }
    this.clearTimer(entry);
    this.entries.delete(key);
    return entry.value;
  }

  /** Kill everything the pool owns (deliberate teardown — /ctl loss). */
  teardownAll(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.value !== null) this.hooks.kill(entry.value);
      this.clearTimer(entry);
    }
    this.entries.clear();
  }

  /** Ready (not pending) keys — introspection for tests and logs. */
  readyKeys(): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.state === 'ready' && e.value !== null)
      .map(([k]) => k);
  }

  /** Every live entry with its state and age (#39 — the TUI's pool rows). */
  status(
    now: number = Date.now(),
  ): Array<{ key: string; state: 'pending' | 'ready'; ageMs: number }> {
    return [...this.entries.entries()].map(([key, e]) => ({
      key,
      state: e.state,
      ageMs: Math.max(0, now - e.bornAt),
    }));
  }

  private dropEntry(key: string, entry: Entry<T>): void {
    this.clearTimer(entry);
    this.entries.delete(key);
    if (entry.value !== null) this.hooks.kill(entry.value);
  }

  private get ttlMs(): number {
    return this.hooks.ttlMs ?? 120_000;
  }

  private setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    const set = this.hooks.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m));
    const t = set(fn, ms);
    t.unref?.();
    return t;
  }

  private clearTimer(entry: Entry<T>): void {
    if (entry.timer === null) return;
    const clear = this.hooks.clearTimer ?? ((t: NodeJS.Timeout) => clearTimeout(t));
    clear(entry.timer);
    entry.timer = null;
  }
}
