/**
 * Lexmark / OKI chip grouping — the frontend half (Sep 2026, ERR-216)
 * ===================================================================
 *
 * The backend collapsed Lexmark's product-code chips from 308 to 83 and OKI's
 * from 73 to 70, rewriting `series_codes` from full MPNs ("20N3HK0") to platform
 * stems ("20"). Its hand-off opened with "there is nothing to build".
 *
 * There was. Two things, and the first is the one that matters.
 *
 *   1. THE EXTRACTOR REJECTED THE BACKEND'S OWN DATA. `extractProductCodes`
 *      PRIORITY 0 said, in a comment, "Trust backend-supplied series_codes (the
 *      only path now)" — and then ran every entry through `normalizeCode()`, a
 *      per-brand SKU/name GRAMMAR that returns null for anything not shaped like
 *      a SKU. Measured against the live catalogue on 2026-09-06 it rejected
 *      **162 of 713 distinct series_codes across nine brands**, including
 *      **20 of 20 sampled Lexmark stems** and OKI's `711` and `332DN`.
 *      THE COMMENT AND THE CODE DISAGREED, AND THE CODE WON.
 *
 *      The "defensive SKU sweep" below it could not make up the difference.
 *      Measured on real SKU shapes, that sweep is very nearly INERT: its regex
 *      is `\b`-anchored, and every live SKU carries a genuine/compatible marker
 *      (`G20N3HK0BK`, `CLC3339BK`), so there is no word boundary where the code
 *      begins. Of eight brand/SKU shapes tested, seven derived NOTHING; the one
 *      that fired (OKI `CB412BK`) derived `CB412` — the compatible marker glued
 *      onto the code, which is not a real chip either.
 *
 *      So the degraded path's actual output for Lexmark was NOTHING AT ALL: a
 *      /api/shop failure produced an EMPTY chip grid under "no products found"
 *      copy, with the catalogue perfectly healthy behind it. That is ERR-193's
 *      shape exactly — a failed read printing empty-shelf copy — and the only
 *      reason it has not been seen yet is that /api/shop has not failed since
 *      the backend deployed on 2026-09-03.
 *
 *   2. RETIRED CODES OUTLIVED THEIR CHIPS. `?code=20N3HK0` still resolves (the
 *      backend collapses the input) but to a SUBSET — 3 products where the `20`
 *      chip shows 18 — while the breadcrumb, <title> and canonical all kept
 *      saying "20N3HK0", a code that appears nowhere in the grid on screen.
 *
 * What this file pins, in order of how badly it would hurt to lose:
 *
 *   §1 Backend codes survive PRIORITY 0 untouched — every live Lexmark and OKI
 *      stem, and the nine-brand rejection census that justifies the change.
 *   §2 The SKU sweep is GATED, not deleted. Both directions are tested: it must
 *      not fire when the backend supplied codes, and it MUST still fire when it
 *      did not. A gate that became a deletion is the ERR-158 failure.
 *   §3 The retired-code adoption is SELF-DISABLING. Four separate ways it must
 *      decline, each tested, plus the one case where it must act.
 *   §4 Chip labels are escaped and counts are honest.
 *   §5 Source wiring — the fix is actually called, not merely present.
 *
 * Run with: node --test tests/lexmark-chip-grouping-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const read = (p) => fs.readFileSync(p, 'utf8');

// stripComments now has ONE owner (ERR-253). Every test file used to carry its
// own two-regex copy that removed block comments first, so a line comment
// containing a starred path silently deleted live code — 22,251 characters of
// it across 35 suites. See tests/helpers/strip-comments.js.
const stripComments = require('./helpers/strip-comments');

const SHOP_SRC = read(JS('shop-page.js'));
const SHOP_CODE = stripComments(SHOP_SRC);
const UTILS_SRC = read(JS('utils.js'));
const UTILS_CODE = stripComments(UTILS_SRC);
const CSS_SRC = read(path.join(ROOT, 'inkcartridges', 'css', 'admin.css'));
const PRODUCTS_SRC = read(JS(path.join('admin', 'pages', 'products.js')));
const PRODUCTS_CODE = stripComments(PRODUCTS_SRC);
const PKG = JSON.parse(read(path.join(ROOT, 'package.json')));

// ─────────────────────────────────────────────────────────────────────────────
// Harness — lift the real methods out of the shipped file.
//
// Extracted, never re-implemented. A test that carries its own copy of the
// derivation proves only that the copy works (ERR-186: keep a positive control,
// and never let the test become the thing under test).
// ─────────────────────────────────────────────────────────────────────────────

/** Pull one object-literal method out of shop-page.js by name and eval it. */
function methodFromShopPage(name, extraScope = {}) {
    const lines = SHOP_SRC.split('\n');
    const idx = lines.findIndex(l => new RegExp(`^\\s{8}${name}\\(`).test(l));
    assert.notEqual(idx, -1, `${name} must exist in shop-page.js`);
    const start = lines.slice(0, idx).join('\n').length + 1;
    let depth = 0, end = -1;
    for (let j = SHOP_SRC.indexOf('{', start); j < SHOP_SRC.length; j++) {
        if (SHOP_SRC[j] === '{') depth++;
        else if (SHOP_SRC[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    assert.notEqual(end, -1, `${name} must be brace-balanced`);
    const body = SHOP_SRC.slice(start, end + 1).replace(/^\s*/, '');
    const sandbox = { console, DebugLog: { warn() {}, error() {}, log() {} }, ...extraScope };
    vm.createContext(sandbox);
    return vm.runInContext(`({${body}})`, sandbox);
}

/** The real SeriesCodes IIFE from utils.js. */
function loadSeriesCodes() {
    const start = UTILS_SRC.indexOf('const SeriesCodes = (function () {');
    assert.notEqual(start, -1, 'SeriesCodes IIFE must exist in utils.js');
    const tail = UTILS_SRC.slice(start);
    const endMarker = tail.indexOf('\n})();');
    assert.notEqual(endMarker, -1, 'SeriesCodes IIFE must be closed');
    const src = tail.slice(0, endMarker + '\n})();'.length);
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(src + '\nglobalThis.__SC = SeriesCodes;', sandbox);
    return sandbox.__SC;
}

const SeriesCodes = loadSeriesCodes();

/** extractProductCodes, wired to the real SeriesCodes, for a given brand. */
function extractorFor(brand) {
    const win = { SeriesCodes };
    const obj = methodFromShopPage('extractProductCodes', { window: win });
    // normalizeCode + the per-brand patterns live on the same object literal in
    // the shipped file; pull them in so the SKU sweep is the real one.
    const nc = methodFromShopPage('normalizeCode');
    const host = {
        state: { brand },
        normalizeCode: nc.normalizeCode,
        extractProductCodes: obj.extractProductCodes,
    };
    return (products) => host.extractProductCodes(products);
}

/**
 * Copy a value out of the vm realm.
 *
 * The extractor runs inside vm.createContext, so the arrays it returns carry the
 * SANDBOX's Array.prototype. assert.deepEqual compares prototypes, so a correct
 * ['10'] fails against a correct ['10']. Crossing the realm explicitly is the fix;
 * loosening the assertion would have hidden real shape errors too.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The chip codes an extractor produced, as a test-realm array of strings. */
const codesOf = (out) => plain(out).map(c => c.code);

/** _backendStemFor, wired to the real SeriesCodes. */
function stemFinder() {
    const obj = methodFromShopPage('_backendStemFor', { window: { SeriesCodes } });
    return (products, code) => obj._backendStemFor(products, code);
}

// The live chip vocabulary, captured 2026-09-06 from
//   GET /api/products/series?brand=lexmark   (83 chips)
//   GET /api/products/series?brand=oki       (69 chips)
// These are the exact strings the backend emits. Every one of them was rejected
// or accepted by the old grammar; all of them must survive the new one.
const LEXMARK_STEMS = [
    '10', '12', '20', '24', '25', '26', '34', '41', '54', '55', '56', '58', '63',
    '64', '66', '70', '71', '72', '73', '74', '75', '76', '77', '78', '79', '80',
    '81', '82', '83', '84', '86', '500Z', '503', '520Z', '523', '603', '623',
    '700', '708', '808', '4227', 'B220', 'B226', 'B236', 'B246', 'B346', 'C236',
    'C323', 'C333', 'C343', 'C500', 'C520', 'C524', 'C540', 'C544', 'C734',
    'C736', 'C746', 'C748', 'C780', 'C792', 'C925', 'C930', 'C950', 'E250',
    'E260', 'E360', 'E450', 'E460', 'T650', 'T654', 'W850', 'X203', 'X264',
    'X463', 'X644', 'X651', 'X654', 'X746', 'X792', 'X860', 'X945', 'X950',
];
const OKI_STEMS = [
    '711', '332DN', 'C710', 'C711', 'C332', 'C301', 'C310', 'C510', 'B412',
    'B432', 'B512', 'MC853', 'MC363', '5950', '3K', 'ML182', 'ML590', '720',
];

// ═════════════════════════════════════════════════════════════════════════════
// §1 — BACKEND CODES SURVIVE PRIORITY 0
// ═════════════════════════════════════════════════════════════════════════════

test('§1a every live Lexmark stem survives extraction', () => {
    const extract = extractorFor('lexmark');
    for (const stem of LEXMARK_STEMS) {
        const out = extract([{ id: stem, sku: '', series_codes: [stem] }]);
        assert.deepEqual(codesOf(out), [stem],
            `Lexmark stem "${stem}" must produce exactly its own chip`);
    }
});

test('§1b every live OKI stem survives extraction', () => {
    const extract = extractorFor('oki');
    for (const stem of OKI_STEMS) {
        const out = extract([{ id: stem, sku: '', series_codes: [stem] }]);
        assert.deepEqual(codesOf(out), [stem],
            `OKI stem "${stem}" must produce exactly its own chip`);
    }
});

test('§1c the nine-brand census: no live code is rejected any more', () => {
    // A sample from each brand's live series_codes that the OLD grammar
    // rejected outright. This is the measurement that justified the change —
    // it is pinned so nobody "restores" normalizeCode believing the damage was
    // Lexmark-only. Brother's colour strip, the old rule's stated reason,
    // changed ZERO codes.
    const census = {
        brother: ['BP60', 'CZ100', 'DKN55224', 'HSE211'],
        canon: ['CI16', 'CI3', 'CI6', '051', 'A3'],
        epson: ['DFX9000', 'LQ2070', 'LQ690'],
        hp: ['EP32', 'CC53', 'CART318', 'CE41'],
        lexmark: ['20', '41', '503', 'C236'],
        oki: ['5950', '3K', '332DN', '711', 'ML182'],
        samsung: ['CLT406', 'CLT506', 'CLT806'],
        'fuji-xerox': ['CT200', 'CT2006', 'CT201'],
    };
    for (const [brand, codes] of Object.entries(census)) {
        const extract = extractorFor(brand);
        for (const c of codes) {
            const out = extract([{ id: c, sku: '', series_codes: [c] }]);
            assert.deepEqual(codesOf(out), [c],
                `${brand} code "${c}" was dropped by the old grammar and must now survive`);
        }
    }
});

test('§1d Epson S015336/S015337 no longer collapse into a code belonging to neither', () => {
    // The old grammar mapped BOTH to "S01533" — two different products' codes
    // merged into one that is not either of them. Destructive, and silent.
    const extract = extractorFor('epson');
    const out = extract([
        { id: 'a', sku: '', series_codes: ['S015336'] },
        { id: 'b', sku: '', series_codes: ['S015337'] },
    ]);
    const codes = codesOf(out).sort();
    assert.deepEqual(codes, ['S015336', 'S015337'],
        'the two Epson ribbon codes must stay distinct');
    assert.ok(!codes.includes('S01533'), 'the merged phantom code must not appear');
});

test('§1e case and whitespace are still canonicalised', () => {
    const extract = extractorFor('lexmark');
    const out = extract([{ id: '1', sku: '', series_codes: ['  c236  ', 'C-236'] }]);
    assert.deepEqual(codesOf(out), ['C236'],
        'spelling variants of one code must land on one chip');
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — THE SKU SWEEP IS GATED, NOT DELETED
// ═════════════════════════════════════════════════════════════════════════════

test('§2a THE REGRESSION PIN: a backend stem must not be joined by its own retired MPN', () => {
    // The stem must come through alone. Before the fix this returned [] — the
    // stem was rejected by normalizeCode and the sweep could not replace it —
    // and the gate now also guarantees that a future widening of the sweep
    // (see §2e) can never bolt the retired MPN back on beside the stem.
    const extract = extractorFor('lexmark');
    const out = extract([{ id: '1', sku: 'G20N3HK0BK', series_codes: ['20'] }]);
    assert.deepEqual(codesOf(out), ['20'],
        'the SKU sweep must not add 20N3HK0 beside the backend stem 20');
});

test('§2b the same, across a whole family — the 308-chip grid must not come back', () => {
    const extract = extractorFor('lexmark');
    const family = [
        'G20N3HK0BK', 'G20N3HC0C', 'G20N3HM0M', 'G20N3HY0Y',
        'G20N3XK0BK', 'G20N3XC0C', 'G20N30K0BK', 'G20N30C0C',
    ].map((sku, i) => ({ id: String(i), sku, series_codes: ['20'] }));
    const out = extract(family);
    assert.deepEqual(codesOf(out), ['20'],
        'eight MPNs filed under one stem must render exactly one chip');
    assert.equal(plain(out)[0].count, 8, 'and that chip must count all eight');
});

test('§2c POSITIVE CONTROL: the safety net still fires when the backend sent nothing', () => {
    // If this fails, the gate became a deletion — the ERR-158 failure, where
    // "upgrade silent to loud" was mistaken for "remove". A product that really
    // does arrive without series_codes must still reach the sweep.
    //
    // The SKU here is deliberately UNPREFIXED. See §2f: the sweep's regex is
    // \b-anchored and cannot see past a G/C marker, so a bare MPN is the only
    // shape that demonstrates the net is still connected.
    const extract = extractorFor('lexmark');
    const out = extract([{ id: '1', sku: '20N3HK0', series_codes: [] }]);
    assert.deepEqual(codesOf(out), ['20N3HK0'],
        'with no backend codes, the SKU sweep must still derive a chip');
});

test('§2d POSITIVE CONTROL: the net fires for a missing series_codes key too', () => {
    const extract = extractorFor('lexmark');
    const out = extract([{ id: '1', sku: '20N3HK0' }]);
    assert.deepEqual(codesOf(out), ['20N3HK0'],
        'absent (not merely empty) series_codes must also reach the safety net');
});

test('§2e MEASURED LIMIT: the sweep is inert on real, prefixed SKUs', () => {
    // Recorded, not fixed. This is the reason the degraded Lexmark grid came out
    // EMPTY rather than wrong, and it is why gating the sweep costs almost
    // nothing. Pinning it means the next person to reason about the fallback
    // starts from the measurement instead of from the comment above it, which
    // calls the sweep a safety net without saying how little it catches.
    //
    // Widening the regex to fix this is NOT a free win: it would start deriving
    // codes for every product on the degraded path, and the phantom chips that
    // motivated the May 2026 thin-extractor work (LC37LC57, IB3757) came from
    // exactly that kind of widening. Leave it narrow; the backend is the source.
    for (const [brand, sku] of [
        ['brother', 'GLC3339BK'], ['canon', 'GPGI680BK'], ['epson', 'G604BK'],
        ['hp', 'G953XLBK'], ['lexmark', 'G20N3HK0BK'], ['kyocera', 'GTK5244BK'],
    ]) {
        const out = extractorFor(brand)([{ id: '1', sku, series_codes: [] }]);
        assert.deepEqual(codesOf(out), [],
            `${brand} "${sku}" derives nothing — the \b anchor cannot pass the G/C marker`);
    }
    // The single brand where it does fire produces a malformed code: the
    // compatible marker is read as part of the code (C + B412).
    const oki = extractorFor('oki')([{ id: '1', sku: 'CB412BK', series_codes: [] }]);
    assert.deepEqual(codesOf(oki), ['CB412'],
        'OKI is the exception, and what it derives is the marker glued to the code');
});

test('§2f the HP numeric-vs-OEM tie-break is still present', () => {
    // Asserted at the source, not behaviourally: §2e shows the SKU sweep cannot
    // be driven with a realistic HP SKU, so a behavioural test here would pass
    // by matching nothing — the ERR-186 "passes for the wrong reason" trap.
    assert.match(SHOP_CODE, /brand === 'hp' && foundCodes\.size > 1/,
        'the HP tie-break must still exist');
    assert.match(SHOP_CODE, /numericCodes/,
        'and must still prefer the numeric series over the OEM part number');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — RETIRED-CODE ADOPTION IS SELF-DISABLING
// ═════════════════════════════════════════════════════════════════════════════

test('§3a adopts the stem when the requested code is no longer a member', () => {
    const stemFor = stemFinder();
    const rows = [
        { sku: 'G20N3HK0BK', series_codes: ['20'] },
        { sku: 'C20N3HK0BK', series_codes: ['20'] },
    ];
    assert.equal(stemFor(rows, '20N3HK0'), '20');
});

test('§3b DECLINES when the requested code is still a member (OKI 711)', () => {
    // Live shape: ?code=711 returns rows filed under BOTH C710 and 711. The
    // requested code is present, so nothing is retired and nothing is rewritten.
    const stemFor = stemFinder();
    const rows = [
        { sku: 'x', series_codes: ['C710', '711'] },
        { sku: 'y', series_codes: ['C710', '711'] },
    ];
    assert.equal(stemFor(rows, '711'), null,
        'a code the rows still carry must never be rewritten');
});

test('§3c DECLINES when the rows share no single stem', () => {
    const stemFor = stemFinder();
    const rows = [
        { sku: 'x', series_codes: ['C332'] },
        { sku: 'y', series_codes: ['MC363'] },
    ];
    assert.equal(stemFor(rows, 'RETIRED'), null,
        'ambiguity must resolve to leaving the URL alone');
});

test('§3d DECLINES when any row carries no codes at all', () => {
    const stemFor = stemFinder();
    const rows = [
        { sku: 'x', series_codes: ['20'] },
        { sku: 'y', series_codes: [] },
    ];
    assert.equal(stemFor(rows, '20N3HK0'), null,
        'a row we cannot place must veto the rewrite');
});

test('§3e DECLINES for every brand the backend did not touch', () => {
    const stemFor = stemFinder();
    for (const code of ['LC133', 'PGI650', 'T312', '62', 'TN253']) {
        const rows = [{ sku: 'x', series_codes: [code] }];
        assert.equal(stemFor(rows, code), null,
            `${code} is still its own family — nothing to adopt`);
    }
});

test('§3f DECLINES on an empty result set (nothing to learn from)', () => {
    const stemFor = stemFinder();
    assert.equal(stemFor([], '20N3HK0'), null);
    assert.equal(stemFor(null, '20N3HK0'), null);
});

test('§3g the adoption is a REPLACE, never a push — Back must not trap', () => {
    const block = /ERR-216 — a link written before[\s\S]*?\n                }\n/.exec(SHOP_SRC);
    assert.ok(block, 'the adoption block must exist');
    assert.match(block[0], /history\.replaceState\(/,
        'correcting the address the visitor arrived on must not add a history entry');
    assert.doesNotMatch(block[0], /history\.pushState\(/,
        'a pushState here would trap Back on the retired code');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — CHIP LABELS ARE ESCAPED, COUNTS ARE HONEST
// ═════════════════════════════════════════════════════════════════════════════

test('§4a the chip label goes through Security.escapeHtml', () => {
    const render = /renderProductCodes\(codes\) \{[\s\S]*?\n        \},/.exec(SHOP_CODE);
    assert.ok(render, 'renderProductCodes must exist');
    assert.match(render[0], /Security\.escapeHtml\(label\)/,
        'the chip label must be escaped before reaching innerHTML');
    assert.doesNotMatch(render[0], /\$\{\s*count\s*\}/,
        'the raw count must not be interpolated any more');
});

test('§4b Security is referenced directly, not through window (ERR-167)', () => {
    const render = /renderProductCodes\(codes\) \{[\s\S]*?\n        \},/.exec(SHOP_CODE);
    assert.doesNotMatch(render[0], /window\.Security/,
        'window.Security does not exist — such a guard would be an off switch');
});

test('§4c an absent or zero count renders nothing, not "undefined product"', () => {
    const render = /renderProductCodes\(codes\) \{[\s\S]*?\n        \},/.exec(SHOP_CODE);
    assert.match(render[0], /Number\.isFinite\(n\)\s*&&\s*n\s*>\s*0/,
        'the count must be proven finite and positive before it is shown');
});

test('§4d one product reads "1 product", two read "2 products"', () => {
    const render = /renderProductCodes\(codes\) \{[\s\S]*?\n        \},/.exec(SHOP_CODE);
    assert.match(render[0], /n === 1 \? '' : 's'/,
        'pluralisation must key off the real number');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — SOURCE WIRING: THE FIX IS CALLED, NOT MERELY PRESENT
// ═════════════════════════════════════════════════════════════════════════════

test('§5a SeriesCodes exports normalize', () => {
    assert.ok(typeof SeriesCodes.normalize === 'function',
        'normalize must be on the exported object, not private to the IIFE');
    assert.equal(SeriesCodes.normalize('  c-236 '), 'C236');
    assert.equal(SeriesCodes.normalize('20'), '20',
        'normalize must never reject a code the backend emitted');
});

test('§5b normalize does NOT collapse yield suffixes (that is collapseChipList\'s job)', () => {
    assert.equal(SeriesCodes.normalize('604XL'), '604XL',
        'one function, one question — normalize canonicalises case and nothing else');
    assert.equal(SeriesCodes.collapseYieldSuffix('604XL'), '604');
});

test('§5c the degraded chip path announces itself', () => {
    assert.match(SHOP_CODE, /_chipsDerivedFrom\s*=\s*'client-extraction'/,
        'the fallback must record that chips are derived, not authoritative');
    assert.match(SHOP_CODE, /_chipsDerivedFrom\s*=\s*'backend'/,
        'and the healthy path must record that they are');
    assert.match(SHOP_CODE, /chip grid falls back to/,
        'losing the authoritative chip source must be logged, not silent');
});

test('§5c2 a THROWN /api/shop is treated as unavailable, not as a page error', () => {
    // API.request() has two failure shapes — it RETURNS { ok: false } for a
    // structured error and THROWS for a network failure or a non-JSON body
    // (ERR-188's split). Only the returned shape used to reach the fallback, so
    // on the commonest failure of all the throw escaped to the outer catch and
    // the client-side chip path never ran. Verified in a browser: before this,
    // aborting /api/shop gave "No products found" on a healthy catalogue; after,
    // it gives the same 74 stem chips the healthy path gives.
    const block = /let response;[\s\S]{0,700}?if \(response\.ok && response\.data\?\.series\)/.exec(SHOP_CODE);
    assert.ok(block, 'the getShopData call must be wrapped');
    assert.match(block[0], /catch \(shopErr\)/,
        'a throw from getShopData must be caught here, not by the outer handler');
    assert.match(block[0], /response = \{ ok: false/,
        'and normalised to the same shape the non-ok branch already handles');
});

test('§5d loadProducts actually calls the stem adoption', () => {
    assert.match(SHOP_CODE, /this\._backendStemFor\(mergedProducts,\s*this\.state\.code\)/,
        'the helper must be wired into loadProducts, not just defined');
});

test('§5e the admin drawer builds its code universe BEFORE seeding from the SKU', () => {
    // Ordering is the fix. Seeding first made "is this code live?" unanswerable.
    const universeAt = PRODUCTS_CODE.indexOf('const seen = new Map();');
    const seedAt = PRODUCTS_CODE.indexOf('partitionDerivedCodes(deriveSeed()');
    assert.ok(universeAt > -1 && seedAt > -1, 'both blocks must exist');
    assert.ok(universeAt < seedAt,
        'the live chip universe must be known before derived codes are judged against it');
});

test('§5f the admin drawer pre-ticks only codes the catalogue already has', () => {
    assert.match(PRODUCTS_CODE, /const \{ known, unknown \} = partitionDerivedCodes\(/,
        'derived codes must be partitioned');
    assert.match(PRODUCTS_CODE, /for \(const n of known\) selection\.set\(n, n\);/,
        'only known codes may be pre-ticked');
    assert.match(PRODUCTS_CODE, /unknownSeed = unknown;/,
        'unknown codes must be surfaced, not discarded');
});

test('§5g the unknown-code warning is styled as a caution, not a whisper', () => {
    assert.match(CSS_SRC, /\.admin-pc-seed-note--unknown\s*\{/,
        'the unknown-seed note needs its own rule');
    assert.match(PRODUCTS_SRC, /id="pc-unknown-seed"/,
        'and an element to render into');
});

test('§5h the probe is registered and read-only', () => {
    assert.ok(PKG.scripts['probe:chip-grouping'],
        'npm run probe:chip-grouping must exist');
    const probe = read(path.join(ROOT, 'scripts', 'probe-lexmark-chip-grouping.mjs'));
    // Strip comments FIRST. The header says, in prose, "there is no --record,
    // no --update-baseline" — and the naive check matched its own documentation
    // and failed. A source assertion that reads comments is testing the prose.
    const probeCode = stripComments(probe);
    assert.doesNotMatch(probeCode, /--record|--update-baseline/,
        'this probe must have no write path at all');
    assert.doesNotMatch(probeCode, /writeFileSync|appendFileSync|method:\s*'(POST|PATCH|PUT|DELETE)'/,
        'and no write verb of any kind');
    assert.match(probeCode, /MODE:/, 'and must print its mode on every run');
    // POSITIVE CONTROL: the stripper must not simply be blanking the file.
    assert.match(probeCode, /process\.exit\(2\)/,
        'the could-not-look exit must survive comment-stripping');
});
