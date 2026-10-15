#!/usr/bin/env node
/**
 * Can the ADMIN CENTRE actually be used on an iPhone?
 * ==================================================
 *
 * Owner report 2026-10-15 (iPhone SE, #analytics?tab=pricing): the Tier Price
 * Multipliers table ran off the right edge with no way to reach its last
 * column, and the floating hamburger sat on top of page content.
 *
 * MODE: READ-ONLY. It logs in, changes location.hash, and clicks TAB buttons
 * only (role=tab / .admin-tab). It never submits a form, never clicks an
 * action button, never Approves anything.
 *
 * WHAT IT MEASURES, per route/tab per viewport
 *   A overflow   documentElement.scrollWidth > innerWidth (page scrolls sideways)
 *   B clipped    a visible element whose right edge passes the viewport with NO
 *                scrolling ancestor — content the owner cannot reach. Named.
 *   C hamburger  at scrollY 0, a text/control element under #mobile-menu-toggle
 *   D ios-zoom   a visible input/select/textarea under 16px (Safari zooms on focus)
 * Plus the row DETAIL views (product drawer, order modal): it clicks the first
 * clickable row on #products / #orders — opening a view is a read — measures
 * the drawer/modal, then RELOADS (Escape does not close it). Nothing inside is clicked.
 *
 * Env: PROBE_BASE (default http://localhost:3000), ADMIN_EMAIL/ADMIN_PASSWORD
 * (env or FEINK/.env), PROBE_ROUTES (comma list to narrow).
 * Exit 1 on any finding. A route that failed to render is SKIPPED BY NAME, not passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { PHONE } from './lib/mobile-viewports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PROBE_BASE || 'http://localhost:3000';

function readEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
}
const env = { ...readEnv(), ...process.env };

// Routes read from the shipped NAV_ITEMS, so a new page is probed without editing this file.
const appJs = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/app.js'), 'utf8');
const NAV = [...appJs.matchAll(/\{ key: '([a-z0-9-]+)'/g)].map((m) => m[1]);
const SUBTABS = {
  analytics: ['revenue', 'best-sellers', 'health', 'margins', 'pricing', 'market-intel', 'traffic', 'acquisition'],
  'control-center': ['overview', 'packs', 'integrity', 'seo', 'links', 'infra'],
  settings: ['notifications', 'shipping', 'site-lock'],
  expenses: ['overview', 'all', 'recurring'],
  business: ['accounts', 'applications'],
};
let ROUTES = [...new Set(NAV)].flatMap((k) => (SUBTABS[k] ? SUBTABS[k].map((t) => `${k}?tab=${t}`) : [k]));
if (env.PROBE_ROUTES) ROUTES = env.PROBE_ROUTES.split(',').map((s) => s.trim());

const VIEWPORTS = [
  // Playwright's 'iPhone SE' is the 2016 320x568 model; the owner's DevTools box is 375x667.
  { name: 'iPhone SE 375x667', ...devices['iPhone SE'], viewport: { width: 375, height: 667 } },
  { name: `iPhone 13 ${PHONE.width}x${PHONE.height}`, ...devices['iPhone 13'] },
];

function measure(scopeSel = '#filter-bar *, #main-content *') {
  const vw = innerWidth;
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    const host = el.closest('[id]');
    return host && host !== el ? `${host.id} › ${s}` : s;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Reachable only through a SCROLLER that is itself on screen. overflow:hidden/clip
  // is not reachable — that is the owner's screenshot (cut off, no way to scroll).
  const scrollsOrClips = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return p.getBoundingClientRect().right <= vw + 1;
      if (ox !== 'visible') return false;
    }
    return false;
  };
  const out = { overflow: null, clipped: [], hamburger: [], zoom: [] };
  const root = document.documentElement;
  if (root.scrollWidth > vw + 1) out.overflow = root.scrollWidth;

  const scope = document.querySelectorAll(scopeSel);
  out.measured = scope.length;
  const seen = new Set();
  for (const el of scope) {
    // Shapes inside an <svg> sit under the svg's UA overflow:hidden — the svg box is measured instead.
    if (el.ownerSVGElement || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && !scrollsOrClips(el)) {
      const n = name(el);
      // Report the OUTERMOST offender only: its children are the same finding.
      if (!el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1 || !seen.has(name(el.parentElement))) {
        if (!seen.has(n)) out.clipped.push(`${n} right=${Math.round(r.right)}`);
      }
      seen.add(n);
    }
  }
  const btn = document.getElementById('mobile-menu-toggle');
  if (btn && visible(btn) && scopeSel.includes('main-content')) {
    const b = btn.getBoundingClientRect();
    for (const el of scope) {
      const leafText = el.children.length === 0 && el.textContent.trim();
      const control = el.matches('a,button,input,select,textarea,[role=tab]');
      if (!(leafText || control) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) {
        out.hamburger.push(name(el));
      }
    }
  }
  for (const el of [...scope].filter((e) => e.matches('input, select, textarea'))) {
    if (!visible(el) || ['checkbox', 'radio', 'range', 'hidden', 'color', 'file'].includes(el.type)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 16) out.zoom.push(`${name(el)} ${fs}px`);
  }
  out.zoom = [...new Set(out.zoom)];
  return out;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // A page still painting its loader is measured too early, not measured broken.
  await page.waitForFunction(() => !document.querySelector('#main-content .admin-loading, #main-content .admin-loader'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
}

console.log(`\nprobe:admin-mobile — MODE: READ-ONLY (navigate + tab clicks only) — ${BASE}`);
console.log(`routes: ${ROUTES.length} × viewports: ${VIEWPORTS.length}\n`);
if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
  console.log('SKIPPED: ADMIN_EMAIL/ADMIN_PASSWORD not set — nothing measured. A skip is not a pass.');
  process.exit(2);
}

const browser = await chromium.launch();
let findings = 0;
const skipped = [];
try {
  // ONE login, then resize: a second password login per viewport hit the auth
  // limiter and the second viewport rendered nothing (measured 2026-10-15).
  const { name: _n, viewport: _v, ...ctxOpts } = VIEWPORTS[0];
  const ctx = await browser.newContext({ ...ctxOpts, viewport: _v });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/account/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-email', env.ADMIN_EMAIL);
  await page.fill('#login-password', env.ADMIN_PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }).catch(() => {});
  if (page.url().includes('/login')) {
    const why = await page.evaluate(() => document.querySelector('.form-error, .auth-error, [role="alert"]')?.textContent?.trim() || '(no message shown)');
    console.log(`SKIPPED: login did not leave /login — ${why}. Nothing measured. A skip is not a pass.`);
    process.exit(2);
  }
  for (const vp of VIEWPORTS) {
    const vpName = vp.name;
    await page.setViewportSize(vp.viewport);
    await page.goto(`${BASE}/admin#dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app-shell:not([hidden])', { timeout: 30000 });
    console.log(`── ${vpName}`);

    for (const route of ROUTES) {
      await page.evaluate((h) => { scrollTo({ top: 0, left: 0, behavior: 'instant' }); location.hash = h; }, route);
      await settle(page);
      const rendered = await page.waitForFunction(() => (document.getElementById('main-content')?.innerText || '').trim().length > 40, null, { timeout: 15000 }).then(() => true, () => false);
      if (!rendered) { skipped.push(`${vpName} #${route}: main-content empty`); console.log(`  ⊘ SKIPPED #${route} (nothing rendered)`); continue; }

      const tabs = await page.$$('#main-content [role="tab"], #main-content .admin-tab');
      const views = [{ label: '', el: null }];
      for (const t of tabs.slice(1)) views.push({ label: ((await t.innerText()) || '').trim().slice(0, 24), el: t });

      for (const v of views) {
        if (v.el) { await v.el.click().catch(() => {}); await settle(page); }
        // admin sets scroll-behavior:smooth; a plain scrollTo was measured mid-animation (scrollY 18 after 300ms).
        await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: 'instant' }));
        const m = await page.evaluate(measure);
        const tag = `#${route}${v.label ? ` [${v.label}]` : ''}`;
        const bad = [];
        if (m.overflow) bad.push(`A page scrolls sideways: scrollWidth=${m.overflow}`);
        for (const c of m.clipped.slice(0, 6)) bad.push(`B unreachable: ${c}`);
        if (m.clipped.length > 6) bad.push(`B … +${m.clipped.length - 6} more`);
        for (const h of [...new Set(m.hamburger)].slice(0, 4)) bad.push(`C under hamburger: ${h}`);
        for (const z of m.zoom.slice(0, 4)) bad.push(`D iOS zoom: ${z}`);
        if (m.zoom.length > 4) bad.push(`D … +${m.zoom.length - 4} more`);
        findings += bad.length;
        console.log(`  ${bad.length ? '✗' : '✓'} ${tag}${bad.map((b) => `\n      ${b}`).join('')}`);
      }

      if (route === 'products' || route === 'orders') {
        // The tab loop left the LAST tab open (orders → Compliance has no rows): re-enter on the first.
        await page.evaluate(() => { location.hash = 'dashboard'; }); await settle(page);
        await page.evaluate((h) => { location.hash = h; }, route); await settle(page);
        const row = await page.waitForSelector('#main-content tbody tr.clickable, #main-content tbody tr[data-id]', { timeout: 15000 }).catch(() => null);
        if (!row) { skipped.push(`${vpName} #${route} detail: no clickable row`); continue; }
        await row.click();
        // Orders and Products mount .admin-product-modal on <body>, not in #drawer-root.
        const DETAIL = '#drawer-root *, #modal-root *, .admin-product-modal.open *';
        await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 20, DETAIL, { timeout: 10000 }).catch(() => {});
        await settle(page);
        const m = await page.evaluate(measure, DETAIL);
        const bad = [];
        if (m.overflow) bad.push(`A page scrolls sideways: scrollWidth=${m.overflow}`);
        for (const c of m.clipped.slice(0, 8)) bad.push(`B unreachable: ${c}`);
        for (const z of m.zoom.slice(0, 4)) bad.push(`D iOS zoom: ${z}`);
        findings += bad.length;
        // An empty drawer-root measured "0 findings" is a skip, not a pass.
        if (m.measured < 20) skipped.push(`${vpName} #${route} detail: drawer/modal did not open (${m.measured} elements)`);
        else console.log(`  ${bad.length ? '✗' : '✓'} #${route} [row detail, ${m.measured} elements]${bad.map((b) => `\n      ${b}`).join('')}`);
        // Escape does NOT close .admin-product-modal; left open it intercepted the next
        // viewport's row click (30s timeout, measured 2026-10-15). Reload.
        // goto() to the same path with a new hash is NOT a reload — force one.
        await page.evaluate(() => { location.hash = 'dashboard'; });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#app-shell:not([hidden])', { timeout: 30000 });
      }
    }
  }
  await ctx.close();
} finally {
  await browser.close();
}
console.log(`\nfindings: ${findings}   skipped views: ${skipped.length}`);
for (const s of skipped) console.log(`  SKIPPED: ${s}`);
process.exit(findings ? 1 : 0);
