/**
 * Invoice "Existing order" must never link another invoice's shadow order (ERR-383)
 *
 * Every invoice raised from scratch materialises a shadow order
 * (`channel: 'invoice'`, order_number `INV-<n>`). The "Existing order" picker
 * lists those rows too. Picking one set `source_order_id` to it, and on save the
 * backend re-pointed `orders.invoice_id` at the NEW invoice: invoice 3297 took
 * INV-3274 away from invoice 3274 (2026-11-20), and the next edit of 3297
 * failed with a 500 "Failed to update invoice".
 *
 * loadFromOrder() now treats an invoice-channel order as a template: lines are
 * copied, `source_order_id` stays null, and a warning says so.
 *
 * Run with: node --test tests/admin-invoice-shadow-order-source-nov2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INVOICES = fs.readFileSync(
  path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'invoices.js'), 'utf8');

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

async function load(order) {
  const toasts = [];
  const ctx = {
    toasts,
    order,
    _draft: { source_order_id: 'stale', lines: [] },
  };
  const run = vm.runInNewContext(`(function () {
    let _editorToken = 1, _freightOwner = null, _fillSource = null;
    const editorAlive = () => true;
    const AdminAPI = { getOrder: async () => order, getOrderBreakdown: async () => null };
    const Toast = {
      success: (m) => toasts.push(['success', m]),
      warning: (m) => toasts.push(['warning', m]),
      error: (m) => toasts.push(['error', m]),
    };
    const orderToParty = () => ({ attn: '', name: 'X', company: '', address: '', phone: '', email: '' });
    const num = (v) => Number(v) || 0;
    const round2 = (v) => Math.round(v * 100) / 100;
    const costOrNull = (v) => (v == null ? null : Number(v));
    const blankLine = () => ({});
    const rebuildEditor = () => {};
    const PRICE_MANUAL = 'manual', GST_RATE = 0.15, FREIGHT_OWNER_OPERATOR = 'operator';
    ${fnBody(INVOICES, 'async function loadFromOrder(')}
    return loadFromOrder;
  })()`, ctx);
  await run(order.id);
  return { draft: ctx._draft, toasts };
}

const items = [{ sku: 'GTK5494KCMY', product_name: 'Kyocera TK5494', qty: 1, sell_price: 596.08 }];

test('an invoice-channel (shadow) order is copied but NOT linked', async () => {
  const { draft, toasts } = await load({
    id: '24a9f5ab', order_number: 'INV-3274', channel: 'invoice', invoice_id: 'inv-3274', items,
  });
  assert.equal(draft.source_order_id, null, 'linking would steal INV-3274 from invoice 3274');
  assert.equal(draft.lines.length, 1, 'goods still copied as a template');
  assert.equal(toasts[0][0], 'warning');
  assert.match(toasts[0][1], /INV-3274/);
});

test('a real web order is still linked as the source', async () => {
  const { draft, toasts } = await load({ id: 'web-1', order_number: '2026092701', channel: 'web', items });
  assert.equal(draft.source_order_id, 'web-1');
  assert.equal(toasts[0][0], 'success');
});

// ── Backend response 2026-11-20 (d759957): the server now refuses a bad link ──

const API_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'api.js'), 'utf8');

const saveErrorMessage = vm.runInNewContext(`(function () {
  ${fnBody(INVOICES, 'function saveErrorMessage(')}
  return saveErrorMessage;
})()`);

const err = (code, message) => Object.assign(new Error(message), { code });

test('every SOURCE_ORDER refusal keeps the server sentence AND says what to do', () => {
  for (const code of ['SOURCE_ORDER_NOT_FOUND', 'SOURCE_ORDER_IS_INVOICE',
    'SOURCE_ORDER_ALREADY_INVOICED', 'SOURCE_ORDER_NOT_LINKABLE']) {
    const msg = saveErrorMessage(err(code, `Server says ${code}`));
    assert.ok(msg.startsWith(`Server says ${code}`), 'the server’s own reason comes first');
    assert.match(msg, /Nothing was saved/);
    assert.match(msg, /reopen it from the list/);
  }
});

test('SOURCE_ORDER_LOOKUP_FAILED (503) says try again, not reopen', () => {
  const msg = saveErrorMessage(err('SOURCE_ORDER_LOOKUP_FAILED', 'Could not check the source order'));
  assert.match(msg, /Try again/);
  assert.ok(!/reopen/.test(msg));
});

test('INVOICE_REFERENCE_CONFLICT (409) and a reasoned 500 pass through verbatim', () => {
  assert.equal(saveErrorMessage(err('INVOICE_REFERENCE_CONFLICT', 'That order is linked to another invoice.')),
    'That order is linked to another invoice.');
  assert.equal(saveErrorMessage(err('INTERNAL_ERROR', 'Failed to update invoice: deadlock detected')),
    'Failed to update invoice: deadlock detected');
});

test('all three persist paths (save, email, download) share saveErrorMessage', () => {
  const uses = INVOICES.match(/Toast\.error\(saveErrorMessage\(err\)\)/g) || [];
  assert.equal(uses.length, 3);
  assert.ok(!/err\.message \|\| 'Save the invoice before emailing it\.'/.test(INVOICES));
  assert.ok(!/err\.message \|\| 'Could not save the invoice to assign a number\.'/.test(INVOICES));
});

test('void returns the server warnings, and the list says them by name', async () => {
  const fn = API_SRC.slice(API_SRC.indexOf('  async voidInvoice('), API_SRC.indexOf('  async setInvoiceStatus('));
  assert.match(fn, /return withInvoiceWarnings\(resp\);/);
  const withInvoiceWarnings = vm.runInNewContext(`(function () {
    ${fnBody(API_SRC, 'function withInvoiceWarnings(')}
    return withInvoiceWarnings;
  })()`);
  const res = withInvoiceWarnings({ ok: true, data: { invoice: { id: 'i1', status: 'void' },
    warnings: [{ code: 'SALES_RECORD_NOT_CANCELLED', message: 'The sales record was not cancelled; it still counts in reports.' }] } });
  assert.deepEqual([...res._warnings], ['The sales record was not cancelled; it still counts in reports.']);
  const caller = INVOICES.slice(INVOICES.indexOf("} else if (action === 'void') {"), INVOICES.indexOf("} else if (action === 'delete') {"));
  assert.match(caller, /const res = await AdminAPI\.voidInvoice\(id\);/);
  assert.match(caller, /Toast\.warning\(`Invoice \$\{btn\.dataset\.num \|\| ''\} voided, but: \$\{w\}`/);
  assert.match(caller, /else \{\s*Toast\.success\('Invoice voided\.'\);/, 'no warning ⇒ the plain success toast');
});
