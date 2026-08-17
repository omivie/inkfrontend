# FE dev brief — admin order profit must subtract the order discount (Aug 2026)

**From:** backend · **Date:** 2026-08-17 · **Priority:** high (money-reporting correctness)
**Repo:** `omivie/inkfrontend` · **Files:** `js/admin/utils/order-profit.js` (required), `js/admin/pages/orders.js` (small, optional UI), `js/admin/utils/profitability.js` (no change needed)
**Backend commits:** `52abc83` (adds discount fields to the orders LIST endpoint — already live on `main`).

---

## TL;DR

Since public volume pricing went live (BF-034, Aug 2026), most orders carry an
order-level discount in `orders.discount_amount`. The admin Orders profit column
and the order-detail modal's Profit Breakdown compute revenue as
`Σ(unit_price × qty)` over the line items and **never subtract that discount**,
so profit is **overstated by `discount_amount / 1.15` ex-GST** on every
discounted order. One code change in `orderProfitFromDetail` fixes both
surfaces (they share the module — ERR-113 design).

Nothing on the storefront cart is broken — see the last section before you
spend time there.

---

## 1. Proof, on a real order

Production order **`20260817000002`** (paid 2026-08-16, one line, no coupon —
the discount is pure volume pricing):

| field | value |
|---|---|
| line items | 10 × `unit_price` $11.26 **ex-GST** = $112.60 |
| `orders.discount_amount` | **$12.90 (GST-inclusive)** |
| `orders.total` (what the card was charged) | $116.60 incl GST |
| revenue your code computes today | $112.60 ex-GST |
| true realised revenue | $112.60 − 12.90/1.15 = **$101.38 ex-GST** (cross-check: total/1.15 = $101.39 — the ≤1¢ drift is stored-rounding, the patched line-sum figure is the acceptance value) |
| **profit overstatement on this order** | **$11.22 ex-GST** |

More orders to test with (all paid, all volume-discount-only, no coupon):
`20260817000001` (discount $8.15), `20260812000003` ($6.62), `20260812000001`
($2.40, plus $7.00 charged shipping — good for the fee-base check).

## 2. Money conventions (verified against live rows — do not re-derive)

| field | GST basis | notes |
|---|---|---|
| `order_items.unit_price`, `line_total` | **ex-GST** | matches your existing `// backend stores sell_price ex-GST` comment |
| `orders.discount_amount` | **GST-inclusive** | aggregate of volume + coupon + loyalty (`calculateTotals` folds all three; there is NO per-component column on the order row) |
| `orders.total` / `total_amount` | GST-inclusive | **already net of the discount** — your fee base (`customerPaidInclGst`) is already correct; only the revenue side is wrong |
| `orders.loyalty_discount_amount` | GST-inclusive | subset of `discount_amount`, exposed if you ever want to label the split |
| `orders.coupon_code` | — | non-null ⇒ some of the discount is a promo coupon |

## 3. Required fix — `js/admin/utils/order-profit.js`

In `orderProfitFromDetail`, after the line loop and before the fee-base block:

```js
// Order-level discount (volume + coupon + loyalty). Stored GST-INCLUSIVE on
// the order row; revenue here is ex-GST, so convert before netting it out.
// Without this, every volume-discounted order (most orders since Aug 2026)
// overstates profit by discount/1.15.
const discountInclGst = Number(order.discount_amount);
const discountExGst = Number.isFinite(discountInclGst) && discountInclGst > 0
  ? discountInclGst / 1.15
  : 0;
totalRevenueExGst = Math.max(0, totalRevenueExGst - discountExGst);
```

And apportion it across the per-line entries by revenue share (same convention
as the order-level fee share), so the modal's per-line profit column still
foots with the order total:

```js
const grossExGst = lines.reduce((s, l) => s + l.revenueExGst, 0);
if (discountExGst > 0 && grossExGst > 0) {
  for (const l of lines) {
    l.revenueExGst -= discountExGst * (l.revenueExGst / grossExGst);
  }
}
```

Notes:

- **The aggregate is the right thing to net.** Volume, coupon and loyalty
  discounts all reduce realised revenue identically for profit purposes; the
  backend folds them into one column and so should you.
- **No change to `computeProfitBreakdown` / `computeLineProfits`.** They take
  revenue as input; feeding them the corrected figure is the whole fix. Side
  benefit: the breakdown's GST waterfall (`gstCollected = customerPaid − rev`)
  is currently under-reporting GST collected on discounted orders because `rev`
  is overstated — the same one-line fix corrects that row too.
- **Classification states are untouched.** CANCELLED / NO_ITEMS / UNKNOWN /
  FAILED / PENDING logic doesn't change; a missing `discount_amount`
  (undefined/null) must behave as $0 — the `Number.isFinite` guard above does
  that, so old cached list rows can't turn profit into `null`.
- **Invoice orders**: shadow orders from saved invoices normally have
  `discount_amount = 0`, so the guard makes this a no-op there. No special-case
  needed.

