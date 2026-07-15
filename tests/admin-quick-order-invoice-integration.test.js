/**
 * Quick Order → Invoice bridge — the double-count guard
 * =====================================================
 *
 * Since backend migration 108 (2026-07-14) a SAVED quick order materialises its own
 * shadow `orders` row, so it is counted in analytics exactly like an invoice. When a
 * quick order is converted to an invoice, that invoice materialises ANOTHER shadow
 * order. The backend keeps no invoice→quick-order link, so unless the FE flips the
 * source quick order to `status='invoiced'` (cancelling its shadow), the sale is
 * counted TWICE.
 *
 * The whole guard lives in three pure functions in utils/quick-order-bridge.js:
 *
 *   buildQuickOrderPrefill  — stages a quick order into an invoice prefill, carrying
 *                             `qo_id` (the new link) out through sessionStorage.
 *   parseQuickOrderPrefill  — reads it back as `source_quick_order_id`.
 *   flipTargetFrom          — the single predicate the invoice save keys its flip
 *                             off, and the thing that makes it idempotent.
 *
 * This file pins the load-bearing rules:
 *
 *   1. A SAVED quick order carries its id across; an UNSAVED draft (id == null)
 *      carries qo_id: null — there is no shadow order, so nothing must flip.
 *   2. The id round-trips through JSON (sessionStorage) back to
 *      `source_quick_order_id` intact — if it were dropped, every converted sale
 *      would double-count.
 *   3. flipTargetFrom returns the id once, then null after it's cleared — so the
 *      invoice's email/download re-saves never flip a second time.
 *   4. Reading a corrupt / old / absent prefill never throws and yields no flip.
 *
 * Run with: node --test tests/admin-quick-order-invoice-integration.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BRIDGE = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'quick-order-bridge.js');

// quick-order-bridge.js is deliberately import-free, so the sandbox only has to
// strip the `export` keywords and re-expose each binding on the realm's global.
// (Same harness as tests/admin-invoice-sku-integrity.test.js.)
function stripEsm(src) {
    const exposed = new Set();
    const stripped = src.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
        (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
    return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Set, Map };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(BRIDGE, 'utf8')), ctx, { filename: 'quick-order-bridge.js' });

const { buildQuickOrderPrefill, parseQuickOrderPrefill, flipTargetFrom } = sandbox;

// Objects built inside the vm realm carry that realm's prototypes; round-trip through
// JSON so deepEqual compares structure, not identity (same trick as the sibling test).
const plain = (x) => JSON.parse(JSON.stringify(x));

// A representative saved quick-order editor draft.
const savedDraft = () => ({
    id: 'qo_123',
    order_date: '2026-07-15',
    customer: { name: 'Jane Buyer', company: 'Acme Ltd', phone: '021 555 0000', email: 'jane@acme.co.nz', address: '1 High St\nWellington' },
    lines: [
        { code: 'CTN258XLKCMY', description: 'Canon ink', qty: 2, unitPrice: 40, supplierCost: 18, costSource: 'manual' },
        { code: '', description: 'Freight', qty: 1, unitPrice: 7, supplierCost: null, costSource: 'auto' },
    ],
});

// ─── 1. The link out: qo_id ──────────────────────────────────────────────────
test('a SAVED quick order carries its id out as qo_id', () => {
    const pre = buildQuickOrderPrefill(savedDraft());
    assert.equal(pre.qo_id, 'qo_123', 'the id is the link the invoice save flips on');
});

test('an UNSAVED draft (id == null) carries qo_id: null — nothing to flip', () => {
    // Converting a brand-new, never-saved quick order via the editor footer. It has
    // no shadow order, so there must be no flip — or we would cancel a shadow that
    // never existed and the invoice would be the only (correct, single) count anyway.
    const d = savedDraft(); d.id = null;
    assert.equal(buildQuickOrderPrefill(d).qo_id, null);
    const d2 = savedDraft(); delete d2.id;
    assert.equal(buildQuickOrderPrefill(d2).qo_id, null, 'a missing id is also null, never undefined-carried');
});

// ─── 2. Fidelity of the prefill payload ──────────────────────────────────────
test('customer maps across (attn mirrors name) and every field is preserved', () => {
    const c = buildQuickOrderPrefill(savedDraft()).customer;
    assert.deepEqual(plain(c), {
        attn: 'Jane Buyer', name: 'Jane Buyer', company: 'Acme Ltd',
        address: '1 High St\nWellington', phone: '021 555 0000', email: 'jane@acme.co.nz',
    });
});

test('lines carry code/description/qty, sell price → unitCost, and cost fields verbatim', () => {
    const lines = buildQuickOrderPrefill(savedDraft()).lines;
    assert.equal(lines.length, 2);
    assert.deepEqual(plain(lines[0]), {
        code: 'CTN258XLKCMY', description: 'Canon ink', qty: 2,
        unitCost: 40,           // quick-order unitPrice (ex-GST sell) → invoice unitCost (ex-GST sell)
        supplierCost: 18, costSource: 'manual',   // OUR cost survives the bridge untouched
    });
});

test('a description-only line (no code) is preserved — freight/labour survive', () => {
    const freight = buildQuickOrderPrefill(savedDraft()).lines[1];
    assert.equal(freight.code, '', 'blank code stays blank (a valid description-only line)');
    assert.equal(freight.description, 'Freight');
    assert.equal(freight.supplierCost, null, 'unknown cost stays null, never coerced to 0');
});

test('qty/price coercion: bad numbers become safe defaults, not NaN', () => {
    const d = { id: 'x', lines: [{ code: 'A', qty: 'not-a-number', unitPrice: 'oops' }] };
    const l = buildQuickOrderPrefill(d).lines[0];
    assert.equal(l.qty, 1, 'qty falls back to 1');
    assert.equal(l.unitCost, 0, 'unitCost falls back to 0 (never NaN in the payload)');
    assert.equal(l.costSource, 'auto', 'costSource defaults to auto');
});

test('an empty / malformed draft never throws', () => {
    assert.equal(buildQuickOrderPrefill(null).qo_id, null);
    assert.deepEqual(plain(buildQuickOrderPrefill(null).lines), []);
    assert.deepEqual(plain(buildQuickOrderPrefill({}).lines), []);
});

// ─── 3. The link back: source_quick_order_id ─────────────────────────────────
test('the id round-trips through JSON back to source_quick_order_id', () => {
    // This IS the double-count guard: sessionStorage → parse must preserve the id, or
    // the invoice save has nothing to flip and the sale counts twice.
    const raw = JSON.stringify(buildQuickOrderPrefill(savedDraft()));
    const parsed = parseQuickOrderPrefill(raw);
    assert.equal(parsed.source_quick_order_id, 'qo_123');
    assert.equal(parsed.order_date, '2026-07-15');
    assert.equal(parsed.customer.name, 'Jane Buyer');
    assert.equal(parsed.lines.length, 2);
});

test('a prefill from BEFORE this change (no qo_id) parses to a null flip target', () => {
    // An old build's prefill can still be sitting in sessionStorage across a deploy.
    // It simply won't auto-flip its quick order — the pre-change behaviour, which is
    // safe (worst case the operator marks it invoiced by hand).
    const legacy = JSON.stringify({ order_date: '2026-07-01', customer: { name: 'A' }, lines: [{ code: 'X' }] });
    assert.equal(parseQuickOrderPrefill(legacy).source_quick_order_id, null);
});

test('corrupt / empty / non-object prefills return null and never throw', () => {
    assert.equal(parseQuickOrderPrefill('{not json'), null);
    assert.equal(parseQuickOrderPrefill(''), null);
    assert.equal(parseQuickOrderPrefill(null), null);
    assert.equal(parseQuickOrderPrefill('42'), null, 'a bare number is not a prefill');
    assert.equal(parseQuickOrderPrefill('"a string"'), null);
    assert.equal(parseQuickOrderPrefill('null'), null);
});

// ─── 4. Idempotency — the flip happens exactly once ──────────────────────────
test('flipTargetFrom returns the id, then null after it is cleared', () => {
    const invoiceDraft = { id: 'inv_1', source_quick_order_id: 'qo_123' };
    assert.equal(flipTargetFrom(invoiceDraft), 'qo_123', 'first save owes the flip');

    // persistDraft clears the link after a successful PUT…
    invoiceDraft.source_quick_order_id = null;
    assert.equal(flipTargetFrom(invoiceDraft), null, 'the email/download re-save must NOT flip again');
});

test('flipTargetFrom is null-safe for invoices that never came from a quick order', () => {
    assert.equal(flipTargetFrom({ id: 'inv_2' }), null, 'no source field → nothing to flip');
    assert.equal(flipTargetFrom(null), null);
    assert.equal(flipTargetFrom(undefined), null);
    assert.equal(flipTargetFrom({ source_quick_order_id: '' }), null, 'empty string is not a flip target');
});
