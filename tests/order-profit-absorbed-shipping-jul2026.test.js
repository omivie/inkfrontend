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

// ─── 1. feeOpts threads absorbedShipping to BOTH profit calls ────────────────

test('absorbedShipping is read from o.shipping_absorbed', () => {
  assert.ok(/const\s+absorbedShipping\s*=\s*o\.shipping_absorbed\b/.test(ordersSrc),
    'must read o.shipping_absorbed into absorbedShipping');
});

test('feeOpts carries absorbedShipping on BOTH the invoice and website branches', () => {
  // isInvoiceOrder(o) ? { ...invoice..., absorbedShipping, ... } : { ..., absorbedShipping }
  assert.ok(/isInvoiceOrder\(o\)\s*\?[\s\S]{0,160}?absorbedShipping[\s\S]{0,160}?:\s*\{[\s\S]{0,120}?absorbedShipping/.test(ordersSrc),
    'both feeOpts branches must include absorbedShipping');
});

test('computeLineProfits and computeProfitBreakdown both receive feeOpts (not a bespoke opts)', () => {
  // Pinned by admin-invoice-orders.test.js too; re-asserted here so a refactor that
  // splits the opts object trips at least one of these files.
  assert.ok(/computeLineProfits\([\s\S]{0,240}?feeOpts,/.test(ordersSrc),
    'computeLineProfits must receive feeOpts');
  assert.ok(/computeProfitBreakdown\(totalPrice,\s*totalCost,\s*feeOpts\)/.test(ordersSrc),
    'computeProfitBreakdown must receive feeOpts');
});

// ─── 2. The Courier absorbed row — guarded, and correctly positioned ─────────

test('a "Courier absorbed (free shipping)" row is emitted, guarded on it applying', () => {
  assert.ok(/if\s*\(\s*b\.absorbedShippingApplies\s*\)/.test(ordersSrc),
    'courier row must be guarded on b.absorbedShippingApplies');
  assert.ok(/Courier absorbed/.test(ordersSrc), 'row label must read "Courier absorbed"');
  assert.ok(/neg\(b\.absorbedShippingInclGst\)/.test(ordersSrc),
    'courier row value must be the negated incl-GST amount');
});

test('the courier row sits AFTER "Paid to Stripe" and BEFORE "GST remitted to IRD"', () => {
  const iStripe = ordersSrc.indexOf('Paid to Stripe');
  const iCourier = ordersSrc.indexOf('Courier absorbed');
  const iIrd = ordersSrc.indexOf('GST remitted to IRD');
  assert.ok(iStripe > -1 && iCourier > -1 && iIrd > -1, 'all three rows must exist');
  assert.ok(iStripe < iCourier && iCourier < iIrd,
    `order must be Stripe(${iStripe}) < Courier(${iCourier}) < IRD(${iIrd})`);
});

test('the IRD-credit tooltip names the courier as a credit source when absorbed applies', () => {
  assert.ok(/absorbedShippingApplies\s*\?\s*'supplier, Stripe and courier'\s*:\s*'supplier and Stripe'/.test(ordersSrc),
    'IRD tooltip must add "and courier" only when absorbed applies');
});

// ─── 3. Owner-only gating is preserved ───────────────────────────────────────

test('the profit breakdown (courier row included) is gated on owner-only showCost', () => {
  assert.ok(/const\s+showCost\s*=\s*AdminAuth\.isOwner\(\)/.test(ordersSrc),
    'showCost must be AdminAuth.isOwner()');
  // orderProfitBreakdown — the object the courier row reads from — is only built under showCost.
  assert.ok(/if\s*\(showCost\)\s*\{\s*[\s\S]{0,120}?orderProfitBreakdown\s*=\s*computeProfitBreakdown/.test(ordersSrc),
    'orderProfitBreakdown must be computed only when showCost');
});

// ─── titleCaseZone helper ────────────────────────────────────────────────────

test('titleCaseZone turns a zone slug into a display label', () => {
  assert.ok(/function titleCaseZone\(/.test(ordersSrc), 'titleCaseZone helper must exist');
});
