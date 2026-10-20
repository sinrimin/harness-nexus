// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * Auth/user validation schemas — the single source of truth for request shapes
 * across server, SDK, and web. See wiki design-phase-1-auth.md for the rules.
 */

const USERNAME_RE = /^[\w.-]{3,32}$/;

export const roleSchema = z.enum(['admin', 'user']);

/** Password: 8–256 chars. Deliberately no complexity theater. */
export const passwordSchema = z.string().min(8).max(256);

export const usernameSchema = z.string().regex(USERNAME_RE, {
  message: 'username must be 3–32 chars of [A-Za-z0-9_.-]',
});

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: z.string().email().optional(),
});

/** Admin-created user may carry an explicit role and optional preset password. */
export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: z.string().email().optional(),
  role: roleSchema.default('user'),
});

export const updateRoleSchema = z.object({
  role: roleSchema,
});

export const createPatSchema = z.object({
  name: z.string().min(1).max(64),
  /**
   * Token purpose (Phase 3.5). `api` (default) — a general PAT for the CLI /
   * automation / REST API. `marketplace` — an emit token whose ONLY power is
   * the marketplace-emitter URL (it cannot call the REST API); mapped to
   * `scopes: ['marketplace']` on the stored record.
   */
  kind: z.enum(['api', 'marketplace']).default('api'),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const updateRegistrationSchema = z.object({
  allowRegistration: z.boolean(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type CreatePatInput = z.infer<typeof createPatSchema>;
export type UpdateRegistrationInput = z.infer<typeof updateRegistrationSchema>;
