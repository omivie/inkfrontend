/**
 * ERR-074 — profit tiles blank while every sale is costed
 * =======================================================
 *
 * Measured against the live store on 2026-07-14:
 *
 *   • `/analytics/kpi-summary` returned `gross_profit: null`, `net_profit: null`,
 *     `margin_proxy: null` for period=all — the fields are PRESENT and explicitly null.
 *   • All 59 revenue orders (of 73; 14 cancelled) have line items. All 84 line items
 *     carry a non-null `supplier_cost_snapshot`. **Nothing is missing a cost.**
 *   • Probing kpi-summary one week at a time: 17 of 19 weeks returned a real gross
 *     profit. The only two that nulled — 2026-06-22 and 2026-07-06 — are precisely the
 *     two holding the three INV- shadow orders. 100% correlation with `invoice_orders > 0`.
 *   • `gross_profit_series` in the same bundle returns a real gross profit for ALL 19
 *     weeks, including those two ($193.52 and $183.11).
 *
 * So the backend can compute the number; only kpi-summary drops it. Meanwhile the
 * dashboard told the owner "gross & net profit can't be calculated for ANY period until
 * every sale has a cost of goods — add one", which was a **falsehood** that would send
 * them hunting for a problem that does not exist.
 *
 * Two contracts pinned here:
 *
 *   1. RECOVERY — rebuild profit by summing the backend's own per-bucket series. This is
 *      not the frontend inventing COGS (ERR-028 forbids that, and it stays forbidden);
 *      every input is a figure the backend published. It must SELF-DISABLE the moment
 *      kpi-summary returns a real gross_profit.
 *   2. HONESTY — if ANY bucket is null, COGS really is unknown somewhere in the range,
 *      and the tiles must go back to "—". One unknown bucket poisons the sum.
 *
 * Run with: node --test tests/dashboard-profit-recovery.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'
);
// Moved helpers now live in utils/dash-charts.js; lift() still reads them from this combined source.
const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'dash-charts.js'), 'utf8').replace(/^export /gm, '') + '\n' + fs.readFileSync(require('node:path').join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'dash-alerts.js'), 'utf8').replace(/^export /gm, '') + '\n' + fs.readFileSync(DASHBOARD, 'utf8');

/**
 * Lift a declaration out of dashboard.js by brace-matching from its opening `{`.
 * dashboard.js imports app.js/charts.js, so it can't be evaluated whole — but the
 * helpers under test are pure, and this runs the REAL shipped source rather than a
 * copy that could silently drift from it.
 */
