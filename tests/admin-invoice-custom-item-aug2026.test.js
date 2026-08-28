/**
 * Invoice CUSTOM ITEMS — a reference you can type, that never becomes a SKU
 * =========================================================================
 *
 * The owner asked to "enter anything within the invoice custom and it should
 * work". One input box was doing two unrelated jobs, and conflating them is why
 * that looked impossible:
 *
 *   code (→ product_code)  WHICH CATALOGUE PRODUCT THIS IS. A real products.sku
 *                          or empty — never anything else. The backend matches
 *                          line items by SKU when it materialises the shadow
 *                          order; a code that matches nothing DROPS THE LINE and
 *                          leaves a paid order with no items (ERR-071, invoices
 *                          #3263/#3264). It also 400s the save outright.
 *   ref  (→ product_ref)   WHAT THE CUSTOMER SEES in the Product Code column.
 *                          Free text, never resolved against anything.
 *
 * SO THE HEADLINE INVARIANT OF THIS SUITE: a custom item's text reaches the
 * DOCUMENT and never reaches product_code. If a test here starts failing because
 * a ref leaked into product_code, that is ERR-071 coming back — fix the code,
 * never the test.
 *
 * The second theme is that three predicates all answer "is this row real?" —
 * validateInvoice's `started` filter, realLines() (what gets SAVED) and
 * invoiceDocRows() (what gets PRINTED). They disagreed once before and a row
 * printed on the customer's invoice while being dropped from the payload
 * (ERR-181). `ref` is now a member of all three, pinned equal below.
 *
 * Run with: node --test tests/admin-invoice-custom-item-aug2026.test.js
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
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');

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
for (const f of ['profitability.js', 'invoice-math.js', 'invoice-quote.js', 'line-codes.js']) {
  const src = stripEsm(fs.readFileSync(path.join(ADMIN, 'utils', f), 'utf8'));
  vm.runInContext(`(function () {\n${src}\n})()`, ctx, { filename: f });
}
const { invoiceDocRows, codesToVerify, applyResolvedCodes, quoteRequestBody, PRICE_MANUAL } = sandbox;

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

/** Rebuild the pure page-level predicates and run them for real. */
function loadPagePure() {
  // The real declaration, not a stub: the whole point of the echo tests is that
  // the list of display-only keys is the one the payload actually uses.
  const keys = INVOICES.match(/const DISPLAY_ONLY_KEYS = \[[^\]]*\];/);
  assert.ok(keys, 'DISPLAY_ONLY_KEYS must exist — refEchoMissing is driven by it');
  const src = [
    keys[0],
    fnBody(INVOICES, 'function validateInvoice('),
    fnBody(INVOICES, 'function isPricedAmount('),
    fnBody(INVOICES, 'const realLines ='),
    fnBody(INVOICES, 'function refEchoMissing('),
    fnBody(INVOICES, 'function costPlaceholder('),
  ].join('\n\n');
  return new vm.Script(`(function (num, lines, computeTotals, money, isCustomLine) {
    ${src}
    return { validateInvoice, realLines, refEchoMissing, costPlaceholder };
  })`).runInContext(ctx)(
    (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; },
    (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
    (d) => sandbox.computeInvoiceTotals(d),
    (n) => `$${Number(n).toFixed(2)}`,
    (l) => l?.kind === 'custom',
  );
}
const { validateInvoice, realLines, refEchoMissing, costPlaceholder } = loadPagePure();

const CUSTOM = { kind: 'custom', code: '', ref: 'REFURB-01', description: 'Refurbished drum unit', qty: 1, unitCost: 180, supplierCost: 120, costSource: 'manual', priceSource: 'manual' };
const draftWith = (ls, extra = {}) => ({
  customer: { name: 'Acme Ltd', address: '1 Queen St\nAuckland' },
  order_date: '2026-08-20', freight: 0, lines: ls, ...extra,
});

// ─── 1. THE HEADLINE: a ref never becomes a product_code ─────────────────────

