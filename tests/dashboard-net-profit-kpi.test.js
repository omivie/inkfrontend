/**
 * Admin Dashboard — Net Profit KPI card (May 2026)
 * ================================================
 *
 * Why this exists:
 *   The top KPI strip showed a GROSS PROFIT card ($713.78 in the fixture) while
 *   the Trends section showed a "Profit" pill ($650.15). They look like they
 *   should match but don't — Gross Profit is pre-payment-fee margin
 *   (revenue_ex_GST − COGS), while the Trends pill is NET profit
 *   (revenue − COGS − Opex − Stripe − GST). The gap is exactly the Stripe fee.
 *
 *   Per the user, net profit is now promoted to its own KPI card. The hard
 *   contract: the Net Profit KPI must ALWAYS equal the Trends "Profit" pill —
 *   so both are sourced from the SAME sumTrendTotals(_trendData), and the KPI
 *   computes net = totals.revenue − totals.expenses, byte-identical to
 *   renderTrendTotals.
 *
 * The contract these tests pin:
 *   §1  Net Profit math == Trends pill math (revenue − expenses), for the
 *       worked fixture and in general.
 *   §2  Honesty: when COGS is unknown (cogsKnown === false) the KPI must NOT
 *       render a confident net — it falls back to "—", mirroring Gross Profit.
 *   §3  dashboard.js wires the card: a 'Net Profit' tile sourced from
 *       sumTrendTotals, gated on cogsKnown + a non-empty trend series, with a
 *       loss alert; Gross + Net share one half-height .admin-kpi-stack cell so
 *       the strip stays at admin-kpi-grid--8 (2 rows of 4).
 *   §4  admin.css ships the .admin-kpi-stack half-height layout.
 *
 * Run with: node --test tests/dashboard-net-profit-kpi.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const MODULE_PATH = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'trend-math.js');
const DASHBOARD = READ('js/admin/pages/dashboard.js');
const ADMINCSS  = READ('css/admin.css');

// ─── Load trend-math.js into a sandbox (mirrors dashboard-trend-math.test.js) ─
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(
    /export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; }
  );
  const footer = '\n;' + [...exposed]
    .map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`)
    .join('\n');
  return stripped + footer;
}
const sandbox = {
  console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date,
};
sandbox.globalThis = sandbox;
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')),
  vm.createContext(sandbox), { filename: 'trend-math.js' });
const { sumTrendTotals } = sandbox;

// The exact computation the dashboard KPI card performs.
function kpiNetProfit(series) {
  const tt = sumTrendTotals(Array.isArray(series) ? series : []);
  const cogsKnown = tt.cogsKnown !== false;
  const hasTrend = Array.isArray(series) && series.length > 0;
  return (hasTrend && cogsKnown) ? (tt.revenue - tt.expenses) : null;
}

// The exact computation the Trends "Profit" pill performs (renderTrendTotals).
function trendPillNet(series) {
  const totals = sumTrendTotals(series);
  return totals.revenue - totals.expenses;
}

// ─── §1 parity ──────────────────────────────────────────────────────────────

test('§1 Net Profit KPI equals the Trends "Profit" pill (worked fixture → $650.15)', () => {
  // Single bucket carrying the screenshot's window totals.
  const series = [{
    revenue: 1691.83,
    expenses: 1041.68,
    cogsTotal: 757.38, opexTotal: 0, stripeTotal: 63.63, gstTotal: 220.67,
    orders: 35, cogsKnown: true,
  }];
  const kpi = kpiNetProfit(series);
  const pill = trendPillNet(series);
  assert.ok(Math.abs(kpi - 650.15) < 0.005, `expected ~$650.15, got ${kpi}`);
  assert.equal(kpi, pill, 'KPI net must equal the Trends pill net');
});

test('§1 parity holds across a multi-bucket series', () => {
  const series = [
    { revenue: 200, expenses: 150, cogsTotal: 100, opexTotal: 10, stripeTotal: 15, gstTotal: 25, orders: 4, cogsKnown: true },
    { revenue: 400, expenses: 250, cogsTotal: 180, opexTotal: 0,  stripeTotal: 18, gstTotal: 52, orders: 9, cogsKnown: true },
    { revenue: 0,   expenses: 0,   cogsTotal: 0,   opexTotal: 0,  stripeTotal: 0,  gstTotal: 0,  orders: 0, cogsKnown: true },
  ];
  assert.equal(kpiNetProfit(series), trendPillNet(series));
  assert.equal(kpiNetProfit(series), 600 - 400); // Σrev − Σexp
});

test('§1 a loss window yields a negative net (drives the loss alert)', () => {
  const series = [{ revenue: 100, expenses: 160, cogsTotal: 120, opexTotal: 20, stripeTotal: 5, gstTotal: 15, orders: 2, cogsKnown: true }];
  assert.equal(kpiNetProfit(series), -60);
});

// ─── §2 honesty ───────────────────────────────────────────────────────────────

test('§2 net is null (card shows "—") when any bucket has cogsKnown === false', () => {
  const series = [
    { revenue: 500, expenses: 100, cogsTotal: 0, opexTotal: 0, stripeTotal: 60, gstTotal: 65, orders: 10, cogsKnown: false },
  ];
  assert.equal(kpiNetProfit(series), null,
    'COGS unknown ⇒ net must be withheld, never a confident overstated number');
});

test('§2 net is null on an empty trend series (no data to total)', () => {
  assert.equal(kpiNetProfit([]), null);
  assert.equal(kpiNetProfit(null), null);
});

// ─── §3 dashboard.js wiring ───────────────────────────────────────────────────

test('§3 renderKpiStrip declares a Net Profit tile', () => {
  assert.match(DASHBOARD, /label:\s*'Net Profit'/,
    "a tile labelled 'Net Profit' must exist in the KPI strip");
});

test('§3 net profit is sourced from sumTrendTotals(_trendData), not a parallel calc', () => {
  assert.match(DASHBOARD, /sumTrendTotals\(\s*Array\.isArray\(_trendData\)\s*\?\s*_trendData\s*:\s*\[\]\s*\)/,
    'must total the same trend series the Trends pill uses');
  assert.match(DASHBOARD, /_tt\.revenue\s*-\s*_tt\.expenses/,
    'net = revenue − expenses, byte-identical to renderTrendTotals');
});

test('§3 net profit is gated on cogsKnown AND a non-empty trend series', () => {
  assert.match(DASHBOARD, /netCogsKnown\s*=\s*_tt\.cogsKnown\s*!==\s*false/);
  assert.match(DASHBOARD, /netProfit\s*=\s*\(hasTrend\s*&&\s*netCogsKnown\)/);
});

test('§3 a negative net flags the loss alert on the card', () => {
  assert.match(DASHBOARD, /alert:\s*netProfit\s*!=\s*null\s*&&\s*netProfit\s*<\s*0/);
});

test('§3 Gross + Net are stacked in one half-height cell, keeping the 8-cell grid', () => {
  // The strip stays at admin-kpi-grid--8 (2 rows of 4); Gross Profit and Net
  // Profit share a single .admin-kpi-stack cell so Out of Stock rides up.
  assert.match(DASHBOARD, /admin-kpi-grid--8/);
  assert.match(DASHBOARD, /admin-kpi-stack/, 'the Gross/Net stack wrapper must be emitted');
  assert.match(DASHBOARD, /renderKpiTile\(t,\s*' admin-kpi--half'\)/,
    'Gross Profit renders as a half-height card');
  assert.match(DASHBOARD, /renderKpiTile\(next,\s*' admin-kpi--half'\)/,
    'Net Profit renders as the second half-height card');
  // The pairing is keyed on the two labels being adjacent.
  assert.match(DASHBOARD, /t\.label === 'Gross Profit' && next && next\.label === 'Net Profit'/);
});

test('§3 the fallback banner names Net Profit alongside Gross Profit', () => {
  // When the analytics RPC is down, the banner must promise exactly what renders.
  const bannerRegion = DASHBOARD.slice(DASHBOARD.indexOf('reconstructedList'),
                                       DASHBOARD.indexOf('admin-kpi-fallback'));
  assert.match(bannerRegion, /Net Profit/,
    'banner reconstructed/unavailable lists must mention Net Profit');
});

// ─── §4 admin.css layout ──────────────────────────────────────────────────────

test('§4 admin.css ships the .admin-kpi-stack half-height layout', () => {
  assert.match(ADMINCSS, /\.admin-kpi-stack\s*\{[^}]*flex-direction:\s*column/,
    'the stack must lay its two cards out in a column');
  assert.match(ADMINCSS, /\.admin-kpi-stack \.admin-kpi--half\s*\{[^}]*flex:\s*1/,
    'each half card must flex to fill half the cell height');
});
