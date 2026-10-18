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
const stripComments = require('./helpers/strip-comments');

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
        'HP Genuine 70 CMY-Pack Ink Cartridge'
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
    // Not de-doubled; only the pack wording changes (owner, 2026-10-15).
    const n = 'Compatible Toner Cartridge for HP 126A CMY 3-Pack';
    assert.equal(ProductName.clean({ name: n, color: 'CMY' }), 'Compatible Toner Cartridge for HP 126A CMY-Pack');
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
        'Brother Genuine LC133 CMY-Pack Ink Cartridge (600 pages)');
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

// ─────────────────────────────────────────────────────────────────────────────
// Pack wording (owner, 2026-10-15): "4-Pack" read as four of the same
// cartridge. 4-colour packs show "KCMY-Pack", 3-colour packs "CMY-Pack".
// ─────────────────────────────────────────────────────────────────────────────

test('pack wording: colour-code packs replace the count', () => {
    const cases = [
        [{ name: 'Canon CART069H Value Pack KCMY 4-Pack', color: 'KCMY' }, 'Canon CART069H KCMY-Pack'],
        [{ name: 'OKI Genuine MC853KCMY Toner Cartridge MC853 KCMY 4-Pack (7,000 pages)', color: 'KCMY' },
            'OKI Genuine MC853 KCMY-Pack Toner Cartridge (7,000 pages)'],
        [{ name: 'Compatible Ink Cartridge for Epson 702XL CMYK 4 Pack', color: 'CMYK' }, 'Compatible Ink Cartridge for Epson 702XL KCMY-Pack'],
        [{ name: 'Brother Genuine DR233CL Drum Unit CMY 3-Pack', color: 'CMY' }, 'Brother Genuine DR233CL Drum Unit CMY-Pack'],
        // bare count, no colour token: the stored colour code decides
        [{ name: 'Brother Genuine DR233CL Drum Unit 4-Pack', color: 'KCMY' }, 'Brother Genuine DR233CL Drum Unit KCMY-Pack'],
        [{ name: 'Brother Genuine DR233CL Drum Unit 3-Pack', color: 'CMY' }, 'Brother Genuine DR233CL Drum Unit CMY-Pack'],
    ];
    for (const [product, want] of cases) {
        assert.equal(ProductName.clean(product), want, product.name);
        assert.equal(ProductName.clean({ ...product, name: want }), want, 'idempotent: ' + want);
    }
});

