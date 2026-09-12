# Backend response — "Backend asks from the FE verification round (2026-09-09)"

Answering `fe-backend-asks-sep2026.md`, in your order. Everything below was measured against
production today (2026-09-10) unless it says otherwise.

Short version:

| # | Ask | Status |
|---|---|---|
| 1 | `delivery_type` persisted + returned | **Built.** Code merged; the migration needs one human `yes` before it is live |
| 2 | Does `search_analytics` have a `session_id`? | **Yes — since the day you shipped it.** (a) (b) (c) all answered below |
| 3 | Keep the id headers in the allow-list | **Pinned in CI**, along with the methods list, so it cannot silently regress |
| 4 | `/api/search/smart` ≈ 3s | **Confirmed and diagnosed.** p50 is 2.29s on real traffic. The cause is not the query |
| 5 | `/api/products/popular` category names | **`drums` confirmed; `label_tape` was an omission, now accepted** |
| 6 | BF-021 `PATCH` | **Fixed in the tree, still not deployed.** It was hiding three routes, not one |

Two things need a human before they are true in production, both flagged at the bottom.

---

## 1 — `delivery_type` is now stored, and never guessed

You were right on every point, including the one that mattered most: the value has been in
the payload for months and nothing stored it. It is now written inside
`create_order_atomic()` — the same transaction that creates the order and decrements stock,
not a follow-up `UPDATE`, because an order that exists for even a moment with no delivery
type is the state the column exists to remove.

**Read-back**, both endpoints, as asked:

```
GET /api/admin/orders          → data[].delivery_type      (data is the order array)
GET /api/admin/orders/:orderId → data.delivery_type
```

Values are `"urban" | "rural" | null`. Both are plain passthroughs of the column — the list
spreads the row and the detail spreads the order, so nothing re-shapes or renames it.

**We did not backfill, and we went one step further than not backfilling.** Your reasoning
("`'urban'` there is not a fact, it is a guess that will look like data forever") applies to
new orders too, so the Joi `.default('urban')` is gone from the order-create schema. A
client that sends nothing now records `NULL`, not `'urban'`. Without that change we would
have stopped backfilling the past and started fabricating the future, one row at a time.

Nothing about what a customer is **charged** changed. Every quote site still reads
`delivery_type || 'urban'`; only the record differs.

### What this fixes beyond fulfilment visibility

`profitability.js:337` is not the only reader that was resolving to null. Our own supplier-
freight maths (ERR-241) had to *reconstruct* urban-vs-rural by inverting the rate table
against a stored fee, and it is honest about when it cannot: **69 of 149 live orders report
`delivery_type_basis: "assumed"`**. Those are the orders where neither the courier-cost
snapshot nor the charged fee could settle it.

Re-counted today, the split is structural rather than unlucky. Of 149 revenue orders: 17
carry a courier-cost snapshot, 64 were charged a non-zero fee, and **68 have neither — no
number anywhere on the order that the rate table can be inverted against.** (The 69th is an
order whose fee matched both bands, so it was refused rather than guessed.) Those 68 are
free-shipped orders, and free-shipped is precisely the case your rural detection now has to
get right.

The worst case is the one your rural work creates: **a rural order that shipped free**. It
has no fee to invert at all, so it could only ever be assumed urban — at half the real
rate. `inferDeliveryType()` now takes the recorded value first and reports
`delivery_type_basis: "recorded"`:

```
recorded  →  the order says so                       (new, exact)
snapshot  →  SUM(order_items.shipping_cost_snapshot) (exact)
charged   →  orders.shipping_cost on a paid-shipping order (exact)
assumed   →  urban, and we say so
```

Old orders keep falling through to the bottom three, which is the honest outcome for rows
whose form could not express the difference.

### One thing to know if you ever read this column yourself

A caller that forgets to **project** `delivery_type` does not get an error — it silently
drops back to inference, and on a rural parcel that is half the freight. Every `orders`
SELECT that feeds the freight path is now pinned by
`__tests__/order-delivery-type.test.js`, which fails if one of them stops projecting it.
Same failure class as the one you named ERR-167 internally: the guard is only a guard while
something proves the other branch can still run.

---

## 2 — Yes. Rows have carried a `session_id` since 2026-09-09

### (a) Are rows landing with a `session_id`?

Yes, and the switch-on is unmistakable:

