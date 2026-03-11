# Frontend QA Audit Handoff — inkcartridges.co.nz

**Date:** 2026-03-11
**Audit type:** Live site QA across desktop (1280x800) and mobile (375x812)
**Backend status:** Search API fix deployed (migration 019). All other backend fixes applied. These are frontend-only issues.

---

## Table of Contents

### High Priority
1. [H1: Cart Badge Flashes "0" on Page Navigation](#h1-cart-badge-flashes-0-on-page-navigation)
2. [H2: Broken Product Image — Color Swatch 404](#h2-broken-product-image--color-swatch-404)
3. [H3: Popular Printer Links Show Wrong/Unfiltered Products](#h3-popular-printer-links-show-wrongunfiltered-products)
4. [H4: Shipping Options API Error on Checkout](#h4-shipping-options-api-error-on-checkout)
5. [H5: "pages pages" Duplicate in Page Yield Display](#h5-pages-pages-duplicate-in-page-yield-display)

### Medium Priority
6. [M2: Ink Finder Grammar — "(1 models)" vs "(1 model)"](#m2-ink-finder-grammar--1-models-vs-1-model)
7. [M3: Duplicate Printer Models in Ink Finder](#m3-duplicate-printer-models-in-ink-finder)
8. [M4: Breadcrumb Order Incorrect on Product Page](#m4-breadcrumb-order-incorrect-on-product-page)
9. [M5: Payment Icons Inconsistent Across Pages](#m5-payment-icons-inconsistent-across-pages)
10. [M6: Mobile Header Icons Invisible (375px)](#m6-mobile-header-icons-invisible-375px)
11. [M7: Breadcrumb Says "Compatible" but Section Says "Genuine"](#m7-breadcrumb-says-compatible-but-section-says-genuine)

### Low Priority / Enhancements
12. [L1: No Related/Recommended Products on Product Page](#l1-no-relatedrecommended-products-on-product-page)
13. [L2: No Printer Compatibility List on Product Page](#l2-no-printer-compatibility-list-on-product-page)
14. [L3: Product Code Browsing is Cryptic](#l3-product-code-browsing-is-cryptic)
15. [L4: Large Blank Area Below Product Tabs](#l4-large-blank-area-below-product-tabs)
16. [L5: No Featured Products on Homepage](#l5-no-featured-products-on-homepage)

---

## High Priority

---

### H1: Cart Badge Flashes "0" on Page Navigation

**Severity:** HIGH
**Pages affected:** Site-wide header
**Symptom:** Cart badge shows "2" on homepage, "0" on shop page, "2" again on HP brand page, "0" on account page. The count flickers between correct and zero during navigation.

**Root cause:** The cart badge resets to `0` on each page load before the `/api/cart` response arrives. There is no local persistence of the cart count between navigations.

**How to fix:**

1. **Cache cart count in localStorage:**

```javascript
// On cart API success, persist count
function updateCartBadge(count) {
  localStorage.setItem('cart_count', count);
  document.querySelector('.cart-badge').textContent = count;
}

// On page load, show cached count immediately (before API call)
function initCartBadge() {
  const cached = localStorage.getItem('cart_count');
  if (cached && parseInt(cached) > 0) {
    document.querySelector('.cart-badge').textContent = cached;
  }
  // Then fetch fresh count from API
  fetchCartCount().then(updateCartBadge);
}
```

2. **On add-to-cart, update localStorage immediately** (don't wait for API):

```javascript
function addToCart(productId, quantity) {
  // Optimistically update badge
  const current = parseInt(localStorage.getItem('cart_count') || '0');
  updateCartBadge(current + quantity);

  // Then sync with API
  return fetch('/api/cart', { method: 'POST', ... })
    .then(res => res.json())
    .then(data => {
      // Use server count as source of truth
      updateCartBadge(data.data.total_items);
    });
}
```

3. **On logout/session clear, reset localStorage:**

```javascript
localStorage.removeItem('cart_count');
```

**How to verify:** Add item to cart, navigate to 5+ different pages. Badge should never flash "0".

---

### H2: Broken Product Image — Color Swatch 404

**Severity:** HIGH
**Pages affected:** Product pages for value packs with generated color swatch images
**Example URL:** `/html/shop?printer_model=HP%20ENVY%206020&printer_brand=hp`
**Symptom:** "HP 67 Ink Cartridge" (value pack) shows broken image with alt text. Console shows `404` for `hi67bct/color-swatch.png`.

**Root cause:** The color swatch composite image was not generated/uploaded for this product. The `image_url` in the database points to a non-existent file.

**How to fix:**

1. **Add an `onerror` fallback for product images:**

```html
<img
  src="{{ product.image_url }}"
  alt="{{ product.name }}"
  onerror="this.onerror=null; this.src='/images/placeholder-product.png';"
/>
```

2. **Or use a CSS-based fallback:**

```css
.product-image {
  background: #f5f5f5 url('/images/placeholder-product.png') center/contain no-repeat;
}
.product-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

This ensures broken images show a branded placeholder instead of alt text + broken icon.

**How to verify:** Search for value pack products. Any missing images should show the placeholder instead of broken image icon.

---

### H3: Popular Printer Links Show Wrong/Unfiltered Products

**Severity:** HIGH
**Pages affected:** Homepage → "Popular Printers" links → Shop page
**Example URL:** `/html/shop?printer_model=Brother+MFC-J6945DW&printer_brand=brother`
**Symptom:** Clicking "Brother MFC-J6945DW" on homepage shows ALL Brother products (100+ including labels, ribbons, drums) instead of only cartridges compatible with that specific printer.

**Root cause:** The Supabase `printer_models` lookup returns a 406 error. The frontend fallback query fetches all products for the brand instead of filtering by printer compatibility.

**How to fix:**

1. **Use the search API for printer model lookups instead of direct Supabase queries:**

```javascript
// Instead of querying printer_models directly:
// BAD: supabase.from('printer_models').select().eq('full_name', printerModel)

// Use the search-by-printer endpoint which handles fallbacks:
async function getProductsForPrinter(printerModel) {
  const res = await fetch(`/api/search/by-printer?q=${encodeURIComponent(printerModel)}&limit=100`);
  const data = await res.json();
  return data.data.products;
}
```

2. **If the printer_models lookup must be used, match with `.ilike()` instead of `.eq()`:**

```javascript
// More forgiving match
const { data: printers } = await supabase
  .from('printer_models')
  .select('id, full_name')
  .ilike('full_name', `%${printerModel}%`)
  .limit(5);
```

3. **When no compatible products are found, show a helpful message instead of all brand products:**

```html
<div class="no-results">
  <h3>No cartridges found for {{ printerModel }}</h3>
  <p>Try searching for your printer model or <a href="/html/shop">browse all products</a>.</p>
</div>
```

**How to verify:** Click each "Popular Printer" link on the homepage. Each should show only cartridges compatible with that specific printer model (typically 4-12 products, not 100+).

---

### H4: Shipping Options API Error on Checkout

**Severity:** HIGH
**Pages affected:** `/html/checkout`
**Symptom:** Console error: `Failed to load resource: /api/shipping/options` returns error. Checkout falls back to "North Island Shipping (est.) $7.00".

**Root cause:** The shipping options endpoint requires an address (region) to calculate correct rates. The frontend is calling it before the user enters their address.

**How to fix:**

1. **Don't call `/api/shipping/options` until the user has entered their region/city:**

```javascript
// Listen for address field changes
document.getElementById('region').addEventListener('change', async (e) => {
  const region = e.target.value;
  const city = document.getElementById('city').value;
  if (region) {
    const rates = await fetchShippingRates(region, city);
    updateShippingDisplay(rates);
  }
});
```

2. **Show "Enter your address for shipping quote" initially** instead of a hardcoded estimate:

```html
<div class="shipping-estimate" id="shipping-display">
  <span class="shipping-pending">Shipping calculated at next step</span>
</div>
```

3. **The API endpoint expects query params:**

```
GET /api/shipping/options?region=auckland&city=Auckland&weight=0.2
```

Required params: `region` (auckland / north_island / south_island), `weight` (kg from cart items).

**How to verify:** Open checkout with items in cart. Shipping should show "calculated at next step" until address is entered. After entering Auckland address, should show $7.00 urban / $14.00 rural.

---

### H5: "pages pages" Duplicate in Page Yield Display

**Severity:** HIGH
**Pages affected:** Product detail pages (Key Features and Description tabs)
**Example:** "Page yield: ~240 pages pages (5% coverage)"
**Symptom:** The word "pages" appears twice.

**Root cause:** The `page_yield` field in the API response already contains "pages" (e.g., `"240 pages"`), and the frontend template appends "pages" again.

**Backend fix applied:** The import scripts now strip "pages" from the stored value. After the next data import, `page_yield` will return clean values like `"240"` or `"~240 (5% coverage)"`.

**Frontend fix still needed** (defensive, in case old data persists):

```javascript
function formatPageYield(value) {
  if (!value) return null;
  // Strip "pages" if already present (defensive)
  const clean = String(value).replace(/\s*pages\b/gi, '').trim();
  if (!clean) return null;
  return `${clean} pages`;
}

// Usage in template:
// Before: `${product.page_yield} pages`
// After:  `${formatPageYield(product.page_yield)}`
```

**How to verify:** Check any product with a page yield value. Should show "~240 pages (5% coverage)" — single "pages", not double.

---

## Medium Priority

---

### M2: Ink Finder Grammar — "(1 models)" vs "(1 model)"

**Severity:** MEDIUM
**Pages affected:** Homepage ink finder — Series dropdown
**Symptom:** Dropdown shows "(1 models)" for singular counts. Should be "(1 model)".

**How to fix:**

```javascript
// When building the series dropdown options:
function formatModelCount(count) {
  return `(${count} ${count === 1 ? 'model' : 'models'})`;
}

// Before: `${series.name} (${series.model_count} models)`
// After:  `${series.name} ${formatModelCount(series.model_count)}`
```

**How to verify:** Find a printer series with exactly 1 model in the ink finder. The dropdown should say "(1 model)" not "(1 models)".

---

### M3: Duplicate Printer Models in Ink Finder

**Severity:** MEDIUM
**Pages affected:** Homepage ink finder — Model dropdown
**Symptom:** "ENVY 6020" and "ENVY 6020/6020E" listed as separate models. Customer won't know which to pick. Same issue likely affects other models with `/E` variants.

**How to fix:**

Option A — **Deduplicate in the frontend dropdown:**

```javascript
function deduplicateModels(models) {
  // Sort by name length descending so "ENVY 6020/6020E" is kept over "ENVY 6020"
  const sorted = [...models].sort((a, b) => b.name.length - a.name.length);
  const seen = new Set();
  return sorted.filter(model => {
    // Extract base model name (before any "/" variant)
    const base = model.name.split('/')[0].trim();
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}
```

Option B — **Merge at display time:**

```javascript
// Show the longer name (with variants) and hide the shorter one
// "ENVY 6020/6020E" covers "ENVY 6020", so only show the combined entry
```

**How to verify:** Select HP → ENVY Series in the ink finder. Each base model should appear only once.

---

### M4: Breadcrumb Order Incorrect on Product Page

**Severity:** MEDIUM
**Pages affected:** `/html/product/?sku=HI67BXL` and all product detail pages
**Symptom:** Breadcrumb shows `Home / Shop / Ink Cartridges / HP / 67XL / ...`
**Expected:** `Home / Shop / HP / Ink Cartridges / 67XL / ...` (brand before category)

**How to fix:**

```javascript
// Product page breadcrumb builder
function buildProductBreadcrumb(product) {
  return [
    { label: 'Home', url: '/' },
    { label: 'Shop', url: '/html/shop' },
    { label: product.brand.name, url: `/html/shop?brand=${product.brand.name.toLowerCase()}` },
    { label: getCategoryLabel(product.category), url: `/html/shop?brand=${product.brand.name.toLowerCase()}&category=${product.category}` },
    { label: product.model || product.sku, url: null } // Current page, no link
  ];
}
```

**How to verify:** Navigate to any product page. Breadcrumb should read: Home > Shop > [Brand] > [Category] > [Product].

---

### M5: Payment Icons Inconsistent Across Pages

**Severity:** MEDIUM
**Pages affected:** Site-wide footer, cart page, checkout page
**Symptom:** Cart and most pages show "Visa, PayPal". Checkout footer shows "Visa, Mastercard, PayPal".

**How to fix:**

If Mastercard is accepted (it is — Stripe supports it), show all three icons everywhere:

```html
<!-- Consistent payment icons component -->
<div class="payment-icons">
  <img src="/images/icons/visa.svg" alt="Visa" />
  <img src="/images/icons/mastercard.svg" alt="Mastercard" />
  <img src="/images/icons/paypal.svg" alt="PayPal" />
</div>
```

Use a single shared component/partial for payment icons across all pages (footer, cart, checkout, product page trust signals).

**How to verify:** Check footer on homepage, shop, cart, and checkout. All should show the same 3 payment icons.

---

### M6: Mobile Header Icons Invisible (375px)

**Severity:** MEDIUM
**Pages affected:** All pages at mobile viewport (375px and below)
**Symptom:** Account, Favourites, and Cart header links exist in the DOM but have no visible text or icons. Users cannot access cart or account from the mobile header.

**How to fix:**

Check the CSS for the header icon elements. Likely causes:

1. **Icons using a web font that isn't loading** — add fallback or use inline SVGs:

```html
<!-- Instead of icon font -->
<a href="/html/account" class="header-icon" aria-label="Account">
  <svg><!-- inline SVG icon --></svg>
</a>
```

2. **CSS `display: none` or `visibility: hidden` at mobile breakpoint** — check media queries:

```css
/* Find and fix the hiding rule */
@media (max-width: 768px) {
  .header-icons {
    display: flex; /* was: display: none */
    gap: 1rem;
  }
  .header-icons a {
    font-size: 0; /* REMOVE THIS if present - it hides text */
  }
  .header-icons svg,
  .header-icons .icon {
    width: 24px;
    height: 24px;
    display: block; /* Ensure icons are visible */
  }
}
```

3. **Text color matching background** — inspect computed styles:

```css
.header-icons a {
  color: #333; /* Ensure contrast against header background */
}
```

**How to verify:** Open site at 375px width (Chrome DevTools mobile mode). Account, Favourites, and Cart icons should be visible and tappable in the header.

---

### M7: Breadcrumb Says "Compatible" but Section Says "Genuine"

**Severity:** MEDIUM
**Pages affected:** `/html/shop?printer_model=HP%20ENVY%206020&printer_brand=hp`
**Symptom:** Breadcrumb shows "Compatible Products" as the current page label, but the first product section heading says "Genuine/Original Products for HP ENVY 6020". Contradictory messaging.

**How to fix:**

The breadcrumb should reflect the actual page state:

```javascript
// If showing products for a printer model, use the printer model as breadcrumb
function getPrinterFilterBreadcrumb(printerModel, brand) {
  return [
    { label: 'Home', url: '/' },
    { label: 'Shop', url: '/html/shop' },
    { label: brand, url: `/html/shop?brand=${brand.toLowerCase()}` },
    { label: printerModel, url: null } // "HP ENVY 6020" instead of "Compatible Products"
  ];
}
```

**How to verify:** Use ink finder to select a printer model. Breadcrumb should show the printer model name, not "Compatible Products".

---

## Low Priority / Enhancements

---

### L1: No Related/Recommended Products on Product Page

**Pages affected:** All product detail pages
**Opportunity:** When viewing genuine HP 67XL ($58.99), show compatible alternative ($8-10). Or show matching tri-colour cartridge alongside black.

**API endpoint available:**

```
GET /api/search/by-printer?q=HP+ENVY+6020&limit=20
```

Returns all cartridges for a printer. Filter out the current product and display as "You may also need" or "Compatible alternatives".

**Suggested implementation:**

```html
<section class="related-products">
  <h3>You May Also Need</h3>
  <div class="product-grid">
    <!-- Show 4 products: compatible alternative + matching colors -->
  </div>
</section>
```

**Business value:** High cross-sell and upsell potential. Show compatible versions alongside genuine products.

---

### L2: No Printer Compatibility List on Product Page

**Pages affected:** All product detail pages
**Opportunity:** Show "Works with: HP ENVY 6020, HP DeskJet 2720..." directly on the product page so customers can verify compatibility before purchasing.

**API endpoint available:**

```
GET /api/search/compatible-printers/{sku}
```

Returns all compatible printer models for a given product SKU.

**Suggested implementation:**

```html
<section class="compatible-printers">
  <h3>Compatible Printers</h3>
  <ul class="printer-list">
    <li><a href="/html/shop?printer_model=HP+ENVY+6020&printer_brand=hp">HP ENVY 6020</a></li>
    <li><a href="/html/shop?printer_model=HP+DeskJet+2720&printer_brand=hp">HP DeskJet 2720</a></li>
    <!-- ... -->
  </ul>
</section>
```

Place this in the product page tabs (e.g., a "Compatibility" tab) or below the main product info.

---

### L3: Product Code Browsing is Cryptic

**Pages affected:** `/html/shop?brand=hp&category=ink` and similar category pages
**Symptom:** Shows 100+ product codes (C8721WA, CN045AA, etc.) that most customers won't recognize. No search/filter within the page.

**How to fix:**

1. **Show human-readable names alongside codes:**

```html
<!-- Instead of just "67XL" -->
<a href="...">67XL — HP 67 XL High Yield Black</a>
```

2. **Add a quick filter input at the top of the code list:**

```html
<input
  type="text"
  placeholder="Filter product codes..."
  oninput="filterCodes(this.value)"
/>
```

```javascript
function filterCodes(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('.product-code-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(q) ? '' : 'none';
  });
}
```

---

### L4: Large Blank Area Below Product Tabs

**Pages affected:** `/html/product/?sku=HI67BXL` and all product detail pages
**Symptom:** Description/Specifications/FAQs tab area has extensive whitespace below the content.

**How to fix:**

```css
/* Remove fixed height on tab content area */
.product-tabs-content {
  min-height: auto; /* was likely a fixed height like 400px or 500px */
  padding-bottom: 2rem;
}
```

Check if there's a `min-height` or `height` set on the tab content container that's creating the empty space.

---

### L5: No Featured Products on Homepage

**Pages affected:** Homepage
**Symptom:** Below the ink finder and trust signals, there are no product recommendations. Customers who don't know their printer model have no browsing entry point beyond "Shop All".

**Suggested implementation:**

```html
<section class="featured-products">
  <h2>Popular Products</h2>
  <div class="product-grid">
    <!-- Show 4-8 best-selling or featured products -->
  </div>
  <a href="/html/shop" class="btn btn-outline">View All Products</a>
</section>
```

**API options:**

- Curate a static list of popular SKUs and fetch via `/api/products?skus=HI67BXL,HI67BCL,...`
- Or use search: `/api/search/smart?q=ink+cartridge&limit=8` for a dynamic selection

---

## API Reference (Quick Summary)

| Endpoint | Method | Description | Used by |
|----------|--------|-------------|---------|
| `/api/cart` | GET | Get cart items + total | H1 (badge count) |
| `/api/cart` | POST | Add item to cart | H1 (optimistic update) |
| `/api/search/by-printer?q=...` | GET | Products for a printer model | H3, L1 |
| `/api/search/smart?q=...&limit=48` | GET | Fuzzy product search | Search page |
| `/api/search/autocomplete?q=...` | GET | Search suggestions | Search box |
| `/api/search/compatible-printers/:sku` | GET | Printers compatible with a product | L2 |
| `/api/shipping/options?region=...&weight=...` | GET | Shipping rates for region | H4 |
| `/api/products/:sku` | GET | Single product detail | Product page |

---

## Testing Checklist

After implementing fixes, verify:

- [ ] **H1:** Add item to cart → navigate through 5+ pages → badge never shows "0"
- [ ] **H2:** Find a value pack product with missing image → shows placeholder, not broken icon
- [ ] **H3:** Click each "Popular Printer" link on homepage → shows only compatible products (4-12, not 100+)
- [ ] **H4:** Open checkout → no console 500 error → shipping shows "calculated at next step" until address entered
- [ ] **H5:** Open any product with page yield → shows "240 pages" not "240 pages pages"
- [ ] **M2:** Ink finder → find series with 1 model → shows "(1 model)" not "(1 models)"
- [ ] **M3:** Ink finder → HP → ENVY Series → no duplicate model entries
- [ ] **M4:** Product page breadcrumb → brand appears before category
- [ ] **M5:** Check footer on homepage, cart, checkout → same payment icons everywhere
- [ ] **M6:** Resize to 375px → Account, Favourites, Cart icons visible and tappable in header
- [ ] **M7:** Filter by printer model → breadcrumb matches section headings
- [ ] **Mobile:** Full purchase flow at 375px width (homepage → find cartridges → add to cart → checkout)
- [ ] **Desktop:** Full purchase flow at 1280px (search → product page → add to cart → checkout)
- [ ] **Console:** No 404 or 500 errors during normal navigation flow
