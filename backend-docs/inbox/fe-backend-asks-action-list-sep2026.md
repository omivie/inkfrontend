# What changed on the backend, and the six things that need you

Covering note for `fe-backend-asks-backend-response-sep2026.md`, which answers your
2026-09-09 round in full with the measurements behind each answer. **This page is only the
part that needs action from your side.**

All six asks are done, deployed and verified in production. Two items are still open and
neither is yours — they are listed at the bottom so you know what is coming.

---

## 1. Drop `?sid=` / `?vid=` on search — keep the headers

**Do:** remove the query params from `/api/search/smart` and `/api/search/suggest`. Keep
`X-Session-Id` / `X-Visitor-Id`.

You asked which transport delivered, and said you would drop the redundant one the same
day. The answer is the **header** — but the reasoning is not what either of us expected, so
it is worth thirty seconds:

The params were never reaching the handler. `validate()` runs Joi with `stripUnknown: true`
and then *replaces* `req.query` with the validated value, and `sid`/`vid` were not in the
route schemas — so they were deleted before the handler ran, and the reader looked them up
on an object they had already been removed from. That is a second, independent fault from
the CORS one. **Your query-param fallback would have returned nothing even if CORS had
always been correct**, which is why keeping both transports until you had an answer was the
right call rather than a cautious one.

They now work (fixed and pinned). But keep the header anyway, because **Cloudflare's cache
key is the URL and does not include custom request headers**. A per-visitor `?sid=` gives
every visitor their own cache entry; the header shares one. See §5.

---

## 2. `delivery_type` is live — and `null` is deliberate

**Do:** read it; your `profitability.js:337` guard stops being dead code.

```
GET /api/admin/orders           → data[].delivery_type      (data is the order array)
GET /api/admin/orders/:orderId  → data.delivery_type
```

Values: `"urban" | "rural" | null`.

**Please do not coerce `null` to `"urban"`.** That is the distinction you asked us to
preserve and we preserved it in both directions: no backfill on historical orders, *and* we
removed the Joi `.default('urban')` from the order-create schema, so an order whose client
sends nothing records `null` rather than a guess. Had we left the default in, we would have
stopped fabricating the past and started fabricating the future one row at a time.

Nothing about what a customer is **charged** changed — every quote path still defaults to
urban internally.

Worth knowing why this mattered more than fulfilment visibility: of 149 revenue orders, 17
carry a courier-cost snapshot and 64 were charged a fee, but **68 have neither** — no number
anywhere on the order to invert the rate table against, so they could only ever be assumed
urban at half cost. Those 68 are free-shipped orders, which is exactly what your rural
detection now produces.

---

## 3. `label_tape` now works

**Do:** add the map line and delete the workaround. `label_tape`, `label-tape`,
`photo_paper` and `photo-paper` all 200 now.

It was our omission, not a design decision — a hand-kept Joi enum had drifted from the
taxonomy the handler actually uses. The accepted set is now derived from the taxonomy so
the two cannot disagree again. It was also the largest affected category: **244 active
in-stock label tapes** were behind that 400.

---

## 4. Keep your `consumable → drums` translation

**Do:** nothing — but do not remove the map now that `consumable` stops 400ing.

`drums` **is** the right backend name for your `consumable` family. Confirmed, as asked:

```
waste_toner, maintenance_box, drum_unit, belt_unit, fuser_kit, fax_film, fax_film_refill
```

(your drums, maintenance boxes and waste toner, plus fax film.)

**The trap:** `consumable` no longer 400s either, but it resolves to *no filter* — popular
products across every category — matching what `?category=consumable` already means on
`/api/shop`. Passing it straight through would silently put ink and toner on a drums shelf.
A genuinely unknown value (`bogus`) still 400s.

| you send | resolves to |
|---|---|
| `ink` / `toner` / `ribbons` / `drums` / `paper` | themselves |
| `label_tape` / `label-tape` / `label` | `label` |
| `photo_paper` / `photo-paper` | `paper` |
| **`consumable` / `cartridge`** | **no filter — all categories, NOT drums** |
| `bogus` | 400 |

---

## 5. Re-benchmark search — and the two limiters were two endpoints

**Do:** re-run your timing with a SKU we actually stock, and re-check your rate-limit sizing.

**Your benchmark query returns zero rows.** `tn244x` finds nothing — we stock TN2445 and
TN2449 — so you measured the full zero-result rescue path. It is not the whole story: real
p50 is **2,291 ms** across 2,008 searches over 14 days, so ~3s is representative, but the
has-results median is 2.2s rather than 3.3s.

