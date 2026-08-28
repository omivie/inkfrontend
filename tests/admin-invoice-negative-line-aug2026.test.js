/**
 * Invoice CREDIT LINES — a negative Unit Price on a line item (Aug 2026)
 * ======================================================================
 *
 * The operator invoices a customer who already paid for the first cartridge and
 * is getting the second at a discount. That discount is its own row on the
 * document, priced below zero — a CREDIT LINE — rather than a quietly reduced
 * price on the goods line with the reason lost.
 *
 * What this suite pins:
 *
 *   1. A PRICE IS A NUMBER OF EITHER SIGN. validateInvoice used to demand
 *      `unitCost > 0` and report a refused negative with the same words an empty
 *      box gets ("required"), so the operator could not tell the figure had been
 *      rejected rather than missed. Blank and non-numeric are the only answers
 *      that are wrong.
 *
 *   2. WHAT PRINTS MUST VALIDATE. invoiceDocRows() filters rows on truthiness,
 *      and num(-50) is truthy — so a row whose only content was a negative
 *      amount reached the customer's PDF and preview_totals while the validator
 *      skipped it and realLines() dropped it from line_items. The two predicates
 *      are pinned equal here so they cannot drift apart again.
 *
 *   3. A CREDIT LINE HAS NO GOODS BEHIND IT, so its cost is a KNOWN $0 — a
 *      derivation from the SIGN, which is the opposite of ERR-068's read of an
 *      ABSENCE as zero. costOrNull's "empty box = UNKNOWN" invariant is
 *      untouched for product lines and is re-pinned below to prove it.
 *
 *   4. THE BACKEND WILL NOT QUOTE A CREDIT. `unit_cost_excl_gst` is validated
 *      server-side as `>= 0` and one negative 400s the whole request
 *      (npm run probe:invoice-quote §6d), so quoteRequestBody omits it — and the
 *      freight row has to SAY the goods total excludes it, because an omission
 *      that changes a free-shipping decision must never be silent.
 *
 * Run with: node --test tests/admin-invoice-negative-line-aug2026.test.js
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
const QUICK_ORDER = fs.readFileSync(path.join(ADMIN, 'pages', 'quick-order.js'), 'utf8');
const PATCH_SRC = fs.readFileSync(path.join(ADMIN, 'utils', 'line-row-patch.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');
const PROBE = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'probe-invoice-quote.mjs'), 'utf8');

// Same ESM→sandbox trick the sibling invoice suites use (admin-invoice-cost-math).
function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.window = undefined;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
// Each module gets its own function scope: invoice-math.js and invoice-quote.js
// both declare a private `const num`, which would collide at the top level of one
// shared realm. Their EXPORTS still land on globalThis (stripEsm appends that),
// so a later module resolves an earlier one's imports as free variables.
for (const f of ['profitability.js', 'invoice-math.js', 'invoice-quote.js']) {
  const src = stripEsm(fs.readFileSync(path.join(ADMIN, 'utils', f), 'utf8'));
  vm.runInContext(`(function () {\n${src}\n})()`, ctx, { filename: f });
}
const {
  costOrNull, lineSupplierCost, lineCostExGst, computeInvoiceTotals, computeInvoiceCogs,
  computeInvoiceProfit, normalizeInvoice, invoiceDocRows,
  quoteRequestBody, applyQuoteToLines, hasCreditLine, PRICE_MANUAL,
} = sandbox;

// Values built inside the vm realm carry that realm's prototypes, so deepEqual
// sees "same structure, not reference-equal". Round-trip through JSON first —
// the same trick admin-invoice-cost-math.test.js uses.
const plain = (x) => JSON.parse(JSON.stringify(x));

/** Lift a function body out of the page module by brace matching. */
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

/**
 * Reconstruct validateInvoice() out of invoices.js and run it for real.
 *
 * Source-pinning this one would be worthless: the whole point is which VALUES it
 * accepts, and "the file contains this regex" cannot answer that. Only the
 * helpers it actually reaches are injected, so the harness cannot accidentally
 * pass by supplying behaviour the page does not have.
 */
