/**
 * BRAND SOURCE — GENUINE vs COMPATIBLE, ONE VOCABULARY (Aug 2026, ERR-157)
 * ========================================================================
 * The cart printed **GENUINE** on compatible cartridges, in production, for
 * months. This file is the regression that would have caught it, plus the
 * fence that keeps the fix from being undone one surface at a time.
 *
 * WHAT HAPPENED
 * -------------
 * `Cart._isCompatible` read `product_source` first and fell back to a
 * leading-word `/^compatible\b/i` test on the stored NAME. That fallback was
 * written when compatible products were named "Compatible Ink Cartridge for …".
 * The May 2026 catalog rename moved the word out of first position — live rows
 * read "143ABK Compatible Toner Cartridge for HP 143A …" — so the regex
 * answered false for every compatible cartridge in the catalogue.
 *
 * On its own that was survivable, because a locally-added row carried
 * `product_source` from the card's data attribute. What made it visible to
 * customers was the OTHER half: `GET /api/cart` did not project `source` onto
 * the line's product, so `_parseServerCart` wrote `product_source: null`, and
 * the badge was BINARY — `isCompatible ? 'COMPATIBLE' : 'GENUINE'`. So one
 * page reload after filling the cart, every compatible line claimed to be an
 * OEM product. The backend shipped `source` on the cart line on 2026-08-10,
 * which is what makes an honest answer possible at all.
 *
 * THE TWO RULES THIS FILE PINS
 * ----------------------------
 *   1. THE FRONTEND NEVER INFERS BRAND SOURCE FROM A NAME.
 *      Not leading-word, not `.includes`, not `is_genuine ? … : …` on a field
 *      that isn't there. Merchant Center and the OEM-warranty claim rules
 *      (ERR-063, ERR-078) make this a compliance question, not a style one.
 *      Enforced repo-wide below, so a new surface cannot reintroduce it.
 *
 *   2. UNKNOWN IS AN ANSWER, AND IT IS NOT "GENUINE".
 *      `BrandSource.of()` returns null and `badgeHTML()` renders nothing.
 *      The PDP has always done this ("we never assert a status we don't
 *      know"); the cart, checkout, favourites and order-detail did not.
 *
 * Fixtures below are REAL payloads, captured from the live API on 2026-08-12
 * against a guest cart. The compatible line is the one whose name defeats the
 * old regex — it is the whole bug in one object.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS_DIR = path.join(ROOT, 'js');
const JS = (rel) => fs.readFileSync(path.join(JS_DIR, rel), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const { BrandSource, CompatSource } = require(path.join(JS_DIR, 'utils.js'));

const CART_SRC = JS('cart.js');
const CART_CODE = stripComments(CART_SRC);
const UTILS_SRC = JS('utils.js');
const FAVOURITES_CODE = stripComments(JS('favourites.js'));
const CHECKOUT_CODE = stripComments(JS('checkout-page.js'));
const ORDER_DETAIL_CODE = stripComments(JS('order-detail-page.js'));
const SEARCH_CODE = stripComments(JS('search.js'));

// ─────────────────────────────────────────────────────────────────────────────
// LIVE FIXTURES — GET /api/cart, guest session, 2026-08-12
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The line that broke. Note BOTH copies of the brand source, exactly as the
 * backend now sends them, and a name in which "Compatible" is the SECOND word.
 */
const LIVE_COMPATIBLE_LINE = {
    quantity: 3,
    source: 'compatible',                    // line-level sibling
    quantity_breaks: [{ min_quantity: 3, discount_percent: 4, business_price: 11.03 }],
    product: {
        id: '681d3309-b72a-442e-b915-f636efdc331d',
        sku: 'C143ABK',
        name: '143ABK Compatible Toner Cartridge for HP 143A Black Neverstop Reload Kit',
        retail_price: 11.49,
        stock_quantity: 100,
        color: 'Black',
        source: 'compatible',                // the field ask 1 added
        brand: { name: 'HP' },
    },
};

