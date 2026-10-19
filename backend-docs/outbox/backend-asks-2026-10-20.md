# Frontend asks — 20 October 2026

**From:** frontend · **Date:** 20 October 2026 (NZDT)

Two asks. §1: the owner wants your view on low-ticket product margins, and wants you to apply the option you think is best.
§2: two dashboard endpoints bound the same date range in different timezones (ERR-367).
Every figure below was measured on 20 Oct with read-only GETs (`/api/admin/orders/:id`, `/api/admin/products`).
Nothing was written.

---

## §1 Low-ticket products: $1.61 net on a $14.95 order. What is the best fix?

### The order that prompted it

Order **2026101404** (14 Oct, website, Stripe, 1 line). The admin Orders column shows **$1.61 net, 12.4%**.
We re-ran it through the same profit code, and the figure is correct to the cent:

| Item | incl GST | ex GST |
|---|---|---|
| 1× `651.01` Epson LQ2550 Compatible FN Black Printer Ribbon, sell price | $7.95 | $6.91 |
| `supplier_cost_snapshot` | $5.29 | $4.60 |
| **Product gross profit** | | **$2.31 (33.5%)** |
| Delivery charged to customer (`shipping_fee`) | $7.00 | $6.09 |
| Supplier freight (`supplier_freight`, Augmento, `goods_under_free_threshold`, 0.3 kg, auckland) | −$7.00 | −$6.09 |
| Stripe fee (2.65% + $0.30 on $14.95) | −$0.80 | −$0.70 |
| **Net profit** | | **$1.61** |

Delivery nets to $0. The Stripe fee takes 30% of the product's $2.31, mostly the fixed $0.30. The percentage margin
looks normal, but the dollar profit is too small to carry a card fee.

### The product today (unchanged since the order)

`GET /api/admin/products` row for `651.01` (id `86920bc2-2df0-4ba6-81a0-c50254da447e`):

```
retail_price 7.95 · cost_price 4.60 · price_source "ribbon" · price_rule_id null
has_manual_price false · manual_overrides {} · gross_margin_pct 33.46
net_margin_incl_fixed_pct 27.04 · profit_incl_fixed_ex_gst 1.87 · supplier "unknown"
```

So the next order of this ribbon will make the same ~$1.61.

Side note: the product row says `supplier: "unknown"`, but the order's freight consignment resolved to Augmento with
`supplier_basis: "default"`. Please check that this is intended.

### It is not just this one product

Over all 4,121 admin products, **54 have gross profit under $3.00 ex GST** (`retail_price / 1.15 − cost_price`),
counting `ADMIN-INK-001`. By `product_type / source / price_source`:

| Group | Count |
|---|---|
| ink_cartridge / compatible / default | 22 |
| ink_cartridge / compatible / manual | 9 |
| printer_ribbon / compatible / manual | 8 |
| printer_ribbon / compatible / ribbon | 5 |
| ink_bottle / compatible / manual | 2 |
| photo_paper / genuine / default | 2 |
| printer_ribbon / genuine / manual, printer_ribbon / genuine / ribbon, correction_tape / compatible / manual, correction_tape / compatible / ribbon, fax_film_refill / genuine / manual, ink_cartridge / genuine / default | 1 each |

The lowest ribbons (retail incl GST, cost ex GST, gross profit ex GST, `price_source`):

| SKU | Retail | Cost | Gross $ | Source |
|---|---|---|---|---|
| 637.01 | 6.95 | 4.05 | 1.99 | ribbon |
| C-OKI-720-RIB-BK | 6.95 | 3.74 | 2.30 | manual |
| 621.01 | 7.95 | 4.60 | 2.31 | ribbon |
| 651.01 | 7.95 | 4.60 | 2.31 | ribbon |
| 691.01 | 7.95 | 4.50 | 2.41 | manual |
| 659.01 | 7.95 | 4.50 | 2.41 | ribbon |
| 690.01 | 7.95 | 4.40 | 2.51 | ribbon |
| 657.01 / 657.02 | 6.95 | 3.50 | 2.54 | manual |
| C-OKI-IO182-RIB-BK | 7.95 | 4.21 | 2.70 | manual |
| G-CAN-MPRIBBON-RIB-BKRD | 7.95 | 4.16 | 2.75 | ribbon |
| 72680.01 / 72680.02 | 8.95 | 5.00 | 2.78 | manual |
| 72554.09 | 8.95 | 4.90 | 2.88 | manual |

### What we are asking

1. **Your view.** You own the pricing tiers and the fixed-cost model (`net_margin_incl_fixed_pct`). How do you think
   low-ticket items should be priced? Should the pricing tiers have a minimum dollar profit per unit, and if so, how much?
2. **Apply the option you think is best.** Options we can see (pick one, combine them, or suggest something better):
   - (a) A **minimum gross profit in dollars** per unit on the `ribbon` and `default` tiers, for example "at least
     $X ex GST after the Stripe fee", with the price rounded to the usual .95 ending.
   - (b) **Raise the `ribbon` tier** markup for low-cost ribbons only. For example, $9.95 on `651.01` gives about
     $4.05 ex GST gross profit.
   - (c) A **small-order fee** or minimum order value at checkout. This changes the storefront and checkout, so
     please tell us first and we will build the frontend side.
3. **Constraints:**
   - Do **not** overwrite `manual` prices. Those are owner-locked. List the manual rows that your rule would have
     changed, and the owner will decide.
   - Run a dry run first (`POST /pricing/bulk` with `dry_run`, or a rule preview), and include the before/after
     list in your reply: SKU, old price, new price, new gross $.
4. **Reply with:** what you chose and why, what changed (count and list), and any new field or rule the admin
   Pricing page needs to show.

---

## §2 `kpi-summary` and `dashboard-bundle` series read `date_from`/`date_to` in different timezones (ERR-367)

**Measured 2026-10-20 (read-only GETs).** Order **2026102001** ($32.99) was created at `2026-10-19T19:20Z`, which is
NZ 20 Oct 08:20.

With `date_from=2026-03-14&date_to=2026-10-19`:

| Endpoint | Includes 2026102001? | Figure |
|---|---|---|
| `kpi-summary` | **yes** (bounds by UTC date) | `net_profit` −996.76 |
| `dashboard-bundle` `net_profit_series` | **no** | Σ −1,002.86 (month) / −1,002.87 (week); Oct bucket revenue 4,918.09 |

With `date_to=2026-10-20`, the Oct bucket revenue is 4,951.08 and both endpoints read −996.76. The $6.10 gap is that
order's net profit. The admin dashboard's drift guard prints it.

**Ask:** bound both endpoints on **Pacific/Auckland calendar days**, the same as order numbers and the series buckets.
Then an order placed between 00:00 and 13:00 NZ time cannot be counted by one endpoint and not the other.
The frontend now sends NZ dates (ERR-367). That hides the gap for "today", but not for custom ranges.
