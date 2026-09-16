/**
 * The shipping the customer paid is REVENUE (ERR-261)
 * ===================================================
 *
 * ERR-241 taught the profit engine to deduct the freight a supplier bills us,
 * and guarded it with `customerPaidFreight()`: when the customer had paid for
 * delivery, no freight was deducted. Shipping was a balanced pass-through —
 * nothing in, nothing out, take-home correct.
 *
 * ERR-255 deleted that guard. Correctly: we really do pay the bill, on 27 of 60
 * measured orders, $221.77 of $506.98. But the revenue half was never added
 * back, and one half of a pass-through is not a pass-through — it is a loss the
 * order did not make. Every order where the customer paid for delivery has been
 * understated by the ex-GST shipping charge ever since.
 *
 *   ***NEVER REMOVE ONE HALF OF A PASS-THROUGH.***
 *
 * WHAT THESE TESTS ARE REALLY GUARDING
 *
 *   1. THE WATERFALL FOOTED THE WHOLE TIME. `gstRemittedToIrd` is a residual by
 *      construction, so it absorbed the unbooked shipping and the columns still
 *      added up. On order 2026091601 it reported $11.82 of GST remitted on a
 *      $41.49 sale whose entire GST content is $5.41 — more than twice the GST
 *      that exists — and footed perfectly. Footing was never a test that could
 *      catch this. §2's bound is: GST remitted can never exceed output GST.
 *
 *   2. THERE IS NO "DERIVED FROM THE TOTAL" BRANCH. `total − revenue × 1.15`
 *      reproduces 2026091601 to the cent and is still wrong, because a residual
 *      cannot tell a delivery charge from any other reason revenue fell short.
 *      Written that way, an order carrying an $11.50 discount produced the
 *      IDENTICAL net profit with and without it — ERR-168 silently undone.
 *      §4 pins that. A RESIDUAL IS A CHECK, NEVER A SOURCE.
 *
 *   3. ABSENT IS A FLOOR, NOT A ZERO AND NOT A REFUSAL. No stated fee means
 *      revenue we could not book, so take-home is a lower bound and says so.
 *      This is the exact MIRROR of unpriced freight, which is an upper bound
 *      (ERR-241) — opposite directions, never folded together. Blanking the
 *      figure instead would be ERR-158 backwards: present → absent.
 *
 *   4. FREE-SHIPPING ORDERS MUST NOT MOVE. They were always right: no revenue,
 *      and the absorbed freight is a real cost. §5 is that negative control —
 *      if it moves, the fix reached orders it had no business reaching.
 *
 * Run with: node --test tests/admin-order-profit-shipping-revenue-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const PROFITABILITY = path.join(ADMIN, 'utils', 'profitability.js');
const SOURCING = path.join(ADMIN, 'utils', 'sourcing.js');
const SUPPLIER_FREIGHT = path.join(ADMIN, 'utils', 'supplier-freight.js');
const ORDER_PROFIT = path.join(ADMIN, 'utils', 'order-profit.js');

const profitabilitySrc = fs.readFileSync(PROFITABILITY, 'utf8');
const orderProfitSrc = fs.readFileSync(ORDER_PROFIT, 'utf8');

// Same loader as supplier-freight-sep2026.test.js: each module in its own
// function scope, because two modules here declare a private `const MISSING`.
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
  stripped = stripped.replace(/export\s+\{[^}]*\}\s*;?/g, '');
  stripped = stripped.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  return '(function(){\n' + stripped + '\n;'
    + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n')
    + '\n})();';
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp, Set, Infinity };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const [file, name] of [[PROFITABILITY, 'profitability.js'], [SOURCING, 'sourcing.js'],
  [SUPPLIER_FREIGHT, 'supplier-freight.js'], [ORDER_PROFIT, 'order-profit.js']]) {
  vm.runInContext(stripEsm(fs.readFileSync(file, 'utf8')), ctx, { filename: name });
}
const { orderProfitFromDetail, PROFIT_STATE, computeProfitBreakdown, computeOrderProfit } = sandbox;

const cents = (a, b, msg) => assert.ok(Math.abs(a - b) <= 0.005,
  `${msg || 'expected'} ${b}, got ${a} (off by ${(a - b).toFixed(4)})`);
const GST_OF_GROSS = 3 / 23;

/** Freight envelope: one Augmento consignment, $12.00 incl-GST. */
const FREIGHT = () => ({
  applies: true, zone: 'rural', delivery_type: 'rural', delivery_type_basis: 'recorded',
  parcel_rate_incl_gst: 12, amount_incl_gst: 12, gst_component: 12 * GST_OF_GROSS,
  amount_ex_gst: 12 - 12 * GST_OF_GROSS, complete: true, unpriced_consignments: 0,
  consignments: [{ supplier: 'Augmento', billed: true, unpriced: false,
    reason: 'goods_under_free_threshold', amount_incl_gst: 12 }],
});

