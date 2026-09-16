/**
 * Admin product editor — "Stock on hand", and the three states of a quantity
 * ==========================================================================
 *
 * The Inventory tab of the product editor carried weight, sourcing identity and
 * two visibility toggles — and no quantity at all. An operator taking a delivery
 * or writing off a damaged unit had to go to the database. This pins the control
 * that closes that gap, and the two rules it has to keep.
 *
 * ── RULE 1: A MISSING INPUT IS NOT A ZERO ───────────────────────────────────
 *
 * `stock_quantity` arrives in three states and only one of them is a count:
 *
 *     absent from the record   →  we were never told
 *     present and null         →  the column is empty
 *     present and a number     →  a count, and 0 is a real one
 *
 * `!product.stock_quantity` cannot tell the first from the third. Collapsing
 * them would show "0 units" for a product we simply failed to fetch — and zero
 * is not cosmetic: at 0 the storefront swaps Add to cart for Contact us
 * (js/products.js:238) and prints "Contact Us For Stock Enquiries"
 * (js/api.js:4225). That is the ERR-063/068/073/075/076/149/150 family.
 *
 * ── RULE 2: THE SAVE BUTTON MUST NOT RESEND STOCK ───────────────────────────
 *
 * Measured against the live backend on 2026-09-16 (`npm run probe:product-stock`):
 *
 *     §3   a save that OMITS stock_quantity leaves it alone
 *     §4   PUT /api/admin/products/:id PERSISTS stock_quantity
 *     §4b  a five-key PUT left all 13 other columns untouched
 *     §5   the direct PostgREST leg is 403 for `authenticated`
 *
 * So Apply owns the write, and `stock_quantity` is deliberately ABSENT from the
 * main save payload. Because omitting it is safe, the only way left to clobber a
 * stock level is for the form to echo back a number it read when the modal
 * opened — undoing an adjustment made since, possibly by someone else. The
 * absence is load-bearing, which is exactly why it needs a test: a later reader
 * "completing" the payload would reintroduce the bug silently.
 *
 * ── RULE 3: NEVER DERIVE stock_status ───────────────────────────────────────
 *
 * `stock_status` is TRI-state — in_stock / out_of_stock / contact_us — and
 * `contact_us` cannot be recomputed from a number. Keeping it "in sync" with the
 * quantity would convert every deliberate contact-us product into an ordinary
 * one. `in_stock` is derived by the backend. Neither may appear in a payload.
 *
 * Run: node --test tests/admin-product-stock-adjust-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codeOnly = require('./helpers/strip-comments.js');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PRODUCTS_SRC = read('inkcartridges/js/admin/pages/products.js');
const STOCK_SRC = read('inkcartridges/js/admin/utils/stock-adjust.js');
const PRODUCTS_CODE = codeOnly(PRODUCTS_SRC);
const STOCK_CODE = codeOnly(STOCK_SRC);

const load = () => import(path.join(SITE, 'js/admin/utils/stock-adjust.js'));

// ─────────────────────────────────────────────────────────────────────────────
// 0. The stripper actually read these files
//
// Every `doesNotMatch` below is an assertion about text that ISN'T there, and
// those pass just as happily over a string that was never populated — which is
// precisely how ERR-253 hid 22,251 characters of live code, and ERR-258 hid six
// guards behind a green suite. So: prove the stripped source still contains
// something only the real file has, before trusting anything it lacks.
// ─────────────────────────────────────────────────────────────────────────────

test('the stripped sources are real code, not an empty string', () => {
  assert.ok(PRODUCTS_CODE.length > 100000,
    `products.js stripped to ${PRODUCTS_CODE.length} chars — too small to be the real file`);
  assert.match(PRODUCTS_CODE, /function stockFieldHtml\(/);
  assert.match(PRODUCTS_CODE, /function wireStockAdjust\(/);
  assert.match(STOCK_CODE, /export function computeNewStock\(/);
  // Positive control for the stripper itself: a comment marker must be GONE.
  assert.doesNotMatch(STOCK_CODE, /RULE 1/,
    'strip-comments left comment prose in the code string — every guard below is unreliable');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. RULE 1 — three states, and absent is not zero
// ─────────────────────────────────────────────────────────────────────────────

test('readStock separates absent, empty and a real count', async () => {
  const { readStock, STOCK_KNOWN, STOCK_EMPTY, STOCK_UNKNOWN } = await load();

  assert.equal(readStock({ sku: 'X' }).state, STOCK_UNKNOWN, 'a record with no key is UNKNOWN');
  assert.equal(readStock({ stock_quantity: null }).state, STOCK_EMPTY, 'present-and-null is EMPTY');
  assert.equal(readStock({ stock_quantity: 0 }).state, STOCK_KNOWN, 'zero is a COUNT');
  assert.equal(readStock(null).state, STOCK_UNKNOWN);
  assert.equal(readStock(undefined).state, STOCK_UNKNOWN);
});

test('absent and zero are distinguishable — the whole point', async () => {
  const { readStock } = await load();
  const absent = readStock({ sku: 'A' });
  const zero = readStock({ sku: 'B', stock_quantity: 0 });

  assert.notEqual(absent.state, zero.state);
  assert.equal(zero.value, 0);
  assert.equal(absent.value, null, 'an unknown stock must NOT be reported as 0');
  assert.notEqual(absent.label, zero.label);
  // The label a human reads must not say "0" when we were never told.
  assert.doesNotMatch(absent.label, /0/);
});

test('readStock labels singular and plural, and truncates to whole units', async () => {
  const { readStock } = await load();
  assert.equal(readStock({ stock_quantity: 1 }).label, '1 unit');
  assert.equal(readStock({ stock_quantity: 2 }).label, '2 units');
  assert.equal(readStock({ stock_quantity: 0 }).label, '0 units');
  assert.equal(readStock({ stock_quantity: '42' }).value, 42, 'a numeric string is still a count');
  assert.equal(readStock({ stock_quantity: 'abc' }).state, 'STOCK_UNKNOWN',
    'a value we cannot read is unknown, not zero');
});

test('canAdjust is false unless there is a real baseline', async () => {
  const { canAdjust } = await load();
  assert.equal(canAdjust({ stock_quantity: 5 }), true);
  assert.equal(canAdjust({ stock_quantity: 0 }), true, 'you may still add to an empty shelf');
  assert.equal(canAdjust({ stock_quantity: null }), false);
  assert.equal(canAdjust({ sku: 'X' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The arithmetic, and everything it refuses
// ─────────────────────────────────────────────────────────────────────────────

test('computeNewStock adds and removes', async () => {
  const { computeNewStock } = await load();

  const up = computeNewStock(42, 'add', 12);
  assert.equal(up.ok, true);
  assert.equal(up.value, 54);
  assert.equal(up.delta, 12);

  const down = computeNewStock(42, 'remove', '12');
  assert.equal(down.ok, true);
  assert.equal(down.value, 30);
  assert.equal(down.delta, -12, 'the delta carries the sign, the input never does');
});

test('computeNewStock refuses what is not a whole positive move', async () => {
  const { computeNewStock } = await load();
  const refused = (r, why) => {
    assert.equal(r.ok, false, why);
    assert.equal(r.value, null, 'a refusal must not carry a value to write');
    assert.ok(r.error && r.error.length > 0, 'a refusal must say why');
  };

  refused(computeNewStock(42, 'add', 0), 'zero is not a move');
  refused(computeNewStock(42, 'add', -3), 'the sign comes from the direction, not the box');
  refused(computeNewStock(42, 'add', 1.5), 'stock moves in whole units');
  refused(computeNewStock(42, 'add', 'abc'), 'not a number');
  refused(computeNewStock(42, 'add', ''), 'empty');
  refused(computeNewStock(42, 'sideways', 5), 'unknown direction');
  refused(computeNewStock(null, 'add', 5), 'no baseline');
  refused(computeNewStock(undefined, 'add', 5), 'no baseline');
});

test('computeNewStock will not drive stock negative', async () => {
  const { computeNewStock } = await load();

  const tooMany = computeNewStock(42, 'remove', 50);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /42/, 'the refusal names what is actually on hand');

  const fromEmpty = computeNewStock(0, 'remove', 1);
  assert.equal(fromEmpty.ok, false);

  const toExactlyZero = computeNewStock(42, 'remove', 42);
  assert.equal(toExactlyZero.ok, true, 'landing ON zero is allowed — going below it is not');
  assert.equal(toExactlyZero.value, 0);
});

test('a change that lands on zero is flagged, because it stops the sale', async () => {
  const { computeNewStock } = await load();

  assert.equal(computeNewStock(42, 'remove', 42).zeroing, true);
  assert.equal(computeNewStock(42, 'remove', 41).zeroing, false, '1 left is still for sale');
  assert.equal(computeNewStock(0, 'add', 5).zeroing, false, 'leaving zero is not zeroing');
});

test('the zeroing notice names the consequence the operator cannot see', async () => {
  const { ZEROING_NOTICE } = await load();
  assert.match(ZEROING_NOTICE, /Add to cart/i);
  assert.match(ZEROING_NOTICE, /Contact Us For Stock Enquiries/i,
    'it must quote the copy the shopper will actually see (js/api.js OOS_STOCK_LABEL)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. RULE 3 — stock_status and in_stock are never written
// ─────────────────────────────────────────────────────────────────────────────

test('the payload carries the number and nothing derived from it', async () => {
  const { stockAdjustPayload } = await load();
  const product = {
    id: 'p1', sku: 'S1', name: 'N', is_active: true, retail_price: 12.5,
    stock_quantity: 3, stock_status: 'contact_us',
  };
  const body = stockAdjustPayload(product, 9);

  assert.equal(body.stock_quantity, 9);
  assert.ok(!('stock_status' in body),
    'stock_status is tri-state — contact_us cannot be derived from a number');
  assert.ok(!('in_stock' in body), 'in_stock is derived by the backend');
  assert.equal(body.retail_price, 12.5, 'the route requires retail_price (products.js:4644)');
  assert.deepEqual(Object.keys(body).sort(),
    ['is_active', 'name', 'retail_price', 'sku', 'stock_quantity'],
    'the body stays small — probe §4b measured that a five-key PUT costs no other column');
});

test('stockAdjustPayload refuses a value it should never write', async () => {
  const { stockAdjustPayload } = await load();
  assert.equal(stockAdjustPayload({ sku: 'S' }, -1), null);
  assert.equal(stockAdjustPayload({ sku: 'S' }, 1.5), null);
  assert.equal(stockAdjustPayload(null, 5), null);
});

test('the stock module never mentions stock_status or in_stock in code', () => {
  // Positive control first: the module DOES talk about stock_quantity, so a
  // pass below is a real absence rather than an empty haystack.
  assert.match(STOCK_CODE, /stock_quantity/);
  assert.doesNotMatch(STOCK_CODE, /stock_status/,
    'stock_status appears in stock-adjust.js code — see RULE 3');
  assert.doesNotMatch(STOCK_CODE, /in_stock/,
    'in_stock appears in stock-adjust.js code — it is derived by the backend');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RULE 2 — the main save payload must NOT carry stock_quantity
// ─────────────────────────────────────────────────────────────────────────────

/** The `const data = {…}` the edit modal's Save button builds. */
function editSavePayloadBlock() {
  const anchor = PRODUCTS_CODE.indexOf('[data-action="save"]');
  assert.ok(anchor > 0, 'could not find the edit modal save handler');
  const start = PRODUCTS_CODE.indexOf('const data = {', anchor);
  assert.ok(start > 0, 'could not find the save payload');
  const end = PRODUCTS_CODE.indexOf('\n    };', start);
  assert.ok(end > start, 'could not find the end of the save payload');
  return PRODUCTS_CODE.slice(start, end);
}

