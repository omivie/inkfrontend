/**
 * Look-alike duplicate catalogue rows — frontend contract tests (ERR-195)
 * =======================================================================
 *
 * WHAT HAPPENED
 * -------------
 * A shopper on `/shop?brand=canon&category=ink&code=CI3` was shown two black
 * Canon cartridges they could not tell apart. The backend repaired the data and
 * handed over `lookalike-duplicate-rows-FE-handoff-aug2026.md`, whose §7 states
 * that identical-name and shared-slug scans "return zero across active rows".
 *
 * Measured against live production on 2026-09-01 — all 4,086 active rows off
 * `/api/products?limit=200&page=N` — they do not. They return one group, and it
 * renders on the very page that was reported:
 *
 *     CBCI3CMY  $14.99  CMY  value_pack  BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack
 *     CBCI6CMY  $14.99  CMY  value_pack  BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack
 *
 * Byte-identical name, slug, colour and price. The duplicate was not removed;
 * it moved from the two blacks to the two CMY 3-packs.
 *
 * WHAT THIS FILE PINS
 * -------------------
 * The storefront's own defence, which does not depend on any one row being
 * fixed: when two cards in a grid are indistinguishable, print the SKU on those
 * cards — and ONLY those cards.
 *
 *   §1  ProductIdentity is published (bare const + window + module.exports)
 *   §2  POSITIVE control — the real live pair is detected
 *   §3  NEGATIVE controls — the rows the backend DID fix stay unmarked
 *   §4  The guard: one differing field is enough to be distinguishable
 *   §5  Never hides — length, order and every other field are untouched
 *   §6  Enrolment — every card surface calls markLookalikes
 *   §7  Render — the SKU line is emitted, escaped, and gated on the flag
 *   §8  RUNTIME render — renderCard/renderCards actually executed, not grepped
 *
 * §2 AND §3 ARE A MATCHED PAIR ON PURPOSE. A detector that marks everything
 * passes §2 and a detector that marks nothing passes §3; only both together say
 * anything. A test can pass for the wrong reason (ERR-181/186) — keep the
 * positive control next to the negative one so it cannot.
 *
 * Fixtures are REAL rows copied from the live API, not invented ones, so a
 * change in the shipped `ProductName.clean` de-doubler shows up here.
 *
 * Run: node --test tests/lookalike-duplicate-rows-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const { ProductIdentity, ProductName } = require(JS('utils.js'));

const UTILS_SRC   = READ(JS('utils.js'));
const PRODUCTS_SRC = READ(JS('products.js'));
const SHOP_SRC     = READ(JS('shop-page.js'));
const SEARCH_SRC   = READ(JS('search.js'));
const PDP_SRC      = READ(JS('product-detail-page.js'));

// ── Real live rows, 2026-09-01 ───────────────────────────────────────────────

/** The defect, exactly as /api/shop?brand=canon&category=ink&code=CI3 returns it. */
const LIVE_PAIR = [
    {
        sku: 'CBCI3CMY',
        name: 'BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack',
        slug: 'bci3cmy-compatible-ink-cartridge-for-canon-bci3-bci6-cmy-3-pack',
        retail_price: 14.99, color: 'CMY', pack_type: 'value_pack'
    },
    {
        sku: 'CBCI6CMY',
        name: 'BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack',
        slug: 'bci3cmy-compatible-ink-cartridge-for-canon-bci3-bci6-cmy-3-pack',
        retail_price: 14.99, color: 'CMY', pack_type: 'value_pack'
    }
];

