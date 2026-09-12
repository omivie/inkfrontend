# Backend brief — an admin-only test product

**Repo**: `ink_backend` (Render: `ink-backend-zaeq.onrender.com`) · **Raised**: 2026-09-09 ·
**Frontend ref**: ERR-234 · **Frontend status**: plumbing shipped and **inert** until the
routes in §4 exist; it reports their absence loudly rather than treating it as "no results".

---

## What the owner asked for

> "I want you to create me a product that only admins can see. This product can be bought
> like a normal product but only owners can see it and add it to cart. This product will
> have 0 cost at all. This product will just be used for testing various things."

Two of those requirements were revised once measured, with the owner's agreement:

- **"only owners can see it"** → enforced **server-side**, not hidden in the UI. A visitor
  hitting `/api/shop` or PostgREST directly must not find the row. That is this brief.
- **"0 cost at all"** → **$0.50**, Stripe's published NZD minimum charge. A true $0 cannot
  be charged at all; see §6.

---

## What is measured today

Against live PostgREST, 2026-09-09, with a positive **and** a negative control:

```
GET /rest/v1/products?select=sku,admin_only&limit=1
  -> 400  {"code":"42703","message":"column products.admin_only does not exist"}

GET /rest/v1/products?select=sku,is_active&limit=1                    (positive control)
  -> 200  [{"sku":"GS0720560BK","is_active":true}]

GET /rest/v1/products?select=sku,zzz_not_a_column&limit=1             (negative control)
  -> 400  {"code":"42703","message":"...does not exist"}

GET /rest/v1/products?sku=ilike.TEST-*&select=sku,name  ->  200  []
```

**`products.admin_only` does not exist**, and no `TEST-` SKU exists in the catalogue.

This matters more than it looks, because **the frontend has shipped three pieces of
machinery that depend on that column** since before July 2026, and not one of them has ever
been able to fire:

| Frontend machinery | File | Depends on |
|---|---|---|
| `_isTestProduct()` | `js/product-detail-page.js:2813-2816` | `admin_only === true` — permanently `undefined === true` |
| PDP visibility gate | `js/product-detail-page.js:256-272` | the above, **plus** `isCachedSuperAdmin()`, itself a hard `return false` stub |
| Free shipping for test carts | `js/checkout-page.js:430-438, 469-474` | a `TEST-` SKU prefix that has never existed |
| "Test Order" banner | `js/order-confirmation-page.js:343-345, 757-768` | `orders.is_test_order` |

So the feature is roughly half-built on our side already, and has been dead the whole time.

---

## 1. Schema

```sql
alter table products add column admin_only boolean not null default false;
```

**`not null default false`** — every existing row is untouched, and the frontend never has to
decide what `null` means. Absence-as-zero is a recurring defect class on this project
(ERR-063/068/073/075/076/149/150); please do not make us guess here.

Index it if it joins the base catalogue filter.

---

## 2. Exclusion from public reads — implemented ONCE

Put `admin_only = false` in the **base catalogue query or view**, not per route. Per-route is
a list nobody maintains — that is ERR-150/160 on our side, twice, and it will be yours too.

Enumerated so an omission is visible, not so you write eighteen filters:

`/api/shop` (rows **and** the `counts` facets **and** `meta.total`) · `/api/products` ·
`/api/products/counts` · `/api/products/:sku` · `/api/products/:sku/related` ·
`/api/products/:sku/bought-together` · `/api/products/:sku/jsonld` ·
`/api/products/printer/:slug` · `/api/products/printer/:slug/color-packs` ·
`/api/products/series/:code` · `/api/search/smart` · `/api/search/suggest` ·
`/api/search/by-printer` · `/api/search/by-part` · `/api/search/compatible-printers/:sku` ·
`/api/ribbons*` · the `get_ribbons_by_brand` RPC · `product_compatibility` joins ·
`sku_redirects`.

**The counts matter as much as the rows.** A row that is filtered out of the list but still
counted gives "1–100 of N" where N is unreachable — that is exactly ERR-220, where a
fabricated total left 3,298 products unreachable.

### 2b. The SEO surfaces — the ones that cost money

These are proxied to you through our `vercel.json` and are the easiest to forget:

- `/sitemap.xml`, `/sitemap-:path.xml`
- **`/feeds/google-shopping.xml`** — leaving the row here **publishes the test product to
  Google Merchant Centre**
- `/feeds/facebook-catalog.tsv`, `/feeds/google-promotions.xml`
- the prerender routes `/p/:sku` and `/html/products/:slug/:sku`
- `/shop?printer=` (server-rendered by you)

