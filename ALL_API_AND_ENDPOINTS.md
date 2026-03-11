# Frontend Integration Guide

Complete reference for connecting to the Ink Backend API.

## Base URL

| Environment | URL |
|---|---|
| Development | `http://localhost:3000` |
| Production | Set via `NEXT_PUBLIC_API_URL` or equivalent env var |

All API routes are prefixed with `/api` (e.g., `GET /api/products`).

## CORS Setup

The backend allows:
- `http://localhost:*` (any port, dev only)
- Vercel preview/production: `https://inkfrontend*.vercel.app`
- Custom domains listed in `ALLOWED_ORIGINS` env var

**Required fetch config:**
```js
fetch(url, {
  credentials: 'include',  // REQUIRED for cookies (guest cart)
  headers: {
    'Content-Type': 'application/json',
    // If authenticated:
    'Authorization': `Bearer ${supabaseAccessToken}`
  }
});
```

## Authentication

Uses **Supabase Auth** — the frontend handles sign-up/login directly with Supabase, then sends the access token to the backend.

```js
// Get token from Supabase client
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// Send to backend
headers: { 'Authorization': `Bearer ${token}` }
```

### Auth Flow After Login/Signup

1. User signs up or logs in via Supabase Auth (frontend)
2. Call `POST /api/account/sync` with the Bearer token — this creates the user profile if needed
3. If user has a guest cart, call `POST /api/cart/merge` to transfer items to their account

### Email Verification

Some actions (placing orders, applying coupons) require a verified email.

```
GET  /api/auth/verification-status  → { ok, data: { verified: bool } }
POST /api/auth/resend-verification  → resends verification email
POST /api/auth/verify-email         → body: { token }
```

## Response Format

**Every** endpoint returns this shape:

```json
// Success
{
  "ok": true,
  "data": { ... },
  "meta": { "page": 1, "limit": 20, "total": 150 }  // optional, on paginated endpoints
}

// Error
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",       // machine-readable
    "message": "Human-readable error message",
    "details": { ... }           // optional (validation errors, etc.)
  }
}
```

### Error Codes

| HTTP Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid input |
| 401 | `UNAUTHORIZED` | Missing/invalid token |
| 403 | `FORBIDDEN` | Insufficient permissions |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | Duplicate (e.g., order idempotency) |
| 422 | `VALIDATION_FAILED` | Joi schema validation failed |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Server error |

### Recommended Error Handler

```js
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
    ...options,
  });

  const json = await res.json();

  if (!json.ok) {
    // Handle specific codes
    if (json.error.code === 'UNAUTHORIZED') {
      // Redirect to login or refresh token
    }
    if (json.error.code === 'RATE_LIMITED') {
      // Show "please wait" message
    }
    throw new ApiError(json.error.code, json.error.message, json.error.details);
  }

  return json; // { ok: true, data, meta? }
}
```

---

## Endpoints Reference

### Products & Catalog

```
GET /api/shop
```
**Primary product listing endpoint.** Returns products, series, and counts in one call.

| Query Param | Type | Notes |
|---|---|---|
| `brand` | string | **Required** — brand slug |
| `page` | number | Default: 1 |
| `limit` | number | Default: 20 |
| `search` | string | Search by name/SKU |
| `color` | string | Filter by color |
| `type` | string | Filter by product type |
| `category` | string | e.g., `CON-INK`, `CON-LASER` |
| `source` | string | `genuine` or `compatible` |
| `code` | string | Part number |
| `sort` | string | Sort order |

```
GET /api/products                → Product listing (same query params as /api/shop)
GET /api/products/counts         → Product counts by filter criteria
GET /api/products/series         → Product series groupings
GET /api/products/:sku           → Single product by SKU
GET /api/products/printer/:slug  → Products compatible with printer
GET /api/products/printer/:slug/color-packs → Color packs for printer
GET /api/brands                  → All brands
GET /api/color-packs/config      → Color pack configuration
```

### Search

```
GET /api/search/smart?q=...&limit=10         → Smart unified search (use this one)
GET /api/search/autocomplete?q=...&limit=5   → Autocomplete suggestions
GET /api/search/by-printer?q=...             → Find cartridges by printer name
GET /api/search/by-part?q=...&type=...       → Find by part number/SKU
GET /api/search/compatible-printers/:sku     → Printers compatible with a product
```

