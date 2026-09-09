/**
 * Supplier freight on order profit (ERR-241)
 * ==========================================
 *
 * The customer's free-shipping threshold is $100 on the SELL price. The
 * supplier's free-freight threshold is $100 on the GOODS COST, ex-GST. Two
 * independent tests on two different numbers, and an order sits on both sides
 * of them routinely — 2026090902 sold for $134.49 (customer shipped free) on
 * goods that cost $76.00 ex-GST (Augmento still billed us the delivery). Until
 * this work that freight was charged to nobody and take-home read $37.09.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING
 *
 *   1. THE RULE IS PER SUPPLIER, NOT PER ORDER. DSNZ bills freight on every
 *      purchase order; Augmento only under $100. An order total cannot express
 *      that, so a per-supplier cost roll-up is the input.
 *   2. NO DOUBLE CHARGE. `order.shipping_absorbed` already deducts one
 *      consignment on the orders the backend knows about (measured: 23 of 60
 *      live orders, every one of them containing a DSNZ line). This module
 *      charges what the backend has NOT.
 *   3. UNPRICED FREIGHT IS A CEILING, NOT A BLANK. An unpriced freight charge
 *      is bounded by the courier ladder and can only push profit DOWN, so
 *      take-home stands and says "at most". Deleting a figure we can state
 *      would be present→absent (ERR-158). A missing supplier COST is different
 *      — unbounded, dominant term — and still refuses.
 *   4. AN ESTIMATE MUST NEVER READ AS A MEASUREMENT. Parcel weight and
 *      urban/rural are not on the order payload, so the amount is the lightest
 *      band of the zone ladder. Every surface prints the word "estimated".
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
  SUPPLIER_FREIGHT_RULES, ZONE_RATES, lightestZoneRateInclGst, supplierFreightForOrder,
  orderSupplierCostFromDetail, supplierSlug, orderProfitFromDetail, PROFIT_STATE,
  computeProfitBreakdown, computeOrderProfit, computeLineProfits, GST_RATE,
} = sandbox;

const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;

/** An order shaped like the admin detail endpoint's. Free shipping by default. */
const mkOrder = (over = {}) => ({
  id: 'o1',
  order_number: '2026090902',
  status: 'paid',
  delivery_zone: 'south-island',
  shipping_fee: 0,
  total_amount: 134.49,
  shipping_absorbed: { applies: false },
  items: [{ sku: 'C955XLKCMY', qty: 1, sell_price: 116.95, supplier_cost_snapshot: 76.00,
    suppliers: [{ name: 'Augmento', sku: 'C955XLBK' }, { name: 'Augmento', sku: 'C955XLC' },
      { name: 'Augmento', sku: 'C955XLM' }, { name: 'Augmento', sku: 'C955XLY' }] }],
  ...over,
});

const line = (name, cost, qty = 1, price = 100) => ({
  sku: `SKU-${name}-${cost}`, qty, sell_price: price, supplier_cost_snapshot: cost,
  suppliers: name ? [{ name }] : [],
});

// ─── 1. The rules themselves ────────────────────────────────────────────────

test('DSNZ always pays freight; Augmento is free at or above $100 ex-GST', () => {
  assert.equal(SUPPLIER_FREIGHT_RULES.dsnz.alwaysPays, true);
  assert.equal(SUPPLIER_FREIGHT_RULES.augmento.freeOverExGst, 100);
  assert.equal(SUPPLIER_FREIGHT_RULES.dsnz.freeOverExGst, undefined,
    'DSNZ must not carry a threshold — "always" is not "under a very large number"');
});

test('a supplier with no recorded terms is UNKNOWN, never free', () => {
  // okin is a real SUPPLIER_FILTER_VALUES entry whose freight terms nobody has
  // ever stated. Defaulting it to $0 is the absence-as-zero bug with money on it.
  assert.equal(SUPPLIER_FREIGHT_RULES.okin, undefined);
  assert.equal(SUPPLIER_FREIGHT_RULES.unknown, undefined);
});

test('supplierSlug crosses the name/slug gap both suppliers actually use', () => {
  assert.equal(supplierSlug('DSNZ'), 'dsnz');
  assert.equal(supplierSlug('Augmento'), 'augmento');
  assert.equal(supplierSlug('  augmento  '), 'augmento');
  // Absence is not a supplier.
  for (const v of [null, undefined, '', '   ', 'unknown', 'none', 'n/a', 'NA']) {
    assert.equal(supplierSlug(v), null, `${JSON.stringify(v)} must resolve to null`);
  }
});

