# Volume pricing for everyone — backend brief (Aug 2026)

**From:** frontend · **Date:** 2026-08-08 · **Tracking:** ERR-149 (FE), BF-032…BF-038 (backend)
**Background:** `readfirst/business-account-pricing-v2-FE-handoff-jul2026.md` (mechanism),
`readfirst/business-volume-discount-range-update-aug2026.md` (the live 6-band matrix),
`business-account-volume-pricing-FE-response-jul2026.md` (what the FE verified),
`catalog-edge-caching-backend-brief-jul2026.md` (the edge-cache contract this has to live inside).

---

## Start here

| Ask | What it wants | Blocking? |
|---|---|---|
| **BF-032** | Put `quantity_breaks[]` on the public catalog payloads | **yes** — primary ask |
| **BF-033** | A batch endpoint — **fallback only**, if BF-032 is refused | no |
| **BF-034** | Apply the volume discount to **every** cart, guests included | **yes** |
| **BF-035** | **Does the loss floor compose with a coupon?** | **yes** — answer before launch |
| **BF-036** | Scope `B2B_COUPON_EXCLUDED` to business accounts, not to "cart has a discount" | **yes** |
| **BF-037** | Keep the loss floor; keep the prerender at retail | no — a "don't change this" |
| **BF-038** | Confirm the Cloudflare Cache Rule covers whatever path ships | no |

**Two things to read before the rest:**

1. **BF-035 is a commercial decision, not an implementation.** It is the only item here that we cannot
   answer for you and cannot detect from the client. Everything else can proceed in parallel; this one
   gates launch.
2. **Ordering: BF-034 must ship BEFORE or WITH BF-032 — never after.** The presence of
   `quantity_breaks` on a public payload is what the storefront treats as your promise that the cart
   charges it. Payload-first means we advertise "$21.82 at 3+" to a guest whom checkout then charges
   full retail. Cart-first is merely a pleasant surprise. Details under "The contract we're relying on".

Nothing on the storefront changes for shoppers until BF-032/BF-034 land — the frontend work is done
and inert, so there is no clock on your side beyond BF-035.

---

## What we want

**Every shopper gets volume pricing — including signed-out guests.** Today the quantity ladder
("Buy 3+ → $21.82 each") is visible and chargeable only to approved business accounts. We want it to
be the ordinary price of buying more than one of something.

**The one ladder is identical for everyone.** A business account and a guest see and pay the same
price at the same quantity. That is the decision, and it is what makes the data public — see BF-032.
Business accounts keep Net 30, credit limits, consolidated invoices and the Business Centre; they no
longer keep a different price.

## Why we can't do this on our side

The frontend never computes a price — that is the standing rule from the v2 handoff, and it is right:
`discount_percent` is a ceiling, and you floor every unit so nothing nets below 5% after Stripe fees,
so `retail × (1 − %)` disagrees with what checkout charges on thin-margin items. Two consequences:

1. We cannot show a ladder we aren't given. Verified live today:
   ```
   curl -s "https://ink-backend-zaeq.onrender.com/api/business/pricing?skus=CLC133CMY"
   → 401 {"ok":false,"error":{"code":"UNAUTHORIZED","message":"Missing authorization header"}}
   ```
2. We cannot make the cart charge it. The discount is applied server-side when the cart recognises a
   business account.

So this is a backend change with a frontend follow-on, not the other way round.

---

## BF-032 — Put `quantity_breaks[]` in the public catalog payloads (primary ask)

Add the ladder to the product objects already returned by `/api/products`, `/api/shop`,
`/api/products/:sku`, the ribbons endpoints and `/api/search/*` — and to `/api/cart` line items.
Identical for every visitor, no auth, no `Vary`.

Everything else the ladder needs is already on those objects. Verified live on
`/api/products?page=1&limit=2`:

```
id, sku, slug, name, manufacturer_part_number, retail_price, compare_price, color, page_yield,
stock_quantity, image_url, color_hex, is_featured, product_type, category, source, pack_type,
brand, in_stock, series_codes, yield_tier, price_includes_gst, gst_amount, waitlist_available,
canonical_url, image_thumbnail_url, image_srcset
```

`sku` and `retail_price` are there; `quantity_breaks` is the only field missing. Same element shape
as `/api/business/pricing` returns today, so nothing on our side needs a new parser:

```json
"quantity_breaks": [
  { "min_quantity": 3, "discount_percent": 3, "business_price": 21.82,
    "effective_percent": 3.0, "savings_amount": 0.67, "floored": false }
]
```

