#!/usr/bin/env node
/**
 * Does a 500 from the catalogue reach the shopper as an ERROR or as "no products"?
 * ================================================================================
 * ERR-264 · Sep 2026
 *
 * On 2026-09-17 every route in the /api/products and /api/shop family answered
 * `500 {"ok":false,"error":{"code":"INTERNAL_ERROR"}}` for about ten minutes —
 * including `/api/products?limit=1` with no filters at all — while
 * /api/search/* and /api/brands stayed up throughout. It self-recovered.
 *
 * The frontend's answer to that was to say **"No products found for this
 * category."** `API.request()` RESOLVES `{ ok: false, status: 5xx }` for a
 * structured error rather than throwing, so the page-walk read it as "that was
 * the last page", cached the empty result for the session, and showed the empty
 * pane. No error, no Try again, and still wrong after the backend healed.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * tests/catalogue-error-vs-empty-sep2026.test.js runs the real decision against
 * fakes and proves the branch is right. It cannot prove the branch is REACHED —
 * that depends on the shape the live backend actually sends when it is unwell,
 * and on nothing between here and the browser rewriting it. §1 measures the
 * live shape; §2 drives a real browser into the failure and reads the pane.
 *
 * 🚨 MEASURE THE HOST THE BROWSER CALLS. `ink-backend-zaeq.onrender.com`
 * answers `cf-cache-status: DYNAMIC` on EVERY request, so measuring the Render
 * origin makes the edge look absent and clears it of suspicion falsely (ERR-263
 * lost an hour to this). `js/config.js` points production at
 * `api.inkcartridges.co.nz`, and that is the only host §1 will ask.
 *
 * ── MODE ───────────────────────────────────────────────────────────────────
 * READ-ONLY. GETs only, no --write, no --record. §2 does inject a fault, but it
 * injects it into OUR BROWSER, never into the backend: `route.fulfill()` answers
 * the page's own request locally and nothing leaves this machine for the routes
 * it intercepts.
 *
 * ⚠️ ON `ctx.route()`. The house rule is never to register one while measuring
 * a TRANSPORT claim — a route handler bypasses CORS and will happily certify a
 * request the browser would refuse to make. That rule is not in play here and
 * the distinction is the whole design of this file:
 *
 *   §1 measures transport (does the live origin 500? with what body? what
 *      headers?) and registers NO route at all. It is plain fetch.
 *   §2 measures a UI claim (given a 500, which pane does the page paint?) and
 *      the 500 has to be manufactured because a real outage cannot be summoned
 *      on demand. Nothing about CORS is being asserted.
 *
 * Do not merge the two passes.
 *
 * ── SEARCH ANALYTICS ───────────────────────────────────────────────────────
 * §2 loads a real search URL, and every GET to /api/search/* writes a
 * `search_analytics` row server-side (ERR-254). The banner says so on every run.
 *
 *   npm run probe:catalogue-outage
 *   npm run probe:catalogue-outage -- --headed
 *
 * Exit codes: 0 all good · 1 a pane was wrong · 2 could not run the browser pass.
 */

import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const API = 'https://api.inkcartridges.co.nz';
const SITE = 'https://inkcartridges.co.nz';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');

// §2 defaults to the deployed site. `--base` points it at a local server so a
// fix can be verified BEFORE it is pushed — without it this probe can only ever
// tell you what production already does, which is the one thing you knew.
//   npx serve inkcartridges -l 3000
//   npm run probe:catalogue-outage -- --base http://localhost:3000 --shop /html/shop.html
// (`serve` does not rewrite /shop, hence the explicit path.)
const argOf = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const BASE = argOf('--base', 'https://inkcartridges.co.nz');
const SHOP_PATH = argOf('--shop', '/shop');

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

console.log('');
console.log('  Catalogue outage → which pane does the shopper see?   (ERR-264)');
console.log('  ' + '─'.repeat(72));
console.log('  MODE: READ-ONLY of the backend. GETs only; §2 fulfils routes inside');
console.log('        our own browser and sends nothing to the origin for them.');
console.log('  HOST: ' + API + '   (never the Render origin — it says DYNAMIC forever)');
console.log('  §2:   ' + BASE + SHOP_PATH + '   ' + (BASE.includes('localhost') ? '(LOCAL BUILD)' : '(DEPLOYED)'));
console.log(SEARCH_ANALYTICS_NOTICE);
console.log('');

let failures = 0;

