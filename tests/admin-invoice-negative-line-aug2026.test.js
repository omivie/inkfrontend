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
 *   4. THE BACKEND QUOTES AND STORES A CREDIT — since BF-050, 2026-08-29.
 *      `unit_cost_excl_gst`, `quantity`, `supplier_cost_excl_gst` and
 *      `freight_excl_gst` all take any sign and zero, on create, update and
 *      /quote, and a credit SUBTRACTS from goods_total_incl_gst (probe §6d/§6e).
 *      quoteRequestBody sends negatives, and the "excluded from the threshold"
 *      warning is gone with the constraint that caused it.
 *
 *   5. WHAT IS STILL REFUSED IS THE DOCUMENT TOTAL, AND IT IS NOT OUR RULE.
 *      Exactly $0.00 saves (201); one cent below returns 500 `Failed to create
 *      invoice` (BF-052, handoff at
 *      readfirst/invoice-negative-total-backend-handoff-aug2026.md). The guard in
 *      validateInvoice is the only thing between the operator and that 500, so it
 *      stays — and §4 below is where that is written down.
 *
 *   6. A COST THE OPERATOR TYPED IS THEIRS, SIGN INCLUDED. manualCostOrNull
 *      reads the box; costOrNull still refuses a negative for DERIVED costs, and
 *      that split is re-pinned below so neither half drifts into the other.
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
  costOrNull, manualCostOrNull, lineSupplierCost, lineCostExGst, computeInvoiceTotals, computeInvoiceCogs,
  computeInvoiceProfit, normalizeInvoice, invoiceDocRows,
  quoteRequestBody, applyQuoteToLines, PRICE_MANUAL,
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

test('§1 a NEGATIVE unit price SAVES — BF-050 lifted the floor', () => {
  // This assertion has now been true, then false, then true again, and the
  // history is the point. It was the feature (ERR-181); then the invoice service
  // was found to refuse it on every route, so the editor blocked it with a
  // one-click way out (ERR-183); then the backend lifted `>= 0` on price AND
  // quantity and made a credit SUBTRACT from the quote (verified live
  // 2026-08-29). A credit row is now a first-class line that prints as its own
  // row — which is what the owner asked for on day one.
  const d = draftWith([GOODS, { code: '', description: 'Already paid — invoice 3271', qty: 1, unitCost: -40 }]);
  assert.deepEqual(plain(validateInvoice(d)), [], 'nothing may block a credit line now');
  assert.equal(computeInvoiceTotals(d).total, 67.85, '99 − 40 = 59, +15% GST');
});

test('§1 a credit needs no line above it — a pure credit note is a real document', () => {
  // The backend deliberately did NOT add a total >= 0 rule, so that a pure
  // credit note stays issuable. The editor's own below-zero guard is the only
  // one, and it fires on the TOTAL, never on a line's position.
  const d = draftWith([{ code: '', description: 'Already paid', qty: 1, unitCost: -40 }, GOODS]);
  assert.deepEqual(plain(validateInvoice(d)), [], 'order of lines is the operator’s business');
});

test('§1 a NEGATIVE quantity is legal — it is how a RETURN is modelled', () => {
  // The shape that keeps the margin honest: -1 × $60 sell at $40 cost reverses
  // revenue AND cost together, moving profit by the original $20 margin. Booking
  // it as 1 × -$60 would subtract the revenue but still ADD the $40 cost and
  // report a $100 loss on a $60 refund.
  const ret = { code: 'GTN251BK', description: 'Returned toner', qty: -1, unitCost: 60, supplierCost: 40, costSource: 'manual' };
  assert.deepEqual(plain(validateInvoice(draftWith([{ ...GOODS, unitCost: 200 }, ret]))), []);
  assert.equal(computeInvoiceTotals({ lines: [ret], freight: 0 }).subtotal, -60);
  assert.equal(computeInvoiceCogs({ lines: [ret] }).costExGst, -40, 'the cost reverses too — that is the whole point');
});