function loadValidate() {
  const src = [
    fnBody(INVOICES, 'function validateInvoice('),
    fnBody(INVOICES, 'function isPricedAmount('),
  ].join('\n\n');
  const factory = new vm.Script(`(function (num, lines, computeTotals, money) {
    ${src}
    return validateInvoice;
  })`).runInContext(ctx);
  return factory(
    (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; },
    (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
    (d) => computeInvoiceTotals(d),
    (n) => `$${Number(n).toFixed(2)}`,
  );
}
const validateInvoice = loadValidate();

/** A draft that is valid in every respect except the lines handed in. */
const draftWith = (lines, extra = {}) => ({
  customer: { name: 'Acme Ltd', address: '1 Queen St\nAuckland' },
  order_date: '2026-08-20',
  freight: 0,
  lines,
  ...extra,
});
const GOODS = { code: 'IC', description: 'Ink Cartridge', qty: 1, unitCost: 99, supplierCost: 54, costSource: 'manual' };
const priceErrs = (d) => validateInvoice(d).filter((e) => e.lfield === 'unitCost');

// ─── 1. The price rule ───────────────────────────────────────────────────────

test('§1 a NEGATIVE unit price is accepted — this is the whole feature', () => {
  const d = draftWith([GOODS, { code: '', description: 'Already paid — invoice 3271', qty: 1, unitCost: -40 }]);
  assert.deepEqual(plain(validateInvoice(d)), [], 'a credit line must not block the save');
});

test('§1 an authored $0 is accepted; a BLANK box is not', () => {
  // ERR-178's distinction, now enforced on the sell side too: an authored $0 is
  // a decision ("this one is free"); an empty box is an unfinished row.
  assert.deepEqual(plain(priceErrs(draftWith([{ ...GOODS, unitCost: 0 }]))), []);
  assert.deepEqual(plain(priceErrs(draftWith([{ ...GOODS, unitCost: '0' }]))), []);
  const blank = priceErrs(draftWith([{ ...GOODS, unitCost: '' }]));
  assert.equal(blank.length, 1);
  assert.match(blank[0].msg, /unit price required/);
});

test('§1 a non-numeric price is rejected, never coerced to 0', () => {
  // num() would turn 'abc' into 0 and let it through as a "free" line.
  for (const bad of ['abc', null, undefined, '   ']) {
    assert.equal(priceErrs(draftWith([{ ...GOODS, unitCost: bad }])).length, 1, `${bad} must be rejected`);
  }
});

test('§1 the message names the PRICE, matching the column header', () => {
  // It used to say "unit cost required" — the same words a refused NEGATIVE got,
  // which is how a rejected figure read as a missing one.
  assert.match(priceErrs(draftWith([{ ...GOODS, unitCost: '' }]))[0].msg, /unit price/);
  assert.match(INVOICES, /<span>Unit Price\$\{gstSub\(GST_EXCL\)\}<\/span>/);
});

test('§1 a fresh blank row is not reported as a missing PRICE', () => {
  // blankLine() seeds unitCost: 0 as a NUMBER — a falsiness test here would
  // flag every new row the moment it appeared.
  assert.match(INVOICES, /const blankLine = \(\) => \(\{\s*\n?\s*code: '', description: '', qty: 1, unitCost: 0/);
  const fresh = { code: '', description: '', qty: 1, unitCost: 0 };
  assert.deepEqual(plain(priceErrs(draftWith([fresh]))), []);
  assert.ok(validateInvoice(draftWith([fresh])).some((e) => e.lfield === 'code'),
    'it is still blocked — on the thing that is actually missing');
});

// ─── 2. What prints must validate ────────────────────────────────────────────

test('§2 the validator and the DOCUMENT agree on what counts as a row', () => {
  // THE BUG THIS CLOSES: invoiceDocRows filters on truthiness and num(-50) is
  // truthy, so a negative-only row printed on the customer's invoice and landed
  // in preview_totals while validateInvoice skipped it and realLines() kept it
  // out of line_items. The document and the stored invoice differed by the
  // credit. Pinned as an INVARIANT, not as a line of source.
  // Every candidate is code-less AND description-less, so "the validator looked
  // at it" shows up unambiguously as a `code or description required` against
  // that row. A complete GOODS line sits at index 0 so the empty-invoice branch
  // (which reports against line 0) can never be mistaken for a per-row verdict.
  const rows = [
    { code: '', description: '', qty: 0, unitCost: -50 },   // the row that used to slip through
    { code: '', description: '', qty: 0, unitCost: 0 },     // a true phantom
    { code: '', description: '', qty: 1, unitCost: 0 },
    { code: '', description: '', qty: 0, unitCost: 0.5 },
  ];
  for (const l of rows) {
    const printed = invoiceDocRows({ lines: [l] }, { money: String }).length === 1;
    const validated = validateInvoice(draftWith([GOODS, l])).some((e) => e.line === 1);
    assert.equal(printed, validated,
      `row ${JSON.stringify(l)}: printed=${printed} but validated=${validated} — a row on the customer's document must be a row the validator checked`);
  }
});

test('§2 the started filter tests !== 0, never > 0', () => {
  const body = fnBody(INVOICES, 'function validateInvoice(');
  assert.match(body, /num\(l\.unitCost\) !== 0/);
  assert.doesNotMatch(body, /num\(l\.unitCost\) > 0/);
});

// ─── 3. Totals are not clamped ───────────────────────────────────────────────

test('§3 a credit line moves subtotal, GST and total DOWN — nothing is floored', () => {
  const t = computeInvoiceTotals({ lines: [{ qty: 1, unitCost: 99 }, { qty: 1, unitCost: -40 }], freight: 0 });
  assert.equal(t.subtotal, 59);
  assert.equal(t.gst, 8.85);          // 59 × 0.15 — the credit reduces the GST too
  assert.equal(t.total, 67.85);
});

test('§3 a credit against the whole sale settles at exactly $0', () => {
  const t = computeInvoiceTotals({ lines: [{ qty: 1, unitCost: 99 }, { qty: 1, unitCost: -99 }], freight: 0 });
  assert.equal(t.subtotal, 0);
  assert.equal(t.total, 0);
});

test('§3 qty multiplies a credit like any other line', () => {
  assert.equal(computeInvoiceTotals({ lines: [{ qty: 3, unitCost: -10 }] }).subtotal, -30);
});

// ─── 4. An invoice may not go below zero ─────────────────────────────────────

test('§4 credits that exceed the charges are refused — that is a credit note', () => {
  const errs = validateInvoice(draftWith([GOODS, { code: '', description: 'Credit', qty: 1, unitCost: -200 }]));
  const neg = errs.filter((e) => /exceed the charges/.test(e.msg));
  assert.equal(neg.length, 1);
  assert.equal(neg[0].line, 1, 'it points at the credit line, which is the box that must change');
  assert.equal(neg[0].lfield, 'unitCost');
  assert.match(neg[0].msg, /-\$?/, 'the message states the total it computed');
});

test('§4 a $0 invoice is LEGAL — "you already paid for all of it"', () => {
  const d = draftWith([GOODS, { code: '', description: 'Already paid', qty: 1, unitCost: -99 }]);
  assert.deepEqual(plain(validateInvoice(d)), [], '$0.00 is the point of the feature, not an error');
});

test('§4 the guard fires just below zero, not at it', () => {
  const at = draftWith([{ ...GOODS, unitCost: 99 }, { code: '', description: 'c', qty: 1, unitCost: -99 }]);
  const below = draftWith([{ ...GOODS, unitCost: 99 }, { code: '', description: 'c', qty: 1, unitCost: -99.01 }]);
  assert.equal(validateInvoice(at).length, 0);
  assert.equal(validateInvoice(below).filter((e) => /exceed the charges/.test(e.msg)).length, 1);
});

test('§4 a NEGATIVE freight is refused — it would print as "Free"', () => {
  // min="0" on that box is inert (the editor is a <div>, not a <form>), and both
  // document renderers test `t.freight > 0`, so -20 prints as "Free" while still
  // pulling $20 out of the total.
  const errs = validateInvoice(draftWith([GOODS], { freight: -20 }));
  assert.equal(errs.filter((e) => e.field === 'freight').length, 1);
  assert.deepEqual(plain(validateInvoice(draftWith([GOODS], { freight: 0 }))), [], '0 freight is "Free" and always was');
  for (const r of ['renderPreview(', 'buildInvoiceDoc(']) {
    assert.match(fnBody(INVOICES, `function ${r}`), /t\.freight > 0 \?/,
      'if this stops being the test, the freight guard above needs revisiting');
  }
});

// ─── 5. A credit line's cost is a KNOWN zero ─────────────────────────────────

test('§5 costOrNull is UNTOUCHED — an empty box on a product line is still UNKNOWN', () => {
  // ERR-068's invariant. The credit rule is a separate function precisely so
  // this one keeps its meaning.
  assert.equal(costOrNull(''), null);
  assert.equal(costOrNull(0), 0);
  assert.equal(costOrNull(-1), null, 'a negative supplier cost is still not a thing');
});

test('§5 a blank cost on a CREDIT line is a known $0, not unknown', () => {
  assert.equal(lineSupplierCost({ unitCost: -99, supplierCost: null }), 0);
  assert.equal(lineSupplierCost({ unitCost: -99, supplierCost: '' }), 0);
});

test('§5 a blank cost on a POSITIVE line is still UNKNOWN', () => {
  assert.equal(lineSupplierCost({ unitCost: 99, supplierCost: '' }), null);
  assert.equal(lineSupplierCost({ unitCost: 0, supplierCost: '' }), null,
    'a $0 sell price is not a credit — nobody has costed this line');
});

test('§5 an AUTO-FILLED cost never survives onto a credit line', () => {
  // The realistic flow: pick product A (the picker sets supplierCost with
  // costSource 'auto'), then type -100 over its price. Booking A's real $30
  // against negative revenue understates the margin AND ships a false COGS.
  assert.equal(lineSupplierCost({ unitCost: -100, supplierCost: 30, costSource: 'auto' }), 0);
  assert.equal(lineSupplierCost({ unitCost: -100, supplierCost: 30, costSource: 'manual' }), 30,
    'a cost the operator typed themselves still wins');
});

test('§5 it reads a SAVED record, whose price key is unit_cost_excl_gst', () => {
  // Miss this and every reopened credit line reads as cost-unknown, collapsing
  // the invoice list's Profit column to "—" — "nobody costed this", which is false.
  assert.equal(lineSupplierCost({ unit_cost_excl_gst: -99, supplier_cost_excl_gst: null }), 0);
});

test('§5 a credit line of any quantity still costs us nothing', () => {
  assert.equal(lineCostExGst({ qty: 4, unitCost: -25, supplierCost: null }), 0);
});

test('§5 the margin survives a credit line instead of collapsing to "—"', () => {
  const d = { lines: [GOODS, { code: '', description: 'Already paid', qty: 1, unitCost: -40 }], freight: 0 };
  const cogs = computeInvoiceCogs(d);
  assert.equal(cogs.unknownLines, 0, 'the credit line is costed, so nothing is unknown');
  assert.equal(cogs.costExGst, 54);
  assert.equal(computeInvoiceProfit(d), 5, 'revenue 59 − cost 54');
});

test('§5 a saved credit invoice normalizes to the same figures the editor showed', () => {
  const n = normalizeInvoice({
    line_items: [
      { product_code: 'IC', quantity: 1, unit_cost_excl_gst: 99, supplier_cost_excl_gst: 54, cost_source: 'manual' },
      { product_code: '', description: 'Already paid', quantity: 1, unit_cost_excl_gst: -40, supplier_cost_excl_gst: null },
    ],
    freight_excl_gst: 0,
  });
  assert.equal(n.allCostsKnown, true, 'a reopened credit line must not read as uncosted');
  assert.equal(n.costExGst, 54);
  assert.equal(n.revenueExGst, 59);
  assert.equal(n.profit, 5);
});

test('§5 buildPayload ships the negative price and the derived $0 cost', () => {
  const body = fnBody(INVOICES, 'function buildPayload(');
  assert.match(body, /unit_cost_excl_gst: round2\(num\(l\.unitCost\)\)/, 'sign-preserving, unclamped');
  assert.match(body, /supplier_cost_excl_gst: lineSupplierCost\(l\)/,
    'must be the same rule the margin bar used, or the editor and the backend disagree');
});

// ─── 6. The backend will not quote a credit ──────────────────────────────────

test('§6 a negative manual price is left OUT of the quote body', () => {
  // Measured, not assumed: the endpoint validates this field as >= 0 and 400s
  // the WHOLE request over one bad line (probe §6d). Sending it would freeze the
  // courier dropdown and the free-shipping banner for every line on the invoice.
  const { body } = quoteRequestBody({
    lines: [
      { code: 'IC', description: 'Ink', qty: 1, unitCost: 99, priceSource: PRICE_MANUAL },
      { code: '', description: 'Already paid', qty: 1, unitCost: -40, priceSource: PRICE_MANUAL },
    ],
  });
  assert.equal(body.line_items[0].unit_cost_excl_gst, 99);
  assert.ok(!('unit_cost_excl_gst' in body.line_items[1]), 'a credit line carries no price');
  assert.equal(body.line_items.length, 2, 'but it keeps its SLOT — positions index the request 1:1');
});

test('§6 the probe is what proves that, and it is still there', () => {
  assert.match(PROBE, /6d\./, 'the negative-price case must survive in the probe');
  assert.match(PROBE, /unit_cost_excl_gst: -150\.00/);
});

test('§6 the omission is SAID OUT LOUD in the freight row', () => {
  // An omission that changes a free-shipping decision must never be silent —
  // the goods total beside the courier picker excludes credit lines.
  assert.equal(hasCreditLine([{ unitCost: 99 }, { unitCost: -1 }]), true);
  assert.equal(hasCreditLine([{ unitCost: 99 }, { unitCost: 0 }]), false);
  const row = fnBody(INVOICES, 'function renderShippingRow(');
  assert.match(row, /hasCreditLine\(_draft\?\.lines\)/);
  assert.match(row, /CREDIT_NOT_IN_THRESHOLD/);
  assert.match(INVOICES, /const CREDIT_NOT_IN_THRESHOLD = '[^']*not counted[^']*'/);
});

test('§6 the volume ladder never OFFERS to overwrite a credit line', () => {
  // A credit built on a real product still resolves, so the ladder still prices
  // it — and the offer button writes that price straight in. One click would
  // turn "−$99.00 already paid" into a "+$53.53" charge.
  const quote = {
    lines: [{ position: 1, resolved: true, unit_excl_gst: 56.95, quantity: 7,
      volume: { unit_excl_gst: 53.53, effective_percent: 6, discount_percent: 6, line_saving_excl_gst: 23.94 } }],
    shipping: { options: [], goods_total_incl_gst: 0 },
  };
  const out = applyQuoteToLines(
    [{ code: 'GLC73BK', qty: 7, unitCost: -99, priceSource: PRICE_MANUAL }],
    normalizeQuoteFor(quote),
  );
  assert.equal(out.lines[0].unitCost, -99, 'the credit is never overwritten');
  assert.deepEqual(plain(out.offers), [], 'and it is never offered away either');
});
function normalizeQuoteFor(q) { return sandbox.normalizeQuote(q); }

test('§6 a backend refusal is translated, not echoed as raw Joi', () => {
  // The user chose to ship without a write test, so the FIRST person to learn
  // whether the save path shares the quote schema is the operator. That has to
  // arrive as a sentence they can act on.
  const body = fnBody(INVOICES, 'function saveErrorMessage(');
  assert.match(body, /unit_cost_excl_gst[\s\S]{0,90}greater than or equal to 0/,
    'match the exact Joi wording the sibling endpoint returns');
  assert.match(body, /BF-050/, 'name the ticket so the message is chaseable');
  const fn = new vm.Script(`(function () { ${body}\n return saveErrorMessage; })()`).runInContext(ctx);
  const msg = fn({
    message: 'Validation failed',
    details: [{ field: 'line_items.1.unit_cost_excl_gst', message: '"line_items[1].unit_cost_excl_gst" must be greater than or equal to 0' }],
  });
  assert.match(msg, /credit line/i);
  assert.doesNotMatch(msg, /Joi|line_items\[1\]/, 'the operator never sees the raw field path');
  // An unrelated failure still reports itself verbatim.
  assert.match(fn({ message: 'Customer name is required' }), /Customer name is required/);
});

// ─── 7. The operator can see it ──────────────────────────────────────────────

test('§7 the price box no longer carries min="0", but qty and Our Cost still do', () => {
  const row = fnBody(INVOICES, 'function renderLines(');
  const price = row.match(/<input[^>]*data-lfield="unitCost"[^>]*>/)[0];
  assert.doesNotMatch(price, /min="0"/, 'a credit line cannot be typed into a box floored at 0');
  assert.match(price, /step="0\.01"/);
  assert.match(row.match(/<input[^>]*data-lfield="qty"[^>]*>/)[0], /min="0"/,
    'a negative QUANTITY is still not a thing');
  assert.match(row.match(/<input[^>]*data-lfield="supplierCost"[^>]*>/s)[0], /min="0"/,
    'nor is a negative cost-to-us — costOrNull says so too');
});

test('§7 a credit price is styled distinctly — one character separates 99 from -99', () => {
  assert.match(CSS, /\.inv-line__price--credit\s*\{/);
  assert.match(fnBody(INVOICES, 'function renderLines('), /inv-line__price--credit/);
});

test('§7 the affordance keeps up with typing, WITHOUT re-rendering the row', () => {
  // Re-rendering the grid under the caret is ERR-179 exactly. markCreditRow
  // touches the existing nodes and writes no .value.
  const body = fnBody(INVOICES, 'function markCreditRow(');
  assert.match(body, /classList\.toggle\('inv-line__price--credit'/);
  // The placeholder is kept in sync — pinned as THAT, not as the expression that
  // produces it. It has since moved into costPlaceholder(), which owns all four
  // cases; markCreditRow holding its own copy is exactly the bug ERR-182 found.
  assert.match(body, /\.placeholder = costPlaceholder\(/);
  assert.doesNotMatch(body, /\.value\s*=/, 'never write a value into a box the operator is typing in');
  assert.match(fnBody(INVOICES, 'function onFormInput('), /markCreditRow\(t, i\)/);
});

test('§7 the shared row patcher keeps the credit class in sync too', () => {
  // Shared with Quick Order (ERR-179): both editors patch through this file, so
  // an affordance set only in renderLines() would go stale on a quote reply.
  assert.match(PATCH_SRC, /const CREDIT_CLASS = 'inv-line__price--credit'/);
  assert.match(PATCH_SRC, /classList\.toggle\(CREDIT_CLASS, linePrice\(line\) < 0\)/);
});

test('§7 the margin bar does not report a credited-to-zero invoice as "cost unknown"', () => {
  const body = fnBody(INVOICES, 'function renderCogsPanel(');
  assert.match(body, /if \(profit == null\)/,
    'costs known + no positive revenue is its own state, not the unknown-cost one');
  assert.match(body, /nothing to measure a margin on/);
  assert.equal(computeInvoiceProfit({ lines: [{ code: 'A', qty: 1, unitCost: 99, supplierCost: 54 },
    { code: '', description: 'c', qty: 1, unitCost: -99 }], freight: 0 }), null,
    'computeOrderProfit refuses a revenue of zero — that is what the branch is for');
});

// ─── 8. The customer's document ──────────────────────────────────────────────

test('§8 a credit line PRINTS, with an ASCII minus jsPDF can render', () => {
  const rows = invoiceDocRows(
    { lines: [{ code: '', description: 'Already paid — invoice 3271', qty: 1, unitCost: -40 }] },
    { money: (n) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(n) },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 5, 'FOUR printed columns plus the note slot — a fifth is how our margin leaks');
  const printed = rows[0][3];
  assert.ok(printed.includes('-'), `expected an ASCII hyphen-minus, got ${JSON.stringify(printed)}`);
  assert.ok(!printed.includes('−'),
    'buildInvoiceDoc writes this straight into jsPDF\'s WinAnsi font with no ascii() normalisation — a U+2212 would print garbled on the one line that matters');
});

// ─── 9. Scope ────────────────────────────────────────────────────────────────

test('§9 Quick Order is deliberately untouched, and still cannot reject a price', () => {
  // Recorded so the asymmetry is a decision, not a discovery. Quick Order's
  // validate() checks neither qty nor price, so it already accepted negatives;
  // the bridge carries them into the invoice editor as PRICE_MANUAL.
  assert.doesNotMatch(fnBody(QUICK_ORDER, 'function validate('), /unitPrice/,
    'if Quick Order grows a price rule, it must allow credits too');
  assert.match(INVOICES, /priceSource: PRICE_MANUAL/);
});

// ─── 10. Returning browsers get the new build ────────────────────────────────

test('§10 APP_VERSION was bumped', () => {
  const app = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');
  const m = app.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m, 'APP_VERSION cache-busts every admin page module');
  assert.notEqual(m[1], '2026.08.28-invoice-send-count',
    'page modules import with ?v=APP_VERSION; a stale token leaves live browsers on the old build');
});
