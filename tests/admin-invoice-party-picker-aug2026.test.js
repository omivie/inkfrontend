/**
 * "Start from" pickers on the New Invoice modal — ERR-176
 * ======================================================
 *
 * A real paying customer (order 20260819000002, a GUEST checkout) could not be
 * found by either picker. Two independent causes, both pinned here:
 *
 *   1. THE ORDER PICKER RETURNED [] FOR EVERY QUERY. `/api/admin/orders` answers
 *      `{ok, data:[…rows…]}` — `data` is a BARE ARRAY — and `AdminAPI.getOrders`
 *      hands that array straight back. The picker read `data?.orders ||
 *      data?.items || []` off it, so a valid order number found nothing either.
 *      Every other caller in the repo already normalised; this one didn't.
 *
 *   2. THE PARTY PICKER SEARCHED TWO OF THE THREE PLACES A CUSTOMER LIVES.
 *      Contacts + Customers, never Orders — so a guest (no account row, no
 *      contact row) was structurally unfindable. "No matches" was reporting
 *      "not looked" as "not found".
 *
 * Also pinned: the customers endpoint cannot match a multi-word name
 * (`search=Mark Leask` → 0, `search=Mark` → 1, measured), and both surfaces must
 * keep sharing ONE search so the copies cannot drift apart again.
 *
 * Run with: node --test tests/admin-invoice-party-picker-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const partyMod = import(pathToFileURL(path.join(ADMIN, 'utils', 'party-search.js')).href);
const read = (...p) => fs.readFileSync(path.join(ADMIN, ...p), 'utf8');
const invoicesSrc = read('pages', 'invoices.js');
const quickOrderSrc = read('pages', 'quick-order.js');
const autocompleteSrc = read('components', 'autocomplete.js');

/** The live guest row, field-for-field: flat shipping_* columns, no `user`. */
const GUEST_ORDER = {
  id: 'cd3054c2-77cb-48b7-9bd9-1f4c2c0a7cca',
  order_number: '20260819000002',
  user_id: null,
  email: null,
  guest_email: 'caitandmike@xtra.co.nz',
  guest_phone: '+61 0422797028',
  status: 'paid',
  total: 922.99,
  shipping_recipient_name: 'Michael Wright',
  shipping_phone: '+61 0422797028',
  shipping_address_line1: 'Building 6, 15 Accent Drive',
  shipping_address_line2: '',
  shipping_city: 'East Tamaki',
  shipping_region: 'auckland',
  shipping_postal_code: '2013',
  shipping_country: 'NZ',
  created_at: '2026-08-19T05:40:00.000Z',
  customer_name: 'Michael Wright',
  customer_email: 'caitandmike@xtra.co.nz',
};

// ── 1. The envelope bug itself ───────────────────────────────────────────────

test('ordersFrom unwraps the live BARE ARRAY envelope', async () => {
  const { ordersFrom } = await partyMod;
  assert.equal(ordersFrom([GUEST_ORDER]).length, 1, 'a bare array is the live shape');
  assert.equal(ordersFrom({ orders: [GUEST_ORDER] }).length, 1);
  assert.equal(ordersFrom({ data: [GUEST_ORDER] }).length, 1);
  assert.equal(ordersFrom({ items: [GUEST_ORDER] }).length, 1);
  assert.deepEqual(ordersFrom(null), [], 'a failed read is empty, never a throw');
});

