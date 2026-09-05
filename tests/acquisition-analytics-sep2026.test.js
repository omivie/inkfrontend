/**
 * Acquisition analytics — ERR-204, job 3
 * ======================================
 *
 * Search Console was connected on 2026-09-03, so the four
 * /api/admin/analytics/acquisition/* endpoints returned real SEO numbers for
 * the first time. The hand-off gave two rules for reading them. One is right
 * for the wrong reason and one is simply false, and both were measured against
 * production before any UI existed.
 *
 * ── TRAP 1 — "null = not connected, 0 = connected and genuinely zero" ───────
 *
 * True on /landing-pages: `ads_clicks`, `ads_impressions`, `ads_cost` and
 * `ads_conversions` are null on all 174 rows, and Google Ads is not connected.
 *
 * FALSE on /search-terms. With `meta.sources.google_ads.connected === false` —
 * the same unconnected integration —
 *
 *      500 of 500 rows report  paid_clicks: 0,  paid_cost: 0
 *      0   of 500 rows report  null
 *
 * A UI that followed the stated rule would tell the owner they spent $0.00
 * across 500 queries: a claim about money, from an integration that has never
 * existed. So the rule this code follows instead is:
 *
 *      CONNECTEDNESS COMES FROM meta.sources. NEVER FROM A CELL.
 *
 * ── TRAP 2 — summing SEO down /landing-pages inflates it 6.41× ──────────────
 *
 * First-party rows are per channel; Google's figures are per URL and repeat
 * identically on every channel row for that path. Measured over all 174 rows:
 *
 *      naive column sum ..... 84,935      collapsed by path ..... 13,259
 *      "/" alone: 4,088 impressions on each of its 8 channel rows → 32,704
 *
 * 16 of 138 paths are multi-channel and in all 16 the repeat is byte-identical.
 * The fix collapses by path and gives the channel sub-rows NO SEO columns at
 * all, so the wrong total is not merely discouraged, it is unconstructible.
 *
 *   1. readSourceStatus — meta.sources and nothing else
 *   2. THE TRAP: a zero from an unconnected source
 *   3. collapseByPath — the 6.41× fix
 *   4. totals that refuse to launder a null into a zero
 *   5. summary / timeseries readers
 *   6. the page + api + hub wiring
 *   7. POSITIVE / NEGATIVE controls
 *
 * Run with: node --test tests/acquisition-analytics-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const mod = import(pathToFileURL(path.join(ADMIN, 'utils', 'acquisition.js')).href);

const PAGE = R('inkcartridges', 'js', 'admin', 'pages', 'acquisition.js');
const HUB = R('inkcartridges', 'js', 'admin', 'pages', 'analytics.js');
// Sep 2026: the hub's tabs moved into a manifest shared with the admin sidebar, so the
// label and the module path now travel together in one object instead of in a TABS array
// and a parallel moduleMap. See tests/admin-analytics-section-sep2026.test.js §5.
const HUB_TABS = R('inkcartridges', 'js', 'admin', 'utils', 'analytics-tabs.js');
const API = R('inkcartridges', 'js', 'admin', 'api.js');
const CSS = R('inkcartridges', 'css', 'admin.css');

/** meta.sources exactly as production returns it, 2026-09-03. */
const LIVE_META = {
  sources: {
    first_party: { configured: true, connected: true, rows: null },
    search_console: { configured: true, connected: true, rows: 16125 },
    google_ads: {
      configured: false, connected: false, rows: 0,
      message: 'Set GOOGLE_ADS_* credentials, then POST /api/admin/analytics/acquisition/sync',
    },
  },
};