Keep the existing semantics exactly: `effective_percent` is what actually landed (we never render the
ceiling), `savings_amount` is per unit, `floored` marks a rung the loss floor reduced, an **empty**
array means this band has no volume discount, and a ladder whose rungs all floor away to retail comes
back empty rather than as zero-saving rungs.

**Please prefer this over a public `?skus=A,B,C` endpoint.** Two concrete reasons:

- **A SKU-list URL is close to uncacheable at the edge.** The cache key is the exact set × exact
  order, and our grids request up to 200 SKUs. Per `catalog-edge-caching-backend-brief-jul2026.md`,
  the Cache Rule is **path-prefix based**, so a new `/api/pricing/*` path would match no rule and not
  be edge-cached at all. Embedding rides cache entries that are already warm.
- **It deletes the client fetch layer entirely.** Grids already hold the product array they just
  fetched; the PDP already holds its product. With the field embedded, no surface makes a second
  request, and a guest browsing the shop generates **zero** extra calls. Without it, we add one
  origin round-trip per grid paint for 100% of traffic to serve a discount that is currently
  requested by ~0.1% of sessions.

Payload cost is roughly **2 KB per 20-product grid**.

### The contract we're relying on

**The presence of `quantity_breaks` in a public payload is your promise that the cart will honour
those prices at those quantities.** We are deliberately not adding a frontend feature flag, because a
client boolean cannot know whether the cart agrees — and getting the order wrong is the worst
possible failure here: we would advertise "$21.82 each at 3+" to a guest on a product page and then
charge them full retail at checkout. If BF-032 ships before BF-034, that is exactly what happens.

**So: ship BF-034 (cart) before or with BF-032 (payload), never after.** If they must be staged, ship
the cart change first — a cart that discounts before the PDP advertises it is a pleasant surprise; the
reverse is a lie on our highest-intent surface.

## BF-033 — Batch endpoint (fallback only, if BF-032 is refused)

Only if embedding is genuinely not possible. Requirements:

- Sits under a path prefix the Cloudflare Cache Rule **already** matches (not a new `/api/pricing/*`).
- Anonymous, no auth, byte-identical for every visitor.
- `?skus=` comma-separated, **literal commas** (we will not percent-encode; our existing caller emits
  literal commas and encoding them would fragment every key), **sorted**, capped at 100.
