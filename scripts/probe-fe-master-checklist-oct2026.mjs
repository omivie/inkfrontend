#!/usr/bin/env node
/**
 * probe:fe-master — FE master checklist (2026-10-05), items 5, 7, 8 (feink-dc's share)
 * ===================================================================================
 * Source: the backend's FE-MASTER-CHECKLIST-oct2026.md, Part 4 checks 5, 7, 8.
 *   §1 /shop series + printer pages at 1280x551, 1366x599, 1536x695, 1920x911
 *      (and 1366x768), consent banner OPEN: elementFromPoint at the first card's
 *      Add returns the button (item 7); the corner card sits bottom-right and
 *      never overlaps Google's badge; the service row is on the first screen
 *      and the first card's Add still is too (item 5).
 *   §2 phone 390x664: the service row on the first screen of a series page.
 *   §3 PDP: the consent card stays bottom-LEFT and Add is clickable (Part 2
 *      invariant); the PDP service row — mounted by feink-61 — is reported as
 *      SKIPPED, never passed, while it is absent.
 *   §4 copy: no "2–4" / "1–4" business/working days on /faq, /about, /shipping;
 *      /faq's visible South Island line equals the FAQPage JSON-LD (item 8).
 *   §5 NEGATIVE CONTROLS: forcing the card back to the left on /shop must turn
 *      the first-card check RED; hiding the service row must turn the row
 *      check RED. A probe that cannot fail proves nothing (ERR-258).
 *
 * MODE: READ-ONLY. Public GETs only: nothing is added to a cart, nothing is
 * typed into a search box (no /api/search/* ⇒ no search_analytics row,
 * ERR-254/271), no form is submitted, consent is never answered. Third-party
 * analytics and /api/analytics/* are ABORTED in the browser. BASE defaults to
 * localhost:3000 (`npx serve inkcartridges -l 3000`), the one local origin the
 * backend's CORS allows.
 *
 *   npm run probe:fe-master
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:fe-master
 *   npm run probe:fe-master -- --only=shop|phone|pdp|copy|controls
 *
 * PACED: 100 requests / 60 s per IP across endpoints (ERR-266). Contexts open
 * at most one per PROBE_PACE_MS (default 9000). A load that saw a 429 or never
 * painted a price is NOT MEASURED — a hard failure, never a layout result.
 *
 * GUEST SESSIONS: every fresh browser context makes the backend MINT a guest
 * session, and that mint has its own per-IP limiter ("429 Too many guest
 * sessions", window > 1h, measured 2026-10-05). A full run opens ~20 contexts.
 * Read-only is not cost-free: don't loop this probe while a peer needs mints.
 */
