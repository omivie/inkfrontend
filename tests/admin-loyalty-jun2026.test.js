/**
 * Admin: Customer Loyalty Points (June 2026)
 * ==========================================
 *
 * Pins the admin surface for viewing + adjusting a customer's loyalty points,
 * built into the Customers detail drawer (no new top-level section):
 *
 *   - AdminAPI:   getCustomerLoyalty (GET /api/admin/customers/:id/loyalty, fail-soft),
 *                 adjustCustomerPoints (POST .../loyalty/adjust, throws on ok:false).
 *   - customers:  loyalty panel in the drawer (balance + ledger, fail-soft), an
 *                 OWNER-only "Adjust points" button, a validated adjust modal.
 *   - Handoff:    admin-loyalty-endpoints-jun2026.md documents the assumed backend contract.
 *
 * Run with: node --test tests/admin-loyalty-jun2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');
const REPO = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// AdminAPI layer
// ─────────────────────────────────────────────────────────────────────────────

test('admin/api.js: getCustomerLoyalty GETs the admin endpoint and is fail-soft', () => {
  const src = JS('admin/api.js');
  assert.match(src, /async getCustomerLoyalty\(customerId\)\s*{/, 'getCustomerLoyalty defined');
  assert.match(src, /\/api\/admin\/customers\/\$\{customerId\}\/loyalty/, 'GET /api/admin/customers/:id/loyalty');
  // Fail-soft: returns null on error like getCustomers (so the drawer degrades).
  assert.match(src, /async getCustomerLoyalty[\s\S]*?catch[\s\S]*?return null;/, 'returns null on error');
});

test('admin/api.js: adjustCustomerPoints POSTs the adjust endpoint and throws on ok:false', () => {
  const src = JS('admin/api.js');
  assert.match(src, /async adjustCustomerPoints\(customerId,\s*{\s*points,\s*reason,\s*type[\s\S]*?}\)/, 'adjustCustomerPoints signature');
  assert.match(src, /\/api\/admin\/customers\/\$\{customerId\}\/loyalty\/adjust/, 'POST .../loyalty/adjust');
  assert.match(src, /adjustCustomerPoints[\s\S]*?ok === false[\s\S]*?throw new Error/, 'throws when ok:false');
});

// ─────────────────────────────────────────────────────────────────────────────
// Customers drawer: panel + owner-gated adjust
// ─────────────────────────────────────────────────────────────────────────────

test('customers.js: drawer fetches loyalty in parallel and renders a fail-soft panel', () => {
  const src = JS('admin/pages/customers.js');
  assert.match(src, /Promise\.allSettled\(\[[\s\S]*?getCustomerLoyalty\(customer\.id\)/, 'loyalty fetched in parallel with orders');
  assert.match(src, /loyaltyPanelBlock\(/, 'panel block rendered into the drawer');
  assert.match(src, /id="cust-loyalty-panel"/, 'panel has a refreshable container');
  assert.match(src, /Loyalty data unavailable/, 'null loyalty degrades to a muted notice, not a crash');
  // Drawer-closed guard after awaits.
  assert.match(src, /drawer\.el\.isConnected/, 'guards against the drawer being closed mid-await');
});

test('customers.js: ledger reuses the canonical type labels and is escaped', () => {
  const src = JS('admin/pages/customers.js');
  for (const t of ['earn', 'bonus', 'redeem', 'clawback', 'restore', 'adjust']) {
    assert.match(src, new RegExp(`${t}:`), `ledger label map includes ${t}`);
  }
  assert.match(src, /esc\(LOYALTY_LEDGER_LABELS\[L\.type\]/, 'ledger type rendered through esc()');
  assert.match(src, /esc\(L\.reason/, 'ledger reason rendered through esc()');
});

test('customers.js: Adjust button is owner-gated; modal validates and calls adjustCustomerPoints', () => {
  const src = JS('admin/pages/customers.js');
  // Button only rendered for owners.
  assert.match(src, /AdminAuth\.isOwner\(\)[\s\S]*?id="cust-loyalty-adjust"/, 'adjust button gated behind AdminAuth.isOwner()');
  // Validation in collectAdjust.
  assert.match(src, /Number\.isInteger\(raw\)\s*\|\|\s*raw\s*<=\s*0/, 'rejects non-integer / non-positive points');
  assert.match(src, /A reason is required/, 'requires a reason');
  assert.match(src, /Math\.abs\(points\)\s*>\s*balance/, 'cannot remove more than the balance');
  assert.match(src, /type:\s*'adjust'/, "sends type 'adjust'");
  // Save path.
  assert.match(src, /AdminAPI\.adjustCustomerPoints\(customer\.id,\s*payload\)/, 'calls adjustCustomerPoints on save');
  assert.match(src, /onAdjusted\(updated\)/, 'refreshes the panel from the response');
  assert.match(src, /Adjustment failed/, 'surfaces backend error to the owner');
});

test('customers.js: imports the Modal component', () => {
  const src = JS('admin/pages/customers.js');
  assert.match(src, /import\s*{\s*Modal\s*}\s*from\s*'\.\.\/components\/modal\.js'/, 'Modal imported');
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint contract
//
// This used to assert that `admin-loyalty-endpoints-jun2026.md` existed in the repo
// root. That file was deliberately deleted (2026-05-11) along with every other backend
// handoff doc: the repo is kept .md-free and `tests/no-ghost-files.test.js` actively
// forbids those paths from reappearing. So the test was demanding a file the repo's own
// policy bans — permanently red, and unfixable without breaking the other test.
//
// The durable home for the contract is the code that calls it. Assert it there.
// ─────────────────────────────────────────────────────────────────────────────

test('the loyalty endpoint contract is wired in admin/api.js', () => {
  const API_SRC = JS('admin/api.js');
  assert.match(API_SRC, /\/api\/admin\/customers\/\$\{customerId\}\/loyalty`/,
    'the read endpoint GET /api/admin/customers/:id/loyalty must be called');
  assert.match(API_SRC, /\/api\/admin\/customers\/\$\{customerId\}\/loyalty\/adjust`/,
    'the adjust endpoint POST /api/admin/customers/:id/loyalty/adjust must be called');
  assert.match(API_SRC, /\{\s*points,\s*reason,\s*type\s*\}/,
    'adjust must send { points, reason, type }');
});
