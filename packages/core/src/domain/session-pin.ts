// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #110 — one pinned-session row, shared by BOTH rails (platform assistant +
 * machine native sessions). Personal by construction: the identity is
 * (owner, key) and every read is owner-filtered.
 *
 * `sessionKey` is the stable NATIVE identity with an axis prefix:
 * `assistant/<sessionId>` or `machine/<machineId>/<target>/<nativeSessionId>`.
 * The machine key carries the target because listings are per agent
 * INSTANCE — without the segment, one instance's listing could GC a sibling
 * instance's pins on the same machine, and native ids are only unique within
 * one agent's own store anyway. Pins survive channel open/close and machine
 * re-enroll (machineId is stable).
 */
export interface SessionPin {
  ownerId: string;
  sessionKey: string;
  /** ISO timestamp — re-pinning refreshes it (the pinned block is DESC on it). */
  pinnedAt: string;
}
