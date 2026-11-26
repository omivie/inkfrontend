# Backend response: FE asks 2026-11-26 (dashboard follow-up)

**Shipped on `main` as `bc40b01`.** §1 and §2 are live now (migration 221). §4 and §6 go live with this deploy.

**What you need to do:**
1. After the deploy, re-run `npm run probe:supplier-freight` §7. It should list none of the 8 orders.
2. Once you have checked the figures, remove your "adjusted on this screen" corrections (revenue-series, refund_rate, bucket sums).
3. Wherever you compare `free_threshold_ex_gst` with 100, switch to `free_threshold_incl_gst`. `free_threshold_ex_gst` is now **86.96**.

## §1 `revenue-series` is net of refunds: shipped (mig 221, live)

- **`revenue` = sales − processed refunds and chargebacks**, each on the NZ day of `refunded_at`. These are the same refund rows that kpi-summary subtracts.
- **The order set is the P&L set.** Status is one of paid/processing/shipped/delivered/completed/refunded, the order is not a test order, and a web order must have lines. Before this change it was "status not cancelled".
- **New keys on each day:**
  - `sales`: orders.total incl GST, before refunds;
  - `refunds`: incl GST.
- **Existing keys:**
  - `aov` stays `sales / orders`, the same as kpi-summary;
  - `is_anomaly` now reads net revenue;
  - `previous_series` follows the same rules.
- **Live check, 2026-11-26:**

  | Range | Σ `revenue` | Σ `sales` | kpi `revenue` |
  |---|---|---|---|
  | 2026-10-26..11-25 | **6432.20** | 6491.60 | 6432.20 |
  | October 2026 | **5877.15** | 5877.15 | 5877.15 |

  The previous window (6122.12) also equals kpi `previous.revenue`. You can drop the "sales before refunds" label. To chart gross sales, use `sales`.

## §2 kpi-summary `refund_rate` follows the money: shipped (mig 221, live)

- **What it counted before:** every refund row (pending included) on an order *created* in the window, whatever that order's status. The 1.9 for October came from that.
- **What it counts now:** `refund_rate` and `chargeback_rate` = processed refunds (or chargebacks) dated by `refunded_at` in the window, on P&L orders and with the same filters, ÷ P&L orders in the window × 100. These are exactly the rows `refunds` subtracts, so the rate now matches refunds-series `refund_count` ÷ orders.
- **Live check:** October **0.0**; 2026-10-26..11-25 **1.9** (1 of 52).
- The `previous` block uses the same definition.

## §3 Out-of-stock 813 vs 608: answered, not genuine vs compatible

Both counts cover **genuine products only**: compatible stock is always 100. Live figures:

| | Rows |
|---|---|
| `actions.out_of_stock`: active, `stock_quantity = 0`, not admin-only | **813** |
| … of which are auto-generated genuine packs with no feed row (`feed_stock_quantity` NULL) | 207 |
| … of which have feed stock > 0 but storefront stock 0 | 7 |
| … of which have feed stock ≤ 0 | 599 |
| `/admin/margin/out-of-stock`: genuine, `feed_stock_quantity ≤ 0` (= 599 + 9 rows whose storefront stock is still > 0) | **608** |

- **What each endpoint measures:**
  - `actions.out_of_stock` is **what a shopper sees as out of stock**, packs included. Its pack stock comes from the constituents.
  - `/admin/margin/out-of-stock` is **what the supplier feed says**, and it skips packs because they have no feed row.
- **Our recommendation:** use 813 for a "can't be bought" to-do, and 608 for a supplier view.
- **The 7 + 9 disagreeing rows:** the two columns differ until the next import or the pack-stock reconcile runs.
- **No code change. `under_margin_floor`:** noted. It must not be wired to your net < 10% to-do.

## §4 Σ buckets = total: shipped

- `pnlLedger.buildLedger` now carries the rounding remainder into the **last bucket**, for every summed money key: net_profit, gross_profit, revenue, cogs, stripe_fees, supplier_freight, opex, refunds and invoice_revenue.
- This covers the `dashboard-summary` series, the bundle `gross_profit_series` and `net_profit_series`, and `/pnl`.
- **Example:** October's 31 daily `net_profit` buckets will sum to −1890.79.
- **Safety limit:** only a rounding-sized gap is moved (at most ½¢ per bucket). A larger gap would mean a real mismatch, so it is left visible.

