/**
 * dashboard-trend-math.js — Revenue & Expenses chart math
 * ========================================================
 *
 * Pins the math the admin dashboard uses to render the Revenue & Expenses
 * chart and the totals strip beneath it. The chart MUST account for every
 * dollar that left the company in a given window — COGS, operating expenses,
 * Stripe fees, and GST remitted. If any of these silently slip back to zero
 * we lose the ability to read profit/loss at a glance.
 *
 * Background (set by user 2026-05-08):
 *   - Backend /api/admin/analytics/pnl rarely populates per-period cogs, but
 *     the KPI summary (analytics_kpi_summary) reliably reports gross_profit.
 *     So COGS = revenue − gross_profit, distributed by bucket revenue.
 *   - /api/admin/analytics/expenses is the source of truth for opex (manually
 *     logged supplier purchases, marketing, etc.). Each row is bucketed at
 *     the day it happened.
 *   - Stripe + GST derive from gross order revenue + count using NZ rates.
 *
 * Run with: node --test tests/dashboard-trend-math.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'trend-math.js'
);

function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(
    /export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; }
  );
  const footer = '\n;' + [...exposed]
    .map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`)
    .join('\n');
  return stripped + footer;
}

const sandbox = {
  console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(
  stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')),
  ctx,
  { filename: 'trend-math.js' }
);

// ─── Constants ──────────────────────────────────────────────────────────────

test('STRIPE_RATE_DERIVE is 2.65% (NZ domestic card, stripe.com/nz/pricing)', () => {
  assert.equal(sandbox.STRIPE_RATE_DERIVE, 0.0265);
});

test('STRIPE_FIXED_DERIVE is $0.30 per transaction', () => {
  assert.equal(sandbox.STRIPE_FIXED_DERIVE, 0.30);
});

test('STRIPE_FEE_GST_DERIVE is 15% (GST Stripe charges on top of its fee)', () => {
  assert.equal(sandbox.STRIPE_FEE_GST_DERIVE, 0.15);
});

test('GST_FRACTION_OF_GROSS is 3/23 — output GST embedded in incl-GST sale', () => {
  assert.equal(sandbox.GST_FRACTION_OF_GROSS, 3 / 23);
  // Sanity: a $115 gross sale carries $15 GST.
  const gross = 115;
  const gst = gross * sandbox.GST_FRACTION_OF_GROSS;
  assert.ok(Math.abs(gst - 15) < 0.001, `expected $15 GST on $115 gross, got ${gst}`);
});

test('COST_GST_GROSS_UP is 1.15 — supplier paid incl-GST', () => {
  assert.equal(sandbox.COST_GST_GROSS_UP, 1.15);
});

// ─── deriveStripe / deriveGst ────────────────────────────────────────────────

test('deriveStripe: 31 orders × $1,277.36 → (2.65% + 31 × $0.30) × 1.15 ≈ $49.62', () => {
  // Matches the dashboard fixture in the user screenshot (3m window).
  // 1277.36 * 0.0265   = 33.8500
  // 31 * 0.30          =  9.30
  // base               = 43.1500
  // × 1.15 (GST on fee) = 49.6225
  const fee = sandbox.deriveStripe(1277.36, 31);
  assert.ok(Math.abs(fee - 49.6225) < 0.01, `expected ~$49.62, got ${fee}`);
});

test('deriveStripe: zero revenue + zero orders → $0', () => {
  assert.equal(sandbox.deriveStripe(0, 0), 0);
});

test('deriveStripe: 0 orders does not add the $0.30 fixed fee', () => {
  // No transactions, no fixed fee. Real-world: an empty bucket.
  // Fee is still grossed up by 1.15 for GST on the fee.
  const expected = 100 * sandbox.STRIPE_RATE_DERIVE * 1.15;
  assert.ok(Math.abs(sandbox.deriveStripe(100, 0) - expected) < 1e-9);
});

test('deriveGst: $1,277.36 gross → ~$166.61 (matches dashboard chip)', () => {
  const gst = sandbox.deriveGst(1277.36);
  assert.ok(Math.abs(gst - 166.612) < 0.01, `expected ~$166.61, got ${gst}`);
});

test('deriveGst: handles non-numeric input safely', () => {
  assert.equal(sandbox.deriveGst(null), 0);
  assert.equal(sandbox.deriveGst(undefined), 0);
  assert.equal(sandbox.deriveGst('not a number'), 0);
});

// ─── distributeCogsByRevenue ────────────────────────────────────────────────

test('distributeCogsByRevenue: total COGS split across buckets in revenue proportion', () => {
  // Corrected COGS for the screenshot fixture: kpiCogsInclGst(1277.36, 557.48)
  // = 1277.36/1.15 − 557.48 ≈ $553.27 to spread across the visible window.
  const COGS = 553.27;
  const buckets = [
    { revenue: 358.24, cogsDerived: 0 },  // 3 May
    { revenue: 358.24, cogsDerived: 0 },  // 5 Apr
    { revenue: 165, cogsDerived: 0 },
    { revenue: 117.97, cogsDerived: 0 },
    { revenue: 277.91, cogsDerived: 0 },
  ];
  sandbox.distributeCogsByRevenue(buckets, COGS);
  const totalRev = 358.24 + 358.24 + 165 + 117.97 + 277.91;
  for (const b of buckets) {
    const expected = COGS * (b.revenue / totalRev);
    assert.ok(Math.abs(b.cogsDerived - expected) < 0.01,
      `bucket rev=${b.revenue}: expected ${expected}, got ${b.cogsDerived}`);
  }
  const sumDerived = buckets.reduce((s, b) => s + b.cogsDerived, 0);
  assert.ok(Math.abs(sumDerived - COGS) < 0.01,
    `derived sum should equal total cogs, got ${sumDerived}`);
});

test('distributeCogsByRevenue: zero total revenue is a no-op (no NaN)', () => {
  const buckets = [
    { revenue: 0, cogsDerived: 0 },
    { revenue: 0, cogsDerived: 0 },
  ];
  sandbox.distributeCogsByRevenue(buckets, 100);
  for (const b of buckets) assert.equal(b.cogsDerived, 0);
});

test('distributeCogsByRevenue: invalid totalCogs is a no-op', () => {
  const buckets = [{ revenue: 100, cogsDerived: 0 }];
  sandbox.distributeCogsByRevenue(buckets, NaN);
  assert.equal(buckets[0].cogsDerived, 0);
  sandbox.distributeCogsByRevenue(buckets, -50);
  assert.equal(buckets[0].cogsDerived, 0);
});

// ─── bucketOperatingExpenses ────────────────────────────────────────────────

test('bucketOperatingExpenses: a 3 May supplier purchase lands on the 3 May bucket', () => {
  // Reproduces the user's 2026-05-08 complaint: they bought cartridges on
  // 3 May, the expense should appear on 3 May, not smeared across the month.
  const buckets = [
    { startMs: Date.UTC(2026, 3, 26), opexLogged: 0, hasOpexLogged: false }, // 26 Apr
    { startMs: Date.UTC(2026, 4, 3),  opexLogged: 0, hasOpexLogged: false }, //  3 May
    { startMs: Date.UTC(2026, 4, 10), opexLogged: 0, hasOpexLogged: false }, // 10 May
  ];
  const indexFor = (ts) => {
    const d = new Date(ts);
    const ymd = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (ymd === '2026-3-26') return 0;
    if (ymd === '2026-4-3')  return 1;
    if (ymd === '2026-4-10') return 2;
    return -1;
  };
  const rows = [
    { expense_date: '2026-05-03', amount: 250.00, category: 'cogs', vendor: 'Cartridge supplier' },
    { expense_date: '2026-05-03', amount:  45.00, category: 'shipping' },
    { expense_date: '2026-04-26', amount:  30.00, category: 'software' },
    { date:         '2026-05-10', total:   12.00, category: 'other' },
  ];
  sandbox.bucketOperatingExpenses(buckets, rows, indexFor);
  assert.equal(buckets[0].opexLogged, 30.00);
  assert.equal(buckets[1].opexLogged, 295.00);   // 250 + 45 on 3 May
  assert.equal(buckets[2].opexLogged, 12.00);
  for (const b of buckets) assert.equal(b.hasOpexLogged, true);
});

test('bucketOperatingExpenses: rows without a date are skipped, not crashed', () => {
  const buckets = [{ startMs: 0, opexLogged: 0, hasOpexLogged: false }];
  sandbox.bucketOperatingExpenses(
    buckets,
    [{ amount: 100 }, { expense_date: '', amount: 50 }, { expense_date: 'not a date', amount: 25 }],
    () => 0,
  );
  assert.equal(buckets[0].opexLogged, 0);
  assert.equal(buckets[0].hasOpexLogged, false);
});

test('bucketOperatingExpenses: dates outside the window are dropped', () => {
  const buckets = [{ startMs: 0, opexLogged: 0, hasOpexLogged: false }];
  sandbox.bucketOperatingExpenses(
    buckets,
    [{ expense_date: '2020-01-01', amount: 999 }],
    () => -1, // simulate "date is before window"
  );
  assert.equal(buckets[0].opexLogged, 0);
});

test('bucketOperatingExpenses: handles non-array input', () => {
  const buckets = [{ startMs: 0, opexLogged: 0, hasOpexLogged: false }];
  sandbox.bucketOperatingExpenses(buckets, null, () => 0);
  sandbox.bucketOperatingExpenses(buckets, undefined, () => 0);
  sandbox.bucketOperatingExpenses(buckets, { not: 'an array' }, () => 0);
  assert.equal(buckets[0].opexLogged, 0);
});

// ─── pickExpenseDate / pickExpenseAmount ─────────────────────────────────────

test('pickExpenseDate prefers expense_date, then date, then created_at', () => {
  assert.equal(sandbox.pickExpenseDate({ expense_date: 'A', date: 'B', created_at: 'C' }), 'A');
  assert.equal(sandbox.pickExpenseDate({ date: 'B', created_at: 'C' }), 'B');
  assert.equal(sandbox.pickExpenseDate({ created_at: 'C' }), 'C');
  assert.equal(sandbox.pickExpenseDate({ createdAt: 'D' }), 'D');
  assert.equal(sandbox.pickExpenseDate({}), null);
  assert.equal(sandbox.pickExpenseDate(null), null);
});

test('pickExpenseAmount prefers amount, then total, then value', () => {
  assert.equal(sandbox.pickExpenseAmount({ amount: 10, total: 20, value: 30 }), 10);
  assert.equal(sandbox.pickExpenseAmount({ total: 20, value: 30 }), 20);
  assert.equal(sandbox.pickExpenseAmount({ value: 30 }), 30);
  assert.equal(sandbox.pickExpenseAmount({}), 0);
  assert.equal(sandbox.pickExpenseAmount({ amount: 'not a number' }), 0);
});

// ─── assembleBucketExpense ───────────────────────────────────────────────────

test('assembleBucketExpense: P&L cogs trumps revenue-distributed cogs', () => {
  const b = {
    revenue: 1000, orders: 5,
    pnlCogs: 600, hasPnlCogs: true, cogsDerived: 999,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.cogsTotal, 600);
});

test('assembleBucketExpense: derived path when P&L is empty', () => {
  // Matches the dashboard fixture: rev $1,277.36 across 31 orders, no P&L data.
  // Stripe (new convention) = (1277.36 × 0.0265 + 31 × 0.30) × 1.15 ≈ 49.62
  // GST                     = 1277.36 × 3/23                        ≈ 166.612
  // COGS  = kpiCogsInclGst(1277.36, 557.48) = 1277.36/1.15 − 557.48  ≈ 553.27
  // Expenses total          ≈ 769.50; Net ≈ 507.86 (a profit).
  const b = {
    revenue: 1277.36, orders: 31,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 553.27,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.cogsTotal, 553.27);
  assert.equal(b.opexTotal, 0);
  assert.ok(Math.abs(b.stripeTotal - 49.6225) < 0.01);
  assert.ok(Math.abs(b.gstTotal    - 166.612) < 0.01);
  assert.ok(Math.abs(b.expenses - 769.50) < 0.05, `expenses=${b.expenses}`);
  assert.ok(b.net > 503 && b.net < 513, `expected profit ~$507.86, got ${b.net}`);
  assert.equal(b.hasExpense, true);
});

test('assembleBucketExpense: opex logged on the same day shows up', () => {
  // The user's 3 May supplier purchase scenario.
  // Stripe (new) = (358.24 × 0.0265 + 1 × 0.30) × 1.15 ≈ 11.26
  // GST          = 358.24 × 3/23                       ≈ 46.73
  // Expenses     = 220 + 250 + 11.26 + 46.73           ≈ 527.99
  // Net          = 358.24 − 527.99                     ≈ −170 (loss)
  const b = {
    revenue: 358.24, orders: 1,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 220,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 250,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.opexTotal, 250);
  assert.ok(b.net < 0, `expected a loss when opex blows past revenue, got net=${b.net}`);
});

test('assembleBucketExpense: zero revenue + zero opex → all-zero expenses', () => {
  const b = {
    revenue: 0, orders: 0,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.expenses, 0);
  assert.equal(b.hasExpense, false);
  assert.equal(b.net, 0);
});

// ─── sumTrendTotals ─────────────────────────────────────────────────────────

test('sumTrendTotals: sums every component across the window', () => {
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40, opexTotal: 5,  stripeTotal: 5, gstTotal: 10, orders: 2 },
    { revenue: 200, expenses: 110, cogsTotal: 80, opexTotal: 10, stripeTotal: 8, gstTotal: 12, orders: 3 },
  ];
  const t = sandbox.sumTrendTotals(series);
  assert.equal(t.revenue, 300);
  assert.equal(t.expenses, 170);
  assert.equal(t.cogs, 120);
  assert.equal(t.opex, 15);
  assert.equal(t.stripe, 13);
  assert.equal(t.gst, 22);
  assert.equal(t.orders, 5);
});

test('sumTrendTotals: empty / nullish series returns zeros, no crash', () => {
  for (const v of [null, undefined, []]) {
    const t = sandbox.sumTrendTotals(v);
    assert.equal(t.revenue, 0);
    assert.equal(t.expenses, 0);
    assert.equal(t.cogs, 0);
    assert.equal(t.opex, 0);
    assert.equal(t.stripe, 0);
    assert.equal(t.gst, 0);
    assert.equal(t.orders, 0);
  }
});

// ─── Integration: the user's screenshot fixture ─────────────────────────────

test('integration: dashboard 3m window matches the user-visible totals', () => {
  // Reproduce the screenshot fixture: revenue $1,277.36, gross_profit $557.48,
  // 31 orders, no logged opex. With the corrected COGS formula:
  //   COGS   = kpiCogsInclGst(1277.36, 557.48) = 1277.36/1.15 − 557.48 ≈ 553.27
  //   Stripe = (1277.36 × 0.0265 + 31 × 0.30) × 1.15   ≈ 49.62
  //   GST    = 1277.36 × (3/23)                        ≈ 166.61
  //   Opex   = 0 (none logged)
  //   Total  ≈ 769.50
  //   Net    ≈ 507.86 profit
  const buckets = [
    { revenue: 1277.36, orders: 31,
      pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  // Step 1: distribute KPI cogs across (only one) bucket. The total COGS comes
  // from kpiCogsInclGst — NOT a raw `revenue − gross_profit` subtraction.
  const totalCogs = sandbox.kpiCogsInclGst(1277.36, 557.48);
  sandbox.distributeCogsByRevenue(buckets, totalCogs);
  // Step 2: assemble
  sandbox.assembleBucketExpense(buckets[0]);
  const totals = sandbox.sumTrendTotals(buckets);

  assert.ok(Math.abs(totals.cogs   - 553.27)  < 0.05, `cogs=${totals.cogs}`);
  assert.equal(totals.opex, 0);
  assert.ok(Math.abs(totals.stripe - 49.6225) < 0.01, `stripe=${totals.stripe}`);
  assert.ok(Math.abs(totals.gst    - 166.612) < 0.01, `gst=${totals.gst}`);
  assert.ok(Math.abs(totals.expenses - 769.50) < 0.05,
    `expected ~$769.50 expenses, got ${totals.expenses}`);
  // Regression guard: expenses must still INCLUDE cogs (the broken cogs=0 path
  // showed only ~$215.66) — but must NOT double-count it via the old ×1.15
  // over-gross-up (which inflated expenses to ~$936).
  assert.ok(totals.expenses > 700 && totals.expenses < 800,
    `regression guard: expenses must include cogs once, got ${totals.expenses}`);
});

test('integration: a bucket with logged opex flips a profit window into a loss', () => {
  // Real-world: a single $5,000 inventory purchase on a slow sales day.
  const buckets = [
    { revenue: 100, orders: 1,
      pnlCogs: 0, hasPnlCogs: false, cogsDerived: 60,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 5000,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  sandbox.assembleBucketExpense(buckets[0]);
  const totals = sandbox.sumTrendTotals(buckets);
  assert.ok(totals.expenses > totals.revenue,
    'a logged opex bigger than revenue must produce a visible loss');
  assert.ok(buckets[0].net < 0, 'net must be negative on a loss day');
});

// ─── kpiCogsInclGst — incl-GST cost from the KPI summary ────────────────────
//
// Formula corrected 2026-05-16. The KPI summary reports `revenue` GROSS and
// `gross_profit = revenue_ex_gst − cost_incl_gst`. So:
//     cost_incl_gst = revenue_ex_gst − gross_profit
//                   = (revenue_gross / 1.15) − gross_profit
// The previous `(revenue − gross_profit) × 1.15` over-counted COGS by ~38%
// because `revenue_gross − gross_profit` already equals
// `output_GST + cost_incl_gst` — see the regression guards below.

test('kpiCogsInclGst: $1,277.36 revenue − $557.48 GP → $553.27 incl-GST cost', () => {
  // (1277.36 / 1.15) − 557.48 = 1110.748 − 557.48 = 553.268
  const cogs = sandbox.kpiCogsInclGst(1277.36, 557.48);
  assert.ok(Math.abs(cogs - 553.268) < 0.01, `expected ~$553.27, got ${cogs}`);
});

test('kpiCogsInclGst: current screenshot fixture $1,354.10 / $594.46 → $583.02', () => {
  // The 2026-05-16 dashboard screenshot: revenue $1,354.10, gross_profit
  // $594.46. (1354.10 / 1.15) − 594.46 = 1177.478 − 594.46 = 583.018.
  const cogs = sandbox.kpiCogsInclGst(1354.10, 594.46);
  assert.ok(Math.abs(cogs - 583.018) < 0.01, `expected ~$583.02, got ${cogs}`);
});

test('kpiCogsInclGst: regression — never re-introduce the ×1.15 over-gross-up', () => {
  // The buggy formula gave (1354.10 − 594.46) × 1.15 = $873.59 — a $290
  // over-count. Guard the corrected value stays well clear of it.
  const cogs = sandbox.kpiCogsInclGst(1354.10, 594.46);
  assert.ok(cogs < 600, `COGS must not balloon back toward the $873.59 bug, got ${cogs}`);
});

test('kpiCogsInclGst: KPI fallback agrees with exact per-order COGS', () => {
  // The whole point of the fix: when items[] are absent and the chart falls
  // back to the KPI figure, it must land on the SAME number the per-order
  // path produces. 4 May order — true cost incl-GST = 198.65 × 1.15 = 228.45.
  //   revenue gross 358.24, gross_profit = 311.513 − 228.448 = 83.065
  const perOrder = sandbox.orderCostInclGst({
    items: [
      { qty: 1, supplier_cost_snapshot: 18.85 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
      { qty: 1, supplier_cost_snapshot: 40.00 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
    ],
  });
  const kpiFallback = sandbox.kpiCogsInclGst(358.24, 83.065);
  assert.ok(Math.abs(kpiFallback - perOrder) < 0.05,
    `KPI fallback (${kpiFallback}) must match per-order cost (${perOrder})`);
});

test('kpiCogsInclGst: NaN inputs return 0, not NaN', () => {
  assert.equal(sandbox.kpiCogsInclGst(NaN, 100), 0);
  assert.equal(sandbox.kpiCogsInclGst(100, NaN), 0);
  assert.equal(sandbox.kpiCogsInclGst(undefined, undefined), 0);
});

test('kpiCogsInclGst: GP > revenue (negative implied cost) clamps to 0', () => {
  // Defensive: negative cost would be nonsensical. Don't propagate it.
  assert.equal(sandbox.kpiCogsInclGst(100, 200), 0);
});

// ─── orderCostInclGst — exact per-order cost from line items ────────────────

test('orderCostInclGst: ORD-MOQBMOJI 4 May fixture → $228.45 incl-GST', () => {
  // The user's actual order from the screenshot:
  //   6 line items, total cost (excl. GST) = $198.65
  //   Real cash to suppliers = 198.65 × 1.15 = 228.4475
  const order = {
    created_at: '2026-05-04T03:00:00Z',
    total: 358.24,
    items: [
      { sku: 'C-HP-CART319-TNR-BK',  qty: 1, supplier_cost_snapshot: 18.85 },
      { sku: 'C-BRO-TN258XL-TNR-BK', qty: 1, supplier_cost_snapshot: 34.95 },
      { sku: 'C-BRO-TN349-TNR-BK',   qty: 1, supplier_cost_snapshot: 40.00 },
      { sku: 'C-BRO-TN258XL-TNR-YL', qty: 1, supplier_cost_snapshot: 34.95 },
      { sku: 'C-BRO-TN258XL-TNR-MG', qty: 1, supplier_cost_snapshot: 34.95 },
      { sku: 'C-BRO-TN258XL-TNR-CY', qty: 1, supplier_cost_snapshot: 34.95 },
    ],
  };
  // Sum ex-GST = 18.85 + 34.95 + 40 + 34.95 + 34.95 + 34.95 = 198.65
  // × 1.15 = 228.4475
  const cost = sandbox.orderCostInclGst(order);
  assert.ok(Math.abs(cost - 228.4475) < 0.01, `expected $228.45, got ${cost}`);
});

test('orderCostInclGst: respects qty multiplier', () => {
  const order = {
    items: [
      { qty: 3, supplier_cost_snapshot: 10 }, // 30 ex-GST → 34.50 incl
      { qty: 2, supplier_cost_snapshot: 5 },  // 10 ex-GST → 11.50 incl
    ],
  };
  // Total ex-GST = 40, × 1.15 = 46.00
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 46.0) < 0.01);
});

test('orderCostInclGst: missing items → 0 (caller falls back to KPI)', () => {
  assert.equal(sandbox.orderCostInclGst({ total: 100 }), 0);
  assert.equal(sandbox.orderCostInclGst({ items: [] }), 0);
  assert.equal(sandbox.orderCostInclGst(null), 0);
  assert.equal(sandbox.orderCostInclGst(undefined), 0);
});

test('orderCostInclGst: items without supplier_cost_snapshot are skipped', () => {
  const order = {
    items: [
      { qty: 1, supplier_cost_snapshot: 10 },
      { qty: 1, sku: 'no-cost' }, // skipped
      { qty: 1, supplier_cost_snapshot: null }, // skipped
    ],
  };
  // Only the first item has cost → 10 ex-GST → 11.50 incl
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 11.5) < 0.01);
});

test('orderCostInclGst: prefers order-level cost field when items absent', () => {
  // Forward-compat: if backend ever ships an aggregated cost on the list endpoint,
  // we use it without needing items[]. Still grosses up by 1.15.
  const order = { cost_total_excl_gst: 100 };
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 115) < 0.01);
});

test('orderCostInclGst: uses qty if quantity is absent', () => {
  // The dashboard list endpoint has historically used either field name.
  const order = { items: [{ quantity: 2, supplier_cost_snapshot: 10 }] };
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 23) < 0.01);
});

// ─── bucketCogsFromOrders ────────────────────────────────────────────────────

test('bucketCogsFromOrders: 4 May order → 4 May bucket gets $228.45', () => {
  const buckets = [
    { startMs: Date.UTC(2026, 3, 26), cogsFromOrders: 0, hasOrderCogs: false },
    { startMs: Date.UTC(2026, 4, 4),  cogsFromOrders: 0, hasOrderCogs: false },
  ];
  const indexFor = (ts) => {
    const d = new Date(ts);
    if (d.getUTCMonth() === 3) return 0;  // April
    if (d.getUTCMonth() === 4) return 1;  // May
    return -1;
  };
  const orders = [
    {
      created_at: '2026-05-04T03:00:00Z', total: 358.24,
      items: [
        { qty: 1, supplier_cost_snapshot: 18.85 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
        { qty: 1, supplier_cost_snapshot: 40.00 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
      ],
    },
  ];
  const { resolvedCount, resolvedRevenue } = sandbox.bucketCogsFromOrders(buckets, orders, indexFor);
  assert.equal(resolvedCount, 1);
  assert.ok(Math.abs(resolvedRevenue - 358.24) < 0.01);
  assert.equal(buckets[0].cogsFromOrders, 0);
  assert.equal(buckets[0].hasOrderCogs, false);
  assert.ok(Math.abs(buckets[1].cogsFromOrders - 228.4475) < 0.01,
    `bucket 4 May should have $228.45, got ${buckets[1].cogsFromOrders}`);
  assert.equal(buckets[1].hasOrderCogs, true);
});

test('bucketCogsFromOrders: orders without items[] do not block resolution of others', () => {
  const buckets = [{ startMs: 0, cogsFromOrders: 0, hasOrderCogs: false }];
  const indexFor = () => 0;
  const orders = [
    { created_at: '2026-05-01T00:00:00Z', total: 100 },           // no items
    { created_at: '2026-05-02T00:00:00Z', total: 50,
      items: [{ qty: 1, supplier_cost_snapshot: 30 }] },           // exact: 34.50
  ];
  const { resolvedCount, resolvedRevenue } = sandbox.bucketCogsFromOrders(buckets, orders, indexFor);
  assert.equal(resolvedCount, 1);
  assert.equal(resolvedRevenue, 50);
  assert.ok(Math.abs(buckets[0].cogsFromOrders - 34.5) < 0.01);
});

// ─── assembleBucketExpense: per-order COGS preference ───────────────────────

test('assembleBucketExpense: order-resolved COGS trumps revenue-distributed', () => {
  const b = {
    revenue: 358.24, orders: 1,
    pnlCogs: 0, hasPnlCogs: false,
    cogsDerived: 999, // garbage smear value
    cogsFromOrders: 228.4475, hasOrderCogs: true,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.ok(Math.abs(b.cogsTotal - 228.4475) < 0.01,
    `must use exact per-order COGS over the smear, got ${b.cogsTotal}`);
});

// ─── expandRecurringExpenses (recurring subscriptions) ─────────────────────
//
// Pinned 2026-05-10. Spec at readfirst/recurring-expenses-may2026.md.
// Each expense row may carry a `recurrence` field; for each fire-date that
// falls inside [windowStart, windowEnd] the helper emits a virtual row with a
// synthesised expense_date so the bucketer can treat the lot as a flat list.
//
// Why these tests matter: every cash-out day on the dashboard must be honest.
// The user's #1 ask was "no smearing, no fake spike on the 1st" — these guards
// keep recurring expenses landing on the actual billing day.

test('expandRecurringExpenses: a one-off row passes through unchanged', () => {
  const row = { date: '2026-05-03', amount: 250, category: 'cogs', vendor: 'Supplier' };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 4, 1), Date.UTC(2026, 5, 1),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0], row, 'one-off rows should reference-pass through, not be cloned');
});

test('expandRecurringExpenses: monthly day-12 across a 90-day window emits 3 occurrences', () => {
  const row = {
    date: '2026-01-12',
    amount: 30,
    vendor: 'Vercel Pro',
    recurrence: 'monthly',
    recurrence_day_of_month: 12,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 1, 1), Date.UTC(2026, 4, 1), // 1 Feb → 1 May
  );
  assert.equal(out.length, 3, 'expected Feb 12 / Mar 12 / Apr 12');
  assert.deepEqual([...out.map(r => r.expense_date)], ['2026-02-12', '2026-03-12', '2026-04-12']);
  // Amount + vendor preserved on each occurrence.
  for (const r of out) {
    assert.equal(r.amount, 30);
    assert.equal(r.vendor, 'Vercel Pro');
    assert.equal(r.recurrence, undefined, 'recurrence keys must be stripped from emitted occurrences');
  }
});

test('expandRecurringExpenses: month-end clamp — day 31 in Feb fires on Feb 28 (2026)', () => {
  const row = {
    date: '2026-01-31',
    amount: 10,
    recurrence: 'monthly',
    recurrence_day_of_month: 31,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 1, 1), Date.UTC(2026, 5, 1), // Feb → June
  );
  // 2026 is not a leap year → Feb 28.
  assert.deepEqual(
    [...out.map(r => r.expense_date)],
    ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'],
    'day-31 must clamp to month-end for short months',
  );
});

test('expandRecurringExpenses: month-end clamp — day 31 in Feb fires on Feb 29 (2024 leap)', () => {
  const row = {
    date: '2024-01-31',
    amount: 10,
    recurrence: 'monthly',
    recurrence_day_of_month: 31,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 15),
  );
  assert.deepEqual([...out.map(r => r.expense_date)], ['2024-02-29']);
});

test('expandRecurringExpenses: weekly Wednesday across 4 weeks emits 4 occurrences', () => {
  const row = {
    date: '2026-05-04', // Mon
    amount: 12,
    recurrence: 'weekly',
    recurrence_day_of_week: 3, // Wed
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 4, 1), Date.UTC(2026, 4, 31),
  );
  assert.deepEqual(
    [...out.map(r => r.expense_date)],
    ['2026-05-06', '2026-05-13', '2026-05-20', '2026-05-27'],
  );
});

test('expandRecurringExpenses: yearly Mar 23 — 14-month window emits once, 26-month window emits twice', () => {
  const row = {
    date: '2025-03-23',
    amount: 80,
    vendor: 'Domain renewal',
    recurrence: 'yearly',
    recurrence_month: 3,
    recurrence_day_of_month: 23,
  };
  const oneYear = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2025, 5, 1), Date.UTC(2026, 6, 1), // Jun 2025 → Jul 2026 (~13mo)
  );
  assert.deepEqual([...oneYear.map(r => r.expense_date)], ['2026-03-23']);

  const twoYears = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2025, 0, 1), Date.UTC(2027, 5, 1), // Jan 2025 → Jun 2027
  );
  assert.deepEqual([...twoYears.map(r => r.expense_date)],
    ['2025-03-23', '2026-03-23', '2027-03-23']);
});

test('expandRecurringExpenses: custom every-90-days walks correctly from start', () => {
  const row = {
    date: '2026-01-01',
    amount: 600,
    recurrence: 'custom',
    recurrence_interval_days: 90,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31),
  );
  // 1 Jan + 90d = 1 Apr; +90d = 30 Jun; +90d = 28 Sep; +90d = 27 Dec
  assert.deepEqual([...out.map(r => r.expense_date)],
    ['2026-01-01', '2026-04-01', '2026-06-30', '2026-09-28', '2026-12-27']);
});

test('expandRecurringExpenses: recurrence_end stops the series mid-window', () => {
  const row = {
    date: '2026-01-12',
    amount: 30,
    recurrence: 'monthly',
    recurrence_day_of_month: 12,
    recurrence_end: '2026-03-31',
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 0, 1), Date.UTC(2026, 5, 1), // Jan → Jun
  );
  // Cancelled 31 Mar → no Apr 12, no May 12.
  assert.deepEqual([...out.map(r => r.expense_date)], ['2026-01-12', '2026-02-12', '2026-03-12']);
});

test('expandRecurringExpenses: occurrences before windowStart are not emitted', () => {
  const row = {
    date: '2025-01-12',
    amount: 30,
    recurrence: 'monthly',
    recurrence_day_of_month: 12,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 4, 1), Date.UTC(2026, 6, 1), // May → Jul 2026
  );
  // Series started Jan 2025 but only the in-window months emit.
  assert.deepEqual([...out.map(r => r.expense_date)], ['2026-05-12', '2026-06-12']);
});

test('expandRecurringExpenses: handles non-array input safely', () => {
  assert.equal(sandbox.expandRecurringExpenses(null, 0, 1).length, 0);
  assert.equal(sandbox.expandRecurringExpenses(undefined, 0, 1).length, 0);
  assert.equal(sandbox.expandRecurringExpenses({ not: 'an array' }, 0, 1).length, 0);
});

test('expandRecurringExpenses: unknown recurrence value falls through as one-off', () => {
  const row = { date: '2026-05-03', amount: 5, recurrence: 'tuesday-of-leap-year' };
  const out = sandbox.expandRecurringExpenses([row], 0, Date.UTC(2030, 0, 1));
  assert.equal(out.length, 1);
  assert.equal(out[0], row);
});

test('expandRecurringExpenses: invalid weekly/monthly/custom params drop silently', () => {
  // Recurring without enough info to know when to fire is dropped, not exploded
  // into garbage rows.
  const rows = [
    { date: '2026-05-01', amount: 1, recurrence: 'weekly' /* no dow */ },
    { date: '2026-05-01', amount: 2, recurrence: 'weekly', recurrence_day_of_week: 99 },
    { date: '2026-05-01', amount: 3, recurrence: 'monthly' /* no dom */ },
    { date: '2026-05-01', amount: 4, recurrence: 'custom' /* no interval */ },
    { /* no start date */ amount: 5, recurrence: 'monthly', recurrence_day_of_month: 1 },
  ];
  const out = sandbox.expandRecurringExpenses(
    rows, Date.UTC(2026, 4, 1), Date.UTC(2026, 5, 1),
  );
  assert.equal(out.length, 0);
});

