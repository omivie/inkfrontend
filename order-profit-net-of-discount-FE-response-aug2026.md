# FE response — order profit net of discount (Aug 2026)

**From:** frontend · **Date:** 2026-08-17 · **Re:** `order-profit-net-of-discount-aug2026.md`
**Status:** §3 and §4 **shipped**. §7 acted on anyway (see 3). §8.1 **shipped**. §8.2 **3 of 4 migrated**, one blocker.

---

## TL;DR

Fix is in, and every acceptance number in your §5 reproduces exactly. Four things you'll want:

1. **The bug had a second half you didn't flag.** The same missing subtraction made the profit
   breakdown report **$4.00 of GST collected on a $116.60 sale**. Fixed by the same change — but
   only because we netted the discount on the *revenue* side. Your §3 patch does this correctly;
   worth knowing *why* it has to be revenue and not a cost-side deduction (§1 below).
2. **Your §4 UI suggestion would have broken the footing.** The Profit Breakdown is not a
   revenue-first breakdown — it's a cash waterfall anchored on `Customer paid`, which is already
   net of the discount. We rendered it differently; details in §2.
3. **🔴 Migration 137 has NOT landed.** `products.cost_price` is readable **right now** with the
   public anon key — 3,978 rows in one unauthenticated request. And revoking `cost_price` alone
   would not close it: `profit_ex_gst` and `margin_pct` are on the same table and each recovers
   the cost. §4 below.
4. **`loyalty_discount_amount` is absent** on the admin order route, though §2 of your brief lists
   it. Labelling only for us, no figures affected.

---

## 1. §3 — shipped, with one deliberate deviation

Implemented as specified, with the GST conversion moved into `utils/profitability.js` as
`orderDiscountParts()` rather than inlined. It mirrors the existing `absorbedShippingParts()`
exactly — anchor on the incl-GST figure, derive `gst = incl × 3/23`, derive `exGst = incl − gst`
rather than `incl / 1.15`. The two are arithmetically identical; deriving by subtraction is what
keeps the cash waterfall footing exactly regardless of rounding, and it means there is one
statement of the GST convention in the codebase rather than two.

Two implementation notes that matter if you ever port this:

- **`totalRevenueExGst` is re-totalled from the apportioned lines**, not computed as
  `gross − discountExGst`. `computeLineProfits` recomputes its own total from the line array, and
  two independently-derived totals drift by a float ulp — enough to break the
  `Σ lineProfits === netProfit` invariant that the per-line column and the waterfall both rely on.
- **A discount at or above the line total resolves to UNKNOWN, not $0 and not a loss.** It's a data
  problem, and the honest answer is "we can't state this", not a confident negative number.

### Why it has to be the revenue side — the GST row you didn't mention

`computeProfitBreakdown` derives `gstCollected = customerPaid − revenueExGst`. `customerPaid`
(the order total) has **always** been stored net of the discount. While revenue stayed gross, the
two sides of that subtraction were on different bases:

| | pre-fix | post-fix | true |
|---|---|---|---|
| `gstCollected` on `20260817000002` | **$4.00** | **$15.22** | $15.21 (15% of $101.38) |

Had we instead passed the discount through `feeOpts` for `computeOrderProfit` to subtract as
another deduction alongside the Stripe fee, the profit line would have come out right and this row
would have stayed exactly as wrong, because `revenueExGst` would still be gross. **A discount is a
revenue reduction, not a cost.** Your §3 patch gets this right; we're spelling it out because the
distinction is invisible until you look at the GST row.

Same reasoning applies to the margin denominator: net margin is now measured against realised
revenue, which is the figure the discount actually produced.

## 2. §4 — we did NOT add the row you suggested, on purpose

Your mockup:

```
Items (ex-GST)            $112.60
Order discount (ex-GST)   −$11.22
Revenue (ex-GST)          $101.38
```

…assumes a revenue-first breakdown. The actual Profit Breakdown is a **cash waterfall**:

```
Customer paid (incl. GST)                  $116.60      ← already net of the discount
− Paid to supplier (incl. GST)             −$81.99
− Paid to Stripe                            −$3.90
− GST remitted to IRD                       −$4.01
= Take-home profit                          $26.69
```

A `−$11.22` row inside that would **double-count the discount and stop Take-home footing**, because
the opening figure already has it deducted. So:

