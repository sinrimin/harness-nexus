// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Outbound-request guards (#21) for the URL-driven fetch surfaces (skill
 * search's well-known/url sources). These answers are user-supplied URLs —
 * without an egress check the server becomes an SSRF probe for internal
 * networks and cloud metadata endpoints.
 *
 * Scope note: the LLM-provider model query deliberately does NOT route
 * through here — pointing a provider at a private LLM endpoint (a local
 * Ollama, an internal gateway) is a legitimate deployment; its secret-flow
 * risk is governed by the credential rules in llm-providers.ts instead.
 *
 * Limitation: the DNS check happens before the fetch re-resolves the host,
 * so a rebinding attacker who flips the record between the two resolutions
 * can still slip through (TOCTOU). Full pinning (fetching via a dialed
 * socket) is out of scope here; this stops the untargeted cases (literal
 * private IPs, localhost names, hosts whose records are stably internal).
 */

const PRIVATE_RANGES = [
  // v4
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // v6
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

const privateList = new net.BlockList();
for (const cidr of PRIVATE_RANGES) {
  const slash = cidr.indexOf('/');
  const subnet = cidr.slice(0, slash);
  privateList.addSubnet(
    subnet,
    Number(cidr.slice(slash + 1)),
    subnet.includes(':') ? 'ipv6' : 'ipv4',
  );
}

/** IPv4-mapped v6 (`::ffff:10.0.0.1`) → the embedded v4 literal. */
function normalizeMapped(host: string): string {
  const m = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m?.[1] ?? host;
}

function isPrivateAddress(ip: string): boolean {
  const addr = normalizeMapped(ip);
  if (net.isIP(addr) === 0) return false;
  return privateList.check(addr, net.isIPv4(addr) ? 'ipv4' : 'ipv6');
}

/**
 * Assert a raw URL is http(s) and its host is public: not a private/loopback/
 * link-local literal, not a localhost/internal name, and no DNS record in a
 * private range. Returns the parsed URL on success; throws otherwise.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`non-HTTP(S) URL rejected: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`host not allowed: ${host}`);
  }
  const literal = normalizeMapped(host);
  if (net.isIP(literal) !== 0) {
    if (isPrivateAddress(literal)) throw new Error(`private address rejected: ${host}`);
    return url;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`host does not resolve: ${host}`);
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`host resolves to a private address: ${host}`);
  }
  return url;
}

/**
 * Read a response body as text with a hard byte cap — `res.text()`/
 * `res.json()` buffer the whole body however large it is (#21 DoS guard).
 * Streams with the Response's reader and aborts the transfer once the cap is
 * exceeded.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error(`response exceeds the ${maxBytes}-byte cap (content-length)`);
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new Error(`response exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
