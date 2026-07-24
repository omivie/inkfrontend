/**
 * dashboard-net-series-jul2026.test.js — ERR-111
 *
 * Pins the frontend follow-through to backend migration 118 + commit b356b48.
 *
 * THE BACKEND DEFECT (fixed server-side): `kpi-summary` subtracted an ex-GST COGS from
 * GST-INCLUSIVE revenue, so the 15% GST collected on revenue (~$1,088 all-time) was booked
 * as profit, and Stripe fees were left out of the comparison. Gross/net profit were
 * over-stated and `Σ gross_profit_series` disagreed with the KPI tile by ~$1,307.
 *
 * VERIFIED LIVE 2026-07-20 (owner session, https://api.inkcartridges.co.nz), period=all:
 *     revenue 8342.15 · gross_profit 1591.20 · stripe_fees 178.65
 *     operating_expenses 1071.69 · net_profit 340.86
 *     1591.20 − 178.65 − 1071.69 = 340.86 exactly
 * and `net_profit_series` rows are now { bucket_start, net_profit, stripe_fees,
 * operating_expenses }. Σ series vs kpi-summary across four windows (incl. the
 * 2026-06-22..28 acceptance window): gross ≤ $0.01, net ≤ $0.02, fees ≤ $0.01, opex ≤ $0.02
 * — pure per-bucket rounding at ~1c/bucket, with zero null buckets.
 *
 * TWO DEFECTS THE BACKEND MESSAGE DID NOT MENTION, both caused by the same migration and
 * both pinned here:
 *   A. `kpiCogsInclGst` returned an EX-GST figure under an incl-GST name (understating real
 *      supplier cash by 15%, ~$849 all-time). Settled by arithmetic on the backend's own
 *      published numbers: rev_INCL − cogs reproduces the OLD gross to the cent, rev_EX − cogs
 *      reproduces the NEW one, so `cogs` is the same ex-GST figure on both sides.
 *   B. The margin tiles divided ex-GST profit by GST-INCLUSIVE revenue → 19.07%, while the
 *      backend's own `margin_proxy` said 21.9%. `margin_proxy` was never read at all.
 *
 * WHAT THIS FILE GUARDS
 *   1. Reconciliation tripwire — fails FIRST if the GST basis ever flips back.
 *   2. Both COGS bases, and the ×1.15 landing on the right one.
 *   3. Drift-guard tolerance scaling, and that it cannot mask a real regression.
 *   4. The null-as-zero false-alarm bug: guard goes QUIET, UI goes LOUD — different channels.
 *   5-8. Null honesty, degrade paths, wrapped shapes, bucket-key normalisation.
 *   9. The upgraded recoverProfitFromSeries (self-disable, independent gates, scalar-primary).
 *   10. Margin base. 11. Source wiring. 12. Cumulative interaction.
 *
 * Run with: node --test tests/dashboard-net-series-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js');
const TREND_MATH = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'trend-math.js');
const FINANCIAL = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'financial-health.js');

const src = fs.readFileSync(DASHBOARD, 'utf8');
const financialSrc = fs.readFileSync(FINANCIAL, 'utf8');

/**
 * Lift a declaration out of dashboard.js by brace-matching from its opening `{`.
 * dashboard.js imports app.js/charts.js so it can't be evaluated whole — but the helpers
 * under test are pure, and this runs the REAL shipped source rather than a copy that could
 * silently drift from it.
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

function functionBody(source, name) {
  const i = source.indexOf(`function ${name}`);
  assert.ok(i !== -1, `${name} not found`);
  const open = source.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(i, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Map };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(
  [lift('numOrNull'), lift('resolveList'), lift('buildOverviewBuckets'),
   lift('planProfitLine'), lift('checkNetDrift'), lift('checkMarginConsistency'),
   lift('recoverProfitFromSeries')].join('\n\n')
  + '\n;globalThis.buildOverviewBuckets = buildOverviewBuckets;'
  + '\n;globalThis.planProfitLine = planProfitLine;'
  + '\n;globalThis.checkNetDrift = checkNetDrift;'
  + '\n;globalThis.checkMarginConsistency = checkMarginConsistency;'
  + '\n;globalThis.recoverProfitFromSeries = recoverProfitFromSeries;',
  ctx,
  { filename: 'dashboard-lifted.js' },
);
const { buildOverviewBuckets, planProfitLine, checkNetDrift, checkMarginConsistency,
        recoverProfitFromSeries } = sandbox;

// trend-math is a real ES module with no DOM deps — strip `export` and run it.
const trendSandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
trendSandbox.globalThis = trendSandbox;
const trendSrc = fs.readFileSync(TREND_MATH, 'utf8').replace(/^export\s+/gm, '');
vm.runInContext(
  trendSrc + '\n;globalThis.kpiCogsExGst = kpiCogsExGst;'
           + '\n;globalThis.kpiCogsInclGst = kpiCogsInclGst;'
           + '\n;globalThis.reconciledGrossProfitInclGst = reconciledGrossProfitInclGst;',
  vm.createContext(trendSandbox),
  { filename: 'trend-math-lifted.js' },
);
const { kpiCogsExGst, kpiCogsInclGst, reconciledGrossProfitInclGst } = trendSandbox;

const round = (n) => Math.round(n * 100) / 100;

// Arrays built inside the vm realm have a different Array.prototype, which strict deepEqual
// treats as a mismatch. Copy into this realm before comparing shapes.
const vals = (a) => Array.from(a);

/** The live all-time kpi-summary payload, verbatim from the backend on 2026-07-20. */
const LIVE_CURRENT = {
  revenue: 8342.15,
  orders: 63,
  includes_invoices: true,
  invoice_revenue: 1268.48,
  invoice_orders: 3,
  aov: 132.42,
  refund_rate: 0,
  margin_proxy: 21.9,
  gross_profit: 1591.20,
  stripe_fees: 178.65,
  operating_expenses: 1071.69,
  net_profit: 340.86,
};