/** The real "/" rows — one per channel, each repeating the same SEO block. */
const SLASH_ROWS = [
  ['Direct', 352, 277], ['Paid', 104, 80], ['Organic', 39, 30], ['Shopping (Free)', 14, 10],
  ['Referral', 7, 5], ['Email', 6, 4], ['Social', 2, 1], ['AI Assistant', 1, 1],
].map(([channel, entry_sessions, bounced_sessions]) => ({
  landing_path: '/', channel, entry_sessions, bounced_sessions,
  unique_visitors: Math.round(entry_sessions * 0.7), pageviews: entry_sessions + 11,
  seo_clicks: 4, seo_impressions: 4088, seo_avg_position: 23.04,
  ads_clicks: null, ads_impressions: null, ads_cost: null, ads_conversions: null,
}));

/** A real search-terms row: paid_* are ZERO while Google Ads is unconnected. */
const LIVE_TERM = {
  term: '2700e hp printer ink', organic_clicks: 1, organic_impressions: 1,
  organic_ctr: 100, organic_position: 5,
  paid_clicks: 0, paid_impressions: 0, paid_cost: 0, paid_conversions: 0, total_clicks: 1,
};

// ── 1. readSourceStatus ─────────────────────────────────────────────────────

test('§1 connectedness is read from meta.sources', async (t) => {
  const { readSourceStatus, SOURCE_STATE } = await mod;

  await t.test('the three live sources classify correctly', () => {
    assert.equal(readSourceStatus(LIVE_META, 'search_console'), SOURCE_STATE.CONNECTED);
    assert.equal(readSourceStatus(LIVE_META, 'google_ads'), SOURCE_STATE.NOT_CONNECTED);
    assert.equal(readSourceStatus(LIVE_META, 'first_party'), SOURCE_STATE.CONNECTED);
  });

  await t.test('`rows` is NOT consulted — it disagrees in both directions', () => {
    // first_party: rows null, connected true. google_ads: rows 0, connected false.
    // A reader that fell back to `rows` would get both of them wrong.
    assert.equal(readSourceStatus(LIVE_META, 'first_party'), SOURCE_STATE.CONNECTED,
      'rows: null must not read as "not connected"');
    assert.equal(
      readSourceStatus({ sources: { x: { connected: true, rows: 0 } } }, 'x'),
      SOURCE_STATE.CONNECTED, 'rows: 0 must not read as "not connected" either');
  });

  await t.test('an unmentioned source is UNKNOWN, never assumed off', () => {
    assert.equal(readSourceStatus({}, 'google_ads'), SOURCE_STATE.UNKNOWN);
    assert.equal(readSourceStatus({ sources: {} }, 'google_ads'), SOURCE_STATE.UNKNOWN);
    assert.equal(readSourceStatus({ sources: { google_ads: {} } }, 'google_ads'), SOURCE_STATE.UNKNOWN,
      'a source object with no `connected` key has not answered the question');
    assert.equal(readSourceStatus(null, 'google_ads'), SOURCE_STATE.UNKNOWN);
  });
});

test('§1b the source cards carry the backend\'s own remediation text', async () => {
  const { readAllSources } = await mod;
  const cards = readAllSources(LIVE_META);
  assert.equal(cards.length, 3);
  const ads = cards.find((c) => c.key === 'google_ads');
  assert.equal(ads.state, 'not-connected');
  assert.match(ads.message, /GOOGLE_ADS_\* credentials/,
    'the message names the exact env vars — paraphrasing it would waste the operator\'s time');
  assert.equal(cards.find((c) => c.key === 'search_console').rows, 16125);
  assert.deepEqual(cards.map((c) => c.key), ['first_party', 'search_console', 'google_ads'],
    'stable order, so the strip does not reshuffle between loads');
});

// ── 2. THE TRAP ─────────────────────────────────────────────────────────────

