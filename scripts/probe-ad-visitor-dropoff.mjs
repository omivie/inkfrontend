#!/usr/bin/env node
/**
 * probe:ad-visitor-dropoff — the first screen a paid laptop visitor sees (ERR-301)
 * ===============================================================================
 * backend-docs/inbox/ad-clicks-to-orders-FE-handoff-oct2026.md (2026-10-02),
 * which supersedes ad-visitor-dropoff-… and paid-traffic-conversion-… (1 Oct).
 * 54 paid visits, 0 orders: on a laptop the price and Add sat below the first
 * screen. One fresh browser context per measurement = a first visit = an ad
 * click, consent card OPEN.
 *
 *   §1 PDP at the handoff's four laptop sizes (+1280x720, 1440x900), for a
 *      genuine pack, a genuine single and a compatible drum:
 *        - Add to Cart fully inside the viewport,
 *        - its rect intersects neither the consent banner nor #google-reviews-badge,
 *        - document.elementFromPoint at its centre AND four inset corners
 *          returns the button (the handoff's own second condition),
 *        - the fit promise (#product-promise) starts directly under Add and is
 *          on screen,
 *        - desktop card mode: banner bottom-left, ≤ 400px wide, badge NOT lifted,
 *        - CLS (layout-shift, hadRecentInput excluded).
 *      The handoff's literal `Add.bottom <= banner.top` is printed as INFO: with
 *      a corner card on the opposite side of the page it measures a vertical
 *      coincidence, not an overlap (decision recorded in ERR-301).
 *   §2 /shop code pages at the same sizes:
 *        - code=288: the h1 names the code; every first-row card's price and
 *          Add are inside the viewport; a card the consent card covers is
 *          reported as COVERED (soft — the accepted corner-card trade), a card
 *          below the fold is a FAIL;
 *        - code=288XL: an /api/shop request carries code=288XL unchanged, the
 *          family is still fetched, and the first card is an XL;
 *        - code=564&pack=value_pack: the request carries pack=value_pack, the
 *          first card is a value pack, and "See all 564 cartridges" is shown.
 *   §3 NEGATIVE CONTROLS: a 200px spacer above PDP Add, and one above the /shop
 *      grid, must each turn the corresponding check RED. A probe that cannot
 *      fail proves nothing (ERR-258).
 *
 * MODE: READ-ONLY. Public GETs only: nothing is added to a cart, no form is
 * submitted, nothing is typed into any search box (no /api/search/* call ⇒ no
 * search_analytics row, ERR-254/271). Third-party analytics and
 * /api/analytics/* are ABORTED in the browser: this probe measures LAYOUT, not
 * transport, so the route handler changes no answer it gives (the ctx.route
 * CORS caveat is about transport claims). BASE defaults to localhost:3000
 * (`npx serve inkcartridges -l 3000`), the one local origin the backend's CORS
 * allows.
 *
 *   npm run probe:ad-visitor-dropoff
 *   PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:ad-visitor-dropoff
 *   npm run probe:ad-visitor-dropoff -- --only=pdp     (or --only=shop)
 *
 * PACED. The backend limits 100 requests / 60 s per IP across endpoints
 * (ERR-266) and one PDP load spends ~15 of them, so contexts open at most one
 * per PROBE_PACE_MS (default 9000). A load that saw a 429 or never painted a
 * price is reported as NOT MEASURED — never as a layout result (ERR-243: a
 * probe once read a 429 as missing data).
 */
import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;
const HANDOFF_VIEWPORTS = [
    { width: 1280, height: 551 },
    { width: 1366, height: 599 },
    { width: 1536, height: 695 },
    { width: 1366, height: 768 },
];
const EXTRA_VIEWPORTS = [{ width: 1280, height: 720 }, { width: 1440, height: 900 }];
const PDP_SKUS = ['GGI690KCMY', 'GLC3329XLBK', 'CDR1070BK'];   // genuine pack · genuine single · compatible drum
const PACE_MS = Number(process.env.PROBE_PACE_MS || 9000);
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;

