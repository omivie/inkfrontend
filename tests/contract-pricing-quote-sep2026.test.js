/**
 * Contract pricing in the operator editors — invoices + quick orders
 * ==================================================================
 * ERR-221 · backend migration 165 · Sep 2026
 *
 * Both editors quote as the operator types. Since migration 165 the quote also
 * prices a business account's own negotiated rates — but only if it is told who
 * the customer is.
 *
 * ── THE FOUR RULES, IN DESCENDING ORDER OF WHAT BREAKING THEM COSTS ────────
 *
 *   1. A CONTRACT PRICE IS NOT A VOLUME DISCOUNT, AND MUST NEVER BE FILED AS
 *      ONE. `volumePercent` / `volumeSaving` / `volumeQuantity` are PERSISTED
 *      into the saved invoice or quick order, cross the QO → invoice bridge, and
 *      drive `lineDocNote()` — which prints on the CUSTOMER'S OWN INVOICE.
 *      Stamping them from a contract price would put a false claim in a stored
 *      document ("Bulk price — 22% off at 1+", naming a rung that does not
 *      exist) and disclose this account's negotiated rate on a page they may
 *      forward to anyone.
 *
 *   2. ENROLMENT IS PINNED HERE, NOT PROMISED IN A COMMENT. This feature class
 *      has silently vanished four times — ERR-149, ERR-150, ERR-158, ERR-160 —
 *      every time because a surface stopped calling the shared path and nothing
 *      said so. `quoteRequestBody` now takes identity as a SECOND ARGUMENT, and
 *      a forgotten second argument reverts that editor to list pricing with no
 *      error, no toast and no log. So the argument is asserted at every call
 *      site, by walking the source.
 *
 *   3. EXACTLY ONE IDENTIFIER, AND NEITHER IS ALSO VALID. "Send neither and
 *      nothing changes" is a guarantee every existing quote depends on.
 *
 *   4. THE INVOICE DRAFT NEVER GAINS A `customer_id`. buildPayload(),
 *      documentDrift() and setStatusViaFullUpdate() all walk the draft's keys.
 *      A key that is never on the draft cannot be persisted by accident.
 *
 * Live-measured 2026-09-06 (`npm run probe:contract-pricing -- --write`, 85/85):
 * the invoice quote's qty-1 `unit_excl_gst` and the quick-order quote's
 * pre-resolved `unit_price_excl_gst` agreed to the cent on a contract-priced
 * line ($5.90 each). That measurement is what licenses keeping BOTH editors on
 * the one shared endpoint; if it ever stops holding, Quick Order must move to
 * `/api/admin/quick-orders/quote` and this file is where you will find out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const QUOTE_SRC = read('inkcartridges/js/admin/utils/invoice-quote.js');
const INV_SRC = read('inkcartridges/js/admin/pages/invoices.js');
const QO_SRC = read('inkcartridges/js/admin/pages/quick-order.js');
const BRIDGE_SRC = read('inkcartridges/js/admin/utils/quick-order-bridge.js');
const QUOTE = codeOnly(QUOTE_SRC);
const INV = codeOnly(INV_SRC);
const QO = codeOnly(QO_SRC);

let Q;
test.before(async () => {
  Q = await import(path.join(SITE, 'js/admin/utils/invoice-quote.js'));
});

const draft = () => ({ lines: [{ code: 'CLC73BK', qty: 8, unitCost: 0, priceSource: 'auto' }] });

/** A live-shaped quote payload with a contract price and no rung. */
const contractQuote = (over = {}) => ({
  data: {
    lines: [{
      position: 0, input_code: 'C02BK', product_code: 'C02BK', resolved: true,
      name: 'Compatible C02 Black', source: 'compatible', is_active: true, quantity: 1,
      retail_incl_gst: 11.49, unit_excl_gst: 5.90,
      contract: { unit_incl_gst: 6.78, unit_excl_gst: 5.90, per_unit_saving_excl_gst: 4.09, line_saving_excl_gst: 4.09 },
      volume: null,
    }],
    business_account_id: 'fc45d22d', business_account_name: 'Home',
    business_account_status: 'active',
    contract_prices_consulted: true, contract_priced_line_count: 1,
    ...over,
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Identity on the request
// ═══════════════════════════════════════════════════════════════════════════

test('send neither identifier and the body is unchanged', () => {
  const { body } = Q.quoteRequestBody(draft(), {});
  assert.equal('customer_id' in body, false);
  assert.equal('business_account_id' in body, false);
  // Measured live: with neither, the endpoint answers consulted:false and every
  // account field null — i.e. exactly what it did before this feature existed.
  assert.deepEqual(Object.keys(body), ['line_items']);
});

test('either identifier is sent, and never both', () => {
  assert.equal(Q.quoteRequestBody(draft(), { customerId: 'c1' }).body.customer_id, 'c1');
  assert.equal(Q.quoteRequestBody(draft(), { businessAccountId: 'a1' }).body.business_account_id, 'a1');

  const both = Q.quoteRequestBody(draft(), { customerId: 'c1', businessAccountId: 'a1' }).body;
  assert.equal(both.business_account_id, 'a1',
    'an explicit account link outranks a customer inferred from whoever the draft was filled from');
  assert.equal('customer_id' in both, false,
    'if the two disagree — invoicing a subsidiary against a parent account — the server picks one ' +
    'and we cannot tell which. Send one.');
});

test('a blank or whitespace identifier is not an identifier', () => {
  const body = Q.quoteRequestBody(draft(), { customerId: '   ', businessAccountId: '' }).body;
  assert.equal('customer_id' in body, false);
  assert.equal('business_account_id' in body, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ENROLMENT — the pin that stops this vanishing a fifth time
// ═══════════════════════════════════════════════════════════════════════════

test('every quoteRequestBody call site passes identity', () => {
  // ERR-149/150/158/160 all had the same shape: a surface stopped calling the
  // shared path, and the fail-soft rendered the absence as a legitimate "no
  // discount". A forgotten second argument here does exactly that.
  const callSites = [];
  for (const [file, src] of [['pages/invoices.js', INV], ['pages/quick-order.js', QO]]) {
    for (const m of src.matchAll(/quoteRequestBody\(([^)]*)\)/g)) {
      callSites.push({ file, args: m[1] });
    }
  }
  assert.ok(callSites.length >= 2, `expected a call site in each editor, found ${callSites.length}`);
  for (const { file, args } of callSites) {
    assert.match(args, /,/, `${file}: quoteRequestBody(${args}) — no identity argument, so this editor quotes at list`);
  }
});

test('the invoice editor only sends a CUSTOMERS-table id as customer_id', () => {
  // `_fillSource` can be {type:'contact'} (a contacts-table id) or
  // {type:'order'|'order details'} (a guest checkout proves no account at all).
  // A contacts id sent as customer_id does not merely fail: a bogus id answers
  // 200 with consulted:false — measured 2026-09-06 — so the quote falls back to
  // list pricing and looks perfectly healthy. And an id that collided would
  // price this invoice against somebody else's negotiated rates.
  const fn = INV.match(/function quoteIdentity\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /_fillSource\?\.type === 'customer'/);
  assert.match(fn, /_draft\.business_account_id/);
});

test('and the invoice DRAFT never gains a customer_id', () => {
  assert.doesNotMatch(INV, /_draft\.customer_id/,
    'the id lives in module-local _fillSource; on the draft it would be one refactor from buildPayload()');
  const payload = INV.match(/function buildPayload\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(payload, /customer_id/);
});

test('the three business_account_id mutation points all re-quote', () => {
  // Linking an account changes WHO the quote is for. Without this, an operator
  // links a contract customer and every price stays at list, with nothing on
  // screen suggesting the link did anything at all.
  const linkHandler = INV.slice(INV.indexOf("act === 'link-business'"), INV.indexOf("act === 'clear-fill'"));
  assert.match(linkHandler, /scheduleQuote\(\)/, 'link-business must re-price');
  assert.equal((linkHandler.match(/scheduleQuote\(\)/g) || []).length, 2,
    'both link-business and unlink-business — going back to list pricing must be visible too');
  const fieldHandler = INV.slice(INV.indexOf("t.dataset.field === 'business_account_id'"));
  assert.match(fieldHandler.slice(0, 400), /scheduleQuote\(\)/, 'and the select’s own change handler');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE HOUSE RULE — a contract price fills no volume_* key
// ═══════════════════════════════════════════════════════════════════════════

test('a contract price autofills the line and stamps NO volume claim', () => {
  const quote = Q.normalizeQuote(contractQuote());
  const { lines, changed } = Q.applyQuoteToLines([{ code: 'C02BK', qty: 1, unitCost: 0, priceSource: 'auto' }], quote);
  assert.equal(changed, true);
  assert.equal(lines[0].unitCost, 5.90, 'unit_excl_gst IS the negotiated price when one applies');
  assert.equal(lines[0].volumePercent, null);
  assert.equal(lines[0].volumeSaving, null);
  assert.equal(lines[0].volumeQuantity, null);
});

test('and therefore prints NOTHING on the customer’s invoice', () => {
  const quote = Q.normalizeQuote(contractQuote());
  const { lines } = Q.applyQuoteToLines([{ code: 'C02BK', qty: 1, unitCost: 0, priceSource: 'auto' }], quote);
  assert.equal(Q.lineDocNote(lines[0]), '',
    'the volume ladder is public — printing "6% off at 7+" tells the customer what the website already ' +
    'does. A negotiated rate is not public, and an invoice can be forwarded to anyone.');
  // An operator's OWN manual discount still prints, in their words.
  assert.match(Q.lineDocNote({ discountSaving: 40, discountNote: 'goodwill' }), /\$40\.00 off — goodwill/);
});

test('the volume keys survive the QO → invoice bridge as nulls', () => {
  const quote = Q.normalizeQuote(contractQuote());
  const { lines } = Q.applyQuoteToLines([{ code: 'C02BK', qty: 1, unitPrice: 0, priceSource: 'auto' }], quote);
  assert.match(BRIDGE_SRC, /volumePercent/, 'the bridge does carry these keys across');
  for (const k of ['volumePercent', 'volumeSaving', 'volumeQuantity']) {
    assert.equal(lines[0][k], null, `${k} must cross the bridge as null, not as a fabricated claim`);
  }
});

test('a rung that beats the contract still stamps the volume keys — that IS a volume discount', () => {
  const withRung = contractQuote();
  withRung.data.lines[0].volume = {
    discount_percent: 10, effective_percent: 10, unit_incl_gst: 5.21, unit_excl_gst: 4.53,
    per_unit_saving_excl_gst: 1.37, line_saving_excl_gst: 10.96, floored: false,
  };
  withRung.data.lines[0].quantity = 8;
  const quote = Q.normalizeQuote(withRung);
  const { lines } = Q.applyQuoteToLines([{ code: 'C02BK', qty: 8, unitCost: 0, priceSource: 'auto' }], quote);
  assert.equal(lines[0].unitCost, 4.53, 'the deeper rung wins — the account pays min(contract, ladder, list)');
  assert.equal(lines[0].volumePercent, 10, 'and it genuinely IS a volume discount, so it is labelled as one');
});

test('the two apply actions are separate handlers, and neither can write the other’s claim', () => {
  for (const [name, src] of [['invoices', INV], ['quick-order', QO]]) {
    assert.match(src, /act === 'apply-contract'/, `${name}: a contract offer needs its own action`);
    const handler = src.slice(src.indexOf("act === 'apply-contract'"));
    const body = handler.slice(0, handler.indexOf('} else if'));
    assert.match(body, /offer\.kind !== OFFER_CONTRACT/, `${name}: and it refuses a volume offer`);
    assert.match(body, /volumePercent: null/, `${name}: applying a contract price claims nothing`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The account envelope — absence, zero, and the suspended case
// ═══════════════════════════════════════════════════════════════════════════

test('an absent line count is null, and zero is zero', () => {
  const absent = Q.normalizeQuote({ data: { lines: [], business_account_id: 'a', contract_prices_consulted: true } });
  assert.equal(absent.account.pricedLineCount, null,
    'an older backend that stops sending the key must not be reported as "0 lines priced"');
  const zero = Q.normalizeQuote(contractQuote({ contract_priced_line_count: 0 }));
  assert.equal(zero.account.pricedLineCount, 0);
});

test('consulted:true with zero priced lines is NORMAL, and does not read as a fault', () => {
  const n = Q.accountNotice(Q.normalizeQuote(contractQuote({ contract_priced_line_count: 0 })));
  assert.equal(n.kind, 'consulted');
  assert.equal(n.warn, false);
  assert.match(n.message, /none of these products/i);
});

test('a SUSPENDED account is LOUD — the highest-value string in the feature', () => {
  // Only an ACTIVE account prices a quote. Without this sentence the operator
  // sees list prices on a customer they know has negotiated rates and concludes
  // the feature is broken — or does not notice, and invoices them at list.
  const n = Q.accountNotice(Q.normalizeQuote(contractQuote({
    business_account_status: 'suspended', contract_priced_line_count: 0,
  })));
  assert.equal(n.warn, true);
  assert.match(n.message, /suspended/);
  assert.match(n.message, /NOT being applied/);
  assert.match(n.message, /priced at list/);
});

test('no account resolved says "no business account", never "list pricing confirmed"', () => {
  // Three situations answer consulted:false with every field null and cannot be
  // told apart: no identifier sent; an ordinary retail customer; a WRONG id (a
  // bogus UUID returns 200, measured 2026-09-06). Only one of those is a fact
  // about the customer.
  assert.equal(Q.accountNotice(Q.normalizeQuote({ data: { lines: [] } })), null);
  assert.doesNotMatch(QUOTE_SRC.slice(QUOTE_SRC.indexOf('export function accountNotice')), /confirmed/i);
});

test('both editors render the notice, and repaint it on every quote', () => {
  for (const [name, src] of [['invoices', INV], ['quick-order', QO]]) {
    assert.match(src, /accountNotice\(_quote\)/, `${name} reads the notice`);
    assert.match(src, /renderAccountNotice\(\)/, `${name} repaints it`);
    assert.match(src, /inv-account-notice--warn/, `${name} styles the loud variant differently`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The chip is derived from the quote, never stamped on the draft
// ═══════════════════════════════════════════════════════════════════════════

test('normalizeContract preserves null and never invents a percent', () => {
  assert.equal(Q.contractBadge({ contract: null }), null);
  assert.equal(Q.normalizeQuote({ data: { lines: [{ position: 0, contract: null }] } }).lines[0].contract, null,
    'null means "no negotiated price applies" and must not flatten into a zero-saving object');
  const badge = Q.contractBadge(Q.normalizeQuote(contractQuote()).lines[0]);
  assert.equal(badge.unitPrice, 5.90);
  assert.equal('percent' in badge, false,
    'the backend supplies no per-line contract percentage, and we do not derive one');
});

test('the chip reads the quote, so nothing new can reach a saved record', () => {
  for (const [name, src] of [['invoices', INV], ['quick-order', QO]]) {
    const fn = src.slice(src.indexOf('function lineQuoteNote'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    assert.match(body, /contractBadge\(ql\)/, `${name}: from the quote line`);
    assert.doesNotMatch(body, /\bl\.contract\b|line\.contract/, `${name}: never from a draft field`);
  }
});

test('when a rung ALSO applies, the chip says the volume saving is on top', () => {
  // §6.3: a rung's saving is then measured against the CONTRACT price, not
  // against list. Unlabelled, an operator reads the two chips as one total
  // discount off list.
  for (const src of [INV, QO]) {
    assert.match(src, /volume saving is on top of this/);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Nothing else moved
// ═══════════════════════════════════════════════════════════════════════════

test('the freight autofill is untouched by any of this', () => {
  // A new autofill path must not collide with _freightOwner (ERR-174: freight
  // billed twice, once as a line and once auto-adopted into the box).
  const applyFn = QUOTE.match(/export function applyQuoteToLines\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(applyFn, /freight|_freightOwner|_freightChoice/);
  const contractHandler = INV.slice(INV.indexOf("act === 'apply-contract'"));
  assert.doesNotMatch(contractHandler.slice(0, contractHandler.indexOf('} else if')), /freight/);
});

test('a hand-edited price is still never overwritten — it is OFFERED', () => {
  const quote = Q.normalizeQuote(contractQuote());
  const { lines, offers } = Q.applyQuoteToLines(
    [{ code: 'C02BK', qty: 1, unitCost: 9.00, priceSource: 'manual' }], quote);
  assert.equal(lines[0].unitCost, 9.00, 'the operator’s number stands');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].kind, 'contract');
  assert.equal(offers[0].badge.unitPrice, 5.90);
});

test('a credit line and a discounted line are never offered a contract price', () => {
  const quote = Q.normalizeQuote(contractQuote());
  const credit = Q.applyQuoteToLines([{ code: 'C02BK', qty: 1, unitCost: -99, priceSource: 'manual' }], quote);
  assert.equal(credit.offers.length, 0, 'a credit line offered a price turns a refund into a charge');
  const discounted = Q.applyQuoteToLines(
    [{ code: 'C02BK', qty: 1, unitCost: 9, priceSource: 'manual', discountSaving: 40 }], quote);
  assert.equal(discounted.offers.length, 0, 'and one click must not silently undo an operator’s discount');
});

test('no contract and no rung means no offer at all — not "apply the list price"', () => {
  const plain = Q.normalizeQuote({
    data: { lines: [{ position: 0, resolved: true, quantity: 1, unit_excl_gst: 5.03, contract: null, volume: null }] },
  });
  const { offers } = Q.applyQuoteToLines([{ code: 'X', qty: 1, unitCost: 15, priceSource: 'manual' }], plain);
  assert.equal(offers.length, 0, 'otherwise every untouched line in the editor sprouts a button');
});
