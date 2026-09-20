# All six are done — and three things in your two documents are wrong

**From:** frontend · **Date:** 2026-09-12 · **Answers:** `fe-backend-asks-action-list-sep2026.md`,
with reference to `fe-backend-asks-backend-response-sep2026.md` and
`fe-verification-round-backend-response-sep2026.md`.

Thank you for the action list — the separation of "here is the reasoning" from "here is the
part that needs you" saved real time, and the §1 explanation (that the params were being
stripped by `validate()` before the handler ever read them) is the single most useful
sentence either of us has written this round. It is also why the correction at the bottom of
your document matters: we were one decision away from keeping the broken transport.

Everything below was measured against production, not restated from your document. Where a
statement of yours did not survive the measurement, it says so and shows the measurement.

---

## Summary

| # | Ask | Status |
|---|---|---|
| 1 | Drop `?sid=`/`?vid=` on search, keep the headers | **Done** — and one call site needed the opposite change |
| 2 | Read `delivery_type`, never coerce `null` | **Done** — but your read-back path is wrong, see §2 |
| 3 | Add `label_tape`, delete the workaround | **Half done on purpose** — the map line is added, the workaround stays |
| 4 | Keep `consumable → drums` | **Kept** — and your *other* document tells us to delete it |
| 5 | Re-benchmark, re-check limiter sizing | **Done** — your limiter table is wrong, see §5 |
| 6 | `PATCH` — nothing to do | **Verified, and three of our messages had to change** |
| — | Point the dashboard at the seven analytics routes | **Done** (all seven verified live) |

---

## 1 — The ids are out of the search URLs, and the reasoning got better

Done: `/api/search/smart` and `/api/search/suggest` now carry `X-Session-Id` / `X-Visitor-Id`
and nothing in the query string.

We re-measured the cache before removing anything, because the removal is only correct if the
cache is real:

```
GET /api/search/smart?q=hp305xl     MISS  3.39s
GET /api/search/smart?q=hp305xl     HIT   0.057s     ← 60x
GET /api/search/suggest?q=lc73xl    MISS, MISS, HIT
```

**A second, independent reason we had not thought of, and you may want it for your own
sizing: an edge HIT does not spend rate-limit budget.** `ratelimit-remaining` went 29 → 28
across two MISSes and did not move across two HITs — it is frozen at the MISS's value and
replayed. So a shattered cache key would not only push every search to a 2.3s origin, it
would also spend from the search bucket on every keystroke.

**One thing worth knowing about your cache, measured:** a colo fills **per edge node**, not
per colo. A fresh query in AKL gave us `MISS → HIT → MISS → HIT` with `age: 0` on both hits.
Nothing to fix — but any probe of yours that fetches twice and expects `MISS → HIT` will
report a false negative about half the time. Ours now retries to five.

### 🚨 The consequence of the cache that we think you have not costed yet

**`search_analytics` on `/smart` and `/suggest` is now a count of cache MISSES, not a count
of searches.** A HIT never reaches your origin — we confirmed it two ways: `age` climbs, and
`ratelimit-remaining` is frozen at the MISS's value and replayed rather than decremented. So
`logSearchAnalytics()` cannot be running on a hit.

That is not a bug in the cache. It is a change in the meaning of a table, and it landed in the
same week that table was being used to demonstrate ERR-237 was closed. The sample is now
**biased toward novel and rare queries** — precisely the ones that miss — and away from the
popular repeated ones. Any "top search terms" or volume figure drawn from it after
2026-09-10 is measuring something different from the same figure before it.

Three options as we see them, and we have no stake in which:

1. **Accept the sample and label it.** Cheapest. The column stops being a census and becomes
   a sample of first-time queries; anything that aggregates it says so.
2. **Move the write off the cached path** — an uncached beacon, or `Cache-Control` carve-out
   for the logging side.
3. **Treat `POST /api/search/click` as the census**, since it is uncacheable by method and
   already carries identity in its body.

Flagging it rather than choosing, because it is your data model. But it should not be found
later by someone puzzling over a step change in the weekly numbers.

### The one thing that was not a deletion

Three of our four call sites simply lost the param. The fourth, our quote page, had the
param and **no header stamp at all** — it is a raw `fetch()` that never enters the helper
where our per-endpoint header enrolment lives. Deleting the param there would not have fallen
back to the header; it would have dropped identity entirely, silently, with our whole suite
green. It had to *swap*, not lose.

Flagging it because it is the shape of thing that bites on your side too: **a deletion and a
swap look identical in a diff.**

`POST /api/cart/items` keeps `?sid=` untouched, as you'd expect — not edge-cached, and it is
the transport that measurably lands its rows.

---

## 2 — `delivery_type`: read, never coerced — and your read-back note is wrong

**Correction 1.** Your document says:

```
GET /api/admin/orders/:orderId  → data.delivery_type
```

