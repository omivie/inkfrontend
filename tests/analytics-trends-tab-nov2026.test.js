/**
 * Trends tab (Nov 2026): the dashboard's charts/cards moved to #analytics?tab=trends via
 * utils/dash-charts.js. Source-text checks, same style as the other dashboard tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const read = (...p) => fs.readFileSync(path.join(ADMIN, ...p), 'utf8');
const tabs = read('utils', 'analytics-tabs.js');
const trends = read('pages', 'trends.js');
const charts = read('utils', 'dash-charts.js');
const dash = read('pages', 'dashboard.js');

const MOVED = [
  'drawSeries', 'drawRanked', 'drawShare', 'drawRevenueProfit', 'drawForecast', 'buildOverviewBuckets',
  'renderOverviewNotes', 'drawPerformanceOverview', 'chartEmpty', 'hasData', 'guardDraw', 'resolveList',
  'fmtBucket', 'resolveGranularity', 'realRangeDays', 'isCumulativeMode', 'rangeLabel', 'bundleToGraphs',
  'chartCard', 'row', 'rowN', 'hexToRgba', 'safeDiv', 'firstArray', 'renderFunnelCard', 'funnelPct',
  'funnelStages', 'renderTopProductsCard', 'renderTopProductsBody', 'wireTopProductsToggle',
  'renderRecentOrdersCard', 'wireOrderRowClicks', 'renderFulfillmentCard', 'normalizeWorstMargin', 'rowMarginPct',
];
const defRe = (n) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\s*\\(`, 'm');

test("'trends' is in the manifest right after 'revenue', lazy ./trends.js", () => {
  assert.match(tabs, /id: 'revenue',[^\n]*\n\s*\{ id: 'trends',\s*label: 'Trends',\s*lazy: '\.\/trends\.js' \}/);
});

test('trends.js renders every canvas id the dashboard rows used', () => {
  for (const id of ['sku-revenue', 'sku-profit', 'sku-worst-margin', 'search-top', 'search-zero', 'revenue-profit',
    'forecast', 'orders', 'aov', 'margin-brand', 'margin-category', 'cust-type', 'reorder', 'traffic-source',
    'refund-rate', 'refund-reasons']) {
    assert.ok(trends.includes(`dash-c-${id}`), `dash-c-${id} missing from trends.js`);
  }
  assert.doesNotMatch(trends, /dash-c-overview/, 'Performance overview stays on the dashboard');
  assert.match(trends, /renderRecentOrdersCard/);
  assert.match(trends, /renderFulfillmentCard/);
  assert.match(trends, /renderTopProductsCard/);
  assert.match(trends, /renderFunnelCard/);
});

test('trends.js has the hub-tab shape, a stale-load guard and soft failures', () => {
  assert.match(trends, /export default \{[\s\S]*init\(container\)[\s\S]*onFilterChange\(\)[\s\S]*destroy\(\)/);
  assert.match(trends, /Promise\.allSettled/);
  assert.match(trends, /mySeq !== _seq/);
  assert.match(trends, /could not be loaded/);
});

test('every moved function is defined once, in dash-charts.js, never in dashboard.js or trends.js', () => {
  for (const n of MOVED) {
    assert.match(charts, defRe(n), `${n} missing from dash-charts.js`);
    assert.doesNotMatch(dash, defRe(n), `${n} still defined in dashboard.js`);
    assert.doesNotMatch(trends, defRe(n), `${n} redefined in trends.js`);
  }
});

test('dash-charts.js exports setEffectiveGranularity and dashboard.js calls it', () => {
  assert.match(charts, /export function setEffectiveGranularity\(/);
  assert.match(dash, /setEffectiveGranularity\(d\._effectiveGranularity/);
  assert.doesNotMatch(dash, /^let _effectiveGranularity/m);
});

test('static imports carry no ?v= (ERR-124)', () => {
  for (const src of [dash, trends, charts]) assert.doesNotMatch(src, /^import .*\?v=/m);
});
