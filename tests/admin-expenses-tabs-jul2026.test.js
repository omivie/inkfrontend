/**
 * Expenses workspace (Jul 2026) — tabbed shell wiring contract
 * ============================================================
 *
 * The Expenses page became a three-tab finance workspace (Overview / All
 * expenses / Recurring) driven by the GLOBAL FilterState period bar and
 * URL-persisted expense filters. This pins the wiring that a partial refactor
 * would silently break:
 *
 *   - FilterState._writeToURL must CARRY THROUGH query params it doesn't own
 *     (`tab=`, `cat=`, `q=`, …). It used to rebuild the query from only its own
 *     state, which dropped a hub's ?tab= on every period click.
 *
 * Run with: node --test tests/admin-expenses-tabs-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

// ─── FilterState URL writer: foreign params survive ──────────────────────────

test('_writeToURL declares its own keys and carries every foreign param through', () => {
  const filters = read(path.join(ADMIN, 'filters.js'));
  assert.match(filters, /_OWN_KEYS:\s*\['period',\s*'granularity',\s*'from',\s*'to',\s*'brands',\s*'suppliers',\s*'statuses',\s*'categories'\]/,
    'the owned-key whitelist must exist and stay in sync with _readFromURL');
  assert.match(filters, /!this\._OWN_KEYS\.includes\(k\)/,
    'foreign params (tab=, cat=, …) must be carried through, not dropped');
  // The base hash must be split at the FIRST ?, never re-parsed lossily.
  assert.match(filters, /const qIdx = hash\.indexOf\('\?'\)/, 'writer reads the existing query to preserve it');
});

// ─── Tab modules exist and stay pure renderers ────────────────────────────────

const TAB_FILES = ['expenses-tab-overview.js', 'expenses-tab-all.js', 'expenses-tab-recurring.js'];

test('the three tab modules exist and the shell statically imports them', () => {
  const shell = read(path.join(ADMIN, 'pages', 'expenses.js'));
  for (const f of TAB_FILES) {
    assert.ok(fs.existsSync(path.join(ADMIN, 'pages', f)), `${f} must exist`);
    assert.ok(shell.includes(`from './${f}'`), `shell must statically import ${f}`);
  }
  assert.match(shell, /readTabFromHash/, 'shell owns tab parsing');
  assert.match(shell, /writeHashParams/, 'shell owns hash-param writing');
  assert.match(shell, /addEventListener\('hashchange'/, 'external ?tab= edits must switch tabs');
  assert.match(shell, /role="tablist"/, 'tabs carry ARIA roles');
  assert.match(shell, /FilterState\.showBar\(true\)/, 'the GLOBAL period bar drives the page');
  assert.match(shell, /FilterState\.setDataStartDate\(/, "period=all must start at real data (ERR-048 rule)");
});

test('tab modules never write browser storage or fetch directly', () => {
  for (const f of TAB_FILES) {
    const src = read(path.join(ADMIN, 'pages', f));
    assert.doesNotMatch(src, /localStorage\.setItem/i, `${f}: no browser storage`);
    assert.doesNotMatch(src, /sessionStorage\.setItem/i, `${f}: no browser storage`);
    assert.doesNotMatch(src, /window\.API\.(get|post|put|delete)/, `${f}: data I/O goes through the shell ctx`);
  }
});

// ─── All tab: columns, bulk actions ──────────────────────────────────────────

test('column visibility persists via AdminAPI prefs (never browser storage)', () => {
  const all = read(path.join(ADMIN, 'pages', 'expenses-tab-all.js'));
  assert.match(all, /COLUMN_PREF_KEY = 'expenses\.columns'/, 'pref key pinned');
  assert.match(all, /api\.setUiPref\(COLUMN_PREF_KEY/, 'persisted through the ctx AdminAPI surface');
});

test('bulk writes are sequential with RATE_LIMITED backoff and loud summaries', () => {
  const all = read(path.join(ADMIN, 'pages', 'expenses-tab-all.js'));
  assert.match(all, /RATE_LIMITED/, 'backoff must key on the RATE_LIMITED code');
  assert.match(all, /1000 \* 2 \*\* \(attempt - 1\)/, 'exponential backoff (1s/2s/4s)');
  assert.match(all, /failures\.push/, 'failures collected, never swallowed');
  assert.match(all, /bulkSummaryToast/, 'every bulk run ends in an honest summary');
  // The bulk bar is a document.body appendage — it must be removed in destroy.
  assert.match(all, /removeBulkBar\(\);[\s\S]{0,200}_table\?\.destroy/, 'destroy() removes the bulk bar');
});

test('bulk category change routes custom keys through the override map', () => {
  const all = read(path.join(ADMIN, 'pages', 'expenses-tab-all.js'));
  assert.match(all, /categories\.backendAccepts\(/, 'gates on the live backend enum');
  assert.match(all, /setOverrideLocal\(/, 'batch-mutates the override map');
  assert.match(all, /persistOverrides\(\)/, 'persists ONCE after the loop');
});

// ─── Drawer close guard ───────────────────────────────────────────────────────

test('Drawer.close() consults onBeforeClose and a false return vetoes the close', () => {
  const drawer = read(path.join(ADMIN, 'components', 'drawer.js'));
  assert.match(drawer, /onBeforeClose/, 'open() must accept onBeforeClose');
  assert.match(drawer, /onBeforeClose\(\)\s*===\s*false\)\s*return/, 'close() must veto on exactly false');
  // Escape must not disarm itself before the veto decision — close() owns removal.
  assert.doesNotMatch(drawer, /Escape'\)\s*\{\s*close\(\);\s*document\.removeEventListener/,
    'Escape handler must let close() own listener removal so a veto re-arms it');
});
