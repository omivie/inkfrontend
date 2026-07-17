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
 * Since Jul 2026 operating categories are OWNER-MANAGED (loaded into the
 * registry via setCustomCategories); these tests also pin:
 *   - the built-in list is exactly the 3 order-linked keys + 'other'
 *   - custom keys can never claim a built-in / order-linked legacy key
 *     (that would silently re-classify historical rows as operating)
 *   - seeding adopts in-use keys (retired built-ins keep their old label +
 *     GST default) and is idempotent
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
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Set };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'expense-categories.js' });

// The registry is module-global; every test starts from a clean (empty) custom list.
test.beforeEach(() => { sandbox.setCustomCategories([]); });

// ─── built-ins ────────────────────────────────────────────────────────────────

test('built-ins are exactly the 3 order-linked categories + the "other" fallback', () => {
  const keys = JSON.parse(JSON.stringify(sandbox.EXPENSE_CATEGORIES.map(c => c.key))).sort();
  assert.deepEqual(keys, ['customer_shipping', 'inventory', 'merchant_fees', 'other']);
});

test('every built-in has key, label, a valid kind, and gstDefault', () => {
  for (const c of sandbox.EXPENSE_CATEGORIES) {
    assert.ok(c.key && typeof c.key === 'string', `key on ${JSON.stringify(c)}`);
    assert.ok(c.label && typeof c.label === 'string', `label on ${c.key}`);
    assert.ok(c.kind === 'operating' || c.kind === 'order_linked', `kind on ${c.key} is ${c.kind}`);
    assert.equal(typeof c.gstDefault, 'boolean', `gstDefault on ${c.key}`);
  }
});

test('order-linked kind covers exactly the auto-counted costs', () => {
  // Round-trip through JSON so the sandbox realm's Array prototype doesn't trip
  // deepStrictEqual's reference check.
  const linked = JSON.parse(JSON.stringify(sandbox.orderLinkedKeys())).sort();
  assert.deepEqual(linked, ['customer_shipping', 'inventory', 'merchant_fees']);
});

test('the retired defaults hold the 15 old operating categories, none overlapping built-ins', () => {
  const retired = Object.keys(sandbox.RETIRED_CATEGORY_DEFAULTS);
  assert.equal(retired.length, 15);
  const builtins = new Set(sandbox.EXPENSE_CATEGORIES.map(c => c.key));
  for (const k of retired) {
    assert.ok(!builtins.has(k), `${k} is both retired and built-in`);
    const d = sandbox.RETIRED_CATEGORY_DEFAULTS[k];
    assert.ok(d.label && typeof d.label === 'string', `label for ${k}`);
    assert.equal(typeof d.gstDefault, 'boolean', `gstDefault for ${k}`);
  }
  // Spot-pin the GST conventions the old registry carried.
  assert.equal(sandbox.RETIRED_CATEGORY_DEFAULTS.software.gstDefault, false, 'foreign SaaS off');
  assert.equal(sandbox.RETIRED_CATEGORY_DEFAULTS.rent.gstDefault, true, 'NZ premises on');
  assert.equal(sandbox.RETIRED_CATEGORY_DEFAULTS.wages.gstDefault, false, 'wages GST-exempt');
});

test('reserved keys = built-ins + non-identity legacy keys, and nothing else', () => {
  const reserved = JSON.parse(JSON.stringify(sandbox.RESERVED_CATEGORY_KEYS)).sort();
  assert.deepEqual(reserved, ['cogs', 'customer_shipping', 'inventory', 'merchant_fees', 'other', 'platform', 'salaries', 'shipping']);
});

// ─── slug + list normalisation ────────────────────────────────────────────────

test('slugifyCategoryKey: underscore slug, null when nothing survives', () => {
  assert.equal(sandbox.slugifyCategoryKey('Team Lunch!'), 'team_lunch');
  assert.equal(sandbox.slugifyCategoryKey('  Fuel & Oil  '), 'fuel_oil');
  assert.equal(sandbox.slugifyCategoryKey('supplier_shipping'), 'supplier_shipping');
  assert.equal(sandbox.slugifyCategoryKey('---'), null);
  assert.equal(sandbox.slugifyCategoryKey(''), null);
  assert.equal(sandbox.slugifyCategoryKey(null), null);
});