function lift(name) {
  const re = new RegExp(`(?:^|\\n)(?:const\\s+${name}\\s*=|function\\s+${name}\\s*\\()`);
  const m = src.match(re);
  assert.ok(m, `${name} not found in dashboard.js — renamed?`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const open = src.indexOf('{', src.indexOf(name, start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const end = src.indexOf(';', i) === i + 1 ? i + 2 : i + 1;
        return src.slice(start, end);
      }
    }
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(
  [lift('numOrNull'), lift('resolveList'), lift('recoverProfitFromSeries')].join('\n\n')
  + '\n;globalThis.recoverProfitFromSeries = recoverProfitFromSeries;',
  ctx,
  { filename: 'dashboard-lifted.js' }
);
const { recoverProfitFromSeries } = sandbox;

/** The live all-time payload, verbatim from the backend on 2026-07-14. */
const LIVE_CURRENT = {
  revenue: 7091.58,
  orders: 59,
  includes_invoices: true,
  invoice_revenue: 1268.48,
  invoice_orders: 3,
  aov: 120.2,
  refund_rate: 0,
  margin_proxy: null,
  gross_profit: null,          // ← the defect
  stripe_fees: 171.11,
  operating_expenses: 0,
  // Supplier freight is the FOURTH term in the backend's identity (ERR-255).
  // Present here because the live payload carries it on every call; the test
  // below pins what happens when it ISN'T.
  supplier_freight: 96.40,
  net_profit: null,            // ← the defect
};

/** The live gross_profit_series for the same range — 19 weekly buckets, none null. */
const LIVE_SERIES = [
  11.74, -2.03, 5.74, 49.1, 73.56, 63.01, 39.75, 8.13, 114.41, 73.57,
  8.01, 43.94, 62.82, 91.87, 96.62, 193.52, 37.73, 183.11, 35.47,
].map((gross_profit, i) => ({ bucket_start: `2026-w${i}`, gross_profit }));

const round = (n) => Math.round(n * 100) / 100;

// ─── 1. Recovery: the live case ─────────────────────────────────────────────

test('rebuilds gross profit by summing the backend’s own weekly buckets', () => {
  const r = recoverProfitFromSeries(LIVE_CURRENT, LIVE_SERIES);
  assert.ok(r, 'should recover — every bucket is known');
  assert.equal(round(r.gross), 1190.07);
});

test('rebuilds net profit with kpi-summary’s own formula: gross − fees − opex − freight', () => {
  // Verified to the cent against four un-poisoned weeks of live data before being
  // relied on (e.g. 2026-06-15: 205.39 − 19.55 − 0 === 185.84, the backend's own net).
  // Supplier freight joined the identity on 2026-09-12 (ERR-255) — the backend's own
  // reconciliation is gross − net = stripe + opex + supplier_freight, verified against
  // the live RPC at 2210.76 − (−56.06) = 170.68 + 1593.50 + 502.64, exact to the cent.
  const r = recoverProfitFromSeries(LIVE_CURRENT, LIVE_SERIES);
  assert.equal(round(r.net), round(1190.07 - 171.11 - 0 - 96.40));
  assert.equal(round(r.net), 922.56);
});

test('🚨 ABSENT supplier_freight REFUSES the scalar formula — it is not $0', () => {
  // THE WHOLE POINT. Freight was $502.64 over the last 30 live days. Reading an
  // absent field as zero would rebuild a net profit half a thousand dollars too
  // healthy and stamp "Rebuilt" on it as though that were a provenance claim —
  // ERR-063/068 absence-as-zero with the headline figure on it.
  //
  // The honest fallback is the backend's own per-bucket net, which already has
  // freight inside it. So the recovery must NOT equal gross − fees − opex.
  const { supplier_freight, ...noFreight } = LIVE_CURRENT;
  assert.equal('supplier_freight' in noFreight, false, 'positive control: the key must really be gone');
  const r = recoverProfitFromSeries(noFreight, LIVE_SERIES);
  assert.notEqual(round(r && r.net), 1018.96,
    'gross − fees − opex with freight silently treated as $0 is the bug this test exists for');
});

test('a NULL supplier_freight is refused exactly like an absent one', () => {
  // Present-and-null is the shape a degraded backend returns. `numOrNull` must
  // treat it as unknown, not coerce it to 0 the way Number(null) would.
  const r = recoverProfitFromSeries({ ...LIVE_CURRENT, supplier_freight: null }, LIVE_SERIES);
  assert.notEqual(round(r && r.net), 1018.96);
});

test('accepts the wrapped {series:[…]} / {data:[…]} shapes the bundle can return', () => {
  for (const payload of [{ series: LIVE_SERIES }, { data: LIVE_SERIES }]) {
    assert.equal(round(recoverProfitFromSeries(LIVE_CURRENT, payload).gross), 1190.07);
  }
});

test('negative buckets are summed, not dropped — a losing week is a known week', () => {
  // The live series has one: 2026-03-16 at −$2.03. A guard like `if (!v) continue`
  // would silently drop it AND drop a legitimate $0.00 bucket.
  const r = recoverProfitFromSeries(LIVE_CURRENT, [
    { gross_profit: 100 }, { gross_profit: -30 }, { gross_profit: 0 },
  ]);
  assert.equal(r.gross, 70);
});

// ─── 2. Honesty: ERR-028 still stands ───────────────────────────────────────

test('ONE null bucket poisons the sum → no recovery, tiles stay "—"', () => {
  const poisoned = LIVE_SERIES.map((b, i) => (i === 7 ? { ...b, gross_profit: null } : b));
  assert.equal(
    recoverProfitFromSeries(LIVE_CURRENT, poisoned), null,
    'an unknown bucket means COGS is genuinely unknown in the range — never guess past it',
  );
});

test('a bucket missing gross_profit entirely is unknown, not zero', () => {
  assert.equal(recoverProfitFromSeries(LIVE_CURRENT, [{ gross_profit: 50 }, {}]), null);
});

test('an empty or absent series is not a $0 profit', () => {
  assert.equal(recoverProfitFromSeries(LIVE_CURRENT, []), null);
  assert.equal(recoverProfitFromSeries(LIVE_CURRENT, null), null);
  assert.equal(recoverProfitFromSeries(LIVE_CURRENT, undefined), null);
});

test('unknown fees leave NET unknown while gross still recovers', () => {
  // Number(null) === 0 would silently turn "we don't know the fees" into "there were no
  // fees", overstating net profit. Gross is unaffected — it never touches fees.
  const r = recoverProfitFromSeries(
    { ...LIVE_CURRENT, stripe_fees: null }, LIVE_SERIES,
  );
  assert.equal(round(r.gross), 1190.07);
  assert.equal(r.net, null, 'unknown fees → unknown net');
});

// ─── 3. Self-disabling: the backend fix must retire this with no second deploy ──

test('does NOT fire when kpi-summary returns a real gross_profit — even 0', () => {
  const healthy = { ...LIVE_CURRENT, gross_profit: 1190.07, net_profit: 1018.96 };
  assert.equal(recoverProfitFromSeries(healthy, LIVE_SERIES), null);

  // A genuine zero-profit period is a REAL answer and must never be overridden.
  const zero = { ...LIVE_CURRENT, gross_profit: 0, net_profit: 0 };
  assert.equal(
    recoverProfitFromSeries(zero, LIVE_SERIES), null,
    '0 is a real backend figure — `??`/`|| ` style truthiness checks would clobber it',
  );
});

test('a missing/blank kpi payload does not fabricate a profit', () => {
  assert.equal(recoverProfitFromSeries(null, LIVE_SERIES), null);
  assert.equal(recoverProfitFromSeries(undefined, LIVE_SERIES), null);
});

// ─── 4. Static wiring — the Dashboard no longer rebuilds profit (2026-11-26) ──
//
// recoverProfitFromSeries stays in utils/dash-charts.js for the Analytics Trends tab, which
// still reads kpi-summary. The Dashboard now reads dashboard-summary, which ALWAYS returns
// every figure and lists the un-costed sales in `cogs_unknown_orders` — so the Dashboard's
// rebuild path, its "Rebuilt from the series" note and the ~120-GET "sales missing a cost"
// scan were deleted. Their replacement is pinned here and in tests/money-truth-nov2026.test.js.

const DASH_ONLY = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'), 'utf8');

test('the Dashboard reads profit from dashboard-summary, never rebuilt from a series', () => {
  assert.match(DASH_ONLY, /AdminAPI\.getDashboardSummary\(range, dsumGrain, signal\)/);
  assert.match(DASH_ONLY, /const m = dashboardMoney\(d\.dsum\)/);
  assert.doesNotMatch(DASH_ONLY, /recoverProfitFromSeries|getDashboardKPIs|Rebuilt from the backend/);
});

test('an un-costed sale makes profit AT MOST, named — not a blank tile', () => {
  assert.match(DASH_ONLY, /atMost: f\.grossProfit\.atMost/);
  assert.match(DASH_ONLY, /atMost: f\.netProfit\.atMost/);
  assert.match(DASH_ONLY, /at most<\/span>/, 'the tile itself carries the flag');
  assert.match(DASH_ONLY, /for \(const w of m\.warnings\)/, 'and the warning is written under the strip');
});

test('an unavailable list never reads as an all-clear (review 2026-11-26)', () => {
  // dashboard-summary down ⇒ trackingOrders null ⇒ both tracking surfaces say "could not load",
  // even when the customer tracking-request list loaded (it alone would undercount).
  assert.match(DASH_ONLY, /const tracking = d\.trackingOrders == null \? null : computeTrackingAlert/);
  assert.match(DASH_ONLY, /d\.trackingOrders == null[\s\S]{0,400}Could not load the orders awaiting tracking — this is not a zero/);
  // An expense list cut short by its limit is "not loaded", so the to-dos never say "None found" on part of it.
  assert.match(DASH_ONLY, /expResp\.items\.length >= expTotal\) \? expResp\.items : null/);
});

test('the missing-cost scan is gone; the backend list replaces it', () => {
  assert.doesNotMatch(DASH_ONLY, /computeMissingCostAlert|startMissingCostScan|MISSING_COST_DETAIL_CAP|AdminAPI\.getOrder\(/);
  assert.match(DASH_ONLY, /missingCostItems\(d\.dsum\?\.actions\?\.missing_cost/);
});

// ─── 7. RETIRED: the ERR-106 proration ──────────────────────────────────────
//
// `buildReconciledNetSeries` prorated two whole-range scalars across buckets so the chart
// line would land exactly on the Net Profit KPI. It existed only because the backend's
// `net_profit_series` did not reconcile (line ~$200 vs KPI ~$1,047).
//
// Backend migration 118 fixed the root cause — kpi-summary had been subtracting an ex-GST
// COGS from GST-INCLUSIVE revenue, booking the 15% revenue GST as profit. Verified live
// 2026-07-20 across four windows: Σ net_profit_series now equals kpi-summary.net_profit to
// within 2c over 30 buckets. So the frontend stopped manufacturing per-bucket figures the
// backend never published, and plots the real series.
//
// Those five proration tests are GONE with the code they pinned. Their surviving invariants
// — null-honesty, negative buckets, all-null degrade, and reconciliation to the KPI — moved
// to tests/dashboard-net-series-jul2026.test.js, restated against the real series (ERR-110).

// ─── 8. Static wiring — real series, no proration, un-clamped axis ───────────

test('drawPerformanceOverview plots the backend net series — the proration is gone', () => {
  // Deleted, not merely unused — it invented per-bucket figures. Matched on the declaration
  // and on any call site; the docblock is free to NAME it when explaining why it's gone.
  assert.doesNotMatch(
    src, /function\s+buildReconciledNetSeries|const\s+buildReconciledNetSeries\s*=/,
    'the ERR-106 proration helper must be deleted',
  );
  assert.doesNotMatch(
    src, /buildReconciledNetSeries\s*\(/,
    'the ERR-106 proration must have no call sites',
  );
  // The profit line and its label both come from the shared planner.
  assert.match(src, /const plan = planProfitLine\(order, byBucket\)/);
  assert.match(src, /mkMoney\(plan\.label, profit, c\.cyan\)/);
  // net_profit_series must be MERGED now (the opposite of the ERR-106 state).
  assert.match(src, /merge\(npList, \(r\) => numOrNull\(r\.net_profit\), 'netProfit'\)/);
  // The loud reconciliation guard must survive, with the same recognisable string.
  assert.match(src, /does not reconcile to the Net Profit KPI/);
  assert.match(src, /checkNetDrift\(plan, kpiNet, order\.length\)/);
});

test('the money axis is no longer clamped at 0, so losses render below the baseline', () => {
  // Scope to the Performance-overview body — the sibling drawRevenueProfit keeps its own
  // deliberate min:0 (dual-axis baseline alignment), so assert against THIS chart only.
  const body = src.slice(
    src.indexOf('function drawPerformanceOverview'),
    src.indexOf('function drawAllCharts'),
  );
  assert.doesNotMatch(
    body, /y:\s*\{ beginAtZero: true, min: 0, position: 'left'/,
    'the min:0 clamp on the money axis is what hid negative net profit',
  );
  // The money axis is now set from the real data floor (moneyMin ≤ 0), so a loss still dips
  // below the baseline — but the number is explicit so the count axes can align to it.
  assert.match(body, /y:\s*\{ min: moneyMin, max: moneyMax, position: 'left'/);
  // …and an emphasised zero gridline is drawn so break-even is obvious.
  assert.match(body, /gctx\.tick\?\.value === 0 \? c\.textMuted : c\.border/);
});

test('orders can never render below the baseline — count axes share the money-zero row', () => {
  const body = src.slice(
    src.indexOf('function drawPerformanceOverview'),
    src.indexOf('function drawAllCharts'),
  );
  // Root cause of "orders show as negative": a hard min:0 on the orders axis pinned orders-0 to
  // the plot BOTTOM, while the money axis dipped below 0 for a loss — so its 0 gridline sat
  // higher, and low order counts fell beneath it. The fix gives every COUNT axis the money
  // axis's own below-zero fraction, so all zeros land on the same pixel row.
  assert.match(body, /const zeroFrac = moneyMax > 0 \? moneyMin \/ moneyMax : 0/);
  assert.match(body, /y1:\s*\{ min: ordersMax \* zeroFrac, max: ordersMax, position: 'right'/,
    'orders-0 aligns to the money-0 gridline instead of the plot bottom');
  // Any negative tick the alignment introduces is blanked, so the axis never prints a negative count.
  assert.match(body, /callback: \(v\) => v < 0 \? '' : Math\.round\(v\)/,
    'negative order-count ticks are hidden');
  // The orders axis must NOT go back to a hard min:0 — that reintroduces the misalignment.
  assert.doesNotMatch(body, /y1:\s*\{ beginAtZero: true, min: 0/);
});

test('traffic overlay: sessions + pageviews on a hidden, baseline-aligned scale, fail-soft loud', () => {
  const body = src.slice(
    src.indexOf('function drawPerformanceOverview'),
    src.indexOf('function drawAllCharts'),
  );
  // Both lines are added on the hidden y2 scale (no third number column) and share the same
  // zeroFrac alignment as orders, so traffic can't dip below the baseline either.
  assert.match(body, /trafficLine\('Sessions', sessions, /);
  assert.match(body, /trafficLine\('Pageviews', pageviews, /);
  assert.match(body, /yAxisID: 'y2'/);
  assert.match(body, /y2:\s*\{ min: trafficMax \* zeroFrac, max: trafficMax, position: 'right', display: false/);
  // Fail-soft must be LOUD: no data → lines omitted (guarded on trafficMissing), never a zero line,
  // and the card says so.
  assert.match(body, /if \(!trafficMissing\)/);
  // The note text lives in renderOverviewNotes (above this body slice) → assert against full src.
  assert.match(src, /Traffic data isn’t available for this range/);
  assert.match(body, /renderOverviewNotes\(plan, drift, opexLabel, hasBackendOpex, trafficMissing\)/);
  // Daily rows are re-bucketed to this chart's grain via the shared indexFor().
  assert.match(body, /indexFor\(Date\.parse\(String\(row\?\.date/);
});

test('the dashboard fetches the traffic time-series and parses it null-honestly', () => {
  // Wired into the parallel load, with a wide fallback range so the all-time view still returns.
  // The range is FilterState.getDateRange(), which is always concrete (All time starts at the
  // store's first-data date), so no wide fallback is needed any more.
  assert.match(src, /AdminAPI\.getTrafficTimeseries\(from, to, signal\)/);
  assert.match(src, /const \{ from, to \} = FilterState\.getDateRange\(\)/);
  // Parsed through the shared normalizer → [] when absent (→ lines omit), never a fabricated zero.
  assert.match(src, /sTraffic: normalizeSeries\(val\(11\)\)/);
});
