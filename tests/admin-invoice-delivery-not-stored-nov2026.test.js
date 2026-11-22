/**
 * Invoice "Deliver to" block: the server doesn't store it yet (ERR-385)
 * =====================================================================
 *
 * Owner, 2026-11-21: "it says it saves but it does not save". Measured on
 * invoice 3297 straight after the owner's save: the price (619.60) and cost
 * were stored, but GET returns NO `delivery` key — the invoice service has no
 * column for it and drops it. The PDF uploaded at save time did carry it, so
 * the customer copy was right; reopening showed the block blank, and saving
 * again from that copy would have re-made the PDF without the delivery address.
 *
 * Until the backend stores it: keep this browser's copy per invoice, restore it
 * on reopen and SAY so, warn when there is no copy, and say it in the save
 * toast. Retires itself when GET starts carrying `delivery`.
 *
 * Run with: node --test tests/admin-invoice-delivery-not-stored-nov2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INVOICES = fs.readFileSync(
  path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'invoices.js'), 'utf8');

function block(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `not found: ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.notEqual(b, -1, `not found: ${endMarker}`);
  return src.slice(a, b);
}

function load(storage = new Map(), { throws = false } = {}) {
  const localStorage = {
    getItem: (k) => { if (throws) throw new Error('blocked'); return storage.has(k) ? storage.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error('blocked'); storage.set(k, String(v)); },
    removeItem: (k) => { if (throws) throw new Error('blocked'); storage.delete(k); },
  };
  const src = block(INVOICES, 'const DeliveryKeep = {', '// The optional "Deliver to" block');
  return vm.runInNewContext(`${src}; ({ DeliveryKeep, deliveryStoreState, DELIVERY_NOTE })`, { localStorage });
}

const DELIVERY = { attn: 'A. Person', company: 'Some Company Ltd', address: ['1 Example Street', 'Dunedin 9012'], phone: '' };

test('a record WITHOUT a delivery key is "server-missing"; WITH one (even null) the server is the truth', () => {
  const { deliveryStoreState } = load();
  assert.equal(deliveryStoreState({ id: 'x', customer: {} }), 'server-missing');
  assert.equal(deliveryStoreState({ id: 'x', delivery: null }), 'server');
  assert.equal(deliveryStoreState({ id: 'x', delivery: DELIVERY }), 'server');
});

test('keep → read round-trips per invoice id; an emptied box clears the copy', () => {
  const store = new Map();
  const { DeliveryKeep } = load(store);
  DeliveryKeep.write('inv-1', DELIVERY);
  assert.deepEqual(JSON.parse(JSON.stringify(DeliveryKeep.read('inv-1'))), DELIVERY);
  assert.equal(DeliveryKeep.read('inv-2'), null, 'never another invoice’s address');
  DeliveryKeep.write('inv-1', null);
  assert.equal(DeliveryKeep.read('inv-1'), null);
  assert.equal(store.size, 0);
});

test('blocked storage never throws (the standing warning still tells the truth)', () => {
  const { DeliveryKeep } = load(new Map(), { throws: true });
  assert.doesNotThrow(() => DeliveryKeep.write('inv-1', DELIVERY));
  assert.equal(DeliveryKeep.read('inv-1'), null);
});

test('reopen: server-missing + a kept copy ⇒ restored and labelled; no copy ⇒ warned', () => {
  const fn = block(INVOICES, 'function draftFromInvoice(', '  const items = rec.line_items');
  assert.match(fn, /d\._deliveryStore = deliveryStoreState\(rec\);/);
  assert.match(fn, /if \(d\._deliveryStore === 'server-missing' \|\| \(d\._deliveryStore === 'server' && rec\.delivery == null\)\) \{\s*const kept = DeliveryKeep\.read\(rec\.id\);\s*if \(kept\) \{/);
  // The kept copy is the PAYLOAD shape (address = array of lines); the textarea
  // wants one line per row. Measured in the browser: without the join it read
  // "line 1,line 2" and the next save would print one comma-joined line.
  assert.match(fn, /address: Array\.isArray\(kept\.address\) \? kept\.address\.join\('\\n'\)/);
  assert.match(fn, /d\._deliveryStore = d\._deliveryStore === 'server' \? 'restored-unsaved' : 'restored-local';/);
  const { DELIVERY_NOTE } = load();
  assert.match(DELIVERY_NOTE['restored-local'], /Restored from this browser/);
  assert.match(DELIVERY_NOTE['server-missing'], /re-type it before saving/);
  assert.match(INVOICES, /d\.id && DELIVERY_NOTE\[d\._deliveryStore\] \? `<div class="inv-refwarn" id="inv-delivery-note">/,
    'the note sits in the Deliver-to box of a SAVED invoice only');
});

test('save: echo without `delivery` keeps the copy + flags the toast; echo WITH it clears the copy (self-retiring)', () => {
  const fn = block(INVOICES, 'async function persistDraft(', '/**\n * Did the invoice service keep');
  const keep = fn.indexOf("if (deliveryStoreState(saved) === 'server-missing') {");
  assert.ok(keep > fn.indexOf('_draft.id = saved.id ?? _draft.id'), 'a NEW invoice is kept under its new id');
  assert.match(fn, /DeliveryKeep\.write\(_draft\.id, payload\.delivery\);\s*_deliveryNotStored = !!payload\.delivery;/);
  assert.match(fn, /else \{\s*DeliveryKeep\.write\(_draft\.id, null\);/);
  assert.ok(keep < fn.indexOf('syncStoredPdf()'), 'decided before the PDF upload, which can fail');
});

// ── Backend 2026-11-22 (migration 215): `delivery` is stored, GET always has the key ──
// Measured READ-ONLY 2026-11-22: GET invoice 3297 ⇒ `delivery` key present, value null
// (the owner's block was saved before the column existed). Without the hand-over the
// box opened blank and the next save re-made the PDF without the address.

test('hand-over: server null + this browser’s copy ⇒ restored as "restored-unsaved"; server value ⇒ copy ignored', () => {
  const store = new Map();
  const { DeliveryKeep, deliveryStoreState, DELIVERY_NOTE } = load(store);
  DeliveryKeep.write('inv-1', DELIVERY);
  const restore = vm.runInNewContext(`(function (rec) {
    const d = { delivery: { attn: '', company: '', address: '', phone: '' } };
    if (rec.delivery) d.delivery = { ...d.delivery, ...rec.delivery, address: rec.delivery.address.join('\\n') };
    ${block(INVOICES, '  d._deliveryStore = deliveryStoreState(rec);', '  const items = rec.line_items')}
    return d;
  })`, { DeliveryKeep, deliveryStoreState });
  const unsaved = restore({ id: 'inv-1', delivery: null });
  assert.equal(unsaved._deliveryStore, 'restored-unsaved');
  assert.equal(unsaved.delivery.company, 'Some Company Ltd');
  assert.equal(unsaved.delivery.address, '1 Example Street\nDunedin 9012');
  assert.match(DELIVERY_NOTE['restored-unsaved'], /press Save once/);
  const stored = restore({ id: 'inv-1', delivery: { ...DELIVERY, company: 'Server Ltd' } });
  assert.equal(stored._deliveryStore, 'server', 'a stored block is the truth');
  assert.equal(stored.delivery.company, 'Server Ltd');
  store.clear();
  const none = restore({ id: 'inv-1', delivery: null });
  assert.equal(none._deliveryStore, 'server');
  assert.equal(DELIVERY_NOTE.server, undefined, 'stored-and-empty shows no note');
});

test('buildPayload still SENDS delivery — the day the column ships, nothing here has to change', () => {
  const fn = block(INVOICES, 'function buildPayload(d) {', '// ====');
  // Always a key: the backend leaves the stored value unchanged when the key is
  // missing, so `null` is how an emptied box clears it.
  assert.match(fn, /delivery: hasDelivery\(d\) \? \{ \.\.\.d\.delivery, address: lines\(d\.delivery\.address\) \} : null,/);
});
