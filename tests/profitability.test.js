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

// ─── Supplier freight, and the absorbed courier it SUPERSEDES (ERR-241/251) ──
//
// 🚨 THE ABSORBED COURIER NO LONGER REDUCES TAKE-HOME, AND THIS SECTION EXISTS
// TO STOP SOMEONE PUTTING IT BACK.
//
// It used to. `shipping_absorbed` was deducted alongside `supplier_freight`, and
// that double-charged one parcel: `shipping_absorbed` is the outbound parcel
// RATE, and `supplier_freight` prices the same parcel(s) off the same ladder.
//
// Measured over 115 live order-samples (70 on 2026-09-10, 45 on 09-12): there is
// NOT ONE order where `shipping_absorbed` applies and `supplier_freight` does
// not, and where both apply the amounts are identical on 39 of 41. The two
// exceptions are the same order both times — 2026090102, two suppliers, where
// absorbed is ONE parcel rate ($7) and freight is TWO consignments ($14). So
// absorbed is a strict SUBSET of freight.
//
// The backend's own identity agrees and has no absorbed-courier term:
//     gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight
// Live RPC 2026-09-10: 2210.76 − (−56.06) = 2266.82 = 170.68 + 1593.50 + 502.64.
//
// The amounts are still PARSED and RETURNED — the zone, the delivery type and
// the figure are worth saying on screen. They are simply no longer arithmetic.
//
// Fixture: order 20260723000001 from the backend hand-off. Genuine Kyocera toner,
// free ship, North Island. Customer paid $138.79 incl-GST, supplier $99.15 incl,
// Stripe $4.57 incl.
//   rev ex-GST  = 138.79 / 1.15 = 120.687
//   cost ex-GST =  99.15 / 1.15 =  86.217
const ABSORBED_REV = 138.79 / 1.15;
const ABSORBED_COST = 99.15 / 1.15;
const ABSORBED_APPLIES = {
  applies: true, basis: 'zone_rate', zone: 'north-island', delivery_type: 'urban',
  parcel_weight_kg: 2.0, amount_incl_gst: 12.00, gst_component: 1.57, amount_ex_gst: 10.43,
};
/** The backend envelope, as utils/supplier-freight.js normalises it. */
const FREIGHT_APPLIES = {
  applies: true, amount_incl_gst: 12.00, gst_component: 1.57, amount_ex_gst: 10.43,
  complete: true, unpricedConsignments: 0, suppliers: ['DSNZ'],
  consignments: [{ supplier: 'DSNZ', billed: true, reason: 'always_billed', amount_incl_gst: 12.00 }],
  zone: 'north-island', deliveryType: 'urban', deliveryTypeBasis: 'charged', parcelWeightKg: 2.0,
};

test('🚨 the absorbed courier is PARSED but does NOT move take-home (the double-charge fix)', () => {
  const without = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  const withAbsorbed = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, absorbedShipping: ABSORBED_APPLIES,
  });
  // Positive control: the fixture really does carry a courier cost, so an
  // assertion that "nothing moved" cannot pass by the input being empty.
  assert.equal(withAbsorbed.absorbedShippingApplies, true, 'positive control: the courier block must be live');
  assert.ok(Math.abs(withAbsorbed.absorbedShippingInclGst - 12.00) < 1e-9);
  assert.ok(Math.abs(withAbsorbed.absorbedShippingGst - 1.57) < 1e-9);
  assert.ok(Math.abs(withAbsorbed.absorbedShippingExGst - 10.43) < 1e-9);
  // ...and yet neither the profit nor the GST line moves.
  assert.ok(Math.abs(withAbsorbed.netProfit - without.netProfit) < 1e-9,
    `absorbed courier moved take-home ${without.netProfit} → ${withAbsorbed.netProfit}; it must not`);
  assert.ok(Math.abs(withAbsorbed.gstRemittedToIrd - without.gstRemittedToIrd) < 1e-9,
    'the absorbed courier GST must not be credited at the IRD line any more');
  // The reason is in the RETURN VALUE, not only in a comment.
  assert.equal(withAbsorbed.absorbedShippingSupersededByFreight, true);
});

