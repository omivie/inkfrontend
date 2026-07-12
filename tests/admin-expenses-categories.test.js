/**
 * expense-categories.js — the single source of truth for expense categories
 * ==========================================================================
 *
 * Pins the two-tier category model that prevents the double-counting bug: the
 * old form summed COGS/platform/shipping expenses into opex ON TOP of the
 * per-order COGS/Stripe/courier the system already computes. Order-linked
 * categories must be flagged so the math can exclude them, and legacy keys must
 * normalise onto the correct kind so historical rows stop double-counting the
 * moment this ships — without rewriting stored values.
 *
 * Run with: node --test tests/admin-expenses-categories.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'expense-categories.js');

function stripEsm(src) {
  const exposed = new Set();
  const stripped = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map(id => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'expense-categories.js' });

test('every category has key, label, a valid kind, and gstDefault', () => {
  for (const c of sandbox.EXPENSE_CATEGORIES) {
    assert.ok(c.key && typeof c.key === 'string', `key on ${JSON.stringify(c)}`);
    assert.ok(c.label && typeof c.label === 'string', `label on ${c.key}`);
    assert.ok(c.kind === 'operating' || c.kind === 'order_linked', `kind on ${c.key} is ${c.kind}`);
    assert.equal(typeof c.gstDefault, 'boolean', `gstDefault on ${c.key}`);
  }
});

test('category keys are unique', () => {
  const keys = sandbox.EXPENSE_CATEGORIES.map(c => c.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate category key');
});

test('order-linked kind covers exactly the auto-counted costs', () => {
  // Round-trip through JSON so the sandbox realm's Array prototype doesn't trip
  // deepStrictEqual's reference check.
  const linked = JSON.parse(JSON.stringify(sandbox.orderLinkedKeys())).sort();
  assert.deepEqual(linked, ['customer_shipping', 'inventory', 'merchant_fees']);
});

test('isOrderLinked is true for auto-counted costs, false for genuine opex', () => {
  assert.equal(sandbox.isOrderLinked('inventory'), true);
  assert.equal(sandbox.isOrderLinked('merchant_fees'), true);
  assert.equal(sandbox.isOrderLinked('customer_shipping'), true);
  assert.equal(sandbox.isOrderLinked('software'), false);
  assert.equal(sandbox.isOrderLinked('rent'), false);
  assert.equal(sandbox.isOrderLinked('marketing'), false);
});

test('legacy keys normalise onto the correct current key + kind', () => {
  // The old form saved these; they must land on order-linked so they stop
  // double-counting immediately.
  assert.equal(sandbox.normalizeCategory('cogs'), 'inventory');
  assert.equal(sandbox.normalizeCategory('platform'), 'merchant_fees');
  assert.equal(sandbox.normalizeCategory('shipping'), 'customer_shipping');
  assert.equal(sandbox.isOrderLinked('cogs'), true, 'legacy cogs must read as order-linked');
  assert.equal(sandbox.isOrderLinked('platform'), true);
  assert.equal(sandbox.isOrderLinked('shipping'), true);
  // Genuine opex legacy keys stay operating.
  assert.equal(sandbox.normalizeCategory('salaries'), 'wages');
  assert.equal(sandbox.normalizeCategory('rent'), 'rent');
  assert.equal(sandbox.isOrderLinked('salaries'), false);
});

test('unknown category falls back to "other" (operating), never throws', () => {
  assert.equal(sandbox.normalizeCategory('totally-made-up'), 'other');
  assert.equal(sandbox.normalizeCategory(''), 'other');
  assert.equal(sandbox.normalizeCategory(null), 'other');
  assert.equal(sandbox.categoryByKey('nope').kind, 'operating');
  assert.equal(sandbox.isOrderLinked('nope'), false);
});

test('gstDefaultFor: foreign SaaS off, NZ premises on, wages off', () => {
  assert.equal(sandbox.gstDefaultFor('software'), false);
  assert.equal(sandbox.gstDefaultFor('rent'), true);
  assert.equal(sandbox.gstDefaultFor('utilities'), true);
  assert.equal(sandbox.gstDefaultFor('wages'), false);
});

test('operating + order-linked partition the whole registry', () => {
  const total = sandbox.EXPENSE_CATEGORIES.length;
  assert.equal(sandbox.operatingCategories().length + sandbox.orderLinkedCategories().length, total);
});