// ─── 2. The zone ladder ─────────────────────────────────────────────────────

test('the zone ladder reproduces every rate the backend has actually charged', () => {
  // Measured amounts in live shipping_absorbed rows: $7, $12 and $22 incl-GST.
  const fees = new Set();
  for (const tiers of Object.values(ZONE_RATES)) for (const t of tiers) fees.add(t.fee);
  for (const seen of [7, 12, 22]) assert.ok(fees.has(seen), `$${seen} must exist in the ladder`);
});

test('the lightest rate is the URBAN floor, and an unknown zone yields null', () => {
  assert.equal(lightestZoneRateInclGst('auckland'), 7);
  assert.equal(lightestZoneRateInclGst('north-island'), 7);
  assert.equal(lightestZoneRateInclGst('south-island'), 7);
  assert.equal(lightestZoneRateInclGst('south-island', 'rural'), 14);
  // Unknown/absent must be null — NOT 0, which would read as "free delivery".
  for (const z of [null, undefined, '', 'chatham-islands', 'AUSTRALIA']) {
    assert.equal(lightestZoneRateInclGst(z), null, `${JSON.stringify(z)} must be null, never 0`);
  }
});

test('the ladder is a transcription, and says so rather than reading Config', () => {
  // Config.settings.shipping does not exist in the admin (only cart.js calls
  // Config.loadSettings). A `Config.settings?.shipping ?? FALLBACK` here would be
  // an off switch whose fallback is the only branch that runs — ERR-167.
  // Strip comments first: the file EXPLAINS why it doesn't read Config, and a
  // grep that can't tell an explanation from a call would ban the explanation.
  const code = freightSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bConfig\s*\./.test(code),
    'supplier-freight.js must not read Config — it is not loaded in the admin');
  assert.ok(/api\/settings/.test(freightSrc),
    'the ladder must name its source so the probe can re-check it');
});

// ─── 3. Per-supplier cost attribution ───────────────────────────────────────

test('an in-house pack is ONE purchase from its supplier, not one per constituent', () => {
  // The four Augmento entries on 2026090902 are four cartridges in one box.
  const info = orderSupplierCostFromDetail(mkOrder());
  assert.deepEqual(Object.keys(info.costBySupplier), ['Augmento']);
  assert.ok(near(info.costBySupplier.Augmento, 76.00));
  assert.equal(info.missingSupplierCount, 0);
  assert.equal(info.mixedSupplierLineCount, 0);
});

test('costBySupplier is a SIBLING field — the ERR-219 totals are untouched', () => {
  const info = orderSupplierCostFromDetail(mkOrder());
  assert.ok(near(info.costExGst, 76.00));
  assert.ok(near(info.costInclGst, 76.00 * (1 + GST_RATE)));
});

test('a line naming no supplier is COUNTED, never quietly attributed', () => {
  const info = orderSupplierCostFromDetail(mkOrder({ items: [line('DSNZ', 10), line(null, 20)] }));
  assert.equal(info.missingSupplierCount, 1);
  assert.deepEqual(Object.keys(info.costBySupplier), ['DSNZ']);
  assert.ok(near(info.costExGst, 30), 'the ORDER total still counts every costed line');
});

test('a line naming two suppliers is REFUSED, not split down the middle', () => {
  const mixed = { sku: 'MIX', qty: 1, sell_price: 50, supplier_cost_snapshot: 30,
    suppliers: [{ name: 'DSNZ' }, { name: 'Augmento' }] };
  const info = orderSupplierCostFromDetail(mkOrder({ items: [mixed] }));
  assert.equal(info.mixedSupplierLineCount, 1);
  assert.deepEqual(Array.from(Object.keys(info.costBySupplier)), [],
    'an even split would put a fabricated number under a freight decision');
});

// ─── 4. The freight decision ────────────────────────────────────────────────

const decide = (order) => supplierFreightForOrder(order, orderSupplierCostFromDetail(order));

test('a customer who PAID for delivery does not also get charged for it', () => {
  const r = decide(mkOrder({ shipping_fee: 7 }));
  assert.equal(r.applies, false);
  assert.equal(r.unknown, false, 'a pass-through is a decided NO, not a refusal');
});

