/**
 * Invoice LINE DISCOUNTS — money off, in a shape the invoice service will store
 * =============================================================================
 *
 * The owner typed a −$40.00 credit row and could not save it. Not a bug in the
 * editor: the invoice service refuses every route to a lower total. Measured
 * against production, 2026-08-28:
 *
 *   negative unit_cost_excl_gst  → 400, "must be greater than or equal to 0"
 *   negative quantity            → 400, "must be greater than or equal to 0"
 *   negative line_total_excl_gst → 200, IGNORED (goods total recomputed)
 *   a discount_excl_gst key      → 200, IGNORED (undiscounted goods total)
 *
 * Every total is recomputed as quantity × unit_cost_excl_gst, and both factors
 * are floored at zero. So a standalone credit row cannot exist on a saved
 * invoice, and the discount has to come off the line it applies to.
 *
 * THE INVARIANT THIS WHOLE DESIGN RESTS ON, pinned in §1: for every line,
 *
 *     what the document PRINTS  ===  quantity × what the payload SENDS
 *
 * The discount is applied once, into `unitCost`, and never re-derived at payload
 * time — because a division there is exactly how a cent of drift between the
 * customer's copy and the stored record would get in. `discountSaving` is a
 * DISPLAY fact about a price that already carries the money, the same way
 * `volumeSaving` has always been.
 *
 * Run with: node --test tests/admin-invoice-discount-aug2026.test.js
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
const PATCH_SRC = fs.readFileSync(path.join(ADMIN, 'utils', 'line-row-patch.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');

function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.window = undefined; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of ['profitability.js', 'invoice-math.js', 'invoice-quote.js']) {
  vm.runInContext(`(function () {\n${stripEsm(fs.readFileSync(path.join(ADMIN, 'utils', f), 'utf8'))}\n})()`, ctx, { filename: f });
}
const {
  invoiceDocRows, computeInvoiceTotals, lineRevenueExGst,
  lineDocNote, hasManualDiscount, clearDiscount, applyQuoteToLines, normalizeQuote, PRICE_MANUAL,
} = sandbox;

const plain = (x) => JSON.parse(JSON.stringify(x));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${Number(n).toFixed(2)}`;

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
 * Rebuild the real discount actions and run them. `_draft` and the DOM readers
 * are injected, so the arithmetic under test is the shipped arithmetic.
 */
