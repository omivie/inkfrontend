/**
 * Ribbon PDP related products — prefix-tolerant SKU resolution — July 2026
 * =======================================================================
 *
 * The bug (ERR-084)
 * -----------------
 * The "Products related to 307.11" section on the Canon AP800 ribbon PDP
 * rendered as a bare heading with no products. Its curated
 * `related_product_skus` were `["141LOT","143LOT"]`, but the real correction
 * tapes have SKUs `C141LOT` / `C143LOT` (leading "C"). renderRelatedProducts()
 * resolved the curated list with an EXACT `.in('sku', manualSkus)` and no
 * fallback, so the bare codes matched zero rows.
 *
 * Root cause: typewriter ribbons use bare numeric SKUs ("307.11") with no
 * prefix, so the related picker saved the tapes by their bare codes, dropping
 * the compatible-product "C" prefix. (The "02" product code was a red herring —
 * it drives /shop chips, and only 307.11 carries it.)
 *
 * The fix
 * -------
 * `relatedSkuCandidates(sku)` returns the exact sku first, then the two
 * conventional prefixed forms ("C"=compatible, "G"=genuine). The ribbon branch
 * queries the candidate union and resolves each entry exact-first, so
 * "141LOT" → C141LOT while a correctly-entered "C141LOT" still resolves to
 * itself. Matching stays strict SKU equality (a tiny candidate set), never a
 * fuzzy substring/ILIKE.
 *
 * Run: node --test tests/pdp-related-sku-prefix-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PDP_PATH = path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js');
const PDP_SRC = fs.readFileSync(PDP_PATH, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const PDP_CODE = stripComments(PDP_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure helper out of product-detail-page.js. Only top-level
// declarations + event-listener registrations run at load, so a permissive
// document/window stub is enough. Mirrors the shop-page helper test.
// ─────────────────────────────────────────────────────────────────────────────
function loadPdpHelpers() {
    const noop = () => {};
    const docStub = {
        addEventListener: noop, removeEventListener: noop,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, setAttribute: noop, appendChild: noop }),
        body: { appendChild: noop }, documentElement: { style: {} }, cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat,
        setTimeout, clearTimeout,
        addEventListener: noop, removeEventListener: noop,
        document: docStub,
        location: { search: '', pathname: '/ribbon/307.11', href: 'http://localhost/ribbon/307.11' },
        history: { replaceState: noop, pushState: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        IntersectionObserver: function () { return { observe: noop, disconnect: noop }; },
        MutationObserver: function () { return { observe: noop, disconnect: noop }; },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(PDP_SRC, ctx, { filename: 'product-detail-page.js' });
    const helpers = sandbox.window._pdpRelatedHelpers;
    assert.ok(helpers, 'product-detail-page.js must expose window._pdpRelatedHelpers');
    return helpers;
}

// A tiny resolver that mirrors the ribbon-branch precedence logic, to prove the
// candidate list drives real resolution (exact-first, order preserved, dedup).
// The catalogue is keyed by UPPER(sku), exactly like the product code does.
function resolve(manualSkus, catalogueSkus, relatedSkuCandidates) {
    const byUpper = {};
    for (const sku of catalogueSkus) byUpper[String(sku).toUpperCase()] = { sku };
    const ordered = [];
    const used = new Set();
    for (const s of manualSkus) {
        for (const c of relatedSkuCandidates(s)) {
            const hit = byUpper[c];
            if (hit && !used.has(hit.sku)) { used.add(hit.sku); ordered.push(hit); break; }
        }
    }
    return ordered.map(p => p.sku);
}

// ═════════════════════════════════════════════════════════════════════════════
// relatedSkuCandidates — the candidate generator
// ═════════════════════════════════════════════════════════════════════════════
test('relatedSkuCandidates — a bare code yields C- and G-prefixed candidates', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    assert.deepEqual([...relatedSkuCandidates('141LOT')], ['141LOT', 'C141LOT', 'G141LOT']);
});

test('relatedSkuCandidates — exact sku is ALWAYS first (exact match wins)', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    assert.equal(relatedSkuCandidates('141LOT')[0], '141LOT');
    assert.equal(relatedSkuCandidates('C141LOT')[0], 'C141LOT');
});

test('relatedSkuCandidates — case-insensitive (lowercase input normalises up)', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    assert.deepEqual([...relatedSkuCandidates('141lot')], ['141LOT', 'C141LOT', 'G141LOT']);
});

test('relatedSkuCandidates — a bare numeric ribbon SKU is handled without breaking', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    assert.deepEqual([...relatedSkuCandidates('307.11')], ['307.11', 'C307.11', 'G307.11']);
});

test('relatedSkuCandidates — empty / null / whitespace yields no candidates', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    assert.deepEqual([...relatedSkuCandidates('')], []);
    assert.deepEqual([...relatedSkuCandidates(null)], []);
    assert.deepEqual([...relatedSkuCandidates('   ')], []);
});

// ═════════════════════════════════════════════════════════════════════════════
// Resolution behaviour — the exact 307.11 case and its invariants
// ═════════════════════════════════════════════════════════════════════════════
test('resolution — 307.11 case: bare ["141LOT","143LOT"] now resolves to C141LOT/C143LOT', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    const out = resolve(['141LOT', '143LOT'], ['C141LOT', 'C143LOT', '307.11'], relatedSkuCandidates);
    assert.deepEqual(out, ['C141LOT', 'C143LOT']);
});

test('resolution — an EXACT sku is preferred over a prefixed sibling (no over-match)', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    // Both "141LOT" (exact) and "C141LOT" exist — the exact one must win.
    const out = resolve(['141LOT'], ['141LOT', 'C141LOT'], relatedSkuCandidates);
    assert.deepEqual(out, ['141LOT']);
});

test('resolution — a correctly-entered C-prefixed sku still resolves (no regression)', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    const out = resolve(['C141LOT'], ['C141LOT'], relatedSkuCandidates);
    assert.deepEqual(out, ['C141LOT']);
});

test('resolution — curated order is preserved and duplicates collapse', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    // 143 first, then 141; and a repeat of 141 must not double-add.
    const out = resolve(['143LOT', '141LOT', '141LOT'], ['C141LOT', 'C143LOT'], relatedSkuCandidates);
    assert.deepEqual(out, ['C143LOT', 'C141LOT']);
});

test('resolution — a genuinely unknown code resolves to nothing (no phantom match)', () => {
    const { relatedSkuCandidates } = loadPdpHelpers();
    const out = resolve(['999XYZ'], ['C141LOT', 'C143LOT'], relatedSkuCandidates);
    assert.deepEqual(out, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// Source wiring — the ribbon branch actually uses the candidate resolver
// ═════════════════════════════════════════════════════════════════════════════
test('renderRelatedProducts — ribbon branch builds a candidate union, not a bare .in(manualSkus)', () => {
    const ribbonBranch = PDP_CODE.slice(
        PDP_CODE.indexOf("if (info.category === 'ribbon') {"),
        PDP_CODE.indexOf('} else {', PDP_CODE.indexOf("if (info.category === 'ribbon') {"))
    );
    assert.match(ribbonBranch, /relatedSkuCandidates\(/,
        'the ribbon branch must expand each curated sku via relatedSkuCandidates');
    assert.match(ribbonBranch, /\.in\('sku',\s*candidates\)/,
        'it must query the candidate union, not the raw manualSkus');
    assert.doesNotMatch(ribbonBranch, /\.in\('sku',\s*manualSkus\)/,
        'the old exact-only query must be gone');
    assert.match(ribbonBranch, /String\(p\.sku\)\.toUpperCase\(\)/,
        'results must be keyed case-insensitively to match candidates');
});
