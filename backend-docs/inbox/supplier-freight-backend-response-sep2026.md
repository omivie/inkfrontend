# Supplier freight — backend response (ERR-241, Sep 2026)

Reply to `supplier-freight-backend-brief-sep2026.md`. All three asks are done, plus
the data item. **Wiring checklist: [`supplier-freight-FE-handoff-sep2026.md`](./supplier-freight-FE-handoff-sep2026.md)** —
this document is the reasoning and the measurements; that one is the steps.

**One of them changes an assumption your shipped code rests on — read
§0 before you wire anything**, because keeping your current derivation alongside the
new field double-charges every order.

---

## 0. The one thing that must change on your side

You wrote:

> we treat your absorbed row as covering the always-pays supplier's consignment and
> charge the rest.

Stop doing that. **`shipping_absorbed` was never a supplier freight bill.** It is the
outbound parcel rate — what it costs to put that box on a courier — and it was gated
on "free shipping AND the order contains a genuine line". That gate is the entire
reason for the correlation you measured, which is why §3 can confirm it as a rule and
still tell you not to build on it.

Supplier freight now arrives as its own field, `supplier_freight`, computed from the
owner's actual terms. **It is the complete freight figure for the order — every
supplier, both thresholds.** Deduct `supplier_freight.amount_ex_gst` and nothing else.
Do not add anything for `shipping_absorbed`, and do not apply your own Augmento rule
on top; both are already inside the number.

Two corrections to the brief's premises while I am here, because they shaped your
fallback:

- **`products` does carry a weight column.** `products.weight_kg`, deterministic per
  `product_type` (light 0.1 kg / medium 0.3 kg / heavy 2 kg, packs 0.3–0.4 kg). It is
  not exposed on the order endpoints, which is a fair thing to have concluded from the
  API — but it exists, and it is what the rate is priced on.
- **Order items do carry a courier cost.** `order_items.shipping_cost_snapshot`, the
  real per-line courier cost frozen at checkout **with the real urban/rural setting**.
  It has been written on every order since Aug 2026 (33 of 34 September lines). That
  column is what lets the backend now recover the delivery type instead of assuming it.

---

## 1. Ask one — the parcel rate is now unconditional

`order.shipping_absorbed` is populated on **every** order, `applies:false` included.
`applies` keeps its exact former meaning (free shipping AND a genuine line AND a
non-zero rate), so nothing that already reads it changes behaviour.

```jsonc
"shipping_absorbed": {
  "applies": false,                  // unchanged semantics — "does someone else pay for it"
  "basis": "zone_rate",
  "zone": "south-island",
  "delivery_type": "rural",
  "delivery_type_basis": "snapshot", // NEW — see below
  "parcel_weight_kg": 0.4,
  "amount_incl_gst": 14.00,          // now present regardless of `applies`
  "gst_component": 1.83,
  "amount_ex_gst": 12.17
}
```

### `delivery_type` is no longer blanket-assumed urban

This is the bigger half of ask one. The Jul 2026 implementation hardcoded `'urban'`
and said so in its own hand-off. On a light south-island parcel that is **$7 against a
real $14** — your brief's floor was not just conservative, it was half.

The backend now recovers the real setting from two stored numbers that were both
computed *with* it at checkout, and tells you which one it used:

| `delivery_type_basis` | meaning |
|---|---|
| `snapshot` | inverted from `SUM(order_items.shipping_cost_snapshot)`. Exact. |
| `charged` | inverted from `orders.shipping_cost` on an order that did not ship free. Exact. |
| `assumed` | neither available — urban, as before. Understates a rural parcel. |

Only an unambiguous match is accepted; a fee matching both bands or neither falls back
to urban rather than guessing, because a wrong rural verdict doubles the figure.

Across all 149 live orders: **80 recovered** (63 `charged`, 17 `snapshot`), 69 still
`assumed` — all of them pre-August, before the snapshot column existed. Every new order
resolves exactly.

**Your example order `2026090902` is one of the recovered ones: south-island, rural,
0.4 kg → $14.00 incl GST, not the $7 your floor produced.**

---

## 2. Ask two — the rule runs server-side

### The rule, as the owner confirmed it (2026-09-09)

> The supplier freight is accrued to us always by Dynamic Supplies at the rates that we
> use for customers. Augmento only makes us pay when the price to buy the goods is under
> $100 excl GST; at or above $100 excl GST we pay no shipping.

So: **one consignment per supplier**, priced at our own zone/weight ladder.