test('Augmento under $100 ex-GST on a free-shipping order owes freight', () => {
  const r = decide(mkOrder());
  assert.equal(r.applies, true);
  assert.deepEqual(Array.from(r.suppliers), ['Augmento']);
  assert.equal(r.amount_incl_gst, 7);
  assert.equal(r.estimated, true, 'the weight is unknown, so this is the lightest band');
  assert.match(r.consignments[0].reason, /under the \$100 free-freight threshold/);
});

test('$100 exactly is FREE — the threshold is "under", and the boundary is the bug', () => {
  const at = decide(mkOrder({ items: [line('Augmento', 100)] }));
  assert.equal(at.applies, false);
  const under = decide(mkOrder({ items: [line('Augmento', 99.99)] }));
  assert.equal(under.applies, true);
  // The live order this boundary decides: 2026090304, Augmento $99.00 ex-GST —
  // which is $113.85 INCL-GST and would be free on the wrong basis.
  const live = decide(mkOrder({ items: [line('Augmento', 99.00)] }));
  assert.equal(live.applies, true, 'the threshold is ex-GST; 99.00 ex is under it');
});

test('Augmento over $100 owes nothing', () => {
  const r = decide(mkOrder({ items: [line('Augmento', 110.00)] }));
  assert.equal(r.applies, false);
  assert.equal(r.unknown, false);
});

test('DSNZ owes freight at ANY order value — no threshold applies to it', () => {
  const r = decide(mkOrder({ items: [line('DSNZ', 500)] }));
  assert.equal(r.applies, true);
  assert.match(r.consignments[0].reason, /charges freight on every order/);
});

test('what the backend already charged is NOT charged again', () => {
  // Every one of the 23 live orders carrying shipping_absorbed contains a DSNZ
  // line. Charging DSNZ again here would double a payment made once.
  const absorbed = { applies: true, amount_incl_gst: 12, gst_component: 1.57, zone: 'south-island' };
  const r = decide(mkOrder({ items: [line('DSNZ', 50)], shipping_absorbed: absorbed }));
  assert.equal(r.applies, false, 'the absorbed-courier row already deducted this consignment');
});

test('a two-supplier order charges only the consignment the backend missed', () => {
  // Live order 2026090102: DSNZ $70.51 + Augmento $27.07, backend absorbed $7.
  const absorbed = { applies: true, amount_incl_gst: 7, gst_component: 0.91, zone: 'north-island' };
  const r = decide(mkOrder({
    delivery_zone: 'north-island',
    items: [line('DSNZ', 70.51), line('Augmento', 27.07)],
    shipping_absorbed: absorbed,
  }));
  assert.equal(r.applies, true);
  assert.deepEqual(Array.from(r.suppliers), ['Augmento'], 'DSNZ is the one the backend already paid for');
  assert.equal(r.amount_incl_gst, 7);
});

test('an unresolvable supplier REFUSES the order, it does not price the part it understands', () => {
  const r = decide(mkOrder({ items: [line('DSNZ', 10), line(null, 20)] }));
  assert.equal(r.applies, false);
  assert.equal(r.unknown, true);
  assert.match(r.unknownReason, /name no supplier/);
});

test('a supplier with no recorded terms refuses by name', () => {
  const r = decide(mkOrder({ items: [line('Okin', 10)] }));
  assert.equal(r.unknown, true);
  assert.match(r.unknownReason, /no freight terms recorded/);
});

test('a zone with no courier rate refuses rather than inventing one', () => {
  const r = decide(mkOrder({ delivery_zone: 'chatham-islands' }));
  assert.equal(r.unknown, true);
  assert.match(r.unknownReason, /chatham-islands/);
  const none = decide(mkOrder({ delivery_zone: null }));
  assert.equal(none.unknown, true);
  assert.match(none.unknownReason, /no delivery zone/);
});

// ─── 5. The money ───────────────────────────────────────────────────────────

const FREIGHT = { applies: true, amount_incl_gst: 7, estimated: true, suppliers: ['Augmento'] };