test('the invoice pickers no longer read .orders off an array', () => {
  assert.ok(!/data\?\.orders \|\| data\?\.items/.test(invoicesSrc),
    'the dead unwrap is back in the order picker — it returns [] for every query');
  assert.ok(!/od\?\.orders\?\.\[0\]/.test(invoicesSrc),
    'loadFromCustomer’s legacy address scrape is silently dead again');
  assert.ok(/ordersFrom\(/.test(invoicesSrc), 'invoices.js must normalise via ordersFrom');
});

// ── 2. Three sources, and the guest that needs the third ─────────────────────

const stubApi = ({ contacts = [], customers = [], orders = [], wideCustomers = null } = {}) => {
  const calls = [];
  return {
    calls,
    listContacts: async (f) => { calls.push(['contacts', f.search]); return { contacts }; },
    getCustomers: async (f) => {
      calls.push(['customers', f.search]);
      // second call = the widened single-token retry
      const isWide = calls.filter((c) => c[0] === 'customers').length > 1;
      return { customers: isWide && wideCustomers ? wideCustomers : customers };
    },
    getOrders: async (f) => { calls.push(['orders', f.search]); return orders; },
  };
};

test('a guest order surfaces under its own section', async () => {
  const { searchParties } = await partyMod;
  const { sections, failed } = await searchParties('michael wright', stubApi({ orders: [GUEST_ORDER] }));
  assert.deepEqual(failed, []);
  assert.equal(sections.length, 1, 'contacts + customers are empty for a guest');
  assert.match(sections[0].title, /Orders/);
  assert.equal(sections[0].items[0].__type, 'order');
  assert.equal(sections[0].items[0].order_number, '20260819000002');
});

test('all three sources are searched, and each row is tagged', async () => {
  const { searchParties } = await partyMod;
  const api = stubApi({
    contacts: [{ id: 'c1', label: 'Sheree Wright' }],
    customers: [{ id: 'u1', full_name: 'Mark Leask', email: 'leaskee@hotmail.com' }],
    orders: [GUEST_ORDER],
  });
  const { sections } = await searchParties('wright', api);
  assert.deepEqual(sections.map((s) => s.items[0].__type), ['contact', 'customer', 'order']);
  assert.deepEqual(api.calls.map((c) => c[0]).sort(), ['contacts', 'customers', 'orders']);
});

test('a source that could NOT be asked is reported, not counted as a miss', async () => {
  const { searchParties, partyEmptyText } = await partyMod;
  const api = stubApi();
  api.listContacts = async () => null;          // fail-soft read → null
  const { sections, failed } = await searchParties('wright', api);
  assert.deepEqual(sections, []);
  assert.deepEqual(failed, ['Contacts']);
  assert.match(partyEmptyText('wright', failed), /Couldn’t search Contacts/);
  assert.match(partyEmptyText('wright', []), /No contact, customer or order/);
});

// ── 3. Multi-word names (measured: customers can't match them) ───────────────

test('a full name widens to the longest token, then filters on every token', async () => {
  const { searchParties } = await partyMod;
  const api = stubApi({
    customers: [],                                     // "Mark Leask" → 0 rows, live
    wideCustomers: [
      { id: 'u1', full_name: 'Mark Leask', email: 'leaskee@hotmail.com' },
      { id: 'u2', full_name: 'Mark Sanders', email: 'ms@example.com' },
    ],
  });
  const { sections } = await searchParties('Mark Leask', api);
  const customers = sections.find((s) => s.title === 'Customers');
  assert.ok(customers, 'the widened retry must surface the customer');
  assert.equal(customers.items.length, 1, 'a row missing the second token is dropped');
  assert.equal(customers.items[0].full_name, 'Mark Leask');
  // the retry token is lower-cased; the endpoint matches case-insensitively (measured)
  assert.deepEqual(api.calls.filter((c) => c[0] === 'customers').map((c) => c[1]), ['Mark Leask', 'leask']);
});

test('a single-token query is never widened', async () => {
  const { searchParties } = await partyMod;
  const api = stubApi({ customers: [] });
  await searchParties('leask', api);
  assert.equal(api.calls.filter((c) => c[0] === 'customers').length, 1);
});

// ── 4. Order → bill-to mapping ───────────────────────────────────────────────

test('orderToParty reads the FLAT columns and the guest fallbacks', async () => {
  const { orderToParty } = await partyMod;
  const p = orderToParty(GUEST_ORDER);
  assert.equal(p.name, 'Michael Wright');
  assert.equal(p.email, 'caitandmike@xtra.co.nz');
  assert.equal(p.phone, '+61 0422797028');
  assert.equal(p.address, 'Building 6, 15 Accent Drive\nEast Tamaki, auckland, 2013\nNZ');
  assert.equal(p.orderNumber, '20260819000002');
  assert.equal(p.orderDate, '2026-08-19');
});

test('orderToParty still reads a shipping_address OBJECT row', async () => {
  const { orderToParty } = await partyMod;
  const p = orderToParty({
    order_number: 'X1',
    shipping_address: { recipient_name: 'Jo Blogs', address_line1: '1 Test St', city: 'Auckland', postal_code: '1010', country: 'NZ', phone: '021' },
  });
  assert.equal(p.name, 'Jo Blogs');
  assert.equal(p.phone, '021');
  assert.equal(p.address, '1 Test St\nAuckland, 1010\nNZ');
});

test('a picked order fills DETAILS ONLY — no lines, no freight, no source link', () => {
  const fn = invoicesSrc.slice(invoicesSrc.indexOf('function loadFromOrderDetails'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/_draft\.source_order_id = null/.test(body), 'a details-only fill must not link the order');
  assert.ok(!/_draft\.lines/.test(body), 'line items belong to the Existing order picker');
  assert.ok(!/_draft\.freight/.test(body), 'freight belongs to the Existing order picker');
  assert.ok(/line items not imported/.test(body), 'the toast must say what was NOT filled');
});

// ── 5. Enrolment: the two copies must stay one ───────────────────────────────

test('both party pickers call the shared search — no local re-implementation', () => {
  for (const [name, src] of [['invoices.js', invoicesSrc], ['quick-order.js', quickOrderSrc]]) {
    assert.ok(/searchParties\(/.test(src), `${name} must use the shared searchParties`);
    assert.ok(!(/AdminAPI\.listContacts\(/.test(src) && /AdminAPI\.getCustomers\(/.test(src)),
      `${name} has re-grown its own contacts+customers fetch — the third source drifts away next`);
    assert.ok(/orderToParty\(/.test(src), `${name} must map orders through the one mapper`);
  }
});

// ── 6. Honest surfaces ───────────────────────────────────────────────────────

test('the order box no longer promises email', () => {
  const ph = /id="inv-order-search"[^>]*placeholder="([^"]*)"/.exec(invoicesSrc);
  assert.ok(ph, 'the order search input must exist');
  assert.ok(!/email/i.test(ph[1]), `placeholder promises email: "${ph[1]}"`);
  assert.match(ph[1], /order #|name/i);
});

test('an email-shaped order query explains itself instead of a bare miss', async () => {
  const { orderEmptyText } = await partyMod;
  assert.match(orderEmptyText('caitandmike@xtra.co.nz'), /can’t match email addresses/);
  assert.match(orderEmptyText('wright'), /No orders match/);
  assert.match(orderEmptyText('wright', true), /unanswered search/);
});

test('autocomplete accepts a query-aware emptyText', () => {
  assert.ok(/typeof emptyText === 'function' \? emptyText\(q\) : emptyText/.test(autocompleteSrc),
    'the shared component must support a per-query empty message');
  assert.ok(/renderResults\(res, q\)/.test(autocompleteSrc), 'the query must reach renderResults');
});

// ── 7. A data row must never be mistaken for a section ───────────────────────

test('sections are detected by SHAPE, not by a stray `items` key', () => {
  // Order rows carry `items` (their line items). The old sniff — "res[0].items is
  // an array" — read a flat list of orders as sections and rendered the first
  // order's LINE ITEMS as pickable rows (a UUID and $0.00). ERR-176.
  const m = /const isSectioned = \(res\) =>([\s\S]*?);\n/.exec(autocompleteSrc);
  assert.ok(m, 'isSectioned not found');
  const isSectioned = new Function('res', `return (${m[1].trim()});`);
  assert.equal(isSectioned([{ ...GUEST_ORDER, items: [{ id: 'line-1' }] }]), false,
    'an order row carrying line items is NOT a section');
  assert.equal(isSectioned([{ title: 'Orders', items: [GUEST_ORDER] }]), true);
  assert.equal(isSectioned([{ title: 'Contacts', items: [{ id: 'c1' }] }, { items: [GUEST_ORDER] }]), false,
    'every element must look like a section, not just the first');
  assert.equal(isSectioned([{ id: 'c1', label: 'Sheree Wright' }]), false);
});
