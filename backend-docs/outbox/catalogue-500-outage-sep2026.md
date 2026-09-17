# Two live issues, and the ten-minute catalogue outage they came from

**From:** frontend · **Date:** 2026-09-17 · **Tracking:** ERR-264 (FE), BF-065 (backend)

> **Start here:** §1 and §2 are both broken *right now* and each reproduces in one curl.
> §3 is the outage they are left over from, which self-recovered. §1 is the cheapest way to
> find its cause — the stack trace is available live rather than in this morning's log — and
> §2 is why the outage lasted roughly twice as long as the fault did.

---

## §1 🔴 `/api/products/by-slug/:slug` returns 500 for every slug

Re-measured **2026-09-17 14:20 NZST**, hours after everything else recovered:

```bash
B=https://api.inkcartridges.co.nz

curl -si "$B/api/products/by-slug/epson-genuine-273hyc-ink-cartridge-273hy-cyan-650-pages"
#   HTTP 500   x-request-id: 48ca897f-c9ea-4f4a-95af-40d73067ff46
#   {"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to fetch product"}}

curl -si "$B/api/products/by-slug/does-not-exist-at-all-xyz"
#   HTTP 500   x-request-id: 1040ec95-41e0-4084-b962-c55a5e14360a
```

**The second one is the useful one.** A slug that does not exist should be a
`404 NOT_FOUND`. It is a 500 — so the handler is throwing **before it reaches the lookup**,
which means this is not about any particular product's data.

Everything else in the family is healthy again as of the same minute:

| Route | Now |
|---|---|
| `/api/products?limit=1` | 200 |
| `/api/products/G273HYC` | 200 |
| `/api/shop?brand=epson&category=ink` | 200 |
| `/api/ribbons?limit=5` | 200 |
| `/api/search/smart?q=273h&limit=10` | 200 |
| **`/api/products/by-slug/<anything>`** | **500** |

**Shopper impact today: low, but it is being masked.** The PDP asks `by-slug` first and
falls back to `/api/products/:sku`, so `/product/<slug>` still renders — we verified that in
a browser. It pays one failed request plus a retry ladder on every product view, and that
fallback is the only thing between this and a dead product page. A fallback working is not
the same as the thing behind it working.

---

## §2 🔴 Cloudflare is caching your 5xx responses — this amplified the outage

Found while writing §1: three identical calls returned the **same `x-request-id`**. The
error is being served from the edge.

```
GET /api/products/by-slug/does-not-exist-at-all-xyz   (×3, api.inkcartridges.co.nz)
  HTTP 500  cf-cache-status: HIT  age: 78  x-request-id: 1040ec95-…   ← same id all three times
  cache-control: public, max-age=0, s-maxage=300, stale-while-revalidate=600
```

A brand-new URL MISSes, hits the origin, gets a 500, and that 500 is then stored and
replayed: `MISS → HIT → HIT`, one cached failure per distinct URL.

**It is the origin's own header, not a Cloudflare rule.** Asking Render directly, which
bypasses the edge entirely:

| Response from `ink-backend-zaeq.onrender.com` | `cache-control` |
|---|---|
| `200` `/api/products/G273HYC` | `public, max-age=0, s-maxage=300, stale-while-revalidate=600` |
| `404` `/api/products/NOSUCHSKU` | *identical* |
| `500` `/api/products/by-slug/<random>` | *identical* |

The caching middleware is setting the header before the handler's outcome is known, so
**error responses inherit the success policy**.

### Why this matters more than it looks

`s-maxage=300` + `stale-while-revalidate=600` means a cached 500 is served for **5 minutes
guaranteed and up to 15**. So this morning's ~10-minute origin fault became up to ~25
minutes of user-visible failure, and kept being served **after** the origin had recovered.
It will also delay your fix for §1 from appearing once you ship it.

**The ask:** don't emit a cacheable `cache-control` on 5xx. `no-store` on the error path is
the usual shape. The 404 is a separate judgement call — caching "this product does not
exist" for 5 minutes may well be deliberate, and we are not asking you to change it.

*(This is the same defect we just fixed one layer in, and it is worth saying plainly: our
`_swrCache` was memoising your `{ok:false}` envelopes for 60s, which made our Retry button
inert. A cache that cannot tell an answer from a failure makes the failure stick. We have
it at the client layer; you have it at the CDN layer.)*

