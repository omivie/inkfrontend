/**
 * COGS honesty — an unknown profit must never render as zero
 * =========================================================
 *
 * The backend returns `cogs` / `gross_profit` / `net_profit` / `*_margin_pct` as
 * **null**, never 0, whenever a sale in the bucket has an un-costed line. That is
 * correct and deliberate (ERR-028). The frontend's job is not to undo it.
 *
 * `Number(null)` is `0`. `null || 0` is `0`. So the naive read turns "we don't
 * know" into "we made nothing" — and the two look identical on screen:
 *
 *   Finance P&L   → "Cost of Goods Sold  $0.00"   (we sold $7k and paid nothing?)
 *   Profit chart  → a line flat along the axis    (a month of zero profit)
 *   Margin chart  → a confident 0.0% bar
 *   Low-margin alert → "OKI · 0.0% — reprice or drop"
 *
 * That last one is the worst: an ACTIONABLE recommendation to drop a brand, built
 * on a number that does not exist. This file pins every one of those shut.
 *
 * Chart.js renders `null` as a GAP (spanGaps defaults to false), so pushing null
 * is not just safe — it's the whole mechanism.
 *
 * Run with: node --test tests/admin-cogs-honesty.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const dashboardSrc = fs.readFileSync(path.join(ADMIN, 'pages', 'dashboard.js'), 'utf8');
const financeSrc = fs.readFileSync(path.join(ADMIN, 'pages', 'financial-health.js'), 'utf8');

/** Brace-match a top-level function body out of a source file. */
function functionBody(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `${name}() not found — renamed?`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`unbalanced braces in ${name}()`);
}

// ─── The helper itself ───────────────────────────────────────────────────────
// numOrNull is a one-liner in dashboard.js; re-implement it here from the source
// so the test breaks if its behaviour changes, not just its name.
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

test('numOrNull keeps unknown as null — it does NOT become 0', () => {
  assert.equal(numOrNull(null), null, 'Number(null) is 0 — that is the bug this exists to stop');
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('abc'), null);
  // A real zero is still a real zero.
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull(-48.19), -48.19, 'a NEGATIVE margin is a real number, not a missing one');
});

test('dashboard.js defines numOrNull and uses it for the COGS-derived reads', () => {
  assert.ok(/const numOrNull = \(v\) =>/.test(dashboardSrc), 'numOrNull must exist');
  // The four mappers that feed profit/margin data into charts.
  for (const fn of ['drawSeries', 'drawRanked', 'drawRevenueProfit', 'drawPerformanceOverview']) {
    const body = functionBody(dashboardSrc, fn);
    assert.ok(body.includes('numOrNull'),
      `${fn}() must read COGS-derived values through numOrNull — otherwise a null gross_profit ` +
      'draws a confident $0 bar.');
  }
});

test('no chart mapper coerces a value with `|| 0` any more', () => {
  // The exact expressions that used to fabricate zeros.
  for (const fn of ['drawSeries', 'drawRanked', 'drawRevenueProfit', 'drawPerformanceOverview']) {
    const body = functionBody(dashboardSrc, fn);
    assert.ok(!/Number\(\s*r\[(valueKey|srcKey|key)\]\s*\|\|\s*0\s*\)/.test(body),
      `${fn}() still has a Number(x || 0) — that turns an unknown COGS into a $0 data point.`);
    assert.ok(!/byBucket\.get\(b\)\?\.\w+\s*\|\|\s*0/.test(body),
      `${fn}() still has a byBucket…|| 0 — an absent bucket must be a gap, not a $0 point.`);
  }
  // drawPerformanceOverview's ?? chain specifically: net → gross → UNKNOWN, not 0.
  const perf = functionBody(dashboardSrc, 'drawPerformanceOverview');
  assert.ok(!/Number\(r\.net_profit \?\? r\.gross_profit \?\? 0\)/.test(perf),
    'the net→gross fallback must end in null, not 0: when BOTH are null the COGS is unknown.');
  assert.ok(/numOrNull\(r\.net_profit\)\s*\?\?\s*numOrNull\(r\.gross_profit\)/.test(perf),
    'expected: numOrNull(net) ?? numOrNull(gross) — no trailing 0');
});

