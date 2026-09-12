/**
 * Supplier freight on order profit — reading the backend's figure (ERR-241/251)
 * ============================================================================
 *
 * ERR-241 built a frontend resolver for supplier freight: per-supplier terms,
 * a transcribed courier ladder, a lightest-band estimate, and a guard that
 * dropped one consignment because `shipping_absorbed` was believed to cover it.
 * The backend now publishes the real figure per order and per consignment, so
 * all of that is deleted and this suite guards the READING of it.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING
 *
 *   1. THE ESTIMATOR IS GONE AND MUST STAY GONE. Running a local derivation
 *      beside the backend's field double-charges every order. Measured over 115
 *      live order-samples (70 on 2026-09-10, 45 on 09-12): there is NOT ONE
 *      order where `shipping_absorbed` applies and `supplier_freight` does not,
 *      and where both apply the amounts are identical on 39 of 41. The two
 *      exceptions are the same order both times — 2026090102, two suppliers,
 *      where absorbed is ONE parcel rate ($7) and freight is TWO ($14). So
 *      `shipping_absorbed` is a strict SUBSET of `supplier_freight`.
 *
 *   2. FOUR STATES, NOT TWO, AND THE FOURTH IS THE ONE THAT MATTERS.
 *        applies:true + complete:true   → the bill, exact
 *        applies:false                  → a KNOWN zero
 *        complete:false / unpriced > 0  → a FLOOR ⇒ take-home is a CEILING
 *        field ABSENT                   → LOUD unknown, NEVER $0
 *      Absence and `{applies:false}` produce the same dollar figure and mean
 *      opposite things. That is the ERR-243 shape, so the test is
 *      `hasOwnProperty` and never truthiness.
 *
 *   3. THE CEILING IS A QUALIFIER, NOT A REFUSAL. Unpriced freight is BOUNDED
 *      (the ladder tops out at $30) and DIRECTIONAL (it can only push profit
 *      down), so take-home stands and says "at most". Blanking it would be
 *      present→absent (ERR-158). A missing supplier COST is different —
 *      unbounded, dominant term — and still refuses outright.
 *
 *   4. "ESTIMATED" IS NOT A STATE ANY MORE. It was the name of a defect.
 *      `supplier_freight` is present on 150 of 150 live list rows and on every
 *      detail payload; there is nothing left to estimate.
 *
 * TWO PATHS CANNOT BE PROVEN AGAINST LIVE DATA. `complete:false` and
 * `unpriced_consignments > 0` fire on 0 of 149 live orders, so they are
 * unit-tested here and the probe SKIPS them BY NAME. A skip is not a pass.
 *
 * Run with: node --test tests/supplier-freight-sep2026.test.js
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
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');

const ordersSrc = fs.readFileSync(ORDERS_PAGE, 'utf8');
const freightSrc = fs.readFileSync(SUPPLIER_FREIGHT, 'utf8');
const profitabilitySrc = fs.readFileSync(PROFITABILITY, 'utf8');

// Each module runs inside its own function scope: profitability.js and
// sourcing.js both declare a module-private `const MISSING`, and two top-level
// consts of one name in a shared vm context is a SyntaxError naming the wrong file.
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
const {
  supplierFreightForOrder, freightCeilingReason, freightReasonPhrase, FREIGHT_REASONS,
  deliveryFactsForOrder, orderSupplierCostFromDetail, orderProfitFromDetail, PROFIT_STATE,
  computeProfitBreakdown, computeOrderProfit, GST_RATE,
} = sandbox;

const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;

/** The backend envelope for 2026090902, copied from the live payload 2026-09-12. */
const ENVELOPE = () => ({
  applies: true,
  zone: 'south-island',
  delivery_type: 'rural',
  delivery_type_basis: 'snapshot',
  parcel_weight_kg: 0.4,
  parcel_rate_incl_gst: 14,
  amount_incl_gst: 14,
  gst_component: 1.83,
  amount_ex_gst: 12.17,
  complete: true,
  unpriced_consignments: 0,
  consignments: [{
    supplier: 'Augmento', supplier_basis: 'default', billed: true, unpriced: false,
    reason: 'goods_under_free_threshold', goods_cost_ex_gst: 76, free_threshold_ex_gst: 100,
    parcel_weight_kg: 0.4, line_count: 1,
    amount_incl_gst: 14, gst_component: 1.83, amount_ex_gst: 12.17,
  }],
});

