# Frontend SEO Implementation Tasks
**Prepared:** March 14, 2026 | **Backend:** All API changes already live

The backend has been updated to support everything below. This document covers every frontend SEO task needed to reach top-3 Google rankings for NZ printer ink searches. Work through sections in order — Critical items first.

---

## CRITICAL

### C1 — Fix www/non-www Canonical Inconsistency

**Problem:** Some pages set canonical to `https://inkcartridges.co.nz` (no www), others use `https://www.inkcartridges.co.nz` (with www). Google treats these as separate domains and splits PageRank between them.

**Fix:** Every single page must use `https://www.inkcartridges.co.nz` (with www) in its canonical tag. No exceptions.

```html
<link rel="canonical" href="https://www.inkcartridges.co.nz/html/shop" />
```

Also verify that `https://inkcartridges.co.nz` (no www) 301 redirects to `https://www.inkcartridges.co.nz` at the DNS/CDN level (Cloudflare).

---

### C2 — Canonical Tags on All Filtered Shop URLs

**Problem:** `/html/shop?brand=hp&category=ink&source=genuine` creates thousands of near-duplicate URLs. Without canonicals, Google may index each filter combination separately, splitting PageRank and wasting crawl budget.

**Fix:** On every shop/search page that has query parameters, set the canonical to the base URL without params:

```html
<!-- On /html/shop?brand=hp&category=ink&source=genuine -->
<link rel="canonical" href="https://www.inkcartridges.co.nz/html/shop" />

<!-- Exception: if you build dedicated brand pages (/brands/hp/),
     canonical on /html/shop?brand=hp should point there instead -->
<link rel="canonical" href="https://www.inkcartridges.co.nz/brands/hp" />
```

Rule: canonical always points to the cleanest, most authoritative version of that content.

---

### C3 — Product Schema (JSON-LD) on Every Product Page

**Why it matters:** Enables star ratings and price display directly in Google search results. Without this, product pages are invisible to Google Shopping rich results.

**API endpoint:** `GET /api/products/:sku`

The response now includes `review_count` and `average_rating` fields. Use these to populate the schema.

**Full schema to render in `<head>` on every product page:**

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "{{ product.name }}",
  "sku": "{{ product.sku }}",
  "brand": {
    "@type": "Brand",
    "name": "{{ product.brand.name }}"
  },
  "image": ["{{ product.image_url }}"],
  "description": "{{ product.name }}. Compatible with {{ compatible_printers | join(', ') }}.",
  "offers": {
    "@type": "Offer",
    "price": "{{ product.retail_price }}",
    "priceCurrency": "NZD",
    "availability": "{{ product.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' }}",
    "url": "https://www.inkcartridges.co.nz/products/{{ product.slug }}/{{ product.sku }}",
    "seller": {
      "@type": "Organization",
      "name": "InkCartridges.co.nz"
    },
    "shippingDetails": {
      "@type": "OfferShippingDetails",
      "shippingRate": {
        "@type": "MonetaryAmount",
        "value": "7.00",
        "currency": "NZD"
      },
      "deliveryTime": {
        "@type": "ShippingDeliveryTime",
        "businessDays": {
          "@type": "QuantitativeValue",
          "minValue": 1,
          "maxValue": 3
        }
      }
    }
  }{{ product.review_count > 0 ? ',' : '' }}
  {{ product.review_count > 0 ? `"aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "${product.average_rating}",
    "reviewCount": "${product.review_count}",
    "bestRating": "5",
    "worstRating": "1"
  }` : '' }}
}
</script>
```

**Notes:**
- Only include `aggregateRating` when `review_count > 0` — Google penalises products with `"reviewCount": "0"`
- `retail_price` from the API is already GST-inclusive NZD — use it directly
- `compatible_printers` is an array in the API response — use it to build the description

---

### C4 — Canonical Tag on Product Pages

Every product page must canonical to the slug URL, not the legacy query-param URL:

```html
<link rel="canonical" href="https://www.inkcartridges.co.nz/products/{{ product.slug }}/{{ product.sku }}" />
```

This ensures any residual PageRank from old `/html/product/?sku=X` links flows to the new URL.

---

## HIGH

### H1 — FAQPage Schema on Homepage

**Why it matters:** FAQ schema causes Google to expand your search result to show Q&A directly in the SERP — dramatically increases click-through rate and occupies more visual real estate.

Copy the exact FAQ content from the homepage FAQ section into this schema:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Are compatible ink cartridges as good as genuine?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Our compatible cartridges are manufactured to ISO standards and produce the same print quality as genuine cartridges at a fraction of the cost. They are fully guaranteed."
      }
    },
    {
      "@type": "Question",
      "name": "Will using compatible cartridges void my printer warranty?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. Under consumer protection laws in New Zealand, printer manufacturers cannot void your warranty simply because you use compatible or third-party ink cartridges."
      }
    },
    {
      "@type": "Question",
      "name": "How fast is delivery?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "We deliver NZ-wide. Auckland orders typically arrive next business day. Rest of North Island and South Island usually take 1–3 business days."
      }
    },
    {
      "@type": "Question",
      "name": "What if my cartridge doesn't work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "We offer a full satisfaction guarantee. If your cartridge is faulty or not compatible, contact us and we will replace it or refund you — no questions asked."
      }
    },
    {
      "@type": "Question",
      "name": "Do you have a minimum order?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No minimum order. Free shipping on orders over $100. A flat shipping rate applies to smaller orders."
      }
    }
  ]
}
</script>
```