/** The rest of the reported page — every one of these must stay unmarked. */
const CI3_REST = [
    { sku: 'CBCI3BK',   name: 'BCI3BK Compatible Ink Cartridge for Canon BCI3 Black',              retail_price: 5.99,  color: 'Black',   pack_type: 'single' },
    { sku: 'CBCI3C',    name: 'BCI3C Compatible Ink Cartridge for Canon BCI3 BCI6 Cyan',           retail_price: 5.49,  color: 'Cyan',    pack_type: 'single' },
    { sku: 'CBCI3M',    name: 'BCI3M Compatible Ink Cartridge for Canon BCI3 BCI6 Magenta',        retail_price: 5.49,  color: 'Magenta', pack_type: 'single' },
    { sku: 'CBCI3Y',    name: 'BCI3Y Compatible Ink Cartridge for Canon BCI3 BCI6 Yellow',         retail_price: 5.49,  color: 'Yellow',  pack_type: 'single' },
    { sku: 'CBCI3KCMY', name: 'BCI3KCMY Compatible Ink Cartridge for Canon BCI3 BCI6 KCMY 4-Pack', retail_price: 20.49, color: 'KCMY',    pack_type: 'value_pack' },
    { sku: 'GCI3EC',    name: 'Canon Genuine CI3EC Ink Cartridge CI3E Cyan (280 pages)',           retail_price: 22.79, color: 'Cyan',    pack_type: 'single' },
    { sku: 'GCI3EM',    name: 'Canon Genuine CI3EM Ink Cartridge CI3E Magenta (280 pages)',        retail_price: 22.79, color: 'Magenta', pack_type: 'single' },
    { sku: 'GCI3EY',    name: 'Canon Genuine CI3EY Ink Cartridge CI3E Yellow (280 pages)',         retail_price: 22.79, color: 'Yellow',  pack_type: 'single' }
];

/**
 * §4c of the handoff: 21 Brother compatible drums renamed onto the compact
 * grammar precisely so their C/M/Y stopped rendering as three identical cards.
 * That fix WORKED — this is the control that proves the detector agrees.
 */
const BROTHER_DRUMS = [
    { sku: 'CDR233CLBK', name: 'DR233CLBK Compatible Drum Unit for Brother DR233CL Black (18,000 pages)', retail_price: 89.99, color: 'Black',   pack_type: 'single' },
    { sku: 'CDR233CLC',  name: 'DR233CLC Compatible Drum Unit for Brother DR233CL Cyan',                  retail_price: 89.99, color: 'Cyan',    pack_type: 'single' },
    { sku: 'CDR233CLM',  name: 'DR233CLM Compatible Drum Unit for Brother DR233CL Magenta',               retail_price: 89.99, color: 'Magenta', pack_type: 'single' },
    { sku: 'CDR233CLY',  name: 'DR233CLY Compatible Drum Unit for Brother DR233CL Yellow',                retail_price: 89.99, color: 'Yellow',  pack_type: 'single' }
];

/**
 * The pre-fix shape: `Compatible Drum Unit for Brother DR233CL` with no colour
 * anywhere. Note it drops `color` too, and that is the whole point — the card
 * renders a colour chip, so three same-named rows that each carry a DIFFERENT
 * colour are already distinguishable and are correctly left alone (asserted
 * below). It is when the name AND the colour are both silent that the shopper
 * is left with three identical cards, which is what §4c actually described.
 */
const BROTHER_DRUMS_BEFORE = BROTHER_DRUMS.map((d) => ({
    ...d, name: 'Compatible Drum Unit for Brother DR233CL', color: ''
}));

/** §4a: the two Canon blacks the fix split apart. They are now distinct. */
const CANON_BLACKS = [
    { sku: 'CBCI3BK', name: 'BCI3BK Compatible Ink Cartridge for Canon BCI3 Black', retail_price: 5.99, color: 'Black', pack_type: 'single' },
    { sku: 'CBCI6BK', name: 'BCI6BK Compatible Ink Cartridge for Canon BCI6 Black', retail_price: 5.49, color: 'Black', pack_type: 'single' }
];

const skusOf = (list) => list.map((p) => p.sku);
const marked = (list) => list.filter((p) => p._lookalikeSku).map((p) => p.sku);
const fresh = (list) => list.map((p) => ({ ...p }));

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the module is reachable from every consumer
// ─────────────────────────────────────────────────────────────────────────────