const LIVE_GENUINE_LINE = {
    quantity: 1,
    source: 'genuine',
    quantity_breaks: [{ min_quantity: 3, discount_percent: 4, business_price: 30.0 }],
    product: {
        id: '494a1432-8b0e-4975-8466-702df4bd6d40',
        sku: 'GLC133BK',
        name: 'Brother Genuine LC133BK Ink Cartridge LC133 Black (600 pages)',
        retail_price: 32.0,
        stock_quantity: 50,
        color: 'Black',
        source: 'genuine',
        brand: { name: 'Brother' },
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. The bug itself
// ─────────────────────────────────────────────────────────────────────────────

test('THE BUG — the live compatible name defeats the retired leading-word regex', () => {
    // Not a hypothetical. This is why the old fallback answered "not
    // compatible" and the binary badge then said GENUINE.
    const name = LIVE_COMPATIBLE_LINE.product.name;
    assert.equal(/^compatible\b/i.test(name), false,
        'the retired regex would not have matched this real compatible product');
    assert.ok(/compatible/i.test(name),
        'the word IS in the name — just not leading, which is exactly the trap');
});

test('THE FIX — a live compatible cart line classifies as compatible', () => {
    const parsed = parseOneLine(LIVE_COMPATIBLE_LINE);
    assert.equal(BrandSource.of(parsed), 'compatible');
    assert.equal(BrandSource.label(parsed), 'COMPATIBLE');
    assert.match(BrandSource.badgeHTML(parsed), /source-badge--compatible/);
});

test('THE FIX — a live genuine cart line classifies as genuine', () => {
    const parsed = parseOneLine(LIVE_GENUINE_LINE);
    assert.equal(BrandSource.of(parsed), 'genuine');
    assert.match(BrandSource.badgeHTML(parsed), /source-badge--genuine/);
});

test('a cart line with NO source renders NO badge — never a GENUINE claim', () => {
    // The failure mode in one assertion. Strip `source` from both copies (a
    // backend rollback, or a row restored from pre-August localStorage) and the
    // surface must go quiet rather than assert an OEM product.
    const stripped = JSON.parse(JSON.stringify(LIVE_COMPATIBLE_LINE));
    delete stripped.source;
    delete stripped.product.source;
    const parsed = parseOneLine(stripped);

    assert.equal(BrandSource.of(parsed), null);
    assert.equal(BrandSource.badgeHTML(parsed), '');
    assert.doesNotMatch(BrandSource.badgeHTML(parsed), /GENUINE/,
        'an unprovable row must never be labelled GENUINE — this is the whole bug');
});

test('either copy of source alone is sufficient (the backend sends two)', () => {
    const productOnly = JSON.parse(JSON.stringify(LIVE_COMPATIBLE_LINE));
    delete productOnly.source;
    assert.equal(BrandSource.of(parseOneLine(productOnly)), 'compatible',
        'items[].product.source alone must classify');

    const lineOnly = JSON.parse(JSON.stringify(LIVE_COMPATIBLE_LINE));
    delete lineOnly.product.source;
    assert.equal(BrandSource.of(parseOneLine(lineOnly)), 'compatible',
        'items[].source alone must classify — this is the redundancy the backend offered');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BrandSource semantics
// ─────────────────────────────────────────────────────────────────────────────

test('BrandSource.of — the full precedence table', () => {
    const cases = [
        [{ product_source: 'compatible' }, 'compatible', 'stored row'],
        [{ product_source: 'genuine' }, 'genuine', 'stored row'],
        [{ product: { source: 'compatible' } }, 'compatible', 'nested catalog object'],
        [{ source: 'genuine' }, 'genuine', 'catalog spelling'],
        [{ source: ' Compatible ' }, 'compatible', 'case/whitespace tolerant'],
        [{ is_genuine: true }, 'genuine', '/suggest boolean'],
        [{ is_genuine: false }, 'compatible', '/suggest boolean'],
        [{ source: 'core', product_source: 'compatible' }, 'compatible', 'sentinel does not mask the real field'],
        [null, null, 'null row'],
        [undefined, null, 'undefined row'],
        [{}, null, 'empty row'],
        [{ source: 'core' }, null, 'cart namespace sentinel is not a brand source'],
        [{ source: 'cross-sell' }, null, 'cart namespace sentinel is not a brand source'],
        [{ source: 'remanufactured' }, null, 'an unknown vocabulary value is not a side'],
        [{ is_genuine: undefined }, null, 'undefined is not false'],
        [{ is_genuine: 'yes' }, null, 'a non-boolean is_genuine proves nothing'],
        [{ name: '143ABK Compatible Toner Cartridge for HP 143A' }, null, 'names prove nothing'],
        [{ name: 'Brother Genuine LC133BK' }, null, 'names prove nothing'],
    ];
    for (const [row, expected, why] of cases) {
        assert.equal(BrandSource.of(row), expected, `${why}: ${JSON.stringify(row)}`);
    }
});

test('BrandSource — the two defaults point away from an assertion, in different directions', () => {
    const unknown = { name: 'anything at all' };
    // Badge question: unknown ⇒ say nothing.
    assert.equal(BrandSource.badgeHTML(unknown), '');
    assert.equal(BrandSource.label(unknown), null);
    assert.equal(BrandSource.isKnown(unknown), false);
    // Colour-tile question: unknown ⇒ not compatible ⇒ neutral placeholder,
    // preserving the genuine-no-colour-tile invariant (ERR-143).
    assert.equal(BrandSource.isCompatible(unknown), false);
    assert.equal(BrandSource.isGenuine(unknown), false,
        'unknown must not satisfy EITHER side — that is what makes it unknown');
});

test('BrandSource.badgeHTML emits only closed-set values (nothing to escape)', () => {
    const hostile = {
        product_source: 'compatible',
        name: '<img src=x onerror=alert(1)>',
        source: '"><script>alert(1)</script>',
    };
    const html = BrandSource.badgeHTML(hostile);
    assert.equal(html, '<span class="source-badge source-badge--compatible">COMPATIBLE</span>',
        'the badge must be built from the resolved source, never from caller text');
    assert.doesNotMatch(html, /script|onerror/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The naming trap
// ─────────────────────────────────────────────────────────────────────────────

test('BrandSource and CompatSource are different modules answering different questions', () => {
    // Two modules whose names both say "source" is a trap for the next reader.
    // They live next to each other in utils.js with cross-references; assert
    // both the separation and the signpost.
    assert.ok(BrandSource, 'BrandSource must exist');
    assert.ok(CompatSource, 'CompatSource must exist');
    assert.notEqual(BrandSource, CompatSource);

    // BrandSource answers genuine/compatible; CompatSource answers proven/unproven.
    assert.equal(BrandSource.of({ source: 'genuine' }), 'genuine');
    assert.equal(CompatSource.PROVEN, 'proven');
    assert.equal(BrandSource.of, BrandSource.of);
    assert.equal(typeof CompatSource.productMatchesCode, 'function');
    assert.equal(BrandSource.PROVEN, undefined,
        'BrandSource must not grow a provenance vocabulary — that is CompatSource');

    // The signpost must survive edits.
    assert.match(UTILS_SRC, /NOT THE SAME THING AS `CompatSource`/,
        'BrandSource must warn the reader about the neighbouring module');
    assert.match(UTILS_SRC, /NOT `BrandSource` ABOVE/,
        'CompatSource must warn in the other direction too');
});

test('BrandSource is exported onto window, like its neighbours', () => {
    // Browser modules read these as globals. A `const` that never reaches
    // `window` is invisible to anything checking `window.X` — the trap the
    // search-click beacon hit with `window.Config` (ERR-156).
    assert.match(UTILS_SRC, /window\.BrandSource\s*=\s*BrandSource/,
        'utils.js must export BrandSource onto window');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Repo-wide fence — no name inference may come back
// ─────────────────────────────────────────────────────────────────────────────

test('NO storefront module infers brand source from a product name', () => {
    // The fence. Each pattern below is one that actually shipped:
    //   /^compatible\b/i          cart, favourites, checkout, order-detail
    //   .includes('compatible')   order-detail's badge — also matched a GENUINE
    //                             cartridge named "… compatible with DCP-J1050DW"
    //   is_genuine ? a : b        search + shop, which invented 'compatible'
    //                             for a row carrying neither field
    const FORBIDDEN = [
        [/\^compatible\\b/, 'leading-word name regex'],
        [/\.includes\(\s*['"]compatible['"]\s*\)/, "unanchored .includes('compatible')"],
        [/is_genuine\s*\?\s*['"]genuine['"]\s*:\s*['"]compatible['"]/, 'inventing a source from a missing boolean'],
    ];

    const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
    assert.ok(files.length > 20, 'sanity: the js/ directory should be populated');

    const offences = [];
    for (const file of files) {
        // utils.js is where the vocabulary lives; its comments necessarily
        // quote the retired patterns to explain why they are retired. Its CODE
        // is covered by the unit tests above.
        if (file === 'utils.js') continue;
        const code = stripComments(fs.readFileSync(path.join(JS_DIR, file), 'utf8'));
        for (const [pattern, label] of FORBIDDEN) {
            if (pattern.test(code)) offences.push(`${file}: ${label}`);
        }
    }
    assert.deepEqual(offences, [],
        'brand source must come from the backend `source` field, never from a name (ERR-157)');
});

test('every customer-facing source badge is rendered by BrandSource.badgeHTML', () => {
    // Four line-item surfaces. Before ERR-157 they used four different rules
    // and three of them defaulted to GENUINE.
    for (const [label, code] of [
        ['cart.js', CART_CODE],
        ['checkout-page.js', CHECKOUT_CODE],
        ['favourites.js', FAVOURITES_CODE],
        ['order-detail-page.js', ORDER_DETAIL_CODE],
    ]) {
        assert.match(code, /BrandSource\.badgeHTML\(/,
            `${label} must render its source badge via BrandSource.badgeHTML`);
        // No surface may hand-roll the pill any more.
        assert.doesNotMatch(code, /source-badge--\$\{|source-badge--'\s*\+/,
            `${label} must not build the .source-badge class itself`);
    }
});

test('the badge is genuinely conditional — no surface hard-codes GENUINE as a fallback', () => {
    for (const [label, code] of [
        ['cart.js', CART_CODE],
        ['checkout-page.js', CHECKOUT_CODE],
        ['favourites.js', FAVOURITES_CODE],
        ['order-detail-page.js', ORDER_DETAIL_CODE],
    ]) {
        assert.doesNotMatch(code, /\?\s*['"]COMPATIBLE['"]\s*:\s*['"]GENUINE['"]/,
            `${label} must not fall back to a GENUINE label for an unproven row`);
    }
});

test('the /suggest adapters resolve a real payload identically, and stop inventing one', () => {
    // `shop-page.js` adaptSuggestProduct and `search.js` adaptForCard both wrote
    // `source: p.source || (p.is_genuine ? 'genuine' : 'compatible')`. Executed
    // rather than grepped, because the behaviour that matters is what they
    // RETURN for each payload shape.
    //
    // Load-order note: `shop.html` loads shop-page.js at line 427 and utils.js at
    // 437, so shop-page.js EVALUATES before BrandSource exists. That is safe
    // because the reference lives inside a function body and resolves at CALL
    // time, when the global lexical binding is initialised — but it is exactly
    // the shape of the ERR-156 `window.Config` trap, so it is asserted here
    // rather than reasoned about: the adapter is invoked with BrandSource passed
    // in from outside, which is what the browser does at call time.
    const SHOP_SRC = JS('shop-page.js');
    const SEARCH_SRC = JS('search.js');

    const lift = (src, name) => {
        const m = src.match(new RegExp(`function ${name}\\(p\\) \\{([\\s\\S]*?)\\n {4}\\}`));
        assert.ok(m, `${name} not found`);
        const fn = new Function('p', 'BrandSource', m[1]);
        return (p) => fn(p, BrandSource);
    };
    const adaptShop = lift(SHOP_SRC, 'adaptSuggestProduct');
    const adaptSearch = lift(SEARCH_SRC, 'adaptForCard');

    const cases = [
        // Real /api/search/suggest row: no `source`, `is_genuine` a real boolean.
        [{ sku: 'CLC133BK', price: 7.99, is_genuine: false }, 'compatible'],
        [{ sku: 'GLC133BK', price: 32.0, is_genuine: true }, 'genuine'],
        // Real /api/search/smart row: `source` present.
        [{ sku: 'CLC133BK', retail_price: 7.99, source: 'compatible' }, 'compatible'],
        // The invention case: neither field. Was 'compatible'; must now be null.
        [{ sku: 'X', price: 1 }, null],
    ];
    for (const [row, expected] of cases) {
        assert.equal(adaptShop(row).source, expected,
            `shop adaptSuggestProduct(${JSON.stringify(row)})`);
        assert.equal(adaptSearch(row).source, expected,
            `search adaptForCard(${JSON.stringify(row)})`);
    }

    // And the adapters must agree with each other on every shape — they feed two
    // grids that a shopper compares side by side.
    for (const [row] of cases) {
        assert.equal(adaptShop(row).source, adaptSearch(row).source,
            `the two /suggest adapters disagreed on ${JSON.stringify(row)}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The parser boundary (the other half of ERR-150's lesson)
// ─────────────────────────────────────────────────────────────────────────────

test('_parseServerCart carries BOTH copies of source, and keeps its own namespace', () => {
    const fn = CART_SRC.slice(CART_SRC.indexOf('_parseServerCart: function'));
    const body = fn.slice(0, fn.indexOf('\n    },'));

    assert.match(body, /product_source:\s*item\.product\.source\s*\|\|\s*item\.source\s*\|\|\s*null/,
        'the parser must read product.source, then the line-level sibling');
    assert.match(body, /source:\s*['"]core['"]/,
        "the cart's own `source` slot is a subsystem namespace and must stay pinned");
    // The map is a whitelist — the ERR-150 lesson. Anything unnamed is dropped,
    // so a new upstream field needs THIS boundary edited, not the consumer.
    assert.match(body, /quantity_breaks:\s*Array\.isArray\(item\.quantity_breaks\)/,
        'the per-line ladder must still survive the whitelist (ERR-150)');
});

test('a parsed line is classifiable — the boundary and the vocabulary agree', () => {
    // The integration the bug lived in: the parser produced a row and the
    // classifier read it. Each was defensible alone.
    for (const [line, expected] of [
        [LIVE_COMPATIBLE_LINE, 'compatible'],
        [LIVE_GENUINE_LINE, 'genuine'],
    ]) {
        const parsed = parseOneLine(line);
        assert.equal(BrandSource.of(parsed), expected);
        assert.equal(parsed.source, 'core', 'the namespace sentinel survives');
        assert.ok(Array.isArray(parsed.quantity_breaks), 'the ladder survives');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ERR-160 — the ladder reaches the search dropdown
// ─────────────────────────────────────────────────────────────────────────────

test('ERR-160 — the search dropdown hands its rows to the volume-pricing decorator', () => {
    // Every other product surface pairs its paint with this call. search.js had
    // no `Business.` reference at all, so a shopper saw "Bulk price" on /shop
    // and nothing in the dropdown for the same SKU.
    assert.match(SEARCH_CODE, /Products\.decorateBusinessPricing\(/,
        'the dropdown must decorate its cards with the public volume ladder');
    // It must hand over the RAW rows. Passing an adapted copy to an ingester is
    // precisely how ERR-150 happened.
    assert.match(SEARCH_CODE, /decorateBusinessPricing\(\s*state\.list\s*,\s*renderedOrder\s*\)/,
        'the dropdown must pass the raw /smart rows, not the adaptForCard copies');
});

test('ERR-160 — decorateBusinessPricing runs AFTER the cards are in the DOM', () => {
    // It queries `.product-card[data-sku]` out of the container, so calling it
    // before the innerHTML assignment would silently decorate nothing.
    const paintIdx = SEARCH_CODE.indexOf('state.list.innerHTML =');
    const decorateIdx = SEARCH_CODE.indexOf('Products.decorateBusinessPricing(');
    assert.ok(paintIdx !== -1 && decorateIdx !== -1);
    assert.ok(paintIdx < decorateIdx,
        'the decorator reads rendered cards out of the DOM — it must run after the paint');
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — run the shipped parser's item map over one server line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes cart.js's REAL item-mapping expression against a server line.
 *
 * Lifted from source rather than reimplemented: a hand-copied parser in a test
 * certifies a boundary that does not exist, and the boundary is where this bug
 * lived. Only the map is lifted (not the whole method), because the rest of
 * _parseServerCart touches `self`, toasts and DebugLog.
 */
function parseOneLine(item) {
    const fn = CART_SRC.slice(CART_SRC.indexOf('_parseServerCart: function'));
    const mapStart = fn.indexOf('const parsed = {');
    const mapEnd = fn.indexOf('};', mapStart);
    assert.ok(mapStart !== -1 && mapEnd !== -1, 'could not lift the item map from _parseServerCart');
    const mapSrc = fn.slice(mapStart, mapEnd + 2);

    const sandbox = {
        item,
        storageUrl: (u) => u || '',
        __result: null,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${mapSrc}\n__result = parsed;`, sandbox);
    return sandbox.__result;
}