test('normalizeCustomCategoryList never trusts the prefs blob', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizeCustomCategoryList(null))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizeCustomCategoryList('junk'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizeCustomCategoryList({ a: 1 }))), []);
  const out = sandbox.normalizeCustomCategoryList([
    { key: 'fuel', label: 'Fuel' },
    { label: '  Team Lunch  ' },                    // key derived from label
    { key: 'inventory', label: 'Sneaky' },          // reserved built-in → dropped
    { key: 'shipping', label: 'Sneaky 2' },         // reserved legacy → dropped
    { key: 'fuel', label: 'Fuel dupe' },            // duplicate key → dropped
    { label: '' }, null, 42, ['x'],                 // junk → dropped
    { key: 'foreign_saas', label: 'Foreign SaaS', gstDefault: false },
    { key: 'weird!!key', label: 'Weird' },          // invalid key → re-derived from label
  ]);
  const plain = JSON.parse(JSON.stringify(out));
  assert.deepEqual(plain, [
    { key: 'fuel', label: 'Fuel' },
    { key: 'team_lunch', label: 'Team Lunch' },
    { key: 'foreign_saas', label: 'Foreign SaaS', gstDefault: false },
    { key: 'weird', label: 'Weird' },
  ]);
});

test('normalizeCustomCategoryList caps label length and list size', () => {
  const long = sandbox.normalizeCustomCategoryList([{ key: 'x', label: 'y'.repeat(200) }]);
  assert.equal(long[0].label.length, sandbox.MAX_CATEGORY_LABEL);
  const many = sandbox.normalizeCustomCategoryList(
    Array.from({ length: 60 }, (_, i) => ({ key: `cat_${i}`, label: `Cat ${i}` })));
  assert.equal(many.length, sandbox.MAX_CUSTOM_CATEGORIES);
});

// ─── the runtime registry ─────────────────────────────────────────────────────

test('setCustomCategories loads customs into every lookup', () => {
  sandbox.setCustomCategories([{ key: 'lunch', label: 'Lunch' }, { key: 'saas', label: 'SaaS', gstDefault: false }]);
  assert.equal(sandbox.normalizeCategory('lunch'), 'lunch');
  assert.equal(sandbox.categoryLabel('lunch'), 'Lunch');
  assert.equal(sandbox.categoryKind('lunch'), 'operating');
  assert.equal(sandbox.isOrderLinked('lunch'), false);
  assert.equal(sandbox.gstDefaultFor('lunch'), true, 'custom default = claimable');
  assert.equal(sandbox.gstDefaultFor('saas'), false, 'explicit gstDefault:false honoured');
});

