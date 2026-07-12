/**
 * expense-recurrence.js — template → projected occurrences
 * ========================================================
 *
 * The recurring-expense engine. Pins the month-end clamp, leap-year handling,
 * every frequency, the two end modes (on-date / after-N), window bounding, and
 * status derivation. Recurring expenses that silently break here are the exact
 * "disappears after refresh / fires on the wrong day" class of bug this page
 * exists to kill.
 *
 * Run with: node --test tests/admin-expenses-recurrence.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'expense-recurrence.js');

function stripEsm(src) {
  const exposed = new Set();
  const stripped = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map(id => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'expense-recurrence.js' });

const D = (s) => sandbox.parseUtcDate(s);
// Values returned from the vm sandbox carry the sandbox realm's prototypes, so
// deepStrictEqual rejects them despite equal structure. Round-trip to plain
// host-realm objects before comparing.
const plain = (x) => JSON.parse(JSON.stringify(x));
const dates = (occ) => plain(occ).map(o => o.date);

// ─── month-end / leap year ───────────────────────────────────────────────────
test('monthly on the 31st falls back to the last valid day of shorter months', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'monthly', recurrence_day_of_month: 31, expense_date: '2026-01-31' },
    D('2026-01-01'), D('2026-05-01'));
  assert.deepEqual(dates(occ), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('yearly Feb 29 honours leap years and clamps to Feb 28 otherwise', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'yearly', recurrence_month: 2, recurrence_day_of_month: 29, expense_date: '2024-02-29' },
    D('2024-01-01'), D('2028-03-01'));
  assert.deepEqual(dates(occ), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
});

// ─── each frequency ──────────────────────────────────────────────────────────
test('weekly aligns to the requested day of week', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'weekly', recurrence_day_of_week: 3, expense_date: '2026-07-06' }, // Mon start, want Wed
    D('2026-07-01'), D('2026-07-31'));
  assert.deepEqual(dates(occ), ['2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29']);
});

test('fortnightly steps 14 days', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'fortnightly', recurrence_day_of_week: 1, expense_date: '2026-07-06' },
    D('2026-07-01'), D('2026-08-31'));
  assert.deepEqual(dates(occ), ['2026-07-06', '2026-07-20', '2026-08-03', '2026-08-17', '2026-08-31']);
});

test('quarterly steps 3 months', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'quarterly', recurrence_day_of_month: 15, expense_date: '2026-01-15' },
    D('2026-01-01'), D('2026-12-31'));
  assert.deepEqual(dates(occ), ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
});

test('yearly steps 1 year on the pinned month/day', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'yearly', recurrence_month: 3, recurrence_day_of_month: 3, expense_date: '2025-03-03' },
    D('2025-01-01'), D('2027-12-31'));
  assert.deepEqual(dates(occ), ['2025-03-03', '2026-03-03', '2027-03-03']);
});

test('custom every N days', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'custom', recurrence_interval_days: 10, expense_date: '2026-07-01' },
    D('2026-07-01'), D('2026-08-01'));
  assert.deepEqual(dates(occ), ['2026-07-01', '2026-07-11', '2026-07-21', '2026-07-31']);
});

// ─── end conditions ──────────────────────────────────────────────────────────
test('recurrence_end is an inclusive stop', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'monthly', recurrence_day_of_month: 1, recurrence_end: '2026-03-01', expense_date: '2026-01-01' },
    D('2026-01-01'), D('2027-01-01'));
  assert.deepEqual(dates(occ), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('recurrence_count ends the series after N occurrences (counted from start)', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'custom', recurrence_interval_days: 10, recurrence_count: 3, expense_date: '2026-07-01' },
    D('2026-06-01'), D('2027-01-01'));
  assert.deepEqual(dates(occ), ['2026-07-01', '2026-07-11', '2026-07-21']);
});

test('recurrence_count is counted from the series start, not the window', () => {
  // Window starts AFTER the 2nd fire — count must already be "used up".
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'monthly', recurrence_day_of_month: 1, recurrence_count: 3, expense_date: '2026-01-01' },
    D('2026-03-15'), D('2027-01-01'));
  // Only the 3rd fire (2026-03-01) exists, and it's before the window → none.
  assert.deepEqual(dates(occ), []);
});

// ─── window bounding + safety ────────────────────────────────────────────────
test('only occurrences inside the window are returned', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'monthly', recurrence_day_of_month: 10, expense_date: '2020-01-10' },
    D('2026-06-01'), D('2026-08-31'));
  assert.deepEqual(dates(occ), ['2026-06-10', '2026-07-10', '2026-08-10']);
});

test('never generates unbounded rows even for a 1-day custom over a century', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'custom', recurrence_interval_days: 1, expense_date: '2000-01-01' },
    D('2000-01-01'), D('2100-01-01'));
  assert.ok(occ.length <= 6000, `expected <= HARD_ITER_CAP, got ${occ.length}`);
});

test('one-off yields a single occurrence and strips recurrence keys', () => {
  const occ = sandbox.expandExpenseOccurrences(
    { recurrence: 'none', expense_date: '2026-07-05', recurrence_day_of_month: 5 },
    D('2026-07-01'), D('2026-07-31'));
  assert.equal(occ.length, 1);
  assert.equal(occ[0].date, '2026-07-05');
  assert.equal(occ[0].recurrence, undefined, 'recurrence key must be stripped');
  assert.equal(occ[0].recurrence_day_of_month, undefined);
});

test('non-object / empty input is safe', () => {
  assert.deepEqual(plain(sandbox.expandExpenseOccurrences(null, 0, 1)), []);
  assert.deepEqual(plain(sandbox.expandExpenseOccurrences({ expense_date: 'garbage' }, 0, 1)), []);
});

// ─── nextOccurrence + status ─────────────────────────────────────────────────
test('nextOccurrence returns the first fire on/after a date', () => {
  const t = { recurrence: 'monthly', recurrence_day_of_month: 20, expense_date: '2026-01-20' };
  assert.equal(sandbox.nextOccurrence(t, D('2026-07-11')), '2026-07-20');
  assert.equal(sandbox.nextOccurrence(t, D('2026-07-20')), '2026-07-20');
  assert.equal(sandbox.nextOccurrence(t, D('2026-07-21')), '2026-08-20');
});

test('deriveStatus: overdue / due / scheduled / paid', () => {
  const today = D('2026-07-11');
  assert.equal(sandbox.deriveStatus({ due_date: '2026-07-01' }, today), 'overdue');
  assert.equal(sandbox.deriveStatus({ due_date: '2026-07-11' }, today), 'due');
  assert.equal(sandbox.deriveStatus({ due_date: '2026-07-20' }, today), 'scheduled');
  assert.equal(sandbox.deriveStatus({ due_date: '2026-07-01', paid_date: '2026-07-02' }, today), 'paid');
  assert.equal(sandbox.deriveStatus({ due_date: '2026-07-01', status: 'skipped' }, today), 'skipped');
});

test('describeRecurrence produces readable summaries', () => {
  assert.equal(sandbox.describeRecurrence({ recurrence: 'none' }), 'One-off');
  assert.match(sandbox.describeRecurrence({ recurrence: 'monthly', recurrence_day_of_month: 15 }), /Monthly · day 15/);
  assert.match(sandbox.describeRecurrence({ recurrence: 'custom', recurrence_interval_days: 45 }), /Every 45 days/);
});