## 4. Suggested UI (small, makes the fix visible)

In the modal's Profit Breakdown, render the discount as its own line between
revenue and supplier cost whenever it's non-zero, so the operator can see WHY
revenue is lower than the line-item sum:

```
Items (ex-GST)            $112.60
Order discount (ex-GST)   −$11.22     ← new row, from discountExGst
Revenue (ex-GST)          $101.38
Supplier cost             −$…
…
```

Optional: the Orders LIST endpoint now returns `discount_amount`,
`coupon_code` and `loyalty_discount_amount` on every row (backend `52abc83`),
so a "Discount" column or badge on the list needs no detail fetch. Your
existing pattern of fetching the detail for the profit column is unchanged —
the detail endpoint has always carried these fields.

## 5. Acceptance checks

1. Open order `20260817000002` in the admin modal:
   - revenue ex-GST shows **$101.38** (was $112.60);
   - net profit is **$11.22 lower** than before the fix;
   - fee line unchanged (fee base was already `total` = $116.60).
2. Open `20260812000001` (has $7.00 charged shipping): fee base still
   `total` $52.40; revenue ex-GST = (41.56 + 6.84 − …) — simply: profit drops
   by exactly `2.40 / 1.15 = $2.09` vs the pre-fix figure, nothing else moves.
3. An old order with `discount_amount = 0`: profit figure **byte-identical**
   to pre-fix output (guard makes the change a strict no-op).
4. A cancelled order and an order with a missing `supplier_cost_snapshot`
   still resolve to CANCELLED / UNKNOWN — never `$0`.
5. Per-line profits in the modal sum to the order profit (± a cent of
   rounding), including on a discounted multi-line order.

## 6. Explicitly out of scope

- **Dashboard / P&L / KPI aggregates are already correct** — they compute
  revenue from `orders.total`, which is stored net of discount. Don't touch.
- The per-product "performance" ranking sums `line_total` and ignores
  order-level discounts — pre-existing, much smaller skew, separate ticket if
  ever.

## 7. Storefront cart — NO action, and what that screenshot was

The customer cart pipeline was live-verified end-to-end on 2026-08-17, guest
AND authed, with the deployed FE: `GET /api/cart` returns `summary.discount` /
`volume_discount` (8× CLC37BK → −$4.80 @ 10%) and the cart page renders
"Volume discount −$4.80", Total $43.12. Orders charge the discounted total.

The screenshot that opened this ticket showed your **localStorage fallback
state** — its fingerprint: GST = `subtotal × 0.15 / 1.15` computed locally
(server GST includes estimated shipping and differs), shipping "Calculated at
checkout", no discount row. That means that tab's `GET /api/cart` failed or
was never adopted (`Cart.serverSummary === null`) and the page silently
rendered cached items at un-discounted local math. Hard refresh clears it.

**Optional hardening if you want to close that gap:** when `serverSummary` is
null but items exist, show a subtle "refreshing prices…" state (and/or retry
the fetch once) instead of silently presenting local totals — a shopper in
that state currently sees prices that checkout will beat, which is at least
confusing. Backend response is provably correct, so if the state recurs,
capture the network tab for `GET /api/cart`.

---

## 8. Related: `products.cost_price` column lockdown (mig 137) — two FE asks

While verifying the cart we found `products.cost_price` (supplier cost) was
readable with the PUBLIC anon key straight from PostgREST — one request dumps
the whole cost table. Backend mig 137 revokes the column from `anon`
(column-level grants, same mechanism as the mig 129 FOR-USE-IN lockdown).
Backend reads all moved to the service client; API responses are unchanged
(`cost_price` was always stripped). Two things land on your side:

1. **PDP related-products fallback (small, real):** `product-detail-page.js`
   (~line 1804) does `sb.from('products').select('*')` for the manually-curated
   `related_product_skus` fallback. Under column-level privileges, `select=*`
   errors for `anon` — supabase-js surfaces `{data: null}`, your optional
   chaining eats it, and the fallback silently returns nothing for SIGNED-OUT
   visitors (signed-in still works; the primary `/api/shop?code=` related rail
   is unaffected). Fix: replace `select('*')` with the explicit column list the
   card renderer actually uses. Grep for any other `.from('products').select('*')`
   in non-admin code while you're there (we found only this one).

2. **Phase 2 blocker — admin pages read `cost_price` directly:** `admin/api.js`,
   `cc2-pricing.js`, `product-search.js`, `pending-changes.js` select
   `cost_price` (and `admin/api.js:1512` uses `select('*, …')`) via supabase-js
   as the admin's `authenticated` session. Column grants can't distinguish
   admin users from shoppers inside the `authenticated` role, so we could NOT
   revoke `cost_price` from `authenticated` — meaning any self-signup account
   can still dump costs until these reads move to the backend admin API (which
   already exposes cost to `super_admin` on the relevant endpoints). Once your
   admin surfaces stop selecting `cost_price` (and drop `select('*')` on
   products), tell us and we run phase 2 (`REVOKE … FROM authenticated`).
