# CLAUDE.md - InkCartridges.co.nz Frontend

## Project Overview
E-commerce frontend for InkCartridges.co.nz - a NZ-based printer ink/toner retailer.

## Tech Stack
- **Frontend**: Vanilla JavaScript (ES6+), HTML5, CSS3 (no framework)
- **Auth**: Supabase Auth (supabase-js v2)
- **Payments**: Stripe (publishable key only, test mode)
- **Backend**: External API at https://ink-backend-zaeq.onrender.com (separate repo)
- **Dev Server**: `npx serve inkcartridges -l 3000`
- **No build tools**: No bundler, no TypeScript, no transpilation

## Key Conventions
- Global objects: `Config`, `API`, `Auth`, `Security`, `Cart`, `Products`, `Favourites`, `Filters`, `AdminAuth`
- XSS prevention: Always use `Security.escapeHtml()` / `Security.escapeAttr()` for dynamic content
- Color utilities: Use `ProductColors` from `utils.js` (not Cart.colorMap)
- Currency: NZD, locale en-NZ, use `formatPrice()` from api.js
- Pricing rule: Frontend never computes prices - all totals from backend

## File Structure
```
inkcartridges/
  index.html              # Auth redirect handler
  html/                   # All page HTML files (42 files)
    index.html            # Homepage
    shop.html             # Shop page with DrilldownNav
    cart.html             # Shopping cart
    checkout.html         # Checkout flow
    payment.html          # Stripe payment
    ribbons.html          # Thermal ribbons landing
    contact.html          # Contact form
    order-confirmation.html
    about.html, faq.html, privacy.html, terms.html, returns.html, 404.html
    business.html, business/apply.html
    account/              # User account pages (13 files)
      index.html, login.html, forgot-password.html, reset-password.html,
      verify-email.html, orders.html, order-detail.html, track-order.html,
      favourites.html, addresses.html, settings.html, personal-details.html,
      printers.html
    admin/                # Admin dashboard pages (12 files)
      index.html, products.html, product-edit.html, orders.html,
      customers.html, customer-intelligence.html, settings.html,
      reports.html, sales.html, financial-health.html, operations.html,
      marketing.html
    product/              # Product detail page
      index.html
  js/                     # JavaScript (83 files)
    config.js             # API URLs, Supabase/Stripe keys
    utils.js              # $, $$, on, getStorage, setStorage, ProductColors, debounce
    security.js           # escapeHtml, escapeAttr, sanitizeUrl, safeRedirect
    main.js               # Nav, search, dropdowns, toasts, smooth scroll
    api.js                # API wrapper + formatPrice, getStockStatus, getSourceBadge
    auth.js               # Supabase Auth wrapper
    cart.js               # Shopping cart (hybrid server + localStorage)
    products.js           # Product card rendering
    filters.js            # Product filtering (sidebar layout pages)
    account.js            # Account pages logic (legacy)
    favourites.js         # Wishlist
    cart-analytics.js     # Cart event tracking
    modern-effects.js     # Scroll animations, ripple, image loading
    search.js             # Search overlay
    search-normalize.js   # Search query normalization
    mega-nav.js           # Mega navigation menu
    landing.js            # Homepage landing logic
    gtag.js               # Google Analytics
    shipping.js           # Shipping calculator
    auth-redirect.js      # Auth callback handler
    # Page controllers (one per HTML page)
    shop-page.js, cart-page.js, checkout-page.js, checkout-compact.js,
    payment-page.js, product-detail-page.js, ribbons-page.js,
    contact-page.js, order-confirmation-page.js, login-page.js,
    account-page.js, account-settings-page.js, favourites-page.js,
    order-detail-page.js, track-order-page.js, forgot-password-page.js,
    reset-password-page.js, verify-email-page.js, business-apply-page.js
    # Admin (legacy top-level)
    admin.js, admin-auth.js, admin-dashboard.js, admin-nav.js,
    admin-product-edit.js, admin-theme-init.js, admin-stub-redirect.js,
    admin-command-palette.js, dashboard-filters.js, analytics.js,
    analytics-api.js, products-page.js, orders-page.js, customers-page.js
    admin/                # Admin v2 modules
      app.js              # Admin app shell
      api.js              # Admin API client
      auth.js             # Admin auth module
      filters.js          # Admin filters
      settings-page.js    # Admin settings
      customer-intelligence-page.js, marketing-page.js,
      operations-page.js, sales-page.js, financial-health-page.js
      components/         # Reusable admin components
        charts.js, drawer.js, modal.js, table.js, toast.js
      pages/              # Admin page modules
        analytics.js, contact-emails.js, customers.js, dashboard.js,
        fulfillment.js, lab.js, orders.js, product-review.js,
        products.js, refunds.js, ribbons.js, settings.js,
        shipping.js, suppliers.js
    ink-finder.js         # Printer-to-ink finder tool
    printer-data.js       # Printer series/model data
  css/                    # Stylesheets (8 files)
    base.css              # Reset, variables, typography
    layout.css            # Grid, header, footer
    components.css        # Reusable UI components
    pages.css             # Page-specific styles (very large)
    admin.css             # Admin dashboard styles
    modern-effects.css    # Animations and effects
    search.css            # Search overlay styles
    checkout-compact.css  # Compact checkout styles
  assets/                 # Images, brand logos, icons
```

## Script Load Order (per HTML pages)
1. Supabase SDK (CDN)
2. security.js (must be first local script)
3. config.js
4. utils.js
5. api.js
6. auth.js
7. main.js
8. Page-specific scripts

## Known Issues
- Newsletter subscribe endpoint (`POST /api/newsletter/subscribe`) returns 500 — backend issue, frontend handles gracefully
- Backend returns `product.brand` as object `{ id, name }` not string — use `getBrandName()` helper
- Some admin analytics endpoints not yet implemented on backend

## Rules
- Never compute prices on frontend - backend is source of truth
- Always escape dynamic HTML content with Security.escapeHtml/escapeAttr
- All API calls go through the API object (api.js)
- Admin pages must verify access via AdminAuth.init()

## Hooks
- **PostToolUse (Write|Edit)**: Auto-runs `node --check` on any `.js` file after edit to catch syntax errors
