# Admin-only test product — FE handoff

**Answers**: `admin-only-test-product-backend-brief-sep2026.md` (ERR-234) ·
**Date**: 2026-09-09 · **Status**: nothing shipped yet — one decision from you (§2)
gates the largest item · **Evidence**: `admin-only-test-product-backend-response-sep2026.md`
(same folder) has the measurements behind every claim here.

Frontend line numbers from your brief are repeated **unverified** — the storefront repo
isn't checked out on the backend side. Everything backend-side below was measured
against live code on `main` and the live Supabase database.

---

## 1. Three things that change your plan

**(a) The feature already exists — as a SKU prefix, not a column.**
An admin-only product in this backend is a **`TEST-` / `ADMIN-` SKU prefix** gated on
`super_admin`, wired at ~60 call sites. Your `TEST-` machinery in `js/checkout-page.js`
was written against a **real** backend convention. Your probe returned `[]` because
nobody has ever created the row — not because the prefix is meaningless.

That means four of your asks are already satisfied server-side (§3), and it means the
seed row is safe from day one: the moment we create `TEST-ADMIN-001`, ~60 existing
guards already hide it.

**(b) Your `admin_only` plan is still right — we're doing it.**
We'll add the column and **backfill it from the prefix**, so
`_isTestProduct()` (`admin_only === true`) starts working with **no FE change**. A CHECK
constraint keeps the two mechanisms from ever disagreeing. You were right that
absence-as-zero is the wrong contract; it'll be `not null default false` as you asked.

**(c) Two risks in your brief don't exist, and one you didn't list does.**

- Shipping is **already** zero-rated server-side for an all-test cart, in four places
  including `POST /api/orders`. There is no displayed-vs-charged divergence. Removing
  your client-side rule is still correct — nothing regresses when you do.
- The Stripe floor is **already** enforced *before* authorisation:
  `400 ORDER_TOTAL_TOO_LOW`. You will never see `amount_too_small` post-auth. Your
  planned guard is fine as UX, but it isn't preventing a live failure.
- **The one you didn't list**: the repricing engine. Measured — a test row with
  `cost_price = 0.01` gets lifted to **$5.49** by the first full-catalogue reprice, and
  the no-decrease ratchet means it never comes back down. We're pinning it
  (`cost_price = 0` + `manual_retail_price = 0.50`). Worth knowing because if the price
  ever silently becomes $5.49, that's the cause.

---

## 2. The one decision we need from you

**Do you still want `/api/admin/catalog/*`?**

Our recommendation is **no**, because the public routes already do what the mirror
would do: a `super_admin` caller gets the hidden rows on the **real** code path today
(`/shop`, `/products`, `/products/:sku`, `/products/by-slug/:slug`, all four search
routes). A mirror would fork the four largest handlers in the codebase to reproduce
behaviour that already exists — and "byte-identical to the public route" is precisely
the guarantee a fork cannot hold across the next ranking or pagination change.

Your §4b cache argument is the one thing the mirror genuinely buys, and it's real. But
it's cheaper to buy it directly:

- `Cache-Control: private, no-store` + `Vary: Authorization` on any catalogue response
  computed with `isSuperAdmin === true`;
- a Cloudflare rule bypassing cache for requests carrying `Authorization`.

That closes ERR-124 **including on the anonymous paths a mirror would never touch**.
For what it's worth, the in-process caches already key on the admin flag, and `/shop`'s
only public CDN header is already guarded by `if (!req.user)` — the residual risk is
entirely at the edge, which is where we'd fix it.

**Pick one:**

| | What we build | What you do |
|---|---|---|
| **A — recommended** | Cache headers on the existing routes | `_catalogRoute()` stays identity; drop the prefix swap; keep `verifyAdmin()` |
| **B** | `/api/admin/catalog/*` as **thin `requireAdmin` + `no-store` wrappers that delegate to the existing handlers** | Ship `_catalogRoute()` as designed |

Option B is available and we'll do it if you prefer the explicit prefix and the clean
404 capability probe. What we won't do is copy the handlers — B is wrappers, so
byte-identical stays structurally true.

Either way **your capability detection works unchanged**: the routes 404 today, so
`unsupported` is the honest state and the storefront stays safe.

---

## 3. What you can rely on today (already live — build against it)

Don't write defensive code for these; they're done:

| Surface | Behaviour for a `TEST-` / `ADMIN-` SKU |
|---|---|
| `/api/shop` — rows, facets **and** counts | excluded (counts excluded in SQL) |
| `/api/products`, `/api/products/counts` | excluded |
| `/api/products/:sku`, `/products/by-slug/:slug` | **404** unless super_admin |
| `/api/products/:sku/jsonld`, `/:sku/for-use-in` | 404 |
| `/api/search/smart`, `suggest`, `autocomplete`, `by-printer`, `by-part`, `popular` | excluded |
| `/api/ribbons`, `/brands`, `/models`, `/device-*` | excluded |
| **`/feeds/google-shopping.xml`** | excluded — **cannot reach Merchant Centre** |
| `/feeds/facebook-catalog.tsv`, `/feeds/google-promotions.xml` | excluded |
| `sitemap-products / brands / accessories / brand-categories .xml` | excluded |
| Prerender `/product/:sku`, `/product-by-slug/:slug`, `/home`, `/category`, `/brand`, `/shop` | 404 / excluded |
| Cart, order and shipping **totals** | test-only cart ships free, server-side |

Your §2b worry — "leaving the row here publishes the test product to Google Merchant
Centre" — is already handled. Good instinct; it was the right thing to flag.

**Not yet guarded** (we're fixing these): `/products/series`, both printer product
grids, the five `/products/:sku/{related,bought-together,constituents,xl-upgrade,accessories}`
rails, `/ribbons/:sku`, prerender printer pages, `/api/schema/printer/:slug`.

---

## 4. The contract we'll ship

Envelope is unchanged: `{ok: true, data, meta?}` / `{ok: false, error: {code, message, details?}}`.

**Product rows**

```
admin_only: boolean     // always present, never null; true only on hidden rows
```

Carried explicitly on admin-visible responses, never signalled by absence — as you
asked. It will **not** appear on public payloads (those rows are excluded anyway).

**Cart / checkout refusals** — new, this is your §5:

| Endpoint | Status | `error.code` |
|---|---|---|
| `POST /api/cart/items` | 403 | `ADMIN_ONLY_PRODUCT` |
| `POST /api/cart/validate` | 403 | `ADMIN_ONLY_PRODUCT` |
| `POST /api/orders` | 403 | `ADMIN_ONLY_PRODUCT` |
| any of the above, mixed cart | 400 | `MIXED_TEST_CART` |

Enforced at the API layer **and** inside `create_order_atomic()` — order creation is one
Postgres transaction, so an API-only check would be bypassable by any future caller.

**Already exists, no change:** `400 ORDER_TOTAL_TOO_LOW` when the payable total is under
$0.50 NZD after discounts.

**Orders**

```
is_test_order: boolean  // not null default false; set when any line is admin_only
```

Returned on `GET /api/orders/:orderNumber` and the order list. Your
`order.testMode || order.is_test_order` banner needs no change.

**Discounts on a test cart** — refused (coupon, loyalty, volume ladder, contract price),
so the operator gets a clear message instead of `ORDER_TOTAL_TOO_LOW`.

**The seed row**: `TEST-ADMIN-001`, $0.50, active, real brand/category/weight, stock 100.
Matches your `TEST-` prefix rule *and* `admin_only === true`.

---

## 5. Revised FE list

| Your item | Verdict |
|---|---|
| 1. `js/admin-preview.js` five-state machine | ✅ ship as designed |
| 2. `_catalogRoute()` | ⏸ hold — depends on §2. Identity under A |
| 3. Remove client-side test-shipping rule | ✅ ship — but note the backend has always zero-rated it; nothing regresses |
| 4. Stripe-floor guard | ✅ ship as UX — backend already refuses pre-auth with `ORDER_TOTAL_TOO_LOW` |
| 5. Revive the PDP gate | ✅ ship as a second lock |
| 6. `npm run probe:admin-only` | ✅ ship. Suggest probing for the **column** as well as the routes — `sku=ilike.TEST-*` returning `200 []` is expected and correct until the seed row lands |

Your "exits 2, never 0, until the routes exist" rule is exactly right and we're not
asking you to relax it.

---

## 6. Sequencing

Column → RLS → write path → the unguarded reads → **seed row last**. The seed row is
deliberately last: while it doesn't exist, every remaining gap is theoretical, and from
the moment it does exist the ~60 prefix guards already cover it.

Your sequencing warning stands and we're honouring it: **do not filter on `admin_only`
before the column lands.** PostgREST answers `400 / 42703`, not an empty set. (One
detail for your own risk model: `products` has no table-level SELECT grant for
`anon` — only column grants — so `select('*')` on it already fails today. Adding an
ungranted column can't break your existing reads. Your direct-PostgREST reads must
already be using explicit column lists.)

**Your four direct-PostgREST reads are the one place RLS is the only lock**, and you
were right to call it load-bearing. We're fixing the policy. Note for accuracy:
`get_ribbons_by_brand` is `SECURITY INVOKER`, not `SECURITY DEFINER` — table RLS
*does* reach it, so it's covered by the policy fix rather than needing its own filter.

---

## 7. What we need back

1. **§2: A or B.** Everything else is settled and we can start without you.
2. Nothing else — shout if any of the §4 field names or error codes clash with
   something you've already shipped.