test('pack wording: packs whose contents the display cannot know stay verbatim', () => {
    for (const product of [
        { name: 'Brother Genuine DR233CL Drum Unit 4-Pack', color: 'Black' },   // colour code is not KCMY
        { name: 'Brother Genuine DR233CL Drum Unit 4-Pack' },                   // no colour code
        { name: 'Canon PG640/CL641 Ink Cartridge 2-Pack', color: 'Black/Colour' },
        { name: 'Brother LC3313 KCMY 5-Pack', color: 'KCMY' },                  // KCMY + spare black
        { name: 'Canon CART069H Value Pack', color: 'Value Pack' },
    ]) {
        assert.equal(ProductName.clean(product), product.name, product.name);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Descriptive title = backend `display_name` (ERR-359; supersedes the FE
// composer of ERR-341). Shown verbatim when the backend composed it. A row it
// could not compose carries its stored name (or, on /api/products/:sku, the
// stored name minus "<Brand> Genuine") — a suffix of `name` — and keeps the
// legacy display (dedouble + packRename for the owner-pending packs).
// ─────────────────────────────────────────────────────────────────────────────

const row = (o) => ({ brand: { name: 'Brother' }, source: 'compatible', product_type: 'ink_cartridge', pack_type: 'single', ...o });

test('composed display_name is shown verbatim (live examples, 2026-10-18)', () => {
    const cases = [
        row({ name: 'LC3313KCMY Compatible Ink Cartridge for Brother LC3313 KCMY-Pack', color: 'KCMY', pack_type: 'value_pack',
            display_name: 'Brother LC3313 Compatible Ink Cartridges – 4 Colour Set BK, C, M, Y' }),
        row({ source: 'genuine', name: 'Brother Genuine TN1070BK Toner Cartridge TN1070 Black (1,000 pages)', color: 'Black',
            display_name: 'Brother TN1070 Genuine Toner Cartridge – Black (~1,000 pages)' }),
        row({ brand: { name: 'HP' }, name: '126AC Compatible Toner Cartridge for HP 126A (CE311A) Cyan', color: 'Cyan',
            display_name: 'HP 126A Compatible Toner Cartridge – Cyan (~1,000 pages)' }),
        // A composed title is never rewritten by the legacy pack grammar.
        row({ brand: { name: 'HP' }, source: 'genuine', name: 'HP Genuine 60BKCLR Ink Cartridge 60 Black/Colour Combo Pack (200 pages)',
            color: 'Black/Colour', pack_type: 'value_pack', display_name: 'HP 60 Genuine Ink Cartridges – Black + Tri-Colour Combo Pack' }),
    ];
    for (const p of cases) {
        assert.equal(ProductName.clean(p), p.display_name, p.name);
        assert.equal(ProductName.composed(p), p.display_name);
    }
});

test('uncomposed rows (display_name = stored name, or its prefix-less tail) keep the legacy display', () => {
    const designjet = { name: 'HP Genuine 711 80mlBK Ink Cartridge 711 80ml Black', color: 'Black' };
    // /api/shop sends the stored name; /api/products/:sku strips "<Brand> Genuine".
    for (const dn of [designjet.name, '711 80mlBK Ink Cartridge 711 80ml Black']) {
        const p = { ...designjet, display_name: dn };
        assert.equal(ProductName.composed(p), '', dn);
        assert.equal(ProductName.clean(p), 'HP Genuine 711 80ml Ink Cartridge Black', 'brand kept, de-doubled: ' + dn);
    }
    const lexmark = { name: 'Lexmark Genuine 74C0ZV0 Drum Unit (150,000 pages)', display_name: '74C0ZV0 Drum Unit (150,000 pages)' };
    assert.equal(ProductName.clean(lexmark), lexmark.name, 'never shows the brand-less PDP tail');
});

test('no display_name (old payloads, local rows) ⇒ legacy display, never blank', () => {
    const p = { name: 'Brother Genuine DR233CL Drum Unit 4-Pack', color: 'KCMY' };
    assert.equal(ProductName.clean(p), 'Brother Genuine DR233CL Drum Unit KCMY-Pack');
    assert.equal(ProductName.clean({ ...p, display_name: '' }), ProductName.legacy(p));
    assert.equal(ProductName.clean({ ...p, display_name: null }), ProductName.legacy(p));
});

test('the FE title composer is gone (ERR-359)', () => {
    const src = stripComments(READ(JS('utils.js')));
    for (const gone of ['function build(', 'composeMiss', "'4 Colour Set BK, C, M, Y'", 'TYPE_WORDS']) {
        assert.ok(!src.includes(gone), `${gone} must not come back — the backend composes display_name`);
    }
});

test('owner-pending packs keep the legacy grammar (ERR-357; 46 rows the backend left for the owner)', () => {
    // HP 67 "4-Pack" is black + tri-colour, 2 cartridges: a customer bought it as four.
    const hp67 = row({ brand: { name: 'HP' }, source: 'genuine', name: 'HP Genuine 67 Ink Cartridge 4-Pack', color: 'Value Pack', pack_type: 'value_pack' });
    assert.equal(ProductName.clean({ ...hp67, display_name: hp67.name }), 'HP Genuine 67 Ink Cartridge Value Pack');
    assert.doesNotMatch(ProductName.clean(row({ name: 'Epson Genuine 200 Ink Cartridge HY Value Pack 4-Pack', brand: 'Epson', source: 'genuine', color: 'Value Pack', pack_type: 'value_pack' })), /Value Pack Value Pack|4-Pack/);

    // Known codes keep their own grammar; multipacks of one colour keep their true count.
    assert.equal(ProductName.legacy(row({ name: 'Epson Genuine 604 Ink Cartridge 4-Pack', color: 'KCMY', pack_type: 'value_pack' })), 'Epson Genuine 604 Ink Cartridge KCMY-Pack');
    assert.match(ProductName.clean(row({ brand: 'HP', source: 'genuine', name: 'HP Genuine 45BK Ink Cartridge 45 Black 2-Pack (833 pages)', color: 'Black', pack_type: 'multipack' })), /2-Pack/);
});

test('cart lines, favourites, PDP alternatives + pack upsell and the free-shipping chip carry the backend title', () => {
    const CART = stripComments(READ(JS('cart.js')));
    assert.match(CART, /display_name:\s*item\.product\.display_name \|\| null/, '_parseServerCart keeps display_name');
    assert.match(CART, /cart-addon__name[^\n]*ProductName\.clean\(p\)/, 'free-shipping suggestion chip');
    const PDP = stripComments(READ(JS('product-detail-page.js')));
    assert.match(PDP, /const name = \(typeof ProductName !== 'undefined' \? ProductName\.clean\(a\) : a\.name\) \|\| a\.sku/, 'compatible alternatives');
    assert.match(PDP, /pack-upsell__name[^\n]*ProductName\.clean\(ps\)/, 'pack upsell');
    assert.match(stripComments(READ(JS('checkout-page.js'))), /checkout-summary__item-title">\$\{Security\.escapeHtml\(\(\(typeof ProductName !== 'undefined'\) \? ProductName\.clean\(item\)/, 'checkout summary line');
    const PAY = stripComments(READ(JS('payment-page.js')));
    assert.match(PAY, /display_name: item\.product\?\.display_name \|\| null/, 'payment cartItems keep display_name');
    assert.match(PAY, /checkout-summary__item-name">\$\{esc\(\(\(typeof ProductName !== 'undefined'\) \? ProductName\.clean\(item\)/, 'payment summary line');
    const FAV = stripComments(READ(JS('favourites.js')));
    assert.equal((FAV.match(/ProductName\.clean\((fav\.product|product)\)/g) || []).length, 2, 'server rows + newly added row');
});

test('look-alike grouping keys on the OLD display, not the descriptive title', () => {
    const src = stripComments(READ(JS('utils.js')));
    const body = src.slice(src.indexOf('function cardKey('), src.indexOf('function cardKey(') + 600);
    assert.match(body, /ProductName\.legacy\(product\)/);
    assert.doesNotMatch(body, /ProductName\.clean\(/);
});
