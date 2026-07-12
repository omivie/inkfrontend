/**
 * The supplier cost must NEVER appear on the customer-facing invoice
 * =================================================================
 *
 * The operator records what WE paid for each line so invoiced sales carry a real
 * COGS into the profit figures. That number is commercially sensitive: the
 * customer must never see it — not in the live preview, not in the downloaded
 * PDF, not in the emailed copy.
 *
 * "We were careful" is not a guarantee, so the code is arranged so that leaking
 * it is STRUCTURALLY hard rather than merely discouraged:
 *
 *   Both document renderers — renderPreview() (HTML) and buildInvoiceDoc()
 *   (jsPDF) — get their rows from ONE function, invoiceDocRows(), which returns
 *   a 4-tuple: [code, description, qty, ex-GST line total]. The renderers no
 *   longer touch the line objects at all, so there is no `l.supplierCost` in
 *   scope to print.
 *
 * This file pins that arrangement. If you are here because a test failed:
 *
 *   ✗ "renderer body mentions the supplier cost" — you reached back into the raw
 *     line objects inside a document renderer. Don't. Whatever you need, add it
 *     to invoiceDocRows (and think hard, because that tuple IS the invoice).
 *
 *   ✗ "the items table has grown a column" — you are about to print our margin
 *     on the customer's invoice. Almost certainly not what you meant.
 *
 * NB this covers the FRONTEND only. The backend renders its own PDF and email —
 * the spec (~/Desktop/invoice-sales-integration-backend-spec.md) carries the
 * matching requirement, and this test cannot enforce it.
 *
 * Run with: node --test tests/admin-invoice-cost-not-on-document.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INVOICES = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'invoices.js');
const src = fs.readFileSync(INVOICES, 'utf8');

// Anything that could carry our cost into the document layer.
const COST_TOKENS = /supplierCost|supplier_cost|costSource|cost_source|productCostExGst|computeInvoiceCogs|computeInvoiceProfit/;

/**
 * Extract a top-level function's body by brace-matching from its declaration.
 * Crude, but it only has to handle this one file — and a real parser is a
 * dependency this repo deliberately doesn't have.
 */
function functionBody(source, name) {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`);
  const start = source.search(decl);
  assert.notEqual(start, -1, `${name}() not found in invoices.js — did it get renamed?`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced braces while scanning ${name}()`);
}

// Every function that produces something the CUSTOMER sees.
const DOCUMENT_RENDERERS = ['renderPreview', 'buildInvoiceDoc', 'invoiceMeta', 'invoiceParties'];

for (const fn of DOCUMENT_RENDERERS) {
  test(`${fn}() — the customer-facing renderer never mentions the supplier cost`, () => {
    const body = functionBody(src, fn);
    const hit = body.match(COST_TOKENS);
    assert.equal(hit, null,
      `${fn}() references "${hit && hit[0]}". That function renders what the CUSTOMER sees. ` +
      'Our cost must not reach it — take the four fields from invoiceDocRows() instead.');
  });
}

test('both document renderers source their rows from invoiceDocRows()', () => {
  // The mechanism itself. If a renderer goes back to mapping d.lines directly,
  // the guard above becomes a promise again rather than a structural fact.
  for (const fn of ['renderPreview', 'buildInvoiceDoc']) {
    const body = functionBody(src, fn);
    assert.ok(body.includes('invoiceDocRows('),
      `${fn}() must build its rows via invoiceDocRows() — that 4-tuple is what makes ` +
      'leaking the cost structurally impossible.');
  }
});

test('the PDF items table still has exactly four columns', () => {
  // A fifth column is how the cost would show up on a real invoice.
  const body = functionBody(src, 'buildInvoiceDoc');
  const head = body.match(/head:\s*\[\[([^\]]*)\]\]/);
  assert.ok(head, 'could not find the autoTable head row in buildInvoiceDoc()');
  const cols = head[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(cols.length, 4,
    `the invoice items table has ${cols.length} columns: ${head[1]}. It must stay at four ` +
    '(Product Code, Description, Number, Cost excl. GST) — a fifth would print our margin.');
});

test('the HTML preview items table still has exactly four headers', () => {
  const body = functionBody(src, 'renderPreview');
  const thead = body.match(/<thead>([\s\S]*?)<\/thead>/);
  assert.ok(thead, 'could not find the preview items <thead>');
  const ths = thead[1].match(/<th/g) || [];
  assert.equal(ths.length, 4, `the preview items table has ${ths.length} headers; it must stay at four.`);
});

// ─── The other half: the cost MUST reach the backend ─────────────────────────
test('buildPayload DOES send the supplier cost — it is internal, not unused', () => {
  const body = functionBody(src, 'buildPayload');
  assert.ok(body.includes('supplier_cost_excl_gst'),
    'buildPayload must send supplier_cost_excl_gst, otherwise the cost the operator ' +
    'typed is thrown away and invoiced sales carry no COGS.');
  assert.ok(body.includes('cost_source'),
    'buildPayload must send cost_source so the backend knows whether it may overwrite ' +
    'the cost with its own snapshot of products.cost_price.');
});

test('the cost input exists in the editor and is owner-gated', () => {
  assert.ok(/data-lfield="supplierCost"/.test(src), 'the editor must render a supplierCost input');
  const body = functionBody(src, 'renderLines');
  assert.ok(body.includes('canSeeCost()'),
    'the cost column must be owner-gated — canSeeCost() is missing from renderLines()');
});

test('Quick Order renders the same 6-column line grid (they share the CSS)', () => {
  // .inv-line is one grid definition used by BOTH editors. If Quick Order does
  // not emit the cost cell while Invoices does, its rows silently misalign.
  const qo = fs.readFileSync(
    path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'quick-order.js'), 'utf8');
  assert.ok(/data-lfield="supplierCost"/.test(qo),
    'quick-order.js must emit the cost cell too — it renders into the same .inv-line grid.');
  assert.ok(qo.includes('canSeeCost()'), 'quick-order.js must owner-gate the cost cell as well');
});

test('the shared .inv-line CSS grid declares six columns', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'inkcartridges', 'css', 'admin.css'), 'utf8');
  const rule = css.match(/\.inv-lines-head,\s*\.inv-line\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
  assert.ok(rule, 'could not find the .inv-line grid-template-columns rule');
  const cols = rule[1].trim().split(/\s+/);
  assert.equal(cols.length, 6,
    `.inv-line declares ${cols.length} columns (${rule[1].trim()}); the editors render six cells ` +
    '(code, description, qty, price, OUR COST, remove).');
});