### Printers

```
GET /api/printers/search?q=...&brand=...     → Search printer models
GET /api/compatibility/:printer_id           → Compatible products for printer
```

### Ribbons

```
GET /api/ribbons?page=1&limit=20&search=...&brand=...&sort=...
GET /api/ribbons/brands
GET /api/ribbons/models
GET /api/ribbons/device-brands
GET /api/ribbons/device-models
GET /api/ribbons/:sku
```

### Reviews (Public)

```
GET /api/products/:productId/reviews          → Product reviews
GET /api/products/:productId/reviews/summary  → Rating summary { average, count, distribution }
```

---

### Cart

Cart works for both **guests** (cookie-based) and **authenticated users** (Bearer token). Always include `credentials: 'include'` for the guest cart cookie to work.

```
GET    /api/cart                → Get cart items
POST   /api/cart/items          → Add item       body: { product_id, quantity }
PUT    /api/cart/items/:productId → Update qty   body: { quantity }
DELETE /api/cart/items/:productId → Remove item
DELETE /api/cart                → Clear cart
GET    /api/cart/count          → Item count     → { ok, data: { count } }
```

**After login:**
```
POST /api/cart/merge      → Merge guest cart into user cart (call after login, requires auth)
```

**Optional auth (works for guest & authenticated):**
```
POST /api/cart/validate   → Validate cart (stock check, price refresh)
```

**Coupon operations (require auth + verified email):**
```
POST /api/cart/coupon      → Apply coupon     body: { coupon_code }
GET  /api/cart/coupon      → Get applied coupon
DELETE /api/cart/coupon    → Remove coupon
```

#### Guest Cart Flow

1. Guest adds items → backend sets `guest_cart_id` httpOnly cookie automatically
2. Guest browses, adds more items → cookie is sent with each request
3. Guest logs in → frontend calls `POST /api/cart/merge` → guest items merge into user cart
4. Cookie is cleared after merge