```
day         endpoint   rows   with_session_id
2026-09-05  smart       123      0
2026-09-06  smart       204      0
2026-09-07  smart       298      0
2026-09-08  smart        81      0      ← CORS fix deployed during this day
2026-09-09  smart       115     37
2026-09-09  suggest      61     38
2026-09-10  smart        13     12
2026-09-10  suggest       3      3
```

`visitor_id` tracks it exactly. `user_id` is still 0, which is correct — every one of these
was an anonymous search.

### (b) Which transport delivered it?

**The header. The params could not have — they were never reaching the handler.**

This is worth spelling out because it is a second, independent bug of the same family as
the CORS one, and it explains your six months of silence without needing the CORS gap at
all:

`validate(schema, 'query')` runs Joi with `stripUnknown: true` and then **replaces
`req.query` with the validated value**. `sid` and `vid` were not in
`smartSearchSchema` / `suggestSchema` / `autocompleteSchema`, so they were deleted from the
request before the handler ran. `readVisitorIdentity()` then looked up `query.sid` on an
object it had already been removed from.

Nothing failed loudly, because an unknown query param is *dropped, not rejected*: the search
returned 200, the analytics row was written, and only the column stayed null. Your instinct
to keep both transports rather than trade "a measured unknown for a hope" was the right
call — you just had two broken transports rather than one.

**`?sid=` / `?vid=` now work.** They are accepted on `/search/smart`, `/search/suggest` and
`/search/autocomplete`, and pinned by `__tests__/search-analytics-identity-transport.test.js`
(which also asserts the header still wins when both are present). Charset validation stays
where it was — in `cleanId` — so a malformed id is still rejected whole rather than
sanitised into a different id that would group with nothing.

**But please drop the param on search and keep the header — see §4.** A query param puts the
id in the URL, and the URL is the edge cache key.

### (c) What writes `search_analytics`?

`logSearchAnalytics()` in `src/routes/search.js:300`, an admin-client insert, fire-and-forget.
It has exactly three callers, and `/api/search/smart` is one of them:

| endpoint | `endpoint` column | logs identity |
|---|---|---|
| `GET /api/search/smart` | `smart` | yes |
| `GET /api/search/suggest` | `suggest` | yes |
| `GET /api/search/autocomplete` | `autocomplete` | yes |
| `POST /api/search/click` | — writes `search_clicks`, not this table | yes (body transport) |

`/search/by-printer` and `/search/by-part` write nothing here — that is deliberate, not a
gap. So you were looking at the right endpoint the whole time; it was reading a `req.query`
that had already been emptied.

---

## 3 — Noted, and made mechanical

Agreed on the stakes, and your framing is now quoted verbatim in the test that guards it:
*"a browser does not degrade — it fails the preflight and never sends the request at all."*

`__tests__/cors-analytics-identity-headers.test.js` already asserted the two headers. It now
also asserts:

- every `x-…` header `readVisitorIdentity()` reads is in `allowedHeaders` (drift guard —
  teach the reader a new header and CI fails until the CORS list learns it);
- **every HTTP verb any route file registers a handler for is in `methods`.** That is the
  same coupling one axis over, and it is what would have caught BF-021 the day the first
  `router.patch(` was written.

The `methods` half is a real guard, not decoration: run it against the pre-fix array
(`GET,POST,PUT,DELETE,OPTIONS`) and it fails on PATCH.

It is also in `CLAUDE.md` now, so it survives a person as well as a CI run.

---

## 4 — `/api/search/smart`: worse than you measured, and the cause is not the query

Thank you for the baseline. It turns out to be the common case, not a tail.

**Server-side timings from real traffic** (`search_analytics.latency_ms`, 14 days,
n = 2,008 — this is our own clock, so it excludes your network):

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| all `smart` | **2,291 ms** | 3,878 ms | — | — |
| with results (n=1,840) | 2,173 ms | 3,736 ms | 5,388 ms | 7,138 ms |
| zero results (n=168) | 3,341 ms | 4,888 ms | 6,058 ms | 6,944 ms |

So your 2.77–3.25s is representative. Two corrections to how it should be read:

**Your benchmark query is a zero-result query.** `tn244x` returns **0 rows** from the
primary RPC — we stock TN2445 and TN2449, not TN244 — so it takes the full rescue ladder.
That is worth knowing when you re-measure, but it is not the explanation: the has-results
median is still 2.2s.

