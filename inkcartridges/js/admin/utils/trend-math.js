/**
 * trend-math.js — pure math helpers for the dashboard Revenue & Expenses chart.
 *
 * The Trends bucket builder in pages/dashboard.js orchestrates the data sources
 * (KPI summary, P&L, raw orders, logged expenses) but the actual math lives
 * here so it can be unit-tested in isolation. The chart MUST reflect every
 * dollar that left the company in a window — COGS, operating expenses, Stripe
 * fees, and GST remitted — so each helper is named after the loss line it
 * builds.
 *
 * Conventions (revised by user 2026-05-12, see project_profit_calc.md):
 *   - Order totals on this dashboard are gross (incl-GST). Output GST embedded
 *     in a gross sale = gross × 3/23.
 *   - Cost is grossed up by 1.15 since we pay the supplier incl-GST.
 *   - Stripe NZ domestic card = gross × 2.65% + $0.30 per transaction, ALL
 *     multiplied by 1.15 (Stripe charges 15% GST on its fee; treat as cash
 *     outflow). Fee base on this dashboard is bucket gross revenue (already
 *     incl-GST + shipping per `o.total`).
 *
 * COGS source-of-truth (set by user 2026-05-08, formula corrected 2026-05-16):
 *   - Backend /api/admin/analytics/pnl rarely populates per-period cogs.
 *   - The KPI summary RPC (analytics_kpi_summary) reliably returns `revenue`
 *     (GROSS, incl-GST) and `gross_profit` for the visible window.
 *   - `gross_profit` follows the canonical profitability.js convention:
 *         gross_profit = revenue_ex_gst − cost_incl_gst
 *     so the incl-GST cost is recovered WITHOUT any further gross-up:
 *         cost_incl_gst = revenue_ex_gst − gross_profit
 *                       = (revenue_gross / 1.15) − gross_profit
 *   - That total COGS is distributed across buckets in proportion to each
 *     bucket's revenue. Totals match exactly; per-bucket shape mirrors the
 *     revenue shape (best approximation absent a daily-cost-series RPC).
 *
 * Operating expenses source-of-truth:
 *   - /api/admin/analytics/expenses returns manually-logged spend with a date
 *     field. Each row is bucketed at the date it happened so a 3 May supplier
 *     purchase shows on 3 May, not smeared across the month.
 */

export const STRIPE_RATE_DERIVE  = 0.0265;
export const STRIPE_FIXED_DERIVE = 0.30;
export const STRIPE_FEE_GST_DERIVE = 0.15;
export const GST_FRACTION_OF_GROSS = 3 / 23;
export const COST_GST_GROSS_UP = 1.15;

// Order statuses that never produced a cleared card charge: `pending` is not
// yet paid, the rest never collected. The bulk /orders endpoint returns every
// status but analytics_kpi_summary counts sales only — filtering raw orders
// through `isRevenueOrder` keeps the dashboard's order tally + Stripe
// fixed-fee derivation consistent with the KPI summary.
export const NON_REVENUE_ORDER_STATUSES = ['pending', 'cancelled', 'failed', 'abandoned'];

export function isRevenueOrder(order) {
  const s = String(order?.status || '').toLowerCase();
  return !NON_REVENUE_ORDER_STATUSES.includes(s);
}

// Pick a date string off an expense row. Backend keys vary, so we try the
// canonical names in order.
export function pickExpenseDate(row) {
  return row?.expense_date || row?.date || row?.created_at || row?.createdAt || null;
}

export function pickExpenseAmount(row) {
  const v = row?.amount ?? row?.total ?? row?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Dollar value of a refund-series row. The analytics_refunds_series source
// (the direct RPC and the /api/admin/analytics/refunds-series HTTP wrapper)
// keys the daily refund total as `total_amount` — older/ad-hoc refund shapes
// use amount/total/value. Reading only the latter silently summed every refund
// to $0 (refunds-series carries no `amount` field), so the Refund-Rate KPI and
// both refund cards always read 0%. `total_amount`/`refund_amount` come first
// so the canonical series field wins; the legacy keys remain as fallbacks.
export function refundAmount(row) {
  const v = row?.total_amount ?? row?.refund_amount ?? row?.amount ?? row?.total ?? row?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Recurring-expense expansion.
//
// A row may carry a `recurrence` string ('weekly' | 'monthly' | 'yearly' |
// 'custom'). For each visible window we synthesise one virtual occurrence per
// fire-date so downstream bucketing can treat everything as a flat list of
// dated transactions. One-off rows pass through unchanged. The actual cash-out
// day is honoured exactly — no smearing, ever.
//
// Schema additions (all optional; missing → one-off):
//   recurrence              : 'none' | 'weekly' | 'monthly' | 'yearly' | 'custom'
//   recurrence_day_of_week  : 0..6   (Sun=0)            — weekly
//   recurrence_day_of_month : 1..31  (clamped to month) — monthly | yearly
//   recurrence_month        : 1..12                     — yearly
//   recurrence_interval_days: int ≥ 1                   — custom
//   recurrence_end          : ISO date | null           — cancellation day
//
// `date` (or expense_date / created_at — see pickExpenseDate) is the start.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function parseDateMs(v) {
  if (v == null) return NaN;
  const ts = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ts) ? ts : NaN;
}