test('§1 buildPayload sends the ref in its OWN field, and product_code stays empty', () => {
  // If this ever fails because product_code carries the ref, ERR-071 is back:
  // the shadow order matches by SKU, finds nothing, and drops the line.
  const body = fnBody(INVOICES, 'function buildPayload(');
  const items = body.slice(body.indexOf('line_items:'), body.indexOf('freight_excl_gst'));
  assert.match(items, /product_code: l\.code/, 'product_code is the catalogue identity, only ever l.code');
  assert.match(items, /product_ref: \(l\.ref \|\| ''\)\.trim\(\) \|\| null/);
  assert.doesNotMatch(items, /product_code: l\.ref|product_code: \(l\.ref/,
    'THE ONE THING THAT MUST NEVER HAPPEN — a ref in product_code drops the line server-side');
  assert.doesNotMatch(items, /\.\.\.l\b/, 'still a whitelist — a spread would leak `kind` too');
});

test('§1 the SKU gate never even sees a custom item', () => {
  // Not an exemption bolted onto line-codes.js — a custom line's `code` is empty,
  // and an empty code has been legal since ERR-071. The gate is untouched, which
  // is why admin-invoice-sku-integrity.test.js still passes unmodified.
  assert.deepEqual(plain(codesToVerify([CUSTOM])), [], 'nothing to ask the catalogue about');
  assert.deepEqual(plain(applyResolvedCodes([{ ...CUSTOM }], new Map())), [],
    'an EMPTY catalogue (a real "matched nothing") still must not block a custom item');
});

test('§1 a real SKU on an ordinary line is still gated exactly as before', () => {
  const errs = applyResolvedCodes([{ code: 'CTN258', description: 'typo' }], new Map());
  assert.equal(errs.length, 1, 'the ERR-071 guard must not have been loosened');
  assert.equal(errs[0].lfield, 'code');
});

test('§1 the quote body carries no ref — the endpoint has no idea it exists', () => {
  const { body } = quoteRequestBody({ lines: [{ ...CUSTOM, priceSource: PRICE_MANUAL }] });
  assert.equal(body.line_items[0].product_code, '');
  assert.ok(!('product_ref' in body.line_items[0]), 'ref is ours, not the pricing engine’s');
});

// ─── 2. It reaches the customer's document ───────────────────────────────────

test('§2 the ref PRINTS in the Product Code column', () => {
  const rows = invoiceDocRows({ lines: [CUSTOM] }, { money: (n) => `$${n.toFixed(2)}` });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'REFURB-01', 'this is the whole point of the feature');
  assert.equal(rows[0][1], 'Refurbished drum unit');
  assert.equal(rows[0][3], '$180.00');
  assert.equal(rows[0].length, 5, 'FOUR printed columns plus the note slot — a fifth leaks our margin');
});

test('§2 an ordinary line still prints its SKU', () => {
  const rows = invoiceDocRows({ lines: [{ code: 'CTN258XLKCMY', description: 'Canon ink', qty: 1, unitCost: 99 }] },
    { money: (n) => `$${n.toFixed(2)}` });
  assert.equal(rows[0][0], 'CTN258XLKCMY');
});

test('§2 a custom item with no ref prints a blank code, exactly like freight always has', () => {
  const rows = invoiceDocRows({ lines: [{ ...CUSTOM, ref: '' }] }, { money: (n) => `$${n.toFixed(2)}` });
  assert.equal(rows[0][0], '', 'the ref is optional — the description identifies the item');
});

// ─── 3. All three "is this row real?" predicates agree ───────────────────────