test('Save Changes does not resend a stock level it does not own', () => {
  const block = editSavePayloadBlock();
  // Positive control — we are looking at the real payload.
  assert.match(block, /retail_price:/, 'this is not the save payload');
  assert.match(block, /weight_kg:/);

  assert.doesNotMatch(block, /stock_quantity/,
    'stock_quantity is back in the main save payload. Probe §3 measured that omitting it is '
    + 'SAFE, so re-adding it cannot fix anything — it can only overwrite a stock level with a '
    + 'number this form read when the modal opened, undoing an adjustment made since. '
    + 'Apply owns this write.');
});

test('the Apply control writes through the ONE route measured to persist stock', () => {
  const wire = PRODUCTS_CODE.slice(PRODUCTS_CODE.indexOf('function wireStockAdjust('));
  assert.ok(wire.length > 0);
  assert.match(wire, /AdminAPI\.updateProduct\(product\.id, payload\)/,
    'the write must go through the admin PUT — probe §5 shows the direct PostgREST leg is 403');
  assert.doesNotMatch(wire.slice(0, wire.indexOf('function sourcingPayload')), /supabase|from\('products'\)/i,
    'no direct-PostgREST write: that leg answered 403 42501 for this role');
});

test('the new stock level is read back, never assumed', () => {
  const wire = PRODUCTS_CODE.slice(PRODUCTS_CODE.indexOf('function wireStockAdjust('));
  assert.match(wire, /AdminAPI\.getProduct\(product\.id\)/,
    'when the write response does not carry the value, re-read it');
  assert.match(wire, /could not be read back/,
    'a write we cannot confirm must say so rather than paint an arithmetic result');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The control is actually on the Inventory tab, and wired
// ─────────────────────────────────────────────────────────────────────────────

test('the Inventory panel renders the stock field', () => {
  const start = PRODUCTS_CODE.indexOf('let inventoryHtml =');
  assert.ok(start > 0, 'the edit modal has no inventoryHtml');
  const panel = PRODUCTS_CODE.slice(start, start + 900);
  assert.match(panel, /stockFieldHtml\(formGroup, full\)/,
    'the stock field is not on the Inventory tab');
  assert.match(panel, /edit-weight/, 'positive control: this is the Inventory panel');
});

test('the control is wired when the modal is built', () => {
  assert.match(PRODUCTS_CODE, /wireStockAdjust\(modal, full\);/,
    'stockFieldHtml renders buttons that nothing listens to — the ERR-214 shape, where '
    + 'hash-locked markup shipped with no runtime for four months');
});

test('the field is pinnable, like every other Inventory field', () => {
  const fn = PRODUCTS_CODE.slice(
    PRODUCTS_CODE.indexOf('function stockFieldHtml('),
    PRODUCTS_CODE.indexOf('function wireStockAdjust('));
  assert.match(fn, /formGroup\('Stock on hand', control, 'stock_quantity'\)/,
    'the override key is what gives the field its import-feed pin badge');
});

test('the unknown state tells the operator it is not a zero', () => {
  const fn = PRODUCTS_CODE.slice(
    PRODUCTS_CODE.indexOf('function stockFieldHtml('),
    PRODUCTS_CODE.indexOf('function wireStockAdjust('));
  assert.match(fn, /not the same as none/i,
    'an unreadable stock must say so in words, not render as 0');
  assert.match(fn, /STOCK_KNOWN/, 'the control only appears over a real baseline');
});