- **DSNZ** — billed on every purchase order, no threshold.
- **Augmento** — billed only when that consignment's goods cost **under $100 ex-GST**.
- A supplier we hold no terms for, or a consignment whose goods cost is unknown, is
  reported `unpriced` and **charged nothing**. A fabricated freight cost reads as fact,
  which is worse than a missing one.

An order drawing on both suppliers is **two** freight bills, each priced on its own
lines' weight — not one parcel rate split. Live example `20260812000002`: Augmento $14
+ DSNZ $14 = $28 of freight on an $89.48 order.

### Where it lands

Freight is deducted **ex-GST**, in **net**, as **its own line** — never folded into
`supplier_cost` (your Orders-list column stays pinned to what the goods cost) and never
into `gross_profit` (which stays the textbook `revenue_ex_gst − COGS` that every
surface already agrees on). Your tile identity gains one term:

```
gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight
```

Verified against the live RPC — it reconciles to the cent.

### Every surface, and the new fields

| Surface | New |
|---|---|
| `GET /admin/orders/:orderId` | `order.supplier_freight` (full envelope, owner-only) |
| `GET /admin/orders` | `supplier_freight` per row, owner-only — **the list can drop its estimate too** |
| `GET /admin/analytics/kpi-summary` | `supplier_freight`, `supplier_freight_incl_gst`, `supplier_freight_unpriced_orders` on `current` and `previous`; `net_profit` reduced |
| `GET /admin/analytics/pnl` | same three per period and in `totals`; `net_profit` / `net_margin_pct` reduced |
| `GET /admin/analytics/dashboard-bundle` | `supplier_freight` per bucket on `net_profit_series`; `net_profit` reduced |
| `GET /admin/analytics/overview` | `supplierFreight`, `prevSupplierFreight`; `netProfit` / `prevNetProfit` reduced |
| kpi-summary RPC-error fallback | `supplier_freight {current, previous}`; `net_profit` reduced — so a fallback render cannot report a healthier net than the RPC would have |

All six read one helper, so they cannot drift: the window totals the fallback uses
($502.64 current / $381.77 previous over the last two 30-day windows) are the same
numbers `kpi-summary` folds in.

`trend-math.js` can now build COGS *and* freight from list rows — the Orders list
carries `supplier_freight` for owners, so the ERR-039 / ERR-203 gap is closed for this
purpose without needing `suppliers[]` or `supplier_cost_snapshot` on the list.

### The envelope

```jsonc
"supplier_freight": {
  "applies": true,                    // we owe freight on this order
  "amount_incl_gst": 14.00,
  "gst_component": 1.83,
  "amount_ex_gst": 12.17,             // ← THE deduction. Nothing else.
  "zone": "south-island",
  "delivery_type": "rural",
  "delivery_type_basis": "snapshot",
  "parcel_weight_kg": 0.4,            // whole order
  "parcel_rate_incl_gst": 14.00,      // what the whole parcel costs to send
  "complete": true,                   // false ⇒ the total is a FLOOR ("at most")
  "unpriced_consignments": 0,
  "consignments": [
    {
      "supplier": "Augmento",
      "supplier_basis": "snapshot",   // snapshot | source_rule | fulfillment | default
      "billed": true,
      "unpriced": false,
      "reason": "goods_under_free_threshold",
      "goods_cost_ex_gst": 76.00,
      "free_threshold_ex_gst": 100,
      "parcel_weight_kg": 0.4,
      "line_count": 1,
      "amount_incl_gst": 14.00, "gst_component": 1.83, "amount_ex_gst": 12.17
    }
  ]
}
```

`reason` values: `always_billed`, `goods_under_free_threshold`,
`goods_at_or_over_free_threshold`, `unknown_supplier`, `unknown_supplier_terms`,
`unknown_goods_cost`.

**Render `complete:false` as the "at most" ceiling you already have.** It is the same
signal as your owed-but-unpriced bucket, but per consignment rather than per order.

---

## 3. Ask three — the correlation is a rule, but not the rule you think

**Confirmed as deterministic, and reproduced exactly: 23 of the last 60 orders.**

It is not luck and it is not going to drift, because it is a literal condition in the
code — `admin.js` required `hasGenuine` before it would emit an absorbed row, and every
genuine line is a DSNZ line. Your 23-of-23 is that `if` statement.

But it is a rule about **genuine items on free-shipping orders**, not about DSNZ
purchase orders, and the two differ in both directions:

- `applies:false` on a **paid-shipping** order containing a DSNZ line — DSNZ still
  billed us freight there. Your model charged nothing.
- `applies:false` on an **Augmento-only** order under $100 — Augmento billed us. Your
  model caught this one, which is why you found 6.

