# SEO Frontend Fixes — InkCartridges.co.nz

Audit performed March 2026. Backend sitemap fix already deployed. All items below require frontend changes.

---

## Critical (Fix Immediately)

### [C2] www vs Non-www Canonical Inconsistency

All pages must use `https://www.inkcartridges.co.nz` (with www) in:
- `<link rel="canonical">` tags
- All JSON-LD `@id`, `url`, `item` fields

**Current inconsistency observed:**

| Page | Canonical Used |
|------|---------------|
| Homepage (`/html`) | `https://inkcartridges.co.nz/` ❌ |
| Shop (`/html/shop`) | `https://inkcartridges.co.nz/html/shop` ❌ |
| Product (`/html/product/?sku=HI61BXL`) | `https://www.inkcartridges.co.nz/html/product/?sku=HI61BXL` ✅ |
| Organization JSON-LD | `https://inkcartridges.co.nz` ❌ |
| WebSite JSON-LD | `https://inkcartridges.co.nz` ❌ |
| SearchAction target | `https://inkcartridges.co.nz/html/shop?q=` ❌ |

**Fix:** Search all JS/HTML files for `https://inkcartridges.co.nz` and replace with `https://www.inkcartridges.co.nz`.

Also update homepage JSON-LD:
```json
// Organization schema
"url": "https://www.inkcartridges.co.nz",
"telephone": "+64-27-474-0115",

// WebSite schema
"url": "https://www.inkcartridges.co.nz",
"potentialAction": {
  "@type": "SearchAction",
  "target": "https://www.inkcartridges.co.nz/html/shop?q={search_term_string}",
  "query-input": "required name=search_term_string"
}
```

---

### [C3] Homepage Served at `/html`, Not `/`

The root URL `https://www.inkcartridges.co.nz/` redirects to `/html`. Google sees the homepage at a subdirectory — this wastes PageRank that flows naturally to the root domain.

**Fix:**
- Configure Cloudflare Pages/Workers so the homepage serves at `/`
- 301-redirect `/html` and `/html/index` → `/`
- Update all internal "Home" nav links from `/html/index.html` → `/`
- Set homepage canonical to `https://www.inkcartridges.co.nz/`
- Update sitemap entry from `/html/index` → `/`

---

### [C4] Product Content is Fully Client-Side Rendered

On initial HTML load, Google's first-wave crawl sees:
- `<title>Product | InkCartridges.co.nz</title>` (generic — no product name)
- H1: empty
- Breadcrumbs: generic placeholders
- Product name, price, description: all empty

Printer model filter pages (`?printer_model=HP+DESKJET+3070`) never render products in a headless browser even after 4 seconds — they require interactive button presses.

**Short-term fix:** Set the page title immediately when the SKU is known from the URL param, before the API response:

```js
// New URL format: /products/:slug/:sku
const pathParts = window.location.pathname.split('/');
const sku = pathParts[pathParts.length - 1]; // last segment is always SKU
if (sku) {
  document.title = `${sku} Ink Cartridge | Buy NZ | InkCartridges.co.nz`;
  // Replace with full product name once API responds
}
```

**Long-term fix:** SSR or pre-rendered HTML for product pages so the title, H1, and description are in the initial HTML response.

---

### [C5] Broken BreadcrumbList JSON-LD on Product Pages

Current JSON-LD on product pages (e.g. `/html/product/?sku=HI61BXL`):
```json
{
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"position": 1, "name": "Home", "item": "https://inkcartridges.co.nz/"},
    {"position": 2, "name": "Shop", "item": "https://inkcartridges.co.nz/html/shop.html"},
    {"position": 3, "name": ""}
  ]
}
```

Issues:
- Position 3 has empty `name` — invalid schema, Google will ignore the entire breadcrumb
- Missing `@type: "ListItem"` on each item
- Uses non-www domain (see C2)
- Uses `.html` extension inconsistently

**Fix:**
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://www.inkcartridges.co.nz/"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Shop",
      "item": "https://www.inkcartridges.co.nz/html/shop"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "[Brand]",
      "item": "https://www.inkcartridges.co.nz/html/shop?brand=[brand]"
    },
    {
      "@type": "ListItem",
      "position": 4,
      "name": "[Category]",
      "item": "https://www.inkcartridges.co.nz/html/shop?brand=[brand]&category=[category]"
    },
    {
      "@type": "ListItem",
      "position": 5,
      "name": "[Product Name]"
    }
  ]
}
```

All values in `[]` should be populated dynamically from the product data once it loads.

---

### [C6] Organization Schema Has Wrong Phone Number

Homepage `Organization` JSON-LD:
```json
"telephone": "+64-800-465-275"  // ← wrong 0800 number, not shown anywhere on site
```

Site displays: `027 474 0115`

**Fix:**
```json
"telephone": "+64-27-474-0115"
```

---

## High Priority

### [W1] Shop Filter Pages Have No Unique Titles or Meta Descriptions

All filter combinations share the same title and meta description regardless of active filters.

**Fix:** Detect active URL params and set `document.title` and `<meta name="description">` dynamically:

```js
const params = new URLSearchParams(window.location.search);
const brand = params.get('brand');
const printerModel = params.get('printer_model');
const category = params.get('category');
const code = params.get('code');