test('absence costs exactly nothing — every caller that passes no freight is unchanged', () => {
  const withOut = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115 });
  for (const opts of [{}, { supplierFreight: null }, { supplierFreight: { applies: false } },
    { supplierFreight: { applies: true, amount_incl_gst: 0 } },
    { supplierFreight: { applies: true, amount_incl_gst: null } }]) {
    const b = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115, ...opts });
    assert.equal(b.supplierFreightApplies, false, JSON.stringify(opts));
    assert.equal(b.supplierFreightInclGst, 0);
    assert.ok(near(b.netProfit, withOut.netProfit), 'take-home must be byte-identical');
  }
});

test('freight is deducted EX-GST and its GST is reclaimed at the IRD line', () => {
  const b = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115, supplierFreight: FREIGHT });
  const gst = 7 * (GST_RATE / (1 + GST_RATE));            // GST inside a GST-incl amount
  assert.ok(near(b.supplierFreightInclGst, 7));
  assert.ok(near(b.supplierFreightGst, gst));
  assert.ok(near(b.supplierFreightExGst, 7 - gst));
  const bare = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115 });
  assert.ok(near(b.netProfit, bare.netProfit - (7 - gst)), 'take-home drops by the EX-GST cost');
  assert.ok(near(b.gstRemittedToIrd, bare.gstRemittedToIrd - gst), 'the GST is an input credit');
});

test('the cash waterfall still foots to the cent with freight in it', () => {
  const b = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115, supplierFreight: FREIGHT });
  const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.absorbedShippingInclGst - b.supplierFreightInclGst - b.gstRemittedToIrd;
  assert.ok(near(foot, b.netProfit), `waterfall ${foot} vs take-home ${b.netProfit}`);
});

test('computeOrderProfit and the waterfall agree, as they must', () => {
  const opts = { customerPaidInclGst: 115, supplierFreight: FREIGHT };
  assert.ok(near(computeOrderProfit(100, 40, opts), computeProfitBreakdown(100, 40, opts).netProfit));
});

test('per-line profits still sum to take-home (ERR-118 footing invariant)', () => {
  const opts = { customerPaidInclGst: 115, supplierFreight: FREIGHT };
  const { lineProfits, totalProfit } = computeLineProfits(
    [{ revenueExGst: 60, costExGst: 25 }, { revenueExGst: 40, costExGst: 15 }], opts);
  assert.ok(near(lineProfits.reduce((s, x) => s + x, 0), totalProfit));
  assert.ok(near(totalProfit, computeProfitBreakdown(100, 40, opts).netProfit));
});

test('freight rides alongside an absorbed courier without displacing it', () => {
  const absorbed = { applies: true, amount_incl_gst: 12, gst_component: 1.57 };
  const b = computeProfitBreakdown(100, 40, {
    customerPaidInclGst: 115, absorbedShipping: absorbed, supplierFreight: FREIGHT });
  assert.ok(near(b.absorbedShippingInclGst, 12), 'the courier row is untouched');
  assert.ok(near(b.supplierFreightInclGst, 7));
  const foot = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
    - b.absorbedShippingInclGst - b.supplierFreightInclGst - b.gstRemittedToIrd;
  assert.ok(near(foot, b.netProfit));
});

test('an estimate is flagged, and a supplied figure is not', () => {
  const est = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115, supplierFreight: FREIGHT });
  assert.equal(est.supplierFreightEstimated, true);
  assert.deepEqual(Array.from(est.supplierFreightSuppliers), ['Augmento']);
  const measured = computeProfitBreakdown(100, 40, { customerPaidInclGst: 115,
    supplierFreight: { ...FREIGHT, estimated: false } });
  assert.equal(measured.supplierFreightEstimated, false);
});

// ─── 6. The worked example — the order that started this ────────────────────

test('2026090902: take-home falls $37.09 → $31.00 and margin 31.7% → 26.5%', () => {
  const info = orderProfitFromDetail(mkOrder(), { customerPaidInclGst: 134.49 });
  assert.equal(info.state, PROFIT_STATE.OK);
  assert.equal(info.supplierFreightApplies, true);
  assert.equal(info.supplierFreightEstimated, true);
  assert.deepEqual(Array.from(info.supplierFreightSuppliers), ['Augmento']);
  assert.ok(near(info.breakdown.supplierFreightInclGst, 7.00));
  assert.ok(near(info.netProfit, 31.00, 0.01), `take-home ${info.netProfit}`);
  assert.ok(near(info.netMarginPct, 26.5, 0.05), `margin ${info.netMarginPct}`);
  assert.ok(near(info.breakdown.gstRemittedToIrd, 4.65, 0.01));
  // The goods cost row is untouched — freight is its own outflow, not a
  // markup on what we paid for the cartridges.
  assert.ok(near(info.breakdown.supplierCostInclGst, 87.40, 0.01));
});