test('expandRecurringExpenses: end-to-end with bucketOperatingExpenses — empty days stay $0', () => {
  // Integration guard for the user's "$29.80 ghost" scenario. A single monthly
  // recurring sub bills on the 12th. The 7-day window 2 May–8 May contains
  // ZERO occurrences → every day's opexLogged stays 0.
  const buckets = [
    { startMs: Date.UTC(2026, 4, 2), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 3), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 4), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 5), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 6), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 7), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 8), opexLogged: 0, hasOpexLogged: false },
  ];
  const indexFor = (ts) => {
    const day = new Date(ts).getUTCDate();
    return (day >= 2 && day <= 8) ? day - 2 : -1;
  };
  const expanded = sandbox.expandRecurringExpenses(
    [{ date: '2026-01-12', amount: 30, recurrence: 'monthly', recurrence_day_of_month: 12 }],
    Date.UTC(2026, 4, 2), Date.UTC(2026, 4, 9),
  );
  sandbox.bucketOperatingExpenses(buckets, expanded, indexFor);
  for (const b of buckets) {
    assert.equal(b.opexLogged, 0, 'no recurring fire-date in 2-8 May → all days $0');
  }
});

// ─── Integration: the user's 4 May order, expenses must be ≥ $285 ───────────

test('integration: 4 May order single-bucket — expenses match cost+stripe+gst exactly', () => {
  // Reproduces the user's complaint on 2026-05-08:
  //   "How can the expenses be $209 for the order on the 4th of may if just
  //   the costs for the products are $198.65 before gst."
  //
  // After the fix, the 4 May bucket must show (2026-05-12 Stripe convention):
  //   Cost incl-GST: 198.65 × 1.15                    = 228.4475
  //   Stripe:        (358.24 × 0.0265 + 1 × 0.30) × 1.15 ≈ 11.262
  //   GST output:    358.24 × 3/23                     ≈ 46.727
  //   ─────────────────────────────────────────────────────────
  //   Total:                                           ≈ 286.44
  //
  // The chart used to show $208.99 on this bucket. Anything below $285 means
  // the 1.15 gross-up was lost again or per-order COGS regressed.
  const items = [
    { qty: 1, supplier_cost_snapshot: 18.85 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
    { qty: 1, supplier_cost_snapshot: 40.00 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
  ];
  const buckets = [
    { startMs: 0, revenue: 358.24, orders: 1,
      pnlCogs: 0, hasPnlCogs: false,
      cogsDerived: 0,
      cogsFromOrders: 0, hasOrderCogs: false,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  const indexFor = () => 0;
  sandbox.bucketCogsFromOrders(buckets, [{
    created_at: '2026-05-04T03:00:00Z', total: 358.24, items,
  }], indexFor);
  sandbox.assembleBucketExpense(buckets[0]);

  assert.ok(buckets[0].expenses >= 285, `regression guard: 4 May expenses must be ≥ $285 (cost incl-GST + Stripe + GST), got ${buckets[0].expenses}`);
  assert.ok(buckets[0].expenses < 290, `4 May expenses must not exceed $290, got ${buckets[0].expenses}`);
  assert.ok(Math.abs(buckets[0].cogsTotal - 228.4475) < 0.01,
    `cogs must equal cost-incl-GST exactly when items[] are present: ${buckets[0].cogsTotal}`);
});

test('integration: when items[] are absent, KPI fallback equals the per-order cost', () => {
  // No items[] → the chart falls back to the KPI total cogs (kpiCogsInclGst)
  // distributed by revenue share. For a single-bucket window that means
  // bucket cogs = total kpiCogsInclGst.
  const buckets = [
    { revenue: 358.24, orders: 1,
      pnlCogs: 0, hasPnlCogs: false,
      cogsDerived: 0,
      cogsFromOrders: 0, hasOrderCogs: false,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  // Single-order window: revenue gross 358.24, gross_profit per profitability.js
  // = revenue_ex_gst − cost_incl_gst = 311.513 − 228.448 = 83.065.
  // Corrected fallback: kpiCogsInclGst(358.24, 83.065)
  //   = 358.24/1.15 − 83.065 = 311.513 − 83.065 = 228.448
  // — i.e. EXACTLY the per-order cost. Pre-fix this returned $316.45 (a 38%
  // over-count); the fallback and the exact path must now agree.
  const totalCogs = sandbox.kpiCogsInclGst(358.24, 83.065);
  sandbox.distributeCogsByRevenue(buckets, totalCogs);
  sandbox.assembleBucketExpense(buckets[0]);
  assert.ok(Math.abs(buckets[0].cogsTotal - 228.4475) < 0.1,
    `KPI-fallback COGS must match the exact per-order cost ($228.45), got ${buckets[0].cogsTotal}`);
  assert.ok(buckets[0].cogsTotal < 300,
    `regression guard: fallback must not balloon back to the $316 over-count, got ${buckets[0].cogsTotal}`);
});

// ─── isRevenueOrder — order-status filter ───────────────────────────────────
//
// The dashboard counts orders for the Trends tally + Stripe fixed-fee from the
// bulk /orders endpoint, which returns every status. analytics_kpi_summary
// counts sales only — `isRevenueOrder` filters raw orders to match it.

test('isRevenueOrder: paid / shipped / completed / delivered count as sales', () => {
  for (const status of ['paid', 'shipped', 'completed', 'delivered', 'processing', 'refunded', 'fulfilled']) {
    assert.equal(sandbox.isRevenueOrder({ status }), true, `${status} should count`);
  }
});

test('isRevenueOrder: pending / cancelled / failed / abandoned are excluded', () => {
  for (const status of ['pending', 'cancelled', 'failed', 'abandoned']) {
    assert.equal(sandbox.isRevenueOrder({ status }), false, `${status} should be excluded`);
  }
});

test('isRevenueOrder: status match is case-insensitive', () => {
  assert.equal(sandbox.isRevenueOrder({ status: 'CANCELLED' }), false);
  assert.equal(sandbox.isRevenueOrder({ status: 'Pending' }), false);
  assert.equal(sandbox.isRevenueOrder({ status: 'PAID' }), true);
});

test('isRevenueOrder: missing / unknown status defaults to counting', () => {
  // An order with no status string still represents a placed order; only the
  // explicit non-revenue statuses are dropped.
  assert.equal(sandbox.isRevenueOrder({}), true);
  assert.equal(sandbox.isRevenueOrder({ status: null }), true);
  assert.equal(sandbox.isRevenueOrder(null), true);
});

test('NON_REVENUE_ORDER_STATUSES: the excluded set is exactly the 4 known non-sales', () => {
  assert.deepEqual(
    [...sandbox.NON_REVENUE_ORDER_STATUSES].sort(),
    ['abandoned', 'cancelled', 'failed', 'pending'],
  );
});

test('isRevenueOrder: a 42-order window with 9 non-sales filters down to 33', () => {
  // Reproduces the 2026-05-16 screenshot discrepancy: the bulk endpoint
  // returned 42 orders, the KPI summary counted 33. The 9 extra were
  // pending/cancelled/failed and inflated the Stripe fixed-fee.
  const orders = [];
  for (let i = 0; i < 33; i++) orders.push({ status: 'paid' });
  for (let i = 0; i < 5; i++)  orders.push({ status: 'pending' });
  for (let i = 0; i < 3; i++)  orders.push({ status: 'cancelled' });
  orders.push({ status: 'failed' });
  const counted = orders.filter(sandbox.isRevenueOrder);
  assert.equal(counted.length, 33, `expected 33 revenue orders, got ${counted.length}`);
});

// ─── deriveKpisFromOrders — KPI strip self-heal (ERR-010) ────────────────────
//
// The dashboard KPI cards (Revenue, Orders, Avg Order Value, Gross Profit) are
// fed by the analytics_kpi_summary RPC. That RPC's GRANT EXECUTE has been
// dropped by a backend redeploy more than once — when it is, the whole strip
// shows "—" even though /api/admin/orders still returns every order.
// deriveKpisFromOrders reconstructs the headline numbers from that order feed.

test('deriveKpisFromOrders: non-array / empty input returns null', () => {
  assert.equal(sandbox.deriveKpisFromOrders(null), null);
  assert.equal(sandbox.deriveKpisFromOrders(undefined), null);
  assert.equal(sandbox.deriveKpisFromOrders([]), null);
  assert.equal(sandbox.deriveKpisFromOrders('nope'), null);
});

test('deriveKpisFromOrders: a window of only non-revenue orders returns null', () => {
  const orders = [
    { status: 'pending', total: 50 },
    { status: 'cancelled', total: 99 },
    { status: 'failed', total: 12 },
  ];
  assert.equal(sandbox.deriveKpisFromOrders(orders), null);
});

test('deriveKpisFromOrders: sums o.total over revenue orders for GROSS revenue', () => {
  const orders = [
    { status: 'paid', total: 324.74 },
    { status: 'shipped', total: 53.79 },
    { status: 'delivered', total: 100.00 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.ok(Math.abs(k.revenue - 478.53) < 0.001, `revenue ${k.revenue}`);
  assert.equal(k.orders, 3);
  assert.equal(k._derived, true);
});

test('deriveKpisFromOrders: pending / cancelled / failed orders are excluded', () => {
  const orders = [
    { status: 'paid', total: 200 },
    { status: 'pending', total: 999 },     // not yet a sale
    { status: 'cancelled', total: 999 },   // never collected
    { status: 'paid', total: 100 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.revenue, 300);
  assert.equal(k.orders, 2);
});

test('deriveKpisFromOrders: o.amount is used when o.total is absent', () => {
  const k = sandbox.deriveKpisFromOrders([{ status: 'paid', amount: 75.5 }]);
  assert.equal(k.revenue, 75.5);
  assert.equal(k.orders, 1);
});

test('deriveKpisFromOrders: zero / negative / non-numeric totals are skipped', () => {
  const orders = [
    { status: 'paid', total: 0 },
    { status: 'paid', total: -10 },
    { status: 'paid', total: 'abc' },
    { status: 'paid', total: 120 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.revenue, 120);
  assert.equal(k.orders, 1);
});

test('deriveKpisFromOrders: unwraps { orders: [...] } and { data: [...] } envelopes', () => {
  const rows = [{ status: 'paid', total: 60 }, { status: 'paid', total: 40 }];
  for (const wrapped of [{ orders: rows }, { data: rows }]) {
    const k = sandbox.deriveKpisFromOrders(wrapped);
    assert.equal(k.revenue, 100);
    assert.equal(k.orders, 2);
  }
});

test('deriveKpisFromOrders: gross_profit is null when ANY order lacks cost data', () => {
  const orders = [
    { status: 'paid', total: 115, items: [{ supplier_cost_snapshot: 40, qty: 1 }] },
    { status: 'paid', total: 115 },  // no items[] — cost unknown
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.revenue, 230);
  assert.equal(k.orders, 2);
  // A partial cost sum would understate COGS and overstate profit — honest "—".
  assert.equal(k.gross_profit, null);
});

test('deriveKpisFromOrders: gross_profit computed when every order has cost data', () => {
  // $115 gross → $100 ex-GST. Cost ex-GST $40 → incl-GST $46. Profit = $54.
  const orders = [
    { status: 'paid', total: 115, items: [{ supplier_cost_snapshot: 40, qty: 1 }] },
    { status: 'paid', total: 230, items: [{ supplier_cost_snapshot: 40, qty: 2 }] },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  // ex-GST revenue 300; cost incl-GST (40 + 80) × 1.15 = 138; profit = 162.
  assert.ok(Math.abs(k.gross_profit - 162) < 0.001, `gross_profit ${k.gross_profit}`);
});

test('deriveKpisFromOrders: order-level cost_total_excl_gst counts as cost data', () => {
  const orders = [
    { status: 'paid', total: 115, cost_total_excl_gst: 40 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.ok(Math.abs(k.gross_profit - (100 - 46)) < 0.001, `gross_profit ${k.gross_profit}`);
});

test('deriveKpisFromOrders: reproduces the screenshot — blank strip becomes real numbers', () => {
  // 8 recent orders from the 2026-05-17 dashboard screenshot window. The KPI
  // RPC was down (strip showed "—"); the order feed was intact.
  const orders = [
    { status: 'paid', total: 324.74 }, { status: 'paid', total: 53.79 },
    { status: 'paid', total: 210.00 }, { status: 'shipped', total: 88.40 },
    { status: 'delivered', total: 412.10 }, { status: 'paid', total: 19.99 },
    { status: 'paid', total: 145.50 }, { status: 'completed', total: 67.25 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.orders, 8);
  assert.ok(k.revenue > 0, 'revenue must be a real positive number, not "—"');
  const aov = k.revenue / k.orders;
  assert.ok(aov > 0, 'avg order value derives cleanly from revenue / orders');
});

// ─── kpiCogsInclGst — null gross_profit must NOT become full-revenue COGS ────

test('kpiCogsInclGst: null gross_profit returns 0, not the entire ex-GST revenue', () => {
  // Number(null) === 0 (finite) — without an explicit null check this returned
  // revenueExGst, painting COGS = all revenue on the KPI fallback path.
  assert.equal(sandbox.kpiCogsInclGst(1678.84, null), 0);
  assert.equal(sandbox.kpiCogsInclGst(1678.84, undefined), 0);
  assert.equal(sandbox.kpiCogsInclGst(null, 500), 0);
  assert.equal(sandbox.kpiCogsInclGst(undefined, undefined), 0);
});

test('kpiCogsInclGst: real revenue + gross_profit still recovers incl-GST COGS', () => {
  // $1,150 gross → $1,000 ex-GST. gross_profit $400 → COGS incl-GST $600.
  const cogs = sandbox.kpiCogsInclGst(1150, 400);
  assert.ok(Math.abs(cogs - 600) < 0.001, `expected $600 COGS, got ${cogs}`);
});

// ─── cogsIsKnown — COGS-unknown vs COGS-genuinely-zero ──────────────────────
//
// Added 2026-05-17 (ERR-028). When the analytics RPC is down AND the bulk
// orders feed carries no per-item supplier cost, the dashboard cannot value
// COGS. `assembleBucketExpense` then leaves cogsTotal at 0 — but that 0 means
// "unknown", not "the goods cost nothing". `cogsIsKnown` distinguishes the two
// so renderTrendTotals can refuse to fold a missing cost line into a confident
// green "Profit" figure (it shows a neutral "Net excl. COGS" instead).

test('cogsIsKnown: no source resolved + real revenue → COGS unknown', () => {
  // The 2026-05-17 screenshot exactly: RPC down (kpiCogsTotal 0), bulk-orders
  // feed had no items[] (hasOrderCogs false), no P&L. COGS is unknown.
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: false, kpiCogsTotal: 0,
  }), false);
});

test('cogsIsKnown: a positive KPI cost total marks COGS known', () => {
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: false, kpiCogsTotal: 553.27,
  }), true);
});

test('cogsIsKnown: per-order item costs mark COGS known even with RPC down', () => {
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: true, kpiCogsTotal: 0,
  }), true);
});

test('cogsIsKnown: backend P&L COGS marks COGS known', () => {
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: true, hasOrderCogs: false, kpiCogsTotal: 0,
  }), true);
});

test('cogsIsKnown: a window with no revenue has no COGS to know → known', () => {
  // An empty date range must NOT raise a spurious "cost missing" warning.
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 0, hasPnlCogs: false, hasOrderCogs: false, kpiCogsTotal: 0,
  }), true);
  assert.equal(sandbox.cogsIsKnown({}), true);
  assert.equal(sandbox.cogsIsKnown(), true);
});