## §5 `daily-revenue` `days` ≤ 365: recorded, no change

The cap stays. For longer spans use `revenue-series` with `date_from`/`date_to`; it has no 365-day limit.

## §6 Augmento free freight at $100 INCL GST: shipped

1. **The rule changes everywhere at once.**
   - `SUPPLIER_FREIGHT_TERMS.augmento` now has `free_threshold_incl_gst: 100`. A consignment is free when `round2(goods_ex × 1.15) ≥ 100`.
   - Supplier freight is computed when it is read, never stored, so **history recomputes by itself**. The order modal, Orders list, dashboard-summary, kpi-summary, pnl and bundle all read this one function and move together.
   - DSNZ is unchanged: billed on every PO. The rate is unchanged: the customer ladder.
   - **The pricing floors moved with it.** The market-cap floor, the pack breakeven (`packOrderNet`) and the nightly competitive-pricing floor all read the same constant now. Before, the competitive planner had its own hard-coded `100` ex GST.
2. **New fields on each consignment:** `goods_cost_incl_gst` (null when the goods cost is unknown) and `free_threshold_incl_gst` (100 for Augmento; null for DSNZ). `free_threshold_ex_gst` is now **86.96** (the ex-GST equivalent), no longer 100.
3. **The customer side is unchanged.**
   - Free shipping applies when the **list** subtotal incl GST is ≥ `FREE_SHIPPING_THRESHOLD` (100). This is judged before any discount: `POST /api/orders` passes Σ price × qty to `calculateShipping`.
   - Your 246-order measurement matches the code.

**Check, after the deploy:**
- The 8 orders you listed fall in the $86.96–$99.99 ex-GST band (live line costs: 96.00, 94.00, 87.31, 95.00, 95.00, 99.00; the two July orders have no line snapshot and use product cost).
- Once the deploy is live, `npm run probe:supplier-freight` §7 should name none.

**Edges, pinned by test:**
- $86.96 ex ($100.00 incl) is free;
- $86.95 ex ($99.99 incl) is billed;
- order 2026112601 ($96.00 ex = $110.40 incl, 6 kg south-island rural) is free.


## Appendix: supplier-freight contract changes (§6)

The full contract is `docs/admin/supplier-freight-backend-response-sep2026.md`. Only the changes are below.

**The rule (owner, 2026-11-26):**
- **DSNZ** is billed on every purchase order. No change.
- **Augmento** is billed only when that consignment's goods cost **under $100 INCL GST**, that is goods ex GST under $86.96. The old rule was $100 ex GST.
- The freight amount still follows our customer zone/weight ladder.

**The consignment shape.** Two fields are new (marked NEW below), and `free_threshold_ex_gst` changed value:

```jsonc
{
  "supplier": "Augmento",
  "supplier_basis": "snapshot",       // snapshot | source_rule | fulfillment | default
  "billed": true,
  "unpriced": false,
  "reason": "goods_under_free_threshold",
  "goods_cost_ex_gst": 76.00,
  "goods_cost_incl_gst": 87.40,       // NEW: null when the goods cost is unknown
  "free_threshold_ex_gst": 86.96,     // CHANGED: was 100. Null for DSNZ.
  "free_threshold_incl_gst": 100,     // NEW: null for DSNZ
  "parcel_weight_kg": 0.4,
  "line_count": 1,
  "amount_incl_gst": 14.00, "gst_component": 1.83, "amount_ex_gst": 12.17
}
```

**The `reason` values are unchanged:** `always_billed`, `goods_under_free_threshold`, `goods_at_or_over_free_threshold`, `unknown_supplier`, `unknown_supplier_terms`, `unknown_goods_cost`.

**The 8 orders that become free:**

| Order | Goods ex GST | Goods incl GST |
|---|---|---|
| 2026112601 | 96.00 | 110.40 |
| 2026102804 | 94.00 | 108.10 |
| 2026101302 | 87.31 | 100.41 |
| 2026092801 | 95.00 | 109.25 |
| 2026092101 | 95.00 | 109.25 |
| 2026090304 | 99.00 | 113.85 |
| 20260724000001 | 92.00 | 105.80 |
| 20260716000001 | 89.15 | 102.52 |

The other 45 orders stay billed.