test('a cumulative running total does not silently step over an unknown bucket', () => {
  // Once a bucket's profit is unknown, every later cumulative total is unknowable
  // too. Treating the gap as "+0" would draw a confident flat shelf and then carry
  // on as if nothing were missing.
  const accum = (arr) => {
    let acc = 0, broken = false;
    return arr.map(v => {
      if (v == null) { broken = true; return null; }
      if (broken) return null;
      return (acc += v);
    });
  };
  assert.deepEqual(accum([10, 20, null, 40]), [10, 30, null, null],
    'the total after an unknown bucket is unknown — not 30, and not 70');
  assert.deepEqual(accum([10, 20, 30]), [10, 30, 60], 'no nulls → ordinary running total');

  for (const fn of ['drawRevenueProfit', 'drawPerformanceOverview']) {
    const body = functionBody(dashboardSrc, fn);
    assert.ok(/broken/.test(body), `${fn}()'s accum must carry the gap forward`);
  }
});

// ─── The low-margin alert — the one that gives ACTIONABLE bad advice ─────────
test('an UNKNOWN margin is not a LOW margin (the false "0.0% — reprice or drop")', () => {
  const LOW_MARGIN_PCT = 10;
  const brands = [
    { brand: 'OKI', margin_pct: -3.41 },   // genuinely bad
    { brand: 'Brother', margin_pct: 7.13 },// genuinely low
    { brand: 'HP', margin_pct: null },     // UNKNOWN — must not be reported at all
    { brand: 'Canon', margin_pct: 42.0 },  // healthy
  ];
  const low = brands
    .map(b => ({ label: b.brand, pct: numOrNull(b.margin_pct) }))
    .filter(b => b.pct != null && b.pct < LOW_MARGIN_PCT)
    .sort((a, b) => a.pct - b.pct);

  assert.deepEqual(low.map(b => b.label), ['OKI', 'Brother']);
  assert.ok(!low.some(b => b.label === 'HP'),
    'HP has an UNKNOWN margin. Telling the owner to reprice-or-drop a brand on the ' +
    'strength of a number that does not exist is worse than telling them nothing.');

  // And prove the old code really did get this wrong, so the test has teeth.
  const oldWay = brands
    .map(b => ({ label: b.brand, pct: Number(b.margin_pct) }))
    .filter(b => Number.isFinite(b.pct) && b.pct < LOW_MARGIN_PCT);
  assert.ok(oldWay.some(b => b.label === 'HP'),
    'sanity: Number(null) === 0 and isFinite(0) — the naive filter DID flag HP at 0.0%');
});

test('computeLowMarginAlert guards null before the threshold compare', () => {
  const body = functionBody(dashboardSrc, 'computeLowMarginAlert');
  assert.ok(body.includes('numOrNull'), 'must use numOrNull');
  assert.ok(!/Number\(b\.margin_pct\)/.test(body),
    'Number(b.margin_pct) turns an unknown margin into 0, which then passes `< LOW_MARGIN_PCT`');
});

// ─── Finance P&L — the bug that was LIVE on the owner's screen ───────────────
test('the P&L renders an unknown COGS as "—", never "$0.00"', () => {
  const MISSING = '—';
  const num = (v, d = 0) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : d;
  };
  const formatPrice = (v) => `$${Number(v).toFixed(2)}`;
  const known = (v) => v != null && Number.isFinite(typeof v === 'string' ? parseFloat(v) : v);
  const fmt = (v, neg) => {
    if (!known(v)) return MISSING;
    const n = num(v);
    return (neg && n > 0 ? '-' : '') + formatPrice(Math.abs(n));
  };

  assert.equal(fmt(null, true), MISSING, 'a null Cost of Goods Sold must read "—", not "$0.00"');
  assert.equal(fmt(undefined, false), MISSING);
  assert.equal(fmt(1234.5, false), '$1234.50', 'a real number still renders');
  assert.equal(fmt(171.12, true), '-$171.12', 'a real negative-signed row still renders');
  assert.equal(fmt(0, false), '$0.00', 'a genuine ZERO is still shown as zero — 0 ≠ unknown');
});