if (printerModel) {
  const modelName = printerModel.replace(/\+/g, ' ');
  document.title = `${modelName} Ink Cartridges NZ | InkCartridges.co.nz`;
  document.querySelector('meta[name="description"]').content =
    `All compatible ink cartridges for the ${modelName}. Genuine and compatible options. Free NZ shipping over $100.`;
} else if (brand && !category && !code) {
  const brandName = brand.charAt(0).toUpperCase() + brand.slice(1);
  document.title = `${brandName} Ink Cartridges & Toner NZ | InkCartridges.co.nz`;
  document.querySelector('meta[name="description"]').content =
    `Shop genuine and compatible ${brandName} ink cartridges and toner NZ-wide. Fast delivery, free shipping over $100.`;
}

// Noindex deep filter combinations to avoid thin content
if (brand && category && code) {
  let robotsMeta = document.querySelector('meta[name="robots"]');
  if (!robotsMeta) {
    robotsMeta = document.createElement('meta');
    robotsMeta.name = 'robots';
    document.head.appendChild(robotsMeta);
  }
  robotsMeta.content = 'noindex, follow';
}
```

---

### [W2] No FAQPage Schema on Homepage

The homepage has a visible FAQ section but no `FAQPage` JSON-LD — missing Google rich snippet opportunity (FAQ dropdowns in SERPs).

**Fix:** Add to homepage `<head>`:

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What's the difference between genuine and compatible cartridges?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Genuine cartridges are made by the original printer manufacturer (HP, Canon, Epson) and are guaranteed to work perfectly with your printer. Compatible cartridges are third-party alternatives that fit the same printers at a lower price — typically 60-70% less. Both carry our quality guarantee."
      }
    },
    {
      "@type": "Question",
      "name": "How do I find the right cartridge for my printer?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use the printer model finder on our homepage — select your brand, series, and model. You'll see every compatible cartridge immediately."
      }
    },
    {
      "@type": "Question",
      "name": "How long does delivery take?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Most NZ orders are dispatched same day and arrive within 1-3 business days for North Island, 2-5 for South Island."
      }
    },
    {
      "@type": "Question",
      "name": "What is your returns policy?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "If a product doesn't perform as expected, contact us within 30 days and we'll replace it — no questions asked."
      }
    },
    {
      "@type": "Question",
      "name": "Will compatible cartridges void my printer warranty?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Under NZ Consumer Guarantees Act and international law, using compatible cartridges cannot void your printer warranty. Printer manufacturers cannot legally require you to use their own cartridges."
      }
    }
  ]
}
```

---

### [W3] Add `preconnect` for Product Image Domain

All product images are served from `https://www.ds.co.nz`. There is no preconnect hint, causing an extra DNS lookup on every product page load (Core Web Vitals impact).

**Fix:** Add to product page `<head>`:

```html
<link rel="preconnect" href="https://www.ds.co.nz">
<link rel="dns-prefetch" href="https://www.ds.co.nz">
```

---

### [W5] Verify SearchAction Target URL

Homepage WebSite JSON-LD has:
```json
"potentialAction": {
  "@type": "SearchAction",
  "target": "https://inkcartridges.co.nz/html/shop?q={search_term_string}"
}
```

**Action required:** Confirm whether navigating to `/html/shop?q=hp+61xl` actually returns filtered results. If the shop page does not handle the `?q=` param, either:
- Make the shop page read `?q=` on load and filter accordingly, or
- Remove the `SearchAction` block entirely

A non-functional SearchAction misleads Google and may result in a manual penalty.

---

### [W7] Homepage Title Tag Too Long

Current title (71 chars — Google truncates at ~60):
```
Ink Cartridges NZ | Find Your Printer Ink Fast — InkCartridges.co.nz
```

**Fix (63 chars):**
```
Ink Cartridges NZ — Genuine & Compatible | InkCartridges.co.nz
```

---

## Medium Priority

### [C7] Products Are 5 Clicks from Homepage

Google's crawl budget favours shallow pages. Every intermediate shop state (`?brand=hp`, `?brand=hp&category=ink`, etc.) is JS-interaction-only — not a linkable URL and not crawlable.