/**
 * Order 2026091601, reconstructed from the PROFIT BREAKDOWN panel a human
 * screenshotted: paid $41.49 incl · supplier $17.25 incl ($15.00 ex) ·
 * Stripe $1.61 incl · supplier freight $12.00 incl · delivery charged $12.00.
 * Goods are therefore (41.49 − 12.00) / 1.15 ex-GST.
 */
const CHARGED = (over = {}) => ({
  id: 'o1', order_number: '2026091601', status: 'paid', channel: 'website',
  total_amount: 41.49, shipping_fee: 12.00, delivery_type: 'rural',
  items: [{ sell_price: 29.49 / 1.15, qty: 1, supplier_cost_snapshot: 15.00,
    suppliers: [{ name: 'Augmento' }] }],
  supplier_freight: FREIGHT(),
  ...over,
});

/** The same shape with free shipping — the negative control. */
const FREE_SHIP = (over = {}) => ({
  id: 'o2', order_number: '2026090902', status: 'paid', channel: 'website',
  total_amount: 134.49, shipping_fee: 0, delivery_type: 'rural',
  items: [{ sell_price: 134.49 / 1.15, qty: 1, supplier_cost_snapshot: 76.00,
    suppliers: [{ name: 'Augmento' }] }],
  supplier_freight: FREIGHT(),
  ...over,
});

// ─── §1 The money ──────────────────────────────────────────────────────────

test('§1 the worked example: 2026091601 is +$9.24 at 25.6%, not −$1.19 at −4.6%', () => {
  const r = orderProfitFromDetail(CHARGED());
  assert.equal(r.state, PROFIT_STATE.OK);
  cents(r.netProfit, 9.24, 'take-home');
  cents(r.netMarginPct, 25.62, 'net margin %');
  // The pre-fix figure, stated so this test names what it fixed. Booking no
  // delivery revenue is exactly `revenue − cost − stripe − freight` on goods.
  const b = r.breakdown;
  cents(b.revenueExGst - b.supplierCostExGst - b.stripeFeeExGst - b.supplierFreightExGst,
    -1.19, 'the figure the column printed before ERR-261');
});

test('§1 the delivery charge is split incl → ex by SUBTRACTION, not by /1.15', () => {
  const b = orderProfitFromDetail(CHARGED()).breakdown;
  cents(b.shippingRevenueInclGst, 12.00, 'shipping incl-GST');
  cents(b.shippingRevenueGst, 12 * GST_OF_GROSS, 'GST inside the charge');
  cents(b.shippingRevenueExGst, 12 - 12 * GST_OF_GROSS, 'shipping ex-GST');
  assert.equal(b.shippingRevenueExGst, b.shippingRevenueInclGst - b.shippingRevenueGst,
    'exGst must be derived as incl − gst so the waterfall foots exactly (ERR-118)');
  assert.equal(b.shippingRevenueBasis, 'recorded');
  // Everything the customer paid, ex-GST — the margin denominator.
  cents(b.revenueWithShippingExGst, 41.49 / 1.15, 'total ex-GST revenue');
});

// ─── §2 The bound a residual cannot fake ───────────────────────────────────