let pass = 0, fail = 0, softs = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const soft = (n, d) => { softs++; console.log(`  \x1b[33m⚠ ${n}\x1b[0m — ${d}`); };
const info = (n, d) => console.log(`  \x1b[36mℹ ${n}\x1b[0m — ${d}`);
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const vpName = (v) => `${v.width}x${v.height}`;

console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, no form submits, no search typed; analytics aborted.');
console.log(`BASE ${BASE}  viewports ${[...HANDOFF_VIEWPORTS, ...EXTRA_VIEWPORTS].map(vpName).join(' ')}`);

const browser = await chromium.launch();

let lastOpen = 0;
async function openPage(viewport, path, { spacer = null } = {}) {
    const wait = lastOpen + PACE_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastOpen = Date.now();
    const ctx = await browser.newContext({ viewport });
    await ctx.route(ANALYTICS, (r) => r.abort());
    await ctx.addInitScript(() => {
        window.__cls = 0;
        try {
            new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
                .observe({ type: 'layout-shift', buffered: true });
        } catch (_) { /* no layout-shift support */ }
    });
    const page = await ctx.newPage();
    const shopRequests = [];
    page.on('request', (r) => { if (/\/api\/shop\?/.test(r.url())) shopRequests.push(r.url()); });
    const limited = [];
    page.on('response', (r) => { if (r.status() === 429) limited.push(r.url()); });
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (spacer) {
        await page.waitForSelector(spacer, { state: 'attached', timeout: 30000 }).catch(() => {});
        await page.evaluate((sel) => {
            const t = document.querySelector(sel);
            if (t) t.insertAdjacentHTML('beforebegin', '<div data-probe-spacer style="height:200px"></div>');
        }, spacer);
    }
    // The consent card animates in; give it and Google's badge time to settle.
    await page.waitForFunction(() => document.querySelector('.consent-banner.is-open'), null, { timeout: 15000 }).catch(() => {});
    return { ctx, page, shopRequests, limited };
}

/** Geometry of the PDP buy decision at scroll 0. Runs in the page. */
function MEASURE_PDP() {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.height ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null; };
    const add = document.getElementById('add-to-cart-btn');
    const banner = document.querySelector('.consent-banner.is-open');
    const badge = document.getElementById('google-reviews-badge');
    const promise = document.querySelector('#product-promise:not([hidden]) .product-promise__label');
    const a = r(add);
    const hits = [];
    if (a) {
        const pts = [[(a.left + a.right) / 2, (a.top + a.bottom) / 2], [a.left + 3, a.top + 3], [a.right - 3, a.top + 3], [a.left + 3, a.bottom - 3], [a.right - 3, a.bottom - 3]];
        for (const [x, y] of pts) {
            const h = (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) ? document.elementFromPoint(x, y) : null;
            hits.push(h && (h === add || add.contains(h)) ? 'add' : (h ? (h.id ? '#' + h.id : String(h.className || h.tagName)).slice(0, 40) : 'offscreen'));
        }
    }
    return {
        vh: innerHeight, vw: innerWidth,
        title: document.getElementById('product-title')?.textContent.trim().slice(0, 60),
        add: a, banner: r(banner), badge: r(badge), promise: r(promise),
        promiseText: promise ? promise.textContent.trim() : null,
        badgeBottom: badge ? getComputedStyle(badge).bottom : null,
        hits, cls: +(window.__cls || 0).toFixed(3),
    };
}

const intersects = (a, b) => !!(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);

async function pdpCheck(vp, sku, { spacer = false } = {}) {
    const { ctx, page, limited } = await openPage(vp, `/p/${sku}`, { spacer: spacer ? '.product-info__actions' : null });
    const loaded = await page.waitForFunction(() => {
        const p = document.getElementById('product-price');
        return p && /\$\d/.test(p.textContent);
    }, null, { timeout: 30000 }).then(() => true, () => false);
    await page.waitForTimeout(2500);   // Google's badge + late layout
    const m = await page.evaluate(MEASURE_PDP);
    await ctx.close();
    const tag = `${vpName(vp)} ${sku}`;
    const inside = !!m.add && m.add.top >= 0 && m.add.bottom <= m.vh;
    const clear = !intersects(m.add, m.banner) && !intersects(m.add, m.badge);
    const hitOk = m.hits.length === 5 && m.hits.every((h) => h === 'add');
    return { m, tag, inside, clear, hitOk, pass: inside && clear && hitOk, loaded, limited };
}

