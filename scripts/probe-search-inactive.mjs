#!/usr/bin/env node
/**
 * probe-search-inactive.mjs
 * =========================
 * ERR-378: a product deactivated in admin (KXP160 ribbon, SKU 72778.01) has no
 * product page, but the search dropdown still showed it. The backend's
 * "compatibility" match tier in /api/search/smart and /api/search/suggest does
 * not apply the is_active filter that its text tier and /api/products apply.
 *
 * This probe searches a few printer models and checks that every SKU a search
 * returns has a product page (GET /api/products/:sku is not 404). A 404 row is a
 * LEAK and fails the probe. The FE cannot filter these rows itself: search rows
 * carry no is_active field.
 *
 * MODE: READ-ONLY. GET requests only. No login, no cart, no admin call.
 * (Each /api/search/* GET still writes one search_analytics row server-side.)
 *
 * Negative control: a known-active SKU must resolve, or the run is
 * INCONCLUSIVE (exit 2). A dead or rate-limited API never reads as green.
 *
 *   npm run probe:search-inactive
 */
import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const PACE = Number(process.env.PROBE_PACE_MS || 700);
const QUERIES = (process.env.PROBE_QUERIES || 'KXP160,HL-L2375DW,MX511').split(',');
const CONTROL_SKU = 'C62XLBK';

console.log(`probe:search-inactive — MODE: READ-ONLY (GET only) against ${API}`);
console.log(SEARCH_ANALYTICS_NOTICE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
    await sleep(PACE);
    // Cache-buster: an edge-cached search answer must not hide a fix or a leak.
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${API}${path}${sep}_probe=${Date.now()}`, {
        headers: { 'User-Agent': 'probe-search-inactive (read-only)' },
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body };
}

const control = await get(`/api/products/${encodeURIComponent(CONTROL_SKU)}`);
if (control.status !== 200) {
    console.log(`INCONCLUSIVE  control ${CONTROL_SKU} returned ${control.status} — API down or rate-limited`);
    process.exit(2);
}
console.log(`  PASS  control: ${CONTROL_SKU} resolves (200)`);

const pageStatus = new Map(); // sku -> HTTP status of /api/products/:sku
let leaks = 0;
let checked = 0;
for (const q of QUERIES) {
    const enc = encodeURIComponent(q);
    const smart = await get(`/api/search/smart?q=${enc}&limit=24`);
    const suggest = await get(`/api/search/suggest?q=${enc}`);
    for (const [label, r, rows] of [
        ['smart', smart, smart.body?.data?.products],
        ['suggest', suggest, suggest.body?.data?.suggestions],
    ]) {
        if (r.status !== 200 || !Array.isArray(rows)) {
            console.log(`INCONCLUSIVE  ${label} q=${q} returned ${r.status} with no rows array`);
            process.exit(2);
        }
        for (const row of rows) {
            if (!row.sku) continue;
            if (!pageStatus.has(row.sku)) {
                pageStatus.set(row.sku, (await get(`/api/products/${encodeURIComponent(row.sku)}`)).status);
            }
            const st = pageStatus.get(row.sku);
            checked++;
            if (st === 404) {
                leaks++;
                console.log(`  FAIL  LEAK ${row.sku} in ${label} q=${q} (match_reason=${row.match_reason ?? '?'}) — product page 404`);
            } else if (st !== 200) {
                console.log(`INCONCLUSIVE  /api/products/${row.sku} returned ${st}`);
                process.exit(2);
            }
        }
    }
    console.log(`  q=${q}: smart ${smart.body.data.products.length} rows, suggest ${suggest.body.data.suggestions.length} rows`);
}

console.log(`\n${checked} search rows checked, ${pageStatus.size} distinct SKUs, ${leaks} leak(s).`);
process.exit(leaks ? 1 : 0);
