#!/usr/bin/env node
/**
 * Touch-pointer measurement probe (not an E2E claim — a measuring tape).
 *
 * `(pointer: coarse)` changes real geometry: the list toolbar and every row's
 * controls grow to a fingertip, and until #23 that growth was applied as a
 * MINIMUM BOX SIZE, which inflated the control, its row, and anything the
 * control sat inside. Desktop-width screenshots cannot show any of it, and a
 * phone-width success shot only shows the end state — so this prints the
 * numbers: row heights, each device's box, and the expanded hit area.
 *
 * Usage:
 *   node scripts/test-touch-targets.mjs <url> <token-file> [skin]
 *
 *   <url>         a page of a running app (dev server or the deployed bundle)
 *   <token-file>  a file holding a bearer token (JWT or PAT) for that app —
 *                 never a token on the command line, it lands in shell history
 *   [skin]        `signal` (default) or `bay`
 *
 * Reports every device it finds: the first table row (rows' heights, the well
 * or chip inside it, its copy affordance's visual box and hit area) and, on a
 * chat session page, the Sender's config controls. Uses puppeteer-core like
 * the ui-snap rig, at the phone profile the #23 reports came from (1080×2400
 * screenshots ⇒ 412 CSS px at DPR 2.625).
 */
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const [url, tokenPath, skin = 'signal'] = process.argv.slice(2);
if (url === undefined || tokenPath === undefined) {
  console.error('usage: node scripts/test-touch-targets.mjs <url> <token-file> [skin]');
  process.exit(2);
}
const token = readFileSync(tokenPath, 'utf8').trim();

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({
  width: 412,
  height: 915,
  deviceScaleFactor: 2.625,
  isMobile: true,
  // The switch that makes `(pointer: coarse)` true — without it every
  // measurement below is a desktop reading at a phone width.
  hasTouch: true,
});
await page.goto(new URL('/login', url).href, { waitUntil: 'networkidle2' });
await page.evaluate(
  (t, s) => {
    localStorage.setItem('harnessnexus.token', t);
    localStorage.setItem('hnx.skin', s);
    localStorage.setItem('theme', 'light');
    localStorage.setItem('hnx.lang', 'en');
  },
  token,
  skin,
);
await page.goto(url, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 3000));

const out = await page.evaluate(() => {
  const rect = (el) => {
    if (el === null || el === undefined) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      right: Math.round(r.right),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const rows = [...document.querySelectorAll('tbody tr')];
  const row = rows[0];
  const device = row?.querySelector('[data-surface="well"]') ?? null;
  const copy = device?.querySelector('[data-slot="copy"]') ?? null;
  const hitOf = (el) => {
    if (el === null || el === undefined) return null;
    const a = getComputedStyle(el, '::after');
    return { w: a.minWidth, h: a.minHeight };
  };
  // The chat Sender's config controls: below `sm` they are icon squares and
  // their fingertip is an overlay, so the visual and the hit area differ.
  const senderTools = [...document.querySelectorAll("[data-slot='composer-tools'] [data-slot='select-trigger']")];
  const sendButton = [...document.querySelectorAll("[data-slot='composer-tools'] button")].find((b) =>
    /send|发送/i.test(b.getAttribute('aria-label') ?? ''),
  );
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    row: rect(row),
    device: { ...rect(device), variant: device?.getAttribute('data-variant') ?? null },
    copyVisual: rect(copy),
    copyHitArea: hitOf(copy),
    menuTrigger: rect(row?.querySelector('[data-slot="dropdown-menu-trigger"]')),
    pinnedCell: rect(row?.lastElementChild),
    // #23 — the section menu's caret in the topbar: 24px of box (the identity
    // line has to stay a line), 2.5rem of fingertip. Present on every page.
    navMenu: (() => {
      const t = document.querySelector("[data-nav-menu='trigger']");
      return t === null
        ? null
        : { visible: t.offsetParent !== null, visual: rect(t), hitArea: hitOf(t) };
    })(),
    sender: senderTools.length === 0 ? null : {
      tools: senderTools.map((t) => ({
        label: t.getAttribute('aria-label'),
        visual: rect(t),
        hitArea: hitOf(t),
      })),
      send: rect(sendButton),
    },
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();