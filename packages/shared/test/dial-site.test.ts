// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  resolveDialSite,
  transportPlaceholderNames,
  type ScannableTransport,
} from '../src/dial-site.js';

describe('transportPlaceholderNames', () => {
  it('collects across url, headers, command, args, env (deduped)', () => {
    const t: ScannableTransport = {
      type: 'streamable-http',
      url: 'https://${cred:api}.example.com/${cred:path}',
      headers: { Authorization: 'Bearer ${cred:api}' },
    };
    expect(transportPlaceholderNames(t).sort()).toEqual(['api', 'path']);
  });

  it('scans stdio command/args/env', () => {
    const t: ScannableTransport = {
      type: 'stdio',
      command: '${cred:runner}',
      args: ['--config', '${cred:cfg}'],
      env: { TOKEN: '${cred:api}' },
    };
    expect(transportPlaceholderNames(t).sort()).toEqual(['api', 'cfg', 'runner']);
  });

  it('returns [] when nothing is referenced', () => {
    expect(transportPlaceholderNames({ type: 'sse', url: 'https://plain.example.com' })).toEqual(
      [],
    );
  });
});

describe('resolveDialSite (normative matrix from phase-8-c2.md)', () => {
  const withUrl = (url: string): ScannableTransport => ({ type: 'streamable-http', url });

  it('explicit overrides always win', () => {
    const t = withUrl('https://${cred:locked}.example.com');
    expect(resolveDialSite({ dialSite: 'client', transport: t }, () => false)).toBe('client');
    expect(
      resolveDialSite({ dialSite: 'server', transport: withUrl('https://x') }, () => true),
    ).toBe('server');
  });

  it('auto + no credentials → client (localhost-friendly default)', () => {
    expect(
      resolveDialSite({ dialSite: 'auto', transport: withUrl('https://x') }, () => false),
    ).toBe('client');
  });

  it('auto + all referenced credentials distributable → client', () => {
    const t = withUrl('https://${cred:mine}.example.com');
    expect(resolveDialSite({ dialSite: 'auto', transport: t }, () => true)).toBe('client');
  });

  it('auto + any non-distributable credential → server (outlet-only)', () => {
    const t: ScannableTransport = {
      type: 'streamable-http',
      url: 'https://${cred:mine}.example.com',
      headers: { Authorization: 'Bearer ${cred:corp}' },
    };
    const distributable = (name: string) => name === 'mine';
    expect(resolveDialSite({ dialSite: 'auto', transport: t }, distributable)).toBe('server');
  });
});