/** An order shaped like the admin detail endpoint's. Free shipping by default. */
const mkOrder = (over = {}) => ({
  id: 'o1',
  order_number: '2026090902',
  status: 'paid',
  delivery_zone: 'south-island',
  shipping_fee: 0,
  total_amount: 134.49,
  shipping_absorbed: { applies: false },
  supplier_freight: ENVELOPE(),
  items: [{ sku: 'C955XLKCMY', qty: 1, sell_price: 116.95, supplier_cost_snapshot: 76.00,
    suppliers: [{ name: 'Augmento', sku: 'C955XLBK' }, { name: 'Augmento', sku: 'C955XLC' },
      { name: 'Augmento', sku: 'C955XLM' }, { name: 'Augmento', sku: 'C955XLY' }] }],
  ...over,
});

// ─── 1. The estimator is GONE, and must stay gone ────────────────────────────

test('the local rate ladder and the per-supplier rules are DELETED', () => {
  // Each of these was a real export until 2026-09-12. Their return means
  // someone re-derived a figure the backend already publishes — which is the
  // double-charge, not a second opinion.
  for (const gone of ['ZONE_RATES', 'SUPPLIER_FREIGHT_RULES', 'lightestZoneRateInclGst',
    'zoneRateInclGst', 'consignmentWeightKg']) {
    assert.equal(sandbox[gone], undefined, `${gone} must not come back — the backend owns the rate`);
    assert.ok(!new RegExp(`export\\s+(const|function)\\s+${gone}\\b`).test(freightSrc),
      `${gone} must not be exported from supplier-freight.js`);
  }
});

test('the customer-paid-delivery short-circuit is DELETED (44% of the bill)', () => {
  // Measured: 27 of 60 orders have customer-paid shipping AND a real backend
  // freight bill — $221.77 of $506.98 — and 0 have customer-paid shipping
  // without one. The customer paying OUR courier to reach THEM says nothing
  // about a supplier billing US to reach our door.
  assert.ok(!/function\s+customerPaidFreight/.test(freightSrc),
    'customerPaidFreight must be gone: it returned a clean $0 with no qualifier to notice');
  const paid = supplierFreightForOrder(mkOrder({ shipping_fee: 9.5 }));
  assert.equal(paid.applies, true, 'a charged delivery must NOT suppress the supplier freight bill');
  assert.ok(near(paid.amount_incl_gst, 14));
});

test('the word "estimated" is gone from the engine and from every surface', () => {
  for (const [src, label] of [[freightSrc, 'supplier-freight.js'], [ordersSrc, 'pages/orders.js']]) {
    const live = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // comments may explain the deletion
      .join('\n');
    assert.ok(!/estimated/i.test(live), `"estimated" must not survive in ${label}`);
  }
  assert.equal(supplierFreightForOrder(mkOrder()).estimated, undefined);
});

// ─── 2. Four states, and the fourth is the one that matters ──────────────────

test('applies:true + complete:true → the exact bill', () => {
  const f = supplierFreightForOrder(mkOrder());
  assert.equal(f.applies, true);
  assert.equal(f.unknown, false);
  assert.equal(f.absent, false);
  assert.equal(f.complete, true);
  assert.ok(near(f.amount_incl_gst, 14));
  assert.ok(near(f.gst_component, 1.83));
  assert.ok(near(f.amount_ex_gst, 12.17));
  assert.equal(freightCeilingReason(f), null, 'an exact figure is not a ceiling');
});

test('applies:false → a KNOWN zero: no row, no qualifier, no refusal', () => {
  const f = supplierFreightForOrder(mkOrder({ supplier_freight: { applies: false } }));
  assert.equal(f.applies, false);
  assert.equal(f.unknown, false, 'we decided no — that is not "we could not decide"');
  assert.equal(f.absent, false);
  assert.equal(f.amount_incl_gst, 0);
  assert.equal(freightCeilingReason(f), null, 'a known zero is exact, not a ceiling');
});

