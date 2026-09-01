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

// ─── editing an existing preset (Sep 2026) ───────────────────────────────────
// The pencil on a chip loads the preset AND aims the save row at it, so Update
// rewrites THAT preset in place. The edit path is id-anchored on purpose: upsertPreset
// matches on NAME, so using it for a rename would overwrite the preset that already
// owns the new name and leave the edited one behind — two presets lost in one click.

const P = (name, fields = {}) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, fields });
const LIST = () => [P('Rent', { category: 'rent', amount: 900 }),
                    P('Power bill', { category: 'utilities', amount: 120 }),
                    P('Netflix', { category: 'software', amount: 23 })];

test('updatePreset replaces values IN PLACE — id, index and length all survive', () => {
  const list = LIST();
  const next = plain(sandbox.updatePreset(list, 'power-bill',
    sandbox.toPreset({ name: 'Power bill', category: 'utilities', amount: 145 }, 'Power bill')));
  assert.equal(next.length, 3, 'an edit must never grow the list');
  assert.equal(next[1].id, 'power-bill', 'the id is the chip identity — it must not change');
  assert.equal(next[1].name, 'Power bill');
  assert.equal(next[1].fields.amount, 145);
  assert.deepEqual(next.map(x => x.name), ['Rent', 'Power bill', 'Netflix'], 'position must hold');
  assert.equal(plain(list)[1].fields.amount, 120, 'the input list must not be mutated');
});

test('a rename keeps the id and the position (the chip does not jump)', () => {
  const next = plain(sandbox.updatePreset(LIST(), 'power-bill',
    sandbox.toPreset({ name: 'Electricity', category: 'utilities', amount: 120 }, 'Electricity')));
  assert.equal(next[1].id, 'power-bill', 'a rename keeps the original id');
  assert.equal(next[1].name, 'Electricity');
  assert.deepEqual(next.map(x => x.name), ['Rent', 'Electricity', 'Netflix']);
});

test('renaming ONTO another preset name throws and changes nothing', () => {
  const list = LIST();
  assert.throws(
    () => sandbox.updatePreset(list, 'power-bill', sandbox.toPreset({ name: 'Rent' }, 'rent')),
    /already exists/i,
    'a rename must never overwrite the preset that owns that name');
  assert.deepEqual(plain(list).map(x => x.name), ['Rent', 'Power bill', 'Netflix']);
});

// POSITIVE CONTROL for the test above: without this, updatePreset refusing EVERY
// rename would pass just as well — the same bug pointing the other way.
test('a preset may keep its own name (different case/whitespace still counts as its own)', () => {
  const next = plain(sandbox.updatePreset(LIST(), 'power-bill',
    sandbox.toPreset({ name: 'x', amount: 130 }, '  POWER BILL ')));
  assert.equal(next[1].id, 'power-bill');
  assert.equal(next[1].name, 'POWER BILL');
  assert.equal(next[1].fields.amount, 130);
});

test('updatePreset on an unknown id THROWS — it never falls through to an append', () => {
  const list = LIST();
  assert.throws(() => sandbox.updatePreset(list, 'gone', sandbox.toPreset({ name: 'x' }, 'Ghost')),
    /no longer exists/i);
  assert.equal(plain(sandbox.normalizePresetList(list)).length, 3, 'a failed edit must not mint a duplicate');
  assert.throws(() => sandbox.updatePreset(LIST(), 'rent', sandbox.toPreset({}, '  ')), /name/i);
});

test('an edit is not a new entry — the cap cannot block it', () => {
  const full = Array.from({ length: sandbox.MAX_PRESETS }, (_, i) => P(`P${i}`, { amount: i }));
  const next = plain(sandbox.updatePreset(full, 'p0', sandbox.toPreset({ amount: 999 }, 'P0')));
  assert.equal(next.length, sandbox.MAX_PRESETS);
  assert.equal(next[0].fields.amount, 999);
  assert.equal(sandbox.validatePreset('P0', full, { exceptId: 'p0' }), null,
    'a full list must still accept an edit of one of its own rows');
  assert.match(sandbox.validatePreset('P1', full, { exceptId: 'p0' }), /already exists/i,
    'but not one renamed onto a sibling');
});

test('presetNameExists/validatePreset skip the preset being edited', () => {
  const list = LIST();
  assert.equal(sandbox.presetNameExists(list, 'rent'), true);
  assert.equal(sandbox.presetNameExists(list, ' RENT ', 'rent'), false, 'its own name is not a clash');
  assert.equal(sandbox.validatePreset('Rent', list, { exceptId: 'rent' }), null);
  assert.match(sandbox.validatePreset('Rent', list, { exceptId: 'netflix' }), /already exists/i);
});

test('THE DATE RULE HOLDS ON THE EDIT PATH TOO', () => {
  // The edit commit snapshots the live form through the same toPreset(), so a dated
  // payload must come out just as dateless as it does on the create path.
  const next = plain(sandbox.updatePreset(LIST(), 'netflix', sandbox.toPreset(PAYLOAD, 'Netflix')));
  for (const banned of ['expense_date', 'date', 'due_date', 'paid_date', 'recurrence_end', 'id', 'status', 'series_state']) {
    assert.equal(next[2].fields[banned], undefined, `${banned} must never survive an edit either`);
  }
  assert.equal(next[2].fields.recurrence_count, 12, 'a count is not a date — it stays');
  assert.equal(next[2].id, 'netflix');
});

