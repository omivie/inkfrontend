# Backend asks — 2026-11-26 — still open after your 26 Nov reply

From FE. Thank you for `bc40b01` (migration 221): §1–§6 of this file are answered by
`inbox/backend-asks-2026-11-26-dashboard-followup-backend-response.md` and verified live on 2026-11-26 —
`npm run probe:backend-26nov` 26/27 and `npm run probe:supplier-freight` all green (194 Augmento consignments follow
"billed only under $100 incl GST"; order 2026112601 now takes home $40.95). The answered sections are deleted here.

**One section is not covered by your reply** — §7, which was added to this file late on 2026-11-26 (possibly after
the copy you worked from). It is resent below unchanged except for today's re-measurement.

**Re-measured 2026-11-26 after `bc40b01`:** INV-3275's shadow order still has `items_count: 0`,
`cost_complete: false`; August dashboard-summary still lists it in `cogs_unknown_orders` (gross 2379.94,
net −69.34). `probe:backend-26nov` §7 FAILs on it by design until this ships.

---

## §7 Invoice lines with no product never reach the sales record, so their cost is invisible

**Measured 2026-11-26 (GET only).** INV-3275 (28 Aug 2026, Michael Wright, $98.34 incl GST, paid) has one line:
"Freight & delivery", $85.51 ex GST, `product_code: ""`, `product_ref: null`. The owner explains it as extra
shipping the customer had to pay, passed straight through, so on 2026-11-26 its "Our Cost" was set to **$85.51**
(`supplier_cost_excl_gst: 85.51`, `cost_source: manual`; invoice `cost_excl_gst` 85.51, profit $0.00, read back
after saving).

Its shadow order (`INV-3275`, `channel: invoice`) still has **0 items** and `cost_complete: false`. So:
- `dashboard-summary` lists INV-3275 in `cogs_unknown_orders`, and every range containing 28 Aug shows profit as
  "AT MOST";
- kpi-summary and pnl return `gross_profit`/`net_profit` **null** for any such range (pnl period `2026-08`, the
  365-day totals);
- the $85.51 we paid is not counted at all, so August profit is **overstated by $85.51** in every figure that does
  count it.

The likely cause: `sync_invoice_shadow_order` copies only lines that resolve to a product. A freight, service or
labour line has none, so it never becomes an order item, and its cost is never seen.

**Ask:** copy every invoice line into the shadow order, including lines with no product, carrying the line's own
`supplier_cost_excl_gst` as its cost snapshot. Alternatively, count the invoice's `cost_excl_gst` for invoice-channel
orders. INV-3275 then counts $85.51 of cost, leaves `cogs_unknown_orders`, and stops blanking profit for August and
every longer range. Please also check whether any other invoice has a product-less line.
