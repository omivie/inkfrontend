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
