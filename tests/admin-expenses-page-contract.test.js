/**
 * Expense Management page — wiring contract (Jul 2026)
 * ====================================================
 *
 * The dedicated Finance → Expenses page is owner-only and must be registered in
 * BOTH gates (nav + route), its module + utils must exist and be wired, the
 * cache-busting versions must be bumped so browsers actually load it, and the
 * old embedded expense form on Financial Health must be gone (replaced by a
 * summary card that links to the new page). This pins all of that so a partial
 * wire-up (e.g. nav shown but route not gated, or version not bumped) fails CI.
 *
 * Run with: node --test tests/admin-expenses-page-contract.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

const appJs = read(path.join(ADMIN, 'app.js'));
const apiJs = read(path.join(ADMIN, 'api.js'));
const indexHtml = read(path.join(ROOT, 'inkcartridges', 'html', 'admin', 'index.html'));
const fhJs = read(path.join(ADMIN, 'pages', 'financial-health.js'));

test('the page module + four utils exist', () => {
  for (const f of ['pages/expenses.js', 'utils/expense-categories.js', 'utils/expense-recurrence.js', 'utils/expense-math.js', 'utils/expense-presets.js']) {
    assert.ok(fs.existsSync(path.join(ADMIN, f)), `${f} must exist`);
  }
});

test('nav registers an owner-only Expenses item under Finance', () => {
  assert.match(appJs, /key:\s*'expenses'[^}]*ownerOnly:\s*true/, 'NAV_ITEMS must have an owner-only expenses entry');
  // July 2026 IA overhaul: Expenses moved from "Analytics" into the "Finance" section.
  const financeIdx = appJs.indexOf("section: 'Finance'");
  const expensesIdx = appJs.indexOf("key: 'expenses'");
  assert.ok(financeIdx > 0 && expensesIdx > financeIdx, 'expenses nav item belongs to the Finance section');
});

test('route gate blocks #expenses for non-owners', () => {
  // July 2026: owner gating derives from NAV_ITEMS via isOwnerOnlyRoute() (no
  // separate ownerPages array). An owner nav item + the derived gate = blocked.
  assert.match(appJs, /key:\s*'expenses'[^}]*ownerOnly:\s*true/, "expenses must be flagged ownerOnly so isOwnerOnlyRoute() gates it");
  assert.match(appJs, /isOwnerOnlyRoute\(pageName\)\s*&&\s*!AdminAuth\.isOwner\(\)/, 'navigate() must gate owner routes through isOwnerOnlyRoute()');
});

test('cache-busting versions were bumped off the previous release', () => {
  const appVer = appJs.match(/const APP_VERSION = '([^']+)'/)[1];
  assert.notEqual(appVer, '2026.07.10-router-hashchange', 'APP_VERSION must be bumped');
  assert.match(appVer, /^\d{4}\.\d{2}\.\d{2}/, 'APP_VERSION keeps the date-prefixed format');
  assert.doesNotMatch(indexHtml, /app\.js\?v=2026-07-10b/, 'index.html app.js ?v= must be bumped');
  assert.doesNotMatch(indexHtml, /admin\.css\?v=2026-07-10a/, 'index.html admin.css ?v= must be bumped');
  assert.match(indexHtml, /app\.js\?v=[^"']+/, 'app.js still versioned');
  assert.match(indexHtml, /admin\.css\?v=[^"']+/, 'admin.css still versioned');
});

test('AdminAPI.expenses namespace exposes the CRUD + status contract', () => {
  const idx = apiJs.indexOf('expenses: {');
  assert.ok(idx > 0, 'AdminAPI.expenses namespace must exist');
  const end = apiJs.indexOf('Admin — Control Center', idx);
  const block = apiJs.slice(idx, end > idx ? end : idx + 8000);
  for (const method of ['list(', 'create(', 'update(', 'remove(', 'pay(', 'unpay(', 'pause(', 'resume(', 'end(', 'occurrences(', 'summary(']) {
    assert.ok(block.includes(method), `AdminAPI.expenses must define ${method}`);
  }
});

test('expenses page imports the shared utils (single source of truth)', () => {
  const page = read(path.join(ADMIN, 'pages', 'expenses.js'));
  assert.match(page, /from '\.\.\/utils\/expense-categories\.js'/);
  assert.match(page, /from '\.\.\/utils\/expense-recurrence\.js'/);
  assert.match(page, /from '\.\.\/utils\/expense-math\.js'/);
  assert.match(page, /export default/);
  assert.match(page, /async init\(/);
  assert.match(page, /destroy\(\)/);
});

test('Financial Health no longer embeds the expense management form', () => {
  assert.doesNotMatch(fhJs, /fh-expense-form-el/, 'the inline expense <form> must be removed');
  assert.doesNotMatch(fhJs, /renderExpenseForm|bindExpenseForm/, 'dead form functions must be gone');
  // It now shows a summary card that opens the dedicated page.
  assert.match(fhJs, /fh-open-expenses/, 'summary card must link to Expense Management');
  assert.match(fhJs, /hash = 'expenses'/, 'the button navigates to #expenses');
});

test('no financial value is persisted to browser storage as the source of truth', () => {
  const page = read(path.join(ADMIN, 'pages', 'expenses.js'));
  // The page may read window/session for UI prefs, but must never write expense
  // records there. Guard against the anti-pattern the brief explicitly forbids.
  assert.doesNotMatch(page, /localStorage\.setItem/i, 'expenses must not be stored in localStorage');
  assert.doesNotMatch(page, /sessionStorage\.setItem/i, 'expenses must not be stored in sessionStorage');
});

// ─── Presets (Jul 2026) ──────────────────────────────────────────────────────
test('presets persist in the admin_ui_prefs DB table, not browser storage', () => {
  const page = read(path.join(ADMIN, 'pages', 'expenses.js'));
  // The durable write goes through AdminAPI (Supabase admin_ui_prefs, RLS-locked to
  // the admin). The page itself must never reach for browser storage.
  assert.match(page, /AdminAPI\.setUiPref\(\s*PRESET_KEY/, 'presets must be written via AdminAPI.setUiPref');
  assert.match(page, /AdminAPI\.getUiPrefs\(\)/, 'presets must be read via AdminAPI.getUiPrefs');
  assert.match(page, /from '\.\.\/utils\/expense-presets\.js'/, 'presets logic lives in the shared util');
});

test('a preset can never carry a date (cash-basis safety)', () => {
  const util = read(path.join(ADMIN, 'utils', 'expense-presets.js'));
  const fields = /export const PRESET_FIELDS = \[([\s\S]*?)\];/.exec(util);
  assert.ok(fields, 'PRESET_FIELDS must exist');
  for (const banned of ['expense_date', 'due_date', 'paid_date', 'recurrence_end']) {
    assert.ok(!fields[1].includes(`'${banned}'`), `PRESET_FIELDS must not include ${banned} — re-dating an old bill would book money in the wrong month`);
  }
  // And they're explicitly scrubbed on the way out too.
  assert.match(util, /export const PRESET_BLOCKED_FIELDS/);
});

// ─── Live backend wire-up (Jul 2026) ─────────────────────────────────────────
test('pay/unpay send an explicit occurrence_date so the backend never guesses', () => {
  assert.match(apiJs, /async pay\(id, \{ paid_date, amount, occurrence_date \}/, 'pay must accept occurrence_date');
  assert.match(apiJs, /async unpay\(id, \{ occurrence_date \}/, 'unpay must accept occurrence_date');
});

test('the stale "backend pending" copy is gone (the API is live)', () => {
  const page = read(path.join(ADMIN, 'pages', 'expenses.js'));
  assert.doesNotMatch(page, /backend pending/i, 'the expense API shipped — this messaging is stale');
  assert.doesNotMatch(page, /needs the expense API update/i);
});

test('a recurring series stores its FIRST occurrence as the start date (backend parity)', () => {
  const page = read(path.join(ADMIN, 'pages', 'expenses.js'));
  // The backend anchors stepping on expense_date and ignores dow/dom. Snapping the
  // start to the first real fire is what keeps the two projections identical.
  assert.match(page, /firstOccurrence/, 'collectPayload must snap the start date');
  assert.match(page, /payload\.expense_date = first/, 'the snapped date must be what we persist');
  const rec = read(path.join(ADMIN, 'utils', 'expense-recurrence.js'));
  assert.match(rec, /export function firstOccurrence/);
});
