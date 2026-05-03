# Backend URL Migration — Switch emitted URLs from `/html/...` to clean form

**Date frontend shipped**: 2026-05-02
**Frontend repo**: `matcha/FEINK` (Vercel)
**Backend repo**: this one (Render, served at `https://ink-backend-zaeq.onrender.com`)

---

## Why this exists

The frontend used to expose URLs like `inkcartridges.co.nz/html/shop`, `/html/cart`, `/html/account/orders` etc. — because the static HTML files literally live in a folder called `html/`. On 2026-05-02 the frontend shipped a clean-URL migration: visible URLs are now `/shop`, `/cart`, `/account/orders` etc. The `/html/...` form is preserved as a 301 redirect target for backwards compatibility.

The backend still emits `/html/...` URLs in several places (sitemap, product feeds, prerendered HTML, API responses). Those URLs are functional — the frontend will 301 them — but:

- Google's index will keep listing the old URLs and following 301s indefinitely. Until the sitemap advertises clean URLs, consolidation takes weeks/months instead of days.
- Each shopping-feed click costs a redirect hop, hurting Core Web Vitals.
- Internal links in prerendered HTML show old URLs in dev tools and confuse anyone debugging.

**Goal**: update every place the backend emits a public URL so it uses the clean form. Functional behavior doesn't change — this is purely a string substitution across emitted output.

---

## The complete URL mapping

Apply this mapping wherever the backend builds a URL string. Query strings are preserved unchanged.

| Old (`/html/...`)                              | New (clean)                          |
| ---------------------------------------------- | ------------------------------------ |
| `/html/shop`, `/html/shop.html`                | `/shop`                              |
| `/html/cart`, `/html/cart.html`                | `/cart`                              |
| `/html/checkout`, `/html/checkout.html`        | `/checkout`                          |
| `/html/payment`, `/html/payment.html`          | `/payment`                           |
| `/html/order-confirmation[.html]`              | `/order-confirmation`                |
| `/html/ribbons`, `/html/ribbons.html`          | `/ribbons`                           |
| `/html/account`, `/html/account/index.html`    | `/account`                           |
| `/html/account/<page>[.html]`                  | `/account/<page>`                    |
| `/html/admin`, `/html/admin/index.html`        | `/admin`                             |
| `/html/admin/<page>[.html]`                    | `/admin/<page>`                      |
| `/html/index`, `/html/index.html`, `/html`     | `/` (already redirected)             |
| `/html/product?sku=<SKU>` (SKU-only fallback)  | `/p/<SKU>`                           |
| `/html/product?slug=<SLUG>`                    | `/product/<SLUG>`                    |
| `/html/product?slug=<SLUG>&sku=<SKU>` (both)   | `/products/<SLUG>/<SKU>`             |
| `/html/brands/`                                | `/shop` (the old brands index page was deleted; `/brands` 301s to `/shop`) |

**Pages that did NOT move** — keep emitting these as-is:

- `/html/product-by-name` — backend-served route, unchanged.
- Any `/api/...` URLs — unchanged.

**Account sub-pages** (full enumeration so search-and-replace is safe):
`/account/addresses`, `/account/favourites`, `/account/forgot-password`, `/account/login`, `/account/loyalty`, `/account/order-detail`, `/account/orders`, `/account/personal-details`, `/account/printers`, `/account/reset-password`, `/account/settings`, `/account/track-order`, `/account/verify-email`.

**Admin sub-pages**:
`/admin/customer-intelligence`, `/admin/customers`, `/admin/financial-health`, `/admin/marketing`, `/admin/operations`, `/admin/orders`, `/admin/product-edit`, `/admin/products`, `/admin/reports`, `/admin/sales`, `/admin/settings`, `/admin/sync-report`.

---

## Where to look in this repo

These are the files/areas most likely to emit `/html/...` strings. Grep first, then audit each hit:

```bash
grep -rn "/html/" --include="*.js" --include="*.ts" --include="*.xml" --include="*.json" .
```

Expected hot spots:

1. **Sitemap generators**
   - `routes/sitemap.*` or `controllers/sitemap.*` or wherever the `/sitemap.xml`, `/sitemap-products.xml`, `/sitemap-pages.xml` etc. handlers live
   - Look for hardcoded `/html/shop`, `/html/ribbons`, page-list arrays
   - Look for product loops that build URLs from `slug` and `sku`

2. **Product feed generators** — these are the highest commercial impact
   - `/feeds/google-shopping.xml` — Google Merchant Center listings; URL is the `<link>` field
   - `/feeds/facebook-catalog.tsv` — Facebook product catalog; URL is the `link` column
   - `/feeds/google-promotions.xml` — promotions feed
   - All three almost certainly use the same URL-builder helper. Find it, fix it once.

3. **Prerender HTML**
   - `/api/prerender/*` endpoints (called by frontend `middleware.js` for bot user-agents)
   - These return SSR'd HTML containing internal `<a href>` and JSON-LD `url` fields
   - Anything with `breadcrumb`, `BreadcrumbList`, `ItemList`, `WebPage.url`, `<link rel="canonical">`, `og:url`, `twitter:url`

