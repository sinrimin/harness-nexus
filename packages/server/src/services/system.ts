// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { serverVersion } from '../version.js';
import type { Principal } from './principal.js';

/**
 * System info (#53 slice 4) — the server build version surface. The one
 * authenticated place the UI (and anything else) learns the build version;
 * compare client-side against `Machine.daemonVersion` (the daemon reports its
 * CLI version in every `machine:hello`) to flag stale daemons; mismatch WARNs,
 * never blocks — the realtime proto number remains the compatibility gate.
 *
 * Takes a principal purely to keep the operation authenticated-only (the
 * version is not anonymous wire data); there is no finer authority decision.
 */

export interface SystemInfo {
  version: string;
}

export function getSystemInfo(_principal: Principal): SystemInfo {
  return { version: serverVersion() };
}
