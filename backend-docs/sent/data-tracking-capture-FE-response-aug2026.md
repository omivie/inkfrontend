# FE response — Data tracking capture (Aug/Sep 2026)

**From:** frontend · **Date:** 2026-09-01 · **Tracking:** ERR-194
**Source:** `data-tracking-capture-fe-handoff-aug2026.md` (migrations 153–155)

**Status: all six items are built and shipped.** Two of them are shipped over a
different transport than you specified, because the one you specified is blocked
by your own CORS config and would have taken the site down rather than degraded.

Everything below was measured against **production** (`api.inkcartridges.co.nz`
— the host `Config.API_URL` actually resolves to on www/apex) on 2026-08-31 and
2026-09-01, and is re-measured on demand by `npm run probe:data-capture`
(read-only; no `--record` mode; the mode is printed on every run).

Read §1 and §7 if you read nothing else. §1 is the one that would have broken
search; §7 is the four-line list of things only you can fix.

---

## 0. What shipped

| Handoff | What the frontend does now | Verified |
|---|---|---|
| §1.1 search ids | `?sid=`/`?vid=` on `/smart` + `/suggest`; `session_id`/`visitor_id` in the `/click` body | live typeahead request captured carrying both |
| §1.2 `printer_slug` | captured at the PDP/shop, survives the server cart round-trip, sent per-item **and** order-level on both payment paths | unit + live |
| §1.3 `add_to_cart` dead | root-caused and fixed; `checkout_completed` too | live: modules present on `/shop` |
| §2.1 return taxonomy | **the return form itself had to be built** — it did not exist | live render, with `printer_model` prefilled from §1.2 |
| §2.2 quote outcome | column + modal on `/admin#quick-order` | live; save blocked by BF-021, loudly |
| §2.3 funnel | card on `/admin#dashboard` | live, against your real numbers |
| §4 `order_items` grants | verified safe, no change needed | grep + audit |

`npm test` — 4,656 passing, 0 failing, including **115 new assertions** across six
new files. `npm run probe:data-capture` — 13 passed, 0 failed, 6 noted.

---

## 1. The two transports you recommended are both blocked by CORS

### 1.1 `X-Session-Id` / `X-Visitor-Id` are not on the allow-list — **BF-054**

Your §1.1 calls the headers the default that "works on all GET search endpoints".
Measured on both hosts, both origins:

```
OPTIONS /api/search/smart   (Access-Control-Request-Headers: x-session-id,x-visitor-id)
  → 204
  Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With,
                                X-Request-Id, X-Guest-Session, X-Attribution-Source
```

Neither id header is there. **A browser does not degrade when a requested header
is not allowed — it fails the preflight and never sends the request at all.**
Confirmed from a real Chrome at `https://inkcartridges.co.nz`:

```js
fetch(API + '/api/search/smart?q=lc&limit=1', { headers: { 'X-Session-Id': 'ts_probe' } })
  → THREW: Failed to fetch
```

Shipping §1.1 as written would have taken **site search down for every customer**
to gain an analytics column. So GET search uses your documented `?sid=`/`?vid=`
fallback instead, and the click beacon carries them in its body as specified.

**This is free today, and it has an expiry date.** `/api/search/smart` and
`/suggest` both answer `cf-cache-status: DYNAMIC`, so the extra params fragment no
edge cache. If either endpoint is ever added to the Cloudflare Cache Rule, those
params become part of the cache key and shatter the shared entry one visitor at a
time. `probe:data-capture` §2 fails the moment `DYNAMIC` stops being true,
precisely so that is caught before it ships. **Add the two headers to the
allow-list and we flip one constant** (`USE_ID_HEADERS`, `js/traffic-tracker.js`)
— headers survive an edge-cache hit; query params do not reach the origin on one.

### 1.2 PATCH is not an allowed method — **BF-021, open since 2026-07-30**

`PATCH /api/admin/quick-orders/:id/outcome` is live, correct and unreachable:

