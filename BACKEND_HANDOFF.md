# Backend Handoff
**InkCartridges.co.nz | February 2026**

Items that require backend implementation to complete the conversion optimization work. Frontend is ready for all of these — just needs the API endpoints/infrastructure.

---

## Priority 1 — Revenue Impact

### 1. Purchase Event Tracking Confirmation
- **Why**: The frontend fires `page_view` on order confirmation, but there's no server-side purchase event. Revenue attribution requires a trusted backend event.
- **What's needed**: After successful payment/order creation, the backend should push a `purchase` event with `order_id`, `total`, `currency: NZD`, `items[]` to the analytics pipeline (GA4 Measurement Protocol or server-side GTM).
- **Frontend status**: `Analytics.track()` is ready to receive and forward if the backend passes order data to the confirmation page (e.g., via URL params or a fetch call).

### 2. Abandoned Cart Recovery
- **Why**: Cart abandonment is typically 60-80% in e-commerce. Email recovery recovers 5-15% of these.
- **What's needed**:
  - Endpoint to save cart state for authenticated users: `POST /api/cart/save` with `{ user_id, items[] }`
  - Scheduled job: If cart hasn't converted in 1h / 24h / 72h, trigger email
  - Email template with cart contents + "Complete Your Order" CTA
- **Frontend status**: Cart state is already synced to localStorage. Auth state is available. Frontend can call a save endpoint when items change.

### 3. Email Capture Endpoint
- **Why**: Newsletter signup in footer drives repeat purchases and is a standard e-comm conversion lever.
- **What's needed**: `POST /api/newsletter/subscribe` accepting `{ email }`, with validation and duplicate handling. Consider Mailchimp/Brevo integration.
- **Frontend status**: `Analytics.bindEmailCapture()` is ready to track submissions. The form HTML can be added to the footer once the endpoint exists.

---

## Priority 2 — SEO & Discovery

### 4. Sitemap.xml Generation
- **Why**: Search engines need a sitemap to efficiently crawl all product pages.
- **What's needed**: Auto-generated `/sitemap.xml` that includes:
  - All static pages (`/html/index.html`, `/html/shop.html`, etc.)
  - All product detail pages (`/html/product/?id=XYZ` for each product)
  - `<lastmod>` dates based on product update timestamps
  - `<changefreq>` and `<priority>` values
- **Frontend status**: N/A — this is purely server-side.

### 5. Robots.txt
- **Why**: Controls crawler access, prevents indexing of admin/account pages.
- **What's needed**: `/robots.txt` with:
  ```
  User-agent: *
  Allow: /
  Disallow: /html/admin/
  Disallow: /html/account/
  Sitemap: https://inkcartridges.co.nz/sitemap.xml
  ```
- **Frontend status**: N/A — server-side static file.

---

## Priority 3 — Customer Retention

### 6. Product Reviews Collection
- **Why**: Social proof increases conversion by 15-30%. Product page already has review stars in schema but no actual review data.
- **What's needed**:
  - `POST /api/reviews` — submit review (post-purchase, authenticated)
  - `GET /api/products/:id/reviews` — fetch reviews for display
  - Review moderation in admin panel
  - Post-purchase email trigger (7 days after delivery) asking for review
- **Frontend status**: Product schema already has review placeholders. Frontend can render reviews once the API exists.

### 7. "Save My Printer" / Reorder Reminders
- **Why**: Order confirmation now has a "Save My Printer" CTA. But no backend to store the printer model or trigger reorder emails.
- **What's needed**:
  - `POST /api/users/:id/printers` — save printer model association
  - Estimated ink life calculation (based on cartridge yield + avg usage)
  - Scheduled email: "Time to reorder?" with one-click reorder link
- **Frontend status**: CTA exists on order confirmation page with data-track. Needs an endpoint to POST the printer info to.

### 8. Wishlist Sync & Notifications
- **Why**: Favourites are currently localStorage only. Users lose them on device switch.
- **What's needed**:
  - `GET/POST /api/users/:id/favourites` — sync wishlist to server for authenticated users
  - Optional: price drop notification email when a wishlisted item goes on sale
- **Frontend status**: `favourites.js` already manages the wishlist. Can add API sync calls for logged-in users.

---

## Implementation Notes

- All existing API calls go through the `API` object in `/js/api.js` which points to `https://ink-backend-zaeq.onrender.com`
- Authentication tokens are managed by Supabase Auth (`/js/auth.js`)
- The frontend follows a pattern of `API.fetch(endpoint, options)` for all backend calls
- CORS headers will need to allow the frontend origin for any new endpoints
