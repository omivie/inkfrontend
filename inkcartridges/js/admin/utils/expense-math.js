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

/** Cash date used for cash-basis placement: paid date if paid, else the expense date. */
function cashMs(o) {
  const paid = toMs(o.paid_date);
  if (o.paid && Number.isFinite(paid)) return paid;
  return toMs(o.expense_date ?? o.date);
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
 * Category breakdown (largest first). Operating-only by default so it feeds the
 * "where is our money going" chart without the double-counted order-linked lines.
 */
export function categoryBreakdown(list, { operatingOnly = true } = {}) {
  const totals = new Map();
  for (const o of (list || [])) {
    if (operatingOnly && !isOperating(o)) continue;
    const key = o.category || 'other';
    totals.set(key, (totals.get(key) || 0) + amt(o));
  }
  return [...totals.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Bucket operating-expense amounts over time for the trend chart. grain is
 * 'day' | 'week' | 'month'. Buckets are keyed by cash date (cash-basis). Returns
 * ordered [{ key, startMs, total }] covering [fromMs, toMs].
 */
export function bucketExpenses(list, fromMs, toMs, grain = 'month') {
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
    const ms = cashMs(o);
    if (!inRange(ms, fromMs, toMs)) continue;
    const k = keyOf(ms);
    buckets.set(k, (buckets.get(k) || 0) + amt(o));
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
 * The headline KPI bundle. All operating-only where it concerns profit / spend;
 * order-linked is reported separately so it's visible but never double-counted.
 *
 * opts: {
 *   monthStart, monthEnd, prevStart, prevEnd,   // ms bounds (UTC)
 *   next30Start, next30End,                      // ms bounds for upcoming cash
 *   revenueThisMonth,                            // Number|null (ex/undefined → ratio null)
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

  // This-month vs last-month operating spend, by expense date (incurred).
  const inMonth = (o, a, b) => inRange(toMs(o.expense_date ?? o.date), a, b);
  const thisMonth = sum(op.filter(o => inMonth(o, monthStart, monthEnd)), amt);
  const lastMonth = sum(op.filter(o => inMonth(o, prevStart, prevEnd)), amt);
  const pctChange = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100
                  : (thisMonth > 0 ? null : 0); // null = "no prior baseline"

  // Status-based totals across the loaded window.
  const paid    = sum(op.filter(o => o.status === 'paid'), amt);
  const overdue = sum(op.filter(o => o.status === 'overdue'), amt);
  const unpaid  = sum(op.filter(o => o.status === 'overdue' || o.status === 'due'), amt);

  // Upcoming cash requirement — unpaid operating occurrences DUE in the next 30d
  // (projected + real). Uses due date, never mixed with paid spend.
  const upcoming30 = sum(
    op.filter(o => o.status !== 'paid' && o.status !== 'cancelled' && o.status !== 'skipped'
                   && inRange(toMs(o.due_date ?? o.date), next30Start, next30End)),
    amt
  );

  const operating    = sum(op, amt);
  const operatingPnl = sum(op, o => pnlCost(amt(o), !!o.gst_claimable));
  const gstReclaim   = sum(op, o => gstCredit(amt(o), !!o.gst_claimable));
  const orderLinked  = sum(ol, amt);

  const breakdown = categoryBreakdown(op, { operatingOnly: true });
  const largestCategory = breakdown.length ? breakdown[0] : null;

  const recurringMonthly = recurringMonthlyCommitment(recurringTemplates);

  const expenseToRevenuePct = (Number.isFinite(revenueThisMonth) && revenueThisMonth > 0)
    ? (thisMonth / revenueThisMonth) * 100
    : null;

  return {
    thisMonth, lastMonth, pctChange,
    paid, unpaid, overdue, upcoming30,
    operating, operatingPnl, gstReclaim, orderLinked,
    recurringMonthly, largestCategory, expenseToRevenuePct,
  };
}

try {
  if (typeof window !== 'undefined') {
    window.ExpenseMath = {
      GST_FRACTION_OF_GROSS, pnlCost, gstCredit, monthlyCommitment,
      recurringMonthlyCommitment, categoryBreakdown, bucketExpenses, computeExpenseKpis,
    };
  }
} catch (_) { /* non-fatal */ }