4. **API responses with URL fields**
   - Any product or category endpoint that returns `canonical_url`, `url`, `permalink`, `link`, `slug_url`
   - Example caller: frontend `js/products.js` reads `product.canonical_url` — if backend emits `/html/product?sku=X`, frontend uses it directly
   - Search/suggest endpoints that return result URLs

5. **robots.txt**
   - Verify it doesn't reference `/html/...` paths in `Allow:` / `Disallow:` lines
   - Should reference the clean paths now (e.g. `Disallow: /admin` not `Disallow: /html/admin`)
   - The sitemap-index URL line should still be `/sitemap.xml` (backend-served)

6. **Email templates** (if applicable)
   - Order confirmation, password reset, account verification, etc.
   - Look in `templates/`, `emails/`, `views/`

7. **Admin notification webhooks / Slack messages** (if applicable)
   - Order links, customer profile links

8. **Database**
   - If any product row has a stored `canonical_url` column with `/html/...` baked in, write a one-shot migration:
     ```sql
     UPDATE products
     SET canonical_url = REPLACE(canonical_url, '/html/product?sku=', '/p/')
     WHERE canonical_url LIKE '/html/product?sku=%';
     -- repeat for /html/shop, /html/ribbons, etc., per the mapping table above
     ```
   - Check the product canonical-URL builder logic — ideally compute on the fly from `slug` + `sku`, not from a stored column.

---

## A reusable URL-builder

If the codebase doesn't already have one, add a single helper and route every emission through it. Example:

```js
// lib/urls.js
const SITE = process.env.SITE_BASE || 'https://www.inkcartridges.co.nz';

function productUrl({ slug, sku }) {
  if (slug && sku) return `${SITE}/products/${encodeURIComponent(slug)}/${encodeURIComponent(sku)}`;
  if (slug) return `${SITE}/product/${encodeURIComponent(slug)}`;
  if (sku) return `${SITE}/p/${encodeURIComponent(sku)}`;
  return SITE;
}

function pageUrl(page) {
  // page = 'shop' | 'cart' | 'ribbons' | etc.
  return `${SITE}/${page}`;
}

function accountUrl(sub) {
  return sub ? `${SITE}/account/${sub}` : `${SITE}/account`;
}

module.exports = { productUrl, pageUrl, accountUrl, SITE };
```

Replace inline URL strings everywhere with calls into this helper. That way the next migration is a one-file change.

---

## How to verify before deploying

1. **No old-form strings remain**:
   ```bash
   grep -rn "/html/" --include="*.js" --include="*.ts" --include="*.xml" .
   ```
   Should return zero matches except for `/html/product-by-name` (backend route, intentionally unchanged) and any documentation/changelog references.

2. **Sitemap returns clean URLs**:
   ```bash
   curl -s https://staging.<your-backend>/sitemap.xml | grep -oE '<loc>[^<]+</loc>' | head -20
   ```
   Every `<loc>` should use clean form. Spot-check that `/shop`, `/ribbons`, `/products/<slug>/<sku>` appear, and `/html/...` does not.

3. **Product feeds**:
   ```bash
   curl -s https://staging.<your-backend>/feeds/google-shopping.xml | grep -oE '<link>[^<]+</link>' | head -20
   curl -s https://staging.<your-backend>/feeds/facebook-catalog.tsv | head -5
   ```
   Same check — clean URLs only.

4. **Prerender HTML (simulate Googlebot)**:
   ```bash
   curl -s -A "Googlebot/2.1" https://www.inkcartridges.co.nz/shop?brand=hp | grep -oE 'href="[^"]+"' | grep -E 'html/' | head
   ```
   After the frontend ships this migration, this should be empty. (Note: the prerender endpoint is hit by the frontend's edge middleware; you can also call `/api/prerender/category/ribbons` on the backend directly.)

5. **robots.txt**:
   ```bash
   curl -s https://www.inkcartridges.co.nz/robots.txt
   ```
   Verify any path references match the clean URLs.

6. **Resubmit sitemap to Google Search Console** after deploy so reindexing kicks off immediately.

---

## What NOT to change

- The `/html/product-by-name` backend route itself — frontend `vercel.json` rewrites `/html/product-by-name` → backend, so it must keep that path.
- Admin auth cookie name (`__ink_auth=1`) and any `/api/...` paths — those weren't touched.
- The `/html/...` redirect destinations on the frontend side — they're owned by `vercel.json` in the frontend repo, not your concern.
- Any internal-only logging that uses `/html/...` paths for historical reasons (low value, low risk).

---

## Sanity check that the frontend side is correct

If you want to confirm what the frontend now expects, in the frontend repo:

- `inkcartridges/vercel.json` — see the `rewrites` block (clean → `/html/...`) and the new top-of-`redirects` block (`/html/...` → clean).
- `inkcartridges/middleware.js` — admin auth gate now matches `/admin*`; bot prerender matchers now use `/shop`, `/ribbons`, `/p/:sku`.

Both are committed on `main` as of 2026-05-02.
