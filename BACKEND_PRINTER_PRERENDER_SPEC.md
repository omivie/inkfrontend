# Printer Page Prerender — Backend Implementation Spec

## TL;DR

Build `GET /api/prerender/printer/:slug` that returns a fully server-rendered HTML page for a printer (e.g. `canon-laser-shot-lbp5200`). The frontend Vercel middleware already calls this endpoint for crawler traffic; once the backend serves it, printer-model SEO pages start working without any further FE changes.

## Why this is needed

Printer-model URLs (`/shop?printer=canon-laser-shot-lbp5200`) are a high-intent SEO surface — searches like "canon laser shot lbp 5200 cartridges" land here. Today, when Googlebot hits these URLs the FE middleware tries to fetch a printer prerender from the backend, but the endpoint returns 404, so bots fall through to the SPA shell and the page indexes poorly.

Existing prerender endpoints that this should mirror in style:
- `/api/prerender/home`
- `/api/prerender/product/:sku`
- `/api/prerender/product-by-slug/:slug`
- `/api/prerender/category/ribbons`

Hit `/api/prerender/home` to see the existing HTML shape — it's a simple, JS-free, bot-friendly document with a full SEO `<head>` and a plain `<body>` listing content as semantic HTML.

## What the FE expects

The Vercel middleware (`inkcartridges/middleware.js`) does this on bot traffic:

```js
// /shop?printer=<slug> → printer prerender
else if (path === '/shop') {
  const printerSlug = url.searchParams.get('printer');
  if (printerSlug) {
    prerenderPath = `/api/prerender/printer/${encodeURIComponent(printerSlug)}`;
  }
}
```

It fetches `${BACKEND}/api/prerender/printer/:slug`, streams the body back to the bot with `Content-Type: text/html; charset=utf-8`, and adds its own `Cache-Control: public, s-maxage=3600, max-age=3600`. Any non-2xx response causes a fallthrough to the SPA shell.

## Endpoint contract

**Route:** `GET /api/prerender/printer/:slug`

**Path param:** `slug` — printer slug (e.g. `canon-laser-shot-lbp5200`, `brother-mfc-l2750dw`). Match case-insensitively against `printers.slug`. Trim trailing slash.

**Response — success (200):**
- `Content-Type: text/html; charset=utf-8`
- Body: complete HTML document (see template below)

**Response — printer not found (404):**
- Plain text or JSON 404 — middleware will fall through to the SPA. Do **not** return 200 with an empty body or "no products" page; that would tell Google to index a content-less page under the printer's URL.

**Response — printer found, zero products (200):**
- Still return a full page. The printer page is valuable even with no cartridges (think: "we sell zero cartridges for this printer right now, but the page exists, here's the brand, here's a CTA"). Use a soft empty-state copy and link to the brand hub.

**Cache:** middleware overrides with `s-maxage=3600`, but feel free to set your own hint (e.g. `Cache-Control: public, max-age=600`) for direct-to-backend hits.

## HTML template

Mirror the structure of `/api/prerender/home`. Required elements:

### `<head>` — SEO metadata

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{Printer Full Name} Ink &amp; Toner Cartridges NZ | InkCartridges.co.nz</title>
  <meta name="description" content="Genuine and compatible cartridges for the {Printer Full Name}. {N} options available. Free NZ shipping over $100.">
  <link rel="canonical" href="https://www.inkcartridges.co.nz/shop?printer={slug}">
  <meta name="robots" content="index, follow">

  <meta property="og:title"       content="{Printer Full Name} Cartridges NZ | InkCartridges.co.nz">
  <meta property="og:description" content="Genuine and compatible cartridges for the {Printer Full Name}. Free NZ shipping over $100.">
  <meta property="og:type"        content="website">
  <meta property="og:url"         content="https://www.inkcartridges.co.nz/shop?printer={slug}">
  <meta property="og:site_name"   content="InkCartridges.co.nz">

  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="{Printer Full Name} Cartridges NZ">
  <meta name="twitter:description" content="Genuine and compatible cartridges for the {Printer Full Name}.">

  <!-- BreadcrumbList -->
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home",        "item": "https://www.inkcartridges.co.nz/" },
      { "@type": "ListItem", "position": 2, "name": "{Brand Name}", "item": "https://www.inkcartridges.co.nz/brands/{brand-slug}" },
      { "@type": "ListItem", "position": 3, "name": "{Printer Full Name}", "item": "https://www.inkcartridges.co.nz/shop?printer={slug}" }
    ]
  }</script>

  <!-- CollectionPage + ItemList of cartridges -->
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "{Printer Full Name} Cartridges",
    "url": "https://www.inkcartridges.co.nz/shop?printer={slug}",
    "description": "...",
    "mainEntity": {
      "@type": "ItemList",
      "numberOfItems": {N},
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "item": {
            "@type": "Product",
            "name": "{Product Name}",
            "sku":  "{SKU}",
            "image": "{image_url}",
            "url":  "https://www.inkcartridges.co.nz/products/{product-slug}/{SKU}",
            "brand": { "@type": "Brand", "name": "{Brand}" },
            "offers": {
              "@type": "Offer",
              "price": "{retail_price}",
              "priceCurrency": "NZD",
              "availability": "https://schema.org/{InStock|OutOfStock}"
            }
          }
        }
        // ... one entry per product
      ]
    }
  }</script>