// ─────────────────────────────────────────────────────────────────────────────
// §1 — live shape of the catalogue family. No route handlers, plain fetch.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES = [
    ['/api/products?limit=1', 'the no-filter canary — it 500d too on 2026-09-17'],
    ['/api/products?brand=epson&page=1&limit=100', 'the brand walk the chip grid uses'],
    ['/api/products/G273HYC', 'a single SKU (the PDP)'],
    ['/api/shop?brand=epson&category=ink', 'the chip-grid endpoint'],
    ['/api/search/smart?q=273h&limit=10', 'stayed UP through the outage'],
    ['/api/brands', 'stayed UP through the outage'],
];

console.log('  §1  LIVE SHAPE');
for (const [path, why] of ROUTES) {
    let status = 'ERR';
    let rid = '';
    let body = '';
    let cache = '';
    try {
        const res = await fetch(API + path, { headers: { Origin: SITE } });
        status = String(res.status);
        rid = res.headers.get('x-request-id') || '';
        cache = res.headers.get('cf-cache-status') || '';
        const text = await res.text();
        body = text.slice(0, 90).replace(/\s+/g, ' ');
    } catch (e) {
        body = String(e && e.message);
    }
    const bad = status !== '200';
    const mark = bad ? RED('✗') : GREEN('✓');
    console.log(`   ${mark} ${status.padEnd(4)} ${path}`);
    console.log(DIM(`        ${why}`));
    if (cache) console.log(DIM(`        cf-cache-status: ${cache}`));
    if (bad) {
        console.log(DIM(`        x-request-id: ${rid || '(none)'}`));
        console.log(DIM(`        ${body}`));
        // A live 500 is INFORMATION, not a probe failure — this script exists
        // precisely to be run during one. It is reported, never counted.
    }
}
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the UI claim. Inject a 500 and read the pane.
// ─────────────────────────────────────────────────────────────────────────────

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch (e) {
    console.log(RED('  §2  SKIPPED — playwright is not installed. A SKIP IS NOT A PASS.'));
    console.log('');
    process.exit(2);
}

const FIVE_HUNDRED = {
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch products' } }),
};

/**
 * Load `url` with every request matching `breakGlob` answered by a 500, and
 * report which pane the drilldown ended up showing.
 */
async function paneUnder(browser, url, breakGlobs) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    for (const glob of breakGlobs) {
        await ctx.route(glob, (route) => route.fulfill(FIVE_HUNDRED));
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(20000);
    const state = await page.evaluate(() => {
        const err = document.getElementById('drilldown-error');
        const empty = document.getElementById('drilldown-empty');
        const msg = document.getElementById('error-message');
        const retry = document.getElementById('drilldown-retry-btn');
        return {
            error: !!(err && !err.hidden),
            empty: !!(empty && !empty.hidden),
            message: msg ? msg.textContent.trim() : null,
            retryVisible: !!(retry && retry.offsetParent !== null),
            cards: document.querySelectorAll('.product-card').length,
        };
    });
    await ctx.close();
    return state;
}

const browser = await chromium.launch({ headless: !HEADED });

console.log('  §2  WHICH PANE (with /api/products* and /api/shop* forced to 500)');
const CASES = [
    {
        name: 'brand + category drilldown',
        url: `${BASE}${SHOP_PATH}?brand=epson&category=ink`,
        globs: ['**/api/products*', '**/api/shop*'],
        want: 'error',
    },
];

for (const c of CASES) {
    let state;
    try {
        state = await paneUnder(browser, c.url, c.globs);
    } catch (e) {
        console.log(`   ${RED('✗')} ${c.name} — could not load: ${e.message}`);
        failures++;
        continue;
    }
    const got = state.error ? 'error' : state.empty ? 'empty' : state.cards ? 'products' : 'none';
    const ok = got === c.want;
    console.log(`   ${ok ? GREEN('✓') : RED('✗')} ${c.name}: showed the ${got} pane (wanted ${c.want})`);
    if (state.message) console.log(DIM(`        "${state.message}"`));
    if (!ok) {
        failures++;
        if (got === 'empty') {
            console.log(RED('        This is ERR-264 exactly: a 500 reported as "there are no products".'));
        }
    } else if (!state.retryVisible) {
        console.log(RED('        …but the Try again button is not visible — the pane is a dead end.'));
        failures++;
    }
}

await browser.close();

console.log('');
if (failures) {
    console.log(RED(`  ${failures} problem(s). A backend failure is being shown to shoppers as an empty catalogue.`));
    process.exit(1);
}
console.log(GREEN('  All good — a catalogue 500 reaches the shopper as a retryable error.'));
console.log('');