**Important:** Keep the `text` values in sync with whatever the visible FAQ actually says on the page. Google checks for consistency.

---

### H2 — LocalBusiness Schema on Contact Page

Triggers Google Knowledge Panel and Maps integration for branded searches:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "InkCartridges.co.nz",
  "url": "https://www.inkcartridges.co.nz",
  "telephone": "+64-800-465-275",
  "email": "support@inkcartridges.co.nz",
  "address": {
    "@type": "PostalAddress",
    "addressCountry": "NZ",
    "addressLocality": "Auckland",
    "addressRegion": "Auckland"
  },
  "openingHoursSpecification": {
    "@type": "OpeningHoursSpecification",
    "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
    "opens": "08:00",
    "closes": "20:00"
  },
  "priceRange": "$$",
  "description": "NZ-owned online store for genuine and compatible ink cartridges and toner. Fast NZ-wide delivery."
}
</script>
```

Update phone, email, and hours to match what's shown on the contact page.

---

### H3 — Brand Landing Pages (`/brands/:slug/`)

**Why it matters:** "HP ink cartridges NZ" gets 1,000+ searches/month. Currently this query lands on a filtered shop URL with no unique content. A dedicated brand page with copy will rank far better.

**New route to create:** `/brands/:slug/`

**API calls needed:**
```
GET /api/brands                          → get all brands (for nav/listing)
GET /api/products?brand={slug}&limit=48  → products for this brand
```

**Page structure:**

```html
<head>
  <title>{{ brand.name }} Ink Cartridges NZ | InkCartridges.co.nz</title>
  <meta name="description" content="Buy genuine and compatible {{ brand.name }} ink cartridges in NZ. All models in stock. Fast NZ-wide delivery." />
  <link rel="canonical" href="https://www.inkcartridges.co.nz/brands/{{ brand.slug }}" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "{{ brand.name }} Ink Cartridges NZ",
    "description": "Genuine and compatible {{ brand.name }} ink cartridges available for NZ delivery.",
    "url": "https://www.inkcartridges.co.nz/brands/{{ brand.slug }}",
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" },
        { "@type": "ListItem", "position": 2, "name": "{{ brand.name }} Ink Cartridges" }
      ]
    }
  }
  </script>
</head>

<body>
  <nav aria-label="Breadcrumb">
    <a href="/">Home</a> › {{ brand.name }} Ink Cartridges
  </nav>

  <h1>{{ brand.name }} Ink Cartridges NZ</h1>

  <p>
    Shop genuine and compatible {{ brand.name }} ink cartridges for fast NZ-wide delivery.
    All popular {{ brand.name }} models in stock, including [list top 3–5 product names].
  </p>

  <!-- Product grid -->
  <!-- Pagination -->
