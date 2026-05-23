/**
 * website-traffic-analytics.test.js — Website Traffic over-time + insights math
 * =============================================================================
 *
 * Pins the pure logic behind the admin Website Traffic page's traffic-over-time
 * chart, period-over-period KPI deltas and the marketing insight feed
 * (inkcartridges/js/admin/utils/traffic-analytics.js).
 *
 * Why this matters: the page tells a marketer where traffic is heading and
 * where to spend next. If normalisation drops days, a moving average leaks
 * future data, a delta inverts its colour, or an insight fires on the wrong
 * threshold, the advice is actively misleading. These tests lock the contract.
 *
 * Fixtures mirror the LIVE backend shapes probed 2026-05-22 against
 * ink-backend-zaeq.onrender.com (1,390 sessions / 5,051 pageviews / 65.1%
 * bounce, channels Direct 971 / Referral 256 / Organic 163).
 *
 * Run with: node --test tests/website-traffic-analytics.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'traffic-analytics.js'
);

// Strip ESM `export` keywords and re-expose every exported binding on the
// sandbox global so we can drive the pure functions without a bundler.
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(
    /export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; }
  );
  // Drop the trailing `export default { ... }` block (it references the names
  // we've already exposed; the object itself isn't needed for these tests).
  stripped = stripped.replace(/export\s+default\s+\{[\s\S]*?\};?\s*$/m, '');
  const footer = '\n;' + [...exposed]
    .map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`)
    .join('\n');
  return stripped + footer;
}

const sandbox = {
  console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date,
  isNaN, parseInt, parseFloat,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(
  stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')),
  ctx,
  { filename: 'traffic-analytics.js' }
);

// Objects returned from the VM carry the VM realm's Object.prototype, so a raw
// deepStrictEqual against a test-realm literal trips on the prototype mismatch.
// Normalise both sides through JSON to compare by value.
const plain = (o) => JSON.parse(JSON.stringify(o));

// ─── Live-shape fixtures (probed 2026-05-22) ─────────────────────────────────

const LIVE_SUMMARY = {
  sessions: 1390,
  pageviews: 5051,
  unique_visitors: 664,
  avg_session_duration: 444,
  bounce_rate: 65.1,
  campaign_visitors: 0,
  campaign_visitor_percent: 0,
  device_breakdown: [
    { device: 'desktop', count: 1142 },
    { device: 'mobile', count: 172 },
    { device: 'bot', count: 72 },
    { device: 'tablet', count: 4 },
  ],
  channel_breakdown: [
    { channel: 'Direct', count: 971 },
    { channel: 'Referral', count: 256 },
    { channel: 'Organic', count: 163 },
  ],
  top_pages: [
    { path: '/', pageviews: 851, unique_visitors: 205 },
    { path: '/shop', pageviews: 400, unique_visitors: 120 },
  ],
  top_referrers: [
    { referrer_host: 'www.inkcartridges.co.nz', sessions: 162 },
    { referrer_host: 'google.com', sessions: 40 },
  ],
};

const LIVE_TIMESERIES = {
  ok: true,
  data: [
    { date: '2026-04-15', sessions: 88, pageviews: 257 },
    { date: '2026-04-16', sessions: 70, pageviews: 239 },
    { date: '2026-04-17', sessions: 59, pageviews: 100 },
    { date: '2026-04-18', sessions: 35, pageviews: 154 },
    { date: '2026-04-19', sessions: 38, pageviews: 168 },
    { date: '2026-04-20', sessions: 46, pageviews: 171 },
    { date: '2026-04-21', sessions: 40, pageviews: 71 },
    { date: '2026-04-22', sessions: 35, pageviews: 75 },
    { date: '2026-05-22', sessions: 17, pageviews: 27 },
  ],
};

// ─── normalizeSeries ─────────────────────────────────────────────────────────

test('normalizeSeries: unwraps { data: [...] } envelope', () => {
  const out = sandbox.normalizeSeries(LIVE_TIMESERIES);
  assert.equal(out.length, 9);
  assert.deepEqual(plain(out[0]), { date: '2026-04-15', sessions: 88, pageviews: 257 });
});

test('normalizeSeries: accepts a bare array too', () => {
  const out = sandbox.normalizeSeries(LIVE_TIMESERIES.data);
  assert.equal(out.length, 9);
});

test('normalizeSeries: sorts by date ascending', () => {
  const out = sandbox.normalizeSeries([
    { date: '2026-05-02', sessions: 5, pageviews: 9 },
    { date: '2026-05-01', sessions: 3, pageviews: 7 },
  ]);
  assert.equal(out[0].date, '2026-05-01');
  assert.equal(out[1].date, '2026-05-02');
});

test('normalizeSeries: coerces non-numeric counts to 0 and drops dateless rows', () => {
  const out = sandbox.normalizeSeries([
    { date: '2026-05-01', sessions: 'x', pageviews: null },
    { sessions: 5, pageviews: 5 }, // no date → dropped
    null,                          // junk → dropped
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(plain(out[0]), { date: '2026-05-01', sessions: 0, pageviews: 0 });
});

test('normalizeSeries: tolerates page_views snake_case alias', () => {
  const out = sandbox.normalizeSeries([{ date: '2026-05-01', sessions: 4, page_views: 12 }]);
  assert.equal(out[0].pageviews, 12);
});

test('normalizeSeries: null / undefined / garbage → []', () => {
  assert.deepEqual(plain(sandbox.normalizeSeries(null)), []);
  assert.deepEqual(plain(sandbox.normalizeSeries(undefined)), []);
  assert.deepEqual(plain(sandbox.normalizeSeries(42)), []);
  assert.deepEqual(plain(sandbox.normalizeSeries({})), []);
});

// ─── movingAverage ───────────────────────────────────────────────────────────

test('movingAverage: trailing window, nulls until the window fills', () => {
  const out = sandbox.movingAverage([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], 2);  // (1+2+3)/3
  assert.equal(out[3], 3);  // (2+3+4)/3
  assert.equal(out[4], 4);  // (3+4+5)/3
});

test('movingAverage: never leaks future values (causal)', () => {
  // Spike at the end must NOT raise earlier points.
  const out = sandbox.movingAverage([10, 10, 10, 1000], 2);
  assert.equal(out[1], 10);
  assert.equal(out[2], 10);
  assert.equal(out[3], 505); // (10+1000)/2
});

test('movingAverage: window larger than data → all-null array of same length', () => {
  const out = sandbox.movingAverage([5, 6], 7);
  assert.deepEqual(out, [null, null]);
});

test('movingAverage: rounds to 2 dp', () => {
  const out = sandbox.movingAverage([1, 2], 2);
  assert.equal(out[1], 1.5);
});

// ─── seriesTotals ────────────────────────────────────────────────────────────

test('seriesTotals: sums, averages, pages/session and peak day', () => {
  const t = sandbox.seriesTotals(sandbox.normalizeSeries(LIVE_TIMESERIES));
  assert.equal(t.days, 9);
  assert.equal(t.sessions, 88 + 70 + 59 + 35 + 38 + 46 + 40 + 35 + 17); // 428
  assert.equal(t.pageviews, 257 + 239 + 100 + 154 + 168 + 171 + 71 + 75 + 27); // 1262
  assert.ok(Math.abs(t.avgSessionsPerDay - 428 / 9) < 1e-9);
  assert.ok(Math.abs(t.pagesPerSession - 1262 / 428) < 1e-9);
  assert.deepEqual(plain(t.peak), { date: '2026-04-15', sessions: 88 });
});

test('seriesTotals: empty series is all-zero, peak null', () => {
  const t = sandbox.seriesTotals([]);
  assert.equal(t.days, 0);
  assert.equal(t.sessions, 0);
  assert.equal(t.avgSessionsPerDay, 0);
  assert.equal(t.pagesPerSession, 0);
  assert.equal(t.peak, null);
});

// ─── trendDirection ──────────────────────────────────────────────────────────

test('trendDirection: null when fewer than 4 points (too thin to advise)', () => {
  assert.equal(sandbox.trendDirection([{ sessions: 1 }, { sessions: 2 }, { sessions: 3 }]), null);
});

test('trendDirection: detects a falling trend', () => {
  const series = [
    { sessions: 100 }, { sessions: 90 }, { sessions: 80 }, { sessions: 70 },
    { sessions: 20 }, { sessions: 10 },
  ];
  const t = sandbox.trendDirection(series);
  assert.equal(t.dir, 'down');
  assert.ok(t.pct < 0);
});

test('trendDirection: detects a rising trend', () => {
  const series = [
    { sessions: 10 }, { sessions: 20 }, { sessions: 30 },
    { sessions: 80 }, { sessions: 90 }, { sessions: 100 },
  ];
  const t = sandbox.trendDirection(series);
  assert.equal(t.dir, 'up');
  assert.ok(t.pct > 0);
});

test('trendDirection: flat when halves are within ±2%', () => {
  const series = [
    { sessions: 50 }, { sessions: 50 }, { sessions: 50 }, { sessions: 50 },
  ];
  assert.equal(sandbox.trendDirection(series).dir, 'flat');
});

// ─── previousRange ───────────────────────────────────────────────────────────

test('previousRange: the equal-length window immediately before [from,to]', () => {
  // 7-day inclusive window → previous 7 days ending the day before `from`.
  const prev = sandbox.previousRange('2026-05-15', '2026-05-21');
  assert.deepEqual(plain(prev), { from: '2026-05-08', to: '2026-05-14' });
});

test('previousRange: single-day window maps to the prior single day', () => {
  const prev = sandbox.previousRange('2026-05-22', '2026-05-22');
  assert.deepEqual(plain(prev), { from: '2026-05-21', to: '2026-05-21' });
});

test('previousRange: 90-day window length is preserved', () => {
  const prev = sandbox.previousRange('2026-02-21', '2026-05-22'); // 91 days inclusive
  const DAY = 86400000;
  const len = Math.round((Date.parse(prev.to + 'T00:00:00Z') - Date.parse(prev.from + 'T00:00:00Z')) / DAY) + 1;
  assert.equal(len, 91);
  assert.equal(prev.to, '2026-02-20'); // day before `from`
});

test('previousRange: invalid input → null', () => {
  assert.equal(sandbox.previousRange('not-a-date', '2026-05-01'), null);
  assert.equal(sandbox.previousRange('2026-05-10', '2026-05-01'), null); // to < from
});

// ─── pctChange / computeDeltas ───────────────────────────────────────────────

test('pctChange: growth is positive, ▲, coloured up (green)', () => {
  const d = sandbox.pctChange(120, 100);
  assert.equal(Math.round(d.pct), 20);
  assert.equal(d.increased, true);
  assert.equal(d.dir, 'up');
  assert.equal(d.arrow, '▲');
});

test('pctChange: decline is negative, ▼, coloured down (red)', () => {
  const d = sandbox.pctChange(80, 100);
  assert.equal(Math.round(d.pct), -20);
  assert.equal(d.dir, 'down');
  assert.equal(d.arrow, '▼');
});

test('pctChange: inverted metric (bounce) — a RISE is bad (red), arrow still ▲', () => {
  const d = sandbox.pctChange(70, 50, /* invert */ true);
  assert.ok(d.pct > 0);
  assert.equal(d.arrow, '▲');     // the number went up
  assert.equal(d.dir, 'down');    // ...but that's bad → red
});

