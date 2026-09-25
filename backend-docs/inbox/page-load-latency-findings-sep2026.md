# Page load latency — measured 2026-09-21

Every number here is one live sample (or a stated repeat) taken on 2026-09-21
against production, serially. Nothing was crawled: a bulk walk of this API 502s
the instance, so pages were loaded one at a time in a real browser and the API
routes were sampled individually with pauses.

## Summary

The HTML is not the problem. Storefront documents arrive in **0.20–0.43s** from
Vercel. Neither is the database: every query behind the slow endpoints measures
in **single-digit milliseconds** (`get_brand_category_counts` 7ms,
`get_top_products` over 180 days 11ms).

The time goes to **round trips** — how many requests a page makes, and how many
of them are forced to reach the Render origin instead of being answered by the
Cloudflare edge or skipped entirely.

Two backend causes are fixed and deployed. The three largest remaining items are
one front-end line, one Cloudflare rule, and one front-end call that goes
straight to Supabase in Mumbai.

## Fixed on the backend (deployed 2026-09-21)

### `/api/products/popular` was never cached — 2.0–2.7s on every request

`MemoryCache` TTLs are milliseconds. The route set its entry with a bare `600`,
so it expired 0.6 seconds later and no request ever read it. Every call rebuilt
the full response: a 180-day sales RPC, up to two catalogue queries,
`filterBrokenPacks`, then series-code / yield-tier / enrich work per row.

Category landing pages fetch this on load, and it was the slowest single call on
`/toner-cartridges` at **5.1s** in the browser.

Now `10 * 60 * 1000`. Re-measured after deploy: **0.29–0.60s**. Pinned by
`__tests__/cache-ttl-milliseconds.test.js`, which fails on any bare sub-second
TTL literal passed to a cache.

### `/api/products/counts` now takes a brand list

`/shop` asks for each brand's counts in its own request — **ten requests, about
600ms each in the browser** (1.2–1.6s on a cold load), for ten payloads of
roughly 40 bytes. The queries behind them total 70ms.

`GET /api/products/counts?brands=hp,epson,brother,…` returns all of them in one
response, keyed by slug:

```json
{ "ok": true,
  "data": { "hp": {"ink":385,"toner":433,"drums":32,"paper":7},
            "epson": {"ink":317,"paper":23,"ribbon":32} } }
```

- `brand=` (single) is unchanged — every existing caller keeps working.
- `brand` and `brands` are mutually exclusive; sending neither or both is a 400.
- Slugs are de-duplicated and capped at 30 per request.
- An unknown slug is listed in `meta.unknown_brands` and omitted from `data`,
  rather than 404-ing the whole batch.
- Both forms share one per-brand cache entry, so mixing them costs nothing.

Measured warm, all ten brands in one request: **0.28–0.32s**, against ~600ms
each for the ten it replaces.

**This needs you to adopt it to show up on `/shop`.**

## The biggest remaining item is one line of front-end code

`js/api.js` sets `'Content-Type': 'application/json'` on **every** request,
including GETs that have no body:

```js
const headers = {
    'Content-Type': 'application/json',
    ...options.headers
};
```

`application/json` is not a CORS-safelisted `Content-Type` value — only
`text/plain`, `multipart/form-data` and `application/x-www-form-urlencoded` are.
So this single header makes **every catalogue GET a non-simple request**, and the
browser sends an `OPTIONS` preflight to the Render origin before it.

This is the same cost the file's own comment carefully avoids for
`X-Session-Id` / `X-Visitor-Id` ("Stamping them here unconditionally would add an
OPTIONS round-trip to the Render origin for every distinct catalog and typeahead
URL on the site — a site-wide latency regression bought with analytics"). That
reasoning is exactly right; `Content-Type` is doing it already, for nothing, on
requests that carry no body.

Measured in a fresh browser context — empty preflight cache, unique URL per
sample, same endpoint:

| request | time |
|---|---|
| `Content-Type: application/json` | 480ms, 784ms |
| no `Content-Type` | 259ms, 270ms |

The fix is to set it only when there is a body:

```js
const headers = { ...options.headers };
if (options.body !== undefined) headers['Content-Type'] = 'application/json';
```

The preflight cache is keyed by full URL, so this costs a round trip per
*distinct* URL. A first-time visitor pays it on nearly every catalogue call —
which is most paid traffic.

**Note this interacts with the edge-cache item below.** A preflight goes to the
origin whether or not the GET itself is edge-cached, so removing it helps even on
paths Cloudflare already serves.

## Cloudflare Cache Rule — four path families are still `DYNAMIC`

`cf-cache-status: DYNAMIC` means the path was never *eligible*, not that it was
cold. The origin already marks all four cacheable; they are simply absent from
the Cache Rule expression:

| path | origin `Cache-Control` | edge | origin time |
|---|---|---|---|
| `/api/images/optimize?url=…` | `public, max-age=31536000, immutable` | DYNAMIC | 0.6–0.8s |
| `/api/prerender/category/ink` | `public, s-maxage=300` | DYNAMIC | 1.15s, 121KB |
| `/api/schema/collection?category=ink` | `public, s-maxage=300` | DYNAMIC | 1.01s |
| `/api/search/smart?q=…` | `public, s-maxage=300` | DYNAMIC | 0.3s warm |

`/api/images/optimize` is the biggest by request count — a category page fetches
five or more thumbnails and each is a separate origin request that reads Supabase
Storage and runs Sharp, behind a header that says it is immutable for a year.

`/api/search/smart` is the one that has already produced a visible bug: your
250ms debounce is sized against the rate limit on the stated assumption that
repeats are absorbed at the edge. They are not, so a shopper typing one query
spends one rate-limit slot per keystroke — that is the "You're searching too
quickly, slow down a sec." report. (The backend side of that is fixed
separately: `/search/smart` now sits on the 120/min bucket for dropdown-shaped
requests instead of 30/min.)

