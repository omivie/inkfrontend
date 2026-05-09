# Dashboard Expense Rebuild — May 2026

The admin dashboard's "Revenue & Expenses" chart was under-counting expenses
by ~$700/month. Root cause: it pulled per-period `cogs`/`operating_expenses`
from `/api/admin/analytics/pnl`, which the backend rarely populates. Stripe
fees and GST were also silently omitted. The chart was essentially a thin
wrapper around three nullable backend fields.

## Decision (2026-05-08)

The chart MUST reflect every dollar that left the company in the visible
window. Stop relying on the broken P&L pipeline; rebuild the expense bar
from data sources that actually work.

Four loss components, four sources:

| Component | Source of truth                          | Fallback                        |
|-----------|------------------------------------------|---------------------------------|
| COGS      | P&L per-period if populated → else `o.items[].supplier_cost_snapshot × qty × 1.15` per order → else `o.cost_total_excl_gst × 1.15` per order | residual `(revenue − gross_profit) × 1.15` from KPI summary, distributed across buckets whose orders weren't resolved exactly |
| Opex      | P&L per-period if populated              | `/api/admin/analytics/expenses`, bucketed at row's `expense_date` |
| Stripe    | P&L per-period if populated              | `revenue × 2.9% + orders × $0.30` |
| GST       | P&L per-period if populated              | `revenue × 3/23` (output GST embedded in gross-incl-GST sale) |

This makes the chart self-healing: every fallback uses data the dashboard
already loads for other tiles, so as long as the KPI summary works the
expense bar is correct.

## Where the math lives

- `inkcartridges/js/admin/utils/trend-math.js` — pure helpers
  (`distributeCogsByRevenue`, `bucketOperatingExpenses`, `assembleBucketExpense`,
  `sumTrendTotals`, `deriveStripe`, `deriveGst`, `orderCostInclGst`,
  `bucketCogsFromOrders`, `kpiCogsInclGst`).
- `inkcartridges/js/admin/pages/dashboard.js` — orchestrates the data
  fetches and calls into trend-math.

## Why the 1.15 gross-up matters (2026-05-08 follow-up)

The KPI summary's `gross_profit` follows the canonical profitability.js
convention: `revenue_ex_gst − cost_incl_gst`. So `revenue − gross_profit`
gives EX-GST cost. But real cash to suppliers is INCL-GST (we pay supplier
+15%). `kpiCogsInclGst()` applies the gross-up.

Symptom of the missing gross-up (now fixed): the user's 4 May order had a
real cost of $228.45 incl-GST but the chart was showing only $208.99 of
total expenses — less than even the supplier cost alone. After the fix the
chart shows ~$285.86 for that bucket (cost incl-GST + Stripe + GST output).

## Per-order COGS (preferred path, 2026-05-08)

When `o.items[]` is included on the bulk-orders endpoint response, the
chart computes COGS exactly per-order:

  `Σ over items of (supplier_cost_snapshot × qty) × 1.15`

This matches the order detail modal exactly and removes the smearing that
revenue-share distribution introduced. For orders without items[] in the
list response, the residual KPI cost is distributed across the un-resolved
buckets only — so the window total still matches the KPI even when only
some orders resolve exactly.

**Backend handoff** (would let the frontend retire the residual fallback):
include either `items[]` or an aggregated `cost_total_excl_gst` on every
row of `GET /api/admin/orders`. Per-order resolution is far more accurate
than revenue-share smearing.

## Where the visual lives

- `inkcartridges/js/admin/pages/dashboard.js::renderTrendTotals` renders
  a horizontal totals strip below the chart with three chips
  (Revenue · Expenses · Profit/Loss) and a stacked bar that flips red on a
  loss.
- CSS in `inkcartridges/css/admin.css` (`.admin-trend-totals*`).
- The strip also renders a gentle hint when zero opex is logged for the
  window: "No operating expenses logged — Add at Finance → Expenses". This
  surfaces the workflow gap that prompted the rebuild: a 3 May supplier
  purchase only shows in the chart if it's logged on the Finance tab.

## What "COGS" means here vs the user's intuition

Important distinction the user hit on 2026-05-08:

- **COGS** (in this chart) = the cost basis of items in customer orders that
  shipped during the window. It's a function of *sales*, not *purchases*.
- **Inventory cash-out** (a supplier purchase) is an *operating expense*. It
  must be logged via Finance → Add Expense (category=cogs, shipping, etc.)
  to be visible in the chart. The chart can't know about cash-out otherwise.

The hint in the totals strip exists to nudge the user toward the right
workflow when their gut says "I spent money today, why don't I see it?"

## Forward-compat: when the backend ships these as P&L lines

If `/api/admin/analytics/pnl` ever populates per-period `cogs`,
`operating_expenses`, `stripe_fees`, or `gst`/`gst_remitted`/`gst_payable`,
the existing code in `dashboard.js::buildTrendSeries` step 3 picks them up
automatically. The frontend always prefers the backend value over the
derived one.

Backend handoff items that would let the frontend retire its fallback math:

1. Per-period `cogs` from order_items × supplier_cost_snapshot, weighted by
   the order's date.
2. Per-period `stripe_fees` from the actual Stripe charge records (gross of
   GST), so we don't have to assume 2.9% + $0.30.
3. Per-period `gst_remitted` (output GST minus input GST credits), so we
   account for input credits on supplier purchases.
4. Per-period `operating_expenses` aggregated from the analytics_expenses
   table, so the dashboard doesn't have to fetch the row list and bucket on
   the client.

## Tests

`tests/dashboard-trend-math.test.js` — 40 tests covering:

- Constants (Stripe rate, GST 3/23, cost gross-up 1.15)
- `deriveStripe` and `deriveGst` against the dashboard fixture
- `distributeCogsByRevenue` proportionality, edge cases (zero rev, NaN cogs)
- `bucketOperatingExpenses` date bucketing, malformed rows, out-of-window dates
- `pickExpenseDate` / `pickExpenseAmount` field-name resolution
- `assembleBucketExpense` source preference (P&L > order-resolved > revenue-share derived) and edge cases
- `sumTrendTotals` summation
- `kpiCogsInclGst` 1.15 gross-up, defensive on NaN/negative inputs
- `orderCostInclGst` per-order line-item summing, qty/quantity field tolerance, order-level field fallback
- `bucketCogsFromOrders` exact per-order bucketing, mixed item-present/absent rows
- **Integration: the user's screenshot** — pins the original regression that
  the previous chart showed only $215.66 of expenses on $1,277.36 revenue.
- **Integration: the user's 4 May order** — pins the 2026-05-08 follow-up
  that the chart was showing $208.99 of expenses for an order whose cost
  incl-GST was $228.45. Asserts the chart now shows ~$285.86 (cost
  incl-GST + Stripe + GST output) and never < $285.

Run: `node --test tests/dashboard-trend-math.test.js`