test('§2 🚨 GST remitted can never exceed the output GST on the sale', () => {
  const b = orderProfitFromDetail(CHARGED()).breakdown;
  const outputGst = b.customerPaidInclGst * GST_OF_GROSS;
  cents(outputGst, 5.41, 'output GST on a $41.49 sale');
  cents(b.gstRemittedToIrd, 1.39, 'GST remitted after credits');
  assert.ok(b.gstRemittedToIrd <= outputGst + 0.005,
    `remitting ${b.gstRemittedToIrd.toFixed(2)} of GST on a sale containing `
    + `${outputGst.toFixed(2)} is impossible — this is the assertion that would have `
    + 'caught ERR-261 on day one, and it reported $11.82 against a $5.41 ceiling');
  cents(b.gstCollected, outputGst, 'gstCollected must BE the output GST');
});

test('§2 RED-PROOF: the bound fires when revenue drops the shipping again', () => {
  // Reproduce the defect exactly — revenue = goods only — and confirm the
  // assertion above goes red. A bound that cannot fail is worse than none.
  const o = CHARGED();
  const goodsExGst = 29.49 / 1.15;
  const broken = computeProfitBreakdown(goodsExGst, 15.00, {
    customerPaidInclGst: 41.49, supplierFreight: o.supplier_freight,
    /* shippingRevenue deliberately omitted — the pre-ERR-261 call */
  });
  const outputGst = 41.49 * GST_OF_GROSS;
  cents(broken.gstRemittedToIrd, 11.82, 'the defect reproduces');
  assert.ok(broken.gstRemittedToIrd > outputGst,
    'THE RED-PROOF FAILED: the pre-fix arithmetic no longer breaches the bound, '
    + 'so §2 is vacuous and proves nothing');
  cents(broken.netProfit, -1.19, 'and the take-home it printed');
});

// ─── §3 The waterfall still foots, on the same outflows ────────────────────

test('§3 the cash waterfall foots on the SAME three outflows', () => {
  const b = orderProfitFromDetail(CHARGED()).breakdown;
  const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.supplierFreightInclGst - b.gstRemittedToIrd;
  cents(foot, b.netProfit, 'the waterfall must still foot to take-home');
  // ...but footing is NOT the evidence. It footed all through ERR-261 because
  // gstRemittedToIrd is the plug. The evidence is §2's bound, which is why that
  // test exists and why this one deliberately says so rather than standing alone.
  const brokenFoot = 41.49 - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.supplierFreightInclGst - 11.82;
  cents(brokenFoot, -1.19, 'the DEFECTIVE waterfall footed just as neatly — to the wrong number');
});

test('§3 the absorbed courier still moves nothing, even with shipping charged (ERR-255)', () => {
  const withAbsorbed = orderProfitFromDetail(CHARGED({
    shipping_absorbed: { applies: true, amount_incl_gst: 12, gst_component: 12 * GST_OF_GROSS, zone: 'rural' },
  }));
  const without = orderProfitFromDetail(CHARGED());
  cents(withAbsorbed.netProfit, without.netProfit,
    'shipping_absorbed is the SAME PARCEL as supplier_freight — deducting it is the double-charge');
  cents(withAbsorbed.breakdown.gstRemittedToIrd, without.breakdown.gstRemittedToIrd);
});

test('§3 the two engines agree — the column and the modal cannot diverge (ERR-113)', () => {
  const o = CHARGED();
  const r = orderProfitFromDetail(o);
  const single = computeOrderProfit(r.breakdown.revenueExGst, 15.00, {
    customerPaidInclGst: 41.49, supplierFreight: o.supplier_freight,
    shippingRevenue: { applies: true, amount_incl_gst: 12.00 },
  });
  cents(single, r.netProfit, 'computeOrderProfit and computeProfitBreakdown must agree');
});

test('§3 per-line profits still sum to the order profit (ERR-118)', () => {
  const multi = CHARGED({
    items: [
      { sell_price: 20, qty: 1, supplier_cost_snapshot: 11, suppliers: [{ name: 'Augmento' }] },
      { sell_price: 5.643478260869565, qty: 1, supplier_cost_snapshot: 4, suppliers: [{ name: 'Augmento' }] },
    ],
  });
  const r = orderProfitFromDetail(multi);
  cents(r.lineProfits.reduce((a, x) => a + x, 0), r.netProfit,
    'Σ lineProfits must equal netProfit — the order-level pool is a residual, so '
    + 'delivery income joins it automatically');
});

