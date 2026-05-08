/**
 * Value-pack savings: dollars only, no percent (May 2026)
 * =======================================================
 *
 * Pins the rule that products with `pack_type` of `value_pack` or
 * `multipack` MUST render their savings as a plain dollar amount, never
 * as a "$X (Y%)" combo. Singles keep the percent — that's the
 * conventional shorthand for sale pricing — but packs already advertise
 * their bulk discount via the "Value Pack" / "Multipack" ribbon, so the
 * percent reads as duplicate copy on the same card.
 *
 * Surfaces audited:
 *
 *   - js/products.js                  (Products.renderCard discount badge)
 *   - js/shop-page.js                 (Shop.createProductCard savings pill)
 *   - js/product-detail-page.js       (PDP price line)
 *
 * Run with: node --test tests/value-pack-savings-no-percent.test.js
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
// STATIC: each surface checks pack_type before emitting the percent suffix.
// ─────────────────────────────────────────────────────────────────────────────

test('static: products.js pack-aware savings badge gates the percent on pack_type', () => {
    const src = fs.readFileSync(JS('products.js'), 'utf8');
    // Helper exists.
    assert.match(src, /_isPack\s*\(/, 'Products._isPack helper must exist');
    // Helper handles value_pack and multipack.
    assert.match(src, /value_pack/, 'Products._isPack must recognise value_pack');
    assert.match(src, /multipack/,  'Products._isPack must recognise multipack');
    // Discount badge renders the dollar amount when isPack, percent otherwise.
    assert.match(
        src,
        /this\._isPack\(product\)\s*\?\s*`Save \$\{formatPrice\(discountAmount\)\}`/,
        'discount badge must use formatPrice for packs'
    );
});

test('static: shop-page.js savings pill gates the percent on pack_type', () => {
    const src = fs.readFileSync(JS('shop-page.js'), 'utf8');
    // The savings pill must inspect pack_type before emitting "(N%)".
    assert.match(
        src,
        /pack_type[\s\S]{0,200}?value_pack[\s\S]{0,200}?multipack/,
        'shop savings pill must consult pack_type to suppress the percent on packs'
    );
});

test('static: product-detail-page.js PDP savings line gates the percent on pack_type', () => {
    const src = fs.readFileSync(JS('product-detail-page.js'), 'utf8');
    // The savings template must be wrapped in a pack-aware ternary that
    // suppresses "(N%)" when pack_type is value_pack or multipack.
    const savingsBlock = src.match(/Save \$\{formatPrice\(savingsAmount\)\}[^`]*`/);
    assert.ok(savingsBlock, 'savings template must exist on PDP');
    assert.match(savingsBlock[0], /_isPack/, 'savings template must consult an _isPack flag');
    // The flag derivation must consult pack_type and recognise both pack
    // types — guarantees a future "single" pack_type spelling cannot bypass
    // the rule by accident.
    assert.match(src, /_packType[\s\S]{0,50}pack_type/, 'must derive _packType from info.pack_type');
    assert.match(src, /_isPack[\s\S]{0,200}value_pack[\s\S]{0,80}multipack/, 'must check both value_pack and multipack');
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME: Products.renderCard outputs "$X" for a value_pack and "X%" for a
// single, given the same discount fields.
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
            getStyle() { return null; },
            getProductStyle() { return null; },
            detectFromName() { return null; },
            isPlaceholderSwatchImage() { return false; },
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

const DISCOUNTED_BASE = {
    id: 'p1',
    sku: 'SKU-1',
    name: 'Test product',
    brand: { name: 'Test' },
    color: 'Black',
    image_url: 'https://example.com/photo.jpg',
    retail_price: 80,
    original_price: 100,
    discount_amount: 20,
    discount_percent: 20,
    in_stock: true,
    source: 'genuine',
};

test('runtime: value_pack card shows "Save $20.00" badge — no "(20%)"', () => {
    const Products = loadProducts();
    const product = { ...DISCOUNTED_BASE, pack_type: 'value_pack' };
    const html = Products.renderCard(product, 0);
    assert.match(html, /Save \$20\.00/, 'value pack discount badge must show dollar amount');
    assert.doesNotMatch(html, /Save 20%/, 'value pack discount badge must NOT show percent');
});

test('runtime: multipack card shows "Save $20.00" badge — no "(20%)"', () => {
    const Products = loadProducts();
    const product = { ...DISCOUNTED_BASE, pack_type: 'multipack' };
    const html = Products.renderCard(product, 0);
    assert.match(html, /Save \$20\.00/);
    assert.doesNotMatch(html, /Save 20%/);
});

test('runtime: single card keeps the "Save 20%" badge (regression guard)', () => {
    const Products = loadProducts();
    const product = { ...DISCOUNTED_BASE, pack_type: 'single' };
    const html = Products.renderCard(product, 0);
    assert.match(html, /Save 20%/, 'singles keep the legacy percent shorthand');
    assert.doesNotMatch(html, /Save \$20\.00/, 'singles must not switch to the dollar form');
});
