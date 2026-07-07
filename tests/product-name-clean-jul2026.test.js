/**
 * ProductName.clean — display-title de-doubling contract
 * ======================================================
 *
 * Backend genuine-cartridge / print-head `name` values embed a redundant
 * compact code token, so the readable code+volume shows twice, e.g.
 *
 *   "HP Genuine 70 130mlCY Ink Cartridge 70 130ml Cyan"
 *                └ compact ┘              └── readable ──┘
 *
 * ProductName.clean() strips the compact token and re-emits the title
 * "colour last":  "HP Genuine 70 130ml Ink Cartridge Cyan".
 *
 * This pins:
 *   - the de-doubling transform (colour-last) for cartridges / print heads
 *   - the doubling GUARD: non-doubled names are returned verbatim
 *     (Gloss Enhancer, compatible "…for HP …", Brother paper/labels/belt)
 *   - idempotency on an already-clean name
 *   - the colour-unknown fallback (drop compact token only)
 *   - render surfaces routing titles through ProductName.clean (not raw name)
 *
 * Root cause is backend data — see
 *   readfirst/product-name-doubling-backend-handoff-jul2026.md
 * and errors.md ERR-054-title (frontend interim de-doubler).
 *
 * Run: node --test tests/product-name-clean-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const { ProductName } = require(JS('utils.js'));

// ─────────────────────────────────────────────────────────────────────────────
// 1. De-doubling transform — colour last
// ─────────────────────────────────────────────────────────────────────────────

test('doubled 130ml cartridge → colour-last, code+volume once', () => {
    assert.equal(
        ProductName.clean({ name: 'HP Genuine 70 130mlCY Ink Cartridge 70 130ml Cyan', color: 'Cyan' }),
        'HP Genuine 70 130ml Ink Cartridge Cyan'
    );
});

test('doubled XL office cartridge', () => {
    assert.equal(
        ProductName.clean({ name: 'HP Genuine 970XLBK Ink Cartridge 970XL Black', color: 'Black' }),
        'HP Genuine 970XL Ink Cartridge Black'
    );
});

test('doubled print head keeps the "Ink Print Head" type', () => {
    assert.equal(
        ProductName.clean({ name: 'HP Genuine 70MBK Ink Print Head 70 Matte Black', color: 'Matte Black' }),
        'HP Genuine 70 Ink Print Head Matte Black'
    );
});

test('CMY 3-Pack (colour not trailing) de-doubles via type-last fallback', () => {
    // "CMY" is not the trailing token ("3-Pack" is), so the colour-split does
    // not fire; the compact token is still dropped.
    assert.equal(
        ProductName.clean({ name: 'HP Genuine 70CMY Ink Cartridge 70 CMY 3-Pack', color: 'CMY' }),
        'HP Genuine 70 CMY 3-Pack Ink Cartridge'
    );
});

test('doubled name with NO colour field → compact token still dropped', () => {
    assert.equal(
        ProductName.clean({ name: 'HP Genuine 70 130mlCY Ink Cartridge 70 130ml Cyan' }),
        'HP Genuine 70 130ml Cyan Ink Cartridge'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Guard — non-doubled names returned verbatim
// ─────────────────────────────────────────────────────────────────────────────

test('Gloss Enhancer (single occurrence) is preserved', () => {
    const n = 'HP Genuine 70 130ml Ink Cartridge Gloss Enhancer (C9459A)';
    assert.equal(ProductName.clean({ name: n, color: 'Gloss Enhancer' }), n);
});

test('compatible "…for HP 126A…" name is preserved', () => {
    const n = 'Compatible Toner Cartridge for HP 126A CMY 3-Pack';
    assert.equal(ProductName.clean({ name: n, color: 'CMY' }), n);
});

test('Brother belt unit (no product-type phrase) is preserved', () => {
    const n = 'Brother Genuine BU223CL Belt Unit';
    assert.equal(ProductName.clean({ name: n }), n);
});

test('already-clean colour-last name is idempotent', () => {
    const n = 'HP Genuine 70 130ml Ink Cartridge Cyan';
    assert.equal(ProductName.clean({ name: n, color: 'Cyan' }), n);
});

test('empty / missing name is safe', () => {
    assert.equal(ProductName.clean({ name: '' }), '');
    assert.equal(ProductName.clean({}), '');
    assert.equal(ProductName.clean(null), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Render surfaces route titles through ProductName.clean (not raw name)
// ─────────────────────────────────────────────────────────────────────────────

test('PDP, shop card, products.renderCard and cart render via ProductName.clean', () => {
    const PDP = stripComments(READ(JS('product-detail-page.js')));
    const SHOP = stripComments(READ(JS('shop-page.js')));
    const PRODUCTS = stripComments(READ(JS('products.js')));
    const CART = stripComments(READ(JS('cart.js')));

    assert.match(PDP, /displayName\s*=\s*\(typeof ProductName[^;]*ProductName\.clean\(p\)/,
        'PDP getProductInfo should set displayName via ProductName.clean');
    assert.match(SHOP, /displayName\s*=\s*\(typeof ProductName[^;]*ProductName\.clean\(product\)/,
        'shop createProductCard should set displayName via ProductName.clean');
    assert.match(PRODUCTS, /displayTitle\s*=\s*\(typeof ProductName[^;]*ProductName\.clean\(product\)/,
        'products.renderCard should compute displayTitle via ProductName.clean');
    assert.match(PRODUCTS, /product-card__title[\s\S]*?Security\.escapeHtml\(displayTitle\)/,
        'products.renderCard <h3> should render displayTitle, not raw product.name');
    assert.match(CART, /ProductName\.clean\(item\)/,
        'cart line items should render via ProductName.clean');
});