</head>
```

### `<body>` — bot-friendly semantic HTML

No JS, no client-side rendering. Plain HTML so Googlebot can parse it without executing scripts. Match the home prerender's pattern (header/nav, h1, sections with `<ul>` / `<a>`).

```html
<body>
  <header>
    <a href="https://www.inkcartridges.co.nz"><strong>InkCartridges.co.nz</strong></a>
    <nav aria-label="Main navigation">
      <a href="https://www.inkcartridges.co.nz/shop">Shop All</a> |
      <a href="https://www.inkcartridges.co.nz/ink-cartridges">Ink Cartridges</a> |
      <a href="https://www.inkcartridges.co.nz/toner-cartridges">Toner Cartridges</a> |
      <a href="https://www.inkcartridges.co.nz/ribbons">Ribbons</a> |
      <a href="https://www.inkcartridges.co.nz/html/contact">Contact</a>
    </nav>
  </header>

  <main>
    <nav aria-label="Breadcrumb">
      <a href="https://www.inkcartridges.co.nz/">Home</a> &rsaquo;
      <a href="https://www.inkcartridges.co.nz/brands/{brand-slug}">{Brand Name}</a> &rsaquo;
      {Printer Full Name}
    </nav>

    <h1>Cartridges for {Printer Full Name}</h1>
    <p>Browse genuine and compatible ink and toner cartridges that fit the {Printer Full Name}. {N} option{s} available. Free NZ-wide shipping on orders over $100.</p>

    <section>
      <h2>Genuine Cartridges</h2>
      <ul>
        <li>
          <a href="https://www.inkcartridges.co.nz/products/{slug}/{sku}">
            <strong>{Product Name}</strong>
          </a>
          — {colour}, {page_yield} pages — NZ${retail_price} {InStock ? "" : "(out of stock)"}
        </li>
        <!-- ... -->
      </ul>
    </section>

    <section>
      <h2>Compatible Cartridges</h2>
      <ul>
        <!-- same shape as Genuine, for source = 'compatible' -->
      </ul>
    </section>

    <!-- Empty-state when no products: -->
    <!-- <section>
      <p>No cartridges currently listed for this printer. Browse all
      <a href="https://www.inkcartridges.co.nz/brands/{brand-slug}">{Brand Name}</a> cartridges,
      or <a href="https://www.inkcartridges.co.nz/html/contact">contact us</a> to request a fit.</p>
    </section> -->
  </main>

  <footer>
    <p>&copy; InkCartridges.co.nz — Auckland, New Zealand</p>
  </footer>
