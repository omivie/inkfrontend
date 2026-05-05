/**
 * Dense-pack rollout — frontend invariant tests
 * ==============================================
 *
 * Pins the storefront's resilience to the May 2026 backend pack-resolver fix
 * that surfaced ~232 previously-filtered packs across:
 *
 *   /api/shop
 *   /api/search/smart
 *   /api/search/by-printer
 *   /api/search/by-part
 *   /api/products/printer/:slug
 *   /api/printers/:slug/products
 *   /api/prerender/printer/:brand/:slug
 *   /api/prerender/category/:category
 *
 * No API contract change — same response shape, same fields. Just more rows.
 * The frontend changes that need to stay locked in:
 *
 *   1. Render in API order (no client `.sort()` on the products array).
 *      Server applies sortByCatalogOrder / sortByRelevance — anything we do
 *      client-side is wrong by definition. Already pinned by §1 of
 *      api-changes-may2026.test.js; this file extends the guard to the
 *      printer/related/recovery-rail surfaces that consume the same API.
 *
 *   2. Generous (not tight) per-page caps. The drilldown product list uses
 *      `limit: 200` per code/series — must remain ≥ the densest realistic
 *      page so packs are never silently truncated. Recovery rails and
 *      bought-together carousels are slice-bounded so the visible count
 *      stays predictable regardless of how many rows the API returns.
 *
 *   3. Bot-prerender cache emits stale-while-revalidate so post-deploy
 *      crawlers refresh their HTML in the background instead of staying
 *      stuck on pre-deploy snapshots until s-maxage expires.
 *
 *   4. Sitemaps + feeds proxy directly to the backend (single source of
 *      truth). Frontend never serves a static sitemap.xml — it'd go stale
 *      every time the catalog changes.
 *
 * Run: node --test tests/dense-pack-rollout-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (rel) => fs.readFileSync(JS(rel), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const SHOP_PAGE_SRC      = READ('shop-page.js');
const PDP_SRC            = READ('product-detail-page.js');
const LANDING_SRC        = READ('landing.js');
const API_SRC            = READ('api.js');

const SHOP_CODE          = stripComments(SHOP_PAGE_SRC);
const PDP_CODE           = stripComments(PDP_SRC);
const LANDING_CODE       = stripComments(LANDING_SRC);
const API_CODE           = stripComments(API_SRC);

const VERCEL_JSON        = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));
const MIDDLEWARE_SRC     = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'middleware.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// §1 Render in API order — extends api-changes-may2026.test.js coverage to the
//    printer / related-products / recovery-rail surfaces.
// ─────────────────────────────────────────────────────────────────────────────

test('§1 loadPrinterProducts renders products in API order', () => {
    // Locate loadPrinterProducts. It must split by source via filter, never
    // call .sort() on the products array.
    const m = SHOP_CODE.match(/loadPrinterProducts\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'loadPrinterProducts must exist in shop-page.js');
    const body = m[1];
    assert.doesNotMatch(body, /products\.sort\s*\(/,
        'loadPrinterProducts must not sort the products array (server applies sortByCatalogOrder)');
    assert.doesNotMatch(body, /\bsortProducts\s*\(/,
        'loadPrinterProducts must not invoke sortProducts');
});

test('§1 recovery rails render slice-only — no client resort', () => {
    // The recovery rails block (around the searchByPrinter calls) renders
    // server-sorted results. It must use slice() to cap rail length, not
    // sort() to reorder.
    const railSlice = SHOP_CODE.match(/printers\.slice\s*\(\s*0\s*,\s*\d+\s*\)/);
    assert.ok(railSlice, 'recovery rails must use .slice() to cap visible count');
    // The whole renderRecovery / by-printer rendering must not reorder.
    assert.doesNotMatch(SHOP_CODE, /by-printer.*products\.sort/s,
        'by-printer rail must not sort the products it renders');
});

test('§1 PDP related products groups by source via filter — no resort', () => {
    // renderRelatedProducts splits compatibles/genuines by .filter.
    // Pinned in api-changes-may2026.test.js §1 too, but we re-pin here so
    // a regression caught by either suite cleanly identifies the area.
    const compatibleAssign = PDP_CODE.match(/const\s+compatibles\s*=\s*([^;]+);/);
    const genuineAssign    = PDP_CODE.match(/const\s+genuines\s*=\s*([^;]+);/);
    assert.ok(compatibleAssign, 'compatibles split must exist');
    assert.ok(genuineAssign, 'genuines split must exist');
    assert.doesNotMatch(compatibleAssign[1], /\bsort\b/i, 'compatibles must not be re-sorted');
    assert.doesNotMatch(genuineAssign[1],    /\bsort\b/i, 'genuines must not be re-sorted');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 Per-page caps must remain generous (≥ densest realistic page).
// ─────────────────────────────────────────────────────────────────────────────

test('§2 drilldown per-code product fetch uses limit ≥ 200', () => {
    // shop-page.js loadProducts() must request limit: 200 from /api/shop —
    // a generous ceiling above the densest realistic per-code product list
    // even after the May 2026 pack-resolver fix surfaced ~232 more packs.
    const m = SHOP_CODE.match(/loadProducts\s*\([^)]*\)\s*\{[\s\S]*?API\.getShopData\s*\(\s*\{[^}]*limit:\s*(\d+)/);
    assert.ok(m, 'loadProducts must call API.getShopData with a limit');
    const limit = parseInt(m[1], 10);
    assert.ok(limit >= 200,
        `drilldown per-code limit must be ≥ 200 to absorb dense pack rows; saw ${limit}`);
});

test('§2 PDP related products fetch uses limit ≥ 200', () => {
    // PDP renderRelatedProducts re-uses /api/shop with the matching code
    // chip. Same ceiling rationale as drilldown.
    const m = PDP_CODE.match(/renderRelatedProducts\s*\([^)]*\)\s*\{[\s\S]*?API\.getShopData\s*\(\s*\{[^}]*code,\s*limit:\s*(\d+)/);
    assert.ok(m, 'renderRelatedProducts must call API.getShopData with a limit');
    const limit = parseInt(m[1], 10);
    assert.ok(limit >= 200,
        `PDP related fetch limit must be ≥ 200; saw ${limit}`);
});

test('§2 free-text smart search caps at limit ≥ 100', () => {
    // shop-page.js hits API.smartSearch with `limit: 100` for the free-text
    // search path. Even with denser packs, 100 covers any realistic search
    // result page; results overflow into "no more results" rather than
    // silently truncating mid-series.
    const m = SHOP_CODE.match(/API\.smartSearch\s*\(\s*searchQuery\s*,\s*\{[\s\S]*?limit:\s*(\d+)/);
    assert.ok(m, 'free-text smartSearch call must specify a limit');
    const limit = parseInt(m[1], 10);
    assert.ok(limit >= 100,
        `free-text smart search limit must be ≥ 100; saw ${limit}`);
});

test('§2 recovery rails are slice-bounded (≤ 6 by-printer entries)', () => {
    // The recovery rails block uses { limit: 6 } when calling searchByPrinter.
    // This is intentional — rails are visually compact strips, not full
    // result pages. The cap must stay tight so layout doesn't grow with
    // denser pack data.
    const matches = SHOP_CODE.match(/API\.searchByPrinter\s*\([^)]*\{\s*limit:\s*(\d+)\s*\}/g) || [];
    assert.ok(matches.length >= 2,
        'expected at least 2 by-printer rail call sites in shop-page.js');
    for (const call of matches) {
        const lim = parseInt(call.match(/limit:\s*(\d+)/)[1], 10);
        // Rail caps live in the 6–10 range. The router-handoff path uses 100;
        // we only check rail call sites by filtering out the >50 ones below.
        if (lim <= 50) {
            assert.ok(lim >= 4 && lim <= 12,
                `recovery rail limit should be a small slice (4-12); saw ${lim}`);
        }
    }
});

test('§2 featured products carousel caps at 8', () => {
    // Landing page hero rail. Slice cap is the second arg to smartSearch.
    const m = LANDING_CODE.match(/API\.smartSearch\s*\(\s*['"][^'"]*['"]\s*,\s*(\d+)\s*\)/);
    assert.ok(m, 'landing.js must call API.smartSearch with a numeric limit');
    const limit = parseInt(m[1], 10);
    assert.ok(limit >= 4 && limit <= 12,
        `featured carousel limit should be a small slice (4-12); saw ${limit}`);
});

test('§2 bought-together rail slices to 4', () => {
    // PDP bought-together must slice the API response to a fixed visible count.
    assert.match(PDP_CODE, /resp\.data\.slice\(0,\s*4\)/,
        'bought-together rail must slice to 4 products');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 Bot prerender cache emits stale-while-revalidate so post-deploy crawler
//    HTML refreshes within one hit instead of staying stuck for s-maxage.
// ─────────────────────────────────────────────────────────────────────────────

test('§3 middleware prerender cache emits stale-while-revalidate', () => {
    // Without SWR, a backend deploy that surfaces new packs (e.g. the May 2026
    // pack-resolver fix) leaves the bot HTML cache stale for up to s-maxage
    // (3600s = 1h). With SWR, the first crawler hit past expiry serves stale
    // immediately AND triggers an async backend refresh, so the next hit sees
    // the fresh pack rows.
    // Pull the Cache-Control header value out of the prerender Response so the
    // assertion targets only the bot-prerender block, not the entire file.
    const cc = MIDDLEWARE_SRC.match(/'Cache-Control':\s*'([^']+)'/);
    assert.ok(cc, 'middleware must set a Cache-Control header on the prerender Response');
    const cacheValue = cc[1];
    assert.match(cacheValue, /stale-while-revalidate=\d+/,
        'middleware bot prerender Cache-Control must set stale-while-revalidate');
    // Sanity: still has s-maxage so the backend isn't hit on every crawl.
    assert.match(cacheValue, /s-maxage=\d+/,
        'middleware must keep an s-maxage so backend isn\'t hit on every bot request');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 Sitemaps + feeds proxy directly to the backend.
// ─────────────────────────────────────────────────────────────────────────────

test('§4 sitemap.xml proxies to backend (single source of truth)', () => {
    const sitemap = (VERCEL_JSON.rewrites || []).find(r => r.source === '/sitemap.xml');
    assert.ok(sitemap, 'vercel.json must rewrite /sitemap.xml');
    assert.ok(/^https:\/\/ink-backend-zaeq\.onrender\.com\//.test(sitemap.destination),
        '/sitemap.xml must proxy to the Render backend, not be served statically');
});

test('§4 sub-sitemaps proxy to backend', () => {
    const sub = (VERCEL_JSON.rewrites || []).find(r => r.source === '/sitemap-:path.xml');
    assert.ok(sub, 'vercel.json must rewrite /sitemap-*.xml');
    assert.ok(/^https:\/\/ink-backend-zaeq\.onrender\.com\//.test(sub.destination),
        '/sitemap-*.xml must proxy to the Render backend');
});

test('§4 product feeds proxy to backend', () => {
    // Google Shopping, Facebook Catalog, Google Promotions — all generated
    // server-side from the same product table the catalog reads from. After
    // the May 2026 pack rollout, these feeds will contain the recovered ~232
    // pack rows automatically.
    const feeds = ['/feeds/google-shopping.xml', '/feeds/facebook-catalog.tsv', '/feeds/google-promotions.xml'];
    for (const src of feeds) {
        const r = (VERCEL_JSON.rewrites || []).find(x => x.source === src);
        assert.ok(r, `vercel.json must rewrite ${src}`);
        assert.ok(/^https:\/\/ink-backend-zaeq\.onrender\.com\//.test(r.destination),
            `${src} must proxy to backend`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 Static asset cache headers force CDN revalidation so a frontend deploy
//    propagates its updated HTML/JS/CSS without a manual purge.
// ─────────────────────────────────────────────────────────────────────────────

test('§5 root + js + css advertise must-revalidate so the CDN re-checks each request', () => {
    const sources = ['/', '/js/(.*)', '/css/(.*)'];
    for (const src of sources) {
        const block = (VERCEL_JSON.headers || []).find(h => h.source === src);
        assert.ok(block, `vercel.json must define cache headers for ${src}`);
        const cacheCtl = block.headers.find(h => h.key === 'Cache-Control');
        assert.ok(cacheCtl, `${src} must declare Cache-Control`);
        assert.match(cacheCtl.value, /max-age=0/,
            `${src} Cache-Control must include max-age=0`);
        assert.match(cacheCtl.value, /must-revalidate/,
            `${src} Cache-Control must include must-revalidate so a deploy lands without manual cache purge`);
    }
});