Owner action, dashboard only. Expression and verification steps:
`docs/infra/cloudflare-catalog-cache-rule.md` §"Fourth gap".

## Two smaller front-end items

### `site_settings` is read straight from Supabase on every page load

```
GET https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/site_settings?select=value&key=eq.site_locked
```

Measured **0.47s, 0.50s, 1.59s** direct, and it was the slowest call on
`/toner-cartridges` at 3.27s during one page load. The Supabase project is in
`ap-south-1` (Mumbai); the browser is in NZ and there is no CDN in between.

For comparison, `/api/site/trust` — same continent problem, but through
Cloudflare — answers in **0.12s**.

Ask and we will expose this on an edge-cached `/api/site/*` route. It is one
boolean and it gates the page, so it should not be a cross-region round trip.

### The analytics beacon posts to the Render host directly

```
https://ink-backend-zaeq.onrender.com/api/analytics/traffic-event
```

Measured 0.88–1.90s. It is a `sendBeacon`, so it does not block rendering, but it
bypasses Cloudflare entirely and pins the origin hostname into the storefront.
Point it at `https://api.inkcartridges.co.nz` like every other call.

## Where the time actually sits now

Page-level, after the backend fixes, one pass each:

| page | FCP | load | API calls |
|---|---|---|---|
| `/` | 1.12s | 3.47s | 7 |
| `/shop` | 1.05s | 2.45s | 17 (10 of them `counts`) |
| `/ink-cartridges` | 0.98s | 2.35s | 25 |
| `/toner-cartridges` | 0.94s | 2.99s | 26 |
| `/ribbons` | 1.06s | 3.65s | 14 |

Each page load was a fresh browser context, so these include the preflight cost
on every distinct URL — i.e. they are first-time-visitor numbers, not returning
ones.

---

# Second pass: the money pages (measured 2026-09-21, later same day)

The first pass covered `/`, `/shop`, two category pages and `/ribbons`. It missed
the PDP, search results and checkout — and those are where the real cost is.

## Every static asset is served `max-age=0, must-revalidate`

This is the single biggest item in this document, larger than anything on the
backend.

```
GET /css/pages.css?v=9236593b   →  cache-control: public, max-age=0, must-revalidate
GET /js/api.js?v=951becfc       →  cache-control: public, max-age=0, must-revalidate
GET /assets/brands/hp.png       →  cache-control: public, max-age=0, must-revalidate
```

That is Vercel's default for static files when nothing in `vercel.json` says
otherwise. It means the browser must revalidate **every** stylesheet, script and
image on **every** navigation, even though the URLs already carry a `?v=<hash>`
cache-buster — which is exactly the situation `immutable` exists for.

Measured on a PDP, same browser context, two consecutive loads:

| | load | same-origin responses | summed |
|---|---|---|---|
| first visit | **10,244ms** | 33 × `200` | 16,039ms |
| second visit | 1,183ms | 1 × `200`, **32 × `304`** | 5,477ms |

The second load is fast in wall-clock terms only because the 304s are cheap
individually. It is still 32 round trips that should not happen at all, on every
single page the shopper moves to.

The fix is a `headers` block in `vercel.json`:

```json
{ "headers": [
  { "source": "/(css|js|assets)/(.*)",
    "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
]}
```

Safe precisely because the URLs are hash-versioned: a changed file is a changed
URL, so `immutable` can never serve a stale one. Leave the HTML documents alone —
they must keep revalidating.

## `pages.css` is 418KB uncompressed and render-blocking on every page

83KB over the wire, 418KB parsed, and it is in the critical path of `/checkout`
as well as the PDP. On the first PDP load it was the longest single resource. It
is worth splitting per page, but the caching fix above is the cheap half and
should land first.

## The PDP makes 23 API calls, two of them 200 rows

```
/api/products?brand=hp&category=ink&source=compatible&limit=200
/api/shop?brand=hp&category=ink&limit=200&code=02
```

Both on a page showing one product. They are ~0.3s each at the origin so they are
not the emergency, but 200-row pulls to render a related-items rail and a chip
strip are worth a look — particularly whether both are needed, since they overlap.

## The search results page runs the same query three times

```
/api/search/smart?page=1&limit=100&include=compat,description&q=lc73   3,687ms
/api/search/suggest?q=lc73&limit=20                                    1,183ms
/api/products?page=1&limit=100&search=lc73                             1,031ms
```

Three different endpoints, one user intent, on one page load. `/search/smart`
already returns what the other two are asking for.

Note this page asks for `limit=100`, which is the deep shape — it takes the
30/min search bucket, not the 120/min typeahead one. That is deliberate and
unchanged from before, but worth knowing if a results page ever starts paging
aggressively.

## What this changes about the first pass

The first pass said "the HTML is not the problem", and that is still true —
documents arrive in 0.20–0.43s. But the CSS and JS behind them are, and on a
first visit they dominate everything measured on the backend by an order of
magnitude.
