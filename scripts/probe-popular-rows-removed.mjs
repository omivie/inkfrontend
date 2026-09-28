#!/usr/bin/env node
/**
 * probe-popular-rows-removed.mjs — are the "Popular … right now" and "Full
 * colour sets" rows gone, and gone with their REQUESTS? (ERR-290)
 * =============================================================================
 *
 * Owner, 2026-09-28 (backend handoff remove-popular-and-colour-set-rows-FE-
 * sep2026.md): "these two rows are no longer needed since users have different
 * printers requiring different cartridges. Please remove this logic across all
 * pages." This probe is that handoff's acceptance list, run in a real browser:
 *
 *   On every URL in the handoff's table, at desktop 1440x900 and phone 390x664:
 *   §1  no h2/h3 matching /Popular/ or /Full colour sets/ — in the DOM, hidden
 *       or not (the rows used to ship as `hidden` sections on every /shop URL,
 *       which is why the backend saw them on brand and search pages);
 *   §2  no request to /api/products/popular or /api/search/popular, and no
 *       `pack=value_pack` request (that one belongs to /value-packs only);
 *   §3  the first thing under the page title is the page's own content — the
 *       printer box / brand picker on a landing, the product list, the printer's
 *       products — never a row.
 *
 * NEGATIVE CONTROL (§4): /value-packs is the page the handoff says to KEEP, and
 * it is also the only page that SHOULD make a `pack=value_pack` request and
 * carry a "Full colour sets" heading. If §4 does not see both, the detectors in
 * §1/§2 are blind and their green means nothing. Checked FIRST.
 *
 * RED-PROOF: before the ERR-290 deploy, production fails §1 on every /shop URL
 * and §2 on /ink-cartridges, /toner-cartridges, /shop?category=consumable and
 * /ribbons — the recorded run is in errors.md under ERR-290.
 *
 * MODE: READ-ONLY. Public GETs only: no cart writes, no form submits, no
 * ctx.route() on any API path (only analytics beacons are aborted, which is not
 * a transport claim this probe makes). ONE URL navigates to /search?q= — the
 * browser's GET to /api/search/smart writes a `search_analytics` row, so its
 * term comes from probeQuery() (`zzprobe_…`, excluded by the backend). The
 * notice below says so on every run.
 *
 * Usage:  npm run probe:popular-rows-removed
 *         PROBE_BASE=http://localhost:3000 npm run probe:popular-rows-removed
 * Exit:   0 = all hard checks pass · 1 = a check failed · 2 = could not run
 */

import { chromium } from 'playwright';
import { PHONE, PHONE_SCALE } from './lib/mobile-viewports.mjs';
import { probeQuery, printSearchAnalyticsNotice } from './lib/probe-search-notice.mjs';

