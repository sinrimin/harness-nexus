// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { User, Credential, Resource, Machine } from '@harness-nexus/core';

/**
 * #53: stays as-is on purpose — shared REPLY-view helpers (secret stripping,
 * derived presence), not domain logic. View shaping is the routes' concern;
 * services return domain rows and call these from their HTTP shells.

/** Strip secrets from a user for API responses. */
export function publicUser(u: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

/** Masked credential view — never exposes the ciphertext or plaintext. */
export interface CredentialView {
  id: string;
  name: string;
  secretPreview: string;
  scope: 'global' | 'personal';
  ownerId: string | null;
  /** Phase 8 C2 — may the plaintext reach a client shim (see the dial-site model). */
  distributable: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Build a masked credential view. `mask` receives the decrypted plaintext and
 * returns a recognition-only preview (e.g. `abc…xyz`); see `maskSecret` in
 * infra/crypto.ts. The ciphertext itself never leaves the route handler.
 */
export function credentialView(c: Credential, secretPreview: string): CredentialView {
  const { secret: _omit, ...rest } = c;
  return { ...rest, secretPreview };
}

/**
 * Resource API view. The domain `Resource` carries no secret, so the view is
 * the resource as-is. Kept as a named function (rather than returning the entity
 * directly) for symmetry with `credentialView` and as the single seam for future
 * redaction or field projection.
 */
export function resourceView(r: Resource): Resource {
  return r;
}

/** Machine API view (Phase 8) — the domain row plus DERIVED presence. */
export interface MachineView extends Machine {
  online: boolean;
}

export function machineView(m: Machine, online: boolean): MachineView {
  return { ...m, online };
}