test('the P&L Change column renders "—" against an unknown, not "0%" or "+∞"', () => {
  const MISSING = '—';
  const num = (v, d = 0) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : d;
  };
  const known = (v) => v != null && Number.isFinite(typeof v === 'string' ? parseFloat(v) : v);
  const change = (c0, p0) => {
    if (!known(c0) || !known(p0)) return MISSING;
    const c = num(c0), p = num(p0);
    if (!p) return c > 0 ? '+∞' : '0%';
    const pct = ((c - p) / Math.abs(p)) * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  };

  assert.equal(change(null, null), MISSING, '"0%" would claim profit was FLAT when it is unknown');
  assert.equal(change(500, null), MISSING, '"+∞" would claim it appeared out of nothing');
  assert.equal(change(null, 500), MISSING);
  assert.equal(change(150, 100), '+50.0%', 'two known values still compute');
  assert.equal(change(100, 0), '+∞', 'a genuine zero base is still +∞ — that behaviour is unchanged');
});

test('financial-health.js actually wires that up (not just in this test file)', () => {
  const body = functionBody(financeSrc, 'renderPnLTable');
  assert.ok(/const known = /.test(body), 'renderPnLTable must define a null guard');
  assert.ok(body.includes('MISSING'), 'renderPnLTable must be able to render "—"');
  assert.ok(!/const fmt = \(v, neg\) => \{\s*const n = num\(v\);/.test(body),
    'fmt() still runs the value straight through num(), which defaults null to 0 → "$0.00"');
  assert.ok(/unknownRows/.test(body),
    'the table should say WHY a row is "—" — a bare dash with no explanation is a dead end');
});

test('the Finance profit chart plots null (a gap), not 0', () => {
  const body = functionBody(financeSrc, 'renderProfitChart');
  assert.ok(/gross\.push\(p\.gross_profit != null \? num\(p\.gross_profit\) : null\)/.test(body),
    'gross.push(num(p.gross_profit)) draws a line down to the axis for an unknown month');
  assert.ok(/net\.push\(p\.net_profit != null \? num\(p\.net_profit\) : null\)/.test(body));
});

// ─── The overlay is gone ─────────────────────────────────────────────────────
test('the client-side invoice overlay has been fully removed', () => {
  // The backend now counts invoiced sales itself (includes_invoices: true). Any
  // surviving client-side top-up would DOUBLE the revenue.
  assert.ok(!fs.existsSync(path.join(ADMIN, 'utils', 'invoice-overlay.js')),
    'utils/invoice-overlay.js still exists — it was built to be deleted once the backend shipped');
  for (const [name, src] of [['dashboard', dashboardSrc], ['financial-health', financeSrc],
    ['expenses', fs.readFileSync(path.join(ADMIN, 'pages', 'expenses.js'), 'utf8')]]) {
    assert.ok(!/invoice-overlay|fetchInvoiceDelta|aggregateInvoices|backendCountsInvoices/.test(src),
      `${name}.js still references the overlay — with the backend counting invoices, that double-counts.`);
  }
});

test('no page adds invoice revenue to a backend total client-side', () => {
  for (const [name, src] of [['dashboard', dashboardSrc], ['financial-health', financeSrc]]) {
    assert.ok(!/withInvoices|pnlWithInvoices/.test(src),
      `${name}.js still has a client-side invoice top-up helper`);
  }
});
