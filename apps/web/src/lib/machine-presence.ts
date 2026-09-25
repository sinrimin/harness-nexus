import type { MachineView } from '@harness-nexus/sdk';
import type { MachineStatusEvent } from '@/realtime';

/**
 * Machine presence, as a pure patch (04-contract.md §5).
 *
 * Four files (`machines`, `dashboard`, `chat`, `machine-detail`) each carried
 * their own copy of this spread — four chances to forget the `daemonVersion`
 * guard, which is the part that actually matters: a status push usually carries
 * no version, and a blind `{...m, daemonVersion: e.daemonVersion}` would blank a
 * version the page already had. Pure, so it is testable; the socket
 * subscription is `useMachineStatus` in `components/shell/use-presence.ts`.
 *
 * Callers keep their own container shape (a list in three files, a single
 * machine in the detail page) — this module knows nothing about containers.
 */
export function patchMachine(m: MachineView, e: MachineStatusEvent): MachineView {
  if (m.id !== e.machineId) return m;
  return {
    ...m,
    online: e.online,
    lastSeenAt: e.lastSeenAt,
    ...(e.daemonVersion !== undefined ? { daemonVersion: e.daemonVersion } : {}),
  };
}

/** The list case: patch the matching row, leave the rest alone. */
export function patchMachineList(
  list: MachineView[] | null,
  e: MachineStatusEvent,
): MachineView[] | null {
  return list?.map((m) => patchMachine(m, e)) ?? list;
}
