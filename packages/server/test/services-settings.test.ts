// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import { getSystemSettings, updateRegistrationSettings } from '../src/services/settings.js';
import { getSystemInfo } from '../src/services/system.js';
import { serverVersion } from '../src/version.js';

/**
 * #53 slice 4 — settings + system services, tested DIRECTLY against the
 * memory driver (no HTTP). Small surfaces, small nets: the anonymous read's
 * default, the admin-only write (the service is the enforcement point), and
 * the version passthrough.
 */

const user: Principal = { userId: 'u-1', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

describe('svc settings — registration switch', () => {
  it('defaults to open registration (anonymous read, no principal)', async () => {
    const d = deps();
    expect((await getSystemSettings(d)).allowRegistration).toBe(true);
  });

  it('write is admin-only and persists the flip', async () => {
    const d = deps();
    await expect(
      updateRegistrationSettings(d, user, { allowRegistration: false }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    const saved = await updateRegistrationSettings(d, admin, { allowRegistration: false });
    expect(saved.allowRegistration).toBe(false);
    expect((await getSystemSettings(d)).allowRegistration).toBe(false);
  });
});

describe('svc system — info', () => {
  it('surfaces the lockstep build version', () => {
    expect(getSystemInfo(admin)).toEqual({ version: serverVersion() });
  });
});
