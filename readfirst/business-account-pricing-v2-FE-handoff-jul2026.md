# Business Account pricing — Frontend handoff (Jul 2026, v2: volume discount)

> **⚠️ THE NUMBERS IN THIS DOCUMENT ARE SUPERSEDED (2026-08-02).**
> The **mechanism** described below is still exactly right. The **matrix is not**:
> the backend re-seeded it on 2026-08-02 (migration 127, commit `a9bff6d`) — top
> discount 18% → **10%**, breaks 3/5/10/20 → **3/4/7/8** (under $100) and
> **2/3/6/7** ($100+), and 4 bands → **6**. Every "Buy 5+ / Buy 10+ / 20+" example
> below is stale, and this document's original worked example matched no live band
> even when it was written.
>
> Current matrix: [`business-volume-discount-range-update-aug2026.md`](./business-volume-discount-range-update-aug2026.md).
> Live truth: `npm run sweep:b2b` → `tests/fixtures/business-pricing-sweep.json`.
> See ERR-140.

**What changed from v1:** the flat bronze/silver/gold account tiers are **gone**. A business account's discount is now a per-line **volume discount** whose % depends on **(the product's unit price band × the line quantity)** — buy more of an item to save more, and cheaper items discount deeper. It is still floor-clamped so no line is ever sold below a 5% net margin, and it is still computed by one backend helper so the shown price always equals the charged price.

## TL;DR for the FE
1. On product pages, when the signed-in user is a business account, call **`GET /api/business/pricing?skus=…`** and render a **quantity-break table** per SKU: "Buy 5+ $X · Buy 10+ $Y · …".
2. Every price the endpoint returns is **exactly** what the cart/checkout charges at that quantity — safe to display.
3. In the cart, read the **`b2b_discount`** block (now `source: "volume"`); `discount_amount` is authoritative.
4. Business accounts **cannot use promo coupons** — the two are mutually exclusive (see §3).
5. There is no more `pricing_tier` / bronze-silver-gold anywhere. Remove any UI that shows it.

## Who is a business account?
`GET /api/business/status` reports whether the signed-in user has an active business account (`status: "approved"` + `net30_approved`, `credit_limit`, …). It **no longer returns `pricing_tier`**. Only show business pricing when this reports an active account; non-business and guest users see standard retail everywhere.

## 1. Product-page volume price breaks — `GET /api/business/pricing`

Auth: signed-in **business** user (`requireB2B`; 403 `B2B_REQUIRED` otherwise). Rate limit 120/min/user.

Query: `?skus=SKU1,SKU2,…` — comma-separated, **max 100** SKUs (de-duped server-side).

Response:
```json
{
  "ok": true,
  "data": {
    "source": "volume",
    "items": [
      {
        "sku": "GTN251BK",
        "found": true,
        "is_active": true,
        "retail_price": 34.99,
        "quantity_breaks": [
          { "min_quantity": 3,  "discount_percent": 5,  "business_price": 33.24, "effective_percent": 5.0,  "savings_amount": 1.75, "floored": false },
          { "min_quantity": 5,  "discount_percent": 8,  "business_price": 32.19, "effective_percent": 8.0,  "savings_amount": 2.80, "floored": false },
          { "min_quantity": 10, "discount_percent": 11, "business_price": 31.14, "effective_percent": 11.0, "savings_amount": 3.85, "floored": false },
          { "min_quantity": 20, "discount_percent": 14, "business_price": 30.09, "effective_percent": 14.0, "savings_amount": 4.90, "floored": false }
        ]
      },
      { "sku": "NOPE-1", "found": false }
    ]
  }
}
```

Field notes:
- `retail_price` — standard retail (GST-inclusive), same as the public PDP. Render as "retail".
- `quantity_breaks[]` — the ladder for **this product's price band**, ascending by `min_quantity`. Each rung:
  - `min_quantity` — buy this many (of this one product) to unlock the rung.
  - `business_price` — the per-unit price (GST-inclusive) charged at that quantity. **This is what checkout charges.**
  - `discount_percent` — the ladder ceiling for the rung; `effective_percent` is what actually landed after the floor (usually equal; **lower** when `floored`).
  - `savings_amount` — `retail_price − business_price` per unit.
  - `floored` — `true` when the loss floor reduced/suppressed the rung's discount for this SKU.
- An **empty** `quantity_breaks` means no volume discount applies to this SKU's band (e.g. an admin disabled it) — show standard retail only.
- `found:false` — SKU not in catalog.

Suggested copy: a compact table — "Buy 5+ → $32.19 ea (save 8%)". On a rung where `floored:true`, show the `business_price`/`savings_amount` but avoid advertising the ceiling `discount_percent`.

## 2. Cart — B2B discount is per-line, floored, volume-based

`GET /api/cart` (and every cart-mutation response) carries `b2b_discount`, now computed per line from the volume ladder:

```json
"b2b_discount": {
  "company_name": "Acme Print Co",
  "effective_percent": 9.4,       // realized % across the cart after flooring
  "discount_amount": 18.60,       // sum of per-line floored savings — AUTHORITATIVE
  "floored_line_count": 1,        // how many lines had their discount reduced
  "source": "volume"
}
```
- `discount_amount` is authoritative and already reflected in `summary.b2b_discount` and the totals.
- There is **no** `pricing_tier` / `discount_percent` ceiling field anymore (the ceiling varies per line).
- Guest/non-business carts: `b2b_discount` stays `null`.
- Encourage volume: since the discount is per-line quantity, a "add N more of this item to reach the next break" nudge maps directly to the ladder.

## 3. Coupons are mutually exclusive with volume pricing (B2B)
A business account gets automatic volume pricing and **cannot also apply a promo coupon** (a coupon isn't floor-clamped, so stacking could sell below cost).
- `POST /api/cart/coupon` for a B2B user → **400** with code `B2B_COUPON_EXCLUDED` and message "Business accounts receive automatic volume pricing; promo codes can't be combined." Surface this inline on the coupon field; don't treat it as an invalid-code error.
- `POST /api/cart/coupon/preview` → `200` with `{ valid: false, reason: "b2b_volume_pricing", message: … }`.
- Loyalty points still work for B2B (a points credit, bounded separately) — only coupons are blocked.

## Never sell at a loss — why the discount flexes
Each ladder % is a **ceiling**. Every unit's discount is capped so the unit still nets ≥ 5% after Stripe fees. Fat-margin items get the full ladder %; thin items (some genuine toners) are reduced (`floored:true`) or suppressed. This is identical across the PDP table, the cart, and checkout — one backend helper — so the displayed price is always the charged price. **Never recompute the discount client-side.**

## Do / don't
- ✅ Render `business_price` / `savings_amount` / `effective_percent` verbatim from the API.
- ✅ Gate business pricing on `GET /api/business/status` reporting an active account.
- ✅ Batch SKUs (≤100/call) on listing pages; one call per PDP.
- ✅ Handle the `B2B_COUPON_EXCLUDED` case on the coupon field.
- ❌ Don't compute `retail × (1 − %)` — it disagrees with the floored price on thin items.
- ❌ Don't reference `pricing_tier` / bronze-silver-gold — it no longer exists.
- ❌ Don't cache business prices across users — they must not leak to non-business shoppers.
```
