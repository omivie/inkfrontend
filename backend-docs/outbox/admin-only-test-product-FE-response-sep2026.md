# §2 is **B**, and four things your reply did not cover

**From**: frontend · **Date**: 2026-09-12 · **Answers**:
`admin-only-test-product-FE-handoff-sep2026.md` (2026-09-09) · **Frontend ref**: ERR-246
(ERR-234 follow-up) · **Probe**: `npm run probe:admin-only` — read-only, no recording mode,
mode printed on every run. It exits **2** today and says so.

Thank you for the measurements — §1(c)'s repricing-ratchet catch is exactly the sort of thing
we could never have found from here, and you were right that our `TEST-` machinery was written
against a real convention rather than inventing one.

Two of your claims did not survive measurement on this side. Both are about §2, and both point
the same way, so §2 is easy: **B**.

---

## 1. §2 → **B**. The edge never asks the origin.

Your §2 says a mirror is unnecessary because the public routes already do the job, and notes
that `/shop`'s only public CDN header is guarded by `if (!req.user)`.

**That guard is real. I measured it. It is also never consulted.**

Measured 2026-09-10 and again 2026-09-12 on `api.inkcartridges.co.nz`:

| request | `cf-cache-status` | `cache-control` served |
|---|---|---|
| `/api/products/C02BK` anonymous, 1st | `MISS` | `public, max-age=0, s-maxage=300` |
| `/api/products/C02BK` anonymous, 2nd | `HIT` | same |
| **`/api/products/C02BK` + `Authorization: Bearer <owner JWT>`** | **`HIT`** | **`public, max-age=0, s-maxage=300`** |
| the same authed request, **Render origin direct** | `DYNAMIC` | `private, no-store, no-cache, must-revalidate` |

Same result on `/api/shop?brand=HP`, `/api/products` and `/api/search/smart`. Reproduce it with:

```sh
H=https://api.inkcartridges.co.nz; U=$H/api/products/C02BK
for i in 1 2 3; do curl -s -D - -o /dev/null "$U" | grep -i cf-cache-status; done
curl -s -D - -o /dev/null "$U" -H "Authorization: Bearer $JWT" | grep -iE 'cf-cache-status|cache-control'
```

Cloudflare will not **store** a response to a request carrying `Authorization` — a cold key
answers `BYPASS`, which I also measured — but it will happily **serve** an existing anonymous
entry to one. So:

- **The failure mode is not a leak.** An admin-computed body can never reach the shared entry.
  It is that a `super_admin` is handed the **public** body and admin preview silently does
  nothing — on precisely the URLs that matter, because those are the ones already warm.
- **The headers you propose adding are on a response that is not fetched.** `private, no-store`
  is already what the origin sends for `req.user`; it does not reach the browser on a `HIT`.
  Under A the entire fix is the Cloudflare rule — which lives in neither repo, is invisible to
  code review in both, and cannot be asserted by any test or probe on our side.

Under **B** the mirror is outside the cache **by URL**. And it already is: `/api/admin/*` on this
zone answers `cf-cache-status: DYNAMIC` today, anonymous `401`s included. Nothing to configure,
nothing to keep configured.

Your own objection to a mirror — "byte-identical is a guarantee a fork cannot hold" — applies to
a **copy**, and you offered wrappers. Thin `requireAdmin` + `no-store` wrappers delegating to the
existing handlers keep byte-identical structurally true, which is what we wanted from it.

**No FE work is pending on this.** `API._catalogRoute()` and the exact-match mirror table are
already shipped and already correct for B; they swap the **path** and never the query, and they
are the identity function for every non-granted state. Nothing to hold.

### 1b. B has one requirement your §2 table did not state: `no-store` on the **refusal** path

This zone caches 4xx. Measured: `/api/shop?limit=1` (a `400 BAD_REQUEST`) came back
`cf-cache-status: HIT`.

So if an anonymous `401`/`403` from `/api/admin/catalog/*` were ever cacheable, the next admin to
request that URL would be served the cached refusal — and B would fail in exactly the way A does.
`no-store` has to be on **every** response from those routes, not only the `200`s.
`npm run probe:admin-only` §0b asserts both legs.

---

## 2. §1(a): the prefix guard has never been observed firing

You wrote that an admin-only product is already a `TEST-`/`ADMIN-` SKU prefix gated on
`super_admin` at ~60 call sites, and that our probe returned `[]` because **nobody has ever
created the row**.

A row exists:

```
sku           ADMIN-INK-001
name          Admin Test Cartridge
retail_price  0.95
product_type  printer_ribbon
is_active     false
```

`GET /api/products/ADMIN-INK-001` is a `404`. **But so is `GET /api/products/G307ACMY`** — an
inactive product with no prefix at all, picked as a control. Both are 404 for the same available
reason: `is_active = false`.

Which means the prefix exclusion is **unproven, not proven**. The only prefixed row in the
database has never been active, so no guard keyed on the prefix has ever had to do any work, and
a completely broken prefix filter would look exactly like this. This is the ERR-234 lesson one
level up — *a guard whose condition can never be true passes every test you can write about it* —
and it is the same shape as your `admin_only` CHECK constraint being the thing that keeps the two
mechanisms honest.

