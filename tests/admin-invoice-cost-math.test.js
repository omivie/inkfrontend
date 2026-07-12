/**
 * invoice-math.js — supplier cost, COGS and profit on an invoiced sale
 * ====================================================================
 *
 * The accounting law of invoiced orders, pinned:
 *
 *   1. UNKNOWN ≠ ZERO. An empty cost box means "nobody has costed this line",
 *      not "this line was free". Number('') === 0, and a $0 cost reports a 100%
 *      margin — so coercing would turn an un-costed invoice into fictional pure
 *      profit. Any unknown cost poisons the whole invoice's profit to null.
 *
 *   2. NO CARD FEE. Invoiced sales settle by bank transfer, so there is no
 *      Stripe 2.65% + $0.30. An invoiced sale nets MORE than an identical
 *      website order. That is the truth, not a bug.
 *
 *   3. AN INVOICE BUILT FROM AN ORDER MUST NOT BE COUNTED. The order is already
 *      in the numbers; counting the invoice too books the same sale twice.
 *      This is the double-count guard, and it holds even when the invoice is paid.
 *
 * Run with: node --test tests/admin-invoice-cost-math.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const PROFITABILITY = path.join(ADMIN, 'utils', 'profitability.js');
const INVOICE_MATH = path.join(ADMIN, 'utils', 'invoice-math.js');

// Strip ESM syntax and re-expose each export on globalThis so the sandbox can
// reach it. invoice-math.js imports from profitability.js, so we concatenate the
// two (dependency first) into one realm and drop the import statements.
function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.window = undefined;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(PROFITABILITY, 'utf8')), ctx, { filename: 'profitability.js' });
vm.runInContext(stripEsm(fs.readFileSync(INVOICE_MATH, 'utf8')), ctx, { filename: 'invoice-math.js' });

const {
  costOrNull, computeInvoiceTotals, computeInvoiceCogs, computeInvoiceProfit,
  normalizeInvoice, countsForAnalytics, invoiceDocRows,
  computeOrderProfit, NO_PAYMENT_FEES,
} = sandbox;

const approx = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
// Values built inside the vm realm carry that realm's prototypes, so deepEqual
// sees "same structure, not reference-equal". Round-trip through JSON first.
const plain = (x) => JSON.parse(JSON.stringify(x));

// ─── 1. Unknown ≠ zero ───────────────────────────────────────────────────────
test('costOrNull: an empty box is UNKNOWN (null), a typed 0 is a known zero', () => {
  // The headline distinction. If these two ever collapse to the same value, an
  // un-costed invoice line silently becomes 100% margin.
  assert.equal(costOrNull(''), null, "'' must be unknown, NOT 0");
  assert.equal(costOrNull(0), 0, 'a deliberate 0 is a known cost');
  assert.equal(costOrNull('0'), 0);
});

test('costOrNull rejects nullish, non-numeric and negative input', () => {
  assert.equal(costOrNull(null), null);
  assert.equal(costOrNull(undefined), null);
  assert.equal(costOrNull('abc'), null);
  assert.equal(costOrNull(NaN), null);
  assert.equal(costOrNull(-1), null, 'a negative supplier cost is not a thing');
});

test('costOrNull round-trips a decimal string from the number input', () => {
  assert.equal(costOrNull('12.34'), 12.34);
});

// ─── 2. COGS honesty ─────────────────────────────────────────────────────────
test('computeInvoiceCogs sums known lines and counts the unknown ones', () => {
  const d = { lines: [
    { code: 'A', qty: 2, unitCost: 50, supplierCost: 30 },   // 60
    { code: 'B', qty: 1, unitCost: 20, supplierCost: 8 },    // 8
  ] };
  const c = computeInvoiceCogs(d);
  approx(c.costExGst, 68);
  assert.equal(c.unknownLines, 0);
  assert.equal(c.allKnown, true);
});

test('ONE un-costed line makes the whole invoice profit null — never a number', () => {
  const d = { lines: [
    { code: 'A', qty: 2, unitCost: 50, supplierCost: 30 },
    { code: 'B', qty: 1, unitCost: 20, supplierCost: null },   // nobody costed this
  ] };
  const c = computeInvoiceCogs(d);
  assert.equal(c.unknownLines, 1);
  assert.equal(c.allKnown, false);
  assert.equal(computeInvoiceProfit(d), null,
    'a partial COGS is a floor, not a fact — it must not be presented as profit');
});

test('an empty draft has no profit (rather than a fictional 100% margin)', () => {
  assert.equal(computeInvoiceProfit({ lines: [{ code: '', description: '', qty: 1, unitCost: 0, supplierCost: null }] }), null);
});

test('a known zero cost is honoured — profit is the full ex-GST revenue', () => {
  const d = { lines: [{ code: 'FREEBIE', qty: 1, unitCost: 100, supplierCost: 0 }] };
  assert.equal(computeInvoiceCogs(d).allKnown, true);
  approx(computeInvoiceProfit(d), 100);
});

// ─── 3. No card fee on an invoiced sale ──────────────────────────────────────
test('an invoiced sale carries NO processor fee — profit is exactly rev − cost', () => {
  const d = { lines: [{ code: 'X', qty: 1, unitCost: 100, supplierCost: 60 }], freight: 0 };
  assert.equal(computeInvoiceProfit(d), 40,
    'bank transfer: $100 ex-GST sell − $60 ex-GST cost = exactly $40, no fee');
});

test('the SAME sale as a website order nets less, because Stripe takes a cut', () => {
  // The contrast is the point: if this ever equals 40, NO_PAYMENT_FEES has leaked
  // into the default path and every website order's profit is overstated.
  const cardProfit = computeOrderProfit(100, 60, { customerPaidInclGst: 115 });
  approx(cardProfit, 100 - 60 - (115 * 0.0265 + 0.30));   // ≈ 36.65
  assert.ok(cardProfit < 40, 'a card sale must net less than a bank-transfer sale');
});

test('NO_PAYMENT_FEES zeroes both the rate and the fixed component', () => {
  assert.equal(computeOrderProfit(100, 60, { ...NO_PAYMENT_FEES }), 40);
  // Not just the 2.65% — the $0.30 too.
  assert.equal(computeOrderProfit(10, 0, { ...NO_PAYMENT_FEES }), 10);
});

test('freight is part of the fee base but not of COGS', () => {
  const d = { lines: [{ code: 'X', qty: 1, unitCost: 100, supplierCost: 60 }], freight: 20 };
  // Bank transfer, so freight adds nothing to the fee; profit is unchanged.
  assert.equal(computeInvoiceProfit(d), 40);
});

// ─── 4. Totals reproduce the pre-refactor numbers exactly ────────────────────
test('computeInvoiceTotals: subtotal ex-GST → GST 15% on (subtotal + freight) → total', () => {
  const d = { lines: [{ qty: 2, unitCost: 50 }, { qty: 1, unitCost: 20 }], freight: 10 };
  const t = computeInvoiceTotals(d);
  approx(t.subtotal, 120);
  approx(t.freight, 10);
  approx(t.gst, 19.5);          // (120 + 10) × 0.15
  approx(t.total, 149.5);
});

test('computeInvoiceTotals treats a missing freight as 0', () => {
  const t = computeInvoiceTotals({ lines: [{ qty: 1, unitCost: 100 }] });
  approx(t.gst, 15);
  approx(t.total, 115);
});

// ─── 5. The double-count guard ───────────────────────────────────────────────
test('countsForAnalytics: a plain unpaid invoice COUNTS (accrual basis)', () => {
  assert.equal(countsForAnalytics({ status: 'unpaid', source_order_id: null }), true,
    'the sale happened on the invoice date; payment is just outstanding');
  assert.equal(countsForAnalytics({ status: 'paid', source_order_id: null }), true);
});

test('countsForAnalytics: a VOID invoice never counts', () => {
  assert.equal(countsForAnalytics({ status: 'void', source_order_id: null }), false);
});

test('countsForAnalytics: an invoice built FROM an order never counts — even when paid', () => {
  // THE DOUBLE-COUNT GUARD. The underlying order is already in the numbers.
  assert.equal(countsForAnalytics({ status: 'paid', source_order_id: 'ord_123' }), false);
  assert.equal(countsForAnalytics({ status: 'unpaid', source_order_id: 'ord_123' }), false);
  // camelCase (a normalized record) must be caught too, not just snake_case.
  assert.equal(countsForAnalytics({ status: 'paid', sourceOrderId: 'ord_123' }), false);
});

// ─── 6. One reader for both shapes ───────────────────────────────────────────
test('normalizeInvoice reads a SAVED RECORD (snake_case line_items)', () => {
  const n = normalizeInvoice({
    id: 'inv1', status: 'unpaid', order_date: '2026-07-08T00:00:00Z',
    line_items: [{ product_code: 'X', quantity: 2, unit_cost_excl_gst: 50, supplier_cost_excl_gst: 30 }],
    freight_excl_gst: 0,
  });
  approx(n.revenueExGst, 100);
  approx(n.costExGst, 60);
  approx(n.profit, 40);
  assert.equal(n.allCostsKnown, true);
  assert.equal(n.units, 2);
  assert.equal(n.date, '2026-07-08', 'buckets by the date the sale happened, not the paperwork date');
});

test('normalizeInvoice reads an EDITOR DRAFT (camelCase lines) to the same numbers', () => {
  const n = normalizeInvoice({
    id: 'inv1', status: 'unpaid', order_date: '2026-07-08',
    lines: [{ code: 'X', qty: 2, unitCost: 50, supplierCost: 30 }],
    freight: 0,
  });
  approx(n.revenueExGst, 100);
  approx(n.costExGst, 60);
  approx(n.profit, 40);
});

test('normalizeInvoice: a record with no supplier cost yet degrades to unknown, not free', () => {
  // This is the whole world today — the backend does not persist the column yet.
  const n = normalizeInvoice({
    status: 'unpaid',
    line_items: [{ product_code: 'X', quantity: 1, unit_cost_excl_gst: 100 }],
  });
  approx(n.revenueExGst, 100);
  assert.equal(n.allCostsKnown, false);
  assert.equal(n.profit, null, 'no cost on file must NOT read as $100 of pure profit');
});

test('normalizeInvoice falls back to issue_date when there is no order_date', () => {
  const n = normalizeInvoice({ issue_date: '2026-07-01', line_items: [] });
  assert.equal(n.date, '2026-07-01');
});

// ─── 7. The document projection ──────────────────────────────────────────────
test('invoiceDocRows yields exactly four fields — cost is not among them', () => {
  const rows = invoiceDocRows({
    lines: [{ code: 'X', description: 'Widget', qty: 2, unitCost: 10, supplierCost: 6 }],
  }, { money });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 4, 'code, description, qty, line total — and nothing else');
  assert.deepEqual(plain(rows[0]), ['X', 'Widget', '2', '$20.00']);

  // The unit cost ($6) and the cost line total (2 × 6 = $12) must appear nowhere.
  const flat = JSON.stringify(plain(rows));
  assert.ok(flat.includes('$20.00'), 'the SELL line total must print');
  assert.ok(!flat.includes('$12.00'), 'the COST line total must NOT print');
  assert.ok(!flat.includes('$6.00'), 'the unit cost must NOT print');
});