test('§3 delivery income may exceed the fees, and a line then out-earns its own margin', () => {
  // Shipping $12.00 against a $1.40 fee and no freight: the order-level pool is
  // NEGATIVE, i.e. income shared across lines. Counter-intuitive and deliberate.
  const r = orderProfitFromDetail(CHARGED({ supplier_freight: { applies: false } }));
  const line = r.lineProfits[0];
  const standalone = r.breakdown.revenueExGst - r.breakdown.supplierCostExGst;
  assert.ok(line > standalone,
    'with delivery income and no freight, a line profits by MORE than its own price minus cost');
  cents(r.lineProfits.reduce((a, x) => a + x, 0), r.netProfit, 'and it still foots');
});

// ─── §4 There is no derived branch, and there must never be one ────────────

test('§4 🚨 an order discount must still change the profit when no fee is stated', () => {
  // THE TEST THAT KILLED THE RESIDUAL DESIGN. `total − revenue × 1.15` books any
  // shortfall as delivery income, so an $11.50 discount came back as $11.50 of
  // shipping and net profit was IDENTICAL with and without it — ERR-168 undone
  // in silence. Both orders below lack shipping_fee, which is precisely when a
  // derived branch would fire.
  const base = {
    id: 'ap', status: 'paid', payment_method: 'stripe', total_amount: 120,
    items: [
      { sku: 'BIG', sell_price: 90, qty: 1, supplier_cost_snapshot: 40 },
      { sku: 'SML', sell_price: 10, qty: 1, supplier_cost_snapshot: 4 },
    ],
  };
  const discounted = orderProfitFromDetail({ ...base, discount_amount: 11.50 });
  const plain = orderProfitFromDetail({ ...base, discount_amount: 0 });
  assert.ok(Math.abs(plain.netProfit - discounted.netProfit) > 1,
    'a discount MUST reduce profit. If these are equal, a residual is reclassifying '
    + 'the discount as delivery income and ERR-168 has been silently reverted');
  cents(plain.netProfit - discounted.netProfit, 11.50 / 1.15, 'by the ex-GST discount');
});

test('§4 the source carries no total-minus-revenue reconstruction', () => {
  assert.ok(!/customerPaidInclGst\s*-\s*\w*[Rr]evenue\w*\s*\*\s*\(1 \+ GST_RATE\)/.test(orderProfitSrc)
    || /A RESIDUAL IS A CHECK, NEVER A SOURCE/.test(orderProfitSrc),
    'if a residual is computed it must be a cross-check with the warning beside it');
  assert.ok(/A RESIDUAL IS A CHECK, NEVER A SOURCE/.test(orderProfitSrc),
    'the reason the derived branch does not exist must stay written down, or it '
    + 'will be re-added by someone who notices absent orders are floored');
});

// ─── §5 The negative control: free shipping must not move ──────────────────

test('§5 a free-shipping order is untouched by all of this', () => {
  const r = orderProfitFromDetail(FREE_SHIP());
  const b = r.breakdown;
  assert.equal(b.shippingRevenueApplies, true, 'a $0 fee is RECORDED — free shipping is a decision');
  cents(b.shippingRevenueExGst, 0);
  // Take-home is exactly revenue − cost − stripe − freight on the goods alone,
  // which is what it was before ERR-261 touched anything.
  cents(r.netProfit, b.revenueExGst - b.supplierCostExGst - b.stripeFeeExGst - b.supplierFreightExGst,
    'a free-shipping order must be bit-identical to the pre-fix arithmetic');
  cents(b.gstCollected, b.customerPaidInclGst * GST_OF_GROSS, 'and its GST was always right');
});

// ─── §6 Absent is a FLOOR — not $0, not a refusal ──────────────────────────

test('§6 no stated fee ⇒ the figure STANDS and is flagged a floor, never blanked', () => {
  const noFee = CHARGED();
  delete noFee.shipping_fee;
  const r = orderProfitFromDetail(noFee);
  assert.equal(r.state, PROFIT_STATE.OK, 'ERR-158: present → absent is the wrong direction');
  assert.equal(r.shippingRevenueUnknown, true, 'and it must say so');
  assert.equal(r.shippingRevenueApplies, false);
  assert.equal(r.shippingRevenueBasis, null, 'no basis — we did not measure it and did not invent it');
  assert.ok(r.netProfit != null, 'take-home still prints; it is simply a lower bound');
});

