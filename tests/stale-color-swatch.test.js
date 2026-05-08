/**
 * Stale color-swatch fallback (May 2026)
 * ======================================
 *
 * Pins the rule that whenever a compatible product's `image_url` is one of
 * the legacy hand-uploaded "color-swatch-vN.png" placeholder PNGs, every
 * surface MUST drop the static image and render a fresh color block from
 * the canonical `color` field instead.
 *
 * Why this matters:
 *
 *   The placeholder swatch lives at
 *     supabase/.../products/<sku-slug>/color-swatch-v4.png
 *   It was generated once when the product was seeded — typically with the
 *   color the SKU suffix advertised (a `-RD` SKU got a red swatch). When an
 *   admin later corrects the canonical `color` (Red → Tri-Colour) the image
 *   does NOT regenerate; the storefront keeps painting the stale red PNG
 *   even though the product is genuinely tri-colour now.
 *
 *   The fix: every render path checks `ProductColors.isPlaceholderSwatchImage`
 *   and falls through to a CSS color block whose styling derives from the
 *   live `color` field. Admin edits propagate visually within one cache
 *   bust, no Supabase upload required.
 *
 * Detection rule (utils.js ProductColors.isPlaceholderSwatchImage):
 *
 *   /\/color-swatch(?:-v\d+)?\.png(?:\?.*)?$/i
 *
 *   Matches any path ending in `color-swatch.png`, `color-swatch-v4.png`,
 *   `color-swatch-v12.png?cb=…` etc. — that family covers every placeholder
 *   currently in the bucket and every plausible future regen suffix.
 *
 * Surfaces audited:
 *
 *   - utils.js                     (ProductColors.isPlaceholderSwatchImage)
 *   - products.js                  (Products.getProductImageHTML)
 *   - shop-page.js                 (Shop.createProductCard)
 *   - product-detail-page.js       (PDP main image)
 *   - cart.js                      (Cart.getItemImageHTML)
 *   - favourites.js                (Favourites.getItemImageHTML)
 *   - checkout-page.js             (CheckoutPage.getItemImageHTML)
 *   - order-confirmation-page.js   (OrderConfirmation.getItemImageHtml)
 *   - order-detail-page.js         (Order detail render)
 *
 * Run with: node --test tests/stale-color-swatch.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => path.join(ROOT, 'js', rel);

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: every render path consults isPlaceholderSwatchImage before painting.
// ─────────────────────────────────────────────────────────────────────────────

const SURFACES = [
    { file: 'js/products.js',                  rationale: 'product card grid' },
    { file: 'js/shop-page.js',                 rationale: 'shop drilldown grid' },
    { file: 'js/product-detail-page.js',       rationale: 'PDP main image' },
    { file: 'js/cart.js',                      rationale: 'cart line item' },
    { file: 'js/favourites.js',                rationale: 'wishlist row' },
    { file: 'js/checkout-page.js',             rationale: 'checkout summary' },
    { file: 'js/order-confirmation-page.js',   rationale: 'post-order receipt' },
    { file: 'js/order-detail-page.js',         rationale: 'account order history' },
];

for (const { file, rationale } of SURFACES) {
    test(`static: ${file} consults isPlaceholderSwatchImage (${rationale})`, () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', file), 'utf8');
        assert.match(
            src,
            /isPlaceholderSwatchImage\s*\(/,
            `${file} must call ProductColors.isPlaceholderSwatchImage to gate stale-swatch fallback`
        );
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS: detection rule covers the canonical placeholder shapes.
// ─────────────────────────────────────────────────────────────────────────────

function loadProductColors() {
    // utils.js touches window/document/document.* on load. Stub the surface
    // area; we only need ProductColors, not the full exports.
    const sandbox = {
        console,
        URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol, RegExp,
        window: {
            location: { hostname: 'localhost', protocol: 'http:', pathname: '/', search: '', href: 'http://localhost/' },
        },
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
        },
        location: { hostname: 'localhost', protocol: 'http:', pathname: '/', search: '', href: 'http://localhost/' },
        module: { exports: {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(JS('utils.js'), 'utf8'), ctx, { filename: 'utils.js' });
    return sandbox.ProductColors || sandbox.window.ProductColors;
}

test('isPlaceholderSwatchImage matches the legacy placeholder shapes', () => {
    const PC = loadProductColors();
    const matches = [
        'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/images/products/c-can-cl41-ink-rd/color-swatch-v4.png',
        'https://example.com/anything/color-swatch.png',
        'https://example.com/x/color-swatch-v1.png',
        'https://example.com/x/color-swatch-v12.png?cb=1234',
    ];
    for (const url of matches) {
        assert.strictEqual(PC.isPlaceholderSwatchImage(url), true, `should match: ${url}`);
    }
});

test('isPlaceholderSwatchImage rejects real product photos', () => {
    const PC = loadProductColors();
    const rejects = [
        'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/images/products/G-BRO-TN150-TNR-BK/G-BRO-TN150-TNR-BK-1776932847052.webp',
        'https://example.com/foo/photo.jpg',
        '/assets/images/placeholder-product.svg',
        '',
        null,
        undefined,
    ];
    for (const url of rejects) {
        assert.strictEqual(PC.isPlaceholderSwatchImage(url), false, `should reject: ${JSON.stringify(url)}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME: products.js Products.renderCard drops the swatch image and emits a
// color-block when image_url is a placeholder.
// ─────────────────────────────────────────────────────────────────────────────

function loadProducts() {
    const sandbox = {
        console,
        URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol, RegExp,
        Security: {
            escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
            escapeAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
            sanitizeUrl: (u) => u,
        },
        ProductColors: {
            getStyle(name) {
                const map = {
                    red: 'background-color: #f44336;',
                    'tri-colour': 'background: linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%);',
                };
                return map[(name || '').toLowerCase()] || null;
            },
            getProductStyle(obj) {
                return this.getStyle(obj && obj.color);
            },
            detectFromName() { return null; },
            isPlaceholderSwatchImage(url) {
                return !!url && /\/color-swatch(?:-v\d+)?\.png(?:\?.*)?$/i.test(url);
            },
        },
        getStockStatus: () => ({ class: 'in-stock', text: 'In stock' }),
        getSourceBadge: (s) => s === 'compatible' ? { class: 'compatible', text: 'COMPATIBLE' } : { class: 'genuine', text: 'GENUINE' },
        qualifiesForFreeShipping: () => false,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        storageUrl: (u) => u,
        imageSrcset: () => '',
        DebugLog: { log() {}, warn() {}, error() {} },
        window: {},
        document: { addEventListener() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(JS('products.js'), 'utf8'), ctx, { filename: 'products.js' });
    return sandbox.Products;
}

const SWATCH_URL = 'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/images/products/c-can-cl41-ink-rd/color-swatch-v4.png';

test('runtime: compatible card with stale swatch + color="Tri-Colour" renders the tri-colour block, not the red PNG', () => {
    const Products = loadProducts();
    const product = {
        id: 'p1',
        sku: 'C-CAN-CL41-INK-RD',
        name: 'Compatible Ink Cartridge Replacement for Canon CL41 Tri-Colour',
        brand: { name: 'Canon' },
        color: 'Tri-Colour',
        color_hex: null,
        image_url: SWATCH_URL,
        retail_price: 19.99,
        in_stock: true,
        source: 'compatible',
        pack_type: 'single',
    };
    const html = Products.renderCard(product, 0);
    // Tri-colour gradient must be inlined as the visible swatch …
    assert.match(html, /linear-gradient\(to right, #00bcd4/, 'tri-colour gradient must be present');
    // … and no <img> element should point at the stale swatch PNG. (The
    // image_url may still appear on the Add-to-Cart button's
    // data-product-image attr — Cart has its own swatch-stale fallback when
    // it later renders the line item.)
    assert.doesNotMatch(html, /<img[^>]+color-swatch-v4\.png/, 'stale swatch image must not be rendered as <img>');
    // The card must surface a color-block container for the swatch we did inline.
    assert.match(html, /class="product-card__color-block"/, 'must render the color-block container');
});

test('runtime: compatible card with a REAL product photo keeps the photo (regression guard)', () => {
    const Products = loadProducts();
    const product = {
        id: 'p2',
        sku: 'C-BRO-TN257-TNR-BK',
        name: 'Compatible Toner Cartridge Replacement for Brother TN257 Black',
        brand: { name: 'Brother' },
        color: 'Black',
        color_hex: null,
        image_url: 'https://example.com/products/c-bro-tn257-tnr-bk/c-bro-tn257-tnr-bk-1776914391318.webp',
        retail_price: 49.99,
        in_stock: true,
        source: 'compatible',
        pack_type: 'single',
    };
    const html = Products.renderCard(product, 0);
    assert.match(html, /c-bro-tn257-tnr-bk-1776914391318\.webp/, 'real product photo must still be used');
});
