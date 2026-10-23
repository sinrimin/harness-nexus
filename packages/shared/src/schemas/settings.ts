// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * System settings beyond the registration toggle (#59). The image-retention
 * knob: days an assistant image blob lives, STAMPED on each blob at ingest —
 * changing the setting never rewrites already-stamped objects.
 */
export const updateImageRetentionSchema = z.object({
  imageRetentionDays: z.number().int().min(1).max(3650),
});
export type UpdateImageRetentionInput = z.infer<typeof updateImageRetentionSchema>;

/**
 * #85 — one outbound rule entry: a hostname, `*.domain` wildcard, IP literal,
 * or CIDR range (`10.0.0.0/8`, `fd00::/8`). One shape for the external and
 * internal lists; which list applies is decided by the target's resolution.
 */
export const apiToolRuleEntrySchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isRuleEntry, { message: 'hostname, *.domain wildcard, IP, or CIDR range' });

function isRuleEntry(v: string): boolean {
  if (/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)) return true; // host / wildcard
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return octetsOk(v); // IP literal
  if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v)) {
    const [ip, bits] = v.split('/');
    return octetsOk(ip!) && Number(bits) <= 32; // IPv4 CIDR
  }
  // IPv6 literal or CIDR — hex groups + colons, optional /prefix ≤ 128.
  const [ip6, bits6] = v.split('/');
  return (
    ip6 !== undefined &&
    /^[0-9a-f:]+$/i.test(ip6) &&
    ip6.includes(':') &&
    (bits6 === undefined || (Number(bits6) <= 128 && bits6 !== ''))
  );
}

function octetsOk(ip: string): boolean {
  return ip.split('.').every((o) => Number(o) <= 255);
}

/**
 * #85 — the API tool outbound policy: the DEFAULT action (`allow` = the rule
 * lists are blacklists; `deny` = whitelists) plus the two rule lists.
 * `external` applies to targets resolving to public addresses, `internal` to
 * private/loopback ones.
 */
export const updateApiToolOutboundSchema = z.object({
  mode: z.enum(['allow', 'deny']),
  rules: z.object({
    external: z.array(apiToolRuleEntrySchema).max(256),
    internal: z.array(apiToolRuleEntrySchema).max(256),
  }),
});
export type UpdateApiToolOutboundInput = z.infer<typeof updateApiToolOutboundSchema>;