It is not the database — the primary search RPC is ~135 ms measured directly against
Postgres. The rest is a serial fallback chain in the handler.

**The two limiters** never appear on the same response; you measured two different
endpoints:

| endpoint | limiter(s) |
|---|---|
| `/api/search/*` | `ratelimit-limit: 30` — one limiter, 30/min, standard headers only |
| `/api/products/popular` | `ratelimit-limit: 60` **and** `x-ratelimit-limit: 100` — both count |

So sizing checkout against 100 is right for `/api/orders`. On catalogue reads the binding
limit for an anonymous visitor is **60**, not 100. On search it is **30**.

**On the preflight:** `Access-Control-Max-Age: 86400` is set, but the CORS-preflight cache
is keyed on the **full URL**, so a changing `?q=` re-preflights each time rather than once
per day. Still the right trade against a 2.3s origin hit, and it disappears on repeat
queries — but "9% on top" understates it on first-typed queries.

---

## 6. `PATCH` is live

**Do:** nothing — but the quick-order outcome modal is reachable now, verified on the wire:

```
access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS
```

Your BF-021 diagnosis was right and it was hiding more than you reported — **three** live
admin routes were unreachable from any browser, not one:

```
PATCH /admin/invoices/:id/status
PATCH /admin/business/accounts/:id
PATCH /admin/quick-orders/:id/outcome
```

The durable part is a CI guard that now scans every route file for `router.<verb>(` and
fails until the CORS allow-list carries it, so this cannot recur silently. Your framing is
quoted in it verbatim: *"a browser does not degrade — it fails the preflight and never
sends the request at all."*

(`quick_orders` being empty in production is still true, so that modal has nothing to act
on yet — but the invoice-status and business-account routes were not empty.)

---

## Done since this was written — search is now edge-cached

**`/api/search/*` is on the CDN as of 2026-09-10**, which is why §1 matters more than it did
when we drafted it.

The origin had been asking the edge to cache search for five minutes all along; the
`Cache catalog API` rule simply listed `/api/search/popular` where it should have said
`/api/search/`. A seven-character edit, no code:

```
/api/search/smart?q=lc73    3.49s  MISS   ->   0.13s  HIT
/api/search/suggest?q=…     1.11s  MISS   ->   0.13s  HIT
```

**This is why you should keep the ids in headers and not in the URL.** Cloudflare's cache key
is the URL and excludes custom request headers, so `?sid=<unique>` would give every visitor
their own cache entry and hand all of this straight back.

Two things to know about it:

- **It is a cache, not a repair.** A first-time query for an uncommon term still waits on the
  origin, and the origin is still ~2.3s. The p50 you measure will fall a lot; the worst case
  will not move.
- **An authenticated request is served the shared anonymous entry on a hit.** In search, admin
  status only controls whether `TEST-`/`ADMIN-` prefixed SKUs appear, so the only consequence
  is that an admin may not see test products for up to five minutes after a query is warmed
  anonymously. The reverse — an admin response reaching the public — cannot happen: we forced
  an authed request to be the first hit on a fresh URL and the edge answered `BYPASS`, storing
  nothing.

## One item from the *other* round that does need you

Tracked separately in `fe-verification-round-backend-response-sep2026.md` — flagged here
only so it does not get lost between two documents.

**ERR-232 is resolved without any grant, and the dashboard needs repointing.** Rather than
granting `EXECUTE` to `authenticated` on the analytics RPCs, the two genuinely defective
gates were repaired and the one missing REST route was added
(`GET /api/admin/analytics/brand-breakdown`). The dashboard should now call the seven admin
endpoints rather than the RPCs directly. Net effect for you: no Supabase-side permission
change to depend on, and one endpoint to wire.

Worth knowing what that repair actually closed, because only one of the two was the bug you
were chasing: `analytics_brand_breakdown` was too **strict** and returned `null` to our own
backend — served as `{ok:true, data:null}` with a **200**, so it read as "no data" rather
than "broken". `get_suppliers` was the opposite and returned real data to **anon**.

---

## One correction, for the record

Our earlier hand-off said `?sid=` was live and CORS was the only thing blocking it. That was
half right, and the half that was wrong is the one that would have cost you: if you had
dropped the header and kept the params — the safer-looking of the two options — you would
have gone straight back to zero session ids with nothing to point at. Carrying both until
you had an answer is the reason that did not happen.
