#!/usr/bin/env node
/**
 * probe:shop-cls — does the shop family still hold its own height? (ERR-276)
 * ==========================================================================
 *
 * Backend handoff `mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md` §6.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * Layout shift has no error message, no failing request and no broken pixel in
 * a screenshot. The page is CORRECT a second later; it is only wrong while it
 * is arriving, which is exactly when a thumb is already moving. On a phone a
 * shift of this size is what makes someone tap the wrong thing.
 *
 * tests/shop-cls-reservation-sep2026.test.js pins the STRUCTURE that makes the
 * reservation work — the levels ship hidden, the loading block ships visible,
 * the /ribbons shelf ships its placeholders. It cannot prove a box is the size
 * it claims, and it stays green through a stylesheet that changes a tile's
 * height, a script that reveals a level earlier, or a shelf that grows a row.
 *
 * MEASURED BEFORE AND AFTER, same machine, same profile (2026-09-20):
 *
 *   route              before    after
 *   /ink-cartridges    0.679     0.007
 *   /toner-cartridges  0.674     0.007
 *   /ribbons           0.607     0.001
 *   /shop              0.089     0.001
 *
 * THE PROFILE IS PART OF THE MEASUREMENT. A laptop on office wifi reports this
 * site as fine; the shopper whose conversion rate the work exists to fix is on
 * a mid-range Android on 4G. So this throttles CPU 4x and the network to
 * ~1.6Mbps and says so on every run. Unthrottled numbers flatter the site and
 * say nothing — the defect only appears once DOMContentLoaded is late, and here
 * it lands at ~5s because the page carries ~973KB of third-party JavaScript.
 *
 * WHY IT WAITS RATHER THAN POLLING A SIGNAL. `layout-shift` entries keep
 * arriving for as long as the page is settling; asking too early reports a good
 * number for a page that has not finished being wrong yet. The wait is fixed
 * and generous, and the largest shift's timestamp is PRINTED so a run that
 * timed out early is visible rather than silently green.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * GETs against public pages. Nothing is clicked, nothing is added to a cart, no
 * form is submitted. It touches no /api/search/* endpoint, so it writes no
 * search_analytics row (ERR-254). There is no --record and no
 * --update-baseline, deliberately: a probe that can record may be green only
 * because it just overwrote what it compared against (sweep:b2b ate a committed
 * fixture, 2026-08-12). The mode is PRINTED on every run.
 *
 * There is NO ctx.route() in this file and there must never be one — a route
 * handler re-issues requests outside the browser's own enforcement and would
 * make this a measurement of the instrument rather than of the site.
 *
 * A FRESH CONTEXT PER ROUTE: a warm cache measures a page nobody arrives on.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly (ERR-229).
 *
 * Usage:  npm run probe:shop-cls
 *         PROBE_BASE=http://localhost:3000 npm run probe:shop-cls
 *         PROBE_ROUTES=/shop,/ribbons npm run probe:shop-cls
 * Exit:   0 = every route is inside the "good" CLS threshold
 *         1 = a route regressed past it
 *         2 = could not run
 */

import { chromium } from 'playwright';
import { PHONE as MOBILE_PHONE, PHONE_SCALE, describeViewport } from './lib/mobile-viewports.mjs';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const ROUTES = (process.env.PROBE_ROUTES || '/ink-cartridges,/toner-cartridges,/ribbons,/shop')
    .split(',').map((r) => r.trim()).filter(Boolean);

/* Google's thresholds, not ours. 0.1 is "good", 0.25 is the edge of "needs
 * improvement"; past that is "poor" and is what these pages were. */
const CLS_GOOD = 0.1;
const SETTLE_MS = 11000;

/* A mid-range Android on 4G — a Pixel-5 class profile. Changing these numbers
 * changes what the probe is measuring, so they are named and printed. */
/* ERR-280: the phone box comes from playwright's own device registry now.
   Every probe here hand-wrote { 390, 844 }, which is the iPhone 13's PHYSICAL
   SCREEN; its usable viewport after Safari's chrome is 390x664. The 180px
   difference is larger than the consent banner, so overlaps that are real on a
   phone did not reproduce at 844. See scripts/lib/mobile-viewports.mjs. */
const PHONE = MOBILE_PHONE;
const CPU_THROTTLE = 4;
const NET = { latencyMs: 150, downMbps: 1.6, upMbps: 0.75 };
const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };

/* Collect every layout shift, with the element and the rects it moved between.
 * A bare CLS number tells you the page is wrong; the source tells you which
 * element to open. `buffered: true` catches the shifts that happen before this
 * observer is installed, which are the early ones that matter most. */
const OBSERVE = () => {
    window.__cls = 0;
    window.__shifts = [];
    const describe = (n) => {
        if (!n || !n.tagName) return 'detached';
        const cls = String(n.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        return `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${cls ? '.' + cls : ''}`;
    };
    new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            window.__cls += e.value;
            window.__shifts.push({
                value: +e.value.toFixed(4),
                t: Math.round(e.startTime),
                sources: (e.sources || []).map((s) => {
                    const p = s.previousRect; const c = s.currentRect;
                    /* Source rects are VIEWPORT-CLIPPED. An element pushed off the
                     * bottom reports a zero currentRect — it was not removed, it
                     * left the screen. Printing both rects keeps that readable. */
                    return `${describe(s.node)} [y ${Math.round(p.y)}->${Math.round(c.y)}, h ${Math.round(p.height)}->${Math.round(c.height)}]`;
                }),
            });
        }
    }).observe({ type: 'layout-shift', buffered: true });
};