test('§1 ProductIdentity exposes the three documented functions', () => {
    assert.equal(typeof ProductIdentity.cardKey, 'function');
    assert.equal(typeof ProductIdentity.lookalikeGroups, 'function');
    assert.equal(typeof ProductIdentity.markLookalikes, 'function');
});

test('§1 ProductIdentity is published on window (ERR-167)', () => {
    // security.js is a bare const and `window.Security?.x ? … : fallback`
    // guards became permanent off-switches. Every surface here reaches
    // ProductIdentity through a `typeof ProductIdentity !== 'undefined'` guard,
    // which needs the bare binding — but the window publish has to exist too,
    // for anything loaded before/outside this file's scope. Grep the assignment.
    assert.match(UTILS_SRC, /window\.ProductIdentity\s*=\s*ProductIdentity/);
});

test('§1 ProductIdentity is in module.exports', () => {
    assert.match(UTILS_SRC, /module\.exports\s*=\s*\{[\s\S]*?\bProductIdentity\b/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — POSITIVE control: the live defect is detected
// ─────────────────────────────────────────────────────────────────────────────

test('§2 the live CBCI3CMY / CBCI6CMY pair is one look-alike group', () => {
    const groups = ProductIdentity.lookalikeGroups(fresh(LIVE_PAIR));
    assert.equal(groups.length, 1, 'the two identical CMY 3-packs must group');
    assert.deepEqual(skusOf(groups[0]), ['CBCI3CMY', 'CBCI6CMY']);
});

test('§2 on the full reported page, exactly 2 of 11 cards are marked', () => {
    const page = fresh([...CI3_REST.slice(0, 4), ...LIVE_PAIR, ...CI3_REST.slice(4)]);
    const result = ProductIdentity.markLookalikes(page);
    assert.deepEqual(result, { groups: 1, marked: 2, skus: ['CBCI3CMY', 'CBCI6CMY'] });
    assert.deepEqual(marked(page), ['CBCI3CMY', 'CBCI6CMY']);
});

test('§2 the pre-fix Brother drums (colour nowhere) are detected', () => {
    // This is the OTHER half of what the backend fixed. If the rename is ever
    // reverted or a new series ships without its colour token, this shape comes
    // back — and the storefront must catch it rather than render blank twins.
    const groups = ProductIdentity.lookalikeGroups(fresh(BROTHER_DRUMS_BEFORE));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 4);
});

test('§2 …but a colourless NAME alone is not enough when the colour chip differs', () => {
    // 101 active rows still carry a colour their name omits. They are NOT this
    // defect: the card prints `product-card__color`, so the shopper can tell
    // them apart. Marking them would put a SKU line on 101 innocent cards and
    // teach everyone to ignore it. The signal has to stay rare to stay a signal.
    const nameOnlyCollision = BROTHER_DRUMS.map((d) => ({
        ...d, name: 'Compatible Drum Unit for Brother DR233CL'
    }));
    assert.deepEqual(ProductIdentity.lookalikeGroups(nameOnlyCollision), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — NEGATIVE controls: what the backend fixed must stay unmarked
// ─────────────────────────────────────────────────────────────────────────────

test('§3 the 21 renamed Brother drums produce zero groups', () => {
    assert.deepEqual(ProductIdentity.lookalikeGroups(fresh(BROTHER_DRUMS)), []);
});

test('§3 the split Canon blacks produce zero groups', () => {
    assert.deepEqual(ProductIdentity.lookalikeGroups(fresh(CANON_BLACKS)), []);
});

test('§3 nothing else on the reported page is marked', () => {
    const rest = fresh(CI3_REST);
    const result = ProductIdentity.markLookalikes(rest);
    assert.deepEqual(result, { groups: 0, marked: 0, skus: [] });
    assert.deepEqual(marked(rest), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the guard: one visible difference is enough
// ─────────────────────────────────────────────────────────────────────────────

const base = { sku: 'A1', name: 'Widget Ink Cartridge', retail_price: 9.99, color: 'Black', pack_type: 'single' };

test('§4 same everything but PRICE is not a look-alike', () => {
    const list = [{ ...base }, { ...base, sku: 'A2', retail_price: 10.99 }];
    assert.deepEqual(ProductIdentity.lookalikeGroups(list), []);
});

test('§4 same everything but COLOUR is not a look-alike', () => {
    const list = [{ ...base }, { ...base, sku: 'A2', color: 'Cyan' }];
    assert.deepEqual(ProductIdentity.lookalikeGroups(list), []);
});

test('§4 same everything but PACK TYPE is not a look-alike', () => {
    const list = [{ ...base }, { ...base, sku: 'A2', pack_type: 'value_pack' }];
    assert.deepEqual(ProductIdentity.lookalikeGroups(list), []);
});

test('§4 price shape does not decide it — 14.99, "14.99" and 14.990 are one price', () => {
    // The two list endpoints disagree on shape. A string compare would call
    // this pair distinct and miss the defect entirely.
    const list = [
        { ...base, sku: 'A1', retail_price: 14.99 },
        { ...base, sku: 'A2', retail_price: '14.99' },
        { ...base, sku: 'A3', retail_price: 14.990 }
    ];
    const groups = ProductIdentity.lookalikeGroups(list);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
});

test('§4 the autocomplete payload shape (`price`, not `retail_price`) is read', () => {
    const list = [{ ...base, retail_price: undefined, price: 9.99 },
                  { ...base, sku: 'A2', retail_price: undefined, price: 9.99 }];
    assert.equal(ProductIdentity.lookalikeGroups(list).length, 1);
});

test('§4 the key is the CLEANED title, so a de-doubler collision is caught', () => {
    // ProductName.clean rewrites genuine titles for display (ERR-055). It can
    // therefore create a collision the raw `name` column does not have — which
    // is exactly the case a raw-name check would miss.
    const a = { sku: 'G1', name: 'HP Genuine 70 130mlCY Ink Cartridge 70 130ml Cyan', color: 'Cyan', retail_price: 5, pack_type: 'single' };
    const b = { sku: 'G2', name: 'HP Genuine 70 130ml Ink Cartridge Cyan',            color: 'Cyan', retail_price: 5, pack_type: 'single' };
    assert.notEqual(a.name, b.name, 'the stored names differ');
    assert.equal(ProductName.clean(a), ProductName.clean(b), 'but they render identically');
    assert.equal(ProductIdentity.lookalikeGroups([a, b]).length, 1, 'so they must group');
});

test('§4 a row with no title is skipped, never grouped with another blank', () => {
    const list = [{ sku: 'A1', name: '' }, { sku: 'A2', name: '' }];
    assert.deepEqual(ProductIdentity.lookalikeGroups(list), []);
});

test('§4 a look-alike with no SKU is left unmarked rather than given a blank label', () => {
    const list = [{ ...base, sku: '' }, { ...base, sku: 'A2' }];
    const result = ProductIdentity.markLookalikes(list);
    assert.equal(result.groups, 1, 'the group is still reported');
    assert.equal(result.marked, 1, 'but only the row that has a SKU is marked');
    assert.equal(list[0]._lookalikeSku, undefined);
    assert.equal(list[1]._lookalikeSku, 'A2');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — never hides
// ─────────────────────────────────────────────────────────────────────────────

test('§5 markLookalikes never removes or reorders a row', () => {
    const page = fresh([...CI3_REST.slice(0, 4), ...LIVE_PAIR, ...CI3_REST.slice(4)]);
    const before = skusOf(page);
    ProductIdentity.markLookalikes(page);
    assert.equal(page.length, before.length, 'a live purchasable row must never be hidden');
    assert.deepEqual(skusOf(page), before, 'order is the caller\'s, not ours');
});

test('§5 markLookalikes touches no field but _lookalikeSku', () => {
    const page = fresh(LIVE_PAIR);
    ProductIdentity.markLookalikes(page);
    for (let i = 0; i < page.length; i++) {
        const { _lookalikeSku, ...rest } = page[i];
        assert.deepEqual(rest, LIVE_PAIR[i], 'every other field is untouched');
    }
});

test('§5 markLookalikes is idempotent', () => {
    const page = fresh(LIVE_PAIR);
    const first = ProductIdentity.markLookalikes(page);
    const snapshot = JSON.stringify(page);
    const second = ProductIdentity.markLookalikes(page);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(page), snapshot);
});

test('§5 lookalikeGroups is pure — it mutates nothing', () => {
    const page = fresh(LIVE_PAIR);
    const snapshot = JSON.stringify(page);
    ProductIdentity.lookalikeGroups(page);
    assert.equal(JSON.stringify(page), snapshot);
});

test('§5 degenerate inputs return empty rather than throwing', () => {
    for (const input of [null, undefined, [], [{ sku: 'A' }], 'nope', 42, {}]) {
        assert.deepEqual(ProductIdentity.lookalikeGroups(input), [], String(input));
        assert.equal(ProductIdentity.markLookalikes(input).groups, 0, String(input));
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — enrolment
//
// "Every surface calls X" is a list nobody maintains: the public volume-pricing
// ladder vanished twice, silently, at a parser and then at a call site
// (ERR-150/160). Put the enrolment in a test instead.
// ─────────────────────────────────────────────────────────────────────────────

const SURFACES = [
    ['products.js (search dropdown, related, generic grids)', PRODUCTS_SRC],
    ['shop-page.js (the reported page)',                      SHOP_SRC],
    ['search.js (results page)',                              SEARCH_SRC],
    ['product-detail-page.js (related products)',             PDP_SRC]
];

for (const [label, src] of SURFACES) {
    test(`§6 ${label} calls ProductIdentity.markLookalikes`, () => {
        assert.match(src, /ProductIdentity\.markLookalikes\(/,
            `${label} renders product cards and must mark look-alikes`);
    });
}

test('§6 every ProductSort.byCodeThenColor surface is one of the enrolled four', () => {
    // If a fifth card surface appears, it will call byCodeThenColor (that is how
    // every grid in this codebase sorts) and this assertion fails, rather than
    // the surface silently shipping without the guard.
    const dir = path.join(ROOT, 'inkcartridges', 'js');
    const enrolled = new Set(['products.js', 'shop-page.js', 'search.js', 'product-detail-page.js']);
    const offenders = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js') || enrolled.has(name)) continue;
        const full = path.join(dir, name);
        if (!fs.statSync(full).isFile()) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/ProductSort\.byCodeThenColor\(/.test(src) && !/ProductIdentity\.markLookalikes\(/.test(src)) {
            offenders.push(name);
        }
    }
    assert.deepEqual(offenders, [],
        'these sort product cards but do not mark look-alikes — enrol them');
});

test('§6 shop-page marks AFTER the sort branch, so both sort modes are covered', () => {
    // Marking inside the `recommended` branch would leave every explicit
    // price/name sort unguarded — half the page, reached by one dropdown.
    const i = SHOP_SRC.indexOf('ProductIdentity.markLookalikes(sortedProducts)');
    const j = SHOP_SRC.indexOf("sortedProducts = compatLast(this._sortProductsBy(products, sortMode))");
    assert.ok(i > 0 && j > 0 && i > j,
        'the mark must run after both sortedProducts assignments, not inside one branch');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — render
// ─────────────────────────────────────────────────────────────────────────────

const RENDERERS = [['products.js', PRODUCTS_SRC], ['shop-page.js', SHOP_SRC]];

for (const [label, src] of RENDERERS) {
    test(`§7 ${label} emits the SKU line only when _lookalikeSku is set`, () => {
        assert.match(src, /\$\{product\._lookalikeSku \?/,
            'the SKU line must be gated — 4,084 of 4,086 rows render unchanged');
        assert.match(src, /class="product-card__sku"/);
    });

    test(`§7 ${label} escapes the SKU it prints`, () => {
        assert.match(src, /product-card__sku">SKU \$\{Security\.escapeHtml\(product\._lookalikeSku\)\}/,
            'dynamic HTML is always escaped');
    });
}

test('§7 .product-card__sku is already styled — no new CSS was added', () => {
    const css = READ(path.join(ROOT, 'inkcartridges', 'css', 'components.css'));
    assert.match(css, /\.product-card__sku\s*\{/,
        'the class predates this change; reuse it rather than inventing another');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — RUNTIME render
//
// §7 greps the source, which proves the line was written. This section actually
// EXECUTES Products.renderCard in a vm and reads the HTML that comes out, which
// proves the line renders — the difference between "the code says so" and "we
// measured it". A source grep cannot tell you the template literal is inside a
// branch that never runs.
// ─────────────────────────────────────────────────────────────────────────────

const vm = require('node:vm');

/** Load the real products.js with the minimum inert stubs renderCard touches. */
function loadProducts() {
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const sandbox = {
        console,
        URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol, RegExp,
        Security: { escapeHtml: esc, escapeAttr: esc, sanitizeUrl: (u) => u },
        ProductColors: {
            getStyle: () => null, getProductStyle: () => null,
            detectFromName: () => null, isPlaceholderSwatchImage: () => false,
        },
        // The real ProductName + ProductIdentity, not stubs — renderCard reads
        // ProductName.clean, and stubbing it would hide a de-doubler regression.
        ProductName, ProductIdentity, ProductSort: require(JS('utils.js')).ProductSort,
        getStockStatus: () => ({ class: 'in-stock', text: 'In stock' }),
        getSourceBadge: () => ({ class: 'compatible', text: 'COMPATIBLE' }),
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

test('§8 a card with no _lookalikeSku renders NO sku line', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...CI3_REST[0], id: 'p1' });
    assert.ok(!html.includes('product-card__sku'),
        'the 4,084 rows that are not look-alikes must render byte-identically to before');
});

test('§8 a marked card renders the sku line with its SKU', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...LIVE_PAIR[1], id: 'p2', _lookalikeSku: 'CBCI6CMY' });
    assert.match(html, /<p class="product-card__sku">SKU CBCI6CMY<\/p>/);
});

test('§8 renderCards end-to-end: the live pair is marked and rendered, in one call', () => {
    // The whole chain, exactly as the search dropdown and PDP related grids run
    // it: sort → mark → render. Nothing is stubbed between them.
    const Products = loadProducts();
    const page = [...CI3_REST.slice(0, 4), ...LIVE_PAIR, ...CI3_REST.slice(4)]
        .map((p, i) => ({ ...p, id: `p${i}` }));
    const html = Products.renderCards(page);

    const skuLines = html.match(/<p class="product-card__sku">SKU [^<]+<\/p>/g) || [];
    assert.deepEqual(skuLines, [
        '<p class="product-card__sku">SKU CBCI3CMY</p>',
        '<p class="product-card__sku">SKU CBCI6CMY</p>',
    ], 'exactly the two indistinguishable cards carry a SKU line — and no others');

    const cards = html.match(/<article class="product-card"/g) || [];
    assert.equal(cards.length, page.length, 'every row still rendered — nothing was hidden');
});

test('§8 the sku line is escaped, not interpolated raw', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...LIVE_PAIR[0], id: 'x', _lookalikeSku: '<img src=x onerror=alert(1)>' });
    assert.ok(!html.includes('<img src=x'), 'a hostile SKU must never reach the DOM as markup');
    assert.match(html, /product-card__sku">SKU &lt;img/);
});