test('pctChange: inverted metric — a DROP is good (green)', () => {
  const d = sandbox.pctChange(40, 50, true);
  assert.equal(d.arrow, '▼');
  assert.equal(d.dir, 'up');      // lower bounce is good → green
});

test('pctChange: |change| < 0.5% reads flat with → arrow', () => {
  const d = sandbox.pctChange(100.2, 100);
  assert.equal(d.dir, 'flat');
  assert.equal(d.arrow, '→');
});

test('pctChange: zero/absent previous → null (no badge)', () => {
  assert.equal(sandbox.pctChange(100, 0), null);
  assert.equal(sandbox.pctChange(100, null), null);
  assert.equal(sandbox.pctChange(100, undefined), null);
});

test('computeDeltas: maps every KPI and inverts bounce', () => {
  const deltas = sandbox.computeDeltas(
    { sessions: 120, pageviews: 200, unique_visitors: 60, avg_session_duration: 100, bounce_rate: 70 },
    { sessions: 100, pageviews: 100, unique_visitors: 50, avg_session_duration: 80, bounce_rate: 50 },
  );
  assert.equal(deltas.sessions.dir, 'up');
  assert.equal(deltas.bounce_rate.arrow, '▲');
  assert.equal(deltas.bounce_rate.dir, 'down'); // bounce up = bad
});