test('§2 THE TRAP — a 0 from an unconnected source is not a zero', async (t) => {
  const { readSourceStatus, classifyMetric, renderMetric, METRIC_STATE, MISSING } = await mod;
  const adsStatus = readSourceStatus(LIVE_META, 'google_ads');
  const seoStatus = readSourceStatus(LIVE_META, 'search_console');

  await t.test('paid_clicks: 0 renders an em-dash, not "0"', () => {
    const m = renderMetric(LIVE_TERM.paid_clicks, adsStatus, String);
    assert.equal(m.text, MISSING);
    assert.equal(m.state, METRIC_STATE.NOT_CONNECTED);
  });

  await t.test('paid_cost: 0 never renders as $0.00 — this is the money claim', () => {
    const money = (n) => `$${n.toFixed(2)}`;
    const m = renderMetric(LIVE_TERM.paid_cost, adsStatus, money);
    assert.equal(m.text, MISSING);
    assert.notEqual(m.text, '$0.00',
      '500 live rows would otherwise assert a spend figure for an integration that does not exist');
  });

  await t.test('the tooltip says the 0 is not a measurement', () => {
    const m = renderMetric(0, adsStatus, String);
    assert.match(m.tooltip, /not connected/i);
    assert.match(m.tooltip, /that 0 is not a measurement/i);
  });

  await t.test('POSITIVE CONTROL — a CONNECTED zero still prints 0', () => {
    // Without this, "render an em-dash" could be satisfied by blanking every
    // zero on the page, which is the opposite mistake.
    const m = renderMetric(0, seoStatus, String);
    assert.equal(m.text, '0');
    assert.equal(m.state, METRIC_STATE.VALUE);
    assert.equal(m.missing, false);
  });

  await t.test('POSITIVE CONTROL — a connected non-zero prints its value', () => {
    assert.equal(renderMetric(4088, seoStatus, (n) => String(n)).text, '4088');
  });

  await t.test('connected but no row for this URL is NO_DATA, a third state', () => {
    // 103 of 174 landing-page rows have seo_impressions null while Search
    // Console IS connected. That is not "not connected" and not a zero.
    const m = renderMetric(null, seoStatus, String);
    assert.equal(m.state, METRIC_STATE.NO_DATA);
    assert.match(m.tooltip, /connected but reported nothing/i);
  });

  await t.test('the source is consulted BEFORE the value — order is the fix', () => {
    // Every value shape must land on NOT_CONNECTED when the source is dead.
    for (const v of [0, null, undefined, 4088, NaN, '12']) {
      assert.equal(classifyMetric(v, adsStatus).state, METRIC_STATE.NOT_CONNECTED,
        `value ${String(v)} must not be able to override the source verdict`);
    }
  });

  await t.test('an UNKNOWN source also refuses to print a figure', () => {
    assert.equal(classifyMetric(0, 'unknown').state, METRIC_STATE.UNKNOWN);
    assert.equal(renderMetric(0, 'unknown', String).text, MISSING);
  });

  await t.test('the four metric states produce four different tooltips', async () => {
    const { metricTooltip } = await mod;
    const t4 = ['not-connected', 'no-data', 'unknown'].map(metricTooltip);
    assert.equal(new Set(t4).size, 3);
    assert.equal(metricTooltip('value'), '', 'a real value needs no excuse');
  });
});

test('§2b a dead column gets a header note, not just dead cells', async () => {
  const { columnNote, readSourceStatus } = await mod;
  const note = columnNote(readSourceStatus(LIVE_META, 'google_ads'), 'Google Ads');
  assert.match(note, /not connected/i);
  assert.match(note, /including the zeros the API sends/i,
    'the note must name the exact trap, because the API keeps sending those zeros');
  assert.equal(columnNote(readSourceStatus(LIVE_META, 'search_console'), 'Search Console'), null,
    'a healthy column gets no note');
});

// ── 3. collapseByPath ───────────────────────────────────────────────────────

