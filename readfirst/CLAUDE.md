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
- Backend returns `product.brand` as object `{ id, name }` not string — use `getBrandName()` helper
- Some admin analytics endpoints not yet implemented on backend

## Rules
- Never compute prices on frontend - backend is source of truth
- Always escape dynamic HTML content with Security.escapeHtml/escapeAttr
- All API calls go through the API object (api.js)
- Admin pages must verify access via AdminAuth.init()
- **Ribbons are isolated**: Never modify anything ribbon-related (ribbons.html, ribbons-page.js, admin/pages/ribbons.js, ribbon product data, ribbon photos, ribbon prices, ribbon descriptions, ribbon CSS) unless the user explicitly asks. Cartridge changes must not touch ribbon code.
- **Out-of-stock CTA (May 2026):** when `product.in_stock === false`, render a primary "Contact us" CTA pointing at `/contact` (`<a>` on the PDP, `<button data-action="contact">` inside the wrapping `<a>` on cards — the parser auto-closes a nested `<a>`). **Do not** render "Notify me" or call `/api/products/:sku/waitlist` from any UI surface. The waitlist API stays mounted but is unused; `waitlist_available` in API responses is ignored. Spec: `readfirst/contact-button-may2026.md`. Pinned by `tests/contact-button-may2026.test.js`.
- **Product codes (May 2026):** the /shop drilldown chips are categorisation *codes* (Brother › Ink › LC40). Codes are backend-derived (`series_codes`) but admins can override them via the `product_codes` Supabase table — assigned in the product drawer's "Product Codes" picker. `api.js getShopData → _applyManualCodes` honours the table on the storefront (fail-open). Semantics: a product with any `product_codes` rows has its derived codes fully replaced; one with none is untouched. Migration: `inkcartridges/sql/product_codes.sql`. Pinned by `tests/product-codes.test.js`.

## Hooks
- **PostToolUse (Write|Edit)**: Auto-runs `node --check` on any `.js` file after edit to catch syntax errors