**It is not the database.** The primary ranked-search RPC is ~135 ms measured directly
against Postgres (`EXPLAIN ANALYZE`, 7.8k shared buffer hits, no I/O). The remaining ~2
seconds is in the Node handler: a long *serial* chain of fallback lookups (ilike supplement,
printer probe, compat expansion, fuzzy-typo RPC, a semantic-embedding call, did-you-mean,
recovery rails), each one a separate round trip, and the Supabase project is in `ap-south-1`.

### The finding you can act on today, and it is a config change, not code

The backend already asks the edge to cache search for five minutes. Cloudflare is ignoring
it — on `/api/search/*` and nothing else:

```
/api/products/popular?category=ink   cf-cache-status: REVALIDATED
/api/shop?brand=brother              cf-cache-status: MISS      ← cacheable, just cold
/api/brands                          cf-cache-status: MISS
/api/search/suggest?q=lc73           cf-cache-status: DYNAMIC   ← not cached at all
/api/search/smart?q=lc73             cf-cache-status: DYNAMIC
```

All four carry the identical origin header
(`public, max-age=0, s-maxage=300, stale-while-revalidate=600`), and `/search/` is in the
same `catalogPaths` allow-list in `server.js` that puts it there. `DYNAMIC` means Cloudflare
never considered it cacheable, so a Cache Rule covers `/api/products/*` and `/api/shop` but
not `/api/search/*`. Extending it would put the repeat-query p50 at edge speed — the same
0.02s you are already seeing on `popular` — without touching the handler.

Safety is already handled at the origin, not by luck: any request carrying an
`Authorization` header or an `sb-*` cookie takes a `no-store` branch, so a personalised or
super-admin response is never edge-stored. We are raising the Cache Rule separately; flagged
here because it is the answer to your question.

### Which is why: keep `X-Session-Id` on search, drop `?sid=`

Cloudflare's cache key is the URL. Custom request headers are not in it. So:

- **header transport** → every visitor shares one cache entry per query. Edge cache works.
- **param transport** → `?sid=<unique per visitor>` gives every visitor their own cache key.
  The edge cache is worth nothing, and every search goes to the 2.3s origin.

The params are now genuinely wired (§2), so they are there for `sendBeacon` and any caller
that cannot set a header — but on `/search/smart` and `/search/suggest` the header is the
one to keep. That is our answer to your "tell us (b) and we will drop the redundant
transport in the same day".

### On the preflight — it is not amortised the way you might expect

`Access-Control-Max-Age: 86400` is set, but the CORS-preflight cache is keyed on the **full
URL**, so a different `?q=` is a different cache entry. A typeahead that changes `q` pays the
~0.3s preflight on each new query string, not once per day. It is still the right trade
against a 2.3s origin hit, and it disappears entirely for repeat queries — but "9% on top"
understates it on first-typed queries and overstates it on repeats.

### The two limiters — they are two real limiters, on different endpoints

You measured a pair that never appears together. Verified on production just now:

```
/api/search/smart      ratelimit-limit: 30      (and NO x-ratelimit-* at all)
/api/products/popular  ratelimit-limit: 60  +  x-ratelimit-limit: 100
```

- `/api/search/*` is governed by **one** limiter, `searchLimiter` at **30/min** — it sets
  standard headers only (`legacyHeaders: false`). The global `/api/` limiter explicitly
  skips `/search/`, which is why no `x-ratelimit-*` appears there at all.
- `/api/products/popular` is governed by **two, and both count**: `catalogLimiter`
  (`ratelimit-limit`, **60/min anonymous**, 300/min with a `Bearer` token) and the global
  `/api/` limiter (`x-ratelimit-limit`, **100/min**, legacy header names). Whichever is
  exhausted first returns the 429.

So: sizing checkout against 100 is right for `/api/orders` and the general `/api/` surface.
On catalogue reads the binding limit for an anonymous visitor is **60**, not 100. On search
it is **30**.

---

## 5 — `drums` confirmed; `label_tape` was an omission and is now accepted

**`drums` is the right backend name for your `consumable` family.** Stated, as asked. It is
the `Drums & Supplies` taxonomy entry and it resolves to:

```
waste_toner, maintenance_box, drum_unit, belt_unit, fuser_kit, fax_film, fax_film_refill
```

— your drums, maintenance boxes and waste toner, plus fax film, which you did not list but
belongs to the same shelf.

