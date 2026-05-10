/**
 * Storefront Category & Search Page Contract — May 2026 (rev 2)
 * ==============================================================
 *
 * Pins three rules:
 *
 *   §1  Every list-view product card (shop, search, printer products,
 *       brand pages, category pages, ribbons, landing-page featured grid)
 *       renders NO per-card COMPATIBLE/GENUINE chip. The section heading
 *       above the grid (e.g. "Brother Compatible Inkjet Cartridges") and
 *       the product name itself ("LC39BK Compatible Ink Cartridge…")
 *       already declare source — the chip was redundant. The chip-stack
 *       container survives for fits-printer + save-discount badges.
 *
 *       PDP related-products section heading still ships its own
 *       `.badge.badge-compatible/genuine` chip (it's the heading the user
 *       reads, not a per-card chip). Cart, checkout, favourites, order
 *       detail line-items keep their `.source-badge` (different element,
 *       different layout, no section heading present in those views).
 *
 *   §2  The aggregated "For Use In: Epson XP100, …" block is gone from
 *       every list page (shop, search, printer products, printer detail).
 *       It belongs ONLY on the PDP.
 *
 *   §3  When the API returns `did_you_mean: <string>`, the banner reads
 *       "Did you mean <string>?" with the suggestion linking to
 *       /search?q=<encoded>. The "Showing similar results. Search instead
 *       for X" copy is retired.
 *
 * Run with: node --test tests/category-page-contract-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const HTML = (rel) => path.join(ROOT, 'inkcartridges', 'html', rel);
const CSS = (rel) => path.join(ROOT, 'inkcartridges', 'css', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const PRODUCTS_SRC = READ(JS('products.js'));
const SHOP_SRC     = READ(JS('shop-page.js'));
const PDP_SRC      = READ(JS('product-detail-page.js'));
const API_SRC      = READ(JS('api.js'));
const LANDING_SRC  = READ(JS('landing.js'));
const RIBBONS_SRC  = READ(JS('ribbons-page.js'));
const SHOP_HTML    = READ(HTML('shop.html'));
const COMPONENTS_CSS = READ(CSS('components.css'));

const PRODUCTS_CODE = stripComments(PRODUCTS_SRC);
const SHOP_CODE     = stripComments(SHOP_SRC);
const PDP_CODE      = stripComments(PDP_SRC);
const API_CODE      = stripComments(API_SRC);
const LANDING_CODE  = stripComments(LANDING_SRC);
const RIBBONS_CODE  = stripComments(RIBBONS_SRC);
const SHOP_HTML_CODE = stripComments(SHOP_HTML);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Per-card source chip is RETIRED from list views
// ─────────────────────────────────────────────────────────────────────────────

test('§1 getSourceBadge helper is removed from api.js (no callers left)', () => {
    // The per-card chip helper is dead weight after the May 2026 rev-2
    // contract — every list-view renderer stopped calling it. Keep this
    // assertion as a regression guard: re-introducing the helper is a
    // strong signal someone is about to re-add the chip.
    assert.ok(
        !/function\s+getSourceBadge\b/.test(API_CODE),
        'api.js must not declare getSourceBadge (helper retired with the chip)'
    );
    assert.ok(
        !/window\.getSourceBadge\s*=/.test(API_CODE),
        'api.js must not export window.getSourceBadge'
    );
});

test('§1 list-view renderers do NOT call getSourceBadge', () => {
    for (const [label, code] of [
        ['products.js (Products.renderCard)',     PRODUCTS_CODE],
        ['shop-page.js (Shop.createProductCard)', SHOP_CODE],
        ['landing.js (featured-products grid)',   LANDING_CODE],
        ['ribbons-page.js (createRibbonCard)',    RIBBONS_CODE],
    ]) {
        assert.ok(
            !/getSourceBadge\s*\(/.test(code),
            `${label}: must not call getSourceBadge()`
        );
    }
});

test('§1 list-view renderers do NOT emit the per-card source chip classes', () => {
    // The chip used .product-card__badge--compatible / .product-card__badge--genuine.
    // Those classes must not appear anywhere in the list-card source.
    for (const [label, code] of [
        ['products.js',     PRODUCTS_CODE],
        ['shop-page.js',    SHOP_CODE],
        ['landing.js',      LANDING_CODE],
        ['ribbons-page.js', RIBBONS_CODE],
    ]) {
        assert.ok(
            !/product-card__badge--compatible/.test(code),
            `${label}: must not emit product-card__badge--compatible`
        );
        assert.ok(
            !/product-card__badge--genuine/.test(code),
            `${label}: must not emit product-card__badge--genuine`
        );
    }
});

test('§1 components.css drops the dead per-card source-chip rules', () => {
    // The CSS variants for the retired chip are gone. Keeping them would
    // be cargo-cult: the JS no longer emits the class names that key them.
    assert.ok(
        !/\.product-card__badge--compatible\s*\{/.test(COMPONENTS_CSS),
        'components.css must not define .product-card__badge--compatible'
    );
    assert.ok(
        !/\.product-card__badge--genuine\s*\{/.test(COMPONENTS_CSS),
        'components.css must not define .product-card__badge--genuine'
    );
});

test('§1 chip-stack survives for fits-printer + save-discount badges', () => {
    // The stack container is still useful — fits-printer + save-discount
    // chips share the top-left and need the flex column to avoid overlap.
    // products.js + shop-page.js still emit the wrapper.
    assert.match(PRODUCTS_CODE, /product-card__chip-stack/,
        'products.js must keep the .product-card__chip-stack wrapper for remaining chips');
    assert.match(SHOP_CODE, /product-card__chip-stack/,
        'shop-page.js must keep the .product-card__chip-stack wrapper for remaining chips');
    // The CSS rules for the stack itself stay — the geometry contract
    // (absolute, top-left, flex column) is still load-bearing.
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__chip-stack\s*\{[\s\S]*?position:\s*absolute/,
        '.product-card__chip-stack must remain absolutely positioned'
    );
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__chip-stack\s*\{[\s\S]*?display:\s*flex/,
        '.product-card__chip-stack must remain a flex container'
    );
});

test('§1 PDP related-products SECTION HEADING keeps its source badge', () => {
    // The PDP renders related products grouped by source with a heading
    // chip ("[COMPATIBLE] Brother Compatible Inkjet Cartridges"). That
    // chip belongs to the heading itself — it IS the heading the §1 rule
    // points at, not a per-card chip. It must survive.
    assert.match(PDP_CODE, /badge-compatible/,
        'PDP related-products heading chip must keep .badge-compatible class');
    assert.match(PDP_CODE, /badge-genuine/,
        'PDP related-products heading chip must keep .badge-genuine class');
    assert.match(PDP_CODE, /related-products__group-heading/,
        'PDP must keep the related-products group heading container');
});

test('§1 cart / checkout / favourites / order-detail keep .source-badge line-item chips', () => {
    // These views render line-items, not cards on a heading-led grid, so
    // the source label still adds signal (a single line of "LC39BK Compatible…"
    // mid-cart can blur with adjacent items). Different element entirely
    // (.source-badge, not .product-card__badge--*).
    const CART_CODE       = stripComments(READ(JS('cart.js')));
    const CHECKOUT_CODE   = stripComments(READ(JS('checkout-page.js')));
    const FAVS_CODE       = stripComments(READ(JS('favourites.js')));
    const ORDER_CODE      = stripComments(READ(JS('order-detail-page.js')));
    for (const [label, code] of [
        ['cart.js',              CART_CODE],
        ['checkout-page.js',     CHECKOUT_CODE],
        ['favourites.js',        FAVS_CODE],
        ['order-detail-page.js', ORDER_CODE],
    ]) {
        assert.match(code, /source-badge--/,
            `${label}: must keep its line-item .source-badge chip`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 RUNTIME — Products.renderCard verification
// ─────────────────────────────────────────────────────────────────────────────

function loadProducts() {
    const sandbox = {
        console,
        URL, URLSearchParams, encodeURIComponent, decodeURIComponent,
        Map, Set, Promise, Date, JSON, Error,
        Object, Array, String, Number, Boolean, Symbol, RegExp, Math,
        Security: {
            escapeHtml: (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
            escapeAttr: (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
            sanitizeUrl: (u) => u,
        },
        ProductColors: {
            getStyle() { return null; },
            getProductStyle() { return null; },
            detectFromName() { return null; },
            isPlaceholderSwatchImage() { return false; },
        },
        getStockStatus: () => ({ class: 'in-stock', text: 'In stock' }),
        qualifiesForFreeShipping: () => false,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        storageUrl: (u) => u,
        storageUrlRaw: (u) => u,
        imageSrcset: () => '',
        DebugLog: { log() {}, warn() {}, error() {} },
        window: {},
        document: { addEventListener() {}, head: { appendChild() {} }, querySelector() { return null; }, createElement() { return { setAttribute() {}, appendChild() {} }; } },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(PRODUCTS_SRC, ctx, { filename: 'products.js' });
    return sandbox.Products;
}

const BASE_PRODUCT = {
    id: 'p1',
    sku: 'SKU-1',
    name: 'Test product',
    brand: { name: 'Epson' },
    color: 'Black',
    image_url: 'https://example.com/photo.jpg',
    retail_price: 50,
    in_stock: true,
};

test('§1 runtime: compatible product card emits NO source chip', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...BASE_PRODUCT, source: 'compatible' }, 0);

    assert.doesNotMatch(html, /product-card__badge--compatible/,
        'compatible card must not render a yellow COMPATIBLE chip');
    assert.doesNotMatch(html, />COMPATIBLE</,
        'compatible card must not render the COMPATIBLE text label');
});

test('§1 runtime: genuine product card emits NO source chip', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...BASE_PRODUCT, source: 'genuine' }, 0);

    assert.doesNotMatch(html, /product-card__badge--genuine/,
        'genuine card must not render a blue GENUINE chip');
    assert.doesNotMatch(html, />GENUINE</,
        'genuine card must not render the GENUINE text label');
});

test('§1 runtime: chip-stack still appears when fits-printer chip is present', () => {
    // Regression guard — removing the source chip must not collapse the
    // stack wrapper when other chips are still active.
    const Products = loadProducts();
    const html = Products.renderCard({
        ...BASE_PRODUCT,
        source: 'genuine',
        _fitsPrinter: 'Brother MFC-J6920DW',
    }, 0);

    assert.match(html, /product-card__chip-stack/,
        'card with fits-printer must wrap the chip in .product-card__chip-stack');
    assert.match(html, /product-card__badge--fits-printer/,
        'card with fits-printer must render the fits-printer chip');
});

test('§1 runtime: chip-stack still appears when discount chip is present', () => {
    const Products = loadProducts();
    const html = Products.renderCard({
        ...BASE_PRODUCT,
        source: 'compatible',
        original_price: 60,
        retail_price: 50,
        discount_amount: 10,
        discount_percent: 17,
    }, 0);

    assert.match(html, /product-card__chip-stack/,
        'card with discount must wrap the chip in .product-card__chip-stack');
    assert.match(html, /product-card__badge--discount/,
        'card with discount must render the save-discount chip');
});

test('§1 runtime: card with no chip-driving fields renders no chip-stack at all', () => {
    // No source chip, no fits-printer, no discount → no stack wrapper.
    // Regression guard against an empty <div class="product-card__chip-stack"></div>
    // being painted on every card.
    const Products = loadProducts();
    const html = Products.renderCard({ ...BASE_PRODUCT, source: 'genuine' }, 0);

    assert.doesNotMatch(html, /product-card__chip-stack/,
        'card with no fits-printer + no discount must not paint an empty chip-stack');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — "For Use In" only on PDP
// ─────────────────────────────────────────────────────────────────────────────

test('§2 shop.html does NOT ship the page-level "For Use In:" banner element', () => {
    assert.ok(
        !/id=["']printers-banner["']/.test(SHOP_HTML),
        'shop.html must not ship #printers-banner (For Use In aggregation retired)'
    );
    assert.ok(
        !/id=["']printers-list["']/.test(SHOP_HTML),
        'shop.html must not ship #printers-list (For Use In aggregation retired)'
    );
});

test('§2 shop-page.js no longer fetches/renders the page-level printers list', () => {
    assert.ok(
        !/elements\.printersBanner\.hidden\s*=\s*false/.test(SHOP_CODE),
        'shop-page.js must not unhide a #printers-banner element'
    );
    assert.ok(
        !/elements\.printersList\.innerHTML/.test(SHOP_CODE),
        'shop-page.js must not write into #printers-list'
    );
    assert.ok(
        !/getElementById\(['"]printers-banner['"]\)/.test(SHOP_CODE),
        'shop-page.js must not bind the #printers-banner element'
    );
    assert.ok(
        !/getElementById\(['"]printers-list['"]\)/.test(SHOP_CODE),
        'shop-page.js must not bind the #printers-list element'
    );
});

test('§2 PDP retains its own per-product printer banner (regression guard)', () => {
    assert.match(PDP_CODE, /product-printers-banner/,
        'PDP must keep its per-product "For Use In:" banner');
    assert.match(PDP_CODE, /For Use In:/,
        'PDP must keep the "For Use In:" copy');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Honest "Did you mean X?" banner
// ─────────────────────────────────────────────────────────────────────────────

test('§3 shop-page.js renderSearchBanners renders "Did you mean X?" with /search link', () => {
    assert.match(
        SHOP_CODE,
        /search-did-you-mean[\s\S]{0,500}?Did you mean[\s\S]{0,200}?\/search\?q=\$\{[^}]*didYouMean[^}]*\}/,
        'banner must read "Did you mean …" and link the suggestion to /search?q=<encoded>'
    );
});

test('§3 shop-page.js does NOT emit the retired "Showing similar results" copy', () => {
    assert.ok(
        !/`[^`]*Showing similar results[^`]*`/.test(SHOP_CODE),
        'no template literal may emit "Showing similar results."'
    );
    assert.ok(
        !/`[^`]*Showing results for[^`]*`/.test(SHOP_CODE),
        'no template literal may emit "Showing results for …"'
    );
    assert.ok(
        !/`[^`]*Search instead for[^`]*`/.test(SHOP_CODE),
        'no template literal may emit "Search instead for …"'
    );
});

test('§3 shop-page.js retires the search-correction-banner DOM class', () => {
    assert.ok(
        !/className\s*=\s*['"]search-correction-banner['"]/.test(SHOP_CODE),
        'shop-page.js must not assign className="search-correction-banner"'
    );
    assert.ok(
        !/class=["']search-correction-banner["']/.test(SHOP_CODE),
        'shop-page.js must not write a class="search-correction-banner" attribute'
    );
});
