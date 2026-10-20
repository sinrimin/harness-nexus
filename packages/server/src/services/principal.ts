// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { UnitOfWork } from '@harness-nexus/core';

/**
 * The service-layer calling convention (#53).
 *
 * Services are Fastify-free: dependencies arrive per call, the acting user
 * arrives as an EXPLICIT principal parameter, and every authorization
 * decision (#36 scope rules, 404 existence-hiding) is enforced INSIDE the
 * service — the REST routes and in-process callers (the platform assistant's
 * tools, #52) share this one door. Routes thin to authenticate → parse →
 * service → reply; they never re-check scope.
 */

/** Who is acting. Anonymous flows (login/register) take no principal. */
export interface Principal {
  userId: string;
  role: 'admin' | 'user';
}

/** Per-call dependencies. Grows per domain only when genuinely needed. */
export interface ServiceDeps {
  uow: UnitOfWork;
}