test('supplier freight DOES drop take-home, by its ex-GST amount', () => {
  const without = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, supplierFreight: FREIGHT_APPLIES,
  });
  assert.equal(b.supplierFreightApplies, true);
  assert.ok(Math.abs(b.supplierFreightInclGst - 12.00) < 1e-9);
  assert.ok(Math.abs(b.supplierFreightGst - 1.57) < 1e-9);
  assert.ok(Math.abs(b.supplierFreightExGst - 10.43) < 1e-9);
  assert.ok(Math.abs(b.netProfit - (without.netProfit - 10.43)) < 1e-9,
    `freight must subtract its ex-GST amount: ${without.netProfit} → ${b.netProfit}`);
  assert.ok(Math.abs(b.gstRemittedToIrd - (without.gstRemittedToIrd - 1.57)) < 1e-9,
    'freight GST is a reclaimable input credit and nets at the IRD line');
});

test('🚨 BOTH present charges ONCE — the exact shape that was double-charging', () => {
  // 24 of 70 live orders carry both blocks. Before ERR-251 this order lost
  // $20.86 of take-home for one $12 parcel.
  const freightOnly = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, supplierFreight: FREIGHT_APPLIES,
  });
  const both = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, supplierFreight: FREIGHT_APPLIES, absorbedShipping: ABSORBED_APPLIES,
  });
  assert.equal(both.absorbedShippingApplies, true, 'positive control: both blocks must really be present');
  assert.equal(both.supplierFreightApplies, true);
  assert.ok(Math.abs(both.netProfit - freightOnly.netProfit) < 1e-9,
    `one parcel, one charge: ${freightOnly.netProfit} vs ${both.netProfit}`);
});

test('cash waterfall foots with freight in it — FOUR outflows, not five', () => {
  const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, supplierFreight: FREIGHT_APPLIES, absorbedShipping: ABSORBED_APPLIES,
  });
  // paid − supplier − stripe − freight − GST-to-IRD === take-home.
  // The absorbed courier is deliberately NOT a term: adding it here would be
  // the bug, and this expression is the reason it cannot come back unnoticed.
  const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.supplierFreightInclGst - b.gstRemittedToIrd;
  assert.ok(Math.abs(foot - b.netProfit) < 0.005, `waterfall ${foot} ≠ take-home ${b.netProfit}`);
});

test('computeProfitBreakdown: { applies:false } and absent supplierFreight leave the breakdown unchanged', () => {
  const base = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  for (const opts of [
    { customerPaidInclGst: 138.79 },
    { customerPaidInclGst: 138.79, supplierFreight: null },
    { customerPaidInclGst: 138.79, supplierFreight: { applies: false } },
    { customerPaidInclGst: 138.79, supplierFreight: { applies: true, amount_incl_gst: 0 } },
  ]) {
    const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, opts);
    assert.equal(b.supplierFreightApplies, false, JSON.stringify(opts));
    assert.equal(b.supplierFreightInclGst, 0);
    assert.ok(Math.abs(b.netProfit - base.netProfit) < 1e-9, `netProfit moved for ${JSON.stringify(opts)}`);
  }
});

test('supplier freight: gst_component absent → derived as incl × 3/23, still foots', () => {
  const b = sandbox.computeProfitBreakdown(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79,
    supplierFreight: { applies: true, amount_incl_gst: 12.00 },   // no gst_component
  });
  assert.ok(Math.abs(b.supplierFreightGst - 12.00 * (0.15 / 1.15)) < 1e-9, `derived gst: ${b.supplierFreightGst}`);
  assert.ok(Math.abs(b.supplierFreightExGst - (12.00 - b.supplierFreightGst)) < 1e-9);
  const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.supplierFreightInclGst - b.gstRemittedToIrd;
  assert.ok(Math.abs(foot - b.netProfit) < 0.005, `waterfall ${foot} ≠ take-home ${b.netProfit}`);
});