function daysInMonth(year, monthIdx0) {
  return new Date(year, monthIdx0 + 1, 0).getDate();
}

function isoDateFromMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emit(row, fireMs) {
  // Strip the recurrence keys so each occurrence looks like a one-off to the
  // bucketer (and so a bug downstream can't accidentally re-expand it).
  const {
    recurrence: _r,
    recurrence_day_of_week: _dw,
    recurrence_day_of_month: _dm,
    recurrence_month: _mo,
    recurrence_interval_days: _ci,
    recurrence_end: _re,
    ...rest
  } = row;
  return { ...rest, expense_date: isoDateFromMs(fireMs), recurrence_origin_id: row.id ?? null };
}

export function expandRecurringExpenses(rows, windowStartMs, windowEndMs) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  const winStart = Number.isFinite(windowStartMs) ? windowStartMs : -Infinity;
  const winEnd   = Number.isFinite(windowEndMs)   ? windowEndMs   :  Infinity;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const recurrence = row.recurrence;
    const startMs = parseDateMs(pickExpenseDate(row));
    const endMs = parseDateMs(row.recurrence_end);
    const stopAt = Math.min(winEnd, Number.isFinite(endMs) ? endMs : winEnd);

    if (!recurrence || recurrence === 'none') {
      // One-off: pass through if it has any usable date. Bucketer drops out-of-window.
      out.push(row);
      continue;
    }
    if (!Number.isFinite(startMs)) continue; // recurring without a start is meaningless

    if (recurrence === 'weekly') {
      const target = Number(row.recurrence_day_of_week);
      if (!Number.isInteger(target) || target < 0 || target > 6) continue;
      // Walk forward from start to first matching weekday.
      const first = new Date(startMs);
      const shift = (target - first.getUTCDay() + 7) % 7;
      let fire = startMs + shift * ONE_DAY_MS;
      while (fire <= stopAt) {
        if (fire >= winStart) out.push(emit(row, fire));
        fire += 7 * ONE_DAY_MS;
      }
      continue;
    }

    if (recurrence === 'monthly' || recurrence === 'yearly') {
      const targetDom = Number(row.recurrence_day_of_month);
      if (!Number.isInteger(targetDom) || targetDom < 1 || targetDom > 31) continue;
      const targetMonth = recurrence === 'yearly' ? Number(row.recurrence_month) : null;
      if (recurrence === 'yearly' && (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12)) continue;

      const startDate = new Date(startMs);
      let year = startDate.getUTCFullYear();
      let monthIdx0 = recurrence === 'yearly' ? (targetMonth - 1) : startDate.getUTCMonth();

      // For yearly, advance year if first candidate is before start.
      if (recurrence === 'yearly') {
        const firstCandidate = Date.UTC(year, monthIdx0, Math.min(targetDom, daysInMonth(year, monthIdx0)));
        if (firstCandidate < startMs) year += 1;
      }

      // Cap iterations defensively (window can't reasonably span more than a few decades of months).
      for (let i = 0; i < 1200; i++) {
        const dom = Math.min(targetDom, daysInMonth(year, monthIdx0));
        const fire = Date.UTC(year, monthIdx0, dom);
        if (fire > stopAt) break;
        if (fire >= startMs && fire >= winStart) out.push(emit(row, fire));
        if (recurrence === 'monthly') {
          monthIdx0 += 1;
          if (monthIdx0 > 11) { monthIdx0 = 0; year += 1; }
        } else {
          year += 1;
        }
      }
      continue;
    }

    if (recurrence === 'custom') {
      const interval = Number(row.recurrence_interval_days);
      if (!Number.isInteger(interval) || interval < 1) continue;
      const stepMs = interval * ONE_DAY_MS;
      let fire = startMs;
      // Cap at 4096 iterations to avoid pathological intervals.
      for (let i = 0; fire <= stopAt && i < 4096; i++) {
        if (fire >= winStart) out.push(emit(row, fire));
        fire += stepMs;
      }
      continue;
    }
    // Unknown recurrence value → treat as one-off so we don't lose the row.
    out.push(row);
  }
  return out;
}

