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

const { codesToVerify, applyResolvedCodes, unresolvedLineErrors } = sandbox;

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

// ─── 6. The backend's fail-soft net, rendered LOUD ──────────────────────────
// When the catalogue is unreachable the client guard lets the save through and the
// backend rejects a non-SKU code with 400 VALIDATION_FAILED +
// `error.details.unresolved: [{position, product_code}]` (backend response Jul 2026).
// unresolvedLineErrors turns that payload back into the SAME {line,lfield,msg} errors
// the client guard emits, so the operator sees which line to fix — pinned inline.

test('a backend 400 maps its unresolved codes back onto the offending lines', () => {
    // #3263/#3264 got past a fail-soft client guard; the backend caught them.
    // position is RAW 0-based (backend response Jul 2026 §2), but here the match is
    // BY CODE so position is ignored — the fixtures use faithful 0-based values anyway.
    const lines = [line('CTN258XLKCMY'), line('CTN258'), line('CLC531XL')];
    const details = { unresolved: [
        { position: 1, product_code: 'CTN258' },
        { position: 2, product_code: 'CLC531XL' },
    ] };
    const errs = unresolvedLineErrors(lines, details);
    assert.deepEqual(plain(errs).map((e) => e.line), [1, 2], 'matched by code to lines at index 1 and 2');
    for (const e of errs) assert.equal(e.lfield, 'code', 'must target the code input so it highlights');
    assert.match(errs[0].msg, /CTN258/);
    assert.match(errs[0].msg, /isn’t a product SKU/);
});

test('the {unresolved:[…]} wrapper and a bare array are both accepted', () => {
    const lines = [line('BADCODE')];
    const wrapped = unresolvedLineErrors(lines, { unresolved: [{ position: 0, product_code: 'BADCODE' }] });
    const bare = unresolvedLineErrors(lines, [{ position: 0, product_code: 'BADCODE' }]);
    assert.deepEqual(plain(wrapped), plain(bare), 'either envelope shape yields the same errors');
    assert.equal(wrapped.length, 1);
});

test('every line carrying the same bad code is flagged, not just the first', () => {
    const lines = [line('CTN258'), line('CTN258XLKCMY'), line('CTN258')];
    const errs = unresolvedLineErrors(lines, { unresolved: [{ position: 0, product_code: 'CTN258' }] });
    assert.deepEqual(plain(errs).map((e) => e.line), [0, 2], 'both CTN258 lines highlighted, the valid one skipped');
});

test('code matching is case-insensitive', () => {
    const lines = [line('ctn258')];
    const errs = unresolvedLineErrors(lines, { unresolved: [{ position: 0, product_code: 'CTN258' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 0);
});

// ─── 6a. position is RAW 0-based into the SUBMITTED array (backend response Jul 2026 §2) ──
// The fallback only fires when the echoed code matches no current line (canonicalised
// or operator-edited mid-request). These pin down the exact index semantics.

test('positional fallback: position is RAW 0-based, no −1 (ERR-079)', () => {
    // Two submittable lines; the echoed code matches neither, so we fall back to
    // position. Under the backend's 0-based contract, position 1 is the SECOND line.
    const lines = [line('FREIGHT-ONLY', 'Freight'), line('SOMECODE')];
    const errs = unresolvedLineErrors(lines, { unresolved: [{ position: 1, product_code: 'DOES-NOT-MATCH' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 1, 'position 1 (0-based) → index 1 (a −1 regression would give 0)');
    assert.equal(errs[0].lfield, 'code');
});

test('positional fallback: position 0 pins the first submitted line', () => {
    const lines = [line('FREIGHT-ONLY', 'Freight'), line('SOMECODE')];
    const errs = unresolvedLineErrors(lines, { unresolved: [{ position: 0, product_code: 'DOES-NOT-MATCH' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 0, 'position 0 (0-based) → index 0');
});

test('position indexes the SUBMITTED array: empty rows are skipped, freight counts', () => {
    // A truly-empty draft row is dropped before submit (realLines) and consumes NO
    // slot; a description-only freight line IS submitted and consumes one. So the
    // backend's submitted array is [freight, SOMECODE] and position 1 is SOMECODE at
    // DRAFT index 2 — proving we map submitted→draft, not index the raw draft.
    const lines = [
        { code: '', description: '', qty: 1, unitCost: 0 },   // blank — dropped before submit
        line('', 'Freight'),                                  // description-only — submitted
        line('SOMECODE'),                                     // submitted
    ];
    const errs = unresolvedLineErrors(lines, { unresolved: [{ position: 1, product_code: 'DOES-NOT-MATCH' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 2, 'submitted index 1 → draft index 2 (blank row skipped, freight counted)');
});

test('positional fallback: out of range under 0-based → unpinned, never a false pin', () => {
    // Two submittable lines → valid positions are 0 and 1. position 2 is out of range;
    // the old 1-based code would have mis-pinned index 1. Now it degrades to line:-1.
    const lines = [line('FREIGHT-ONLY', 'Freight'), line('SOMECODE')];
    const errs = unresolvedLineErrors(lines, { unresolved: [{ position: 2, product_code: 'GHOSTCODE' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, -1, 'past the end of the submitted array → unpinned, not a wrong row');
    assert.match(errs[0].msg, /GHOSTCODE/);
});

test('a line removed mid-flight still names its code, unpinned', () => {
    // No code match and position out of range → line:-1 so the summary toast still
    // tells the operator which code failed.
    const errs = unresolvedLineErrors([line('CTN258XLKCMY')], { unresolved: [{ position: 9, product_code: 'GHOSTCODE' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, -1, 'unpinned so no form input is falsely highlighted');
    assert.match(errs[0].msg, /GHOSTCODE/);
});

test('empty / absent / null unresolved returns [] and never throws', () => {
    assert.deepEqual(plain(unresolvedLineErrors([line('X')], { unresolved: [] })), []);
    assert.deepEqual(plain(unresolvedLineErrors([line('X')], {})), []);
    assert.deepEqual(plain(unresolvedLineErrors([line('X')], null)), []);
});

test('a null draft with a real unresolved code surfaces it unpinned, no throw', () => {
    // Defensive: the draft could be gone by the time the 400 lands. It must not
    // throw, and the code still names itself (unpinned) in the summary toast.
    const errs = unresolvedLineErrors(null, { unresolved: [{ position: 0, product_code: 'X' }] });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, -1);
    assert.match(errs[0].msg, /“X”/);
});

test('client guard and backend 400 produce IDENTICAL copy for the same code', () => {
    // The whole point of the shared skuLineMsg: an operator can't tell which layer
    // caught the bad code, because the sentence is byte-identical.
    const guardLines = [line('CTN258')];
    const guardErr = applyResolvedCodes(guardLines, REAL)[0];
    const backendErr = unresolvedLineErrors([line('CTN258')],
        { unresolved: [{ position: 0, product_code: 'CTN258' }] })[0];
    assert.equal(backendErr.msg, guardErr.msg, 'same line, same code → same message');
});

test('unresolvedLineErrors is read-only — it never mutates the lines', () => {
    const lines = [line('CTN258')];
    unresolvedLineErrors(lines, { unresolved: [{ position: 0, product_code: 'CTN258' }] });
    assert.equal(lines[0].code, 'CTN258', 'the draft is untouched (unlike applyResolvedCodes)');
});
