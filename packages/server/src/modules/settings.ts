// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  updateApiToolAllowlistSchema,
  updateImageRetentionSchema,
  updateRegistrationSchema,
  type UpdateApiToolAllowlistInput,
  type UpdateImageRetentionInput,
  type UpdateRegistrationInput,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import {
  getSystemSettings,
  updateApiToolAllowlist,
  updateImageRetentionSettings,
  updateRegistrationSettings,
} from '../services/settings.js';

/** System settings routes — thin adapters over `services/settings.ts` (#53). */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET is intentionally public: the register page needs it before login.
  app.get('/api/settings/registration', async () => {
    const settings = await getSystemSettings({ uow: app.uow });
    return { allowRegistration: settings.allowRegistration };
  });

  app.put('/api/settings/registration', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = updateRegistrationSchema.parse(req.body) as UpdateRegistrationInput;
    const settings = await updateRegistrationSettings({ uow: app.uow }, principalOf(req), input);
    return { allowRegistration: settings.allowRegistration };
  });

  // #59 — the image retention window (days), admin-only both ways.
  app.get('/api/settings/image-retention', { preHandler: [app.requireAdmin] }, async () => {
    const settings = await getSystemSettings({ uow: app.uow });
    return { imageRetentionDays: settings.imageRetentionDays };
  });

  app.put('/api/settings/image-retention', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = updateImageRetentionSchema.parse(req.body) as UpdateImageRetentionInput;
    const settings = await updateImageRetentionSettings({ uow: app.uow }, principalOf(req), input);
    return { imageRetentionDays: settings.imageRetentionDays };
  });

  // #80 — the API tool runtime's default-deny host allowlist (admin-managed;
  // empty = no outbound API tool traffic).
  app.get('/api/settings/api-tool-allowlist', { preHandler: [app.requireAdmin] }, async () => {
    const settings = await getSystemSettings({ uow: app.uow });
    return { entries: settings.apiToolAllowlist };
  });

  app.put('/api/settings/api-tool-allowlist', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = updateApiToolAllowlistSchema.parse(req.body) as UpdateApiToolAllowlistInput;
    const settings = await updateApiToolAllowlist({ uow: app.uow }, principalOf(req), input);
    return { entries: settings.apiToolAllowlist };
  });
}