test('§3 ref counts as content for VALIDATION, SAVING and PRINTING alike', () => {
  // ERR-181's lesson: while these disagreed, a row printed on the customer's
  // invoice and was dropped from line_items. Pinned as an equality, not three
  // separate assertions, so they cannot drift apart again.
  const rows = [
    { code: '', ref: 'REFURB-01', description: '', qty: 0, unitCost: 0 },  // ref alone = real
    { code: '', ref: '', description: '', qty: 0, unitCost: 0 },           // a true phantom
    { code: '', ref: '', description: 'Labour', qty: 0, unitCost: 0 },
  ];
  for (const l of rows) {
    const printed = invoiceDocRows({ lines: [l] }, { money: String }).length === 1;
    const saved = realLines({ lines: [l] }).length === 1;
    const validated = validateInvoice(draftWith([{ code: 'X', description: 'goods', qty: 1, unitCost: 9 }, l]))
      .some((e) => e.line === 1);
    assert.equal(printed, saved,
      `row ${JSON.stringify(l)}: printed=${printed} saved=${saved} — the document and the stored invoice must contain the same rows`);
    assert.equal(printed, validated,
      `row ${JSON.stringify(l)}: printed=${printed} validated=${validated} — a printed row must be a checked row`);
  }
});

test('§3 a custom item still needs a DESCRIPTION — a bare ref is not an item', () => {
  // `code or description required` already says this; a custom line's code is
  // always empty, so the rule lands on the description with no special case.
  const errs = validateInvoice(draftWith([{ ...CUSTOM, description: '' }]));
  assert.ok(errs.some((e) => e.lfield === 'code' && /code or description/.test(e.msg)));
  assert.deepEqual(plain(validateInvoice(draftWith([CUSTOM]))), [], 'a complete custom item saves');
});

// ─── 4. The margin stays honest ──────────────────────────────────────────────

test('§4 a custom line asks for its cost instead of promising "auto"', () => {
  // Nothing auto-fills a non-catalogue line: productCostExGst is only reachable
  // from the picker's onPick. Saying "auto" would promise a snapshot that never
  // happens, and a blank cost prints the invoice at 100% margin on the LIST
  // (BF-047) — the operator typing the figure is what makes that number true.
  assert.equal(costPlaceholder({ kind: 'custom', unitCost: 180 }), 'needs a cost');
  assert.equal(costPlaceholder({ kind: 'shipping', unitCost: 20 }), 'courier cost');
  assert.equal(costPlaceholder({ unitCost: 99 }), 'auto');
  assert.equal(costPlaceholder({ unitCost: -40 }), '0.00 — credit', 'the credit rule still wins');
});

test('§4 nothing keeps a SECOND copy of the placeholder rules', () => {
  // Caught in the browser: markCreditRow carried its own two-case version, so
  // typing a price on a custom line reset the box from "needs a cost" back to
  // "auto" — the right answer overwritten by a stale copy of the same question.
  const body = fnBody(INVOICES, 'function markCreditRow(');
  assert.match(body, /costPlaceholder\(_draft\.lines\[i\]\)/);
  assert.doesNotMatch(body, /'courier cost'|'auto'/,
    'one question, one function — a second copy silently goes stale');
  const renders = INVOICES.split('\n').filter((ln) => /placeholder\s*[=:]/.test(ln) && /cost/i.test(ln));
  for (const ln of renders) {
    assert.match(ln, /costPlaceholder/, `a cost placeholder set outside costPlaceholder(): ${ln.trim()}`);
  }
});

test('§4 an uncosted custom line still reports the margin as unknown, never as profit', () => {
  const cogs = sandbox.computeInvoiceCogs({ lines: [{ ...CUSTOM, supplierCost: null, costSource: 'auto' }] });
  assert.equal(cogs.allKnown, false, 'UNKNOWN is not zero — ERR-068');
  assert.equal(cogs.unknownLines, 1);
  assert.equal(sandbox.computeInvoiceProfit({ lines: [{ ...CUSTOM, supplierCost: null }] }), null);
});

test('§4 a costed custom line computes like any other', () => {
  assert.equal(sandbox.computeInvoiceProfit({ lines: [CUSTOM], freight: 0 }), 60, '180 revenue − 120 cost');
});