test('🚨 ABSENT is not {applies:false} — and the dollar figure cannot tell them apart', () => {
  // Both produce zero freight. They mean opposite things. ERR-243: `null` once
  // meant both "no list" and "read failed", and the two needed a third state.
  const order = mkOrder();
  delete order.supplier_freight;
  assert.equal('supplier_freight' in order, false, 'positive control: the key must really be gone');

  const absent = supplierFreightForOrder(order);
  const known = supplierFreightForOrder(mkOrder({ supplier_freight: { applies: false } }));

  assert.equal(absent.amount_incl_gst, known.amount_incl_gst, 'the AMOUNTS agree — that is the trap');
  assert.equal(absent.absent, true);
  assert.equal(absent.unknown, true, 'a field that never arrived is UNKNOWN, not zero');
  assert.equal(known.absent, false);
  assert.equal(known.unknown, false);
  assert.ok(freightCeilingReason(absent), 'absence must make take-home a ceiling');
  assert.equal(freightCeilingReason(known), null);
});

test('a present-but-unusable envelope is not the same as an absent one', () => {
  // `supplier_freight: null` means the backend ANSWERED and the answer is
  // unusable. Distinct from never having been asked.
  for (const bad of [null, 'yes', 7]) {
    const f = supplierFreightForOrder(mkOrder({ supplier_freight: bad }));
    assert.equal(f.unknown, true, `${JSON.stringify(bad)} must be unknown`);
    assert.equal(f.absent, false, `${JSON.stringify(bad)} is present, just unreadable`);
  }
});

test('applies:true with no usable amount is a CEILING, not a silent zero', () => {
  // The backend contradicting itself. Rendering nothing would read as "no
  // freight owed" for an order we have been told owes some.
  for (const amt of [0, -3, null, undefined, 'abc']) {
    const f = supplierFreightForOrder(mkOrder({
      supplier_freight: { ...ENVELOPE(), amount_incl_gst: amt },
    }));
    assert.equal(f.unknown, true, `amount ${JSON.stringify(amt)} must refuse`);
    assert.ok(freightCeilingReason(f));
  }
});

// ─── 3. complete:false — a FLOOR, so take-home is a CEILING ──────────────────
//
// Fires on 0 of 149 live orders. Unit-testable only; the probe skips it by name.

test('complete:false makes the total a floor and take-home a ceiling', () => {
  const f = supplierFreightForOrder(mkOrder({
    supplier_freight: { ...ENVELOPE(), complete: false, unpriced_consignments: 1 },
  }));
  assert.equal(f.applies, true, 'the part we CAN price still applies');
  assert.equal(f.complete, false);
  assert.equal(f.unpricedConsignments, 1);
  assert.ok(near(f.amount_incl_gst, 14), 'the priced part is still deducted');
  assert.match(freightCeilingReason(f), /could not be priced/);
});

test('an unpriced consignment overrides a complete:true the backend also sent', () => {
  // The two are the same claim from two directions. Disagreeing with ourselves
  // is not a state we should be able to render.
  const f = supplierFreightForOrder(mkOrder({
    supplier_freight: { ...ENVELOPE(), complete: true, unpriced_consignments: 2 },
  }));
  assert.equal(f.complete, false);
  assert.match(freightCeilingReason(f), /2 supplier consignments/);
});

test('an ABSENT `complete` on a present envelope is not a refusal', () => {
  const env = ENVELOPE();
  delete env.complete;
  const f = supplierFreightForOrder(mkOrder({ supplier_freight: env }));
  assert.equal(f.complete, true, 'only an explicit false means incomplete');
  assert.equal(freightCeilingReason(f), null);
});

// ─── 4. The money ────────────────────────────────────────────────────────────

test('freight is deducted ex-GST and its GST is credited at the IRD line', () => {
  const info = orderProfitFromDetail(mkOrder());
  const bare = orderProfitFromDetail(mkOrder({ supplier_freight: { applies: false } }));
  assert.ok(near(info.netProfit, bare.netProfit - 12.17), `${bare.netProfit} → ${info.netProfit}`);
  assert.ok(near(info.breakdown.gstRemittedToIrd, bare.breakdown.gstRemittedToIrd - 1.83));
});

test('🚨 shipping_absorbed contributes NOTHING, even when it applies', () => {
  // 24 of 70 live orders carry both blocks. Before this change they were both
  // deducted, double-charging one parcel.
  const withBoth = orderProfitFromDetail(mkOrder({
    shipping_absorbed: {
      applies: true, basis: 'zone_rate', zone: 'south-island', delivery_type: 'rural',
      parcel_weight_kg: 0.4, amount_incl_gst: 14, gst_component: 1.83, amount_ex_gst: 12.17,
    },
  }));
  const freightOnly = orderProfitFromDetail(mkOrder());
  assert.equal(withBoth.absorbedApplies, true, 'positive control: the absorbed block must be live');
  assert.ok(near(withBoth.netProfit, freightOnly.netProfit, 1e-9),
    `one parcel, one charge: ${freightOnly.netProfit} vs ${withBoth.netProfit}`);
  assert.equal(withBoth.breakdown.absorbedShippingSupersededByFreight, true);
});

