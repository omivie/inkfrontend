# Backend Fix — `/api/images/optimize` Blocking & Rate-Limiting

**Repo:** `ink-backend-zaeq` (Render deployment at `https://ink-backend-zaeq.onrender.com`)
**Endpoint:** `/api/images/optimize`
**Priority:** High — product grids on the live site are rendering color-block placeholders instead of product photos because this endpoint is blocking the browser from loading its own responses.

---

## Context

The frontend (`inkcartridges.co.nz`, and `localhost:3000` in dev) loads product images through this backend proxy to get webp conversion, resizing, and caching:

```
GET /api/images/optimize?url=<original-url>&w=400&format=webp
```

Every product card in search results, shop grids, and product pages hits this endpoint. When an image fails to load, the frontend swaps in a color-block placeholder (`inkcartridges/js/search.js:693-703` and `js/utils.js` product-image helpers). That fallback is currently firing on **nearly every card** because the proxy responses are being blocked by the browser.

---

## Observed problems

### 1. `Cross-Origin-Resource-Policy: same-origin` header blocks the browser

Reproduce:

```bash
curl -sI 'https://ink-backend-zaeq.onrender.com/api/images/optimize?url=https%3A%2F%2Flmdlgldjgcanknsjrcxh.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fpublic-assets%2Fimages%2Fproducts%2FG-HP-67-INK-BK%2Fproduct.png&w=400&format=webp'
```

Response headers (current):

```
cross-origin-resource-policy: same-origin
cross-origin-opener-policy: same-origin
content-security-policy: default-src 'none'; img-src 'self' data:; ...
```

Chrome/Safari/Firefox all honor CORP. With `same-origin`, an `<img>` loaded from `localhost:3000` or `inkcartridges.co.nz` into a page whose origin differs from `ink-backend-zaeq.onrender.com` is blocked with:

```
net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin
```

This is the root cause of the missing images. The image data is actually fetched successfully — the browser then refuses to hand it to the `<img>` element because CORP says "same-origin only."

The `Content-Security-Policy: img-src 'self' data:` on the response itself is irrelevant for `<img>` consumption (CSP on a non-HTML response does nothing), but if Helmet is emitting both headers, the CORP line is the real blocker.

### 2. `HTTP/2 429 Too Many Requests` under normal grid loads

When a search result grid renders, it fires 18–30 image requests in one burst. The endpoint returns `429` on many of them:

```
HTTP/2 429
cache-control: no-store, no-cache, must-revalidate
```

Image endpoints should not be gated by the same rate limiter as write/API endpoints. A 20-card grid is legitimate and expected traffic.

### 3. No caching headers on image responses

Current response sends `cache-control: no-store, no-cache, must-revalidate, proxy-revalidate`. Even when the request does succeed, the browser re-fetches the same image on every navigation. This multiplies problems #1 and #2.

---

## Required fixes

### Fix 1 — Set `Cross-Origin-Resource-Policy: cross-origin`

In the Express middleware stack for the `/api/images/*` route (or wherever Helmet is configured for images), override CORP:

```js
// Example — adjust to your Helmet setup
app.use('/api/images', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Optional but recommended for caches:
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Timing-Allow-Origin', '*');
  next();
});
```

If you're using Helmet globally, either:
- Configure `helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })` on the image router only, or
- Keep Helmet strict elsewhere and set the header after Helmet runs for this route.

**Verification:**

```bash
curl -sI 'https://ink-backend-zaeq.onrender.com/api/images/optimize?url=<any-url>&w=400'
# Must contain:  cross-origin-resource-policy: cross-origin
```

### Fix 2 — Exempt image routes from the aggressive rate limiter (or give them their own generous one)

The global rate limiter (likely `express-rate-limit`) is hitting `/api/images/optimize` and returning 429 under normal grid loads. Apply a separate, much more permissive bucket:

```js
const imageLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,                      // 10 req/sec per IP is fine for images
  standardHeaders: true,
  skipSuccessfulRequests: false,
  message: { error: 'Too many image requests' }
});

app.use('/api/images', imageLimiter);
```

Or exempt them entirely if you're confident the upstream cache absorbs the load:

```js
const globalLimiter = rateLimit({ /* existing */ });
app.use((req, res, next) => {
  if (req.path.startsWith('/api/images/')) return next();
  return globalLimiter(req, res, next);
});
```

**Verification:**

```bash
# Burst 30 requests in parallel; none should return 429
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://ink-backend-zaeq.onrender.com/api/images/optimize?url=https%3A%2F%2Flmdlgldjgcanknsjrcxh.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fpublic-assets%2Fimages%2Fproducts%2FG-HP-67-INK-BK%2Fproduct.png&w=400&format=webp" &
done | sort | uniq -c
# Expect: 30x 200 (or 30x 304 after first warm-up). Zero 429s.
```

### Fix 3 — Send real caching headers

Product images are immutable (filename includes product code). Replace the `no-store` directive with a long `max-age` + `immutable` on success responses:

```js
// Only after a successful optimize+transform
res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
res.setHeader('Vary', 'Accept'); // if you serve webp vs png by accept header
```

For the error path (upstream fetch failed, bad URL param, etc.) keep `no-store` so failures don't get cached.

**Verification:**

```bash
curl -sI 'https://ink-backend-zaeq.onrender.com/api/images/optimize?url=<any>&w=400'
# Must contain on 200:  cache-control: public, max-age=31536000, immutable
```

### Fix 4 (optional but recommended) — Set a Vercel/CDN edge cache header

If the backend is behind a CDN or Vercel edge, also set `CDN-Cache-Control` or `s-maxage` so the CDN caches and the origin gets hammered less:

```js
res.setHeader('Cache-Control', 'public, max-age=31536000, immutable, s-maxage=31536000');
```

---

## Out of scope — frontend will not change

The frontend fallback behavior (color-block placeholder on `<img>` error) is correct and stays. The frontend is not going to stop using `/api/images/optimize`. Once the four fixes above ship, images will load on every card without any frontend change.

---

## Acceptance checklist

- [ ] `curl -I` on any `/api/images/optimize` URL returns `cross-origin-resource-policy: cross-origin`
- [ ] 30 parallel GETs return zero 429s
- [ ] Successful response includes `cache-control: public, max-age=31536000, immutable`
- [ ] Load `https://inkcartridges.co.nz/html/shop` in a real browser — every product card shows its product image, not a color-block placeholder, with no `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` errors in the console
- [ ] Repeat for a search: type "67" or "069" in the header search; all image tiles render
