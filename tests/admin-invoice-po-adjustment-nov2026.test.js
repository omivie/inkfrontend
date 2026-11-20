/**
 * Invoice: PO number printed, courier row aligned, credit / adjustment line (ERR-381)
 *
 * 1. The PO number was saved and shown on the customer's portal but never
 *    printed: invoiceMeta() (the ONE header source for the preview, the PDF and
 *    the emailed PDF) had no PO row.
 * 2. `.inv-freight` bottom-aligned the freight box to the courier picker, which
 *    grows a second row when the free-shipping pill wraps.
 * 3. "Add credit / adjustment" adds a manual-priced line with our cost pinned to
 *    a manual 0, so a positive surcharge never reads as 100% margin.
 *
 * Run with: node --test tests/admin-invoice-po-adjustment-nov2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', 'inkcartridges');
const INVOICES = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'pages', 'invoices.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');

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

const invoiceMeta = vm.runInNewContext(`(function () {
  const formatInvoiceDate = (x) => x; const orderPlacedDisplay = (d) => d.order_date;
  ${fnBody(INVOICES, 'function invoiceMeta(')}
  return invoiceMeta;
})()`);

const draft = (extra) => ({ invoice_number: '3297', date: '2026-11-20', order_date: '2026-11-20', seller: { gst: '94-509-459' }, ...extra });

test('§1 the PO number prints on the document when set', () => {
  const rows = invoiceMeta(draft({ po_number: '  PO# 36104 ' }));
  const po = rows.find(([k]) => k === 'PO Number');
  assert.ok(po, 'PO row missing — the customer cannot match the invoice to their PO');
  assert.equal(po[1], 'PO# 36104', 'printed trimmed');
});

test('§1 no PO row when blank', () => {
  for (const po_number of ['', '   ', null, undefined]) {
    assert.ok(!invoiceMeta(draft({ po_number })).some(([k]) => k === 'PO Number'));
  }
});

test('§1 preview and PDF both read invoiceMeta (so the email PDF does too)', () => {
  assert.match(fnBody(INVOICES, 'function renderPreview('), /invoiceMeta\(d\)/);
  assert.match(fnBody(INVOICES, 'function buildInvoiceDoc('), /invoiceMeta\(d\)/);
  assert.match(fnBody(INVOICES, 'async function syncStoredPdf('), /buildInvoiceDoc\(/);
});

test('§2 the freight row aligns tops, not bottoms', () => {
  const rule = CSS.match(/\.inv-freight \{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /align-items: flex-start/);
});

test('§3 adjustment line: manual price, our cost manual 0, wired to a button', () => {
  const m = INVOICES.match(/const adjustmentLine = \(\) => \(\{[\s\S]*?\}\);/);
  assert.ok(m, 'adjustmentLine factory missing');
  const PRICE_MANUAL = 'manual';
  const line = vm.runInNewContext(`const blankLine = () => ({ code: '', unitCost: 0, supplierCost: null, costSource: 'auto', priceSource: 'auto' });
    const PRICE_MANUAL = ${JSON.stringify(PRICE_MANUAL)}; ${m[0]} adjustmentLine()`);
  assert.equal(line.supplierCost, 0);
  assert.equal(line.costSource, 'manual');
  assert.equal(line.priceSource, PRICE_MANUAL);
  assert.equal(line.code, '', 'never a SKU — must not reach the catalogue matcher');
  assert.match(INVOICES, /data-form-action="add-adjustment"/);
  assert.match(INVOICES, /act === 'add-adjustment'\) \{ addAdjustmentLine\(\); \}/);
});

test('§3 kind stays out of the payload', () => {
  const items = fnBody(INVOICES, 'function buildPayload(');
  assert.doesNotMatch(items, /\bkind:/);
});
