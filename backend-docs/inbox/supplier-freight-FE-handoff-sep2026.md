# Supplier freight — FE wiring checklist (ERR-241, Sep 2026)

Backend is live on `main` (`cb7344e`). This is the "what to change" list.
The reasoning, the measurements and the answers to your three asks are in
[`supplier-freight-backend-response-sep2026.md`](./supplier-freight-backend-response-sep2026.md) —
read §0 of that one first if you read nothing else here.

---

## 1. Delete before you add

The estimator is now wrong in both directions, so it has to come out before the new
field goes in — running both **double-charges every order**.

- [ ] Remove the local freight derivation (`shipping_absorbed` treated as the DSNZ
      consignment + your own Augmento `< $100` rule on top).
- [ ] Remove the lightest-band-of-the-zone-ladder fallback.
- [ ] Remove the "estimated" qualifier that fallback forced onto the UI.

**`shipping_absorbed` is not a freight bill.** It is the outbound parcel rate — what
it costs to put the box on a courier. It is still there, still means the same thing,
and must **not** be added to profit alongside `supplier_freight`.

## 2. Read one field instead

`supplier_freight.amount_ex_gst` is the complete deduction for the order: every
supplier, both thresholds, already inside the number.

```jsonc
"supplier_freight": {
  "applies": true,                  // we owe freight on this order
  "amount_ex_gst": 12.17,           // ← deduct THIS. Nothing else.
  "amount_incl_gst": 14.00,         // show on the line; it is a GST-inclusive cost
  "gst_component": 1.83,            // reduce the "GST remitted to IRD" line by this
  "complete": true,                 // false ⇒ the total is a FLOOR — render "at most"
  "unpriced_consignments": 0,
  "zone": "south-island",
  "delivery_type": "rural",
  "delivery_type_basis": "snapshot",
  "parcel_weight_kg": 0.4,
  "parcel_rate_incl_gst": 14.00,
  "consignments": [ /* one per supplier — see §5 */ ]
}
```

Same treatment as the existing supplier and Stripe lines:

1. New row after "Paid to Stripe": `Supplier freight` → `−$amount_incl_gst`
2. Reduce "GST remitted to IRD (after credits)" by `gst_component`
3. Take-home therefore drops by `amount_ex_gst`; recompute net margin

`supplier_freight` is **owner-only** (`super_admin`). It is absent for
`order_manager` — render nothing, not a zero.

## 3. Per surface

| Surface | Field | Notes |
|---|---|---|
| Order detail modal | `order.supplier_freight` | full envelope |
| Orders list | `row.supplier_freight` | same envelope, per row — **the list can drop its estimate too** |
| Dashboard KPI tiles | `current.supplier_freight` / `previous.supplier_freight` | ex-GST; `net_profit` already reduced |
| Financial Health P&L | `periods[].supplier_freight` + `totals.supplier_freight` | ex-GST; `net_profit` / `net_margin_pct` already reduced |
| Net-profit chart | `series[].supplier_freight` | per bucket; `net_profit` already reduced |

**The aggregate surfaces already have freight subtracted server-side.** Do not
subtract it again — the field is there so you can render the line, not so you can
apply it.

`trend-math.js`: the Orders list now carries `supplier_freight`, so it can build
COGS *and* freight from list rows without needing `suppliers[]` or
`supplier_cost_snapshot` on the list (ERR-039 / ERR-203).

## 4. The tile identity gained a term

```
gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight
```

`gross_profit` is unchanged and stays `revenue_ex_gst − COGS`. Freight is not a cost
of the goods — it never enters `supplier_cost`, so the Orders-list supplier-cost
column stays pinned to exactly what it was.

## 5. Three states to render honestly

**`complete: false`** — at least one consignment could not be priced, so the total
is a floor and take-home is a **ceiling**. This is the same signal as your
owed-but-unpriced bucket; keep the "at most" qualifier for it. As of the backend
going live this is `false` on zero live orders, but it is the honest path and it
will fire the day a new supplier appears.

**`delivery_type_basis`** — how we know urban vs rural:

| value | meaning |
|---|---|
| `snapshot` / `charged` | recovered from stored data. Exact. |
| `assumed` | urban assumed, as the old behaviour always did. **Understates a rural parcel by roughly half.** |

Only worth surfacing as a tooltip. Every order from Aug 2026 on resolves exactly;
the `assumed` ones are all historical.

**`consignments[].supplier_basis`** — how we knew which supplier:
`snapshot` → `source_rule` → `fulfillment` → `default`. Only `default` is inferred
(compatible stock has one live supplier). Qualify it if you want; the rate and the
threshold are exact either way.

Per consignment you also get `supplier`, `billed`, `reason`, `goods_cost_ex_gst`,
`free_threshold_ex_gst` and `parcel_weight_kg` — enough to explain any figure in a
tooltip without a second request. `reason` is one of `always_billed`,
`goods_under_free_threshold`, `goods_at_or_over_free_threshold`, `unknown_supplier`,
`unknown_supplier_terms`, `unknown_goods_cost`.

## 6. One unrelated fix while you are in there

Your pre-freight take-home deducts the Stripe fee **GST-inclusive** while deducting
freight ex-GST. `profitability.js` rule 3 reclaims the GST on both:

```
stripe_fee_ex_gst = (total × 2.65% + 0.30) / 1.15
```

It is about 50c per order — but it is a per-order constant, so the modal and the
dashboard will stay roughly `$0.50 × order count` apart until it is aligned, which
defeats the point of everything above.

## 7. Expect these to move

Not regressions — corrections. Worth knowing before someone reports them as bugs:

- **`shipping_absorbed` amounts change on rural orders.** The old value was always
  the urban rate. Where we now recover `rural`, the figure roughly doubles.
- **`applies:false` rows now carry amounts.** Deliberate (ask one). `applies` itself
  is untouched, so anything gating on it behaves exactly as before.
- **Far more orders owe freight than your rule found** — the great majority, not a
  handful. DSNZ bills on every purchase order; your model only ever charged the
  consignments it believed were unaccounted for.
- **Dashboard and P&L net profit drop, and can go negative.** That is the real
  number; it was overstated before.

## 8. Verifying

`npm run probe:supplier-freight` should report **`freight applied: N (0 estimated)`**
once §1 and §2 are done — the estimate count reaching zero is the signal, and N will
be much larger than the old 6-per-60.

Its §2 tripwire on the `shipping_absorbed` ⇄ DSNZ correlation **will trip on the next
run**, because ask one deliberately populates amounts on `applies:false` rows. Repoint
it at `supplier_freight` rather than relaxing it.

Backend coverage, if you want to read the rules rather than the prose:
`__tests__/supplier-freight.test.js` and
`__tests__/kpi-summary-supplier-freight.test.js`.
