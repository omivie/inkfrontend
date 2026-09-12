/**
 * Absorbed courier cost in the Orders profit breakdown (FE render pins)
 * ====================================================================
 *
 * On a free-shipping order (subtotal ≥ $100) the customer pays $0 shipping but we
 * still pay the courier. The backend now exposes that absorbed cost as the
 * owner-only order.shipping_absorbed field. The order modal must:
 *
 *   1. THREAD IT THROUGH THE PROFIT MATH. `feeOpts` — the single opts object handed
 *      to BOTH computeLineProfits and computeProfitBreakdown — must carry
 *      `absorbedShipping: o.shipping_absorbed`, so the per-line Profit column/foot
 *      and the waterfall take-home drop together and stay equal (margin-consistency
 *      gate, ERR-113).
 *   2. SHOW A COURIER ROW, guarded on it actually applying, positioned after the
 *      Stripe/card row and before the GST-remitted-to-IRD row (its GST nets there).
 *   3. STAY OWNER-ONLY. The whole breakdown is gated on showCost = AdminAuth.isOwner(),
 *      matching the backend's owner-only gating of the field.
 *
 * These are source-level pins (regex over orders.js) mirroring
 * admin-invoice-orders.test.js — they guard the wiring the math tests can't see.
 *
 * Run with: node --test tests/order-profit-absorbed-shipping-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const ordersSrc = fs.readFileSync(path.join(ADMIN, 'pages', 'orders.js'), 'utf8');
// The profit derivation moved out of pages/orders.js into utils/order-profit.js
// (Jul 2026) when the Orders list gained its Profit column — the modal and the
// column must derive the number from ONE function or they will drift (ERR-113).
// The contracts below are unchanged; only their address is.
const profitSrc = fs.readFileSync(path.join(ADMIN, 'utils', 'order-profit.js'), 'utf8');

// ─── 1. feeOpts threads absorbedShipping to BOTH profit calls ────────────────

test('absorbedShipping is read from the order\'s shipping_absorbed', () => {
  assert.ok(/const\s+absorbedShipping\s*=\s*order\.shipping_absorbed\b/.test(profitSrc),
    'must read order.shipping_absorbed into absorbedShipping');
});

test('feeOpts carries absorbedShipping on BOTH the invoice and website branches', () => {
  // isInvoice ? { ...invoice..., absorbedShipping, ... } : { ..., absorbedShipping }
  assert.ok(/isInvoice\s*\n?\s*\?[\s\S]{0,160}?absorbedShipping[\s\S]{0,160}?:\s*\{[\s\S]{0,120}?absorbedShipping/.test(profitSrc),
    'both feeOpts branches must include absorbedShipping');
});

test('computeLineProfits and computeProfitBreakdown both receive feeOpts (not a bespoke opts)', () => {
  // Pinned by admin-invoice-orders.test.js too; re-asserted here so a refactor that
  // splits the opts object trips at least one of these files.
  assert.ok(/computeLineProfits\(lines,\s*feeOpts\)/.test(profitSrc),
    'computeLineProfits must receive feeOpts');
  assert.ok(/computeProfitBreakdown\(totalRevenueExGst,\s*totalCostExGst,\s*feeOpts\)/.test(profitSrc),
    'computeProfitBreakdown must receive feeOpts');
});

// ─── 2. The Courier absorbed row — guarded, and correctly positioned ─────────

test('🚨 the "Courier absorbed" ROW IS GONE, and nothing deducts it (ERR-255)', () => {
  // THIS TEST WAS INVERTED ON 2026-09-12, DELIBERATELY. It used to require the
  // row. The row was double-charging: `shipping_absorbed` is the outbound parcel
  // RATE and `supplier_freight` prices the same parcel off the same ladder.
  // Measured over 115 live order-samples — no order where absorbed applies and
  // freight does not; amounts identical on 39 of 41, the exceptions being one
  // two-supplier order where absorbed is ONE rate and freight is TWO.
  //
  // With no deduction behind it a row here cannot foot, so it goes. The FACT it
  // carried moved into the freight row's tooltip, which is pinned below.
  assert.ok(!/if\s*\(\s*b\.absorbedShippingApplies\s*\)/.test(ordersSrc),
    'there must be no row guarded on b.absorbedShippingApplies any more');
  assert.ok(!/neg\(b\.absorbedShippingInclGst\)/.test(ordersSrc),
    'the absorbed courier must not be rendered as an outflow');
  assert.ok(!/Courier absorbed/.test(ordersSrc),
    'the "Courier absorbed" label must be gone from the waterfall');
});

test('the free-shipping FACT survives in the freight tooltip, not as a row', () => {
  // Present→absent is not an upgrade (ERR-158). Deleting the deduction must not
  // delete the information: on a free-shipping order the owner still needs to
  // know the customer paid $0 and that it is counted once.
  assert.ok(/absorbedShippingSupersededByFreight/.test(ordersSrc),
    'the freight tooltip must read the superseded flag');
  assert.ok(/counted here once, not twice/.test(ordersSrc),
    'the tooltip must say the parcel is charged once');
  const engineSrc = fs.readFileSync(path.join(ADMIN, 'utils', 'profitability.js'), 'utf8');
  assert.ok(/absorbedShippingSupersededByFreight/.test(engineSrc),
    'the engine must publish the flag, not leave the reason in a comment');
});

test('the supplier-freight row sits AFTER "Paid to Stripe" and BEFORE "GST remitted to IRD"', () => {
  // Anchor on the modal ROW, not on the bare words: "Supplier freight" also
  // appears in the Orders-LIST tooltip, which sits earlier in the file, so a
  // plain indexOf would compare the wrong two positions and pass or fail for a
  // reason that has nothing to do with row order.
  const iStripe = ordersSrc.indexOf('Paid to Stripe ');
  const iFreight = ordersSrc.indexOf('>Supplier freight ');
  const iIrd = ordersSrc.indexOf('GST remitted to IRD ');
  assert.ok(iStripe > -1 && iFreight > -1 && iIrd > -1,
    `all three rows must exist — Stripe ${iStripe}, Freight ${iFreight}, IRD ${iIrd}`);
  assert.ok(iStripe < iFreight && iFreight < iIrd,
    `order must be Stripe(${iStripe}) < Freight(${iFreight}) < IRD(${iIrd})`);
});

test('the IRD-credit tooltip names the courier as a credit source when absorbed applies', () => {
  // Was a two-way ternary until ERR-241 added a fourth reclaimable outflow
  // (supplier freight). A fixed pair of strings cannot express four states, so
  // the pin follows the code to a filtered list — the CONTRACT is unchanged:
  // a credit source is named if and only if it actually applied.
  // 'courier' is NO LONGER a credit source: its cost is no longer deducted, so
  // its GST is no longer reclaimed here. Naming it would promise a credit the
  // arithmetic does not take (ERR-255).
  assert.ok(!/\?\s*'courier'\s*:\s*null/.test(ordersSrc),
    'the IRD tooltip must not name the courier as a credit source any more');
  assert.ok(/b\.supplierFreightApplies\s*\?\s*'supplier freight'\s*:\s*null/.test(ordersSrc),
    'IRD tooltip must name supplier freight only when it applies');
  assert.ok(/\.filter\(Boolean\)/.test(ordersSrc),
    'the credit-source list must drop the ones that did not apply, never print "null"');
});

test('supplierFreight rides on BOTH feeOpts branches, like absorbedShipping', () => {
  // The ERR-241 mirror of the absorbedShipping pin above. A cost threaded onto
  // only the website branch is a cost that silently vanishes on every invoiced
  // sale — and invoiced sales are the ones with no card fee to mask the gap.
  assert.ok(/isInvoice\s*\n?\s*\?[\s\S]{0,200}?supplierFreight[\s\S]{0,200}?:\s*\{[\s\S]{0,160}?supplierFreight/.test(profitSrc),
    'both feeOpts branches must include supplierFreight');
  // Takes the ORDER and nothing else since ERR-255 — the per-supplier cost
  // roll-up was an input to a threshold WE applied, and the backend applies it.
  assert.ok(/const\s+supplierFreight\s*=\s*supplierFreightForOrder\(order\)/.test(profitSrc),
    'supplierFreight must come from the freight module, not be assembled inline');
});

// ─── 3. Owner-only gating is preserved ───────────────────────────────────────

test('the profit breakdown (courier row included) is gated on owner-only showCost', () => {
  assert.ok(/const\s+showCost\s*=\s*AdminAuth\.isOwner\(\)/.test(ordersSrc),
    'showCost must be AdminAuth.isOwner()');
  // orderProfitBreakdown — the object the courier row reads from — is only assigned under showCost.
  assert.ok(/if\s*\(showCost\)\s*orderProfitBreakdown\s*=\s*profitInfo\.breakdown/.test(ordersSrc),
    'orderProfitBreakdown must be populated only when showCost');
});

test('the Orders list Profit column is gated on the same owner check', () => {
  // Since ERR-203 the gate is a named set — Profit, Supplier and Supplier cost
  // are all owner-only and all fed by the one fan-out. The invariant is the
  // same one: a non-owner sees no Profit column and triggers no cost fetches.
  assert.ok(/AdminAuth\.isOwner\(\)\s*\?\s*COLUMNS\s*:\s*COLUMNS\.filter\(c => !OWNER_ONLY_COLUMNS\.has\(c\.key\)\)/.test(ordersSrc),
    'the DataTable must filter its columns through the owner-only set');
  assert.ok(/const OWNER_ONLY_COLUMNS = new Set\(\[[^\]]*'_profit'[^\]]*\]\)/.test(ordersSrc),
    'a non-owner must see no Profit column — and therefore trigger no cost fan-out');
});

// ─── titleCaseZone helper ────────────────────────────────────────────────────

test('titleCaseZone turns a zone slug into a display label', () => {
  assert.ok(/function titleCaseZone\(/.test(ordersSrc), 'titleCaseZone helper must exist');
});