**Fix:** Add direct product links from the homepage or a static HTML product index page. At minimum, ensure the sitemap (already fixed on the backend) is submitted to Google Search Console so product pages are discovered directly.

**Longer term:** Create static brand landing pages (see New Pages section below).

---

## New Pages to Create

These pages don't exist and represent the highest-volume ranking opportunities:

| URL | Target Keyword | Priority |
|-----|---------------|----------|
| `/brands/hp` | "hp ink cartridges nz" | 🔴 High |
| `/brands/canon` | "canon ink cartridges nz" | 🔴 High |
| `/brands/epson` | "epson ink cartridges nz" | 🟠 Medium |
| `/brands/brother` | "brother toner nz" | 🟠 Medium |
| `/ink-cartridges` | "ink cartridges nz" | 🔴 High |
| `/toner-cartridges` | "toner cartridges nz" | 🟠 Medium |
| `/genuine-vs-compatible` | "genuine vs compatible ink nz" | 🟡 Low-Medium |

Each brand page should include:
- `<h1>HP Ink Cartridges NZ</h1>`
- 150-word intro about the brand's cartridges
- Category sub-navigation (Ink / Toner / Drums)
- Product grid pre-filtered for that brand (renders on load — no interaction required)
- Brand-specific FAQ section
- `BreadcrumbList` + `ItemList` JSON-LD

Once these pages exist, let the backend know and the sitemap will be updated to include them.

---

## Verification Checklist

After making changes, verify with:

1. **Canonicals** — `curl -s https://www.inkcartridges.co.nz/html/shop | grep canonical` — should show `www`
2. **JSON-LD validation** — paste any page URL into https://validator.schema.org
3. **Rich Results Test** — https://search.google.com/test/rich-results — check homepage (FAQ), product pages (BreadcrumbList, Product)
4. **Title length** — https://www.serpsimulator.com — verify homepage title is not truncated
5. **Google Search Console** — after deploy, submit sitemap and request recrawl of homepage
6. **BreadcrumbList errors** — GSC → Enhancements → Breadcrumbs
7. **FAQ rich snippets** — GSC → Enhancements → FAQ

---

## Keyword-Rich Product URLs (Backend Already Done — Frontend Routing Required)

The backend has been updated. All 3,790 products now have SEO slugs in the database. The sitemap already serves the new URL format. **Frontend needs to implement the routing.**

### New URL format
```
/products/{slug}/{SKU}
```
Example:
```
/products/genuine-hp-61xl-ink-cartridge-black-ch563wa/HI61BXL
```

### What the frontend needs to do

**1. Add route** — `/products/:slug/:sku` → render product page

The SKU is always the last path segment. To fetch the product, call the existing API:
```
GET /api/products/:sku
```
The response now includes a `slug` field. The slug in the URL is decorative (for SEO) — the SKU is the real identifier.

**2. Add 301 redirect** — old URLs must redirect permanently to new URLs:
```
/html/product/?sku=HI61BXL  →  /products/genuine-hp-61xl-ink-cartridge-black-ch563wa/HI61BXL
```

To get the slug for a given SKU, call `GET /api/products/HI61BXL` — the response includes `slug`. Build the redirect client-side on the old product page:
```js
// On /html/product/ page, if old ?sku= param detected:
const sku = new URLSearchParams(window.location.search).get('sku');
if (sku) {
  fetch(`/api/products/${sku}`)
    .then(r => r.json())
    .then(({ data }) => {
      if (data.slug) {
        window.location.replace(`/products/${data.slug}/${sku}`);
      }
    });
}
```

**3. Update all internal product links** — anywhere the frontend builds a link to a product page, use:
```js
// Instead of: /html/product/?sku=${product.sku}
// Use:        /products/${product.slug}/${product.sku}
```
The `slug` field is now returned on every product API response.

**4. Update canonical tag** on product pages:
```html
<link rel="canonical" href="https://www.inkcartridges.co.nz/products/{slug}/{SKU}">
```

**5. Update BreadcrumbList** — the `item` URL for the product breadcrumb should use the new URL format.

---

## Out of Scope for Frontend (Already Done or Requires Infrastructure)

- ✅ Sitemap SKU URLs — fixed on backend
- ✅ Keyword-rich slug URLs — backend done, slugs generated for all 3,790 products (see section above)
- 🏗️ Product image hosting on own domain — requires CDN/storage change
- 🏗️ robots.txt Cloudflare conflict — requires Cloudflare dashboard change (disable Managed Content Signals)
- 🏗️ Aggregate ratings on Product schema — requires a review system to be built first