test('the cash waterfall foots on FOUR outflows', () => {
  const b = orderProfitFromDetail(mkOrder()).breakdown;
  const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.supplierFreightInclGst - b.gstRemittedToIrd;
  assert.ok(near(foot, b.netProfit), `waterfall ${foot} ≠ take-home ${b.netProfit}`);
});

test('the worked example: 2026090902 lands at $24.92 / 21.3%', () => {
  // Verified against the live payload 2026-09-12 and footed to the cent:
  //   revenue ex-GST 116.95, goods ex-GST 76.00,
  //   Stripe 134.49 × 2.65% + 0.30 = 3.86 (deducted as the 2026-05-17
  //   convention has it — handoff §6's ÷1.15 was DECLINED by the owner
  //   pending a real Stripe invoice; see the ERR-255 entry),
  //   supplier freight 12.17 ex-GST.
  //   116.95 − 76.00 − 3.86 − 12.17 = 24.92, margin 21.3%.
  const info = orderProfitFromDetail(mkOrder());
  assert.equal(info.state, PROFIT_STATE.OK);
  assert.ok(near(info.netProfit, 24.92), `take-home ${info.netProfit}`);
  assert.ok(near(info.netMarginPct, 21.3, 0.05), `margin ${info.netMarginPct}`);
  // The goods row is untouched — freight is its own outflow, not a markup on
  // what we paid for the cartridges (ERR-219).
  assert.ok(near(info.breakdown.supplierCostInclGst, 87.40, 0.01));
});

test('an order that owes no freight is byte-identical to the pre-change figure', () => {
  // The over-$100 control. If this moves, freight is being charged to orders
  // that do not owe it.
  const info = orderProfitFromDetail(mkOrder({ supplier_freight: { applies: false } }));
  assert.ok(near(info.netProfit, 116.95 - 76.00 - (134.49 * 0.0265 + 0.30)),
    `no-freight take-home ${info.netProfit}`);
});

test('a missing supplier COST still refuses outright — it is unbounded', () => {
  // The distinction that ERR-241 got wrong first time. Unpriced FREIGHT is
  // bounded and directional, so it qualifies. A missing COST is the dominant
  // term and unbounded, so no honest number can be printed at all.
  const info = orderProfitFromDetail(mkOrder({
    items: [{ sku: 'X', qty: 1, sell_price: 116.95, supplier_cost_snapshot: null, suppliers: [{ name: 'Augmento' }] }],
  }));
  assert.equal(info.state, PROFIT_STATE.UNKNOWN);
  assert.equal(info.netProfit, null);
});

test('unpriced freight does NOT blank take-home (ERR-158)', () => {
  const order = mkOrder();
  delete order.supplier_freight;
  const info = orderProfitFromDetail(order);
  assert.equal(info.state, PROFIT_STATE.OK, 'a bounded unknown is a qualifier, not a refusal');
  assert.ok(info.netProfit != null, 'the figure we CAN state must survive');
  assert.equal(info.supplierFreightCeiling, true);
  assert.equal(info.supplierFreightAbsent, true);
});

// ─── 5. Multi-consignment — reachable, but only just ─────────────────────────
//
// 3 of 149 live orders. A named fixture, because a path that passes only when
// the live sample happens to contain 2026090102 is a coin flip with a green tick.

const TWO_SUPPLIERS = () => ({
  applies: true, zone: 'north-island', delivery_type: 'urban', delivery_type_basis: 'charged',
  parcel_weight_kg: 2.1, parcel_rate_incl_gst: 12,
  amount_incl_gst: 19, gst_component: 2.48, amount_ex_gst: 16.52,
  complete: true, unpriced_consignments: 0,
  consignments: [
    { supplier: 'Augmento', billed: true, reason: 'goods_under_free_threshold',
      goods_cost_ex_gst: 27.07, free_threshold_ex_gst: 100, parcel_weight_kg: 0.1, amount_incl_gst: 7 },
    { supplier: 'DSNZ', billed: true, reason: 'always_billed',
      goods_cost_ex_gst: 70.51, free_threshold_ex_gst: null, parcel_weight_kg: 2.0, amount_incl_gst: 12 },
  ],
});

