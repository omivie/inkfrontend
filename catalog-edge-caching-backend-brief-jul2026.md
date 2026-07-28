# Catalog edge caching — FE verification results + backend asks (Jul 2026)

**Re:** `catalog-edge-caching-fe-notes-jul2026.md`
**From:** frontend · **Date:** 2026-07-28 · **Tracking:** ERR-124 (FE), BF-011…BF-018 (backend)

First — thank you, this works and it is a big win. Verified independently:
`cf-cache-status: HIT`, **44 ms cached vs 205 ms uncached** on
`/api/shop?brand=brother`. The FE side is now hardened to keep it that way (one
canonical param order for every catalog URL; public reads carry no identity).

Three claims in the note did **not** reproduce, and two of them matter for
correctness rather than performance. Everything below is a live measurement, with
the exact command to reproduce.

---

## ✅ Confirmed

| Claim | Result |
|---|---|
| Catalog GETs edge-cached, big speedup | **Yes.** MISS→HIT, 44 ms vs 205 ms |
| `/api/shop`, `/api/products`, `/api/products/series`, `/api/brands` cached | **Yes**, all MISS→HIT |
| Param order fragments the key | **Yes** — `?category=ink&brand=x` MISSes against a warm `?brand=x&category=ink` |
| Cache-busters / `utm_*` fragment the key | **Yes** |
| CORS correct on cached responses | **Yes**, correct ACAO per origin |

We found **zero** cache-busters and **zero** tracking params on our API URLs, and
have added `tests/catalog-edge-cache-jul2026.test.js` to keep it that way
permanently.

---

## ❌ BF-011 — A bearer token does NOT bypass the edge (highest priority)

The note says *"Requests carrying an auth token / `sb-*` cookie get
`Cache-Control: no-store` and are served from the origin."* Only the **cookie**
half is true, and in practice **no cookie ever rides along**, so in practice
**nothing bypasses**.

```bash
# Bearer token → still served from the shared public cache
curl -sI -H "Origin: https://www.inkcartridges.co.nz" \
     -H "Authorization: Bearer <any-token>" \
     "https://api.inkcartridges.co.nz/api/shop?brand=brother" | grep -i cf-cache-status
# cf-cache-status: HIT        ← never reached the origin

# sb-* cookie → correctly bypasses
curl -sI -H "Origin: https://www.inkcartridges.co.nz" \
     -H "Cookie: sb-lmdlgldjgcanknsjrcxh-auth-token=x" \
     "https://api.inkcartridges.co.nz/api/shop?brand=canon" | grep -i cf-cache-status
# cf-cache-status: MISS
```

**Why the cookie path never fires in production:** supabase-js is initialised
with default options, so the session lives in **localStorage**, not a cookie. And
`api.inkcartridges.co.nz` returns **no `Set-Cookie` at all** (verified), so there
is no cookie scoped to that host to send. Our auth has always travelled in the
`Authorization` header. Net effect before this week's FE change: **every
logged-in visitor's catalog reads were served from, and eligible to be written
into, the shared anonymous cache entry.**

Also, the authed response is not `no-store` — the origin returns
`public, max-age=60, s-maxage=300, stale-while-revalidate=300`, i.e. explicitly
shared-cacheable.

**Ask:** add `Authorization` (and `X-Guest-Session`, if it ever varies a
response) as a **bypass condition on the Cache Rule** — or send
`Vary: Authorization` plus `Cache-Control: private, no-store` from the origin
when a token is present. Today a token changes the *response* but not the *key*,
which is the classic cache-poisoning shape.

**FE mitigation already shipped:** all catalog reads are now explicitly anonymous
— no token, no cookies, no guest-session header. So we are not currently exposed.
This ask is about making the platform safe rather than relying on the client
being careful.

## ❓ BF-012 — Please confirm whether these endpoints vary by identity

This determines whether BF-011 is a **correctness bug** or just hardening. We
could not test it without a privileged token.

1. **`/api/products/:sku`** — our PDP used to `await` the session specifically so
   a token would be attached "for admin-gated products", implying the response
   differs for admins. If it does, an admin opening an unpublished PDP could mint
   a **public** cache entry for it. (Our code no longer sends the token, so the
   FE can no longer trigger this — but anything else that does, still can.)