**`label_tape` was an omission.** It now 200s. We stock **244 active in-stock label tapes**,
so that landing was asking for the largest of the affected categories and getting a 400.
Both spellings work (`label_tape` and `label-tape`), and both resolve to the canonical
`label`. The root cause was a hand-kept Joi enum that had drifted from the taxonomy the
handler actually uses; the accepted set is now derived from the taxonomy, so the two cannot
disagree again. `photo_paper` / `photo-paper` were the same shape and are also fixed.

**One trap, and please keep your map.** `consumable` no longer 400s either — but it does
**not** mean `drums`. It is a retired alias that resolves to *no filter*, i.e. popular
products across every category, matching what `?category=consumable` already means on
`/api/shop`. Passing it through would give you ink and toner on a drums shelf, silently.
**Keep translating `consumable → drums` on your side.** A genuinely unknown value
(`bogus`) still 400s.

Full resolution table for the values you tested:

| you send | accepted | resolves to | product types |
|---|---|---|---|
| `ink` | ✓ | `ink` | ink_cartridge, ink_bottle |
| `toner` | ✓ | `toner` | toner_cartridge |
| `ribbons` / `ribbon` | ✓ | `ribbon` | the 4 ribbon types |
| `drums` | ✓ | `drums` | the 7 above |
| `paper` / `photo_paper` | ✓ | `paper` | photo_paper |
| `label_tape` / `label-tape` / `label` | ✓ | `label` | label_tape |
| `consumable` / `cartridge` | ✓ | *(no filter)* | **all — not drums** |
| `bogus` | ✗ 400 | — | — |

---

## 6 — BF-021: `PATCH` was hiding three routes, not one

Confirmed on production a few minutes ago:

```
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
```

`'PATCH'` is in the CORS `methods` array in the working tree but **has not been deployed
yet** — see the bottom of this document.

Worth knowing: the quick-order outcome modal was not the only casualty. Three live admin
routes register `PATCH`, and all three were unreachable from any browser:

```
PATCH /admin/invoices/:id/status
PATCH /admin/business/accounts/:id
PATCH /admin/quick-orders/:id/outcome
```

Your point about `quick_orders` being empty in production is correct and useful — but the
invoice-status and business-account ones were not empty, so the fix earns itself twice over.

The drift guard in §3 is the durable part: any future verb is now caught by CI rather than
by someone measuring the live site.

---

## What still needs a human

Two items. Neither is a decision about *what* to do — both are actions that need an explicit
yes.

1. **Migration `171_order_delivery_type.sql` is written but NOT applied.** It adds the
   column (nullable, no default, no backfill), grants `SELECT` on it to `anon` +
   `authenticated` — `orders` is column-granted, so a new column is invisible and breaks
   `select('*')` under a client key until granted — and replaces `create_order_atomic()`
   with a 25th parameter. That last part is a `DROP` + `CREATE`, which resets a
   `SECURITY DEFINER` ACL to `PUBLIC`, so the migration re-asserts the
   `REVOKE … / GRANT EXECUTE … TO service_role` block. **Until it runs, `POST /api/orders`
   keeps working exactly as it does today** (the new parameter is defaulted, and the deployed
   build does not send it), so there is no ordering hazard either way.

2. **Nothing in this response is deployed yet.** The `PATCH` fix in particular is a
   one-line change that has been sitting in an uncommitted tree; it needs the deploy, not
   more work.

Also queued, from the parallel workstream and unrelated to your asks: migration `172`
(analytics RPC grants) is written and unapplied, and migration `132`
(`DROP products.compatible_devices_html`) must run **strictly after** the deploy that
removes its dual-write, or every admin product save 400s.

---

## Reproducing

```bash
npm test -- order-delivery-type search-analytics-identity-transport cors-analytics-identity-headers
```

54 assertions across the three suites. Full suite: 401 suites / 6,142 tests, green.

The production numbers in §2 and §4 come from `search_analytics` and from
`EXPLAIN ANALYZE ranked_product_search(...)`; the cache-status and rate-limit headers in §4
and §6 from single `curl` calls against `api.inkcartridges.co.nz` (no load testing).

---

## One correction, for the record

Our previous hand-off said the `?sid=` transport was live and that the CORS gap was the only
thing stopping it. That was half right. The header gap was real and is fixed, but the params
were independently broken by `stripUnknown` on three route schemas — so if you had dropped
the header and kept the params, as the safer-looking of the two options, you would have gone
back to zero session ids with nothing to point at. Your decision to carry both until you had
an answer is the reason that did not happen.