test('two consignments: both suppliers are named and the total is theirs, not the parcel rate', () => {
  const f = supplierFreightForOrder(mkOrder({ supplier_freight: TWO_SUPPLIERS() }));
  assert.deepEqual(f.suppliers, ['Augmento', 'DSNZ']);
  assert.ok(near(f.amount_incl_gst, 19));
  assert.ok(near(f.parcelRateInclGst, 12),
    'the ORDER-level parcel rate is 12 — the bill is 19 because there are two parcels');
  assert.equal(f.consignments.length, 2);
});

test('a consignment marked billed:false is not named as a biller', () => {
  const env = TWO_SUPPLIERS();
  env.consignments[1].billed = false;
  env.consignments[1].reason = 'goods_at_or_over_free_threshold';
  const f = supplierFreightForOrder(mkOrder({ supplier_freight: env }));
  assert.deepEqual(f.suppliers, ['Augmento'], 'only the supplier that actually billed us');
});

// ─── 6. The reason vocabulary ────────────────────────────────────────────────

test('every reason the backend documents has a phrase', () => {
  for (const r of ['always_billed', 'goods_under_free_threshold', 'goods_at_or_over_free_threshold',
    'unknown_supplier', 'unknown_supplier_terms', 'unknown_goods_cost']) {
    assert.ok(Object.prototype.hasOwnProperty.call(FREIGHT_REASONS, r), `${r} must have a phrase`);
    assert.ok(freightReasonPhrase(r), `${r} must render`);
  }
});

test('an unrecognised reason is a GAP, not an empty string', () => {
  // A new backend reason must show up as missing, not silently render a
  // sentence with a hole where the explanation should be.
  assert.equal(freightReasonPhrase('some_new_rule_2027'), null);
  assert.equal(freightReasonPhrase(undefined), null);
});

// ─── 7. Delivery provenance travels with the freight (ERR-253) ───────────────

test('the delivery area and its basis survive every refusal path', () => {
  const order = mkOrder({ supplier_freight: { applies: false, delivery_type: 'rural', delivery_type_basis: 'charged', parcel_weight_kg: 0.4 } });
  const f = supplierFreightForOrder(order);
  assert.equal(f.deliveryType, 'rural', 'an order we charge no freight on still has a delivery area');
  assert.equal(f.deliveryTypeBasis, 'charged');
  assert.equal(f.parcelWeightKg, 0.4);
});

test('a delivery area that was never recorded stays null, never "urban"', () => {
  // ERR-235 is what happens when a guess is stored as a fact.
  const f = supplierFreightForOrder(mkOrder({
    delivery_type: null,
    supplier_freight: { applies: false },
  }));
  assert.equal(f.deliveryType, null);
  assert.notEqual(f.deliveryType, 'urban');
});

test('deliveryFactsForOrder prefers the order column, then the freight envelope', () => {
  assert.equal(deliveryFactsForOrder({ delivery_type: 'rural', supplier_freight: { delivery_type: 'urban' } }).deliveryType, 'rural');
  assert.equal(deliveryFactsForOrder({ supplier_freight: { delivery_type: 'urban', delivery_type_basis: 'assumed' } }).basis, 'assumed');
  assert.equal(deliveryFactsForOrder({}).deliveryType, null);
});

// ─── 8. The render wiring — EXECUTED, not grepped ────────────────────────────

/**
 * Execute the SHIPPED template text rather than grepping it.
 *
 * Every source grep can tell you the characters are present; only running the
 * block tells you the row RENDERS. This lifts the real
 * `if (b.supplierFreightApplies) { … }` out of pages/orders.js and runs it with
 * the helpers it actually closes over.
 *
 * FRAGILITY, NAMED SO THE NEXT PERSON DOES NOT HAVE TO REDISCOVER IT:
 *   • the anchor is located by REGEX, not by an exact-spacing indexOf — the
 *     previous version broke on any reformat while the neighbouring grep test
 *     stayed green, which is precisely backwards.
 *   • brace matching is naive character counting with no string/comment
 *     awareness. It works because `${…}` interpolations are balanced. A literal
 *     `{` or `}` inside a STRING in that block would desynchronise it.
 *   • the accumulator must stay named `profitBreakdownInner`.
 *   • the closed-over helper set is the parameter list below. A sixth helper in
 *     the block means a sixth parameter here.
 */
