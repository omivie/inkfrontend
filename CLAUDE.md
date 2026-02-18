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
  index.html          # Auth redirect handler
  html/               # All page HTML files
    index.html         # Homepage
    shop.html          # Shop page with DrilldownNav
    cart.html          # Shopping cart
    checkout.html      # Checkout flow
    payment.html       # Stripe payment
    account/           # User account pages (12 files)
    admin/             # Admin dashboard pages (12 files)
    product/           # Product detail page
    business/          # Business account application
  js/                  # All JavaScript (24 files)
    config.js          # API URLs, Supabase/Stripe keys
    utils.js           # $, $$, on, getStorage, setStorage, ProductColors, debounce
    security.js        # escapeHtml, escapeAttr, sanitizeUrl, safeRedirect
    main.js            # Nav, search, dropdowns, toasts, smooth scroll
    api.js             # API wrapper + formatPrice, getStockStatus, getSourceBadge
    auth.js            # Supabase Auth wrapper
    cart.js            # Shopping cart (hybrid server + localStorage)
    products.js        # Product card rendering
    filters.js         # Product filtering (sidebar layout pages)
    account.js         # Account pages logic
    admin.js           # Admin dashboard
    admin-auth.js      # Admin role verification
    admin-product-edit.js # Admin product editor
    ink-finder.js      # Printer-to-ink finder tool
    printer-data.js    # Printer series/model data
    favourites.js      # Wishlist
    cart-analytics.js  # Cart event tracking
    modern-effects.js  # Scroll animations, ripple, image loading
    ribbons.js         # Ribbons page filters
    products-page.js   # Admin products list + export
    orders-page.js     # Admin orders list
    customers-page.js  # Admin customers list
    analytics-api.js   # Admin analytics API calls
  css/                 # Stylesheets (6 files)
    base.css           # Reset, variables, typography
    layout.css         # Grid, header, footer
    components.css     # Reusable UI components
    pages.css          # Page-specific styles (very large)
    admin.css          # Admin dashboard styles
    modern-effects.css # Animations and effects
  assets/              # Images, brand logos, icons
  backend/data/        # ribbons.json (product data)
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

## Known Issues (see .claude/memory/errors.md for details)
- admin-auth.js has wrong login redirect paths
- cart.js duplicates colorMap and escapeHtml from utils.js/security.js
- 128 console.log statements across 20 JS files
- Unused npm dependencies (react, react-dom, @stripe/react-stripe-js)
- Empty backdoc/ directory
- Duplicate kyocera brand assets (PNG + SVG)

## Rules
- Never compute prices on frontend - backend is source of truth
- Always escape dynamic HTML content with Security.escapeHtml/escapeAttr
- All API calls go through the API object (api.js)
- Admin pages must verify access via AdminAuth.init()
