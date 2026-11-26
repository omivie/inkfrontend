# Backend response: FE asks 2026-11-25 (admin Dashboard numbers and speed)

The status of each ask is below. Every section ships in ONE deploy, together with migrations 218, 219 and 220. Delete your matching "adjusted on this screen" correction only after that deploy is live and you have checked the figure. Section 4 of this file gives the live-check figures.

All money ranges are NZ calendar days (`Pacific/Auckland`), inclusive at both ends.

## §1 Invoice shadow orders dated by `issue_date`: shipped

- A shadow order's `created_at` is now **00:00 UTC on the invoice's `issue_date`**. That is 12:00 or 13:00 in NZ, so the date is the same in both zones. NZ-day analytics, the UTC-bounded `GET /api/admin/orders?date_from&date_to`, and cashflow therefore all place the invoice on its issue date. `order_date` is no longer read.
- **Edits re-sync.** Creating or updating an invoice calls `sync_invoice_shadow_order`, so a changed `issue_date` moves its shadow order.
- **Backfill.** 13 shadow orders are re-dated: 12 carry revenue, and the 13th is the voided INV-3264, which has no revenue effect. Six of them change month:

  | Invoice | Amount | Month moves |
  |---|---|---|
  | INV-3268 | 249.55 | Jul → Aug |
  | INV-3269 | 150.79 | Jul → Aug |
  | INV-3272 | 966.00 | Aug → Sep |
  | INV-3274 | 685.49 | Aug → Sep |
  | INV-3277 | 1325.95 | Aug → Sep |
  | INV-3298 | 195.99 | Oct → Nov |

  The totals for July to November history therefore change. October `invoice_revenue` becomes 1074.27 (7 invoices).
- **Accrual.** An invoice's revenue and cost of goods count on its issue date, paid or not.

## §2 One P&L definition everywhere: shipped

kpi-summary, `/pnl`, the dashboard-bundle `gross_profit_series`/`net_profit_series`, and the new dashboard-summary all compute money with one definition. kpi-summary runs it in SQL; the other three share the Node module `src/utils/pnlLedger.js`. Tests pin the two against each other. For the same range they return the same figures.

- **Orders counted.** Orders created on that NZ day, with `is_test_order = false`. The status must be a revenue status or `refunded`. Web orders with no lines are excluded.
- **`/pnl`** buckets by NZ calendar day, week or month. A whole NZ month equals kpi-summary for that month.
- **Series sum.** The bundle `net_profit_series` sums to kpi-summary `net_profit`. The 10.66 gap came from refunded order 2026110601, which the series dropped while kpi kept it.
- **Shape change on `/pnl`.** `date_range` is now `{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', timezone: 'Pacific/Auckland' }`, and empty periods are zero-filled. Period keys (`2026-10`, …) are unchanged. Send `start_date` and `end_date` as plain `YYYY-MM-DD`. A timestamp such as `2026-10-31T23:59:59Z` is read as its NZ day, which is 2026-11-01.
- **Cost unknown.** A sale with no cost (no cost on a line, or a non-web order with no lines) is listed rather than silently counted at $0. kpi-summary drops `gross_profit`/`net_profit` for such a range, as it did before. dashboard-summary returns every figure plus `cogs_unknown_orders` (see §6). Known case: **INV-3275** (2026-08-28, no lines). Any range containing August 2026 is cost-unknown until that invoice gets its lines. As a result, `/pnl` period `2026-08` and the default 365-day totals return `null` for cogs, gross and net.

## §3 Refunds: shipped

1. **Subtraction.** Revenue, gross profit and net profit subtract **processed** refunds and chargebacks, dated on `refunded_at` (NZ day). The full ex-GST amount (`amount / 1.15`) comes off. Cost of goods is not reversed.
2. **`refunds-series` `total_amount`** is **incl-GST**. The series now counts processed refunds only, dated by `refunded_at`. Refund 2026091503 ($70.49) therefore sits in September, and the pending $14.00 refund 2026100901 is not counted.
3. **Restock.** A refund does **not** restock in either of these cases:
   - a refund after dispatch;
   - any partial refund. It is logged, and the order status does not change.

   The admin refund update never restocks. The one exception is a **full refund before dispatch**, which cancels the order and restores its stock. That order is then `cancelled`: it drops out of revenue entirely, and its refund is not subtracted a second time.
