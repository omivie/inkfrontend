/**
 * Admin Contacts + smarter invoice pre-fill & search — June 2026
 * ==============================================================
 *
 * Pins the feature that added a Contacts address book (tab inside Customers),
 * a saved per-customer invoicing profile, and a storefront-grade autocomplete
 * used to pre-fill invoices.
 *
 * These are static source-scan tests (same style as search-enter-key): they
 * read the shipped JS and assert the load-bearing invariants survive refactors.
 *
 * Invariants pinned:
 *   - the shared autocomplete emits `type="button"` items (Enter-key rule from
 *     search-enter-key-may2026), exposes listbox/option a11y roles, handles
 *     Arrow/Enter/Escape, renders skeleton + no-results + error states, and
 *     guards out-of-order fetches.
 *   - invoices.js imports the shared component (no private copy), exposes the
 *     unified Contacts+Customers picker, has loadFromContact, and
 *     loadFromCustomer PREFERS the saved invoicing profile BEFORE scraping the
 *     customer's latest order.
 *   - api.js ships the contacts CRUD + updateCustomerInvoicing methods.
 *   - the Customers page wires the Contacts tab + an owner-gated invoicing block.
 *
 * Run with: node --test tests/admin-contacts-jun2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = (rel) => path.join(ROOT, 'inkcartridges', 'js', 'admin', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const autocomplete = READ(ADMIN('components/autocomplete.js'));
const api          = READ(ADMIN('api.js'));
const invoices     = READ(ADMIN('pages/invoices.js'));
const customers    = READ(ADMIN('pages/customers.js'));
const contacts     = READ(ADMIN('pages/contacts.js'));

test('shared autocomplete: items are type="button" (Enter-key invariant)', () => {
  assert.match(autocomplete, /class="admin-ac__item"[^`]*type="button"|type="button"[^`]*class="admin-ac__item"/);
});

test('shared autocomplete: exposes listbox/option a11y roles', () => {
  assert.match(autocomplete, /role',\s*'listbox'|role="listbox"/);
  assert.match(autocomplete, /role="option"/);
  assert.match(autocomplete, /aria-activedescendant/);
});

test('shared autocomplete: keyboard nav handles Arrow/Enter/Escape', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
    assert.ok(autocomplete.includes(`'${key}'`), `missing key handler ${key}`);
  }
});

test('shared autocomplete: renders loading + no-results + error states', () => {
  assert.match(autocomplete, /renderSkeleton/);
  assert.match(autocomplete, /admin-ac__skel/);            // skeleton shimmer
  assert.match(autocomplete, /emptyText/);                 // no-results message
  assert.match(autocomplete, /admin-ac__msg--error/);      // error state
});

test('shared autocomplete: guards out-of-order fetches', () => {
  // A stale fetch resolving after a newer keystroke must not paint.
  assert.match(autocomplete, /reqSeq/);
  assert.match(autocomplete, /seq !== reqSeq/);
});

test('api.js: ships contacts CRUD + updateCustomerInvoicing', () => {
  for (const m of ['listContacts', 'getContact', 'createContact', 'updateContact', 'deleteContact', 'updateCustomerInvoicing']) {
    assert.ok(api.includes(`${m}(`), `api.js missing ${m}`);
  }
  assert.match(api, /\/api\/admin\/contacts/);
  assert.match(api, /\/api\/admin\/customers\/\$\{customerId\}\/invoicing/);
});

test('invoices.js: imports the shared autocomplete (no private copy)', () => {
  assert.match(invoices, /import\s*\{\s*attachAutocomplete\s*\}\s*from\s*'\.\.\/components\/autocomplete\.js'/);
  // The old in-file primitive must be gone.
  assert.ok(!/function attachAutocomplete\b/.test(invoices), 'local attachAutocomplete should be removed');
});

test('invoices.js: unified picker fetches contacts AND customers', () => {
  assert.match(invoices, /inv-party-search/);
  assert.match(invoices, /listContacts\(/);
  assert.match(invoices, /getCustomers\(/);
  assert.match(invoices, /title:\s*'Contacts'/);
  assert.match(invoices, /title:\s*'Customers'/);
});

test('invoices.js: has loadFromContact filling bill-to + deliver-to', () => {
  assert.match(invoices, /function loadFromContact/);
  const body = invoices.slice(invoices.indexOf('function loadFromContact'));
  assert.match(body, /_draft\.customer\s*=/);
  assert.match(body, /_draft\.delivery\s*=/);
});

test('invoices.js: loadFromCustomer prefers saved profile BEFORE scraping orders', () => {
  const start = invoices.indexOf('async function loadFromCustomer');
  assert.ok(start > -1, 'loadFromCustomer not found');
  const end = invoices.indexOf('\nfunction ', start + 1);
  const body = invoices.slice(start, end > -1 ? end : undefined);
  const invIdx = body.indexOf('c.invoicing');
  const ordIdx = body.indexOf('getOrders');
  assert.ok(invIdx > -1, 'should read c.invoicing');
  assert.ok(ordIdx > -1, 'should still fall back to getOrders');
  assert.ok(invIdx < ordIdx, 'saved profile must be checked before the order fallback');
});

test('invoices.js: shows a "filled from … clear" chip', () => {
  assert.match(invoices, /fillChipHtml/);
  assert.match(invoices, /data-form-action="clear-fill"/);
  assert.match(invoices, /clear-fill/);          // handled in onFormClick
});

test('customers.js: wires the Contacts tab', () => {
  assert.match(customers, /data-cust-tab="contacts"/);
  assert.match(customers, /import\('\.\/contacts\.js'\)/);
});

test('customers.js: invoicing block is owner-gated', () => {
  assert.match(customers, /function invoicingBlock/);
  const body = customers.slice(customers.indexOf('function invoicingBlock'));
  assert.match(body.slice(0, 200), /AdminAuth\.isOwner\(\)/);
  assert.match(customers, /updateCustomerInvoicing/);
});

test('contacts.js: standalone page module with create/edit/delete', () => {
  assert.match(contacts, /export default/);
  assert.match(contacts, /createContact|updateContact/);
  assert.match(contacts, /deleteContact/);
  assert.match(contacts, /bill_to/);
  assert.match(contacts, /deliver_to/);
});
