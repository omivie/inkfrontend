/**
 * Admin Orders list — Supplier + Supplier cost columns (ERR-203, Sep 2026)
 * ============================================================================
 *
 * The Orders list could say what a customer paid and what we made, but not who
 * we bought from or what it cost us. Both facts were already on screen — once
 * per line, inside the order-detail modal — so answering "where is this month's
 * volume going?" meant opening twenty modals one at a time.
 *
 * THE FINDING THIS FILE EXISTS TO PROTECT
 * ---------------------------------------
 * The order-detail payload carries a top-level, owner-only
 * `supplier_fulfillment: { selected_supplier, total_supplier_cost, line_details[] }`
 * that reads like this exact feature, pre-built by the backend. It is a trap,
 * and the measurement is the argument (production, 2026-09-03, 45 non-cancelled
 * orders):
 *
 *   - populated on 13 of 45 (29%); the line items answer for 39 (87%). Twenty-six
 *     orders whose LINES name a supplier have the field null.
 *   - on 2026090102 — the one order in the sample sourced from two suppliers —
 *     it says `selected_supplier: "Augmento"`, `total_supplier_cost: 27.07`.
 *     That order's lines are DSNZ + Augmento and cost $97.58. It reported one
 *     supplier's SLICE as the order's whole.
 *   - a second cost disagreement on 20260829000001 ($16.60 of lines vs $13.50).
 *
 * A field that is right eleven times and quietly wrong the twelfth is worse than
 * no field at all, because nothing on screen tells the two apart. §4 below bans
 * the identifier outright: the next reader to notice it will think it saves work,
 * and the failing test is the only thing that will tell them otherwise.
 *
 * Everything else here is the fail-soft-must-be-LOUD rule applied to two new
 * cells: UNKNOWN is never $0, a partial supplier list never renders as complete,
 * and each em-dash says which of five different things it means.
 *
 * Run: node --test tests/admin-orders-supplier-columns-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ORDERS = read('inkcartridges/js/admin/pages/orders.js');
const SOURCING = read('inkcartridges/js/admin/utils/sourcing.js');
const CSS = read('inkcartridges/css/admin.css');

// Both modules are ESM; this file is CJS. Load them once, lazily.
let S;
let P;
test.before(async () => {
  S = await import(path.join(SITE, 'js/admin/utils/sourcing.js'));
  P = await import(path.join(SITE, 'js/admin/utils/order-profit.js'));
});

/** A line with everything recorded. */
const line = (over = {}) => ({
  sku: 'GPGI680XXLBK', qty: 1, sell_price: 43.03, supplier_cost_snapshot: 30.77,
  suppliers: [{ name: 'DSNZ', sku: 'GPGI680XXLBK', color: 'Black' }],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Supplier cost: UNKNOWN is not zero, and a real zero is not unknown
// ─────────────────────────────────────────────────────────────────────────────

test('a line with no recorded cost makes the ORDER total UNKNOWN, never $0', () => {
  const r = S.orderSupplierCostFromDetail({
    items: [line(), line({ supplier_cost_snapshot: null })],
  });
  assert.equal(r.costExGst, null, 'a partial cost total is not a cost total');
  assert.equal(r.missingCostCount, 1);
  assert.equal(r.itemCount, 2);
});

test('supplier_cost_snapshot undefined counts as missing too, not as 0', () => {
  const bare = { sku: 'X', qty: 1, suppliers: [{ name: 'DSNZ' }] };
  const r = S.orderSupplierCostFromDetail({ items: [bare] });
  assert.equal(r.costExGst, null);
  assert.equal(r.missingCostCount, 1);
});

test('a snapshot of a GENUINE 0 is a real recorded cost — a giveaway costs $0', () => {
  const r = S.orderSupplierCostFromDetail({ items: [line({ supplier_cost_snapshot: 0, qty: 3 })] });
  assert.equal(r.costExGst, 0, '`== null` and nothing looser — `?? 0` here is the ERR-063 bug class');
  assert.equal(r.missingCostCount, 0);
});

test('an order with no line items is UNKNOWN, not a $0.00 order', () => {
  // The sum over nothing is 0, and "$0.00" would be a claim we never made.
  const r = S.orderSupplierCostFromDetail({ items: [] });
  assert.equal(r.costExGst, null);
  assert.equal(r.itemCount, 0);
  assert.equal(r.missingCostCount, 0, 'no lines is not the same as lines with no cost');
});

test('cost is summed per unit × quantity, ex-GST', () => {
  const r = S.orderSupplierCostFromDetail({
    items: [line({ supplier_cost_snapshot: 10, qty: 2 }), line({ supplier_cost_snapshot: 5.5, qty: 4 })],
  });
  assert.equal(r.costExGst, 42);
});

test('quantity is read from qty OR quantity, whichever the payload spells', () => {
  const a = S.orderSupplierCostFromDetail({ items: [{ supplier_cost_snapshot: 7, qty: 3 }] });
  const b = S.orderSupplierCostFromDetail({ items: [{ supplier_cost_snapshot: 7, quantity: 3 }] });
  assert.equal(a.costExGst, 21);
  assert.equal(b.costExGst, 21);
});

test('order_items is accepted as well as items', () => {
  const r = S.orderSupplierCostFromDetail({ order_items: [line({ supplier_cost_snapshot: 9, qty: 1 })] });
  assert.equal(r.costExGst, 9);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Suppliers: dedupe for display, but NEVER hide a line that named nobody
// ─────────────────────────────────────────────────────────────────────────────

test('distinct supplier names, in first-seen order', () => {
  const r = S.orderSuppliersFromDetail({
    items: [
      line({ suppliers: [{ name: 'DSNZ', color: 'Cyan' }, { name: 'DSNZ', color: 'Magenta' }] }),
      line({ suppliers: [{ name: 'Augmento', color: 'Yellow' }] }),
    ],
  });
  assert.deepEqual(r.names, ['DSNZ', 'Augmento'], 'three entries, two distinct names');
  assert.equal(r.constituents.length, 3, 'the tooltip keeps every constituent — that is its whole value');
  assert.equal(r.missingSupplierCount, 0);
});

test('PARTIAL: some lines supplied and some not is reported, not silently trimmed', () => {
  // This is the state that makes supplier_fulfillment unusable. If the return
  // value cannot express it, the cell cannot render it, and the names become a
  // claim about the whole order that we have no basis for.
  const r = S.orderSuppliersFromDetail({
    items: [line(), line({ suppliers: [] }), line({ suppliers: undefined })],
  });
  assert.deepEqual(r.names, ['DSNZ']);
  assert.equal(r.missingSupplierCount, 2, 'two lines named nobody and the caller must be told');
  assert.equal(r.itemCount, 3);
});

test('no supplier anywhere is distinguishable from no line items', () => {
  const noSup = S.orderSuppliersFromDetail({ items: [line({ suppliers: [] })] });
  assert.deepEqual(noSup.names, []);
  assert.equal(noSup.itemCount, 1, 'a line exists — it just names nobody');

  const noItems = S.orderSuppliersFromDetail({ items: [] });
  assert.equal(noItems.itemCount, 0);
});

test('an entry with no name is dropped, matching supplierCell', () => {
  const r = S.orderSuppliersFromDetail({ items: [line({ suppliers: [{ sku: 'X' }, { name: 'DSNZ' }] })] });
  assert.deepEqual(r.names, ['DSNZ']);
  assert.equal(r.missingSupplierCount, 0, 'the line DID name a supplier, so it is not a missing line');
});

test('the tooltip label prefers colour, then constituent sku, then the line sku', () => {
  const r = S.orderSuppliersFromDetail({
    items: [line({ sku: 'LINE', suppliers: [
      { name: 'A', color: 'Cyan', sku: 'S1' },
      { name: 'B', sku: 'S2' },
      { name: 'C' },
    ] })],
  });
  assert.deepEqual(r.constituents.map((c) => c.label), ['Cyan', 'S2', 'LINE']);
});

test('a junk order returns the empty shape rather than throwing', () => {
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    assert.equal(S.orderSuppliersFromDetail(junk).itemCount, 0);
    assert.equal(S.orderSupplierCostFromDetail(junk).costExGst, null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POSITIVE CONTROL: the two independent cost sums must agree
// ─────────────────────────────────────────────────────────────────────────────

test('orderSupplierCostFromDetail agrees with the profit engine wherever both can speak', () => {
  // Deliberate near-duplication: orderProfitFromDetail nulls totalCostExGst when
  // it refuses the REVENUE side, which would wrongly blank a cost we do know.
  // So this sums independently — and this test is what stops the two drifting.
  // A test that only checked the UNKNOWN paths could pass with both broken, so
  // the assertion that matters is the one on real numbers (ERR-186).
  const order = {
    status: 'paid', total_amount: 223.97,
    items: [
      line({ supplier_cost_snapshot: 30.77, qty: 2, sell_price: 43.03 }),
      line({ supplier_cost_snapshot: 12.5, qty: 3, sell_price: 20 }),
    ],
  };
  const mine = S.orderSupplierCostFromDetail(order);
  const theirs = P.orderProfitFromDetail(order);
  assert.equal(theirs.totalCostExGst != null, true, 'positive control: the profit engine must have a figure here');
  assert.ok(Math.abs(mine.costExGst - theirs.totalCostExGst) < 1e-9,
    `two sums of the same numbers disagree: ${mine.costExGst} vs ${theirs.totalCostExGst}`);
});

test('and both go UNKNOWN together when a line has no cost', () => {
  const order = { status: 'paid', total_amount: 100, items: [line(), line({ supplier_cost_snapshot: null })] };
  assert.equal(S.orderSupplierCostFromDetail(order).costExGst, null);
  assert.equal(P.orderProfitFromDetail(order).totalCostExGst, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE GUARD: supplier_fulfillment must never be read
// ─────────────────────────────────────────────────────────────────────────────

/** Source with comments removed — the ban is on CODE, not on the prose explaining it. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('neither module reads order.supplier_fulfillment — it reports a slice as the whole', () => {
  // See the header. Measured 2026-09-03: 29% coverage, and on the one
  // multi-supplier order in the sample it named one of the two suppliers and
  // 27.07 of a 97.58 cost. `npm run probe:orders-supplier` §2 watches it live in
  // case the backend ever changes what the field means; until that probe goes
  // green on a full reconciliation, this ban stands.
  for (const [name, src] of [['pages/orders.js', ORDERS], ['utils/sourcing.js', SOURCING]]) {
    const code = stripComments(src);
    for (const banned of ['supplier_fulfillment', 'selected_supplier', 'total_supplier_cost', 'line_details']) {
      assert.ok(!new RegExp(`\\b${banned}\\b`).test(code),
        `${name} must not read \`${banned}\` — see this file's header for the measurement`);
    }
  }
  // It must still be EXPLAINED, or the next reader re-discovers the trap the
  // hard way. A silent ban is one refactor away from being undone.
  assert.ok(/supplier_fulfillment/.test(SOURCING),
    'sourcing.js must keep the comment recording why the field is unused');
  assert.ok(/2026090102/.test(SOURCING),
    'and cite the order that disproved it, so the claim can be re-measured');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Column declarations
// ─────────────────────────────────────────────────────────────────────────────

test('both columns are declared, between Profit and the actions column', () => {
  assert.match(ORDERS, /key:\s*'_supplier',\s*label:\s*'Supplier'/);
  assert.match(ORDERS, /key:\s*'_supplier_cost',\s*label:\s*'Supplier cost'/);
  const profitAt = ORDERS.indexOf("key: '_profit'");
  const supAt = ORDERS.indexOf("key: '_supplier',");
  const costAt = ORDERS.indexOf("key: '_supplier_cost'");
  const actionsAt = ORDERS.indexOf("key: '_actions'");
  assert.ok(profitAt > -1 && supAt > profitAt, 'Supplier sits right of Profit');
  assert.ok(costAt > supAt, 'and Supplier cost right of Supplier');
  assert.ok(actionsAt > costAt, 'both before the actions column');
});

test('neither column is sortable — the values are not on the list payload at all', () => {
  // Measured 2026-09-03: 0 of 142 list items carry `suppliers` or
  // `supplier_cost_snapshot`. A header click could only order the 20 rows
  // already hydrated while looking like a full sort, and the backend's sort
  // enum (newest|oldest|total-high|total-low) silently falls back to newest.
  const block = ORDERS.slice(ORDERS.indexOf("key: '_supplier',"), ORDERS.indexOf("key: '_actions'"));
  assert.ok(!/sortable:\s*true/.test(block));
});

test('the money column states its GST basis and the name column does not borrow one', () => {
  const costBlock = ORDERS.slice(ORDERS.indexOf("key: '_supplier_cost'"), ORDERS.indexOf("key: '_actions'"));
  assert.match(costBlock, /gst:\s*GST_EXCL/,
    'a money column with a blank gst slot means "basis undocumented" (utils/gst-basis.js)');
  const nameBlock = ORDERS.slice(ORDERS.indexOf("key: '_supplier',"), ORDERS.indexOf("key: '_supplier_cost'"));
  assert.ok(!/gst:/.test(nameBlock), 'a supplier NAME is not money and must not enter the money vocabulary');
});

test('both columns are owner-only, via the same named set the fan-out gates on', () => {
  assert.match(ORDERS, /const OWNER_ONLY_COLUMNS = new Set\(\[([^\]]*)\]\)/);
  const set = ORDERS.match(/const OWNER_ONLY_COLUMNS = new Set\(\[([^\]]*)\]\)/)[1];
  for (const key of ['_profit', '_supplier', '_supplier_cost']) {
    assert.ok(set.includes(`'${key}'`), `${key} must be owner-only — supplier cost is ERR-170 data`);
  }
  assert.match(ORDERS, /COLUMNS\.filter\(c => !OWNER_ONLY_COLUMNS\.has\(c\.key\)\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ONE fetch feeds three columns
// ─────────────────────────────────────────────────────────────────────────────

test('NO SECOND FAN-OUT: the sourcing cells read the response profit already fetched', () => {
  // The whole point of the design. A second AdminAPI.getOrder loop would double
  // the load on the backend's 60/min limiter for data already in hand.
  const calls = (ORDERS.match(/AdminAPI\.getOrder\(/g) || []).length;
  assert.equal(calls, 2,
    `expected exactly two getOrder call sites — the row hydration and the modal — found ${calls}`);
  const hydrate = ORDERS.slice(ORDERS.indexOf('async function hydrateRowDetail'), ORDERS.indexOf('function orderLabel'));
  assert.equal((hydrate.match(/AdminAPI\.getOrder\(/g) || []).length, 1,
    'the hydration must make exactly one request per row, feeding all three columns');
  assert.match(hydrate, /_profitCache\.set/);
  assert.match(hydrate, /_sourcingCache\.set/);
});

test('the sourcing cache is filled from the SAME settled result as the profit cache', () => {
  const hydrate = ORDERS.slice(ORDERS.indexOf('async function hydrateRowDetail'), ORDERS.indexOf('function orderLabel'));
  assert.match(hydrate, /const ok = res\.status === 'fulfilled' && res\.value/,
    'one fulfilment check for both caches — two would let them disagree about the same response');
});

test('a failed detail call marks BOTH caches failed, never "no supplier" or $0', () => {
  const hydrate = ORDERS.slice(ORDERS.indexOf('async function hydrateRowDetail'), ORDERS.indexOf('function orderLabel'));
  assert.match(hydrate, /\{ state: PROFIT_STATE\.FAILED \}/);
  assert.match(hydrate, /\{ state: SOURCING_STATE\.FAILED \}/);
});

test('cancelled rows are cached as CANCELLED without a fetch, and say so', () => {
  const hydrate = ORDERS.slice(ORDERS.indexOf('async function hydrateRowDetail'), ORDERS.indexOf('function orderLabel'));
  assert.match(hydrate, /_sourcingCache\.set\(row\.id, \{ state: SOURCING_STATE\.CANCELLED \}\)/);
  // and the cell must explain that we never asked, rather than implying nobody supplied it
  assert.match(ORDERS, /Cancelled[\s\S]{0,40}line items were not loaded/,
    'a cancelled row\'s dash means "not fetched", not "no supplier"');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The five em-dash states are distinguishable, and the partial one is loud
// ─────────────────────────────────────────────────────────────────────────────

test('every SOURCING_STATE has its own branch in both renderers', () => {
  assert.match(ORDERS, /const SOURCING_STATE = Object\.freeze\(\{/);
  for (const fn of ['supplierNameCellHtml', 'supplierCostCellHtml']) {
    const body = ORDERS.slice(ORDERS.indexOf(`function ${fn}(`));
    const cut = body.slice(0, body.indexOf('\n}\n') + 3);
    for (const state of ['PENDING', 'CANCELLED', 'FAILED']) {
      assert.ok(cut.includes(`SOURCING_STATE.${state}`), `${fn} must handle ${state} in its own words`);
    }
  }
});

test('the cost cell says UNKNOWN, not $0, in as many words', () => {
  const body = ORDERS.slice(ORDERS.indexOf('function supplierCostCellHtml('));
  const cut = body.slice(0, body.indexOf('\n}\n'));
  assert.match(cut, /UNKNOWN, not \$0/);
  assert.match(cut, /This is NOT \$0/, 'a failed lookup must disclaim zero too');
});

test('a partial supplier list renders a marker and a counted tooltip', () => {
  const body = ORDERS.slice(ORDERS.indexOf('function supplierNameCellHtml('));
  const cut = body.slice(0, body.indexOf('\n}\n'));
  assert.match(cut, /missingSupplierCount > 0/);
  assert.match(cut, /order-supplier__partial/);
  assert.match(cut, /INCOMPLETE/,
    'the tooltip must say the list may be missing a supplier, not merely count lines');
});

test('both cells carry a stable data attribute so they can be patched in place', () => {
  // Not setData/setColumns: that re-renders the table and drops row focus on
  // each of ~20 landing fetches (the reason patchProfitCell exists).
  assert.match(ORDERS, /data-order-supplier="\$\{id\}"/);
  assert.match(ORDERS, /data-order-supplier-cost="\$\{id\}"/);
  const patch = ORDERS.slice(ORDERS.indexOf('function patchSourcingCells('));
  const cut = patch.slice(0, patch.indexOf('\n}\n'));
  assert.match(cut, /CSS\.escape/);
  assert.ok(!/setData|setColumns/.test(cut));
});

test('supplier names are escaped — they are backend free text', () => {
  const body = ORDERS.slice(ORDERS.indexOf('function supplierNameCellHtml('));
  const cut = body.slice(0, body.indexOf('\n}\n'));
  assert.match(cut, /names\.map\(esc\)/, 'a supplier name reaches the DOM as HTML');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Every class the renderers emit exists in the stylesheet
// ─────────────────────────────────────────────────────────────────────────────

test('the CSS the two cells depend on is defined', () => {
  for (const cls of [
    'order-supplier', 'order-supplier__names', 'order-supplier__partial',
    'order-supplier--partial', 'order-supplier--none', 'order-supplier--pending',
    'order-supplier--failed', 'order-supplier-cost', 'order-supplier-cost--none',
    'order-supplier-cost--pending', 'order-supplier-cost--failed',
  ]) {
    assert.ok(CSS.includes(`.${cls}`), `.${cls} is emitted by orders.js but not defined in admin.css`);
  }
});

test('failed reads amber and unknown reads muted — they must not be the same colour', () => {
  // "cost lookup failed" and "no cost on record" are different facts; ERR-063's
  // whole lesson is that rendering them alike is what makes a dash ignorable.
  assert.match(CSS, /\.order-supplier--failed \{[^}]*--yellow-text/);
  assert.match(CSS, /\.order-supplier-cost--failed \{[^}]*--yellow-text/);
  assert.match(CSS, /\.order-supplier--none[^{]*\{[^}]*--text-muted/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. One vocabulary — the list and the modal must not drift
// ─────────────────────────────────────────────────────────────────────────────

test('the roll-ups live in utils/sourcing.js, not inlined in the page', () => {
  assert.match(SOURCING, /export function orderSuppliersFromDetail\(/);
  assert.match(SOURCING, /export function orderSupplierCostFromDetail\(/);
  assert.match(ORDERS, /orderSuppliersFromDetail,\s*orderSupplierCostFromDetail,?\s*\n?\s*\}?\s*from '\.\.\/utils\/sourcing\.js'|orderSuppliersFromDetail/,
    'orders.js must import them rather than keep its own copy');
  // The page must not re-implement the dedupe the util owns.
  assert.ok(!/new Set\(\s*list\.map\(\(s\) => s\.name\)\s*\)/.test(ORDERS),
    'deduping supplier names in the page is how the list and the modal drift apart');
});