test('the over-$100 control: 2026090701 keeps every cent of its profit', () => {
  const before = orderProfitFromDetail(mkOrder({ items: [line('Augmento', 110, 1, 161.73)] }));
  assert.equal(before.supplierFreightApplies, false);
  const bare = computeProfitBreakdown(before.totalRevenueExGst, before.totalCostExGst,
    { customerPaidInclGst: before.breakdown.customerPaidInclGst });
  assert.ok(near(before.netProfit, bare.netProfit), 'no freight, no change');
});

// ─── 7. Unpriced freight is a CEILING, not a blank (ERR-158) ────────────────

test('an order we cannot price freight for KEEPS its take-home and says "at most"', () => {
  const info = orderProfitFromDetail(mkOrder({ items: [line('DSNZ', 10), line(null, 20)] }));
  assert.equal(info.state, PROFIT_STATE.OK, 'a bounded unknown must not blank a stateable figure');
  assert.notEqual(info.netProfit, null);
  assert.equal(info.supplierFreightUnknown, true);
  assert.match(info.supplierFreightUnknownReason, /name no supplier/);
  assert.equal(info.supplierFreightApplies, false, 'nothing was deducted — that is why it is a ceiling');
});

test('a missing supplier COST still refuses outright — the two are not the same fact', () => {
  const info = orderProfitFromDetail(mkOrder({
    items: [{ sku: 'X', qty: 1, sell_price: 50, supplier_cost_snapshot: null, suppliers: [{ name: 'DSNZ' }] }],
  }));
  assert.equal(info.state, PROFIT_STATE.UNKNOWN, 'an UNBOUNDED unknown has no honest number');
  assert.equal(info.netProfit, null);
});

// ─── 8. The render wiring the math cannot see ───────────────────────────────

test('the freight row sits after the courier row and before the IRD line', () => {
  // Scope to the MODAL. 'Supplier freight' also appears far earlier, in the
  // Orders-list cell tooltip — an unscoped indexOf compares two different rows
  // and reports an ordering that was never in question.
  const iCourier = ordersSrc.indexOf('Courier absorbed');
  const iFreight = ordersSrc.indexOf('Supplier freight', iCourier);
  const iIrd = ordersSrc.indexOf('GST remitted to IRD', iCourier);
  assert.ok(iCourier > -1 && iFreight > -1 && iIrd > -1, 'all three rows must exist');
  assert.ok(iCourier < iFreight && iFreight < iIrd,
    `order must be Courier(${iCourier}) < Freight(${iFreight}) < IRD(${iIrd}) — its GST nets at the IRD line`);
});

test('the freight row is guarded on it actually applying', () => {
  assert.ok(/if\s*\(b\.supplierFreightApplies\)/.test(ordersSrc),
    'a $0.00 freight row would imply a payment that was rounded away');
});

test('the word "estimated" ships with the number, on every surface that prints it', () => {
  assert.ok(/estimated/.test(ordersSrc), 'the modal must print the word');
  assert.ok(/supplierFreightEstimated/.test(ordersSrc), 'and it must come from the flag, not a guess');
});