</body>
```

**Priority brand pages to build first** (highest search volume):
1. `/brands/hp/` — "HP ink cartridges NZ"
2. `/brands/canon/` — "Canon ink cartridges NZ"
3. `/brands/epson/` — "Epson ink cartridges NZ"
4. `/brands/brother/` — "Brother ink cartridges NZ"

---

### H4 — Printer Model Landing Pages (`/printers/:slug/`)

**Why it matters:** "HP DeskJet 2710 ink" and similar printer-model queries are extremely high purchase intent. The backend already has the data — this is purely a frontend template.

**New route to create:** `/printers/:slug/`

**API call:**
```
GET /api/products/printer/:printerSlug
```

Response shape:
```json
{
  "printer": {
    "model_name": "DeskJet 2710",
    "full_name": "HP DeskJet 2710",
    "slug": "hp-deskjet-2710",
    "brand": { "name": "HP", "slug": "hp" }
  },
  "products": [ ...compatible cartridges... ]
}
```

**Page structure:**

```html
<head>
  <title>HP DeskJet 2710 Ink Cartridges NZ | InkCartridges.co.nz</title>
  <meta name="description" content="Find the right ink cartridges for your HP DeskJet 2710. Genuine HP and compatible options. Fast NZ delivery." />
  <link rel="canonical" href="https://www.inkcartridges.co.nz/printers/hp-deskjet-2710" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "HP DeskJet 2710 Ink Cartridges NZ",
    "url": "https://www.inkcartridges.co.nz/printers/hp-deskjet-2710",
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" },
        { "@type": "ListItem", "position": 2, "name": "HP Ink Cartridges", "item": "https://www.inkcartridges.co.nz/brands/hp" },
        { "@type": "ListItem", "position": 3, "name": "HP DeskJet 2710 Ink Cartridges" }
      ]
    }
  }
  </script>
</head>

<body>
  <nav aria-label="Breadcrumb">
    <a href="/">Home</a> ›
    <a href="/brands/hp">HP Ink Cartridges</a> ›
    HP DeskJet 2710 Ink Cartridges
  </nav>

  <h1>HP DeskJet 2710 Ink Cartridges NZ</h1>

  <p>
    Find genuine HP and compatible ink cartridges for your HP DeskJet 2710.
    All cartridges ship fast NZ-wide. Fully guaranteed.
  </p>

  <!-- Product grid showing compatible cartridges -->
  <!-- "Also works with" section listing related printer models -->
</body>
```

**Note:** The sitemap already includes all `/printers/{slug}` URLs. These pages need to exist before Google crawls the new sitemap, otherwise Google will log 404s for all ~500 printer pages. **Build this route before the next sitemap cache refresh (1 hour after deploy)**, or temporarily remove printer pages from the sitemap until the route is live.

Same warning applies to `/brands/{slug}/` pages.

---

### H5 — BreadcrumbList JSON-LD on All Non-Homepage Pages

HTML breadcrumbs exist but there's no JSON-LD — Google can't reliably parse HTML breadcrumbs. Add JSON-LD to every page that has breadcrumbs.

**Shop page:**
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" },
    { "@type": "ListItem", "position": 2, "name": "Shop" }
  ]
}
```

**Product page:**
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" },
    { "@type": "ListItem", "position": 2, "name": "{{ brand.name }} Ink Cartridges", "item": "https://www.inkcartridges.co.nz/brands/{{ brand.slug }}" },
    { "@type": "ListItem", "position": 3, "name": "{{ product.name }}" }
  ]
}
```

---

### H6 — Related Products Section on Product Pages

**API endpoint (new):** `GET /api/products/:sku/related`

Returns up to 12 products compatible with the same printers, same brand. Use this to render a "You might also need" or "Also compatible with your printer" section.

Response shape:
```json
{
  "success": true,
  "data": {
    "related": [
      {
        "sku": "HC046BK",
        "slug": "compatible-canon-046-black",
        "name": "Compatible Canon 046 Black Toner Cartridge",
        "retail_price": 34.99,
        "color": "Black",
        "image_url": "https://...",
        "stock_quantity": 100,
        "brand": { "name": "Canon", "slug": "canon" },
        "in_stock": true
      }
    ]
  }
}
```

This also creates internal links from every product page to other products — a strong SEO signal.

---

## MEDIUM

### M1 — Homepage H1 Keyword Optimisation

**Current H1:** "Never Buy the Wrong Ink Again. Delivered Fast NZ-Wide."
This is conversion-focused but has zero keyword signal.

**Recommended H1:**
```html
<h1>Ink Cartridges NZ — Genuine &amp; Compatible, Delivered Fast</h1>
```

Keep the existing conversion subheading as an `<h2>` or `<p>` tag below it.

---

### M2 — Fix Footer Heading Tags

Footer headings ("Support", "Contact", "Company") are marked up as `<h3>` which dilutes the heading hierarchy on every single page.

**Fix:** Change footer headings from `<h3>` to styled `<div>` or `<p>` elements:

```html
<!-- Before -->
<h3>Support</h3>