---

## 3. RLS — load-bearing, not belt-and-braces

`anon` **and** `authenticated` policies on `products` must add `and admin_only = false`.

This is not optional hardening: **the storefront reads PostgREST directly with the anon key
in four places**, and every one of them is an open side door until RLS closes it.

| Call | File |
|---|---|
| PDP description/compat enrich | `js/product-detail-page.js:220-226` |
| `getManualProductCodes` → `_supabaseSelect` | `js/api.js:~1505` |
| `_fetchRibbonBrandsList` | `js/api.js:2160` |
| `getRibbonsByBrand` (RPC) | `js/api.js:2196` |

`get_ribbons_by_brand` is a `security definer` RPC and is **not** covered by table RLS — it
needs the filter in its own body.

---

## 4. The admin read routes — **BF-013 as written does not suffice**

We asked for BF-013 in July 2026 (`catalog-edge-caching-backend-brief-jul2026.md:93-102`):
`GET /api/admin/products/:sku`, admin-gated, `no-store`. Having now built against it, it is
the wrong ask on two counts:

1. **Wrong shape.** It sits in the `/api/admin/products` family and returns the *admin
   record*. Measured, that family omits `series_codes`, `supplier` and `supplier_sku`, and
   `cost_price` is 403 for `authenticated` (ERR-220). The PDP needs the *storefront* payload:
   `slug`, `canonical_url`, `retail_price`, `compare_price`, `description_html`,
   `compatible_devices_html`, `series_codes`, `quantity_breaks`, `product_source`.
2. **Wrong scope.** It covers the PDP only. The shop grid, `/search` and the header dropdown
   need list routes too.

### What we need instead: a mirror of the catalogue, under one prefix

```
GET /api/admin/catalog/shop?…            ==  GET /api/shop?…
GET /api/admin/catalog/products?…        ==  GET /api/products?…
GET /api/admin/catalog/products/:sku     ==  GET /api/products/:sku
GET /api/admin/catalog/search/smart?…    ==  GET /api/search/smart?…
GET /api/admin/catalog/search/suggest?…  ==  GET /api/search/suggest?…
```

Requirements, all four load-bearing:

- **Byte-identical behaviour** to the public route — same filters, same ranking, same
  pagination, same envelope — differing **only** in that `admin_only` rows are included.
  The whole value of a test product is that it rides the real code path.
- **Admin/owner gated**: `401` unauthenticated, `403` for a signed-in non-admin.
- **`Cache-Control: private, no-store`, and outside every Cloudflare cache-rule prefix.**
  See §4b — this is the one that can hurt customers.
- **`admin_only: true` carried explicitly on the row**, never signalled by absence.

### 4b. Why the mirror must never be cacheable

ERR-124 (2026-07-28): `/api/products/:sku` is edge-cached and **a bearer token does not
change the cache key**, so an admin fetching a hidden product could store it in the *shared
public* entry and serve it to anonymous shoppers. Our catalogue reads have been anonymous by
contract ever since (`js/api.js:1945-1953`, `credentials:'omit'`).

The mirror is safe **only** because the token rides a different path prefix that is never
cached. If `/api/admin/catalog/*` ever becomes edge-cacheable, this design is ERR-124 with
extra steps. Our probe asserts `cf-cache-status` is never `HIT`/`MISS` on those paths, and
re-checks the anonymous 404 immediately after an admin read.

---

## 5. The write path must refuse too — this is half of "server-side enforced"

Hiding the row from listings does nothing on its own. `POST /api/cart/items` takes a bare
`product_id` (`js/api.js:2695` sends `{product_id, quantity}` and nothing else), so anyone
who learns the UUID can add a $0.50, free-shipping product to their cart **today**.

- `POST /api/cart/items` → **`403 ADMIN_ONLY_PRODUCT`** when the product is `admin_only` and
  the caller is not an admin.
- The same rule on `POST /api/cart/validate` and `POST /api/orders`.
- **Reject mixed carts** → `400 MIXED_TEST_CART`. This is the cheapest way to keep
  `is_test_order` unambiguous, and it deletes a whole class of accounting edge cases in §8.

---

## 6. Pricing a test cart

**The price is $0.50 and it is exactly Stripe's NZD floor** (docs.stripe.com/currencies —
`0.50 NZD`, verified 2026-09-09). That has a consequence:

> **No discount of any kind may apply to a test cart.** Any coupon, loyalty redemption, B2B
> volume band or contract price takes the total below $0.50, and Stripe then rejects it with
> `amount_too_small` — *after* the customer has authorised. Please refuse discounts on an
> `admin_only` cart at `POST /api/cart/coupon` and in the volume/contract ladder.

**Shipping.** Zero-rate a cart that is entirely `admin_only`.

Note what is true today: `js/checkout-page.js:469-474` zero-rates test-cart shipping **in the
browser**, while you re-price at `POST /api/orders` and know nothing about `TEST-`. So the
displayed total and the charged total would disagree. **We are removing our client-side rule
in this same change** rather than leaving a frontend price rule standing (`js/cart.js:12-13`:
"Frontend never computes prices"). Until you implement this, a test purchase costs $0.50 plus
real shipping — which is honest, and strictly better than the reverse.

---

## 7. `orders.is_test_order`

```sql
alter table orders add column is_test_order boolean not null default false;
```

Set it when the order contains an `admin_only` line, and return it on `GET /api/orders/:number`.

**The frontend needs no change for this** — `js/order-confirmation-page.js:343-345` already
reads `order.testMode || order.is_test_order` and renders the "Test Order" banner.

---

## 8. Analytics exclusion — enumerated

The owner's requirement: test orders must not touch revenue reporting. Repeated testing would
otherwise quietly inflate the dashboards with orders that were never real.

Exclude `is_test_order` orders from:

- dashboard KPI RPCs and `kpi-summary` — revenue, order count, AOV, `invoice_revenue`,
  `invoice_orders`; overview buckets; financial-health P&L; margin; COGS; Stripe fees
- `cart_analytics_events` and add-to-cart conversion; acquisition and traffic-conversion joins
- loyalty points accrual
- "customers who bought" / related-product and bought-together signals
- **GA4 and Google Ads purchase conversions.** This is the easiest to miss and the only one
  that costs real money — a stream of $0.50 purchases forwarded through the Measurement
  Protocol corrupts Smart Bidding.

### 8b. The ERR-197 interaction — please fix both sides in one deploy

Invoiced sales are **cash basis**, booked on the *shadow order's* `created_at`, **not**
`issue_date` (ERR-197). Therefore:

- an `INV-` shadow order for a test invoice must itself carry `is_test_order`;
- `invoice_revenue` / `invoice_orders` **and** the `/api/admin/invoices` list must exclude
  test orders **consistently**.

If those two diverge, `js/admin/utils/invoice-cash-basis.js` refuses the deduction and the
dashboard falls back to unadjusted accrual behind a banner. That is correct fail-loud
behaviour on our side, but it means an inconsistent backend **visibly breaks the dashboard**
rather than quietly skewing it.

---

## 9. Seed row

So we have something to point at:

```
sku            TEST-ADMIN-001
name           Admin Test Product
retail_price   0.50
admin_only     true
is_active      true
```

with a real weight, category and brand. **It must be an ordinary product in every respect
except the flag** — that is what makes it a useful test of the real pipeline.

---

## What we are shipping on our side

1. `js/admin-preview.js` — a five-state machine (`anonymous` · `granted` · `refused` ·
   `unreachable` · `unsupported`) reusing the single `verifyAdmin()` call we already make.
2. `_catalogRoute()` in `js/api.js` — one pure function that swaps the path prefix and flips
   anonymity, wired at five transport sites. **Identity until §4 exists.**
3. The client-side test-cart shipping rule **removed** (§6).
4. A Stripe-floor guard so a sub-minimum total is refused visibly instead of by Stripe after
   authorisation.
5. The PDP gate revived (§4), as a *second* lock — the real enforcement is §2/§3/§5.
6. `npm run probe:admin-only` — read-only, and it **exits 2 ("could not run"), never 0**,
   until the routes exist. A probe that cannot look must never report that it looked.

**Capability detection**: on `granted` we issue one `GET /api/admin/catalog/shop?limit=1`. A
404 puts us in `unsupported` and disables admin preview loudly. So this brief can land in any
order without breaking the storefront.

---

## Sequencing constraint — please read before deploying

**Do not add `admin_only` to any PostgREST-facing filter before the column exists.** Measured:
PostgREST answers `400 / 42703`, **not** an empty set. A premature filter would take down the
ribbon brand pages, the PDP enrich and the manual-codes reads outright — the same shape as
ERR-193, where a failed read printed empty-shelf copy on 63 brand pages for 44 hours.

Column first (§1), then the filters (§2/§3), then the routes (§4).
