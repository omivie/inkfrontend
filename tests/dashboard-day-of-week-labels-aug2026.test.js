/**
 * Dashboard — day-of-week on the Performance-overview date labels (Aug 2026)
 * =========================================================================
 *
 * Asked for 2026-08-04: at the `day` bar-width the chart labelled buckets "12 Jun", which
 * hides the strongest cycle in this store's data — the weekday/weekend rhythm. Every spike
 * read as a one-off. The day grain now leads with the weekday: "Fri 12 Jun".
 *
 * Three contracts pinned here:
 *
 *   1. DAY GRAIN ONLY. A week/month/quarter bucket spans every weekday, so naming one
 *      would be a false claim about which day the money landed on.
 *   2. LOCAL parse. The backend ships an Auckland-local "YYYY-MM-DD"; `new Date(str)` would
 *      read it as UTC and could name the WRONG weekday. The weekday must match the local
 *      calendar date, or the whole feature misleads.
 *   3. ONE formatter. `fmtBucket` produces the axis tick AND (via Chart.js's default title
 *      callback) the tooltip title. A `title` callback in the Performance-overview tooltip
 *      would fork them, so the tooltip could name a different day than the axis under it.
 *
 * Run with: node --test tests/dashboard-day-of-week-labels-aug2026.test.js
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
const src = fs.readFileSync(DASHBOARD, 'utf8');

/** Lift a `function NAME(){}` declaration out of dashboard.js by brace-matching. */
function lift(name) {
  const m = src.match(new RegExp(`(?:^|\\n)function\\s+${name}\\s*\\(`));
  assert.ok(m, `${name} not found in dashboard.js — renamed?`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const open = src.indexOf('{', src.indexOf(name, start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

// The REAL shipped source, not a copy that could drift from it. dashboard.js imports
// app.js/charts.js so it can't be evaluated whole, but fmtBucket is pure once the
// granularity latch is stubbed.
const weekdayLine = src.match(/^const WEEKDAY = .*$/m);
assert.ok(weekdayLine, 'WEEKDAY helper not found — renamed?');

const sandbox = { console, Math, Number, String, Boolean, Object, Array, JSON, Date, isNaN, Error };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext([
  'let _effectiveGranularity = null;',
  'function resolveGranularity() { return _effectiveGranularity || "day"; }',
  weekdayLine[0],
  lift('fmtBucket'),
  ';globalThis.fmtBucket = fmtBucket;',
  ';globalThis.setGrain = (g) => { _effectiveGranularity = g; };',
].join('\n'), ctx, { filename: 'dashboard-lifted.js' });

const { fmtBucket, setGrain } = sandbox;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The weekday of a "YYYY-MM-DD" read as a LOCAL calendar date — the answer we must match. */
function localWeekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

// ─── 1. The day grain names the day ─────────────────────────────────────────

test('day grain leads with the weekday — the bucket in the report, 2026-06-12, is a Friday', () => {
  setGrain('day');
  assert.equal(fmtBucket('2026-06-12'), 'Fri 12 Jun');
});

test('no comma between weekday and date — "Fri, 12 Jun" reads as two dates on a packed axis', () => {
  setGrain('day');
  // Guards the two-call format: en-NZ renders {weekday,day,month} in ONE call as "Fri, 12 Jun".
  assert.equal(fmtBucket('2026-06-12').includes(','), false);
});

test('consecutive days name seven distinct weekdays, in calendar order', () => {
  setGrain('day');
  const week = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11',
                '2026-06-12', '2026-06-13', '2026-06-14'];
  assert.deepEqual(
    week.map(d => fmtBucket(d).split(' ')[0]),
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  );
});

test('the date part is unchanged — nothing that read "12 Jun" before stopped saying it', () => {
  setGrain('day');
  for (const iso of ['2026-04-21', '2026-06-12', '2026-07-29']) {
    const [, ...rest] = fmtBucket(iso).split(' ');
    const [y, m, d] = iso.split('-').map(Number);
    assert.equal(rest.join(' '), new Date(y, m - 1, d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }));
  }
});

// ─── 2. The weekday is the LOCAL one (a UTC parse can name the wrong day) ───

test('every day of a 60-day run names the weekday of the LOCAL calendar date', () => {
  setGrain('day');
  // `new Date("2026-06-12")` is UTC midnight; in a negative-offset timezone that is the
  // 11th locally, and a UTC-parsed label would name Thursday for a Friday's takings.
  const start = new Date(2026, 4, 1);
  for (let i = 0; i < 60; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(fmtBucket(iso).split(' ')[0], localWeekday(iso), `wrong weekday for ${iso}`);
  }
});

test('a bucket that arrives with a time component still names its own day', () => {
  setGrain('day');
  assert.equal(fmtBucket('2026-06-12T00:00'), 'Fri 12 Jun');
});

// ─── 3. Coarser grains must NOT name a weekday ──────────────────────────────

test('week / month / quarter carry no weekday — the bucket spans every day of the week', () => {
  const cases = { week: '2026-06-08', month: '2026-06-01', quarter: '2026-04-01' };
  for (const [grain, iso] of Object.entries(cases)) {
    setGrain(grain);
    const label = fmtBucket(iso);
    for (const wd of WEEKDAYS) {
      assert.equal(
        new RegExp(`\\b${wd}\\b`).test(label), false,
        `${grain} label "${label}" names a weekday — a ${grain} bucket has no single day`,
      );
    }
  }
});

test('the week span format is untouched', () => {
  setGrain('week');
  assert.equal(fmtBucket('2026-06-08'), 'Jun 8 – Jun 15');
});

test('an unparseable bucket still falls back to the raw string', () => {
  setGrain('day');
  assert.equal(fmtBucket('not-a-date'), 'not-a-date');
  assert.equal(fmtBucket(null), '');
});

// ─── 4. Axis label and tooltip title stay the same string ───────────────────

test('the Performance overview labels its x-axis from fmtBucket', () => {
  const body = lift('drawPerformanceOverview');
  assert.match(body, /const labels = order\.map\(fmtBucket\)/);
});

test('the Performance-overview tooltip does NOT override the title', () => {
  // Chart.js defaults the tooltip title to the category label, i.e. fmtBucket's output. A
  // `title:` callback here would fork the two and let the tooltip name a different day
  // than the tick beneath it.
  const body = lift('drawPerformanceOverview');
  const tooltip = body.slice(body.indexOf('tooltip: { callbacks:'));
  assert.ok(tooltip, 'tooltip callbacks block not found — restructured?');
  assert.equal(
    /\btitle:\s*(\(|function)/.test(tooltip.slice(0, tooltip.indexOf('scales:'))), false,
    'a tooltip title callback would bypass fmtBucket',
  );
});
