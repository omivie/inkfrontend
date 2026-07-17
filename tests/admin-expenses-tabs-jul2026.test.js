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

// ─── Drawer close guard ───────────────────────────────────────────────────────

test('Drawer.close() consults onBeforeClose and a false return vetoes the close', () => {
  const drawer = read(path.join(ADMIN, 'components', 'drawer.js'));
  assert.match(drawer, /onBeforeClose/, 'open() must accept onBeforeClose');
  assert.match(drawer, /onBeforeClose\(\)\s*===\s*false\)\s*return/, 'close() must veto on exactly false');
  // Escape must not disarm itself before the veto decision — close() owns removal.
  assert.doesNotMatch(drawer, /Escape'\)\s*\{\s*close\(\);\s*document\.removeEventListener/,
    'Escape handler must let close() own listener removal so a veto re-arms it');
});
