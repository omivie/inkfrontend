/**
 * expense-presets.js — saved, reusable expense templates
 * =======================================================
 *
 * A preset is a NAMED SNAPSHOT of the Add-expense form, re-applied in one click.
 *
 * The rule that matters most: A PRESET NEVER CARRIES A DATE. On a cash-basis P&L,
 * silently re-using an old bill's `expense_date` / `paid_date` would book real money
 * into the wrong month. So `expense_date`, `due_date`, `paid_date` and
 * `recurrence_end` are stripped on the way in AND on the way out — belt and braces,
 * because a preset blob lives in a shared prefs object we don't fully control.
 * `recurrence_count` survives: it's a count, not a date.
 *
 * Presets persist in the `admin_ui_prefs` Supabase table (per-admin, RLS-locked) —
 * never in browser storage as the source of truth.
 *
 * Run with: node --test tests/admin-expenses-presets.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'expense-presets.js');

function stripEsm(src) {
  const exposed = new Set();
  const stripped = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map(id => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'expense-presets.js' });

const plain = (x) => JSON.parse(JSON.stringify(x));

// A realistic collectPayload() output for a recurring subscription.
const PAYLOAD = {
  name: 'Netflix subscription', description: 'Netflix subscription',
  payee: 'Netflix', vendor: 'Netflix',
  category: 'software', amount: 23.00, gst_claimable: false,
  expense_date: '2026-03-01', date: '2026-03-01',
  due_date: '2026-03-05', paid_date: '2026-03-02',
  method: 'card', reference: 'INV-9', notes: 'family plan',
  recurrence: 'monthly', recurrence_day_of_month: 1,
  recurrence_end: '2027-01-01', recurrence_count: 12,
  status: 'paid', series_state: 'active', id: 'abc-123',
};

// ─── the date rule ───────────────────────────────────────────────────────────
test('toPreset strips EVERY date + identity field', () => {
  const p = plain(sandbox.toPreset(PAYLOAD, 'Netflix'));
  for (const banned of ['expense_date', 'date', 'due_date', 'paid_date', 'recurrence_end', 'id', 'status', 'series_state']) {
    assert.equal(p.fields[banned], undefined, `${banned} must never be stored in a preset`);
  }
});

test('toPreset keeps the shape of the spend, incl. the recurrence rule', () => {
  const p = plain(sandbox.toPreset(PAYLOAD, 'Netflix'));
  assert.equal(p.name, 'Netflix');
  assert.equal(p.fields.name, 'Netflix subscription');
  assert.equal(p.fields.category, 'software');
  assert.equal(p.fields.payee, 'Netflix');
  assert.equal(p.fields.amount, 23);
  assert.equal(p.fields.gst_claimable, false);
  assert.equal(p.fields.method, 'card');
  assert.equal(p.fields.reference, 'INV-9');
  assert.equal(p.fields.notes, 'family plan');
  assert.equal(p.fields.recurrence, 'monthly');
  assert.equal(p.fields.recurrence_day_of_month, 1);
  assert.equal(p.fields.recurrence_count, 12, 'a count is not a date — it survives');
});

test('applyPresetToDraft strips dates even if a malformed preset smuggles one in', () => {
  const rogue = { name: 'x', fields: { name: 'X', category: 'rent', expense_date: '2020-01-01', paid_date: '2020-01-02', id: 'zzz' } };
  const draft = plain(sandbox.applyPresetToDraft(rogue));
  assert.equal(draft.expense_date, undefined);
  assert.equal(draft.paid_date, undefined);
  assert.equal(draft.id, undefined);
  assert.equal(draft.category, 'rent');
});

test('a preset with no recurrence applies as a one-off', () => {
  const draft = plain(sandbox.applyPresetToDraft({ name: 'p', fields: { name: 'Ink', category: 'other' } }));
  assert.equal(draft.recurrence, 'none');
});

test('round-trip: payload → preset → draft keeps the reusable fields', () => {
  const draft = plain(sandbox.applyPresetToDraft(sandbox.toPreset(PAYLOAD, 'Netflix')));
  assert.equal(draft.name, 'Netflix subscription');
  assert.equal(draft.amount, 23);
  assert.equal(draft.recurrence, 'monthly');
  assert.equal(draft.recurrence_day_of_month, 1);
  assert.equal(draft.expense_date, undefined, 'the caller re-anchors the date on today');
});

test('empty / undefined fields are dropped so a preset stays a sparse patch', () => {
  const p = plain(sandbox.toPreset({ name: 'A', category: 'rent', payee: '', notes: null, amount: NaN }, 'A'));
  assert.equal(p.fields.payee, undefined);
  assert.equal(p.fields.notes, undefined);
  assert.equal(p.fields.amount, undefined, 'a blank amount is legitimate (variable bill)');
});

// ─── list management ─────────────────────────────────────────────────────────
test('upsertPreset overwrites by name (case-insensitive) and keeps its slot', () => {
  const a = sandbox.toPreset({ name: 'Rent', category: 'rent', amount: 100 }, 'Rent');
  const b = sandbox.toPreset({ name: 'Power', category: 'utilities', amount: 50 }, 'Power');
  let list = sandbox.upsertPreset(sandbox.upsertPreset([], a), b);
  assert.equal(list.length, 2);

  const updated = sandbox.toPreset({ name: 'Rent', category: 'rent', amount: 999 }, 'rent'); // different case
  list = sandbox.upsertPreset(list, updated);
  assert.equal(list.length, 2, 'overwrite, not append');
  assert.equal(plain(list)[0].fields.amount, 999);
  assert.equal(plain(list)[0].name, 'rent');
  assert.equal(plain(list)[1].name, 'Power', 'order preserved');
});

test('upsertPreset never mutates the input array', () => {
  const orig = [];
  sandbox.upsertPreset(orig, sandbox.toPreset({ name: 'X', category: 'other' }, 'X'));
  assert.equal(orig.length, 0);
});

test('MAX_PRESETS caps genuinely-new presets (overwrites still allowed)', () => {
  let list = [];
  for (let i = 0; i < sandbox.MAX_PRESETS; i++) {
    list = sandbox.upsertPreset(list, sandbox.toPreset({ name: `P${i}`, category: 'other' }, `P${i}`));
  }
  assert.equal(list.length, sandbox.MAX_PRESETS);
  assert.throws(() => sandbox.upsertPreset(list, sandbox.toPreset({ name: 'one-too-many', category: 'other' }, 'one-too-many')), /up to 20 presets/i);
  // Overwriting an existing one at the cap must still work.
  const ok = sandbox.upsertPreset(list, sandbox.toPreset({ name: 'P0', category: 'rent' }, 'P0'));
  assert.equal(ok.length, sandbox.MAX_PRESETS);
});

test('removePreset drops by id and leaves the rest', () => {
  const list = sandbox.upsertPreset(sandbox.upsertPreset([],
    sandbox.toPreset({ name: 'A', category: 'other' }, 'A')),
    sandbox.toPreset({ name: 'B', category: 'other' }, 'B'));
  const left = plain(sandbox.removePreset(list, plain(list)[0].id));
  assert.equal(left.length, 1);
  assert.equal(left[0].name, 'B');
});

test('ids stay unique when two names slugify identically', () => {
  let list = sandbox.upsertPreset([], sandbox.toPreset({ name: 'a', category: 'other' }, 'Power bill'));
  list = sandbox.upsertPreset(list, sandbox.toPreset({ name: 'b', category: 'other' }, 'Power  bill!'));
  const ids = plain(list).map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, `ids must be unique, got ${ids}`);
});

// ─── hardening: the prefs blob is shared and untrusted ───────────────────────
test('normalizePresetList survives garbage in the shared prefs blob', () => {
  const raw = [null, 42, 'nope', { nope: 1 }, { name: '   ' }, { name: 'Good', fields: { category: 'rent' } }, { name: 'NoFields' }];
  const out = plain(sandbox.normalizePresetList(raw));
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Good');
  assert.deepEqual(out[1].fields, {}, 'a preset with no fields object gets an empty one');
  assert.ok(out.every(p => typeof p.id === 'string' && p.id));
  assert.deepEqual(plain(sandbox.normalizePresetList(undefined)), []);
  assert.deepEqual(plain(sandbox.normalizePresetList({ not: 'an array' })), []);
});

test('normalizePresetList honours the cap', () => {
  const raw = Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, fields: {} }));
  assert.equal(sandbox.normalizePresetList(raw).length, sandbox.MAX_PRESETS);
});

// ─── validation (much looser than an expense — a preset is a template) ───────
test('validatePreset: a name is the only hard requirement', () => {
  assert.match(sandbox.validatePreset('', []), /name/i);
  assert.match(sandbox.validatePreset('   ', []), /name/i);
  // No amount, no date, no category → still a perfectly valid preset.
  assert.equal(sandbox.validatePreset('Variable power bill', []), null);
});

test('validatePreset blocks a duplicate name unless overwrite is allowed', () => {
  const list = sandbox.upsertPreset([], sandbox.toPreset({ name: 'Rent', category: 'rent' }, 'Rent'));
  assert.match(sandbox.validatePreset('rent', list), /already exists/i);
  assert.equal(sandbox.validatePreset('rent', list, { allowOverwrite: true }), null);
});

test('validatePreset rejects an over-long name', () => {
  assert.match(sandbox.validatePreset('x'.repeat(sandbox.MAX_PRESET_NAME + 1), []), /under \d+ characters/i);
});

test('presetNameExists is case- and whitespace-insensitive', () => {
  const list = sandbox.upsertPreset([], sandbox.toPreset({ name: 'Rent', category: 'rent' }, 'Warehouse Rent'));
  assert.equal(sandbox.presetNameExists(list, '  warehouse rent '), true);
  assert.equal(sandbox.presetNameExists(list, 'other'), false);
  assert.equal(sandbox.presetNameExists(list, ''), false);
});

// ─── storage contract ────────────────────────────────────────────────────────
test('PRESET_KEY is namespaced for the shared admin_ui_prefs blob', () => {
  assert.equal(sandbox.PRESET_KEY, 'expenses.presets');
});
