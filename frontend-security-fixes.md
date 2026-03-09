# Frontend Security Fixes

Findings from scanning `https://www.inkcartridges.co.nz/html` on 2026-03-09.

Backend fixes already applied in `src/server.js` (Referrer-Policy, Permissions-Policy, CORP, HSTS preload).

---

## Must Fix

### 1. Move CSP from `<meta>` tag to HTTP header

**Severity:** High

The CSP is currently delivered via `<meta http-equiv="Content-Security-Policy">`. Browsers **ignore `frame-ancestors` in meta tags**, so your clickjacking protection from `frame-ancestors 'none'` is not active. CSP must be set as an HTTP response header for full enforcement.

### 2. Add Cloudflare Insights to CSP `script-src`

**Severity:** High

`https://static.cloudflareinsights.com` is missing from the `script-src` directive. The Cloudflare Web Analytics beacon is being **actively blocked** by CSP — you can see this in browser console:

```
Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/...'
violates the following Content Security Policy directive: "script-src 'self' ..."
```

Add `https://static.cloudflareinsights.com` to `script-src`.

### 3. Add SRI hashes to all first-party scripts

**Severity:** Medium-High

Only the Supabase CDN script has an `integrity` attribute. All 16+ first-party scripts load without Subresource Integrity checks:

- `config.js`, `security.js`, `utils.js`, `api.js`, `auth.js`
- `products.js`, `search.js`, `search-normalize.js`, `main.js`
- `mega-nav.js`, `landing.js`, `modern-effects.js`
- `cart.js`, `ink-finder.js`, `printer-data.js`, `analytics.js`

If the hosting or CDN is compromised, these scripts could be tampered with silently. Generate SRI hashes with:

```bash
cat file.js | openssl dgst -sha384 -binary | openssl base64 -A
```

Then add to each script tag:

```html
<script src="/js/config.js" integrity="sha384-..." crossorigin="anonymous"></script>
```

### 4. Restrict `Access-Control-Allow-Origin`

**Severity:** Medium-High

The frontend currently returns `Access-Control-Allow-Origin: *`. This should be restricted to the actual domain (`https://www.inkcartridges.co.nz`). Note: the backend CORS is already properly restricted — this is a Vercel/Cloudflare hosting config issue.

---

## Should Fix

### 5. Add security headers via `vercel.json`

**Severity:** Medium

The frontend responses are missing `Strict-Transport-Security`, `Referrer-Policy`, and `Permissions-Policy` headers. Add to `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=31536000; includeSubDomains; preload"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "Permissions-Policy",
          "value": "camera=(), microphone=(), geolocation=()"
        },
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://js.stripe.com https://www.googletagmanager.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://lmdlgldjgcanknsjrcxh.supabase.co data:; connect-src 'self' https://lmdlgldjgcanknsjrcxh.supabase.co https://ink-backend-zaeq.onrender.com https://www.google-analytics.com; frame-ancestors 'none'"
        }
      ]
    }
  ]
}
```

This fixes items 1, 2, and 4 in one shot (CSP as header, Cloudflare in script-src, frame-ancestors enforced).

### 6. Strip HTML comments in production

**Severity:** Low

The production HTML contains structural comments that map out page architecture:

```html
<!-- ============================================
     HEADER
     ============================================ -->
<!-- Main header -->
<!-- Contact info -->
<!-- Header actions -->
<!-- Primary navigation -->
```

Strip these in the build step to reduce information leakage.

### 7. Remove localStorage cart backup for authenticated users

**Severity:** Low-Medium

`cart.js` saves cart data to localStorage even for authenticated users as a "backup." This creates a vector where manipulated localStorage data could be restored if server calls fail. For authenticated users, the server should be the sole source of truth — remove the localStorage sync entirely.

---

## Nice to Have

### 8. Proxy API calls through the frontend domain

**Severity:** Low

The backend URL (`https://ink-backend-zaeq.onrender.com`) is visible in `config.js` and network traffic. Attackers can target it directly, bypassing Cloudflare protections on the main domain.

Configure a Vercel rewrite to proxy API requests:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://ink-backend-zaeq.onrender.com/api/:path*" }
  ]
}
```

Then update `config.js` to use `/api` instead of the full Render URL.

---

## Summary

| #  | Fix                                   | Severity    | Effort |
|----|---------------------------------------|-------------|--------|
| 1  | CSP via HTTP header (not meta)        | High        | Low    |
| 2  | Add Cloudflare to CSP script-src      | High        | Low    |
| 3  | SRI hashes on all scripts             | Medium-High | Medium |
| 4  | Restrict CORS to actual domain        | Medium-High | Low    |
| 5  | Security headers in vercel.json       | Medium      | Low    |
| 6  | Strip HTML comments                   | Low         | Low    |
| 7  | Remove localStorage cart for authed   | Low-Medium  | Medium |
| 8  | Proxy API through frontend domain     | Low         | Medium |

Items 1, 2, 4, and 5 can all be solved with a single `vercel.json` update.