function lift(name, startRe, endMarker) {
  const m = startRe.exec(ordersSrc);
  assert.ok(m, `${name}: the block must exist to be executed`);
  const start = m.index;
  let depth = 0; let end = -1;
  for (let i = ordersSrc.indexOf('{', start); i < ordersSrc.length; i++) {
    if (ordersSrc[i] === '{') depth++;
    else if (ordersSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, `${name}: the block must be brace-balanced`);
  if (endMarker) assert.ok(ordersSrc.slice(start, end).includes(endMarker), `${name}: ${endMarker} must be inside`);
  return ordersSrc.slice(start, end);
}

/** deliveryPhrase and titleCaseZone are SHIPPED code — lift them, never stub them. */
function liftedHelper(declRe, name) {
  const m = declRe.exec(ordersSrc);
  assert.ok(m, `${name} must still live in orders.js`);
  const start = m.index;
  let depth = 0; let end = -1;
  for (let i = ordersSrc.indexOf('{', start); i < ordersSrc.length; i++) {
    if (ordersSrc[i] === '{') depth++;
    else if (ordersSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return ordersSrc.slice(start, end);
}

const DELIVERY_BASIS_PHRASE_SRC = ordersSrc.slice(
  ordersSrc.indexOf('const DELIVERY_BASIS_PHRASE = {'),
  ordersSrc.indexOf('/** The modal’s Delivery cell.') > -1
    ? ordersSrc.indexOf('/** The modal’s Delivery cell.')
    : ordersSrc.indexOf("/** The modal's Delivery cell."));

function renderFreightRow(breakdown, profitInfo = {}) {
  const block = lift('freight row', /if \(b\.supplierFreightApplies\) \{/, 'Supplier freight');
  const phraseFns = DELIVERY_BASIS_PHRASE_SRC + '\n';
  const titleCase = liftedHelper(/function titleCaseZone\(/, 'titleCaseZone');
  const fn = new Function('b', 'profitInfo', 'formatPrice', 'esc', 'muted', 'pbRow', 'neg',
    'freightReasonPhrase', `
    ${phraseFns}
    ${titleCase}
    let profitBreakdownInner = '';
    ${block}
    return profitBreakdownInner;
  `);
  return fn(
    breakdown, profitInfo,
    (v) => `$${Number(v).toFixed(2)}`,
    (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c])),
    (t) => `<span class="admin-text-muted">${t}</span>`,
    (label, value) => `<div class="om-meta-row"><span>${label}</span><span class="mono">${value}</span></div>`,
    (v) => `−$${Math.abs(v).toFixed(2)}`,
    freightReasonPhrase,
  );
}

test('the shipped freight row renders the supplier, the amount and the rule that fired', () => {
  const b = computeProfitBreakdown(116.95, 76.00, {
    customerPaidInclGst: 134.49,
    supplierFreight: supplierFreightForOrder(mkOrder()),
  });
  const html = renderFreightRow(b);
  assert.match(html, /Supplier freight/, 'the row must be labelled');
  assert.match(html, /Augmento/, 'the supplier must be named — "a supplier" is not an answer');
  assert.match(html, /−\$14\.00/, 'the amount must render as a negative outflow');
  assert.match(html, /under the free-freight threshold/, 'the tooltip must state the rule that fired');
  assert.match(html, /\$76\.00 ex-GST against \$100\.00/, 'the two numbers the rule fired on');
});

test('the row NEVER says "estimated" — that state no longer exists', () => {
  const b = computeProfitBreakdown(116.95, 76.00, {
    customerPaidInclGst: 134.49, supplierFreight: supplierFreightForOrder(mkOrder()),
  });
  assert.ok(!/estimated/i.test(renderFreightRow(b)), 'a measured figure must not be labelled an estimate');
});

test('the row renders NOTHING when no freight applies (negative control)', () => {
  // Proves the two tests above exercise the GUARD, not just the template.
  const b = computeProfitBreakdown(116.95, 76.00, { customerPaidInclGst: 134.49 });
  assert.equal(renderFreightRow(b), '', 'a $0.00 freight row would imply a payment we never made');
});

test('an assumed delivery area is flagged; a recovered one is not', () => {
  const assumed = supplierFreightForOrder(mkOrder({
    supplier_freight: { ...ENVELOPE(), delivery_type: 'urban', delivery_type_basis: 'assumed' },
  }));
  const exact = supplierFreightForOrder(mkOrder());
  const bA = computeProfitBreakdown(116.95, 76.00, { customerPaidInclGst: 134.49, supplierFreight: assumed });
  const bE = computeProfitBreakdown(116.95, 76.00, { customerPaidInclGst: 134.49, supplierFreight: exact });
  assert.match(renderFreightRow(bA), /NOT recorded/, 'an assumption must say so');
  assert.ok(!/NOT recorded/.test(renderFreightRow(bE)), 'a recovered area must not carry a warning');
});

test('the free-shipping fact rides in the tooltip, counted once', () => {
  const b = computeProfitBreakdown(116.95, 76.00, {
    customerPaidInclGst: 134.49,
    supplierFreight: supplierFreightForOrder(mkOrder()),
    absorbedShipping: { applies: true, amount_incl_gst: 14, gst_component: 1.83 },
  });
  assert.match(renderFreightRow(b), /counted here once, not twice/);
});

test('two consignments produce two tooltip lines', () => {
  const b = computeProfitBreakdown(116.95, 76.00, {
    customerPaidInclGst: 134.49,
    supplierFreight: supplierFreightForOrder(mkOrder({ supplier_freight: TWO_SUPPLIERS() })),
  });
  const html = renderFreightRow(b);
  assert.match(html, /Augmento/);
  assert.match(html, /DSNZ/);
  assert.match(html, /billed on every purchase order/, 'DSNZ’s rule');
});

// ─── 9. Surface wiring — source pins with the contract named ─────────────────

test('the "(at most)" qualifier and the ≤ mark key off ONE ceiling gate', () => {
  assert.ok(/profitInfo\.supplierFreightCeiling\s*\n?\s*\?\s*`<strong>Take-home profit<\/strong>/.test(ordersSrc),
    'take-home must say "(at most)" on supplierFreightCeiling, not on one of its two causes');
  assert.ok(/const ceilingMark = info\.supplierFreightCeiling/.test(ordersSrc),
    'the list cell’s ≤ mark must use the same gate');
});

test('the IRD credit list no longer names the courier', () => {
  assert.ok(!/\?\s*'courier'\s*:\s*null/.test(ordersSrc),
    'crediting GST we no longer deduct would promise a credit the arithmetic does not take');
  assert.ok(/b\.supplierFreightApplies \? 'supplier freight' : null/.test(ordersSrc));
});

test('the profit engine deducts freight and NOT the absorbed courier', () => {
  assert.ok(/netProfit = rev - costExGst - stripeFeeExGst - supplierFreightExGst;/.test(profitabilitySrc),
    'netProfit must have exactly four terms');
  assert.ok(/gstRemittedToIrd = gstCollected - supplierCostGst - stripeFeeGst - supplierFreightGst;/.test(profitabilitySrc),
    'the IRD line must not credit the absorbed courier');
});

test('the page does no freight maths of its own', () => {
  // The engine owns the arithmetic; the page renders it. A rate or a threshold
  // appearing here means the derivation grew back somewhere new.
  //
  // KNOWN WEAKNESS, LEFT DELIBERATELY: this bans the CHARACTERS `0.15 / 1.15`
  // rather than an OPERATION on a value, so it will also fire on PROSE — the
  // first time someone adds a footnote or a worked example to orders.js quoting
  // a GST fraction, this goes red on a documentation change, which is a
  // confusing place to land. Banning a number catches sentences; banning an
  // operation catches the bug. Left as-is because orders.js carries no such
  // prose today and a green guard is not worth churning; if you are reading
  // this because it just failed on a comment you added, THAT is why — rewrite
  // it to forbid arithmetic on the freight value rather than relaxing it.
  // (Failure mode identified by wire-backend-supplier-freight.)
  assert.ok(!/supplierFreightForOrder/.test(ordersSrc), 'orders.js must not resolve freight itself');
  assert.ok(!/\b(0\.15\s*\/\s*1\.15|free_threshold_ex_gst\s*[<>])/.test(ordersSrc),
    'no GST extraction or threshold comparison in the page');
});

test('the whole thing stays owner-only', () => {
  assert.ok(/OWNER_ONLY_COLUMNS = new Set\(\['_profit', '_supplier', '_supplier_cost'\]\)/.test(ordersSrc));
  assert.ok(/const showCost = AdminAuth\.isOwner\(\)/.test(ordersSrc));
});