// Sum logged operating expenses into the bucket their date falls into.
// `indexFor(ms)` is the caller-supplied date→bucket-index map; returns -1 for
// dates outside the window.
export function bucketOperatingExpenses(buckets, expenseRows, indexFor) {
  const rows = Array.isArray(expenseRows) ? expenseRows : [];
  for (const row of rows) {
    const raw = pickExpenseDate(row);
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (isNaN(ts)) continue;
    const i = indexFor(ts);
    if (i < 0) continue;
    buckets[i].opexLogged += pickExpenseAmount(row);
    buckets[i].hasOpexLogged = true;
  }
  return buckets;
}

// Distribute total COGS across buckets in proportion to each bucket's revenue.
// Mutates `buckets[].cogsDerived`. No-op if revenue is zero or COGS is invalid.
//
// IMPORTANT: callers must pass `totalCogs` already in incl-GST terms (real
// cash to suppliers). Use `kpiCogsInclGst` below to derive it from the KPI
// summary — that helper already returns the incl-GST figure, so no further
// gross-up is applied here.
export function distributeCogsByRevenue(buckets, totalCogs) {
  if (!Number.isFinite(totalCogs) || totalCogs <= 0) return buckets;
  const totalRev = buckets.reduce((s, b) => s + (b.revenue || 0), 0);
  if (totalRev <= 0) return buckets;
  for (const b of buckets) {
    const share = (b.revenue || 0) / totalRev;
    b.cogsDerived = totalCogs * share;
  }
  return buckets;
}

// Compute total COGS (incl-GST, real cash to suppliers) from the KPI summary.
//
// The KPI summary RPC reports `revenue` GROSS (incl-GST) and `gross_profit`
// per the canonical profitability.js convention:
//     gross_profit = revenue_ex_gst − cost_incl_gst
// So the incl-GST cost is recovered by taking revenue back to its ex-GST base
// and subtracting gross profit — NO further gross-up:
//     cost_incl_gst = revenue_ex_gst − gross_profit
//                   = revenue_gross × (1 − 3/23) − gross_profit
// (1 − 3/23 = 20/23 = 1/1.15.)
//
// Bug fixed 2026-05-16: this previously did `(revenue − gross_profit) × 1.15`.
// But `revenue_gross − gross_profit` already equals `output_GST + cost_incl_gst`
// (substitute the convention above), so the × 1.15 inflated COGS by ~38% — the
// chart showed $873.59 of COGS where the true figure was $583.02.
export function kpiCogsInclGst(kpiRevenue, kpiGrossProfit) {
  // null/undefined ⇒ "unknown", not zero. Number(null) is 0 (a finite value),
  // so without this explicit check a null gross_profit would slip past the
  // isFinite guard below and make COGS equal the ENTIRE ex-GST revenue. That
  // matters on the order-derived KPI fallback, where gross_profit is null
  // whenever the orders lack supplier-cost data.
  if (kpiRevenue == null || kpiGrossProfit == null) return 0;
  const rev = Number(kpiRevenue);
  const gp  = Number(kpiGrossProfit);
  if (!Number.isFinite(rev) || !Number.isFinite(gp)) return 0;
  const revenueExGst = rev * (1 - GST_FRACTION_OF_GROSS);
  return Math.max(0, revenueExGst - gp);
}

// Sum cost (incl-GST cash to supplier) for a single order's line items.
// Each item's supplier_cost_snapshot is stored ex-GST per profitability.js;
// gross-up by 1.15 since we paid the supplier incl-GST. Returns 0 when items
// are missing or have no cost data — caller falls back to KPI distribution.
export function orderCostInclGst(order) {
  if (order == null) return 0;
  const items = Array.isArray(order.items) ? order.items : [];
  let totalExGst = 0;
  let sawAnyCost = false;
  for (const it of items) {
    const cost = it?.supplier_cost_snapshot;
    const qty  = it?.qty ?? it?.quantity ?? 0;
    if (cost == null) continue;
    const c = Number(cost);
    const q = Number(qty);
    if (!Number.isFinite(c) || !Number.isFinite(q)) continue;
    totalExGst += c * q;
    sawAnyCost = true;
  }
  // If a backend list endpoint ever ships an aggregated `cost_total_excl_gst`
  // on the order itself, prefer that — saves us from depending on items[]
  // being included in the bulk-list response.
  if (!sawAnyCost) {
    const orderLevel = order.cost_total_excl_gst ?? order.total_cost_excl_gst ?? null;
    if (orderLevel != null && Number.isFinite(Number(orderLevel))) {
      totalExGst = Number(orderLevel);
      sawAnyCost = true;
    }
  }
  return sawAnyCost ? totalExGst * COST_GST_GROSS_UP : 0;
}