test('§3 collapseByPath removes the 6.41× double-count', async (t) => {
  const { collapseByPath, seoInflationCheck, SEO_FIELDS } = await mod;

  await t.test('eight channel rows for "/" become one', () => {
    const out = collapseByPath(SLASH_ROWS);
    assert.equal(out.length, 1);
    assert.equal(out[0].landing_path, '/');
    assert.equal(out[0].channel_count, 8);
  });

  await t.test('THE TRAP: SEO is taken ONCE — 4,088, not 32,704', () => {
    const out = collapseByPath(SLASH_ROWS);
    assert.equal(out[0].seo_impressions, 4088);
    assert.equal(out[0].seo_clicks, 4);
    assert.equal(out[0].seo_avg_position, 23.04);
  });

  await t.test('first-party columns DO sum — they are genuinely per channel', () => {
    const out = collapseByPath(SLASH_ROWS);
    assert.equal(out[0].entry_sessions, 352 + 104 + 39 + 14 + 7 + 6 + 2 + 1);
  });

  await t.test('bounce rate is RECOMPUTED, never averaged', () => {
    // Averaging rates across unequal denominators is its own bug: "/" would
    // report the mean of eight percentages rather than 408/525.
    const out = collapseByPath(SLASH_ROWS);
    const bounced = SLASH_ROWS.reduce((s, r) => s + r.bounced_sessions, 0);
    const sessions = SLASH_ROWS.reduce((s, r) => s + r.entry_sessions, 0);
    assert.equal(out[0].bounce_rate, Math.round((bounced / sessions) * 1000) / 10);
    const naiveMean = SLASH_ROWS.reduce((s, r) => s + (r.bounced_sessions / r.entry_sessions) * 100, 0) / 8;
    assert.notEqual(out[0].bounce_rate, Math.round(naiveMean * 10) / 10);
  });

  await t.test('sub-rows carry NO SEO columns — the wrong total is unconstructible', () => {
    const out = collapseByPath(SLASH_ROWS);
    for (const c of out[0].channels) {
      for (const f of SEO_FIELDS) {
        assert.ok(!(f in c), `channel sub-row must not carry ${f} — not even blanked`);
      }
    }
    assert.equal(out[0].channels.length, 8);
    assert.equal(out[0].channels[0].channel, 'Direct', 'sub-rows sort by sessions, desc');
  });

  await t.test('the inflation is measured, and it is 8× for "/"', () => {
    const c = seoInflationCheck(SLASH_ROWS);
    assert.equal(c.naive, 32704);
    assert.equal(c.collapsed, 4088);
    assert.equal(c.inflation, 8);
    assert.equal(c.inflated, true);
  });

  await t.test('POSITIVE CONTROL — genuinely distinct paths still add up', () => {
    // Collapsing must de-duplicate, not swallow. A second path contributes.
    const rows = SLASH_ROWS.concat([
      { landing_path: '/shop', channel: 'Direct', entry_sessions: 118, bounced_sessions: 50, seo_impressions: 2914, seo_clicks: 11 },
    ]);
    const c = seoInflationCheck(rows);
    assert.equal(c.collapsed, 4088 + 2914);
    assert.equal(collapseByPath(rows).length, 2);
  });

  await t.test('POSITIVE CONTROL — a single-channel path is untouched', () => {
    const one = collapseByPath([{ landing_path: '/x', channel: 'Direct', entry_sessions: 5, seo_impressions: 7 }]);
    assert.equal(one[0].entry_sessions, 5);
    assert.equal(one[0].seo_impressions, 7);
    assert.equal(one[0].channel_count, 1);
  });

  await t.test('NEGATIVE CONTROL — disagreeing repeats are FLAGGED, not silently kept', () => {
    // Today all 16 multi-channel paths repeat identically, which is what makes
    // "take the first" safe. The day that stops being true, collapsing would
    // start LOSING data, so it must announce itself instead.
    const out = collapseByPath([
      { landing_path: '/x', channel: 'Direct', seo_impressions: 10 },
      { landing_path: '/x', channel: 'Paid', seo_impressions: 99 },
    ]);
    assert.equal(out[0].seoDiverged, true);
    assert.equal(collapseByPath(SLASH_ROWS)[0].seoDiverged, false, 'and stays false for real data');
  });

  await t.test('rows sort by sessions, so the biggest entry pages lead', () => {
    const out = collapseByPath([
      { landing_path: '/small', channel: 'Direct', entry_sessions: 3 },
      { landing_path: '/big', channel: 'Direct', entry_sessions: 300 },
    ]);
    assert.deepEqual(out.map((r) => r.landing_path), ['/big', '/small']);
  });
});

