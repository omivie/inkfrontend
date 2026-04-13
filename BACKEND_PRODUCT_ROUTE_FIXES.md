# Backend Changes Needed — Product Routing & Search Suggestions

**Date:** 2026-04-13
**Requesting repo:** `FEINK` (frontend, inkcartridges.co.nz)
**Backend repo:** `ink-backend` (deployed at `https://ink-backend-zaeq.onrender.com`)
**Priority:** High — users landing on product pages from search see "No product specified" or get bounced to a search listing instead of the product.

---

## TL;DR

Two small, independent changes are needed on the backend:

1. **Include `sku` in every object returned by `GET /api/search/suggest`.** (Primary fix — unblocks direct navigation from the search dropdown to product pages.)
2. **Add a new endpoint `GET /api/products/by-slug/:slug`** that returns the same shape as `GET /api/products/:sku`, but keyed by slug. (Secondary fix — lets the frontend resolve legacy `/product/:slug` URLs that exist in Google's index / old sitemaps / external referrers without a round-trip through the search endpoint.)

Change #1 alone fixes the primary user-facing bug. Change #2 makes legacy URL recovery clean and deterministic. Please implement both.

---

## Context — what the frontend expects

Canonical product URL on the site: **`/products/:slug/:sku`** (plural, both parts).

The product-detail-page controller (`inkcartridges/js/product-detail-page.js`) loads a product by calling `GET /api/products/:sku`. It extracts the SKU from one of:

- `?sku=` query param
- `/ribbon/:sku` pathname
- `/products/:slug/:sku` pathname (last segment = SKU)
- *(new)* `?slug=` / `/product/:slug` — slug-only fallback for legacy URLs

The search dropdown (`inkcartridges/js/search.js`) renders suggestion cards whose `<a href>` is built from the suggest payload. It needs **both** `slug` and `sku` to link to `/products/:slug/:sku`.

---

## Bug #1 — `/api/search/suggest` omits `sku`

### Current response

```
GET /api/search/suggest?q=Brother+LC3319XL&limit=1
```

```json
{
  "ok": true,
  "data": {
    "suggestions": [
      {
        "id": "35148a67-e58c-4abd-9f77-99197947784b",
        "name": "Brother Compatible LC3319XL Ink Cartridge Black",
        "slug": "brother-compatible-lc3319xl-ink-cartridge-black",
        "price": 24.79,
        "stock_quantity": 100,
        "is_genuine": false,
        "image_url": "https://.../color-swatch-v4.png",
        "category": { "name": "Ink", "slug": "ink" }
      }
    ]
  }
}
```

Note: **no `sku` field**.

### Impact

Since `/api/products/:sku` is keyed by SKU, and the PDP loads by SKU, the frontend cannot generate a correct product URL from a suggestion. Every search-dropdown click currently produces a degraded URL (`/product/:slug` without SKU) that forces the PDP to do extra work to resolve the product — and when that resolution fails, the user is bounced to `/html/shop?search=...` instead of landing on the actual product.

### Required change

Add `sku` (string, required, uppercase) to every object in `suggestions[]`.

### Required response shape

```json
{
  "ok": true,
  "data": {
    "suggestions": [
      {
        "id": "35148a67-e58c-4abd-9f77-99197947784b",
        "sku": "C-BRO-LC3319XL-INK-BK",        // ← NEW, required
        "name": "Brother Compatible LC3319XL Ink Cartridge Black",
        "slug": "brother-compatible-lc3319xl-ink-cartridge-black",
        "price": 24.79,
        "stock_quantity": 100,
        "is_genuine": false,
        "image_url": "https://.../color-swatch-v4.png",
        "category": { "name": "Ink", "slug": "ink" }
      }
    ],
    "matched_printer": null,
    "did_you_mean": null
  }
}
```

- Field name: `sku`
- Type: string
- Presence: **always present** on every suggestion object (never `null`, never missing). If a product has no SKU in the DB, exclude it from suggestions.
- Must match the `sku` returned by `GET /api/products/:sku` for the same product.

### Verification

After deploy, this must hold:

```bash
curl -s "https://ink-backend-zaeq.onrender.com/api/search/suggest?q=Brother+LC3319XL&limit=1" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['data']['suggestions'][0]; assert s.get('sku'), 'missing sku'; print('OK', s['sku'])"
```

Also test a ribbon, a toner, and a printer-matched query (`q=Brother+MFC-L2750DW`) — all suggestion entries must include `sku`.

---

## Bug #2 — no way to look up a product by slug

### Current state

- `GET /api/products/:sku` works (SKU only).
- `GET /api/products?slug=...` **ignores the filter** and returns an arbitrary list.
- `GET /api/products?search=<terms>` returns `[]` for most real product names (text search is not wired up on this endpoint).
- `GET /api/products/:id` (UUID) returns `NOT_FOUND`.

So from a bare slug, there is no single call that reliably returns the product.

### Why we need this

Google and external sites have indexed legacy URLs like `/product/<slug>` (singular, no SKU) — e.g. the one the user clicked: `/product/epson-sx540687b-mete-paper-50-pages/`. The frontend now rewrites these to `/html/product?slug=<slug>` and the PDP attempts to resolve the slug → SKU, but has no direct endpoint to call. Bug #1's fix lets us fall back to suggest, but suggest is fuzzy — it can return a *similar* product rather than the exact slug, or nothing at all.

### Required change — new endpoint

```
GET /api/products/by-slug/:slug
```

**Path parameter**
- `:slug` — URL-decoded slug, case-sensitive match on the `products.slug` column. Never contains `/`.

**Success (200)** — same shape as `GET /api/products/:sku`:

```json
{
  "ok": true,
  "data": {
    "id": "...",
    "sku": "C-BRO-LC3319XL-INK-BK",
    "slug": "brother-compatible-lc3319xl-ink-cartridge-black",
    "name": "...",
    /* ...all the usual product fields... */
  }
}
```

**Not found (404)**
```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Product not found" } }
```

**Behaviour**
- Exact slug match only (no fuzzy match, no trailing-slash tolerance — the caller strips trailing slashes).
- Must respect the same admin-gating rules as `/api/products/:sku` (i.e. don't return admin-only products to anonymous users).
- Should be cache-friendly (same `Cache-Control` as `/api/products/:sku`).

### Verification

```bash
# Should 200 with sku populated
curl -s "https://ink-backend-zaeq.onrender.com/api/products/by-slug/brother-compatible-lc3319xl-ink-cartridge-black" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok'] and d['data']['sku'], d; print('OK', d['data']['sku'])"

# Should 404 cleanly
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://ink-backend-zaeq.onrender.com/api/products/by-slug/this-slug-does-not-exist"
# Expect: 404
```

---

## Nice-to-haves (optional, smaller)

These are not blocking the user-visible bug but would round out the routing story:

### NTH-1 — bot prerender endpoint for `/product/:slug`

The Vercel edge middleware (`inkcartridges/middleware.js`) prerenders pages for SEO bots. It currently handles `/products/:slug/:sku` via `GET /api/prerender/product/:sku`. Once `/api/products/by-slug/:slug` exists, please add:

```
GET /api/prerender/product-by-slug/:slug
```

Same output shape as `/api/prerender/product/:sku` (server-rendered HTML with JSON-LD, meta tags, canonical link pointing to `/products/:slug/:sku`). The frontend middleware will route bot traffic on `/product/:slug` to this endpoint.

### NTH-2 — include `sku` in related-products payload

Verify that `GET /api/products/:sku/related` already includes `sku` on each related item. If not, add it — same rationale as Bug #1 (the related-products grid renders via the same `Products.renderCard` as search).

---

## Frontend changes already shipped

For context, the frontend has already been updated to:

- Stop generating `/products/<slug>/` URLs with empty SKU (was the direct cause of the "No product specified" error).
- Accept `/product/:slug` and `?slug=` as PDP entry points.
- Call `/api/search/suggest` as a slug-resolution fallback (degraded; will be replaced by `/api/products/by-slug/:slug` once available).
- Rewrite `/product/:slug` → `/html/product?slug=:slug` in `vercel.json` and `serve.json`.
- Canonicalise URLs to `/products/:slug/:sku` via `history.replaceState` after resolution.

Once Bug #1 is fixed, the user-visible regression is fully resolved. Bug #2 makes the legacy URL handler robust and removes the fuzzy-search workaround.

---

## Summary checklist for the backend agent

- [ ] Add `sku` (string, required) to every `suggestions[]` item in `GET /api/search/suggest`.
- [ ] Verify `sku` is present for ink, toner, ribbon, and printer-matched queries.
- [ ] Implement `GET /api/products/by-slug/:slug` returning the same shape as `GET /api/products/:sku`, 404 on miss, respecting admin gating.
- [ ] (Optional) Implement `GET /api/prerender/product-by-slug/:slug` for SEO bots.
- [ ] (Optional) Confirm `sku` is present in `GET /api/products/:sku/related` items.
- [ ] Deploy to Render and reply with confirmation + the verification `curl` outputs above.