So the tripwire in `probe:supplier-freight` §2 is worth keeping, but point it at
`supplier_freight` instead. Since ask one now populates the amount on `applies:false`
rows, the old correlation will look like it "broke" on the very next run — that is
expected, not a regression.

---

## 4. What this does to the numbers

Nothing in the P&L had ever counted this cost. Last 30 days (2026-08-11 → 09-09, 60
orders), measured against the live RPC:

| | before | after |
|---|---|---|
| revenue | $10,278.23 | $10,278.23 |
| gross profit | $2,210.76 | $2,210.76 |
| stripe fees | $170.68 | $170.68 |
| operating expenses | $1,593.50 | $1,593.50 |
| **supplier freight** | — | **$502.64** (ex-GST; $578.00 incl) |
| **net profit** | **$446.58** | **−$56.06** |
| net margin | 5.0% | **−0.6%** |

Across all 149 live orders the uncounted freight totals **$1,158.33 ex-GST**
($1,332.00 incl). 58 of the last 60 orders owe freight — not 6. Your rule only ever
charged the consignments you believed were unaccounted for; under the real terms DSNZ
bills on every PO (61 consignments) and Augmento bills on 80 of its 90 (89%), close to
the 78% your own measurement found.

On order `2026090902` specifically: the take-home is **$25.42 at 21.7%**, against the
$31.00 at 26.5% your $7 floor produced.

### One small thing that will still keep us apart

Your $37.09 pre-freight take-home on that order reverse-engineers cleanly:
`116.95 − 76.00 − (134.49 × 2.65% + 0.30)` — the Stripe fee deducted **GST-inclusive**,
while you deduct freight ex-GST. The backend reclaims the GST on both
(`profitability.js` rule 3: "the GST on Stripe fees is reclaimable — divide the fee by
(1 + GST)"), which makes the same line `$3.36`, not `$3.86`, and the pre-freight
take-home **$37.59 at 32.1%**.

It is 50c on this order, but it is a per-order constant, so the modal and the dashboard
will stay about $0.50 × order-count apart even after everything above lands. Worth
aligning while you are in there.

---

## 5. The data item — resolved without needing data entry

`INV-3273`, `20260817000002` and `20260814000002` are all priced now, and so is every
other order: **`unpriced_consignments` is 0 across all 149.**

The lines name no supplier, but they are all `source='compatible'`, and compatible
stock has exactly one live supplier. Attribution runs a ladder and tells you which rung
it landed on via `supplier_basis`:

1. `snapshot` — `order_items.supplier_name`, who we actually bought from that day.
2. `source_rule` — genuine ⇒ DSNZ, the sole genuine distributor.
3. `fulfillment` — `order_fulfillment.selected_supplier` for compatible lines.
4. `default` — compatible with none of the above ⇒ Augmento. A configured fact
   (`COMPATIBLE_SUPPLIER_DEFAULT`), not a guess: Supplier2026's price list was last
   imported 2026-02-19 and has never won a fulfilment.

Live spread: 15 `snapshot`, 51 `source_rule`, 37 `fulfillment`, 48 `default`. If you
want to qualify the `default` ones in the UI the field is there, but they are not
estimates in the sense yours were — the rate and the threshold are both exact, only the
supplier's identity is inferred, and there is only one candidate.

---

## 6. Verifying

`npm run probe:supplier-freight` should now report **`freight applied: N (0 estimated)`**
once you read `supplier_freight` instead of deriving one. Expect N to jump from 6 to
roughly 58 per 60 orders — that is the rule being applied to every consignment rather
than only the ones the absorbed row appeared to miss.

Backend side: `__tests__/supplier-freight.test.js` (36 cases — both thresholds, the
per-consignment split, every refusal path, the delivery-type recovery, the attribution
ladder) and `__tests__/kpi-summary-supplier-freight.test.js` (the P&L seam end-to-end).

## 7. Caveats worth carrying into the UI

- The amount is **our zone rate**, per the owner's terms ("at the rates that we use for
  customers"). No supplier freight invoice is recorded anywhere, so this is the agreed
  basis, not a reconciliation against a bill.
- 69 of 149 historical orders still carry `delivery_type_basis:"assumed"` (urban). If
  any of those were rural, their freight is understated by roughly half. Every order
  from Aug 2026 on resolves exactly.
- Freight is attributed to the **order** that caused it, on the order's own date. Real
  supplier invoices arrive on their own schedule; this is not a cash-basis figure.
- Aramex courier tickets are booked separately as an expense and relate to manually
  added orders, not website orders. They are not double-counted here.