<!-- After -->
<p class="footer-heading">Support</p>
<!-- or -->
<div class="footer-heading" role="heading" aria-level="6">Support</div>
```

---

### M3 — Meta Title Length

All page titles should be 50–60 characters. Anything longer is truncated in SERPs.

| Page | Current | Recommended |
|------|---------|-------------|
| Homepage | "Ink Cartridges NZ \| Find Your Printer Ink Fast — InkCartridges.co.nz" (73 chars) | "Ink Cartridges NZ \| Genuine & Compatible Printer Ink" (53 chars) |
| Contact | "Contact Us \| InkCartridges.co.nz" (33 chars) | "Contact Us \| InkCartridges.co.nz NZ" or add more context |
| Brand pages | — | "{{ brand }} Ink Cartridges NZ \| InkCartridges.co.nz" |
| Printer pages | — | "{{ printer.full_name }} Ink Cartridges NZ \| InkCartridges.co.nz" |
| Product pages | — | "{{ product.name }} NZ \| InkCartridges.co.nz" |

Product page titles: dynamically generate from product name. Keep under 60 chars; truncate product name if needed.

---

### M4 — Product Page H1 Format

Product page H1 should be keyword-rich:

```
{{ Brand }} {{ Model Number }} {{ Color }} Ink Cartridge NZ
```

Examples:
- "HP 67XL Black Ink Cartridge NZ"
- "Canon PG-645XL Black Ink Cartridge NZ"
- "Compatible Epson 220XL Cyan Ink Cartridge NZ"

The word "NZ" at the end captures local search intent. "Compatible" prefix for compatible-source products improves relevance matching.

---

### M5 — Product Page: Show Compatible Printers as Links

The `GET /api/products/:sku` response includes `compatible_printers` — an array of printer models. Render these as links to the printer model pages:

```html
<section>
  <h2>Compatible Printers</h2>
  <ul>
    <li><a href="/printers/hp-deskjet-2710">HP DeskJet 2710</a></li>
    <li><a href="/printers/hp-deskjet-2720">HP DeskJet 2720</a></li>
    <li><a href="/printers/hp-envy-6020">HP ENVY 6020</a></li>
  </ul>
</section>
```

This creates an internal link graph between product pages and printer pages — one of the strongest SEO signals available. Build this only after the `/printers/:slug/` pages exist so the links resolve.

---

## VERIFICATION CHECKLIST

After implementing, run these checks before considering the work done:

- [ ] **Google Rich Results Test** — paste a product page URL into https://search.google.com/test/rich-results — should detect `Product` schema with `Offer` and optionally `AggregateRating`
- [ ] **Google Rich Results Test** — paste homepage URL — should detect `FAQPage` schema
- [ ] **View Source** on homepage — canonical tag should use `https://www.inkcartridges.co.nz` (with www)
- [ ] **View Source** on `/html/shop?brand=hp` — canonical should point to `/html/shop` or `/brands/hp`
- [ ] **Curl sitemap** — `curl https://www.inkcartridges.co.nz/sitemap.xml | grep brands` — should return brand page entries
- [ ] **Visit** `/brands/hp/` and `/printers/hp-deskjet-2710/` — should return 200, not 404
- [ ] **Google Search Console** → URL Inspection → test a product page → confirm structured data is detected
- [ ] **Ahrefs / Screaming Frog** — crawl for duplicate canonicals (all should be www, none should have query params)

---

## API REFERENCE SUMMARY

All endpoints are live on the backend:

| Endpoint | Used for |
|----------|----------|
| `GET /api/products/:sku` | Product page — includes `review_count`, `average_rating` |
| `GET /api/products/:sku/related` | Related products widget on product pages |
| `GET /api/products/printer/:printerSlug` | Printer landing page — returns printer + compatible products |
| `GET /api/brands` | Brand listing + brand page slugs |
| `GET /api/products?brand=hp&limit=48` | Brand landing page product grid |
| `GET /api/products/printer/:slug` | Printer landing page product grid |