test('cogsIsKnown: negative / non-numeric revenue is treated as no revenue', () => {
  assert.equal(sandbox.cogsIsKnown({ windowRevenue: -5, kpiCogsTotal: 0 }), true);
  assert.equal(sandbox.cogsIsKnown({ windowRevenue: 'nope', kpiCogsTotal: 0 }), true);
});

// ─── sumTrendTotals — cogsKnown propagation ─────────────────────────────────

test('sumTrendTotals: cogsKnown stays true when every bucket has known COGS', () => {
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40, cogsKnown: true },
    { revenue: 200, expenses: 90, cogsTotal: 70, cogsKnown: true },
  ];
  assert.equal(sandbox.sumTrendTotals(series).cogsKnown, true);
});

test('sumTrendTotals: one bucket with cogsKnown:false poisons the whole window', () => {
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40, cogsKnown: true },
    { revenue: 200, expenses: 20, cogsTotal: 0,  cogsKnown: false },
  ];
  assert.equal(sandbox.sumTrendTotals(series).cogsKnown, false);
});

test('sumTrendTotals: cogsKnown defaults to true for legacy buckets without the flag', () => {
  // Buckets predating ERR-028 carry no cogsKnown — absence must not be read
  // as "unknown", or every cached render would flip to the warning state.
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40 },
    { revenue: 200, expenses: 90, cogsTotal: 70 },
  ];
  assert.equal(sandbox.sumTrendTotals(series).cogsKnown, true);
});