</body>
</html>
```

## Data sources — reuse existing

`/api/printers/:slug/products` already returns everything you need. Sample response for `canon-laser-shot-lbp5200`:

```json
{
  "ok": true,
  "data": {
    "printer": {
      "id": "f9f46794-...",
      "model_name": "LASER SHOT LBP 5200",
      "full_name": "Canon LASER SHOT LBP 5200",
      "slug": "canon-laser-shot-lbp5200",
      "brand": { "name": "Canon", "slug": "canon" }
    },
    "products": [
      {
        "sku": "G-CAN-CART301D-DRM-BK",
        "name": "Canon Genuine CART301D Drum Unit Black",
        "slug": "canon-genuine-cart301d-drum-unit-black",
        "source": "genuine",
        "retail_price": 302.49,
        "color": "Black",
        "page_yield": "",
        "in_stock": true,
        "image_url": "https://...",
        "brand": "Canon"
      }
    ]
  }
}
```

The same DB query / service used by that endpoint should back the prerender — just render to HTML instead of JSON. Pass a high-enough `limit` to include the full product set (cap at e.g. 200 — printers with more cartridges than that are vanishingly rare, and the page should not paginate).

Split products into two sections by `source` field:
- `source === 'genuine'` → "Genuine Cartridges"
- `source === 'compatible'` → "Compatible Cartridges"

Order within each section: in-stock first, then alphabetical by name (matching the existing FE behaviour).

## Edge cases

| Case | Behaviour |
|---|---|
| Slug not found in DB | Return **404**. Middleware falls through to SPA shell. Do not return 200 with empty content. |
| Slug found, zero products | Return **200** with the soft empty-state body. Page still has SEO value. |
| Slug case mismatch (`Canon-LASER-SHOT-LBP5200`) | Treat slugs as case-insensitive. |
| Trailing slash | Treat `/api/prerender/printer/foo/` and `/api/prerender/printer/foo` identically. |
| Special characters in product names (`&`, `<`, `>`, `"`, `'`) | HTML-escape all dynamic content. The home prerender already does this (`&amp;` etc.) — use the same helper. |
| Special characters in slug | Slugs are constrained to `[a-z0-9-]` in the DB, so no escaping needed for the canonical URL — but URL-encode anyway as defense. |
| Image URL is null | Omit `image` from the JSON-LD entry rather than emitting `"image": null`. |
| `retail_price` is null/0 | Omit `offers` rather than emitting an invalid `Offer`. |

## Smoke tests after deploy

```bash
# 1. Endpoint returns 200 with HTML for a real printer
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://ink-backend-zaeq.onrender.com/api/prerender/printer/canon-laser-shot-lbp5200
# expect: 200 text/html; charset=utf-8

# 2. Body has correct title + canonical
curl -s https://ink-backend-zaeq.onrender.com/api/prerender/printer/brother-mfc-l2750dw \
  | grep -E '<title>|rel="canonical"|<h1>'

# 3. Unknown slug → 404
curl -s -o /dev/null -w "%{http_code}\n" \
  https://ink-backend-zaeq.onrender.com/api/prerender/printer/this-printer-does-not-exist
# expect: 404

# 4. End-to-end via Vercel middleware (Googlebot UA)
curl -s -A "Googlebot/2.1" \
  'https://www.inkcartridges.co.nz/shop?printer=canon-laser-shot-lbp5200' \
  | grep -E 'X-Prerendered|<title>'
# expect: <title>Canon LASER SHOT LBP 5200 ...</title> in body, X-Prerendered: true in headers

# 5. JSON-LD parses cleanly
curl -s https://ink-backend-zaeq.onrender.com/api/prerender/printer/canon-laser-shot-lbp5200 \
  | python3 -c "
import sys, re, json
html = sys.stdin.read()
blocks = re.findall(r'<script type=\"application/ld\+json\">(.*?)</script>', html, re.DOTALL)
print(f'{len(blocks)} JSON-LD blocks found')
for b in blocks:
    json.loads(b)  # raises if invalid
print('All JSON-LD valid')
"
```

## Acceptance checklist

- [ ] `GET /api/prerender/printer/:slug` returns 200 + HTML for known slugs
- [ ] Returns 404 for unknown slugs (not 200 with empty body)
- [ ] HTML includes `<title>`, `<meta description>`, `<link rel=canonical>`, og: tags
- [ ] BreadcrumbList JSON-LD is present and valid
- [ ] CollectionPage + ItemList JSON-LD includes all products with valid Offer data
- [ ] `<h1>` contains the printer's full name
- [ ] Products grouped by `source` (genuine / compatible) and listed as `<a>` links to `/products/{slug}/{sku}`
- [ ] All dynamic strings are HTML-escaped
- [ ] Empty-product case returns 200 with soft empty-state copy
- [ ] Verified via `curl -A "Googlebot/2.1" 'https://www.inkcartridges.co.nz/shop?printer=<slug>'` — `X-Prerendered: true` header is present and HTML body is rendered

Once deployed, no further FE work is needed — the Vercel middleware will pick it up immediately.

## FE-side work already shipped

In the FEINK repo (this is just FYI, not action needed for backend):

- `inkcartridges/middleware.js` now calls `/api/prerender/printer/${slug}` with the single `?printer=<slug>` shape (the only shape the FE actually emits).
- Old `?brand=X&printer_slug=Y` two-param shape was removed — it was never set by any FE code.
- `inkcartridges/vercel.json` redirect for `/printers/:slug` now points to `/shop?printer=:slug` so any external links / SEO-indexed URLs land on the strict printer-products route (not a search query).