async function shopFirstRow(vp, path, { spacer = false } = {}) {
    const { ctx, page, shopRequests, limited } = await openPage(vp, path, { spacer: spacer ? '#source-sections' : null });
    const loaded = await page.waitForFunction(() => document.querySelector('.product-card:not(.product-card--skeleton) .product-card__price'), null, { timeout: 30000 }).then(() => true, () => false);
    await page.waitForTimeout(2500);
    const m = await page.evaluate(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return b.height ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right } : null; };
        const cards = [...document.querySelectorAll('.products-row .product-card:not(.product-card--skeleton)')].filter((c) => c.getBoundingClientRect().height > 0);
        const firstTop = cards.length ? cards[0].getBoundingClientRect().top : null;
        const row = cards.filter((c) => Math.abs(c.getBoundingClientRect().top - firstTop) < 4);
        const banner = document.querySelector('.consent-banner.is-open');
        const badge = document.getElementById('google-reviews-badge');
        const h1 = document.querySelector('h1');
        const all = document.getElementById('family-all-link');
        return {
            vh: innerHeight,
            h1: h1 ? h1.textContent.trim() : null,
            label: document.getElementById('product-type-label')?.textContent.trim() || null,
            banner: r(banner), badge: r(badge),
            allLink: all && !all.hidden ? { text: all.textContent.trim(), href: all.getAttribute('href') } : null,
            firstTitle: cards[0]?.querySelector('.product-card__title')?.textContent.trim() || null,
            firstPack: !!cards[0]?.querySelector('.product-card__ribbon--value-pack'),
            cardTop: firstTop,
            row: row.map((c) => {
                const btn = c.querySelector('.product-card__cart-btn');
                const b = r(btn);
                let hit = null;
                if (b) {
                    const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
                    const h = (y >= 0 && y < innerHeight) ? document.elementFromPoint(x, y) : null;
                    hit = h && (h === btn || btn.contains(h)) ? 'add' : (h ? (h.id ? '#' + h.id : String(h.className || h.tagName)).slice(0, 30) : 'offscreen');
                }
                return { sku: c.dataset.sku, price: r(c.querySelector('.product-card__price')), add: b, hit };
            }),
        };
    });
    await ctx.close();
    if (!loaded || limited.length) {
        bad(`${vpName(vp)} ${path}: NOT MEASURED`, `${loaded ? 'cards painted' : 'no priced card painted'}; ${limited.length} × 429 — raise PROBE_PACE_MS`);
    }
    return { m, shopRequests, loaded: loaded && !limited.length };
}

/** Classify one first-row card at this viewport. */
function cardVerdict(card, m) {
    const p = card.price, a = card.add;
    if (!p || !a) return 'missing';
    if (p.bottom > m.vh || a.bottom > m.vh) return 'below-fold';
    if (intersects(a, m.banner) || intersects(p, m.banner)) return 'covered-by-consent';
    if (intersects(a, m.badge) || card.hit !== 'add') return 'covered-other';
    return 'clear';
}