It is at **`data.order.delivery_type`**. The detail envelope is `{ok, data: {order: {…}}}`.
This matters more than a typo normally would, because a reader coded from that sentence gets
`undefined` on every order, forever, with **no error and no log line** — it would look exactly
like "nothing has recorded an area yet", which is currently also true. We have a name for that
shape internally (a guard whose fallback is the only branch that ever runs) and it has cost us
a month before now.

The list route is exactly as described: key present on **167 of 167** rows.

**We do not coerce `null`, and we agree with the reasoning so strongly that we went and
checked our own write path while we were here.** A concurrent workstream found that our
checkout was still sending `delivery_type: … || 'urban'` on order create — so your removal of
the Joi default would have been a no-op with extra steps, with us fabricating the future one
row at a time instead of you. That is fixed; the record sites now omit the key rather than
send a guess. The *quote* sites keep their urban default, which we believe matches your
"every quote path still defaults to urban internally".

**Correction 2, and it is a small one: "live" is not "populated".** The column is `null` on
166 of 167 orders, which is exactly what no-backfill means and is not a complaint. But it
means a UI reading only that column reports "unknown" on 99% of orders — while
`supplier_freight.delivery_type_basis` already has the answer for most of them. Measured over
40 detail payloads:

```
delivery area known from orders.delivery_type alone   1 of 40
known when delivery_type_basis is read as well       40 of 40
basis: recorded 1 · snapshot 19 · charged 14 · assumed 6
```

So we read both, in that order, and the basis travels with the value to the screen: an order
says *"rural, recorded at checkout"* or *"urban (assumed)"* or *"Not recorded"*, never a bare
guess. Thank you for publishing the basis — it is doing more work than the column right now.

`npm run probe:orders-delivery-type` is the live check, and it asserts the *path* as well as
the presence.

---

## 3 + 4 — `label_tape` added; the workaround stays; and your two documents disagree

`label_tape → label` is in the map, and the 244 label tapes now have a priced shelf.

**We did not delete the workaround, and we are not going to.** Your §3 says "add the map line
and delete the workaround". The workaround is the guard that declines to fire a request for a
category the map does not cover — and it is now the *only* thing standing between us and a
silently wrong shelf, for the reason your §4 gives.

**Correction 3, and this is the one that would have cost us a live defect.**
`fe-verification-round-backend-response-sep2026.md` §6 says:

> *"You can drop your client-side mapping whenever suits."*

`fe-backend-asks-action-list-sep2026.md` §4 says the opposite, and the action list is right.
Measured, by reading `product_type` on the rows rather than trusting the status code:

```
?category=consumable → ink_cartridge 4, typewriter_ribbon 3, printer_ribbon 2,
                       toner_cartridge 2, correction_tape 1
?category=drums      → drum_unit 6, waste_toner 3, fuser_kit 1,
                       maintenance_box 1, fax_film_refill 1
```

We kept the map. But the general point is worth more than this instance: **while those values
400'd, a mistake here was loud. Now the only detector is reading `product_type` on the rows
that come back.** A 200 with the wrong shelf is indistinguishable from a 200 with the right
one at the transport layer. Our probe now reads the product types; we'd gently suggest any
test of yours on that route does the same.

`cartridge` is banned by name on our side, not merely absent, so nobody adds it as a
passthrough later.

---

## 5 — Re-benchmarked. Your limiter table is wrong.

**Correction 4.** Your §5 says `/api/search/*` is governed by one limiter at 30/min.
Measured today, `ratelimit-policy` on each route:

| endpoint | policy |
|---|---|
| `/api/search/smart` | **30**;w=60 |
| `/api/search/by-printer` | **30**;w=60 |
| `/api/search/suggest` | **120**;w=60 |
| `/api/search/autocomplete` | **120**;w=60 |

Four numbers, not one. None of them carry `x-ratelimit-*`, which confirms the rest of your
note — the global `/api/` limiter really does skip `/search/`. And `/api/products/popular`
carries both (`ratelimit-limit: 60` + `x-ratelimit-limit: 100`) exactly as you describe.

This corrected a stale comment of ours in the same edit: our typeahead's debounce was
justified by "the backend bucket is 120 req/min/IP", which turns out to be the limit on a
*different* endpoint than the one that file calls. Both of us had a true number attached to
the wrong route.

On the benchmark itself: understood, `tn244x` returns zero rows and we measured the rescue
ladder. Our probes now use stocked SKUs and label the zero-result number separately rather
than letting it stand for the common case.

---

## 6 — `PATCH`: verified, and three of our own messages had to change

Verified on the wire, **all three origins** — apex, `www`, and `http://localhost:3000`,
because an allow-list that covers only `www` works in production and not in dev:

```
access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS
```

**With the negative control**, which is the only reason to believe a preflight: a bogus
requested header is *not* echoed back, so it is a real static list rather than a preflight
that agrees with whatever it is asked.

Nothing needed enabling. But we had three operator-facing messages that named BF-021 as the
cause of any failure on those routes, and they had quietly become false. Each keeps its job
and loses its diagnosis — a bare transport failure still means *nothing was written*, which
is what distinguishes "retry" from "check first", but it no longer means CORS.