**Important:** The guest cart cookie is `httpOnly` (can't read it from JS) with `sameSite: 'none'` and `secure: true` in production. Your frontend just needs `credentials: 'include'`.

---

### Shipping

```
POST /api/shipping/options
```
Body:
```json
{
  "cart_total": 45.99,
  "items": [{ "product_id": "uuid", "quantity": 2 }],
  "postal_code": "1010",
  "delivery_type": "urban"   // "urban" | "rural"
}
```
Returns available shipping options with prices.

```
GET /api/shipping/rates    → Full shipping rate table (for display)
```

**Free shipping:** Orders over $100 NZD get free shipping (urban and rural).

---

### Orders

All order endpoints require `requireAuth` + verified email.

#### Create Order
```
POST /api/orders
```
Body:
```json
{
  "items": [
    { "product_id": "uuid", "quantity": 1 }
  ],
  "shipping_address": {
    "first_name": "John",
    "last_name": "Doe",
    "address_line_1": "123 Queen St",
    "address_line_2": "",
    "city": "Auckland",
    "region": "Auckland",
    "postal_code": "1010",
    "country": "NZ",
    "phone": "021..."
  },
  "save_address": true,
  "customer_notes": "Leave at door",
  "idempotency_key": "sha256-hash",
  "payment_method": "stripe",        // "stripe" | "paypal"
  "delivery_type": "urban",          // "urban" | "rural" | "admin-free"
  "shipping_tier": "auckland",
  "shipping_zone": "auckland"
}
```

Returns a Stripe `client_secret` (for `stripe` payment) or PayPal order details (for `paypal`).

#### Idempotency Key

Generate a SHA-256 hash of `userId + sorted item IDs + address` to prevent duplicate orders:
```js
const raw = userId + JSON.stringify(sortedItems) + JSON.stringify(address);
const idempotencyKey = await sha256(raw);
```

#### Stripe Payment Flow

1. `POST /api/orders` → get `client_secret`
2. Use Stripe.js `confirmPayment({ clientSecret })` on the frontend
3. Stripe webhook confirms payment → order moves to `paid`
4. Redirect user to order confirmation page

#### PayPal Payment Flow

1. `POST /api/orders` with `payment_method: "paypal"` → get PayPal approval URL
2. Redirect user to PayPal for approval
3. After approval, call `POST /api/orders/:orderNumber/capture-paypal`
4. PayPal webhook confirms → order moves to `paid`

#### Order Status Flow

```
pending → paid → processing → shipped → completed
   ↘ cancelled (from pending, paid, or processing)
```

#### Other Order Endpoints

```
GET  /api/orders                     → Order history (query: page, limit, status)
GET  /api/orders/:orderNumber        → Order details (format: ORD-{id}-{hex4})
GET  /api/orders/check-pending       → Check for pending orders
POST /api/orders/:orderNumber/cancel → Cancel order (from pending, paid, or processing)
```

---

### User Profile

All require Bearer token.

```
GET  /api/user/profile                    → Get profile
PUT  /api/user/profile                    → Update (body: { first_name, last_name, phone })

GET  /api/user/addresses                  → List addresses
POST /api/user/address                    → Add address
PUT  /api/user/address/:addressId         → Update address
DELETE /api/user/address/:addressId       → Delete address

GET  /api/user/printers                   → List saved printers
POST /api/user/printers                   → Add printer
PUT  /api/user/printers/:printerId        → Update printer
DELETE /api/user/printers/:printerId      → Delete printer

GET  /api/user/favourites                 → Get favourites
POST /api/user/favourites                 → Add (body: { product_id })
DELETE /api/user/favourites/:productId    → Remove
POST /api/user/favourites/sync            → Sync (body: { product_ids: [] })
GET  /api/user/favourites/check/:productId → Check if favourited

GET /api/user/savings                     → Get savings/deals
```

### Reviews (Authenticated)

```
POST   /api/reviews            → Create review (body: { product_id, rating, title, body })
PUT    /api/reviews/:reviewId  → Update own review
DELETE /api/reviews/:reviewId  → Delete own review
GET    /api/user/reviews       → List own reviews
```
Note: Creating a review requires having purchased the product.

---

### Account

```
POST /api/account/validate-email  → body: { email } — pre-signup check (blocks disposable emails)
POST /api/account/sync            → Sync after OAuth login (requires auth + Turnstile token)
GET  /api/account/me              → Get account info
```

### Business Accounts

```
POST /api/business/apply   → body: { company_name, nzbn, contact_name, contact_email, contact_phone, estimated_monthly_spend, industry }
GET  /api/business/status   → Application status
```

### Newsletter & Contact

Both require a Cloudflare Turnstile token.

```
POST /api/newsletter/subscribe  → body: { email, source, turnstile_token }
POST /api/contact               → body: { name, email, subject, message, phone?, order_number?, turnstile_token }
```

### Email Unsubscribe

```
GET /api/email/unsubscribe?token=...&type=...
```

### Settings

```
GET /api/settings   → Public settings (shipping rates, GST rate, features, stock thresholds)
```

### Cart Analytics

```
POST /api/analytics/cart-event  → body: { event_type, product_id, quantity, session_id }
```

---

## Cloudflare Turnstile (CAPTCHA)

These endpoints require a `turnstile_token` in the request body:

- `POST /api/contact`
- `POST /api/newsletter/subscribe`
- `POST /api/account/sync`

Frontend implementation:
```jsx
// 1. Add Turnstile widget to your form
<div className="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY} />

// 2. Include the token in your request body
const turnstileToken = document.querySelector('[name="cf-turnstile-response"]')?.value;

fetch('/api/contact', {
  method: 'POST',
  body: JSON.stringify({
    name, email, subject, message,
    turnstile_token: turnstileToken
  })
});
```

---

## Rate Limits

| Endpoint Group | Limit | Window |
|---|---|---|
| General API | 100 req | 1 min |
| Product browsing | 60 req | 1 min |
| Search | 30 req | 1 min |
| Cart | 60 req | 1 min |
| Orders | 10 req | 15 min |
| Account sync | 5 req | 15 min |
| Email verification | 5 req | 15 min |
| Newsletter | 3 req | 1 hour |
| Contact form | 3 req | 1 hour |
| Business application | 3 req | 1 hour |

When rate limited, the response is:
```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests..." } }
```

---

## Common Gotchas

1. **Always use `credentials: 'include'`** — guest cart relies on cookies
2. **Call `/api/account/sync` after login** — creates profile if it doesn't exist
3. **Call `/api/cart/merge` after login** — transfers guest cart items
4. **Check email verification** before order/coupon flows — use `/api/auth/verification-status`
5. **Turnstile token** is required on contact, newsletter, and account sync
6. **Order numbers** use the format `ORD-{id}-{hex4}` (e.g., `ORD-42-a3f1`)
7. **Idempotency key** is required for order creation to prevent duplicates
8. **GST is included** in all `retail_price` values (15% NZ GST)
9. **`cost_price` is never exposed** in public endpoints
10. **Pagination** defaults: `page=1`, `limit=20`. Response includes `meta: { page, limit, total }`

## Health & SEO (Root-level)

```
GET /health        → Health check with DB connectivity
GET /ready         → Readiness check
GET /sitemap.xml   → Dynamic sitemap (cached 1 hour)
GET /robots.txt    → Robots file
```

## Timeouts

- Standard endpoints: **15 seconds**
- Analytics endpoints: **30 seconds**

If a request takes too long, the backend responds with `408 Request Timeout`.

---

## Admin Endpoints

All admin endpoints require `Authorization: Bearer <token>` where the user has an entry in the `admin_roles` table. The `requireAdmin` middleware handles this automatically.

### Admin Verification
```
GET /api/admin/verify   → { ok, data: { roles: ['super_admin'], is_admin: true } }
```

### Admin Orders
```
GET  /api/admin/orders                      → List orders (query: page, limit, status, search)
GET  /api/admin/orders/:orderId             → Order details
PUT  /api/admin/orders/:orderId             → Update order (body: { status, admin_notes, tracking_number, carrier, shipped_at })
GET  /api/admin/orders/:orderId/events      → Order event history
POST /api/admin/orders/:orderId/events      → Add order event
```

### Admin Products
```
GET  /api/admin/products                        → List (query: page, limit, search, brand, is_active, is_reviewed, sort, order)
GET  /api/admin/products/:productId             → Details
PUT  /api/admin/products/:productId             → Update (body: { retail_price, stock_quantity, is_active, ... })
PUT  /api/admin/products/by-sku/:sku            → Update by SKU
GET  /api/admin/products/diagnostics            → Diagnostics report
POST /api/admin/products/bulk-activate          → Bulk activate/deactivate
POST /api/admin/products/:productId/images      → Upload image (multipart/form-data, max 5MB)
DELETE /api/admin/products/:productId/images/:imageId
PUT  /api/admin/products/:productId/images/reorder → body: { images: [] }
```

### Admin Customers
```
GET /api/admin/customers   → List customers (query: page, limit, search)
```

### Admin Refunds
```
GET  /api/admin/refunds              → List refunds (query: page, limit)
POST /api/admin/refunds              → Create refund
PUT  /api/admin/refunds/:refundId    → Update refund
```

### Admin Export
```
GET /api/admin/export/:type   → Export data (type: orders, products, customers) (query: format, date range)
```

### Admin Reviews
```
GET /api/admin/reviews                → All reviews for moderation
PUT /api/admin/reviews/:reviewId      → Moderate (body: { status, admin_notes })
```

### Admin Ribbons
```
GET    /api/admin/ribbons              → List ribbons
GET    /api/admin/ribbons/:ribbonId    → Details
POST   /api/admin/ribbons              → Create
PUT    /api/admin/ribbons/:ribbonId    → Update
DELETE /api/admin/ribbons/:ribbonId    → Delete
```

### Admin Shipping
```
GET    /api/admin/shipping/rates              → List rates (with gap/overlap detection)
GET    /api/admin/shipping/rates/:rateId      → Details
POST   /api/admin/shipping/rates              → Create
PUT    /api/admin/shipping/rates/:rateId      → Update
DELETE /api/admin/shipping/rates/:rateId      → Delete
```

### Admin Business Applications
```
GET /api/admin/business-applications            → List (query: page, limit, search, sort)
GET /api/admin/business-applications/:id        → Details
PUT /api/admin/business-applications/:id        → Update status (body: { status, notes })
GET /api/admin/business-applications-stats      → Statistics
```

### Admin Contact Emails
```
GET    /api/admin/contact-emails       → List recipients
POST   /api/admin/contact-emails       → Add (body: { email })
DELETE /api/admin/contact-emails/:id   → Remove
```

### Admin Abuse Prevention
```
GET /api/admin/abuse/flags                     → Flagged accounts (query: page, limit, flag_type, active_only)
PUT /api/admin/abuse/flags/:flagId/resolve     → Resolve flag
GET /api/admin/abuse/coupon-signals            → Coupon abuse signals
GET /api/admin/abuse/blocked-domains           → Blocked email domains
POST /api/admin/abuse/blocked-domains          → Block domain (body: { domain, reason })
DELETE /api/admin/abuse/blocked-domains/:id    → Unblock
```

### Admin Suppliers
```
GET /api/admin/suppliers                    → List suppliers
GET /api/admin/supplier-offers/compare      → Compare supplier pricing
```

### Admin Feed Files & Import
```
POST /api/admin/feed-files/:feedType       → Upload feed file (multipart, requires cron auth)
GET  /api/admin/feed-files                 → List uploaded feed files (requires cron auth)
POST /api/admin/import/genuine             → Run genuine product import (requires cron auth)
POST /api/admin/import/compatible          → Run compatible product import (requires cron auth)
POST /api/admin/cron/daily-product-import  → Run daily automated import (requires cron auth)
```

### Admin Analytics

All require admin auth. See full list:

```
GET /api/analytics/overview?timeRange=...
GET /api/analytics/top-products?metric=...&days=...&limit=...
GET /api/analytics/attach-rate
GET /api/analytics/genuine-vs-compatible
GET /api/analytics/stock-coverage
GET /api/analytics/pricing-intelligence
GET /api/analytics/customer-behavior
GET /api/analytics/b2b-opportunities
GET /api/analytics/cart-summary?period=...
GET /api/analytics/abandoned-carts
GET /api/analytics/marketing
POST /api/analytics/refresh

GET /api/admin/analytics/summary/financial
GET /api/admin/analytics/summary/customers
GET /api/admin/analytics/summary/operations
GET /api/admin/analytics/summary/executive
GET /api/admin/analytics/customer-ltv
GET /api/admin/analytics/cac
GET /api/admin/analytics/ltv-cac-ratio
GET /api/admin/analytics/cohorts
GET /api/admin/analytics/churn
GET /api/admin/analytics/customer-health
GET /api/admin/analytics/nps
GET /api/admin/analytics/repeat-purchase
GET /api/admin/analytics/pnl?days=...
GET /api/admin/analytics/cashflow
GET /api/admin/analytics/burn-runway
GET /api/admin/analytics/daily-revenue
GET /api/admin/analytics/forecasts
GET /api/admin/analytics/expenses
POST /api/admin/analytics/expenses
GET /api/admin/analytics/expense-categories
GET /api/admin/analytics/campaigns
POST /api/admin/analytics/campaigns
POST /api/admin/analytics/marketing-spend
GET /api/admin/analytics/channel-efficiency
GET /api/admin/analytics/conversion-funnel
GET /api/admin/analytics/inventory-turnover
GET /api/admin/analytics/dead-stock
GET /api/admin/analytics/stock-velocity
GET /api/admin/analytics/inventory-cash-lockup
GET /api/admin/analytics/product-performance
GET /api/admin/analytics/page-revenue
GET /api/admin/analytics/alerts
PUT /api/admin/analytics/alerts/:alertId/acknowledge
GET /api/admin/analytics/alert-thresholds
PUT /api/admin/analytics/alert-thresholds/:thresholdId
POST /api/admin/analytics/feedback
GET /api/admin/analytics/ga4-summary
GET /api/admin/analytics/overview
GET /api/admin/analytics/top-products
```
