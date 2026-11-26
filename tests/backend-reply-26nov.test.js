/**
 * Backend reply 2026-11-26 (bc40b01, migration 221) — what the FE changed because of it (ERR-397)
 * ==============================================================================================
 *
 * §1 revenue-series is now net of refunds (+ `sales`, `refunds` per day):
 *    - Analytics → Revenue chart no longer says "sales before refunds";
 *    - Expenses "vs Revenue" reads revenue-series for the page's own date range (no 365-day cap),
 *      replacing daily-revenue?days=N (which refused > 365 — §5), whose API method is deleted.
 * §2 kpi refund_rate now equals the Dashboard's own count ratio — comment updated, no second call.
 * §3 Out of Stock tile = dashboard-summary `actions.out_of_stock` (what a shopper sees, packs
 *    included); the supplier-feed read (margin/out-of-stock) left the Dashboard.
 * §4/§6 are graded live by `npm run probe:backend-26nov` and `probe:supplier-freight` §7.
 *
 * Run with: node --test tests/backend-reply-26nov.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const read = (...p) => fs.readFileSync(path.join(ADMIN, ...p), 'utf8');
const DASH = read('pages', 'dashboard.js');
const EXP = read('pages', 'expenses.js');
const OVERVIEW = read('pages', 'expenses-tab-overview.js');
const ANALYTICS = read('pages', 'analytics.js');
const API = read('api.js');

test('§3: the Out of Stock tile is the shopper view from dashboard-summary, never a silent 0', () => {
  assert.match(DASH, /const oosCount = d\.dsum\?\.actions\?\.out_of_stock\?\.count \?\? null;/);
  assert.doesNotMatch(DASH, /AdminAPI\.getOutOfStock\(|outOfStockCount\(/, 'the supplier-feed read left the Dashboard');
  assert.match(DASH, /missingWhy: 'The out-of-stock list could not load — this is not a zero\.'/);
  assert.match(DASH, /Supplier-feed view[\s\S]{0,60}Margins → Out of stock/i);
});

test('§3: the invoice list moved into slot 4 and every slot still lines up', () => {
  assert.match(DASH, /\/\/ 4  invoice cost-over-price to-do[\s\S]{0,400}AdminAPI\.listInvoices\(\{\}, 1, 100\),/);
  assert.match(DASH, /invoiceRows: wholeList\(val\(4\), \['invoices', 'data', 'items'\]\)/);
  assert.match(DASH, /refundRows: wholeList\(val\(13\)/);
  assert.match(DASH, /funnel: val\(12\)/);
  assert.match(DASH, /sTraffic: normalizeSeries\(val\(11\)\)/);
  // exactly 14 promises (0..13)
  const list = DASH.slice(DASH.indexOf('const promises = ['), DASH.indexOf('const results = await Promise.allSettled(promises);'));
  assert.equal((list.match(/^\s{4}AdminAPI\./gm) || []).length, 14);
});

test('§2: the refund-rate comment says kpi now uses the same definition', () => {
  assert.match(DASH, /kpi-summary's `refund_rate` uses this same definition/);
  assert.doesNotMatch(DASH, /`refund_rate` is NOT used/);
});

test('§1/§5: Expenses reads revenue-series for its own date range — no days, no 365 cap', () => {
  const fn = EXP.slice(EXP.indexOf('function ensureDailyRevenue() {'), EXP.indexOf('// ─── row filtering'));
  assert.match(fn, /AdminAPI\.getRevenueSeries\(new URLSearchParams\(\{ from, to \}\)\)/);
  assert.match(fn, /const \{ from, to \} = FilterState\.getDateRange\(\);/);
  const code = fn.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // comments may name the old call
  assert.doesNotMatch(code, /getAdminAnalyticsDailyRevenue|days|365/);
  assert.match(fn, /_dailyRevenue = rows \? \{ daily: rows \} : null;/, 'a failure stays null — the chart says "could not load"');
  assert.doesNotMatch(API, /async getAdminAnalyticsDailyRevenue\(/, 'the capped endpoint wrapper is deleted');
});

test('§1: the Expenses chart labels revenue as after refunds and never draws a $0 line on failure', () => {
  assert.match(OVERVIEW, /label: 'Revenue after refunds'/);
  assert.match(OVERVIEW, /revenue could not load — not a zero/);
  assert.match(OVERVIEW, /\.\.\.\(daily \? \[\{ label: 'Revenue after refunds'/);
  assert.doesNotMatch(OVERVIEW, /backend max 365 days/);
});

test('§1: Analytics → Revenue chart is after refunds (the "sales before refunds" label is gone)', () => {
  assert.match(ANALYTICS, /Revenue Series <small>\$\{FilterState\.get\('period'\)\} · after refunds<\/small>/);
  assert.doesNotMatch(ANALYTICS, /sales before refunds/);
});