import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;
const PACE_MS = Number(process.env.PROBE_PACE_MS || 9000);
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;
const LAPTOPS = [
    { width: 1280, height: 551 },
    { width: 1366, height: 599 },
    { width: 1536, height: 695 },
    { width: 1920, height: 911 },
    { width: 1366, height: 768 },
];
const PHONE = { width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const SERIES = '/shop?brand=epson&category=ink&code=288';
const PRINTER = '/shop?brand=canon&printer_slug=canon-pixma-ts6160';
const PDP = '/p/CPG512BK';
const OLD_DAYS = /\b[12]\s*(?:–|-|&ndash;|–)\s*4\s+(?:business|working)\s+days/i;

let pass = 0, fail = 0, skips = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const skip = (n, d) => { skips++; console.log(`  \x1b[33m⤼ SKIPPED (not a pass): ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const vpName = (v) => `${v.width}x${v.height}`;
const want = (k) => !ONLY || ONLY === k;

console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, nothing typed, consent never answered; analytics aborted.');
console.log(`BASE ${BASE}  pace ${PACE_MS}ms`);

const browser = await chromium.launch();
let lastOpen = 0;

async function openPage(viewport, path, { css = null } = {}) {
    const wait = lastOpen + PACE_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastOpen = Date.now();
    const { isMobile, hasTouch, deviceScaleFactor, ...vp } = viewport;
    const ctx = await browser.newContext({ viewport: vp, isMobile, hasTouch, deviceScaleFactor });
    await ctx.route(ANALYTICS, (r) => r.abort());
    const page = await ctx.newPage();
    const limited = [];
    page.on('response', (r) => { if (r.status() === 429) limited.push(r.url()); });
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (css) await page.addStyleTag({ content: css });
    await page.waitForFunction(() => document.querySelector('.consent-banner.is-open'), null, { timeout: 15000 }).catch(() => {});
    // Google's badge settles after ~3 s on production (ERR-301 probe note).
    await page.waitForFunction(() => {
        const b = document.getElementById('google-reviews-badge');
        const r = b ? b.getBoundingClientRect() : null;
        const key = r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : 'none';
        window.__bs = (window.__bs && window.__bs.key === key) ? { key, n: window.__bs.n + 1 } : { key, n: 0 };
        return window.__bs.n >= 12;
    }, null, { timeout: 15000, polling: 'raf' }).catch(() => {});
    return { ctx, page, limited };
}

const intersects = (a, b) => !!(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);

/** /shop geometry at scroll 0. Runs in the page. */
function MEASURE_SHOP() {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.height ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null; };
    const hitName = (h) => (h ? (h.id ? '#' + h.id : String(h.className || h.tagName)).slice(0, 40) : 'offscreen');
    const cards = [...document.querySelectorAll('.products-row .product-card:not(.product-card--skeleton)')].filter((c) => c.getBoundingClientRect().height > 0);
    const first = cards[0];
    const btn = first ? first.querySelector('.product-card__cart-btn') : null;
    const a = r(btn);
    let hit = null;
    if (a) {
        const x = (a.left + a.right) / 2, y = (a.top + a.bottom) / 2;
        const h = (y >= 0 && y < innerHeight) ? document.elementFromPoint(x, y) : null;
        hit = h && (h === btn || btn.contains(h)) ? 'add' : hitName(h);
    }
    const row = document.getElementById('service-row');
    return {
        vh: innerHeight, vw: innerWidth,
        sku: first ? first.dataset.sku : null,
        price: r(first && first.querySelector('.product-card__price')),
        add: a, hit,
        banner: r(document.querySelector('.consent-banner.is-open')),
        badge: r(document.getElementById('google-reviews-badge')),
        row: row && !row.hidden ? r(row) : null,
        rowFacts: row && !row.hidden ? [...row.querySelectorAll('.service-row__item')].map((li) => li.textContent.trim()) : [],
        tel: row ? (row.querySelector('a[href^="tel:"]') || {}).href || null : null,
    };
}

async function shop(vp, path, opts) {
    const { ctx, page, limited } = await openPage(vp, path, opts);
    const loaded = await page.waitForFunction(() => document.querySelector('.product-card:not(.product-card--skeleton) .product-card__price'), null, { timeout: 30000 }).then(() => true, () => false);
    await page.waitForFunction(() => { const s = document.getElementById('service-row'); return s && !s.hidden; }, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const m = await page.evaluate(MEASURE_SHOP);
    await ctx.close();
    const measured = loaded && !limited.length;
    if (!measured) bad(`${vpName(vp)} ${path}: NOT MEASURED`, `${loaded ? 'cards painted' : 'no priced card'}; ${limited.length} × 429 — raise PROBE_PACE_MS`);
    return { m, measured };
}

const firstCardClear = (m) => !!m.add && m.add.bottom <= m.vh && m.hit === 'add' && !intersects(m.add, m.banner) && !intersects(m.price, m.banner);
const rowOnScreen = (m) => !!m.row && m.row.top >= 0 && m.row.top < m.vh && m.rowFacts.length >= 3;

try {
    /* §1 ── /shop series + printer pages, laptops ─────────────────────────── */
    if (want('shop')) {
        for (const [label, path] of [['series', SERIES], ['printer', PRINTER]]) {
            for (const vp of (label === 'series' ? LAPTOPS : LAPTOPS.slice(1, 2))) {
                head(`§1 /shop ${label} — ${vpName(vp)}`);
                const { m, measured } = await shop(vp, path);
                if (!measured) continue;
                const t = `${vpName(vp)} ${label}`;
                console.log(`    first ${m.sku}: Add ${m.add ? `${Math.round(m.add.top)}–${Math.round(m.add.bottom)} x${Math.round(m.add.left)}–${Math.round(m.add.right)}` : 'none'}`
                    + `  banner ${m.banner ? `${Math.round(m.banner.top)}–${Math.round(m.banner.bottom)} x${Math.round(m.banner.left)}–${Math.round(m.banner.right)}` : 'none'}`
                    + `  badge ${m.badge ? `${Math.round(m.badge.top)}–${Math.round(m.badge.bottom)} x${Math.round(m.badge.left)}` : 'none'}`
                    + `  row ${m.row ? `${Math.round(m.row.top)}–${Math.round(m.row.bottom)}` : 'hidden'}`);
                if (!m.banner) { bad(`${t}: consent banner open (first visit)`, 'not open — the item 7 check needs it open'); continue; }
                check(`${t}: elementFromPoint at the first card's Add returns the button, banner open`, firstCardClear(m), `hit ${m.hit}`);
                check(`${t}: consent card is bottom-RIGHT (right edge within 24px of the viewport)`, m.vw - m.banner.right <= 24, `x${Math.round(m.banner.left)}–${Math.round(m.banner.right)} of ${m.vw}`);
                check(`${t}: consent card does not overlap Google's badge`, !intersects(m.banner, m.badge));
                check(`${t}: service row on the first screen with ≥ 3 facts`, rowOnScreen(m), m.rowFacts.join(' | ') || 'hidden');
                check(`${t}: service row has no Afterpay and no unscoped same-day`,
                    !m.rowFacts.some((f) => /afterpay/i.test(f)) && m.rowFacts.every((f) => !/same day|same-day/i.test(f) || /Auckland metro/.test(f)));
            }
        }
    }

    /* §2 ── phone ─────────────────────────────────────────────────────────── */
    if (want('phone')) {
        head(`§2 /shop series — phone ${vpName(PHONE)}`);
        const { m, measured } = await shop(PHONE, SERIES);
        if (measured) {
            check('phone: service row on the first screen with ≥ 3 facts', rowOnScreen(m), m.row ? `top ${Math.round(m.row.top)}, ${m.rowFacts.length} facts` : 'hidden');
            check('phone: service row is ONE line (≤ 28px tall)', !!m.row && m.row.bottom - m.row.top <= 28, m.row ? `${Math.round(m.row.bottom - m.row.top)}px` : 'hidden');
            check('phone: call link uses tel:', /^tel:\+?\d+$/.test(m.tel || ''), String(m.tel));
        }
    }

    /* §3 ── PDP keeps the left card; Add clickable ─────────────────────────── */
    if (want('pdp')) {
        for (const vp of LAPTOPS.slice(0, 2)) {
            head(`§3 PDP ${PDP} — ${vpName(vp)}`);
            const { ctx, page, limited } = await openPage(vp, PDP);
            const loaded = await page.waitForFunction(() => /\$\d/.test(document.getElementById('product-price')?.textContent || ''), null, { timeout: 30000 }).then(() => true, () => false);
            await page.waitForTimeout(2500);
            const m = await page.evaluate(() => {
                const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.height ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null; };
                const add = document.getElementById('add-to-cart-btn');
                const a = r(add);
                const h = a ? document.elementFromPoint((a.left + a.right) / 2, (a.top + a.bottom) / 2) : null;
                const row = document.getElementById('product-service-row');
                return {
                    vh: innerHeight, add: a, hit: h && (h === add || add.contains(h)),
                    banner: r(document.querySelector('.consent-banner.is-open')),
                    row: row && !row.hidden ? r(row) : null, rowExists: !!row,
                };
            });
            await ctx.close();
            if (!loaded || limited.length) { bad(`${vpName(vp)} PDP: NOT MEASURED`, `${limited.length} × 429`); continue; }
            check(`${vpName(vp)} PDP: Add on screen and elementFromPoint returns it`, !!m.add && m.add.bottom <= m.vh && m.hit);
            check(`${vpName(vp)} PDP: consent card stays bottom-LEFT`, !!m.banner && m.banner.left <= 24, m.banner ? `x${Math.round(m.banner.left)}` : 'not open');
            if (!m.rowExists) skip(`${vpName(vp)} PDP service row`, '#product-service-row not in the page yet (feink-61 mounts it)');
            else check(`${vpName(vp)} PDP: service row on the first screen`, !!m.row && m.row.bottom <= m.vh, m.row ? `${Math.round(m.row.top)}–${Math.round(m.row.bottom)}` : 'hidden');
        }
    }

    /* §4 ── delivery copy ─────────────────────────────────────────────────── */
    if (want('copy')) {
        head('§4 delivery days copy (item 8)');
        for (const path of ['/faq', '/about', '/shipping']) {
            const { ctx, page } = await openPage({ width: 1366, height: 768 }, path);
            await page.waitForTimeout(1500);
            // textContent, not innerText: the FAQ answers sit in CLOSED <details>, which
            // innerText omits — the first run read "null" for a line that is there.
            const text = await page.evaluate(() => (document.querySelector('main') || document.body).textContent.replace(/\s+/g, ' '));
            const ld = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join('\n'));
            await ctx.close();
            const hit = OLD_DAYS.exec(text) || OLD_DAYS.exec(ld);
            check(`${path}: no "2–4"/"1–4" business/working days (visible or JSON-LD)`, !hit, hit ? `"${hit[0]}"` : '');
            if (path === '/faq') {
                const vis = /South Island:\s*([^.\n]+)/.exec(text);
                const json = /South Island ([^.;"]+)/.exec(ld);
                check('/faq: visible South Island line equals the FAQPage JSON-LD', !!vis && !!json && vis[1].trim() === json[1].trim(),
                    `visible "${vis && vis[1]}" · JSON-LD "${json && json[1]}"`);
            }
        }
    }

    /* §5 ── negative controls ─────────────────────────────────────────────── */
    if (want('controls')) {
        head('§5 NEGATIVE CONTROLS — each must turn its check RED');
        const vp = { width: 1366, height: 599 };
        {
            const { m, measured } = await shop(vp, SERIES, { css: '@media (min-width:1100px){ body.page-shop .consent-banner{ left:16px!important; right:auto!important; bottom:16px!important } }' });
            if (measured) check('card forced back to the left ⇒ the first-card check FAILS', !!m.banner && !firstCardClear(m), `hit ${m.hit}`);
        }
        {
            const { m, measured } = await shop(vp, SERIES, { css: '#service-row{ display:none!important }' });
            if (measured) check('service row hidden ⇒ the row check FAILS', !rowOnScreen({ ...m, row: m.row && m.row.bottom > m.row.top ? m.row : null }));
        }
    }
} finally {
    await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${skips} skipped${fail ? '' : skips ? ' — hard checks green; SKIPPED is not a pass' : ' — all hard checks green'}`);
process.exit(fail ? 1 : 0);