4. **kpi-summary.** It returns `refunds: { current, previous }` in this same deploy. The amount is **incl-GST**, the same basis as `revenue`, which is now sales minus refunds, both incl-GST. The RPC also returns `refunds_ex_gst`. The fallback path returns `refunds` too. In dashboard-summary, `refunds` is likewise incl-GST.
5. **Cancelled and test orders.** A refund or chargeback on a cancelled or test order is never subtracted.
6. **`GET /api/admin/refunds`.** Each row now carries `order_status`.

## §4 Operating expenses on accrual: shipped

`operating_expenses` on kpi-summary, `/pnl`, the dashboard bundle and dashboard-summary is now counted on `expense_date`, paid or not.

- **Excluded:** deleted and cancelled rows, the `order_linked` categories, and `gst_payment`.
- **Recurring expenses** count their recorded occurrences. Today there are no recurring templates, so this has no effect.
- `/expenses/summary` keeps `operating_paid` (paid on `paid_date`, for cash flow). It now leaves out `gst_payment` too.

## §5 `gst_payment` category: shipped

A built-in category `gst_payment` ("GST / tax payment to IRD"). It is excluded from `operating_expenses` everywhere and from `operating_paid`.

**Order of steps:**
1. The owner moves the existing "G.S.T" row ($724.51, 2026-10-20, now `other`) into `gst_payment` right after the deploy.
2. Only after that, delete your FE exclusion.

Until the row is moved, October `operating_expenses` reads 3491.40 instead of 2766.89.

## §6 `GET /api/admin/analytics/dashboard-summary`: shipped

The endpoint requires `requireAdmin` and is limited to 60/min.

**Query parameters:**
- `date_from` and `date_to`: `YYYY-MM-DD`, NZ days.
- `granularity`: `day`, `week` or `month`. The default is `day`.

**Response:**

```
{
  date_range:     { date_from, date_to, granularity, timezone: 'Pacific/Auckland' },
  previous_range: { date_from, date_to },          // same length, immediately before
  current / previous: {
    revenue_incl_gst, revenue_ex_gst, refunds, cogs, gross_profit, stripe_fees,
    supplier_freight, operating_expenses, net_profit, orders, aov,
    owed_unpaid_invoices,                          // incl-GST, unpaid invoices issued on or before date_to
    cogs_unknown_orders: [{ order_id, order_number, skus }]
  },
  series: [{ bucket_start, revenue, gross_profit, net_profit }],   // revenue is incl-GST
  actions: {
    needs_tracking:     { count, rows },   // paid/processing, not invoice/test, no tracking number
    missing_cost:       { count, rows },   // = current.cogs_unknown_orders (replaces the 120-request scan)
    under_margin_floor: { count, rows },   // sorted by gap, largest first
    out_of_stock:       { count, rows }    // active, stock 0, admin-only rows excluded
  },
  supplier_freight_failed: boolean
}
```

**Notes:**
- Each action list returns at most 50 rows; `count` is the full count. If one list fails, it returns `{ count: null, rows: [], error: 'unavailable' }` and the money figures still load.
- In `current` and `previous`, every figure is returned even when some sales have no cost. Those sales are listed in `cogs_unknown_orders`.
- For a past window, `previous.owed_unpaid_invoices` is approximate: invoices have no paid date, so it uses today's unpaid set as issued by that date.

**`traffic/timeseries` speed.** The endpoint used to load every event row into Node. It is now aggregated in SQL (migration 220): the 8-month range took about 10 s before, and the query now takes about 0.2–0.4 s. Buckets are now **NZ days** (hour buckets are NZ hours), where before they were UTC.

## Live-check figures (October 2026, after deploy and after the G.S.T row is moved)

| | |
|---|---|
| orders | 52 |
| revenue incl GST | 5877.15 |
| refunds | 0 |
| revenue ex GST | 5110.57 |
| COGS | 3697.25 |
| Stripe fees | 122.41 |
| operating_expenses | 2766.89 |
| invoice revenue | 1074.27 (7 invoices) |

For 2026-10-26..2026-11-25: sales incl GST before refunds 6491.60, refunds 59.40 (so kpi `revenue` = 6432.20), revenue ex GST 5593.22, COGS 4942.07.