test('§6 a null fee is unknown, not a $0 charge', () => {
  const r = orderProfitFromDetail(CHARGED({ shipping_fee: null }));
  assert.equal(r.shippingRevenueUnknown, true, 'null means NOT REPORTED');
  assert.equal(r.shippingRevenueApplies, false);
  // RED-PROOF of the distinction: a real 0 reports the opposite.
  const zero = orderProfitFromDetail(CHARGED({ shipping_fee: 0 }));
  assert.equal(zero.shippingRevenueUnknown, false, 'a recorded 0 is NOT unknown');
  assert.equal(zero.shippingRevenueApplies, true);
  assert.notEqual(r.shippingRevenueUnknown, zero.shippingRevenueUnknown,
    'if these agree, the detector cannot tell absence from free shipping');
});

test('§6 the floor and the freight CEILING point opposite ways and stay separate', () => {
  const noFee = CHARGED();
  delete noFee.shipping_fee;
  const floored = orderProfitFromDetail(noFee);
  const ceilinged = orderProfitFromDetail(CHARGED({
    supplier_freight: { ...FREIGHT(), complete: false, unpriced_consignments: 1 },
  }));
  assert.equal(floored.shippingRevenueUnknown, true);
  assert.equal(floored.supplierFreightCeiling, false, 'omitted revenue is not a ceiling cause');
  assert.equal(ceilinged.supplierFreightCeiling, true);
  assert.equal(ceilinged.shippingRevenueUnknown, false, 'unpriced freight is not a floor cause');
});

// ─── §7 null × 1.15, and the parameter that must stay inert ────────────────

test('§7 a null amount yields zero income, never a zero-GST windfall', () => {
  const b = computeProfitBreakdown(100, 50, {
    customerPaidInclGst: 115, shippingRevenue: { applies: true, amount_incl_gst: null },
  });
  assert.equal(b.shippingRevenueInclGst, 0);
  assert.equal(b.shippingRevenueExGst, 0);
});

test('§7 🚨 an omitted gst_component is DERIVED, because Number(null) is 0', () => {
  // This shipped broken for one run: `Number(s.gst_component)` on a null gave 0,
  // which is finite and non-negative, so the derive-it guard never fired and the
  // full $12.00 was booked ex-GST. exGst came back $12.00 instead of $10.43.
  const withNull = computeProfitBreakdown(100, 50, {
    customerPaidInclGst: 115, shippingRevenue: { applies: true, amount_incl_gst: 12, gst_component: null },
  });
  cents(withNull.shippingRevenueExGst, 12 - 12 * GST_OF_GROSS,
    'a null gst_component must fall through to incl × 3/23, not to zero GST');
  const stated = computeProfitBreakdown(100, 50, {
    customerPaidInclGst: 115, shippingRevenue: { applies: true, amount_incl_gst: 12, gst_component: 12 * GST_OF_GROSS },
  });
  cents(withNull.shippingRevenueExGst, stated.shippingRevenueExGst, 'both routes must agree');
});

test('§7 🚨 opts.shippingExGst is a FEE BASE and must never become revenue', () => {
  const base = { customerPaidInclGst: 115 };
  const plain = computeProfitBreakdown(100, 50, base);
  const withFeeBaseParam = computeProfitBreakdown(100, 50, { ...base, shippingExGst: 50 });
  cents(withFeeBaseParam.netProfit, plain.netProfit,
    'shippingExGst is inert once customerPaidInclGst is known — invoice-math.js:207 '
    + 'passes it with NO_PAYMENT_FEES and must keep getting nothing for it');
  // RED-PROOF: the parameter that IS revenue moves the same order.
  const withRevenue = computeProfitBreakdown(100, 50, {
    ...base, shippingRevenue: { applies: true, amount_incl_gst: 57.50 },
  });
  cents(withRevenue.netProfit - plain.netProfit, 50,
    'if this does not move, the test above is vacuous');
});

