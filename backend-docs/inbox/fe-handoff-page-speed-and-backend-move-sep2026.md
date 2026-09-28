# Storefront speed fixes and the backend move — frontend handoff

**Date:** 28 September 2026
**From:** backend
**Status:** every backend change this document depends on is live and verified.

## Summary

On 28 September the backend moved from Render Oregon to Render Singapore, next to the database
(Supabase, Mumbai). Each database call from the API now takes about 75–86 ms instead of 258 ms.
The switch cost about 2–4 seconds of downtime. `https://api.inkcartridges.co.nz` already points
at the new service, so the browser needs no change.

The same day the backend added the fields the product page used to read straight from Supabase,
and cut several slow request chains.

This document lists seven frontend changes, in order. The first one blocks backend clean-up and
should ship first. The others remove waits that shoppers see today.

| # | Change | Why it matters | Backend support |
|---|---|---|---|
| 0 | Point the Vercel server at the new backend address | The old service is switched off once this ships; anything still calling it then breaks, including the pages Google sees and the sitemaps | n/a |
| 1 | Search results: stop chaining two extra searches | Results page LCP 7.5 s; images wait for a request that starts late | n/a |
| 2 | Product page: paint the gallery from the product response | LCP 4.7 s; the main image waits behind three direct Supabase reads | Live |
| 3 | Brand page: don't hold schema and prerender behind the ribbons call | Its last requests finished at 10.0 s before the backend fix, 2.2 s after | n/a |
| 4 | Every page: move two direct Supabase reads behind the API | Two uncached trips to Mumbai on every page view | Live |
| 5 | Defer the Google Customer Reviews badge | About 450 KB of third-party JavaScript on every page | n/a |
| 6 | Skip `GET /api/cart` when there is no cart | An uncached origin call on every first page view | n/a |

---

## 0. Point the Vercel server at the new backend address (do first)

The Vercel server side still calls the old service's own address,
`https://ink-backend-zaeq.onrender.com`. The old service is kept running only for these calls.

Direct calls to the old address in the 24 hours to 28 Sep 2026, from the Render request logs:

| Path | Count |
|---|---|
| `/api/prerender/product/*`, `/brand/*`, `/home`, `/printer/*`, `/category/*`, `/shop` | about 2,290 |
| `GET /` (an uptime pinger, about every 2.5 minutes) | 586 |
| `/sitemap*.xml`, `/robots.txt` | about 90 |
| `/api/ribbons`, `/api/products/:sku`, `/api/shop`, `/p/:sku`, others | about 25 |

**Change:** replace `https://ink-backend-zaeq.onrender.com` with
`https://ink-backend-sg.onrender.com` everywhere on the Vercel side:

- the bot pre-render middleware (`/api/prerender/*`);
- the sitemap and `robots.txt` rewrites;
- the non-production `API_URL` fallback in `js/config.js`, currently:

  ```js
  API_URL: (location.hostname === 'www.inkcartridges.co.nz' || location.hostname === 'inkcartridges.co.nz')
      ? 'https://api.inkcartridges.co.nz'
      : 'https://ink-backend-zaeq.onrender.com',   // → https://ink-backend-sg.onrender.com
  ```

- if the `GET /` pinger is yours, point it at `https://api.inkcartridges.co.nz/health`.

**Check after deploying:** `https://www.inkcartridges.co.nz/sitemap.xml` loads, and a bot fetch of
any product page returns the pre-rendered HTML. Then tell the backend. We will confirm the old
address has gone quiet in the logs before switching it off.

---

## 1. Search results: stop chaining two extra searches after `/search/smart`

One search makes three requests. `/api/search/smart?limit=100` already returns the products.
When it finishes, the page starts `/api/products?search=…&limit=100` and
`/api/search/suggest?limit=20`, and the result images wait for the slower of the two.

Measured waterfall (query `tn2450`, mobile, first visit):

| Request | Start | Duration |
|---|---|---|
| `GET /api/search/smart?limit=100` | 0.54 s | 4.96 s |
| `GET /api/products?search=…&limit=100` | 5.50 s | 0.49 s |
| `GET /api/search/suggest?limit=20` | 5.50 s | 1.73 s |
| Result images | 7.25 s | 0.03–2.8 s |
| **LCP** | **7.47 s** | |