// ── 4. totals ───────────────────────────────────────────────────────────────

test('§4 totals skip nulls instead of laundering them into zeros', async (t) => {
  const { totalsFor } = await mod;

  await t.test('a null row is excluded and REPORTED, not counted as 0', () => {
    const t1 = totalsFor([{ a: 5 }, { a: null }, { a: 3 }], ['a']).a;
    assert.equal(t1.sum, 8);
    assert.equal(t1.known, 2);
    assert.equal(t1.missing, 1);
    assert.equal(t1.complete, false, 'a partial total must announce itself — it is a floor');
  });

  await t.test('a complete column says so', () => {
    const t2 = totalsFor([{ a: 5 }, { a: 3 }], ['a']).a;
    assert.equal(t2.complete, true);
    assert.equal(t2.missing, 0);
  });

  await t.test('NEGATIVE CONTROL — all-null totals to null, never 0', () => {
    const t3 = totalsFor([{ a: null }, { a: null }], ['a']).a;
    assert.equal(t3.sum, null, '`|| 0` here would report a measured zero for an unmeasured column');
  });

  await t.test('the real "/" table totals to the collapsed figure', async () => {
    const { collapseByPath } = await mod;
    const totals = totalsFor(collapseByPath(SLASH_ROWS), ['seo_impressions']);
    assert.equal(totals.seo_impressions.sum, 4088);
  });
});

// ── 5. summary + timeseries ─────────────────────────────────────────────────

test('§5 readSummary keeps internal sessions visible and reconciles', async (t) => {
  const { readSummary } = await mod;
  const LIVE_SUMMARY = {
    range: { from: '2026-08-04', to: '2026-09-03' },
    total_sessions: 1405,
    channels: [
      { channel: 'Direct', sessions: 647, pageviews: 1080, share_pct: 46 },
      { channel: 'Paid', sessions: 458, pageviews: 1723, share_pct: 32.6 },
      { channel: 'Organic', sessions: 149, pageviews: 239, share_pct: 10.6 },
      { channel: 'Shopping (Free)', sessions: 123, pageviews: 301, share_pct: 8.8 },
      { channel: 'Referral', sessions: 14, pageviews: 18, share_pct: 1 },
      { channel: 'Email', sessions: 7, pageviews: 23, share_pct: 0.5 },
      { channel: 'AI Assistant', sessions: 5, pageviews: 26, share_pct: 0.4 },
      { channel: 'Social', sessions: 2, pageviews: 2, share_pct: 0.1 },
    ],
    internal_sessions: 124,
  };

  await t.test('the live payload reconciles', () => {
    const s = readSummary(LIVE_SUMMARY);
    assert.equal(s.totalSessions, 1405);
    assert.equal(s.channelSum, 1405);
    assert.equal(s.reconciles, true);
  });

  await t.test('internal_sessions is surfaced, not folded in or dropped', () => {
    const s = readSummary(LIVE_SUMMARY);
    assert.equal(s.internalSessions, 124);
    assert.notEqual(s.totalSessions, 1405 + 124, 'the exclusion must not be added back');
    assert.match(PAGE, /internal session/i);
    assert.match(PAGE, /excluded from every figure/i, 'an unlabelled exclusion is ERR-063');
  });

  await t.test('NEGATIVE CONTROL — a breakdown that does not explain the headline says so', () => {
    const s = readSummary({ total_sessions: 999, channels: [{ channel: 'Direct', sessions: 10 }] });
    assert.equal(s.reconciles, false);
    assert.match(PAGE, /does not fully explain the headline/);
  });

  await t.test('absent internal_sessions is null, not 0', () => {
    assert.equal(readSummary({ total_sessions: 5, channels: [] }).internalSessions, null);
  });
});