test('setCustomCategories normalises its input and returns what it installed', () => {
  const installed = sandbox.setCustomCategories([{ key: 'inventory', label: 'Nope' }, { label: 'Fuel' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(installed)), [{ key: 'fuel', label: 'Fuel' }]);
  assert.equal(sandbox.normalizeCategory('fuel'), 'fuel');
});

test('unknown category falls back to "other" (operating), never throws', () => {
  assert.equal(sandbox.normalizeCategory('totally-made-up'), 'other');
  assert.equal(sandbox.normalizeCategory(''), 'other');
  assert.equal(sandbox.normalizeCategory(null), 'other');
  assert.equal(sandbox.categoryByKey('nope').kind, 'operating');
  assert.equal(sandbox.isOrderLinked('nope'), false);
});

test('a deleted/unknown custom key collapses to "other"', () => {
  assert.equal(sandbox.normalizeCategory('lunch'), 'other', 'not loaded → other');
  assert.equal(sandbox.categoryLabel('lunch'), 'Other');
});

test('legacy order-linked keys stay order-linked even with customs loaded', () => {
  sandbox.setCustomCategories([{ key: 'fuel', label: 'Fuel' }]);
  assert.equal(sandbox.normalizeCategory('cogs'), 'inventory');
  assert.equal(sandbox.normalizeCategory('platform'), 'merchant_fees');
  assert.equal(sandbox.normalizeCategory('shipping'), 'customer_shipping');
  assert.equal(sandbox.isOrderLinked('cogs'), true, 'legacy cogs must read as order-linked');
  assert.equal(sandbox.isOrderLinked('platform'), true);
  assert.equal(sandbox.isOrderLinked('shipping'), true);
});

test('legacy operating keys resolve to the owner\'s category when it exists, else "other"', () => {
  assert.equal(sandbox.normalizeCategory('salaries'), 'other', 'no wages category → other');
  sandbox.setCustomCategories([{ key: 'wages', label: 'Wages / contractor' }]);
  assert.equal(sandbox.normalizeCategory('salaries'), 'wages');
  assert.equal(sandbox.isOrderLinked('salaries'), false);
  assert.equal(sandbox.normalizeCategory('rent'), 'other', 'identity legacy key without a custom → other');
});

test('operatingCategories = owner\'s list + Other last; order-linked list is fixed', () => {
  sandbox.setCustomCategories([{ key: 'fuel', label: 'Fuel' }, { key: 'lunch', label: 'Lunch' }]);
  const ops = JSON.parse(JSON.stringify(sandbox.operatingCategories()));
  assert.deepEqual(ops.map(c => c.key), ['fuel', 'lunch', 'other']);
  for (const c of ops) assert.equal(c.kind, 'operating');
  assert.equal(sandbox.orderLinkedCategories().length, 3);
});

// ─── mutation helpers ─────────────────────────────────────────────────────────

test('addCustomCategory: happy path returns a NEW list + the derived key', () => {
  const list = [{ key: 'fuel', label: 'Fuel' }];
  const { list: next, key } = sandbox.addCustomCategory(list, '  Team Lunch  ');
  assert.equal(key, 'team_lunch');
  assert.equal(next.length, 2);
  assert.equal(next[1].label, 'Team Lunch');
  assert.equal(list.length, 1, 'input list never mutated');
});

test('addCustomCategory rejects reserved, duplicate, empty, and over-cap', () => {
  assert.throws(() => sandbox.addCustomCategory([], 'Shipping'), /built-in/);
  assert.throws(() => sandbox.addCustomCategory([], 'Other'), /built-in/);
  assert.throws(() => sandbox.addCustomCategory([], 'Inventory'), /built-in/);
  const list = [{ key: 'fuel', label: 'Fuel' }];
  assert.throws(() => sandbox.addCustomCategory(list, 'fuel!'), /already exists/, 'same key');
  assert.throws(() => sandbox.addCustomCategory(list, '  FUEL  '), /already exists/, 'same label, case-insensitive');
  assert.throws(() => sandbox.addCustomCategory([], ''), /name/);
  assert.throws(() => sandbox.addCustomCategory([], '!!!'), /letters or numbers/);
  assert.throws(() => sandbox.addCustomCategory([], 'y'.repeat(60)), /under/);
  const full = Array.from({ length: sandbox.MAX_CUSTOM_CATEGORIES }, (_, i) => ({ key: `c_${i}`, label: `C ${i}` }));
  assert.throws(() => sandbox.addCustomCategory(full, 'One More'), /up to/);
});

test('renameCustomCategory changes the label but NEVER the key', () => {
  const list = [{ key: 'team_lunch', label: 'Team Lunch' }, { key: 'fuel', label: 'Fuel' }];
  const next = sandbox.renameCustomCategory(list, 'team_lunch', 'Team Meals');
  assert.equal(next[0].key, 'team_lunch', 'key survives — saved rows keep resolving');
  assert.equal(next[0].label, 'Team Meals');
  assert.equal(list[0].label, 'Team Lunch', 'input never mutated');
  assert.throws(() => sandbox.renameCustomCategory(list, 'team_lunch', 'fuel'), /already has/);
  assert.throws(() => sandbox.renameCustomCategory(list, 'ghost', 'X'), /no longer exists/);
  assert.throws(() => sandbox.renameCustomCategory(list, 'fuel', ''), /name/);
});

test('removeCustomCategory filters by key, returns a NEW list', () => {
  const list = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
  const next = sandbox.removeCustomCategory(list, 'a');
  assert.deepEqual(JSON.parse(JSON.stringify(next)), [{ key: 'b', label: 'B' }]);
  assert.equal(list.length, 2);
});

// ─── seeding ─────────────────────────────────────────────────────────────────

test('seedMissingCategories adopts in-use keys: retired labels, legacy mapping, prettified unknowns', () => {
  const rows = [
    { category: 'software' },        // retired built-in → original label + gstDefault:false
    { category: 'lunch' },           // unknown custom → prettified
    { category: 'cogs' },            // legacy → built-in inventory → nothing to seed
    { category: 'salaries' },        // legacy → seeds wages with its retired label
    { category: 'other' },           // built-in → skipped
    { category: '' }, {},            // blank/junk → skipped
    { category: 'Bad Key!' },        // malformed stored key → never adopted
    { category: 'software' },        // repeat in the same batch → seeded once
  ];
  const { list, added } = sandbox.seedMissingCategories([], rows);
  const plain = JSON.parse(JSON.stringify(added));
  assert.deepEqual(plain, [
    { key: 'software', label: 'Software subscriptions', gstDefault: false },
    { key: 'lunch', label: 'Lunch' },
    { key: 'wages', label: 'Wages / contractor', gstDefault: false },
  ]);
  assert.equal(list.length, 3);

  // Idempotent: with the seeded list loaded, a second pass adds nothing.
  const again = sandbox.seedMissingCategories(list, rows);
  assert.equal(again.added.length, 0);
});

test('seedMissingCategories never throws and respects the cap', () => {
  assert.equal(sandbox.seedMissingCategories([], null).added.length, 0);
  assert.equal(sandbox.seedMissingCategories(null, [{ category: 'fuel' }]).added.length, 1);
  const nearFull = Array.from({ length: sandbox.MAX_CUSTOM_CATEGORIES - 1 }, (_, i) => ({ key: `c_${i}`, label: `C ${i}` }));
  const rows = [{ category: 'one_more' }, { category: 'too_many' }];
  const { list, added } = sandbox.seedMissingCategories(nearFull, rows);
  assert.equal(added.length, 1, 'stops at the cap instead of throwing');
  assert.equal(list.length, sandbox.MAX_CUSTOM_CATEGORIES);
});

test('seeding respects an existing custom entry (no duplicate, label kept)', () => {
  const mine = [{ key: 'software', label: 'My SaaS' }];
  const { added } = sandbox.seedMissingCategories(mine, [{ category: 'software' }]);
  assert.equal(added.length, 0);
});

// ─── per-expense overrides (custom keys the backend enum can't store) ────────

test('normalizeCategoryOverrides never trusts the prefs blob', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizeCategoryOverrides(null))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizeCategoryOverrides([1, 2]))), {});
  const out = sandbox.normalizeCategoryOverrides({
    'id-1': 'team_lunch',
    'id-2': 'inventory',      // reserved built-in → an override must never re-kind a row
    'id-3': 'shipping',       // reserved legacy → same double-count hazard
    'id-4': 42,               // junk
    'id-5': 'Bad Key!',       // malformed slug
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { 'id-1': 'team_lunch' });
});

