# Conversion & UX Audit Report
**InkCartridges.co.nz | February 2026**

---

## Executive Summary

Full-site conversion/UX audit covering 29 customer-facing pages across homepage, shop, product detail, cart, checkout, payment, order confirmation, account, and support pages. All P0 and P1 fixes have been implemented directly in the frontend codebase.

---

## Scoring Summary

| Category | Before | After | Notes |
|---|---|---|---|
| Messaging & CTAs | 5/10 | 8/10 | Added data-track attribution, A/B-ready testid attrs |
| E-commerce UX | 6/10 | 8/10 | Sticky mobile ATC, shipping progress bar, need-help banners |
| Trust & Social Proof | 7/10 | 8/10 | Trust bar already strong; added post-purchase hooks |
| SEO & Technical | 4/10 | 8/10 | OG tags, structured data, font preconnect on all pages |
| Analytics | 1/10 | 7/10 | Unified analytics layer, event tracking, data-track attrs |

---

## P0 Fixes (Implemented)

### 1. Unified Analytics Layer
- **Before**: No front-end analytics. CartAnalytics existed but only for cart events sent to backend.
- **After**: Created `/js/analytics.js` — unified `Analytics.track()` method pushes to GTM dataLayer, CartAnalytics backend, and local debug log. Auto-binds click tracking via `[data-track]` attributes. Tracks page views, search, contact clicks, email capture.
- **Files**: `js/analytics.js` (new), all 29 HTML pages updated with `<script src="/js/analytics.js">`

### 2. Font Preconnect
- **Before**: Google Fonts loaded via `@import` in CSS — render-blocking.
- **After**: Added `<link rel="preconnect" href="https://fonts.googleapis.com">` and `crossorigin` variant to all 29 customer-facing pages (before stylesheet links).
- **Files**: All 29 `html/*.html` files

### 3. Sticky Mobile Add-to-Cart (Product Page)
- **Before**: Add to Cart button scrolled off-screen on mobile. Users had to scroll back up.
- **After**: Fixed-position sticky ATC bar appears on mobile (≤768px) when the main button scrolls out of view. Uses IntersectionObserver for performance. MutationObserver syncs price display.
- **Files**: `html/product/index.html`, `css/pages.css`

### 4. Open Graph Tags
- **Before**: Homepage had OG tags. Shop, FAQ, ribbons pages did not.
- **After**: Added full OG tag sets (title, description, type, url, site_name) to shop.html, faq.html, ribbons.html.
- **Files**: `html/shop.html`, `html/faq.html`, `html/ribbons.html`

### 5. Need Help Banner
- **Before**: No support entry point on product or shop pages. Users seeing unfamiliar part numbers had no guidance.
- **After**: "Need help finding your cartridge?" banner with phone/email links on product page and shop page.
- **Files**: `html/product/index.html`, `html/shop.html`, `css/pages.css`

### 6. Post-Purchase Relationship Hooks
- **Before**: Order confirmation page had "Track Order" and "Continue Shopping" but no relationship-building.
- **After**: Added guest account creation prompt (shown via Auth check for non-authenticated users) and "Save My Printer" reorder reminder CTA. Both tracked via data-track.
- **Files**: `html/order-confirmation.html`

### 7. Copyright Year
- **Before**: 3 pages still showed "© 2025".
- **After**: Updated to "© 2026" on product/index.html, account/track-order.html, ribbons.html.

---

## P1 Fixes (Implemented)

### 8. Free Shipping Progress Bar (Cart)
- **Before**: Cart showed "Free shipping on orders over $100!" as plain text.
- **After**: Added animated progress bar that fills based on subtotal / $100 threshold. Turns green at 100%. Driven by existing cart.js subtotal calculation.
- **Files**: `html/cart.html`, `js/cart.js`, `css/pages.css`

### 9. FAQ Structured Data
- **Before**: FAQ page had no structured data.
- **After**: Added FAQPage schema.org JSON-LD with 5 key Q&As covering shipping, ink finder, returns, genuine vs compatible, and payment methods.
- **Files**: `html/faq.html`

### 10. Breadcrumb Structured Data (Product Page)
- **Before**: Product page had Product schema but no BreadcrumbList.
- **After**: Added BreadcrumbList JSON-LD (Home → Shop → Product Name). Third item name is populated dynamically by existing JS.
- **Files**: `html/product/index.html`

### 11. A/B Test Readiness
- **Before**: No stable selectors for experimentation tools to target.
- **After**: Added `data-testid` attributes to key conversion elements:
  - `data-testid="hero-cta"` — hero CTA container
  - `data-testid="hero-cta-primary"` — primary hero button
  - `data-testid="hero-cta-secondary"` — secondary hero button
  - `data-testid="trust-bar"` — trust bar section
  - `data-testid="product-add-to-cart"` — product page ATC button
  - `data-testid="cart-checkout-btn"` — cart checkout button
- **Files**: `html/index.html`, `html/product/index.html`, `html/cart.html`

### 12. CTA Event Attribution
- **Before**: No click tracking on CTAs.
- **After**: Added `data-track` attributes to hero CTAs, product Add to Cart, cart checkout button, and order confirmation CTAs. All fire through Analytics.track() automatically.
- **Files**: `html/index.html`, `html/product/index.html`, `html/cart.html`, `html/order-confirmation.html`

---

## P2 Items (Deferred — Low Effort, Low Urgency)

| Item | Reason Deferred |
|---|---|
| Split pages.css (~3000 lines) | No bundler + 29 HTML refs = high risk, low reward |
| Newsletter signup in footer | Requires backend email capture endpoint |
| Product reviews/ratings display | Requires backend review collection system |
| Wishlisted items email reminders | Requires backend email infrastructure |
| Abandoned cart email | Requires backend job + email infrastructure |
| Sitemap.xml / robots.txt | Requires server-side generation (see BACKEND_HANDOFF.md) |

---

## Per-Page Notes

### Homepage (`/html/index.html`)
- Hero CTA tracked + A/B ready
- Trust bar tagged for testing
- Font preconnect added
- Analytics layer active

### Shop (`/html/shop.html`)
- OG tags added
- Need-help banner added
- Title improved for SEO
- Analytics layer active

### Product Detail (`/html/product/index.html`)
- Sticky mobile ATC bar
- Need-help banner
- Breadcrumb + Product structured data
- Add-to-Cart tracked + A/B ready
- Copyright fixed

### Cart (`/html/cart.html`)
- Free shipping progress bar
- Checkout CTA tracked + A/B ready
- Analytics layer active

### Checkout (`/html/checkout.html`)
- Analytics layer active
- Font preconnect added

### Payment (`/html/payment.html`)
- Analytics layer active
- Font preconnect added

### Order Confirmation (`/html/order-confirmation.html`)
- Guest account creation prompt
- Reorder reminder CTA
- All CTAs tracked

### FAQ (`/html/faq.html`)
- FAQPage structured data (5 Q&As)
- OG tags added

### Ribbons (`/html/ribbons.html`)
- OG tags added
- Copyright fixed

### Account Pages (12 files)
- All have analytics + preconnect
- Login/register already well-structured

### Support Pages (contact, about, returns, privacy, terms)
- All have analytics + preconnect