console.log('\n\x1b[1mprobe:shop-cls — does the shop family hold its own height? (ERR-276)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no writes.');
console.log(`Target: ${BASE}`);
console.log(`Profile: ${describeViewport(PHONE)}, CPU ${CPU_THROTTLE}x throttle, `
    + `${NET.downMbps}Mbps / ${NET.latencyMs}ms — a mid-range Android on 4G, not a laptop.`);
console.log(`Threshold: CLS <= ${CLS_GOOD} ("good"). Settle window: ${SETTLE_MS}ms.\n`);

let browser;
let fatal = null;
try {
    browser = await chromium.launch();
    for (const route of ROUTES) {
        const ctx = await browser.newContext({
            viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: PHONE_SCALE, userAgent: PIXEL_UA,
        });
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: NET.latencyMs,
            downloadThroughput: (NET.downMbps * 1e6) / 8,
            uploadThroughput: (NET.upMbps * 1e6) / 8,
        });
        await page.addInitScript(OBSERVE);

        let loaded = true;
        try {
            await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 90000 });
        } catch (err) {
            loaded = false;
            soft(`${route} did not load`, err.message.split('\n')[0]);
        }

        if (loaded) {
            await page.waitForTimeout(SETTLE_MS);
            const r = await page.evaluate(() => ({
                cls: +window.__cls.toFixed(4),
                shifts: window.__shifts.filter((s) => s.value > 0.0005).sort((a, b) => b.value - a.value).slice(0, 4),
                /* Did the page actually finish? A blank page has a perfect CLS.
                 * This is the control that stops a broken render reading green. */
                rendered: {
                    brandTiles: document.querySelectorAll('#brands-grid .drilldown-box, #ribbons-brands-grid .drilldown-box').length,
                    popularCards: document.querySelectorAll('#popular-row-grid .product-card:not(.product-card--placeholder)').length,
                    placeholdersLeft: document.querySelectorAll('.product-card--placeholder').length,
                    levelVisible: !!document.querySelector('.drilldown-level:not([hidden])'),
                    loadingVisible: !(document.getElementById('drilldown-loading') || { hidden: true }).hidden,
                },
            }));

            const verdict = r.cls <= CLS_GOOD ? 'good' : r.cls <= 0.25 ? 'needs improvement' : 'POOR';
            console.log(`\x1b[1m── ${route} — CLS ${r.cls} (${verdict}) ──\x1b[0m`);
            for (const s of r.shifts) {
                console.log(`    ${String(s.value).padEnd(8)} @${String(s.t).padStart(6)}ms  ${s.sources.join('\n                            ')}`);
            }
            if (!r.shifts.length) console.log('    (no shift above 0.0005)');
            console.log(`    rendered: ${r.rendered.brandTiles} brand tile(s), ${r.rendered.popularCards} popular card(s), `
                + `${r.rendered.placeholdersLeft} placeholder(s) left, level visible=${r.rendered.levelVisible}, `
                + `loading visible=${r.rendered.loadingVisible}`);

            /* THE CONTROL COMES FIRST. A page that never rendered has a perfect
             * CLS and proves nothing, so a blank render is NOT EXERCISED rather
             * than a pass — a skip is not a pass. */
            if (!r.rendered.levelVisible || r.rendered.brandTiles === 0) {
                soft(`${route} never finished rendering — its CLS of ${r.cls} measures nothing`,
                    `level visible=${r.rendered.levelVisible}, brand tiles=${r.rendered.brandTiles}. `
                    + 'A page that stayed on its skeleton cannot shift, so this number is not a pass.');
            } else if (r.cls <= CLS_GOOD) {
                ok(`${route} holds its height`, `CLS ${r.cls} <= ${CLS_GOOD}`);
            } else {
                bad(`${route} shifts past the "good" threshold`,
                    `CLS ${r.cls}. Largest: ${r.shifts[0] ? `${r.shifts[0].value} at ${r.shifts[0].t}ms from ${r.shifts[0].sources[0]}` : 'unattributed'}. `
                    + 'The reservation comes from html/shop.html and html/ribbons.html shipping the '
                    + 'drilldown levels `hidden` and #drilldown-loading VISIBLE, so the skeleton holds '
                    + 'the box before any script runs. Check that first.');
            }

            if (r.rendered.placeholdersLeft > 0) {
                bad(`${route} left ${r.rendered.placeholdersLeft} placeholder(s) on screen`,
                    'the /ribbons shelf placeholders must be replaced by real cards or the section '
                    + 'hidden. A shimmering card that never resolves promises content that is not coming.');
            }
        }
        await ctx.close();
    }
} catch (err) {
    fatal = err;
} finally {
    if (browser) await browser.close();
}

console.log('\n────────────────────────────────────────────────────────');
if (fatal) {
    console.log(`\x1b[31mCOULD NOT RUN\x1b[0m — ${fatal.message}`);
    process.exit(2);
}
console.log(`${pass} passed, ${failures.length} failed, ${notes.length} not exercised`);
if (notes.length) {
    console.log('\n\x1b[33mNot exercised (a skip is not a pass):\x1b[0m');
    notes.forEach((n) => console.log(`  ~ ${n}`));
}
if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
}
console.log('\x1b[32mEvery shop route holds its height on a throttled phone.\x1b[0m');
process.exit(0);
