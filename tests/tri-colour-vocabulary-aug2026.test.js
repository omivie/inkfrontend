/**
 * Tri-colour catalogue corrections + colour-vocabulary hardening (Aug 2026)
 * ========================================================================
 *
 * ERR-143. A backend handoff arrived on 2026-08-03 describing six products
 * whose `color` had been corrected — five Canon singles moved from the vague
 * "Colour" to "Tri-Colour", and `G804CLR` became a live HP 804 Tri-Colour
 * SINGLE (it had been a fake KCMY 4-pack). It concluded:
 *
 *     "Nothing to code. Purge caches for the affected pages and eyeball the
 *      swatches. Verify the tri-colour swatch renders for all 6 SKUs."
 *
 * Two of those three instructions describe behaviour the storefront is built
 * to PREVENT, and verifying the claim surfaced defects the handoff never
 * mentioned. This file pins what was actually established.
 *
 * What it guards:
 *
 *   1. The swatch premise. All 6 SKUs are GENUINE, and a genuine row never
 *      paints a colour tile (the genuine-no-colour-tile invariant — see
 *      tests/genuine-no-color-tile.test.js). "Verify the swatch renders" is
 *      not a thing that can happen here, and the day someone "fixes" it
 *      toward a swatch, that test fails.
 *
 *   2. The label flip is visually inert. ProductColors.map maps 'colour' and
 *      'tri-colour' to the byte-identical gradient and COLOR_RANK ranks both
 *      11, so five of the six changed rows changed nothing but a text label.
 *
 *   3. familyKey's yield grammar. PRIORITY-0 used to carry its own regex,
 *      /^([A-Z]+\d+)(XXL|XL|HY|H)([A-Z]*)$/ — a second, subtly different
 *      grammar from SeriesCodes.YIELD_SUFFIX ~500 lines below it in the same
 *      file. `[A-Z]+` required a letter before the digits, so BARE-NUMERIC
 *      codes never collapsed ('804XL' stayed '804XL') while 'LC133XL' became
 *      'LC133'.
 *
 *      THE OBVIOUS FIX IS A REGRESSION. Widening to `[A-Z]*` was measured
 *      against all 1,350 distinct series_codes live on 2026-08-03: it
 *      collapses ZERO codes correctly and MANGLES THREE, because the `H`
 *      branch eats a letter out of a bare-numeric body. Those three are
 *      pinned below by name. Delegating to SeriesCodes.collapseYieldSuffix
 *      (which only strips X{1,3}L) was zero-diff across all 1,350.
 *
 *   4. ONE colour vocabulary. Three private colour→hex maps had forked from
 *      ProductColors — shop-page.js loadColorPacks, admin/pages/cc2-packs.js
 *      COLOR_DOT, and order-detail-page.js getColorPlaceholder. All three
 *      were PascalCase-keyed or name-derived and blind to 'Tri-Colour'; one
 *      interpolated a color_hex ARRAY straight into CSS. Same shape as
 *      ERR-075 / ERR-129 / ERR-135.
 *
 *   5. The dead landmine. shop-page.js::isValuePack had zero call sites and
 *      classified `color === 'colour'` and any name containing ' pack' as a
 *      pack — it would have mislabelled all 35 live Tri-Colour SINGLES.
 *
 * Run: node --test tests/tri-colour-vocabulary-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const CSS = (rel) => path.join(ROOT, 'inkcartridges', 'css', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const { ProductColors, ProductSort, SeriesCodes } = require(JS('utils.js'));

const UTILS_SRC = READ(JS('utils.js'));
const SHOP_SRC = READ(JS('shop-page.js'));
const CC2_SRC = READ(JS('admin/pages/cc2-packs.js'));
const ORDER_DETAIL_SRC = READ(JS('order-detail-page.js'));

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. familyKey — one yield vocabulary
// ─────────────────────────────────────────────────────────────────────────────

const fk = (codes, brand) =>
    ProductSort.familyKey({ name: 'placeholder', brand: { name: brand }, series_codes: codes });

test('familyKey PRIORITY-0 collapses BARE-NUMERIC yield codes onto the base family', () => {
    // The whole point: HP 804 and Epson 604 carry no letter prefix, so the old
    // `[A-Z]+\d+` pattern never matched and the XL rows forked into their own
    // family away from their std siblings.
    assert.equal(fk(['804XL'], 'HP'), 'B:HP:804');
    assert.equal(fk(['804'], 'HP'), 'B:HP:804');
    assert.equal(fk(['604XL'], 'Epson'), 'B:EPSON:604');
    assert.equal(fk(['65XL'], 'HP'), 'B:HP:65');
    assert.equal(fk(['200XXL'], 'Epson'), 'B:EPSON:200');
});

test('familyKey PRIORITY-0 still collapses LETTER-PREFIXED yield codes', () => {
    // The behaviour that already worked must not regress.
    assert.equal(fk(['LC133XL'], 'Brother'), 'B:BROTHER:LC133');
    assert.equal(fk(['CL641XL'], 'Canon'), 'B:CANON:CL641');
    assert.equal(fk(['PGI645XXL'], 'Canon'), 'B:CANON:PGI645');
});

test('familyKey PRIORITY-0 must NOT mangle bare-numeric Lexmark H-codes', () => {
    // MEASURED 2026-08-03 across all 1,350 distinct series_codes live on
    // /api/products: these three are the ONLY codes where the "obvious"
    // `[A-Z]+` -> `[A-Z]*` widening changes anything at all, and it is WRONG
    // on all three — the `H` yield branch eats a letter out of the code body
    // (34217HR -> 34217R). Real SKUs: G34217HRBK, G64017HRBK, G64080HWBK.
    //
    // If you are here because you just "fixed a typo" in that regex: run the
    // candidate over the whole live key space before believing a
    // one-character diff.
    for (const code of ['34217HR', '64017HR', '64080HW']) {
        assert.equal(fk([code], 'Lexmark'), `B:LEXMARK:${code}`,
            `${code} must survive familyKey intact — the H branch must never fire on a bare-numeric body`);
    }
});

test('familyKey routes through SeriesCodes.collapseYieldSuffix — no second yield regex', () => {
    const src = stripComments(UTILS_SRC);
    assert.match(src, /base\s*=\s*SeriesCodes\.collapseYieldSuffix\(base\)/,
        'familyKey PRIORITY-0 must delegate to the one yield vocabulary');
    // The retired PRIORITY-0 pattern specifically. `(XXL|XL|HY|H)` still
    // appears in the name-scrape fallback below it, where it strips a yield
    // PREFIX off an extracted suffix — a different job on a different input,
    // and correct there.
    assert.doesNotMatch(src, /\^\(\[A-Z\]\+\\d\+\)\(XXL\|XL\|HY\|H\)/,
        'the second whole-code yield grammar must be gone — one vocabulary, not two that disagree');
    // window.SeriesCodes is undefined under require(), which would silently
    // disable the fix in every test while looking fine in a browser.
    assert.doesNotMatch(src, /window\.SeriesCodes\.collapseYieldSuffix/,
        'must reference the SeriesCodes binding directly, never off window');
});

test('familyKey unifies a genuine std row with an enriched compatible XL row', () => {
    // api.js::_enrichSeriesCodes emits '804XL' for any payload that ships no
    // backend series_codes; the genuine sibling carries the collapsed '804'.
    // Before the fix these landed in two families and the grid split them.
    const genuine = fk(['804'], 'HP');
    const enrichedCompatible = fk(['804XL'], 'HP');
    assert.equal(genuine, enrichedCompatible,
        'std and XL siblings must share one family — yieldTier is what separates them inside it');
});

test('SeriesCodes.collapseYieldSuffix strips only X{1,3}L, never H/HY', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('804XL'), '804');
    assert.equal(SeriesCodes.collapseYieldSuffix('804XXL'), '804');
    assert.equal(SeriesCodes.collapseYieldSuffix('34217HR'), '34217HR');
    assert.equal(SeriesCodes.collapseYieldSuffix('CART069H'), 'CART069H');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The Aug 2026 label flip is visually inert
// ─────────────────────────────────────────────────────────────────────────────

test('getStyle("Colour") and getStyle("Tri-Colour") are byte-identical', () => {
    const vague = ProductColors.getStyle('Colour');
    const precise = ProductColors.getStyle('Tri-Colour');
    assert.ok(vague, "'Colour' must still render — 11 live rows still store it");
    assert.equal(vague, precise,
        'the Aug 2026 backend flip changed the label only; the swatch must be unchanged');
    assert.match(precise, /linear-gradient/, 'tri-colour is the CMY 3-stripe');
    assert.match(precise, /#00bcd4[\s\S]*#e91e63[\s\S]*#ffeb3b/, 'cyan → magenta → yellow, in order');
});

test('Colour and Tri-Colour both rank 11 — the flip does not move a product', () => {
    assert.equal(ProductSort.colorOrder({ color: 'Colour' }), 11);
    assert.equal(ProductSort.colorOrder({ color: 'Tri-Colour' }), 11);
});

test('Tri-Colour is a SINGLE — never in PACK_VALUES', () => {
    assert.ok(!ProductColors.PACK_VALUES.includes('Tri-Colour'),
        'Tri-Colour is ONE cartridge holding three inks, not a multi-cartridge pack');
    assert.ok(ProductColors.PACK_VALUES.includes('CMY'), 'CMY is three separate cartridges');
});

test('G804CLR-shaped row: tri-colour single, no pack classification', () => {
    const g804clr = {
        sku: 'G804CLR', name: 'HP Genuine 804CLR Ink Cartridge 804 Tri-Colour (165 pages)',
        brand: { name: 'HP' }, color: 'Tri-Colour', pack_type: 'single',
        series_codes: ['804'], source: 'genuine', image_url: null
    };
    assert.equal(ProductSort.packRank(g804clr), 0, 'pack_type "single" must not rank as a pack');
    assert.equal(ProductSort.colorOrder(g804clr), 11, 'a tri-colour single ranks 11, not 20/21');
    assert.equal(ProductSort.familyKey(g804clr), 'B:HP:804',
        'must share the 804 family with G804BK / G804XLBK / G804XLCLR');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Vocabulary completeness — map / OPTIONS / COLOR_RANK agree
// ─────────────────────────────────────────────────────────────────────────────

const swatchFor = (c) => ProductColors.map[String(c).toLowerCase().trim()];

test('every ProductColors.OPTIONS value has a swatch', () => {
    // An admin can only save what OPTIONS offers. Offering a colour the
    // storefront cannot paint produces a blank tile with no error anywhere.
    for (const opt of ProductColors.OPTIONS) {
        assert.ok(swatchFor(opt.value),
            `OPTIONS offers '${opt.value}' but ProductColors.map cannot paint it`);
    }
});

test('every ranked colour name has a swatch', () => {
    const aliasOrPack = /^[a-z]{1,4}$/;
    const packKeys = new Set(['cmy', 'kcmy', 'cmyk', 'bcmy', '3-pack', '3 pack', '4-pack', '4 pack']);
    for (const key of Object.keys(ProductSort.COLOR_RANK)) {
        if (aliasOrPack.test(key) || packKeys.has(key)) continue;
        assert.ok(ProductColors.map[key],
            `COLOR_RANK ranks '${key}' but ProductColors.map has no entry — sortable but unpaintable`);
    }
});

test('OPTIONS carries the British spellings production actually stores', () => {
    const values = ProductColors.OPTIONS.map(o => o.value);
    // Production has stored 'Grey' 27 times and 'Light Grey' 6 times while the
    // dropdown only knew the US 'Gray' — so all 33 rendered as "(legacy)" and
    // any save silently re-spelled them. That is how an open vocabulary drifts.
    assert.ok(values.includes('Grey'), "OPTIONS must offer 'Grey'");
    assert.ok(values.includes('Light Grey'), "OPTIONS must offer 'Light Grey'");
    // The US spellings stay so existing rows and the pinned ordering hold, but
    // must be labelled so nobody picks them by accident.
    const gray = ProductColors.OPTIONS.find(o => o.value === 'Gray');
    assert.ok(gray, "'Gray' must be retained for existing rows");
    assert.match(gray.label, /US spelling/i, "'Gray' must be labelled as the non-preferred spelling");
});

test("'Colour' and 'Color' are deliberately NOT selectable", () => {
    const values = ProductColors.OPTIONS.map(o => o.value.toLowerCase());
    assert.ok(!values.includes('colour'), "offering 'Colour' is how 13 tri-colour singles got mislabelled");
    assert.ok(!values.includes('color'), "'Color' must not be offerable either");
    // But they must still render and sort — 11 live rows still carry them.
    assert.ok(ProductColors.map['colour'], "'colour' must still PAINT for legacy rows");
    assert.equal(ProductSort.COLOR_RANK['colour'], 11, "'colour' must still SORT for legacy rows");
});

test('PACK_VALUES covers the pack labels production stores', () => {
    // ERR-075 cuts both ways: a bogus value matches zero rows, and a real pack
    // colour MISSING from this list hides real packs. All 5 live rows carrying
    // 'CMYK' or 'Black/Colour' are pack_type='value_pack' 4-packs.
    for (const v of ['CMY', 'KCMY', 'CMYK', 'Black/Colour', 'Value Pack', 'Multipack']) {
        assert.ok(ProductColors.PACK_VALUES.includes(v), `PACK_VALUES must include '${v}'`);
    }
    const optionValues = new Set(ProductColors.OPTIONS.map(o => o.value));
    for (const v of ProductColors.PACK_VALUES) {
        assert.ok(optionValues.has(v), `PACK_VALUES '${v}' must also be an OPTIONS value (ERR-075 guard)`);
    }
});

test('unknown colours still land on RANK_UNKNOWN_SINGLE after the additions', () => {
    // Every Aug 2026 addition is a fractional rank below 19, so a genuinely
    // unrecognised colour stays distinguishable from a known finish.
    assert.equal(ProductSort.colorOrder({ color: 'Ultraviolet Sparkle' }), 19);
    for (const finish of ['Clear', 'Chroma Optimizer', 'Gloss Enhancer']) {
        const r = ProductSort.colorOrder({ color: finish });
        assert.ok(r < 19, `${finish} must rank below unknown (got ${r})`);
        assert.ok(r > 17, `${finish} must rank after the coloured inks (got ${r})`);
    }
});

test('getProductStyle renders a multi-hex color_hex ARRAY as a gradient', () => {
    // shop-page.js used to interpolate this field straight into a template:
    // `background:${['#a','#b']}` stringifies to "background:#a,#b", which is
    // invalid CSS and paints nothing.
    const style = ProductColors.getProductStyle({ color_hex: ['#00bcd4', '#e91e63', '#ffeb3b'] });
    assert.match(style, /linear-gradient/, 'a 3-hex array must produce a striped gradient');
    assert.doesNotMatch(style, /#00bcd4,#e91e63/, 'must never emit a bare comma-joined array');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ONE vocabulary — no private colour maps
// ─────────────────────────────────────────────────────────────────────────────

test('ProductColors is the ONLY cartridge-colour vocabulary in inkcartridges/js', () => {
    // The signature of a product-colour map is the CMYK vocabulary: a cyan key
    // AND a magenta key mapped to hexes. (admin/pages/planner.js has a
    // sticky-note palette — yellow/pink/blue/green/purple — which is a UI
    // theme, not a cartridge colour, and is correctly not matched here.)
    const cyanKey = /\bcyan\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/i;
    const magentaKey = /\bmagenta\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/i;
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js') || full === JS('utils.js')) continue;
            const src = fs.readFileSync(full, 'utf8');
            if (cyanKey.test(src) && magentaKey.test(src)) offenders.push(path.relative(ROOT, full));
        }
    };
    walk(path.join(ROOT, 'inkcartridges', 'js'));
    assert.deepEqual(offenders, [],
        `private cartridge-colour maps must not exist — use ProductColors.getProductStyle(). Found: ${offenders.join(', ')}`);
});

test('shop-page loadColorPacks paints swatches through ProductColors', () => {
    const src = stripComments(SHOP_SRC);
    assert.match(src, /ProductColors\.getProductStyle\(item,\s*['"]background-color: #888;['"]\)/,
        'colour-pack swatches must use getProductStyle (handles color_hex arrays + gradients)');
    assert.doesNotMatch(src, /const\s+colorHex\s*=\s*\{/,
        'the private colorHex literal must be gone');
});

test('admin cc2-packs colour dots read the shared vocabulary', () => {
    const src = stripComments(CC2_SRC);
    assert.doesNotMatch(src, /COLOR_DOT/, 'the private COLOR_DOT map must be gone');
    assert.match(src, /function colorDotStyle/, 'must define a helper that delegates');
    assert.match(src, /window\.ProductColors/, 'must read the shared vocabulary off window (admin is a module)');
    assert.match(src, /style="\$\{colorDotStyle\(c\)\}"/, 'the dot must render through the helper');
});

test('order-detail placeholder derives its tile from ProductColors, not a name scan', () => {
    const src = stripComments(ORDER_DETAIL_SRC);
    assert.match(src, /ProductColors\.getProductStyle\(\{\s*color,\s*name:\s*productName\s*\}/,
        'must resolve colour through the shared vocabulary');
    assert.doesNotMatch(src, /const colors = \{[\s\S]*?'cyan':/,
        'the private 7-word name-scan map must be gone');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The dead landmine stays dead
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js no longer defines isValuePack', () => {
    // It had zero call sites and classified `color === 'colour'`, `'cmyk'`, and
    // any name containing ' pack' / 'multi' / 'bundle' as a pack — so the day
    // anyone wired it up it would have relabelled all 35 live Tri-Colour
    // SINGLES as multi-cartridge packs.
    assert.doesNotMatch(stripComments(SHOP_SRC), /isValuePack\s*\(/,
        'isValuePack must not be reintroduced — use ProductSort.packRank / PACK_NAME_REGEX');
});

test('the tested pack classifiers are the ones that survive', () => {
    assert.equal(ProductSort.packRank({ pack_type: 'value_pack' }), 1);
    assert.equal(ProductSort.packRank({ pack_type: 'multipack' }), 2);
    assert.equal(ProductSort.packRank({ pack_type: 'single' }), 0);
    // A tri-colour SINGLE must never read as a pack, by any classifier.
    assert.equal(ProductSort.packRank({ pack_type: 'single', color: 'Tri-Colour' }), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Near-white swatches need an edge
// ─────────────────────────────────────────────────────────────────────────────

test('colour-block tiles carry a border so White and the finishes stay visible', () => {
    // 'White', 'Clear', 'Chroma Optimizer' and 'Gloss Enhancer' resolve to
    // near-white fills; without an edge they are invisible on a white card.
    const components = READ(CSS('components.css'));
    const pages = READ(CSS('pages.css'));
    assert.match(components, /\.product-card__color-block\s*\{[^}]*border:\s*1px solid/,
        '.product-card__color-block needs a border (components.css)');
    assert.match(pages, /\.product-gallery__color-block\s*\{[^}]*border:\s*1px solid/,
        '.product-gallery__color-block needs a border (pages.css)');
});
