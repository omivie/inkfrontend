/**
 * expense-math.js — KPI, P&L-impact and breakdown math for expenses
 * ==================================================================
 *
 * The ONE place expense numbers are computed, so the summary KPIs, the analytics
 * charts and the Financial-Health card can never disagree. Two accounting rules
 * are enforced here and must match the backend P&L aggregation (see the backend
 * spec):
 *
 *   1. DOUBLE-COUNT GUARD. Order-linked categories (inventory / merchant fees /
 *      courier) are ALREADY counted in per-order profit (profitability.js). They
 *      are EXCLUDED from the operating-expense total and from net-profit impact,
 *      and surfaced separately as "already counted in order costs".
 *
 *   2. GST-NEUTRAL. When an expense carries claimable NZ GST, only its ex-GST
 *      portion reduces profit — the GST is reclaimed as an input credit and nets
 *      to zero (same law as profitability.js). Foreign / GST-free expenses hit
 *      profit at full face value. GST fraction of a GST-inclusive gross amount is
 *      3/23 (never × 0.15). See reference_shipping_gst_convention.
 *
 *   3. CASH BASIS (Jul 2026 — matches the backend). An expense counts toward
 *      spend / profit ONLY once it is marked PAID, and lands in the period of its
 *      `paid_date` — never its incurred date. This mirrors the backend's
 *      /api/admin/analytics/pnl `operating_expenses`, so the Expenses page, the
 *      Financial-Health card and Finance → P&L all report the same figure for the
 *      same month. Unpaid work (overdue / due / upcoming) is reported SEPARATELY
 *      off the DUE date and is never mixed into a spend total.
 *
 *      headline `thisMonth` === backend `summary.operating_paid`
 *                            === backend `pnl.operating_expenses`
 *
 * Occurrences passed in are ENRICHED objects (the page stamps these once):
 *   { amount:Number, category:String, kind:'operating'|'order_linked',
 *     status:String, paid:Boolean,
 *     expense_date, due_date, paid_date (ISO or ms), gst_claimable:Boolean,
 *     projected:Boolean, recurring:Boolean }
 *
 * Import-free + side-effect-free → unit-tested in a bare vm sandbox.
 *
 * Run with: node --test tests/admin-expenses-math.test.js
 */

'use strict';

export const GST_FRACTION_OF_GROSS = 3 / 23; // GST portion of a GST-inclusive amount

function toMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function amt(o) {
  const n = typeof o.amount === 'string' ? parseFloat(o.amount) : o.amount;
  return Number.isFinite(n) ? n : 0;
}

const isOperating = (o) => o && o.kind !== 'order_linked';
const inRange = (ms, a, b) => Number.isFinite(ms) && ms >= a && ms <= b;

/** Has this expense actually been paid? (Stored status wins; `paid` flag is a mirror.) */
export function isPaid(o) {
  return !!o && (o.status === 'paid' || o.paid === true);
}

/**
 * CASH-BASIS placement date: the day the money actually left the bank.
 * An UNPAID expense has no cash date (NaN) and is therefore excluded from every
 * spend/profit total — that is the whole point of the cash basis. Falling back to
 * the incurred date here would silently re-introduce accrual accounting and put us
 * back out of step with the backend's P&L.
 */
export function cashMs(o) {
  if (!isPaid(o)) return NaN;
  return toMs(o.paid_date);
}

/**
 * Profit impact of a single expense amount (GST-neutral). Order-linked costs
 * return 0 (already in per-order COGS). Claimable GST is netted out.
 */
export function pnlCost(amount, gstClaimable) {
  const a = Number.isFinite(amount) ? amount : 0;
  return gstClaimable ? a * (1 - GST_FRACTION_OF_GROSS) : a;
}

/** Reclaimable GST input credit embedded in a GST-inclusive amount. */
export function gstCredit(amount, gstClaimable) {
  const a = Number.isFinite(amount) ? amount : 0;
  return gstClaimable ? a * GST_FRACTION_OF_GROSS : 0;
}

/**
 * Normalise a recurring template's amount to an equivalent MONTHLY cost, so the
 * "recurring monthly commitment" KPI is comparable across frequencies. One-off
 * templates contribute 0 (not a commitment).
 */
export function monthlyCommitment(template) {
  if (!template) return 0;
  const a = (typeof template.amount === 'string' ? parseFloat(template.amount) : template.amount) || 0;
  switch (template.recurrence) {
    case 'weekly':      return a * 52 / 12;
    case 'fortnightly': return a * 26 / 12;
    case 'monthly':     return a;
    case 'quarterly':   return a / 3;
    case 'yearly':      return a / 12;
    case 'custom': {
      const iv = parseInt(template.recurrence_interval_days, 10);
      return (Number.isInteger(iv) && iv > 0) ? a * 365 / (12 * iv) : 0;
    }
    default:            return 0;
  }
}

/** Sum monthly commitment across ACTIVE recurring templates only. */
export function recurringMonthlyCommitment(templates) {
  if (!Array.isArray(templates)) return 0;
  return templates.reduce((s, t) => {
    if (!t || !t.recurrence || t.recurrence === 'none') return s;
    const state = t.series_state || 'active';
    if (state !== 'active') return s;
    return s + monthlyCommitment(t);
  }, 0);
}

/**
 * Category breakdown (largest first) — "where did the money actually go".
 * Cash-basis by default: PAID operating expenses only, GST-netted, so the doughnut
 * sums to the headline KPI and to Finance → P&L. Pass { paidOnly:false } for an
 * accrual view (nothing ships that today).
 */