test('§1 a QUANTITY is a number of either sign, and ZERO is one of them', () => {
  // Zero used to be refused, and it was OUR rule alone: the invoice service takes
  // `quantity: 0` (BF-050, verified live 2026-08-29). It is a real shape — a line
  // the customer should READ but not be charged for. Worse, the refusal said
  // "quantity required", the same words a blank box gets, so a rejected figure
  // was indistinguishable from a missing one; that is the exact defect ERR-181
  // fixed on the price box, recurring one column over.
  const qtyErrs = (d) => validateInvoice(d).filter((e) => e.lfield === 'qty');
  assert.deepEqual(plain(qtyErrs(draftWith([{ ...GOODS, qty: 0 }]))), [], 'zero is accepted');
  assert.deepEqual(plain(qtyErrs(draftWith([{ ...GOODS, qty: '0' }]))), [], 'and as a string');
  assert.deepEqual(plain(qtyErrs(draftWith([{ ...GOODS, qty: -1 }]))), [], 'so is a negative');
  // THE POSITIVE CONTROL. Without it this test would pass just as well against a
  // validateInvoice with no quantity rule at all — which is how ERR-181's guard
  // test passed for the wrong reason. Blank and non-numeric are still refused.
  for (const bad of ['', '   ', 'abc', null, undefined]) {
    assert.equal(qtyErrs(draftWith([{ ...GOODS, qty: bad }])).length, 1, `${bad} must still be refused`);
  }
});