2. **`/api/shop` / `/api/products`** — do these ever return B2B (business
   account) pricing when authenticated? If yes, the first authenticated MISS
   would populate the shared entry with discounted prices.

If the answer to either is "yes", BF-011 becomes urgent.

## 🔧 BF-013 — Restore admin preview with an uncached endpoint

Because catalog reads are now anonymous, admins can no longer preview
admin-gated/unpublished products in the storefront. That is the correct
trade — the alternative is leaking them into a public cache.

**Ask:** `GET /api/admin/products/:sku` (owner/admin-gated, `Cache-Control:
private, no-store`, outside the cached path prefixes). We will wire the PDP to
fall back to it when the anonymous read 404s **and** the viewer is an admin.

## 📉 BF-014 — `/api/site/*` is not actually edge-cached

The note lists `/api/site/*` as cached. It isn't — those responses carry
`public, max-age=3600` with **no `s-maxage`**, so the Cache Rule doesn't apply:

```bash
curl -sI -H "Origin: https://www.inkcartridges.co.nz" \
     "https://api.inkcartridges.co.nz/api/site/nav" | grep -iE 'cf-cache-status|cache-control'
# cache-control: public, max-age=3600
# cf-cache-status: DYNAMIC     ← on every repeat
```

Same for `/api/site/trust`. (`/api/site/settings` 404s — the real endpoint is
`/api/settings`, which returns `private, no-store` and is also uncached.)

**Ask:** add `s-maxage` to `/api/site/*` and extend the Cache Rule to match, or
correct the note. `/api/site/nav` is fetched on **every page load** site-wide, so
this is meaningful free latency.

## 📉 BF-018 — Two smaller gaps

**a) `/api/schema/*` sets `s-maxage=3600` but is never cached.** The origin
already asks for edge caching; the Cache Rule just doesn't match the path.

```bash
curl -sI ".../api/schema/collection?brand=brother" | grep -iE 'cf-cache-status|cache-control'
# cache-control: public, max-age=900, s-maxage=3600
# cf-cache-status: DYNAMIC   ← twice in a row
```

**b) 404s are edge-cached for 5 min + 10 min stale-while-revalidate.**

```bash
curl -sI ".../api/products/PG512" | grep -iE 'HTTP|cf-cache-status'
# HTTP/2 404 … cf-cache-status: MISS
# (repeat) HTTP/2 404 … cf-cache-status: HIT
```

A SKU that 404s once — because it was requested seconds before the product went
live — stays a hard 404 for up to 15 minutes, and the admin price/stock purge
won't clear it (there was no product to purge). **Ask:** don't cache 4xx, or cap
negative TTL at ~10 s.

---

## Two notes, no action needed

- **`Vary: Origin` splits the cache between apex and www.** Harmless today
  because apex 307-redirects to www, so real traffic is single-origin — but worth
  knowing before anyone removes that redirect.
- **The `Vary` header is sent twice** (`Vary: Origin, Accept-Encoding` and
  `Vary: Accept-Encoding`). Cosmetic, but it suggests two layers are both
  appending.

---

## What changed on the frontend (ERR-124)

1. **One canonical query serializer** (`API.catalogQuery` / `catalogEndpoint`,
   `CATALOG_PARAM_ORDER`). Four hand-rolled serializers with four different param
   orders are gone. Notably `_productsForCode()` emitted
   `brand,category,code,limit` while `getShopData()` emitted `…limit` *before*
   `code` — the same question minting two cache entries, on the codes-drilldown
   hot path. The canonical order deliberately preserves `getShopData`'s historical
   sequence, so your currently-warm entries were not invalidated by our deploy.
2. **Public reads carry no identity.** New `{ anonymous: true }` contract:
   no bearer token, `credentials: 'omit'`, no `X-Guest-Session`, no 401
   refresh-retry, and an anonymous response can never seed a guest-session id
   (a shared cached response carrying `X-Guest-Session` would otherwise hand
   every visitor the same guest cart).
3. **25 new tests** pin all of it, including source scans that fail the build if
   anyone ever appends `_t=`/`utm_*`/`Date.now()` to a catalog URL.
