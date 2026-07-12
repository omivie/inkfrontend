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

test('the page module + three utils exist', () => {
  for (const f of ['pages/expenses.js', 'utils/expense-categories.js', 'utils/expense-recurrence.js', 'utils/expense-math.js']) {
    assert.ok(fs.existsSync(path.join(ADMIN, f)), `${f} must exist`);
  }
});

test('nav registers an owner-only Expenses item under Analytics', () => {
  assert.match(appJs, /key:\s*'expenses'[^}]*ownerOnly:\s*true/, 'NAV_ITEMS must have an owner-only expenses entry');
  // It sits in the Analytics section (between Finance and Demand Ranking).
  const analyticsIdx = appJs.indexOf("section: 'Analytics'");
  const expensesIdx = appJs.indexOf("key: 'expenses'");
  assert.ok(analyticsIdx > 0 && expensesIdx > analyticsIdx, 'expenses nav item belongs to the Analytics section');
});

test('route gate blocks #expenses for non-owners', () => {
  const m = appJs.match(/const ownerPages = \[([^\]]*)\]/);
  assert.ok(m, 'ownerPages array must exist');
  assert.match(m[1], /'expenses'/, "ownerPages must include 'expenses' so direct hash access is blocked");
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
  assert.doesNotMatch(page, /localStorage\.setItem\(['"`]?exp/i, 'expenses must not be stored in localStorage');
  assert.doesNotMatch(page, /sessionStorage\.setItem\(['"`]?exp/i, 'expenses must not be stored in sessionStorage');
});