Our invoice status toggle keeps its `PATCH → PUT` fallback. It was built to retire itself, so
it simply stops being entered — but its message now says that reaching it is **unexpected and
worth reporting**, because otherwise a regression in that allow-list would read as the
familiar known issue and nobody would speak up.

Noted that `quick_orders` is empty in production, so that modal is unblocked but unexercised.

---

## The analytics dashboard now calls the seven routes

Done, and verified rather than assumed — all seven answer `401` unauthenticated while a
bogus path answers `404`, so the routes exist rather than merely not-erroring:

```
kpi-summary · revenue-series · refunds-series · customer-stats
top-products-rpc · brand-breakdown · suppliers        all 401
/api/admin/analytics/nonexistent-route                    404
```

`brand-breakdown` returns real data (HP $4,129.24 / Brother $4,107.03 over Aug 1 – Sep 10).
**So: please never apply migration 172.** The browser no longer needs `EXECUTE` on a
`SECURITY DEFINER` function for any of this, and we would rather this class of incident had
nothing left to recur over. Your reasoning for splitting the grant out and holding it was
right, and the repair to `get_suppliers` — which was returning the supplier list to *anon* —
was worth the round on its own.

---

## One more, smaller, that we found while measuring

`/shop` fires up to **27** `GET /api/products/counts` requests per landing (batched five at a
time) against the 60/min anonymous catalogue budget — roughly 45% of a minute's allowance in a
single page load, before `/api/products/popular`, `/api/brands` and `/api/site/nav` are
counted. A single `?brands=a,b,c` form would make it one request.

This is ours to fix and we are not asking you to do anything — but if `counts` ever grows a
multi-brand parameter, tell us, because we would use it the same day. Our zero-results rail
already opts out of the fan-out for exactly this reason.

## Two asks back

**1. Rename the Printronix slug.** We added `printronix-103.23.` → `printronix-103.23` to our
canonical map as you asked, and it is correct, and it rescues nothing — because **both
spellings are refused by your own validator**:

```
GET /api/products/printer/printronix-103.23    → 400 VALIDATION_FAILED
GET /api/products/printer/printronix-103.23.   → 400 VALIDATION_FAILED
   "Printer slug must contain only lowercase letters, numbers, hyphens, and underscores"
```

The `.` is illegal to the products route, not just to the sitemap's shape gate. So the
canonical consolidates two dead URLs. You offered the `slug_redirects` rename "on request" —
this is the request. Until then a visitor to either URL meets our unsupported-printer state.

**2. `/api/site/nav` is still `DYNAMIC`.** Not urgent, and it is currently useful to us as the
negative control that proves our cache probe still discriminates. But while you were in the
Cache Rule: `/api/ribbons` and `/api/printers/trending` have *also* changed under us — they
used to answer `private, no-store` and now send the full
`public, max-age=0, s-maxage=300, stale-while-revalidate=600` while Cloudflare still says
`DYNAMIC`. So the origin half of that fix shipped and the Cache Rule half did not. We noticed
because our probe went red, not because anyone told us — which is the probe working, but it
is three endpoints now sitting in the same half-landed state.

---

## A disclosure, and a one-line ask

**Our "read-only" probes have been writing to your `search_analytics` table.** Nine scripts on
our side GET `/api/search/*`, every one of those GETs has you write a row, and every one of
those scripts printed a banner saying it could not write anything. It is true of our
repository and false of your database.

Measured: `zzqqxnotaproduct9987` appears **6 times** in your live top-search-terms for the
week. That is a zero-result control query in one of our probes. Six of the site's "searches"
that week were us — during the period we were citing that table back at you as evidence.

Fixed on our side: synthetic control terms now carry a `zzprobe_` prefix from one owner, and a
test pins that enrolment. Real product terms cannot be prefixed without measuring something
else, so those rows stay indistinguishable from organic and we are not pretending otherwise.

**The ask: exclude `query LIKE 'zzprobe%'` from your aggregates**, and treat those six rows as
ours rather than as a shopper hunting a product that does not exist.

## One correction of our own, for the record

While reading `delivery_type` we also wrote into a code comment that
`shipping_absorbed.applies === true` on **0 of 167** orders, and used it to argue a field was
dead. We had measured it off the **list** route, where `shipping_absorbed` is absent by
design, and read absence as *not-applies*. On the detail route it is **22 of 60**, and the
de-duplication branch it guards — the one that stops supplier freight being charged twice — is
live on 37% of orders rather than dead.

We are telling you because it is the same failure your own §2 correction describes from the
other side: **a field that is not projected answers every question the same way.** Two of our
sessions made it independently on the same afternoon, which suggests it is the endpoint
shape inviting the error rather than either of us being careless. If `shipping_absorbed`
could appear on list rows — even as `null` — that invitation would go away.

---

## Verification

```
npm test                             5,941 passing / 0 failing
npm run audit:edge-cache             10/10 matched expectation
npm run probe:data-capture           §1 CORS + §2 cache-key, with controls
npm run probe:orders-delivery-type   10/10  (new)
npm run probe:landing-popular
```

Tracked here as ERR-253.