test('§1 a ZERO-quantity row still PRINTS what it validates — the three predicates agree', () => {
  // The row is only real because of its description; a qty of 0 is falsy in both
  // invoiceDocRows' filter and validateInvoice's `started` filter, so a row whose
  // ONLY content is a zero quantity stays an ignored phantom in both. That
  // agreement is the invariant this suite exists to protect.
  const d = draftWith([{ code: '', description: 'Backordered — not charged', qty: 0, unitCost: 0 }]);
  assert.deepEqual(plain(validateInvoice(d)), [], 'a described $0 × 0 line is a complete row');
  const rows = invoiceDocRows(d, { money: (n) => `$${Number(n).toFixed(2)}` });
  assert.equal(rows.length, 1, 'and it prints');
  assert.equal(rows[0][2], '0');
  assert.equal(rows[0][3], '$0.00');
  const phantom = draftWith([{ code: '', description: '', qty: 0, unitCost: 0 }]);
  assert.equal(invoiceDocRows(phantom, { money: String }).length, 0, 'an empty row still prints nothing');
  assert.equal(validateInvoice(phantom).filter((e) => /at least one line item/.test(e.msg)).length, 1,
    'and is still not a line item');
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

test('§3 a total that rounds to nothing is $0.00, never -$0.00', () => {
  // NEGATIVE ZERO IS A REAL RENDERING BUG, not a pedantry: Math.round(-0.33) is
  // -0, and Intl formats that as "-$0.00" — a minus sign on a customer's invoice
  // for a line worth nothing. It became reachable the day the "a discount may not
  // exceed its line" cap came out ($100 off a 3 × $33.33 line lands a third of a
  // cent below zero), so round2 normalises it at the source.
  const t = computeInvoiceTotals({ lines: [{ qty: 1, unitCost: -0.001 }], freight: 0 });
  for (const [k, v] of Object.entries(t)) {
    assert.ok(!Object.is(v, -0), `${k} came back as -0, which prints as "-$0.00"`);
  }
  assert.equal(new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(t.total), '$0.00');
  // The control: a real negative is still negative, and still prints as one.
  assert.equal(computeInvoiceTotals({ lines: [{ qty: 1, unitCost: -10 }], freight: 0 }).total, -11.5);
});

// ─── 4. An invoice may not go below zero ─────────────────────────────────────

test('§4 a below-zero total is refused, and the message says WHOSE limit it is', () => {
  const errs = validateInvoice(draftWith([GOODS, { code: '', description: 'Credit', qty: 1, unitCost: -200 }]));
  const neg = errs.filter((e) => /below \$0\.00/.test(e.msg));
  assert.equal(neg.length, 1);
  assert.equal(neg[0].line, 1, 'it points at the credit line, which is the box that must change');
  assert.equal(neg[0].lfield, 'unitCost');
  // Three things the operator needs and cannot get anywhere else: the number, who
  // is refusing it, and what to do instead. A refusal with no route around it is
  // just a wall — and this one is not our policy, so it must not read as one.
  assert.match(neg[0].msg, /116\.15/, 'the total it actually computed');
  assert.match(neg[0].msg, /invoice service|server error/, 'that the SERVER is the one refusing');
  assert.match(neg[0].msg, /BF-052/, 'the ticket, so it can be chased');
  assert.match(neg[0].msg, /negative quantity/, 'the shape that DOES work today');
  assert.doesNotMatch(neg[0].msg, /exceed the charges/,
    'the old wording read as a rule of ours about credit lines');
});

test('§4 a $0 invoice is LEGAL — "you already paid for all of it"', () => {
  // Reached through a DISCOUNT now rather than a credit row, because that is the
  // shape the invoice service will store: the price is already net, and nothing
  // anywhere is negative. The outcome the owner asked for is unchanged.
  const d = draftWith([{ ...GOODS, unitCost: 0, discountSaving: 99, discountNote: 'already paid' }]);
  assert.deepEqual(plain(validateInvoice(d)), [], '$0.00 is the point of the feature, not an error');
  assert.equal(computeInvoiceTotals(d).total, 0);
});

test('§4 the below-zero guard is the ONLY guard, and it is load-bearing', () => {
  // Now the single most important rule in this file. The backend deliberately
  // did NOT add a total >= 0 check ("validateInvoice in the editor stays the
  // guard, and it is the only one — please keep it") — but measured on
  // 2026-08-29, a negative-total invoice does not merely pass, it **500s**:
  // `Failed to create invoice`, with nothing an operator could act on. Exactly
  // $0 saves fine; one cent below does not. BF-052.
  //
  // So this guard is the only thing standing between the operator and an opaque
  // server error. Do not relax it until that 500 is a 201 or a 400 — the ask is
  // readfirst/invoice-negative-total-backend-handoff-aug2026.md, and when it
  // lands, DELETE the block rather than softening the message.
  //
  // It is also, now, the LAST money refusal in this editor. Zero quantities,
  // zero prices, negative prices, negative quantities, negative freight and a
  // negative typed cost are all accepted; if a second one ever reappears beside
  // this, it needs the same standard of proof — a measured server refusal.
  const below = draftWith([{ ...GOODS, unitCost: -0.01 }]);
  assert.equal(validateInvoice(below).filter((e) => /below \$0\.00/.test(e.msg)).length, 1);
  assert.equal(validateInvoice(draftWith([GOODS])).length, 0, 'and never fires on an ordinary invoice');
  assert.match(INVOICES, /readfirst\/invoice-negative-total-backend-handoff-aug2026\.md/,
    'the source says where the ask lives, so the guard can be removed by whoever sees it land');
});

test('§4 a NEGATIVE freight is a freight CREDIT, and prints as one', () => {
  // It used to be refused, and the stated reason was never the sign — it was
  // that both renderers tested `t.freight > 0`, so -20 printed as "Free" while
  // still taking $20 off the total. Fix the render and the refusal has no
  // grounds left; BF-050 lifted the server's floor in the same week.
  assert.deepEqual(plain(validateInvoice(draftWith([GOODS], { freight: -20 }))), []);
  for (const r of ['renderPreview(', 'buildInvoiceDoc(']) {
    const body = fnBody(INVOICES, `function ${r}`);
    assert.match(body, /t\.freight === 0 \? 'Free' : money\(t\.freight\)/,
      'ONLY zero is Free — a negative must print as the credit it is');
    assert.doesNotMatch(body, /t\.freight > 0 \? money/, 'the old test that hid a credit');
  }
  assert.equal(computeInvoiceTotals(draftWith([GOODS], { freight: -20 })).subtotal, 99);
});

// ─── 5. A credit line's cost is a KNOWN zero ─────────────────────────────────

test('§5 costOrNull is UNTOUCHED — an empty box on a product line is still UNKNOWN', () => {
  // ERR-068's invariant. The credit rule is a separate function precisely so
  // this one keeps its meaning.
  assert.equal(costOrNull(''), null);
  assert.equal(costOrNull(0), 0);
  // THE CONTROL for the manualCostOrNull split below. costOrNull reads costs we
  // DERIVED — a catalogue cost_price, an order's supplier_cost_snapshot, the
  // backend's cost_excl_gst — and none of those may be negative; one that is is a
  // corrupt reading, not a claim. If this line ever needs relaxing, the split
  // has collapsed and ERR-068's domain has been widened by accident.
  assert.equal(costOrNull(-1), null, 'a DERIVED cost below zero is corruption, not a value');
});

test('§5 manualCostOrNull keeps a TYPED cost, sign and all — it used to vanish', () => {
  // The silent one. The operator typed -5 into Our Cost; costOrNull read it as
  // null, so the box emptied on reopen, the Profit column fell back to "—", and
  // NOTHING anywhere said the figure had been discarded. A value the operator
  // authored is theirs: refuse it out loud or keep it, never swallow it. The
  // service accepts a negative supplier_cost_excl_gst (BF-050, live 2026-08-29).
  assert.equal(manualCostOrNull(-5), -5);
  assert.equal(manualCostOrNull(0), 0);
  assert.equal(manualCostOrNull('-5.50'), -5.5);
  // Blank is still UNKNOWN — this widens the SIGN, never ERR-068's absence rule.
  assert.equal(manualCostOrNull(''), null);
  assert.equal(manualCostOrNull(null), null);
  assert.equal(manualCostOrNull(undefined), null);
  assert.equal(manualCostOrNull('abc'), null);
});

test('§5 a typed negative cost survives lineSupplierCost, the payload and a reopen', () => {
  const typed = { unitCost: 99, supplierCost: -5, costSource: 'manual' };
  assert.equal(lineSupplierCost(typed), -5, 'the editor and the payload read the same number');
  assert.equal(lineCostExGst({ ...typed, qty: 3 }), -15, 'and quantity multiplies it like any cost');
  // A record off the backend spells it the other way; the same answer must come
  // back, or the margin bar disagrees with itself across a save.
  assert.equal(lineSupplierCost({ unit_cost_excl_gst: 99, supplier_cost_excl_gst: -5, cost_source: 'manual' }), -5);
  const rec = normalizeInvoice({
    line_items: [{ product_code: 'IC', description: 'Ink', quantity: 1, unit_cost_excl_gst: 99,
      supplier_cost_excl_gst: -5, cost_source: 'manual' }],
  });
  assert.equal(rec.lines[0].supplierCost, -5, 'a reopened invoice still knows what it cost');
  assert.equal(rec.lines[0].costSource, 'manual',
    'the PROVENANCE rides along — without it computeInvoiceCogs re-reads the same '
    + 'number as though nobody typed it and reports the cost UNKNOWN (ERR-178 shape)');
  assert.equal(rec.allCostsKnown, true, 'and it is KNOWN, not "—"');
  // THE CONTROL: an AUTO cost below zero is still refused, so this widened the
  // typed box and nothing else.
  assert.equal(lineSupplierCost({ unitCost: 99, supplierCost: -5, costSource: 'auto' }), null);
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

test('§6 a negative manual price IS sent to the quote, so the threshold is honest', () => {
  // The omission is gone. Verified live 2026-08-29: the endpoint accepts the
  // negative and SUBTRACTS it from goods_total_incl_gst, so free shipping is
  // finally judged on what the customer actually pays.
  const { body } = quoteRequestBody({
    lines: [
      { code: 'IC', description: 'Ink', qty: 1, unitCost: 99, priceSource: PRICE_MANUAL },
      { code: '', description: 'Already paid', qty: 1, unitCost: -40, priceSource: PRICE_MANUAL },
    ],
  });
  assert.equal(body.line_items[0].unit_cost_excl_gst, 99);
  assert.equal(body.line_items[1].unit_cost_excl_gst, -40, 'the credit must reach the goods total');
  assert.equal(body.line_items.length, 2, 'and every line keeps its SLOT — positions index the request 1:1');
});

test('§6 the probe is what proves that, and it is still there', () => {
  assert.match(PROBE, /6d\./, 'the negative-price case must survive in the probe');
  assert.match(PROBE, /unit_cost_excl_gst: -150\.00/);
  assert.match(PROBE, /6e\./, 'and the negative-QUANTITY case');
  assert.match(PROBE, /quantity: -1/);
  // Zero quantity is now typeable, so the live claim behind it needs a probe of
  // its own. What is measured is not just "accepted" but "contributes nothing" —
  // a backend reading 0 as "unspecified" and substituting 1 would charge for a
  // line the document says is free, and free shipping would be decided on it.
  assert.match(PROBE, /6f\./, 'and the ZERO-quantity case');
  assert.match(PROBE, /quantity: 0, unit_cost_excl_gst: 80\.00/);
  // BF-052 is deliberately absent: proving a 500 on a below-zero TOTAL needs a
  // POST /api/admin/invoices, and this probe has no write path by design.
  assert.match(PROBE, /readfirst\/invoice-negative-total-backend-handoff-aug2026\.md/,
    'the probe says where that one is measured instead, so its absence is not read as coverage');
});

test('§6 the warning about that omission is GONE, because the omission is', () => {
  // Kept as a test rather than simply deleted: a warning that outlives the thing
  // it warned about is worse than none, because the operator starts pricing
  // around a limitation that no longer exists.
  assert.doesNotMatch(INVOICES, /CREDIT_NOT_IN_THRESHOLD/);
  assert.doesNotMatch(INVOICES, /hasCreditLine/);
  assert.doesNotMatch(fnBody(INVOICES, 'function renderShippingRow('), /not counted/);
});

test('§6 the volume ladder never OFFERS to overwrite a credit line', () => {
  // A credit built on a real product still resolves, so the ladder still prices
  // it — and the offer button writes that price straight in. One click would
  // turn "−$99.00 already paid" into a "+$53.53" charge.
  // position 0 pairs with draft index 0. This said `position: 1` until the
  // discount work, which meant the quote line matched NO draft line, no badge
  // was ever produced, and the assertion below passed whether or not the guard
  // existed. A test that cannot fail is not a test — always prove the fixture
  // reaches the code (the sibling test in admin-invoice-discount-aug2026 keeps a
  // positive control for exactly that reason).
  const quote = {
    lines: [{ position: 0, resolved: true, unit_excl_gst: 56.95, quantity: 7,
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

test('§6 the BF-050 translation is gone — the 400 it explained cannot happen', () => {
  // Its own comment said "delete this branch when BF-050 lands, not before".
  // A translation for an impossible error is dead code that reads as a live
  // limitation to the next person who finds it.
  const body = fnBody(INVOICES, 'function saveErrorMessage(');
  assert.doesNotMatch(body, /greater than or equal to 0/);
  assert.doesNotMatch(body, /will not accept a credit line/);
  // Real failures still report themselves verbatim.
  const fn = new vm.Script(`(function () { ${body}\n return saveErrorMessage; })()`).runInContext(ctx);
  assert.match(fn({ message: 'Customer name is required' }), /Customer name is required/);
  assert.match(fn({ message: 'Validation failed', details: [{ message: 'something else entirely' }] }),
    /something else entirely/);
});

// ─── 7. The operator can see it ──────────────────────────────────────────────

test('§7 NO money box in this editor is floored any more', () => {
  // `min="0"` never enforced anything here — the editor is a <div>, not a <form>,
  // nothing in js/admin/ calls checkValidity(), and admin.css has no :invalid
  // rule. All it ever did was shape the spinner arrows and TELL the operator a
  // limit existed. Every one of these was residue of a server refusal that has
  // since been lifted, and residue reads as a live limitation (ERR-184).
  const row = fnBody(INVOICES, 'function renderLines(');
  const price = row.match(/<input[^>]*data-lfield="unitCost"[^>]*>/)[0];
  assert.doesNotMatch(price, /min="0"/, 'a credit line cannot be typed into a box floored at 0');
  assert.match(price, /step="0\.01"/);
  assert.doesNotMatch(row.match(/<input[^>]*data-lfield="qty"[^>]*>/)[0], /min="0"/,
    'a negative QUANTITY is a RETURN — the box must not floor it');
  assert.doesNotMatch(row.match(/<input[^>]*data-lfield="supplierCost"[^>]*>/s)[0], /min="0"/,
    'a cost the operator types is theirs, sign included — manualCostOrNull reads it');
  assert.doesNotMatch(INVOICES.match(/<input[^>]*data-field="freight"[^>]*>/s)[0], /min="0"/,
    'negative freight is a freight CREDIT and has printed as one since ERR-184');
  // THE CONTROL, and the reason this is not just "delete every min": the discount
  // box is still floored, because it is backed by a real check in
  // applyLineDiscount and it means "how much to take OFF".
  assert.match(INVOICES.match(/<input[^>]*data-disc-amt[^>]*>/s)[0], /min="0"/,
    'the discount amount is a magnitude, not a signed price');
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
  assert.notEqual(m[1], '2026.08.29-invoice-credit-lines-live',
    'page modules import with ?v=APP_VERSION; a stale token leaves live browsers on the old build');
});