`tn2450` is not in the catalogue, so `/search/smart` took its slow "did you mean" path. For
searches that match, the production median for `/search/smart` was 2.5 s before the move to
Singapore.

**Change:** render results from the `/search/smart` response alone. If the page needs
`/search/suggest` (for "did you mean" or the suggestion rail), start it at the same time as
`/search/smart` and don't let result images wait for it. Drop `/api/products?search=` on this
page unless it feeds something `/search/smart` does not return; if it does, tell the backend what
is missing.

**Expected gain:** images start when `/search/smart` returns, about 1.7 s sooner on this load, and
every search makes two fewer origin requests.

---

## 2. Product page: paint the gallery from the product response

The product JSON arrives at 2.7 s and already carries `image_url`, `image_srcset` and
`image_thumbnail_url`. The first image request did not start until 4.2 s. Before it, the page ran
three reads from the browser straight to Supabase in Mumbai, one after another. Two more direct
reads came later.

Measured waterfall (`/products/…/C02BK`, mobile, first visit):

| Request | Start | Duration |
|---|---|---|
| `GET /api/products/C02BK` | 0.60 s | 2.14 s |
| `GET /api/products/C02BK/for-use-in` | 2.74 s | 0.71 s |
| Supabase `products?select=id,description_html,related_product_skus` | 2.74 s | 0.69 s |
| Supabase `product_codes` (this product) | 3.45 s | 0.69 s |
| First images | 4.16 s | 0.53 s |
| `GET /api/shop?brand=hp&category=ink&limit=200&code=02` | 4.16 s | 2.02 s |
| `GET /api/products?brand=hp&category=ink&source=compatible&limit=200` | 4.16 s | 1.06 s |
| reviews, reviews/summary, bought-together | 4.16 s | 0.64–0.81 s |
| Supabase `product_codes` (related ids) | 6.18 s | 0.34 s |
| Supabase `product_codes?code=eq.02` | 6.52 s | 0.39 s |
| **LCP** | **4.70 s** | |

**Change:** render the gallery, and preload the main image, as soon as `/api/products/:sku`
returns. Start description, codes, "for use in", related items and reviews in parallel, not in a
chain, and never gate the gallery on them.

**All four direct Supabase reads on this page can be removed** (live since 28 Sep):

| Direct read today | Use instead |
|---|---|
| `products?select=id,description_html,related_product_skus` | `description_html` and `related_product_skus` on `GET /api/products/:sku` |
| `product_codes` for this product | `series_codes` on `GET /api/products/:sku` now applies the `product_codes` override (an override replaces the derived codes) |
| `product_codes` for the related items | rows from `GET /api/products` and `GET /api/shop` carry override-aware `series_codes` |
| `product_codes?code=eq.<code>` | `GET /api/shop?brand=…&code=…` now includes products filed under the code by an override (example: `/api/shop?brand=hp&code=57` returns `C56BK`) |

The product response also carries `review_count` and `average_rating`; check whether
`/reviews/summary` is still needed.

**Expected gain:** the main image can start at about 2.8 s instead of 4.2 s, so LCP should drop by
about 1.4 s. The product request itself is also faster since 28 Sep: fewer serial database stages
and about three times faster database calls.

---

## 3. Brand page: don't hold schema and prerender behind the ribbons call

`/api/schema/collection` and `/api/prerender/brand/…` start only after
`/api/ribbons?printer_brand=` finishes.

| Request | Start | Duration |
|---|---|---|
| `GET /api/shop?brand=brother` | 0.59 s | 0.79 s |
| `GET /api/ribbons?printer_brand=brother&limit=1` | 0.59 s | 8.61 s before the backend fix, 1.49 s after |
| `GET /api/schema/collection?brand=brother` | 9.21 s | 0.77 s |
| `GET /api/prerender/brand/brother` | 9.21 s | 0.77 s |

**Change:** start all four requests together. The ribbons request asks for `limit=1`, so it looks
like a check for whether to show a ribbons link. If the schema or prerender request really needs
its result, say so and the backend can return the ribbon count with `/api/shop`.

