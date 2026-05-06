/**
 * May 2026 catalog overhaul — frontend contract tests
 * ====================================================
 *
 * Pins the storefront's adoption of `readfirst/api-changes-may2026.md`.
 *
 * What this file guards against:
 *
 *   §1  Sort order — server now applies sortByCatalogOrder /
 *       sortByRelevance on every product-list endpoint. The frontend must
 *       NOT re-sort. `Shop.renderProducts` must render in API order;
 *       `ProductDetail._sortByColor` must stay deleted; PDP related
 *       products must be filtered (by source) without resorting.
 *
 *   §2  Compatible name format — backend ships
 *       "Compatible <Type> Cartridge Replacement for <Brand> <Codes> <Color>".
 *       Frontend must NOT regex `name` to detect source. `Shop` /
 *       `ProductDetail` / `Cart` / `Checkout` / `Favourites` must read
 *       `product.source` (and the cart's `_isCompatible` helper must read
 *       `product_source` first, with the legacy substring as a final
 *       fallback for old localStorage rows).
 *
 *   §4  Series chip cache — bumped to v6 so Epson specialty colors
 *       collapse into base T-series chips (T3127 → T312) and bare-numeric
 *       Epson chips (212, 802, 46S, 604) appear.
 *
 *   §6  Pending Changes — `partial` status is rendered, reviewable, and
 *       counted on the Pending tab; rows that move pending→partial don't
 *       vanish before the admin finishes them.
 *
 *   §extractSeriesCodes — `ProductDetail.extractProductCode` prefers the
 *       backend-supplied `info.series_codes[0]` over its per-brand regex.
 *
 * Run: node --test tests/api-changes-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
const CART_SRC           = READ('cart.js');
const CHECKOUT_SRC       = READ('checkout-page.js');
const FAVOURITES_SRC     = READ('favourites.js');
const PENDING_SRC        = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'pending-changes.js'), 'utf8');

const SHOP_CODE          = stripComments(SHOP_PAGE_SRC);
const PDP_CODE           = stripComments(PDP_SRC);
const CART_CODE          = stripComments(CART_SRC);
const CHECKOUT_CODE      = stripComments(CHECKOUT_SRC);
const FAVOURITES_CODE    = stripComments(FAVOURITES_SRC);
const PENDING_CODE       = stripComments(PENDING_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// §1 Sort order — render in API order
// ─────────────────────────────────────────────────────────────────────────────

test('§1 Shop.renderProducts renders in API order — does NOT call sortProducts/byYieldAndColor', () => {
    // Locate the renderProducts method body.
    const m = SHOP_CODE.match(/renderProducts\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'expected to find renderProducts method body in shop-page.js');
    const body = m[1];
    assert.doesNotMatch(body, /\bsortProducts\s*\(/,
        'renderProducts must not call sortProducts — server-side sortByCatalogOrder is canonical (api-changes-may2026.md §1)');
    assert.doesNotMatch(body, /\bByYieldAndColor\b/i,
        'renderProducts must not invoke ProductSort.byYieldAndColor');
    assert.doesNotMatch(body, /products\.sort\s*\(/,
        'renderProducts must not call .sort() on the products array');
});

test('§1 Shop.renderProducts dropped the legacy options.preserveOrder branch', () => {
    // The `preserveOrder` opt-in is gone; preservation is the unconditional default.
    assert.doesNotMatch(SHOP_CODE, /options\.preserveOrder\s*\?/,
        'no caller should need a preserveOrder flag — every API list response is server-sorted');
});

test('§1 ProductDetail._sortByColor stays deleted', () => {
    assert.doesNotMatch(PDP_CODE, /\b_sortByColor\s*\(/,
        '_sortByColor must not be called — server-side sortByCatalogOrder is canonical');
    assert.doesNotMatch(PDP_CODE, /_sortByColor\s*\(\s*products\s*\)\s*\{/,
        '_sortByColor function definition must be removed');
});

test('§1 ProductDetail.renderRelatedProducts filters by source, then applies the canonical color tier (May 2026 override)', () => {
    // `compatibles` and `genuines` start as filtered slices, then get a stable
    // `ProductSort.byColor(…)` pass to enforce K→C→M→Y→CMY→KCMY display order
    // (color-display-order-may2026.md). The forbidden helpers are the legacy
    // `_sortByColor` and `byYieldAndColor` — those would override the
    // backend's primary series/yield grouping. `byColor` is colour-only and
    // stable, so it preserves that grouping inside a tier.
    const compatibleAssign = PDP_CODE.match(/const\s+compatibles\s*=\s*([^;]+);/);
    const genuineAssign    = PDP_CODE.match(/const\s+genuines\s*=\s*([^;]+);/);
    assert.ok(compatibleAssign, 'compatibles assignment must exist in renderRelatedProducts');
    assert.ok(genuineAssign,    'genuines assignment must exist in renderRelatedProducts');
    for (const [label, src] of [['compatibles', compatibleAssign[1]], ['genuines', genuineAssign[1]]]) {
        assert.doesNotMatch(src, /\b_sortByColor\b/, `${label} must not call the legacy _sortByColor`);
        assert.doesNotMatch(src, /\bbyYieldAndColor\b/i,
            `${label} must not call byYieldAndColor — that would override the backend's seriesBase/yieldTier sort`);
        assert.match(src, /sortByColor\s*\(\s*related\.filter|ProductSort\.byColor/,
            `${label} must apply the canonical K→C→M→Y→CMY→KCMY tier via ProductSort.byColor (color-display-order-may2026.md)`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 Compatible name format — stop parsing names
// ─────────────────────────────────────────────────────────────────────────────

test('§2 ProductDetail.getProductInfo reads product.source — no name.includes("compatible") fallback', () => {
    // Capture only the getProductInfo function body, not later methods.
    const m = PDP_CODE.match(/getProductInfo\s*\(\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'expected to find getProductInfo method body');
    const body = m[1];
    assert.doesNotMatch(body, /name(Lower)?\.includes\(\s*['"]compatible['"]\s*\)/i,
        'getProductInfo must not fall back to nameLower.includes("compatible")');
    assert.match(body, /p\.source\s*===\s*['"]compatible['"]/,
        'getProductInfo must read p.source === "compatible"');
});

test('§2 ProductDetail.inferSource (renderRelatedProducts) trusts product.source', () => {
    // The function should now be a one-liner: `(p) => p.source || info.source || 'genuine'`.
    const m = PDP_CODE.match(/const\s+inferSource\s*=\s*\(p\)\s*=>\s*([^;]+);/);
    assert.ok(m, 'expected inferSource arrow function in renderRelatedProducts');
    const expr = m[1];
    assert.doesNotMatch(expr, /name\.startsWith/i, 'inferSource must not name.startsWith("compatible")');
    assert.doesNotMatch(expr, /slug\.startsWith/i, 'inferSource must not slug.startsWith("compatible-")');
    assert.doesNotMatch(expr, /sku\.startsWith/i,  'inferSource must not sku.startsWith("comp-")');
    assert.match(expr, /p\.source/, 'inferSource must read p.source');
});

test('§2 ProductDetail.extractProductCode prefers backend series_codes', () => {
    const m = PDP_CODE.match(/extractProductCode\s*\(info\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'expected extractProductCode method body');
    const body = m[1];
    assert.match(body, /info\.series_codes/,
        'extractProductCode must consult info.series_codes (backend canonical)');
    // The series_codes branch must come BEFORE any `info.name` regex pass.
    const seriesIdx = body.indexOf('info.series_codes');
    const nameIdx   = body.indexOf('info.name');
    assert.ok(seriesIdx >= 0, 'series_codes mention must exist');
    assert.ok(nameIdx   >= 0, 'name mention must still exist (legacy fallback)');
    assert.ok(seriesIdx < nameIdx,
        'series_codes branch must appear BEFORE the name regex fallback (priority order)');
});

test('§2 Cart, Checkout, Favourites read source via Cart._isCompatible — no inline name fallback', () => {
    // The badge code now delegates to Cart._isCompatible, which encapsulates
    // the product_source > legacy-source > leading-word-name precedence.
    for (const [name, code] of [['cart', CART_CODE], ['checkout', CHECKOUT_CODE], ['favourites', FAVOURITES_CODE]]) {
        // Inline `(item.name || '').toLowerCase().includes('compatible')` must be gone.
        assert.doesNotMatch(code, /\(item\.name\s*\|\|\s*['"]['"]\s*\)\.toLowerCase\(\)\.includes\(\s*['"]compatible['"]/,
            `${name} must not inline-fallback to item.name.includes("compatible")`);
        // Each must call the helper.
        assert.match(code, /Cart\._isCompatible\s*\(\s*item\s*\)/,
            `${name} must read source via Cart._isCompatible(item)`);
    }
});

test('§2 Cart._isCompatible exists, prefers product_source, falls back to legacy name only as last resort', () => {
    const m = CART_CODE.match(/_isCompatible:\s*function\s*\(item\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, 'Cart._isCompatible must be defined as a method');
    const body = m[1];
    assert.match(body, /item\.product_source\s*===\s*['"]compatible['"]/,
        '_isCompatible must check product_source first');
    // The legacy name fallback must be anchored to the leading word ("^compatible\b"),
    // not a loose .includes — that would overmatch on the new compatible name format.
    assert.match(body, /\/\^compatible\\b\/i/,
        '_isCompatible legacy fallback must be anchored to leading-word /^compatible\\b/i');
});

test('§2 Cart.addItem captures product_source and stores it on the row', () => {
    const m = CART_CODE.match(/async\s+addItem\s*\(product\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, 'Cart.addItem must be defined');
    const body = m[1];
    assert.match(body, /product_source/,
        'addItem must derive a product_source value');
    assert.match(body, /product_source:\s*productSource/,
        'addItem must store product_source on new rows');
    // Sanity: subsystem sentinels are not mistaken for brand sources.
    assert.match(body, /\['core',\s*'cross-sell'\]/,
        'addItem must filter out the cart-namespace sentinels when promoting source → product_source');
});

test('§2 Card renderers expose data-product-source', () => {
    // products.js renderCard add-to-cart button — main shop card path.
    const PRODUCTS_SRC = stripComments(fs.readFileSync(JS('products.js'), 'utf8'));
    assert.match(PRODUCTS_SRC, /data-product-source="\$\{Security\.escapeAttr\(product\.source\s*\|\|\s*''\)\}"/,
        'products.js add-to-cart button must emit data-product-source');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 Series chip cache — v6 invalidates stale Epson chip counts
// ─────────────────────────────────────────────────────────────────────────────

test('§4 series chip-grid cache key is bumped to v6', () => {
    // Active key is v6.
    assert.match(SHOP_CODE, /codes-v6/,
        'shop-page must use codes-v6 cache key (May 2026 Epson chip changes)');
    // Lookup loop tries v6 first, falls back to v5/v4 to avoid losing
    // pre-warmed entries during the same SPA session.
    assert.match(SHOP_CODE, /codesCacheKey6.*codesCacheKey5.*codesCacheKey4/,
        'lookup loop must try v6 before v5 before v4');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 Pending Changes — partial status
// ─────────────────────────────────────────────────────────────────────────────

test('§6 Pending tab fetches both pending AND partial buckets', () => {
    assert.match(PENDING_CODE, /statusesToFetch\s*=\s*_filters\.status\s*===\s*['"]pending['"]/,
        'load() must derive a statusesToFetch list from the active tab');
    assert.match(PENDING_CODE, /\['pending',\s*'partial'\]/,
        'Pending tab must request both pending and partial');
});

test('§6 Pending tab count adds pending + partial buckets', () => {
    assert.match(PENDING_CODE, /pendingBase.*partialBase/s,
        'tab count must combine pending + partial summary buckets');
});

test('§6 _belongsInCurrentTab keeps partial rows on the Pending tab', () => {
    const m = PENDING_CODE.match(/function\s+_belongsInCurrentTab\s*\(item\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, '_belongsInCurrentTab helper must be defined');
    const body = m[1];
    assert.match(body, /status\s*===\s*['"]pending['"][^]*partial/,
        'helper must accept both pending and partial when on the Pending tab');
});

test('§6 review actions use _belongsInCurrentTab (not raw status equality)', () => {
    // The two old `if (item.status !== _filters.status)` filter-out lines must be replaced.
    assert.doesNotMatch(PENDING_CODE, /if\s*\(item\.status\s*!==\s*_filters\.status\)/,
        'review handlers must not drop rows based on raw status equality (would yank partials off the Pending tab)');
    // _belongsInCurrentTab is referenced from at least two action handlers.
    const refs = (PENDING_CODE.match(/_belongsInCurrentTab\s*\(item\)/g) || []).length;
    assert.ok(refs >= 2, `_belongsInCurrentTab should be called by at least 2 action handlers, found ${refs}`);
});

test('§6 partial is reviewable and bulk-selectable', () => {
    // Pre-existing wiring — guard so it cannot regress.
    const reviewableChecks = (PENDING_CODE.match(/status\s*===\s*['"]pending['"]\s*\|\|\s*item\.status\s*===\s*['"]partial['"]/g) || []).length;
    assert.ok(reviewableChecks >= 1,
        'at least one reviewable check (status === pending || partial) must exist');
});