// ─── storage contract ────────────────────────────────────────────────────────
test('PRESET_KEY is namespaced for the shared admin_ui_prefs blob', () => {
  assert.equal(sandbox.PRESET_KEY, 'expenses.presets');
});

// ─── editor contract: loading a preset ───────────────────────────────────────
// Static source assertions against the page (matching the other admin-expenses-*
// tests) — the pure module above can't see the DOM the editor writes into.
const PAGE_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'expenses.js'), 'utf8');

test('a fresh draft is Already-paid by default', () => {
  assert.match(PAGE_SRC, /function freshDraft\(\)[\s\S]*?paid_date: todayInputValue\(\)/,
    'freshDraft must seed paid_date with today so "Already paid" starts checked');
});

test('loading a preset leaves "Already paid" CHECKED and its date row visible', () => {
  const apply = PAGE_SRC.slice(PAGE_SRC.indexOf('const applyPreset = (preset)'));
  assert.ok(apply, 'applyPreset must exist');
  assert.match(apply, /\$\('#e-paid'\)\.checked = true/,
    'applying a preset must CHECK "Already paid" (same default as freshDraft)');
  assert.match(apply, /#e-paid-wrap'\)\?\.classList\.remove\('hidden'\)/,
    'the paid-date row must be revealed, not left hidden behind a checked box');
  assert.doesNotMatch(apply.slice(0, apply.indexOf('Toast.info')), /\$\('#e-paid'\)\.checked = false/,
    'nothing in applyPreset may uncheck "Already paid" again');
});

test('a preset-loaded paid date re-anchors on the expense date, never on the preset', () => {
  const apply = PAGE_SRC.slice(PAGE_SRC.indexOf('const applyPreset = (preset)'));
  assert.match(apply, /paidDate\.dataset\.touched = '';\s*paidDate\.value = \$\('#e-date'\)\.value/,
    'the paid date must be re-armed to the re-anchored (today) expense date');
  assert.doesNotMatch(apply.slice(0, apply.indexOf('Toast.info')), /patch\.paid_date|patch\.expense_date/,
    'applyPreset must never read a date off the preset patch');
});

// ─── editor contract: editing a preset (Sep 2026) ────────────────────────────
test('every chip carries an Edit control, and the one being edited is marked', () => {
  const panel = PAGE_SRC.slice(PAGE_SRC.indexOf('function presetsPanel('),
                               PAGE_SRC.indexOf('function editorBody('));
  assert.match(panel, /data-preset-edit="\$\{escA\(p\.id\)\}"/, 'the pencil is keyed by preset id');
  assert.match(panel, /aria-label="Edit preset \$\{escA\(p\.name\)\}"/, 'the pencil needs an accessible name');
  assert.match(panel, /p\.id === editingId \? ' is-editing' : ''/, 'the edited chip must be visibly marked');
  assert.match(panel, /id="e-preset-cancel"/, 'edit mode needs a way out that changes nothing');
  assert.match(panel, /id="e-preset-mode"/, 'the panel must say which preset is being edited');
});

test('the Update commit is id-anchored — updatePreset, never upsertPreset', () => {
  const commit = PAGE_SRC.slice(PAGE_SRC.indexOf('const updateExistingPreset = async ()'));
  const body = commit.slice(0, commit.indexOf("$('#e-preset-cancel')"));
  assert.ok(body.length, 'updateExistingPreset must exist');
  assert.match(body, /updatePreset\(_presets, editingPresetId, toPreset\(/,
    'an edit must be keyed on the id, not on the name (upsertPreset would clobber a sibling)');
  assert.doesNotMatch(body, /upsertPreset/, 'upsertPreset matches by NAME — never use it to edit');
  assert.match(body, /validatePreset\(name, _presets, \{ exceptId: editingPresetId \}\)/,
    'a preset must be allowed to keep its own name');
  assert.match(body, /presetErr\(e3\.message\)/, 'a refused rename is reported on the panel, not swallowed');
  assert.match(body, /durable === false/, 'a local-only write must still be reported honestly');
});

test('the add path still branches away from the edit path', () => {
  const add = PAGE_SRC.slice(PAGE_SRC.indexOf("$('#e-preset-add')?.addEventListener"));
  assert.match(add.slice(0, 200), /if \(editingPresetId\) \{ await updateExistingPreset\(\); return; \}/,
    '"Save as preset" must become Update while a preset is open for editing');
});

test('edit mode is never left pointing at a preset that is gone or at the wrong one', () => {
  const chips = PAGE_SRC.slice(PAGE_SRC.indexOf("root.querySelector('#e-preset-chips')"));
  const body = chips.slice(0, chips.indexOf('const updateExistingPreset'));
  assert.match(body, /if \(p\.id === editingPresetId\) setPresetEditMode\(null\)/,
    'deleting the preset under edit must leave edit mode');
  const load = body.slice(body.indexOf("const loadBtn"), body.indexOf("const delBtn"));
  assert.match(load, /setPresetEditMode\(null\);\s*\n\s*applyPreset\(p\)/,
    'a plain chip load must leave edit mode, or Update would write B over A');
});
