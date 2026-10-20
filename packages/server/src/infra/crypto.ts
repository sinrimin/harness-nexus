// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { hash, verify } from '@node-rs/argon2';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * argon2id parameters (OWASP-recommended ballpark). We pass `algorithm: 2`
 * (Argon2id) as a literal because @node-rs/argon2 ships it as a `const enum`,
 * which can't be referenced under `verbatimModuleSyntax`.
 */
const ARGON2_OPTS = {
  algorithm: 2,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a password with argon2id. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS);
}

/** Verify a password against an argon2id hash; false on any failure. */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Prefix for Harness Nexus personal access tokens. */
export const PAT_PREFIX = 'hnpat_';

/** Generate a new PAT. Returns the raw `hnpat_…` value (shown to the user once). */
export function generatePat(): string {
  return PAT_PREFIX + randomBytes(32).toString('base64url');
}

/** sha256 of the raw PAT — what we persist and look up by. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Stable random id (URL-safe). Used for all primary keys. */
export function generateId(): string {
  return randomBytes(16).toString('base64url');
}

/** The display prefix kept alongside the hash, for UI recognition. */
export function patDisplayPrefix(rawToken: string): string {
  return rawToken.slice(0, PAT_PREFIX.length + 6);
}

// ---- credential secret encryption (AES-256-GCM) ----
// Used for Credential.secret, which must be reversible (decrypted at connect
// time to inject into upstream headers). Contrast with PAT hashing (sha256),
// which is one-way. See wiki design-phase-2.1-credentials.md "Credential encryption".

/** Derive a stable 32-byte AES-256 key from any-length input via sha256. */
function deriveKey(keyMaterial: string): Buffer {
  return createHash('sha256').update(keyMaterial).digest();
}

/**
 * Encrypt plaintext with AES-256-GCM. Returns `base64(iv):base64(ct):base64(tag)`.
 * A fresh random IV is used per call.
 */
export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const key = deriveKey(keyMaterial);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join(':');
}

/** Decrypt an `iv:ct:tag` blob produced by encryptSecret. Throws on tamper/bad key. */
export function decryptSecret(blob: string, keyMaterial: string): string {
  const [ivB64, ctB64, tagB64] = blob.split(':');
  if (!ivB64 || !ctB64 || !tagB64) throw new Error('malformed ciphertext blob');
  const key = deriveKey(keyMaterial);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Produce a recognition-only mask of a secret for API responses. Never returns
 * the plaintext or enough of it to reconstruct the value.
 * ≥8 chars → `abc…xyz`; shorter → `***`.
 */
export function maskSecret(secret: string): string {
  return secret.length >= 8 ? `${secret.slice(0, 3)}…${secret.slice(-3)}` : '***';
}
