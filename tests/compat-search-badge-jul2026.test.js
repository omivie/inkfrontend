/**
 * Compatibility ("FOR USE IN") search — FE robustness + badge — July 2026
 * =======================================================================
 *
 * The bug (ERR-083)
 * -----------------
 * Searching a MACHINE the customer owns returned nothing. q=VP6000 → "No
 * results", even though the Canon AP800 Compatible Typewriter Ribbon (SKU
 * 307.11) lists VP6000 in its free-text "FOR USE IN:" block. That block lives
 * in `compatible_devices_html`, which was never indexed for search.
 *
 * The backend fixed the index: /api/search/smart now surfaces such products
 * with `source:"compatible"`, `match_tier:3`, `relevance_score:25`, and two
 * new fields — `match_reason:"compatibility"` and `matched_token:"<query>"`.
 * (Verified live 2026-07-16: q=VP6000 → 307.11, C141LOT, C143LOT.)
 *
 * The FE side pinned here
 * -----------------------
 * 1. ROBUSTNESS. loadSearchResults' reconciliation (search-results-parity)
 *    swaps a thin `/smart` set for the literal /api/products + /suggest union
 *    on digit queries (softMiss) or autocorrected queries (hijack). "VP6000"
 *    is digit-shaped and its compat rows do NOT literally match name/sku, so
 *    without a guard they'd be swapped for a union that (being name/sku-only)
 *    can never contain them — silently dropping the customer's answer. A new
 *    pure helper `hasCompatibilityMatch` gates BOTH softMiss and hijack: a
 *    compat set is a deliberate backend hit, not a miss.
 * 2. BADGE. createProductCard renders a "Fits <model>" chip (teal
 *    `product-card__badge--compat-match`) for compat rows, mirroring the
 *    `_fitsPrinter` → "Fits Your Printer" chip, so the card explains why it
 *    surfaced. matched_token is escaped (escapeHtml text / escapeAttr title).
 *
 * Run: node --test tests/compat-search-badge-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHOP_JS_PATH  = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');
const SEARCH_CSS_PATH = path.join(ROOT, 'inkcartridges', 'css', 'search.css');

const SHOP_SRC = fs.readFileSync(SHOP_JS_PATH, 'utf8');
const SEARCH_CSS = fs.readFileSync(SEARCH_CSS_PATH, 'utf8');

// Strip comments so a literal inside a comment can't satisfy a source assertion.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const SHOP_CODE = stripComments(SHOP_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure reconciliation helpers out of shop-page.js (only top-level
// declarations run on load — the DrilldownNav methods never execute). Mirrors
// tests/search-results-parity-may2026.test.js.
// ─────────────────────────────────────────────────────────────────────────────
function loadShopHelpers() {
    const doc = {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
        body: { appendChild() {} },
        documentElement: { style: {} },
        cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat,
        setTimeout, clearTimeout,
        document: doc,
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    const helpers = sandbox.window._searchParityHelpers;
    assert.ok(helpers, 'shop-page.js must expose window._searchParityHelpers');
    return helpers;
}

// Live-verified fixture (curl'd 2026-07-16), trimmed to the fields the guard
// reads. The AP800 ribbon surfaced ONLY because VP6000 is in its "for use in"
// list — the token appears nowhere in its name or sku.
const VP6000_COMPAT = [
    { id: 'eebf2228', sku: '307.11',  name: 'Canon  AP800 Compatible Typewriter Ribbon 307.11', source: 'compatible', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'VP6000' },
    { id: '20e3c4a5', sku: 'C141LOT', name: 'IBM Compatible 141LOT Correction Ribbon Tape',      source: 'compatible', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'VP6000' },
];
const DIRECT_MATCHES = [
    { id: 'd1', sku: 'GCL511', name: 'Canon Genuine CL511 Ink Cartridge Colour', source: 'genuine' },
    { id: 'd2', sku: 'CCL511CLR', name: 'CL511CLR Compatible Ink Cartridge for Canon CL511', source: 'compatible' },
];

// ═════════════════════════════════════════════════════════════════════════════
// hasCompatibilityMatch — the reconciliation guard
// ═════════════════════════════════════════════════════════════════════════════
test('hasCompatibilityMatch — true when any row is a compatibility match', () => {
    const { hasCompatibilityMatch } = loadShopHelpers();
    assert.equal(hasCompatibilityMatch(VP6000_COMPAT), true);
    // Even one compat row among direct matches flips it (protects the whole set).
    assert.equal(hasCompatibilityMatch([...DIRECT_MATCHES, VP6000_COMPAT[0]]), true);
});

test('hasCompatibilityMatch — false for a name/SKU-only result set', () => {
    const { hasCompatibilityMatch } = loadShopHelpers();
    assert.equal(hasCompatibilityMatch(DIRECT_MATCHES), false);
    // A compatible-SOURCE product is NOT a compatibility MATCH — the guard keys
    // strictly on match_reason, not on product.source.
    assert.equal(hasCompatibilityMatch([{ sku: 'X', source: 'compatible' }]), false);
});

test('hasCompatibilityMatch — safe on null / empty / malformed input', () => {
    const { hasCompatibilityMatch } = loadShopHelpers();
    assert.equal(hasCompatibilityMatch(null), false);
    assert.equal(hasCompatibilityMatch(undefined), false);
    assert.equal(hasCompatibilityMatch([]), false);
    assert.equal(hasCompatibilityMatch([null, undefined]), false);
    assert.equal(hasCompatibilityMatch('not an array'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// Reconciliation wiring — the guard must gate BOTH swap paths
// ═════════════════════════════════════════════════════════════════════════════
test('loadSearchResults — computes hasCompatMatch from the /smart result set', () => {
    assert.match(SHOP_CODE, /const\s+hasCompatMatch\s*=\s*hasCompatibilityMatch\(products\)/);
});

test('loadSearchResults — softMiss is gated by !hasCompatMatch', () => {
    // Isolate the softMiss assignment and confirm the guard is one of its terms.
    const m = SHOP_CODE.match(/const\s+softMiss\s*=([\s\S]*?);/);
    assert.ok(m, 'softMiss assignment must exist');
    assert.match(m[1], /!hasCompatMatch/,
        'softMiss must not fire when the set contains compatibility matches');
});

test('loadSearchResults — hijack is gated by !hasCompatMatch', () => {
    const m = SHOP_CODE.match(/const\s+hijack\s*=([\s\S]*?);/);
    assert.ok(m, 'hijack assignment must exist');
    assert.match(m[1], /!hasCompatMatch/,
        'hijack must not fire when the set contains compatibility matches');
});

// ═════════════════════════════════════════════════════════════════════════════
// createProductCard — the "Fits <model>" badge
// ═════════════════════════════════════════════════════════════════════════════
test('createProductCard — builds a compat-match badge guarded by match_reason + matched_token', () => {
    const m = SHOP_CODE.match(/const\s+compatMatchBadge\s*=([\s\S]*?);\n/);
    assert.ok(m, 'compatMatchBadge must be defined in createProductCard');
    const expr = m[1];
    assert.match(expr, /product\.match_reason\s*===\s*['"]compatibility['"]/,
        'badge must be gated on match_reason === "compatibility"');
    assert.match(expr, /product\.matched_token/,
        'badge must require matched_token');
    assert.match(expr, /product-card__badge--compat-match/,
        'badge must carry the compat-match CSS class');
});

test('createProductCard — matched_token is escaped in both text and attribute', () => {
    const m = SHOP_CODE.match(/const\s+compatMatchBadge\s*=([\s\S]*?);\n/);
    const expr = m[1];
    assert.match(expr, /Security\.escapeHtml\(product\.matched_token\)/,
        'visible token text must go through Security.escapeHtml');
    assert.match(expr, /Security\.escapeAttr\(product\.matched_token\)/,
        'token in the title attribute must go through Security.escapeAttr');
});

test('createProductCard — chip-stack renders when ANY of fits-printer / compat / suggested badge is present', () => {
    // search-ux-frontend-jul2026 §1 added a third chip (suggestedBadge); the
    // stack must include it and appear whenever any of the three exists.
    assert.match(
        SHOP_CODE,
        /\(fitsPrinterBadge\s*\|\|\s*compatMatchBadge\s*\|\|\s*suggestedBadge\)\s*\?\s*`<div class="product-card__chip-stack">\$\{fitsPrinterBadge\}\$\{compatMatchBadge\}\$\{suggestedBadge\}<\/div>`/,
        'the chip-stack must emit all three badges and appear whenever any exists'
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// CSS
// ═════════════════════════════════════════════════════════════════════════════
test('search.css — defines the compat-match badge style', () => {
    assert.match(SEARCH_CSS, /\.product-card__badge--compat-match\s*\{/,
        'search.css must style .product-card__badge--compat-match');
});