test('an unpriced freight charge marks the take-home as a ceiling in the modal AND the list', () => {
  assert.ok(/Take-home profit<\/strong>\} \$\{muted\('\(at most\)'\)\}|\(at most\)/.test(ordersSrc),
    'the modal take-home must say "at most" when freight is unpriced');
  assert.ok(/supplierFreightUnknown\s*\n?\s*\?\s*`<strong>Take-home profit<\/strong>/.test(ordersSrc)
    || /profitInfo\.supplierFreightUnknown/.test(ordersSrc),
    'the qualifier must be driven by the flag');
  assert.ok(/ceilingMark/.test(ordersSrc),
    'the Orders list cell needs a VISIBLE mark — nobody hovers a column they believe');
  assert.ok(/owed, not priced/.test(ordersSrc),
    'the modal must show a row for freight it knows is owed but cannot price');
});

/**
 * Execute the SHIPPED template text rather than grepping it.
 *
 * Every other assertion in this section is a source grep, and a source grep
 * cannot tell you that the row renders — only that the characters are present.
 * This lifts the real `if (b.supplierFreightApplies) { … }` block out of
 * pages/orders.js and runs it against a real breakdown with the helpers it
 * actually closes over. If someone reorders the template literal into
 * nonsense, or drops the amount, the greps stay green and this goes red.
 */
function renderFreightRow(breakdown) {
  const start = ordersSrc.indexOf('if (b.supplierFreightApplies) {');
  assert.ok(start > -1, 'the freight row block must exist to be executed');
  let depth = 0; let end = -1;
  for (let i = ordersSrc.indexOf('{', start); i < ordersSrc.length; i++) {
    if (ordersSrc[i] === '{') depth++;
    else if (ordersSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'the freight row block must be brace-balanced');
  const block = ordersSrc.slice(start, end);
  const fn = new Function('b', 'formatPrice', 'esc', 'muted', 'pbRow', 'neg', `
    let profitBreakdownInner = '';
    ${block}
    return profitBreakdownInner;
  `);
  return fn(
    breakdown,
    (v) => `$${Number(v).toFixed(2)}`,
    (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c])),
    (t) => `<span class="admin-text-muted">${t}</span>`,
    (label, value) => `<div class="om-meta-row"><span>${label}</span><span class="mono">${value}</span></div>`,
    (v) => `\u2212$${Math.abs(v).toFixed(2)}`,
  );
}

test('the shipped freight row RENDERS the supplier, the amount and the word estimated', () => {
  const b = computeProfitBreakdown(116.95, 76.00, {
    customerPaidInclGst: 134.49,
    supplierFreight: { applies: true, amount_incl_gst: 7, estimated: true, suppliers: ['Augmento'] },
  });
  const html = renderFreightRow(b);
  assert.match(html, /Supplier freight/, 'the row must be labelled');
  assert.match(html, /Augmento/, 'the supplier must be named — "a supplier" is not an answer');
  assert.match(html, /\u2212\$7\.00/, 'the amount must render as a negative outflow');
  assert.match(html, /estimated/, 'an estimate must say so ON THE ROW, not only in the tooltip');
  assert.match(html, /title="[^"]*under \$100 ex-GST/, 'the tooltip must state the rule that fired');
});

test('a backend-supplied amount renders WITHOUT the word estimated', () => {
  // The signal that the ERR-241 brief has landed. If this row still says
  // "estimated" once the backend sends a figure, the flag is being ignored.
  const b = computeProfitBreakdown(116.95, 76.00, {
    customerPaidInclGst: 134.49,
    supplierFreight: { applies: true, amount_incl_gst: 12, estimated: false, suppliers: ['Augmento'] },
  });
  const html = renderFreightRow(b);
  assert.match(html, /\u2212\$12\.00/);
  assert.ok(!/estimated/.test(html), 'a measured figure must not be labelled an estimate');
});

test('the row renders NOTHING when no freight applies (negative control)', () => {
  // Proves the two tests above are exercising the guard, not the template.
  const b = computeProfitBreakdown(116.95, 76.00, { customerPaidInclGst: 134.49 });
  assert.equal(renderFreightRow(b), '', 'a $0.00 freight row would imply a payment we never made');
});

test('the IRD tooltip names supplier freight as a credit source only when it applies', () => {
  assert.ok(/b\.supplierFreightApplies\s*\?\s*'supplier freight'\s*:\s*null/.test(ordersSrc));
});

test('the whole thing stays owner-only', () => {
  // Freight is derived from supplier costs, the figure ERR-170 was logged for leaking.
  assert.ok(/const\s+showCost\s*=\s*AdminAuth\.isOwner\(\)/.test(ordersSrc));
  assert.ok(/if\s*\(showCost\)\s*orderProfitBreakdown\s*=\s*profitInfo\.breakdown/.test(ordersSrc));
});

test('pages/orders.js still does no money maths of its own', () => {
  assert.ok(!/computeProfitBreakdown\(/.test(ordersSrc),
    'the page renders what the engine returns — it must never compute');
  assert.ok(!/supplierFreightForOrder\(/.test(ordersSrc),
    'the freight decision belongs to utils/supplier-freight.js, called via order-profit.js');
});