test('computeDeltas: no previous summary → all null', () => {
  const deltas = sandbox.computeDeltas(LIVE_SUMMARY, null);
  assert.equal(deltas.sessions, null);
  assert.equal(deltas.bounce_rate, null);
});

// ─── channelMix ──────────────────────────────────────────────────────────────

test('channelMix: shares sum to 100 and top channel is identified', () => {
  const mix = sandbox.channelMix(LIVE_SUMMARY.channel_breakdown);
  assert.equal(mix.total, 1390);
  assert.equal(mix.top.channel, 'Direct');
  assert.ok(Math.abs(mix.byName.organic.share - (163 / 1390) * 100) < 1e-9);
  const sum = Object.values(mix.byName).reduce((t, c) => t + c.share, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9);
});

test('channelMix: empty input is safe', () => {
  const mix = sandbox.channelMix([]);
  assert.equal(mix.total, 0);
  assert.equal(mix.top, null);
});

// ─── generateInsights ────────────────────────────────────────────────────────

test('generateInsights: live data flags low organic, zero campaigns, direct-heavy, thin mobile, high bounce', () => {
  const series = sandbox.normalizeSeries(LIVE_TIMESERIES);
  const ids = sandbox.generateInsights({ summary: LIVE_SUMMARY, series }).map(i => i.id);
  assert.ok(ids.includes('organic-low'), 'organic 11.7% < 20% → opportunity');
  assert.ok(ids.includes('no-campaigns'), 'campaign_visitors 0 → opportunity');
  assert.ok(ids.includes('direct-heavy'), 'direct 69.9% > 60% → watch');
  assert.ok(ids.includes('mobile-thin'), 'mobile 12.4% < 30% → watch');
  assert.ok(ids.includes('bounce-high'), 'bounce 65.1% > 60% → watch');
  assert.ok(ids.includes('top-channel'), 'top channel callout always present');
  assert.ok(ids.includes('self-referral'), 'own domain in referrers → info');
});

