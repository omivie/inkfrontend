/**
 * Ribbon "FOR USE IN" reached the typeahead endpoints — and broke the chip — Aug 2026
 * ===================================================================================
 *
 * The backend change
 * ------------------
 * Backend commit `99d798b` (2026-08-04) made a product's admin-authored
 * `compatible_devices_html` ("FOR USE IN") blob searchable on
 * `/api/search/suggest` and `/api/search/autocomplete`, so a ribbon shows up in
 * the search-bar dropdown as you type. Its handoff
 * (`ribbon-for-use-in-typeahead-FE-handoff-aug2026.md`) said, for the second
 * consecutive handoff on this feature, **"No FE changes required."**
 *
 * Every behavioural claim in it is TRUE. Re-verified against prod 2026-08-04:
 * `TCX-11`, `ET-3300`, `TR910`, `NS-5100`, `EX-9000`, `TS-4000i`, `PIX-200`,
 * `PIX-4000` all return `36000.01`/`36000.02` from /suggest, autocomplete
 * agrees, `lc233` stays ribbon-free, and blob rows only fill slots left over
 * after the direct hits (`/suggest?q=CE50&limit=1` → `GCE506A` alone).
 *
 * Two things were still wrong. (ERR-144.)
 *
 * Finding 1 — this app's dropdown never called /suggest
 * -----------------------------------------------------
 * `search.js` has driven off `/api/search/smart` at limit 40 since Jun 2026
 * (`/suggest` caps at 24: measured 2026-08-04, limit=24 → 24 rows, limit=25 →
 * hard `400 Validation failed`).
 * The customer-facing gap the handoff describes was already closed on
 * 2026-07-30 by /smart's blob search plus ERR-133. What misled the backend was
 * our own stale prose: search.js's header said "backed by GET
 * /api/search/suggest", its fetcher was still named `fetchSuggest`, and
 * api.js called /suggest "the endpoint the dropdown uses". All corrected;
 * §6 pins them so they cannot rot back.
 *
 * Finding 2 — /suggest is this app's literal CONTROL SET, and widening it
 * silently deleted the "Fits <model>" chip
 * -----------------------------------------------------------------------
 * `API.searchSuggest` still has one caller: `shop-page.js loadSearchResults`,
 * where it forms half the literal union (`/api/products?search=` ∪ `/suggest`)
 * used to judge whether /smart's set should be replaced. ERR-133's whole design
 * rested on an invariant that commit `99d798b` falsified:
 *
 *     the literal union matches on name/SKU only, so it can NEVER contain a
 *     "for use in" match
 *
 * It can now — and because the typeahead payloads deliberately omit
 * `match_reason`/`matched_token`, those rows arrive INDISTINGUISHABLE from
 * direct hits. Consequences, all measured live 2026-08-04:
 *
 *   1. The chip dies. mergeLiteralResults prefers the literal copy (richer
 *      fields); rowsNotAlreadyIn then sees the row as already supplied and
 *      re-appends nothing; the row that renders carries no match_reason, so
 *      createProductCard emits no "Fits <model>". q=AP830, AP8100, VP6000,
 *      AP1000, SP1000, TR910, GX6750, AX220, CE50, CE60 — every one of them.
 *   2. The swap bar inverts. `mergedUsed.length > directCount` excluded compat
 *      rows from the right-hand side but counted them on the left, so a set of
 *      pure also-fits rows could win a swap it had not earned. q=VP6000 (0
 *      direct, 3 compat) had an EMPTY literal set in July and kept /smart's
 *      three badged rows; post-99d798b /suggest returned those same three
 *      ribbons, `3 > 0` swapped, and they rendered stripped of their chips.
 *   3. compatLast stops working — an untagged row sorts among the direct hits.
 *   4. The pager gate (`preservedCompat.length === 0`) went trivially true, so
 *      a curated page could get a pager back. ERR-113's cross-field rule.
 *
 * The fix
 * -------
 * `reattachCompatProvenance(rows, compatRows)` re-labels a literal row from
 * /smart's OWN row for the same product. This is NOT the frontend asserting
 * compatibility (ERR-135): a compat row may be RE-labelled, never labelled —
 * nothing is derived, matched or guessed locally. The swap bar then compares
 * direct-vs-direct on both sides, and the pager gate asks "is any compat row on
 * this page", not "did we re-append one".
 *
 * What this file pins
 * -------------------
 *  §1 reattachCompatProvenance — the primitive, including its ERR-135 limits.
 *  §2 the wiring: re-attach runs, the bar is symmetric, both mechanisms survive.
 *  §3 end-to-end over live-verified fixtures (AP830, VP6000, CE50, lc233).
 *  §4 the pager gate covers literal-side compat rows.
 *  §5 the ERR-133 regressions stay fixed (no !hasCompatMatch veto, etc).
 *  §6 the stale-prose rot that caused this, pinned shut.
 *  §7 the dropdown keyboard-order defect fixed alongside.
 *
 * Run: node --test tests/ribbon-typeahead-compat-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (f) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', f), 'utf8');

const SHOP_SRC = JS('shop-page.js');
const UTILS_SRC = JS('utils.js');
const SEARCH_SRC = JS('search.js');
const API_SRC = JS('api.js');

// Strip comments so a literal inside a comment can't satisfy a source assertion.
// NOTE: never put a slash-star sequence inside a fixture string in this file —
// it opens a fake block comment here and silently voids every assertion below.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const SHOP_CODE = stripComments(SHOP_SRC);
const SEARCH_CODE = stripComments(SEARCH_SRC);
const API_CODE = stripComments(API_SRC);

// Balanced `{ … }` body of the first block at/after `anchor` (ERR-124's lesson:
// a fixed-width slice window goes vacuous the moment the code inside grows).
function blockBodyAt(src, anchor) {
    const at = src.indexOf(anchor);
    if (at === -1) return null;
    const open = src.indexOf('{', at + anchor.length);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    return null;
}

// Load the pure reconciliation helpers out of shop-page.js. utils.js loads
// FIRST because queryCodeMatch delegates to window.CompatSource for its
// code-token vocabulary — without it the helper answers false for everything
// and any test leaning on it silently proves nothing.
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

const H = loadShopHelpers();

// ─────────────────────────────────────────────────────────────────────────────
// §1  reattachCompatProvenance — the primitive
// ─────────────────────────────────────────────────────────────────────────────

test('§1 the helper is exported on the shared test hook', () => {
    assert.equal(typeof H.reattachCompatProvenance, 'function',
        'the audit script and these tests both read it off window._searchParityHelpers');
});

test('§1 an untagged literal row is re-labelled from the /smart row for the same product', () => {
    const smartCompat = [{
        id: 'c5ec20e9', sku: '307.11', name: 'Canon AP800 Compatible Ribbon',
        match_reason: 'compatibility', matched_token: 'AP830',
    }];
    // The literal copy: richer (it has retail_price), but provenance-blind.
    const literal = [{ id: 'c5ec20e9', sku: '307.11', name: 'Canon AP800 Compatible Ribbon', retail_price: 68.27 }];

    const out = H.reattachCompatProvenance(literal, smartCompat);
    assert.equal(out[0].match_reason, 'compatibility');
    assert.equal(out[0].matched_token, 'AP830');
    assert.equal(out[0].retail_price, 68.27, 'the richer literal fields must survive the re-label');
});

test('§1 a row the /smart set never called compat is left completely alone', () => {
    // THE ERR-135 LINE. The frontend never asserts compatibility. If /smart did
    // not tag this product, nothing here may tag it — no name matching, no
    // token inference, no "it looks like a ribbon".
    const smartCompat = [{ id: 'ribbon-1', sku: '307.11', match_reason: 'compatibility', matched_token: 'AP830' }];
    const literal = [
        { id: 'cart-1', sku: 'GCE506A', name: 'HP 05A Toner' },
        { id: 'ribbon-2', sku: '154.11', name: 'Some Other Ribbon AP830' }, // name even contains the token
    ];
    const out = H.reattachCompatProvenance(literal, smartCompat);
    assert.equal(out[0].match_reason, undefined);
    assert.equal(out[1].match_reason, undefined,
        'a matching token in the NAME is not provenance — only /smart can call a row compat');
});

test('§1 a row that already carries its own match_reason is never overwritten', () => {
    const smartCompat = [{ id: 'x', match_reason: 'compatibility', matched_token: 'AP830' }];
    const literal = [{ id: 'x', match_reason: 'fuzzy', matched_token: 'AP8300' }];
    const out = H.reattachCompatProvenance(literal, smartCompat);
    assert.equal(out[0].match_reason, 'fuzzy', 'the backend verdict for THIS row wins');
    assert.equal(out[0].matched_token, 'AP8300');
});

test('§1 idempotent — running it twice changes nothing', () => {
    const smartCompat = [{ id: 'x', sku: 'A', match_reason: 'compatibility', matched_token: 'AP830' }];
    const once = H.reattachCompatProvenance([{ id: 'x', sku: 'A' }], smartCompat);
    const twice = H.reattachCompatProvenance(once, smartCompat);
    assert.deepEqual(twice, once);
});

test('§1 a /smart-sourced set passes through untouched (every row already tagged or direct)', () => {
    const compat = [{ id: 'r1', match_reason: 'compatibility', matched_token: 'VP6000' }];
    const smartSet = [{ id: 'd1', name: 'Direct hit' }, compat[0]];
    const out = H.reattachCompatProvenance(smartSet, compat);
    assert.equal(out[0].match_reason, undefined, 'a direct row stays direct');
    assert.equal(out[1], compat[0], 'an already-tagged row is returned by reference, not copied');
});

test('§1 identity matches on id, on sku (case-insensitively) and on normalized name', () => {
    const token = 'AP830';
    const mk = (over) => Object.assign({ match_reason: 'compatibility', matched_token: token }, over);

    const byId = H.reattachCompatProvenance([{ id: 'abc' }], [mk({ id: 'abc' })]);
    assert.equal(byId[0].matched_token, token, 'id');

    const bySku = H.reattachCompatProvenance([{ sku: 'c143lot' }], [mk({ sku: 'C143LOT' })]);
    assert.equal(bySku[0].matched_token, token, 'sku, case-insensitively');

    const byName = H.reattachCompatProvenance(
        [{ name: 'Canon   AP800 Compatible Ribbon' }],
        [mk({ name: 'Canon AP800 Compatible Ribbon' })]);
    assert.equal(byName[0].matched_token, token, 'normalized name (whitespace-collapsed)');
});

test('§1 it uses the SHARED identity vocabulary, not a private one', () => {
    // ERR-135's lesson: the rule already existed four times and the correct
    // pair still disagreed. Three notions of "same product" in one file is how
    // that happens again.
    const body = blockBodyAt(SHOP_CODE, 'function reattachCompatProvenance');
    assert.ok(body, 'reattachCompatProvenance must exist');
    assert.match(body, /productIdentityKeys\(/,
        'identity must go through productIdentityKeys, shared with mergeLiteralResults + rowsNotAlreadyIn');
    assert.doesNotMatch(body, /\.toUpperCase\(\)|\.trim\(\)|\.replace\(/,
        'no hand-rolled key normalisation — that is productIdentityKeys\' job');
});

test('§1 pure: never drops, never reorders, never mutates its input', () => {
    const compat = [{ id: 'b', match_reason: 'compatibility', matched_token: 'T' }];
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const frozenBefore = JSON.stringify(rows);
    const out = H.reattachCompatProvenance(rows, compat);
    assert.equal(out.length, 3, 'never drops a row');
    assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c'], 'never reorders');
    assert.equal(JSON.stringify(rows), frozenBefore, 'never mutates the input rows');
    assert.notEqual(out[1], rows[1], 'the re-labelled row is a copy');
});

test('§1 null-safe and cheap on the common no-compat path', () => {
    // NOTE: helpers come from a vm realm, so their arrays do not share this
    // realm's Array.prototype — deepStrictEqual would fail on the prototype
    // check alone. Assert on shape, not on cross-realm reference equality.
    assert.equal(H.reattachCompatProvenance(null, []).length, 0);
    assert.equal(H.reattachCompatProvenance(undefined, null).length, 0);
    const rows = [{ id: 'a' }];
    assert.equal(H.reattachCompatProvenance(rows, []), rows, 'no compat rows → same array back');
    assert.equal(H.reattachCompatProvenance(rows, null), rows);
    // A malformed "compat" list with no actual compatibility rows is a no-op.
    assert.equal(H.reattachCompatProvenance(rows, [{ id: 'a', match_reason: 'fuzzy' }]), rows);
});

test('§1 survives null rows inside either list', () => {
    const out = H.reattachCompatProvenance(
        [null, { id: 'a' }],
        [null, { id: 'a', match_reason: 'compatibility', matched_token: 'T' }]);
    assert.equal(out.length, 2);
    assert.equal(out[0], null);
    assert.equal(out[1].matched_token, 'T');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  The wiring in loadSearchResults
// ─────────────────────────────────────────────────────────────────────────────

const RECONCILE_BODY = blockBodyAt(SHOP_CODE, 'if (hardMiss || softMiss || hijack || exactMode)');

test('§2 the reconcile block exists and re-attaches provenance to the literal set', () => {
    assert.ok(RECONCILE_BODY, 'the shared reconcile gate must be intact');
    assert.match(RECONCILE_BODY, /mergedUsed\s*=\s*reattachCompatProvenance\(\s*mergedUsed\s*,\s*compatRows\s*\)/,
        'the literal set must be re-labelled from /smart\'s compat rows');
});

test('§2 re-attach runs AFTER the digit on-topic filter and BEFORE the swap decision', () => {
    const iFilter = RECONCILE_BODY.indexOf('queryCodeMatch');
    const iReattach = RECONCILE_BODY.indexOf('reattachCompatProvenance');
    const iDecide = RECONCILE_BODY.indexOf('shouldUseFallback');
    assert.ok(iFilter !== -1 && iReattach !== -1 && iDecide !== -1);
    assert.ok(iFilter < iReattach,
        're-attaching before the filter would tag rows that never reach the page');
    assert.ok(iReattach < iDecide,
        'the swap decision reads the partition, so provenance must already be attached');
});

test('§2 the swap bar counts DIRECT rows on BOTH sides', () => {
    assert.match(RECONCILE_BODY, /const\s+mergedSplit\s*=\s*partitionCompatRows\(\s*mergedUsed\s*\)/,
        'the literal set needs its own provenance partition');
    assert.match(RECONCILE_BODY, /mergedSplit\.direct\.length\s*>\s*directCount/,
        'direct-vs-direct — the ERR-144 fix');
    assert.doesNotMatch(RECONCILE_BODY, /mergedUsed\.length\s*>\s*directCount/,
        'counting the whole literal set lets smuggled compat rows win a swap they did not earn');
    assert.doesNotMatch(RECONCILE_BODY, /mergedUsed\.length\s*>\s*smartCount/,
        'and comparing against smartCount is the original ERR-133 CE50 bug');
});

test('§2 the hijack / hardMiss arm still swaps on ANY literal hit', () => {
    // Not a regression target: when /smart is empty or provably wrong, one
    // literal row of any provenance beats it.
    assert.match(RECONCILE_BODY, /\(hijack\s*\|\|\s*hardMiss\)[\s\S]{0,120}mergedUsed\.length\s*>\s*0/);
});

test('§2 BOTH preservation mechanisms are present — they cover different rows', () => {
    // re-attach covers compat rows the literal union DID supply; re-append
    // covers the ones it did not. Dropping either loses chips on a different
    // corpus, which is exactly how ERR-144 happened to ERR-133's fix.
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    assert.ok(body);
    assert.match(body, /const\s+preservedCompat\s*=\s*rowsNotAlreadyIn\(\s*compatRows\s*,\s*mergedUsed\s*\)/);
    assert.match(body, /products\s*=\s*mergedUsed\.concat\(\s*preservedCompat\s*\)/);
    assert.match(RECONCILE_BODY, /reattachCompatProvenance/);
});

test('§2 exactMode still goes through the same single assignment to products', () => {
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    const assignments = body.match(/products\s*=\s*[^;]+;/g) || [];
    assert.equal(assignments.length, 1, 'exactMode must not get a private path that skips preservation');
    assert.match(assignments[0], /concat\(\s*preservedCompat\s*\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  End-to-end over live-verified fixtures
//
// The shipped sequence, composed from the SAME exported helpers the page uses.
// §2 pins that shop-page.js performs these steps in this order, so this mirror
// cannot drift away from the real thing without a test going red.
// ─────────────────────────────────────────────────────────────────────────────

function reconcile({ smartProducts, suggestList, productsList, query, exactMode = false }) {
    const queryHasDigits = /\d/.test(String(query || ''));
    const { direct, compat } = H.partitionCompatRows(smartProducts);
    const directCount = direct.length;

    const merged = H.mergeLiteralResults(suggestList, productsList);
    let mergedUsed = merged;
    if (queryHasDigits) {
        const onTopic = merged.filter(p => H.queryCodeMatch(p, query));
        if (onTopic.length > 0 && onTopic.length < merged.length) mergedUsed = onTopic;
    }
    mergedUsed = H.reattachCompatProvenance(mergedUsed, compat);
    const mergedSplit = H.partitionCompatRows(mergedUsed);

    const hardMiss = smartProducts.length === 0;
    const hijack = false;
    const shouldUseFallback = exactMode
        ? true
        : (hijack || hardMiss)
            ? mergedUsed.length > 0
            : mergedSplit.direct.length > directCount;

    if (!shouldUseFallback) return { swapped: false, products: smartProducts };
    const preservedCompat = H.rowsNotAlreadyIn(compat, mergedUsed);
    return { swapped: true, products: mergedUsed.concat(preservedCompat), preservedCompat, mergedSplit };
}

const chipCount = (rows, token) =>
    rows.filter(p => p && p.match_reason === 'compatibility' && p.matched_token === token).length;

// Live shapes, 2026-08-04. /smart tags compat rows; /suggest does not.
const AP830 = {
    query: 'AP830',
    smartProducts: [
        { id: 's1', sku: '307.11', name: 'Canon AP800 Compatible Ribbon', retail_price: 68.27 },
        { id: 's2', sku: 'C141LOT', name: 'Correction Tape C141LOT', match_reason: 'compatibility', matched_token: 'AP830' },
        { id: 's3', sku: 'C143LOT', name: 'Correction Tape C143LOT', match_reason: 'compatibility', matched_token: 'AP830' },
    ],
    suggestList: [
        { id: 's1', sku: '307.11', name: 'Canon AP800 Compatible Ribbon' },
        { id: 's2', sku: 'C141LOT', name: 'Correction Tape C141LOT' },
        { id: 's3', sku: 'C143LOT', name: 'Correction Tape C143LOT' },
    ],
    productsList: [],
};

test('§3 AP830 — the pure-ribbon literal set no longer wins a swap it did not earn', () => {
    const r = reconcile(AP830);
    assert.equal(r.swapped, false,
        'the literal set has ONE direct row, same as /smart — nothing to gain, and swapping cost the chips');
    assert.equal(chipCount(r.products, 'AP830'), 2, 'both correction tapes keep "Fits AP830"');
});

test('§3 AP830 — and even if it HAD swapped, the chips would survive the re-attach', () => {
    // Belt and braces: force the swap via exactMode (the "Search instead for X"
    // path), which is exactly where ERR-133's original guard failed.
    const r = reconcile(Object.assign({}, AP830, { exactMode: true }));
    assert.equal(r.swapped, true);
    assert.equal(chipCount(r.products, 'AP830'), 2,
        'exactMode is the path that rendered a ZERO-RESULTS screen in ERR-133 — it must carry chips now');
});

test('§3 VP6000 — a set with NO direct rows is never replaced by its own ribbons', () => {
    const smartProducts = [
        { id: 'v1', sku: '155.11', name: 'Ribbon 155.11', match_reason: 'compatibility', matched_token: 'VP6000' },
        { id: 'v2', sku: '156.11', name: 'Ribbon 156.11', match_reason: 'compatibility', matched_token: 'VP6000' },
        { id: 'v3', sku: 'C143LOT', name: 'Correction Tape C143LOT', match_reason: 'compatibility', matched_token: 'VP6000' },
    ];
    const r = reconcile({
        query: 'VP6000',
        smartProducts,
        suggestList: smartProducts.map(p => ({ id: p.id, sku: p.sku, name: p.name })), // untagged copies
        productsList: [],
    });
    assert.equal(r.swapped, false, '0 direct vs 0 direct — the literal set adds nothing');
    assert.equal(chipCount(r.products, 'VP6000'), 3, 'all three ribbons keep their chip');
});

test('§3 CE50 — the ERR-133 win is preserved AND the chips survive it', () => {
    // The mixed case: the literal set really does carry two cartridges /smart
    // missed (G05ABK, G05XBK), so the swap SHOULD fire — it just must not cost
    // the ribbons their provenance on the way through.
    const smartProducts = [
        { id: 'd1', sku: 'CCART319BK', name: 'Canon 319 Toner' },
        { id: 'd2', sku: 'GCE506A', name: 'HP 05A Toner CE505A' },
        { id: 'd3', sku: 'C05XBK', name: 'HP 05X Compatible Toner' },
        { id: 'r1', sku: '154.11', name: 'Ribbon 154.11', match_reason: 'compatibility', matched_token: 'CE50' },
        { id: 'r2', sku: 'C143LOT', name: 'Correction Tape C143LOT', match_reason: 'compatibility', matched_token: 'CE50' },
    ];
    const r = reconcile({
        query: 'CE50',
        smartProducts,
        suggestList: [
            { id: 'd2', sku: 'GCE506A', name: 'HP 05A Toner CE505A' },
            { id: 'd3', sku: 'C05XBK', name: 'HP 05X Compatible Toner' },
            { id: 'd1', sku: 'CCART319BK', name: 'Canon 319 Toner' },
            { id: 'r1', sku: '154.11', name: 'Ribbon 154.11' },
            { id: 'r2', sku: 'C143LOT', name: 'Correction Tape C143LOT' },
        ],
        productsList: [
            { id: 'd2', sku: 'GCE506A', name: 'HP 05A Toner CE505A' },
            { id: 'd3', sku: 'C05XBK', name: 'HP 05X Compatible Toner' },
            { id: 'd1', sku: 'CCART319BK', name: 'Canon 319 Toner' },
            { id: 'd4', sku: 'G05ABK', name: 'HP 05A Genuine Toner CE505A' },
            { id: 'd5', sku: 'G05XBK', name: 'HP 05X Genuine Toner CE505X' },
        ],
    });
    assert.equal(r.swapped, true, '5 direct beats 3 direct — the two missed cartridges must be recovered');
    const skus = r.products.map(p => p.sku);
    assert.ok(skus.includes('G05ABK') && skus.includes('G05XBK'), 'the ERR-133 recovery still happens');
    assert.equal(chipCount(r.products, 'CE50'), 2, 'and both ribbons still carry "Fits CE50"');
    assert.equal(r.preservedCompat.length, 0,
        'nothing needed re-appending here — which is precisely why re-attach had to exist');
});

test('§3 lc233 — the negative control is untouched', () => {
    const direct = Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, sku: `LC233${i}`, name: `Brother LC233 ink ${i}` }));
    const r = reconcile({ query: 'lc233', smartProducts: direct, suggestList: direct, productsList: direct });
    assert.equal(r.swapped, false, '13 direct vs 13 direct — no swap');
    assert.equal(r.products.filter(p => p.match_reason).length, 0, 'nothing gets labelled out of nowhere');
});

test('§3 a compat row the literal union does NOT supply is still re-appended', () => {
    // The ERR-133 path, unchanged. Re-attach must not have replaced it.
    const smartProducts = [
        { id: 'd1', sku: 'AAA', name: 'Direct A' },
        { id: 'r1', sku: 'RIB1', name: 'Ribbon 1', match_reason: 'compatibility', matched_token: 'XR20' },
    ];
    const r = reconcile({
        query: 'XR20',
        smartProducts,
        suggestList: [],
        productsList: [
            { id: 'd1', sku: 'AAA', name: 'Direct A' },
            { id: 'd2', sku: 'BBB', name: 'Direct B' },
        ],
    });
    assert.equal(r.swapped, true, '2 direct beats 1 direct');
    assert.equal(r.preservedCompat.length, 1, 'the ribbon was absent from the literal set — re-append it');
    assert.equal(chipCount(r.products, 'XR20'), 1);
    assert.equal(r.products[r.products.length - 1].sku, 'RIB1', 'and it lands AFTER the direct rows');
});

test('§3 a re-attached row is classified compat, so compatLast will sink it', () => {
    const r = reconcile(Object.assign({}, AP830, { exactMode: true }));
    const split = H.partitionCompatRows(r.products);
    assert.equal(split.compat.length, 2,
        'without the re-attach these two would count as DIRECT and sort among real name/SKU hits');
    assert.equal(split.direct.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4  The pager gate
// ─────────────────────────────────────────────────────────────────────────────

test('§4 the pager is suppressed when ANY compat row is on the page', () => {
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    assert.match(body, /preservedCompat\.length\s*===\s*0\s*[\s\S]{0,120}mergedSplit\.compat\.length\s*===\s*0/,
        'a compat row that arrived via /suggest is uncounted by fallback.meta in exactly the same '
        + 'way as a re-appended one — ERR-113 cross-field contradiction otherwise');
});

test('§4 the pager still works when the page is a plain literal set', () => {
    const body = blockBodyAt(SHOP_CODE, 'if (shouldUseFallback)');
    assert.match(body, /!mergedFiltered/, 'a filtered page stays curated');
    assert.match(body, /total_pages:\s*fallback\.meta\.total_pages/,
        'the normal pagination path must remain reachable');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5  ERR-133 regressions stay fixed
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the !hasCompatMatch veto is never re-added to softMiss / hijack', () => {
    const soft = SHOP_CODE.match(/const\s+softMiss\s*=([\s\S]*?);/);
    const hij = SHOP_CODE.match(/const\s+hijack\s*=([\s\S]*?);/);
    assert.ok(soft && hij);
    assert.doesNotMatch(soft[1], /hasCompat/i,
        'ERR-133: one ribbon riding along must not switch off the digit-noise repair for the cartridges');
    assert.doesNotMatch(hij[1], /hasCompat/i);
});

test('§5 the softMiss thinness bound still measures DIRECT rows', () => {
    const soft = SHOP_CODE.match(/const\s+softMiss\s*=([\s\S]*?);/);
    assert.match(soft[1], /directCount\s*<\s*SOFT_MISS_THRESHOLD/);
});

test('§5 the dead invariant is not re-asserted anywhere in shop-page.js', () => {
    // The prose that justified the old design. If someone reinstates it, the
    // next backend widening silently deletes the chips again.
    assert.doesNotMatch(SHOP_SRC, /literal union[\s\S]{0,80}can never contain/i,
        'ERR-144: /api/search/suggest carries "for use in" matches as of backend 99d798b');
    assert.doesNotMatch(SHOP_SRC, /structurally cannot contain a "for use in" match/i);
    assert.match(SHOP_SRC, /ERR-144/,
        'the reconciliation must carry the note explaining why re-attachment exists');
});

test('§5 compatLast still orders direct hits above also-fits rows at render time', () => {
    assert.match(SHOP_CODE, /const\s+compatLast\s*=/);
    assert.match(SHOP_CODE, /partitionCompatRows\(rows\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  The stale prose that caused this, pinned shut
// ─────────────────────────────────────────────────────────────────────────────

test('§6 search.js says it is backed by /smart, and never claims /suggest', () => {
    assert.match(SEARCH_SRC, /backed by GET \/api\/search\/smart/,
        'the header must name the endpoint the file actually calls');
    assert.doesNotMatch(SEARCH_SRC, /backed by GET \/api\/search\/suggest/,
        'this exact sentence is what convinced the backend to widen /suggest (ERR-144)');
    assert.match(SEARCH_CODE, /const ENDPOINT = '\/api\/search\/smart'/);
});

test('§6 the fetcher is named for the endpoint it calls', () => {
    assert.match(SEARCH_CODE, /async function fetchSmart\(/);
    assert.doesNotMatch(SEARCH_CODE, /function fetchSuggest\b/,
        'the old name outlived the endpoint it described');
    assert.doesNotMatch(SEARCH_CODE, /fetchSuggest\(/, 'no stale call sites');
});

test('§6 api.js documents searchSuggest as a control set that can carry compat rows', () => {
    const doc = API_SRC.slice(
        Math.max(0, API_SRC.indexOf('async searchSuggest(') - 2200),
        API_SRC.indexOf('async searchSuggest('));
    assert.match(doc, /control set/i, 'its job is reconciliation, not typeahead');
    assert.match(doc, /ERR-144/, 'and it must warn that the rows are no longer pure name/SKU matches');
    assert.doesNotMatch(doc, /the literal-substring search the dropdown uses/,
        'the dropdown does not use this — that claim is what rotted');
});

test('§6 nothing in the storefront calls /api/search/autocomplete', () => {
    // Re-verified 2026-08-04. The backend widened it too; it reaches no code
    // here, and that is deliberate (thin-frontend audit, Bucket B).
    assert.doesNotMatch(API_CODE, /search\/autocomplete/);
    assert.doesNotMatch(SEARCH_CODE, /search\/autocomplete/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  The dropdown keyboard-order defect, fixed alongside
// ─────────────────────────────────────────────────────────────────────────────

test('§7 state.results holds the RENDERED order, not the raw API array', () => {
    // setActive(i) highlights DOM card i; the Enter handler navigates to
    // state.results[i]. The cards are emitted after the compatible/genuine
    // partition AND byCodeThenColor, so a raw-array state.results meant
    // arrowing to a card and pressing Enter opened a different product.
    const body = blockBodyAt(SEARCH_CODE, 'function renderResults');
    assert.ok(body, 'renderResults must exist');
    assert.match(body, /const\s+renderedOrder\s*=\s*\[\]/);
    assert.match(body, /renderedOrder\.push\(p\)/,
        'each row must be recorded as its card is emitted');
    assert.match(body, /state\.results\s*=\s*renderedOrder/,
        'and the keyboard handler must index that same order');

    const iSections = body.indexOf('const sectionsHTML');
    const iAssign = body.indexOf('state.results = renderedOrder');
    assert.ok(iSections !== -1 && iAssign > iSections,
        'the assignment must come after both sections have been rendered');
});

test('§7 the push happens inside the sorted map, not over the unsorted input', () => {
    const section = blockBodyAt(SEARCH_CODE, 'const renderSection =');
    assert.ok(section);
    const iSorted = section.indexOf('sorted.map');
    const iPush = section.indexOf('renderedOrder.push');
    assert.ok(iSorted !== -1 && iPush > iSorted,
        'pushing before the sort would reproduce the very mismatch this fixes');
});

test('§7 the dead [data-sku-text] highlight selector is gone', () => {
    // It matched zero elements on every render — Products.renderCard exposes
    // the SKU only as a data-sku ATTRIBUTE, with no SKU text node to mark.
    // Dead code that reads as working code.
    assert.doesNotMatch(SEARCH_CODE, /data-sku-text/,
        'remove the selector or emit the attribute — do not ship one without the other');
    assert.match(SEARCH_CODE, /\.smart-ac__grid \.product-card__title/,
        'title highlighting must still run');
});