test('computeOrderProfit: freight subtracts amount_ex_gst; absorbed courier subtracts NOTHING', () => {
  const bare = sandbox.computeOrderProfit(ABSORBED_REV, ABSORBED_COST, { customerPaidInclGst: 138.79 });
  const withFreight = sandbox.computeOrderProfit(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, supplierFreight: FREIGHT_APPLIES,
  });
  const withAbsorbed = sandbox.computeOrderProfit(ABSORBED_REV, ABSORBED_COST, {
    customerPaidInclGst: 138.79, absorbedShipping: ABSORBED_APPLIES,
  });
  assert.ok(Math.abs(withFreight - (bare - 10.43)) < 1e-9, `freight: ${bare} → ${withFreight}`);
  assert.ok(Math.abs(withAbsorbed - bare) < 1e-9, `absorbed must be a no-op: ${bare} → ${withAbsorbed}`);
});

test('computeLineProfits: freight drops the total and is allocated by revenue share', () => {
  const lines = [
    { revenueExGst: 80, costExGst: 40 },
    { revenueExGst: 40.687, costExGst: 46.217 },
  ];
  const bare = sandbox.computeLineProfits(lines, { customerPaidInclGst: 138.79 });
  const withFreight = sandbox.computeLineProfits(lines, {
    customerPaidInclGst: 138.79, supplierFreight: FREIGHT_APPLIES,
  });
  assert.ok(Math.abs(withFreight.totalProfit - (bare.totalProfit - 10.43)) < 1e-9);
  // Σ lineProfits === totalProfit still holds: the new deduction rides in the
  // order-level fee (revenue − cost − profit) and allocates itself.
  const sum = withFreight.lineProfits.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - withFreight.totalProfit) < 1e-9, `Σ lines ${sum} ≠ total ${withFreight.totalProfit}`);
});

// ─── orderDiscountParts — order-level discount, GST-inclusive (ERR-168) ──────
//
// Added Aug 2026. `orders.discount_amount` is the aggregate of volume + coupon +
// loyalty and is stored GST-INCLUSIVE, while revenue is ex-GST — so it has to be
// converted before it can be netted out. This mirrors absorbedShippingParts()
// exactly, and for the same reason: one statement of the GST convention, in the
// module that owns the money math.

test('orderDiscountParts: derives the GST inside a GST-inclusive amount (× 3/23)', () => {
  const d = sandbox.orderDiscountParts(12.90);
  assert.equal(d.applies, true);
  assert.ok(Math.abs(d.gst - 12.90 * 3 / 23) < 1e-9, `gst ${d.gst}`);
  assert.ok(Math.abs(d.exGst - 12.90 / 1.15) < 1e-9, `exGst ${d.exGst}`);
  // exGst is derived by SUBTRACTION so the waterfall foots exactly, and must
  // still equal the /1.15 form the backend brief states.
  assert.ok(Math.abs((d.inclGst - d.gst) - d.exGst) < 1e-12, 'exGst must be incl − gst');
});

test('orderDiscountParts: the parts always reconstruct the whole', () => {
  for (const amount of [0.01, 2.40, 6.62, 8.15, 12.90, 999.99]) {
    const d = sandbox.orderDiscountParts(amount);
    assert.ok(Math.abs(d.exGst + d.gst - d.inclGst) < 1e-12, `${amount} does not reconstruct`);
  }
});

test('orderDiscountParts: absent/null/zero/negative means NO discount, not a $0 one', () => {
  // Same LOUD-by-absence rule as absorbedShippingParts: callers gate on
  // `applies`, so a field the backend never sent can never be read as a decision.
  for (const v of [undefined, null, 0, -1, NaN, 'x', {}, []]) {
    const d = sandbox.orderDiscountParts(v);
    assert.equal(d.applies, false, `${JSON.stringify(v)} must not apply`);
    assert.equal(d.exGst, 0);
    assert.equal(d.gst, 0);
    assert.equal(d.inclGst, 0);
  }
});

test('orderDiscountParts: honours a custom GST rate, like every other helper here', () => {
  const d = sandbox.orderDiscountParts(110, 0.10);
  assert.ok(Math.abs(d.exGst - 100) < 1e-9, `exGst ${d.exGst}`);
  assert.ok(Math.abs(d.gst - 10) < 1e-9, `gst ${d.gst}`);
});
