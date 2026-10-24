#!/usr/bin/env node
/**
 * probe:listing-phone-sweep — FE checklist 2026-10-22 item 25 (ERR-370)
 * ====================================================================
 * The checklist's own done-when, executed: at 390x664, with the consent bar
 * OPEN and after it is ANSWERED, scroll the LC233 series page and the
 * MFC-J4620DW printer page from 0 to 2000px in 300px steps; at every step
 * every Add in view must be what elementFromPoint returns at its centre —
 * except an Add lying under the consent bar itself (exempt by the spec).
 * Measured before the fix (live, 2026-10-25): 3 of 4 runs failed, the first
 * Add hit #filter-sort-open (the fixed Filter & Sort bar) or the banner.
 *
 * NEGATIVE CONTROL: the last run re-adds a fixed 67px bar over the bottom of
 * the screen (the old #filter-sort-bar) and MUST fail; if it passes, the probe
 * is not measuring anything.
 *
 * MODE: READ-ONLY. Public pages only; no cart writes, nothing typed, consent is
 * set in localStorage for the "answered" runs (never clicked); analytics aborted.
 *
 *   npm run probe:listing-phone-sweep                  # localhost:3000
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:listing-phone-sweep
 */
import { chromium } from 'playwright';
const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m BASE ' + BASE);
const pages = ['/shop?brand=brother&category=ink&code=LC233', '/shop?brand=brother&printer_slug=brother-mfc-j4620dw'];
const browser = await chromium.launch();
let fails = 0;
const runs = [];
for (const answered of [false, true]) for (const path of pages) runs.push({ answered, path, control: false });
runs.push({ answered: true, path: pages[0], control: true });
for (const { answered, path, control } of runs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await ctx.route(/googletagmanager|google-analytics|bat\.bing|doubleclick|\/api\/analytics\//, (r) => r.abort());
  if (answered) await ctx.addInitScript(() => { try { localStorage.setItem('cookie_consent', 'declined'); localStorage.setItem('cookie_consent_v', '1'); } catch {} });
  const p = await ctx.newPage();
  await p.goto(BASE + path, { waitUntil: 'networkidle' });
  await p.waitForSelector('.product-card__cart-btn');
  if (control) await p.evaluate(() => { const d = document.createElement('div'); d.id = 'old-fixed-filter-bar'; d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:67px;z-index:9999;background:rgba(0,0,0,.02)'; document.body.appendChild(d); });
  await p.waitForTimeout(1200);
  const bad = [];
  for (let y = 0; y <= 2000; y += 300) {
    await p.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
    await p.waitForTimeout(350);
    const r = await p.evaluate(() => {
      const bar = document.querySelector('.consent-banner.is-open');
      const barTop = bar ? bar.getBoundingClientRect().top : innerHeight;
      const out = [];
      for (const b of document.querySelectorAll('.product-card__cart-btn')) {
        const r = b.getBoundingClientRect(); if (!r.height) continue;
        const cy = (r.top + r.bottom) / 2, cx = (r.left + r.right) / 2;
        if (cy < 0 || cy >= innerHeight) continue;
        if (cy >= barTop) continue; // under the consent bar itself: exempt by the spec
        const h = document.elementFromPoint(cx, cy);
        if (!(h === b || b.contains(h))) out.push(`${Math.round(cy)} → ${h ? (h.id || h.className || h.tagName) : 'null'}`);
      }
      return { out, first: (() => { const b = document.querySelector('.product-card__cart-btn'); const r = b.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(barTop)]; })() };
    });
    if (y === 0) console.log(`  ${answered ? 'answered' : 'bar open'} ${path} scroll0 firstAdd ${r.first[0]}-${r.first[1]} barTop ${r.first[2]}`);
    if (r.out.length) bad.push(`y${y}: ${r.out.join('; ')}`);
  }
  if (control) {
    console.log(`${bad.length ? '✔' : '✖'} NEGATIVE CONTROL (fixed bar re-added) must fail: ${bad.length ? 'it does' : 'IT PASSED — the probe measures nothing'}`);
    fails += bad.length ? 0 : 1;
  } else {
    console.log(`${bad.length ? '✖' : '✔'} ${answered ? 'answered' : 'bar open'} ${path} ${bad.join(' | ')}`);
    fails += bad.length ? 1 : 0;
  }
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} failing` : 'all pass');
process.exit(fails ? 1 : 0);
