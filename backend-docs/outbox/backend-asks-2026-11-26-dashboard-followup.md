# Backend asks — 2026-11-26 — follow-up to your dashboard reply (2026-11-25)

From FE. Thank you: every section of `backend-asks-2026-11-25-dashboard` is live, and the numbers match your
live-check table to the cent. The admin Dashboard now takes all its money from `dashboard-summary`, and every FE
adjustment is deleted. Each section below is one small follow-up found while verifying. Delete a section once
it is answered.

All figures were measured on 2026-11-26 with GET requests only, as the owner, against `api.inkcartridges.co.nz`.
`npm run probe:backend-25nov` (READ-ONLY) re-measures all of them.

---

## Verified (no action needed)

- October 2026 (`dashboard-summary`): orders 52, revenue incl 5877.15, refunds 0, ex 5110.57, COGS 3697.25, Stripe
  122.41, opex 2766.89, net −1890.79. kpi-summary October `invoice_revenue` 1074.27 from 7 invoices.
- 2026-10-26..2026-11-25: revenue 6432.20, refunds 59.40, ex 5593.22, COGS 4942.07.
- dashboard-summary == kpi-summary == pnl (October) on every figure, to the cent.
- All 37 invoice shadow orders carry `created_at` = `issue_date`T00:00Z.
- Refund rows carry `order_status`; refunds-series is processed-only, dated by `refunded_at`.
- `gst_payment` is listed; October `operating_paid` = 2766.89.
- August 2026: dashboard-summary returns gross profit and lists INV-3275 in `cogs_unknown_orders`. The Dashboard
  now shows profit as "AT MOST" and names the sale.

---

## §1 `revenue-series` is still gross of refunds

`GET /api/admin/analytics/revenue-series?date_from=2026-10-26&date_to=2026-11-25` sums to **6491.60**.
kpi-summary `revenue` for the same range is **6432.20**. The difference, 59.40, is the refund processed on 6 Nov.
October agrees (5877.15 both, no refunds that month).

The Analytics → Revenue tab shows the kpi figure in its tile and revenue-series in the chart beside it, so the
chart now reads higher than the tile whenever a refund was processed. The FE labels the chart "sales before
refunds" until this is answered.

**Ask:** either subtract processed refunds (on `refunded_at`) in revenue-series as well, or say that it is meant
to stay sales-before-refunds.

---

## §2 kpi-summary `refund_rate` uses a different definition

kpi-summary `refund_rate` reads **1.9** for October 2026, but no refund was processed in October (refunds-series:
0 of 60; dashboard-summary `refunds` 0). For 2026-10-26..2026-11-25 it also reads 1.9, where there was one
processed refund among 52 orders.

The Dashboard's Refund Rate tile now uses processed refunds in range (refunds-series `refund_count`) ÷
dashboard-summary `orders`: 0.0% for October, 1.9% for the 30 days.

**Ask:** say what `refund_rate` counts (it looks like orders whose status is `refunded`, by order date). If it
should follow the money definition (processed refunds on `refunded_at`), please change it. If not, please name it.

---

## §3 Two action definitions differ from the FE's existing to-dos

- `actions.out_of_stock.count` = **813** (active, stock 0, admin-only excluded). `GET /api/admin/margin/out-of-stock`
  `total_out_of_stock` = **608** (genuine products, feed stock). The Dashboard tile keeps the 608 figure until the
  owner picks one. **Ask:** confirm the difference is genuine vs compatible (or say what it is).
- `actions.under_margin_floor.count` = **4125**, because the floor is each product's pricing rule (first row:
  `margin_floor` 80, `net_margin` 22.35, a compatible ribbon). The FE's low-margin to-do means net margin under 10%,
  so it keeps its own source. No change asked; recorded so nobody wires one to the other by mistake.

---

## §4 Σ daily net profit drifts by rounding

For October, the 31 daily `net_profit` buckets (bundle `net_profit_series` and dashboard-summary `series`) sum to
**−1890.77**; the total is **−1890.79**. Each bucket is rounded on its own. The FE allows ½¢ per bucket and is
fine with it.

**Ask (optional):** if you would rather the buckets sum exactly, carry the rounding remainder into the last
bucket. No FE change depends on it.

---

## §5 `daily-revenue` refuses `days` > 365

`GET /api/admin/analytics/daily-revenue?days=372` answers 400 `"days" must be less than or equal to 365`. The FE
asked for 372 on Financial Health (the result was never used — that call is now deleted) and up to 750 on the
Expenses "vs Revenue" chart (now capped at 365; the chart says where its revenue line stops).

**Ask:** none, unless you want to raise the cap. Recorded so the limit is written down somewhere.
