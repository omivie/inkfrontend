#!/usr/bin/env node
/**
 * probe-page-latency.mjs — `npm run probe:page-latency [-- --browser]`
 * =====================================================================
 * Re-measures the backend's 2026-09-21 page-load latency handoff against
 * PRODUCTION, item by item, so each FE fix it prompted (ERR-282 → ERR-285) has
 * a live check and not just a source test.
 *
 * MODE: READ-ONLY. Every request is a GET. Nothing is recorded to this repo.
 *
 *   §A static cache (ERR-282) — the HASHED /js + /css URL that live HTML
 *      references must be `immutable`; three NEGATIVE CONTROLS must still
 *      revalidate: the same file with no `?v=`, with a non-hex `?v=`, and the
 *      admin's hand-bumped APP_VERSION import. /assets is capped at a day.
 *      Without the controls, "immutable everywhere" would also read green —
 *      and that is exactly the change the handoff asked for and we refused.
 *   §B `/api/products/counts?brands=` returns data keyed by slug.
 *   §C `/api/images/optimize` with a REAL catalogue image goes MISS→HIT (a
 *      bogus url BYPASSes, which is how "DYNAMIC" was measured once).
 *      The other three handoff families live in `npm run audit:edge-cache`.
 *   §D (--browser) /shop and a PDP in a fresh context = a first-time visitor:
 *      - no OPTIONS preflight on any catalogue GET (ERR-282)
 *      - /shop brand counts cost at most ONE request (ERR-284)
 *      - the traffic beacon targets api.inkcartridges.co.nz (ERR-285)
 *
 * ANALYTICS SAFETY (ERR-254/257/271). A real page load WRITES: the traffic
 * beacon, GA4/Ads/UET hits, and — if a PDP slug fails to resolve — a search.
 * This probe owns its safety instead of borrowing it from the service: every
 * analytics/beacon/search URL is ABORTED in the browser before it leaves, and
 * its URL is still recorded (that is how §D reads the beacon host without
 * sending it). The PDP is opened by SKU, so no slug→search fallback runs. Only
 * the aborted URLs are routed; catalogue GETs are NOT, because a route handler
 * bypasses CORS and would erase the very preflights §D counts.
 *
 * EXIT: 0 all checks pass · 1 a check failed · 2 the probe could not run.
 */

const SITE = process.env.SITE || 'https://www.inkcartridges.co.nz';
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const BROWSER = process.argv.includes('--browser');

console.log('\n\x1b[1mprobe:page-latency — backend latency handoff 2026-09-21\x1b[0m');
console.log(`\x1b[33mMODE: READ-ONLY.\x1b[0m GET only. ${BROWSER ? 'Browser: analytics/beacon/search requests are ABORTED before they leave.' : 'No browser (pass --browser for §D).'}`);
console.log(`site ${SITE} · api ${API}\n`);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const get = (url, headers = {}) => fetch(url, { method: 'GET', headers: { Origin: SITE, ...headers } });
async function cacheControl(url) {
    const r = await get(url);
    await r.arrayBuffer();
    return { status: r.status, cc: r.headers.get('cache-control') || '', cf: r.headers.get('cf-cache-status') };
}

