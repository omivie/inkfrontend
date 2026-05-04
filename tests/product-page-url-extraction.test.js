/**
 * Product page URL extraction
 * ===========================
 *
 * The product detail page (`inkcartridges/js/product-detail-page.js`) accepts
 * a SKU from many URL shapes:
 *
 *   1.  ?sku=<SKU>                          (legacy query-string)
 *   2.  ?slug=<SLUG>                        (legacy slug-only)
 *   3.  /ribbon/:sku                        (typewriter ribbons)
 *   4.  /products/:slug/:sku                (canonical SEO)
 *   5.  /product/:slug                      (legacy slug-only path)
 *   6.  /p/:sku                             (short link)
 *
 * In production Vercel rewrites /p/:sku to the Render backend's 301 handler so
 * the browser ends up on /products/:slug/:sku before any frontend JS runs. On
 * localhost (`npx serve inkcartridges`) the rewrite in serve.json points
 * /p/** at the static product page directly, so the page JS itself has to
 * extract the SKU from the path. This regressed silently when the /p/:sku
 * shape was added: clicking a search-bar product card on localhost showed
 * "No product specified".
 *
 * This test pins the path-matching regex contract for product-detail-page.js
 * and asserts the file contains the wiring needed to:
 *   - extract a SKU from /p/<sku>
 *   - canonicalise the URL bar to /products/<slug>/<sku> after a successful
 *     load that started from /p/<sku>
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.resolve(
    __dirname,
    '..',
    'inkcartridges',
    'js',
    'product-detail-page.js',
);
const SRC = fs.readFileSync(SOURCE, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural: the regex contract for each path shape.
// ─────────────────────────────────────────────────────────────────────────────

// The same patterns hard-coded in product-detail-page.js. If these drift,
// the tests below fail and the source needs to update with them.
const RIBBON_RE   = /^\/ribbon\/(.+)$/;
const CANONICAL_RE = /^\/products\/[^/]+\/(.+)$/;
const LEGACY_SLUG_RE = /^\/product\/([^/]+)\/?$/;
const SHORT_RE    = /^\/p\/(.+)$/;

test('ribbon path regex extracts the sku', () => {
    const m = '/ribbon/RIBBON-123-XYZ'.match(RIBBON_RE);
    assert.ok(m);
    assert.equal(decodeURIComponent(m[1]), 'RIBBON-123-XYZ');
});

test('canonical /products/:slug/:sku regex extracts the sku, ignoring the slug', () => {
    const m = '/products/brother-genuine-tn2449-toner/G-BRO-TN2449-TNR-BK'.match(CANONICAL_RE);
    assert.ok(m);
    assert.equal(decodeURIComponent(m[1]), 'G-BRO-TN2449-TNR-BK');
});

test('legacy /product/:slug regex extracts the slug (no SKU)', () => {
    const m = '/product/brother-genuine-tn2449-toner'.match(LEGACY_SLUG_RE);
    assert.ok(m);
    assert.equal(decodeURIComponent(m[1]), 'brother-genuine-tn2449-toner');
});

test('legacy /product/:slug regex tolerates trailing slash', () => {
    const m = '/product/brother-genuine-tn2449-toner/'.match(LEGACY_SLUG_RE);
    assert.ok(m);
    assert.equal(decodeURIComponent(m[1]), 'brother-genuine-tn2449-toner');
});

test('short /p/:sku regex extracts the sku', () => {
    const m = '/p/G-BRO-TN2449-TNR-BK'.match(SHORT_RE);
    assert.ok(m);
    assert.equal(decodeURIComponent(m[1]), 'G-BRO-TN2449-TNR-BK');
});

test('short /p/:sku regex handles URL-encoded SKUs', () => {
    const m = '/p/G%2FBRO%2FTN2449'.match(SHORT_RE);
    assert.ok(m);
    assert.equal(decodeURIComponent(m[1]), 'G/BRO/TN2449');
});

test('short /p/:sku regex does NOT match /products/...', () => {
    // Sanity — make sure the cheap /p/ shape can't accidentally swallow the
    // canonical /products/<slug>/<sku> path.
    assert.equal('/products/foo/BAR'.match(SHORT_RE), null);
});

test('short /p/:sku regex does NOT match /p (no SKU)', () => {
    assert.equal('/p/'.match(SHORT_RE), null);
    assert.equal('/p'.match(SHORT_RE), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Static analysis: the source file actually wires up each shape in init().
// ─────────────────────────────────────────────────────────────────────────────

test('product-detail-page.js init() handles /ribbon/:sku', () => {
    assert.ok(SRC.includes('/^\\/ribbon\\/(.+)$/'));
});

test('product-detail-page.js init() handles /products/:slug/:sku', () => {
    assert.ok(SRC.includes('/^\\/products\\/[^/]+\\/(.+)$/'));
});

test('product-detail-page.js init() handles /product/:slug', () => {
    assert.ok(SRC.includes('/^\\/product\\/([^/]+)\\/?$/'));
});

test('product-detail-page.js init() handles /p/:sku', () => {
    // The fix: this regex was missing before; clicking a /p/<sku> link on
    // localhost showed "No product specified".
    assert.ok(
        SRC.includes('/^\\/p\\/(.+)$/'),
        '/p/:sku regex must be present in product-detail-page.js init()',
    );
});

test('product-detail-page.js canonicalises the URL bar after loading from /p/:sku', () => {
    // After a successful load from a /p/<sku> short link we replaceState to
    // the canonical /products/<slug>/<sku> so reloads, sharing, and back
    // navigation all use the SEO URL.
    assert.match(SRC, /cameFromShortUrl/);
    assert.match(SRC, /window\.history\.replaceState\(/);
});

test('product-detail-page.js short-link path matcher runs only when no SKU yet', () => {
    // The /p/<sku> matcher must be guarded by `if (!sku)` so a request with
    // both ?sku=A and a /p/B path doesn't silently flip to /p/B's value.
    const idx = SRC.indexOf('/^\\/p\\/(.+)$/');
    assert.ok(idx > -1, '/p/:sku regex must be in source');
    // Walk back through the source to find the most recent guard that opens
    // the surrounding block. It must be `if (!sku) {`.
    const before = SRC.slice(Math.max(0, idx - 800), idx);
    const lastGuard = before.lastIndexOf('if (!sku)');
    const lastOpenBrace = before.lastIndexOf('{');
    assert.ok(
        lastGuard > -1 && lastOpenBrace > lastGuard,
        '/p/:sku block must be guarded by `if (!sku) {` so it never overrides ?sku=',
    );
});