// Bucket per-order COGS into the buckets they belong to. Returns the count of
// orders that contributed real cost (so the caller can decide whether to fall
// back to KPI revenue-share distribution for the remaining orders).
export function bucketCogsFromOrders(buckets, rawOrders, indexFor) {
  const orders = Array.isArray(rawOrders) ? rawOrders : [];
  let resolvedCount = 0;
  let resolvedRevenue = 0;
  for (const o of orders) {
    const cost = orderCostInclGst(o);
    if (cost <= 0) continue;
    const ts = Date.parse(o?.created_at || o?.createdAt || '');
    if (isNaN(ts)) continue;
    const i = indexFor(ts);
    if (i < 0) continue;
    buckets[i].cogsFromOrders = (buckets[i].cogsFromOrders || 0) + cost;
    buckets[i].hasOrderCogs = true;
    resolvedCount += 1;
    resolvedRevenue += Number(o?.total || 0);
  }
  return { resolvedCount, resolvedRevenue };
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Per-bucket Stripe fee derived from gross revenue + order count.
// 2.65% × gross + $0.30 × orders, then × 1.15 for the GST Stripe charges on its
// fee (real cash outflow per the 2026-05-12 convention).
export function deriveStripe(revenue, orders) {
  const base = safeNum(revenue) * STRIPE_RATE_DERIVE
             + safeNum(orders)  * STRIPE_FIXED_DERIVE;
  return base * (1 + STRIPE_FEE_GST_DERIVE);
}

// Per-bucket output GST embedded in gross-incl-GST revenue.
export function deriveGst(revenue) {
  return safeNum(revenue) * GST_FRACTION_OF_GROSS;
}

// Final assembly: pick the most authoritative source for each component.
// Order of preference for COGS:
//   1. P&L per-period (forward-compat — backend rarely ships this today)
//   2. Sum of orderCostInclGst per order in the bucket (exact, from items[])
//   3. Revenue-share distribution from kpiCogsInclGst (approximate fallback)
// Mutates the bucket and returns it for chaining.
export function assembleBucketExpense(b) {
  if (b.hasPnlCogs)        b.cogsTotal = b.pnlCogs;
  else if (b.hasOrderCogs) b.cogsTotal = b.cogsFromOrders || 0;
  else                     b.cogsTotal = b.cogsDerived || 0;
  b.opexTotal   = b.hasPnlOpex ? b.pnlOpex : (b.opexLogged || 0);
  b.stripeTotal = b.hasPnlStripe ? b.pnlStripe : deriveStripe(b.revenue, b.orders);
  b.gstTotal    = b.hasPnlGst ? b.pnlGst : deriveGst(b.revenue);
  b.expenses    = b.cogsTotal + b.opexTotal + b.stripeTotal + b.gstTotal;
  b.hasExpense  = b.expenses > 0;
  if (!b.hasNet) b.net = b.revenue - b.expenses;
  return b;
}

// Reconstruct the dashboard KPI "current" block from the raw orders list when
// the analytics_kpi_summary RPC is unavailable.
//
// Why this exists (ERR-010, recurring): the admin dashboard's headline KPI
// cards — Revenue, Orders, Avg Order Value, Gross Profit — are fed entirely by
// the `analytics_kpi_summary` Supabase RPC. That RPC's `GRANT EXECUTE TO
// authenticated` has been dropped by a backend redeploy more than once
// (fixed 2026-05-02, recurred 2026-05-17), and when it is the dashboard shows
// "—" across the whole strip even though the underlying orders are right
// there. The /api/admin/orders REST endpoint is independent of the analytics
// RPCs and keeps working, so the dashboard can self-heal its headline numbers
// instead of going blank.
//
// The returned object is shaped like analytics_kpi_summary's `current` block
// so callers can swap it in transparently:
//   { revenue, orders, gross_profit, _derived: true }
//
//   revenue       Σ o.total over revenue-generating orders. GROSS (incl-GST) —
//                 matches the RPC's convention (see this file's header).
//   orders        count of revenue-generating orders (isRevenueOrder filter,
//                 so pending/cancelled/failed rows don't inflate the tally).
//   gross_profit  Σ(revenue_ex_gst − cost_incl_gst) — but ONLY when every
//                 counted order resolved a real supplier cost. If any order is
//                 missing cost data this is null: a partial cost sum would
//                 understate COGS and overstate profit, and a confident wrong
//                 number is worse than an honest "—".
//   _derived      marker so the UI can flag that these are reconstructed.
//
// Returns null when there are no usable orders at all, so callers can tell
// "RPC down, here are the reconstructed numbers" apart from "RPC down and no
// orders to reconstruct from either".
export function deriveKpisFromOrders(rawOrders) {
  const orders = Array.isArray(rawOrders)
    ? rawOrders
    : (Array.isArray(rawOrders?.orders) ? rawOrders.orders
       : Array.isArray(rawOrders?.data) ? rawOrders.data : []);
  let revenue = 0;
  let count = 0;
  let costInclGst = 0;
  let everyOrderHasCost = true;
  for (const o of orders) {
    if (!isRevenueOrder(o)) continue;
    const total = Number(o?.total ?? o?.amount);
    if (!Number.isFinite(total) || total <= 0) continue;
    revenue += total;
    count += 1;
    const cost = orderCostInclGst(o);
    if (cost > 0) costInclGst += cost;
    else everyOrderHasCost = false;
  }
  if (count === 0) return null;
  const grossProfit = everyOrderHasCost
    ? revenue * (1 - GST_FRACTION_OF_GROSS) - costInclGst
    : null;
  return { revenue, orders: count, gross_profit: grossProfit, _derived: true };
}

// Sum every bucket's component totals so the totals strip shows the same
// picture as the chart bars.
//
// `cogsKnown` rides along: it stays true only while every bucket's COGS is
// known. A single bucket with `cogsKnown === false` poisons the whole strip —
// the totals line cannot claim a real profit when any slice of the window is
// missing its cost of goods. See `cogsIsKnown` for how the flag is set.
export function sumTrendTotals(series) {
  return (series || []).reduce((acc, m) => {
    acc.revenue  += Number(m.revenue || 0);
    acc.expenses += Number(m.expenses || 0);
    acc.cogs     += Number(m.cogsTotal || 0);
    acc.opex     += Number(m.opexTotal || 0);
    acc.stripe   += Number(m.stripeTotal || 0);
    acc.gst      += Number(m.gstTotal || 0);
    acc.orders   += Number(m.orders || 0);
    if (m && m.cogsKnown === false) acc.cogsKnown = false;
    return acc;
  }, { revenue: 0, expenses: 0, cogs: 0, opex: 0, stripe: 0, gst: 0, orders: 0, cogsKnown: true });
}

// Decide whether Cost of Goods Sold is genuinely KNOWN for a trend window —
// as opposed to being legitimately zero, or simply unavailable.
//
// Why this matters: when the analytics RPC is down AND the bulk-orders feed
// carries no per-item supplier cost, the dashboard has no way to value COGS.
// `assembleBucketExpense` then sets `cogsTotal = 0` — but that 0 means
// "unknown", NOT "the goods we sold cost nothing". A profit figure computed
// off that 0 (revenue − Stripe − GST − opex) silently omits the single
// largest cost line and dramatically overstates profit. Callers use this flag
// to refuse a confident profit number — exactly as the KPI strip refuses a
// Gross Profit card when `deriveKpisFromOrders` can't resolve cost.
//
// COGS counts as KNOWN when ANY real source resolved it:
//   - hasPnlCogs    backend P&L shipped a per-period COGS line
//   - hasOrderCogs  at least one order resolved exact cost from its items[]
//   - kpiCogsTotal  the KPI summary's gross_profit yielded a positive cost
// A window with no revenue has no COGS to know, so it is treated as known —
// otherwise an empty date range would raise a spurious "cost missing" warning.
export function cogsIsKnown({
  windowRevenue = 0,
  hasPnlCogs = false,
  hasOrderCogs = false,
  kpiCogsTotal = 0,
} = {}) {
  if (!(Number(windowRevenue) > 0)) return true;
  return Boolean(hasPnlCogs) || Boolean(hasOrderCogs) || Number(kpiCogsTotal) > 0;
}