---

## §3 The outage this is left over from

Between roughly **12:30 and 12:45 NZST on 2026-09-17**, every route in the `/api/products`
and `/api/shop` family answered:

```
HTTP 500
{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to fetch products"}}
```

It recovered on its own. Nothing was deployed on our side in that window. We found out from
a shopper report ("it seems like there are no products").

Measured against `api.inkcartridges.co.nz` (the host the browser calls), with
`Origin: https://inkcartridges.co.nz`:

| Route | During the window |
|---|---|
| `/api/products` — **with no parameters at all** | **500** |
| `/api/products?limit=1` | **500** |
| `/api/products?brand=epson&page=1&limit=100` | **500** |
| `/api/products?search=273h&limit=100&page=1` | **500** |
| `/api/products/G273HYC` | **500** (`"Failed to fetch product"`) |
| `/api/products/by-slug/…` | **500** (still is — §1) |
| `/api/products/G273HYC/for-use-in` | **500** |
| `/api/shop?brand=epson&category=ink` | **500** |
| `/api/ribbons?limit=5` | **500** (`"Failed to fetch ribbons"`) |
| `/api/search/smart`, `/api/search/suggest` | 200 throughout |
| `/api/brands`, `/api/products/counts?brand=epson` | 200 throughout |
| `/api/products/G273HYC/bought-together` | 404 (pre-existing, unrelated) |

Correlation id from the window: **`x-request-id: 6a522c76-39a7-47f3-b51a-8877e8be4363`**.

### Three things that narrow it down

1. **Not query-shaped.** `?limit=1` with no filters failed identically. Every parameter
   permutation we tried failed, all in about 0.9s — fast, so thrown rather than timed out.
2. **Routing and validation were fine.** `/api/products?sort=relevance` still returned a
   correct `400 VALIDATION_FAILED` naming the allowed values. The request reached the
   handler; the handler threw.
3. **`/api/search/*` reads the same catalogue data and stayed up.** Whatever failed is in
   the products/shop/ribbons read path specifically, not the database as a whole.

Both hosts behaved the same (`ink-backend-zaeq.onrender.com` too), so this was the origin
and not anything at the edge. CORS headers were present on the 500s.

---

## §4 What we would like to know

**1. What threw?** The message is your generic handler catch, so the cause is in your logs
under those request ids and invisible to us. One prior with the same shape, in case it
saves you time: **ERR-244** was a `SELECT` naming a column a migration had dropped, and
PostgREST `42703`s the *whole* statement — a column list is only as live as its deadest
member. If a migration landed on or near 2026-09-17, that is where we would look first.
The `by-slug` handler throwing on a nonexistent slug fits that shape.

**2. Does `/api/admin/catalog/*` share the products handler?** This matters more than it
looks. A granted admin's catalogue reads are re-routed to the mirror, which is token-bearing
and therefore **never edge-cached** — making an admin the only visitor who cannot ride out
an origin wobble on a cached body. During this outage a signed-out visitor on
`/search?q=273h` saw nineteen correct cards while the admin who reported it saw a total
failure. If the mirror shares the handler it shares the fault, with no cache in front of it.

**3. Is there alerting on this?** Ten minutes of a dead catalogue is a full outage of the
storefront's core function, and `/api/products?limit=1` returning 500 is about as cheap a
health check as exists. `/api/products/by-slug/<nonexistent>` returning 500 instead of 404
would have caught the leftover too.

---

## §5 What we changed on our side — no action needed from you

The outage is yours; how we *reported* it was ours (ERR-264).

`API.request()` has two failure shapes: it **throws** for a non-JSON body or a network
failure, and it **resolves** `{ok:false, status:5xx}` for a structured error like yours. Our
catalogue page-walk only understood the first, so a 500 was read as "that was the last
page", the empty result was cached for the session, and `/shop?brand=epson&category=ink`
rendered **"No products found for this category."** — no error, no retry, and still wrong
after you recovered.

Now fixed: a failed fetch shows a retryable error pane, is never cached at either layer, and
a failing admin mirror degrades to the public route rather than to a dead page.

**We mention it for one practical reason:** if you look for shopper impact during the window,
it will show up in our funnel as *no-results* events, not error events.

---

*Frontend tracking: `errors.md` ERR-264. Reproduction: `npm run probe:catalogue-outage`.*
