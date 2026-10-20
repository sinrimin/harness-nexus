// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, readBodyCapped } from '../src/infra/egress.js';

/** #21 — outbound egress guards for user-supplied URLs. */

describe('assertPublicHttpUrl (#21)', () => {
  it.each([
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://192.168.0.1/x',
    'http://172.20.1.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.7/x',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://[fc00::5]/x',
    'http://localhost/x',
    'http://host.localhost/x',
    'http://svc.internal/x',
    'ftp://example.com/x',
    'file:///etc/passwd',
  ])('rejects %s', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  it('accepts public literal IPs without DNS', async () => {
    await expect(assertPublicHttpUrl('https://8.8.8.8/skills')).resolves.toBeInstanceOf(URL);
  });
});

describe('readBodyCapped (#21)', () => {
  it('throws once the stream passes the cap (and honors content-length)', async () => {
    const big = new Response('x'.repeat(64));
    await expect(readBodyCapped(big, 32)).rejects.toThrow(/cap/);

    const withLength = new Response('x'.repeat(64), {
      headers: { 'content-length': '64' },
    });
    await expect(readBodyCapped(withLength, 16)).rejects.toThrow(/cap/);

    const fine = new Response('small');
    await expect(readBodyCapped(fine, 1024)).resolves.toBe('small');
  });
});
