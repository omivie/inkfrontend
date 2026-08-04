/**
 * Ribbon "FOR USE IN" search went ADDITIVE — FE reconciliation + parity — Jul 2026
 * ================================================================================
 *
 * The backend change
 * ------------------
 * Backend commit `1d43034` (2026-07-30) made a product's admin-authored
 * `compatible_devices_html` ("FOR USE IN") blob searchable on EVERY
 * printer/model-shaped query, and made those matches **additive** — they now
 * appear ALONGSIDE any cartridges/toners that also match, instead of being
 * suppressed whenever those existed. The handoff
 * (`ribbon-for-use-in-search-FE-handoff-jul2026.md`) stated "No FE changes
 * required" and asked us to confirm the compat rows survive the results-page
 * reconciliation (its §5a).
 *
 * They did not. Two independent paths were deleting them (ERR-133).
 *
 * Defect 1 — `?exact=1` discarded every compat row
 * ------------------------------------------------
 * `shouldUseFallback = exactMode ? true : …` then `products = mergedUsed`. The
 * literal union (/api/products?search= ∪ /api/search/suggest) matches on
 * name/SKU only, so it can NEVER contain a "for use in" match — assigning it
 * raw throws the ribbons away. Measured live 2026-07-30:
 *
 *   /search?q=VP6000&exact=1  → ZERO-RESULTS SCREEN, over three good ribbons
 *   /search?q=AP830&exact=1   → 307.11 only; C141LOT + C143LOT dropped
 *   /search?q=CE60&exact=1    → 154.11 only; C143LOT dropped
 *
 * `?exact=1` is the target of the correction banner's "Search instead for X"
 * link, so this was reachable by clicking. It is ERR-083 reintroduced through
 * the exact-mode door added later by the search-UX work.
 *
 * Defect 2 — one compat row vetoed the literal repair for the DIRECT rows
 * ----------------------------------------------------------------------
 * `hasCompatMatch` was "any row is compat", and it was a term of both softMiss
 * and hijack. That was sound while compat sets were mutually exclusive with
 * direct hits — "any compat row" then implied "every row is compat". Once the
 * backend made them additive, a single ribbon riding along switched off the
 * digit-noise repair for the real cartridges beside it, and `smartCount`
 * inflated the bar the literal set had to clear with rows that set structurally
 * cannot supply. Measured live 2026-07-30:
 *
 *   q=CE50  /smart  → CCART319BK, GCE506A, C05XBK  +  154.11*, C143LOT*
 *           literal → GCE506A, C05XBK, CCART319BK, G05ABK, G05XBK
 *           veto killed softMiss ⇒ G05ABK and G05XBK were never shown.
 *
 * Defect 3 — the dropdown showed compat ribbons with no explanation
 * ----------------------------------------------------------------
 * `search.js` hits /api/search/smart too, so the dropdown receives compat rows,
 * but it renders through `Products.renderCard` which had no compat branch — and
 * `search.css` blanket-hid every `.product-card__badge` inside `.smart-ac__grid`
 * anyway. Typing AP830 surfaced two correction tapes with nothing saying why.
 * ERR-125 is the precedent: the two card renderers are duplicated, not shared.
 *
 * Defect 4 — the backend buries a direct hit under compat rows
 * ------------------------------------------------------------
 * The handoff claims compat rows "append at the bottom" and "never displace or
 * bury direct results". They do. Measured live 2026-07-30, q=AP1000:
 *   G45BK (tier 2, 131.93) → 155.11* → 156.11* → C143LOT* (all tier 3, 25)
 *   → G45BK-2PK (tier 2, 131.93)
 * The pack variant of the top hit lands BELOW three score-25 ribbons. Reported
 * to the backend in `ribbon-compat-search-FE-response-jul2026.md`.
 *
 * What this file pins
 * -------------------
 *  §1 partitionCompatRows — the primitive: split by provenance, stably.
 *  §2 productIdentityKeys / rowsNotAlreadyIn — ONE dedup vocabulary.
 *  §3 the reconciliation wiring: veto retired, directCount used, compat rows
 *     preserved across the swap, exactMode covered.
 *  §4 end-to-end against live-verified fixtures: CE50 swaps AND keeps both
 *     ribbons; VP6000 exact-mode is not empty; lc233 is untouched.
 *  §5 provenance ordering — direct hits first, "also fits" rows after.
 *  §6 dropdown/results badge parity + the scoped CSS exception.
 *
 * Run: node --test tests/ribbon-compat-search-additive-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (f) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', f), 'utf8');
const CSS = (f) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'css', f), 'utf8');

const SHOP_SRC = JS('shop-page.js');
const UTILS_SRC = JS('utils.js');
const PRODUCTS_SRC = JS('products.js');
const SEARCH_CSS = CSS('search.css');

// Strip comments so a literal inside a comment can't satisfy a source assertion.
// NOTE (ERR-124): never put a slash-star sequence inside a fixture string in
// this file — it opens a fake block comment here and silently voids every
// source assertion below it.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const SHOP_CODE = stripComments(SHOP_SRC);
const PRODUCTS_CODE = stripComments(PRODUCTS_SRC);

// Return the balanced `{ … }` body of the first block at/after `anchor`.
// ERR-124's lesson: a fixed-width `slice(idx, idx + N)` window goes vacuous the
// moment the code inside grows, so bound the read by real brace structure.
function blockBodyAt(src, anchor) {
    const at = src.indexOf(anchor);
    if (at === -1) return null;
    // Search PAST the anchor: a method signature anchor can itself contain a
    // brace (`_options = {}`), and starting at `at` would walk that empty
    // default-parameter object instead of the function body.
    const open = src.indexOf('{', at + anchor.length);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure reconciliation helpers out of shop-page.js. utils.js loads
// FIRST because queryCodeMatch now delegates to window.CompatSource (utils.js)
// for its code-token vocabulary — without it the helper answers false for
// everything and any test that leans on it silently proves nothing.
// ─────────────────────────────────────────────────────────────────────────────
function loadShopHelpers() {
    const doc = {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
        body: { appendChild() {} },
        documentElement: { style: {} },
        cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat, isNaN,
        setTimeout, clearTimeout,
        document: doc,
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node' },
        DebugLog: { log() {}, warn() {}, error() {} },
        Config: { API_URL: 'https://backend.test', settings: {}, getSetting(k, f) { return f; } },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(UTILS_SRC, ctx, { filename: 'utils.js' });
    assert.ok(sandbox.window.CompatSource,
        'utils.js must expose window.CompatSource — queryCodeMatch delegates to it');
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    const helpers = sandbox.window._searchParityHelpers;
    assert.ok(helpers, 'shop-page.js must expose window._searchParityHelpers');
    return helpers;
}

const SECURITY_STUB = {
    escapeHtml: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
};
SECURITY_STUB.escapeAttr = SECURITY_STUB.escapeHtml;

function loadProducts() {
    const sandbox = {
        console, URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number,
        Boolean, Symbol, RegExp, parseInt, parseFloat,
        Security: SECURITY_STUB,
        ProductColors: {
            getStyle: () => null, getProductStyle: () => null,
            detectFromName: () => null, isPlaceholderSwatchImage: () => false,
        },
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
    vm.runInContext(PRODUCTS_SRC, ctx, { filename: 'products.js' });
    return sandbox.Products;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-verified fixtures — curl'd against ink-backend-zaeq.onrender.com on
// 2026-07-30, trimmed to the fields the reconciliation reads.
// ─────────────────────────────────────────────────────────────────────────────

// q=CE50 — the overlap case. 3 direct + 2 compat, and the literal set holds two
// HP toners /smart missed entirely (G05ABK, G05XBK).
const CE50_SMART = [
    { id: '12a784a8', sku: 'CCART319BK', name: '05ABK Compatible Toner Cartridge for HP 05A (CE505A) Canon CART319 Black', series_codes: ['05', 'CART319'], source: 'compatible', match_tier: 2, relevance_score: 30 },
    { id: '17fd7ee2', sku: 'GCE506A', name: 'HP Genuine 220V LaserJet Fuser Kit 220V', series_codes: ['220V'], source: 'genuine', match_tier: 2, relevance_score: 30 },
    { id: '7a8b3494', sku: 'C05XBK', name: '05XBK Compatible Toner Cartridge for HP 05X (CE505X) Canon CART319HY Black', series_codes: ['05', 'CART319'], source: 'compatible', match_tier: 2, relevance_score: 30 },
    { id: 'bb959f8d', sku: '154.11', name: 'Brother  7020 Compatible Typewriter Ribbon 154.11', series_codes: [], source: 'compatible', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'CE50' },
    { id: '36224f3d', sku: 'C143LOT', name: 'Olympia Compatible 143LOT Correction Ribbon Tape', series_codes: ['143LOT'], source: 'compatible', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'CE50' },
];
const CE50_PRODUCTS = [
    { id: '17fd7ee2', sku: 'GCE506A', name: 'HP Genuine 220V LaserJet Fuser Kit 220V', series_codes: ['220V'], source: 'genuine' },
    { id: '1ad07620', sku: 'G05ABK', name: 'HP Genuine 05ABK Toner Cartridge 05A Black (2,300 pages)', series_codes: ['05'], source: 'genuine' },
    { id: 'fee120fc', sku: 'G05XBK', name: 'HP Genuine 05XBK Toner Cartridge 05X Black (6,500 pages)', series_codes: ['05'], source: 'genuine' },
    { id: '12a784a8', sku: 'CCART319BK', name: '05ABK Compatible Toner Cartridge for HP 05A (CE505A) Canon CART319 Black', series_codes: ['05', 'CART319'], source: 'compatible' },
    { id: '7a8b3494', sku: 'C05XBK', name: '05XBK Compatible Toner Cartridge for HP 05X (CE505X) Canon CART319HY Black', series_codes: ['05', 'CART319'], source: 'compatible' },
];
const CE50_SUGGEST = [
    { id: '17fd7ee2', sku: 'GCE506A', name: 'HP Genuine 220V LaserJet Fuser Kit 220V', price: 543.79, is_genuine: true },
    { id: '7a8b3494', sku: 'C05XBK', name: '05XBK Compatible Toner Cartridge for HP 05X (CE505X) Canon CART319HY Black', price: 47.49, is_genuine: false },
    { id: '12a784a8', sku: 'CCART319BK', name: '05ABK Compatible Toner Cartridge for HP 05A (CE505A) Canon CART319 Black', price: 35.49, is_genuine: false },
];

// q=VP6000 — every row is a compat row, and the literal set is EMPTY. The
// exact-mode zero-results screen came from here.
const VP6000_SMART = [
    { id: 'eebf2228', sku: '307.11', name: 'Canon  AP800 Compatible Typewriter Ribbon 307.11', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'VP6000' },
    { id: '20e3c4a5', sku: 'C141LOT', name: 'IBM Compatible 141LOT Correction Ribbon Tape', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'VP6000' },
    { id: '36224f3d', sku: 'C143LOT', name: 'Olympia Compatible 143LOT Correction Ribbon Tape', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'VP6000' },
];

// q=AP1000 — Defect 4. A tier-2 score-131.93 row sits BELOW three tier-3
// score-25 compat rows in the backend's own ordering.
const AP1000_SMART = [
    { id: 'e91d6690', sku: 'G45BK', name: 'HP Genuine 45BK Ink Cartridge 45 Black (833 pages)', match_tier: 2, relevance_score: 131.925622224808 },
    { id: '544d2591', sku: '155.11', name: 'Canon AP QS S Series Compatible Typewriter Ribbon 155.11', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'AP1000' },
    { id: '91c8739f', sku: '156.11', name: 'Canon AP01 Compatible Typewriter Ribbon 156.11', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'AP1000' },
    { id: '36224f3d', sku: 'C143LOT', name: 'Olympia Compatible 143LOT Correction Ribbon Tape', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'AP1000' },
    { id: '9f0ce48c', sku: 'G45BK-2PK', name: 'HP Genuine 45BK Ink Cartridge 45 Black 2-Pack (833 pages)', match_tier: 2, relevance_score: 131.925622224808 },
];

// q=lc233 — the negative control. 13 inks, ZERO compat rows. Nothing in this
// change may alter it.
const LC233_SMART = [
    { id: 'l1', sku: 'GLC233BK', name: 'Brother Genuine LC233BK Ink Cartridge LC233 Black', match_tier: 2, relevance_score: 200 },
    { id: 'l2', sku: 'GLC233C', name: 'Brother Genuine LC233C Ink Cartridge LC233 Cyan', match_tier: 2, relevance_score: 200 },
    { id: 'l3', sku: 'CLC233BK', name: 'LC233BK Compatible Ink Cartridge for Brother LC233 Black', match_tier: 2, relevance_score: 180 },
];

// Array.from, not .map: arrays built by array literals INSIDE the vm context
// carry that realm's Array.prototype, and assert/strict's deepEqual compares
// prototypes — so `.map` on a returned row list yields a sandbox array that
// fails deepEqual against a test-realm literal despite identical contents.
// Array.from is invoked on this realm's Array, so the result is always local.
const skus = (rows) => Array.from(rows, (p) => p.sku);

// Mirrors the predicate arithmetic in loadSearchResults so §4 can exercise the
// real helpers end to end. The arithmetic itself is pinned against source in §3
// — this is the composition, not a second source of truth.
function reconcile(helpers, { query, smart, products, suggest, exactMode = false, corrected = false, matchedPrinter = null, didYouMean = null }) {
    const { partitionCompatRows, mergeLiteralResults, queryCodeMatch, productMatchesQuery, rowsNotAlreadyIn } = helpers;
    const { direct, compat } = partitionCompatRows(smart);
    const directCount = direct.length;
    const smartCount = smart.length;
    const queryHasDigits = /\d/.test(String(query || ''));
    const smartHasLiteralMatch = smart.some((p) => productMatchesQuery(p, query));
    const hardMiss = smart.length === 0 && !matchedPrinter;
    const softMiss = queryHasDigits && smartCount > 0 && directCount < 50 && !matchedPrinter && !didYouMean;
    const hijack = corrected && smartCount > 0 && !smartHasLiteralMatch && !matchedPrinter;

    let out = smart;
    let swapped = false;
    if (hardMiss || softMiss || hijack || exactMode) {
        const merged = mergeLiteralResults(suggest || [], products || []);
        let mergedUsed = merged;
        if (queryHasDigits) {
            const onTopic = merged.filter((p) => queryCodeMatch(p, query));
            if (onTopic.length > 0 && onTopic.length < merged.length) mergedUsed = onTopic;
        }
        const shouldUseFallback = exactMode
            ? true
            : (hijack || hardMiss) ? mergedUsed.length > 0 : mergedUsed.length > directCount;
        if (shouldUseFallback) {
            out = mergedUsed.concat(rowsNotAlreadyIn(compat, mergedUsed));
            swapped = true;
        }
    }
    const ordered = partitionCompatRows(out);
    return { rows: ordered.direct.concat(ordered.compat), swapped, softMiss, hijack, hardMiss, directCount };
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 partitionCompatRows — the primitive
// ═════════════════════════════════════════════════════════════════════════════
test('§1 partitionCompatRows splits a mixed set on match_reason', () => {
    const { partitionCompatRows } = loadShopHelpers();
    const { direct, compat } = partitionCompatRows(CE50_SMART);
    assert.deepEqual(skus(direct), ['CCART319BK', 'GCE506A', 'C05XBK'],
        'direct rows are the name/SKU/tsvector hits, in backend order');
    assert.deepEqual(skus(compat), ['154.11', 'C143LOT'],
        'compat rows are the "for use in" matches, in backend order');
});

test('§1 partitionCompatRows is STABLE — backend order survives inside each group', () => {
    const { partitionCompatRows } = loadShopHelpers();
    // AP1000 interleaves direct/compat/direct, which is exactly the ordering
    // bug; the partition must not reshuffle within a group while fixing it.
    const { direct, compat } = partitionCompatRows(AP1000_SMART);
    assert.deepEqual(skus(direct), ['G45BK', 'G45BK-2PK']);
    assert.deepEqual(skus(compat), ['155.11', '156.11', 'C143LOT']);
});

test('§1 partitionCompatRows never compares relevance_score (it is not a re-rank)', () => {
    const { partitionCompatRows } = loadShopHelpers();
    // A compat row with an absurdly HIGH score still sorts after a direct row
    // with a low one — provenance is the only axis.
    const rows = [
        { sku: 'DIRECT', relevance_score: 1 },
        { sku: 'COMPAT', relevance_score: 9999, match_reason: 'compatibility', matched_token: 'X' },
    ];
    const { direct, compat } = partitionCompatRows(rows);
    assert.deepEqual(skus(direct), ['DIRECT']);
    assert.deepEqual(skus(compat), ['COMPAT']);
});

test('§1 partitionCompatRows keys strictly on match_reason, not product.source', () => {
    const { partitionCompatRows } = loadShopHelpers();
    // Almost every ribbon has source:"compatible". That is the PRODUCT being an
    // aftermarket part; it says nothing about WHY the row matched. Confusing the
    // two would classify most of the catalogue as a compat match.
    const { direct, compat } = partitionCompatRows([{ sku: 'X', source: 'compatible' }]);
    assert.deepEqual(skus(direct), ['X']);
    assert.equal(compat.length, 0);
});

test('§1 partitionCompatRows is safe on null / empty / malformed input', () => {
    const { partitionCompatRows } = loadShopHelpers();
    for (const bad of [null, undefined, 'not an array', 42, {}]) {
        const r = partitionCompatRows(bad);
        assert.ok(Array.isArray(r.direct) && r.direct.length === 0,
            'direct must be an empty array, never undefined — callers read .length');
        assert.ok(Array.isArray(r.compat) && r.compat.length === 0,
            'compat must be an empty array, never undefined');
    }
    const holes = partitionCompatRows([null, undefined, { sku: 'A' }]);
    assert.deepEqual(skus(holes.direct), ['A'], 'null holes are dropped, not counted as direct');
});

test('§1 partitionCompatRows is pure — it does not mutate or alias its input', () => {
    const { partitionCompatRows } = loadShopHelpers();
    const input = CE50_SMART.slice();
    const before = JSON.stringify(input);
    const { direct, compat } = partitionCompatRows(input);
    assert.equal(JSON.stringify(input), before, 'input array must be untouched');
    assert.equal(input.length, 5, 'input length must be unchanged');
    // The groups are new arrays, but hold the SAME row objects by reference —
    // _fitsPrinter / _suggestedChip tagging downstream relies on that.
    assert.notEqual(direct, input);
    assert.equal(direct[0], input[0], 'rows are shared by reference, not cloned');
    assert.equal(compat[0], input[3]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 productIdentityKeys / rowsNotAlreadyIn — ONE dedup vocabulary
// ═════════════════════════════════════════════════════════════════════════════
test('§2 productIdentityKeys emits id, upper-cased sku and normalized name', () => {
    const { productIdentityKeys } = loadShopHelpers();
    const keys = productIdentityKeys({ id: 'abc', sku: 'g05abk', name: 'HP Genuine 05ABK' });
    assert.ok(keys.includes('id:abc'), 'id key');
    assert.ok(keys.includes('sku:G05ABK'), 'sku key must be case-folded UP');
    assert.ok(keys.some((k) => k.startsWith('name:')), 'name key');
});

test('§2 productIdentityKeys is safe on null and on rows missing every field', () => {
    const { productIdentityKeys } = loadShopHelpers();
    assert.equal(productIdentityKeys(null).length, 0);
    assert.equal(productIdentityKeys({}).length, 0);
    // An empty-string id is not an id — it would collide every such row.
    assert.equal(productIdentityKeys({ id: '' }).length, 0);
});

test('§2 rowsNotAlreadyIn drops rows the literal set already supplied', () => {
    const { rowsNotAlreadyIn } = loadShopHelpers();
    const compat = [{ id: 'c1', sku: 'C143LOT', name: 'Olympia 143LOT' }];
    // Same product, matched by SKU alone (the literal row carries a richer name).
    const present = rowsNotAlreadyIn(compat, [{ id: 'zzz', sku: 'c143lot', name: 'Different name' }]);
    assert.equal(present.length, 0, 'a SKU match alone must count as already present');
    const absent = rowsNotAlreadyIn(compat, [{ id: 'zzz', sku: 'OTHER', name: 'Other' }]);
    assert.deepEqual(skus(absent), ['C143LOT']);
});

test('§2 rowsNotAlreadyIn preserves order and is safe on null inputs', () => {
    const { rowsNotAlreadyIn } = loadShopHelpers();
    const rows = [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }];
    assert.deepEqual(skus(rowsNotAlreadyIn(rows, [{ sku: 'B' }])), ['A', 'C']);
    assert.equal(rowsNotAlreadyIn(null, rows).length, 0);
    assert.deepEqual(skus(rowsNotAlreadyIn(rows, null)), ['A', 'B', 'C']);
    assert.deepEqual(skus(rowsNotAlreadyIn(rows, undefined)), ['A', 'B', 'C']);
});

test('§2 mergeLiteralResults still dedups exactly as before the refactor', () => {
    // productIdentityKeys was extracted OUT of mergeLiteralResults; its
    // behaviour must be unchanged. Name-key dedup is the aggressive one, so pin
    // it explicitly.
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults(CE50_SUGGEST, CE50_PRODUCTS);
    assert.equal(merged.length, 5, 'the 3-row suggest list overlaps 3 of the 5 products');
    assert.deepEqual(skus(merged), ['GCE506A', 'C05XBK', 'CCART319BK', 'G05ABK', 'G05XBK'],
        'dropdown order first, then products-search rows the dropdown missed');
    const byName = mergeLiteralResults(
        [{ id: 'x1', sku: 'AAA', name: 'Same Name' }],
        [{ id: 'x2', sku: 'BBB', name: 'same  name' }]
    );
    assert.equal(byName.length, 1, 'differing id AND sku still collapse on normalized name');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 Reconciliation wiring — source pins
// ═════════════════════════════════════════════════════════════════════════════
test('§3 the reconciliation partitions the set instead of vetoing on compat rows', () => {
    assert.match(SHOP_CODE,
        /const\s*\{\s*direct:\s*directRows,\s*compat:\s*compatRows\s*\}\s*=\s*partitionCompatRows\(products\)/,
        'loadSearchResults must split /smart rows by provenance');
    assert.doesNotMatch(SHOP_CODE, /hasCompatMatch/,
        'the blunt any-compat-row veto must not come back (ERR-133)');
});

test('§3 softMiss and hijack are no longer vetoed by the presence of compat rows', () => {
    const soft = SHOP_CODE.match(/const\s+softMiss\s*=([\s\S]*?);/);
    const hij = SHOP_CODE.match(/const\s+hijack\s*=([\s\S]*?);/);
    assert.ok(soft && hij, 'both flags must exist');
    assert.doesNotMatch(soft[1], /[Cc]ompat/,
        'a ribbon riding along must not switch off the digit-noise repair');
    assert.doesNotMatch(hij[1], /[Cc]ompat/,
        'a ribbon riding along must not switch off the autocorrect repair');
});

test('§3 the soft-miss thinness bound and strict-beat both measure DIRECT rows', () => {
    const soft = SHOP_CODE.match(/const\s+softMiss\s*=([\s\S]*?);/);
    assert.match(soft[1], /directCount\s*<\s*SOFT_MISS_THRESHOLD/,
        'thinness is a property of the direct rows, not of the padded total');
    // ERR-144 updated this pin. It used to require the literal side to be a raw
    // `mergedUsed.length`, which was only ever correct because the literal union
    // could not contain a compat row. Backend `99d798b` broke that, so BOTH
    // sides must now be counted the same way — direct vs direct. The invariant
    // is unchanged; only its expression had to become symmetric. (Pinning the
    // old line verbatim is exactly the ERR-053 failure mode: a source pin that
    // freezes a bug in place.)
    assert.match(SHOP_CODE, /mergedSplit\.direct\.length\s*>\s*directCount/,
        'the literal set must out-count only the rows it could actually replace, counting DIRECT rows on both sides');
    assert.doesNotMatch(SHOP_CODE, /mergedUsed\.length\s*>\s*smartCount/,
        'comparing against smartCount is the CE50 bug — compat rows inflate the bar from the /smart side');
    assert.doesNotMatch(SHOP_CODE, /mergedUsed\.length\s*>\s*directCount/,
        'comparing a raw mergedUsed.length is the ERR-144 bug — post-99d798b /api/search/suggest '
        + 'smuggles compat rows into the literal set, so they inflate the bar from the literal side instead');
});

test('§3 the swap re-appends the compat rows, deduped against the literal set', () => {
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    assert.ok(body, 'the shouldUseFallback branch must exist');
    assert.match(body, /const\s+preservedCompat\s*=\s*rowsNotAlreadyIn\(\s*compatRows\s*,\s*mergedUsed\s*\)/,
        'preserved rows must go through the shared dedup vocabulary');
    assert.match(body, /products\s*=\s*mergedUsed\.concat\(\s*preservedCompat\s*\)/,
        'a raw `products = mergedUsed` is what deleted the ribbons');
    assert.match(body, /smartData\s*=\s*null/,
        'nulling smartData (kill the stale banner) must be preserved');
});

test('§3 exactMode goes through the SAME preservation path', () => {
    // The original guard never covered exact mode, which is how the VP6000
    // zero-results screen survived ERR-083. There must be exactly one
    // assignment to `products` in the swap branch, so exactMode cannot have a
    // private path that skips preservation.
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    const assignments = body.match(/products\s*=\s*[^;]+;/g) || [];
    assert.equal(assignments.length, 1,
        'one and only one assignment to products in the swap branch');
    assert.match(assignments[0], /concat\(\s*preservedCompat\s*\)/);
    assert.match(SHOP_CODE, /const\s+shouldUseFallback\s*=\s*exactMode\s*\n?\s*\?\s*true/,
        'exact mode still prefers the literal set unconditionally');
});

test('§3 the three reconciliation triggers plus exact mode all still gate the fetch', () => {
    assert.match(SHOP_CODE, /if\s*\(\s*hardMiss\s*\|\|\s*softMiss\s*\|\|\s*hijack\s*\|\|\s*exactMode\s*\)/,
        'the shared reconcile gate must be intact');
});

test('§3 the pager is suppressed when compat rows were appended', () => {
    // The appended rows are not in the literal set fallback.meta counted, so
    // total/limit/total_pages would disagree — the ERR-113 cross-field hazard.
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    assert.match(body, /preservedCompat\.length\s*===\s*0/,
        'pagination may only be adopted from fallback.meta on a non-composite page');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 End-to-end — the four defects, against live-verified fixtures
// ═════════════════════════════════════════════════════════════════════════════
test('§4 Defect 2 — q=CE50 now swaps in the missed toners AND keeps both ribbons', () => {
    const H = loadShopHelpers();
    const r = reconcile(H, { query: 'CE50', smart: CE50_SMART, products: CE50_PRODUCTS, suggest: CE50_SUGGEST });
    assert.equal(r.directCount, 3, 'three direct rows');
    assert.equal(r.softMiss, true, 'a compat row must no longer veto the soft miss');
    assert.equal(r.swapped, true, 'the 5-row literal set beats 3 direct rows');
    assert.ok(r.rows.some((p) => p.sku === 'G05ABK'), 'G05ABK was withheld before ERR-133');
    assert.ok(r.rows.some((p) => p.sku === 'G05XBK'), 'G05XBK was withheld before ERR-133');
    assert.ok(r.rows.some((p) => p.sku === '154.11'), 'the ribbon must survive the swap');
    assert.ok(r.rows.some((p) => p.sku === 'C143LOT'), 'the correction tape must survive the swap');
    assert.equal(r.rows.length, 7, 'five literal rows plus the two preserved compat rows');
});

test('§4 Defect 1 — q=VP6000 in exact mode is NOT a zero-results screen', () => {
    const H = loadShopHelpers();
    // The literal set is genuinely empty for VP6000, which is precisely why
    // assigning it raw wiped the page.
    const r = reconcile(H, { query: 'VP6000', smart: VP6000_SMART, products: [], suggest: [], exactMode: true });
    assert.equal(r.rows.length, 3, 'all three ribbons must survive exact mode');
    assert.deepEqual(skus(r.rows), ['307.11', 'C141LOT', 'C143LOT']);
});

test('§4 Defect 1 — exact mode keeps compat rows alongside a literal hit', () => {
    const H = loadShopHelpers();
    const AP830_SMART = [
        { id: 'a1', sku: '307.11', name: 'Canon  AP800 Compatible Typewriter Ribbon 307.11', match_tier: 2, relevance_score: 68.27 },
        { id: '20e3c4a5', sku: 'C141LOT', name: 'IBM Compatible 141LOT Correction Ribbon Tape', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'AP830' },
        { id: '36224f3d', sku: 'C143LOT', name: 'Olympia Compatible 143LOT Correction Ribbon Tape', match_tier: 3, relevance_score: 25, match_reason: 'compatibility', matched_token: 'AP830' },
    ];
    const literal = [{ id: 'a1', sku: '307.11', name: 'Canon  AP800 Compatible Typewriter Ribbon 307.11' }];
    const r = reconcile(H, { query: 'AP830', smart: AP830_SMART, products: literal, suggest: [], exactMode: true });
    assert.deepEqual(skus(r.rows), ['307.11', 'C141LOT', 'C143LOT'],
        'the literal row is authoritative, both ribbons are re-appended after it');
    // And the row the literal set DID supply is not duplicated.
    assert.equal(r.rows.filter((p) => p.sku === '307.11').length, 1);
});

test('§4 Defect 4 — q=AP1000 no longer buries the pack variant under score-25 rows', () => {
    const H = loadShopHelpers();
    // No literal set, so no swap — this exercises the ordering pass alone.
    const r = reconcile(H, { query: 'AP1000', smart: AP1000_SMART, products: [], suggest: [] });
    assert.equal(r.swapped, false, 'nothing to swap in');
    assert.deepEqual(skus(r.rows), ['G45BK', 'G45BK-2PK', '155.11', '156.11', 'C143LOT'],
        'both HP rows lead; the three ribbons follow, in backend order');
    const lastDirect = r.rows.findIndex((p) => p.sku === 'G45BK-2PK');
    const firstCompat = r.rows.findIndex((p) => p.match_reason === 'compatibility');
    assert.ok(lastDirect < firstCompat, 'no direct row may sit below a compat row');
});

test('§4 the negative control — q=lc233 has no compat rows and is untouched', () => {
    const H = loadShopHelpers();
    const r = reconcile(H, { query: 'lc233', smart: LC233_SMART, products: [], suggest: [] });
    assert.equal(r.rows.length, LC233_SMART.length, 'no rows added or lost');
    assert.deepEqual(skus(r.rows), skus(LC233_SMART), 'backend order is preserved exactly');
    const { compat } = H.partitionCompatRows(LC233_SMART);
    assert.equal(compat.length, 0, 'a plain ink query must inject no compat rows');
});

test('§4 a swap on a compat-free set behaves exactly as it always did', () => {
    const H = loadShopHelpers();
    // Guards the other direction: preservation must be a no-op when there is
    // nothing to preserve, so ordinary digit-noise repair is unaffected.
    const smart = [{ id: 's1', sku: 'X220', name: 'Thing 220V voltage kit', series_codes: ['220V'] }];
    const products = [
        { id: 'p1', sku: 'C220BK', name: 'Epson 220BK Compatible Ink 220 Black', series_codes: ['220'] },
        { id: 'p2', sku: 'C220XLBK', name: 'Epson 220XLBK Compatible Ink 220XL Black', series_codes: ['220'] },
    ];
    const r = reconcile(H, { query: '220', smart, products, suggest: [] });
    assert.equal(r.swapped, true, 'the literal set out-counts the single smart row');
    assert.deepEqual(skus(r.rows), ['C220BK', 'C220XLBK'], 'no phantom rows appended');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 Provenance ordering is applied unconditionally
// ═════════════════════════════════════════════════════════════════════════════
test('§5 the ordering pass lives in renderProducts, where order is actually decided', () => {
    // It CANNOT live on the flat /smart array: loadSearchResults re-partitions
    // rows by `source` into the Compatible/Genuine sections and re-sorts each,
    // so anything imposed upstream is discarded before it reaches the DOM.
    // Verified in a real browser 2026-07-30 — ordering the flat array was a
    // measurable no-op, which is why this pin names renderProducts.
    const body = blockBodyAt(SHOP_CODE, 'renderProducts(products, container, section, isCompatible = false, _options = {})');
    assert.ok(body, 'renderProducts must exist');
    assert.match(body, /const\s+compatLast\s*=\s*\(rows\)\s*=>/,
        'renderProducts must define the compat-last reorder');
    assert.match(body, /split\.direct\.concat\(split\.compat\)/,
        'direct rows first, then the "also fits" rows');
    assert.doesNotMatch(SHOP_CODE,
        /const\s+ordered\s*=\s*partitionCompatRows\(products\)/,
        'the flat-array ordering pass was a no-op and must not come back');
});

test('§5 compat-last is applied under BOTH sort modes, before row breaks', () => {
    const body = blockBodyAt(SHOP_CODE, 'renderProducts(products, container, section, isCompatible = false, _options = {})');
    assert.match(body, /compatLast\(this\._sortProductsBy\(products,\s*sortMode\)\)/,
        'explicit price/name sorts must also trail the compat rows');
    assert.match(body, /compatLast\(\(typeof ProductSort[\s\S]*?byCodeThenColor\(products\)[\s\S]*?\)\)/,
        'the recommended (byCodeThenColor) path must trail them too');
    // rowBreakIndices must be computed from the REORDERED array, or the
    // yield-group break lines land between the wrong cards.
    const reorderAt = body.indexOf('compatLast((typeof ProductSort');
    const breaksAt = body.indexOf('rowBreakIndices(sortedProducts)');
    assert.ok(reorderAt !== -1 && breaksAt !== -1 && reorderAt < breaksAt,
        'row breaks must be derived after the reorder');
});

test('§5 compat-last returns the ORIGINAL array when there are no compat rows', () => {
    // Every non-search surface (code drilldown, printer, paper) funnels through
    // renderProducts. The reorder must be provably inert for them.
    const body = blockBodyAt(SHOP_CODE, 'renderProducts(products, container, section, isCompatible = false, _options = {})');
    assert.match(body, /split\.compat\.length\s*\?\s*split\.direct\.concat\(split\.compat\)\s*:\s*rows/,
        'no compat rows ⇒ hand back the untouched array, not a rebuilt one');
});

test('§5 the ordering pass is idempotent', () => {
    const { partitionCompatRows } = loadShopHelpers();
    const once = (rows) => { const o = partitionCompatRows(rows); return o.direct.concat(o.compat); };
    const a = once(AP1000_SMART);
    assert.deepEqual(skus(once(a)), skus(a), 'reordering an ordered set changes nothing');
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 Dropdown ⇄ results-page badge parity
// ═════════════════════════════════════════════════════════════════════════════
test('§6 Products.renderCard emits the compat badge for a compat row', () => {
    const html = loadProducts().renderCard({
        id: 'c1', sku: 'C141LOT', name: 'IBM Compatible 141LOT Correction Ribbon Tape',
        brand: { name: 'IBM' }, image_url: 'https://x/141.webp', retail_price: 11.95,
        in_stock: true, source: 'compatible', match_reason: 'compatibility', matched_token: 'AP830',
    }, 0);
    assert.match(html, /product-card__badge--compat-match/, 'the dropdown card must carry the chip');
    assert.match(html, />Fits AP830</, 'visible text names the machine searched');
    assert.match(html, /title="Compatible with AP830"/, 'tooltip carries the full phrase');
    assert.match(html, /product-card__chip-stack[\s\S]{0,300}compat-match/, 'chip lives in the chip-stack');
});

test('§6 Products.renderCard emits NO badge without both fields', () => {
    const P = loadProducts();
    const base = {
        id: 'c1', sku: 'C141LOT', name: 'IBM Compatible 141LOT Correction Ribbon Tape',
        brand: { name: 'IBM' }, image_url: 'https://x/141.webp', retail_price: 11.95,
        in_stock: true, source: 'compatible',
    };
    assert.doesNotMatch(P.renderCard({ ...base }, 0), /compat-match/,
        'a normal name/SKU row must stay clean');
    assert.doesNotMatch(P.renderCard({ ...base, match_reason: 'compatibility' }, 0), /compat-match/,
        'match_reason without matched_token would render "Fits undefined"');
    assert.doesNotMatch(P.renderCard({ ...base, matched_token: 'AP830' }, 0), /compat-match/,
        'matched_token alone (fuzzy rows carry one too) must not claim a fit');
    assert.doesNotMatch(P.renderCard({ ...base, match_reason: 'semantic', matched_token: 'AP830' }, 0), /compat-match/,
        'only match_reason === "compatibility" earns the chip');
});

test('§6 matched_token is escaped in BOTH the text and the title attribute', () => {
    // matched_token echoes the raw query, so it is attacker-influenced: a
    // crafted /search?q=… would otherwise inject into the dropdown.
    const html = loadProducts().renderCard({
        id: 'c1', sku: 'C141LOT', name: 'IBM 141LOT', brand: { name: 'IBM' },
        image_url: 'https://x/141.webp', retail_price: 11.95, in_stock: true, source: 'compatible',
        match_reason: 'compatibility', matched_token: '"><img src=x onerror=alert(1)>',
    }, 0);
    assert.doesNotMatch(html, /<img src=x onerror/, 'no raw tag may reach the DOM');
    assert.match(html, /&lt;img src=x onerror/, 'the token must appear escaped');
    assert.doesNotMatch(html, /title="Compatible with "><img/, 'the attribute must not be broken out of');
});

test('§6 the dropdown card mirrors the results-page card byte-for-byte', () => {
    // ERR-125's lesson: these two renderers are duplicated, so the only defence
    // against drift is pinning them to the same shape.
    const shop = SHOP_CODE.match(/const\s+compatMatchBadge\s*=([\s\S]*?);\n/);
    const drop = PRODUCTS_CODE.match(/const\s+compatMatchBadgeHTML\s*=([\s\S]*?);\n/);
    assert.ok(shop && drop, 'both renderers must define the badge');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    assert.equal(norm(drop[1]), norm(shop[1]),
        'the dropdown badge expression must match the results-page one exactly');
});

test('§6 both card renderers gate the chip-stack on the compat badge too', () => {
    assert.match(SHOP_CODE,
        /\(fitsPrinterBadge\s*\|\|\s*compatMatchBadge\s*\|\|\s*suggestedBadge\)/,
        'results-page stack must appear when only the compat chip is present');
    assert.match(PRODUCTS_CODE,
        /\(discountBadgeHTML\s*\|\|\s*fitsPrinterBadgeHTML\s*\|\|\s*compatMatchBadgeHTML\)/,
        'dropdown stack must appear when only the compat chip is present');
});

test('§6 search.css un-hides ONLY the compat chip inside the dropdown grid', () => {
    assert.match(SEARCH_CSS, /\.smart-ac__grid\s+\.product-card__badge\s*\{[^}]*display:\s*none/,
        'the blanket hide must remain for Save / Fits Your Printer');
    const m = SEARCH_CSS.match(/\.smart-ac__grid\s+\.product-card__badge--compat-match\s*\{([^}]*)\}/);
    assert.ok(m, 'the compat chip needs an explicit exception or the hide wins');
    assert.match(m[1], /display:\s*inline-block/, 'the exception must actually re-show it');
    assert.match(m[1], /font-size:\s*9px/, 'scaled down for the tighter dropdown footprint');
    assert.match(m[1], /text-overflow:\s*ellipsis/, 'a long machine name must not blow out the card');
});

test('§6 the results-page badge style is still defined', () => {
    assert.match(SEARCH_CSS, /\.product-card__badge--compat-match\s*\{/,
        'search.css must style .product-card__badge--compat-match');
});