```
PATCH /:id/outcome {"outcome":"bogus"}  → 400  "outcome" must be one of [won, lost, pending, null]
PATCH /:id/outcome {"outcome":"won"}    → 404  Quick order not found
   …so the route validates and looks up. Then:
OPTIONS /:id/outcome  (Access-Control-Request-Method: PATCH)
  → 204, Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS     ← no PATCH
```

From a real browser at the production origin: `PATCH → THREW: Failed to fetch`,
while `POST` to the same URL returns a clean 404. The block is CORS, not the route.

**And there is no fallback verb.** Every permitted alternative was probed:

```
POST /:id/outcome              → 404 Endpoint not found
PUT  /:id/outcome              → 404 Endpoint not found
PUT  /:id  {outcome}           → 400 "A status is required for a status-only update"
PUT  /:id  {status, outcome}   → reaches the row lookup: `outcome` is neither
                                 validated nor rejected — the decoy signature
X-HTTP-Method-Override         → not on Access-Control-Allow-Headers
```

So the pattern we used for the invoice PAID toggle (PATCH first, fall back to a
permitted verb) has nothing to fall back **to**. Writing outcome through
`PUT /:id` would send the operator's "lost to a competitor at $38.90" into a void
behind a success toast. The page therefore attempts PATCH — the correct call,
which starts working the day BF-021 lands, with no code change — and on a bare
transport failure says exactly this, once per session:

> The outcome could not be saved: the browser is blocked from sending a PATCH to
> the API (BF-021 — PATCH is missing from the backend CORS allow-list). The
> endpoint itself is live and correct. **Nothing was changed.**

It does not say "not available yet". That sentence is what hid ERR-131 for a
month over a route that was answering 401 the whole time.

---

## 2. §1.3 — `add_to_cart` and `checkout_completed`: both root causes found

You asked us to check. Both were findable, and neither was "the tracker is broken".

### `add_to_cart` — 56 events ever, and it was never really working

`cart-analytics.js` was loaded on **three** pages — cart, checkout, payment.
`cart.js`, which owns the only call site, is loaded on **thirty-three**. Every
real add-to-cart entry point — PDP, shop cards, homepage, ribbons, favourites,
business — sits behind:

```js
if (typeof CartAnalytics !== 'undefined') { CartAnalytics.trackAddToCart(...) }
```

…which was **false on every one of them**. The guard was an off-switch. What
survived were the cart page's own value-pack swap and cross-sell modal, both gated
on backend-supplied data; when that trickle stopped on 2026-08-11 the metric read
as a feature breaking rather than one that had never worked.

Your table is the proof, once you sort it by "does this event fire from a page
that loads the script": `cart_viewed` (cart page) 1,128; `checkout_started`
(checkout page) 579; `remove_from_cart` (cart page) 251; `add_to_cart` (nowhere
real) 56.

**Fixed** by enrolling all 33 pages, and by a test that walks every HTML file and
asserts *loads `cart.js` ⇒ loads `cart-analytics.js`*, so a new page cannot
silently opt out. A second fix: `addItem`'s transport-failure branch keeps the
item, saves it and shows it in the shopper's cart, then used to `return` before
tracking — so any spell of cart-API flakiness silently zeroed the metric while
people were still buying. It now emits there; the server-**rejected** branch still
does not, because that line was rolled back.

### `checkout_completed` — dead since the day before your last event