/** A bucketed net_profit_series in the live row shape. */
const mkNet = (rows) => rows.map(([bucket_start, net_profit, stripe_fees, operating_expenses]) =>
  ({ bucket_start, net_profit, stripe_fees, operating_expenses }));

// ─── 1. Reconciliation tripwire — fails first if the basis flips back ───────

test('the live KPI identity holds to the cent: gross − fees − opex === net', () => {
  const { gross_profit: g, stripe_fees: f, operating_expenses: o, net_profit: n } = LIVE_CURRENT;
  assert.equal(round(g - f - o), round(n));
  assert.equal(round(g - f - o), 340.86);
});

test('the ORIGINAL defect is pinned: revenue GST must never be booked as profit', () => {
  // Pre-migration-118 the RPC computed revenue_INCL − cogs. Reproduce it and assert the
  // live figure is NOT that number — the gap is exactly the GST on revenue.
  const revenue = LIVE_CURRENT.revenue;
  const cogsEx = kpiCogsExGst(revenue, LIVE_CURRENT.gross_profit);   // 5662.84
  const preFixGross = round(revenue - cogsEx);                        // the old $2,679.31
  assert.equal(preFixGross, 2679.31, 'sanity: this reproduces the pre-fix figure');
  assert.notEqual(round(LIVE_CURRENT.gross_profit), preFixGross);
  // The entire difference is the 3/23 GST on revenue — proof only the revenue basis moved.
  assert.equal(round(preFixGross - LIVE_CURRENT.gross_profit), round(revenue * 3 / 23));
  assert.equal(round(revenue * 3 / 23), 1088.11);
});

test('Σ net_profit_series reconciles to the KPI net within the rounding residual', () => {
  // The live 2026-06-22..28 acceptance window: kpi net 27.10, series sums to 27.12.
  const series = mkNet([
    ['2026-06-22', -143.28, 0, 173.91], ['2026-06-23', 21.4, 3.1, 0],
    ['2026-06-24', 38.6, 8.2, 0],       ['2026-06-25', 41.05, 9.4, 0],
    ['2026-06-26', 26.19, 7.8, 0],      ['2026-06-27', 22.06, 6.4, 0],
    ['2026-06-28', 21.1, 6.4, 0],
  ]);
  const total = round(series.reduce((a, r) => a + r.net_profit, 0));
  const kpiNet = 27.10;
  assert.ok(Math.abs(total - kpiNet) <= 0.05,
    `series ${total} must reconcile to kpi ${kpiNet}`);
  // ...and the guard must stay SILENT at that residual.
  const { order, byBucket } = buildOverviewBuckets({ sNetProfit: series });
  const plan = planProfitLine(order, byBucket);
  assert.equal(checkNetDrift(plan, kpiNet, order.length), null);
});

// ─── 2. GST basis — both COGS bases, ×1.15 on the right one (ERR-111) ───────

test('kpiCogsExGst recovers the backend’s own ex-GST cogs exactly', () => {
  assert.equal(round(kpiCogsExGst(8342.15, 1591.20)), 5662.84);
});