const BASE = (process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz').replace(/\/$/, '');
const DESKTOP = { width: 1440, height: 900 };
const SETTLE_MS = 5000;
/* PACING. Every page load here spends 10-20 requests from the backend's per-IP
 * rate limit (ERR-266: 100 per 60s, shared across endpoints). Unpaced, the
 * first local run 429'd /api/shop and /api/products/printer/* two-thirds of
 * the way through, and the page rendered its error pane — which §3 read as "no
 * level" on a DIFFERENT URL each run. A failure that moves is not the page; it
 * was this probe. So: a pause between loads, and one retry after the window
 * resets when a 429 is what stopped the render. A 429 that survives the retry is
 * reported as rate-limited, never as a pass. */
const PACE_MS = 6000;
const RATE_WINDOW_MS = 65000;
const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;

// Every row of the handoff's table. `kind` decides what §3 expects first.
const URLS = [
    { path: '/ink-cartridges', kind: 'landing' },
    { path: '/toner-cartridges', kind: 'landing' },
    { path: '/shop', kind: 'brands' },
    { path: '/shop?brand=brother', kind: 'listing' },
    { path: '/shop?brand=brother&code=LC73', kind: 'listing' },
    { path: '/shop?category=consumable', kind: 'brands' },
    { path: '/shop?brand=brother&printer_slug=brother-mfc-j5330dw', kind: 'printer' },
    { path: '/ribbons', kind: 'ribbons' },
    { path: `/search?q=${encodeURIComponent(probeQuery('norows_err290'))}`, kind: 'zero-results' },
];

const ROW_HEADING = /popular|full colou?r sets/i;
const ROW_REQUEST = /\/api\/(products|search)\/popular\b|[?&]pack=value_pack\b/;
const ROW_IDS = ['popular-row', 'value-pack-rail'];

let pass = 0, fail = 0, softs = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const soft = (n, d) => { softs++; console.log(`  \x1b[33m⚠ ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

console.log('\n\x1b[1mprobe:popular-rows-removed — the owner\'s 2026-09-28 removal, measured (ERR-290)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Public GETs only; no cart writes, no form submits, no ctx.route() on the API; analytics aborted.');
printSearchAnalyticsNotice();
console.log(`BASE ${BASE}  desktop ${DESKTOP.width}x${DESKTOP.height}  phone ${PHONE.width}x${PHONE.height}`);

/** Everything the three checks need, read from the settled page. */
const READ_PAGE = (rowIds) => {
    const visible = (el) => {
        if (!el || el.closest('[hidden]')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const describe = (el) => el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
        + `${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}` : null;
    const level = [...document.querySelectorAll('.drilldown-level')].find(visible) || null;
    // First visible block inside the visible level — or, on a zero-results page,
    // the recovery panel it holds.
    const first = level ? [...level.children].find(visible) || null : null;
    return {
        headings: [...document.querySelectorAll('h2, h3')].map((h) => ({
            text: h.textContent.replace(/\s+/g, ' ').trim(), shown: visible(h),
        })),
        rowIdsPresent: rowIds.filter((id) => document.getElementById(id)),
        level: describe(level),
        first: describe(first),
        firstHasBrands: !!(first && first.querySelector && first.querySelector('#brands-grid, #ribbons-brands-grid')),
        firstHasProducts: !!(first && first.querySelector && first.querySelector('.product-card')),
        productCards: level ? [...level.querySelectorAll('.product-card')].filter(visible).length : 0,
        recoveryTitles: [...document.querySelectorAll('.search-recovery__rail-title')].map((h) => h.textContent.trim()),
        colorPacksShown: visible(document.getElementById('color-packs-section')),
        h1: ((document.querySelector('h1') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
        cardsAnywhere: document.querySelectorAll('.product-card').length,
    };
};

const browser = await chromium.launch();
async function open(path, viewport) {
    const ctx = await browser.newContext(viewport === 'phone'
        ? { viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: PHONE_SCALE }
        : { viewport: DESKTOP });
    await ctx.route(ANALYTICS, (r) => r.abort());
    const page = await ctx.newPage();
    const requests = [];
    const apiErrors = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('response', (r) => {
        if (r.status() >= 400 && /\/api\//.test(r.url())) apiErrors.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    });
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    // Wait for the page to RENDER, not for a fixed time: a cold backend took
    // longer than 7s once on the first run and §3 read "no level" — a slow page,
    // not a missing one. Up to 30s for a level (or /value-packs' cards), then
    // SETTLE_MS more so late fetches (the rows used to be one) have fired.
    await page.waitForFunction(() => document.querySelector('.drilldown-level:not([hidden]), .value-page .product-card'),
        null, { timeout: 30000 }).catch(() => { /* §3 reports it — a skip is not a pass */ });
    await page.waitForTimeout(SETTLE_MS);
    const m = await page.evaluate(READ_PAGE, ROW_IDS);
    await ctx.close();
    return { m, requests, apiErrors };
}

let exitCode = 0;
try {
    /* ══ §4 FIRST — the negative control ════════════════════════════════════ */
    head('§4 negative control — /value-packs is KEPT, and it is what the detectors must see');
    const vp = await open('/value-packs', 'desktop');
    const vpReq = vp.requests.filter((u) => ROW_REQUEST.test(u));
    const controlSees = vpReq.some((u) => /pack=value_pack/.test(u));
    check('/value-packs makes its own pack=value_pack request (the request detector can see one)',
        controlSees, vpReq[0] ? vpReq[0].replace(/^https?:\/\/[^/]+/, '') : `none of ${vp.requests.length} requests matched`);
    // An h1, so §1's h2/h3 scan would not flag it anyway: the control is that
    // the kept page still carries the words and the packs.
    check('/value-packs keeps its "Full colour sets" heading', /full colou?r sets/i.test(vp.m.h1), `h1 "${vp.m.h1}"`);
    check('/value-packs still lists packs', vp.m.cardsAnywhere > 0, `${vp.m.cardsAnywhere} card(s)`);
    if (!controlSees) {
        console.log('\n\x1b[31mNEGATIVE CONTROL FAILED — §2 cannot be trusted on this run; stopping.\x1b[0m');
        exitCode = 1;
        throw new Error('control');
    }

    /* ══ §1-§3 every URL, both viewports ════════════════════════════════════ */
    for (const { path, kind } of URLS) {
        for (const vw of ['desktop', 'phone']) {
            head(`${path}  [${vw}]`);
            await new Promise((r) => setTimeout(r, PACE_MS));
            let { m, requests, apiErrors } = await open(path, vw);
            if (!m.first && apiErrors.some((e) => e.startsWith('429'))) {
                soft('rate-limited (429) before the page rendered — waiting for the window and retrying once',
                    apiErrors.slice(0, 3).join(' · '));
                await new Promise((r) => setTimeout(r, RATE_WINDOW_MS));
                ({ m, requests, apiErrors } = await open(path, vw));
            }

            const rowHeadings = m.headings.filter((h) => ROW_HEADING.test(h.text));
            check('§1 no h2/h3 matching /Popular|Full colour sets/ — shown or hidden',
                rowHeadings.length === 0,
                rowHeadings.length ? rowHeadings.map((h) => `"${h.text}"${h.shown ? '' : ' (hidden)'}`).join(', ') : `${m.headings.length} headings scanned`);
            check('§1 no row container in the DOM', m.rowIdsPresent.length === 0, m.rowIdsPresent.join(', ') || '');

            const rowReq = requests.filter((u) => ROW_REQUEST.test(u));
            check('§2 no popular / value_pack request', rowReq.length === 0,
                rowReq.length ? rowReq.map((u) => u.replace(/^https?:\/\/[^/]+/, '')).join(' · ') : `${requests.length} requests seen`);

            // §3 — what is first under the title. A page that never rendered has
            // nothing first and is NOT a pass: a skip is not a pass.
            if (!m.first) {
                bad(apiErrors.some((e) => e.startsWith('429'))
                    ? '§3 NOT EXERCISED — still rate-limited after the retry (not a pass)'
                    : '§3 page rendered its own content', `no visible drilldown level (level=${m.level}); `
                    + `API errors: ${apiErrors.slice(0, 6).join(' · ') || 'none'}`);
                continue;
            }
            const firstIsRow = ROW_IDS.some((id) => (m.first || '').includes('#' + id));
            if (kind === 'landing') {
                check('§3 first under the title: the printer box', m.first.includes('#landing-printer-search'), m.first);
            } else if (kind === 'brands' || kind === 'ribbons') {
                check('§3 first under the title: the brand picker', m.firstHasBrands && !firstIsRow, m.first);
            } else if (kind === 'zero-results') {
                check('§3 first under the title: the no-results panel', m.first.includes('#search-recovery') || m.first.includes('.search-recovery'), m.first);
                const popTitles = m.recoveryTitles.filter((t) => /popular/i.test(t));
                check('§3 no recovery rail titled "Popular"', popTitles.length === 0, m.recoveryTitles.join(' | '));
                check('§3 printer-finder / contact help is offered', m.recoveryTitles.some((t) => /can.t find it/i.test(t)), m.recoveryTitles.join(' | '));
            } else {
                // listing / printer: the page's own list — chips, codes or cards —
                // and never a row.
                check('§3 first under the title is the page\'s own list, not a row', !firstIsRow, `${m.first}, ${m.productCards} card(s) in level`);
                if (kind === 'printer') {
                    check('§3 the printer page rendered its products', m.productCards > 0, `${m.productCards} card(s)`);
                    if (m.colorPacksShown) {
                        soft('printer page shows "Colour Pack Bundles" above its products',
                            'this is the PRINTER\'s own packs (GET /api/printers/:slug/color-packs), not a best-seller row, '
                            + 'so it follows the owner\'s rule and was KEPT — flagged because it is the one thing that can '
                            + 'sit between the title and the product list.');
                    }
                }
            }
        }
    }
} catch (err) {
    if (err.message !== 'control') {
        console.error(`\n\x1b[31mcould not run: ${err.message}\x1b[0m`);
        exitCode = 2;
    }
} finally {
    await browser.close();
}

console.log(`\n${pass} passed · ${fail} failed · ${softs} warning(s)`);
if (exitCode === 0 && fail > 0) exitCode = 1;
process.exit(exitCode);
