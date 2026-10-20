// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Credential, UnitOfWork } from '@harness-nexus/core';

/**
 * Tenant-scoped `${cred:NAME}` resolution (#21).
 *
 * A credential name resolves within ONE owner's namespace: the owner's
 * personal rows first (personal names shadow same-named global rows for their
 * owner), then global rows. A global-namespace lookup (`ownerId === null`,
 * e.g. a global MCP server row) sees global rows only. A same-named credential
 * owned by another user can therefore never resolve — bare-name lookups let
 * one tenant decrypt another's secret.
 */
export async function findCredentialForOwner(
  uow: UnitOfWork,
  name: string,
  ownerId: string | null,
): Promise<Credential | null> {
  if (ownerId !== null) {
    const personal = await uow.credentials.findByName(name, 'personal', ownerId);
    if (personal !== null) return personal;
  }
  return uow.credentials.findByName(name, 'global');
}
