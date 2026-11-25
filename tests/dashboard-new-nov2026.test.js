/**
 * Rebuilt Dashboard (#dashboard-new, side-by-side with the old one until the owner approves).
 * Source-level wiring checks; the money math itself is pinned by money-truth-nov2026.test.js.
 *
 * Measured 2026-11-25 (local, live API, cold reload): first money box 2.9 s and 19 requests,
 * incl. admin boot; old dashboard 17.0 s and 147 requests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.join(__dirname, '..', 'inkcartridges', 'js', 'admin');
const page = fs.readFileSync(path.join(ADMIN, 'pages', 'dashboard-new.js'), 'utf8');
const app = fs.readFileSync(path.join(ADMIN, 'app.js'), 'utf8');

test('nav: owner-only "Dashboard (new)" sits under the old Dashboard', () => {
  assert.match(app, /\{ key: 'dashboard', label: 'Dashboard', icon: 'dashboard' \},\s*\/\/[^\n]*\n\s*\{ key: 'dashboard-new', label: 'Dashboard \(new\)', icon: 'dashboard', ownerOnly: true \}/);
});

test('money boxes come from money-truth, and every box opens How it is calculated', () => {
  assert.match(page, /import \{ moneyTruth, moneyTodos \} from '\.\.\/utils\/money-truth\.js';/);
  assert.match(page, /data-how="\$\{esc\(b\.key\)\}"/);
  assert.match(page, /addEventListener\('click', \(\) => openHow\(state\.money, btn\.dataset\.how\)\)/);
  for (const k of ['revenueExGst', 'grossProfit', 'netProfit', 'orders', 'aov', 'owed']) {
    assert.match(page, new RegExp(`key: '${k}'`), k);
    assert.match(page, new RegExp(`\\b${k}: '`), `formula text for ${k}`);
  }
});

test('kpi-summary and the bundle get the date range ONLY (adjustments are whole-business)', () => {
  assert.match(page, /const kpiParams = new URLSearchParams\(\{ from: range\.from, to: range\.to \}\);/);
  assert.match(page, /getDashboardKPIs\(kpiParams, signal\)/);
  assert.match(page, /getDashboardBundle\(kpiParams, g, signal\)/);
  assert.doesNotMatch(page, /getDashboardKPIs\(FilterState\.getParams\(\)/);
  assert.match(page, /setVisibleFilters\(\['period'\]\)/);
});

test('speed: no per-order detail scan; missing cost reads cost_complete off list rows', () => {
  assert.doesNotMatch(page, /AdminAPI\.getOrder\(/);
  assert.match(page, /o\.cost_complete === false/);
  // The graph never waits for the slow traffic call.
  assert.match(page, /const trafficP = AdminAPI\.getTrafficTimeseries/);
  assert.doesNotMatch(page, /Promise\.allSettled\(\[AdminAPI\.getDashboardBundle[^\]]*getTrafficTimeseries/);
});

test('fail-soft is loud: a list that did not load is null, and a null card says so', () => {
  assert.match(page, /if \(data == null\) return null;/);
  assert.match(page, /this is not a zero/);
});