try {
    // ── §A static cache ─────────────────────────────────────────────────────
    console.log('§A static asset cache (ERR-282)');
    const html = await (await get(`${SITE}/shop`)).text();
    const js = html.match(/\/js\/api\.js\?v=([0-9a-f]{8})"/);
    const css = html.match(/\/css\/pages\.css\?v=([0-9a-f]{8})"/);
    if (!js || !css) throw new Error('live /shop HTML carries no stamped api.js / pages.css token');
    const immutable = (cc) => /max-age=31536000/.test(cc) && /immutable/.test(cc);
    const revalidates = (cc) => /max-age=0/.test(cc) && /must-revalidate/.test(cc);
    for (const [label, url] of [['api.js', `/js/api.js?v=${js[1]}`], ['pages.css', `/css/pages.css?v=${css[1]}`]]) {
        const r = await cacheControl(SITE + url);
        check(`hashed ${label} is immutable`, r.status === 200 && immutable(r.cc), `${url} → ${r.cc}`);
    }
    const adminHtml = await (await get(`${SITE}/js/admin/app.js`)).text();
    const appVersion = (adminHtml.match(/const APP_VERSION = '([^']+)'/) || [])[1];
    const controls = [
        ['bare /js/api.js (control)', '/js/api.js'],
        ['non-hex ?v= (control)', '/js/api.js?v=not-a-hash'],
        ['bare /css/pages.css (control)', '/css/pages.css'],
    ];
    if (appVersion) controls.push([`APP_VERSION import ?v=${appVersion} (control)`, `/js/admin/pages/dashboard.js?v=${appVersion}`]);
    else check('APP_VERSION readable from live admin/app.js', false, 'control could not be built');
    for (const [label, url] of controls) {
        const r = await cacheControl(SITE + url);
        check(`${label} still revalidates`, revalidates(r.cc) && !/immutable/.test(r.cc), `${r.status} ${r.cc}`);
    }
    const logo = await cacheControl(`${SITE}/assets/brands/hp.png`);
    check('/assets capped at one day, never immutable', /max-age=86400/.test(logo.cc) && !/immutable/.test(logo.cc), logo.cc);
    const doc = await cacheControl(`${SITE}/shop`);
    check('HTML document still revalidates', revalidates(doc.cc), doc.cc);

    // ── §B batch counts ─────────────────────────────────────────────────────
    console.log('\n§B /api/products/counts?brands= (ERR-284)');
    const counts = await (await get(`${API}/api/products/counts?brands=epson,hp,zzprobe-unknown`)).json();
    const hp = counts?.data?.hp;
    check('batch returns data keyed by slug', hp && Number.isFinite(hp.ink), JSON.stringify(hp));
    check('unknown slug reported, not 404ing the batch', (counts?.meta?.unknown_brands || []).includes('zzprobe-unknown'));

    // ── §C image optimiser edge cache ───────────────────────────────────────
    console.log('\n§C /api/images/optimize with a real image');
    const list = await (await get(`${API}/api/products?page=1&limit=1`)).json();
    const img = (list?.data?.products || list?.data || [])[0]?.image_url;
    if (!img) {
        check('a catalogue image url to measure with', false, 'none returned');
    } else {
        const url = `${API}/api/images/optimize?url=${encodeURIComponent(img)}&w=400&format=webp`;
        const seen = [];
        for (let i = 0; i < 3; i++) {
            seen.push((await cacheControl(url)).cf);
            if (seen.at(-1) === 'HIT') break;
            await new Promise((r) => setTimeout(r, 1500));
        }
        check('optimised image reaches an edge HIT', seen.includes('HIT'), seen.join('→'));
    }

    // ── §D browser ──────────────────────────────────────────────────────────
    if (BROWSER) {
        console.log('\n§D first-visit browser load (ERR-282/284/285)');
        const { chromium } = await import('playwright');
        const browser = await chromium.launch();
        const sku = (list?.data?.products || list?.data || [])[0]?.sku;
        const CATALOGUE = /\/api\/(products|shop|brands|site|printers|ribbons|schema)(\/|\?|$)/;
        const WRITES = /\/api\/analytics\/|\/api\/search\/|\/api\/cart-analytics|google-analytics\.com|googletagmanager\.com\/g\/collect|doubleclick\.net|googleadservices\.com|bat\.bing\.com/;
        try {
            for (const [label, path] of [['/shop', '/shop'], [`PDP ${sku}`, `/products/x/${encodeURIComponent(sku)}`]]) {
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                const aborted = [];
                await ctx.route(WRITES, (route) => { aborted.push(route.request().url()); return route.abort(); });
                const cdp = await ctx.newCDPSession(page);
                await cdp.send('Network.enable');
                const preflights = [];
                const gets = [];
                cdp.on('Network.requestWillBeSent', (e) => {
                    if (e.request.method === 'OPTIONS' || e.type === 'Preflight') preflights.push(e.request.url);
                    else if (e.request.url.startsWith(API)) gets.push(e.request.url);
                });
                await page.goto(SITE + path, { waitUntil: 'networkidle', timeout: 60000 });
                await page.waitForTimeout(2000);
                const cataloguePreflights = preflights.filter((u) => u.startsWith(API) && CATALOGUE.test(new URL(u).pathname + '?'));
                check(`${label}: no preflight on a catalogue GET`, cataloguePreflights.length === 0,
                    `${cataloguePreflights.length} of ${gets.length} API GETs preflighted${cataloguePreflights.length ? ': ' + cataloguePreflights.slice(0, 3).join(' | ') : ''} (all preflights: ${preflights.length})`);
                if (label === '/shop') {
                    const countCalls = gets.filter((u) => u.includes('/api/products/counts'));
                    check('/shop brand counts cost ≤ 1 request', countCalls.length <= 1 && countCalls.every((u) => u.includes('brands=')),
                        `${countCalls.length} call(s)`);
                    const tileText = await page.$$eval('[data-count]', (els) => els.map((e) => e.textContent).filter(Boolean));
                    check('/shop brand tiles show a count', tileText.length > 0, tileText.slice(0, 3).join(', ') || 'all blank');
                }
                const beacons = aborted.filter((u) => u.includes('/api/analytics/traffic-event'));
                if (beacons.length) {
                    const hosts = [...new Set(beacons.map((u) => new URL(u).host))];
                    check(`${label}: traffic beacon targets the api subdomain`, hosts.every((h) => h === new URL(API).host), hosts.join(', '));
                } else {
                    console.log(`  ·  ${label}: no traffic beacon fired within the window (not a pass, not a fail)`);
                }
                console.log(`  ·  ${label}: ${aborted.length} analytics/search request(s) aborted before leaving the browser`);
                await ctx.close();
            }
        } finally {
            await browser.close();
        }
    }
} catch (err) {
    console.error(`\n\x1b[31mprobe could not run:\x1b[0m ${err.message}`);
    process.exit(2);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
