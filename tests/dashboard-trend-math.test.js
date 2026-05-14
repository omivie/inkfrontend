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

test('distributeCogsByRevenue: $720 split across buckets in revenue proportion', () => {
  // Matches the user screenshot: revenue $1,277.36 - gross_profit $557.48
  // = $719.88 of COGS to spread across the visible window.
  const buckets = [
    { revenue: 358.24, cogsDerived: 0 },  // 3 May
    { revenue: 358.24, cogsDerived: 0 },  // 5 Apr
    { revenue: 165, cogsDerived: 0 },
    { revenue: 117.97, cogsDerived: 0 },
    { revenue: 277.91, cogsDerived: 0 },
  ];
  sandbox.distributeCogsByRevenue(buckets, 719.88);
  const totalRev = 358.24 + 358.24 + 165 + 117.97 + 277.91;
  for (const b of buckets) {
    const expected = 719.88 * (b.revenue / totalRev);
    assert.ok(Math.abs(b.cogsDerived - expected) < 0.01,
      `bucket rev=${b.revenue}: expected ${expected}, got ${b.cogsDerived}`);
  }
  const sumDerived = buckets.reduce((s, b) => s + b.cogsDerived, 0);
  assert.ok(Math.abs(sumDerived - 719.88) < 0.01,
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
  // COGS                    =                                       = 719.88
  // Expenses total          ≈ 936.11; Net ≈ 341.25 (a profit).
  const b = {
    revenue: 1277.36, orders: 31,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 719.88,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.cogsTotal, 719.88);
  assert.equal(b.opexTotal, 0);
  assert.ok(Math.abs(b.stripeTotal - 49.6225) < 0.01);
  assert.ok(Math.abs(b.gstTotal    - 166.612) < 0.01);
  assert.ok(Math.abs(b.expenses - 936.11) < 0.05);
  assert.ok(b.net > 335 && b.net < 345, `expected profit ~$341.25, got ${b.net}`);
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
  // 31 orders, no logged opex. With the 2026-05-12 Stripe convention:
  //   COGS   = 1277.36 − 557.48                        = 719.88
  //   Stripe = (1277.36 × 0.0265 + 31 × 0.30) × 1.15   ≈ 49.62
  //   GST    = 1277.36 × (3/23)                        ≈ 166.61
  //   Opex   = 0 (none logged)
  //   Total  ≈ 936.11
  //   Net    ≈ 341.25 profit
  const buckets = [
    { revenue: 1277.36, orders: 31,
      pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  // Step 1: distribute KPI cogs across (only one) bucket
  sandbox.distributeCogsByRevenue(buckets, 1277.36 - 557.48);
  // Step 2: assemble
  sandbox.assembleBucketExpense(buckets[0]);
  const totals = sandbox.sumTrendTotals(buckets);

  assert.ok(Math.abs(totals.cogs   - 719.88)  < 0.01, `cogs=${totals.cogs}`);
  assert.equal(totals.opex, 0);
  assert.ok(Math.abs(totals.stripe - 49.6225) < 0.01, `stripe=${totals.stripe}`);
  assert.ok(Math.abs(totals.gst    - 166.612) < 0.01, `gst=${totals.gst}`);
  // Regression guard: the previous version of the chart would have shown
  // ~$215.66 (the broken cogs=0 path); expenses must include cogs.
  assert.ok(Math.abs(totals.expenses - 936.11) < 0.05,
    `expected ~$936.11 expenses, got ${totals.expenses}`);
  assert.ok(totals.expenses > 900, `regression guard: expenses must include cogs (was $215.66 before fix)`);
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

// ─── kpiCogsInclGst — the 1.15 gross-up ─────────────────────────────────────

test('kpiCogsInclGst: $1,277.36 revenue − $557.48 GP grossed up to $827.86 cost', () => {
  // The user's screenshot fixture. revenue − gross_profit gives ex-GST cost
  // because of the profitability.js convention; multiply by 1.15 to get real
  // cash paid to suppliers.
  const cogs = sandbox.kpiCogsInclGst(1277.36, 557.48);
  // (1277.36 − 557.48) × 1.15 = 719.88 × 1.15 = 827.862
  assert.ok(Math.abs(cogs - 827.862) < 0.01, `expected ~$827.86, got ${cogs}`);
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

test('integration: when items[] are absent, KPI fallback grosses up by 1.15', () => {
  // No items[] → the chart uses the KPI total cogs (revenue − gross_profit) × 1.15
  // distributed by revenue share. For a single-bucket window this means
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
  // Single-order window: revenue = 358.24, gross_profit = 83.07 (per profitability.js)
  // Cost incl-GST = (358.24 − 83.07) × 1.15 = 275.17 × 1.15 = 316.45
  // BUT! In a real KPI fixture, gross_profit = revenue_ex_gst − cost_incl_gst.
  //  = 311.52 − 228.45 = 83.07
  // So kpiCogsInclGst with revenue=358.24, gp=83.07 = (358.24 − 83.07) × 1.15 = 316.45
  // That's higher than the true cost ($228.45) because revenue here is gross
  // not ex-GST. This is why the per-order path is preferred — but the fallback
  // still produces a number > cost-incl-GST, never lower.
  const totalCogs = sandbox.kpiCogsInclGst(358.24, 83.07);
  sandbox.distributeCogsByRevenue(buckets, totalCogs);
  sandbox.assembleBucketExpense(buckets[0]);
  // Sanity: fallback cogs ≥ true cost-incl-GST (no under-counting)
  assert.ok(buckets[0].cogsTotal >= 228.45,
    `KPI-fallback COGS must never under-count cost-incl-GST: ${buckets[0].cogsTotal}`);
});