`trackOrderCompleted()` had **zero callers**. Commit `633d045` ("add custom PayPal
integration with JS SDK popup flow", **2026-03-12**) rewrote `payment-page.js` and
deleted both calls while keeping the lines around them. Your last recorded event
is **2026-03-11**.

**Not restored where it was deleted.** Both Stripe paths write `lastOrder` and
call `stripe.confirmPayment()` immediately after — the order exists, but the money
has not moved and a 3DS challenge can still fail. An event fired there counts
*attempts*, which is a worse number than none because it looks right. Every
successful path (Stripe redirect, Stripe inline, PayPal capture) lands on
`/order-confirmation`, so that is now the single place that records a completed
order, behind three guards: the payment actually succeeded (`?redirect_status=`
failures render this same page), once per pageload, and **once per order number
across reloads**.

> **Found in passing and fixed:** that third guard also closes a live defect in
> the Google Ads conversion. `gtag('event','conversion')` fired inline in both
> render branches with no dedupe, and this page deliberately keeps a localStorage
> copy of the order for an hour so a hard refresh still renders. **One refresh of
> a receipt reported a second purchase of the same order, at full value.**

---

## 3. §1.2 — `printer_slug`, and the two places it silently died

The chain already existed and ended one line short: the PDP reads `?printer_slug=`
for its "bought for this printer" proof line and then called `Cart.addItem`
without it. Now captured at the PDP and shop grid explicitly, and — for the
generic card handlers — from the page's own `?printer_slug=` URL, which is the
honest definition of "this page is scoped to that printer". Never from
`?printer_model=`, `?printer_brand=`, a brand, or a compatibility list.

Two traps, both of which delete the field with no symptom:

1. **`_parseServerCart` rebuilds every line from the server row**, and the server
   cart has no printer column — and `addItem` calls `loadFromServer()` on itself.
   A field written only onto the line is gone milliseconds after it is set, and
   would look correct in any test that did not round-trip. It is now re-attached
   from a client-side annotation map keyed by the cart's own composite line key.
2. **`calculateTotals()` re-projects `cartItems`** into a narrower shape on every
   call, stripping anything it does not name — seconds before the order POST.

**The order-level value is sent only when the cart has exactly one distinct known
slug.** Zero → omitted. Two or more → omitted, because you apply it to every line
lacking its own and picking either would attribute lines to a printer they were
not bought for. "Most common" is a guess with arithmetic in front of it. Likewise
a line added from two different printer contexts is marked *ambiguous* and reports
nothing, rather than us choosing. And an unknown printer **omits the key** rather
than sending `printer_slug: null`.

---

## 4. §2.1 — there was no return form, so we built one

Grep for `return-request` across the whole repo returned nothing.
`returns.html` is a static policy page; `order-detail-page.js` had no return code.
Your two new fields could not have collected a single row.

Shipped on `/account/order-detail`: reason (required), `issue_type` (your eight
values, optional, framed as *"What exactly went wrong?"* — the single most useful
thing a customer can tell us), and `printer_model` as free text, **prefilled from
the line's `printer_slug`** when §1.2 supplied one. The supplier is never asked
for. Blank optionals are **omitted, not sent as `''`** — an empty string would
land in the taxonomy as a real, meaningless category and dilute every rate
computed off it.

**No date cut-off, deliberately.** `js/legal-config.js` states the rule in as many
words: *faulty / not-as-described returns are never time-barred by the 30-day
window — a Consumer Guarantees Act §43 right a retailer cannot contract out of.*
A form that vanished on day 31 would be this site telling a customer they have no
rights they in fact have. The gate is on order state.

**BF-055 — we could not enumerate the `reason` enum.** `POST /return-request` is
aggressively rate-limited (`429 RATE_LIMITED`, "Too many return requests. Please
contact support directly.") after very few attempts, which is good design and did
its job on us. Only `faulty` is confirmed — it is the value your own document
shows. The form offers `faulty | damaged | wrong_item | change_of_mind | other`
and renders your validation `details` **verbatim** if one is rejected, so a bad
value names itself instead of hiding behind house copy. **Please confirm the list.**

---

## 5. §2.3 — the funnel card, and three ways it would have lied

Live payload, 2026-09-01:

```
visitors 995 → added_to_cart 2 → started_checkout 78 → completed_purchase 64
drop_off: { cart_to_checkout: -3800, checkout_to_purchase: 17.9 }
overall_conversion_rate: 6.43
meta: { window_days: 30, product_viewers: 191, sessions: 1398 }
```

1. **`-3800%`.** A funnel cannot widen. `added_to_cart: 2` beneath
   `started_checkout: 78` is not customer behaviour — it is §1.3's broken emitter,
   which we fixed in this same change. Rendering your `drop_off` beside four
   confident-looking numbers would launder a wiring bug into a business insight.
   The card names the **under-counting** stage (the earlier half of the pair — the
   one that is actually wrong), withholds **its** rate, and explains why. It keeps
   the overall visitor→order rate, which is computed from two sound numbers and
   does not route through the broken stage. The callout is measured, not
   hardcoded: it disappears on its own once the fix has a full window behind it.
2. **The percent unit.** The dashboard's existing `fmtPct` multiplies anything
   `≤ 1.5` by 100, assuming it was handed a fraction. You send `6.43` meaning
   6.43%, so a genuine 1.2% conversion rate would have rendered as **120%**. The
   card has its own formatter, pinned by a test.
3. **`window_days` is a decoy.** `?window_days=7`, `=90`, `=999` and an explicit
   `date_from`/`date_to` all return the byte-identical payload with
   `meta.window_days: 30`. A card sitting under the dashboard's date filter would
   have lied every time the operator changed it. It sends **no** query string,
   labels itself from your echo, and says on its face that it is a fixed 30-day
   window independent of the filter above it. Either honour the parameter or drop
   it from the response — accepted-and-ignored is the worst of the three.

`overall_conversion_rate: null` renders as `—`, never `0%`; `meta.data_gap: true`
renders a loud callout naming migration 155 rather than an empty chart.
`conversion-by-source` stays commented out — it still returns >100%.

---

## 6. §4 — `order_items` grants: verified safe, nothing to change

The frontend never reads `order_items` over Supabase. There is no
`.from('order_items')` and no PostgREST path anywhere in the tree; every reference
is a field on a backend API response object. No `select('*')` touches it.

The reason it held is that ERR-170 already taught this codebase the lesson —
under column-level privileges PostgREST fails the **whole** `select('*')` with
`42501`, invisibly for signed-in users — so every Supabase select here is already
column-enumerated. Migration 153 breaks nothing.

§3.1, §3.2 and §3.3 need no frontend work and we have not touched them.

---

## 7. What we need from you

| # | Ask | Effect |
|---|---|---|
| **BF-021** | Add `PATCH` to `Access-Control-Allow-Methods` | Quote outcomes start saving. **No frontend change** — the page already calls PATCH first and only reports the block. Open since 2026-07-30; this is its third feature. |
| **BF-054** | Add `X-Session-Id`, `X-Visitor-Id` to `Access-Control-Allow-Headers` | Lets us move the join key to headers, which survive an edge-cache hit. Needed **before** `/api/search/smart` is ever added to the Cloudflare Cache Rule. |
| **BF-055** | Confirm the `reason` enum on `/return-request` | We are shipping four unverified values beside your one documented one. |
| — | Confirm `?sid=`/`?vid=` are actually stored | From outside they are **indistinguishable from a decoy**: a malformed id and a nonsense param both answer 200 with an identical body. Consistent with "a bad id is dropped, not 400'd", but it means our only acceptance signal is `search/top-converting.orders` going non-null. A `400` on a malformed id would make this provable from the client. |
| — | `window_days` on `conversion-funnel`: honour it or remove it | See §5.3. |

Two observations, not asks:

- **`quick_orders` is empty in production** (`total: 0`). The outcome column and
  modal are built and correct, but the six new display fields could not be
  confirmed on a real row.
- **`search/top-converting` still returns `orders: null` for every term**, with
  your own `meta.data_gap: true` and the note *"search_analytics has no link to
  resulting orders"*. That is expected until searches carrying the ids produce
  orders — and it is the number that will prove §1.1 landed. `probe:data-capture`
  §6 watches it.

---

## 8. Verifying this

```
npm test                        # 4,656 assertions, incl. 115 new across 6 files
npm run probe:data-capture      # 13 checks against production, read-only
```

New test files: `cart-funnel-enrolment-aug2026`, `search-session-identity-aug2026`,
`printer-slug-order-plumbing-aug2026`, `admin-quick-order-outcome-aug2026`,
`return-request-aug2026`, `conversion-funnel-aug2026`.

The enrolment test is the one worth knowing about: it walks every HTML file in the
tree and fails if a page can add to cart but cannot record it. "Every surface calls
X" is a list nobody maintains — that is how this broke in the first place.
