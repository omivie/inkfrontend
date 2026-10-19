/**
 * ERR-367 — the admin filter bar's "today" was the UTC day
 * ========================================================
 *
 * Measured 2026-10-20 at 12:17 NZDT: the dashboard printed "per-period net profit adds up
 * to −$3,026.66, but the Net Profit tile reads −$3,020.56 (gap $6.10)". The filter bar sent
 * `date_to=2026-10-19` (`toISOString()`, the UTC day) while NZ was on the 20th. Order
 * 2026102001 ($32.99, NZ 20 Oct 08:20 = 2026-10-19T19:20Z) was then INSIDE kpi-summary
 * (UTC bounds) and OUTSIDE the series (NZ bounds): $6.10 of net. With `date_to=2026-10-20`
 * both read −996.76.
 *
 * Run with: node --test tests/admin-filter-nz-date-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'filters.js'), 'utf8');

const nzDaySrc = src.match(/const nzDay = [^\n]+\n/)[0];
const presetsSrc = src.slice(src.indexOf('const PERIOD_PRESETS'), src.indexOf('];', src.indexOf('const PERIOD_PRESETS')) + 2);
const start = src.indexOf('  getDateRange() {');
const end = src.indexOf('\n  },', start) + 4;
const getDateRangeSrc = src.slice(start, end);

/** Run the SHIPPED getDateRange with the clock pinned to `isoNow`. */
function rangeAt(isoNow, state) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [isoNow])); }
    static now() { return new RealDate(isoNow).getTime(); }
  }
  const sandbox = { Date: FakeDate, Intl };
  vm.createContext(sandbox);
  vm.runInContext(`${nzDaySrc}\n${presetsSrc}\nglobalThis.FS = {\n${getDateRangeSrc}\n};`, sandbox);
  sandbox.FS._state = state;
  sandbox.FS._dataStartDate = '2026-03-14';
  return sandbox.FS.getDateRange();
}

test('NZ morning: "today" is the NZ day, not the UTC day', () => {
  // 2026-10-19T23:17Z = 20 Oct 12:17 NZDT, the moment of the owner's screenshot.
  const r = rangeAt('2026-10-19T23:17:00Z', { period: 'all' });
  assert.deepEqual({ ...r }, { from: '2026-03-14', to: '2026-10-20' });
});

test('presets count back from the NZ day', () => {
  assert.deepEqual({ ...rangeAt('2026-10-19T23:17:00Z', { period: '1m' }) }, { from: '2026-09-20', to: '2026-10-20' });
  assert.deepEqual({ ...rangeAt('2026-10-19T23:17:00Z', { period: '24h' }) }, { from: '2026-10-19', to: '2026-10-20' });
});

test('NZ afternoon: UTC and NZ already agree, nothing moves', () => {
  assert.equal(rangeAt('2026-10-20T02:00:00Z', { period: '7d' }).to, '2026-10-20');
});

test('DST end (5 Apr 2026): one-day preset stays one calendar day', () => {
  // 2026-04-05T12:30Z = 6 Apr 00:30 NZST, just after the clocks went back.
  assert.deepEqual({ ...rangeAt('2026-04-05T12:30:00Z', { period: '24h' }) }, { from: '2026-04-05', to: '2026-04-06' });
});

test('custom range passes through untouched', () => {
  const r = rangeAt('2026-10-19T23:17:00Z', { period: 'custom', dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  assert.deepEqual({ ...r }, { from: '2026-08-01', to: '2026-08-31' });
});

test('getDateRange no longer reads the UTC day for "today"', () => {
  assert.ok(!/new Date\(\)\.toISOString\(\)/.test(getDateRangeSrc));
});