- **The items-table foot** got your three rows verbatim — that is where revenue is stated, and
  where it genuinely needed explaining (the Price foot no longer relates to the unit prices above
  it once it's net).
- **The waterfall** got a qualifier on the opening line instead:
  `Customer paid (incl. GST) after −$12.90 discount ⓘ`, with the coupon code in the tooltip when
  `coupon_code` is set. Footing preserved.
- **The Financial Breakdown** section got a `Discount (volume / coupon / loyalty) −$12.90 incl. GST`
  row beside Subtotal / GST / Total — the customer-money view, and the natural home for the gross
  figure.
- **The Orders list** got a muted `−$12.90` under the Total, straight off the list row. Thanks for
  shipping `discount_amount` on the list endpoint — that's zero extra requests.

### Adjacent bug fixed while in there

The UNKNOWN state's copy hardcoded *"N of M items have no recorded supplier cost"*, but UNKNOWN is
also reachable with `missingCostCount === 0` (via the `!breakdown` branch, and now via a discount at
or above the line total). It was printing **"0 of 2 items have no recorded supplier cost"**. It now
branches on the actual cause. This predates your brief.

## 3. §7 — the cart. We acted, and here's the disagreement

You're right that the pipeline was correct on the day you tested it, and right about the
localStorage fingerprint. We still shipped cart work, because there's a distinct mechanism that
produces the owner's exact words — *"the discount is showing but not in the total"* — and it is
invisible by construction:

```js
// cart.js, computeDiscountBreakdown
other: Math.max(0, aggregate - loyalty - b2b)
```

The discount **rows** render from the components (`volume_discount`, `loyalty_discount_amount`).
The **total** is computed separately as `subtotal − summary.discount`. The whole thing rests on
`summary.discount` containing those components — which is recorded as verified-live in a code
comment and checked nowhere. If it ever stops holding, the volume row still says −$4.80 while the
total deducts nothing, and that `Math.max(0, …)` flattens the contradiction to zero on the way past.

That residual is now returned as `shortfall` and rendered as a durable on-page notice naming the
amount. It does **not** correct any figure — you own the money, the customer sees your numbers
verbatim, and a mismatch is disclosed rather than silently recomputed.

We also took your optional hardening, and a bit more: `serverSummary = null` was being set at eight
sites meaning two different things (four real failures, four deliberate invalidations pending a
mutation) with no reason attached, and in production it was silent on *every* channel — `DebugLog`
is a no-op outside localhost, and `isUsingEstimatedPrices()` had **zero callers** repo-wide despite
a docblock saying checkout should be blocked on it. There's now a reason code, one bounded re-fetch,
and a visible notice. The local fallback is **kept** — this makes it loud, it doesn't remove it.

**No backend ask here.** If the state recurs we'll capture the network tab as you suggested.

## 4. 🔴 §8 — migration 137 is not live, and as specified it wouldn't be enough

### 4a. Please re-check the migration

Measured 2026-08-17 against production with the anon key from the shipped bundle:

```
GET /rest/v1/products?select=sku,cost_price,retail_price   →  200, content-range 0-0/3978
```

Full supplier cost and margin for the entire catalogue, unauthenticated, one request. Whatever
happened to mig 137, the grant is not in effect.

### 4b. `cost_price` is not the only column that leaks the cost

Both of these are on `products` and both are readable by `anon` today:

| column | recovers cost how |
|---|---|
| `profit_ex_gst` | `retail/1.15 − profit_ex_gst` → `122.43 − 56.33 = $66.10` ✓ |
| `margin_pct` | `retail/1.15 × (1 − margin/100)` → same figure |

Revoking `cost_price` alone moves the leak, it doesn't close it. **All three columns need the same
treatment**, from `anon` now and from `authenticated` at phase 2.

### 4c. §8.1 — shipped, and there was a second half

`select('*')` → explicit column list, done. Two things worth knowing:

- **We verified every column against the live schema first.** Nine of the fields a reasonable
  person would list — `in_stock`, `average_rating`, `review_count`, `canonical_url`,
  `original_price`, `discount_amount`, `discount_percent`, `cost_per_page_display`,
  `image_thumbnail_url`/`image_srcset` — are **API-computed and not table columns**. An unknown
  column is a hard 400, which would have been a worse outage than the one being fixed.
- **The column list alone would not have fixed it.** The query **discarded its `error`**, so a
  42501 rendered the rail's empty state — indistinguishable from "the owner curated nothing". And
  the error pane was gated on `info.category !== 'ribbon'`, so even once the flag was set the ribbon
  path could never display it. Both fixed.

⚠️ **Ordering:** this needs to be **deployed before you run the revoke**. If the revoke lands first,
every curated ribbon rail goes blank for logged-out shoppers and reads as a content problem.

### 4d. §8.2 — 3 of 4 migrated

Your list was both over- and under-inclusive. Corrected:

| site | status |
|---|---|
| `admin/api.js:1512` `getRibbonProduct` | ✅ narrowed — `select('*')` → explicit, no cost columns |
| `admin/api.js:1471` `getRibbonProducts` | ✅ narrowed — **not in your brief**, same `select('*')` |
| `components/product-search.js` | ✅ **REST-only now** |
| `pages/products.js:762` | ❌ **blocked — BF-044 below** |
| `pending-changes.js` | ✅ already safe — selects no cost column; its hits are a diff-formatter field list |
| `cc2-pricing.js` | ✅ already safe — REST-fed via `/api/admin/pricing/simulate`, no supabase in the file |

Both ribbon methods are currently **unreferenced repo-wide**. We narrowed rather than deleted them,
so re-wiring one later can't silently reopen the hole.

On `product-search.js`: its comment asserted *"there is NO evidence `/api/admin/products` returns
it"*. There is — `cost_price` comes back on both the list and detail routes for `super_admin`
(along with `profit_ex_gst`, `margin_pct` and friends). We measured search parity before switching:
identical result counts, and exact-SKU lookups identical, which is what the picker is actually used
for. The `product_images(...)` join it carried was already dead weight — `resolveImg` never read it.

### 4e. 🔵 BF-044 — the one thing we need from you to finish phase 2

`pages/products.js` runs the Products list through PostgREST rather than `/api/admin/products`
because the REST endpoint:

1. **cannot express three of the page's filters** — pack type (CMY/KCMY/value pack vs singles),
   supplier, and product-type *groups* ("All Ribbons"); and
2. **omits `supplier` and `supplier_sku`**, which the Supplier and Origin columns render. (That gap
   is why `warnIfSourcingFieldsMissing()` exists — the REST path already degrades those columns to
   em-dashes.)

So dropping `cost_price` there would either blank the owner's Cost column on the **default** view or
silently return unfiltered rows while the dropdown claims otherwise. Neither is acceptable and
neither is fixable from our side.

**Either of these unblocks us — your call which is cheaper:**

- **(a)** add `pack_type`/`color`, `supplier`, and product-type-group filters to
  `GET /api/admin/products`, plus `supplier` + `supplier_sku` on the response. We then delete the
  Supabase branch entirely and phase 2 is unblocked with no exceptions left; **or**
- **(b)** ship a narrow owner-only `GET /api/admin/products/costs?ids=…` we can hydrate from after
  paint (same shape as the Orders list's profit fan-out).

(a) is the better outcome — it removes a whole duplicate data path, not just the cost read.

Once that lands, tell us and we'll flip the last read and confirm; the enrolment test
(`tests/admin-supabase-cost-exposure-aug2026.test.js`) will fail loudly the moment its documented
exception stops being needed, so it can't be forgotten.

---

## 5. Verification

- **`npm run probe:order-discount`** — new **READ-ONLY** live probe (no `--record` mode; the mode is
  printed on every run). Walks the list + detail endpoints with a super_admin token and asserts the
  discount fields are present, typed, and that realised revenue reconciles to the charged total.
  All four orders from your §1 pass:

  | order | discount | lines ex-GST | realised | charged | drift |
  |---|---|---|---|---|---|
  | `20260817000002` | $12.90 | $112.60 | **$101.38** | $116.60 | $0.01 |
  | `20260817000001` | $8.15 | $281.67 | $274.58 | $315.79 | $0.02 |
  | `20260812000003` | $6.62 | $287.80 | $282.04 | $324.36 | $0.01 |
  | `20260812000001` | $2.40 | $41.56 | $39.47 (+$7.00 ship) | $52.40 | $0.01 |

- **Confirmed in the real admin UI** on `20260817000002`: revenue $101.38, take-home $37.91 → $26.69
  (−$11.22), Stripe fee unchanged, all three discount surfaces rendering.
- **74 new tests** across four files, plus 4 added to `profitability.test.js`. Full suite: **3975
  passing, 0 failing.**
- The enrolment sweeps were each verified to actually fail on an injected regression — a green sweep
  that can't go red is decoration.

## 6. Answers to your specific claims

| your claim | verdict |
|---|---|
| profit overstated by `discount/1.15` | ✅ confirmed, $11.22 on the proof order |
| fee base already correct | ✅ confirmed, `stripeFee` byte-identical before/after |
| `discount_amount` is GST-inclusive | ✅ confirmed against 4 live orders |
| detail endpoint "has always carried these fields" | ✅ for `discount_amount` / `coupon_code` |
| `loyalty_discount_amount` "exposed if you ever want to label the split" | ❌ **absent** on the admin route. Labelling only for us — no figure affected — so not blocking. |
| invoice orders have `discount_amount = 0` ⇒ no-op | ✅ confirmed |
| dashboard / P&L aggregates already correct | ✅ untouched, they read `orders.total` |
| mig 137 revokes `cost_price` from anon | ❌ **not in effect** — see §4a |
| only one `select('*')` in non-admin code | ✅ confirmed (there are two `.from('products')`; the other selects `id` only and is unaffected) |

## 7. One pre-existing oddity, not fixed, not urgent

On an order with **charged** shipping, the waterfall's `gstCollected` overstates: revenue excludes
shipping (it's treated as a courier pass-through, not booked as revenue) while `customerPaid`
includes it, so the shipping component lands inside `gstRemittedToIrd` rather than on its own line.
The waterfall still foots and take-home is correct — `gstRemittedToIrd` is the residual by
construction — but that row is not a GST return figure on those orders. Predates this work, out of
scope, flagging it so it isn't discovered as a regression later.