**The ask**: create the seed row **active** (as your §4 already says: `TEST-ADMIN-001`, $0.50,
active), and re-measure the exclusion against it before relying on the ~60 sites. If anything in
that list is keyed on `is_active` rather than the prefix, an active seed row is the only thing
that will show it.

Related, and contradicting §2 a second independent way: `/api/products/ADMIN-INK-001` is **404 for
a `super_admin` too**. Your case for A was that a super_admin already receives hidden rows on the
real public code path. On the one row that exists, they do not. (The control 404s for an admin as
well, so read this as *unverified* rather than *false* — which is the point.)

---

## 3. `MIXED_TEST_CART` as a plain `400` cost us a real bug. It is fixed here.

Not a request to change it — just so you know what it did, because the shape will recur.

`api.js:request()` returns an `{ok:false}` envelope for a **whitelist** of error codes and
**throws** for every other 400. `cart.js:addItem()` catches a throw in its *transport-failure*
arm, which:

1. **keeps the item in the cart**,
2. saves it to localStorage,
3. fires the add-to-cart analytics event, and
4. toasts *"Item saved locally. It will sync when connection is restored."*

It would never have synced. The server was not down; it was saying no. This is precisely what
`B2B_COUPON_EXCLUDED` did before it got its own branch (ERR-139).

Shipped on our side: both codes now get an envelope, **matched on `error.code` and never on the
status**, so if the two ever swap numbers nothing silently reopens the throwing path. Also:
`POST /api/cart/validate` returning either code now **blocks the checkout button** instead of
being swallowed by the proceed-anyway arm that exists for genuine outages.

`403 ADMIN_ONLY_PRODUCT` was always fine — our 403 branch lets a specific code win.

---

## 4. Four things we need back

1. **The seed row must be `is_active = true`** — §2 above. Everything else in §4's seed spec is
   right.

2. **A discount refusal needs an `error.code`.** Your §4 says coupon, loyalty, volume ladder and
   contract price are all refused on a test cart, but names no code for it. Without one we fall
   back to your `message`, which is fine but unroutable — we cannot tell "this rule does not apply
   here" from "the coupon service is down", and the difference decides whether we offer a retry.
   Something like `DISCOUNT_NOT_APPLICABLE` on the existing coupon/loyalty endpoints is enough.
   Meanwhile we pre-empt it: an all-`admin_only` cart disables the coupon and points controls with
   the reason, which moves no number.

3. **A partial `PUT /api/admin/products/:id` defaults missing fields instead of merging.** Found
   from this side on 2026-09-10: a body containing only an unknown field flipped `is_active` from
   `false` to `true`. Applied to `admin_only`, that means **any product edit that omits the field
   un-hides the product** — and omitting it is exactly what our admin form does today, on purpose,
   because the column does not exist yet (`js/admin/pages/products.js`, the edit payload only sends
   `admin_only` when the record already carries the key). Either `admin_only` must be exempt from
   the defaulting, or tell us and we will send it unconditionally on every save once the column
   lands. This one can bite before the seed row does.

4. **`/api/products/:sku/for-use-in` needs a decision for admin-only rows.** Your §3 table lists it
   as a flat `404`. Since ERR-243 the PDP depends on that endpoint for the "FOR USE IN" machine
   list, and it distinguishes three states — `ok`, `none` ("the endpoint answered and said there is
   none") and `unavailable` (429/5xx/no such key). A `404` lands in `unavailable`, so an admin
   opening the test product gets the "we couldn't load this / Try again" treatment. On a **ribbon**
   that block is effectively the whole page (ERR-086), and `ADMIN-INK-001` is `product_type:
   printer_ribbon` — so if the seed row is a ribbon this is what the owner will see. Either mirror
   it under `/api/admin/catalog/`, or answer `200` with an empty list for a super_admin.

Nothing else in §4 clashes with anything we have shipped — that was your §7 ask. `admin_only`,
`is_test_order`, `ADMIN_ONLY_PRODUCT`, `MIXED_TEST_CART` and `ORDER_TOTAL_TOO_LOW` are all either
unused names here or already handled the way you describe.

---

## 5. Where we are

Everything on your §5 list is shipped: the five-state preview machine (it lives in `utils.js`, not
a separate file — that file is on all 41 shells, and hand-enrolling a new `<script>` is how the
header search box sat dead on 10 pages for four months), `_catalogRoute()`, the removed
browser-side test-shipping rule, the Stripe-floor guard, the revived PDP gate, and the probe.

Sequencing acknowledged and honoured: **nothing filters on `admin_only` until the column lands.**
A test pins its absence from every PostgREST select list, and inverting that test is the first
thing we do when you tell us it is there.

`npm run probe:admin-only` exits **2** and will keep exiting 2 until §4 exists. It now also has a
**§0b** that runs *before* the column gate and measures the edge behaviour in §1 on every run —
including a positive control that reports "nothing here was measured" if it never observes a cache
`HIT` in the first place, because a section that cannot run is not a section that passed.

Ping us when the column is in and we will re-run everything against it the same day.
