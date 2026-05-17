/**
 * Polished-slug SEO contract — frontend pins
 * ===========================================
 *
 * Pins the May 2026 "polished slugs" rollout. The system has two response paths
 * to the same product URL, distinguished by User-Agent:
 *
 *   • Bot UA  (Googlebot, AhrefsBot, etc.): bot-prerender middleware serves
 *     fully-rendered HTML at 200 OK with stale-while-revalidate caching.
 *   • Human UA: backend issues 301 redirects from short / loser URLs to the
 *     polished canonical URL; humans then render the SPA at that URL.
 *
 * The frontend's part of the contract:
 *
 *   1. vercel.json proxies /p/:sku and sitemap-* to backend (pass-through).
 *   2. Every product card / cart / favourite / checkout surface that builds a
 *      product link consumes `product.canonical_url` first, falling back to
 *      `/products/<slug>/<sku>` only when canonical_url is absent.
 *   3. product-detail-page.js normalises window.location to the polished slug
 *      via history.replaceState whenever the current pathname differs from the
 *      backend's canonical_url. Covers entry via /p/:sku, /products/:loser/:sku,
 *      /product/:slug, and ?slug=… — all collapse to the canonical URL bar.
 *   4. product-detail-page.js renders <link rel="canonical">, og:url, and
 *      Product JSON-LD url with the canonical_url value.
 *
 * Why this exists:
 *
 *   - Removing canonical_url plumbing from any one surface lets that surface
 *     emit a loser-slug URL on the next render and split SEO signal.
 *   - Reverting the SPA replaceState back to its `cameFromShortUrl` gating
 *     would leave loser-slug entries in the URL bar, weakening canonical signal.
 *   - Repointing the Vercel rewrites away from backend breaks the 301 chain
 *     for non-bot traffic.
 *
 * Live verification (post-deploy):
 *   node scripts/verify_polished_slugs.mjs --sample 9
 *
 * Run unit assertions:
 *   node --test tests/polished-slugs-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const VERCEL_JSON = JSON.parse(READ(path.join(ROOT, 'inkcartridges', 'vercel.json')));
const PDP_SRC = READ(JS('product-detail-page.js'));
const PRODUCTS_SRC = READ(JS('products.js'));
const CART_SRC = READ(JS('cart.js'));
const SHOP_SRC = READ(JS('shop-page.js'));
const LANDING_SRC = READ(JS('landing.js'));
const FAVOURITES_SRC = READ(JS('favourites.js'));

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — vercel.json proxies the SEO endpoints to backend
// ─────────────────────────────────────────────────────────────────────────────

test('§1 vercel.json rewrites /p/:sku to backend (so backend can issue the 301 / serve prerendered HTML)', () => {
    const rw = VERCEL_JSON.rewrites.find((r) => r.source === '/p/:sku');
    assert.ok(rw, '/p/:sku rewrite must exist in vercel.json');
    assert.match(rw.destination, /ink-backend-zaeq\.onrender\.com\/p\/:sku$/,
        '/p/:sku must proxy to backend so the 301 / bot-prerender are reachable');
});

test('§1 vercel.json rewrites /html/p/:sku to backend (alt entry into bot-prerender)', () => {
    const rw = VERCEL_JSON.rewrites.find((r) => r.source === '/html/p/:sku');
    assert.ok(rw, '/html/p/:sku rewrite must exist');
    assert.match(rw.destination, /ink-backend-zaeq\.onrender\.com\/html\/p\/:sku$/);
});

test('§1 vercel.json rewrites sitemap-*.xml to backend (Googlebot must reach the live sitemap)', () => {
    const root = VERCEL_JSON.rewrites.find((r) => r.source === '/sitemap.xml');
    const sub = VERCEL_JSON.rewrites.find((r) => r.source === '/sitemap-:path.xml');
    assert.ok(root, '/sitemap.xml rewrite required');
    assert.ok(sub, '/sitemap-:path.xml rewrite required');
    assert.match(root.destination, /ink-backend-zaeq\.onrender\.com\/sitemap\.xml$/);
    assert.match(sub.destination, /ink-backend-zaeq\.onrender\.com\/sitemap-:path\.xml$/);
});

test('§1 vercel.json keeps brand-listing redirects permanent (301, not 302)', () => {
    const brandRedirects = VERCEL_JSON.redirects.filter((r) => /^\/brand[s]?\//.test(r.source));
    assert.ok(brandRedirects.length >= 3, 'expected /brand/:slug + /brands/:slug + /brands/:slug/hub redirects');
    for (const r of brandRedirects) {
        assert.equal(r.permanent, true, `${r.source} must be permanent (301) for SEO`);
        assert.match(r.destination, /^\/shop\?brand=/);
    }
});

test('§1 vercel.json /robots.txt is proxied to backend (not a stale static file)', () => {
    const rw = VERCEL_JSON.rewrites.find((r) => r.source === '/robots.txt');
    assert.ok(rw, '/robots.txt rewrite required');
    assert.match(rw.destination, /ink-backend-zaeq\.onrender\.com\/robots\.txt$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Every card-rendering surface consumes product.canonical_url first
// ─────────────────────────────────────────────────────────────────────────────

const CARD_SURFACES = [
    { label: 'products.js (card listings)', src: PRODUCTS_SRC },
    { label: 'shop-page.js (chip drilldown + listings)', src: SHOP_SRC },
    { label: 'cart.js (cart line items + remove flow)', src: CART_SRC },
    { label: 'landing.js (homepage promo rows)', src: LANDING_SRC },
    { label: 'favourites.js (saved items)', src: FAVOURITES_SRC },
];

for (const { label, src } of CARD_SURFACES) {
    test(`§2 ${label} reads product.canonical_url before falling back to /products/<slug>/<sku>`, () => {
        const code = stripComments(src);
        assert.match(code, /\.canonical_url/,
            `${label} must reference canonical_url — removing it splits SEO signal`);
        // The fallback construction must remain (legacy responses), but it must
        // appear *after* the canonical_url branch — pin that ordering loosely
        // by ensuring `new URL(...canonical_url).pathname` precedes any
        // `/products/${...}/${...}` template literal.
        const canonicalIdx = code.indexOf('.canonical_url');
        const fallbackIdx = code.search(/\/products\/\$\{[^}]+\}\/\$\{[^}]+\}/);
        if (canonicalIdx >= 0 && fallbackIdx >= 0) {
            assert.ok(canonicalIdx < fallbackIdx,
                `${label}: canonical_url branch must precede the slug-template fallback`);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — product-detail-page.js normalises URL bar to canonical on every entry
// ─────────────────────────────────────────────────────────────────────────────

test('§3 PDP normaliser is unconditional — fires whenever current path differs from canonical', () => {
    const code = stripComments(PDP_SRC);
    // The normaliser block must NOT be gated by a single-entry flag like
    // `if (cameFromShortUrl)` that would skip loser-slug entries.
    assert.doesNotMatch(code, /if\s*\(\s*cameFromShortUrl\s*\)\s*\{\s*const\s+canonicalPath/,
        'replaceState must not be gated on cameFromShortUrl — loser slugs (/products/<wrong>/<SKU>) need normalising too');
    // It must still pull canonical_url first and compare against current path.
    assert.match(code, /this\.product\.canonical_url/,
        'PDP must read this.product.canonical_url');
    assert.match(code, /canonicalPath\s*!==\s*window\.location\.pathname/,
        'PDP must skip replaceState when path already matches canonical (avoid history spam)');
    assert.match(code, /window\.history\.replaceState\(\s*\{\s*\}\s*,\s*''\s*,\s*canonicalPath/,
        'PDP must call replaceState with the canonical path');
});

test('§3 PDP renders <link rel="canonical"> and og:url from canonical_url', () => {
    const code = stripComments(PDP_SRC);
    assert.match(code, /info\.canonical_url\s*\|\|/,
        'PDP must prefer info.canonical_url for the rendered <link rel="canonical">');
    assert.match(code, /getElementById\(\s*['"]canonical-url['"]\s*\)\.href\s*=\s*canonicalUrl/,
        'PDP must assign canonicalUrl to #canonical-url href');
    assert.match(code, /getElementById\(\s*['"]og-url['"]\s*\)\.content\s*=\s*canonicalUrl/,
        'PDP must assign canonicalUrl to og:url meta content');
    // The client-side Product JSON-LD `"url": canonicalUrl` assertion was
    // retired by marketing-audit-may-2026.md §4: the PDP no longer emits ANY
    // client-side Product JSON-LD (the backend prerender layer is the single
    // source). The <link rel="canonical"> + og:url tags above remain the
    // client-side canonical signals. See tests/marketing-audit-may2026.test.js
    // for the no-client-JSON-LD pin.
    assert.doesNotMatch(code, /["']url["']\s*:\s*canonicalUrl/,
        'PDP must NOT emit client-side Product JSON-LD (audit §4) — no "url": canonicalUrl');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Guard against regressions in the canonical-url contract
// ─────────────────────────────────────────────────────────────────────────────

test('§4 No surface emits an unconditional `/products/<slug>/<sku>` without first checking canonical_url', () => {
    // Scan every JS file under inkcartridges/js for /products/${...}/${...}
    // patterns. Any file that uses the pattern must also reference canonical_url
    // somewhere — the actual ordering check lives in §2 for known card surfaces.
    const jsDir = path.join(ROOT, 'inkcartridges', 'js');
    const walk = (dir) => {
        const out = [];
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) out.push(...walk(full));
            else if (ent.name.endsWith('.js')) out.push(full);
        }
        return out;
    };
    const files = walk(jsDir);
    const violations = [];
    for (const f of files) {
        const code = stripComments(fs.readFileSync(f, 'utf8'));
        if (!/\/products\/\$\{[^}]+\}\/\$\{[^}]+\}/.test(code)) continue;
        if (!/canonical_url/.test(code)) violations.push(path.relative(ROOT, f));
    }
    assert.deepEqual(violations, [],
        `These files build /products/<slug>/<sku> URLs without consulting canonical_url first:\n  ${violations.join('\n  ')}`);
});

test('§4 product-detail-page.js still falls back to slug-from-product when canonical_url is missing', () => {
    // Old API responses may not carry canonical_url; the legacy slug+sku
    // construction is the safety net. Removing it would 404 those pages.
    const code = stripComments(PDP_SRC);
    assert.match(code, /\/products\/\$\{[^}]*encodeURIComponent\([^}]*slug[^}]*\)[^}]*\}\/\$\{[^}]*encodeURIComponent\([^}]*sku[^}]*\)/,
        'PDP must keep the slug+sku fallback construction for legacy API responses');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — README of behaviour for future readers (executes as a no-op)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 contract documentation embedded in this file mentions the two UA paths', () => {
    const self = READ(__filename);
    assert.match(self, /Bot UA/);
    assert.match(self, /Human UA/);
    assert.match(self, /bot-prerender/);
    assert.match(self, /history\.replaceState/);
});