// ─── 5. The operator finds out while typing, not at save ────────────────────

test('§5 the code check runs on FOCUSOUT — mid-typing is not a wrong SKU', () => {
  const body = fnBody(INVOICES, 'function onFormFocusOut(');
  assert.match(body, /lfield === 'code'/);
  assert.match(body, /scheduleCodeCheck/);
});

test('§5 "we could not ask" is never rendered as "not a SKU"', () => {
  // resolveSkus returns null on an outage of OURS. Recording that as false would
  // accuse every good code the operator typed. Same discipline as the save gate.
  const body = fnBody(INVOICES, 'async function runCodeChecks(');
  assert.match(body, /if \(!resolved\) return;/, 'null must record nothing at all');
  const known = fnBody(INVOICES, 'function codeIsKnownBad(');
  assert.match(known, /=== false/, 'only a recorded false is a real no — undefined renders nothing');
});

test('§5 the answer is keyed by CODE, never by row index', () => {
  // Rows are added, removed and reordered; an answer pinned to position 2 would
  // end up describing whatever moved into position 2.
  const body = fnBody(INVOICES, 'async function runCodeChecks(');
  assert.match(body, /_codeChecks\.set\(c\.toLowerCase\(\)/);
  assert.doesNotMatch(body, /_codeChecks\.set\(i\b/);
});

test('§5 the note offers the way OUT, not just the complaint', () => {
  const body = fnBody(INVOICES, 'function lineQuoteNote(');
  assert.match(body, /codeIsKnownBad\(l\)/);
  assert.match(body, /data-form-action="make-custom"/, 'one click, because the text was something they meant');
  assert.match(body, /isn.t a catalogue SKU/);
});

test('§5 "Keep as a custom item" MOVES the text — it never leaves it in code', () => {
  const body = fnBody(INVOICES, 'function makeLineCustom(');
  assert.match(body, /ref: \(l\.ref \|\| ''\)\.trim\(\) \|\| typed/);
  assert.match(body, /code: ''/, 'the typed text must leave product_code entirely');
  assert.match(body, /priceSource: PRICE_MANUAL/, 'nothing can quote a non-catalogue item');
  assert.match(body, /clearVolume/, 'a volume badge would describe a ladder never consulted');
});

test('§5 repainting the note never rebuilds the grid (ERR-179)', () => {
  const body = fnBody(INVOICES, 'function repaintLineNotes(');
  assert.doesNotMatch(body, /renderLines\(\)/,
    'the operator has just tabbed into the next box — rebuilding destroys it');
  assert.match(body, /inv-line__note/);
});

test('§5 a custom row renders no product picker and no SKU box', () => {
  const body = fnBody(INVOICES, 'function renderLines(');
  // The custom branch is the one template literal that renders the ref box.
  const custom = body.split('\n').find((ln) => ln.includes('inv-line__ref'));
  assert.ok(custom, 'the custom code cell must exist');
  assert.match(custom, /data-lfield="ref"/, 'a different FIELD is the whole safety argument');
  assert.doesNotMatch(custom, /inv-ac/, 'no catalogue dropdown offering to turn it into a product line');
  assert.doesNotMatch(custom, /data-lfield="code"/);
  // And the description box on a custom row is equally picker-free.
  assert.match(body, /const descCell = \(ship \|\| custom\)/,
    'a custom row must not open a product dropdown on its description either');
});

// ─── 6. The storage gap is measured, not assumed ─────────────────────────────

test('§6 a dropped product_ref is DETECTED from the echo', () => {
  // Live read 2026-08-28: saved line items carry exactly product_code,
  // description, quantity, unit_cost_excl_gst, line_total_excl_gst,
  // supplier_cost_excl_gst, cost_source. No column for the ref yet (BF-051), and
  // unknown keys are dropped silently. This is text the operator TYPED, so it
  // must not vanish quietly.
  const sent = { line_items: [{ product_code: '', product_ref: 'REFURB-01' }] };
  assert.equal(refEchoMissing(sent, { line_items: [{ product_code: '', description: 'x' }] }), true,
    'sent a ref, got no such key back — say so');
  assert.equal(refEchoMissing(sent, { line_items: [{ product_code: '', product_ref: null }] }), false,
    'PRESENT-but-null is the column existing and being empty — not a drop');
});

test('§6 it SELF-HEALS — no flag to remember to turn off', () => {
  const sent = { line_items: [{ product_ref: 'REFURB-01' }] };
  assert.equal(refEchoMissing(sent, { line_items: [{ product_ref: 'REFURB-01' }] }), false,
    'the day the column ships, the warning stops appearing on its own');
});

test('§6 it never cries wolf', () => {
  assert.equal(refEchoMissing({ line_items: [{ product_code: 'X' }] }, { line_items: [{ product_code: 'X' }] }), false,
    'no ref was sent — nothing to lose');
  assert.equal(refEchoMissing({ line_items: [{ product_ref: 'R' }] }, {}), false,
    'nothing echoed at all — we cannot tell, so we must not claim');
  assert.equal(refEchoMissing({ line_items: [{ product_ref: 'R' }] }, { line_items: [] }), false);
});

test('§6 the warning is a standing note on the form, not a toast', () => {
  const body = fnBody(INVOICES, 'function renderRefWarning(');
  assert.match(body, /inv-ref-warn/);
  assert.doesNotMatch(body, /Toast/, 'a toast is gone in four seconds; this is a fact about the invoice');
  assert.match(INVOICES, /const REF_NOT_STORED = /);
  assert.match(INVOICES, /BF-051/, 'name the ticket so the gap is chaseable');
  assert.match(fnBody(INVOICES, 'function resetQuoteState('), /_refNotStored = false/,
    'a statement about the LAST save must not survive onto the next invoice');
  assert.match(CSS, /\.inv-refwarn\s*\{/);
});

// ─── 7. Reopening a saved invoice ────────────────────────────────────────────

test('§6 the Save path says it in the TOAST, because it closes the drawer', () => {
  // Caught in the browser: the standing note is rendered into the editor body,
  // and saveInvoice() closes the drawer on success — so on the one path the
  // operator uses most, the warning was painted into a body about to be thrown
  // away and never seen. The note still serves Download PDF and Email, which
  // auto-save through persistDraft WITHOUT closing.
  const body = fnBody(INVOICES, 'async function saveInvoice(');
  // Comments in this very function mention Drawer.close(); compare CODE only.
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /const refsLost = _refNotStored;/,
    'read the flag BEFORE Drawer.close() — its onClose runs resetQuoteState(), which clears it');
  assert.ok(code.indexOf('const refsLost') < code.indexOf('Drawer.close()'),
    'reading it after the close would always see false');
  assert.match(body, /if \(refsLost\) Toast\.warning\(/);
  assert.match(body, /REF_NOT_STORED/, 'the same sentence, not a second copy of it');
  assert.match(body, /else Toast\.success\(/, 'an ordinary save still reads as a plain success');
});

test('§7 a stored ref restores the custom line — read, never guessed', () => {
  const body = fnBody(INVOICES, 'function draftFromInvoice(');
  assert.match(body, /ref: l\.product_ref \?\? l\.ref \?\? ''/);
  assert.match(body, /product_ref \?\? l\.ref\) \? \{ kind: 'custom' \}/,
    'recovered from a stored FIELD; sniffing the description text is the BF-043 trap');
  assert.doesNotMatch(body, /SHIPPING_DESCRIPTION/);
});

// ─── 8. Returning browsers get the new build ────────────────────────────────

test('§8 APP_VERSION was bumped', () => {
  const app = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');
  const m = app.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m);
  assert.notEqual(m[1], '2026.08.28-invoice-credit-line',
    'page modules import with ?v=APP_VERSION; a stale token leaves live browsers on the old build');
});