try {
    /* ══ §1 PDP ════════════════════════════════════════════════════════════ */
    if (!ONLY || ONLY === 'pdp') {
        for (const vp of [...HANDOFF_VIEWPORTS, ...EXTRA_VIEWPORTS]) {
            head(`§1 PDP — ${vpName(vp)}${HANDOFF_VIEWPORTS.includes(vp) ? ' (handoff size)' : ''}`);
            for (const sku of PDP_SKUS) {
                const { m, tag, inside, clear, hitOk, loaded, limited } = await pdpCheck(vp, sku);
                if (!loaded || limited.length) {
                    bad(`${tag}: NOT MEASURED`, `${loaded ? 'price painted' : 'price never painted'}; ${limited.length} × 429 (${limited.slice(0, 2).map((u) => new URL(u).pathname).join(', ')}) — raise PROBE_PACE_MS`);
                    continue;
                }
                if (!m.add) { bad(`${tag}: Add to Cart rendered`, 'no #add-to-cart-btn box'); continue; }
                const a = m.add;
                console.log(`    ${tag}: Add ${Math.round(a.top)}–${Math.round(a.bottom)} x${Math.round(a.left)}–${Math.round(a.right)}`
                    + `  banner ${m.banner ? `${Math.round(m.banner.top)}–${Math.round(m.banner.bottom)} x${Math.round(m.banner.left)}–${Math.round(m.banner.right)}` : 'none'}`
                    + `  badge ${m.badge ? `${Math.round(m.badge.top)}–${Math.round(m.badge.bottom)} x${Math.round(m.badge.left)}` : 'none'}  CLS ${m.cls}`);
                check(`${tag}: Add fully inside the ${m.vh}px viewport`, inside, `bottom ${Math.round(a.bottom)}`);
                check(`${tag}: nothing fixed overlaps Add (consent, badge)`, clear);
                check(`${tag}: elementFromPoint returns Add at centre + 4 corners`, hitOk, m.hits.join(','));
                check(`${tag}: fit promise directly under Add and on screen`,
                    !!m.promise && m.promise.top >= a.bottom && m.promise.top - a.bottom <= 24 && m.promise.bottom <= m.vh,
                    m.promise ? `"${m.promiseText}" at ${Math.round(m.promise.top)}–${Math.round(m.promise.bottom)}` : 'no #product-promise label');
                if (!m.banner) soft(`${tag}: consent banner open`, 'not open — a first visit should show it; was consent already stored?');
                else if (vp.width >= 1100) {
                    check(`${tag}: consent is a bottom-left card (≤ 400px wide, left ≤ 24)`,
                        m.banner.right - m.banner.left <= 400 && m.banner.left <= 24,
                        `x${Math.round(m.banner.left)}–${Math.round(m.banner.right)}`);
                    check(`${tag}: Google badge NOT raised over the banner (computed bottom 0px)`, m.badgeBottom === null || m.badgeBottom === '0px', String(m.badgeBottom));
                    // The handoffs' VERTICAL acceptance, printed as-is so a re-run
                    // of their check is never a surprise: 2 Oct §1 "Add.bottom ≤
                    // banner.top"; 1 Oct §1 "above the top edge of EVERY fixed
                    // element" (the badge too). With the card bottom-LEFT and the
                    // badge bottom-RIGHT neither shares Add's columns, so the
                    // owner-accepted bar is the intersection + hit-test above.
                    const fixedTop = Math.min(m.banner.top, m.badge ? m.badge.top : Infinity);
                    info(`${tag}: handoffs' vertical metric Add.bottom ≤ min(banner.top, badge.top)`,
                        `${Math.round(a.bottom)} ≤ ${Math.round(fixedTop)} is ${a.bottom <= fixedTop} — card x ${Math.round(m.banner.left)}–${Math.round(m.banner.right)}, badge x ≥ ${m.badge ? Math.round(m.badge.left) : '—'}, Add x ${Math.round(a.left)}–${Math.round(a.right)}: no shared column, so overlap is measured above instead`);
                }
                if (m.cls >= 0.1) soft(`${tag}: CLS ${m.cls}`, 'target < 0.1');
            }
        }
    }

    /* ══ §2 /shop ══════════════════════════════════════════════════════════ */
    if (!ONLY || ONLY === 'shop') {
        for (const vp of [...HANDOFF_VIEWPORTS, ...EXTRA_VIEWPORTS]) {
            head(`§2 /shop code=288 — ${vpName(vp)}`);
            const { m, loaded } = await shopFirstRow(vp, '/shop?brand=epson&category=ink&code=288');
            if (!loaded) continue;
            check(`${vpName(vp)}: h1 names the code`, /\b288\b/.test(m.h1 || ''), `"${m.h1}"`);
            check(`${vpName(vp)}: visible label equals the h1`, m.label === m.h1, `"${m.label}"`);
            if (!m.row.length) { bad(`${vpName(vp)}: first row rendered`, 'no cards'); continue; }
            const verdicts = m.row.map((c) => ({ c, v: cardVerdict(c, m) }));
            console.log(`    card top ${Math.round(m.cardTop)}; first row: ${verdicts.map(({ c, v }) => `${c.sku} price ${Math.round(c.price?.top)} Add ${Math.round(c.add?.top)}–${Math.round(c.add?.bottom)} [${v}]`).join(' · ')}`);
            const first = m.row[0];
            // The compact card is a short-laptop layout (height ≤ 800); a tall
            // window keeps the full card, so the 250px budget is not asked there.
            if (vp.height <= 800) {
                check(`${vpName(vp)}: price + Add within 250px of the card top`, !!first.add && first.add.bottom - m.cardTop <= 250,
                    first.add ? `${Math.round(first.add.bottom - m.cardTop)}px` : 'no Add');
            }
            const below = verdicts.filter(({ v }) => v === 'below-fold' || v === 'missing' || v === 'covered-other');
            check(`${vpName(vp)}: no first-row price/Add below the fold or covered by anything but the consent card`, below.length === 0,
                below.map(({ c, v }) => `${c.sku}:${v}`).join(' ') || `${m.row.length} cards`);
            const covered = verdicts.filter(({ v }) => v === 'covered-by-consent');
            if (covered.length) soft(`${vpName(vp)}: ${covered.length} of ${m.row.length} first-row cards under the consent card until it is answered`, covered.map(({ c }) => c.sku).join(' '));
        }

        head('§2 /shop code=288XL — the ad\'s yield reaches the API and leads the page');
        {
            const { m, shopRequests } = await shopFirstRow({ width: 1366, height: 768 }, '/shop?brand=epson&category=ink&code=288XL');
            const xl = shopRequests.some((u) => new URL(u).searchParams.get('code') === '288XL');
            const fam = shopRequests.some((u) => new URL(u).searchParams.get('code') === '288');
            check('an /api/shop request carries code=288XL unchanged', xl, shopRequests.map((u) => new URL(u).search).join(' | ') || 'no /api/shop request');
            check('the family (code=288) is still fetched — 288XL alone returns only the 7 XL rows', fam);
            check('first card is a 288XL', /288XL/i.test(m.firstTitle || ''), `"${m.firstTitle}"`);
            check('the page still lists standard 288 below', m.row.length > 0, `${m.row.length} cards in row 1`);
        }

        head('§2 /shop pack=value_pack — passed through, packs first, way back to the family');
        {
            const { m, shopRequests } = await shopFirstRow({ width: 1366, height: 768 }, '/shop?brand=hp&category=ink&code=564&pack=value_pack');
            check('an /api/shop request carries pack=value_pack', shopRequests.some((u) => new URL(u).searchParams.get('pack') === 'value_pack'),
                shopRequests.map((u) => new URL(u).search).join(' | ') || 'no /api/shop request');
            check('first card is a value pack', m.firstPack, `"${m.firstTitle}"`);
            check('"See all … cartridges" link shown, without pack=', !!m.allLink && !/pack=/.test(m.allLink.href || ''), m.allLink ? `${m.allLink.text} → ${m.allLink.href}` : 'absent');
        }
    }

    /* ══ §3 negative controls ══════════════════════════════════════════════ */
    head('§3 NEGATIVE CONTROLS — a 200px spacer must turn each check red');
    if (!ONLY || ONLY === 'pdp') {
        const vp = { width: 1366, height: 599 };
        const r = await pdpCheck(vp, PDP_SKUS[0], { spacer: true });
        check('PDP: spacer above Add ⇒ the Add check FAILS', !r.pass, r.m.add ? `Add bottom ${Math.round(r.m.add.bottom)} of ${r.m.vh}` : 'no Add');
    }
    if (!ONLY || ONLY === 'shop') {
        const vp = { width: 1366, height: 599 };
        const { m } = await shopFirstRow(vp, '/shop?brand=epson&category=ink&code=288', { spacer: true });
        const anyBelow = m.row.some((c) => cardVerdict(c, m) === 'below-fold');
        check('/shop: spacer above the grid ⇒ the first-row check FAILS', anyBelow, `first Add bottom ${Math.round(m.row[0]?.add?.bottom)} of ${m.vh}`);
    }
} finally {
    await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed, ${softs} soft${fail ? '' : ' — all hard checks green'}`);
process.exit(fail ? 1 : 0);
