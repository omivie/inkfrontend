# Backend asks — 2026-11-25 — admin Dashboard numbers and speed

From FE. The owner is rebuilding the admin Dashboard because its numbers are wrong and it is slow. Each section is
one ask. Until a section ships, the new dashboard corrects that number itself and labels it "adjusted on this
screen". When you ship a section, tell us which one: we delete the matching FE adjustment. Delete a section here once
it is answered and verified live.

All figures were measured on 2026-11-25 with GET requests only, as the owner, against the API the admin uses
(`ink-backend-sg.onrender.com`). Range = October 2026, NZ days (`date_from=2026-10-01&date_to=2026-10-31`).

---

## §1 Invoice shadow orders carry the wrong date (bug)

**Measured:** `GET /api/admin/orders?date_from=2026-10-01&date_to=2026-10-31` returns 8 `channel:'invoice'` orders.
`GET /api/admin/invoices` has only 7 invoices with an October `issue_date`.

| Invoice | `issue_date` (invoices list) | shadow order `created_at` | total |
|---|---|---|---|
| INV-3298 | **2026-11-22** | **2026-10-01T00:00:00+00:00** | 195.99 |
| INV-3284 | 2026-10-02 | 2026-10-01T00:00:00+00:00 | 195.99 |

**Effect:** kpi-summary October `invoice_revenue` = 1270.26 (8 invoices). By issue date it should be 1074.27
(7 invoices). October revenue is $195.99 too high, and November is $195.99 too low. INV-3298 has the same amount and
cost as INV-3284 and INV-3263, so it was probably created from an earlier one, and the shadow order kept the old date.

**Ask:**
1. Date every invoice shadow order by the invoice's `issue_date` as an NZ calendar day. Re-sync the shadow order when
   the issue date is edited.
2. Backfill the existing shadow orders.
3. Owner rule (accrual): an invoice's revenue AND cost of goods count on its issue date, paid or not.

---

## §2 kpi-summary and pnl disagree for the same month

| October 2026 | kpi-summary `current` | pnl period `2026-10` |
|---|---|---|
| revenue | 6073.14 | 6019.65 |
| orders | 53 | 52 |
| gross_profit | 1443.94 | 1413.43 |
| supplier_freight | 414.80 | 395.67 |
| net_profit | −2584.67 | −2594.56 |

The Dashboard reads kpi-summary and Financial Health reads pnl, so the owner sees two different Octobers.
We believe pnl buckets months by UTC and kpi-summary by NZ day (migration 212), but we have not verified this.

**Ask:** make pnl bucket by NZ calendar month, the same rule as kpi-summary. Both must return identical totals for a
whole NZ month.

**Also:** the dashboard-bundle `net_profit_series` and kpi-summary disagree for the same range. For
2026-10-26..2026-11-25 the series adds up to −1630.67 but kpi-summary `net_profit` is −1620.01 (gap 10.66). They
should be equal.

---

## §3 Subtract refunds from revenue (definition change, owner 2026-11-25)

Today every status except `cancelled` counts in revenue, including `refunded`. October had 2 refunds totalling
$84.49 (`refunds-series` → `reasons[0].amount`), and revenue still includes them.

**Measured:** `refunds-series` counts a PENDING refund (2026100901, $14.00, pending since 14 Oct) and dates refunds by
`created_at`. Refund 2026091503 ($70.49) has `refunded_at` 2026-09-17 but `created_at` 2026-10-25, so the series puts it
in October. The owner counts only PROCESSED refunds, on the day the money went back.

**Ask:**
1. Revenue, gross profit and net profit subtract PROCESSED refunds, dated on `refunded_at` (NZ day). Goods are not
   restocked (owner), so the whole ex-GST refund comes off profit.
2. Document whether `refunds-series` `total_amount` is incl- or ex-GST.
3. Say whether a refund puts the goods back into stock (so cost of goods reverses) or not.
4. Return `refunds` (amount) on kpi-summary `current`/`previous`, in the SAME deploy that starts subtracting them.
5. Only subtract refunds (and chargebacks) on orders the revenue counted: never one on a cancelled or test order.
6. Add `order_status` to `/api/admin/refunds` rows. The FE currently looks up each refund's order to check this.

---

## §4 Operating expenses: count by expense date, paid or not (definition change, owner 2026-11-25)

Today `operating_expenses` = PAID expenses on their `paid_date` (`summary.operating_paid`). The owner wants accrual:
an expense counts on its `expense_date` whether it is paid or not. This matches how invoices already count
(paid or not).

**Ask:** kpi-summary, pnl and dashboard-bundle `operating_expenses` = operating expenses by `expense_date`, all
statuses except deleted. Keep `operating_paid` on `/expenses/summary` for cash-flow.

---

## §5 GST payments to IRD are not an operating expense

The expense "G.S.T" $724.51 (2026-10-20, category `other`) is the GST return payment to IRD. It is subtracted from
October net profit. Revenue and profit are already ex-GST, so paying the GST we collected is not a cost.

**Ask:** add a built-in expense category `gst_payment` ("GST / tax payment to IRD") that is excluded from
`operating_expenses` everywhere, like the `order_linked` categories. The owner will move the existing G.S.T rows
into it. Until you ship this, the FE excludes that category itself.

---

## §6 One fast dashboard endpoint (speed)

**Measured cold load of the current dashboard:**
- Money boxes appear after 17.0 s. 147 requests total; the last one finishes at 41.5 s.
- `traffic/timeseries` for 2026-03-14..2026-11-25 took 10.0 s.
- 4 analytics calls hit 429 and retried after 5 s (the analytics limiter is 20/min per user).
- About 120 of the 147 requests are `GET /api/admin/orders/:id`. They are the FE's "sales missing a cost" scan,
  which exists because kpi-summary drops `gross_profit`/`net_profit` for some ranges that contain an invoiced
  sale (ERR-074).

**Ask:** `GET /api/admin/analytics/dashboard-summary?date_from&date_to&granularity` returning, in one call:
- money for `current` and `previous`, using the definitions in §1, §3, §4 and §5: `revenue_incl_gst`,
  `revenue_ex_gst`, `refunds`, `cogs`, `gross_profit`, `stripe_fees`, `supplier_freight`, `operating_expenses`,
  `net_profit`, `orders`, `aov`, `owed_unpaid_invoices`. Each figure must be returned even when some sales have
  no cost: return `cogs_unknown_orders: [{order_id, order_number, skus}]` instead of dropping the profit figures;
- the revenue / gross profit / net profit series for the main graph;
- action counts and their rows: orders needing tracking, sales missing a cost (replaces the 120-request scan),
  products under the margin floor, out-of-stock products.

The new dashboard then needs one call to show the money boxes instead of about 15. Also, please check why
`traffic/timeseries` takes 10 s for an 8-month range.
