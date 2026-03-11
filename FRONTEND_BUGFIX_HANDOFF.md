# Frontend Bug Fix Handoff — inkcartridges.co.nz

**Date:** 2026-03-11
**Priority:** CRITICAL — Site is not ready for paid traffic until these are fixed
**Backend API:** All endpoints are healthy and returning correct data. These are all frontend rendering/JS issues.

---

## Table of Contents

1. [C1: `will-animate` Sections Invisible (opacity: 0)](#c1-will-animate-sections-invisible-opacity-0)
2. [C2: Search Results Page Shows No Products](#c2-search-results-page-shows-no-products)
3. [C3: Ribbons Listing Pages Empty](#c3-ribbons-listing-pages-empty)
4. [C4: Printer Model Filter Shows Empty Page](#c4-printer-model-filter-shows-empty-page)
5. [C5: Product Code Filter Ignored on Shop Page](#c5-product-code-filter-ignored-on-shop-page)
6. [C6: Product Images Show Black/Broken for Compatible Products](#c6-product-images-show-blackbroken-for-compatible-products)
7. [C7: Cart Page Shows Empty on First Navigation](#c7-cart-page-shows-empty-on-first-navigation)
8. [C8: Cart Badge Resets to 0 on Page Navigation](#c8-cart-badge-resets-to-0-on-page-navigation)
9. [C9: Checkout Order Summary Initially Shows $0.00](#c9-checkout-order-summary-initially-shows-000)
10. [H1: Search Overlay Blocks All Page Interactions](#h1-search-overlay-blocks-all-page-interactions)
11. [H2: Checkout Shipping API Error](#h2-checkout-shipping-api-error)
12. [H3: Raw Vercel 404 Page — No Branded Error Page](#h3-raw-vercel-404-page--no-branded-error-page)
13. [H4: Shipping Claim Mismatch on Homepage](#h4-shipping-claim-mismatch-on-homepage)
14. [M1: No "No Results Found" Message on Empty Pages](#m1-no-no-results-found-message-on-empty-pages)
15. [M2: Product Page Shows "Loading..." Briefly with $0.00 Price](#m2-product-page-shows-loading-briefly-with-000-price)
16. [M3: Related Products / Compatible Printers Not Rendering](#m3-related-products--compatible-printers-not-rendering)
17. [M4: Product Names Truncated with No Tooltip](#m4-product-names-truncated-with-no-tooltip)
18. [M5: Checkout Footer Shows © 2025](#m5-checkout-footer-shows--2025)
19. [M6: "+" Text Artifacts Near Product Tabs](#m6--text-artifacts-near-product-tabs)
20. [M7: Mastercard Missing from Payment Badges](#m7-mastercard-missing-from-payment-badges)
21. [CRO: Too Many Clicks to Reach a Product](#cro-too-many-clicks-to-reach-a-product)

---

## C1: `will-animate` Sections Invisible (opacity: 0)

**Severity:** CRITICAL
**Pages Affected:** Homepage, Product detail pages, possibly others
**Root Cause:** CSS class `will-animate` sets `opacity: 0` as initial state. A JavaScript scroll-triggered animation (likely IntersectionObserver) is supposed to add a class that transitions opacity to 1, but the observer is never initializing or never firing.

### What's Hidden

| Page | Section | Expected Content |
|------|---------|-----------------|
| Homepage | "Why Shop With Us" | 5 trust cards: Quality Guaranteed, Free Shipping Over $100, Human Support, Price Match, Secure Checkout |
| Homepage | "Frequently Asked Questions" | 5 FAQ accordions about genuine vs compatible, finding cartridges, delivery, returns, warranty |
| Product page | `section.product-tabs` | Tabs containing Description (product details, features, what's included), Specifications (brand, type, color table), FAQs (installation help, compatible vs genuine, returns) |

### How to Verify

Open browser DevTools on the homepage, scroll down past the ink finder. You'll see a large blank gap. In the Elements panel, find the section with class `will-animate` — it has `opacity: 0` in computed styles.

### How to Fix

**Option A — Fix the IntersectionObserver (recommended):**

Find the JavaScript file that sets up scroll animations. It likely looks something like:

```js
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('animated'); // or 'visible', 'in-view', etc.
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.will-animate').forEach(el => observer.observe(el));
```

The problem is likely one of:
- The script runs before DOM is ready (wrap in `DOMContentLoaded` or move to end of body)
- The observer is selecting the wrong class name
- The CSS transition class doesn't set `opacity: 1`
- The script file isn't being loaded at all on some pages

Check that:
1. The observer script is loaded on ALL pages (homepage, product pages)
2. It runs after DOM is ready
3. The CSS has a rule like `.will-animate.animated { opacity: 1; transition: opacity 0.5s; }`

**Option B — Remove animations entirely (quick fix):**

If you want to just make content visible immediately, add this CSS:

```css
.will-animate {
  opacity: 1 !important;
}
```

Or remove the `will-animate` class from all affected elements in the HTML.

### Verification

After fix, these should be visible without scrolling:
- Homepage: scroll past ink finder → "Why Shop With Us" section with 5 cards visible
- Homepage: scroll further → FAQ accordions visible
- Product page: scroll past "Key Features" → Description/Specifications/FAQs tabs visible with content

---

## C2: Search Results Page Shows No Products

**Severity:** CRITICAL
**URL Pattern:** `/html/shop?search=Brother%20toner` (any search query via URL)
**What Happens:** Page loads with only the breadcrumb "Shop" and help banner. No product grid, no results, no loading state.
**Expected:** Product cards matching the search query

### Backend API (Works Correctly)

The search API returns results:

```bash
# This works — returns products
curl "https://ink-backend-zaeq.onrender.com/api/search/smart?q=Brother+toner&limit=10"
# Returns: { ok: true, data: { results: [...], total: N } }
```

The shop endpoint also supports search:
```bash
curl "https://ink-backend-zaeq.onrender.com/api/shop?brand=brother&search=toner&limit=20"
```

### How to Debug

1. Open `/html/shop?search=Brother%20toner` in the browser
2. Open Network tab — check if the frontend makes ANY API call to `/api/search/*` or `/api/shop?search=*`
3. If no API call is made: the frontend JS that reads the `search` URL parameter and triggers a product fetch is broken
4. If an API call IS made but returns data: the rendering logic for search results is broken

### Likely Root Cause

The shop page JS probably only handles the `brand` parameter (which works — clicking brand tiles triggers product loading). The `search` parameter from the URL is likely never read/processed. The search autocomplete dropdown works because it uses a different code path (inline JS on the search component).

### How to Fix

In the shop page JavaScript:

```js
// On page load, check for search param
const urlParams = new URLSearchParams(window.location.search);
const searchQuery = urlParams.get('search');

if (searchQuery) {
  // Fetch search results
  const res = await fetch(`${API_BASE}/api/search/smart?q=${encodeURIComponent(searchQuery)}&limit=50`);
  const data = await res.json();

  if (data.ok) {
    // Render product cards from data.data.results
    renderProductGrid(data.data.results);
    // Update page heading to show "Search results for "Brother toner""
    updateHeading(`Search results for "${searchQuery}"`);
  }
}
```

Alternatively, use the `/api/shop` endpoint with the search param:
```js
const res = await fetch(`${API_BASE}/api/shop?brand=${brand}&search=${searchQuery}&limit=50`);
```

Note: `/api/shop` requires a `brand` parameter. If searching across all brands, use `/api/search/smart` instead.

### Verification

1. Navigate to `/html/shop?search=HP+ink` → should show HP ink products
2. Navigate to `/html/shop?search=Brother+toner` → should show Brother toner products
3. Type in search bar, press Enter or click "View all X results" → should navigate to results page and show products

---

## C3: Ribbons Listing Pages Empty

**Severity:** CRITICAL
**URL Patterns:**
- `/html/ribbons` — main ribbons page
- `/html/ribbons?brand=Epson` — brand-filtered ribbons

**What Happens:** Pages load empty — just breadcrumb "Ribbons" and help banner. No product grid.

### Backend API (Works Correctly)

```bash
# Returns ribbon products
curl "https://ink-backend-zaeq.onrender.com/api/ribbons?limit=20"
# Returns: { ok: true, data: [...], meta: { total: N } }

# Brand-filtered ribbons
curl "https://ink-backend-zaeq.onrender.com/api/ribbons?brand=Epson&limit=20"

# Available ribbon brands
curl "https://ink-backend-zaeq.onrender.com/api/ribbons/brands"
```

### How to Fix

The ribbons page JS needs to:

1. On page load, call `GET /api/ribbons?limit=20&page=1`
2. If `brand` URL param exists, include it: `GET /api/ribbons?brand=Epson&limit=20`
3. Render product cards from the response
4. If no results, show "No ribbons found" message
5. Implement pagination using `meta.total` and `meta.page` from the response

```js
const urlParams = new URLSearchParams(window.location.search);
const brand = urlParams.get('brand');
const page = urlParams.get('page') || 1;

let url = `${API_BASE}/api/ribbons?page=${page}&limit=20`;
if (brand) url += `&brand=${encodeURIComponent(brand)}`;

const res = await fetch(url, { credentials: 'include' });
const data = await res.json();

if (data.ok && data.data.length > 0) {
  renderProductGrid(data.data);
  renderPagination(data.meta);
} else {
  showEmptyState('No ribbons found for this brand.');
}
```

### Verification

1. `/html/ribbons` → shows all ribbon products with pagination
2. `/html/ribbons?brand=Epson` → shows only Epson ribbons
3. Clicking ribbon brands from the Shop page → navigates to filtered ribbon page with products

---

## C4: Printer Model Filter Shows Empty Page

**Severity:** CRITICAL
**URL Pattern:** `/html/shop?printer_model=HP+ENVY+6020&printer_brand=hp`
**What Happens:** Page loads empty. The `printer_model` and `printer_brand` URL params are ignored.

### Where This Is Triggered

- Homepage "Popular Printers" quick links (e.g., "HP ENVY 6020", "Brother MFC-J6945DW")
- Homepage ink finder "Find Cartridges" button (after selecting brand > series > model)

### Backend APIs for Printer Compatibility

```bash
# Step 1: Search for the printer model to get its ID
curl "https://ink-backend-zaeq.onrender.com/api/printers/search?q=HP+ENVY+6020&brand=hp"
# Returns printer models with IDs

# Step 2: Get compatible products for that printer
curl "https://ink-backend-zaeq.onrender.com/api/products/printer/{printer_slug}"
# Returns products compatible with the printer
```

Or use search:
```bash
curl "https://ink-backend-zaeq.onrender.com/api/search/by-printer?q=HP+ENVY+6020"
```

### How to Fix

The shop page JS must handle the `printer_model` and `printer_brand` params:

```js
const printerModel = urlParams.get('printer_model');
const printerBrand = urlParams.get('printer_brand');

if (printerModel) {
  // Search for the printer to get its slug/ID
  const searchRes = await fetch(
    `${API_BASE}/api/printers/search?q=${encodeURIComponent(printerModel)}&brand=${printerBrand || ''}`
  );
  const searchData = await searchRes.json();

  if (searchData.ok && searchData.data.length > 0) {
    const printer = searchData.data[0];
    // Fetch compatible products
    const productsRes = await fetch(`${API_BASE}/api/products/printer/${printer.slug}`);
    const productsData = await productsRes.json();

    if (productsData.ok) {
      updateHeading(`Cartridges for ${printerModel}`);
      renderProductGrid(productsData.data.products);
    }
  } else {
    showEmptyState(`No cartridges found for ${printerModel}. Contact us for help.`);
  }
}
```

### Verification

1. Click "HP ENVY 6020" link on homepage → shows compatible cartridges
2. Use ink finder: select HP > ENVY series > ENVY 6020 > "Find Cartridges" → shows products
3. Click "Brother MFC-J6945DW" on homepage → shows compatible cartridges

---

## C5: Product Code Filter Ignored on Shop Page

**Severity:** CRITICAL
**URL Pattern:** `/html/shop?brand=hp&category=ink&code=965XL`
**What Happens:** Clicking a product code (e.g., "965XL — 7 products") navigates to the URL with `code=965XL`, but the page shows ALL HP compatible ink products instead of just 965XL products.

### Backend API (Supports Code Filter)

```bash
# This correctly filters by code
curl "https://ink-backend-zaeq.onrender.com/api/shop?brand=hp&category=ink&code=965XL&limit=20"
```

The `code` param is supported by `/api/shop`. The frontend just isn't passing it.

### How to Fix

In the shop page JS that fetches products, ensure the `code` URL parameter is included:

```js
const code = urlParams.get('code');
let apiUrl = `${API_BASE}/api/shop?brand=${brand}&limit=20&page=${page}`;
if (category) apiUrl += `&category=${encodeURIComponent(category)}`;
if (code) apiUrl += `&code=${encodeURIComponent(code)}`; // ADD THIS LINE
```

### Verification

1. Navigate to Shop > HP > Ink Cartridges > 965XL → should show only 965XL products (7 items)
2. The breadcrumb shows "965XL" correctly — the page heading should match

---

## C6: Product Images Show Black/Broken for Compatible Products

**Severity:** CRITICAL
**Pages Affected:** Product listing grid, product detail pages, cart, checkout

### Root Cause

The backend returns `image_url: null` for ALL compatible products (source: `compatible`). Genuine products DO have image URLs (pointing to `https://www.ds.co.nz/assets/full/{SKU}.jpg`).

When `image_url` is `null` or `""`, the frontend renders a black rectangle.

### How to Fix

**Frontend: Add a placeholder/fallback image**

```js
function getProductImage(product) {
  if (product.image_url) {
    return product.image_url;
  }
  // Return a placeholder based on product type or category
  return '/images/placeholder-cartridge.png';
  // Or use a color-coded placeholder:
  // if (product.color === 'Black') return '/images/placeholder-black.png';
  // if (product.color === 'Cyan') return '/images/placeholder-cyan.png';
  // etc.
}
```

For the `<img>` tag, add `onerror` fallback:

```html
<img
  src="${product.image_url || '/images/placeholder-cartridge.png'}"
  alt="${product.name}"
  onerror="this.src='/images/placeholder-cartridge.png'"
/>
```

**You'll need to create placeholder images:**
- A generic cartridge silhouette/icon image for products without photos
- Consider different placeholders for ink vs toner vs ribbon

**Note:** The backend team will also work on populating `image_url` for compatible products (see backend fixes), but the frontend MUST have a fallback regardless, because some products may always lack images.

### Verification

1. Browse product listing → all products show either a real image or a clean placeholder
2. Product detail page → shows placeholder if no image
3. Cart → shows placeholder thumbnail
4. No black rectangles anywhere

---

## C7: Cart Page Shows Empty on First Navigation

**Severity:** CRITICAL
**URL:** `/html/cart`
**What Happens:** After adding an item on a product page, navigating to `/html/cart` shows "Your cart is empty" with 0 items. Refreshing the page (F5) then shows the correct cart with items.

### Root Cause

Race condition. The cart page renders the empty state BEFORE reading cart data from localStorage (`inkcartridges_cart` key) or before the `/api/cart` response arrives.

The data IS in localStorage — confirmed:
```js
localStorage.getItem('inkcartridges_cart')
// Returns: [{"id":"...","name":"Compatible HP 02...","price":10.79,"quantity":1,...}]
```

### How to Fix

**Option A — Show loading state first (recommended):**

```js
// Instead of rendering empty cart immediately, show a loading skeleton
function initCart() {
  showCartLoading(); // Show spinner or skeleton, NOT "empty cart"

  const localCart = JSON.parse(localStorage.getItem('inkcartridges_cart') || '[]');

  if (localCart.length > 0) {
    renderCartItems(localCart); // Render from localStorage immediately
  }

  // Then fetch fresh data from API
  fetch(`${API_BASE}/api/cart`, { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (data.ok && data.data.items?.length > 0) {
        renderCartItems(data.data.items); // Update with server data
      } else if (localCart.length === 0) {
        showEmptyCart(); // Only show empty if localStorage is ALSO empty
      }
    });
}
```

**Option B — Wait for data before rendering:**

```js
async function initCart() {
  showCartLoading();

  // Read from localStorage first (instant)
  const localCart = JSON.parse(localStorage.getItem('inkcartridges_cart') || '[]');

  // Use localStorage data if available
  if (localCart.length > 0) {
    renderCartItems(localCart);
    return;
  }

  // Fallback to API
  const data = await fetchCart();
  if (data.items.length === 0) {
    showEmptyCart();
  } else {
    renderCartItems(data.items);
  }
}
```

The key insight: **never show "empty cart" until you've checked localStorage AND the API**.

### Verification

1. Add item on product page → click Cart link → cart shows item immediately (no flash of empty state)
2. Add item → navigate to a different page → click Cart → cart shows item
3. Close browser → reopen → cart page shows items from localStorage

---

## C8: Cart Badge Resets to 0 on Page Navigation

**Severity:** CRITICAL
**Location:** Header cart icon/badge (site-wide)
**What Happens:** The cart count in the header shows "0" when a new page loads, even if items are in the cart. It sometimes corrects after a moment, but on many pages it stays at 0.

### Root Cause

Same race condition as C7. The header cart badge is initialized to "0" and waits for an API call or event to update. On page navigation, the new page's JS starts from scratch and hasn't yet read cart data.

### How to Fix

Read cart count from localStorage on page load, before any API calls:

```js
// In the header/nav JS that runs on every page:
document.addEventListener('DOMContentLoaded', () => {
  // Immediately set badge from localStorage
  const localCart = JSON.parse(localStorage.getItem('inkcartridges_cart') || '[]');
  const totalItems = localCart.reduce((sum, item) => sum + (item.quantity || 0), 0);
  updateCartBadge(totalItems); // Set badge immediately, don't wait for API

  // Then optionally verify with API in background
  fetch(`${API_BASE}/api/cart/count`, { credentials: 'include' })
    .then(res => res.json())
    .then(data => {
      if (data.ok) {
        updateCartBadge(data.data.count);
      }
    })
    .catch(() => {}); // Silently fail — localStorage count is good enough
});
```

### Verification

1. Add items → navigate to any page → badge shows correct count immediately
2. Never see "0" badge when items are in localStorage

---

## C9: Checkout Order Summary Initially Shows $0.00

**Severity:** CRITICAL
**URL:** `/html/checkout`
**What Happens:** The order summary sidebar shows "Subtotal: $0.00" and "Estimated Total: $0.00 NZD" when the page first loads. The item list is empty. After a moment (or reload), it populates correctly.

### Root Cause

Same pattern as C7/C8. The checkout reads cart data asynchronously but renders the summary before data arrives.

### How to Fix

Same approach as C7. Read from `localStorage` (`inkcartridges_cart`) immediately on page load:

```js
function initCheckoutSummary() {
  const localCart = JSON.parse(localStorage.getItem('inkcartridges_cart') || '[]');

  if (localCart.length > 0) {
    // Calculate totals from localStorage data
    const subtotal = localCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    renderOrderSummary(localCart, subtotal);
  }

  // Then verify/refresh with API
  // ...
}
```

### Verification

1. Add items → proceed to checkout → order summary shows items and correct total immediately
2. No flash of $0.00

---

## H1: Search Overlay Blocks All Page Interactions

**Severity:** HIGH
**Location:** Site-wide — happens on any page after using the search bar
**What Happens:** After clicking the search input, the nav element gets a `search-active` class. After the search dropdown closes (pressing Escape or clicking a result), the `search-active` class is NOT removed. This class causes the nav to intercept ALL pointer events on the page, making buttons, links, and the entire page unclickable.

### Error from Playwright

```
<nav aria-label="Main navigation" class="primary-nav search-active">
  ...intercepts pointer events
```

### How to Fix

Find where the `search-active` class is added and ensure it's removed properly:

```js
// When search input loses focus or search dropdown closes:
const nav = document.querySelector('.primary-nav');

// Remove on Escape key
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    nav.classList.remove('search-active');
    closeSearchDropdown();
  }
});

// Remove when clicking outside search area
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-form, .search-dropdown')) {
    nav.classList.remove('search-active');
    closeSearchDropdown();
  }
});

// Remove when a search result is clicked
searchDropdown.addEventListener('click', () => {
  nav.classList.remove('search-active');
});

// Remove on blur
searchInput.addEventListener('blur', () => {
  setTimeout(() => {
    nav.classList.remove('search-active');
  }, 200); // Small delay to allow click on dropdown items
});
```

Also check the CSS for `.search-active` — it likely has something like:

```css
.primary-nav.search-active {
  /* This may be using a large z-index or pointer-events that blocks the page */
  position: relative;
  z-index: 9999;
}
```

Consider whether this is necessary or if the z-index can be scoped to just the search dropdown.

### Verification

1. Click search input → type something → press Escape → click "Add to Cart" → button works
2. Click search input → type → click a search result → navigate to product → all buttons work
3. Click search input → click anywhere else on page → page is interactive

---

## H2: Checkout Shipping API Error

**Severity:** HIGH
**URL:** `/html/checkout`
**Console Error:** `Failed to load resource: the server responded with a status of ... /api/shipping/options`

### Backend API Spec

The `POST /api/shipping/options` endpoint requires:

```json
{
  "cart_total": 45.99,
  "items": [{ "product_id": "uuid-here", "quantity": 2 }],
  "postal_code": "1010",
  "delivery_type": "urban"
}
```

**Important:**
- `product_id` must be a valid UUID (from the product's `id` field), NOT the SKU string
- `cart_total` is the numeric subtotal
- `postal_code` is a string
- `delivery_type` is `"urban"` or `"rural"`

### Likely Issue

The checkout may be:
1. Calling the endpoint before the user has entered a postal code (missing required fields)
2. Passing SKU instead of UUID for `product_id`
3. Not including `credentials: 'include'`

### How to Fix

Only call `/api/shipping/options` after the user has entered their postal code and selected Urban/Rural:

```js
async function fetchShippingOptions() {
  const postalCode = document.getElementById('postcode').value;
  const deliveryType = document.querySelector('input[name="delivery_type"]:checked')?.value;

  if (!postalCode || !deliveryType) return; // Don't call yet

  const cartItems = getCartItems(); // From localStorage or cart API
  const cartTotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const res = await fetch(`${API_BASE}/api/shipping/options`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cart_total: cartTotal,
      items: cartItems.map(item => ({
        product_id: item.id,  // Must be UUID, not SKU
        quantity: item.quantity
      })),
      postal_code: postalCode,
      delivery_type: deliveryType
    })
  });

  const data = await res.json();
  if (data.ok) {
    updateShippingSummary(data.data);
  }
}
```

### Verification

1. Go to checkout → enter postal code + select Urban → shipping rate appears without console errors
2. No API call made before user enters address details

---

## H3: Raw Vercel 404 Page — No Branded Error Page

**Severity:** HIGH
**URL:** Any invalid path, e.g., `/html/nonexistent-page`
**What Happens:** Shows raw Vercel error: "404: NOT_FOUND", "Code: NOT_FOUND", "ID: syd1::...", with a link to Vercel docs. No site branding, no navigation, no way back.

### How to Fix

Create a custom `404.html` (or `404.tsx` in Next.js) in your app:

**If using Next.js App Router:** Create `app/not-found.tsx`
**If using Next.js Pages Router:** Create `pages/404.tsx`
**If static HTML on Vercel:** Create `404.html` in the public/output directory

The page should include:
- Site header with navigation
- "Page Not Found" message
- Search bar (help them find what they're looking for)
- "Go to Homepage" button
- "Browse All Products" button
- Contact info

```html
<!-- Example 404.html -->
<h1>Page Not Found</h1>
<p>Sorry, the page you're looking for doesn't exist or has been moved.</p>
<div>
  <a href="/html/index.html">Go to Homepage</a>
  <a href="/html/shop.html">Browse Products</a>
</div>
<p>Need help? Call <a href="tel:0274740115">027 474 0115</a></p>
```

### Verification

Navigate to `/html/some-random-page` → branded 404 page with navigation and links back to site

---

## H4: Shipping Claim Mismatch on Homepage

**Severity:** HIGH
**Location:** Homepage "Why Shop With Us" section (currently hidden by C1, but will be visible after fix)
**Issue:** The section states:

> "Spend $100 or more and we cover the delivery. **Flat $5 shipping on all other orders NZ-wide.**"

**Actual shipping rates from the backend:**
- Auckland Urban: **$7.00**
- Auckland Rural: $14.00
- North Island Urban (light <0.5kg): $7.00
- North Island Urban (standard): $12.00
- South Island Urban (light): $7.00
- South Island Urban (standard): $12.00
- South Island Urban (heavy >2kg): $22.00

**There is no $5 flat rate.** The cheapest option is $7.00.

### How to Fix

Update the copy to match actual pricing:

```
"Spend $100 or more and we cover the delivery. Flat-rate shipping from $7 on all other orders."
```

Or simply:
```
"Free shipping on orders over $100. Fast, flat-rate NZ delivery."
```

### Verification

Check the "Why Shop With Us" section text matches actual shipping rates from `/api/shipping/rates`

---

## M1: No "No Results Found" Message on Empty Pages

**Severity:** MEDIUM
**Pages Affected:** Search results, ribbons listing, printer model filter — all empty listing pages

When a page has no products to show, it displays nothing — just the breadcrumb and help banner. There should be a clear message.

### How to Fix

Add an empty state component that shows when a product fetch returns 0 results:

```html
<div class="empty-state">
  <img src="/images/empty-search.svg" alt="" />
  <h2>No products found</h2>
  <p>We couldn't find any products matching your search. Try a different search term or browse by brand.</p>
  <a href="/html/shop.html" class="btn btn--primary">Browse All Products</a>
  <p class="empty-state__help">
    Need help? Call <a href="tel:0274740115">027 474 0115</a> or
    <a href="mailto:inkandtoner@windowslive.com">email us</a>
  </p>
</div>
```

### Verification

1. Search for "asdfghjkl" → shows "No products found" message
2. Filter by a ribbon brand with no products → shows message
3. Empty state has clear CTAs to browse or contact support

---

## M2: Product Page Shows "Loading..." Briefly with $0.00 Price

**Severity:** MEDIUM
**URL:** Any product page, e.g., `/html/product/?sku=IHP02B`
**What Happens:** For 1-3 seconds after page load, shows "Loading..." as the title, "SKU: Loading..." and "$0.00" as the price. Then content loads.

### How to Fix

Use a skeleton loading state instead of showing fake data:

```js
// Instead of:
<h1>Loading...</h1>
<p>SKU: Loading...</p>
<div class="price">$0.00</div>

// Show a skeleton:
<h1 class="skeleton-text" style="width: 60%">&nbsp;</h1>
<p class="skeleton-text" style="width: 30%">&nbsp;</p>
<div class="skeleton-text" style="width: 20%">&nbsp;</div>
```

```css
.skeleton-text {
  background: linear-gradient(90deg, #eee 25%, #ddd 50%, #eee 75%);
  background-size: 200% 100%;
  animation: skeleton-pulse 1.5s infinite;
  border-radius: 4px;
  color: transparent;
}
@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### Verification

1. Navigate to product page → see animated skeleton placeholders (not "Loading..." text or "$0.00")
2. After 1-2s, content loads and replaces skeletons

---

## M3: Related Products / Compatible Printers Not Rendering

**Severity:** MEDIUM
**Location:** Product detail page

The API calls are being made:
- `GET /api/search/compatible-printers/IHP02B` → returns compatible printers
- `GET /api/products?limit=10&brand=hp&search=02` → returns related products

But neither section is visible on the page. Likely another `will-animate` victim or the rendering JS isn't populating these sections.

### How to Fix

1. First fix C1 (`will-animate`) — the sections may become visible
2. If still not visible, check the JS that handles the API response for these sections
3. Ensure the "Compatible Printers" and "Related Products" sections are rendered into the correct DOM containers

### Verification

1. Product page shows "Compatible Printers" section listing printer models
2. Product page shows "You May Also Like" or "Related Products" section with clickable product cards

---

## M4: Product Names Truncated with No Tooltip

**Severity:** MEDIUM
**Location:** Product listing grid cards

Product names like "Compatible HP 02 (C8721WA Ink Cartridge..." are truncated without any way to see the full name.

### How to Fix

Add a `title` attribute for tooltip, or allow wrapping:

```html
<h3 class="product-card__title" title="${product.name}">
  ${product.name}
</h3>
```

Or allow 2-3 lines of wrapping with CSS:

```css
.product-card__title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.4;
}
```

---

## M5: Checkout Footer Shows © 2025

**Severity:** LOW
**Location:** `/html/checkout` footer
**Fix:** Change `© 2025` to `© 2026` in the checkout page template. Other pages correctly show 2026.

---

## M6: "+" Text Artifacts Near Product Tabs

**Severity:** LOW
**Location:** Product detail page, near the Description/Specs/FAQs tabs
**What Happens:** Literal "+" characters are visible as text artifacts at the bottom of the tab panel. Likely leftover from a template or accordion toggle icon.

### How to Fix

Search the product page HTML/template for literal `+` characters near the tab section and remove them.

---

## M7: Mastercard Missing from Payment Badges

**Severity:** LOW
**Location:** Footer "We accept" section, checkout payment badges
**Fix:** Add Mastercard logo/badge alongside Visa and PayPal. If Stripe is the payment processor, it accepts Mastercard, Amex, etc.

---

## CRO: Too Many Clicks to Reach a Product

**Severity:** MEDIUM (Conversion Rate Optimization)
**Current flow:** Shop → Brand (click 1) → Category (click 2) → Product Code (click 3) → Product (click 4)
**Recommended:** Shop → Brand (click 1) → Products with filters (click 2)

### Suggestion

After selecting a brand + category, show the product grid directly instead of an intermediate "Select a Product Code" screen. Add the product code as a filter/facet in the sidebar instead:

```
[Brand: HP] [Category: Ink Cartridges] [Code: All ▼] [Color: All ▼] [Source: All ▼]

Product Grid:
  [HP 965XL Black] [HP 965XL Cyan] [HP 965XL Magenta] ...
```

This reduces the flow to 2 clicks (brand → see products).

---

## Quick Reference: Backend API Endpoints Used by Frontend

| Frontend Feature | Backend Endpoint | Notes |
|---|---|---|
| Product listing by brand | `GET /api/shop?brand=hp&category=ink&limit=20` | `category` accepts: `ink`, `toner`, `laser` |
| Product listing by code | `GET /api/shop?brand=hp&category=ink&code=965XL` | |
| Search results | `GET /api/search/smart?q=...&limit=50` | Cross-brand search |
| Search autocomplete | `GET /api/search/autocomplete?q=...&limit=5` | |
| Single product | `GET /api/products/:sku` | |
| Compatible printers | `GET /api/search/compatible-printers/:sku` | |
| Related products | `GET /api/products?limit=10&brand=hp&search=02` | |
| Ribbons listing | `GET /api/ribbons?page=1&limit=20&brand=Epson` | |
| Ribbon brands | `GET /api/ribbons/brands` | |
| Printer search | `GET /api/printers/search?q=...&brand=hp` | For ink finder |
| Products by printer | `GET /api/products/printer/:slug` | |
| Cart | `GET /api/cart` | Always include `credentials: 'include'` |
| Cart count | `GET /api/cart/count` | |
| Cart add | `POST /api/cart/items` body: `{ product_id, quantity }` | |
| Shipping options | `POST /api/shipping/options` | Requires UUID `product_id`, not SKU |
| Shipping rates | `GET /api/shipping/rates` | For display purposes |

---

## Summary Checklist

- [ ] C1: Fix `will-animate` opacity — make hidden sections visible
- [ ] C2: Render search results on `/html/shop?search=*`
- [ ] C3: Render ribbon products on `/html/ribbons*`
- [ ] C4: Handle `printer_model` param → fetch compatible products
- [ ] C5: Pass `code` param to `/api/shop` endpoint
- [ ] C6: Add placeholder images for products with null `image_url`
- [ ] C7: Read localStorage before showing empty cart
- [ ] C8: Set cart badge from localStorage on page load
- [ ] C9: Set checkout summary from localStorage on page load
- [ ] H1: Remove `search-active` class on blur/escape/click-outside
- [ ] H2: Fix shipping API call — send correct body format, call only after form input
- [ ] H3: Create custom branded 404 page
- [ ] H4: Update shipping copy to match $7 actual rate (not $5)
- [ ] M1: Add "No results found" empty state
- [ ] M2: Replace "Loading..." with skeleton loaders
- [ ] M3: Verify Related Products / Compatible Printers render after C1 fix
- [ ] M4: Add title tooltip or multi-line wrapping to product names
- [ ] M5: Fix © 2025 → 2026 in checkout footer
- [ ] M6: Remove "+" text artifacts from product tabs
- [ ] M7: Add Mastercard to payment badges
