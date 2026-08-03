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

// ─────────────────────────────────────────────────────────────────────────────
// Aug 2026 (ERR-143) — the page-yield tail
//
// Almost every genuine name carries a "(N pages)" suffix, so the trailing
// colour was never actually trailing and every one of those titles fell to
// the type-last fallback, rendering
//   "Brother Genuine LC133 Black (600 pages) Ink Cartridge"
// with the product type stranded after the page count. clean() now peels the
// parenthetical off first and re-appends it last.
//
// Measured over all 3,969 live products: 2,373 titles improve and every
// fixture pinned above (none of which carries a parenthetical) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

test('page-yield tail moves to the END, after the colour', () => {
    assert.equal(
        ProductName.clean({
            name: 'Brother Genuine LC133BK Ink Cartridge LC133 Black (600 pages)',
            color: 'Black'
        }),
        'Brother Genuine LC133 Ink Cartridge Black (600 pages)');
});

test('the Aug 2026 tri-colour SKUs read correctly', () => {
    assert.equal(
        ProductName.clean({
            name: 'HP Genuine 804CLR Ink Cartridge 804 Tri-Colour (165 pages)',
            color: 'Tri-Colour'
        }),
        'HP Genuine 804 Ink Cartridge Tri-Colour (165 pages)');
    assert.equal(
        ProductName.clean({
            name: 'Canon Genuine CL511CLR Ink Cartridge CL511 Tri-Colour (244 pages)',
            color: 'Tri-Colour'
        }),
        'Canon Genuine CL511 Ink Cartridge Tri-Colour (244 pages)');
});

test('MULTIPLE trailing parentheticals are peeled together (HP 68)', () => {
    // Real live name: an OEM part number followed by the page yield.
    assert.equal(
        ProductName.clean({
            name: 'HP Genuine 68 Ink Cartridge 68 Colour (7FP20TA) (120 pages)',
            color: 'Colour'
        }),
        'HP Genuine 68 Ink Cartridge Colour (7FP20TA) (120 pages)');
});

test('a pack name with a page tail keeps the pack label before the type', () => {
    // Colour is not trailing here, so the type-last fallback still applies —
    // the parenthetical just stops stranding the type behind it.
    assert.equal(
        ProductName.clean({
            name: 'Brother Genuine LC133CMY Ink Cartridge LC133 CMY 3-Pack (600 pages)',
            color: 'CMY'
        }),
        'Brother Genuine LC133 CMY 3-Pack Ink Cartridge (600 pages)');
});

test('cleaning an already-cleaned name is idempotent (no drift on re-render)', () => {
    // Cards, PDP and cart each call clean() independently; a non-idempotent
    // rewrite would show a different title depending on which surface ran.
    const product = {
        name: 'HP Genuine 804CLR Ink Cartridge 804 Tri-Colour (165 pages)',
        color: 'Tri-Colour'
    };
    const once = ProductName.clean(product);
    const twice = ProductName.clean({ name: once, color: product.color });
    assert.equal(twice, once);
});

test('a name that is ONLY a parenthetical after the type is returned verbatim', () => {
    // Guard against emitting a title with the readable half amputated.
    const name = 'HP Genuine 123 Ink Cartridge (500 pages)';
    assert.equal(ProductName.clean({ name, color: 'Black' }), name);
});