test('generateInsights: opportunities are sorted ahead of watch, win and info', () => {
  const series = sandbox.normalizeSeries(LIVE_TIMESERIES);
  const list = sandbox.generateInsights({ summary: LIVE_SUMMARY, series });
  const order = { opportunity: 0, watch: 1, win: 2, info: 3 };
  for (let i = 1; i < list.length; i++) {
    assert.ok(order[list[i].severity] >= order[list[i - 1].severity],
      `insight ${i} (${list[i].severity}) out of priority order`);
  }
});

test('generateInsights: every insight has id, severity, title, detail', () => {
  const list = sandbox.generateInsights({ summary: LIVE_SUMMARY, series: [] });
  for (const ins of list) {
    assert.ok(ins.id && ins.title && ins.detail, 'missing field');
    assert.ok(['opportunity', 'watch', 'win', 'info'].includes(ins.severity));
    assert.equal(ins._i, undefined, 'internal sort key must be stripped');
  }
});

test('generateInsights: thin window short-circuits to a single info card', () => {
  const list = sandbox.generateInsights({ summary: { sessions: 5 }, series: [] });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'thin-data');
});

test('generateInsights: healthy site surfaces wins, not false alarms', () => {
  const healthy = {
    sessions: 5000,
    pageviews: 20000,
    bounce_rate: 35, // < 40 → win
    campaign_visitors: 800,
    channel_breakdown: [
      { channel: 'Organic', count: 2500 },
      { channel: 'Direct', count: 1500 },
      { channel: 'Referral', count: 1000 },
    ],
    device_breakdown: [
      { device: 'mobile', count: 3000 },
      { device: 'desktop', count: 2000 },
    ],
    top_pages: [{ path: '/shop', pageviews: 4000 }],
    top_referrers: [{ referrer_host: 'google.com', sessions: 500 }],
  };
  const ids = sandbox.generateInsights({ summary: healthy, series: [] }).map(i => i.id);
  assert.ok(ids.includes('bounce-great'), 'low bounce → win');
  assert.ok(!ids.includes('organic-low'), 'organic 50% must not flag');
  assert.ok(!ids.includes('direct-heavy'), 'direct 30% must not flag');
  assert.ok(!ids.includes('no-campaigns'), 'campaigns present must not flag');
  assert.ok(!ids.includes('mobile-thin'), 'mobile 60% must not flag');
  assert.ok(!ids.includes('self-referral'), 'no own-domain referrer must not flag');
});