test('sumTrendTotals: empty / nullish series reports cogsKnown true', () => {
  for (const v of [null, undefined, []]) {
    assert.equal(sandbox.sumTrendTotals(v).cogsKnown, true);
  }
});

test('integration: ERR-028 screenshot — COGS unknown, net must NOT read as profit', () => {
  // The 2026-05-17 window: revenue $1,678.84, RPC down so gross_profit null →
  // kpiCogsInclGst returns 0, no per-order items[], no P&L. COGS is unknown.
  // The bucket carries cogsKnown:false; sumTrendTotals propagates it; and the
  // "net" the totals strip would print (revenue − Stripe − GST) is an
  // OVERSTATEMENT of true profit because product cost is missing entirely.
  const totalCogsInclGst = sandbox.kpiCogsInclGst(1678.84, null); // RPC down
  assert.equal(totalCogsInclGst, 0, 'null gross_profit → 0 COGS, not guessed');

  const cogsKnown = sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: false,
    kpiCogsTotal: totalCogsInclGst,
  });
  assert.equal(cogsKnown, false, 'COGS is unknown for this window');

  const b = {
    revenue: 1678.84, orders: 34,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    cogsKnown,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  const totals = sandbox.sumTrendTotals([b]);
  assert.equal(totals.cogsKnown, false,
    'cogsKnown:false must survive into the totals the strip renders from');
  assert.equal(totals.cogs, 0, 'COGS sits at a 0 placeholder — shown as "—", never "$0.00 profit"');
  // The renderable "net" excludes COGS — it is a ceiling on profit, not profit.
  const net = totals.revenue - totals.expenses;
  assert.ok(net > 0, 'net excl. COGS is positive here — which is exactly why it must not be labelled "Profit"');
});
