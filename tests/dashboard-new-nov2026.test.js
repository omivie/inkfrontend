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
  assert.match(page, /import \{ moneyTruth, moneyTodos, previousRange \} from '\.\.\/utils\/money-truth\.js';/);
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

test('refund order lookups pass only correctly-typed fields, and only for the shown window', () => {
  assert.match(page, /if \(typeof o\.status === 'string' && o\.status\) known\.order_status = o\.status;/);
  assert.match(page, /if \(typeof o\.is_test_order === 'boolean'\) known\.order_is_test = o\.is_test_order;/);
  assert.match(page, /loadRefunds\(signal, \(compare && previousRange\(range\)\?\.from\) \|\| range\.from\)/);
  assert.match(page, /m\.owedToUs\.value == null \? m\.owedToUs\.note/);
});

test('a blank profit box says why on its face and names the sale with no cost (owner 2026-11-26)', () => {
  assert.match(page, /f\.grossProfit\.value == null \? noProfitWhy\(m\)/);
  assert.match(page, /f\.netProfit\.value == null \? noProfitWhy\(m\)/);
  assert.match(page, /blocked: no cost on \$\{b\.slice\(0, 3\)\.join/);
  assert.match(page, /state\.money\.costBlockers = state\.todo\.missingCost \? state\.todo\.missingCost\.items\.map\(\(i\) => i\.ref\) : null;/);
});