test('§5b readTimeseries understands the real envelope', async () => {
  const { readTimeseries } = await mod;
  const live = {
    buckets: ['2026-08-04'], channels: ['AI Assistant'],
    series: [{ channel: 'AI Assistant', points: [{ bucket_start: '2026-08-04T00:00:00+00:00', sessions: 0, pageviews: 0 }] }],
  };
  const ts = readTimeseries(live);
  assert.equal(ts.series.length, 1);
  assert.equal(ts.series[0].channel, 'AI Assistant');
  assert.equal(ts.series[0].points.length, 1);
  assert.deepEqual(readTimeseries(null), { series: [], buckets: [], channels: [] });
  assert.deepEqual(readTimeseries({ series: [{ points: [] }] }).series, [],
    'a series with no channel name cannot be plotted or labelled');
});

// ── 6. wiring ───────────────────────────────────────────────────────────────

test('§6 api.js exposes all four endpoints through the LOUD helper', () => {
  for (const m of ['getAcquisitionSummary', 'getAcquisitionLandingPages',
    'getAcquisitionSearchTerms', 'getAcquisitionTimeseries']) {
    assert.match(API, new RegExp(`async ${m}\\(`), `${m} must exist`);
  }
  const block = API.slice(API.indexOf('async getAcquisitionSummary('), API.indexOf('  // Traffic time-series'));
  assert.match(block, /analyticsHttpGetShared/);
  assert.doesNotMatch(block, /analyticsHttpGet\(/,
    'the fail-soft-to-null helper would render a 429 as "no traffic"');
});

test('§6b the hub registers the Acquisition tab and can load it', () => {
  assert.match(HUB_TABS, /\{ id: 'acquisition',\s+label: 'Acquisition',\s+lazy: '\.\/acquisition\.js' \}/,
    "the Acquisition tab must carry its own module path. It used to be listed in a TABS " +
    'array with `lazy: true` and named again in a separate moduleMap; a tab that appeared ' +
    'in the first and was forgotten in the second rendered a permanent spinner. One object ' +
    'now holds both, so that particular hole is closed by construction.');
  assert.match(HUB, /const TABS = ANALYTICS_TABS;/,
    'the hub must render the shared manifest, not a private copy of it');
  assert.ok(HUB_TABS.indexOf("id: 'acquisition'") > HUB_TABS.indexOf("id: 'traffic'"),
    'it belongs beside Traffic, the other first-party traffic surface');
});

test('§6c the page follows the house lifecycle contract', () => {
  assert.match(PAGE, /export default/);
  assert.match(PAGE, /async init\s*\(/);
  assert.match(PAGE, /destroy\s*\(\)/);
  assert.match(PAGE, /_renderSeq/);
  assert.match(PAGE, /mySeq !== _renderSeq/);
  assert.match(PAGE, /_renderSeq\+\+/);
  assert.match(PAGE, /removeEventListener/);
  assert.match(PAGE, /Charts\.destroy\?\.\(CHART_ID\)/, 'the chart instance must be released');
  assert.doesNotMatch(codeOf(PAGE), /FilterState/,
    'a lazy hub tab must not fight the hub for the global filter bar');
});

test('§6d the rate limit is named, with a countdown', () => {
  assert.match(PAGE, /rate-limited/i);
  assert.match(PAGE, /acq-countdown/);
  assert.match(PAGE, /not.{0,40}a report of zero traffic/,
    'the failure copy must distinguish an outage from a measurement (ERR-188)');
  assert.match(PAGE, /res\.retryAfter/, 'the countdown must use the server\'s own retry-after');
});

test('§6e the four requests are sequential, not a burst', () => {
  // 20 requests / 60s, shared across the whole analytics family. A
  // Promise.all of four is a quarter of the budget in one instant, and a
  // partial rate-limit would blank the page rather than degrade it.
  const code = codeOf(PAGE);
  assert.doesNotMatch(code, /Promise\.all|Promise\.allSettled/);
  assert.match(code, /await AdminAPI\.getAcquisitionSummary[\s\S]*await AdminAPI\.getAcquisitionTimeseries/);
});

test('§6f imports are house-legal and escaping is used', () => {
  assert.match(PAGE, /import \{ AdminAPI, esc \} from '\.\.\/app\.js'/);
  assert.match(PAGE, /import \{ Charts \} from '\.\.\/components\/charts\.js'/,
    'Charts is a NAMED export — a default import would be undefined at runtime');
  assert.doesNotMatch(PAGE, /^import[^\n]*\?v=/m);
  assert.doesNotMatch(PAGE, /typeof AdminAPI/);
  // Backend text on our page: landing paths and search terms are visitor-supplied.
  assert.match(PAGE, /esc\(String\(r\.term \|\| MISSING\)\)/);
  assert.match(PAGE, /esc\(r\.landing_path\)/);
});

test('§6g the CSS exists, in theme tokens', () => {
  for (const cls of [
    '.acq-controls', '.acq-sources', '.acq-source--on', '.acq-source--off',
    '.acq-source--unknown', '.acq-note--warn', '.acq-caret', '.acq-row--sub',
    '.acq-sub-na', '.acq-flag', '.acq-partial', '.acq-missing', '.acq-table tfoot td',
  ]) {
    assert.ok(CSS.includes(cls), `admin.css is missing ${cls}`);
  }
});

test('§6h the double-count is explained ON the page, with the numbers', () => {
  // The operator is being shown a table that deliberately does not look like
  // the API's own rows. If we do not say why, the next person "fixes" it.
  assert.match(PAGE, /per URL, not per channel/);
  assert.match(PAGE, /check\.naive/);
  assert.match(PAGE, /check\.collapsed/);
  assert.match(PAGE, /Search Console figures are per URL/,
    'the sub-row must explain its own blank SEO span rather than leaving it empty');
});

// ── 7. controls ─────────────────────────────────────────────────────────────

test('§7 NEGATIVE CONTROL — the readers reject junk without inventing answers', async () => {
  const { collapseByPath, seoInflationCheck, readSummary, readAllSources, totalsFor } = await mod;
  assert.deepEqual(collapseByPath(null), []);
  assert.deepEqual(collapseByPath([null, undefined, 3]), []);
  assert.equal(seoInflationCheck([]).inflation, null, 'no rows means no ratio, not a divide-by-zero');
  assert.equal(readSummary(null), null);
  assert.deepEqual(readAllSources(null), []);
  assert.deepEqual(totalsFor(null, ['a']).a, { sum: null, known: 0, missing: 0, complete: true });
});

test('§7b POSITIVE CONTROL — the classifier is not a constant function', async () => {
  const { classifyMetric } = await mod;
  const seen = new Set([
    classifyMetric(5, 'connected').state,
    classifyMetric(null, 'connected').state,
    classifyMetric(0, 'not-connected').state,
    classifyMetric(0, 'unknown').state,
  ]);
  assert.equal(seen.size, 4, 'all four states must be reachable, or one of them is dead code');
});

test('§7c a row with an unknown landing_path is kept, not dropped', async () => {
  const { collapseByPath } = await mod;
  // Dropping it would quietly shrink the sessions total. Grouping it under a
  // visible placeholder keeps the arithmetic honest.
  const out = collapseByPath([{ channel: 'Direct', entry_sessions: 9 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].landing_path, '(unknown)');
  assert.equal(out[0].entry_sessions, 9);
});
