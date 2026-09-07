/**
 * Value packs in the header search dropdown — ERR-222 / ERR-226 / BF-057
 * ======================================================================
 *
 * WHAT BROKE
 *
 * A customer typed `lc`. The dropdown offered "Did you mean LC3333KCMY …
 * KCMY 4-Pack?" and then painted a grid row containing only the four singles.
 * The row is designed to be six cards wide — BK C M Y CMY KCMY — and it painted
 * four. It was first reported as "the search bar looks lop-sided".
 *
 * `/api/search/smart` was using `pack_type` as its PRIMARY sort key, so for
 * q=lc it returned all 238 singles at ranks 1-238 and all 129 value packs at
 * 239-367. The dropdown asks for 40 rows and never paginates. Every multi-pack
 * in the catalogue was invisible in typeahead for any query returning more than
 * 40 rows — which is every query while the customer is still typing.
 *
 * The backend fixed the ranking on 2026-09-06 (family-cohesive: a family is
 * ranked by its best-scoring member and its rows are emitted together). Live
 * verification and the standing alarm on that fix live in
 * `npm run probe:search-packs` — that is a DATA question and cannot be a test.
 *
 * WHAT THIS FILE PINS — the frontend half, which is a CODE question
 *
 *   §1 The dropdown paints a complete family row from the new interleaved
 *      send order, with packs at the TAIL, and no row break inside the family.
 *   §2 Genuine and compatible arriving interleaved still partition into two
 *      sections, and the render stays length-preserving.
 *   §3 The did-you-mean rule is SHARED, not copied (ERR-226).
 *   §4 The dropdown suppresses a contradicted suggestion — and, in the other
 *      direction, still shows a real one. A suppression test that only tests
 *      suppression passes for the wrong reason (ERR-181/183).
 *   §5 A colourless cartridge collapses to the unknown-single rank. The
 *      backend shipped this endpoint without SELECTing `color` for months and
 *      every unit test stayed green because they build rows by hand.
 *
 * Run with: node --test tests/search-value-pack-ranking-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const SEARCH_JS = READ('js/search.js');
const SHOP_JS = READ('js/shop-page.js');
const UTILS_JS = READ('js/utils.js');

// Evaluate the SHIPPED utils.js and read its own CommonJS export block. Its
// modules are `const` at script top level, which in a vm is lexical scope and
// not a sandbox global — so reading the exports is both what works and what the
// browser-side `window.X =` lines mirror.
function loadUtils() {
    const sandbox = { console, module: { exports: {} } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(UTILS_JS, sandbox);
    return sandbox.module.exports;
}
const { ProductSort, SearchMatch } = loadUtils();

// A row shaped like /api/search/smart actually sends one.
const row = (sku, name, color, packType, source) => ({
    id: sku, sku, name, color,
    pack_type: packType, source,
    series_codes: ['LC3333'],
    product_type: 'ink', category: 'ink',
});

// The live q=lc page-1 window, ranks 1-12, in the order the backend now sends
// it: family-cohesive, genuine and compatible INTERLEAVED. Captured 2026-09-07.
const LC3333_AS_SENT = [
    row('CLC3333BK',   'LC3333BK Compatible Ink Cartridge for Brother LC3333 Black',        'Black',   'single',     'compatible'),
    row('GLC3333BK',   'Brother Genuine LC3333BK Ink Cartridge LC3333 Black',               'Black',   'single',     'genuine'),
    row('CLC3333C',    'LC3333C Compatible Ink Cartridge for Brother LC3333 Cyan',          'Cyan',    'single',     'compatible'),
    row('GLC3333C',    'Brother Genuine LC3333C Ink Cartridge LC3333 Cyan',                 'Cyan',    'single',     'genuine'),
    row('CLC3333M',    'LC3333M Compatible Ink Cartridge for Brother LC3333 Magenta',       'Magenta', 'single',     'compatible'),
    row('GLC3333M',    'Brother Genuine LC3333M Ink Cartridge LC3333 Magenta',              'Magenta', 'single',     'genuine'),
    row('CLC3333Y',    'LC3333Y Compatible Ink Cartridge for Brother LC3333 Yellow',        'Yellow',  'single',     'compatible'),
    row('GLC3333Y',    'Brother Genuine LC3333Y Ink Cartridge LC3333 Yellow',               'Yellow',  'single',     'genuine'),
    row('CLC3333CMY',  'LC3333CMY Compatible Ink Cartridge for Brother LC3333 CMY 3-Pack',  'CMY',     'value_pack', 'compatible'),
    row('GLC3333CMY',  'Brother Genuine LC3333CMY Ink Cartridge LC3333 CMY 3-Pack',         'CMY',     'value_pack', 'genuine'),
    row('CLC3333KCMY', 'LC3333KCMY Compatible Ink Cartridge for Brother LC3333 KCMY 4-Pack', 'KCMY',   'value_pack', 'compatible'),
    row('GLC3333KCMY', 'Brother Genuine LC3333KCMY Ink Cartridge LC3333 KCMY 4-Pack',       'KCMY',    'value_pack', 'genuine'),
];

// ---------------------------------------------------------------------------
// §1 — the six-card row
// ---------------------------------------------------------------------------

test('§1 a family arriving interleaved sorts into K→C→M→Y→CMY→KCMY, packs at the tail', () => {
    const compatible = LC3333_AS_SENT.filter(p => p.source === 'compatible');
    const sorted = ProductSort.byCodeThenColor(compatible);
    assert.deepEqual(
        sorted.map(p => p.sku),
        ['CLC3333BK', 'CLC3333C', 'CLC3333M', 'CLC3333Y', 'CLC3333CMY', 'CLC3333KCMY'],
        'this is the six-card row the dropdown grid is designed around'
    );
    // The documented ranks: singles 0-3, CMY 20, KCMY 21.
    assert.deepEqual(sorted.map(p => ProductSort.colorOrder(p)), [0, 1, 2, 3, 20, 21]);
});

test('§1 the packs do NOT break onto a row of their own', () => {
    // packs share their singles' familyKey, accessoryTier and yieldTier, so the
    // family is one segment. If a break ever appeared here, the 4-pack would be
    // pushed onto its own line and the "lop-sided" report would come straight
    // back with a different cause.
    const sorted = ProductSort.byCodeThenColor(LC3333_AS_SENT.filter(p => p.source === 'compatible'));
    // Array.from is load-bearing: rowBreakIndices builds its array INSIDE the
    // vm sandbox, so it carries that realm's Array.prototype and
    // deepStrictEqual([], []) fails on the prototype alone. (byCodeThenColor
    // does not hit this — it slices the array we passed in, so the result stays
    // in this realm.)
    assert.deepEqual(Array.from(ProductSort.rowBreakIndices(sorted)), [],
        'CMY/KCMY extend the family row; they do not start a new one');
    const keys = new Set(sorted.map(p => ProductSort.familyKey(p)));
    assert.equal(keys.size, 1, 'the 4-pack shares its singles\' family — that is what keeps them on one row');
});

test('§1 a value pack is not demoted by packRank into looking like a single', () => {
    // packRank returns 0 for ANYTHING it does not recognise, i.e. "single".
    // A renamed pack_type would silently demote every pack — which is why the
    // probe pins the vocabulary against the live API too.
    assert.equal(ProductSort.packRank({ pack_type: 'single' }), 0);
    assert.equal(ProductSort.packRank({ pack_type: 'value_pack' }), 1);
    assert.equal(ProductSort.packRank({ pack_type: 'multipack' }), 2);
    assert.equal(ProductSort.packRank({ pack_type: 'bundle' }), 0,
        'an unknown spelling reads as a single — the failure mode a vocabulary change would take');
});

// ---------------------------------------------------------------------------
// §2 — the partition survives interleaving
// ---------------------------------------------------------------------------

test('§2 interleaved genuine/compatible still partitions into two complete sections', () => {
    const { BrandSource } = loadUtils();
    const isCompatible = (p) => BrandSource.isCompatible(p);
    const compatible = LC3333_AS_SENT.filter(isCompatible);
    const genuine = LC3333_AS_SENT.filter(p => !isCompatible(p));

    assert.equal(compatible.length, 6, 'the compatible row is six cards');
    assert.equal(genuine.length, 6, 'the genuine row is six cards');
    assert.equal(compatible.length + genuine.length, LC3333_AS_SENT.length,
        'the two predicates are exact complements — the render is length-preserving, and the '
        + 'keyboard handler\'s `count` depends on it (search.js state.results ⇄ DOM contract)');
});

test('§2 search.js partitions with two filters, so send order cannot matter', () => {
    // The backend changed send order from "all compatible, then all genuine" to
    // interleaved. A partition built from .filter() is order-agnostic; one built
    // from a findIndex boundary would not have been.
    assert.match(SEARCH_JS, /const compatibleItems = list\.filter\(isCompatibleProduct\);/);
    assert.match(SEARCH_JS, /const genuineItems = list\.filter\(\(p\) => !isCompatibleProduct\(p\)\);/);
});

// ---------------------------------------------------------------------------
// §3 — one rule, one home (ERR-226)
// ---------------------------------------------------------------------------

test('§3 SearchMatch is defined exactly once, in utils.js', () => {
    assert.equal(typeof SearchMatch.productMatchesQuery, 'function');
    assert.equal(typeof SearchMatch.normalizeForMatch, 'function');
    assert.equal(typeof SearchMatch.shouldShowCorrection, 'function');
    assert.match(UTILS_JS, /window\.SearchMatch = SearchMatch;/,
        'must be on window — search.js reads it as a global on 34 pages');
});

test('§3 neither shop-page.js nor search.js keeps a private copy of the rule', () => {
    // ERR-150/160: "every surface calls X" is a list nobody maintains, so the
    // enrolment lives in a test. A second copy is a second vocabulary, and a
    // second vocabulary drifts.
    for (const [label, src] of [['shop-page.js', SHOP_JS], ['search.js', SEARCH_JS]]) {
        assert.doesNotMatch(src, /function\s+productMatchesQuery\s*\(/,
            `${label} must call SearchMatch, not redefine productMatchesQuery`);
        assert.doesNotMatch(src, /function\s+normalizeForMatch\s*\(/,
            `${label} must call SearchMatch, not redefine normalizeForMatch`);
    }
    assert.match(SHOP_JS, /SearchMatch\.productMatchesQuery\(/, 'shop-page.js delegates to the shared rule');
    assert.match(SEARCH_JS, /SearchMatch\.shouldShowCorrection\(/, 'search.js delegates to the shared rule');
});

test('§3 search.js calls SearchMatch directly — no window?. guard (ERR-167)', () => {
    // utils.js is on 41 pages, a strict superset of search.js's 34 (asserted
    // below). A `window.SearchMatch?.x ? … : fallback` would run its fallback on
    // 33 of 34 pages: when the fallback is the only branch that ever runs, the
    // guard IS the bug.
    // Check the CODE, not the prose. search.js's own comment spells out the
    // guard it is refusing to use, and the first version of this assertion
    // matched that sentence and failed — a test reading a comment as if it were
    // behaviour is the same mistake as ERR-216, in miniature.
    const code = SEARCH_JS
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /window\.SearchMatch/,
        'reference SearchMatch directly, the way ProductSort and BrandSource already are');
});

test('§3 every page that loads search.js also loads utils.js', () => {
    // The enrolment this whole design rests on. ERR-214 is what happens when a
    // runtime is enrolled by hand and ten pages are missed.
    const htmlFiles = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.html')) htmlFiles.push(full);
        }
    })(path.join(ROOT, 'inkcartridges'));

    const missing = [];
    let withSearch = 0;
    for (const f of htmlFiles) {
        const html = fs.readFileSync(f, 'utf8');
        if (!/js\/search\.js/.test(html)) continue;
        withSearch++;
        if (!/js\/utils\.js/.test(html)) missing.push(path.relative(ROOT, f));
    }
    assert.ok(withSearch > 30, `expected search.js on 30+ pages, found ${withSearch}`);
    assert.deepEqual(missing, [],
        'these pages load search.js without utils.js, so SearchMatch would be undefined there');
});

test('§3 shop-page.js re-exports the helpers as wrappers, not captured references', () => {
    // Every script in shop.html is `defer`, so they execute in document order —
    // and shop-page.js is listed BEFORE utils.js. Capturing SearchMatch at IIFE
    // time is a ReferenceError; calling it at call time is fine.
    assert.match(SHOP_JS, /const normalizeForMatch = \(s\) => SearchMatch\.normalizeForMatch\(s\);/);
    assert.match(SHOP_JS, /const productMatchesQuery = \(product, query\) => SearchMatch\.productMatchesQuery\(product, query\);/);
    const shopHtml = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'shop.html'), 'utf8');
    assert.ok(shopHtml.indexOf('js/shop-page.js') < shopHtml.indexOf('js/utils.js'),
        'if this ever flips, the wrapper indirection is still correct — but the comment explaining it is not');
});

// ---------------------------------------------------------------------------
// §4 — the rule itself, in BOTH directions
// ---------------------------------------------------------------------------

test('§4 a suggestion contradicted by the rows on screen is suppressed', () => {
    // The live q=lc case: did_you_mean names a product that IS on page 1, and
    // every row literally contains "lc". Offering to correct a query we honoured
    // is what made the dropdown and /search disagree on the same envelope.
    const dym = 'LC3333KCMY Compatible Ink Cartridge for Brother LC3333 KCMY 4-Pack';
    assert.equal(SearchMatch.shouldShowCorrection(dym, LC3333_AS_SENT, 'lc'), false);
});

test('§4 a real typo still gets its suggestion — the feature is not switched off', () => {
    // The live q=cannon case: nothing in the rows contains "cannon", so the
    // correction is the whole point. Without this assertion the test above
    // passes for a function that returns false unconditionally.
    const canonRows = [
        row('CPGI650BK', 'PGI650BK Compatible Ink Cartridge for Canon PGI650 Black', 'Black', 'single', 'compatible'),
        row('CCLI651C',  'CLI651C Compatible Ink Cartridge for Canon CLI651 Cyan',   'Cyan',  'single', 'compatible'),
    ];
    assert.equal(SearchMatch.shouldShowCorrection('Canon', canonRows, 'cannon'), true);
});

test('§4 a zero-result search keeps its suggestion', () => {
    assert.equal(SearchMatch.shouldShowCorrection('Canon', [], 'cannon'), true);
    assert.equal(SearchMatch.shouldShowCorrection('Canon', null, 'cannon'), true);
});

test('§4 no suggestion in, no suggestion out', () => {
    assert.equal(SearchMatch.shouldShowCorrection(null, LC3333_AS_SENT, 'lc'), false);
    assert.equal(SearchMatch.shouldShowCorrection('', LC3333_AS_SENT, 'lc'), false);
});

test('§4 shouldShowCorrection ignores matched_printer — that gate stays at the call site', () => {
    // The dropdown's zero-results branch shows a suggestion even when a printer
    // matched but its canonical URL could not be built. Folding matched_printer
    // into the shared rule would have silently changed that branch.
    assert.equal(SearchMatch.shouldShowCorrection.length, 3, 'signature is (suggestion, products, query)');
    assert.match(SEARCH_JS, /const dymRowHTML = didYouMean && !matchedPrinter/,
        'the results branch keeps its own matched_printer gate, exactly as before');
});

test('§4 search.js gates BOTH render sites off the shared decision', () => {
    // There are two: the results top-row and the zero-results inline button.
    // Gating only one would leave the incoherence on the emptier of the two.
    const fn = SEARCH_JS.slice(SEARCH_JS.indexOf('function renderResults('));
    assert.match(fn, /const rawDidYouMean = data && data\.did_you_mean;/,
        'the raw envelope value is kept separate from the decision');
    assert.match(fn, /\) \? rawDidYouMean : null;/);
    // Everything downstream reads the gated `didYouMean`, never the raw value.
    const MARKER = '? rawDidYouMean : null;';
    const afterDecision = fn.slice(fn.indexOf(MARKER) + MARKER.length);
    assert.doesNotMatch(afterDecision, /rawDidYouMean/,
        'nothing past the decision may reach around it to the raw suggestion');
    assert.match(afterDecision, /smart-ac__dym/, 'zero-results branch renders off the gated value');
    assert.match(afterDecision, /smart-ac__top-row--dym/, 'results branch renders off the gated value');
});

test('§4 the rule agrees with the results page it was taken from', () => {
    // shop-page.js drops the banner on the same condition, via the same helper.
    // If these two ever disagree again, it is because someone inlined one.
    assert.match(SHOP_JS, /smartData\.products\.some\(p => productMatchesQuery\(p, searchQuery\)\)/);
});

// ---------------------------------------------------------------------------
// §5 — the hazard the backend just fixed, owned on this side
// ---------------------------------------------------------------------------

test('§5 colorOrder falls back to the NAME, so a missing `color` is only sometimes fatal', () => {
    // The backend hydrated /api/search/smart's pool with `id, pack_type` and
    // never `color`, and its response says colorOrder therefore "returned the
    // unknown-single rank 19 for every single". MEASURED HERE, that is too
    // strong for our surface: colorOrder resolves the colour from the product
    // NAME before it gives up, and live catalogue names end in the colour word
    // ("… for Brother LC3333 Black"). The safety net absorbed most of it.
    //
    // That is worth knowing precisely, because it says where the real exposure
    // is — not "every single", but every single whose NAME carries no colour
    // word. Those are the ones that collapse into one indistinguishable bucket
    // and fall through to the name tiebreaker, looking plausible while wrong.
    const named = LC3333_AS_SENT
        .filter(p => p.pack_type === 'single' && p.source === 'compatible')
        .map(p => Object.assign({}, p, { color: undefined }));
    assert.deepEqual(named.map(p => ProductSort.colorOrder(p)), [0, 1, 2, 3],
        'the name fallback recovers K→C→M→Y even with color stripped');

    const unnamed = named.map(p => Object.assign({}, p, {
        name: p.name.replace(/ (Black|Cyan|Magenta|Yellow)$/, ''),
    }));
    assert.deepEqual(unnamed.map(p => ProductSort.colorOrder(p)), [19, 19, 19, 19],
        'with neither a color field nor a colour word in the name, every single collapses '
        + 'to RANK_UNKNOWN_SINGLE — this is the case the probe watches for on the live API');

    // The packs are never at risk: the pack-name regex runs first.
    const packs = LC3333_AS_SENT
        .filter(p => p.pack_type === 'value_pack' && p.source === 'compatible')
        .map(p => Object.assign({}, p, { color: undefined }));
    assert.deepEqual(packs.map(p => ProductSort.colorOrder(p)), [20, 21],
        'CMY/KCMY are recovered by PACK_NAME_REGEX before the colour lookup is reached');
});

test('§5 the live guard for that is the probe, and it is registered', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['probe:search-packs'], 'node scripts/probe-search-value-pack-ranking.mjs',
        'ERR-222 is a data question; the standing alarm has to be runnable by name');
});

test('§5 the probe has no write path — checked on code, not on its own promise', () => {
    // ERR-216's lesson: "trust the backend" in a comment, re-parsed on the next
    // line. This probe's header PROMISES it is read-only, and the promise is
    // what a naive grep would match. Strip the comments and check the code.
    const raw = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-search-value-pack-ranking.mjs'), 'utf8');
    const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, including the header
        .replace(/^\s*\/\/.*$/gm, '');       // line comments
    assert.doesNotMatch(code, /writeFileSync|appendFileSync|createWriteStream|mkdirSync|unlinkSync/,
        'a probe that can write is a probe that can pass by overwriting what it compared against '
        + '(sweep:b2b ate a committed fixture on 2026-08-12)');
    assert.doesNotMatch(code, /ARGS\.has\('--record'\)|ARGS\.has\('--update-baseline'\)/,
        'no record flag — the mode must not be switchable');
    assert.match(raw, /MODE: \\x1b\[1mREAD-ONLY/, 'and the mode is printed on every run');
});