// ─── §8 The alias ladder, and the word that must stay off it ───────────────

test('§8 a supplier freight field named `freight` is NEVER read as income', () => {
  const r = orderProfitFromDetail(CHARGED({ shipping_fee: undefined, freight: 12.00 }));
  assert.equal(r.shippingRevenueApplies, false,
    '`freight` on an admin order is our supplier’s bill to US — reading a cost '
    + 'field as revenue would book the same parcel twice, in opposite directions');
  assert.equal(r.shippingRevenueUnknown, true);
});

test('§8 `shipping` is off the ladder — on a raw order it is the tier NAME', () => {
  const r = orderProfitFromDetail(CHARGED({ shipping_fee: undefined, shipping: 'Standard Shipping' }));
  assert.equal(r.shippingRevenueApplies, false);
  // RED-PROOF that the ladder itself works: a spelling that IS on it resolves.
  const alias = orderProfitFromDetail(CHARGED({ shipping_fee: undefined, shipping_cost: 12.00 }));
  assert.equal(alias.shippingRevenueApplies, true, 'shipping_cost must still be read');
  cents(alias.breakdown.shippingRevenueExGst, 12 - 12 * GST_OF_GROSS);
});

// ─── §9 The residual survives as a CHECK ───────────────────────────────────

test('§9 a stated fee that does not reconcile is disclosed, and still stands', () => {
  const agreeing = orderProfitFromDetail(CHARGED());
  assert.ok(Math.abs(agreeing.shippingRevenueDrift) <= 0.05,
    'a coherent order must report no drift');
  // $20.00 stated against a total that only leaves room for $12.00.
  const disagreeing = orderProfitFromDetail(CHARGED({ shipping_fee: 20.00 }));
  assert.ok(Math.abs(disagreeing.shippingRevenueDrift) > 0.05,
    'THE DETECTOR CANNOT FIRE — a disagreement check that never reports is worse than none');
  cents(disagreeing.shippingRevenueDrift, 8.00, 'and it reports the size of the gap');
  cents(disagreeing.breakdown.shippingRevenueInclGst, 20.00,
    'the STATED fee still wins — the backend owns the money, we disclose the mismatch');
});

// ─── §10 The revenue side refuses, exactly like the cost side ──────────────

test('§10 a line with no price makes the ORDER unknown, not a silent $0', () => {
  const r = orderProfitFromDetail(CHARGED({
    items: [{ sell_price: null, qty: 1, supplier_cost_snapshot: 15.00 }],
  }));
  assert.equal(r.state, PROFIT_STATE.UNKNOWN, 'an unpriced line understates profit as '
    + 'silently as an uncosted one — the cost side has refused since ERR-122');
  assert.equal(r.missingPriceCount, 1);
  assert.equal(r.netProfit, null, 'UNKNOWN, not $0');
});

test('§10 🚨 a null qty no longer makes a fully-costed line free on BOTH sides', () => {
  // The worst of the pair: `qty ?? 0` zeroed the revenue AND multiplied the
  // recorded cost by 0, so missingCostCount stayed 0 and the order resolved OK
  // with a confident, wrong number. No witness anywhere.
  const r = orderProfitFromDetail(CHARGED({
    items: [{ sell_price: 25.64, qty: null, supplier_cost_snapshot: 15.00 }],
  }));
  assert.equal(r.state, PROFIT_STATE.UNKNOWN);
  assert.equal(r.missingPriceCount, 1, 'no quantity ⇒ no stateable revenue');
  assert.equal(r.missingCostCount, 1, 'and no stateable cost either — a snapshot with '
    + 'nothing to multiply it by is not a $0 cost');
});

test('§10 a genuine 0 is still a real recorded price', () => {
  const r = orderProfitFromDetail(CHARGED({
    items: [{ sell_price: 0, qty: 1, supplier_cost_snapshot: 0, suppliers: [{ name: 'Augmento' }] }],
    total_amount: 12.00,
  }));
  assert.equal(r.missingPriceCount, 0, 'a giveaway is priced at $0, it is not unpriced');
  assert.equal(r.missingCostCount, 0);
});
