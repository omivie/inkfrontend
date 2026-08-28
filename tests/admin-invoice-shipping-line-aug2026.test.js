/**
 * Invoicing a shipping charge with no product behind it
 * =====================================================
 *
 * The operator needs to bill freight on its own — a re-delivery, a rural
 * surcharge invoiced after the fact, an international shipment on-charged at
 * cost. The editor was built entirely around the product picker, and the only
 * freight surface was the `Freight` scalar, which prints as a totals row and
 * cannot stand alone: validateInvoice demands a complete line item and the
 * backend 400s on an empty `line_items`.
 *
 * The data model already allowed this. A description-only line has been legal
 * since ERR-071 ("code OR description" — freight/labour/one-off lines are
 * modelled exactly this way), so "Add shipping charge" needed no new field, no
 * endpoint and no payload key. What it DID need was a guard.
 *
 * What this file pins, and why each one is load-bearing:
 *
 *   §1  THE DOUBLE CHARGE (ERR-174). reconcileShipping() auto-adopts the
 *       backend's suggested courier rate whenever a fresh draft's freight box is
 *       still $0 and no option has been chosen. On an invoice billing freight AS
 *       A LINE that fires the moment the quote returns and drops a second
 *       freight charge into the totals, where the operator will not look.
 *       Adding the line takes the choice out of null. This is silent money.
 *   §2  The ladder can never re-price freight. A shipping line is PRICE_MANUAL
 *       from birth, so applyQuoteToLines may only OFFER, never overwrite, and
 *       any discount claim is stripped. An authored freight figure is history.
 *   §3  `kind` is session-only and NEVER reaches buildPayload. That key set is
 *       walked by setStatusViaFullUpdate() and diffed by documentDrift(), so a
 *       new key would change what the Paid toggle's full-record PUT writes —
 *       the same reason _freightChoice was never stored.
 *   §4  The document is unchanged: FOUR columns, empty code cell, the amount in
 *       the subtotal, Freight still "Free". A fifth column is the shape that
 *       would one day print our margin.
 *   §5  Freight COST is UNKNOWN, not zero. Booking a freight line at 100% margin
 *       is absence-as-zero (ERR-068); the COGS panel must degrade to "—" until
 *       the operator types what the courier charged us.
 *   §6  An empty code stays legal end to end — no SKU lookup fires, and the
 *       parcel-weight note does not count a blank code as "unrecognised".
 *   §7  The code box is read-only and carries no product autocomplete, because a
 *       typed `FREIGHT` is not a real products.sku and would block the save.
 *   §8  Returning browsers get the new build.
 *
 * Run: node --test tests/admin-invoice-shipping-line-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', 'inkcartridges');
const ADMIN = path.join(ROOT, 'js', 'admin');
const INVOICES = fs.readFileSync(path.join(ADMIN, 'pages', 'invoices.js'), 'utf8');
const APP = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');

// Same ESM→sandbox trick the sibling invoice suites use (admin-invoice-quote).
function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

function sandboxOf(...relPaths) {
  const box = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date, RegExp };
  box.globalThis = box;
  vm.createContext(box);
  for (const rel of relPaths) {
    const file = path.join(ADMIN, rel);
    vm.runInContext(stripEsm(fs.readFileSync(file, 'utf8')), box, { filename: path.basename(file) });
  }
  return box;
}

// invoice-math.js imports GST_RATE etc. from profitability.js — dependency first.
const MATH = sandboxOf('utils/profitability.js', 'utils/invoice-math.js');
const QUOTE = sandboxOf('utils/invoice-quote.js');
const CODES = sandboxOf('utils/line-codes.js');

// Values built inside the vm realm carry that realm's prototypes, so deepEqual
// sees "same structure, not reference-equal". Round-trip through JSON first.
const plain = (x) => JSON.parse(JSON.stringify(x));

const { computeInvoiceTotals, computeInvoiceCogs, computeInvoiceProfit, invoiceDocRows } = MATH;
const { PRICE_MANUAL, PRICE_AUTO, FREIGHT_CUSTOM, applyQuoteToLines, parcelWeightNote,
  quoteRequestBody, freeShippingLost, planFreightAutofill,
  FREIGHT_OWNER_NONE, FREIGHT_OWNER_AUTO, FREIGHT_OWNER_OPERATOR } = QUOTE;

// Comments explain; only code counts when asserting that something is WIRED.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const CODE = stripComments(INVOICES);

/** Brace-match a top-level function body out of a source file. */
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `not found: ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`unbalanced braces after ${signature}`);
}

const money = (n) => `$${Number(n).toFixed(2)}`;

/** A shipping-only invoice: one description-only line, freight box untouched. */
const shippingOnlyDraft = () => ({
  lines: [{
    code: '', description: 'Freight & delivery', qty: 1, unitCost: 150,
    supplierCost: null, costSource: 'auto', priceSource: 'manual',
    volumePercent: null, volumeSaving: null, volumeQuantity: null,
  }],
  freight: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// §1  The double charge — freight billed twice (ERR-174)
// ─────────────────────────────────────────────────────────────────────────────

test('§1 adding a shipping line takes the freight choice out of null', () => {
  const body = fnBody(CODE, 'function suppressFreightAutofill(');
  // null is the ONLY state reconcileShipping's autofill branch acts on.
  assert.match(body, /_freightChoice\s*==\s*null/,
    'must only act when no choice has been made — an operator who picked a courier keeps it');
  assert.match(body, /_freightChoice\s*=\s*FREIGHT_CUSTOM/,
    'must land on FREIGHT_CUSTOM, the same value a hand-typed freight figure sets');
});

test('§1 the add-shipping handler calls it BEFORE anything re-quotes', () => {
  const body = fnBody(CODE, 'function addShippingLine(');
  assert.match(body, /suppressFreightAutofill\(\)/,
    'without this the quote drops a second freight charge into the totals');
  assert.ok(body.indexOf('suppressFreightAutofill()') < body.indexOf('scheduleQuote()'),
    'the guard must be set before the quote that would trip the autofill is scheduled');
});

test('§1 the autofill branch it defends against is still shaped the way we think', () => {
  // The condition moved out of reconcileShipping and into planFreightAutofill
  // when ERR-178 split "who wrote this freight figure" out of _freightChoice.
  // Pin the behaviour rather than the old inline expression: an untouched draft
  // still adopts, and the disarmed state still does not.
  const shipping = {
    hasOptions: true,
    options: [{ key: 'auckland:urban', label: 'Auckland urban', freightExclGst: 6.09 }],
    suggestedKey: 'auckland:urban', freeShippingThreshold: 100, freeShippingEligible: false,
    goodsTotalInclGst: 172.50,
  };
  const untouched = planFreightAutofill(shipping, {
    owner: FREIGHT_OWNER_NONE, choice: null, freight: 0,
  });
  assert.equal(untouched.apply, true, 'the common case must still need no clicks');

  const disarmed = planFreightAutofill(shipping, {
    owner: FREIGHT_OWNER_OPERATOR, choice: FREIGHT_CUSTOM, freight: 0,
  });
  assert.equal(disarmed.apply, false,
    'this is the ERR-174 double charge: a $150 freight LINE plus a $6.09 courier rate');

  // And ERR-178's re-adoption must not sneak past the same guard.
  const overThreshold = planFreightAutofill({ ...shipping,
    options: [{ key: 'free', label: 'Free shipping', freightExclGst: 0 }, ...shipping.options],
    suggestedKey: 'free', freeShippingEligible: true,
  }, { owner: FREIGHT_OWNER_OPERATOR, choice: FREIGHT_CUSTOM, freight: 0 });
  assert.equal(overThreshold.apply, false,
    'crossing the free-shipping threshold must not reopen the hole from the other side');
});

test('§1 suppressFreightAutofill disarms BOTH halves of the guard', () => {
  // _freightChoice alone is no longer enough: planFreightAutofill keys off
  // ownership, so a shipping line that only set the choice would still be
  // revisable the moment the goods total crossed the threshold.
  const body = fnBody(CODE, 'function suppressFreightAutofill()');
  assert.match(body, /_freightChoice == null.*FREIGHT_CUSTOM/s);
  assert.match(body, /_freightOwner = FREIGHT_OWNER_OPERATOR/);
});

test('§1 FREIGHT_CUSTOM does not trip the free-shipping-lost fallback', () => {
  // That branch WRITES a freight figure. It must not fire on a freight line.
  const lost = freeShippingLost(FREIGHT_CUSTOM, {
    hasOptions: true, options: [{ key: 'auckland:urban', label: 'Auckland urban', freightExclGst: 7 }],
    suggestedKey: 'auckland:urban', freeShippingThreshold: 100,
  });
  assert.equal(lost.lost, false);
});

test('§1 the button is wired to the handler', () => {
  assert.match(CODE, /data-form-action="add-shipping"/, 'the button must exist');
  assert.match(CODE, /act === 'add-shipping'/, 'and be dispatched in onFormClick');
  assert.match(fnBody(CODE, 'function onFormClick('), /addShippingLine\(\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  The volume ladder may never re-price freight
// ─────────────────────────────────────────────────────────────────────────────

test('§2 a shipping line is PRICE_MANUAL from birth', () => {
  const body = fnBody(CODE, 'const shippingLine = (');
  assert.match(body, /priceSource:\s*PRICE_MANUAL/,
    'freight is an authored figure — PRICE_AUTO would let the ladder overwrite it');
  assert.match(body, /kind:\s*'shipping'/);
  assert.match(body, /description:\s*SHIPPING_DESCRIPTION/);
  assert.match(CODE, /const SHIPPING_DESCRIPTION = 'Freight & delivery'/,
    'country-agnostic by design — it must read as well for international freight as for NZ');
});

test('§2 the ladder offers but never overwrites a shipping line', () => {
  const d = shippingOnlyDraft();
  const quote = {
    lines: [{ position: 0, inputCode: '', resolved: false, quantity: 1,
      volume: { unit_excl_gst: 9.99, effective_percent: 25, saving_excl_gst: 40 } }],
  };
  const { offers } = applyQuoteToLines(d.lines, quote);
  assert.equal(d.lines[0].unitCost, 150, 'the typed freight figure must survive the quote');
  assert.equal(d.lines[0].volumePercent, null, 'and carry no discount claim we did not give');
  assert.ok(Array.isArray(offers));
});

test('§2 a fresh PRODUCT line stays PRICE_AUTO — the guard is scoped, not global', () => {
  assert.match(fnBody(CODE, 'const blankLine = ('), /priceSource:\s*PRICE_AUTO/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  `kind` is session-only and never reaches the wire
// ─────────────────────────────────────────────────────────────────────────────

test('§3 buildPayload does not send `kind`', () => {
  const body = fnBody(CODE, 'function buildPayload(');
  assert.doesNotMatch(body, /\bkind\b/,
    'a new payload key widens the Paid toggle’s full-record PUT and documentDrift’s refusal set');
});

test('§3 line_items is still an explicit whitelist, not a spread', () => {
  const body = fnBody(CODE, 'function buildPayload(');
  const items = body.slice(body.indexOf('line_items:'));
  assert.doesNotMatch(items.slice(0, items.indexOf('freight_excl_gst')), /\.\.\.l\b/,
    'spreading the line would leak `kind` — and every future editor-only field — to the backend');
});

test('§3 draftFromInvoice does not re-derive `kind`', () => {
  const body = fnBody(CODE, 'function draftFromInvoice(');
  assert.doesNotMatch(body, /kind:/,
    'guessing the marker back from a description the operator rewrote is the BF-043 trap');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4  The customer's document is unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('§4 a shipping-only invoice totals correctly, and Freight stays Free', () => {
  assert.deepEqual(plain(computeInvoiceTotals(shippingOnlyDraft())),
    { subtotal: 150, freight: 0, gst: 22.5, total: 172.5 });
});

test('§4 it prints ONE row with an empty product-code cell', () => {
  const rows = invoiceDocRows(shippingOnlyDraft(), { money });
  assert.equal(rows.length, 1);
  assert.deepEqual(plain(rows[0]), ['', 'Freight & delivery', '1', '$150.00', '']);
});

test('§4 the doc projection is still a 5-tuple — the 5th slot is the sub-line, not a column', () => {
  const rows = invoiceDocRows(shippingOnlyDraft(), { money });
  assert.equal(rows[0].length, 5,
    'autoTable derives its column count from the body rows; a 6th slot would grow the table');
  assert.match(CODE, /\['Product Code', ?'Description', ?'Number'/,
    'the PDF head must stay four columns');
});

test('§4 GST is 15% like every other line — no frontend-only zero-rating', () => {
  // The backend recomputes GST authoritatively and has no per-line GST flag, so a
  // frontend zero-rate would be silently overruled on save. Recorded as a backend
  // item instead of faked here.
  const t = computeInvoiceTotals(shippingOnlyDraft());
  assert.equal(t.gst, 22.5);
  assert.doesNotMatch(CODE, /zeroRated|zero_rated/,
    'if this ever lands it needs the backend first — see the handoff note');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5  Freight cost is UNKNOWN, not zero
// ─────────────────────────────────────────────────────────────────────────────

test('§5 COGS degrades to unknown rather than booking freight at 100% margin', () => {
  const cogs = computeInvoiceCogs(shippingOnlyDraft());
  assert.equal(cogs.allKnown, false, 'what the courier charged us is not known until it is typed');
  assert.equal(cogs.unknownLines, 1);
  assert.equal(computeInvoiceProfit(shippingOnlyDraft()), null,
    'absence-as-zero here would report a fictional profit (ERR-068)');
});

test('§5 a typed courier cost is honoured', () => {
  const d = shippingOnlyDraft();
  d.lines[0].supplierCost = 120;
  d.lines[0].costSource = 'manual';
  const cogs = computeInvoiceCogs(d);
  assert.equal(cogs.allKnown, true);
  assert.equal(cogs.costExGst, 120);
});

test('§5 the factory leaves the cost unset, not 0', () => {
  const body = fnBody(CODE, 'const shippingLine = (');
  assert.doesNotMatch(body, /supplierCost:\s*0/,
    'a 0 here would silently claim the freight cost us nothing');
});

test('§5 the cost box asks for the courier cost instead of promising "auto"', () => {
  // Verified live 2026-08-28 on invoice #3275: the stored line kept
  // supplier_cost_excl_gst:null (correctly unknown), but the LIST endpoint
  // reported cost_excl_gst:0 / profit_excl_gst:150, so the Profit column printed
  // 100.0% margin. normalizeInvoice prefers those server fields BY PRESENCE, so
  // the frontend cannot honestly override them — BF-046. What it CAN do is stop
  // telling the operator a freight cost auto-fills, because nothing fills it.
  const body = fnBody(CODE, 'function renderLines(');
  assert.match(body, /const shipCost = l\.kind === 'shipping'/);
  assert.match(body, /shipCost \? 'courier cost' : 'auto'/,
    '"auto" on a freight line promises a snapshot that finds no product and never happens');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  An empty code stays legal end to end
// ─────────────────────────────────────────────────────────────────────────────

test('§6 a blank code is not counted as an unrecognised code in the parcel note', () => {
  const note = parcelWeightNote({
    shipping: { weightKg: 0.7 },
    lines: [{ position: 0, inputCode: '', resolved: false }],
  });
  assert.equal(note, 'parcel ≈ 0.7 kg', 'a freight line has no code to recognise — it is not a miss');
});

test('§6 the shipping line still reaches the quote body (it counts toward the goods total)', () => {
  const built = quoteRequestBody(shippingOnlyDraft());
  assert.ok(built, 'a draft with content must still quote');
  assert.equal(built.body.line_items.length, 1);
  assert.equal(built.body.line_items[0].product_code, '');
  assert.equal(built.body.line_items[0].unit_cost_excl_gst, 150,
    'manual lines send their price so the backend free-shipping check sees the real total');
});

test('§6 codesToVerify skips it, so no SKU lookup fires on a freight line', () => {
  const codes = CODES.codesToVerify(shippingOnlyDraft().lines);
  assert.deepEqual(plain(codes), [],
    'if blank codes ever start erroring, every invoice with a shipping line becomes unsaveable');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  The row itself: no product picker, no typeable code
// ─────────────────────────────────────────────────────────────────────────────

test('§7 a shipping row renders a read-only code box outside .inv-ac', () => {
  const body = fnBody(CODE, 'function renderLines(');
  assert.match(body, /const ship = l\.kind === 'shipping'/);
  assert.match(body, /inv-line__code--none[\s\S]{0,400}readonly/,
    'a typed FREIGHT is not a products.sku and would block the save at verifyLineCodes');
  // The autocomplete selector is `.inv-ac > input`, so keeping a shipping row's
  // inputs OUT of .inv-ac is what excludes it — structurally, not by a flag.
  assert.match(body, /\.inv-ac > input/);
  const shipBranch = body.slice(body.indexOf('const codeCell'), body.indexOf('return `'));
  assert.doesNotMatch(shipBranch.split(': `')[0], /inv-ac/,
    'the shipping branch must not wrap its input in .inv-ac or the product dropdown comes back');
});