---

## 4. Every page: move the two direct Supabase reads behind the API

Every page load makes two uncached reads from the browser to Supabase in Mumbai (0.35–1.14 s each
in our measurements). They don't block first paint, but every page view pays for them.

| Direct read today | Use instead |
|---|---|
| `site_settings?select=value&key=eq.site_locked` | `GET /api/site/lock` (live since 25 Sep). Returns `{ enabled, message }`, edge-cached 60 s, fails open. Switch `site-guard.js` to it. |
| `ribbon_brands?is_active=eq.true&order=sort_order.asc&select=id,name,slug,image_url,sort_order` | `ribbon_brands` on `GET /api/site/nav` (live since 28 Sep). Same fields, filter and order; verified identical (63 brands, same order). The value is `null` (not `[]`) if the backend could not load the list; in that case fall back to your current read. |

**Expected gain:** two fewer Mumbai round trips per page view. With both reads moved, the Supabase
client (44 KB from jsDelivr) may no longer be needed on pages that loaded it only for these reads.

---

## 5. Defer the Google Customer Reviews badge

The category page loaded 44 scripts totalling 1.41 MB (uncompressed), mostly third-party. The
Google Customer Reviews badge (`platform.js?onload=renderOptIn` and `m=ratingbadge`) pulls in
about 450 KB on every page. The two Google tag containers (G- and AW-) add 177 KB and 156 KB. On a
phone this JavaScript runs on the same thread as scrolling and taps. We did not measure
main-thread time.

**Change:** load the rating badge after the page is idle (`requestIdleCallback`, or on first
scroll). The opt-in survey (`renderOptIn`) is needed only on the order confirmation page.

---

## 6. Skip `GET /api/cart` when there is no cart to read

Every page asks `/api/cart` for the header count, including first-time visitors with no
`X-Guest-Session` and no login. The request is per-user, so it always reaches the origin
(0.2–1.4 s in our measurements).

**Change:** with no stored guest session and no auth token, show an empty cart without calling
the API. Call it once a session exists.

---

## Already fixed since the 21 September audit

- Static assets are served `cache-control: public, max-age=31536000, immutable`.
- No `OPTIONS` preflights on catalogue GETs.
- Category pages use one `/api/products/counts?brands=…` call.
- The traffic beacon posts through `api.inkcartridges.co.nz`.

## Backend changes, 28 September 2026

| Commit | Change |
|---|---|
| `faf5690` | `/api/ribbons?printer_brand=` and `printer_model=`: 24 serial database calls → 3 (Brother 8.6 s → 1.5 s live). The old path also missed 74 of Brother's 1,074 printer models. Product page and cart quantity change make fewer serial calls. |
| `ef9fdf8` | `GET /api/products/:sku` adds `description_html` and `related_product_skus`; its `series_codes` apply `product_codes` overrides. `GET /api/site/nav` adds `ribbon_brands`. `bought_for_this_printer` (with `?printer_slug=`) now works; a bug meant it could never appear before. |
| `74fb234` | `GET /api/products` rows apply `product_codes` overrides. `GET /api/shop?code=` includes products filed under the code by an override; all 32 active override rows now list under their codes, and ordinary codes return the same products as before. |
| Infrastructure | API moved to Render Singapore (`ink-backend-sg`). `api.inkcartridges.co.nz`, the Stripe webhook and the PayPal webhook all point at it. The PayPal webhook had never reached the backend before (its URL redirected to `www` and returned 404); it now works. |

A real-browser check of the live site passed after the move, with no script errors and no API
errors: home, brand, series-code page, product page, category, search, ribbons and cart, plus add
to cart, change quantity and remove.

## How these numbers were measured

Playwright Chromium, iPhone user agent, 390 × 664 viewport, a fresh browser context per page
(first-time visitor), one load per page, from New Zealand, 28 September 2026. Timings are single
samples and vary by a few hundred milliseconds between loads. Waterfall starts are measured from
navigation. The before-numbers were taken while the API was still in Oregon; uncached API calls
are now roughly 0.4–0.8 s faster, and responses served from the edge cache are unchanged.