test('generateInsights: never throws on empty/partial summary', () => {
  assert.doesNotThrow(() => sandbox.generateInsights({}));
  assert.doesNotThrow(() => sandbox.generateInsights({ summary: {} }));
  assert.doesNotThrow(() => sandbox.generateInsights({ summary: { sessions: 100 }, series: null }));
});

// ─── INSIGHT_THRESHOLDS (pin the marketing judgement calls) ──────────────────

test('INSIGHT_THRESHOLDS: documented values are pinned', () => {
  const T = sandbox.INSIGHT_THRESHOLDS;
  assert.equal(T.organicLowShare, 20);
  assert.equal(T.directHighShare, 60);
  assert.equal(T.mobileLowShare, 30);
  assert.equal(T.bounceHigh, 60);
  assert.equal(T.bounceGreat, 40);
  assert.equal(T.minSessionsForStats, 30);
});

// ─── bucketSeries (chart granularity: 1 day / 1 week / 1 month bars) ─────────
//
// The chart card lets the user pick 1 day / 1 week / 1 month per bar. The
// backend timeseries is daily-only, so we re-bucket client-side. These tests
// pin the bucketing rules — get the boundary wrong (e.g. a Sunday-start week)
// and every weekly bar misaligns by a day for the rest of time.

test('bucketSeries: exposed GRANULARITIES are exactly day/week/month', () => {
  assert.deepEqual(plain(sandbox.GRANULARITIES), ['day', 'week', 'month']);
});

test("bucketSeries('day'): passthrough — one bucket per source row, days=1", () => {
  const series = sandbox.normalizeSeries(LIVE_TIMESERIES);
  const out = sandbox.bucketSeries(series, 'day');
  assert.equal(out.length, series.length);
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].key, series[i].date);
    assert.equal(out[i].start, series[i].date);
    assert.equal(out[i].end, series[i].date);
    assert.equal(out[i].days, 1);
    assert.equal(out[i].sessions, series[i].sessions);
    assert.equal(out[i].pageviews, series[i].pageviews);
  }
});

test("bucketSeries('day'): unknown granularity falls back to day", () => {
  const out = sandbox.bucketSeries(
    [{ date: '2026-05-01', sessions: 4, pageviews: 9 }],
    'lol'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].days, 1);
});

test("bucketSeries('day'): default granularity is day", () => {
  const out = sandbox.bucketSeries([{ date: '2026-05-01', sessions: 1, pageviews: 1 }]);
  assert.equal(out[0].start, '2026-05-01');
  assert.equal(out[0].days, 1);
});

test("bucketSeries('week'): groups by Monday-start ISO week", () => {
  // 2026-05-18 is a Monday. 2026-05-23 is a Saturday — same ISO week.
  // 2026-05-24 is a Sunday — STILL the same ISO week (Mon→Sun).
  // 2026-05-25 is the next Monday — a new bucket.
  const out = sandbox.bucketSeries([
    { date: '2026-05-18', sessions: 10, pageviews: 30 }, // Mon
    { date: '2026-05-23', sessions: 5,  pageviews: 12 }, // Sat
    { date: '2026-05-24', sessions: 2,  pageviews: 4  }, // Sun (still wk1)
    { date: '2026-05-25', sessions: 7,  pageviews: 18 }, // Mon (wk2)
  ], 'week');
  assert.equal(out.length, 2);
  assert.equal(out[0].key, '2026-05-18');
  assert.equal(out[0].start, '2026-05-18');
  assert.equal(out[0].end, '2026-05-24');
  assert.equal(out[0].sessions, 17);
  assert.equal(out[0].pageviews, 46);
  assert.equal(out[0].days, 3);
  assert.equal(out[1].key, '2026-05-25');
  assert.equal(out[1].start, '2026-05-25');
  assert.equal(out[1].end, '2026-05-31');
  assert.equal(out[1].days, 1);
});

test("bucketSeries('week'): a Sunday at the start rolls back to the prior Monday", () => {
  // 2026-05-17 is a Sunday; its ISO week starts Mon 2026-05-11.
  const out = sandbox.bucketSeries([
    { date: '2026-05-17', sessions: 3, pageviews: 8 },
  ], 'week');
  assert.equal(out[0].start, '2026-05-11');
  assert.equal(out[0].end, '2026-05-17');
});

