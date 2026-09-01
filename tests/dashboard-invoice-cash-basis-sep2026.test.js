/**
 * invoice-cash-basis.js — invoiced sales recognise on PAYMENT, their goods on ACCRUAL
 * ==================================================================================
 *
 * ERR-197. The owner's basis, in one line:
 *
 *     revenue and profit arrive when the money does; the cost of the goods
 *     arrives when the invoice is raised.
 *
 * The backend cannot express that — it counts every non-void invoice on the day it
 * was raised (`includes_invoices: true`). So the frontend SUBTRACTS the invoices
 * whose cash has not landed. That is not the deleted `invoice-overlay.js` coming
 * back: an ADD would double a revenue the backend already contains, a SUBTRACT
 * removes part of a total we have first proved it contains.
 *
 * Five things here would each silently break the feature, and each has a test:
 *
 *   1. Reading the SHADOW ORDER's `status` instead of the invoice's. Every INV-
 *      order is 'paid' with a paid_at, including the nine invoices the operator has
 *      never marked paid — so the deduction would always be zero and the feature
 *      would look shipped while doing nothing.
 *   2. Bucketing on `issue_date`. The backend books on the shadow order's
 *      created_at; they differ on 8 of 15 live invoices, sometimes across a month
 *      boundary. Money would leave the wrong month and haunt the right one.
 *   3. Deducting an invoice the backend never counted (one raised against a real
 *      order). That deletes a genuine order's revenue.
 *   4. Adjusting a cost. Then an unpaid invoice costs nothing, and the entire point
 *      — seeing what you have laid out and not been paid for — is gone.
 *   5. Turning an unknown into a zero. `Number(null) === 0` has produced ERR-068,
 *      ERR-074 and a "0.0% — reprice or drop" recommendation about a margin that
 *      did not exist.
 *
 * The fixture is the REAL live book as measured on 2026-09-01 by
 * `npm run probe:invoice-cash-basis`, including its two freight invoices and its
 * one void. Synthetic rows are added only for cases production does not yet have.
 *
 * Run with: node --test tests/dashboard-invoice-cash-basis-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const MODULE = path.join(ADMIN, 'utils', 'invoice-cash-basis.js');

function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date, Map, RegExp };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE, 'utf8')), ctx, { filename: 'invoice-cash-basis.js' });

const {
  EX_GST_FACTOR, isOutstanding, isUnrealised, indexShadowOrders, joinToShadowOrders,
  withinPeriod, reconcilePeriod, unrealisedDeduction, bucketDeduction,
  applyCashBasis, marginPct, cashBasisNote,
} = sandbox;

// A non-numeric `eps` means a message was passed into the tolerance slot — that
// makes `< eps` false and fails a passing assertion for the wrong reason. Throw
// on it rather than let the mis-call masquerade as a real failure.
const approx = (a, b, eps = 0.005, msg = '') => {
  if (typeof eps !== 'number') throw new TypeError(`approx(): eps must be a number, got ${JSON.stringify(eps)}`);
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}${msg ? ` — ${msg}` : ''}`);
};

// ─── The live book, 2026-09-01 ───────────────────────────────────────────────
// invoice_number, issue_date, status, total_incl_gst | shadow created_at, order status
const LIVE = [
  [3263, '2026-06-22', 'paid',    195.99, '2026-06-22', 'paid'],
  [3264, '2026-07-03', 'void',    106.49, '2026-06-25', 'cancelled'],
  [3265, '2026-07-08', 'paid',    966.00, '2026-07-07', 'paid'],
  [3266, '2026-07-27', 'paid',     34.79, '2026-07-27', 'paid'],
  [3267, '2026-07-27', 'unpaid',  150.79, '2026-07-27', 'paid'],
  [3268, '2026-08-01', 'unpaid',  249.55, '2026-07-31', 'paid'],
  [3269, '2026-08-05', 'unpaid',  150.79, '2026-07-27', 'paid'],
  [3270, '2026-08-05', 'unpaid',  200.99, '2026-08-05', 'paid'],
  [3271, '2026-08-07', 'unpaid',  238.49, '2026-08-07', 'paid'],
  [3272, '2026-08-17', 'unpaid',  966.00, '2026-08-14', 'paid'],
  [3273, '2026-08-17', 'paid',    104.47, '2026-08-17', 'paid'],
  [3274, '2026-08-19', 'unpaid',  685.49, '2026-08-19', 'paid'],
  [3275, '2026-08-28', 'unpaid',   98.34, '2026-08-19', 'paid'],
  [3276, '2026-08-31', 'paid',     41.50, '2026-08-28', 'paid'],
  [3277, '2026-09-01', 'unpaid', 1325.95, '2026-08-28', 'paid'],
];
const invoices = LIVE.map(([n, d, s, t]) =>
  ({ invoice_number: n, issue_date: d, status: s, total_incl_gst: t }));
const orders = LIVE.map(([n, , , t, c, os]) =>
  ({ order_number: `INV-${n}`, created_at: `${c}T00:00:00`, status: os, total: t }));
const shadows = () => indexShadowOrders(orders);
const joinAll = () => joinToShadowOrders(invoices, shadows());

// ─── 1. The two predicates answer DIFFERENT questions ────────────────────────

test('isOutstanding and isUnrealised agree on the ordinary cases', () => {
  for (const s of ['unpaid', 'draft']) {
    assert.equal(isOutstanding({ status: s }), true, `${s} is owed`);
    assert.equal(isUnrealised({ status: s }), true, `${s} has not been collected`);
  }
  for (const s of ['paid', 'void']) {
    assert.equal(isOutstanding({ status: s }), false);
    assert.equal(isUnrealised({ status: s }), false);
  }
});

test('a DRAFT is unpaid — the test is !== paid, never === unpaid', () => {
  // `INVOICE_STATUSES` contains 'draft'. Live it is 0 rows, so an `=== 'unpaid'`
  // test would pass today and silently leave a draft's revenue on the dashboard
  // as if collected the first time one is created.
  assert.equal(isUnrealised({ status: 'draft' }), true);
  assert.equal(isOutstanding({ status: 'draft' }), true);
});

test('an invoice with no shadow order is dropped, but is still money owed', () => {
  // THE distinction. An invoice raised against an existing order gets no shadow
  // order (the backend already counted the ORDER), so it must never be deducted
  // from the dashboard — but the customer still owes us for it, so the Invoices
  // page's outstanding box must still count it.
  const orphan = { invoice_number: 9999, issue_date: '2026-08-10', status: 'unpaid', total_incl_gst: 500 };
  const joined = joinToShadowOrders([...invoices, orphan], shadows());
  assert.ok(!joined.some((j) => j.invoice.invoice_number === 9999),
    'an invoice with no shadow order must not reach the deduction');
  assert.equal(isOutstanding(orphan), true,
    'the same invoice IS outstanding — the debtors question has a different answer');
});

// ─── 2. The join and the booking date ────────────────────────────────────────

test('the void invoice is dropped via its CANCELLED shadow order', () => {
  const joined = joinAll();
  assert.equal(joined.length, 14, '15 invoices, 1 void → 14 counted');
  assert.ok(!joined.some((j) => j.invoice.invoice_number === 3264));
});

test('bookedOn comes from the ORDER, never from issue_date', () => {
  const j = joinAll().find((x) => x.invoice.invoice_number === 3277);
  assert.equal(j.invoice.issue_date, '2026-09-01');
  assert.equal(j.bookedOn, '2026-08-28',
    'INV-3277 is invoiced 1 Sep but booked 28 Aug — the backend reports $0 invoice revenue for September');
});

test('the whole live book: 8 of 15 are booked on a different day than issue_date', () => {
  const drifted = joinAll().filter((x) => x.bookedOn !== String(x.invoice.issue_date).slice(0, 10));
  assert.equal(drifted.length, 7,
    'seven of the fourteen JOINED rows drift (the eighth, #3264, is the void one already dropped)');
});

test('withinPeriod filters on the booking day, so September holds nothing', () => {
  assert.equal(withinPeriod(joinAll(), '2026-09-01', '2026-09-30').length, 0);
  assert.equal(withinPeriod(joinAll(), '2026-08-01', '2026-08-31').length, 8);
  assert.equal(withinPeriod(joinAll(), '2026-07-01', '2026-07-31').length, 5);
  assert.equal(withinPeriod(joinAll(), '2026-06-01', '2026-06-30').length, 1);
});

// ─── 3. Reconciliation — the guard that replaces source_order_id ─────────────

test('every live window reconciles to the backend\'s own invoice_revenue', () => {
  // These four pairs were measured, not invented. If the join ever stops matching
  // what the backend published, this is the test that says so.
  const windows = [
    ['2026-06-01', '2026-06-30', 195.99, 1],
    ['2026-07-01', '2026-07-31', 1551.92, 5],
    ['2026-08-01', '2026-08-31', 3661.23, 8],
    ['2026-09-01', '2026-09-30', 0, 0],
  ];
  for (const [from, to, invoice_revenue, invoice_orders] of windows) {
    const rec = reconcilePeriod(withinPeriod(joinAll(), from, to),
      { includes_invoices: true, invoice_revenue, invoice_orders });
    assert.equal(rec.ok, true, `${from}..${to} must reconcile — got: ${rec.reason}`);
    approx(rec.ours, invoice_revenue);
  }
});

test('a mismatched total refuses, and says by how much', () => {
  const rec = reconcilePeriod(withinPeriod(joinAll(), '2026-08-01', '2026-08-31'),
    { includes_invoices: true, invoice_revenue: 3000, invoice_orders: 8 });
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /do not reconcile/);
  assert.match(rec.reason, /3661\.23/, 'the reason must name our figure');
  assert.match(rec.reason, /3000\.00/, 'and theirs');
});

test('a mismatched COUNT refuses even when the money happens to agree', () => {
  const rec = reconcilePeriod(withinPeriod(joinAll(), '2026-08-01', '2026-08-31'),
    { includes_invoices: true, invoice_revenue: 3661.23, invoice_orders: 7 });
  assert.equal(rec.ok, false);
  assert.match(rec.reason, /counts do not reconcile/);
});

test('includes_invoices !== true refuses — there is nothing to take out', () => {
  const j = withinPeriod(joinAll(), '2026-08-01', '2026-08-31');
  for (const flag of [false, undefined, null, 'true']) {
    const rec = reconcilePeriod(j, { includes_invoices: flag, invoice_revenue: 3661.23, invoice_orders: 8 });
    assert.equal(rec.ok, false, `includes_invoices=${JSON.stringify(flag)} must refuse`);
  }
});

test('a MISSING invoice_revenue is unknown, not zero — it cannot reconcile', () => {
  const rec = reconcilePeriod(withinPeriod(joinAll(), '2026-09-01', '2026-09-30'),
    { includes_invoices: true, invoice_revenue: null, invoice_orders: 0 });
  assert.equal(rec.ok, false, 'null must not pass by looking like a matching 0');
  assert.match(rec.reason, /did not report an invoice revenue figure/);
});

// ─── 4. The deduction ────────────────────────────────────────────────────────

test('the deduction counts only the unpaid, at the backend\'s ex-GST basis', () => {
  const d = unrealisedDeduction(joinAll());
  assert.equal(d.count, 9, 'nine unpaid invoices in the live book');
  approx(d.revenueInclGst, 4066.39);
  approx(d.revenueExGst, 4066.39 * (20 / 23));
  approx(d.revenueExGst, 3535.99);
});

test('a shadow order marked paid does NOT make an unpaid invoice realised', () => {
  // The trap. Every INV- order is status 'paid' with a paid_at, including all nine
  // unpaid invoices. Reading the order would give a deduction of zero, and the
  // feature would ship looking correct and doing nothing.
  assert.ok(orders.every((o) => o.status === 'paid' || o.status === 'cancelled'),
    'fixture check: the shadow orders really are all paid/cancelled');
  assert.ok(unrealisedDeduction(joinAll()).count > 0,
    'the deduction must be driven by invoices.status, not the order');
});

test('an unreadable total is reported, not silently treated as $0', () => {
  const withNull = [...invoices, { invoice_number: 4001, issue_date: '2026-08-10', status: 'unpaid', total_incl_gst: null }];
  const withNullOrders = [...orders, { order_number: 'INV-4001', created_at: '2026-08-10T00:00:00', status: 'paid' }];
  const d = unrealisedDeduction(joinToShadowOrders(withNull, indexShadowOrders(withNullOrders)));
  assert.equal(d.unknownTotal, 1, 'the unknown must be COUNTED, not skipped in silence');
  approx(d.revenueInclGst, 4066.39, 0.01);
});

// ─── 5. Bucketing across every granularity ───────────────────────────────────

test('daily buckets place each invoice on its own booking day', () => {
  const starts = ['2026-08-05', '2026-08-07', '2026-08-14', '2026-08-19', '2026-08-28'];
  const b = bucketDeduction(withinPeriod(joinAll(), '2026-08-01', '2026-08-31'), starts);
  approx(b.get('2026-08-05').revenueInclGst, 200.99);
  approx(b.get('2026-08-07').revenueInclGst, 238.49);
  approx(b.get('2026-08-14').revenueInclGst, 966.00);
  approx(b.get('2026-08-19').revenueInclGst, 685.49 + 98.34);
  approx(b.get('2026-08-28').revenueInclGst, 1325.95);
});

test('monthly buckets: #3277 lands in AUGUST, where the backend put it', () => {
  const b = bucketDeduction(joinAll(), ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);
  assert.equal(b.has('2026-09-01'), false, 'September must be empty — the backend reports $0 there');
  approx(b.get('2026-08-01').revenueInclGst, 200.99 + 238.49 + 966 + 685.49 + 98.34 + 1325.95);
  approx(b.get('2026-07-01').revenueInclGst, 150.79 + 249.55 + 150.79);
});

test('weekly and quarterly buckets work off the given keys alone', () => {
  const wk = bucketDeduction(joinAll(), ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']);
  approx(wk.get('2026-08-03').revenueInclGst, 200.99 + 238.49);   // Wed 5th, Fri 7th
  approx(wk.get('2026-08-10').revenueInclGst, 966.00);            // Fri 14th
  approx(wk.get('2026-08-24').revenueInclGst, 1325.95);           // Fri 28th
  const q = bucketDeduction(joinAll(), ['2026-04-01', '2026-07-01']);
  approx(q.get('2026-07-01').revenueInclGst, 4066.39);
});

test('an invoice earlier than the first bucket is dropped, never folded into it', () => {
  const b = bucketDeduction(joinAll(), ['2026-08-01']);
  approx(b.get('2026-08-01').revenueInclGst, 200.99 + 238.49 + 966 + 685.49 + 98.34 + 1325.95);
  assert.equal(b.size, 1, 'July\'s unpaid invoices must not be swept into August');
});

test('the sum of the buckets equals the single-figure deduction', () => {
  const starts = [...new Set(joinAll().map((j) => j.bookedOn))];
  const b = bucketDeduction(joinAll(), starts);
  const summed = [...b.values()].reduce((s, v) => s + v.revenueInclGst, 0);
  approx(summed, unrealisedDeduction(joinAll()).revenueInclGst, 0.01);
});

// ─── 6. applyCashBasis ───────────────────────────────────────────────────────

const LIVE_KPIS = Object.freeze({
  revenue: 22089.34, gross_profit: 4871.53, net_profit: 998.20, orders: 131,
  aov: 168.62, cogs: 12000, operating_expenses: 3000, stripe_fees: 400,
});
const FULL = { revenueInclGst: 4066.39, revenueExGst: 3535.99, count: 9, unknownTotal: 0 };

test('the live all-time case: revenue and both profits fall by the right amounts', () => {
  const a = applyCashBasis(LIVE_KPIS, FULL);
  approx(a.revenue, 22089.34 - 4066.39);
  approx(a.revenue, 18022.95);
  approx(a.gross_profit, 4871.53 - 3535.99);
  approx(a.net_profit, 998.20 - 3535.99);
  assert.ok(a.net_profit < 0,
    'a book that is 75% unpaid SHOULD read as a loss — that is the feature, not a bug');
});

test('every cost and the order count pass through untouched', () => {
  const a = applyCashBasis(LIVE_KPIS, FULL);
  assert.equal(a.cogs, 12000, 'we are still charged for the goods');
  assert.equal(a.operating_expenses, 3000);
  assert.equal(a.stripe_fees, 400);
  assert.equal(a.orders, 131, 'the order still happened — the owner chose to keep counting it');
});

test('AOV follows revenue, so it falls — stated, not hidden', () => {
  const a = applyCashBasis(LIVE_KPIS, FULL);
  approx(a.aov, 18022.95 / 131);
  assert.ok(a.aov < LIVE_KPIS.aov);
});

test('margins are re-derived against an EX-GST base (ERR-111)', () => {
  const a = applyCashBasis(LIVE_KPIS, FULL);
  approx(a.gross_margin, (a.gross_profit / (a.revenue * (20 / 23))) * 100, 0.02);
  // The trap ERR-111 caught: dividing by GST-INCLUSIVE revenue understates by ~13%.
  const wrong = (a.gross_profit / a.revenue) * 100;
  assert.ok(Math.abs(a.gross_margin - wrong) > 1,
    'the ex-GST denominator must actually differ from the incl-GST one, or the test proves nothing');
});

test('the input object is never mutated', () => {
  const before = JSON.stringify(LIVE_KPIS);
  applyCashBasis(LIVE_KPIS, FULL);
  assert.equal(JSON.stringify(LIVE_KPIS), before);
});

test('null in, null out — an unknown profit never becomes a number', () => {
  const a = applyCashBasis({ revenue: 1000, gross_profit: null, net_profit: null, orders: 5 }, FULL);
  assert.equal(a.gross_profit, null, 'Number(null) === 0 would make this -3535.99');
  assert.equal(a.net_profit, null);
  assert.equal(a.gross_margin, null);
  // POSITIVE CONTROL — the same call with KNOWN inputs must move, or the assertions
  // above would also pass on a function that simply did nothing (ERR-184).
  const b = applyCashBasis({ revenue: 10000, gross_profit: 5000, net_profit: 4000, orders: 5 }, FULL);
  approx(b.gross_profit, 5000 - 3535.99);
  assert.notEqual(b.net_profit, 4000);
});

test('a zero deduction is a no-op, not a rewrite', () => {
  const none = { revenueInclGst: 0, revenueExGst: 0, count: 0, unknownTotal: 0 };
  const a = applyCashBasis(LIVE_KPIS, none);
  assert.equal(a.revenue, LIVE_KPIS.revenue);
  assert.equal(a.gross_profit, LIVE_KPIS.gross_profit);
  assert.equal(a.gross_margin, undefined, 'a no-op must not invent a margin field either');
});

test('deduct then add back returns the original', () => {
  const a = applyCashBasis(LIVE_KPIS, FULL);
  approx(a.revenue + FULL.revenueInclGst, LIVE_KPIS.revenue);
  approx(a.gross_profit + FULL.revenueExGst, LIVE_KPIS.gross_profit);
  approx(a.net_profit + FULL.revenueExGst, LIVE_KPIS.net_profit);
});

// ─── 7. marginPct edge cases (ERR-113) ───────────────────────────────────────

test('marginPct refuses to explode on a near-zero base', () => {
  assert.equal(marginPct(50, 0), null);
  assert.equal(marginPct(50, 0.001), null, 'a near-zero denominator gives a meaningless 5,000,000%');
  assert.equal(marginPct(null, 1000), null);
  approx(marginPct(250, 1000), 25);
  approx(marginPct(-250, 1000), -25, 0.005, 'a negative margin is legal and must survive');
});

// ─── 8. The sentence on screen ───────────────────────────────────────────────

test('the note states the money, the count AND that the cost stays', () => {
  const s = cashBasisNote(FULL);
  assert.match(s, /4066\.39/);
  assert.match(s, /9 unpaid invoices/);
  assert.match(s, /cost of those goods stays in costs/,
    'without this clause a negative net profit reads as a fault rather than as money owed to us');
  assert.equal(cashBasisNote({ count: 0 }), null, 'nothing outstanding → no note');
});

test('the note says "1 unpaid invoice", not "1 unpaid invoices"', () => {
  assert.match(cashBasisNote({ revenueInclGst: 10, revenueExGst: 8.7, count: 1 }), /1 unpaid invoice /);
});

// ─── 9. EX_GST_FACTOR is the documented basis ────────────────────────────────

test('EX_GST_FACTOR is 20/23, and reproduces the live margin badge', () => {
  approx(EX_GST_FACTOR, 20 / 23, 1e-12);
  // Invoice 3277 renders a 7.2% badge on $1,325.95 with $83.50 profit. If this
  // arithmetic ever stops matching the page, one of the two is wrong.
  approx((83.50 / (1325.95 * EX_GST_FACTOR)) * 100, 7.24, 0.01);
});