test('resolveRowCategory applies an override ONLY on the "other" carrier value', () => {
  const ovr = { 'e1': 'team_lunch' };
  assert.equal(sandbox.resolveRowCategory('other', 'e1', ovr), 'team_lunch');
  assert.equal(sandbox.resolveRowCategory('other', 'e2', ovr), 'other', 'no entry → stays other');
  assert.equal(sandbox.resolveRowCategory('software', 'e1', ovr), 'software', 'a real stored key is never overridden');
  assert.equal(sandbox.resolveRowCategory('other', null, ovr), 'other');
  assert.equal(sandbox.resolveRowCategory('other', 'e1', null), 'other');
  // Numeric ids coerce to the map's string keys.
  assert.equal(sandbox.resolveRowCategory('other', 7, { '7': 'fuel' }), 'fuel');
});

test('an override whose category was deleted collapses to "other" at normalize time', () => {
  const raw = sandbox.resolveRowCategory('other', 'e1', { e1: 'ghost_category' });
  assert.equal(raw, 'ghost_category');
  assert.equal(sandbox.normalizeCategory(raw), 'other', 'unknown override key falls back safely');
  sandbox.setCustomCategories([{ key: 'ghost_category', label: 'Ghost' }]);
  assert.equal(sandbox.normalizeCategory(raw), 'ghost_category', 'and resolves once the category exists');
});