test('kpiCogsInclGst returns real cash to suppliers — NOT the ex-GST figure', () => {
  const incl = kpiCogsInclGst(8342.15, 1591.20);
  assert.equal(round(incl), 6512.27);
  assert.notEqual(round(incl), 5662.84,
    'ERR-111: returning the ex-GST figure here understates supplier cash by 15% (~$849 all-time)');
});

test('kpiCogsInclGst is the exact inverse of reconciledGrossProfitInclGst', () => {
  // These were NOT inverses before ERR-111 — the round-trip silently lost 15%.
  const gp = 1591.20;
  const rt = reconciledGrossProfitInclGst(8342.15, kpiCogsInclGst(8342.15, gp));
  assert.ok(Math.abs(rt - gp) < 1e-9, `round-trip must be lossless, got ${rt}`);
});

test('the chart’s COGS line uses the incl-GST (cash) helper, not the ex-GST one', () => {
  const body = functionBody(src, 'drawPerformanceOverview');
  assert.match(body, /kpiCogsInclGst\(rev, gp\)/);
  assert.doesNotMatch(body, /kpiCogsExGst\(/,
    'the cost lines represent cash out, so they must use the grossed-up figure');
});

// ─── 3. Drift-guard tolerance scaling ───────────────────────────────────────

const planOf = (netValues) => planProfitLine(
  netValues.map((_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
  new Map(netValues.map((v, i) => [`2026-01-${String(i + 1).padStart(2, '0')}`, { netProfit: v }])),
);

test('tolerance scales with bucket count: 2c over 30 buckets is silent', () => {
  const values = new Array(30).fill(10);
  const plan = planOf(values);                       // Σ = 300
  assert.equal(checkNetDrift(plan, 299.98, 30), null, '2c residual over 30 buckets is expected');
});

test('a real basis regression trips it regardless of bucket count', () => {
  const plan = planOf(new Array(30).fill(10));       // Σ = 300
  // Stripe fees dropped from the comparison — the $178.65 shape.
  const fees = checkNetDrift(plan, 300 - 178.65, 30);
  assert.ok(fees, 'a dropped-fees regression must be caught');
  assert.equal(round(fees.gap), 178.65);
  // The literal original P0: revenue GST booked as profit, $1,088.11.
  const gst = checkNetDrift(plan, 300 - 1088.11, 30);
  assert.ok(gst, 'the incl-vs-ex-GST regression must be caught');
  assert.equal(round(gst.gap), 1088.11);
});

test('the 5c floor stops a single-bucket range tripping on float noise', () => {
  const plan = planOf([100]);
  assert.equal(checkNetDrift(plan, 99.97, 1), null, '3c on one bucket is within the floor');
  assert.ok(checkNetDrift(plan, 99.5, 1), '50c on one bucket is a real gap');
});

test('365 daily buckets tolerate ~$7.30 but not $8', () => {
  const plan = planOf(new Array(365).fill(1));       // Σ = 365
  assert.equal(checkNetDrift(plan, 365 - 7.20, 365), null, 'inside the 365 × 2c tolerance');
  assert.ok(checkNetDrift(plan, 365 - 8, 365));
  // Even the widest tolerance is orders of magnitude below a real regression.
  assert.ok(0.02 * 365 < 178.65, 'tolerance must never approach a real defect');
});

// ─── 4. The null-as-zero false alarm: guard QUIET, UI LOUD ──────────────────

test('a PARTIAL series silences the guard instead of false-alarming', () => {
  // The old guard summed netByBucket treating null as 0 (=300) and compared it to a
  // full-range KPI net (500), reporting a $200 "gap" that was really just a missing bucket.
  const plan = planOf([100, null, 200]);
  assert.equal(plan.complete, false);
  assert.equal(checkNetDrift(plan, 500, 3), null,
    'a partial series says nothing about backend self-consistency — it must not warn');
});

test('...and the partial-ness surfaces in the RETURN VALUE so the UI can shout', () => {
  const plan = planOf([100, null, 200]);
  assert.equal(plan.nullCount, 1);
  assert.equal(plan.knownCount, 2);
  assert.equal(plan.seriesTotal, 300);
  // Fail-soft must be LOUD: the caller renders a caption off nullCount. Guard and UI are
  // deliberately DIFFERENT channels — quieting one must not quiet the other.
  const notes = functionBody(src, 'renderOverviewNotes');
  assert.match(notes, /plan\.nullCount > 0/);
  assert.match(notes, /periods have no profit figure/);
});

test('the drift caption names both backend figures and blames neither the chart', () => {
  const notes = functionBody(src, 'renderOverviewNotes');
  assert.match(notes, /These two backend figures disagree/);
  assert.match(notes, /drift\.seriesTotal/);
  assert.match(notes, /drift\.kpiNet/);
  assert.match(notes, /Neither figure can be trusted/);
});

// ─── 5. Null honesty (ERR-028) ──────────────────────────────────────────────

test('a null bucket stays null — never 0, never interpolated', () => {
  const plan = planOf([100, null, 200]);
  assert.equal(plan.values[1], null);
  assert.notEqual(plan.values[1], 0);
  assert.deepEqual(vals(plan.values), [100, null, 200]);
});

test('a genuine 0 bucket is a real answer, not an unknown', () => {
  const plan = planOf([100, 0, 200]);
  assert.equal(plan.values[1], 0);
  assert.equal(plan.nullCount, 0);
  assert.equal(plan.complete, true);
  assert.equal(plan.seriesTotal, 300);
});

test('a loss-making bucket keeps its negative value', () => {
  const plan = planOf([-143.28, 21.4]);
  assert.equal(plan.values[0], -143.28);
  assert.equal(round(plan.seriesTotal), -121.88);
});

// ─── 6. Degrade paths — the frontend stops manufacturing a number ───────────

test('no net series at all → plots gross, LABELLED gross', () => {
  const d = { sGrossProfit: [{ bucket_start: '2026-07-01', gross_profit: 50 },
                             { bucket_start: '2026-07-02', gross_profit: 70 }] };
  const { order, byBucket } = buildOverviewBuckets(d);
  const plan = planProfitLine(order, byBucket);
  assert.equal(plan.basis, 'gross-fallback');
  assert.equal(plan.label, 'Gross profit');
  assert.deepEqual(vals(plan.values), [50, 70]);
});

test('an ALL-NULL net series is not a run of $0 net — it degrades to gross', () => {
  const { order, byBucket } = buildOverviewBuckets({
    sGrossProfit: [{ bucket_start: '2026-07-01', gross_profit: 50 }],
    sNetProfit:   [{ bucket_start: '2026-07-01', net_profit: null }],
  });
  const plan = planProfitLine(order, byBucket);
  assert.equal(plan.basis, 'gross-fallback');
  assert.equal(plan.label, 'Gross profit');
  assert.deepEqual(vals(plan.values), [50]);
  assert.notEqual(plan.values[0], 0, 'an unanswered net must never render as $0');
});

test('ONE known net bucket is enough to plot net (the rest gap honestly)', () => {
  const d = {
    sGrossProfit: [{ bucket_start: '2026-07-01', gross_profit: 50 },
                   { bucket_start: '2026-07-02', gross_profit: 70 }],
    sNetProfit:   [{ bucket_start: '2026-07-01', net_profit: 12 },
                   { bucket_start: '2026-07-02', net_profit: null }],
  };
  const { order, byBucket } = buildOverviewBuckets(d);
  const plan = planProfitLine(order, byBucket);
  assert.equal(plan.basis, 'net-series');
  assert.equal(plan.label, 'Net profit');
  assert.deepEqual(vals(plan.values), [12, null]);
  assert.equal(plan.complete, false);
});

test('empty range → no buckets, and the caller short-circuits before planning', () => {
  const { order } = buildOverviewBuckets({});
  assert.equal(order.length, 0);
  assert.match(functionBody(src, 'drawPerformanceOverview'), /if \(!order\.length\)/);
});

// ─── 7. Wrapped payload shapes the bundle can return ────────────────────────

test('accepts {series:[…]} and {data:[…]} for the net series', () => {
  const rows = [{ bucket_start: '2026-07-01', net_profit: 42 }];
  for (const sNetProfit of [rows, { series: rows }, { data: rows }]) {
    const { order, byBucket } = buildOverviewBuckets({ sNetProfit });
    assert.equal(planProfitLine(order, byBucket).values[0], 42);
  }
});

// ─── 8. Bucket-key normalisation ────────────────────────────────────────────

test('an ISO timestamp and a bare date collapse to ONE bucket, not two', () => {
  // Un-normalised, these split one day into two labels and halve both lines.
  const { order, byBucket } = buildOverviewBuckets({
    sRevenue:   [{ bucket_start: '2026-07-01', revenue: 500 }],
    sNetProfit: [{ bucket_start: '2026-07-01T00:00:00Z', net_profit: 42 }],
  });
  assert.equal(order.length, 1, 'both series must land on the same bucket');
  assert.equal(order[0], '2026-07-01');
  assert.equal(byBucket.get('2026-07-01').revenue, 500);
  assert.equal(byBucket.get('2026-07-01').netProfit, 42);
});

test('rows with no usable bucket key are skipped, not keyed as ""', () => {
  const { order } = buildOverviewBuckets({ sNetProfit: [{ net_profit: 5 }] });
  assert.equal(order.length, 0);
});

// ─── 9. The upgraded recoverProfitFromSeries ────────────────────────────────

const GROSS_SERIES = [{ gross_profit: 800 }, { gross_profit: 791.20 }];
const NET_SERIES = mkNet([['a', 170.44, 89.32, 535.84], ['b', 170.44, 89.33, 535.85]]);

test('self-disables COMPLETELY on the healthy live payload', () => {
  assert.equal(recoverProfitFromSeries(LIVE_CURRENT, GROSS_SERIES, NET_SERIES), null,
    'both figures are real — behave exactly as if this function did not exist');
});

test('real gross + NULL net now recovers net (the hole this upgrade closes)', () => {
  // Previously the function bailed on line 1 whenever gross_profit was present, blanking
  // the Net tile even with a complete net_profit_series in the same bundle.
  const cur = { ...LIVE_CURRENT, net_profit: null };
  const r = recoverProfitFromSeries(cur, GROSS_SERIES, NET_SERIES);
  assert.ok(r, 'must recover');
  assert.equal(r.grossRebuilt, false, 'gross was real — do not claim it was rebuilt');
  assert.equal(r.netRebuilt, true);
  assert.equal(round(r.net), round(1591.20 - 178.65 - 1071.69));
  assert.equal(round(r.net), 340.86);
});

test('net PREFERS the range-exact scalars over Σ series (rounding residual)', () => {
  // Construct a case where the two disagree by 2c and assert the scalar formula wins.
  const cur = { ...LIVE_CURRENT, net_profit: null };
  const driftedSeries = mkNet([['a', 170.45, 0, 0], ['b', 170.43, 0, 0]]); // Σ = 340.88
  const r = recoverProfitFromSeries(cur, GROSS_SERIES, driftedSeries);
  assert.equal(round(r.net), 340.86, 'the scalar formula is range-exact and must win');
  assert.notEqual(round(r.net), 340.88);
});

test('...but falls back to Σ net_profit_series when a scalar is missing', () => {
  const cur = { ...LIVE_CURRENT, net_profit: null, stripe_fees: null };
  const r = recoverProfitFromSeries(cur, GROSS_SERIES, NET_SERIES);
  assert.ok(r, 'a published per-bucket figure beats blanking the tile');
  assert.equal(round(r.net), 340.88);
  assert.equal(r.netRebuilt, true);
});

test('ONE null bucket poisons a sum → THAT figure stays unknown, others survive', () => {
  const cur = { ...LIVE_CURRENT, gross_profit: null };
  const poisoned = [{ gross_profit: 800 }, { gross_profit: null }];
  const r = recoverProfitFromSeries(cur, poisoned, NET_SERIES);
  // Gross is genuinely unknown → null, so the tile shows "—" (ERR-028). It must NOT be
  // summed past the gap, and must NOT be reported as rebuilt.
  assert.equal(r.gross, null, 'unknown COGS in the range → never guess past it');
  assert.equal(r.grossRebuilt, false, 'nothing was successfully rebuilt, so claim nothing');
  // ...but the REAL net from kpi-summary is untouched. The old code bailed wholesale here,
  // which was harmless for gross yet discarded a perfectly good net alongside it.
  assert.equal(r.net, 340.86);
  assert.equal(r.netRebuilt, false, 'net came straight from kpi-summary');
});

test('gross_profit: 0 and net_profit: 0 are real answers, never overridden', () => {
  // The classic `??` vs `||` trap — a real $0 must not trigger a rebuild.
  const cur = { ...LIVE_CURRENT, gross_profit: 0, net_profit: 0 };
  assert.equal(recoverProfitFromSeries(cur, GROSS_SERIES, NET_SERIES), null);
});

test('a rebuilt gross does NOT stamp "rebuilt" on a real net tile', () => {
  const cur = { ...LIVE_CURRENT, gross_profit: null };
  const r = recoverProfitFromSeries(cur, GROSS_SERIES, NET_SERIES);
  assert.equal(r.grossRebuilt, true);
  assert.equal(r.netRebuilt, false, 'net came from kpi-summary — provenance must not leak across');
});

// ─── 10. Margin base (defect B) ─────────────────────────────────────────────

test('margins prefer the backend’s own margin_proxy', () => {
  assert.match(src, /cur\.margin_proxy\s*!=\s*null\s*\?\s*Number\(cur\.margin_proxy\)/);
});

test('the derived margin base is ex-GST revenue, not the GST-inclusive figure', () => {
  const body = functionBody(src, 'renderKpiStrip');
  assert.match(body, /\(20 \/ 23\)/, 'the margin base must strip GST from revenue');
  assert.doesNotMatch(body, /marginOf\(grossProfit, cur\.revenue\)\s*;[\s\S]{0,40}\* 100/,
    'dividing ex-GST profit by incl-GST revenue understates every margin by ~13%');
  // Arithmetic proof of the live numbers this fixes: 19.07% → 21.94%.
  const wrong = (1591.20 / 8342.15) * 100;
  const right = (1591.20 / (8342.15 * 20 / 23)) * 100;
  assert.equal(round(wrong), 19.07);
  assert.equal(round(right), 21.94);
  assert.ok(Math.abs(right - LIVE_CURRENT.margin_proxy) < 0.05,
    'the ex-GST base must agree with the backend’s margin_proxy');
});

// ─── 10b. Margin consistency gate (ERR-113) ─────────────────────────────────
//
// Live 2026-07-22, period=all: revenue 7728.48, gross_profit 1418.44, net_profit −19.67.
// The Net Margin tile read −29.3% while −19.67 / (7728.48 × 20/23) = −0.29% — the tile
// contradicted the Net Profit tile beside it by ~100×, and the frontend passed the backend's
// figure through in silence. Preferring the backend is right; rendering it BLINDLY is not.

const LIVE_0722 = { revenue: 7728.48, gross_profit: 1418.44, net_profit: -19.67 };
const exGst = (rev) => rev * (20 / 23);
const derivedMargin = (profit, rev) => (profit / exGst(rev)) * 100;

test('the live −29.3% net margin is caught: it disagrees with its own profit tile', () => {
  const derived = derivedMargin(LIVE_0722.net_profit, LIVE_0722.revenue);
  assert.equal(round(derived), -0.29, 'the honest figure is −0.29%, not −29.3%');
  const chk = checkMarginConsistency('Net Margin', -29.3, derived);
  assert.ok(chk, 'a 100× disagreement must trip the gate');
  assert.equal(chk.backend, -29.3);
  assert.ok(Math.abs(Math.abs(chk.ratio) - 100) < 10, 'the ratio must name it as a scale bug');
});

test('an agreeing margin_proxy stays silent — this gate does not stop trusting the backend', () => {
  // The live 2026-07-20 pair: margin_proxy 21.9 vs derived 21.94. Pure rounding.
  const derived = derivedMargin(LIVE_CURRENT.gross_profit, LIVE_CURRENT.revenue);
  assert.equal(round(derived), 21.94);
  assert.equal(checkMarginConsistency('Gross Margin', LIVE_CURRENT.margin_proxy, derived), null);
});

test('the ERR-111 incl-GST basis error still trips the gate', () => {
  // 19.07% (÷ GST-inclusive revenue) vs 21.94% (÷ ex-GST). The gate is a second net under
  // the original defect: if the base ever regresses, the strip says so out loud.
  assert.ok(checkMarginConsistency('Gross Margin', 19.07, 21.94));
});

test('ordinary rounding never trips it, and a near-zero margin does not explode', () => {
  assert.equal(checkMarginConsistency('Gross Margin', 21.9, 21.94), null);
  assert.equal(checkMarginConsistency('Net Margin', 0.01, 0.02), null, '0.5pp floor absorbs float noise');
  const chk = checkMarginConsistency('Net Margin', 40, 0.0001);
  assert.equal(chk.ratio, null, 'a ~0 denominator must not produce an absurd ratio');
});

test('unknown on either side is not a disagreement', () => {
  assert.equal(checkMarginConsistency('Net Margin', null, 12), null);
  assert.equal(checkMarginConsistency('Net Margin', 12, null), null);
  assert.equal(checkMarginConsistency('Net Margin', NaN, 12), null);
});

test('renderKpiStrip shows the DERIVED figure when the gate trips, and says so loudly', () => {
  const body = functionBody(src, 'renderKpiStrip');
  assert.match(body, /grossMarginCheck\s*\?\s*grossMarginDerived/,
    'a failing gross gate must fall back to the derived figure');
  assert.match(body, /netMarginCheck\s*\?\s*netMarginDerived/,
    'a failing net gate must fall back to the derived figure');
  assert.match(body, /admin-dash-note--alert/,
    'the disagreement must be surfaced in the UI, not just swapped silently');
  assert.match(body, /esc\(fmtPct\(chk\.backend\)\)/, 'the note must name the backend’s own figure');
});

// ─── 10c. Backend stripe_fees convention (ERR-114) ──────────────────────────
//
// Reverse-engineered from the live 2026-07-20 payload above, exact to 0.4 of a cent. Pinned
// because it is the ONLY record of the backend's fee formula anywhere in this repo, and
// because it disagrees with profitability.js by 15%.

test('backend stripe_fees DOES carve out invoiced (bank-transfer) sales', () => {
  const naive = 0.0265 * LIVE_CURRENT.revenue + 0.30 * LIVE_CURRENT.orders;
  assert.ok(LIVE_CURRENT.stripe_fees < naive - 1,
    'if this ever equals the naive figure, invoiced sales are being charged a card fee they never paid');
});

test('backend stripe_fees = (2.65% × card revenue + $0.30 × card orders) × 20/23', () => {
  const cardRevenue = LIVE_CURRENT.revenue - LIVE_CURRENT.invoice_revenue;
  const cardOrders  = LIVE_CURRENT.orders  - LIVE_CURRENT.invoice_orders;
  const feeInclGst  = 0.0265 * cardRevenue + 0.30 * cardOrders;
  assert.equal(round(feeInclGst * 20 / 23), LIVE_CURRENT.stripe_fees,
    'the backend treats the 2.65% + $0.30 as GST-INCLUSIVE and strips GST to express it ex-GST');
});

test('DIVERGENCE: profitability.js treats the same rate as ex-GST — 15% apart', () => {
  // profitability.js: stripeFee = base × 0.0265 + 0.30, deducted ex-GST, with GST ADDED on top
  // (computeProfitBreakdown.stripeFeeGst). The backend divides the identical expression by 1.15.
  // Both cannot be right. Whichever is, the order modal and the dashboard currently disagree by
  // 15% of every card fee — $26.80 all-time on this payload.
  const cardRevenue = LIVE_CURRENT.revenue - LIVE_CURRENT.invoice_revenue;
  const cardOrders  = LIVE_CURRENT.orders  - LIVE_CURRENT.invoice_orders;
  const feStyle = 0.0265 * cardRevenue + 0.30 * cardOrders;   // ex-GST per profitability.js
  const beStyle = LIVE_CURRENT.stripe_fees;                    // ex-GST per the backend
  assert.equal(round(feStyle - beStyle), 26.80);
  assert.equal(round(feStyle / beStyle), 1.15);
});

// ─── 11. Source wiring ──────────────────────────────────────────────────────

test('the backend’s per-bucket operating_expenses is PRIMARY, /expenses only a fallback', () => {
  const body = functionBody(src, 'drawPerformanceOverview');
  assert.match(body, /const backendOpex = order\.map\(b => numOrNull\(byBucket\.get\(b\)\?\.opex\)\)/);
  assert.match(body, /const hasBackendOpex = backendOpex\.some\(v => v != null\)/);
  // The client-side bucketing must be unreachable when the backend answered.
  assert.match(body, /if \(!hasBackendOpex\) \{[\s\S]*?d\.expenseRows/);
  assert.match(body, /hasBackendOpex \? backendOpex : loggedOpex/);
});

test('the fallback expense line is LABELLED differently — it is a different measurement', () => {
  const body = functionBody(src, 'drawPerformanceOverview');
  const m = body.match(/const opexLabel = hasBackendOpex \? '([^']+)' : '([^']+)'/);
  assert.ok(m, 'opexLabel must branch on the source');
  assert.notEqual(m[1], m[2],
    'live 2026-07-20 these differed by $304 — reusing one label would repeat the lie being fixed');
  // ...and the caption must explain the discrepancy rather than leave it silent.
  assert.match(functionBody(src, 'renderOverviewNotes'), /!hasBackendOpex/);
});

test('renderOverviewSection shares ONE planner with the chart legend', () => {
  const body = functionBody(src, 'renderOverviewSection');
  assert.match(body, /planProfitLine\(order, byBucket\)\.label\.toLowerCase\(\)/);
  assert.doesNotMatch(body, /npList/,
    'the independent npList heuristic let the subtitle contradict the legend');
  assert.match(body, /id="dash-overview-notes"/, 'the notes need a mount point');
});

test('the GST basis is stated where the owner would otherwise mis-subtract', () => {
  assert.match(src, /profit is measured net of GST/i);
  assert.match(financialSrc, /Revenue is GST-inclusive/);
  assert.match(financialSrc, /don’t subtract\s+straight down the column/);
  // The P&L null-honesty convention must survive the edit.
  assert.match(financialSrc, /const known = \(v\) =>/);
  assert.match(financialSrc, /if \(!known\(v\)\) return MISSING/);
});

// ─── 12b. renderOverviewNotes actually RENDERS (not just contains the string) ─
//
// Source-text assertions prove the copy exists; these prove it reaches the DOM. Verified in
// the live browser too (a shimmed bundle halving every net bucket produced exactly:
// "net-profit line ($170.44) does not reconcile to the Net Profit KPI ($340.86) — gap
// $170.43, tolerance $3.62"), but that run depended on SWR repaint timing — this does not.

function renderNotes({ plan, drift, opexLabel = 'Operating expenses', hasBackendOpex = true }) {
  const host = { innerHTML: '' };
  const noteSandbox = {
    console, Math, Number, Object, Array, String, Boolean, JSON, Error,
    document: { getElementById: (id) => (id === 'dash-overview-notes' ? host : null) },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    formatPrice: (v) => `$${Number(v || 0).toFixed(2)}`,
  };
  noteSandbox.globalThis = noteSandbox;
  vm.runInContext(
    lift('renderOverviewNotes') + '\n;globalThis.__run = renderOverviewNotes;',
    vm.createContext(noteSandbox),
    { filename: 'notes-lifted.js' },
  );
  noteSandbox.__run(plan, drift, opexLabel, hasBackendOpex);
  return host.innerHTML;
}

test('a healthy range renders NO notes at all', () => {
  const html = renderNotes({ plan: planOf([10, 20, 30]), drift: null });
  assert.equal(html, '', 'nothing is wrong, so the card must stay clean');
});

test('a drift renders the LOUD alert with both figures and the gap', () => {
  const html = renderNotes({
    plan: planOf([170.44]),
    drift: { seriesTotal: 170.44, kpiNet: 340.86, gap: -170.42, tolerance: 3.62 },
  });
  assert.match(html, /admin-dash-note--alert/, 'the drift note must carry the alert style');
  assert.match(html, /These two backend figures disagree/);
  assert.match(html, /\$170\.44/, 'must name the series total');
  assert.match(html, /\$340\.86/, 'must name the KPI figure');
  assert.match(html, /\$170\.42/, 'must state the gap');
  assert.match(html, /Neither figure can be trusted/);
});

test('a partial series renders the gap caption — LOUD where the guard is silent', () => {
  const plan = planOf([100, null, 200]);
  const html = renderNotes({ plan, drift: checkNetDrift(plan, 500, 3) });
  assert.doesNotMatch(html, /admin-dash-note--alert/, 'the guard is silent on a partial series');
  assert.match(html, /1 of 3 periods have no profit figure/);
  assert.match(html, /gaps there/);
});

test('the gross-fallback renders its own caption, not the partial one', () => {
  const { order, byBucket } = buildOverviewBuckets({
    sGrossProfit: [{ bucket_start: '2026-07-01', gross_profit: 50 }],
  });
  const html = renderNotes({ plan: planProfitLine(order, byBucket), drift: null });
  assert.match(html, /Net profit isn’t available per period/);
  assert.match(html, /gross profit/);
  assert.doesNotMatch(html, /have no profit figure/);
});

test('the client-side expense fallback is disclosed on the card', () => {
  const html = renderNotes({
    plan: planOf([10]), drift: null,
    opexLabel: 'Logged expenses (client-side)', hasBackendOpex: false,
  });
  assert.match(html, /Logged expenses \(client-side\)/);
  assert.match(html, /bucketed from your logged expenses in the\s+browser/);
  assert.match(html, /recurring charges/, 'must say WHY it can differ from the tile');
});

test('escaping: the notes never interpolate a label raw', () => {
  const html = renderNotes({
    plan: planOf([10]), drift: null,
    opexLabel: '<img src=x onerror=alert(1)>', hasBackendOpex: false,
  });
  assert.doesNotMatch(html, /<img/, 'opexLabel must go through esc()');
  assert.match(html, /&lt;img/);
});

// ─── 12. Cumulative interaction ─────────────────────────────────────────────

test('a cumulative total halts permanently at the first unknown bucket', () => {
  // Re-pinned against the real series rather than the retired proration output.
  const accum = (arr) => {
    let acc = 0, broken = false;
    return arr.map(v => {
      if (v == null) { broken = true; return null; }
      if (broken) return null;
      return (acc += v);
    });
  };
  assert.deepEqual(vals(accum(planOf([10, null, 30]).values)), [10, null, null]);
  assert.deepEqual(vals(accum(planOf([10, 20, 30]).values)), [10, 30, 60]);
});