test('§7 the code input keeps its data-line/data-lfield hooks', () => {
  const body = fnBody(CODE, 'function renderLines(');
  const ship = body.slice(body.indexOf('const codeCell'), body.indexOf('const descCell'));
  assert.match(ship, /data-line="\$\{i\}" data-lfield="code"/,
    'markInvoiceErrors and unresolvedLineErrors select on these');
});

test('§7 a pristine default row is REPLACED, so one click is a whole invoice', () => {
  const body = fnBody(CODE, 'function addShippingLine(');
  assert.match(body, /_draft\.lines\[0\] = shippingLine\(\)/);
  assert.match(body, /_draft\.lines\.push\(shippingLine\(\)\)/);
  assert.match(body, /data-lfield="unitCost"[\s\S]{0,80}\)/,
    'focus belongs on the amount — the description is already filled');
});

test('§7 the row keeps the shared six-column grid', () => {
  assert.match(CSS, /\.inv-line--shipping/, 'styled as a modifier of the existing grid');
  const block = CSS.slice(CSS.indexOf('.inv-line--shipping'), CSS.indexOf('.inv-line--shipping') + 400);
  assert.doesNotMatch(block, /grid-template-columns/,
    'the .inv-line grid is shared verbatim with Quick Order — never re-column it for one row type');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8  Returning browsers get the new build
// ─────────────────────────────────────────────────────────────────────────────

test('§8 APP_VERSION was bumped for this change', () => {
  const m = APP.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m, 'APP_VERSION must exist — it cache-busts every page module');
  assert.notEqual(m[1], '2026.08.18-preset-already-paid',
    'admin page modules import with ?v=APP_VERSION; a stale token leaves live browsers on the old build');
});
