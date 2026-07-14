/**
 * Invoice line codes — a product_code is a real SKU, or it is nothing
 * ==================================================================
 *
 * ERR-071. Invoices #3263 and #3264 were saved with product_code `CTN258` and
 * `CLC531XL` — the series codes printed on the box — instead of the actual SKUs
 * `CTN258XLKCMY` / `CLC531XLKCMY`. The backend materialises each invoice into a
 * shadow order and matches its line items BY SKU, so both lines matched nothing
 * and were dropped, leaving PAID ORDERS WITH NO LINE ITEMS and a CRITICAL
 * data-integrity alert.
 *
 * The picker was never at fault: it stores `product.sku` verbatim. The hole was
 * the free-text code box — a code TYPED instead of PICKED reached the payload
 * unverified. utils/line-codes.js is the gate; this file pins its two rules.
 *
 *   1. AN EMPTY CODE IS LEGAL. Freight, labour and one-off lines are description-
 *      only by design ("code or description"). If this ever starts erroring, every
 *      invoice with a shipping line becomes unsaveable.
 *
 *   2. NEVER GUESS. `CTN258` prefixes BOTH `CTN258BK` and `CTN258XLKCMY`. Resolving
 *      it to either would invoice the WRONG PRODUCT — a worse failure than the one
 *      being fixed. Only an exact match (ignoring case) is ever accepted.
 *
 * And the fail-soft rule that keeps the guard from becoming an outage of its own:
 * a catalogue we cannot REACH (null) is not a catalogue that says NO (empty map).
 * Blocking a save because our own lookup broke would stop the business invoicing.
 *
 * Run with: node --test tests/admin-invoice-sku-integrity.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LINE_CODES = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'line-codes.js');

// line-codes.js is deliberately import-free, so the sandbox only has to strip the
// `export` keywords and re-expose each binding on the realm's global.
function stripEsm(src) {
    const exposed = new Set();
    const stripped = src.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
        (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
    return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Set, Map };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(LINE_CODES, 'utf8')), ctx, { filename: 'line-codes.js' });

const { codesToVerify, applyResolvedCodes } = sandbox;

// Arrays built inside the vm realm carry that realm's prototypes, so deepEqual sees
// "same structure, not reference-equal". Round-trip through JSON first (same trick as
// tests/admin-invoice-cost-math.test.js).
const plain = (x) => JSON.parse(JSON.stringify(x));

// The catalogue as resolveSkus() hands it over: Map<lowercased code, canonical sku>.
const catalogue = (...skus) => new Map(skus.map((s) => [s.toLowerCase(), s]));
const REAL = catalogue('CTN258XLKCMY', 'CLC531XLKCMY', 'CTN258BK');

const line = (code, description = 'A product') => ({ code, description, qty: 1, unitCost: 10 });

// ─── 1. The bug that started this ────────────────────────────────────────────
test('a series/base code is NOT a SKU — the save is blocked (ERR-071)', () => {
    // The exact values that shipped on #3263 and #3264.
    const lines = [line('CTN258'), line('CLC531XL')];
    const errs = applyResolvedCodes(lines, REAL);

    assert.equal(errs.length, 2, 'both truncated codes must be rejected');
    assert.equal(errs[0].line, 0);
    assert.equal(errs[0].lfield, 'code', 'must target the code input so it gets highlighted');
    assert.match(errs[0].msg, /CTN258/, 'the message must name the offending code');
    assert.match(errs[0].msg, /isn’t a product SKU/);
    // And it must NOT have quietly repaired them — that is rule 2.
    assert.equal(lines[0].code, 'CTN258', 'an unresolvable code is left alone, never guessed');
});

test('NEVER GUESS: an ambiguous prefix is not resolved to either candidate', () => {
    // CTN258 prefixes both CTN258BK and CTN258XLKCMY. Picking either would invoice
    // the wrong product. The only safe answer is "you resolve it".
    const lines = [line('CTN258')];
    const errs = applyResolvedCodes(lines, REAL);
    assert.equal(errs.length, 1);
    assert.notEqual(lines[0].code, 'CTN258BK');
    assert.notEqual(lines[0].code, 'CTN258XLKCMY');
});

// ─── 2. What a good line looks like ──────────────────────────────────────────
test('an exact SKU passes untouched', () => {
    const lines = [line('CTN258XLKCMY'), line('CLC531XLKCMY')];
    assert.deepEqual(plain(applyResolvedCodes(lines, REAL)), []);
    assert.equal(lines[0].code, 'CTN258XLKCMY');
    assert.equal(lines[1].code, 'CLC531XLKCMY');
});

test('a hand-typed SKU snaps to the catalogue’s canonical casing', () => {
    // The operator types what's on the box; the backend matches case-sensitively.
    const lines = [line('ctn258xlkcmy'), line('  CtN258XlKcMy  ')];
    assert.deepEqual(plain(applyResolvedCodes(lines, REAL)), [], 'wrong case is not an error');
    assert.equal(lines[0].code, 'CTN258XLKCMY', 'must be rewritten to the real SKU');
    assert.equal(lines[1].code, 'CTN258XLKCMY', 'surrounding whitespace is trimmed away too');
});

// ─── 3. Rule 1 — a description-only line is not a defect ─────────────────────
test('an empty code is LEGAL — freight/labour lines must still save', () => {
    const lines = [
        { code: '', description: 'Freight', qty: 1, unitCost: 7 },
        { code: '   ', description: 'Labour', qty: 1, unitCost: 50 },
        line('CTN258XLKCMY'),
    ];
    assert.deepEqual(plain(applyResolvedCodes(lines, REAL)), [],
        'a line with no code is description-only by design, not an error');
});

test('codesToVerify asks the catalogue only about non-empty codes, once each', () => {
    const codes = plain(codesToVerify([
        line('CTN258XLKCMY'), line('  CTN258XLKCMY  '), line(''), line('   '),
        line('CLC531XLKCMY'), { description: 'no code field at all' },
    ]));
    assert.deepEqual(codes, ['CTN258XLKCMY', 'CLC531XLKCMY'], 'trimmed, de-duplicated, blanks dropped');
    assert.deepEqual(plain(codesToVerify([])), []);
    assert.deepEqual(plain(codesToVerify(null)), [], 'a null draft must not throw');
});

// ─── 4. Fail-soft — our outage is not their problem ──────────────────────────
test('an UNREACHABLE catalogue (null) blocks nothing', () => {
    // null = "we could not ask". Refusing the save here would mean a Supabase blip
    // stops the business invoicing anyone. Contrast with the empty map below.
    const lines = [line('CTN258'), line('literally anything')];
    assert.deepEqual(plain(applyResolvedCodes(lines, null)), [],
        'a lookup failure must never block a save');
});

test('an EMPTY catalogue (nothing matched) is a real NO and does block', () => {
    const lines = [line('CTN258')];
    const errs = applyResolvedCodes(lines, new Map());
    assert.equal(errs.length, 1, 'empty map ≠ null: it means the code matched no product');
});

// ─── 5. Error shape — it has to reach the right input ────────────────────────
test('errors carry the line index the form markers key on', () => {
    const lines = [line('CTN258XLKCMY'), line('BOGUS'), line(''), line('ALSO-BOGUS')];
    const errs = applyResolvedCodes(lines, REAL);
    assert.deepEqual(plain(errs).map((e) => e.line), [1, 3], 'indexes are positional, skipping valid/blank lines');
    for (const e of errs) assert.equal(e.lfield, 'code');
});
