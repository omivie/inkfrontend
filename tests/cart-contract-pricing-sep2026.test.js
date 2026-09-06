/**
 * Contract pricing in the cart
 * ============================
 * ERR-221 · backend migration 165 · Sep 2026
 *
 * A business account can now have its own negotiated price for a product.
 * Mechanically that saving rides the EXISTING volume-discount line: it is inside
 * `volume_discount.discount_amount`, and therefore already inside
 * `summary.discount` and `summary.total`. No new total arithmetic.
 *
 * ── THE ONE TEST IN THIS FILE THAT MATTERS MOST ────────────────────────────
 *
 * `contract_pricing.discount_amount` is a SUBSET of
 * `volume_discount.discount_amount`. Adding them shows the shopper a saving the
 * total does not reflect — the ERR-169 shape, where the cart displayed a
 * discount it was not deducting. Two plausible figures arriving side by side in
 * the same payload is an invitation to add them, and this is the file that
 * refuses.
 *
 * ── AND THE ONE THAT IS EASIEST TO BREAK BY ACCIDENT ───────────────────────
 *
 * `_parseServerCart` is a WHITELIST: a per-line field it does not name is
 * discarded at the boundary and does not exist anywhere downstream. That is
 * exactly how the public volume ladder went missing in ERR-150 — the fields
 * were on the payload the whole time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CART_SRC = read('inkcartridges/js/cart.js');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CART = codeOnly(CART_SRC);

/** Lift one module-level function out of the shipping source and run it. */
function lift(name) {
  const start = CART_SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let i = CART_SRC.indexOf('{', start);
  let end = i;
  for (; i < CART_SRC.length; i++) {
    if (CART_SRC[i] === '{') depth++;
    else if (CART_SRC[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${CART_SRC.slice(start, end + 1)}\nglobalThis.__fn = ${name};`, ctx);
  return ctx.__fn;
}

let breakdown;
let label;
test.before(() => {
  breakdown = lift('computeDiscountBreakdown');
  label = lift('businessDiscountLabel');
});

/** The live volume_discount block, contract-priced. Shape measured 2026-09-06. */
const block = (over = {}) => ({
  company_name: 'Home', effective_percent: 2.6,
  discount_amount: 30, floored_line_count: 0,
  contract_discount_amount: 25, volume_discount_amount: 5,
  contract_line_count: 2, source: 'volume+contract',
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The subset rule
// ═══════════════════════════════════════════════════════════════════════════

test('contract and volume are the two HALVES of the b2b figure, never additions to it', () => {
  const r = breakdown({ discount: 30 }, 30, block());
  assert.equal(r.b2b, 30, 'NEVER 55 — the contract saving is already inside discount_amount');
  assert.equal(r.total, 30);
  assert.equal(r.contract, 25);
  assert.equal(r.volumeOnly, 5);
  assert.equal(r.contract + r.volumeOnly, r.b2b, 'the two halves reconstruct the whole');
  assert.equal(r.shortfall, 0, 'and the ERR-169 guard still foots');
});

test('a wholly-contract cart still deducts exactly what it shows', () => {
  const r = breakdown({ discount: 25 }, 25, block({
    discount_amount: 25, contract_discount_amount: 25, volume_discount_amount: 0, source: 'contract',
  }));
  assert.equal(r.b2b, 25);
  assert.equal(r.volumeOnly, 0);
  assert.equal(r.shortfall, 0);
});

test('the shortfall guard still catches a discount that is NOT inside the aggregate', () => {
  // ERR-169: `Math.max(0, aggregate − loyalty − b2b)` used to clamp this away.
  const r = breakdown({ discount: 10 }, 10, block({ discount_amount: 30 }));
  assert.ok(r.shortfall > 19.9, 'showing $30 of saving against a $10 deduction must be reported, not clamped');
});

test('an absent split is null — NOT "0 lines at your agreed price"', () => {
  const r = breakdown({ discount: 30 }, 30, { discount_amount: 30, company_name: 'Home' });
  assert.equal(r.contractLineCount, null,
    'a backend that does not report the split is not a backend reporting zero contract lines');
  assert.equal(r.contract, 0);
  assert.equal(r.b2b, 30, 'and the total is unaffected either way');
});

test('a genuine zero is zero', () => {
  const r = breakdown({ discount: 5 }, 5, block({
    discount_amount: 5, contract_discount_amount: 0, volume_discount_amount: 5,
    contract_line_count: 0, source: 'volume',
  }));
  assert.equal(r.contractLineCount, 0);
});

test('nothing about the pre-existing breakdown moved', () => {
  // The old three-way split must behave identically on a cart with no contract.
  const r = breakdown({ discount: 12, loyalty_discount_amount: 2 }, 12, { discount_amount: 8, company_name: 'Acme' });
  assert.equal(r.loyalty, 2);
  assert.equal(r.b2b, 8);
  assert.equal(r.other, 2);
  assert.equal(r.total, 12);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The label — one vocabulary, and the ERR-149 rule underneath it
// ═══════════════════════════════════════════════════════════════════════════

test('a negotiated saving is named for what it is', () => {
  assert.equal(label(block({ source: 'contract' })), 'Contract pricing — Home');
  assert.equal(label(block({ source: 'volume+contract' })), 'Volume & contract pricing — Home');
  assert.equal(label(block({ source: 'volume' })), 'Volume discount — Home',
    'and an ordinary volume cart is unchanged');
});

test('ERR-149 still holds: with no company name we never guess who the shopper is', () => {
  // This row is not gated on anything — every renderer prints it whenever the
  // server reports an amount. "Business account" beside a guest's three-for-two
  // was the original bug.
  assert.equal(label({ source: 'contract' }), 'Contract pricing');
  assert.equal(label({ source: 'volume+contract' }), 'Volume & contract pricing');
  assert.equal(label({}), 'Volume discount');
  assert.equal(label(null), 'Volume discount');
  for (const meta of [{ source: 'contract' }, { source: 'volume+contract' }, {}]) {
    assert.doesNotMatch(label(meta), /business account/i);
  }
});

test('the label never states a percentage', () => {
  // `effective_percent` is realised across the WHOLE cart, so beside a name it
  // would read as the customer's rate and be wrong on every mixed basket.
  assert.doesNotMatch(label(block()), /%|\d/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The boundary whitelist
// ═══════════════════════════════════════════════════════════════════════════

test('_parseServerCart carries contract_price and price_source through', () => {
  const parse = CART.slice(CART.indexOf('_parseServerCart'), CART.indexOf('parsed.key = self.cartItemKey'));
  assert.match(parse, /contract_price: item\.contract_price/,
    'a field this whitelist does not name does not exist downstream — ERR-150 verbatim');
  assert.match(parse, /price_source: item\.price_source/,
    'price_source is the only honest label: the account pays min(contract, ladder, list), ' +
    'so a deep enough rung beats the contract and the line is then a volume line');
  assert.match(parse, /quantity_breaks: Array\.isArray/, 'and the ladder fields are still there');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The note under the row
// ═══════════════════════════════════════════════════════════════════════════

test('the note is only rendered when the count is known and positive', () => {
  const rows = CART.slice(CART.indexOf('_renderDiscountRows'), CART.indexOf('cart-coupon-note'));
  assert.match(rows, /contractLineCount != null && contractLineCount > 0/,
    'null means "not reported"; saying "0 items at your agreed price" would be a claim we cannot support');
  assert.match(rows, /at your agreed price/);
  assert.match(rows, /of this/,
    'the contract figure is quoted as a PART of the row above — two figures side by side invite addition');
});

test('the floored-lines note still renders, and the two can coexist', () => {
  const rows = CART.slice(CART.indexOf('_renderDiscountRows'), CART.indexOf('cart-coupon-note'));
  assert.match(rows, /already at their best possible price/);
  assert.match(rows, /bits\.join\(' '\)/, 'both notes share one element rather than one overwriting the other');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Enrolment — every renderer of this row reads the one label helper
// ═══════════════════════════════════════════════════════════════════════════

test('every surface that prints this row uses businessDiscountLabel', () => {
  // Four files render it, and they have drifted before (ERR-110). A fifth
  // spelling of the label is how a contract customer sees "Volume discount" on
  // the checkout page and "Contract pricing" in the cart.
  for (const f of ['inkcartridges/js/cart.js', 'inkcartridges/js/checkout-page.js',
    'inkcartridges/js/payment-page.js', 'inkcartridges/js/order-totals.js']) {
    const src = read(f);
    assert.match(src, /businessDiscountLabel/, `${f} must not hand-roll this label`);
  }
});

test('a past ORDER inherits the contract label for free, once orders carry the source', () => {
  // order-totals.js renders saved orders, whose payload has a different shape
  // and a different lifetime from the cart's — it deliberately keeps its own
  // normalisation. But the LABEL is shared, so the moment an order's b2bMeta
  // carries source:'contract', a customer looking at a past order sees the same
  // sentence they saw at checkout rather than a different one.
  const src = read('inkcartridges/js/order-totals.js');
  assert.match(src, /window\.businessDiscountLabel\(o\.b2bMeta\)/);
  assert.match(src, /o\.b2bMeta/, 'and it passes the whole metadata object, not just an amount');
});
