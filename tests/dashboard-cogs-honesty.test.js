/**
 * Admin Dashboard — COGS-honesty contract (ERR-028, May 2026)
 * ============================================================
 *
 * Background — the 2026-05-17 bug report:
 *   The admin dashboard "wasn't showing the correct data". With the analytics
 *   RPC down, the dashboard self-heals headline numbers from the orders feed
 *   (deriveKpisFromOrders). But that feed carries no per-item supplier cost,
 *   so Cost of Goods Sold could not be valued. Three surfaces lied about it:
 *
 *     1. The KPI fallback banner promised "…Gross Margin below are
 *        reconstructed…" — but the Gross Margin card rendered "—". A banner
 *        making a promise the strip didn't keep.
 *     2. The Trends totals strip showed a confident green "Profit +$1,396.97"
 *        and "COGS $0.00". COGS wasn't $0 — it was UNKNOWN. The "profit"
 *        omitted the single largest cost line and was wildly overstated.
 *     3. The 30-day Forecast projected "+$X profit" off a net-profit margin
 *        computed from that same COGS-free expense total (~83% margin).
 *
 * The contract these tests pin:
 *
 *   §1  trend-math.js exposes `cogsIsKnown` and `sumTrendTotals` propagates a
 *       `cogsKnown` flag. (Math is exercised in dashboard-trend-math.test.js;
 *       here we assert the wiring exists.)
 *   §2  buildTrendSeries tags every bucket with `cogsKnown` via `cogsIsKnown`.
 *   §3  renderTrendTotals branches on `cogsKnown`: when false it renders a
 *       neutral "Net excl. COGS" chip (never green "Profit"), a "COGS —"
 *       breakdown, and a warning hint — and never the old green profit chip.
 *   §4  The KPI fallback banner is conditional on `cur.gross_profit`: it only
 *       names "Gross Margin" as reconstructed when gross_profit resolved.
 *   §5  The forecast suppresses its profit headline + chart profit lines when
 *       COGS is unknown (netMargin null / `showProfit` gate).
 *   §6  admin.css ships the `--unknown` chip/segment and `--warn` hint styles.
 *
 * Run with: node --test tests/dashboard-cogs-honesty.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const DASHBOARD = READ('js/admin/pages/dashboard.js');
const TRENDMATH = READ('js/admin/utils/trend-math.js');
const ADMINCSS  = READ('css/admin.css');

// ─── §1 trend-math.js exposes the COGS-known primitives ─────────────────────

test('§1 trend-math.js exports cogsIsKnown', () => {
  assert.match(TRENDMATH, /export function cogsIsKnown\b/,
    'cogsIsKnown must be an exported helper');
});

test('§1 sumTrendTotals seeds and propagates cogsKnown', () => {
  // The accumulator must start at cogsKnown:true and flip false on any bucket.
  assert.match(TRENDMATH, /cogsKnown:\s*true\s*\}/,
    'sumTrendTotals accumulator must seed cogsKnown:true');
  assert.match(TRENDMATH, /m\.cogsKnown === false.*acc\.cogsKnown = false/s,
    'sumTrendTotals must flip cogsKnown false when a bucket reports false');
});

test('§1 dashboard.js imports cogsIsKnown from trend-math', () => {
  assert.match(DASHBOARD, /import\s*\{[^}]*\bcogsIsKnown\b[^}]*\}\s*from\s*'\.\.\/utils\/trend-math\.js'/s,
    'dashboard.js must import cogsIsKnown');
});

// ─── §2 buildTrendSeries tags buckets with cogsKnown ────────────────────────

test('§2 buildTrendSeries decides cogsKnown via cogsIsKnown', () => {
  assert.match(DASHBOARD, /cogsIsKnown\(\{/,
    'buildTrendSeries must call cogsIsKnown({...})');
  // The decision must be fed the three real signals + window revenue.
  const call = DASHBOARD.match(/cogsIsKnown\(\{[\s\S]*?\}\)/);
  assert.ok(call, 'cogsIsKnown call object must be present');
  for (const key of ['windowRevenue', 'hasPnlCogs', 'hasOrderCogs', 'kpiCogsTotal']) {
    assert.ok(call[0].includes(key), `cogsIsKnown call must pass ${key}`);
  }
});

test('§2 every bucket is tagged with cogsKnown before assembly', () => {
  assert.match(DASHBOARD, /b\.cogsKnown = windowCogsKnown/,
    'each bucket must carry the window-wide cogsKnown flag');
});

// ─── §3 renderTrendTotals is honest when COGS is unknown ────────────────────

test('§3 renderTrendTotals branches on cogsKnown', () => {
  assert.match(DASHBOARD, /const cogsKnown = totals\.cogsKnown !== false/,
    'renderTrendTotals must read cogsKnown off the totals');
  assert.match(DASHBOARD, /if \(!cogsKnown\)/,
    'renderTrendTotals must have a dedicated !cogsKnown branch');
});

test('§3 the unknown branch renders a neutral "Net excl. COGS" chip, not "Profit"', () => {
  const branch = DASHBOARD.slice(
    DASHBOARD.indexOf('if (!cogsKnown)'),
    DASHBOARD.indexOf('// Horizontal bar layout:'),
  );
  assert.ok(branch.length > 100, 'the !cogsKnown branch must be substantial');
  assert.match(branch, /Net excl\. COGS/,
    'unknown branch must label the figure "Net excl. COGS"');
  assert.match(branch, /admin-trend-totals__chip--unknown/,
    'unknown branch must use the neutral --unknown chip');
  assert.ok(!/chip--profit/.test(branch),
    'unknown branch must NEVER use the green --profit chip');
});

test('§3 the unknown branch shows "COGS —", never "COGS $0.00"', () => {
  const branch = DASHBOARD.slice(
    DASHBOARD.indexOf('if (!cogsKnown)'),
    DASHBOARD.indexOf('// Horizontal bar layout:'),
  );
  assert.match(branch, /COGS —/,
    'unknown breakdown must read "COGS —" (unknown), not a fabricated $0.00');
});

test('§3 the unknown branch ships a warning hint explaining the gap', () => {
  const branch = DASHBOARD.slice(
    DASHBOARD.indexOf('if (!cogsKnown)'),
    DASHBOARD.indexOf('// Horizontal bar layout:'),
  );
  assert.match(branch, /admin-trend-totals__hint--warn/,
    'unknown branch must render the --warn hint');
  assert.match(branch, /overstates true profit/,
    'the hint must state plainly that the figure overstates profit');
});

test('§3 the "Net Profit" chart line is relabelled when COGS is unknown', () => {
  assert.match(DASHBOARD, /trendCogsKnown = !series\.some\(m => m && m\.cogsKnown === false\)/,
    'drawTrendChart must detect a COGS-unknown window');
  assert.match(DASHBOARD, /netLineLabel = trendCogsKnown \? 'Net Profit' : 'Net \(excl\. COGS\)'/,
    'the profit line must drop the word "Profit" when COGS is unknown');
  assert.match(DASHBOARD, /label: netLineLabel,/,
    'the profit dataset must use the conditional label, not a hard-coded string');
});

// ─── §4 the KPI fallback banner promises only what it delivers ──────────────

test('§4 the fallback banner is conditional on gross_profit', () => {
  assert.match(DASHBOARD, /profitReconstructed = cur\.gross_profit != null/,
    'the banner must key its wording off whether gross_profit resolved');
});

test('§4 banner never claims "Gross Margin" unconditionally', () => {
  // The old bug: a hard-coded string that always named Gross Margin as
  // reconstructed. The reconstructed-list must be the conditional variable.
  const bannerBlock = DASHBOARD.slice(
    DASHBOARD.indexOf('if (_kpi.derived)'),
    DASHBOARD.indexOf('if (_kpi.derived)') + 1400,
  );
  assert.match(bannerBlock, /reconstructedList/,
    'banner must build its metric list from the reconstructedList variable');
  // When profit did NOT reconstruct, Gross Profit + Gross Margin must appear
  // in the unavailable list instead.
  assert.match(bannerBlock, /unavailableList[\s\S]*Gross Profit[\s\S]*Gross Margin/,
    'unavailable branch must list Gross Profit + Gross Margin as still-down');
});

// ─── §5 the forecast refuses a profit it can't compute ──────────────────────

test('§5 buildForecastSeries nulls netMargin and exposes cogsKnown', () => {
  assert.match(DASHBOARD, /const cogsKnown = trendTotals\.cogsKnown !== false/,
    'buildForecastSeries must read cogsKnown off the trend totals');
  assert.match(DASHBOARD, /netMargin = \(cogsKnown && trendTotals\.revenue > 0\)/,
    'netMargin must be gated on cogsKnown');
  assert.match(DASHBOARD, /return \{[^}]*\bcogsKnown\b[^}]*\}/,
    'buildForecastSeries must return cogsKnown for downstream consumers');
});

test('§5 renderForecastCard says "profit pending cost data" when COGS unknown', () => {
  assert.match(DASHBOARD, /profit pending cost data/,
    'the forecast headline must explain a missing profit, not silently drop it');
});

test('§5 drawForecastChart drops the profit datasets when COGS unknown', () => {
  assert.match(DASHBOARD, /const showProfit = state\.netMargin != null/,
    'drawForecastChart must compute a showProfit gate');
  assert.match(DASHBOARD, /if \(showProfit\) \{\s*datasets\.push/,
    'the two profit datasets must be pushed only when showProfit is true');
});

// ─── §6 admin.css ships the COGS-unknown styles ─────────────────────────────

test('§6 admin.css defines the --unknown chip + segment and --warn hint', () => {
  assert.match(ADMINCSS, /\.admin-trend-totals__chip--unknown\s*\{/,
    'the neutral unknown chip must be styled');
  assert.match(ADMINCSS, /\.admin-trend-totals__seg--unknown\s*\{/,
    'the hatched unknown bar segment must be styled');
  assert.match(ADMINCSS, /\.admin-trend-totals__hint--warn\s*\{/,
    'the warning hint variant must be styled');
});
