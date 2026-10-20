// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '@harness-nexus/core';

/** Claims carried by an Harness Nexus access token. */
export interface AccessTokenPayload extends JWTPayload {
  sub: string; // user id
  role: Role;
}

export interface JwtService {
  signAccessToken(user: { id: string; role: Role }): Promise<string>;
  verifyAccessToken(token: string): Promise<AccessTokenPayload>;
}

const encoder = new TextEncoder();

export function createJwtService(opts: {
  secret: string;
  issuer: string;
  accessTtl: string;
}): JwtService {
  const key = encoder.encode(opts.secret);

  return {
    async signAccessToken(user) {
      return new SignJWT({ role: user.role })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuedAt()
        .setIssuer(opts.issuer)
        .setExpirationTime(opts.accessTtl)
        .sign(key);
    },

    async verifyAccessToken(token) {
      const { payload } = await jwtVerify(token, key, {
        issuer: opts.issuer,
      });
      if (
        typeof payload.sub !== 'string' ||
        (payload.role !== 'admin' && payload.role !== 'user')
      ) {
        throw new Error('invalid token claims');
      }
      return payload as AccessTokenPayload;
    },
  };
}
