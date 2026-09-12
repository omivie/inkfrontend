/**
 * ERR-236 — the ad landing pages sold nothing
 * ===========================================
 *
 * /ink-cartridges, /toner-cartridges and /ribbons are where Google Ads lands.
 * `buy ink cartridges` alone is 53% of spend. Measured on production
 * 2026-09-09, all three rendered a brand chooser and NOT ONE PRICE:
 *
 *     h1     "Shop Ink Cartridges & Toner NZ"
 *     h2     "Choose a brand to see ink cartridges"
 *     prices 0
 *
 * The backend half had been live and correct the whole time —
 * /api/products/popular answers 200 with real rows on every category. Nothing
 * on the frontend was asking it.
 *
 * Two structural facts this suite pins, because both are easy to get wrong:
 *
 *   1. /ribbons IS A DIFFERENT PAGE. vercel.json rewrites /ink-cartridges and
 *      /toner-cartridges onto html/shop.html, but /ribbons onto html/ribbons.html
 *      — a separate controller with its own card renderer. A row added to one
 *      is NOT inherited by the other, so §5 asserts the pair stays in step.
 *
 *   2. The endpoint's category vocabulary is not ours. Measured 2026-09-09:
 *      ink, toner, ribbons, drums and paper answer 200; our own internal ids
 *      `consumable` and `label_tape` are a hard 400.
 *
 * Source text cannot prove a card is on screen or the right width —
 * `npm run probe:landing-popular` measures that in a browser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const API_JS = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const SHOP_JS = fs.readFileSync(path.join(ROOT, 'js', 'shop-page.js'), 'utf8');
const RIBBONS_JS = fs.readFileSync(path.join(ROOT, 'js', 'ribbons-page.js'), 'utf8');
const SHOP_HTML = fs.readFileSync(path.join(ROOT, 'html', 'shop.html'), 'utf8');
const RIBBONS_HTML = fs.readFileSync(path.join(ROOT, 'html', 'ribbons.html'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SHOP_CODE = stripComments(SHOP_JS);
const RIBBONS_CODE = stripComments(RIBBONS_JS);

function fnBody(src, signature) {
    const start = src.indexOf(signature);
    assert.notEqual(start, -1, `not found: ${signature}`);
    // Start from the signature's OWN trailing brace. Scanning for the first
    // `{` after `start` finds the `{}` of a destructured default instead —
    // `getPopularProducts(params = {})` then "closes" immediately and the body
    // is empty, so every assertion about it fails for the wrong reason (or, far
    // worse, a doesNotMatch passes vacuously).
    const i = start + signature.length - 1;
    assert.equal(src[i], '{', `fnBody signature must end at its opening brace: ${signature}`);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced braces after ${signature}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the API helper
// ─────────────────────────────────────────────────────────────────────────────

test('§1 getPopularProducts goes through catalogEndpoint and getWithSWR', () => {
    const fn = fnBody(API_JS, 'async getPopularProducts(params = {}) {');
    assert.match(fn, /this\.catalogEndpoint\('\/api\/products\/popular', params\)/,
        'the response IS edge-cached (measured 2026-09-09: s-maxage=300), so the URL is part of '
        + 'the cache key and two spellings of one question are two entries — catalogEndpoint '
        + 'fixes the param order (ERR-124/159)');
    assert.match(fn, /getWithSWR\(/, 'and it shares the in-memory SWR cache like every catalog read');
    assert.match(fn, /anonymous: true/,
        'identity must stay off an entry that is shared with every other visitor');
    assert.doesNotMatch(fn, /\?category=|`\/api\/products\/popular\?/,
        'no hand-rolled query string — that is how four spellings of one query became four '
        + 'cache entries before ERR-124');
});

test('§1 the params it uses are canonical ones', () => {
    const order = API_JS.match(/CATALOG_PARAM_ORDER:\s*\[([^\]]+)\]/)[1];
    for (const key of ['category', 'limit']) {
        assert.match(order, new RegExp(`'${key}'`),
            `${key} must be in CATALOG_PARAM_ORDER or it sorts into the alphabetical extras `
            + 'tail and forks the cache key');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the markup, on BOTH pages
// ─────────────────────────────────────────────────────────────────────────────

test('§2 /ribbons really is a different file — the reason this row is added twice', () => {
    const rewrites = VERCEL.rewrites || [];
    const dest = (src) => (rewrites.find((r) => r.source === src) || {}).destination;
    assert.equal(dest('/ink-cartridges'), '/html/shop');
    assert.equal(dest('/toner-cartridges'), '/html/shop');
    assert.equal(dest('/ribbons'), '/html/ribbons',
        'if this ever becomes /html/shop, the duplicate row in ribbons-page.js should go — '
        + 'until then, a row added to shop.html does NOT appear on /ribbons');
});

for (const [label, html] of [['shop.html', SHOP_HTML], ['ribbons.html', RIBBONS_HTML]]) {
    test(`§2 ${label} carries the shelf, hidden, above the brand picker`, () => {
        assert.match(html, /<section class="shop-section-card" id="popular-row" hidden>/,
            'it starts hidden — an empty shelf over a working catalogue is worse than no shelf '
            + '(ERR-193 printed empty-shelf copy on 63 pages for 44 hours)');
        assert.match(html, /id="popular-row-grid"/, 'and it has a grid to render into');

        const levelStart = html.indexOf('id="level-brands"');
        const rowAt = html.indexOf('id="popular-row"');
        const brandCardAt = html.indexOf('shop-section-card__header', levelStart);
        assert.ok(levelStart !== -1 && rowAt > levelStart,
            'the shelf must live INSIDE #level-brands — that is the level a category landing '
            + 'renders; #level-products is hidden on this path');
        assert.ok(rowAt < brandCardAt + 200,
            'and above the brand picker, which is where the ad click is looking');
    });

    test(`§2 ${label} reuses the shared card grid rather than inventing one`, () => {
        assert.match(html, /class="popular-row__grid product-grid"/,
            '.product-grid is the same pairing the PDP related and bought-together rows use, so '
            + 'the row needs no CSS of its own and the 185px card cap and the 200px container '
            + 'query resolve exactly as they do everywhere else');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — the category vocabulary
// ─────────────────────────────────────────────────────────────────────────────

test('§3 the FE→API category map is the measured one, in exactly one place', () => {
    const map = SHOP_JS.match(/POPULAR_CATEGORY_API:\s*\{([^}]+)\}/);
    assert.ok(map, 'the map must exist');
    const body = map[1];

    assert.match(body, /ink:\s*'ink'/);
    assert.match(body, /toner:\s*'toner'/);

    // `consumable: 'drums'` — AND THE REASON CHANGED WITHOUT THE LINE CHANGING.
    //
    // Until 2026-09-10 this mapping existed because `?category=consumable` was
    // a hard 400 and the backend calls that family `drums`. The 400 is gone —
    // and the mapping is MORE load-bearing than it was, not less. Measured
    // 2026-09-12 by reading product_type on the rows that come back:
    //
    //   ?category=consumable → ink_cartridge 4, typewriter_ribbon 3,
    //                          printer_ribbon 2, toner_cartridge 2,
    //                          correction_tape 1   (a retired alias: NO FILTER)
    //   ?category=drums      → drum_unit 6, waste_toner 3, fuser_kit 1,
    //                          maintenance_box 1, fax_film_refill 1
    //
    // So removing this line now puts ink and toner on a drums shelf, with a
    // 200 and no error anywhere. One of the two backend documents covering
    // this change explicitly invites that removal ("you can drop your
    // client-side mapping whenever suits"); the other, written later, retracts
    // it. ***THE STATUS CODE CAN NO LONGER TELL YOU YOU ARE WRONG — only
    // reading product_type on the rows can, which is why probe:landing-popular
    // does exactly that.***
    assert.match(body, /consumable:\s*'drums'/,
        'MEASURED 2026-09-12: `consumable` is ACCEPTED now and resolves to NO FILTER, not to '
        + 'drums. Passing it through silently returns ink and toner on the drums landing');
    assert.doesNotMatch(body, /cartridge:/,
        '`cartridge` is the same retired no-filter alias as `consumable` and must never be '
        + 'added as a passthrough');

    // label_tape: 200 as of 2026-09-10, having been a hard 400. The backend
    // reports 244 active in-stock label tapes were behind it, the largest
    // category the outage covered. `label` is the spelling categories[].
    // apiCategory already uses — one vocabulary, not a seventh.
    assert.match(body, /label_tape:\s*'label'/,
        'label_tape now 200s and must be asked for; `label` is the canonical spelling this '
        + 'repo already uses for it in ShopPage.categories');
    assert.match(body, /paper:\s*'paper'/);

    // Exactly one map: a second copy is how the six type vocabularies happened.
    assert.equal((SHOP_JS.match(/POPULAR_CATEGORY_API/g) || []).length, 2,
        'declared once, read once — any third mention is a second copy');
});

test('§3 every key in the map is a category this repo actually has', () => {
    // The map translates OUR ids to THEIRS. A key that is not one of our ids
    // is a request that can never fire; a key that IS one but is missing is a
    // landing with no shelf. Both are silent, so both are pinned here against
    // the canonical list rather than against a second hand-kept copy.
    const map = SHOP_JS.match(/POPULAR_CATEGORY_API:\s*\{([^}]+)\}/)[1];
    const keys = [...map.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    const ours = [...SHOP_JS.match(/categories:\s*\[([\s\S]*?)\],/)[1]
        .matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(ours.length >= 6, `sanity: expected the category list, found ${ours.join(',')}`);
    const strays = keys.filter((k) => !ours.includes(k));
    assert.deepEqual(strays, [], 'every mapped key must be a real ShopPage category id');

    // `ribbons` is absent ON PURPOSE: /ribbons is a different page with its own
    // controller, which hardcodes its one category. Asserted so the absence
    // reads as a decision rather than an oversight.
    assert.ok(!keys.includes('ribbons'),
        'ribbons is served by ribbons-page.js, which does not consult this map');
});

test('§3 an unmapped category is reported, not silently blank', () => {
    const fn = fnBody(SHOP_JS, 'async renderPopularRow(category, label) {');
    assert.match(fn, /DebugLog\.warn\(/,
        'a category with no mapping must say so by name — a skip is not a pass');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — only on a category landing
// ─────────────────────────────────────────────────────────────────────────────

test('§4 renderBrands fills the shelf on a category landing and clears it otherwise', () => {
    const fn = fnBody(SHOP_JS, 'renderBrands(brands) {');
    assert.match(fn, /this\.renderPopularRow\(this\.state\.category, label\)/,
        'the categoryPicker branch is the landing-page path');
    assert.match(fn, /this\.renderPopularRow\(null\)/,
        'bare /shop knows no category — inventing one to have something to show would be a '
        + 'guess printed as a recommendation');
});

test('§4 the brand heading still names the brand card, not whatever is first', () => {
    // The trap this row created: renderBrands used
    //   levelBrands.querySelector('.shop-section-card__title')
    // which was the brand card's h2 only because nothing had ever sat above it.
    // The shelf now does, and the unscoped query would have relabelled IT.
    const fn = fnBody(SHOP_JS, 'renderBrands(brands) {');
    assert.doesNotMatch(fn, /levelBrands\?\.querySelector\('\.shop-section-card__title'\)/,
        'a positional selector quietly means something else the moment anything moves');
    assert.match(fn, /grid\.closest\('\.shop-section-card'\)\?\.querySelector\('\.shop-section-card__title'\)/,
        'scope the title lookup to the card that HOLDS THE BRAND GRID');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — the two renderers stay in step, and both bind everything
// ─────────────────────────────────────────────────────────────────────────────

for (const [label, src, sig] of [
    ['shop-page.js', SHOP_JS, 'async renderPopularRow(category, label) {'],
    ['ribbons-page.js', RIBBONS_JS, 'async renderPopularRow() {'],
]) {
    test(`§5 ${label} binds ALL THREE card hooks`, () => {
        const fn = fnBody(src, sig);
        // The zero-results rail calls attachCardListeners only; its cards
        // silently lose image retry and the bulk-price overlay. Not copied here.
        assert.match(fn, /Products\.renderCards\(rows\)/,
            'renderCards already handles sorting, lookalike marking and row-breaks');
        assert.match(fn, /Products\.bindImageFallbacks\(grid\)/,
            'without this a broken image stays broken instead of retrying its raw src');
        assert.match(fn, /Products\.attachCardListeners\(grid\)/, 'add-to-cart and the qty stepper');
        assert.match(fn, /Products\.decorateBusinessPricing\(grid, rows\)/,
            'the bulk-price overlay finds cards by data-sku AFTER they are painted');
    });

    test(`§5 ${label} hides on failure and says so loudly`, () => {
        const fn = fnBody(src, sig);
        assert.match(fn, /DebugLog\.error\(/,
            'a failed read is LOUD in the log — ERR-193 was silent for 44 hours');
        assert.match(fn, /section\.hidden = true/,
            'and INVISIBLE on the page: never empty-shelf copy over a working catalogue');
        assert.match(fn, /token !== this\._popularRowToken/,
            'a shopper who navigates on mid-flight must not get this painted over the level '
            + 'they actually landed on');
    });
}

test('§5 the ribbons row is enrolled at the single choke point, not per call site', () => {
    const fn = fnBody(RIBBONS_JS, 'showLevel(which) {');
    assert.match(fn, /this\.renderPopularRow\(\);/,
        'showLevel is the one place this page decides it is in the landing state, so every path '
        + 'in (init, popstate, pageshow, back-to-brands) gets the shelf — "every surface calls X" '
        + 'is a list nobody maintains (ERR-150/160)');
    // And it must be in the brands branch, not the products one.
    const brandsBranch = fn.slice(fn.indexOf("if (which === 'brands')"), fn.indexOf('} else {'));
    assert.match(brandsBranch, /renderPopularRow/,
        'the shelf belongs to the brand-picker state only');
});

test('§5 neither page hardcodes a product, a price or a SKU', () => {
    for (const [label, src, sig] of [
        ['shop-page.js', SHOP_JS, 'async renderPopularRow(category, label) {'],
        ['ribbons-page.js', RIBBONS_JS, 'async renderPopularRow() {'],
    ]) {
        const fn = fnBody(src, sig);
        assert.doesNotMatch(fn, /\$\d|retail_price\s*[*+-]/,
            `${label}: the row prints what the backend returned and computes nothing`);
    }
});
