// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { credPlaceholder, resolvePlaceholders } from '../src/utils/placeholders.js';

describe('credPlaceholder', () => {
  it('wraps a name into the ${cred:NAME} form', () => {
    expect(credPlaceholder('github-token')).toBe('${cred:github-token}');
  });
});

describe('resolvePlaceholders', () => {
  it('substitutes every occurrence with the looked-up value', async () => {
    const out = await resolvePlaceholders(
      'Bearer ${cred:api-key} and ${cred:api-key} again',
      async (name) => `<${name}>`,
    );
    expect(out).toBe('Bearer <api-key> and <api-key> again');
  });

  it('resolves placeholders inside a longer string without touching the rest', async () => {
    const out = await resolvePlaceholders(
      'https://upstream.example/mcp?x=1&token=${cred:token}',
      async () => 'sekret',
    );
    expect(out).toBe('https://upstream.example/mcp?x=1&token=sekret');
  });

  it('leaves strings without placeholders untouched', async () => {
    const out = await resolvePlaceholders('plain', async () => {
      throw new Error('should not be called');
    });
    expect(out).toBe('plain');
  });

  it('propagates lookup failures (unknown credential aborts resolution)', async () => {
    await expect(
      resolvePlaceholders('${cred:missing}', async () => {
        throw new Error('unknown credential');
      }),
    ).rejects.toThrow('unknown credential');
  });

  it('handles names containing dots and dashes', async () => {
    const out = await resolvePlaceholders('${cred:my.token-1}', async (n) => n.toUpperCase());
    expect(out).toBe('MY.TOKEN-1');
  });
});