test("bucketSeries('week'): crosses year boundary correctly", () => {
  // ISO week containing 2026-01-01 (a Thursday) starts Mon 2025-12-29.
  const out = sandbox.bucketSeries([
    { date: '2025-12-29', sessions: 1, pageviews: 1 }, // Mon
    { date: '2026-01-01', sessions: 2, pageviews: 5 }, // Thu — same week
    { date: '2026-01-04', sessions: 3, pageviews: 7 }, // Sun — still same week
    { date: '2026-01-05', sessions: 4, pageviews: 9 }, // Mon — new week
  ], 'week');
  assert.equal(out.length, 2);
  assert.equal(out[0].start, '2025-12-29');
  assert.equal(out[0].end, '2026-01-04');
  assert.equal(out[0].sessions, 6);
  assert.equal(out[0].pageviews, 13);
  assert.equal(out[0].days, 3);
  assert.equal(out[1].start, '2026-01-05');
});

test("bucketSeries('month'): groups by calendar month, end = last day", () => {
  const out = sandbox.bucketSeries([
    { date: '2026-04-15', sessions: 88, pageviews: 257 },
    { date: '2026-04-30', sessions: 12, pageviews: 40  },
    { date: '2026-05-01', sessions: 20, pageviews: 60  },
    { date: '2026-05-22', sessions: 17, pageviews: 27  },
  ], 'month');
  assert.equal(out.length, 2);
  assert.equal(out[0].key, '2026-04');
  assert.equal(out[0].start, '2026-04-01');
  assert.equal(out[0].end, '2026-04-30'); // April has 30 days
  assert.equal(out[0].sessions, 100);
  assert.equal(out[0].pageviews, 297);
  assert.equal(out[0].days, 2);
  assert.equal(out[1].key, '2026-05');
  assert.equal(out[1].start, '2026-05-01');
  assert.equal(out[1].end, '2026-05-31'); // May has 31 days
  assert.equal(out[1].days, 2);
});

test("bucketSeries('month'): February in a leap year ends on the 29th", () => {
  // 2024 is a leap year — February has 29 days.
  const out = sandbox.bucketSeries([
    { date: '2024-02-01', sessions: 1, pageviews: 1 },
    { date: '2024-02-29', sessions: 1, pageviews: 1 },
  ], 'month');
  assert.equal(out[0].end, '2024-02-29');
});

test("bucketSeries('month'): non-leap February ends on the 28th", () => {
  const out = sandbox.bucketSeries([
    { date: '2026-02-15', sessions: 1, pageviews: 1 },
  ], 'month');
  assert.equal(out[0].end, '2026-02-28');
});

test('bucketSeries: weekly + monthly preserve grand totals from the daily series', () => {
  const series = sandbox.normalizeSeries(LIVE_TIMESERIES);
  const daySum = (out, k) => out.reduce((t, b) => t + (b[k] || 0), 0);
  const total = (k) => series.reduce((t, b) => t + (b[k] || 0), 0);
  for (const g of ['day', 'week', 'month']) {
    const out = sandbox.bucketSeries(series, g);
    assert.equal(daySum(out, 'sessions'), total('sessions'), `${g} sessions total`);
    assert.equal(daySum(out, 'pageviews'), total('pageviews'), `${g} pageviews total`);
  }
});

test('bucketSeries: empty / junk input is safe', () => {
  assert.deepEqual(plain(sandbox.bucketSeries([], 'week')), []);
  assert.deepEqual(plain(sandbox.bucketSeries(null, 'month')), []);
  assert.deepEqual(plain(sandbox.bucketSeries(undefined, 'day')), []);
  // Row with no date → skipped, not crashing
  const out = sandbox.bucketSeries(
    [{ sessions: 5, pageviews: 5 }, { date: '2026-05-01', sessions: 1, pageviews: 1 }],
    'week'
  );
  assert.equal(out.length, 1);
});

test('bucketSeries: output is sorted ascending by key', () => {
  const out = sandbox.bucketSeries([
    { date: '2026-05-22', sessions: 1, pageviews: 1 },
    { date: '2026-04-15', sessions: 1, pageviews: 1 },
  ], 'month');
  assert.equal(out[0].key, '2026-04');
  assert.equal(out[1].key, '2026-05');
});
