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
// Descriptive title (owner, 2026-10-15, ERR-341): Smart Ink style, built from
// fields. Rows it cannot build keep the old display (pinned above) and
// composeMiss() names why, so probe:product-titles can count them.
// ─────────────────────────────────────────────────────────────────────────────

const row = (o) => ({ brand: { name: 'Brother' }, source: 'compatible', product_type: 'ink_cartridge', pack_type: 'single', yield_tier: 'STD', ...o });

test('descriptive title: singles, packs, genuine, toner, drum', () => {
    const cases = [
        [row({ name: 'LC432XLKCMY Compatible Ink Cartridge for Brother LC432XL KCMY-Pack', color: 'KCMY', pack_type: 'value_pack', yield_tier: 'XL' }),
            'Brother LC432XL Compatible Ink Cartridges – 4 Colour Set BK, C, M, Y – High Yield'],
        [row({ name: 'LC432XLCMY Compatible Ink Cartridge for Brother LC432XL CMY-Pack', color: 'CMY', pack_type: 'value_pack', yield_tier: 'XL', page_yield: '1,500' }),
            'Brother LC432XL Compatible Ink Cartridges – 3 Colour Set C, M, Y – High Yield'],   // no pages on packs
        [row({ name: 'LC432XLBK Compatible Ink Cartridge for Brother LC432XL Black', color: 'Black', yield_tier: 'XL', page_yield: '3,000' }),
            'Brother LC432XL Compatible Ink Cartridge – Black – High Yield (~3,000 pages)'],
        [row({ brand: { name: 'HP' }, name: '126AC Compatible Toner Cartridge for HP 126A (CE311A) Cyan', color: 'Cyan', product_type: 'toner_cartridge', page_yield: '1,000' }),
            'HP 126A Compatible Toner Cartridge – Cyan (~1,000 pages)'],
        [row({ brand: 'Epson', source: 'genuine', name: 'Epson Genuine 288XLC Ink Cartridge 288XL Cyan (450 pages)', color: 'Cyan', yield_tier: 'XL', page_yield: '450' }),
            'Epson 288XL Genuine Ink Cartridge – Cyan – High Yield (~450 pages)'],
        [row({ source: 'genuine', name: 'Brother Genuine DR1170BK Drum Unit DR1170 Black (10,000 pages)', color: 'Black', product_type: 'drum_unit', page_yield: '10,000' }),
            'Brother DR1170 Genuine Drum Unit – Black (~10,000 pages)'],
        [row({ brand: 'Canon', source: 'genuine', name: 'Canon Genuine CLI42M Ink Cartridge CLI42 Magenta (48 pages)', color: 'Magenta', page_yield: '48 A3+' }),
            'Canon CLI42 Genuine Ink Cartridge – Magenta'],   // implausible yield dropped
        [row({ brand: 'HP', name: '67XXLBK Compatible Ink Cartridge for HP 67XXL Black', color: 'Black', yield_tier: 'XXL' }),
            'HP 67XXL Compatible Ink Cartridge – Black – Extra High Yield'],
    ];
    for (const [product, want] of cases) {
        assert.equal(ProductName.composeMiss(product), null, product.name);
        assert.equal(ProductName.clean(product), want, product.name);
    }
});

test('descriptive title: rows it cannot build keep the old display and say why', () => {
    const cases = [
        [row({ name: 'Brother Genuine TZe231 Label Tape', color: 'Black', product_type: 'label_tape', source: 'genuine' }), 'type_label_tape'],
        [row({ brand: 'HP', source: 'genuine', name: 'HP Genuine 70 130mlRD Ink Cartridge 70 130ml Red', color: 'Red' }), 'no_code'],
        [row({ name: 'Canon PG640/CL641 Ink Cartridge 2-Pack', brand: 'Canon', source: 'genuine', color: 'Black/Colour', pack_type: 'multipack' }), 'no_code'],
        [row({ brand: 'HP', name: '67XXLRD Compatible Ink Cartridge for HP 67XXL Tri-Colour', color: 'Red' }), 'color_mismatch'],
        [row({ name: 'LC3313 Compatible Ink Cartridge for Brother LC3313 5-Pack', color: 'Value Pack', pack_type: 'value_pack' }), 'pack_contents_unknown'],
        [row({ name: 'LC38BK Compatible Ink Cartridge for Brother LC38 Black', color: 'Black', source: 'local' }), 'no_source'],
    ];
    for (const [product, reason] of cases) {
        assert.equal(ProductName.composeMiss(product), reason, product.name);
        assert.equal(ProductName.clean(product), ProductName.legacy(product), 'fallback = old display: ' + product.name);
    }
});

test('black + tri-colour combo packs say so; unknown value packs drop the count (owner 2026-10-16, ERR-357)', () => {
    // HP 67 "4-Pack" is black + tri-colour, 2 cartridges: a customer bought it as four.
    const combo = row({ brand: { name: 'HP' }, source: 'genuine', name: 'HP Genuine 60BKCLR Ink Cartridge 60 Black/Colour Combo Pack (200 pages)', color: 'Black/Colour', pack_type: 'value_pack' });
    assert.equal(ProductName.composeMiss(combo), null);
    assert.equal(ProductName.clean(combo), 'HP 60 Genuine Ink Cartridges – Black + Tri-Colour Combo Pack');

    const hp67 = row({ brand: { name: 'HP' }, source: 'genuine', name: 'HP Genuine 67 Ink Cartridge 4-Pack', color: 'Value Pack', pack_type: 'value_pack' });
    assert.equal(ProductName.composeMiss(hp67), 'pack_contents_unknown', 'still counted loudly');
    assert.equal(ProductName.clean(hp67), 'HP Genuine 67 Ink Cartridge Value Pack');
    assert.doesNotMatch(ProductName.clean(row({ name: 'Epson Genuine 200 Ink Cartridge HY Value Pack 4-Pack', brand: 'Epson', source: 'genuine', color: 'Value Pack', pack_type: 'value_pack' })), /Value Pack Value Pack|4-Pack/);

    // Known codes keep their own grammar; multipacks of one colour keep their true count.
    assert.equal(ProductName.legacy(row({ name: 'Epson Genuine 604 Ink Cartridge 4-Pack', color: 'KCMY', pack_type: 'value_pack' })), 'Epson Genuine 604 Ink Cartridge KCMY-Pack');
    assert.match(ProductName.clean(row({ brand: 'HP', source: 'genuine', name: 'HP Genuine 45BK Ink Cartridge 45 Black 2-Pack (833 pages)', color: 'Black', pack_type: 'multipack' })), /2-Pack/);
});

test('look-alike grouping keys on the OLD display, not the descriptive title', () => {
    const src = stripComments(READ(JS('utils.js')));
    const body = src.slice(src.indexOf('function cardKey('), src.indexOf('function cardKey(') + 600);
    assert.match(body, /ProductName\.legacy\(product\)/);
    assert.doesNotMatch(body, /ProductName\.clean\(/);
});
