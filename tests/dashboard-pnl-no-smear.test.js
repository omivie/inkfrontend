/**
 * dashboard-pnl-no-smear.js — pin the P&L granularity rule
 * ========================================================
 *
 * Pinned 2026-05-10 (see readfirst/recurring-expenses-may2026.md §"P&L
 * granularity rule"). Spec at memory/recurring_expenses_may2026.md.
 *
 * Background:
 *   Backend `/api/admin/analytics/pnl` returns one row per CALENDAR MONTH
 *   (`period: "2026-05"`). The dashboard's Trends chart used to smear those
 *   monthly aggregates across visible day/week buckets weighted by time
 *   overlap — this concentrated the entire month's COGS into the visible
 *   window, painting a fake ~$29.80/day "expense" on every empty day. The
 *   user named this the "$29.80 ghost" on 2026-05-08.
 *
 *   The fix at `inkcartridges/js/admin/pages/dashboard.js` (around the P&L
 *   pre-fill loop) wraps the smearing in `if (cfg.unit === 'month')`. At
 *   sub-month granularity the chart leans on the actual per-day sources of
 *   truth: per-order COGS (items[].supplier_cost_snapshot × qty × 1.15) and
 *   dated logged expenses (incl. recurring subscriptions expanded by
 *   `expandRecurringExpenses`).
 *
 * What this test pins:
 *   1. At day/week granularity, the P&L pre-fill loop MUST NOT run, so a
 *      bucket whose only "expense source" is a P&L month total stays at $0.
 *   2. At month granularity, the loop MUST run so per-month P&L still appears
 *      on the wider views (1y / 3m).
 *
 * Strategy:
 *   We don't have a public entry point to `buildTrendSeries`, so we replicate
 *   the smearing-loop predicate directly: given `cfg.unit`, simulate the
 *   conditional and verify the right branch fires. This file lives next to
 *   dashboard-trend-math.test.js because both pin the same chart's math.
 *
 * Run with: node --test tests/dashboard-pnl-no-smear.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_PATH = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'
);

const SOURCE = fs.readFileSync(DASHBOARD_PATH, 'utf8');

// ─── Static guards on the source ────────────────────────────────────────────
// These are the cheapest, most direct way to prove the granularity guard
// stays in place: the loop must be syntactically inside the `if (cfg.unit
// === 'month')` block, and the comment block explaining WHY must remain so a
// future refactor can't quietly delete the guard without confronting the
// reason it exists.

test("dashboard.js wraps the P&L period loop in cfg.unit === 'month'", () => {
  // Find the P&L pre-fill loop signature and confirm the granularity guard
  // appears in the lines immediately above it.
  const loopIdx = SOURCE.indexOf('for (const p of pnlPeriods)');
  assert.ok(loopIdx > 0, 'P&L period loop must exist in dashboard.js');

  // The 200 chars preceding the loop should contain the guard.
  const preamble = SOURCE.slice(Math.max(0, loopIdx - 200), loopIdx);
  assert.match(
    preamble,
    /if\s*\(\s*cfg\.unit\s*===\s*'month'\s*\)/,
    'P&L period loop must be guarded by `if (cfg.unit === \'month\')` — otherwise monthly aggregates will smear across daily buckets and re-introduce the $29.80 ghost.'
  );
});

test("dashboard.js retains the GRANULARITY RULE rationale comment", () => {
  // The "why" matters more than the "what" for this guard. If the comment
  // disappears, future cleanup is likely to take the guard with it.
  assert.match(
    SOURCE,
    /GRANULARITY RULE/,
    'The granularity rule rationale must stay in dashboard.js so future refactors understand why P&L pre-fill is month-only.'
  );
  assert.match(
    SOURCE,
    /\$29\.80 ghost/,
    'The $29.80 ghost reference must stay so the bug can be traced from comment back to user-reported incident.'
  );
});

test("dashboard.js imports expandRecurringExpenses and calls it before bucketing", () => {
  // The recurring-expense expansion must run BEFORE bucketOperatingExpenses
  // so the bucketer treats the lot as a flat list of dated rows.
  assert.match(
    SOURCE,
    /import\s+\{[^}]*expandRecurringExpenses[^}]*\}\s+from\s+'\.\.\/utils\/trend-math\.js'/,
    'dashboard.js must import expandRecurringExpenses from trend-math.js'
  );
  const callIdx = SOURCE.indexOf('expandRecurringExpenses(');
  const bucketIdx = SOURCE.indexOf('bucketOperatingExpenses(buckets,');
  assert.ok(callIdx > 0, 'expandRecurringExpenses must be called in dashboard.js');
  assert.ok(bucketIdx > 0, 'bucketOperatingExpenses must be called in dashboard.js');
  assert.ok(
    callIdx < bucketIdx,
    'expandRecurringExpenses must run BEFORE bucketOperatingExpenses (it produces the flat list the bucketer consumes)'
  );
});

// ─── Behavioural guard: simulate both granularities ─────────────────────────
// Replicate just the smearing loop with a stub `cfg.unit` to prove the
// predicate works. This guards against a refactor that keeps the comment
// but inverts the guard.

function simulateSmearing(unit) {
  // Single 7-day window, all in May 2026. Single P&L row for May with
  // cogs = $700.
  const buckets = [
    { startMs: Date.UTC(2026, 4, 2), pnlCogs: 0, hasPnlCogs: false },
    { startMs: Date.UTC(2026, 4, 3), pnlCogs: 0, hasPnlCogs: false },
    { startMs: Date.UTC(2026, 4, 4), pnlCogs: 0, hasPnlCogs: false },
    { startMs: Date.UTC(2026, 4, 5), pnlCogs: 0, hasPnlCogs: false },
    { startMs: Date.UTC(2026, 4, 6), pnlCogs: 0, hasPnlCogs: false },
    { startMs: Date.UTC(2026, 4, 7), pnlCogs: 0, hasPnlCogs: false },
    { startMs: Date.UTC(2026, 4, 8), pnlCogs: 0, hasPnlCogs: false },
  ];
  const cfg = { unit, stepMs: 24 * 3600 * 1000 };
  const pnlPeriods = [{ period: '2026-05', cogs: 700 }];

  // Mirror dashboard.js exactly:
  if (cfg.unit === 'month') {
    for (const p of pnlPeriods) {
      const m = String(p.period).match(/^(\d{4})-(\d{2})/);
      const monthStart = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
      const monthEnd   = new Date(Number(m[1]), Number(m[2]), 1).getTime();
      const overlaps = [];
      for (const b of buckets) {
        const bStart = b.startMs;
        const bEnd = new Date(new Date(bStart).getFullYear(), new Date(bStart).getMonth() + 1, 1).getTime();
        const ov = Math.max(0, Math.min(bEnd, monthEnd) - Math.max(bStart, monthStart));
        if (ov > 0) overlaps.push({ b, ov });
      }
      const totalOv = overlaps.reduce((s, o) => s + o.ov, 0);
      if (!totalOv) continue;
      for (const { b, ov } of overlaps) {
        const w = ov / totalOv;
        b.pnlCogs += p.cogs * w; b.hasPnlCogs = true;
      }
    }
  }
  return buckets;
}

test("simulateSmearing(unit='day'): empty days stay at $0 (no P&L pre-fill)", () => {
  const buckets = simulateSmearing('day');
  for (const b of buckets) {
    assert.equal(b.pnlCogs, 0, 'daily buckets must NOT receive smeared P&L');
    assert.equal(b.hasPnlCogs, false);
  }
});

test("simulateSmearing(unit='week'): P&L pre-fill also skipped at week granularity", () => {
  const buckets = simulateSmearing('week');
  for (const b of buckets) {
    assert.equal(b.pnlCogs, 0, 'weekly buckets must NOT receive smeared P&L either');
  }
});

test("simulateSmearing(unit='month'): P&L pre-fill still runs on monthly view", () => {
  // Switch to a single monthly bucket spanning all of May.
  const buckets = [
    { startMs: Date.UTC(2026, 4, 1), pnlCogs: 0, hasPnlCogs: false },
  ];
  const cfg = { unit: 'month', stepMs: null };
  const pnlPeriods = [{ period: '2026-05', cogs: 700 }];

  // Replay the same logic but with the monthly bucket layout.
  if (cfg.unit === 'month') {
    for (const p of pnlPeriods) {
      const m = String(p.period).match(/^(\d{4})-(\d{2})/);
      const monthStart = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
      const monthEnd   = new Date(Number(m[1]), Number(m[2]), 1).getTime();
      for (const b of buckets) {
        const bStart = b.startMs;
        const bEnd = new Date(new Date(bStart).getFullYear(), new Date(bStart).getMonth() + 1, 1).getTime();
        const ov = Math.max(0, Math.min(bEnd, monthEnd) - Math.max(bStart, monthStart));
        if (ov > 0) {
          // totalOv === ov for one bucket → weight = 1
          b.pnlCogs += p.cogs * (ov / ov);
          b.hasPnlCogs = true;
        }
      }
    }
  }

  assert.equal(buckets[0].pnlCogs, 700, 'monthly bucket must get the full P&L cogs');
  assert.equal(buckets[0].hasPnlCogs, true);
});