export function categoryBreakdown(list, { operatingOnly = true, paidOnly = true, netted = true } = {}) {
  const totals = new Map();
  for (const o of (list || [])) {
    if (operatingOnly && !isOperating(o)) continue;
    if (paidOnly && !isPaid(o)) continue;
    const key = o.category || 'other';
    const v = netted ? pnlCost(amt(o), !!o.gst_claimable) : amt(o);
    totals.set(key, (totals.get(key) || 0) + v);
  }
  return [...totals.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Bucket operating-expense spend over time for the trend chart. grain is
 * 'day' | 'week' | 'month'. CASH BASIS: only PAID expenses, bucketed on their
 * `paid_date`, GST-netted — so the bars reconcile with the headline KPI and the
 * P&L. Unpaid/projected spend belongs in the "upcoming" surfaces, never here.
 * Returns ordered [{ key, total }] covering [fromMs, toMs].
 */
export function bucketExpenses(list, fromMs, toMs, grain = 'month', { netted = true } = {}) {
  const buckets = new Map();
  const keyOf = (ms) => {
    const d = new Date(ms);
    if (grain === 'day') return isoDay(ms);
    if (grain === 'week') {
      const dow = d.getUTCDay();
      const monday = ms - ((dow + 6) % 7) * 86400000;
      return isoDay(monday);
    }
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  for (const o of (list || [])) {
    if (!isOperating(o)) continue;
    const ms = cashMs(o);            // NaN for unpaid → excluded
    if (!inRange(ms, fromMs, toMs)) continue;
    const k = keyOf(ms);
    const v = netted ? pnlCost(amt(o), !!o.gst_claimable) : amt(o);
    buckets.set(k, (buckets.get(k) || 0) + v);
  }
  return [...buckets.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

function isoDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The headline KPI bundle — CASH BASIS (see rule 3 in the header).
 *
 * Spend figures (`thisMonth`, `lastMonth`, `orderLinked`, `largestCategory`) count
 * ONLY PAID expenses, placed on their `paid_date`, GST-netted and operating-only.
 * `thisMonth` is therefore the same number the backend reports as
 * `summary.operating_paid` / `pnl.operating_expenses`.
 *
 * Forward-looking figures (`overdue`, `due`, `unpaid`, `upcoming30`) count UNPAID
 * work off the DUE date, at GROSS (that's the cash you must actually find). They
 * are deliberately never added into a spend total.
 *
 * opts: {
 *   monthStart, monthEnd, prevStart, prevEnd,   // ms bounds (UTC)
 *   next30Start, next30End,                      // ms bounds for upcoming cash
 *   revenueThisMonth,                            // Number|null (ex-GST; null → ratio null)
 *   recurringTemplates,                          // Array<template> for commitment
 * }
 */
export function computeExpenseKpis(list, opts = {}) {
  const rows = Array.isArray(list) ? list : [];
  const {
    monthStart, monthEnd, prevStart, prevEnd,
    next30Start, next30End, revenueThisMonth, recurringTemplates,
  } = opts;

  const op = rows.filter(isOperating);
  const ol = rows.filter(o => !isOperating(o));

  const sum = (arr, f) => arr.reduce((s, o) => s + f(o), 0);
  const net = (o) => pnlCost(amt(o), !!o.gst_claimable);
  // Paid, and the money left the bank inside [a,b].
  const paidIn = (arr, a, b) => arr.filter(o => inRange(cashMs(o), a, b));

  // ── Cash-basis spend (reconciles with the backend P&L) ──
  const opThis = paidIn(op, monthStart, monthEnd);
  const opPrev = paidIn(op, prevStart, prevEnd);
  const thisMonth      = sum(opThis, net);   // ← the headline; === backend operating_paid
  const thisMonthGross = sum(opThis, amt);   // what actually left the bank (incl GST)
  const lastMonth      = sum(opPrev, net);
  const pctChange = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100
                  : (thisMonth > 0 ? null : 0); // null = "no prior baseline"

  // Order-linked cash out this month — shown separately, NEVER in the P&L figure.
  const orderLinked = sum(paidIn(ol, monthStart, monthEnd), amt);

  const gstReclaim = sum(opThis, o => gstCredit(amt(o), !!o.gst_claimable));

  // ── Forward-looking, unpaid, off the DUE date, at gross ──
  const isOpen = (o) => o.status !== 'paid' && o.status !== 'cancelled' && o.status !== 'skipped';
  const overdue = sum(op.filter(o => o.status === 'overdue'), amt);
  const due     = sum(op.filter(o => o.status === 'due'), amt);
  const unpaid  = overdue + due;
  const upcoming30 = sum(
    op.filter(o => isOpen(o) && inRange(toMs(o.due_date ?? o.date), next30Start, next30End)),
    amt
  );

  const breakdown = categoryBreakdown(opThis, { operatingOnly: true, paidOnly: true, netted: true });
  const largestCategory = breakdown.length ? breakdown[0] : null;

  const recurringMonthly = recurringMonthlyCommitment(recurringTemplates);

  // Both sides ex-GST: pnl.revenue is ex-GST and `thisMonth` is GST-netted.
  const expenseToRevenuePct = (Number.isFinite(revenueThisMonth) && revenueThisMonth > 0)
    ? (thisMonth / revenueThisMonth) * 100
    : null;

  return {
    thisMonth, thisMonthGross, lastMonth, pctChange,
    paid: thisMonth, unpaid, overdue, due, upcoming30,
    gstReclaim, orderLinked,
    recurringMonthly, largestCategory, expenseToRevenuePct,
  };
}

try {
  if (typeof window !== 'undefined') {
    window.ExpenseMath = {
      GST_FRACTION_OF_GROSS, pnlCost, gstCredit, isPaid, cashMs, monthlyCommitment,
      recurringMonthlyCommitment, categoryBreakdown, bucketExpenses, computeExpenseKpis,
    };
  }
} catch (_) { /* non-fatal */ }
