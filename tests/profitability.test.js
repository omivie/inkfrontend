/**
 * profitability.js — order/product profit math
 * =============================================
 *
 * Pins computeOrderProfit / computeProfitability / computeLineProfits /
 * computeProfitBreakdown against real-world fixtures so we don't regress the
 * GST/Stripe convention again.
 *
 * Convention (GST-neutral — revised by user 2026-05-17, supersedes 2026-05-12):
 *   1. order_items.sell_price is stored EX-GST in the backend.
 *   2. cost_price / supplier_cost_snapshot are stored ex-GST and deducted
 *      AS-IS. The GST we pay the supplier is reclaimable as an input tax
 *      credit, so it nets to zero and must NOT reduce profit.
 *   3. Stripe NZ domestic rate is 2.65% + $0.30 per transaction, deducted
 *      ex-GST. The 15% GST Stripe charges on its fee is likewise reclaimable,
 *      so it is NOT added (there is a cash-flow timing gap, but that is a
 *      working-capital matter, not profit).
 *   4. Fee base is the FULL customer-paid amount (incl. shipping + GST), not
 *      just the product subtotal. computeOrderProfit accepts opts with
 *      customerPaidInclGst; falls back to (rev + shipping) × 1.15.
 *
 * profit = revenueExGst − costExGst − (feeBase × 0.0265 + 0.30)
 *
 * See project_profit_calc.md for accounting rationale.
 *
 * Run with: node --test tests/profitability.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'profitability.js');

function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  const footer = '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
  return stripped + footer;
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'profitability.js' });

// ─── Constants ──────────────────────────────────────────────────────────────

test('STRIPE_RATE is 2.65% (NZ domestic card, stripe.com/nz/pricing)', () => {
  assert.equal(sandbox.STRIPE_RATE, 0.0265);
});

test('STRIPE_FIXED is $0.30 per transaction', () => {
  assert.equal(sandbox.STRIPE_FIXED, 0.30);
});

test('GST_RATE is 15%', () => {
  assert.equal(sandbox.GST_RATE, 0.15);
});

test('STRIPE_FEE_GST is gone — GST on the Stripe fee is reclaimable, not deducted', () => {
  assert.equal(sandbox.STRIPE_FEE_GST, undefined);
});

// ─── computeOrderProfit (GST-neutral) ───────────────────────────────────────

test('computeOrderProfit: ORD-MOXKETUX (rev $13.87 ex-GST, cost $9.10 ex-GST, customer paid $22.95) → ~$3.86', () => {
  // GST-neutral: cost deducted ex-GST, Stripe fee deducted ex-GST.
  //   stripeFee = 22.95 × 0.0265 + 0.30 = 0.608175 + 0.30 = 0.908175
  //   profit    = 13.87 − 9.10 − 0.908175           ≈ 3.8618
  const profit = sandbox.computeOrderProfit(13.87, 9.10, { customerPaidInclGst: 22.95 });
  assert.ok(Math.abs(profit - 3.8618) < 0.01, `expected ~$3.86, got ${profit}`);
});

test('computeOrderProfit: $311.52 ex-GST rev, $198.65 cost ex-GST, no opts → falls back to (rev × 1.15)', () => {
  // No customerPaidInclGst → fee base is revenue grossed up to the incl-GST
  // amount Stripe would have charged.
  //   feeBase   = 311.52 × 1.15 = 358.248
  //   stripeFee = 358.248 × 0.0265 + 0.30 = 9.4936 + 0.30 = 9.7936
  //   profit    = 311.52 − 198.65 − 9.7936          ≈ 103.0764
  const profit = sandbox.computeOrderProfit(311.52, 198.65);
  assert.ok(Math.abs(profit - 103.076) < 0.05, `expected ~$103.08, got ${profit}`);
});

test('computeOrderProfit: prefers customerPaidInclGst over fallback shipping math', () => {
  // A larger explicit paid amount means Stripe charges on a bigger base.
  const profitNoShip = sandbox.computeOrderProfit(311.52, 198.65);
  const profitWithShip = sandbox.computeOrderProfit(311.52, 198.65, { customerPaidInclGst: 400.00 });
  assert.ok(profitWithShip < profitNoShip, 'larger fee base must produce a smaller profit');
});

test('computeOrderProfit: shippingExGst fallback adjusts fee base when paid is unknown', () => {
  // feeBase = (10 + 5) × 1.15 = 17.25 vs (10) × 1.15 = 11.5
  const profitWithShipping = sandbox.computeOrderProfit(10, 5, { shippingExGst: 5 });
  const profitNoShipping = sandbox.computeOrderProfit(10, 5);
  assert.ok(profitWithShipping < profitNoShipping, 'shipping in fallback widens fee base');
});

test('computeOrderProfit: zero/negative/NaN revenue returns null', () => {
  assert.equal(sandbox.computeOrderProfit(0, 100), null);
  assert.equal(sandbox.computeOrderProfit(-50, 100), null);
  assert.equal(sandbox.computeOrderProfit(NaN, 100), null);
  assert.equal(sandbox.computeOrderProfit('not a number', 100), null);
});

test('computeOrderProfit: cost > revenue yields a negative profit (loss)', () => {
  const profit = sandbox.computeOrderProfit(50, 100);
  assert.ok(profit < 0, `expected loss, got ${profit}`);
});

test('computeOrderProfit: opts arg is optional', () => {
  const profit = sandbox.computeOrderProfit(100, 50);
  assert.ok(Number.isFinite(profit), `expected a number, got ${profit}`);
});

test('computeOrderProfit: GST on cost is NOT deducted (GST-neutral)', () => {
  // Same inputs, but profit must reflect cost ex-GST ($50), not grossed up
  // ($57.50). Difference between the two would be 50 × 0.15 = $7.50.
  const profit = sandbox.computeOrderProfit(100, 50, { customerPaidInclGst: 115 });
  const stripeFee = 115 * 0.0265 + 0.30;
  assert.ok(Math.abs(profit - (100 - 50 - stripeFee)) < 1e-9, `profit: ${profit}`);
});

// ─── computeProfitability (per-product, retail_price is incl-GST) ────────────

test('computeProfitability: $63.49 incl-GST retail, $34.95 cost ex-GST → ~$18.58 profit', () => {
  // priceExGst = 63.49 / 1.15            = 55.2087
  // stripeFee  = 63.49 × 0.0265          =  1.6825   (ex-GST, no fixed per-product)
  // profit     = 55.2087 − 34.95 − 1.6825 ≈ 18.5762
  // margin     = 18.5762 / 55.2087 × 100  ≈ 33.65%
  // markup     = 18.5762 / 34.95   × 100  ≈ 53.15%
  const r = sandbox.computeProfitability({ retail_price: 63.49, cost_price: 34.95 });
  assert.ok(Math.abs(r.profitDollars - 18.576) < 0.01, `profit: ${r.profitDollars}`);
  assert.ok(r.marginPct > 33 && r.marginPct < 35, `margin: ${r.marginPct}`);
  assert.ok(r.markupPct > 52 && r.markupPct < 54, `markup: ${r.markupPct}`);
  assert.equal(r.costExGst, 34.95, 'cost is deducted ex-GST, not grossed up');
});

test('computeProfitability: missing/invalid inputs return all-null shape', () => {
  const r = sandbox.computeProfitability({ retail_price: null, cost_price: 10 });
  assert.equal(r.profitDollars, null);
  assert.equal(r.marginPct, null);
  assert.equal(r.markupPct, null);
});

// ─── computeLineProfits (per-line profit in the order detail modal) ──────────

// Fixture: order ORD-MP7GA80N (16 May 2026). Six Epson genuine lines, qty 1.
//   subtotal ex-GST  = $282.37   cost ex-GST = $215.68   paid incl-GST = $324.74
//   order profit     = $57.78  (GST-neutral)
const LINES_FIXTURE = [
  { revenueExGst: 104.17, costExGst: 80.88 },  // T312CMY 3-pack
  { revenueExGst: 35.64,  costExGst: 26.96 },  // T3123M
  { revenueExGst: 35.64,  costExGst: 26.96 },  // T3127RD
  { revenueExGst: 35.64,  costExGst: 26.96 },  // T3129OR
  { revenueExGst: 35.64,  costExGst: 26.96 },  // T3128MBK
  { revenueExGst: 35.64,  costExGst: 26.96 },  // T3122C
];

test('computeLineProfits: per-line profits sum to the order foot total', () => {
  const { lineProfits, totalProfit } = sandbox.computeLineProfits(
    LINES_FIXTURE, { customerPaidInclGst: 324.74 },
  );
  assert.ok(Math.abs(totalProfit - 57.78) < 0.05, `order profit: ${totalProfit}`);
  const summed = lineProfits.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(summed - totalProfit) < 1e-9, `Σ lines ${summed} ≠ total ${totalProfit}`);
  assert.ok(lineProfits.every((p) => Number.isFinite(p) && p > 0), `lineProfits: ${lineProfits}`);
});

test('computeLineProfits: the fixed $0.30 Stripe fee is allocated by revenue share, not flat', () => {
  const { lineProfits } = sandbox.computeLineProfits(
    LINES_FIXTURE, { customerPaidInclGst: 324.74 },
  );
  // 3-pack (~37% of revenue) carries a bigger fee slice than a single.
  // gross before fee: 3-pack 104.17−80.88=23.29, single 35.64−26.96=8.68.
  assert.ok(lineProfits[0] > 19 && lineProfits[0] < 21, `3-pack line: ${lineProfits[0]}`);
  assert.ok(lineProfits[1] > 7 && lineProfits[1] < 8, `single line: ${lineProfits[1]}`);
  // The five identical singles must produce identical profit.
  for (let i = 2; i < 6; i++) {
    assert.ok(Math.abs(lineProfits[i] - lineProfits[1]) < 1e-9, `line ${i} drifted`);
  }
});

test('computeLineProfits: a line with unknown cost yields null profit but still counts toward revenue', () => {
  const { lineProfits, totalRevenue } = sandbox.computeLineProfits(
    [
      { revenueExGst: 100, costExGst: 60 },
      { revenueExGst: 50,  costExGst: null },
    ],
    { customerPaidInclGst: 172.50 },
  );
  assert.equal(lineProfits[1], null, 'unknown-cost line should be null');
  assert.ok(Number.isFinite(lineProfits[0]), 'known-cost line should be a number');
  assert.equal(totalRevenue, 150, 'null-cost line revenue still counts');
});

test('computeLineProfits: empty/invalid input returns empty result, not a throw', () => {
  const r = sandbox.computeLineProfits([], { customerPaidInclGst: 100 });
  assert.equal(r.lineProfits.length, 0);
  assert.equal(r.totalProfit, null);
  assert.equal(sandbox.computeLineProfits(null).lineProfits.length, 0);
});

// ─── computeProfitBreakdown (order-level profit waterfall) ───────────────────

test('computeProfitBreakdown: ORD-MP7GA80N cash waterfall foots to take-home profit', () => {
  // rev $282.37 ex-GST, cost $215.68 ex-GST, customer paid $324.74 incl-GST.
  const b = sandbox.computeProfitBreakdown(282.37, 215.68, { customerPaidInclGst: 324.74 });
  assert.ok(b, 'expected a breakdown object');
  assert.equal(b.customerPaidInclGst, 324.74, 'top line = full incl-GST customer payment');
  assert.ok(Math.abs(b.netProfit - 57.78) < 0.05, `netProfit: ${b.netProfit}`);
  // The literal cash waterfall: customer paid − every payment out = take-home.
  const footed = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst - b.gstRemittedToIrd;
  assert.ok(Math.abs(footed - b.netProfit) < 1e-9, `waterfall ${footed} ≠ take-home ${b.netProfit}`);
});

test('computeProfitBreakdown: supplier & Stripe outflows are shown incl-GST (GST is visible)', () => {
  const b = sandbox.computeProfitBreakdown(282.37, 215.68, { customerPaidInclGst: 324.74 });
  // We DO pay GST to the supplier: $215.68 × 0.15 = $32.35, inside $248.03.
  assert.ok(Math.abs(b.supplierCostGst - 32.352) < 0.01, `supplierCostGst: ${b.supplierCostGst}`);
  assert.ok(Math.abs(b.supplierCostInclGst - 248.032) < 0.01, `supplierCostInclGst: ${b.supplierCostInclGst}`);
  assert.ok(Math.abs(b.supplierCostInclGst - (b.supplierCostExGst + b.supplierCostGst)) < 1e-9);
  // And GST on the Stripe fee.
  assert.ok(Math.abs(b.stripeFeeInclGst - (b.stripeFeeExGst + b.stripeFeeGst)) < 1e-9);
  assert.ok(Math.abs(b.stripeFeeExGst - (b.stripeRateFee + b.stripeFixedFee)) < 1e-9);
});

test('computeProfitBreakdown: GST remitted to IRD = GST collected − GST already paid out', () => {
  const b = sandbox.computeProfitBreakdown(282.37, 215.68, { customerPaidInclGst: 324.74 });
  // gstRemitted is an input-tax-credit calc, not a plug.
  const expected = b.gstCollected - b.supplierCostGst - b.stripeFeeGst;
  assert.ok(Math.abs(b.gstRemittedToIrd - expected) < 1e-9, `gstRemitted: ${b.gstRemittedToIrd}`);
  assert.ok(Math.abs(b.gstCollected - 42.37) < 0.02, `gstCollected: ${b.gstCollected}`);
  assert.ok(Math.abs(b.gstRemittedToIrd - 8.68) < 0.02, `gstRemitted: ${b.gstRemittedToIrd}`);
});

test('computeProfitBreakdown: netProfit equals computeOrderProfit (GST nets to zero)', () => {
  const opts = { customerPaidInclGst: 324.74 };
  const b = sandbox.computeProfitBreakdown(282.37, 215.68, opts);
  const orderProfit = sandbox.computeOrderProfit(282.37, 215.68, opts);
  assert.ok(Math.abs(b.netProfit - orderProfit) < 1e-9, `${b.netProfit} ≠ ${orderProfit}`);
});

test('computeProfitBreakdown: net margin is take-home as a share of ex-GST revenue', () => {
  const b = sandbox.computeProfitBreakdown(282.37, 215.68, { customerPaidInclGst: 324.74 });
  assert.ok(Math.abs(b.netMarginPct - (b.netProfit / b.revenueExGst) * 100) < 1e-9);
  assert.ok(b.netMarginPct > 20 && b.netMarginPct < 21, `net margin: ${b.netMarginPct}`);
});

test('computeProfitBreakdown: customerPaidInclGst falls back to (rev × 1.15) when paid is unknown', () => {
  const withPaid = sandbox.computeProfitBreakdown(100, 50, { customerPaidInclGst: 200 });
  const noPaid = sandbox.computeProfitBreakdown(100, 50);
  assert.equal(withPaid.customerPaidInclGst, 200, 'uses the explicit paid amount');
  assert.ok(Math.abs(noPaid.customerPaidInclGst - 115) < 1e-9, `fallback: ${noPaid.customerPaidInclGst}`);
});

test('computeProfitBreakdown: zero/negative/NaN revenue returns null', () => {
  assert.equal(sandbox.computeProfitBreakdown(0, 100), null);
  assert.equal(sandbox.computeProfitBreakdown(-5, 100), null);
  assert.equal(sandbox.computeProfitBreakdown(NaN, 100), null);
});

// ─── Absorbed courier on free-shipping orders (order.shipping_absorbed) ──────
//
// Fixture: order 20260723000001 from the backend hand-off. Genuine Kyocera toner,
// free ship, North Island. Customer paid $138.79 incl-GST, supplier $99.15 incl,
// Stripe $4.57 incl. Take-home was reported $30.49 / 25.3%; ~$12 courier was
// absorbed and never subtracted → true take-home $20.06 / 16.6%.
//   rev ex-GST  = 138.79 / 1.15 = 120.687
//   cost ex-GST =  99.15 / 1.15 =  86.217
const ABSORBED_REV = 138.79 / 1.15;
const ABSORBED_COST = 99.15 / 1.15;
const ABSORBED_APPLIES = {
  applies: true, basis: 'zone_rate', zone: 'north-island', delivery_type: 'urban',
  parcel_weight_kg: 2.0, amount_incl_gst: 12.00, gst_component: 1.57, amount_ex_gst: 10.43,
};

test('computeProfitBreakdown: absorbed courier drops take-home $30.49 → $20.06 (doc worked example)', () => {
  const before = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  assert.ok(Math.abs(before.netProfit - 30.49) < 0.02, `before netProfit: ${before.netProfit}`);
  assert.ok(Math.abs(before.gstRemittedToIrd - 4.57) < 0.02, `before gstRemitted: ${before.gstRemittedToIrd}`);

  const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, absorbedShipping: ABSORBED_APPLIES,
  });
  assert.equal(b.absorbedShippingApplies, true);
  assert.ok(Math.abs(b.absorbedShippingInclGst - 12.00) < 1e-9, `courier incl: ${b.absorbedShippingInclGst}`);
  assert.ok(Math.abs(b.absorbedShippingGst - 1.57) < 1e-9, `courier gst: ${b.absorbedShippingGst}`);
  assert.ok(Math.abs(b.absorbedShippingExGst - 10.43) < 1e-9, `courier ex: ${b.absorbedShippingExGst}`);
  assert.ok(Math.abs(b.netProfit - 20.06) < 0.02, `after netProfit: ${b.netProfit}`);
  assert.ok(Math.abs(b.gstRemittedToIrd - 3.00) < 0.02, `after gstRemitted: ${b.gstRemittedToIrd}`);
  assert.ok(Math.abs(b.netMarginPct - 16.6) < 0.2, `after net margin: ${b.netMarginPct}`);
  // Metadata carried through for the tooltip.
  assert.equal(b.absorbedShippingZone, 'north-island');
  assert.equal(b.absorbedShippingDeliveryType, 'urban');
});

test('computeProfitBreakdown: cash waterfall still foots with the absorbed-courier line', () => {
  const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, absorbedShipping: ABSORBED_APPLIES,
  });
  const footed = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.absorbedShippingInclGst - b.gstRemittedToIrd;
  assert.ok(Math.abs(footed - b.netProfit) < 1e-9, `waterfall ${footed} ≠ take-home ${b.netProfit}`);
  // Take-home drops by exactly amount_ex_gst vs. the no-courier breakdown.
  const noCourier = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  assert.ok(Math.abs((noCourier.netProfit - b.netProfit) - b.absorbedShippingExGst) < 1e-9,
    `drop ${noCourier.netProfit - b.netProfit} ≠ exGst ${b.absorbedShippingExGst}`);
  // ...and IRD drops by exactly the courier GST component.
  assert.ok(Math.abs((noCourier.gstRemittedToIrd - b.gstRemittedToIrd) - b.absorbedShippingGst) < 1e-9);
});

test('computeProfitBreakdown: { applies:false } and absent absorbedShipping leave the breakdown unchanged', () => {
  const base = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  for (const opts of [
    { customerPaidInclGst: 138.79 },
    { customerPaidInclGst: 138.79, absorbedShipping: { applies: false } },
    { customerPaidInclGst: 138.79, absorbedShipping: null },
    { customerPaidInclGst: 138.79, absorbedShipping: { applies: true, amount_incl_gst: 0 } },
    { customerPaidInclGst: 138.79, absorbedShipping: { applies: true } }, // no amount
  ]) {
    const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, opts);
    assert.equal(b.absorbedShippingApplies, false, `applies should be false for ${JSON.stringify(opts.absorbedShipping)}`);
    assert.equal(b.absorbedShippingInclGst, 0);
    assert.equal(b.absorbedShippingGst, 0);
    assert.equal(b.absorbedShippingExGst, 0);
    assert.ok(Math.abs(b.netProfit - base.netProfit) < 1e-9, `netProfit drifted: ${b.netProfit}`);
    assert.ok(Math.abs(b.gstRemittedToIrd - base.gstRemittedToIrd) < 1e-9);
  }
});

test('computeProfitBreakdown: gst_component absent → derived as incl × 3/23, still foots', () => {
  const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79,
    absorbedShipping: { applies: true, zone: 'north-island', amount_incl_gst: 12.00 }, // no gst_component
  });
  // 12.00 × 0.15/1.15 = 1.5652...
  assert.ok(Math.abs(b.absorbedShippingGst - (12.00 * 0.15 / 1.15)) < 1e-9, `derived gst: ${b.absorbedShippingGst}`);
  assert.ok(Math.abs(b.absorbedShippingExGst - (12.00 - 12.00 * 0.15 / 1.15)) < 1e-9);
  const footed = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.absorbedShippingInclGst - b.gstRemittedToIrd;
  assert.ok(Math.abs(footed - b.netProfit) < 1e-9, `waterfall ${footed} ≠ take-home ${b.netProfit}`);
});

test('computeOrderProfit: absorbed courier subtracts amount_ex_gst (and is a no-op when absent)', () => {
  const base = sandbox.computeOrderProfit(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  const withCourier = sandbox.computeOrderProfit(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, absorbedShipping: ABSORBED_APPLIES,
  });
  assert.ok(Math.abs((base - withCourier) - 10.43) < 1e-9, `drop ${base - withCourier} ≠ 10.43`);
  const noop = sandbox.computeOrderProfit(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, absorbedShipping: { applies: false },
  });
  assert.ok(Math.abs(noop - base) < 1e-9, 'applies:false must not change profit');
});

test('computeLineProfits: absorbed courier drops the total and is allocated by revenue share', () => {
  // Two lines, 3:1 revenue split, on a free-shipped order that absorbed courier.
  const lines = [
    { revenueExGst: 90, costExGst: 60 },
    { revenueExGst: 30, costExGst: 20 },
  ];
  const opts = { customerPaidInclGst: 138.00, absorbedShipping: ABSORBED_APPLIES };
  const withCourier = sandbox.computeLineProfits(lines, opts);
  const noCourier = sandbox.computeLineProfits(lines, { customerPaidInclGst: 138.00 });
  // Total drops by the ex-GST courier cost.
  assert.ok(Math.abs((noCourier.totalProfit - withCourier.totalProfit) - 10.43) < 1e-9,
    `total drop ${noCourier.totalProfit - withCourier.totalProfit} ≠ 10.43`);
  // Σ lines === total, exactly.
  const summed = withCourier.lineProfits.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(summed - withCourier.totalProfit) < 1e-9, `Σ ${summed} ≠ total ${withCourier.totalProfit}`);
  // The bigger line absorbs 3× the courier slice of the smaller line.
  const dropBig = noCourier.lineProfits[0] - withCourier.lineProfits[0];
  const dropSmall = noCourier.lineProfits[1] - withCourier.lineProfits[1];
  assert.ok(Math.abs(dropBig / dropSmall - 3) < 1e-9, `allocation ratio ${dropBig / dropSmall} ≠ 3`);
});