- Rate limit by **IP**, generously, or not at all. The current 120/min/**user** becomes 120/min/**IP**
  for anonymous traffic, and a single office or school NAT would trip it for everyone behind it. The
  data is public and edge-cached, so the origin sees very little of this.

## BF-034 — Apply the volume discount to every cart, including guest carts

`GET /api/cart` and every cart mutation currently return `b2b_discount: null` for guests and retail
customers. Apply the same per-line volume discount to **all** carts, including the guest-session path
(`X-Guest-Session`).

Please emit it under a neutral name, with the old one kept as a transitional alias so nothing breaks
mid-deploy:

```json
"volume_discount": {
  "company_name": null,          // null for retail/guest; the company for a business account
  "effective_percent": 3.0,
  "discount_amount": 1.48,
  "floored_line_count": 0,
  "source": "volume"
},
"b2b_discount": { ...same object... }   // alias, remove once we've cut over
```

`summary.b2b_discount` is live a bare **number** (not the object) — please keep that, and add
`summary.volume_discount` as the same number.

We have already shipped our half of this: the summary row was ungated and labelled "Business account",
which would have told every discounted guest they held an account they never opened. It now reads
**"Volume discount"**, appending `— {company_name}` only when you supply one. That is ERR-149, fixed
and pinned by tests today, so BF-034 can land whenever you're ready without a copy bug.

## BF-035 — How does the loss floor compose with a coupon? *(please answer before launch)*

**This is the most important question in this brief, and it is new exposure created by this change.**

The floor guarantees each unit still nets ≥5% after Stripe fees *considering the volume discount
alone*. Today that is safe because the two shoppers who can get a discount are disjoint: business
accounts get volume pricing and are blocked from coupons; everyone else gets coupons and no volume
pricing. **After BF-034 the sets overlap.** A retail shopper buying 8 of a thin-margin item at −9%
and then applying a 15% promo code can go below cost, and nothing in the current design stops it.

Please tell us which of these is true after this change:

1. The floor is recomputed over the **combined** discount (volume + coupon), so the coupon is clamped
   too; or
2. The coupon applies after the floor and can breach it — in which case coupon economics need a
   separate cap, and that's a decision for the owner, not for either of us; or
3. Coupons and volume pricing are made mutually exclusive **for everyone** — which contradicts the
   decision recorded in BF-036 below, so flag it rather than implementing it.

We can't detect any of these from the client, and we will render whatever you charge.

## BF-036 — Scope `B2B_COUPON_EXCLUDED` to business accounts, not to "has a volume discount"

Decision from the owner: **retail shoppers keep their promo codes.** The coupon exclusion stays
business-accounts-only.

We're flagging this because the natural implementation of BF-034 breaks it by accident. If the coupon
check is written as *"this cart has a volume discount ⇒ reject the coupon"*, then the moment volume
pricing reaches retail carts, **every shopper buying 3+ of anything silently loses the ability to use
a promo code** — including every code in a live campaign. Please gate on account type explicitly.

Two related notes:

- The wire contract stays as-is: `POST /api/cart/coupon` → 400 `B2B_COUPON_EXCLUDED`, and
  `POST /api/cart/coupon/preview` → 200 `{valid:false, reason:"b2b_volume_pricing"}`. We handle both
  and will keep doing so.
- **The rule's stated reason stops being true.** The message we show is *"Business accounts receive
  automatic volume pricing; promo codes can't be combined."* Once everyone receives automatic volume
  pricing, that sentence no longer explains why business accounts specifically are excluded — it
  becomes a penalty for holding a business account, with no reason we can put in the UI. We're not
  asking you to decide it; we're asking you to confirm whether the exclusion has a rationale that
  survives BF-034, because if it doesn't, retiring it is cleaner than writing copy we can't defend.
  Whatever you decide, BF-035's answer probably determines it.

## BF-037 — Keep the loss floor, and keep the prerender at retail

- The per-unit loss floor still applies unchanged. Nothing about making this public changes the
  "never sell at a loss" guarantee, and we still render `business_price` / `savings_amount` /
  `effective_percent` verbatim and never recompute.
- **The bot prerender must not put a quantity price into `itemprop="price"` or the prerendered
  buy-box.** Our `#product-price` microdata stays qty-1 retail permanently — that's the Merchant
  Center contract, and a quantity-dependent price there would be cloaking. A JS-rendered ladder that
  is absent from the prerender is progressive enhancement and is fine; a prerendered one is not.
  Merchant Center itself is unaffected because the qty-1 price does not change.

## BF-038 — Confirm the Cloudflare Cache Rule covers whatever ships

If BF-032 ships, the ladder rides existing catalog entries and the only question is whether adding a
field invalidates warm entries (we expect a normal cold-start, which is fine). If BF-033 ships
instead, the new path needs an explicit Cache Rule or it will be uncached — please confirm which rule
matches it and that `cf-cache-status` goes MISS→HIT on a repeat request.

---

## What we're shipping on our side

Already done (no backend dependency):

- ERR-149 — the ungated summary row no longer claims "Business account" without evidence.

Ready to ship, lights up automatically when BF-032/BF-034 land — no second frontend pass:

- The ladder reads from the catalog payload instead of `/api/business/pricing`, so guests get it with
  zero extra requests and zero calls to `/api/business/*`.
- The PDP block is relabelled **"Buy more, save more"**; product cards say **"Bulk price"**.
- Volume pricing stops being advertised as a business-account perk on `/business` and the account
  dashboard; Net 30, consolidated invoices and the Business Centre remain.
- The coupon lock stays business-only and still fails **open** — a failed status check never blocks a
  retail customer's promo code.

Unchanged and staying that way: `#product-price` microdata, the "never compute a price client-side"
rule, and per-account prices never touching web storage.

## Verification we'll run against your change

```bash
# 1. The ladder is public and edge-cacheable
curl -sI "https://api.inkcartridges.co.nz/api/products?page=1&limit=20" | grep -i cf-cache-status
curl -s  "https://api.inkcartridges.co.nz/api/products?page=1&limit=2" | jq '.data.products[0].quantity_breaks'

# 2. A guest cart is actually discounted (not just advertised)
#    add 3 × CLC133CMY as a guest, then:
curl -s -H "X-Guest-Session: <id>" ".../api/cart" | jq '.data.summary.volume_discount, .data.volume_discount'

# 3. A retail coupon still applies on a cart that already has a volume discount
curl -s -X POST -H "X-Guest-Session: <id>" ".../api/cart/coupon" -d '{"code":"<live code>"}'
```

Plus `npm run sweep:b2b` re-derived against production, which with BF-032 no longer needs business
credentials — it can read the ladder off the anonymous catalog walk it already does.

**Anything you'd rather do differently, say so — the only hard requirement is BF-035's answer and the
BF-034-before-BF-032 ordering.**