function loadActions(draft, inputs = {}) {
  const src = [
    fnBody(INVOICES, 'function applyLineDiscount('),
    fnBody(INVOICES, 'function undoLineDiscount('),
    fnBody(INVOICES, 'function foldCreditIntoPrevious('),
  ].join('\n\n');
  const warnings = [];
  const body = {
    querySelector: (sel) => {
      const m = /\[data-disc-(amt|why)="(\d+)"\]/.exec(sel);
      if (!m) return null;
      const v = (inputs[m[2]] || {})[m[1] === 'amt' ? 'amount' : 'why'];
      return v === undefined ? null : { value: String(v) };
    },
  };
  const api = new vm.Script(`(function (_draft, _editorRefs, num, round2, money, Toast,
      clearVolume, clearDiscount, PRICE_MANUAL, blankLine, renderLines, refreshPreview, scheduleQuote) {
    ${src}
    return { applyLineDiscount, undoLineDiscount, foldCreditIntoPrevious };
  })`).runInContext(ctx)(
    draft,
    { drawer: { body } },
    (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; },
    round2, money,
    { warning: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    sandbox.clearVolume, sandbox.clearDiscount, PRICE_MANUAL,
    () => ({ code: '', description: '', qty: 1, unitCost: 0 }),
    () => {}, () => {}, () => {},
  );
  return { ...api, warnings, draft };
}

const GOODS = () => ({
  code: 'IC', description: 'Ink Cartridge', qty: 1, unitCost: 99,
  supplierCost: 54, costSource: 'manual', priceSource: 'manual',
  volumePercent: null, volumeSaving: null, volumeQuantity: null,
  discountSaving: null, discountNote: '',
});

// ─── 1. THE INVARIANT: printed === quantity × sent ───────────────────────────

test('§1 what prints equals quantity × what the payload sends, to the cent', () => {
  // THE REASON THIS DESIGN IS SAFE. The discount is applied ONCE into unitCost;
  // the payload sends that number and the backend recomputes qty × it. If the
  // discount were instead divided out at payload time, a rounded unit price on a
  // multi-quantity line would leave the customer's copy and the stored invoice a
  // cent apart, with nothing to notice it.
  for (const [qty, price, amount] of [[1, 99, 40], [3, 99, 10], [7, 56.95, 23.94], [2, 10, 0.01], [3, 33.33, 100]]) {
    const draft = { lines: [{ ...GOODS(), qty, unitCost: price }] };
    const { applyLineDiscount } = loadActions(draft, { 0: { amount, why: 'x' } });
    applyLineDiscount(0);
    const l = draft.lines[0];
    const sent = round2(l.unitCost);                    // exactly what buildPayload ships
    assert.equal(l.unitCost, sent, 'the stored unit price is already rounded');
    // To the CENT: lineRevenueExGst is a raw float (7 × 53.53 is
    // 374.71000000000004 in IEEE754) and every surface that shows it rounds —
    // money() through Intl, computeInvoiceTotals through round2. The claim is
    // that the money agrees, not that two floats are bit-identical.
    assert.equal(round2(lineRevenueExGst(l)), round2(qty * sent),
      `qty ${qty} @ ${price} less ${amount}: printed ${round2(lineRevenueExGst(l))} vs backend ${round2(qty * sent)}`);
    assert.ok(sent >= 0, 'and nothing is ever negative — the one thing the server refuses');
  }
});

test('§1 the recorded saving is what the price ACTUALLY moved by', () => {
  // qty 3 and $10 off cannot land exactly: 10/3 per unit does not round cleanly.
  // The note must state the money really taken off, not the figure typed.
  const draft = { lines: [{ ...GOODS(), qty: 3, unitCost: 99 }] };
  const { applyLineDiscount } = loadActions(draft, { 0: { amount: 10, why: 'goodwill' } });
  applyLineDiscount(0);
  const l = draft.lines[0];
  assert.equal(l.unitCost, 95.67, '99 − 10/3, rounded once');
  assert.equal(l.discountSaving, round2((99 - 95.67) * 3), 'derived from the price, not from the input');
  assert.equal(l.discountSaving, 9.99, 'and it says 9.99 — because that is what came off');
});

// ─── 2. Applying, undoing, and the limits ────────────────────────────────────

test('§2 a discount nets the price and records why', () => {
  const draft = { lines: [GOODS()] };
  const { applyLineDiscount } = loadActions(draft, { 0: { amount: 40, why: 'already paid on invoice 3271' } });
  applyLineDiscount(0);
  assert.equal(draft.lines[0].unitCost, 59);
  assert.equal(draft.lines[0].discountSaving, 40);
  assert.equal(draft.lines[0].discountNote, 'already paid on invoice 3271');
  assert.equal(draft.lines[0].priceSource, PRICE_MANUAL, 'ours now — the ladder must not re-price it');
  assert.equal(computeInvoiceTotals(draft).total, 67.85, '59 + 15% GST');
});

test('§2 a discount bigger than the line is refused, not clamped', () => {
  // Past the line's value it stops being a discount and becomes a credit — the
  // thing the service will not store at all. Clamping would hide that; letting
  // it through would only move the failure to Save.
  const draft = { lines: [GOODS()] };
  const { applyLineDiscount, warnings } = loadActions(draft, { 0: { amount: 150, why: '' } });
  applyLineDiscount(0);
  assert.equal(draft.lines[0].unitCost, 99, 'the price is untouched');
  assert.equal(draft.lines[0].discountSaving, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /more than this line is worth/);
});

test('§2 a discount equal to the whole line is allowed — that is a free item', () => {
  const draft = { lines: [GOODS()] };
  const { applyLineDiscount } = loadActions(draft, { 0: { amount: 99, why: 'already paid' } });
  applyLineDiscount(0);
  assert.equal(draft.lines[0].unitCost, 0);
  assert.equal(computeInvoiceTotals(draft).total, 0, '$0.00 is legal — it was the point of the feature');
});

test('§2 zero or blank is refused with a nudge, not silently ignored', () => {
  const draft = { lines: [GOODS()] };
  const { applyLineDiscount, warnings } = loadActions(draft, { 0: { amount: '', why: 'x' } });
  applyLineDiscount(0);
  assert.equal(draft.lines[0].unitCost, 99);
  assert.match(warnings[0], /how much to take off/);
});

test('§2 undo puts the price back exactly', () => {
  const draft = { lines: [GOODS()] };
  const a = loadActions(draft, { 0: { amount: 40, why: 'x' } });
  a.applyLineDiscount(0);
  a.undoLineDiscount(0);
  assert.equal(draft.lines[0].unitCost, 99);
  assert.equal(draft.lines[0].discountSaving, null);
  assert.equal(draft.lines[0].discountNote, '');
});

// ─── 3. Folding a typed credit row ───────────────────────────────────────────

test('§3 "Apply to the line above" folds a credit and leaves the total unchanged', () => {
  const draft = { lines: [GOODS(), { code: '', description: 'Already paid — invoice 3271', qty: 1, unitCost: -40 }] };
  const before = computeInvoiceTotals(draft).total;
  loadActions(draft).foldCreditIntoPrevious(1);
  assert.equal(draft.lines.length, 1, 'the credit row is gone');
  assert.equal(draft.lines[0].unitCost, 59);
  assert.equal(draft.lines[0].discountSaving, 40);
  assert.equal(draft.lines[0].discountNote, 'Already paid — invoice 3271',
    'the credit row said why; that is the reason the customer should see');
  assert.equal(computeInvoiceTotals(draft).total, before,
    'THE MONEY DOES NOT MOVE — only the shape the server will accept');
});

test('§3 folding adds to a discount already on the line', () => {
  const draft = { lines: [{ ...GOODS(), unitCost: 89, discountSaving: 10, discountNote: 'first' }],
  };
  draft.lines.push({ code: '', description: 'and another', qty: 1, unitCost: -9 });
  loadActions(draft).foldCreditIntoPrevious(1);
  assert.equal(draft.lines[0].unitCost, 80);
  assert.equal(draft.lines[0].discountSaving, 19, 'the savings accumulate');
});

test('§3 a credit bigger than the line above is refused', () => {
  const draft = { lines: [GOODS(), { code: '', description: 'too big', qty: 1, unitCost: -200 }] };
  const { foldCreditIntoPrevious, warnings } = loadActions(draft);
  foldCreditIntoPrevious(1);
  assert.equal(draft.lines.length, 2, 'nothing is folded');
  assert.equal(draft.lines[0].unitCost, 99);
  assert.match(warnings[0], /bigger than the line above/);
});

test('§3 folding is now an OFFER, not a rescue', () => {
  // Since BF-050 a credit row saves on its own and prints as its own line, so
  // the row must stop claiming otherwise. Folding it into the line above is the
  // same money said as a discount on one row instead of two — a choice about how
  // the document reads, which is the operator's to make.
  const body = fnBody(INVOICES, 'function lineQuoteNote(');
  assert.match(body, /num\(l\.unitCost\) < 0 && i > 0/);
  assert.match(body, /data-form-action="fold-credit"/);
  assert.match(body, /prints as its own row/, 'state what it does now, not what it was once blocked from');
  assert.doesNotMatch(body, /can’t be saved/, 'that limitation is gone — repeating it would be a lie');
});

test('§3 the credit row and the discount are the same money, two documents', () => {
  const asCredit = { lines: [GOODS(), { code: '', description: 'Already paid', qty: 1, unitCost: -40 }], freight: 0 };
  const asDiscount = { lines: [{ ...GOODS(), unitCost: 59, discountSaving: 40, discountNote: 'Already paid' }], freight: 0 };
  assert.equal(computeInvoiceTotals(asCredit).total, computeInvoiceTotals(asDiscount).total,
    'the customer pays the same either way — only how the document reads differs');
  assert.equal(computeInvoiceTotals(asCredit).total, 67.85);
  // Two printed rows vs one with a sub-line.
  assert.equal(invoiceDocRows(asCredit, { money, note: lineDocNote }).length, 2);
  assert.equal(invoiceDocRows(asDiscount, { money, note: lineDocNote }).length, 1);
});

// ─── 4. The customer's document ──────────────────────────────────────────────

test('§4 the reason prints under the description', () => {
  assert.equal(lineDocNote({ discountSaving: 40, discountNote: 'already paid on invoice 3271' }),
    '$40.00 off — already paid on invoice 3271');
  assert.equal(lineDocNote({ discountSaving: 40, discountNote: '' }), '$40.00 off',
    'a discount with no reason still says a discount was given');
  assert.equal(lineDocNote({ discountSaving: 0 }), '');
  assert.equal(lineDocNote({}), '');
});

test('§4 a manual discount outranks a bulk claim, and bulk still works alone', () => {
  assert.equal(lineDocNote({ discountSaving: 40, discountNote: 'x', volumePercent: 6, volumeQuantity: 7 }),
    '$40.00 off — x', 'the more specific statement wins');
  assert.equal(lineDocNote({ volumePercent: 6, volumeQuantity: 7 }), 'Bulk price — 6% off at 7+',
    'the volume note is untouched');
});

test('§4 the note reaches the document projection, in ASCII jsPDF can render', () => {
  const rows = invoiceDocRows(
    { lines: [{ code: 'IC', description: 'Ink Cartridge', qty: 1, unitCost: 59, supplierCost: 54, discountSaving: 40, discountNote: 'already paid' }] },
    { money, note: lineDocNote },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 5, 'FOUR printed columns plus the note slot — a fifth is how our margin leaks');
  assert.equal(rows[0][3], '$59.00', 'the printed line total is the NET figure');
  assert.equal(rows[0][4], '$40.00 off — already paid');
  assert.ok(!/[−]/.test(rows[0][4]), 'U+2212 would print garbled in jsPDF\'s WinAnsi font');
});

test('§4 both renderers use the same projection, and neither grew a column', () => {
  for (const fn of ['function renderPreview(', 'function buildInvoiceDoc(']) {
    const body = fnBody(INVOICES, fn);
    assert.match(body, /invoiceDocRows\(d, \{ money, note: lineDocNote \}\)/,
      `${fn} must print the note the same way`);
  }
  assert.match(fnBody(INVOICES, 'function buildInvoiceDoc('), /\$\{description\}\\n\$\{bulkNote\}/,
    'the note is a second LINE of the description cell, never a fifth cell');
});

// ─── 5. The claim cannot outlive the price it describes ──────────────────────

test('§5 retyping the price clears the discount claim', () => {
  // "$40.00 off" is a statement about a number the operator has just replaced.
  // Re-deriving it against the new one would invent a discount nobody gave.
  const body = fnBody(INVOICES, 'function onFormInput(');
  assert.match(body, /clearDiscount\(clearVolume\(_draft\.lines\[i\]\)\)/);
  assert.deepEqual(plain(clearDiscount({ unitCost: 59, discountSaving: 40, discountNote: 'x' })),
    { unitCost: 59, discountSaving: null, discountNote: '' });
});

test('§5 a quote reply must NOT withdraw a discount the operator gave', () => {
  // The MANUAL branch clears the VOLUME trio, because that describes a price the
  // ladder set. It has no standing over one the operator set.
  const quote = normalizeQuote({
    lines: [{ position: 0, resolved: true, unit_excl_gst: 99, quantity: 1, volume: null }],
    shipping: { options: [], goods_total_incl_gst: 0 },
  });
  const out = applyQuoteToLines([{ code: 'IC', qty: 1, unitCost: 59, priceSource: PRICE_MANUAL, discountSaving: 40, discountNote: 'already paid' }], quote);
  assert.equal(out.lines[0].unitCost, 59);
  assert.equal(out.lines[0].discountSaving, 40, 'the discount survives the quote');
  assert.equal(out.lines[0].discountNote, 'already paid');
});

test('§5 the ladder never OFFERS to overwrite a discounted line', () => {
  // The sign test alone stopped covering this the moment discounts existed: a
  // discounted line is MANUAL and POSITIVE, so it sails through. One click on
  // "Apply volume price" would silently undo the $40 the operator took off.
  // position 0, matching draft index 0. Get this wrong and the quote line pairs
  // with no draft line at all, no badge is produced, and the test passes whether
  // or not the guard exists — which is exactly how the credit-line version of
  // this test came to be vacuous.
  const quote = normalizeQuote({
    lines: [{ position: 0, resolved: true, unit_excl_gst: 56.95, quantity: 7,
      volume: { unit_excl_gst: 53.53, effective_percent: 6, discount_percent: 6, line_saving_excl_gst: 23.94 } }],
    shipping: { options: [], goods_total_incl_gst: 0 },
  });
  const discounted = applyQuoteToLines(
    [{ code: 'GLC73BK', qty: 7, unitCost: 50, priceSource: PRICE_MANUAL, discountSaving: 40, discountNote: 'x' }], quote);
  assert.deepEqual(plain(discounted.offers), [], 'no offer on a discounted line');
  assert.equal(discounted.lines[0].unitCost, 50);

  // …but an ordinary hand-typed price is still offered the better one.
  const plainManual = applyQuoteToLines(
    [{ code: 'GLC73BK', qty: 7, unitCost: 50, priceSource: PRICE_MANUAL }], quote);
  assert.equal(plainManual.offers.length, 1, 'the offer still works where it should');
});

test('§5 hasManualDiscount is true only for a real, positive saving', () => {
  assert.equal(hasManualDiscount({ discountSaving: 40 }), true);
  assert.equal(hasManualDiscount({ discountSaving: 0 }), false);
  assert.equal(hasManualDiscount({ discountSaving: null }), false);
  assert.equal(hasManualDiscount({}), false);
});

// ─── 6. Where it lives on screen ─────────────────────────────────────────────

test('§6 the discount INPUTS are outside the note strip the quote patches', () => {
  // patchQuotedLineRows replaces .inv-line__note wholesale on every quote reply.
  // An input living inside it would be destroyed under the caret — ERR-179.
  const row = fnBody(INVOICES, 'function lineDiscountRow(');
  assert.match(row, /inv-line__disc/);
  assert.doesNotMatch(row, /inv-line__note/, 'the inputs must not be in the patched element');
  assert.match(PATCH_SRC, /querySelector\('\.inv-line__note'\)/, 'which is still the only thing it patches');
  assert.doesNotMatch(PATCH_SRC, /inv-line__disc/);
});

test('§6 the discount row renders BEFORE the note, so a patch cannot reorder them', () => {
  // The patcher APPENDS a note that did not exist before, so the discount row
  // has to come first for the order to survive both a full render and a patch.
  const body = fnBody(INVOICES, 'function renderLines(');
  assert.ok(body.indexOf('lineDiscountRow(l, i)') < body.indexOf('lineQuoteNote(l, i)'),
    'discount row first');
  assert.match(PATCH_SRC, /insertAdjacentHTML\('beforeend', html\)/, 'the append this ordering assumes');
});

test('§6 the sub-row spans the shared grid rather than adding a column', () => {
  // .inv-line is shared verbatim with Quick Order; a seventh column would
  // misalign every one of its rows.
  assert.match(CSS, /\.inv-line__disc\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  const block = CSS.slice(CSS.indexOf('.inv-line__disc'), CSS.indexOf('.inv-line__disc') + 400);
  assert.doesNotMatch(block, /grid-template-columns/);
});

// ─── 7. The payload ──────────────────────────────────────────────────────────

test('§7 the payload sends the net price and the display-only pair', () => {
  const items = (() => {
    const b = fnBody(INVOICES, 'function buildPayload(');
    return b.slice(b.indexOf('line_items:'), b.indexOf('freight_excl_gst'));
  })();
  assert.match(items, /unit_cost_excl_gst: round2\(num\(l\.unitCost\)\)/,
    'unchanged — unitCost is ALREADY net, which is the whole trick');
  assert.match(items, /discount_saving_excl_gst: l\.discountSaving \?\? null/);
  assert.match(items, /discount_note: \(l\.discountNote \|\| ''\)\.trim\(\) \|\| null/);
  assert.doesNotMatch(items, /\.\.\.l\b/, 'still a whitelist — a spread would leak discountOpen');
});

test('§7 the dropped-key warning covers the discount reason too', () => {
  // Same position as product_ref (BF-051) and the volume fields (BF-043): no
  // column, so the wording is lost on reopen while the price is not. One
  // sentence for both, and it self-heals when either column lands.
  assert.match(INVOICES, /const DISPLAY_ONLY_KEYS = \[[^\]]*'discount_note'/);
  assert.match(INVOICES, /const REF_NOT_STORED = [\s\S]{0,400}discount reasons/);
  assert.match(INVOICES, /BF-051/);
});

// ─── 8. Returning browsers get the new build ────────────────────────────────

test('§8 APP_VERSION was bumped', () => {
  const app = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');
  const m = app.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m);
  assert.notEqual(m[1], '2026.08.28-invoice-line-discount');
});
