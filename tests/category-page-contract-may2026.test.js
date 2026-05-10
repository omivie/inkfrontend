/**
 * Storefront Category & Search Page Contract — May 2026
 * ======================================================
 *
 * Pins the rules from `readfirst/category-page-contract-may2026.md`:
 *
 *   §1  Every product card on a list view (catalog, printer products,
 *       search, brand, category) renders a top-left COMPATIBLE/GENUINE
 *       chip — yellow for compatible, blue for genuine.
 *   §2  The aggregated "For Use In: Epson XP100, …" block is gone from
 *       every list page (shop, search, printer products, printer detail).
 *       It belongs ONLY on the PDP.
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
// §1 — Per-card source chip
// ─────────────────────────────────────────────────────────────────────────────

test('§1 getSourceBadge returns uppercase short labels (COMPATIBLE / GENUINE)', () => {
    // The card chip must read "COMPATIBLE" / "GENUINE" — uppercase, no "OEM"
    // suffix. This is what the spec acceptance criteria assert (e.g.
    // "Every Epson 200 single shows a yellow COMPATIBLE chip").
    assert.match(API_SRC, /text:\s*['"]COMPATIBLE['"]/,
        'getSourceBadge must emit "COMPATIBLE" (uppercase)');
    assert.match(API_SRC, /text:\s*['"]GENUINE['"]/,
        'getSourceBadge must emit "GENUINE" (uppercase, no "OEM" suffix)');
});

test('§1 getSourceBadge maps source to BEM-correct chip class names', () => {
    // Class names must match the CSS rules in components.css. The spec's
    // colour mapping (yellow=compatible, blue=genuine) lives in CSS and
    // is keyed to these exact class names.
    assert.match(API_SRC, /class:\s*['"]product-card__badge--compatible['"]/,
        'compatible badge must use the .product-card__badge--compatible class');
    assert.match(API_SRC, /class:\s*['"]product-card__badge--genuine['"]/,
        'genuine badge must use the .product-card__badge--genuine class');
});

test('§1 components.css defines the yellow/blue source-chip variants', () => {
    // Yellow background for compatible.
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__badge--compatible\s*\{[^}]*background-color:\s*var\(--yellow-primary\)/,
        '.product-card__badge--compatible must paint yellow'
    );
    // Cyan/blue for genuine. The cyan-primary token is the project's
    // canonical "blue" colour (see base.css).
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__badge--genuine\s*\{[^}]*background-color:\s*var\(--cyan-primary\)/,
        '.product-card__badge--genuine must paint blue (cyan-primary)'
    );
});

test('§1 components.css defines the chip-stack container that prevents overlap', () => {
    // The stack is the absolute anchor; chips inside lose absolute
    // positioning and flow vertically (acceptance: "FITS YOUR PRINTER chip
    // stacks above or beside the source chip without overlapping").
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__chip-stack\s*\{[\s\S]*?position:\s*absolute/,
        '.product-card__chip-stack must be absolutely positioned'
    );
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__chip-stack\s*\{[\s\S]*?display:\s*flex/,
        '.product-card__chip-stack must use flex layout'
    );
    assert.match(
        COMPONENTS_CSS,
        /\.product-card__chip-stack\s+\.product-card__badge\s*\{[\s\S]*?position:\s*static/,
        'chips inside the stack must drop their absolute positioning'
    );
});

test('§1 every list-view card renderer emits a chip-stack with the source chip', () => {
    // The chip-stack wraps the source chip on each list-view renderer.
    // We grep the source for "product-card__chip-stack" — its presence
    // is the contract the spec pins.
    for (const [label, code] of [
        ['products.js (Products.renderCard)',     PRODUCTS_CODE],
        ['shop-page.js (Shop.createProductCard)', SHOP_CODE],
        ['landing.js (featured-products grid)',   LANDING_CODE],
        ['ribbons-page.js (createRibbonCard)',    RIBBONS_CODE],
    ]) {
        assert.match(code, /product-card__chip-stack/,
            `${label}: must wrap top-left chips in .product-card__chip-stack`);
        assert.match(code, /getSourceBadge/,
            `${label}: must call getSourceBadge to drive the chip`);
    }
});

test('§1 PDP does NOT add a per-card source chip (PDP excluded from spec)', () => {
    // The spec is explicit: per-card source chips do NOT appear on the PDP
    // because the heading copy ("HP Genuine 72…") already conveys source.
    // We allow .badge-genuine / .badge-compatible (PDP "related products"
    // section header) but reject .product-card__chip-stack on the PDP buy
    // box itself.
    //
    // The PDP's _renderRelated section uses its own .badge.badge-genuine
    // chip on a section heading — that's allowed (it's the section header
    // chip referenced by spec §1, "existing chip placement"). The chip-
    // stack class is reserved for list-view cards.
    const buyBox = PDP_CODE.split('renderRelated')[0] || PDP_CODE;
    assert.ok(
        !/product-card__chip-stack/.test(buyBox),
        'PDP buy box must not render the list-view chip-stack'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 RUNTIME — Products.renderCard injects the chip into the chip-stack
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
        // Mirror the production getSourceBadge contract — chips use the
        // BEM class + uppercase short label.
        getSourceBadge: (s) => {
            if (s === 'genuine')    return { class: 'product-card__badge--genuine',    text: 'GENUINE' };
            if (s === 'compatible') return { class: 'product-card__badge--compatible', text: 'COMPATIBLE' };
            return null;
        },
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

test('§1 runtime: compatible product card emits yellow COMPATIBLE chip in chip-stack', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...BASE_PRODUCT, source: 'compatible' }, 0);

    assert.match(html, /<div class="product-card__chip-stack">/,
        'compatible card must render a chip-stack');
    assert.match(html, /class="product-card__badge product-card__badge--compatible">COMPATIBLE</,
        'compatible card must render the yellow COMPATIBLE chip text');
});

test('§1 runtime: genuine product card emits blue GENUINE chip in chip-stack', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...BASE_PRODUCT, source: 'genuine' }, 0);

    assert.match(html, /<div class="product-card__chip-stack">/,
        'genuine card must render a chip-stack');
    assert.match(html, /class="product-card__badge product-card__badge--genuine">GENUINE</,
        'genuine card must render the blue GENUINE chip text');
});

test('§1 runtime: chip-stack precedes the lowest-price chip in the DOM order', () => {
    // The chip-stack lives at top-left; the lowest-price chip lives at
    // top-right. They must render as siblings inside the image-wrapper —
    // not stacked on top of one another.
    const Products = loadProducts();
    const html = Products.renderCard({
        ...BASE_PRODUCT,
        source: 'compatible',
        is_lowest_in_market: true,
        market_position: { price_diff_percent: 5, lowest_competitor_name: 'Other' },
    }, 0);

    const chipStackIdx = html.indexOf('product-card__chip-stack');
    const lowestIdx    = html.indexOf('product-card__badge--lowest-price');
    assert.ok(chipStackIdx > 0, 'chip-stack must render');
    assert.ok(lowestIdx > 0,    'lowest-price chip must render');
    assert.ok(chipStackIdx < lowestIdx,
        'chip-stack must precede the top-right lowest-price chip in DOM order');
});

test('§1 runtime: card with no source field renders no chip (no broken empty span)', () => {
    // Defensive: legacy products without product.source should render
    // cleanly — no source chip, no empty stack wrapper.
    const Products = loadProducts();
    const html = Products.renderCard({ ...BASE_PRODUCT, source: undefined }, 0);

    assert.doesNotMatch(html, /product-card__badge--compatible/,
        'no source = no compatible chip');
    assert.doesNotMatch(html, /product-card__badge--genuine/,
        'no source = no genuine chip');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — "For Use In" only on PDP
// ─────────────────────────────────────────────────────────────────────────────

test('§2 shop.html does NOT ship the page-level "For Use In:" banner element', () => {
    // The banner element used to live at #printers-banner inside
    // #level-products. It has been retired — list pages render no
    // aggregated printer block.
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
    // The shop controller used to grab this.elements.printersBanner /
    // printersList and populate them inside displayProductInfo. After
    // the May 2026 contract those references are gone.
    assert.ok(
        !/elements\.printersBanner\.hidden\s*=\s*false/.test(SHOP_CODE),
        'shop-page.js must not unhide a #printers-banner element'
    );
    assert.ok(
        !/elements\.printersList\.innerHTML/.test(SHOP_CODE),
        'shop-page.js must not write into #printers-list'
    );
    // Defensive: the controller must not reach into the dead DOM nodes
    // via the legacy element bindings.
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
    // The PDP keeps the same .product-printers-banner container — it
    // renders compatible printers FOR THE CURRENT PRODUCT, which is the
    // one place this UI belongs.
    assert.match(PDP_CODE, /product-printers-banner/,
        'PDP must keep its per-product "For Use In:" banner');
    assert.match(PDP_CODE, /For Use In:/,
        'PDP must keep the "For Use In:" copy');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Honest "Did you mean X?" banner
// ─────────────────────────────────────────────────────────────────────────────

test('§3 shop-page.js renderSearchBanners renders "Did you mean X?" with /search link', () => {
    // The banner must read "Did you mean <link>didYouMean</link>?". The
    // link must point at /search?q=<encoded suggestion> — the canonical
    // search URL.
    assert.match(
        SHOP_CODE,
        /search-did-you-mean[\s\S]{0,500}?Did you mean[\s\S]{0,200}?\/search\?q=\$\{[^}]*didYouMean[^}]*\}/,
        'banner must read "Did you mean …" and link the suggestion to /search?q=<encoded>'
    );
});

test('§3 shop-page.js does NOT emit the retired "Showing similar results" copy', () => {
    // Comments still reference the retired copy (explanatory) but no
    // template literal must emit it. We assert: no occurrence of the
    // copy outside a comment.
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
    // The banner that used to render "Showing similar results … Search
    // instead for X" used the .search-correction-banner class. With the
    // honest-banner spec it is dead — we no longer emit that class from
    // shop-page.js.
    assert.ok(
        !/className\s*=\s*['"]search-correction-banner['"]/.test(SHOP_CODE),
        'shop-page.js must not assign className="search-correction-banner"'
    );
    assert.ok(
        !/class=["']search-correction-banner["']/.test(SHOP_CODE),
        'shop-page.js must not write a class="search-correction-banner" attribute'
    );
});
