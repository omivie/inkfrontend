# Backend → Frontend Integration Master Contract

> **Updated:** 2026-03-02 (production hardening audit: query pagination guards, import body validation, performance indexes, SKU normalization, deactivation alerts) | **Generated:** 2026-02-18 | **Source:** Zero-assumption audit of current backend source code
> **Every claim cites exact `file:line`** — no assumptions, no speculation.

---

## 1. System Overview

**Stack:** Node.js/Express backend, Supabase (PostgreSQL + RLS), Stripe payments
**File:** `package.json`

| Component | Version | Purpose |
|-----------|---------|---------|
| express | ^4.18.2 | HTTP server |
| @supabase/supabase-js | ^2.93.3 | Database client |
| stripe | ^20.1.0 | Payment processing |
| joi | ^17.11.0 | Request validation |
| helmet | ^7.1.0 | Security headers |
| express-rate-limit | ^7.1.5 | Rate limiting |
| compression | ^1.7.4 | Response compression |
| cookie-parser | ^1.4.7 | Cookie handling |
| morgan | ^1.10.0 | Request logging |
| multer | ^1.4.5-lts.1 | File uploads |
| nodemailer | ^7.0.12 | Email (SMTP) |
| resend | ^6.9.1 | Email (API) |
| cors | ^2.8.5 | CORS middleware |
| dotenv | ^16.3.1 | Environment variable loading |
| uuid | ^9.0.1 | UUID generation |
| csv-parser | ^3.0.0 | CSV parsing (import scripts) |
| xlsx | ^0.18.5 | Excel parsing (import scripts) |
| sanitize-html | ^2.17.1 | HTML sanitization (XSS prevention) |
| @sentry/node | ^10.39.0 | Error tracking (opt-in via SENTRY_DSN) |
| @google-analytics/data | ^5.2.1 | GA4 event reporting |

**Engine requirement:** Node >=18.0.0, npm >=9.0.0 (`package.json:48-49`)

**Entry point:** `src/server.js` — Express app exported at line 374.

**Middleware order** (`src/server.js:102-275`):
```
trust proxy (L102) → helmet (L108) → HTTPS redirect prod-only (L122)
→ CORS (L142) → requestId (L169)
→ global rate limit 100/min (L172-177) → request timeouts 15s/30s/60s (L179-182)
→ compression (L185) → raw body for webhooks BEFORE json (L189)
→ express.json 1mb (L192) → urlencoded 1mb (L193)
→ cookieParser (L196) → morgan (L199, combined in prod / dev in dev)
→ health check (L206) → readiness check (L227) → root info (L257)
→ SEO routes (L263) → API routes (L266)
→ Sentry error handler (L270, conditional) → 404 handler (L274) → error handler (L275)
```

---

## 2. Base URL Rules

**Development:**
- API: `http://localhost:3000/api`
- Health: `http://localhost:3000/health`
- Port: `process.env.PORT || 3000` (`src/server.js:104`)

**Production:**
- API base derived from `ALLOWED_ORIGINS` env var
- HTTPS enforced via `x-forwarded-proto` redirect (`src/server.js:122-131`)
- Frontend URL: `process.env.FRONTEND_URL` (no universal default — only `cartRecoveryService.js:5` falls back to `https://www.inkcartridges.co.nz`)

**CORS Configuration** (`src/server.js:133-166`):
- Origins: `process.env.ALLOWED_ORIGINS` (comma-separated) or `['http://localhost:3000']` default
- Localhost pattern `/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/` allowed in development only (`NODE_ENV === 'development'`, L150)
- No-origin requests allowed (mobile apps, Postman, webhooks) (L145)
- `credentials: true` — cookies sent cross-origin (L162)
- Methods: `GET, POST, PUT, DELETE, OPTIONS` (L163)
- Allowed headers: `Content-Type, Authorization, X-Requested-With, X-Request-Id` (L164)
- Preflight cache: 86400s / 24 hours (L165)
- Blocked origins logged: `console.warn('CORS blocked origin: ...')` (L158)

**Non-API routes** (mounted at root, not `/api`):
| Path | File | Purpose |
|------|------|---------|
| `GET /health` | `src/server.js:206` | Health check |
| `GET /ready` | `src/server.js:227` | Readiness check (DB + Stripe) |
| `GET /` | `src/server.js:257` | API info |
| `GET /sitemap.xml` | `src/routes/seo.js:24` | Auto-generated sitemap (1h cache) |
| `GET /robots.txt` | `src/routes/seo.js:81` | Robots file |

---

## 2b. Image URL Contract

**Bucket:** `public-assets` (single public bucket in Supabase Storage)
**Base URL pattern:** `{SUPABASE_URL}/storage/v1/object/public/public-assets/{path}`

The database stores **relative paths** for all Supabase storage assets. How they reach the frontend:

| Field | Backend resolves? | Frontend action |
|-------|-------------------|-----------------|
| `product.image_url` | **Yes** — always a full URL (or null) | Use directly in `<img src>` |
| `brand.logo_path` | **Yes** — always a full URL (or null) | Use directly in `<img src>` |
| `product_images[].path` | No — raw relative path | Frontend resolves with `storageUrl()` |

**Frontend helper** (needed only for `product_images[].path`):
```js
function storageUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path; // legacy safety
  return `${SUPABASE_URL}/storage/v1/object/public/public-assets/${path}`;
}
```

**Examples:**
- `product.image_url` from API: `"https://lmdl...supabase.co/storage/v1/object/public/public-assets/images/products/HP-C2P06AA/main.jpg"` or `"https://www.ds.co.nz/assets/full/CART312.jpg"` (external) — use as-is
- `brand.logo_path` from API: `"https://lmdl...supabase.co/storage/v1/object/public/public-assets/logos/canon.png"` — use as-is (or null if no logo)
- `product_images[].path` from API: `"images/products/HP-C2P06AA/main.jpg"` → `storageUrl(...)` → full URL

---

## 2c. Response Envelope

Every API response follows a consistent envelope format. The `ok` field indicates success or failure, `data` contains the response payload, and `meta` contains pagination metadata when applicable.

### Success Response

```json
{
  "ok": true,
  "data": {
    "products": [...]
  }
}
```

### Error Response

All errors return a structured `error` object with a machine-readable `code`, a human-readable `message`, and an optional `details` array for validation errors.

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      { "field": "email", "message": "\"email\" is required" }
    ]
  }
}
```

### Paginated Response

Pagination metadata is returned at the top level in a `meta` field, separate from `data`.

```json
{
  "ok": true,
  "data": {
    "products": [...]
  },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "total_pages": 5,
    "has_next": true,
    "has_prev": false
  }
}
```

### Pagination

All paginated endpoints use a consistent `meta` object at the top level with 6 fields:

| Field | Type | Description |
|-------|------|-------------|
| `total` | number | Total matching records |
| `page` | number | Current page number |
| `limit` | number | Items per page |
| `total_pages` | number | Total number of pages |
| `has_next` | boolean | Whether a next page exists |
| `has_prev` | boolean | Whether a previous page exists |

### Error Codes Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BAD_REQUEST` | 400 | Malformed request or invalid parameters |
| `VALIDATION_FAILED` | 400 | Joi schema validation failed (check `details` array) |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `FORBIDDEN` | 403 | Authenticated but insufficient permissions |
| `EMAIL_NOT_VERIFIED` | 403 | Email verification required for this action |
| `NOT_FOUND` | 404 | Requested resource does not exist |
| `CONFLICT` | 409 | Resource conflict (duplicate, stale state, coupon stacking) |
| `RATE_LIMITED` | 429 | Too many requests — respect `Retry-After` header |
| `PAYMENT_ERROR` | 402/500 | Stripe payment processing error |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### X-Request-Id Header

Every response includes an `X-Request-Id` header containing a unique UUID for the request. Clients can also send an `X-Request-Id` header with their requests for correlation — if provided, the server echoes it back; otherwise, the server generates one.

Use `X-Request-Id` for:
- **Debugging:** Include it in bug reports or support tickets
- **Log correlation:** Match frontend errors to backend log entries
- **Distributed tracing:** Track requests across services

Example:
```
# Request
GET /api/products HTTP/1.1
X-Request-Id: 550e8400-e29b-41d4-a716-446655440000

# Response
HTTP/1.1 200 OK
X-Request-Id: 550e8400-e29b-41d4-a716-446655440000
```

---

## 3. Authentication Contract

**Provider:** Supabase Auth (JWT-based)
**File:** `src/middleware/auth.js`

### Token Format
```
Authorization: Bearer <supabase-access-token>
```
The token is a Supabase JWT obtained client-side via `supabase.auth.signInWith*()`.

### Middleware Chain

| Middleware | File:Line | Sets on `req` | Purpose |
|-----------|-----------|---------------|---------|
| `requireAuth` | `auth.js:15` | `req.user`, `req.token` | Validates Bearer token via `supabase.auth.getUser()` |
| `requireAdmin` | `auth.js:47` | `req.userRoles`, `req.isAdmin` | Calls `requireAuth` internally, then checks `admin_roles` table |
| `requireRole(...roles)` | `auth.js:102` | — | Must follow `requireAdmin`. Checks `req.userRoles` against allowed roles |
| `optionalAuth` | `auth.js:131` | `req.user` (or null) | Attempts auth, continues as anonymous if missing/invalid |
| `requireVerifiedEmail` | `auth.js:165` | — | Must follow `requireAuth`. Checks `email_confirmed_at` is set |

### Auth Failure Responses

| Scenario | Status | Body |
|----------|--------|------|
| Missing/invalid Bearer token | 401 | `{ "ok": false, "error": { "code": "UNAUTHORIZED", "message": "Missing authorization header" } }` or `"Invalid token"` |
| Auth error | 401 | `{ "ok": false, "error": { "code": "UNAUTHORIZED", "message": "Authentication failed" } }` |
| Not admin | 403 | `{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Admin access required" } }` |
| Insufficient role | 403 | `{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Insufficient permissions for this action" } }` |
| Email not verified | 403 | `{ "ok": false, "error": { "code": "EMAIL_NOT_VERIFIED", "message": "Please verify your email address to access this resource" } }` |

### Three Supabase Client Tiers (`src/config/supabase.js`)

| Client | Function | Line | RLS | Used For |
|--------|----------|------|-----|----------|
| Anonymous | `setupSupabase()` | L4 | Enforced (anon role) | Public product reads |
| Service Role | `setupSupabaseAdmin()` | L18 | **Bypassed** | Admin ops, webhooks, cron |
| User JWT | `setupSupabaseWithUser(token)` | L41 | Enforced (user role) | **All user-facing routes** |

**Defense-in-depth:** User-facing routes MUST use `setupSupabaseWithUser(req.token)` so RLS policies enforce row-level access at the database level, in addition to application-level checks.

### Admin Roles
Stored in `admin_roles` table. Valid roles: `super_admin`, `stock_manager`, `order_manager` (`auth.js:62`).

---

## 4. API Endpoints

### Route Registration (`src/routes/index.js:268-288`)

| Mount | Router File | Prefix |
|-------|------------|--------|
| L268 | `products.js` | `/api` |
| L269 | `orders.js` | `/api` |
| L270 | `cart.js` | `/api` |
| L271 | `webhooks.js` | `/api` |
| L272 | `user.js` | `/api` |
| L273 | `admin.js` | `/api` |
| L274 | `search.js` | `/api` |
| L275 | `analytics.js` | `/api/analytics` |
| L276 | `auth.js` | `/api` |
| L277 | `business.js` | `/api` |
| L278 | `shipping.js` | `/api` |
| L279 | `settings.js` | `/api` |
| L280 | `cartAnalytics.js` | `/api` |
| L281 | `newsletter.js` | `/api` |
| L282 | `contact.js` | `/api` |
| L283 | `reviews.js` | `/api` |
| L284 | `account.js` | `/api` |
| L285 | `ribbons.js` | `/api` |
| L286 | `adminRibbons.js` | `/api` |
| L287 | `adminShipping.js` | `/api` |
| L288 | `adminAnalytics.js` | `/api/admin/analytics` |

---

### 4.1 Products & Catalog (Public)

**File:** `src/routes/products.js`
**Rate limit:** 60 req/min per IP (`catalogLimiter`, L18-24)

#### GET /api/products
**Line:** 45 | **Auth:** None | **Validation:** `productQuerySchema` (query)

Query params:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | int | 1 | Page number |
| limit | int | 20 | Items per page (max 200) |
| search | string | — | Search name/sku/mpn |
| brand | string | — | Filter by brand slug |
| color | string | — | Filter by color |
| sort | string | name_asc | `price_asc`, `price_desc`, `name_asc`, `name_desc` |
| type | string | — | `cartridge`/`consumable`/`printer`/`ribbon`/`label_tape` |
| category | string | — | `ink`, `toner`, `printer`, `laser`, `inkjet`, `consumable` |

**Filtering behavior:**
- `type=consumable` / `type=cartridge` / `category=consumable` / `category=cartridge` — returns ink, toner, drums, fax, photo paper. **Excludes** ribbons and label tapes (they have dedicated types).
- `type=ribbon` — returns only ribbons (calculator/POS/dot-matrix ribbons). Use dedicated `/api/ribbons` routes for device-based filtering.
- `type=label_tape` — returns only label tapes and label rolls (P-touch TZe tapes, DK/CZ label rolls).
| source | string | — | `genuine`, `compatible`, or `ribbon` |

Response:
```json
{
  "ok": true,
  "data": {
    "products": [{ "id", "sku", "name", "brand": {"id","name","slug"}, "manufacturer_part_number", "retail_price", "color", "page_yield", "stock_quantity", "image_url", "is_featured", "product_type", "category", "source", "specifications", "in_stock": true }]
  },
  "meta": { "page": 1, "limit": 20, "total": 100, "total_pages": 5, "has_next": true, "has_prev": false }
}
```

#### GET /api/products/:sku
**Line:** 205 | **Auth:** None | **Validation:** `productSkuSchema` (params)

Response includes: product detail, `compatible_printers` (for non-ribbon consumables), `compatible_cartridges` (for printers), `in_stock`, `is_low_stock`. `cost_price` always returned as `null` (L302). Brand includes `logo_path` (full URL, use directly). For ribbon detail with `compatible_devices`, use the dedicated `GET /api/ribbons/:sku` endpoint instead.

#### GET /api/products/printer/:printerSlug
**Line:** 317 | **Auth:** None | **Validation:** `printerSlugSchema` (params)

Returns printer info + `compatible_products` array with `in_stock` flag.

#### GET /api/printers/search
**Line:** 388 | **Auth:** None | **Validation:** `printerSearchSchema` (query)

Query: `q` (required), `brand` (optional slug). Results capped at 10 (hardcoded at `products.js:406`).
Returns printers with `compatible_products_count`.

#### GET /api/brands
**Line:** 460 | **Auth:** None | **Validation:** None

Returns `[{ id, name, slug, logo_path }]` for active brands. `logo_path` is a full URL (e.g. `https://...supabase.co/.../logos/canon.png`) — use directly in `<img src>`. Returns `null` if no logo uploaded.

#### GET /api/compatibility/:printer_id
**Line:** 488 | **Auth:** None | **Validation:** `printerIdSchema` (params)

Returns `{ printer, compatible_products, total_compatible }`.

#### GET /api/products/printer/:printerSlug/color-packs
**Line:** 577 | **Auth:** None | **Validation:** `printerSlugSchema` (params)

Query: `include_unavailable` (boolean), `source` (`genuine`/`compatible`).
Returns color packs (CMY/KCMY) separated by genuine/compatible. DB-persisted packs (`GEN-PACK-*` and `COMP-PACK-*` SKUs) are returned as regular products; virtual packs are generated on-the-fly only for series that lack a DB pack. Discount rate 7% default.

#### GET /api/color-packs/config
**Line:** 627 | **Auth:** None | **Validation:** None

Returns `{ discount_rate, min_discount, max_discount, pack_types, price_ending }`.

---

### 4.2 Search (Public)

**File:** `src/routes/search.js`
**Rate limit:** 30 req/min per IP (`searchLimiter`, L17-23)

#### GET /api/search/by-printer
**Line:** 68 | **Auth:** None | **Validation:** `searchByPrinterSchema` (query)

Query: `q` (required, min 2), `limit` (default 20), `page` (default 1).
Returns cartridges compatible with matching printers. Cost price stripped (L146). Image URLs resolved via `resolveImageUrl()`.
Response: `{ "ok": true, "data": { "printer_search": ..., "products": [...] }, "meta": { "page", "limit", "total", "total_pages", "has_next", "has_prev" } }`.

#### GET /api/search/by-part
**Line:** 213 | **Auth:** None | **Validation:** `searchByPartSchema` (query)

Query: `q` (required, min 1), `type` (`cartridge`/`consumable`/`printer`/`ribbon`/`label_tape`, optional), `limit`, `page`.
Searches by SKU, MPN, name. Enriches cartridge consumables with `compatible_printers` and ribbons with `compatible_devices` (from `ribbon_compatibility` table). Label tapes receive no compatibility enrichment. `type=cartridge`/`type=consumable` excludes ribbons and label tapes. Cost price stripped (L280). Image URLs resolved via `resolveImageUrl()`.
Response: `{ "ok": true, "data": { "search_term": ..., "filter": ..., "products": [...] }, "meta": { "page", "limit", "total", "total_pages", "has_next", "has_prev" } }`.

#### GET /api/search/autocomplete
**Line:** 372 | **Auth:** None | **Validation:** `autocompleteSchema` (query)

Query: `q` (required, min 2), `limit` (default 10).
Returns `{ search_term, suggestions }`.

#### GET /api/search/compatible-printers/:sku
**Line:** 448 | **Auth:** None | **Validation:** `skuParamSchema` (params)

Returns all printers/devices compatible with a specific consumable SKU. For **non-ribbon consumables**, returns `{ cartridge: { sku, name }, compatible_printers: [...], total }` from `product_compatibility`. For **ribbons**, returns `{ ribbon: { sku, name }, compatible_devices: [{ brand, model }], total }` from `ribbon_compatibility`. Returns 400 if product is not a consumable type.

#### GET /api/search/smart
**Line:** 513 | **Auth:** `optionalAuth` | **Validation:** `smartSearchSchema` (query, defined locally in `search.js:47-50`)

Fuzzy search with trigram matching (`pg_trgm`) and relevance ranking. Tolerates typos on queries >= 3 chars.

Query: `q` (required, min 1, max 200), `limit` (default 48, max 100).

Response:
```json
{
  "ok": true,
  "data": {
    "products": [{
      "id": "uuid",
      "sku": "HP-65XL-BK",
      "name": "HP 65XL Black Ink Cartridge",
      "brand": { "name": "HP" },
      "color": "Black",
      "source": "genuine",
      "retail_price": 39.95,
      "in_stock": true,
      "is_low_stock": false,
      "stock_quantity": 25,
      "image_url": "https://...",
      "page_yield": "300 pages"
    }],
    "total": 12
  }
}
```

**Notes:**
- Uses `smart_search` Supabase RPC function (pg_trgm for typo tolerance)
- `cost_price` and `relevance` score are stripped from results
- No pagination — returns up to `limit` results ranked by relevance
- Example: `GET /api/search/smart?q=epsn+220&limit=10` (typo-tolerant)

---

### 4.3 Orders (Authenticated)

**File:** `src/routes/orders.js`

#### POST /api/orders
**Line:** 124 | **Auth:** `requireAuth` + `requireVerifiedEmail` | **Rate Limit:** `orderLimiter` 10/15min per user | **Validation:** `createOrderSchema` (body)

Request body:
```json
{
  "items": [{ "product_id": "uuid", "quantity": 1 }],
  "shipping_address": {
    "recipient_name": "string",
    "phone": "string (optional)",
    "address_line1": "string",
    "address_line2": "string (optional)",
    "city": "string",
    "region": "string (required for zone-based shipping)",
    "postal_code": "string",
    "country": "string (default NZ)"
  },
  "save_address": false,
  "customer_notes": "string (optional, max 500 chars, HTML stripped)",
  "idempotency_key": "string (optional, max 64 chars — auto-generated if missing)",
  "delivery_type": "urban|rural (default urban — used for shipping rate lookup)",
  "shipping_tier": "free|light|standard|heavy (optional, display-only — backend ignores and recalculates)",
  "shipping_zone": "auckland|north-island|south-island (optional, display-only — backend recalculates)"
}
```

> **Note:** `coupon_code` field has been removed. Only promotional coupons (applied via `POST /api/cart/coupon`) are supported.

**Validation constraints** (`createOrderSchema`):
- `items`: 1–50 items, each with `product_id` (UUID) and `quantity` (1–100)
- `shipping_address.recipient_name`: max 200 chars
- `shipping_address.country`: exactly 2 uppercase chars, defaults to `NZ`
- `shipping_zone`: also accepts underscore variants (`north_island`, `south_island`)
- `shipping_tier` and `shipping_zone`: **empty strings are accepted** — send `""` or omit entirely. Backend ignores these values and recalculates from `shipping_address`.

Response (201):
```json
{
  "ok": true,
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-XXXXX-XXXX",
    "status": "pending",
    "total_amount": 99.95,
    "gst_amount": 13.04,
    "client_secret": "pi_xxx_secret_xxx",
    "items": [...],
    "shipping_address": {...},
    "created_at": "ISO"
  }
}
```

**Critical:** Frontend uses `client_secret` with Stripe.js `confirmPayment()`.

Errors:
| Status | Error Code | Condition |
|--------|------------|-----------|
| 400 | `VALIDATION_FAILED` | Request body fails Joi schema validation (e.g. missing required fields, invalid UUIDs). `error.details` has per-field messages. |
| 400 | `BAD_REQUEST` | Stock validation failed (`error.details` has per-item failed_items array) |
| 400 | `BAD_REQUEST` | Product not found/inactive |
| 409 | `DUPLICATE_REQUEST` | Idempotency key in-flight (message: "Order already being processed. Please wait.") |
| 409 | `DUPLICATE_ORDER` | DB-level duplicate from `create_order_atomic()` RPC (message: "Order already exists") |
| 200 | — | Idempotent replay: order already exists. Response includes `is_duplicate: true` and `message` inside `data` (see below) |
| 409 | `PROMO_COUPON_LIMIT_REACHED` | Promotional coupon usage limit reached (message: "Coupon has reached its usage limit.") |
| 400 | `ORDER_TOTAL_TOO_LOW` | Order total after discounts is below Stripe minimum ($0.50 NZD). Show message asking user to add more items. |
| 400/500 | `PAYMENT_ERROR` | Stripe rejected the PaymentIntent (e.g. invalid params). Show generic payment error with retry. |
| 500 | `ORDER_DB_ERROR` | Database transaction failed. Message includes DB error code for debugging (e.g. `DB: 42883` = missing RPC function). |

**Idempotent replay response (200)** — note: NO `client_secret`, `items`, or `shipping_address`:
```json
{
  "ok": true,
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-XXXXX-XXXX",
    "status": "pending",
    "total_amount": 99.95,
    "created_at": "ISO",
    "is_duplicate": true,
    "message": "Order already exists"
  }
}
```

**Frontend error handling:**
```js
// Check for idempotent replay FIRST (status 200 with is_duplicate)
if (response.ok && response.data?.is_duplicate) {
  // Order already created — redirect to order confirmation
  // DO NOT try to use client_secret (not present in this response)
  redirectToOrderConfirmation(response.data.order_number);
  return;
}

if (!response.ok) {
  const code = response.error?.code;
  if (code === 'DUPLICATE_REQUEST') {
    // Show "Order already being processed" — do NOT retry
    // Poll GET /api/orders after 5-10 seconds
  } else if (code === 'DUPLICATE_ORDER') {
    // Order already created — redirect to order confirmation
  } else if (code === 'PROMO_COUPON_LIMIT_REACHED') {
    // Coupon maxed out — remove and retry without coupon
  } else if (code === 'VALIDATION_FAILED') {
    // Show per-field errors from error.details[]
  } else if (code === 'ORDER_DB_ERROR') {
    // Database error — show generic "Order could not be processed" with retry
  }
}
```

#### GET /api/orders/check-pending
**Line:** 820 | **Auth:** `requireAuth` | **Validation:** None

Returns the most recent pending order from the last 30 minutes for the current user. Use this for **checkout timeout recovery** — if the frontend gets a timeout or network error during order creation, call this endpoint to check if an order was actually created before showing an error or allowing a retry.

Response:
```json
{
  "ok": true,
  "data": {
    "has_pending_order": true,
    "order": {
      "id": "uuid",
      "order_number": "ORD-xxx-xxxx",
      "status": "pending",
      "total": 59.95,
      "created_at": "2026-03-01T...",
      "payment_intent_id": "pi_xxx"
    }
  }
}
```
When `has_pending_order` is `false`, `order` is `null`. **Frontend flow:** On checkout timeout → call this endpoint → if pending order exists, redirect to order status page instead of retrying (which could create a duplicate).

#### GET /api/orders
**Line:** 852 | **Auth:** `requireAuth` | **Validation:** `orderQuerySchema` (query)

Query: `page`, `limit`, `status` (optional filter).
Uses `setupSupabaseWithUser` — RLS enforces user sees own orders only.

Response includes per-order:
- `customer_notes` (string or `null`)
- `tracking_number`, `tracking_url` (computed NZ Post link, or `null`)
- `estimated_delivery` (ISO date string, computed from order date + delivery days)
- `shipping_tier` (`free`/`standard`/`heavy`), `delivery_zone` (`auckland`/`north-island`/`south-island`)
- `invoice` (`{ invoice_number, invoice_date }` or `null` — from `invoices` table)
- `order_items[].product_slug` (product SKU for "Buy Again" links — e.g. `"HP-65XL-BK"`, use with `/api/products/:sku`)

#### GET /api/orders/:orderNumber
**Line:** 979 | **Auth:** `requireAuth` | **Validation:** `orderNumberParamSchema` (params — must match `ORD-{base36}-{hex4}` format, max 30 chars)

Returns full order detail with items, product images, and shipping zone info. RLS-enforced.
Includes `gst_amount`, `tracking_url`, `estimated_delivery`, `shipping_tier`, `shipping_fee`, `delivery_zone`, `estimated_delivery_days_min/max`, `invoice` (`{ invoice_number, invoice_date }` or `null`), and `order_items[].product_slug` (product SKU).

---

### 4.4 Cart (Guest & Authenticated)

**File:** `src/routes/cart.js`
**Rate limit:** 60 req/min per IP (`cartLimiter`, L46-50)

**Guest cart:** Uses `guest_cart_id` httpOnly cookie (72 hours, secure in prod, sameSite lax) — `L54-60`.
Browser manages cookie automatically; frontend does not need to handle it.

#### GET /api/cart
**Line:** 294 | **Auth:** `optionalAuth` | **Validation:** None

Response:
```json
{
  "ok": true,
  "data": {
    "items": [{ "id", "quantity", "product": {...}, "price_snapshot", "price_changed", "line_total", "in_stock" }],
    "removed_items": [{ "cart_item_id": "uuid", "reason": "Product no longer available" }],
    "coupon": { "code", "discount_type", "discount_amount", "is_valid" } | null,
    "summary": { "item_count", "unique_items", "subtotal", "shipping", "discount", "total", "gst_amount", "coupon": {...} | null, "is_shipping_estimate": true },
    "is_guest": true|false
  }
}
```

**Deleted product handling:** If a product referenced by a cart item has been deleted, the orphaned cart item is auto-removed from the database and excluded from `items`. When any items are cleaned up, a `removed_items` array is included in the response. When no items were removed, `removed_items` is absent (not an empty array). Frontend can optionally show a toast notification when `removed_items` is present.

#### POST /api/cart/items
**Line:** 369 | **Auth:** `optionalAuth` | **Validation:** `addToCartSchema` (body)

Body: `{ "product_id": "uuid", "quantity": 1 }`.
Creates guest session cookie if needed. Updates quantity if item already in cart.
Returns 201 (new) or 200 (updated).

#### PUT /api/cart/items/:productId
**Line:** 512 | **Auth:** `optionalAuth` | **Validation:** `cartProductIdSchema` (params) + `updateCartItemSchema` (body)

Body: `{ "quantity": 3 }`.

#### DELETE /api/cart/items/:productId
**Line:** 590 | **Auth:** `optionalAuth` | **Validation:** `cartProductIdSchema` (params)

#### DELETE /api/cart
**Line:** 624 | **Auth:** `optionalAuth` | **Validation:** None

Clears entire cart.

#### POST /api/cart/merge
**Line:** 657 | **Auth:** `requireAuth` | **Validation:** Guest cookie UUID format validated via `getValidGuestSessionId()`

**Frontend MUST call after sign-in** to merge guest cart into user cart.
Calls `merge_guest_cart_to_user()` RPC atomically. Clears guest cookie. Malformed guest_cart_id cookies are treated as "no guest cart" (returns `merged_count: 0`).

#### GET /api/cart/count
**Line:** 715 | **Auth:** `optionalAuth` | **Validation:** None

Returns `{ count, unique_items }` for header badge. Count excludes deleted and inactive products — badge matches rendered cart items.

#### POST /api/cart/validate
**Line:** 752 | **Auth:** `optionalAuth` | **Validation:** None

**Frontend MUST call before checkout.** Checks stock, product active, price changes.
Auto-updates stale price snapshots so next validation passes.

Response:
```json
{
  "data": {
    "is_valid": true|false,
    "valid_items": [...],
    "issues": [{
      "cart_item_id": "uuid",
      "sku": "HP-65XL-BK",
      "name": "HP 65XL Black Ink Cartridge",
      "issue": "Insufficient stock",
      "requested": 3,
      "available": 0
    }],
    "summary": { "valid_item_count", "issue_count", "subtotal" }
  }
}
```

**Issue types and their fields:**
| Issue | Fields |
|---|---|
| `"Product no longer exists"` | `cart_item_id` only (product was deleted) |
| `"Product is no longer available"` | `cart_item_id`, `sku`, `name`, `available` (always `0`) |
| `"Insufficient stock"` | `cart_item_id`, `sku`, `name`, `requested`, `available` |
| `"Price has changed"` | `cart_item_id`, `sku`, `name`, `old_price`, `new_price` |

Price-change issues auto-update the cart snapshot, so re-validating after the user acknowledges will pass.

#### POST /api/cart/coupon
**Line:** 1018 | **Auth:** `requireAuth` | **Rate Limit:** `couponLimiter` 5/5min per user + daily cap 50/day + progressive backoff (DB-backed) | **Validation:** `applyCouponSchema` (body)

Body: `{ "code": "SAVE10" }`. Validates expiry, usage limits, minimum order.

**Rate limiting (3 layers):**
1. `cartLimiter`: 60/min (shared with all cart ops)
2. `couponLimiter`: 5 attempts per 5 minutes per user
3. **Daily cap + progressive backoff (NEW):** 50 attempts/day per user. After 20 failed attempts, user is blocked for 1 hour. Returns `429` with `retry_after` (seconds) when blocked.

**Error responses:** All coupon validation failures return identical `400 { "ok": false, "error": { "code": "BAD_REQUEST", "message": "Coupon could not be applied" } }` (security: prevents coupon code enumeration). Exception: minimum order amount still returns `400 { "ok": false, "error": { "code": "BAD_REQUEST", "message": "Minimum order amount of $X required" }, ... }`.

**New 429 responses:**
- `"Too many failed coupon attempts. Please try again later."` — progressive backoff (1 hour block). Response includes `retry_after` in seconds.
- `"Daily coupon attempt limit reached. Please try again tomorrow."` — 50/day cap exhausted.

#### DELETE /api/cart/coupon
**Line:** 1153 | **Auth:** `requireAuth` | **Validation:** None

Removes applied coupon.

#### GET /api/cart/coupon
**Line:** 1170 | **Auth:** `requireAuth` | **Validation:** None

Returns currently applied coupon details or `null`.

---

### 4.5 User Profile (Authenticated)

**File:** `src/routes/user.js`
All endpoints use `setupSupabaseWithUser(req.token)` for RLS enforcement.

#### GET /api/user/profile
**Line:** 25 | **Auth:** `requireAuth`

Auto-creates profile if missing. Returns profile + email.

#### PUT /api/user/profile
**Line:** 78 | **Auth:** `requireAuth` | **Validation:** `updateProfileSchema` (body)

Body: `{ "first_name", "last_name", "phone" }`.

#### GET /api/user/addresses
**Line:** 134 | **Auth:** `requireAuth`

Returns saved addresses sorted by `is_default` then `created_at`.

#### POST /api/user/address
**Line:** 163 | **Auth:** `requireAuth` | **Validation:** `createAddressSchema` (body)

Body: `{ "recipient_name", "phone", "address_line1", "address_line2", "city", "region", "postal_code", "country", "is_default" }`.

#### PUT /api/user/address/:addressId
**Line:** 223 | **Auth:** `requireAuth` | **Validation:** `addressIdSchema` (params) + `createAddressSchema` (body)

#### DELETE /api/user/address/:addressId
**Line:** 295 | **Auth:** `requireAuth` | **Validation:** `addressIdSchema` (params)

If deleted address was default, auto-sets another as default.

#### GET /api/user/printers
**Line:** 349 | **Auth:** `requireAuth`

Returns saved printers with printer model details.

#### POST /api/user/printers
**Line:** 387 | **Auth:** `requireAuth` | **Validation:** `addPrinterSchema` (body)

Body accepts two formats (must provide `printer_id` or `slug`):
- By ID: `{ "printer_id": "uuid" }`
- By slug: `{ "slug": "printer-slug", "model": "optional", "brand": "optional", "nickname": "optional" }`

If `slug` is provided without `printer_id`, the backend resolves it to a printer ID via lookup. `nickname` is saved if provided. Returns 409 if already saved.

#### PUT /api/user/printers/:printerId
**Line:** 471 | **Auth:** `requireAuth` | **Validation:** `printerIdParamSchema` (params) + `updatePrinterNicknameSchema` (body)

Body: `{ "nickname": "Office Printer" }`.

#### DELETE /api/user/printers/:printerId
**Line:** 520 | **Auth:** `requireAuth` | **Validation:** `printerIdParamSchema` (params)

#### GET /api/user/favourites
**Line:** 551 | **Auth:** `requireAuth`

Returns `{ "ok": true, "data": [...] }` — `data` is a flat array of favourites with product detail and `in_stock` flag.

#### POST /api/user/favourites
**Line:** 609 | **Auth:** `requireAuth` | **Validation:** `addFavouriteSchema` (body)

Body: `{ "product_id": "uuid" }`. Returns 409 if already favourited.

#### DELETE /api/user/favourites/:productId
**Line:** 670 | **Auth:** `requireAuth` | **Validation:** `favouriteProductIdSchema` (params)

#### POST /api/user/favourites/sync
**Line:** 705 | **Auth:** `requireAuth` | **Validation:** `syncFavouritesSchema` (body)

Body: `{ "product_ids": ["uuid", "uuid"] }`.
Bulk merges localStorage favourites to server on login.

#### GET /api/user/favourites/check/:productId
**Line:** 782 | **Auth:** `requireAuth` | **Validation:** `favouriteProductIdSchema` (params)

Returns `{ is_favourite, favourite_id, added_at }`.

#### GET /api/user/savings
**Line:** 813 | **Auth:** `requireAuth`

Returns total savings summary by type + recent savings + account type.

---

### 4.6 Auth & Verification

**File:** `src/routes/auth.js`

#### GET /api/auth/verification-status
**Line:** 31 | **Auth:** `requireAuth` | **Rate:** 30/min (`statusLimiter`, L21)

Returns `{ email, email_verified, verified_at }`.

#### POST /api/auth/resend-verification
**Line:** 50 | **Auth:** `requireAuth` | **Rate:** 5/15min (`verificationLimiter`, L15)

Resends Supabase verification email. Returns 400 if already verified.
Redirect URL: `process.env.EMAIL_VERIFICATION_REDIRECT_URL || ${FRONTEND_URL}/auth/verify` (L69).

#### POST /api/auth/verify-email
**Line:** 106 | **Auth:** None | **Rate:** 5/15min | **Validation:** `verifyEmailSchema` (body)

Body: `{ "token": "token_hash", "type": "email" (optional) }`.
Verifies OTP/token via Supabase. Returns session tokens on success.

---

### 4.7 Signup Coupons

**REMOVED:** The signup coupon endpoints (`POST /api/coupons/claim-signup`, `GET /api/coupons/my`, `POST /api/coupons/redeem`) have been removed. Only promotional coupons (applied via `POST /api/cart/coupon`) remain.

---

### 4.8 Reviews

**File:** `src/routes/reviews.js`
**Rate limit (write ops):** 10/15min (`reviewLimiter`, L8-14)

#### POST /api/reviews
**Line:** 41 | **Auth:** `requireAuth` + `reviewLimiter` | **Validation:** `createReviewSchema` (body)

Body: `{ "product_id": "uuid", "rating": 1-5, "title": "optional", "body": "optional" }`.
Verifies user has purchased the product. Returns 403 if not purchased, 409 if already reviewed.

#### GET /api/products/:productId/reviews
**Line:** 117 | **Auth:** None

Query: `page`, `limit`, `sort` (`newest`/`oldest`/`highest`/`lowest`).
Returns only `approved` reviews. Response: `{ "ok": true, "data": { "reviews": [...] }, "meta": { "page", "limit", "total", "total_pages", "has_next", "has_prev" } }`.

#### GET /api/products/:productId/reviews/summary
**Line:** 167 | **Auth:** None

Returns `{ review_count, average_rating, five_star, four_star, ..., avg_rating, count, distribution: { 5, 4, 3, 2, 1 } }`.
`avg_rating` aliases `average_rating`, `count` aliases `review_count`, `distribution` groups star counts by number.

#### GET /api/user/reviews
**Line:** 221 | **Auth:** `requireAuth`

Returns user's own reviews with product info.

#### PUT /api/reviews/:reviewId
**Line:** 253 | **Auth:** `requireAuth` + `reviewLimiter` | **Validation:** `reviewIdSchema` (params) + `updateReviewSchema` (body)

Only pending reviews can be edited.

#### DELETE /api/reviews/:reviewId
**Line:** 311 | **Auth:** `requireAuth` + `reviewLimiter` | **Validation:** `reviewIdSchema` (params)

#### GET /api/admin/reviews
**Line:** 355 | **Auth:** `requireAdmin` | **Validation:** `adminReviewQuerySchema` (query)

Query: `page`, `limit`, `status` (filter).
Response: `{ "ok": true, "data": { "reviews": [...] }, "meta": { "page", "limit", "total", "total_pages", "has_next", "has_prev" } }`.

#### PUT /api/admin/reviews/:reviewId
**Line:** 400 | **Auth:** `requireAdmin` | **Validation:** `reviewIdSchema` (params) + `moderateReviewSchema` (body)

Body: `{ "status": "approved"|"rejected", "admin_notes": "optional" }`.

---

### 4.9 Business Accounts

**File:** `src/routes/business.js`

#### POST /api/business/apply
**Line:** 24 | **Auth:** `requireAuth` | **Rate Limit:** `businessLimiter` 3/hour per user (L12-19) | **Validation:** `businessApplicationSchema` (body)

Body: `{ "company_name", "nzbn" (optional), "contact_name", "contact_email", "contact_phone" (optional), "estimated_monthly_spend" (optional), "industry" (optional) }`.
Returns 409 if pending/approved application exists.

#### GET /api/business/status
**Line:** 99 | **Auth:** `requireAuth`

Returns `{ status, account_type, business_details, application, can_apply }`.

---

### 4.10 Shipping (Zone-Based)

**File:** `src/routes/shipping.js`

#### POST /api/shipping/options
**Line:** 22 | **Auth:** None | **Validation:** `shippingOptionsSchema` (body)

Accepts two input formats. Must provide `items` or `item_count` **and** `region` or `postal_code`:

**Legacy format** (full item details, enables weight-based calculation):
```json
{
  "cart_total": 85.50,
  "items": [{ "product_id": "uuid", "quantity": 2 }],
  "region": "canterbury"
}
```

**Frontend format** (lightweight, assumes 0.5 kg per item):
```json
{
  "cart_total": 85.50,
  "item_count": 3,
  "postal_code": "8011",
  "delivery_type": "urban"
}
```

> **Validation:** `.or('items', 'item_count').or('region', 'postal_code')` — requests without a location field are now rejected (400).

`postal_code` (4-digit NZ) is resolved to a zone: 0600-2249 → Auckland, 0100-0599/2250-6999 → North Island, 7000-9999 → South Island. If `postal_code` is provided, it takes precedence over `region`.

Response includes both flat fields (backward compat) and `options` array:
```json
{
  "ok": true,
  "data": {
    "tier": "standard",
    "fee": 12,
    "zone": "south-island",
    "zone_label": "South Island",
    "eta": "2-4 business days",
    "delivery_type": "urban",
    "free_threshold": 100,
    "spend_more_for_free": 14.50,
    "options": [{ "tier": "standard", "fee": 12, "zone": "south-island", "zone_label": "South Island", "eta": "2-4 business days", "delivery_type": "urban", "free_threshold": 100, "spend_more_for_free": 14.50 }]
  }
}
```

> **Color pack override:** Orders containing CMY/KCMY/CMYK color packs are assigned a minimum effective weight of 2.0 kg, forcing the highest shipping tier for the zone regardless of actual pack weight (CMY = 0.3 kg, KCMY = 0.4 kg).

#### GET /api/shipping/rates
**Line:** 102 | **Auth:** None

Returns DB-driven zone + weight + delivery type rate table:
```json
{
  "ok": true,
  "data": {
    "free_threshold": 100,
    "currency": "NZD",
    "zones": {
      "auckland": {
        "label": "Auckland",
        "eta": "1-2 business days",
        "tiers": [
          { "tier": "standard", "delivery_type": "urban", "fee": 7, "min_weight_kg": 0, "max_weight_kg": null },
          { "tier": "standard", "delivery_type": "rural", "fee": 14, "min_weight_kg": 0, "max_weight_kg": null }
        ]
      },
      "north-island": {
        "label": "North Island",
        "eta": "1-3 business days",
        "tiers": [
          { "tier": "light", "delivery_type": "urban", "fee": 7, "min_weight_kg": 0, "max_weight_kg": 0.5 },
          { "tier": "light", "delivery_type": "rural", "fee": 14, "min_weight_kg": 0, "max_weight_kg": 0.5 },
          { "tier": "standard", "delivery_type": "urban", "fee": 12, "min_weight_kg": 0.5, "max_weight_kg": null },
          { "tier": "standard", "delivery_type": "rural", "fee": 20, "min_weight_kg": 0.5, "max_weight_kg": null }
        ]
      },
      "south-island": {
        "label": "South Island",
        "eta": "2-4 business days",
        "tiers": [
          { "tier": "light", "delivery_type": "urban", "fee": 7, "min_weight_kg": 0, "max_weight_kg": 0.5 },
          { "tier": "light", "delivery_type": "rural", "fee": 14, "min_weight_kg": 0, "max_weight_kg": 0.5 },
          { "tier": "standard", "delivery_type": "urban", "fee": 12, "min_weight_kg": 0.5, "max_weight_kg": 2.0 },
          { "tier": "standard", "delivery_type": "rural", "fee": 20, "min_weight_kg": 0.5, "max_weight_kg": 2.0 },
          { "tier": "heavy", "delivery_type": "urban", "fee": 22, "min_weight_kg": 2.0, "max_weight_kg": null },
          { "tier": "heavy", "delivery_type": "rural", "fee": 30, "min_weight_kg": 2.0, "max_weight_kg": null }
        ]
      }
    }
  }
}
```

**Note:** Rates are DB-driven from `shipping_rates` table. Auckland is flat rate (all weights same fee). North Island has 2 weight tiers (0.5 kg threshold). South Island has 3 weight tiers (0.5 kg and 2.0 kg thresholds). All tiers are broken down by delivery type (urban/rural). Color packs (CMY/KCMY) use a minimum effective weight of 2.0 kg, always hitting the highest tier per zone. Administered via `GET/POST/PUT/DELETE /api/admin/shipping/rates` endpoints.

---

### 4.11 Account Sync

**File:** `src/routes/account.js`

#### POST /api/account/sync
**Line:** 13 | **Auth:** `requireAuth`

**Frontend MUST call after every OAuth/email login.** Idempotent.
Creates profile if missing, fills empty fields from OAuth metadata.
Returns `{ ...profile, email, created: true|false }`.

#### GET /api/account/me
**Line:** 101 | **Auth:** `requireAuth`

Returns `{ id, email, email_verified, profile, is_admin, roles }`.
Single endpoint for frontend to get everything after login.

---

### 4.12 Newsletter

**File:** `src/routes/newsletter.js`
**Rate limit:** 3/hour (`newsletterLimiter`, L10-16)
**Bot protection:** Cloudflare Turnstile (when `TURNSTILE_SECRET_KEY` is configured)

#### POST /api/newsletter/subscribe
**Line:** 25 | **Auth:** None | **Validation:** `newsletterSubscribeSchema` (body) | **Middleware:** `verifyTurnstile`

Body: `{ "email": "user@example.com", "source": "optional", "turnstile_token": "cf-token-here" }`.

**Turnstile integration (NEW):** When `TURNSTILE_SECRET_KEY` is configured on the backend, the `turnstile_token` field is **required**. The backend verifies the token with Cloudflare before processing. If Turnstile is not configured (dev/staging), the field is optional and verification is skipped. See **Section 8 — Turnstile Integration** for frontend setup.

Returns 200 for both new and duplicate subscriptions. Response message is always `"Thank you for subscribing!"` regardless of whether the email was new or already existed (security: prevents email enumeration).

**Turnstile error responses:**
- `400 { "code": "TURNSTILE_MISSING", "message": "Bot verification token is required" }` — token not provided
- `403 { "code": "TURNSTILE_FAILED", "message": "Bot verification failed. Please try again." }` — token invalid/expired

---

### 4.13 Contact

**File:** `src/routes/contact.js`
**Rate limit:** 3/hour (`contactLimiter`, L11-17)
**Bot protection:** Cloudflare Turnstile (when `TURNSTILE_SECRET_KEY` is configured)

#### POST /api/contact
**Line:** 25 | **Auth:** None | **Validation:** `contactFormSchema` (body) | **Middleware:** `verifyTurnstile`

Body: `{ "name", "email", "subject", "message", "turnstile_token": "cf-token-here" }`.
Optional fields: `phone`, `order_number`, `turnstile_token`.

**Turnstile integration (NEW):** Same as newsletter — when configured, `turnstile_token` is required. See **Section 8 — Turnstile Integration** for frontend setup.

Queues email to support team only. No auto-reply is sent to the customer (security: prevents email relay abuse via attacker-supplied addresses). The HTTP response confirms receipt.

**Turnstile error responses:**
- `400 { "code": "TURNSTILE_MISSING", "message": "Bot verification token is required" }` — token not provided
- `403 { "code": "TURNSTILE_FAILED", "message": "Bot verification failed. Please try again." }` — token invalid/expired

#### GET /api/email/unsubscribe
**Line:** 87 | **Auth:** None (HMAC token-based)

Query: `token`, `type` (`cart_recovery`/`marketing`).
Renders HTML confirmation page. Token verified via HMAC.

---

### 4.14 Settings (Public)

**File:** `src/routes/settings.js`

#### GET /api/settings
**Line:** 9 | **Auth:** None

Returns:
```json
{
  "ok": true,
  "data": {
    "FREE_SHIPPING_THRESHOLD": 100,
    "shipping": {
      "free_threshold": 100,
      "currency": "NZD",
      "zones": {
        "auckland": {
          "label": "Auckland",
          "eta": "1-2 business days",
          "tiers": [
            { "tier": "standard", "delivery_type": "urban", "fee": 7, "min_weight_kg": 0, "max_weight_kg": null },
            { "tier": "standard", "delivery_type": "rural", "fee": 14, "min_weight_kg": 0, "max_weight_kg": null }
          ]
        },
        "north-island": { "label": "North Island", "eta": "1-3 business days", "tiers": [{ "tier": "light", "fee": 7, ... }, { "tier": "standard", "fee": 12, ... }] },
        "south-island": { "label": "South Island", "eta": "2-4 business days", "tiers": [{ "tier": "light", "fee": 7, ... }, { "tier": "standard", "fee": 12, ... }, { "tier": "heavy", "fee": 22, ... }] }
      }
    },
    "LOW_STOCK_THRESHOLD": 10,
    "CRITICAL_STOCK_THRESHOLD": 2,
    "GST_RATE": 0.15,
    "CURRENCY": "NZD",
    "COUNTRY": "NZ",
    "FEATURES": { "business_accounts_enabled": true, "guest_checkout_enabled": false }
  }
}
```

**Note:** `shipping` is a DB-driven rate table from `shipping_rates`. Rates include zone, tier, weight bracket, and delivery type (urban/rural). The old flat `SHIPPING_FEE_*` constants are no longer returned — use `shipping.zones` instead.

---

### 4.15 Cart Analytics

**File:** `src/routes/cartAnalytics.js`
**Rate limit (events):** 30/min (`analyticsEventLimiter`, L11-17)

#### POST /api/analytics/cart-event
**Line:** 22 | **Auth:** None | **Validation:** `cartAnalyticsEventSchema` (body)

Body: `{ "event_type", "product_id" (optional), "quantity" (optional), "session_id" (optional) }`.

Accepted `event_type` values: `"add_to_cart"` | `"remove_from_cart"` | `"checkout_started"` | `"checkout_completed"` | `"cart_viewed"` | `"payment_started"`.

#### GET /api/analytics/cart-summary
**Line:** 60 | **Auth:** `requireAdmin`

Query: `period` (format: `Nd` e.g. `7d`, `30d`, `90d` — default `30d`).
Response: `{ total_carts, abandoned_carts, completed_carts, conversion_rate, average_cart_value, period }`.

#### GET /api/analytics/abandoned-carts
**Line:** 134 | **Auth:** `requireAdmin`

Query: `page` (default 1), `limit` (default 20), `min_value` (float, filters carts with value >= this amount, default 0).

#### GET /api/analytics/marketing
**Line:** 213 | **Auth:** `requireAdmin`

Query: `period` (default `30d`).

---

### 4.16 Webhooks

**File:** `src/routes/webhooks.js`
**Rate limit:** 200/min (`webhookLimiter`, L12-18)
**Timeout:** 60s (via `requestTimeout.js` — longer than the default 15s to accommodate Stripe processing)

#### POST /api/webhooks/payment
**Line:** 26 | **Auth:** Stripe signature verification

**Not called by frontend.** Stripe sends events here.
Raw body middleware configured in `src/server.js:189` BEFORE `express.json()`.
Error responses use the standard `formatError()` envelope (`{ ok: false, error: { code, message } }`) for monitoring consistency.

Handled events:
| Event | Action |
|-------|--------|
| `payment_intent.succeeded` | Mark order `paid`, queue post-payment tasks |
| `payment_intent.payment_failed` | Cancel order + restore stock atomically |
| `payment_intent.canceled` | Cancel order + restore stock atomically |
| `charge.refunded` | Full: cancel + restore stock. Partial: log for manual review |

---

### 4.17 Admin Verify & Orders

**File:** `src/routes/admin.js`

#### GET /api/admin/verify
`admin.js:124` | **Auth:** `requireAdmin`
Returns admin role info (`is_admin`, `role`, `roles`, `email`). Used by frontend to confirm admin access on load.

#### GET /api/admin/orders
`admin.js:144` | **Auth:** `requireAdmin` + `adminUserLimiter` (30/min per user) + `requireRole('super_admin', 'order_manager')`
Query: `page` (default 1), `limit` (default 50), `status` (comma-separated, e.g. `paid,processing`), `search`, `customer_email`, `date_from`, `date_to`, `sort` (`newest`/`oldest`/`total-high`/`total-low`). **Validation:** `adminOrderQuerySchema`.

**`search` field:** Searches across `order_number`, `email`, and `shipping_recipient_name` (case-insensitive partial match on all three).

**Response shape — `data` is a raw array, NOT `{ orders: [...] }`:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "uuid",
      "order_number": "ORD-abc123-ff00",
      "status": "paid",
      "total": 129.95,
      "subtotal": 113.00,
      "shipping_cost": 7,
      "created_at": "2026-02-27T10:00:00Z",
      "paid_at": "2026-02-27T10:01:00Z",
      "customer_name": "John Smith",
      "customer_email": "john@example.com",
      "items_count": 3,
      "items": [
        {
          "id": "uuid",
          "name": "HP 65XL Black",
          "sku": "HP-65XL-BK",
          "quantity": 2,
          "price": 42.99,
          "line_total": 85.98,
          "image_url": "https://...supabase.co/.../main.jpg"
        }
      ]
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "total_pages": 3,
    "has_next": true,
    "has_prev": false
  }
}
```

**Note:** `customer_name` is derived from user profile first/last name, falling back to `shipping_recipient_name`, then `email`. `customer_email` comes from the order `email` field. Both are flat fields — no nested object traversal needed.

#### GET /api/admin/orders/:orderId
`admin.js:303` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')` | **Validation:** `adminOrderIdSchema` (params)

Returns a single order with full detail: all fields from the list endpoint plus `admin_notes`, `shipping_tier`, `shipping_fee`, `delivery_zone`, `estimated_delivery_days_min`, `estimated_delivery_days_max`, `paid_at`, `shipped_at`, `completed_at`, `cancelled_at`. Includes flat `customer_name` and `customer_email` (same logic as list endpoint). Items are transformed the same way as the list handler. Response: `{ "ok": true, "data": { "order": ... } }`. Returns 404 if order not found.

#### PUT /api/admin/orders/:orderId
`admin.js:434` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')`
Body (at least one field required): `{ "status", "carrier", "tracking_number", "shipped_at", "admin_notes", "confirm_processing_cancellation" }`. **Validation:** `updateOrderStatusSchema` (body, `.min(1)`) + `adminOrderIdSchema` (params).

- **`status` is optional** — omit it to update metadata only (carrier, tracking) without a state transition
- `carrier` (string, max 100) — e.g. "NZ Post", "CourierPost"
- `shipped_at` (ISO date string) — overrides auto-set timestamp when status → shipped
- If `status` is provided, validates state machine transitions. Cancellation uses atomic `cancel_order_restore_stock()` RPC
- Cancelling a `processing` order requires `confirm_processing_cancellation: true`
- Atomic status check prevents race conditions (returns 409 if status changed)
- Response includes `carrier` and `delivered_at` fields

#### GET /api/admin/orders/:orderId/events
`admin.js:2354` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')` | **Validation:** `adminOrderIdSchema` (params)
Returns the audit trail for an order, sorted newest first. Includes trigger-generated events (status changes, refund creation) and manual notes.
Response: `{ "ok": true, "data": [{ "id", "type", "created_at", "actor_id", "payload" }] }`.
Event types: `status_change` (auto), `refund_created` (auto), `note` (manual).

#### POST /api/admin/orders/:orderId/events
`admin.js:2392` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')` | **Validation:** `adminOrderIdSchema` (params) + `createOrderEventSchema` (body)
Creates a manual note on an order. Body: `{ "type": "note", "payload": { "note": "string" } }`.
Sets `actor_id` to the authenticated user's UUID. Returns 201 with the created event.

---

### 4.17b Admin Refunds

**File:** `src/routes/admin.js`
**Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')`

#### GET /api/admin/refunds
`admin.js:2436` | **Validation:** `adminRefundQuerySchema` (query)
Query: `page` (default 1), `limit` (default 20), `dateFrom` (YYYY-MM-DD), `dateTo` (YYYY-MM-DD), `type` (`refund`/`chargeback`), `status` (`pending`/`processed`/`failed`), `search` (searches order number and reason note).
Response: `{ "ok": true, "data": { "refunds": [...] }, "meta": { "total", "page", "limit", "total_pages", "has_next", "has_prev" } }`.
Each refund includes `order_number` (joined from orders table).

#### POST /api/admin/refunds
`admin.js:2513` | **Validation:** `createRefundSchema` (body)
Body: `{ "order_id" (UUID), "type" ("refund"/"chargeback"), "amount" (positive number), "reason_code", "reason_note" (optional) }`.
Valid `reason_code` values: `damaged`, `wrong_item`, `not_received`, `defective`, `customer_request`, `duplicate`, `fraud`, `other`.

**Validation rules:**
- `amount` must be <= order total
- **10-minute full refund rule:** if `amount` equals order total and order is older than 10 minutes, returns 400
- Sets `processed_by` to authenticated user's UUID

Returns 201 with the created refund.

#### PUT /api/admin/refunds/:refundId
`admin.js:2572` | **Validation:** `refundIdSchema` (params) + `updateRefundSchema` (body)
Body: `{ "status": "processed" | "failed" }`.
Only `pending` refunds can be updated. When status → `processed`, sets `refunded_at` to now and `processed_by` to auth user. Returns the updated refund.

---

### 4.17c Admin CSV Export

**File:** `src/routes/admin.js`

#### GET /api/admin/export/:type
`admin.js:2623` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')` | **Validation:** `adminExportTypeSchema` (params) + `adminExportQuerySchema` (query)
Path param: `orders` or `refunds`. Query: `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `statuses` (comma-separated).
Response: `Content-Type: text/csv` with `Content-Disposition: attachment` header.

**Orders CSV columns:** `Order Number, Date, Customer Name, Customer Email, Status, Items, Total, Carrier, Tracking Number, Shipped At`
**Refunds CSV columns:** `Refund ID, Order Number, Type, Amount, Status, Reason, Note, Created At, Processed At`

---

### 4.17d Admin Dashboard Supabase RPC Functions

These are called directly by the admin frontend via `POST /rest/v1/rpc/{function_name}` with the user's auth token. They run in Supabase Postgres, not through the Express backend.

**Migration files (historical, already applied to Supabase):** `001_admin_dashboard_schema.sql`, `002_admin_rpc_functions.sql`

#### RLS Helper Functions
- `is_admin_or_owner()` — returns true if caller has any role in `admin_roles` (`super_admin`, `stock_manager`, `order_manager`)
- `is_owner()` — returns true if caller has `super_admin` role

#### admin_work_queue()
**Access:** `is_admin_or_owner()` | Returns: `{ orders_to_ship, missing_tracking, refunds_pending, late_deliveries, cancellations }`

#### analytics_fulfillment_sla(date_from TEXT, date_to TEXT, supplier_filter TEXT DEFAULT NULL)
**Access:** `is_owner()` | Returns: `{ median_hours, pct_48h, tracking_coverage }`

#### analytics_kpi_summary(date_from, date_to, brand_filter, supplier_filter, status_filter)
**Access:** `is_owner()` | Returns: `{ current: { revenue, orders, aov, refund_rate, chargeback_rate, margin_proxy, sla_48h, volatility }, previous: { ... } }`

#### analytics_revenue_series(date_from, date_to, brand_filter, supplier_filter)
**Access:** `is_owner()` | Returns: `{ series: [{ date, revenue, orders, aov, is_anomaly }], previous_series: [{ date, revenue, orders, aov }] }`

#### analytics_brand_breakdown(date_from, date_to, metric, supplier_filter, status_filter)
**Access:** `is_owner()` | Returns: `{ brands: [{ brand, current_revenue, previous_revenue, current_orders, previous_orders }] }`

#### analytics_refunds_series(date_from, date_to, brand_filter)
**Access:** `is_owner()` | Returns: `{ series: [{ date, refund_count, total_orders, total_amount }], reasons: [{ reason_code, reason, count, amount }] }`

#### get_suppliers()
**Access:** `is_admin_or_owner()` | Returns: `[{ name, id }]` (active suppliers only)

#### New Database Tables
| Table | Purpose |
|-------|---------|
| `refunds` | Refund/chargeback records with `refund_type`/`refund_status` enums |
| `order_events` | Audit trail (status changes, notes, refund creation) |
| `suppliers` | Supplier reference data for filter dropdowns |

#### New Columns on Existing Tables
| Table | Column | Type |
|-------|--------|------|
| `orders` | `carrier` | TEXT |
| `orders` | `delivered_at` | TIMESTAMPTZ |
| `order_items` | `supplier_cost_snapshot` | NUMERIC |
| `order_items` | `shipping_cost_snapshot` | NUMERIC |
| `order_items` | `supplier_id` | UUID |
| `order_items` | `brand` | TEXT |
| `order_items` | `category` | TEXT |

---

### 4.18 Admin Products

**File:** `src/routes/admin.js`

#### GET /api/admin/products
`admin.js:699` | **Auth:** `requireAdmin`
Query: `page`, `limit`, `search`, `brand` (slug), `is_active` (true/false). **Validation:** `adminProductQuerySchema`.
Returns all products (including inactive) with cost_price, pagination metadata, and computed `in_stock`/`is_low_stock` flags.

#### GET /api/admin/products/diagnostics
`admin.js:812` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
Returns product count diagnostics. Helps identify why database count differs from API returned count.

**Response shape:**
```json
{
  "ok": true,
  "data": {
    "summary": {
      "total_in_database": 450,
      "active_products": 420,
      "inactive_products": 30,
      "discrepancy": 30,
      "public_api_returns": 420,
      "explanation": "..."
    },
    "by_product_type": [
      { "product_type": "ink_cartridge", "count": 200 }
    ],
    "inactive_products": [
      { "id": "uuid", "sku": "HP-OLD-1", "name": "...", "is_active": false, "created_at": "ISO", "updated_at": "ISO" }
    ],
    "filters_applied_by_public_api": ["is_active = true", "..."]
  }
}
```

#### POST /api/admin/products/bulk-activate
`admin.js:893` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
Body: `{ "product_ids": [...], "activate_all": false, "dry_run": true }`. **Validation:** `bulkActivateSchema`.
Default is dry run — set `dry_run: false` to actually activate. Can target specific IDs or all inactive products.

**Dry run response** (`dry_run: true`, default):
```json
{
  "ok": true,
  "data": {
    "dry_run": true,
    "message": "Would activate 5 products",
    "products": [
      { "id": "uuid", "sku": "HP-OLD-1", "name": "..." }
    ]
  }
}
```

**Live response** (`dry_run: false`):
```json
{
  "ok": true,
  "data": {
    "message": "Activated 5 products",
    "activated": 5,
    "products": [
      { "id": "uuid", "sku": "HP-OLD-1", "name": "..." }
    ]
  }
}
```

#### PUT /api/admin/products/by-sku/:sku
`admin.js:962` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
Body: `{ "retail_price", "stock_quantity", "is_active" }`. **Validation:** `updateProductSchema` (body) + `productSkuSchema` (params).
Partial update by SKU — only provided fields are updated.

#### GET /api/admin/products/:productId
`admin.js:1029` | **Auth:** `requireAdmin`
**Validation:** `adminProductIdSchema` (params — UUID).
Returns full product details including `images[]` (with `path`, `alt_text`, `is_primary`, `sort_order`), `compatible_printers[]`, all fields (cost_price, meta fields, specifications, etc.). `image_url` is resolved to a full URL by the backend.

#### PUT /api/admin/products/:productId
`admin.js:1128` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
Body: full product fields including `name`, `description`, `brand_id`, `product_type`, `color`, `source`, `page_yield`, `retail_price`, `compare_price`, `cost_price`, `stock_quantity`, `low_stock_threshold`, `is_active`, `track_inventory`, `compatible_printer_ids[]`, `meta_title`, `meta_description`, `meta_keywords`. **Validation:** `fullProductUpdateSchema` (body) + `adminProductIdSchema` (params — UUID). Valid `product_type` values: `ink_cartridge`, `ink_bottle`, `toner_cartridge`, `drum_unit`, `waste_toner`, `belt_unit`, `fuser_kit`, `fax_film`, `fax_film_refill`, `ribbon`, `label_tape`, `photo_paper`, `printer`.
Full product update by UUID. Also updates `product_compatibility` junction table if `compatible_printer_ids` is provided.

**Response returns a subset of fields, NOT the full product object:**
```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "sku": "HP-65XL-BK",
    "name": "HP 65XL Black Ink Cartridge",
    "brand": { "id": "uuid", "name": "HP", "slug": "hp" },
    "retail_price": 42.99,
    "stock_quantity": 50,
    "is_active": true,
    "updated_at": "2026-02-27T10:00:00Z"
  }
}
```
**Tip:** If the frontend needs all fields after an update (e.g. `images[]`, `compatible_printers[]`, `specifications`), re-fetch the full product detail via `GET /api/admin/products/:productId`.

#### POST /api/admin/products/:productId/images
`admin.js:1255` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
Multipart form with `image` field (via `multer`, max 5MB, JPEG/PNG/WebP/GIF). **Validation:** `adminProductIdSchema` (params — UUID).
Uploads image to `public-assets` bucket. First image is automatically set as primary. Magic byte validation ensures file content matches claimed MIME type.

**Request:** `multipart/form-data` — only the `image` field is required. Do **not** manually set `Content-Type` (browser sets it with boundary for FormData). Additional fields (`alt_text`, `is_primary`, `sort_order`) are set automatically by the backend.

**File constraints:**
- Max size: **5 MB**
- Allowed types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- Magic bytes validated — renaming a non-image file will be rejected

**Storage path:** `images/products/{sku}/{sku}-{timestamp}.{ext}`

**Success response (201):**
```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "path": "images/products/SKU123/SKU123-1709012345678.jpg",
    "alt_text": null,
    "image_url": "https://xxxx.supabase.co/storage/v1/object/public/public-assets/images/products/SKU123/SKU123-1709012345678.jpg",
    "is_primary": true,
    "sort_order": 0
  }
}
```

**Error responses:**

| Status | Message | Cause |
|--------|---------|-------|
| 400 | `No image file provided` | Missing `image` field in form data |
| 400 | `File content does not match claimed image type` | Magic byte validation failed |
| 400 | `Invalid file type...` | MIME type not in allowlist |
| 404 | `Product not found` | Invalid `productId` |
| 500 | `Failed to upload image` | Supabase Storage upload failed |
| 500 | `Failed to save image record` | DB insert into `product_images` failed |

**Frontend example:**
```javascript
const formData = new FormData();
formData.append('image', file); // File or Blob

const response = await fetch(`${API_BASE}/admin/products/${productId}/images`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});
```

#### DELETE /api/admin/products/:productId/images/:imageId
`admin.js:1364` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
**Validation:** `imageIdSchema` (params). Deletes image from `public-assets` bucket and database. If deleted image was primary, promotes next image (by `sort_order`). If no images remain, `products.image_url` is set to `null`.

#### PUT /api/admin/products/:productId/images/reorder
`admin.js:1445` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
Body: `{ "images": [{ "id": "uuid", "sort_order": int, "is_primary": bool }] }`. **Validation:** `imageReorderSchema` (body) + `adminProductIdSchema` (params).
Exactly one image must be marked `is_primary: true` — returns 400 otherwise.
Reorders images by setting `sort_order` and `is_primary` based on provided values. Response includes updated `images[]` array with `id`, `path`, `alt_text`, `is_primary`, `sort_order`.

---

### 4.19 Admin Business Applications

**File:** `src/routes/admin.js`
**Auth:** `requireAdmin` + `requireRole('super_admin')`

#### GET /api/admin/business-applications
`admin.js:2003` | Query: `page`, `limit`, `status`. **Validation:** `adminBusinessApplicationQuerySchema`.

#### GET /api/admin/business-applications/:applicationId
`admin.js:2076` | **Validation:** `adminBusinessApplicationIdSchema` (params).

#### PUT /api/admin/business-applications/:applicationId
`admin.js:2149` | Body: `{ "status": "approved"|"rejected", "notes" }`. **Validation:** `updateBusinessApplicationSchema`.
On approval: updates `user_profiles` to `account_type: 'business'` and sends status email via `sendBusinessApplicationStatusEmail()`.

#### GET /api/admin/business-applications-stats
`admin.js:2250` | Returns application statistics (counts by status, recent applications).

---

### 4.19b Admin Customers

**File:** `src/routes/admin.js`

#### GET /api/admin/customers
`admin.js:1885` | **Auth:** `requireAdmin` + `requireRole('super_admin', 'order_manager')` | **Validation:** `adminCustomerQuerySchema` (query)
Query params: `page` (int, min 1), `limit` (int, 1-500, default 50), `search` (string, max 200), `sort` (`created_at`/`first_name`/`last_name`, default `created_at`), `order` (`asc`/`desc`, default `desc`).

Response: `{ "ok": true, "data": { "customers": [...] }, "meta": { "total", "page", "limit", "total_pages", "has_next", "has_prev" } }`.
Each customer includes: `id`, `full_name`, `email`, `phone`, `created_at`, `order_count`, `total_spent`, `account_type`.

---

### 4.19d Admin Ribbons

**File:** `src/routes/adminRibbons.js`
**Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')` on all endpoints

Admin CRUD for ribbons. Ribbons are stored in the `products` table with `product_type='ribbon'` — these endpoints filter on that type. **Note:** Label tapes (`product_type='label_tape'`) are a separate type and are NOT included in these endpoints. Includes sensitive fields hidden from public routes (`cost_price`, `margin_percent`).

#### GET /api/admin/ribbons
`adminRibbons.js:54` | **Validation:** `adminRibbonQuerySchema` (query)

Query params:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | int | 1 | Page number (min 1) |
| limit | int | 50 | Items per page (1–500) |
| search | string | — | Search across SKU and name |
| brand | string | — | Filter by brand (case-insensitive, via brands FK) |
| is_active | string | — | `'true'` or `'false'` — omit for all |
| sort | string | name | `name`, `brand`, `price`, `stock`, `created` |

Returns all ribbons (including inactive) with admin fields: `cost_price`, `margin_percent` (computed), `source`, `weight_kg`. Standard pagination metadata.

Response:
```json
{
  "ok": true,
  "data": {
    "ribbons": [{
      "id": "uuid",
      "sku": "655.02",
      "name": "Epson ERC-30/34/38 Printer Ribbon",
      "brand": "Epson",
      "color": "Black/Red",
      "cost_price": 8.50,
      "sale_price": 14.74,
      "margin_percent": 73.41,
      "stock_quantity": 100,
      "is_active": true,
      "image_path": "images/ribbons/655-02/main.png",
      "source": "genuine",
      "weight_kg": 0.1,
      "created_at": "ISO",
      "updated_at": "ISO"
    }]
  },
  "meta": { "page": 1, "limit": 50, "total": 95, "total_pages": 2, "has_next": true, "has_prev": false }
}
```

#### GET /api/admin/ribbons/:ribbonId
`adminRibbons.js:141` | **Validation:** `adminRibbonIdSchema` (params — UUID)

Returns full ribbon detail with all admin fields plus `compatible_devices[]` from `ribbon_compatibility` join (includes `device_brand`, `device_model`, `match_type`, `confidence`, `source_name`). Returns 404 if not found.

#### PUT /api/admin/ribbons/:ribbonId
`adminRibbons.js:195` | **Validation:** `adminRibbonIdSchema` (params) + `updateRibbonSchema` (body, `.min(1)`)

Body (all optional, at least one required): `name`, `color`, `sale_price`, `stock_quantity`, `is_active`, `image_path`.

Only provided fields are updated. `sale_price` maps to `retail_price` in the DB, `image_path` maps to `image_url`. Logs admin action to console. Returns 404 if ribbon doesn't exist.

#### POST /api/admin/ribbons
`adminRibbons.js:269` | **Validation:** `createRibbonSchema` (body)

Body:
| Field | Required | Description |
|-------|----------|-------------|
| sku | yes | Uppercased automatically |
| name | yes | Display name |
| brand | yes | Brand name (looked up via `brands` table) |
| cost_price | yes | Cost price (ex-GST) |
| sale_price | yes | Retail price (inc-GST) |
| color | no | Color description |
| stock_quantity | no | Default 0 |
| is_active | no | Default true |
| image_path | no | Image path |

Creates a product with `product_type='ribbon'`, `source='genuine'`, and deterministic `weight_kg=0.1`. Returns 400 if brand not found, 409 on duplicate SKU, 201 on success.

#### DELETE /api/admin/ribbons/:ribbonId
`adminRibbons.js:337` | **Validation:** `adminRibbonIdSchema` (params)

Soft delete only — sets `is_active: false`. Idempotent: returns success message if already inactive. Returns 404 if ribbon doesn't exist.

---

### 4.19e Admin Shipping Rates

**File:** `src/routes/adminShipping.js`
**Auth:** `requireAdmin` + `requireRole('super_admin', 'stock_manager')` on all endpoints

Admin CRUD for DB-driven shipping rates. Changes are reflected immediately in `POST /api/shipping/options` and `GET /api/shipping/rates` (cache invalidated on write).

**Fields:** `id`, `zone`, `zone_label`, `tier_name`, `min_weight_kg`, `max_weight_kg`, `delivery_type`, `fee`, `eta_min_days`, `eta_max_days`, `is_active`, `created_at`, `updated_at`

#### GET /api/admin/shipping/rates
`adminShipping.js:66` | **Validation:** `adminShippingRateQuerySchema` (query)

Query params:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | int | 1 | Page number (min 1) |
| limit | int | 50 | Items per page (1–500) |
| zone | string | — | Filter by zone (`auckland`, `north-island`, `south-island`) |
| delivery_type | string | — | `urban` or `rural` |
| is_active | string | — | `'true'` or `'false'` |

Returns all shipping rates with pagination.

#### GET /api/admin/shipping/rates/:rateId
**Validation:** `adminShippingRateIdSchema` (params — UUID)
Returns a single rate by ID.

#### POST /api/admin/shipping/rates
**Validation:** `createShippingRateSchema` (body)

Body:
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| zone | yes | — | Zone key (e.g. `auckland`) |
| zone_label | yes | — | Display label (e.g. `Auckland`) |
| tier_name | yes | — | Tier name (e.g. `standard`, `heavy`) |
| min_weight_kg | no | 0 | Minimum weight in kg |
| max_weight_kg | no | null | Maximum weight (null = unlimited) |
| delivery_type | yes | — | `urban` or `rural` |
| fee | yes | — | Shipping fee in NZD |
| eta_min_days | no | 1 | Minimum delivery days |
| eta_max_days | no | 3 | Maximum delivery days |
| is_active | no | true | Whether rate is active |

Returns 201 with the created rate. Invalidates shipping rate cache.
Returns **409** if the weight range overlaps an existing active rate in the same zone + delivery_type. Error message includes the conflicting rate's tier name and weight range.
Response `meta` may include `gap_warnings` (string array) if weight ranges for this zone+delivery_type are non-contiguous after creation.

#### PUT /api/admin/shipping/rates/:rateId
**Validation:** `adminShippingRateIdSchema` (params) + `updateShippingRateSchema` (body, `.min(1)`)
Partial update — only provided fields are changed. Invalidates shipping rate cache.
Returns **409** if the updated weight range would overlap another active rate in the same zone + delivery_type (excluding the rate being updated).
Response `meta` may include `gap_warnings` (string array) if weight ranges are non-contiguous after update.

#### DELETE /api/admin/shipping/rates/:rateId
**Validation:** `adminShippingRateIdSchema` (params)
Soft delete (sets `is_active: false`). Idempotent. Invalidates shipping rate cache.
Response `meta` may include `gap_warnings` (string array) if deactivation creates a gap in weight coverage.

---

### 4.19c Admin Cron & Recovery (Backend-Only)

**File:** `src/routes/admin.js`
**Auth:** `verifyCronAuth` (CRON_SECRET header, not frontend-accessible)

These endpoints are called by scheduled cron jobs, not by the frontend. Documented for completeness.

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| POST | `/api/admin/cron/cleanup-emails` | L1557 | Clean stuck email queue entries. Body: `{ "max_age_hours": int }` (1–168, default 24). Validated by `cronCleanupEmailsSchema`. |
| POST | `/api/admin/cron/process-emails` | L1574 | Process pending email queue |
| POST | `/api/admin/cron/cleanup-data` | L1590 | Clean expired sessions, old carts |
| POST | `/api/admin/cron/reconcile-payments` | L1656 | Reconcile Stripe payments with orders |
| POST | `/api/admin/cron/retry-post-payment` | L1674 | Retry failed post-payment tasks |
| POST | `/api/admin/cron/cart-recovery` | L2322 | Send abandoned cart recovery emails |
| POST | `/api/admin/cron/cleanup-guest-carts` | L2338 | Remove expired guest carts |
| POST | `/api/admin/cron/daily-product-import` | L3096 | Run full import pipeline (genuine → compatible → ribbons). Returns per-script results. 200 on full success, 207 on partial failure. |
| POST | `/api/admin/import/genuine` | L2946 | Trigger genuine products import (DSNZ.xlsx). 10-min timeout. 409 if already running. **400 if body is non-empty.** |
| POST | `/api/admin/import/compatible` | L2996 | Trigger compatible products import (Augmento.xlsx). 10-min timeout. 409 if already running. **400 if body is non-empty.** |
| POST | `/api/admin/import/ribbons` | L3046 | Trigger ODS ribbon import (RIBBONS Streamline.ods). 10-min timeout. 409 if already running. |
| GET | `/api/admin/recovery/health-check` | L1610 | System health check |
| POST | `/api/admin/recovery/fix-missing-invoices` | L1623 | Fix orders missing invoice numbers |
| POST | `/api/admin/recovery/cancel-stale-orders` | L1638 | Cancel unpaid orders past threshold (1h default, runs every 30min via cron) |
| GET | `/api/admin/recovery/data-integrity-audit` | L1690 | Run full data integrity audit |

---

### 4.20 Admin Analytics (Legacy)

**File:** `src/routes/analytics.js`
**Auth:** `requireAdmin`

| Method | Path | Line | Validation |
|--------|------|------|-----------|
| GET | `/api/analytics/overview` | L38 | `analyticsOverviewSchema` |
| GET | `/api/analytics/top-products` | L79 | `analyticsTopProductsSchema` |
| GET | `/api/analytics/attach-rate` | L123 | `analyticsAttachRateSchema` |
| GET | `/api/analytics/genuine-vs-compatible` | L181 | `analyticsGenuineCompatibleSchema` |
| GET | `/api/analytics/customer-behavior` | L266 | `analyticsCustomerBehaviorSchema` |
| GET | `/api/analytics/b2b-opportunities` | L328 | `analyticsB2BOpportunitiesSchema` |
| GET | `/api/analytics/stock-coverage` | L373 | `analyticsStockCoverageSchema` |
| GET | `/api/analytics/pricing-intelligence` | L433 | `analyticsPricingIntelligenceSchema` |
| POST | `/api/analytics/refresh` | L539 | None |

---

### 4.21 Admin Analytics (New Dashboards)

**File:** `src/routes/adminAnalytics.js`
**Auth:** `requireAdmin`

**Top Products:**
- `GET /api/admin/analytics/top-products` — L2105 | **Validation:** `analyticsTopProductsSchema` (query). Query: `metric` (`revenue`/`units`/`profit`/`margin_pct`), `productType`, `compatibilityType`, `days` (default 30), `limit` (default 10). Returns `{ metric, productType, compatibilityType, days, products: [...] }`. Mirrors `/api/analytics/top-products`.

> **Note:** The `products` array is returned directly from the `get_top_products` Supabase RPC function. Expected fields:
> ```json
> { "name": "HP 65XL Black", "sku": "HP-65XL-BK", "units_sold": 42, "total_revenue": 1259.58, "stock_quantity": 15, "in_stock": true }
> ```
> Exact fields depend on the RPC definition in Supabase.

**Summary (5 endpoints):**
- `GET /api/admin/analytics/summary/financial` — L249
- `GET /api/admin/analytics/summary/customers` — L260
- `GET /api/admin/analytics/summary/operations` — L271
- `GET /api/admin/analytics/summary/executive` — L284 (aggregates the above 3)
- `GET /api/admin/analytics/overview` — L2004 | Query: `days` or `timeRange` (default 7). Returns `{ grossProfit, netProfit, refundRate, avgFulfilmentTime, revenueSparkline[], ordersSparkline[], revenueTrend: { direction, change }, ordersTrend: { direction, change } }`

**Financial (8 endpoints):**
- `GET /api/admin/analytics/pnl` — L325 | **Validation:** `analyticsPnlQuerySchema` (query). Query: `start_date` (ISO date), `end_date` (ISO date), `granularity` (`daily`/`monthly`)
- `GET /api/admin/analytics/cashflow` — L404 | **Validation:** `analyticsCashflowQuerySchema` (query). Query: `months` (1-24, default 6), `projections` (boolean, default false)
- `GET /api/admin/analytics/burn-runway` — L493
- `GET /api/admin/analytics/daily-revenue` — L536 | **Validation:** `analyticsDailyRevenueQuerySchema` (query). Query: `days` (1-365, default 30)
- `GET /api/admin/analytics/forecasts` — L581 | Linear trend projection
- `POST /api/admin/analytics/expenses` — L626 | **Validation:** `analyticsCreateExpenseSchema` (body). Body: `{ category, amount, description, date, recurring, recurring_frequency }`
- `GET /api/admin/analytics/expenses` — L666 | Query: `start_date`, `end_date`, `category`, `limit`
- `GET /api/admin/analytics/expense-categories` — L701

**Customer Intelligence (9 endpoints):**
- `GET /api/admin/analytics/customer-ltv` — L725 | Query: `sort_by`, `limit`
- `GET /api/admin/analytics/cac` — L787 | Query: `months`, `channel`
- `GET /api/admin/analytics/ltv-cac-ratio` — L839
- `GET /api/admin/analytics/cohorts` — L888 | Query: `months`, `metric`
- `GET /api/admin/analytics/churn` — L962 | Query: `include_at_risk`
- `GET /api/admin/analytics/customer-health` — L1020 | Query: `status`, `sort_by`, `limit`
- `GET /api/admin/analytics/nps` — L1114
- `POST /api/admin/analytics/feedback` — L1154 | **Validation:** `analyticsCreateFeedbackSchema` (body). Body: `{ user_id, order_id, feedback_type, nps_score (0-10), rating (1-5), comment, tags[] }`
- `GET /api/admin/analytics/repeat-purchase` — L1192

**Marketing (5 endpoints):**
- `GET /api/admin/analytics/campaigns` — L1239 | Query: `status`, `channel`
- `POST /api/admin/analytics/campaigns` — L1300 | **Validation:** `analyticsCreateCampaignSchema` (body). Body: `{ name, channel, budget, start_date, end_date, target_audience, goals }`
- `POST /api/admin/analytics/marketing-spend` — L1331 | **Validation:** `analyticsMarketingSpendSchema` (body). Body: `{ campaign_id (UUID, optional), channel, amount, date, impressions, clicks, conversions }`
- `GET /api/admin/analytics/channel-efficiency` — L1387
- `GET /api/admin/analytics/conversion-funnel` — L1436. Returns `data.funnel` (array of `{ stage, count, rate }`), `data.steps` (array of `{ label, value }` with human-readable labels: "Site Visits", "Add to Cart", "Checkout Started", "Order Completed"), `data.drop_off` (`{ cart_to_checkout, checkout_to_purchase }` percentages), and `data.overall_conversion_rate`.

> **Note:** "Site Visits" is an estimate (`cart_viewed` sessions x 10, default 1000). It is not sourced from GA4. The other step values ("Add to Cart", "Checkout Started", "Order Completed") are real data from `cart_analytics_events` and `orders` tables.

**Operations (6 endpoints):**
- `GET /api/admin/analytics/inventory-turnover` — L1504 | Query: `sort_by`, `limit`
- `GET /api/admin/analytics/dead-stock` — L1572 | Query: `days_threshold`, `min_value`
- `GET /api/admin/analytics/stock-velocity` — L1632 | Query: `limit`, `sort_by`
- `GET /api/admin/analytics/inventory-cash-lockup` — L1698
- `GET /api/admin/analytics/product-performance` — L1752 | Query: `sort_by`, `limit`, `include_unprofitable`
- `GET /api/admin/analytics/page-revenue` — L1831

**Alerts (4 endpoints):**
- `GET /api/admin/analytics/alerts` — L1894 | Query: `severity`, `acknowledged` (true/false)
- `PUT /api/admin/analytics/alerts/:alertId/acknowledge` — L1927 | **Validation:** `analyticsAlertIdSchema` (params — UUID)
- `GET /api/admin/analytics/alert-thresholds` — L1953
- `PUT /api/admin/analytics/alert-thresholds/:thresholdId` — L1972 | **Validation:** `analyticsThresholdIdSchema` (params — UUID) + `analyticsUpdateThresholdSchema` (body). Body: `{ threshold_value, severity (low/medium/high/critical), is_enabled, cooldown_hours (0-720) }`

**GA4 (in `admin.js`):**
- `GET /api/admin/analytics/ga4-summary` — `admin.js:2297` | Returns GA4 event summary (admin-only, no validation schema)

---

### 4.22 Ribbons (Public)

**File:** `src/routes/ribbons.js`
**Rate limit:** 60 req/min per IP (`catalogLimiter`, L18-24)

Public endpoints for ribbon products. Ribbons are stored in the `products` table with `product_type='ribbon'` — these endpoints filter on that type. **Label tapes** (`product_type='label_tape'`) are a separate type and are NOT included in these endpoints — use `GET /api/products?type=label_tape` for label tapes. Device-level compatibility is maintained via the `ribbon_compatibility` table (separate from the `product_compatibility` junction table used by ink/toner products).

**Note:** Ribbons can also be found via `GET /api/products?type=ribbon`. These dedicated endpoints provide ribbon-specific features (device filtering, device brand/model dropdowns).

#### GET /api/ribbons
**Line:** 56 | **Auth:** None | **Validation:** `ribbonQuerySchema` (query)

Query params:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | int | 1 | Page number (min 1) |
| limit | int | 20 | Items per page (1–200) |
| search | string | — | Search across name and SKU |
| brand | string | — | Filter by brand (case-insensitive, via brands FK join) |
| color | string | — | Filter by color (case-insensitive, partial match) |
| device_brand | string | — | Filter by compatible **device** brand (uses `ribbon_compatibility` join via RPC) |
| device_model | string | — | Filter by compatible **device** model (uses `ribbon_compatibility` join via RPC) |
| sort | string | name | `price_asc`, `price_desc`, `name` |

**Device filtering:** When `device_brand` and/or `device_model` are provided, the endpoint calls the `filter_ribbons_by_device()` RPC function which joins `ribbon_compatibility` to find matching ribbon IDs. If no ribbons match the device filter, returns empty results immediately.

Response:
```json
{
  "ok": true,
  "data": {
    "ribbons": [{
      "id": "uuid",
      "sku": "655.02",
      "name": "Epson ERC-30/34/38 Printer Ribbon Black/Red",
      "brand": "Epson",
      "color": "Black/Red",
      "sale_price": 14.74,
      "stock_quantity": 100,
      "is_active": true,
      "image_path": "images/ribbons/655-02/main.png",
      "created_at": "ISO",
      "updated_at": "ISO"
    }]
  },
  "meta": { "page": 1, "limit": 20, "total": 95, "total_pages": 5, "has_next": true, "has_prev": false }
}
```

**Breaking changes from previous version:**
- Removed fields: `model`, `ribbon_type`, `compatibility` (these were from the old standalone ribbons table)
- Sort values changed: `brand_asc`/`brand_desc` removed, use `name`/`price_asc`/`price_desc`
- `brand` is now resolved from the `brands` FK join (not a text field on the ribbons table)

#### GET /api/ribbons/brands
**Line:** 166 | **Auth:** None | **Validation:** `ribbonBrandsQuerySchema` (query)

Returns distinct brand names from active ribbon products. No query params.

Response:
```json
{
  "ok": true,
  "data": {
    "brands": ["Brother", "Citizen", "Epson", "Star Micronics", "..."]
  }
}
```

#### GET /api/ribbons/models
**Line:** 195 | **Auth:** None | **Validation:** `ribbonModelsQuerySchema` (query)

Returns distinct compatible printer model names from the `product_compatibility` junction table for ribbon products.

Query params:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| brand | string | — | Filter models by brand (case-insensitive, via brands FK) |

Response:
```json
{
  "ok": true,
  "data": {
    "models": ["LQ-350", "LX-350", "TM-U220", "..."]
  }
}
```

#### GET /api/ribbons/device-brands
**Line:** 254 | **Auth:** None | **Validation:** `ribbonDeviceBrandsQuerySchema` (query)

Returns distinct device brands from the `ribbon_compatibility` table. Each entry includes a count of how many ribbons are compatible with that brand. Designed for populating "Find ribbon by device" filter dropdowns. No query params.

Response:
```json
{
  "ok": true,
  "data": {
    "device_brands": [
      { "value": "epson", "label": "Epson", "count": 26 },
      { "value": "citizen", "label": "Citizen", "count": 51 },
      { "value": "panasonic", "label": "Panasonic", "count": 33 }
    ]
  }
}
```

- `value`: normalized brand key (lowercase) — use this when calling `GET /api/ribbons?device_brand=...`
- `label`: display name (original casing)
- `count`: number of active ribbons compatible with this device brand

#### GET /api/ribbons/device-models
**Line:** 298 | **Auth:** None | **Validation:** `ribbonDeviceModelsQuerySchema` (query)

Returns distinct device models from `ribbon_compatibility`, with ribbon count per model. Use as the second dropdown after the user selects a device brand.

Query params:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| device_brand | string | — | Filter models by device brand (normalized, e.g. `epson`) |

Response:
```json
{
  "ok": true,
  "data": {
    "device_models": [
      { "value": "lq-590", "label": "LQ-590", "brand": "Epson", "count": 2 },
      { "value": "tm-u220", "label": "TM-U220", "brand": "Epson", "count": 3 }
    ]
  }
}
```

- `value`: normalized model key — use this when calling `GET /api/ribbons?device_model=...`
- `label`: display name (original casing)
- `brand`: device brand display name
- `count`: number of active ribbons compatible with this device model

**Typical frontend flow:**
1. User selects device brand from `GET /api/ribbons/device-brands` dropdown
2. Fetch `GET /api/ribbons/device-models?device_brand=epson` to populate model dropdown
3. On selection, fetch `GET /api/ribbons?device_brand=epson&device_model=lq-590` for filtered results

#### GET /api/ribbons/:sku
**Line:** 349 | **Auth:** None | **Validation:** `ribbonSkuSchema` (params)

Returns single ribbon detail by SKU (case-insensitive, uppercased for lookup). Includes computed `in_stock` field and structured `compatible_devices` array. Returns 404 if not found or inactive.

Response includes all list fields plus:
- `in_stock`: boolean — `stock_quantity > 0`
- `compatible_devices`: array of structured compatibility entries from `ribbon_compatibility`

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "sku": "655.02",
    "name": "Epson ERC-30/34/38 Printer Ribbon Black/Red",
    "brand": "Epson",
    "color": "Black/Red",
    "sale_price": 14.74,
    "stock_quantity": 100,
    "is_active": true,
    "image_path": "images/ribbons/655.02.jpg",
    "in_stock": true,
    "compatible_devices": [
      { "brand": "Epson", "model": "TM-U220", "match_type": "exact", "confidence": 60 },
      { "brand": "Epson", "model": "TM-U230", "match_type": "unknown", "confidence": 60 }
    ],
    "created_at": "ISO",
    "updated_at": "ISO"
  }
}
```

- `compatible_devices` is always an array (empty `[]` if no structured compatibility data exists)
- `match_type`: `exact` | `series` | `family` | `unknown`
- `confidence`: 0–100 (higher = more reliable)
- Sorted by `device_brand` then `device_model` (ascending)

**Key notes:**
- Uses `setupSupabaseAdmin()` for consistent query behavior
- `cost_price` is **never** exposed
- `sale_price` includes 15% GST — display as-is
- Ribbons are stored in the `products` table with `product_type='ribbon'` — also accessible via `GET /api/products?type=ribbon`
- Label tapes (TZe, DK, CZ, HG) have `product_type='label_tape'` — they are NOT ribbons and won't appear in ribbon endpoints
- `image_path` may be a full URL or a relative path — use `storageUrl()` helper for safe resolution

---

### 4.23 Utility Endpoints

| Method | Path | File:Line | Auth | Purpose |
|--------|------|-----------|------|---------|
| GET | `/health` | `server.js:206` | None | `{ "ok": true, "data": { "message": "Server is running", "timestamp": "ISO" } }` |
| GET | `/ready` | `server.js:227` | None | `{ "ok": true/false, "data": { "ready": bool, "checks": { "db", "stripe" } } }` |
| GET | `/` | `server.js:257` | None | `{ "ok": true, "data": { "message": "Ink Cartridge E-Commerce API", "version": "v1" } }` |
| GET | `/api/docs` | `routes/index.js:29` | None | Full endpoint listing |

---

## 5. Stripe Contract

### Checkout Flow

1. Frontend calls `POST /api/orders` with items + shipping address + delivery_type
2. Backend validates stock, checks for promotional coupon (redeems atomically if present), creates Stripe PaymentIntent, creates order atomically via `create_order_atomic()` RPC
3. Backend returns `client_secret` in response
4. Frontend uses Stripe.js:
   ```js
   const stripe = Stripe(publishable_key);
   const { error } = await stripe.confirmPayment({
     elements,
     clientSecret: response.data.client_secret,
     confirmParams: { return_url: '...' }
   });
   ```
5. Stripe sends webhook to `POST /api/webhooks/payment`
6. Backend marks order as `paid` and queues post-payment tasks

### PaymentIntent Configuration (`src/routes/orders.js:427-441`)
- `amount`: Integer cents NZD (discount already subtracted)
- `currency`: `nzd`
- `automatic_payment_methods: { enabled: true }`
- `metadata`: `{ order_number, user_id }`
- Stripe idempotency key: `pi_${orderNumber}_${totalCents}` (L441)

### Webhook Security (`src/routes/webhooks.js:26-56`)
1. `STRIPE_WEBHOOK_SECRET` required in all environments (L31)
2. `stripe-signature` header required (L37)
3. `constructEvent()` verifies signature against raw body (L50)

### Webhook Idempotency (4 layers)
1. **Event-level:** `is_webhook_processed` RPC checks if Stripe event ID was already handled (L76-87)
2. **Status-based:** Skip if order already in `paid`/`processing`/`shipped`/`completed` (L139)
3. **Atomic update:** `eq('status', 'pending')` ensures only one concurrent webhook succeeds (L202)
4. **Amount verification:** PaymentIntent amount must match order total in cents (L123-136)

---

## 6. Order Lifecycle

### State Machine (`src/utils/stateMachine.js`)

```
pending ──→ paid ──→ processing ──→ shipped ──→ completed
  │           │         │
  └───────────┴─────────┴──→ cancelled
```

**Valid transitions** (L23-30):
| From | To |
|------|-----|
| pending | paid, cancelled |
| paid | processing, cancelled |
| processing | shipped, cancelled |
| shipped | completed |
| completed | *(terminal)* |
| cancelled | *(terminal)* |

**Business rule:** Transition to `shipped` requires `tracking_number` field (L33-38).

### Order Creation (Atomic)
`create_order_atomic()` RPC — single Postgres transaction (`src/routes/orders.js:489-543`):
1. Validates stock for all items (row-level locks)
2. Creates order record
3. Creates order_items records (prices stored ex-GST for accounting)
4. Decrements stock for each item
5. Returns order_id + success/failure

**Idempotency key:** SHA256 of `userId:sortedItems:addressKey` (L65-72). Stored on order row.

### Order Totals Calculation (`src/routes/orders.js:88-121`)
- `retail_price` in DB **includes GST** (applied by pricing engine)
- `subtotal`: items-only ex-GST for accounting (`itemsTotalIncGst / 1.15`)
- `gst`: extracted from the **full taxable amount** `(items + shipping - discount) / 1.15`. This means GST covers shipping charges (NZ shipping fees are GST-inclusive). Previously GST was extracted from items-only, understating GST on tax invoices.
- `shipping`: Weight + zone-based fee calculated from `shipping_address.region`/`postal_code` and total item weight:
  - **Free**: $0 if items total ≥ $100 (always wins)
  - **Auckland**: flat $7 urban / $14 rural (all weights)
  - **North Island**: <0.5 kg → $7/$14, ≥0.5 kg → $12/$20
  - **South Island**: <0.5 kg → $7/$14, ≥0.5 kg → $12/$20, ≥2 kg → $22/$30
  - **Color packs** (CMY/KCMY): min 2.0 kg effective weight → always highest tier per zone
- `discount`: from promotional coupon (if applied via `POST /api/cart/coupon`), capped so total never goes negative
- `totalCents`: `Math.max(0, Math.round(total * 100))` for Stripe (floor at zero)

**IMPORTANT:** Frontend values for `shipping_tier` and `shipping_zone` are accepted but **ignored** — backend always recalculates from `shipping_address.region`.

### Post-Payment Tasks (`src/services/postPaymentService.js`)
Queued after webhook confirms payment:
| Task | Purpose |
|------|---------|
| `calculate_savings` | Record compatible-vs-genuine savings, free shipping savings |
| `clear_cart` | Remove user's cart items |
| `update_profile` | Fill empty profile fields from checkout data |
| `send_invoice` | Email order confirmation |
| `send_supplier_email` | Notify supplier of new order |
| `send_ga4_event` | Send purchase event to Google Analytics 4 |

Tasks stored in `post_payment_tasks` table with retry support (max 3 attempts, exponential backoff).

**Execution model:** Tasks are queued synchronously (fast DB insert) to ensure persistence before returning 200 to Stripe. Task processing is fire-and-forget — runs in the background so Stripe doesn't timeout waiting for emails/GA4. Failed tasks are retried by the `retry-post-payment` cron job.

---

## 7. Database Interaction Model

### Client Usage Pattern

| Route Type | Client | Reason |
|------------|--------|--------|
| Public catalog/search | `setupSupabaseAdmin()` | Products table RLS restricts anon reads |
| Public ribbons catalog | `setupSupabaseAdmin()` | Ribbons table RLS restricts anon reads to is_active=true |
| User cart (authenticated) | `setupSupabaseWithUser(req.token)` | RLS enforces user_id = auth.uid() |
| User cart (guest) | `setupSupabaseAdmin()` | No JWT for guest sessions |
| User profile/orders | `setupSupabaseWithUser(req.token)` | RLS defense-in-depth |
| Webhooks | `setupSupabaseAdmin()` | Server-side, no user context |
| Admin operations | `setupSupabaseAdmin()` | Bypasses RLS by design |

### Key Tables

| Table | Purpose |
|-------|---------|
| `products` | Product catalog (sku, name, retail_price, stock_quantity) |
| `brands` | Brand master data |
| `printer_models` | Printer model master data |
| `product_compatibility` | Junction: product ↔ printer_model |
| `orders` | Order header (status, totals, shipping address) |
| `order_items` | Order line items (unit_price stored ex-GST) |
| `cart_items` | Cart items (user_id or guest_session_id) |
| `guest_sessions` | Guest session tracking |
| `user_profiles` | User profile (name, phone, account_type, business fields) |
| `user_addresses` | Saved shipping addresses |
| `user_printers` | Saved printers |
| `user_favourites` | Favourited products |
| `admin_roles` | Admin role assignments (super_admin, stock_manager, order_manager) |
| `reviews` | Product reviews (with moderation status) |
| `product_rating_summary` | Materialized view of review aggregates |
| `signup_coupons` | $5 signup coupons (LEGACY — table exists but endpoints removed) |
| `coupons` | General coupons (percentage/fixed, usage limits) |
| `user_applied_coupons` | Currently applied coupon per user |
| `business_applications` | Business account applications |
| `shipping_rates` | Configurable shipping rates |
| `order_savings` | Recorded savings per order |
| `post_payment_tasks` | Async task queue with retry |
| `order_status_history` | Admin order status change audit trail |
| `newsletter_subscribers` | Newsletter emails |
| `email_preferences` | Opt-out preferences |
| `cart_recovery_emails` | Recovery email tracking |
| `email_verification_logs` | Verification audit trail |
| `cron_locks` | Distributed cron lock table |
| `import_runs` | Feed import run tracking (script name, status, anomaly counts) |
| `supplier_offers` | Multi-supplier pricing per canonical product (internal-only, never exposed to frontend) |
| `order_fulfillment` | Chosen supplier per order with cost breakdown (internal-only) |
| `ribbons` | **DROPPED** (migration 010). Fully replaced by `products` table with `product_type='ribbon'`. |
| `ribbon_compatibility` | Structured ribbon ↔ device mappings (device_brand, device_model, match_type, confidence) — junction table for device-based filtering. Only used for `product_type='ribbon'`, not for `label_tape` |

### Atomic Operations (RPC Functions)
| Function | Purpose |
|----------|---------|
| `create_order_atomic()` | Create order + items + decrement stock |
| `cancel_order_restore_stock()` | Cancel order + restore stock |
| `merge_guest_cart_to_user()` | Merge guest cart to user cart |
| `is_webhook_processed()` | Check webhook idempotency |
| `log_webhook_event()` | Record processed webhook |
| `queue_email()` | Queue email for sending |
| `acquire_cron_lock()` / `release_cron_lock()` | Distributed locking |
| `cleanup_guest_carts()` | Delete expired guest sessions + their cart items |
| `cleanup_email_queue()` | Purge old sent/failed emails by retention policy |
| `cleanup_status_history()` | Purge old order/email status history |
| `redeem_promotional_coupon()` | Atomic coupon redemption with usage tracking |
| `rollback_promotional_coupon_usage()` | Reverse a promo coupon redemption on order failure |
| `get_top_products()` | Top/bottom products by revenue, units, profit, or margin |
| `calculate_attach_rate()` | Printer-to-consumable attach rate metrics |
| `identify_b2b_opportunities()` | Score customers by B2B likelihood |
| `refresh_analytics_views()` | Refresh all analytics materialized views |
| `smart_search()` | Fuzzy product search with pg_trgm trigram matching |
| `autocomplete_products()` | Product/printer autocomplete suggestions |
| `search_cartridges_by_printer()` | Find cartridges compatible with a printer |
| `search_products_by_part()` | Search products by SKU/part number/name |
| `get_compatible_cartridges_for_printer()` | Compatible cartridges for a printer product |
| `get_product_counts_by_type()` | Active product counts grouped by product_type |
| `increment_campaign_spent()` | Atomically add to a marketing campaign's spent amount |
| `analytics_overview()` | Aggregated dashboard metrics (revenue, profit, margins) |
| `margin_violations()` | Find products where retail price is below cost |
| `filter_ribbons_by_device()` | Find ribbon IDs compatible with a given device brand/model |

### Current Migration Files (`sql/migrations/`)

Migration files are applied manually to Supabase and then cleaned up from the repo. The following are currently on disk (pending application or kept as reference):

| File | Purpose | Key Details |
|------|---------|-------------|
| `001_create_order_atomic.sql` | `create_order_atomic()` RPC function | Idempotency check, stock validation with row-level locks (`FOR UPDATE`), atomic order + order_items insert, stock decrement. Accepts shipping zone params (`p_shipping_tier`, `p_delivery_zone`, `p_estimated_delivery_days_min/max`). Returns `{ success, order_id, error_code, error_message, failed_items }`. **Note:** All legacy overloads (20-arg varchar, 25-arg varchar) have been dropped — only the 25-arg `text`-params version remains. Order items INSERT uses `product_sku` and `product_name` columns (not `sku`/`name`). |
| `002_coupon_rpcs.sql` | Coupon redemption RPCs | `redeem_promotional_coupon()` — atomic usage_count increment with WHERE guard, returns usage row or empty on limit reached. `rollback_promotional_coupon_usage()` — deletes uncommitted usage rows (order_id IS NULL) and decrements counter |
| `003_product_images.sql` | `product_images` table | Creates `product_images` table (id UUID PK, product_id FK→products, path TEXT, alt_text TEXT, is_primary BOOLEAN, sort_order INTEGER, created_at TIMESTAMPTZ). Indexes on `product_id` and partial index on `(product_id, is_primary) WHERE is_primary = true` |

**Applied and removed migrations (already in Supabase):**

| File | Purpose |
|------|---------|
| `003_shipping_rates.sql` | Created `shipping_rates` table (zone, tier, weight brackets, delivery type, fees, ETAs) with RLS and 12 seed rows |
| `001_admin_dashboard_schema.sql` | Admin dashboard tables (`refunds`, `order_events`, `suppliers`), new order columns (`carrier`, `delivered_at`), RLS + triggers |
| `002_admin_rpc_functions.sql` | Admin RPC functions (`admin_work_queue`, `analytics_*` family, `get_suppliers`) |
| `001_ribbon_compatibility.sql` | `ribbon_compatibility` table with device matching, `filter_ribbons_by_device()` RPC |
| `022_ribbons.sql` | Original `ribbons` table with RLS and indexes (**table dropped in migration 010**) |
| `022_storage_path_migration.sql` | Storage path normalization, `brands.logo_path`, `product_images` column renames |
| `004_email_queue_resend_id.sql` | Added `resend_id` column to `email_queue` |

---

## 8. Security Model

### Helmet (`src/server.js:108-120`)
```javascript
helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true }
})
```
API-only CSP — denies all resource loading. Frame embedding blocked. HSTS enforces HTTPS-only for 1 year.

### Rate Limiting

| Scope | Window | Max | File:Line |
|-------|--------|-----|-----------|
| Global `/api/` | 1 min | 100 | `server.js:172-177` |
| **Orders (per user)** | **15 min** | **10** | `orders.js:26-33` |
| Products/catalog | 1 min | 60 | `products.js:18-24` |
| Search | 1 min | 30 | `search.js:17-23` |
| Cart | 1 min | 60 | `cart.js:46-50` |
| **Cart coupon (per user)** | **5 min** | **5** | `cart.js:892-899` |
| **Cart coupon daily cap** | **24 hours** | **50** | `cart.js:901-1016` (DB-backed) |
| **Cart coupon backoff** | **1 hour block** | **after 20 failures** | `cart.js:901-1016` (DB-backed) |
| Cart analytics events | 1 min | 30 | `cartAnalytics.js:11-17` |
| Webhooks | 1 min | 200 | `webhooks.js:12-18` |
| **Admin (per user)** | **1 min** | **30** | `admin.js:112-119` |
| Auth verification | 15 min | 5 | `auth.js:15-19` |
| Auth status | 1 min | 30 | `auth.js:21-25` |
| Reviews (write) | 15 min | 10 | `reviews.js:8-14` |
| ~~Coupons claim~~ | ~~15 min~~ | ~~5~~ | ~~`coupons.js`~~ (removed) |
| ~~Coupons redeem~~ | ~~1 min~~ | ~~10~~ | ~~`coupons.js`~~ (removed) |
| ~~Coupons list~~ | ~~1 min~~ | ~~30~~ | ~~`coupons.js`~~ (removed) |
| Newsletter | 1 hour | 3 | `newsletter.js:10-16` |
| Contact | 1 hour | 3 | `contact.js:11-17` |
| **Business apply (per user)** | **1 hour** | **3** | `business.js:12-19` |
| Ribbons catalog | 1 min | 60 | `ribbons.js:18-24` |

Rate limit exceeded response:
```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests, please try again later" } }
```

### HTTPS Enforcement
Production only, via `x-forwarded-proto` header from load balancer (`server.js:122-131`). 301 redirect. Health check paths (`/health`, `/api/health`) are exempt.

### Body Size Limits
`express.json({ limit: '1mb' })` and `express.urlencoded({ limit: '1mb' })` (`server.js:192-193`).

### Cookie Security (`src/routes/cart.js:54-60`)
```javascript
{ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 72h }
```

### Input Validation
All user input validated via Joi schemas (`src/validators/schemas.js`). Middleware: `validate(schema, 'body'|'query'|'params')`.

### Cost Price Protection
- `cost_price: null` in product detail response (`products.js:302`)
- `cost_price` stripped from search RPC results (`search.js:146`, `search.js:279`)

### Trust Proxy
`app.set('trust proxy', 1)` — trusts single proxy layer for X-Forwarded-* headers (`server.js:102`).

### Cloudflare Turnstile — Bot Protection

**File:** `src/middleware/turnstile.js`
**Endpoints protected:** `POST /api/contact`, `POST /api/newsletter/subscribe`

Turnstile is Cloudflare's free, privacy-respecting CAPTCHA alternative. When `TURNSTILE_SECRET_KEY` is configured on the backend, the middleware requires and verifies a `turnstile_token` from the frontend. When not configured (dev/local), verification is skipped entirely — no frontend changes needed for dev.

**Frontend integration steps:**

1. **Get site key:** Create a Turnstile widget at [dash.cloudflare.com/turnstile](https://dash.cloudflare.com/turnstile). You'll get a **site key** (frontend) and **secret key** (backend, already configured).

2. **Add the Turnstile script** to your HTML/layout:
```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

3. **Add the widget** to contact and newsletter forms:
```html
<div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY"></div>
```
Or use the [React component](https://www.npmjs.com/package/@marsidev/react-turnstile):
```jsx
import { Turnstile } from '@marsidev/react-turnstile';

<Turnstile siteKey="YOUR_SITE_KEY" onSuccess={(token) => setTurnstileToken(token)} />
```

4. **Include token in request body:**
```json
{
  "email": "user@example.com",
  "name": "...",
  "turnstile_token": "token-from-widget"
}
```

**Error handling:**
| Status | Code | Meaning | Frontend action |
|--------|------|---------|-----------------|
| 400 | `TURNSTILE_MISSING` | Token not provided | Ensure Turnstile widget rendered and token captured |
| 403 | `TURNSTILE_FAILED` | Token invalid/expired | Show "Verification failed, please try again" and reset the widget |

**Production fail-closed behavior:** In production, if the Cloudflare Turnstile API is unreachable, the backend returns `503 TURNSTILE_UNAVAILABLE`. This prevents bot bypasses. In dev/staging, requests are allowed through (fail-open) so Cloudflare outages don't block development.

| Status | Code | Meaning | Frontend action |
|--------|------|---------|-----------------|
| 503 | `TURNSTILE_UNAVAILABLE` | Verification service unreachable (production only) | Show "Service temporarily unavailable, please try again" |

### Guest Session Flood Protection

**File:** `src/routes/cart.js`

Guest cart sessions are limited to **10 new sessions per IP per hour**. If exceeded, `POST /api/cart/items` (for unauthenticated users) returns:
```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "Too many guest sessions. Please try again later." } }
```
Status: `429`. This is transparent to normal users (cookies persist sessions). Only affects attackers creating sessions without cookies. Tracking is DB-backed via `rate_limit_entries` table for cross-instance consistency (in-memory Map is a fast-path cache).

---

## 9. Known Constraints / Edge Cases

### Guest Cart → User Cart Merge
- Guest cart uses `guest_cart_id` httpOnly cookie (72 hours)
- Frontend MUST call `POST /api/cart/merge` after sign-in to transfer items
- Merge is atomic via `merge_guest_cart_to_user()` RPC
- Cookie cleared after merge

### Color Packs: DB-Persisted + Virtual Fallback
- Both genuine and compatible color packs (CMY/KCMY) are now generated as real DB products during import
- Genuine packs have SKU prefix `GEN-PACK-*`, compatible packs have `COMP-PACK-*` (source field matches)
- Virtual packs are still generated on-the-fly by `colorPackService.js` but only for series that have no DB pack
- If a DB pack exists for a series+packType, the virtual pack is suppressed for ALL sources (no duplicates)
- 7% discount off combined individual prices, .90 ending
- Genuine and compatible packs are never mixed
- Compatible packs can be filtered via `GET /api/products?source=compatible` like regular products
- **Weight:** CMY = 0.3 kg (3 × 0.1 kg), KCMY = 0.4 kg (4 × 0.1 kg)
- **Shipping:** Color packs use a minimum effective weight of 2.0 kg for shipping tier selection, ensuring they always hit the highest tier per zone (NI: $12/$20, SI: $22/$30)

### Coupon Constraints
- **Only promotional coupons are supported** (applied via `POST /api/cart/coupon`). Signup coupons have been removed.
- **Promotional coupons:** One applied per user at a time (enforced by `user_applied_coupons` UPSERT on `user_id`). Validated at checkout for expiry, usage limits, per-user limits, and minimum order amount
- Atomic redemption prevents double-spend via concurrent orders (uses `redeem_promotional_coupon` RPC)

### Cart Shipping Estimate
- `GET /api/cart` returns a dynamic shipping estimate based on the **lowest urban fee** from the DB rate table (falls back to $7 if rates unavailable), or $0 if above free threshold
- `POST /api/orders` always recalculates shipping using zone-based rates from `shipping_address.region`
- Cart total may differ from order total depending on zone, weight, and delivery type
- Frontend should display "Shipping calculated at checkout" or show the cart estimate as approximate

### Order Idempotency
- Key = SHA256(userId + sorted items + address) truncated to 32 chars
- In-flight protection via in-memory Map (5-minute TTL)
- Database-level check via `idempotency_key` column
- Duplicate returns existing order with `is_duplicate: true`

### Webhook Raw Body
- `express.raw({ type: 'application/json' })` for `/api/webhooks/payment` MUST be registered before `express.json()` in `server.js:189`
- Required for Stripe signature verification

### Shipping (DB-Driven Zone + Weight)
- **Free** over $100 (inclusive of GST) — always wins
- **Rates are DB-driven** from `shipping_rates` table, administered via `/api/admin/shipping/rates` endpoints
- **Zone rates** broken down by delivery type (urban/rural) and weight bracket:
  - Auckland: flat $7 urban / $14 rural (all weights), 1-2 business days
  - North Island: <0.5 kg $7/$14, ≥0.5 kg $12/$20, 1-3 business days
  - South Island: <0.5 kg $7/$14, ≥0.5 kg $12/$20, ≥2 kg $22/$30, 2-4 business days
- **Color pack override**: CMY/KCMY/CMYK color packs are assigned a minimum effective weight of 2.0 kg for shipping, forcing the highest tier per zone (NI: $12/$20, SI: $22/$30). Actual product weights: CMY = 0.3 kg, KCMY = 0.4 kg.
- **Delivery types**: `urban` and `rural` — rural costs more (typically +$7-8)
- **Deterministic product weight**: All product weights are assigned by product type at import time — supplier weight values are never used. Light items (ink, bottles, ribbons, label tapes, fax film, photo paper) = 0.1 kg. Heavy items (toner, drums, belts, waste toner, fuser kits) = 2 kg. Color packs: CMY = 0.3 kg, KCMY = 0.4 kg. Unknown types get `null` and trigger a warning in shipping calculation (falls back to 0.1 kg).
- **Region mapping**: Postal codes resolved to zones via `resolveZone()` in `src/services/shippingService.js`
- **Server-side recalculation**: Backend always recalculates shipping from `shipping_address.region`/`postal_code` — frontend `shipping_tier`/`shipping_zone` values are display-only hints
- **Rate caching**: Rates cached in memory with TTL, invalidated on admin CRUD operations
- **Fallback rates**: If DB is unavailable, hardcoded zone fees in `src/constants/shipping.js` are used (same weight-tier structure as DB). Fallback accepts both zone keys (`south-island`) and region names (`canterbury`).
- **Gap tolerance**: If no exact weight-range match exists (gap in admin-configured ranges), the service uses the closest rate for the zone+delivery_type rather than falling to hardcoded constants. A warning is logged.
- **Overlap protection**: Admin rate creation and updates reject (409) weight ranges that overlap existing active rates in the same zone + delivery_type
- **Gap detection**: Admin create/update/delete responses include `meta.gap_warnings` (string array) when weight ranges for the affected zone+delivery_type are non-contiguous (e.g., missing a range, first range doesn't start at 0, last range isn't unbounded). Warnings are non-blocking — the operation succeeds regardless.

### Shipping (Weight-Based) — DEPRECATED Utility

**DEPRECATED.** Pure utility in `src/utils/shippingCalculator.js` — kept for reference only. Uses an outdated 0.3 kg threshold and does not include Auckland zone or color pack logic. **Not used by any endpoint or order flow.** The active shipping logic is in `src/services/shippingService.js`.

### Pricing
- All `retail_price` values in the database **include 15% GST**
- GST rate: 15% (NZ) — `src/utils/pricing.js`
- Frontend should display `retail_price` as-is — it's the customer-facing price
- `cost_price` is never exposed to public API

### Email Verification
- Supabase handles magic link verification automatically
- Backend provides `/api/auth/verify-email` for custom OTP flows
- Orders require verified email (`requireVerifiedEmail` middleware)

### Review Moderation
- New reviews start with `pending` status
- Only `approved` reviews shown publicly
- Only `pending` reviews can be edited by users
- Admin can approve/reject/flag reviews

### Non-JSON Endpoints

These endpoints return non-JSON responses. Do NOT parse them with `.json()`:

| Endpoint | Content-Type | Notes |
|----------|-------------|-------|
| `GET /api/email/unsubscribe` | `text/html` | Returns an HTML page — open in browser/iframe, not via fetch |
| `GET /api/admin/export/:type` | `text/csv` | Returns CSV with `Content-Disposition: attachment` header — trigger browser download |
| `GET /sitemap.xml` | `application/xml` | Auto-generated sitemap (1h cache) — consumed by search engines, not frontend |
| `GET /robots.txt` | `text/plain` | Robots file — consumed by search engines, not frontend |

---

## 10. Required Frontend Responsibilities

### Authentication
1. Obtain Supabase access token client-side via `supabase.auth.signInWith*()`
2. Send token as `Authorization: Bearer <token>` on all authenticated requests
3. Handle 401 responses by refreshing token or redirecting to login
4. Handle 403 with `error.code === 'EMAIL_NOT_VERIFIED'` by prompting verification

### Post-Login Flow (Critical)
1. `await` `POST /api/account/sync` — creates/updates profile from OAuth metadata
2. Then fire **in parallel** (all are independent — no ordering requirements, no rate limit concerns):
   - `POST /api/cart/merge` — transfers guest cart to user account
   - `GET /api/account/me` — get full user state (profile, admin status, verification)
   - Favourites sync

`mergeCart` does not depend on `accountSync`'s DB writes (uses user ID from JWT, not from `user_profiles`). 3 concurrent requests will not trigger any rate limiter (global limit is 100/min per IP).

### Checkout Flow
1. Call `POST /api/cart/validate` — ensure stock, prices, product availability
2. If `is_valid: false`, show issues to user (price changes, stock problems)
3. **Coupon check:** If user has a promotional coupon applied to cart (via `POST /api/cart/coupon`), it will be automatically applied at checkout. No coupon field needed in the order request.
4. Call `POST /api/orders` with items + shipping address + `delivery_type` (`urban`/`rural`)
5. Use returned `client_secret` with Stripe.js `confirmPayment()`
6. Handle Stripe redirect (return_url) to order confirmation page
7. Payment result handled server-side via webhook — poll order status or listen for updates
8. Handle `DUPLICATE_REQUEST` (409) by waiting — do NOT retry. Poll `GET /api/orders` after 5-10s

### Guest Cart
- Browser handles `guest_cart_id` httpOnly cookie automatically
- No frontend cookie management needed
- After sign-in, call `POST /api/cart/merge`

### Favourites
- Can store favourites in localStorage for anonymous users
- After sign-in, call `POST /api/user/favourites/sync` with `{ product_ids: [...] }` to merge

### Rate Limits
- Respect 429 responses with exponential backoff
- Display user-friendly message on rate limit hit

### Error Response Format
All errors follow this structure (see Section 2c for full reference):
```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": [...]
  }
}
```

Joi validation errors:
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [{ "field": "email", "message": "\"email\" is required" }]
  }
}
```

### Prices & Currency
- All prices from API are in NZD and include GST
- Display `retail_price` directly as the customer-facing price
- GST rate: 15% — shown on invoices/receipts
- Cart totals calculated server-side — frontend should use `summary.total` from cart response

### Environment Variables Required by Frontend
The frontend needs its own copies of:
| Variable | Purpose | Source |
|----------|---------|--------|
| `SUPABASE_URL` | Auth + real-time | Supabase Dashboard |
| `SUPABASE_ANON_KEY` | Public API key | Supabase Dashboard |
| `STRIPE_PUBLISHABLE_KEY` | Stripe.js initialization | Stripe Dashboard |
| Backend API URL | All API calls | Deployment config |

---

## 11. Troubleshooting

Common errors and how frontend should handle them.

### 400 with `error.code: 'VALIDATION_FAILED'`
**Cause:** Request body fails Joi schema validation. Common causes: missing required fields, invalid UUIDs, or field values not in the allowed set.
**Response shape:** `{ "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "Validation failed", "details": ["\"items\" is required", ...] } }`
**Fix:** Check `error.details` array for per-field messages. Display to user or fix programmatically. **Important:** `shipping_tier` and `shipping_zone` accept empty strings (`""`) or can be omitted entirely — do NOT send arbitrary string values.
**Code path:** `src/middleware/validate.js:8-21` via `src/validators/schemas.js:62-100`

### 401 — Token Expired or Missing
**Cause:** Supabase JWT expires (default 1 hour) or Authorization header missing.
**Fix:** Refresh token via `supabase.auth.refreshSession()` and retry. If refresh fails, redirect to login.
**Code path:** `src/middleware/auth.js:15-45`

### 403 with `error.code: 'EMAIL_NOT_VERIFIED'`
**Cause:** User hasn't confirmed their email. Blocks order creation.
**Response shape:** `{ "ok": false, "error": { "code": "EMAIL_NOT_VERIFIED", "message": "Please verify your email address to access this resource" } }`
**Fix:** Show verification prompt. Call `POST /api/auth/resend-verification` to re-send. Check status via `GET /api/auth/verification-status`.
**Code path:** `src/middleware/auth.js:165-179`

### 409 with `error.code: 'DUPLICATE_REQUEST'`
**Cause:** Same order is already being processed (in-flight idempotency check via in-memory Map).
**Response shape:** `{ "ok": false, "error": { "code": "DUPLICATE_REQUEST", "message": "Order already being processed. Please wait." } }`
**Fix:** Do NOT retry immediately. Poll `GET /api/orders` after 5-10 seconds to check if order was created.
**Code path:** `src/routes/orders.js:141-142`

### 409 with `error.code: 'DUPLICATE_ORDER'`
**Cause:** DB-level idempotency check found an existing order with the same idempotency key (from `create_order_atomic()` RPC).
**Response shape:** `{ "ok": false, "error": { "code": "DUPLICATE_ORDER", "message": "Order already exists" } }`
**Fix:** Redirect to order confirmation. The order was already created successfully.
**Code path:** `src/routes/orders.js:598-599`

### 500 with `error.code: 'ORDER_DB_ERROR'`
**Cause:** The `create_order_atomic()` database function failed. Error message includes the PostgreSQL error code for debugging.
**Common codes:** `42883` = function does not exist (migration not applied), `42703` = column does not exist (schema mismatch), `23514` = CHECK constraint violation (e.g. `line_total ≠ unit_price * quantity`), `PGRST203` = multiple function overloads with ambiguous signatures.
**Response shape:** `{ "ok": false, "error": { "code": "ORDER_DB_ERROR", "message": "Failed to create order (DB: 42883)" } }`
**Fix:** Check Supabase SQL Editor to verify exactly one `create_order_atomic` function exists (`SELECT proname, pronargs FROM pg_proc WHERE proname = 'create_order_atomic';`). There must be only the 25-arg `text`-params version. If duplicates exist, drop the extras (see changelog 2026-02-28).
**Code path:** `src/routes/orders.js:513-541`

### 429 — Rate Limited
**Cause:** Too many requests in time window. Each endpoint has its own limit (see Rate Limiting table in Section 8).
**Response shape:** `{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "Too many requests, please try again later" } }`
**Fix:** Implement exponential backoff. Show user-friendly "please slow down" message. Check `Retry-After` header if present.

### Cart Validation Issues
**Cause:** `POST /api/cart/validate` returned `is_valid: false` with issues array.
**Common issues:** "Insufficient stock", "Price has changed", "Product is no longer available"
**Fix:** Display each issue to user. Backend auto-updates stale price snapshots. Re-validate after user acknowledges.
**Code path:** `src/routes/cart.js:644-758`

### Payment Failed — Order Auto-Cancelled
**Cause:** Stripe payment failed or was cancelled. Webhook atomically cancels order and restores stock.
**Frontend experience:** After Stripe redirect, poll `GET /api/orders/:orderNumber` — status will be `cancelled`.
**Fix:** Show error message, offer retry. User's coupon is automatically unrefunded. Stock is restored.
**Code path:** `src/routes/webhooks.js:298-389` (atomic cancellation via `cancel_order_restore_stock` RPC)

### Guest Cart Lost After Clearing Cookies
**Cause:** Guest cart is tied to `guest_cart_id` httpOnly cookie (72h expiry). If browser cookies cleared, cart is orphaned.
**Fix:** No recovery possible. Start fresh cart. Orphaned guest carts are cleaned up by backend cron job.

### Order Status Stuck on 'pending'
**Cause:** Stripe webhook may not have arrived yet, or webhook processing failed.
**Fix:** Poll `GET /api/orders/:orderNumber` every 2-5 seconds for up to 30 seconds. If still `pending`, show "Payment processing — we'll email you when confirmed." Backend cron retries failed webhooks.

---

## 12. Changelog

### 2026-02-18 — Security Audit + Doc Update
**Code changes (commit `363b12e`):**
- Removed internal `error.message` leakage from auth verification endpoints (`auth.js:89,150`)
- Added per-user rate limit on order creation: 10 req/15min (`orders.js:22-29`)
- Switched cart coupon DELETE/GET from admin client to user client for RLS defense-in-depth (`cart.js:881,898`)
- Fixed CORS localhost check: now explicit `NODE_ENV === 'development'` instead of `!== 'production'` (`server.js:140`)
- Enabled `morgan('combined')` request logging in production (`server.js:181-185`)
- Added per-user rate limit on business application: 3 req/hour (`business.js:11-19`)
- Added bounds validation on shipping constants with safe defaults (`constants/shipping.js`)
- Standardized webhook rate limiter response to include `ok: false` (`webhooks.js:14`)

**Doc updates:**
- Fixed stale `file:line` references throughout (orders.js, business.js, server.js shifts)
- Added `orderLimiter` and `businessLimiter` to rate limit table
- Updated CORS description: "development only" (explicit match)
- Updated middleware pipeline: morgan now runs in all environments
- Added `message` field to email verification auth failure response
- Added Section 11: Troubleshooting (8 common scenarios)
- Added Section 12: Changelog

### 2026-02-19 — Zone-Based Shipping + Backend Requirements Fixes

**Code changes:**

**Zone-Based Shipping System (Section 2):**
- Replaced flat $5 shipping with weight + zone-based rates: Auckland flat $7/$14, NI 2-tier, SI 3-tier (`constants/shipping.js`, `services/shippingService.js`)
- Rates are DB-driven from `shipping_rates` table with in-memory cache
- Added region-to-zone mapping for all 15 NZ regions + postal code resolution
- `POST /api/orders` now calculates shipping server-side from `shipping_address.region` — frontend `shipping_tier`/`shipping_zone` accepted but NOT trusted
- `POST /api/shipping/options` rewritten: accepts `{ cart_total, items, region }`, returns `{ tier, fee, zone, zone_label, eta, spend_more_for_free }`
- `GET /api/shipping/rates` rewritten: returns zone fee table with weight brackets
- `GET /api/settings` returns zone-specific fees via `shipping.zones`
- Color packs (CMY/KCMY) use min 2.0 kg effective weight for shipping tier selection
- `createOrderSchema` updated: accepts optional `shipping_tier`, `shipping_zone`
- `shippingOptionsSchema` updated: `{ cart_total, items[], region }` replaces `{ cart_total, item_count, postal_code }`
- SQL migration `020_zone_shipping.sql`: adds `shipping_tier`, `shipping_fee`, `delivery_zone`, `estimated_delivery_days_min/max` to orders table; updates `create_order_atomic()` RPC

**Order Enhancements (Section 3):**
- `GET /api/orders` and `GET /api/orders/:orderNumber` now include `product_slug` on each order item (for "Buy Again" links)
- `GET /api/orders` now includes `tracking_number`, `tracking_url` (NZ Post link), `estimated_delivery` (ISO date)
- `GET /api/orders/:orderNumber` now includes `shipping_tier`, `shipping_fee`, `delivery_zone`, `estimated_delivery_days_min/max`, `tracking_url`, `estimated_delivery`

**Admin Analytics (Section 4):**
- Added `GET /api/admin/analytics/overview` endpoint (`adminAnalytics.js`) — returns `grossProfit`, `netProfit`, `refundRate`, `avgFulfilmentTime`, `revenueSparkline`, `ordersSparkline`, `revenueTrend`, `ordersTrend`

**Doc updates:**
- Updated Section 4.3 (Orders): POST /api/orders request body with `shipping_tier`/`shipping_zone`, GET /api/orders response with tracking + delivery fields
- Rewrote Section 4.10 (Shipping): zone-based endpoints with full request/response examples
- Updated Section 4.14 (Settings): zone-specific fee constants
- Updated Section 4.21 (Admin Analytics): added /overview endpoint
- Updated Section 6 (Order Totals): zone-based shipping calculation rules
- Rewrote Section 9 (Shipping): zone rates, weight tiers, region mapping

### 2026-02-19 — Multi-Supplier Offer Storage + Cheapest-Supplier Selection

**Code changes (commit `07b0c70`):**
- Added `supplier_offers` table for multi-supplier pricing (one row per supplier + canonical product)
- Added `order_fulfillment` table for recording chosen supplier per order
- Both tables are RLS-enabled with no policies (service-role only, never exposed to frontend)
- Added `generateCanonicalSku()` to `src/utils/feedHelpers.js` for cross-supplier product matching
- Extended `scripts/compatible.js` to upsert Augmento offers into `supplier_offers` during import
- Created `scripts/supplier2026.js` import pipeline for secondary supplier feed
- Created `src/services/supplierSelection.js`: cheapest single-supplier selection at checkout
- Integrated non-blocking supplier selection into `POST /api/orders` (Steps 1.5 and 5.5)
- Supplier selection failure never blocks order creation — defaults to Augmento

**Frontend impact: None.** Supplier offers are internal-only. No API response shapes changed. The order creation endpoint still returns the same contract. All new logic is server-side and invisible to the frontend.

**Doc updates:**
- Fixed stale `file:line` references in orders.js (shifted by ~45 lines from supplier selection code)
- Fixed pre-existing server.js line reference errors (health check, root info, module.exports)
- Added `supplier_offers`, `order_fulfillment`, `import_runs` to Key Tables (Section 7)

### 2026-02-19 — Ribbons Product Domain

**Code changes:**
- Created `ribbons` table (`sql/migrations/022_ribbons.sql`) — fully isolated from `products`, with RLS, indexes, and `updated_at` trigger. **Note:** This table is now LEGACY — see 2026-03-02 changelog for migration to `products` table.
- Created `scripts/import-ribbons.js` — ODS import with brand/model/color extraction, tiered pricing with 15% GST, batch upsert, soft deactivation, `--dry-run` support. **Updated 2026-03-02:** Now upserts to `products` table with `source='ribbon'`.
- Created `src/routes/ribbons.js` — public endpoints: `GET /api/ribbons` (list with filters/pagination), `GET /api/ribbons/:sku` (single detail)
- Added `ribbonQuerySchema`, `ribbonSkuSchema` to `src/validators/schemas.js`
- Registered `ribbonsRouter` at `/api` in `src/routes/index.js:209`
- Created `docs/RIBBONS_FRONTEND_CONTRACT.md` — standalone API contract for ribbon endpoints

**Frontend impact:**
- Two new public endpoints: `GET /api/ribbons` and `GET /api/ribbons/:sku` — no authentication required
- Ribbons are a separate product domain from ink/toner — different table, different endpoints, different data shape
- `sale_price` includes 15% GST, display as-is (same pattern as main products `retail_price`)
- `name` field uses standardized format: `[Brand] [Model] [Ribbon Type] [Color]`
- Available filters: `brand`, `type` (printer_ribbon/typewriter_ribbon/correction_tape), `color`, `search`, `sort`
- Pagination follows same contract as products: `{ page, limit, total, total_pages, has_next, has_prev }`
- `cost_price`, `margin_percent` never exposed

**Doc updates:**
- Added Section 4.22 (Ribbons) with full endpoint documentation
- Added `ribbons` table to Key Tables (Section 7)
- Added ribbons rate limiter to Rate Limiting table (Section 8)
- Added ribbons client usage to Database Interaction Model (Section 7)
- Updated Route Registration table with `ribbons.js` at L209 and corrected all line numbers

### 2026-02-21 — Backend Verification Audit Fixes

**Code changes (3 files, 6 fixes):**

*`src/routes/cart.js`:*
- **[FIX 1+5] Cart summary now includes `coupon` and `is_shipping_estimate`.** `summary.coupon` mirrors `data.coupon` inside the summary object for frontend stacking prevention checks. `summary.is_shipping_estimate` is always `true` (cart shipping is always an estimate)

*`src/routes/orders.js`:*
- **[FIX 2] `customer_notes` added to GET /api/orders SELECT query.** Was already present on the single-order endpoint, now also returned in the orders list
- **[FIX 4a/4b] Invoice data added to both order endpoints.** `GET /api/orders/:orderNumber` fetches invoice from `invoices` table and returns `invoice: { invoice_number, invoice_date } | null`. `GET /api/orders` batch-fetches invoices for all returned orders and adds the same field to each
- **[FIX 6] Coupon stacking error shape standardized.** Changed to `error: 'Only one coupon allowed per order'` (human-readable) with `code: 'COUPON_STACKING_NOT_ALLOWED'`

*`src/routes/adminAnalytics.js`:*
- **[FIX 3] Conversion funnel now returns `steps` array.** Added `data.steps` (array of `{ label, value }`) alongside existing `data.funnel` for backward compatibility. Labels: "Site Visits", "Add to Cart", "Checkout Started", "Order Completed"

**Frontend impact:**
- Cart: access coupon data at `summary.coupon` (in addition to `data.coupon`). Check `summary.is_shipping_estimate` to show "estimated" label
- Orders list: `customer_notes` now available on each order in the list
- Order detail + list: `invoice` field available (`null` if no invoice generated yet)
- Coupon stacking: check for `code === 'COUPON_STACKING_NOT_ALLOWED'` — `error` is now the human-readable message
- Conversion funnel: use `data.steps` for `{ label, value }` format, or `data.funnel` for `{ stage, count, rate }` format

**Doc updates:**
- Updated Section 4.3 (Orders): added `customer_notes` and `invoice` to GET /api/orders response, added `invoice` to GET /api/orders/:orderNumber
- Updated Section 4.4 (Cart): added `coupon` and `is_shipping_estimate` to summary shape
- Updated Section 4.21 (Admin Analytics): documented `steps` array on conversion-funnel endpoint
- Updated Section 11 troubleshooting: corrected COUPON_STACKING_NOT_ALLOWED response shape

### 2026-02-21 — Production Audit Fixes + Coupon Stacking Prevention

**Code changes (3 files):**

*`src/routes/orders.js`:*
- **[HIGH] Promotional coupon discount now applied to order total.** Previously, promo coupons from `user_applied_coupons` were shown in the cart but NOT factored into the order's `calculateTotals()`. Now Step 2b queries `user_applied_coupons` → `coupons` table, re-validates (expiry, start date, usage limits, per-user limits, minimum order), and calculates discount
- **[BUSINESS RULE] Coupon stacking prevention.** New invariant: a single order may use either a signup coupon (`coupon_code`) OR a promotional coupon (`user_applied_coupons`), never both. If both are present, returns 409 `COUPON_STACKING_NOT_ALLOWED`. Signup coupon is auto-rolled-back before the error response
- **[LOW] Added `.catch()` error boundary** to fire-and-forget `storeOrderFulfillment()` call
- **[LOW] Documented in-memory idempotency Map** as per-instance only (DB check provides cross-instance protection)

*`src/routes/cart.js`:*
- **[MEDIUM] `POST /api/cart/coupon` now uses split clients.** `adminSupabase` for `coupons` table reads (no user RLS), `userSupabase` for `cart_items` reads and `user_applied_coupons` upsert (RLS-enforced). No API contract change

*`src/routes/admin.js`:*
- **[LOW] Timing-safe cron secret comparison.** Replaced `===` with `crypto.timingSafeEqual()` to prevent timing attacks on `X-CRON-SECRET` header. No API contract change

**Frontend impact:**
- **New 409 error:** `COUPON_STACKING_NOT_ALLOWED` — frontend must ensure only one coupon type is active at checkout. Either remove the promotional coupon (`DELETE /api/cart/coupon`) before submitting with `coupon_code`, or omit `coupon_code` to use the promotional coupon
- **Promotional coupons now correctly reduce order total** — previously the cart showed a discount that wasn't applied at checkout. Now the order total matches the cart preview
- **Cart shipping remains an estimate** — `GET /api/cart` uses flat North Island light rate ($7); actual shipping calculated at checkout from `shipping_address.region`/`postal_code` + item weights. Frontend should show shipping as approximate in cart

**Doc updates:**
- Added `COUPON_STACKING_NOT_ALLOWED` to Section 4.3 (Orders) error table
- Updated Section 5 (Stripe Contract) checkout flow to mention stacking check
- Updated Section 6 (Order Totals) discount description to reflect mutual exclusivity
- Rewrote Section 9 Coupon Constraints with two-system explanation and no-stacking rule
- Added Section 9 Cart Shipping Estimate documenting flat-rate vs zone-based divergence
- Updated Section 10 checkout flow with coupon stacking guidance (step 3)
- Added Section 11 troubleshooting entry for 409 `COUPON_STACKING_NOT_ALLOWED`

### 2026-02-22 — Email System Audit & Fixes

**Code changes (3 files, 7 fixes):**

*`src/server.js`:*
- **[LOW] Added RESEND env vars to boot validation.** `RESEND_API_KEY` and `RESEND_FROM_EMAIL` now appear in `OPTIONAL_ENV_VARS` warnings at startup. Previously, misconfigured Resend silently fell through to SMTP or no-send mode with no warning

*`src/services/emailService.js`:*
- **[LOW] Resend message ID now logged and stored.** Captures `resendClient.emails.send()` return value, logs the Resend message ID, and stores it in `email_queue.resend_id` column for delivery tracing in the Resend dashboard
- **[LOW] Removed `recipient_email` from stuck-email cleanup logs.** `cleanupStuckEmails()` now selects only `id, subject, created_at` — prevents customer email addresses from leaking into logs
- **[MEDIUM] Resend 429 rate limit detection.** Send errors with `statusCode === 429` or `status === 429` now trigger max backoff (1 hour) instead of normal exponential backoff. Batch processing (`processEmailQueue()`) stops immediately on 429 to avoid further rate limit hits
- **[MEDIUM] Business application status email idempotency hardened.** Replaced fragile `.ilike('subject', '%${status}%')` duplicate check with exact `.eq('subject', subject)` match. The old pattern could false-match across statuses (e.g., "Approved" appearing in a rejection subject)
- **[LOW] Exported `calculateBackoffDelay` for testing**

*`src/services/cartRecoveryService.js`:*
- **[MEDIUM] Cart recovery sends now rate-limited with batch delay.** Added `checkEmailRateLimit()` before each send and 1-second `BATCH_DELAY_MS` delay between sends, matching the `processEmailQueue()` pattern. Previously, 50 abandoned carts would fire 50 emails in rapid succession
- **[MEDIUM] Cart recovery record-before-send race condition fixed.** Moved `cart_recovery_emails` insert to BEFORE `queue_email()` call. Previously, a crash between queue and insert would cause duplicate emails on next cron run. Now worst case is a recorded-but-not-sent email (no duplicate to user)

**New files:**
- `sql/migrations/004_email_queue_resend_id.sql` — Adds `resend_id` TEXT column to `email_queue` table
- `__tests__/emailService.test.js` — Unit tests for `calculateBackoffDelay()` (exponential growth, jitter, max cap), `checkEmailRateLimit()` (per-user and global limits), and `EMAIL_COST_LIMITS` constants

**Frontend impact: None.** All changes are backend email infrastructure. No API response shapes changed. No new endpoints. Cart recovery emails, order invoices, and business application status emails continue to work with the same triggers — they are now more reliable and better protected against rate limits and duplicates

### 2026-02-22 — Backend Handoff Fixes

**Code changes (5 files):**

- `src/routes/products.js` — Added `logo_path` to product list brand select; `brand.logo_path` now resolved to full URL via `resolveImageUrl()` in product list, product detail, and brands endpoints
- `src/routes/cart.js` — Added `available: 0` to inactive-product issue in cart validate response
- `src/validators/schemas.js` — Added `model` query param to `ribbonQuerySchema`; added `ribbonBrandsQuerySchema` and `ribbonModelsQuerySchema`
- `src/routes/ribbons.js` — Added `model` filter (case-insensitive partial match on `compatibility`); added `GET /api/ribbons/brands` and `GET /api/ribbons/models` endpoints
- `src/routes/index.js` — Added new ribbon endpoints to API docs

**Data changes:**
- All 9 brand logos uploaded to Supabase Storage (`public-assets/logos/`) and `brands.logo_path` populated
- Ribbon compatibility data re-imported from ODS (6 ribbons have compatibility data from source)
- Ribbon photos uploaded (91/95 matched)
- All 95 active ribbons set to `stock_quantity: 100`

**Frontend impact:**
- **`brand.logo_path`** — Now a full URL (was relative path). Use directly in `<img src>`. No more `storageUrl()` needed.
- **`POST /api/cart/validate`** — "Product is no longer available" issue now includes `available: 0` field, matching the shape of "Insufficient stock" issues.
- **`GET /api/ribbons`** — New `model` query param for filtering by compatible printer model.
- **`GET /api/ribbons/brands`** — New endpoint returning `{ brands: ["Epson", ...] }` for filter dropdowns. Optional `type` param.
- **`GET /api/ribbons/models`** — New endpoint returning `{ models: ["LQ-350", ...] }` for filter dropdowns. Optional `brand` and `type` params.

---

### 2026-02-22 — Supabase Storage Relative-Path Migration

**Code changes (9 files):**

*New files:*
- **`src/utils/storage.js`** — `resolveImageUrl()` helper. Converts relative storage paths to full public URLs, passes through external URLs and null unchanged.
- **`sql/migrations/022_storage_path_migration.sql`** — Adds `brands.logo_path`, renames `product_images.url` → `url_deprecated` / `storage_path` → `path`, adds `alt_text`, backfills relative paths, adds indexes.

*Modified routes (7 files):*
- `products.js` — `image_url` resolved to full URL in all responses; `brand.logo_url` → `brand.logo_path`
- `admin.js` — Image upload/delete/reorder now uses `public-assets` bucket and `path`/`alt_text` columns; `image_url` resolved in admin order/product responses
- `orders.js` — `image_url` resolved in order history and order detail
- `cart.js` — `image_url` resolved in `buildCartResponse`
- `user.js` — `image_url` resolved in favourites
- `reviews.js` — `image_url` resolved in user reviews
- `cartRecoveryService.js` — `image_url` resolved for email `<img src>`

**Frontend impact:**
- **`GET /api/brands`** — **BREAKING:** Returns `logo_path` instead of `logo_url`. `logo_path` is now a full URL resolved by the backend — use directly in `<img src>`. (Previously required frontend resolution; no longer needed.)
- **`product.image_url`** — **No change needed.** Backend now resolves all image_url fields to full URLs before returning. External URLs (ds.co.nz feed images) pass through unchanged.
- **Admin `images[]`** — Fields changed: `url` → removed, `storage_path` → `path`, added `alt_text`. Frontend must use `storageUrl(image.path)` to display.
- **Admin image upload response** — Now returns `{ path, alt_text, image_url, is_primary, sort_order }` instead of `{ url, is_primary, sort_order }`.
- **Storage bucket** — Changed from `product-images` to `public-assets` for all new uploads.

---

### 2026-02-22 — Security Audit Hardening (5 fixes)

**Code changes (4 files, ~25 lines):**

*`src/validators/schemas.js`:*
- **[NEW] `adminCustomerQuerySchema`** — Joi validation for `GET /admin/customers` query params (page, limit 1-500, search max 200 chars, sort whitelist, order asc/desc)
- **[NEW] `orderNumberParamSchema`** — Joi validation for order number param (pattern: `ORD-{base36}-{hex4}`, max 30 chars)

*`src/routes/admin.js`:*
- **[MEDIUM] Added Joi validation to `GET /admin/customers`.** Previously accepted raw query params — `limit=999999` could dump entire customer table. Now validates with `adminCustomerQuerySchema`
- **[LOW] Fixed cron secret timing leak.** Replaced `Buffer.length` check + `timingSafeEqual` with HMAC-SHA256 digest comparison. Old code leaked secret length via faster rejection when lengths differed
- **[INFO] Fixed misleading comment** about admin auth fallback being development-only (it runs in all environments)

*`src/routes/cart.js`:*
- **[LOW] Cart merge now validates guest cookie UUID format.** Replaced raw `req.cookies` read with `getValidGuestSessionId()`, consistent with all other guest cart operations

*`src/routes/orders.js`:*
- **[LOW] Added param validation to `GET /orders/:orderNumber`.** Now rejects malformed order numbers at the validation layer instead of sending arbitrary strings to the DB query

**Frontend impact:**
- **`GET /api/orders/:orderNumber`** — Invalid order number formats (not matching `ORD-{base36}-{hex4}`) now return **400** instead of reaching the DB query. Ensure order number URLs use the exact format returned by the API
- **`GET /api/admin/customers`** — `limit` capped at 500, `sort` restricted to `created_at`/`first_name`/`last_name`, `search` capped at 200 chars. Invalid values now return 400
- **`POST /api/cart/merge`** — No behavior change for valid cookies. Malformed (non-UUID) guest_cart_id cookies now return "No guest cart to merge" instead of passing through to DB

### 2026-02-22 — API Contract Normalization (Pagination + Error Envelope)

**Code changes (3 files, ~40 lines):**

*`src/routes/reviews.js`:*
- **[FIX] Public reviews pagination** — Renamed `pages` → `total_pages`, added `has_next` and `has_prev` fields
- **[FIX] Admin reviews pagination** — Moved `pagination` from sibling of `data` to nested inside `data`, wrapped raw reviews array inside `data: { reviews: [...] }`, renamed `pages` → `total_pages`, added `has_next` and `has_prev`

*`src/routes/search.js`:*
- **[FIX] Search by-printer pagination** — Moved flat `total`, `page`, `limit`, `total_pages` fields into nested `pagination` object, added `has_next` and `has_prev`
- **[FIX] Search by-part pagination** — Same normalization as by-printer

*`src/routes/orders.js`:*
- **[FIX] Coupon conflict error shape** — Changed from `error: 'coupon_conflict'` with separate `message` field to `error: 'Only one coupon allowed per order'` (standard envelope: `error` is always human-readable)

**New files:**
- `docs/FRONTEND_CONTRACT_MAP.md` — Slim conventions reference: response envelope, pagination shape, auth, non-paginated list endpoints
- `scripts/verify-api-contract.js` — Standalone smoke-test script (no deps) that validates paginated endpoint shapes against the running server

**Frontend impact:**
- **All paginated endpoints now use identical shape:** `data.pagination: { page, limit, total, total_pages, has_next, has_prev }`. No more special-case handling per endpoint
- **`GET /api/products/:productId/reviews`** — `pagination.pages` → `pagination.total_pages`, new fields `has_next`/`has_prev`
- **`GET /api/admin/reviews`** — `pagination` moved from top-level into `data`, reviews array now at `data.reviews` instead of `data` (was raw array)
- **`GET /api/search/by-printer`** — Flat pagination fields (`total`, `page`, `limit`, `total_pages`) moved into `data.pagination` object, new fields `has_next`/`has_prev`
- **`GET /api/search/by-part`** — Same change as by-printer
- **Coupon stacking error** — Check `code === 'COUPON_STACKING_NOT_ALLOWED'` (unchanged) but `error` is now the human-readable message (no separate `message` field)

**Doc updates:**
- Updated header date
- Updated Section 4.2 (Search): added response shape documentation with nested `pagination` for both endpoints
- Updated Section 4.8 (Reviews): fixed public reviews pagination shape, added admin reviews response shape
- Updated Section 11 (Troubleshooting): corrected `COUPON_STACKING_NOT_ALLOWED` response shape
- Corrected changelog entry from 2026-02-21 (Backend Verification Audit) to reflect final error shape

---

### 2026-02-22 — Compatible Color Packs (DB-Persisted)

**What changed:** Color packs are no longer genuine-only. The `colorPackGenerator.js` is now source-agnostic and runs during both genuine and compatible imports, creating real DB products with `COMP-PACK-*` SKUs for compatible products (alongside existing `GEN-PACK-*` for genuine).

**Frontend impact:**
- `GET /api/products?source=compatible` now returns `COMP-PACK-*` products (filterable like any product)
- `GET /api/products/printer/:slug/color-packs` returns DB packs from both sources; virtual packs only generated where no DB pack exists
- No API contract changes — existing endpoints return the same shape, just more data

**Files changed:**
- `src/utils/colorPackGenerator.js` — source parameterization, `COMP-PACK` prefix, circuit breaker tightened to 30%
- `src/services/colorPackService.js` — canonical prefix constants, cross-source virtual suppression
- `scripts/compatible.js` — pack generation step added (Steps 13.6-13.8), `--skip-packs` flag

---

### 2026-02-24 — Production Security Hardening

**Code changes (4 files):**

*`src/routes/reviews.js`:*
- **[MEDIUM] Replaced regex HTML stripping with `sanitize-html`.** `stripHtmlTags()` now uses `sanitize-html` library (zero allowed tags/attributes) instead of bypass-prone `/<[^>]*>/g` regex. Prevents XSS via malformed tags, HTML entities, and event handler attributes

*`src/server.js`:*
- **[MEDIUM] Added Sentry error tracking (opt-in).** `@sentry/node` initialized when `SENTRY_DSN` env var is set. Traces sampled at 10%. All unhandled errors reported with request context (method, path, userId)

*`src/middleware/errorHandler.js`:*
- **[MEDIUM] Error handler reports to Sentry.** `captureException()` called at top of centralized error handler before response, with method/path/userId context

*`src/routes/admin.js`:*
- **[LOW] Diagnostics endpoint role-restricted.** `GET /api/admin/products/diagnostics` now requires `requireRole('super_admin', 'stock_manager')` in addition to `requireAdmin`. Previously any admin role could access product diagnostics

**New files:**
- `tests/smoke.test.js` — Production smoke test (17 assertions: health, public endpoints, auth rejection, admin rejection, input validation, CORS, rate limiting, webhook security, 404 handling). Run with `BASE_URL=https://api.example.com node tests/smoke.test.js`

**New dependencies:**
- `sanitize-html` ^2.17.1 — battle-tested HTML sanitizer for review XSS prevention
- `@sentry/node` ^10.39.0 — error tracking and alerting (opt-in via `SENTRY_DSN`)

**Frontend impact:**
- **`GET /api/admin/products/diagnostics`** — `order_manager` admins will now receive 403 (previously allowed). Only `super_admin` and `stock_manager` can access
- **Review content** — Unchanged API shape. Sanitization is stricter but produces same result for non-malicious input
- **Error responses** — Unchanged shape. Sentry reporting is invisible to frontend

**Doc updates:**
- Updated `server.js` line references throughout (+12 line shift from Sentry block)
- Updated diagnostics endpoint auth description in Section 4.18

---

### 2026-02-24 — Second-Pass Security Hardening

**Code changes (6 files):**

*`src/routes/cart.js`:*
- **[HIGH] Coupon error responses unified.** `POST /api/cart/coupon` now returns identical `400 "Coupon could not be applied"` for ALL failure cases (invalid code, not yet active, expired, usage limit reached, per-user limit). Previously returned distinct messages that enabled coupon code enumeration
- **[MEDIUM] Coupon `select('*')` replaced with explicit fields.** Three queries on `coupons` table (apply, cart response, get coupon) now select only needed columns

*`src/routes/orders.js`:*
- **[CRITICAL] Order creation `select('*')` replaced with explicit fields.** Post-creation fetch no longer returns `payment_intent_id`, `idempotency_key`, `admin_notes`, or future internal columns
- **[HIGH] `customer_notes` sanitized with `sanitize-html`.** Strips all HTML tags before DB storage to prevent stored XSS targeting admin views
- **[MEDIUM] Idempotency Map size-capped at 10,000 entries.** Emergency cleanup triggered at capacity to prevent memory exhaustion under sustained load

*`src/utils/storage.js`:*
- **[HIGH] `resolveImageUrl()` now validates external URLs against trusted domain.** Only URLs matching the Supabase host are passed through; all other external URLs return `null`

*`src/routes/admin.js`:*
- **[HIGH] Recovery/health-check queries bounded.** Added `.limit(10000)` to 6 unbounded queries across health-check and fix-invoices endpoints

*`src/routes/webhooks.js`:*
- **[MEDIUM] Unhandled Stripe events filtered early.** Events not in `HANDLED_EVENTS` set return `{ received: true }` immediately, before idempotency DB check and logging

*`src/services/emailService.js`:*
- **[MEDIUM] Email rate tracker Map bounded before insertion.** Rejects emails when per-user Map hits 10K capacity, preventing unbounded growth between cleanup cycles

**Frontend impact:**
- **`POST /api/cart/coupon` error handling change** — All coupon failures now return `{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "Coupon could not be applied" } }` with status 400. Frontend should NOT distinguish between "invalid code", "expired", "already used", etc. — show the generic error message to the user. The minimum order amount error (`Minimum order amount of $X required`) is unchanged
- **Image URLs** — `resolveImageUrl()` now returns `null` for non-Supabase external URLs. Frontend image components should already handle `null`/missing images gracefully
- **Order creation response** — No shape change (response was already explicitly constructed), but internal fetch now excludes sensitive columns as defense-in-depth

### 2026-02-24 — Documentation Audit & Stale Reference Fixes

**Doc-only changes (no code changes):**

- **[NEW] Added `GET /api/search/smart` to Section 4.2.** Fuzzy search with trigram matching (`pg_trgm`), typo tolerance, relevance ranking. Was added in commit `d883acc` but never documented in Frontend.md. Uses `smartSearchSchema` (defined locally in `search.js:44-47`), `optionalAuth` middleware, and `smart_search` Supabase RPC
- **[NEW] Added `sanitize-html` and `@sentry/node` to Section 1 dependency table.** Both were added in the 2026-02-24 security hardening but omitted from the version table
- **[NEW] Added `image_path` to ribbon response shape (Section 4.22).** Field was returned by the API but missing from the documented JSON example
- **[FIX] Fixed ~30 stale line number references across the document:**
  - `src/routes/index.js` — Route registration block shifted +1 (L193-212 → L194-213)
  - `src/routes/analytics.js` — All 9 endpoint lines shifted +12 (e.g., L25 → L37)
  - `src/routes/products.js` — 8 line references corrected (1-7 line shifts)
  - `src/routes/search.js` — `searchLimiter` L13-19 → L14-20; inline cost_price strip refs L99→L145, L210→L288
  - `src/routes/orders.js` — `orderLimiter` L25-32 → L26-33; POST handler L123 → L124; idempotency key L63-71 → L64-72; totals L87-118 → L88-119; duplicate check L134-143 → L136-146
  - `src/routes/cart.js` — GET/POST/PUT/DELETE handlers shifted +1 (L182→L183, L236→L237, L387→L388, L468→L469)
  - `src/routes/reviews.js` — `reviewLimiter` L7-13 → L8-14
  - `src/routes/business.js` — `businessLimiter` end L19 → L18
  - `src/routes/ribbons.js` — `catalogLimiter` L10-16 → L15-21
  - `src/middleware/auth.js` — Email not verified response L193 → L192
  - Section 8 rate limiting table — 6 file:line references corrected
  - Section 11 troubleshooting — 3 code path references corrected

**Frontend impact:** None. Documentation-only corrections.

---

### 2026-02-24 — Backend Bug Fix Audit (~25 fixes, 19 files)

**BREAKING CHANGE:**
- **`PUT /api/admin/products/:sku` renamed to `PUT /api/admin/products/by-sku/:sku`** — The old path conflicted with `PUT /api/admin/products/:productId` (both matched the same Express route pattern, making the UUID endpoint unreachable). Frontend admin panel must update the SKU-based product update URL.

**Frontend-visible behavior changes:**
- **`POST /api/admin/analytics/expenses`** — Now validated with `analyticsCreateExpenseSchema`. Invalid payloads (missing `category`, `amount`, `date`, or non-numeric `amount`) will return 400 instead of 500
- **`POST /api/admin/analytics/campaigns`** — Now validated with `analyticsCreateCampaignSchema`. Missing `name`, `channel`, or `budget` returns 400
- **`POST /api/admin/analytics/marketing-spend`** — Now validated with `analyticsMarketingSpendSchema`. Missing `channel`, `amount`, or `date` returns 400
- **`POST /api/admin/analytics/feedback`** — Now validated with `analyticsCreateFeedbackSchema`. `nps_score` must be 0-10, `rating` must be 1-5
- **`GET /api/admin/analytics/pnl`** — Now validated. Invalid `granularity` (not `daily`/`monthly`) returns 400
- **`GET /api/admin/analytics/cashflow`** — Now validated. `months` must be 1-24
- **`GET /api/admin/analytics/daily-revenue`** — Now validated. `days` must be 1-365
- **`POST /api/cart/coupon` error (unchanged)** — Coupon failures still return generic error. No change from second-pass hardening
- **Review rating summaries** — Now correctly invalidated when admin approves/rejects a review. Previously stale until cache TTL expired

**Non-breaking backend fixes (no API shape changes):**
- Fixed 21 occurrences of `'delivered'` status → `'completed'` across `adminAnalytics.js`, `admin.js`, `cartAnalytics.js`, `analytics.js` (state machine has no `delivered` status)
- Fixed revenue queries including `pending` (unpaid) orders in `analytics.js`
- Fixed broken `.from('coupons').rpc()` chain in `orders.js` coupon rollback
- Fixed SQL injection in `adminAnalytics.js` marketing-spend endpoint
- Fixed hardcoded fallback HMAC secret and added timing-safe comparison in `cartRecoveryService.js`
- Fixed `postPaymentService.js` fresh tasks never picked up (NULL `next_retry_at` filter)
- Fixed spoofable rate limit keys in `contact.js` and `newsletter.js` (raw `X-Forwarded-For` → `req.ip`)
- Fixed `auth.js` `isEmailVerified` treating `undefined` as verified
- Fixed `emailService.js` null dereference on `order.user_id` before null check
- Fixed `emailService.js` `item.product.source` → `item.product?.source`
- Fixed non-atomic default address operations in `user.js` (POST and PUT)
- Added LIKE escape for backslash in `ribbons.js` and `admin.js` search filters
- Added singleton pattern for Supabase clients in `supabase.js`
- Added 10s fetch timeout in `ga4Service.js`
- Added `.unref()` to `setInterval` timers in `emailService.js` and `orders.js`
- HTTPS redirect now exempts `/health` and `/api/health` in `server.js`
- `stripe.js` now throws on missing `STRIPE_SECRET_KEY` instead of returning null

**Doc updates:**
- Renamed `PUT /api/admin/products/:sku` → `PUT /api/admin/products/by-sku/:sku` in Section 4.18
- Updated ~38 adminAnalytics.js line references (+9 shift from expanded imports)
- Added **Validation** notes to 7 admin analytics endpoints (3 GET, 4 POST)

### 2026-02-24 — Image URL Handling & Cron Refactor

**Code changes (3 files):**

*`src/routes/search.js`:*
- **[MEDIUM] `image_url` added to search fallback queries.** `GET /api/search/by-printer` and `GET /api/search/by-part` fallback SELECT queries (used when RPC fails) now include `image_url` in the response. Previously these fallback paths returned products without `image_url`
- **[MEDIUM] `resolveImageUrl()` applied to all search responses.** All three search endpoints (`by-printer`, `by-part`, `smart`) now resolve `image_url` through `resolveImageUrl()`, matching the behavior of product catalog routes. External URLs from trusted domains (Supabase, ds.co.nz) are preserved; untrusted external URLs return `null`

*`src/utils/storage.js`:*
- **[HIGH] `ds.co.nz` added to trusted image hosts.** `resolveImageUrl()` now whitelists `www.ds.co.nz` and `ds.co.nz` as trusted external image sources, in addition to the Supabase storage host. Previously, all supplier feed image URLs (e.g. `https://www.ds.co.nz/assets/full/CART312.jpg`) were blocked and returned as `null`

*`src/cron/scheduler.js` + `src/cron/jobs.js` + `src/routes/admin.js`:*
- **[INTERNAL] Cron scheduler refactored.** Replaced HTTP self-requests (fetch to `localhost:PORT`) with direct function calls. Shared job runners extracted to `src/cron/jobs.js`. ~700 lines of duplicated logic removed from `admin.js`. No API contract change
- **[INTERNAL] Fixed cron job status checking.** All cron jobs return `{ ok: true }` but the scheduler (`scheduler.js:24`) and all 9 HTTP cron endpoints in `admin.js` were checking `result.success` (always `undefined`), causing every job to falsely report failure. Changed all checks to `result.ok`

**Frontend impact:**
- **Search results now include `image_url`** — `GET /api/search/by-printer` and `GET /api/search/by-part` results now consistently include resolved `image_url` fields. Previously, products found via the fallback query path were missing this field
- **More product images will render** — Products with supplier feed images (`ds.co.nz`) that previously showed as `null` (broken images) will now return valid URLs
- **No API shape changes** — Same response structure, just more complete data

**Doc updates:**
- Fixed 8 stale `search.js` line references (shifted +1 to +10 from `resolveImageUrl` import and image_url additions)
- Fixed 10 stale `server.js` line references (CORS options, PORT, entry point, middleware pipeline)
- Updated cost_price strip references in Section 8 Security Model
- Updated HTTPS enforcement description (health check exemption)

### 2026-02-25 — Response Envelope Overhaul

**BREAKING CHANGES:**

All API responses now use a new envelope format. This is a global change affecting every endpoint.

1. **`"success"` → `"ok"`** — The boolean success indicator field has been renamed from `success` to `ok` across all responses
2. **Structured error objects** — Error responses changed from `{ "ok": false, "error": "message string" }` to `{ "ok": false, "error": { "code": "ERROR_CODE", "message": "message string", "details": [...] } }`. The `error` field is now always an object, never a flat string
3. **Pagination moved to `meta`** — Pagination metadata moved from `data.pagination` to a top-level `meta` field: `{ "ok": true, "data": {...}, "meta": { "page", "limit", "total", "total_pages", "has_next", "has_prev" } }`
4. **`X-Request-Id` header** — Every response now includes an `X-Request-Id` header (UUID). Clients can send their own `X-Request-Id` for request correlation
5. **Error codes standardized** — All errors now include a machine-readable `code`: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `VALIDATION_FAILED`, `RATE_LIMITED`, `PAYMENT_ERROR`, `EMAIL_NOT_VERIFIED`, `INTERNAL_ERROR`

**Frontend migration required:**
- Replace all `response.success` checks with `response.ok`
- Replace all `response.error` (string) reads with `response.error.message` (for display) and `response.error.code` (for logic)
- Replace all `response.data.pagination` reads with `response.meta`
- Validation error details are now at `response.error.details` instead of `response.details`
- Rate limit responses now return structured error objects like all other errors
- Health endpoint (`GET /health`) returns `{ "ok": true, "data": { "message": "Server is running", ... } }`
- Root endpoint (`GET /`) returns `{ "ok": true, "data": { "message": "...", "version": "v1" } }`

**Doc updates:**
- Added Section 2c (Response Envelope) with success, error, pagination formats, error codes table, and X-Request-Id documentation
- Updated all response examples throughout Sections 3, 4, 8, 10, and 11 to use new envelope format
- Updated all `"success": true/false` → `"ok": true/false` in JSON examples
- Updated all flat error strings to structured error objects
- Moved all `data.pagination` references to top-level `meta`
- Updated rate limiting response format in Section 8
- Updated error response format documentation in Section 10
- Updated all troubleshooting response shapes in Section 11

### 2026-02-25 — Ribbon Compatibility System

**Code changes (4 files):**

- `sql/migrations/001_ribbon_compatibility.sql` — New `ribbon_compatibility` table with `device_brand_norm`/`device_model_norm` columns, `ribbon_match_type` enum, confidence/source_rank fields, unique constraint, `filter_ribbons_by_device()` RPC, RLS (SELECT-only policy)
- `src/routes/ribbons.js` — Added `device_brand`/`device_model` query params to `GET /api/ribbons` (join-based filtering via RPC); added `compatible_devices` array to `GET /api/ribbons/:sku` response; added two new endpoints: `GET /api/ribbons/device-brands` and `GET /api/ribbons/device-models`
- `src/validators/schemas.js` — Added `device_brand`/`device_model` to `ribbonQuerySchema`; added `ribbonDeviceBrandsQuerySchema` and `ribbonDeviceModelsQuerySchema`
- `src/routes/index.js` — Registered `ribbon_device_brands` and `ribbon_device_models` in API docs

**New endpoints:**
- **`GET /api/ribbons/device-brands`** — Returns `{ device_brands: [{ value, label, count }] }` for device brand filter dropdowns. Optional `type` param
- **`GET /api/ribbons/device-models`** — Returns `{ device_models: [{ value, label, brand, count }] }` for device model filter dropdowns. Optional `device_brand` and `type` params

**Modified endpoints:**
- **`GET /api/ribbons`** — New `device_brand` and `device_model` query params. Uses `filter_ribbons_by_device()` RPC for join-based filtering against `ribbon_compatibility` table. Existing `model` param (free-text search) still works
- **`GET /api/ribbons/:sku`** — Now includes `compatible_devices` array with `{ brand, model, match_type, confidence }` entries. Always present (empty `[]` if no data)

**Frontend impact:**
- New "find ribbon by device" flow: device-brands dropdown → device-models dropdown → filtered ribbon results
- Ribbon detail pages can display structured compatibility lists instead of raw free-text
- All existing ribbon API calls continue to work unchanged — new params/fields are additive

**Data:**
- 92% coverage: 92 of 100 active ribbons have structured compatibility data (1154 entries)
- 8 Universal/generic ribbons have no device-specific compatibility (expected)
- Sources: supplier feed compatibility text (960 entries) + product name parsing (194 entries)

**Doc updates:**
- Added `device_brand`/`device_model` params to `GET /api/ribbons` table and device filtering explanation
- Added `GET /api/ribbons/device-brands` and `GET /api/ribbons/device-models` endpoint docs with response shapes
- Updated `GET /api/ribbons/:sku` to include `compatible_devices` array in response example
- Added `ribbon_compatibility` to Key Tables (Section 7)
- Added `filter_ribbons_by_device()` to RPC Functions table (Section 7)
- Updated line references: `GET /api/ribbons` L33→L35, brands L126→L168, models L163→L205, `:sku` L215→L404

### 2026-02-26 — Supabase Function Security Hardening & Missing RPCs

**Database changes (no code changes):**

Fixed `cleanup_guest_carts` RPC referencing nonexistent `merged_into_user` column (caused cron job failures on Render). Audited all Supabase functions and fixed mutable `search_path` vulnerability across every function in the `public` schema — all now use `SET search_path TO ''` with fully-qualified `public.` table references. (**Note:** The 6 analytics RPCs from `002_admin_rpc_functions.sql` were missed in this pass and remained broken until the 2026-03-01 fix below.)

**Functions fixed (search_path hardened):**
- Batch 1 (11): `analytics_overview`, `autocomplete_products`, `cancel_order_restore_stock`, `cleanup_email_queue`, `cleanup_status_history`, `create_invoice_for_order`, `create_order_atomic` (old overload), `get_compatible_cartridges_for_printer`, `search_cartridges_by_printer`, `search_products_by_part`, `smart_search`
- Batch 2 (16): `batch_update_stock`, `cleanup_old_records`, `generate_invoice_number`, `get_order_state_machine`, `handle_new_user`, `is_super_admin`, `log_email_status_transition`, `log_order_status_transition`, `preview_repair_stale_pending_orders`, `repair_missing_invoices`, `repair_sent_emails_no_timestamp`, `repair_stale_pending_orders`, `repair_stuck_emails`, `repair_sync_tracking_numbers`, `restore_order_stock`, `run_all_safe_repairs`, `trigger_create_invoice_on_payment`, `update_order_status_atomic`, `validate_email_state_transition`, `validate_order_state_transition`

**New RPC functions created (7):**
- `get_top_products()` — Top/bottom products by revenue, units, profit, or margin
- `calculate_attach_rate()` — Printer-to-consumable attach rate metrics
- `identify_b2b_opportunities()` — Score customers 0-100 by B2B likelihood
- `refresh_analytics_views()` — Refresh all 4 analytics materialized views
- `rollback_promotional_coupon_usage()` — Reverse promo coupon redemption on order failure
- `get_product_counts_by_type()` — Active product counts grouped by product_type
- `increment_campaign_spent()` — Atomically add to a marketing campaign's spent amount

**Doc updates:**
- Expanded RPC Functions table in Section 7 from 8 to 27 entries

**Frontend impact:** The 4 analytics RPCs (`get_top_products`, `calculate_attach_rate`, `identify_b2b_opportunities`, `refresh_analytics_views`) previously returned 500 errors — these admin analytics endpoints now work correctly. The 3 utility RPCs (`rollback_promotional_coupon_usage`, `get_product_counts_by_type`, `increment_campaign_spent`) previously fell back to slower direct queries — they now use atomic RPC calls.

### 2026-02-27 — Image Upload 500 Fix (product_images table)

**Bug:** `POST /api/admin/products/:productId/images` returned **500 Internal Server Error** with message `"Failed to save image record"` for all image uploads.

**Root cause:** The `product_images` table did not exist in the database. The route handler (`admin.js:1255`) inserts into `product_images`, but no migration had ever created the table. The Supabase Storage upload to `public-assets` succeeded, but the subsequent DB insert failed — producing the 500.

**Fix applied:**
- **`sql/migrations/003_product_images.sql`** — Creates `product_images` table with columns: `id` (UUID PK), `product_id` (UUID FK→products ON DELETE CASCADE), `path` (TEXT), `alt_text` (TEXT), `is_primary` (BOOLEAN), `sort_order` (INTEGER), `created_at` (TIMESTAMPTZ). Includes indexes on `product_id` and a partial index on `(product_id, is_primary) WHERE is_primary = true`

**Action required:** Run `003_product_images.sql` in Supabase SQL Editor before testing. Also verify the `public-assets` storage bucket exists and is set to **public** in Supabase Dashboard > Storage.

**Frontend impact:**
- **Image uploads will work** — `POST /api/admin/products/:productId/images` will return 201 instead of 500. No frontend code changes needed — the request format documented in this file is correct
- **Image delete and reorder will work** — `DELETE` and `PUT /reorder` endpoints also depend on `product_images` and were similarly broken
- **Your existing frontend code is correct** — `FormData` with `image` field, Bearer auth header, no manual `Content-Type` header. This matches the backend exactly

**Doc updates:**
- Added `003_product_images.sql` to migrations table (Section 7)
- Expanded `POST /api/admin/products/:productId/images` documentation (Section 4.18) with full request/response spec, error table, file constraints, storage path convention, and frontend code example
- Updated `DELETE` and `PUT /reorder` descriptions with additional behavior details
- Fixed line references: POST `admin.js:1177` → `1179`, DELETE `admin.js:1275` → `1277`, PUT `admin.js:1356` → `1358`

---

## 13. Production Readiness Notes

### Query Safety
- **1000-row Supabase default limit:** All backend queries use explicit `.limit()` — no unbounded queries found. Safe for production.
- **Large analytics queries:** `adminAnalytics.js` uses `.limit(50000)` on 7 queries (financial summary, inventory, dead stock). These could hit memory limits at scale — monitor memory usage on analytics endpoints.

### Email Rate Limits (`src/services/emailService.js:15-24`)
| Limit | Value |
|-------|-------|
| Global hourly cap | 500 emails/hour |
| Per-user hourly cap | 10 emails/hour |
| Per-user daily cap | 50 emails/day |
| Batch size | 10 emails per batch |
| Batch delay | 1 second between emails |
| Max retries per email | 3 |
| Backoff base | 1 minute (exponential, max 1 hour) |

### Webhook Idempotency (4 layers)
1. **Event-level:** `is_webhook_processed` RPC checks if Stripe event ID was already handled
2. **Status-based:** Skip if order already in `paid`/`processing`/`shipped`/`completed`
3. **Atomic update:** `eq('status', 'pending')` ensures only one concurrent webhook succeeds
4. **Amount verification:** PaymentIntent amount must match order total in cents

### In-Memory State (single-instance only)
These use in-memory `Map` objects — **not shared across instances**. Multi-instance deployment would need Redis:

| State | Location | TTL | Concern |
|-------|----------|-----|---------|
| Order idempotency keys | `orders.js:44` | 5 minutes | Duplicate orders possible across instances (DB check is the backup) |
| Shipping rate cache | `shippingService.js:28-29` | 5 minutes | Stale rates possible across instances after admin CRUD |
| Email rate tracker | `emailService.js:28-32` | 1 hour (per-user), rolling | Rate limits not enforced across instances |

### Analytics Rate Limit
Admin analytics endpoints have a dedicated rate limiter: **20 requests/minute per admin** (`adminAnalytics.js:30-37`), separate from the global 100/min limit. This prevents expensive aggregation queries from being abused even with a valid admin token.

---

## 14. Frontend Safety Guide — Nullable Fields & Response Gotchas

This section documents every response shape inconsistency, nullable field, and defensive pattern the frontend must implement. **Treat this as a checklist before going live.**

### 14.1 Nullable Fields by Endpoint

#### POST /api/orders (Success Response)
| Field | Nullable? | Notes |
|-------|-----------|-------|
| `shipping_address.phone` | **Yes** | Optional in schema |
| `shipping_address.address_line2` | **Yes** | Optional in schema |
| `shipping_address.region` | **Yes** | Optional (but needed for shipping calc) |
| `shipping_address.country` | No | Defaults to `'NZ'` |
| `client_secret` | No | Always present on success |

#### POST /api/orders (Idempotent Replay — 200)
When the same `idempotency_key` is submitted again:
```json
{
  "ok": true,
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-XXXXX-XXXX",
    "status": "pending|paid|...",
    "total_amount": 99.95,
    "created_at": "ISO",
    "is_duplicate": true,
    "message": "Order already exists"
  }
}
```
**Important:** This response does NOT include `client_secret`, `items`, or `shipping_address`. Frontend should detect `is_duplicate: true` and redirect to order confirmation instead of trying to use `client_secret`.

#### GET /api/orders (List)
| Field | Nullable? | Notes |
|-------|-----------|-------|
| `order_items[].product` | **Yes** | Null if product was deleted from DB. Fallback to `product_name` and `product_sku` on the order item. |
| `invoice` | **Yes** | Null for orders created before invoice system or if invoice generation failed |
| `tracking_number` | **Yes** | Null until order shipped |
| `tracking_url` | **Yes** | Null if no tracking number |
| `shipping_phone` | **Yes** | Optional field |
| `estimated_delivery` | **Yes** | Null if not yet shipped |
| `paid_at` | **Yes** | Null if still pending |

#### GET /api/products & GET /api/products/:sku
| Field | Nullable? | Notes |
|-------|-----------|-------|
| `brand` | **Yes** | Null if brand_id doesn't exist. **Do NOT access `product.brand.name` without null check.** |
| `brand.logo_path` | **Yes** | Can resolve to null even when brand exists |
| `image_url` | **Yes** | Use placeholder image if null |
| `retail_price` | **Yes** | Extremely rare but possible. Do not add to cart if null. |
| `compatible_printers` | **Yes** | Only present for non-ribbon/non-label_tape consumable products. Ribbons use `compatible_devices` (via `/api/ribbons/:sku`). Label tapes have no compatibility data. |
| `compatible_cartridges` | **Yes** | Only present for printer products with `printer_model_id` |

#### GET /api/user/profile
- **Never returns 404.** Auto-creates profile with all null fields on first access.
- `first_name`, `last_name`, `phone`: all nullable

#### GET /api/account/me
- `profile`: **Can be null** if profile hasn't been created yet (unlike GET /user/profile which auto-creates)
- `roles`: Always an array (empty `[]` if not admin, never null)

#### GET /api/cart/coupon
- `data`: **Is `null`** (not empty object) when no coupon applied. Check `data === null`.

#### GET /api/user/favourites
- Deleted/inactive products are **silently filtered out**. If 5 items favourited and 2 products deleted, response has 3 items with no indication of removal.

### 14.2 Response Shape Inconsistencies

#### Cart Validation (`POST /api/cart/validate`)
The `issues` field is now always present as an array (empty `[]` when no issues). Previously it was omitted when empty — this has been fixed.

```js
// Safe pattern:
const { is_valid, issues, valid_items, summary } = response.data;
issues.forEach(issue => { /* always safe */ });
```

#### Cart Add (`POST /api/cart/items`)
- Returns **201** for new items, **200** for quantity updates (incrementing existing item)
- `quantity` in response is the **new total** (not the amount added)
- Sending `quantity: 2` when item already has `quantity: 1` results in `quantity: 3`

#### Coupon Errors (All Generic)
All coupon application failures return the same shape — frontend **cannot distinguish** between:
- Code doesn't exist
- Coupon expired
- Usage limit reached
- Per-user limit reached

```json
{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "Coupon could not be applied" } }
```

**Exception:** Minimum order amount errors include details:
```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Minimum order amount of $50.00 required",
    "details": { "minimum_required": 50.00, "current_subtotal": 25.00 }
  }
}
```

#### Auth Errors (All Identical 401)
All token failures (missing, malformed, expired) return the same 401 response. Frontend cannot distinguish — always attempt token refresh, then redirect to login.

### 14.3 Promo Coupon Silent Failure

If a promotional coupon's RPC redemption fails (DB error, not usage limit), the backend **silently drops the discount** and proceeds with the order at full price. The frontend has no indication the coupon wasn't applied.

**Defensive pattern:** After order creation, compare `total_amount` in the response against the frontend's expected total. If they differ, show a notice: "Your order total may differ from the estimate."

### 14.4 Stripe Error Handling

All Stripe errors in the order creation flow return:
```json
{ "ok": false, "error": { "code": "INTERNAL_ERROR", "message": "Failed to create payment intent" } }
```

Frontend cannot distinguish between card declined, Stripe outage, or rate limiting. Show a generic retry message. If user retries and gets the same error, suggest contacting support.

**Note:** Stripe errors during *payment confirmation* (client-side `confirmPayment()`) are handled by Stripe.js directly — those have detailed error codes. This only affects the initial PaymentIntent creation.

### 14.5 Empty String vs Null Handling

Joi validation with `convert: true` means:
- `phone: ""` → stored as `null` in DB, returned as `null` in responses
- `address_line2: ""` → stored as `null`, returned as `null`
- `customer_notes: ""` → stored as `null`, returned as `null`
- `shipping_tier: ""` → accepted (`.allow('')`), backend ignores it
- `shipping_zone: ""` → accepted (`.allow('')`), backend ignores it

**Pattern:** Always use `value || ''` or `value ?? ''` when rendering, never trust that optional string fields will be empty strings vs null.

### 14.6 Pagination Pattern Reference

All paginated endpoints use the same consistent pattern: top-level `meta` with `total`, `page`, `limit`, `total_pages`, `has_next`, and `has_prev`. No frontend workarounds needed.

### 14.7 Error Codes Quick Reference

| Code | Status | Meaning | Frontend Action |
|------|--------|---------|-----------------|
| `VALIDATION_FAILED` | 400 | Joi schema error | Show `error.details[]` per-field messages |
| `BAD_REQUEST` | 400 | Business logic error | Show `error.message` |
| `UNAUTHORIZED` | 401 | Token missing/expired/invalid | Refresh token → retry → login redirect |
| `EMAIL_NOT_VERIFIED` | 403 | Email not confirmed | Show verification prompt |
| `FORBIDDEN` | 403 | Not admin / RLS violation | Show access denied |
| `NOT_FOUND` | 404 | Resource doesn't exist | Show 404 page or redirect |
| `DUPLICATE_REQUEST` | 409 | Order in-flight (idempotency) | Wait 5-10s, poll GET /api/orders |
| `DUPLICATE_ORDER` | 409 | Order already created (DB) | Redirect to order confirmation |
| `COUPON_STACKING_NOT_ALLOWED` | 409 | Both coupon types active | Remove one coupon type |
| `PROMO_COUPON_LIMIT_REACHED` | 409 | Promotional coupon maxed out | Coupon is **retained** on cart — user must call `DELETE /api/cart/coupon` to remove it, then retry. Show: "The promotional coupon on your cart has reached its usage limit. Please remove the coupon from your cart and try again." No cart refresh needed (totals unchanged until coupon removed). |
| `CONFLICT` | 409 | DB unique constraint | Varies by endpoint |
| `RATE_LIMITED` | 429 | Too many requests | Exponential backoff, show "slow down" |
| `INTERNAL_ERROR` | 500 | Unhandled server error | Show generic error, suggest retry |
| `PAYMENT_ERROR` | 400+ | Stripe error | Show generic payment error |

---

## Verification Summary

- Endpoints verified: 103 (98 + 5 admin shipping CRUD)
- Line numbers corrected: ~195 (exhaustive audit 2026-02-27, +25 admin.js refs)
- Schema/param corrections: 0
- Endpoints added: 6 (GET /api/search/smart, 5x admin shipping CRUD)
- Endpoints removed: 0
- Breaking changes: 2 (PUT /api/admin/products/:sku → /by-sku/:sku; response envelope overhaul)
- Response shapes added: 5 (admin orders list, admin product update, diagnostics, bulk-activate, cart-summary)
- New sections: 3 (pagination patterns, non-JSON endpoints, production readiness)

---

### 2026-02-25 — Comprehensive Backend Audit & Line Reference Fix

**Doc-only changes (no code changes):**

Full audit of all backend source files against Frontend.md documentation. Fixed ~25 stale line number references caused by `requestId` and `responseTransform` middleware insertions in `server.js` and structural shifts across multiple files.

**Fixes by section:**

*Section 1 (System Overview):*
- Entry point: `server.js` export line 318 → 326
- Middleware pipeline: added missing `requestId` (L165) and `responseTransform` (L168) middleware to pipeline description
- All `server.js` line references updated (+8 shift): trust proxy, helmet, HTTPS redirect, CORS, rate limit, compression, body parsing, cookie parser, morgan, health check, root info, SEO routes, API routes, error handlers

*Section 2 (Base URL Rules):*
- PORT definition: `server.js:102` → `server.js:104`
- CORS configuration: `server.js:127-160` → `server.js:129-162`
- All CORS detail line refs updated (+2 shift): localhost pattern, no-origin, credentials, methods, headers, maxAge, blocked origin warning
- **Added `X-Request-Id` to CORS allowed headers list** (was present in code but missing from doc)

*Section 3 (Authentication Contract):*
- `requireAuth`: `auth.js:14` → `auth.js:15`
- `requireAdmin`: `auth.js:46` → `auth.js:47`
- `requireRole`: `auth.js:113` → `auth.js:102` (was significantly off)
- `optionalAuth`: `auth.js:148` → `auth.js:131` (was significantly off)
- `requireVerifiedEmail`: `auth.js:182` → `auth.js:165` (was significantly off)
- Admin roles `.in()` call: `auth.js:61` → `auth.js:62`

*Section 4 (API Endpoints):*
- Route registration block: `index.js:254-273` → `index.js:256-275` (all 20 mount lines shifted +2)
- Products `catalogLimiter`: `L17-24` → `L18-24`
- `GET /api/orders`: L897 → L907
- `GET /api/orders/:orderNumber`: L1036 → L1046
- Auth `GET /verification-status`: L36 → L30
- Auth `statusLimiter`: L23 → L20
- Auth `POST /resend-verification`: L61 → L55, redirect URL L83 → L77
- Auth `POST /verify-email`: L129 → L123
- Ribbons `catalogLimiter`: `L15-21` → `L17-23`

*Section 8 (Security Model):*
- Helmet: `server.js:105-114` → `server.js:108-116`
- Global rate limit: `server.js:162-168` → `server.js:171-176`
- Products rate limit: `products.js:17-24` → `products.js:18-24`
- Auth status rate limit: `auth.js:23-30` → `auth.js:20-24`
- Ribbons rate limit: `ribbons.js:15-21` → `ribbons.js:17-23`
- HTTPS enforcement: `server.js:117-125` → `server.js:119-127`
- Body size limits: `server.js:178-179` → `server.js:186-187`
- Trust proxy: `server.js:100` → `server.js:102`
- Webhook raw body: `server.js:175` → `server.js:183`

*Section 11 (Troubleshooting):*
- `requireAuth` code path: `auth.js:14-44` → `auth.js:15-45`
- `EMAIL_NOT_VERIFIED` code path: `auth.js:192-199` → `auth.js:165-179` (was significantly off)

*Utility endpoints table:*
- Health check: `server.js:192` → `server.js:200`
- Root info: `server.js:212` → `server.js:220`

**Frontend impact:** None. Documentation-only corrections. All API contracts, response shapes, and endpoint behaviors are unchanged.

### 2026-02-26 — Exhaustive Line Reference Audit (~150 corrections)

**Doc-only changes (no code changes):**

Full cross-reference audit of all ~150 `file:line` references in Frontend.md against current backend source code. Code refactoring since the last audit caused line numbers to drift by -1 to -236 lines depending on the file. All endpoint paths, auth requirements, request/response shapes, and business logic descriptions were already correct — only navigational `file:line` references were stale.

**Fixes by file:**
- `src/routes/index.js` — Route registration block: L256-275 → L258-277 (+2 shift, all 20 mount lines)
- `src/routes/products.js` — 8 endpoint refs corrected (drift -9 to -74)
- `src/routes/search.js` — 5 endpoint refs + searchLimiter + cost_price strip refs corrected (drift +2 to -35)
- `src/routes/orders.js` — 3 endpoint refs + PaymentIntent config + create_order_atomic + idempotency key + totals calculation corrected (drift +1 to -67)
- `src/routes/cart.js` — 11 endpoint refs + cartLimiter + cookie config corrected (drift +1 to -17)
- `src/routes/user.js` — 16 endpoint refs corrected (drift +1 to -170)
- `src/routes/auth.js` — 3 endpoint refs + both limiter refs + redirect URL corrected (drift +1 to -17)
- `src/routes/coupons.js` — 3 endpoint refs + 3 limiter refs corrected (drift -2 to +1)
- `src/routes/reviews.js` — 8 endpoint refs corrected (drift +1 to -26)
- `src/routes/business.js` — 2 endpoint refs + businessLimiter corrected (drift +1 to -18)
- `src/routes/shipping.js` — 2 endpoint refs corrected (drift +1 to -8)
- `src/routes/account.js` — 2 endpoint refs corrected (drift +1 to -11)
- `src/routes/newsletter.js` — 1 endpoint ref + newsletterLimiter corrected (drift +1)
- `src/routes/contact.js` — 2 endpoint refs + contactLimiter corrected (drift +1 to -2)
- `src/routes/cartAnalytics.js` — 4 endpoint refs + analyticsEventLimiter corrected (drift +1 to -14)
- `src/routes/admin.js` — 30 endpoint refs corrected (drift +1 to -236)
- `src/routes/analytics.js` — 9 endpoint refs corrected (drift +1 to -130)
- `src/routes/adminAnalytics.js` — 37 endpoint refs corrected (drift +1 to -101)
- `src/routes/ribbons.js` — 6 endpoint refs + catalogLimiter corrected (drift +1 to -23)
- Section 5 (Stripe Contract) — PaymentIntent config L480-496 → L451-467, idempotency key L495 → L466
- Section 6 (Order Lifecycle) — create_order_atomic L537-564 → L515-542, idempotency key L64-72 → L65-72, totals L88-119 → L89-119
- Section 8 (Security Model) — 13 rate limiter file:line refs corrected, cookie security ref corrected, 2 cost_price protection refs corrected
- Section 11 (Troubleshooting) — 3 code path refs corrected

**Frontend impact:** None. Documentation-only corrections. All API contracts, response shapes, and endpoint behaviors are unchanged.

### 2026-02-26 — Production Hardening

**Backend changes (no API contract changes):**

- **[CRITICAL] Webhook post-payment tasks now fire-and-forget** (`webhooks.js:248-262`). Previously `processPostPaymentTasks()` was awaited in the Stripe webhook handler, risking Stripe timeouts during slow email/GA4 calls. Tasks are now queued synchronously (DB insert) then processed in the background. Cron retries failures. Same pattern applied to `reconcilePayments` in `cron/jobs.js`.
- **[HIGH] Cron health check and invoice fix queries bounded** (`cron/jobs.js`). `healthCheck()` and `fixMissingInvoices()` previously used `.limit(10000)` which could exhaust memory as tables grow. Now scoped to last 90 days with 500-row limits, and invoice lookups use `IN (order_ids)` instead of fetching all invoices.
- **[HIGH] HSTS header added** (`server.js:108-120`). Helmet now includes `hsts: { maxAge: 31536000, includeSubDomains: true }` so browsers cache HTTPS-only policy for 1 year.
- **[MEDIUM] Printer search N+1 eliminated** (`products.js:428-441`). Compatible products count now uses `{ count: 'exact', head: true }` (Postgres-side count) instead of fetching all `product_compatibility` rows into memory.
- **[LOW] Order status audit trail** (`admin.js:41-56, 617-623, 680-686`). Admin order status changes (both cancellation and non-cancel transitions) now persist to `order_status_history` table via non-blocking insert. Records previous_status, new_status, changed_by (admin user ID), and notes.
- **[LOW] Structured logger utility added** (`src/utils/logger.js`). Lightweight JSON logger with `log.info/warn/error(event, data)` and `log.child(context)` for incremental adoption. Existing `console.log` statements unchanged.

**Frontend impact:** None. All changes are backend infrastructure. No API response shapes, endpoint paths, or auth requirements changed.

### 2026-02-26 — Admin Dashboard Backend (Schema + Endpoints + RPC)

**Database migrations** (`sql/migrations/001_admin_dashboard_schema.sql`, `002_admin_rpc_functions.sql`):
- Added `carrier` (TEXT), `delivered_at` (TIMESTAMPTZ) columns to `orders` table
- Added cost snapshot columns to `order_items`: `supplier_cost_snapshot`, `shipping_cost_snapshot`, `supplier_id`, `brand`, `category`
- Created `refunds` table with `refund_type`/`refund_status` enums and indexes
- Created `order_events` audit table (coexists with existing `order_status_history`)
- Created `suppliers` table
- Added triggers: `log_order_status_change()` (auto-logs status changes to `order_events`), `log_refund_created()` (auto-logs refund creation)
- Created RLS helpers `is_admin_or_owner()` and `is_owner()` using `admin_roles` table (not `profiles`)
- Enabled RLS + policies on `refunds`, `order_events`, `suppliers`
- Created 7 Supabase RPC functions: `admin_work_queue`, `analytics_fulfillment_sla`, `analytics_kpi_summary`, `analytics_revenue_series`, `analytics_brand_breakdown`, `analytics_refunds_series`, `get_suppliers`
- All functions use `SECURITY DEFINER STABLE SET search_path = ''` with fully qualified `public.` table references

**Endpoint changes** (`src/routes/admin.js`, `src/validators/schemas.js`):
- `PUT /api/admin/orders/:orderId` — `status` is now **optional** (was required). Added `carrier` and `shipped_at` fields. Allows metadata-only updates without state transitions. Schema has `.min(1)` to require at least one field.
- `GET /api/admin/orders/:orderId/events` — new endpoint, returns order audit trail
- `POST /api/admin/orders/:orderId/events` — new endpoint, creates manual notes
- `GET /api/admin/refunds` — new endpoint, paginated refund list with filters (date range, type, status, search)
- `POST /api/admin/refunds` — new endpoint, create refund/chargeback with 10-minute full-refund rule
- `PUT /api/admin/refunds/:refundId` — new endpoint, update refund status (pending → processed/failed)
- `GET /api/admin/export/:type` — new endpoint, CSV download for orders or refunds

**Doc updates:**
- Updated Section 4.17 (PUT orders): documented optional status, carrier, shipped_at fields
- Added Section 4.17b (Admin Refunds): GET list, POST create, PUT status
- Added Section 4.17c (Admin CSV Export): GET /api/admin/export/:type
- Added Section 4.17d (Admin Dashboard Supabase RPC Functions): all 7 functions, new tables, new columns
- Updated `ADMIN_BACKEND_HANDOFF.md`: corrected RLS helpers (`profiles` → `admin_roles`), order status flow, auth description, data relationships

**Frontend impact:** All new endpoints follow existing patterns (`requireAdmin` + `requireRole`, `formatSuccess`/`formatError` envelope). The only breaking change is `status` becoming optional on PUT orders — existing calls that send `status` continue to work identically.

### 2026-02-27 — Admin Order Customer Name Fields

**Endpoint changes** (`src/routes/admin.js`):
- `GET /api/admin/orders` (`admin.js:267`) — response now includes flat `customer_name` and `customer_email` on each order object
- `GET /api/admin/orders/:orderId` (`admin.js:388`) — same flat fields added to single-order response

**Field details:**
- `customer_name`: built from `user_profiles.first_name` + `user_profiles.last_name` (joined via existing `user` alias), falls back to `shipping_recipient_name`, or `null` if neither available
- `customer_email`: from the order's `email` column, or `null`

**No breaking changes.** The existing nested `user` object remains in the response. These are additive flat fields for convenience. No database, migration, auth, or middleware changes.

**Frontend impact:** Admin Orders and Fulfillment tables can now read `customer_name` directly instead of traversing nested `user_profile`/`user`/`customer` objects. The frontend fallback chain already checks `customer_name`, so customer columns should display names instead of "—" with no frontend code changes.

### 2026-02-27 — Weight-Based Shipping Calculator (NOW DEPRECATED)

**File:** `src/utils/shippingCalculator.js` — **DEPRECATED.** Kept for reference only. Uses an outdated 0.3 kg threshold and does not include Auckland zone or color pack logic. Not used by any endpoint or order flow. The active shipping logic is in `src/services/shippingService.js` with DB-driven rates.

### 2026-02-27 — Backend Verification Audit

**Doc-only changes (no code changes):**

Full verification of all backend route files against Frontend.md. Identified and corrected discrepancies from DB-driven shipping migration and Sentry init block insertion in `server.js`.

**Fixes by section:**

*Section 1 (System Overview):*
- Entry point export line: 359 → 363
- Middleware pipeline: all `server.js` line references updated (+4 shift from Sentry init block): HTTPS redirect L119→L122, CORS L138→L142, requestId L165→L169, rate limit L168-173→L172-177, timeouts L175-178→L179-182, compression L181→L185, raw body L185→L189, express.json L188→L192, urlencoded L189→L193, cookieParser L192→L196, morgan L195→L199, health L202→L206, readiness L223→L227, root L253→L257, SEO L259→L263, routes L262→L266, 404 L265→L269, error L266→L270

*Section 2 (Base URL Rules):*
- CORS configuration: `server.js:129-162` → `server.js:133-166` (+4 shift on all sub-references)
- HTTPS enforcement: `server.js:119-127` → `server.js:122-131`
- Non-API routes table: health L202→L206, ready L223→L227, root L253→L257

*Section 4 (Route Registration):*
- Block range: `index.js:258-277` → `index.js:274-295`
- All 20 mount line numbers updated (+16 shift)
- **Added missing `adminRibbonsRouter` (L293) and `adminShippingRouter` (L294)** to mount table

*Section 4.10 (Shipping):*
- `GET /api/shipping/rates` response shape completely rewritten — old hardcoded zone structure replaced with DB-driven `zones[].tiers[]` array format including `delivery_type` (urban/rural), `min_weight_kg`, `max_weight_kg` per tier
- `POST /api/shipping/options` line ref: L23 → L22, updated format description for weight-based calculation

*Section 4.14 (Settings):*
- **BREAKING DOC CHANGE:** `GET /api/settings` response shape rewritten — old flat `SHIPPING_FEE_AUCKLAND`, `SHIPPING_FEE_NORTH_ISLAND`, `SHIPPING_FEE_SOUTH_ISLAND`, `HEAVY_SURCHARGE` replaced with `shipping` object containing full DB-driven rate table from `getShippingRates()`

*Section 4.23 (Utility Endpoints):*
- Line refs updated: health L202→L206, ready L223→L227, root L253→L257, docs L27→L29

*NEW Section 4.19e (Admin Shipping Rates):*
- Documented 5 CRUD endpoints from `adminShipping.js`: GET list, GET detail, POST create, PUT update, DELETE (soft delete)
- All require `requireAdmin` + `requireRole('super_admin', 'stock_manager')`
- Changes invalidate shipping rate cache immediately

*Section 7 (Database Interaction Model):*
- Added "Current Migration Files" subsection documenting `001_create_order_atomic.sql` and `002_coupon_rpcs.sql` with key details (params, return types, atomicity guarantees)
- Added "Applied and removed migrations" reference table listing 7 historical migrations already in Supabase
- Fixed stale migration file reference in Section 4.17d (`001_admin_dashboard_schema.sql`, `002_admin_rpc_functions.sql` marked as historical)

*Section 8 (Security Model):*
- Helmet ref: `server.js:108-120` (confirmed correct)
- Global rate limit: `server.js:168-173` → `server.js:172-177`
- HTTPS enforcement: `server.js:119-127` → `server.js:122-131`
- Body size limits: `server.js:188-189` → `server.js:192-193`
- Webhook raw body: `server.js:185` → `server.js:189` (3 occurrences)

*Section 9 (Known Constraints):*
- Rewrote "Shipping (Zone-Based)" → "Shipping (DB-Driven Zone + Weight)" — reflects DB-driven rates, urban/rural delivery types, weight brackets, rate caching with invalidation

**Frontend impact:**
- **`GET /api/settings`** — `shipping` field is now a structured rate table, not flat fee constants. Frontend should use `shipping.zones` to display zone-specific rates
- **`GET /api/shipping/rates`** — Response includes `tiers[]` arrays per zone instead of flat `standard`/`heavy` fields
- **Admin shipping CRUD** — 5 new documented endpoints for managing shipping rates via admin panel

### 2026-02-27 — Zero-Trust Documentation Audit

**Doc-only changes (no code changes):**

Full zero-trust audit of Frontend.md against current backend source code. Focused on response shapes, pagination patterns, and stale line references in admin.js endpoints.

**Fixes:**

*Section 2c (Response Envelope):*
- Added **Pagination Pattern Inconsistencies** table documenting 3 distinct patterns (A: standard meta, B: `data.pagination` in refunds, C: partial meta in customers) with frontend workaround code

*Section 4.17 (Admin Orders):*
- Added explicit JSON response shape for `GET /api/admin/orders` — clarifies `data` is a raw array (not `{ orders: [...] }`)
- Documented `search` query param behavior: searches `order_number`, `email`, `shipping_recipient_name`
- Updated 2 stale line refs: orders/:orderId GET (269→286), PUT (368→417), events GET (2258→2307), events POST (2296→2345)

*Section 4.17b (Admin Refunds):*
- Updated 3 stale line refs: GET (2340→2389), POST (2415→2464), PUT (2474→2523)

*Section 4.17c (Admin Export):*
- Updated 1 stale line ref: GET (2525→2574)

*Section 4.18 (Admin Products):*
- Updated 8 stale line refs: list (633→682), diagnostics (733→782), bulk-activate (814→863), by-sku (883→932), detail (950→999), update (1048→1097), images POST (1179→1226), images DELETE (1277→1324), images reorder (1358→1405)
- Added full response shape for diagnostics endpoint (summary, by_product_type, inactive_products, filters_applied)
- Added dry_run and live response shapes for bulk-activate endpoint
- Added response shape for PUT product update — documents subset fields returned (not full product)

*Section 4.19 (Admin Business Applications):*
- Updated 4 stale line refs: list (1907→1956), detail (1980→2029), update (2053→2102), stats (2154→2203)

*Section 4.19b (Admin Customers):*
- Updated 1 stale line ref: (1795→1844)
- Added explicit response shape with customer fields
- Added **Pagination Pattern C caveat** — meta omits `has_next`/`has_prev`, frontend must compute

*Section 4.21 (Admin Analytics):*
- Updated GA4 summary line ref: (2201→2250)

*Section 4.15 (Cart Analytics):*
- Added response shape for cart-summary endpoint
- Added `period` format description (`Nd` pattern)
- Added `min_value` description for abandoned-carts

*Section 9 (Known Constraints):*
- Added **Non-JSON Endpoints** table (HTML unsubscribe, CSV export, XML sitemap, text robots.txt)

*New Section 13 (Production Readiness Notes):*
- Query safety (explicit `.limit()` on all queries, `.limit(50000)` analytics caveat)
- Email rate limits table (500/hr global, 10/hr per user, 50/day per user)
- Webhook idempotency 4-layer summary
- In-memory state table (order idempotency, shipping cache, email tracker) with multi-instance warnings
- Analytics rate limit (20 req/min per admin)

**Frontend impact:** None. Documentation-only. All API contracts, response shapes, and endpoint behaviors are unchanged.

---

### 2026-02-27 — Bug Fix: POST /api/orders shipping validation

**Problem:** `POST /api/orders` returned `400 VALIDATION_FAILED` when frontend sent `"shipping_zone": ""` or `"shipping_tier": ""`. Joi's `.valid(...).optional()` allows omission (undefined) but rejects empty strings — the frontend was sending empty strings.

**Root cause:** `src/validators/schemas.js:94-99` — `shipping_tier` and `shipping_zone` used `.valid(...).optional()` without `.allow('')`.

**Fix applied:** Added `.allow('')` to both `shipping_tier` and `shipping_zone` in `createOrderSchema`:
```js
shipping_tier: Joi.string().valid('free', 'standard', 'heavy', 'light').allow('').optional(),
shipping_zone: Joi.string().valid('auckland', 'north-island', 'north_island', 'south-island', 'south_island').allow('').optional()
```

**Frontend impact:** Frontend can now send `""` for `shipping_tier` and `shipping_zone` without triggering validation errors. Both fields remain optional — omitting them entirely also works. Backend ignores these values and recalculates shipping from `shipping_address.region`/`postal_code`.

**Documentation updates:**
- Section 4.3 (Orders): Added empty string acceptance note to validation constraints
- Section 4.3 (Orders): Added `VALIDATION_FAILED` to error table
- Section 11 (Troubleshooting): Added `VALIDATION_FAILED` troubleshooting entry with empty string guidance

### 2026-02-27 — Bug Fixes & Frontend Safety Audit

**Code fixes (3 bugs):**

1. **Idempotent order response shape** (`src/routes/orders.js:156`): `message` field was spread at top level (`{ ok, data, message }`) instead of inside `data`. Fixed — `message` and `is_duplicate` are now inside `data` where frontend expects them.

2. **Cart validate issues omission** (`src/routes/cart.js:746`): `issues` field was `undefined` (omitted from JSON) when no issues existed. Frontend doing `response.data.issues.length` would crash. Fixed — `issues` is now always an array (empty `[]` when no issues).

3. **Shipping validation** (previous entry): `shipping_zone: ""` and `shipping_tier: ""` rejected by Joi. Fixed with `.allow('')`.

**Documentation additions:**

- Section 4.3 (Orders): Added `PROMO_COUPON_LIMIT_REACHED` error code, expanded idempotent replay response shape (no `client_secret`), expanded frontend error handling example with `is_duplicate` check
- Section 11 (Troubleshooting): Added `VALIDATION_FAILED` entry
- **New Section 14 (Frontend Safety Guide):** Comprehensive reference covering:
  - 14.1: Nullable fields by endpoint (orders, products, profile, cart, account)
  - 14.2: Response shape inconsistencies (cart validation, cart add, coupon errors, auth errors)
  - 14.3: Promo coupon silent failure pattern
  - 14.4: Stripe error handling limitations
  - 14.5: Empty string vs null field handling
  - 14.6: Pagination pattern reference (all consistent)
  - 14.7: Complete error codes quick reference table

**Frontend impact:** Two response shapes changed:
1. Idempotent order replay: `message` moved from top-level to inside `data`
2. Cart validate: `issues` now always present (empty array vs omitted)

---

### Changelog — 2026-02-28 (B3: gst_amount)

**Backend changes (from BACKEND_VERIFY.md review):**

- **`POST /api/orders` (201 response):** Added `gst_amount` field (number, 2 decimal places). Value is the GST component from the order total, stored in DB during order creation.
- **`GET /api/orders/:orderNumber`:** `gst_amount` already included via object spread — no code change, now documented.
- **`GET /api/cart` summary:** Added `gst_amount` to `data.summary`. Computed as `total * 0.15 / 1.15` (GST extracted from GST-inclusive total). Frontend can use this directly instead of computing client-side.

**Documentation updates:**
- Section 4.3 (Orders): Added `gst_amount` to POST /api/orders 201 response shape, added to GET /api/orders/:orderNumber description
- Section 4.4 (Cart): Added `gst_amount` to GET /api/cart summary shape

**Frontend action required:**
- Read `Config.settings.GST_RATE` (uppercase) — the settings endpoint returns `GST_RATE`, not `gst_rate`
- When `gst_amount` is present in a response, use it directly instead of recalculating

---

### Changelog — 2026-02-28 (BACKEND_HANDOFF_2 responses)

**Code fixes (2 changes in `src/routes/cart.js`):**

1. **GET /api/cart orphaned item auto-cleanup** (L253–272): When a cart item references a deleted product (`item.product` is null), the backend now auto-deletes the orphaned `cart_items` row and includes a `removed_items` array in the response. Previously, orphaned items were silently filtered from the response but remained in the database.

2. **GET /api/cart/count accuracy fix** (L634, L649–651): Cart count endpoint now joins with the `products` table and excludes deleted/inactive products. Previously, the badge count could be higher than the number of items actually rendered in the cart.

**Confirmations (no code changes):**

3. **Post-login parallel safety:** `accountSync` → then `mergeCart`, `claimSignupCoupon`, `getAccountMe`, and favourites sync can all run in parallel. `mergeCart` uses user ID from JWT (not `user_profiles`), and `mergeCart`/`claimSignupCoupon` write to separate tables with no lock conflicts.

4. **Rate limiting:** 4 concurrent post-login requests will not trigger any rate limiter. Global limit is 100/min per IP. Per-endpoint limits: cart 60/min, claim-signup 5/15min. No stagger needed.

5. **Promo coupon retention:** After `PROMO_COUPON_LIMIT_REACHED` (409), the coupon is **retained** on the cart. User must manually remove it via `DELETE /api/cart/coupon`. Current frontend error message is correct. No cart refresh needed.

**Documentation updates:**
- Section 4.4 (Cart): Added `removed_items` to GET /api/cart response shape, added deleted product handling note
- Section 4.4 (Cart): Updated GET /api/cart/count line ref (608 → 626), added note about excluded items
- Section 10 (Post-Login Flow): Documented parallel safety — steps 2–5 can run via `Promise.allSettled`
- Section 14.7 (Error codes): Expanded `PROMO_COUPON_LIMIT_REACHED` with coupon retention details

**Frontend action required:**
- Optionally handle `data.removed_items` from GET /api/cart — show a toast when items are auto-removed. Existing `.filter(item => item.product != null)` guard can stay as a safety net
- No changes needed for post-login flow, rate limiting, or promo coupon handling — current implementation is correct

---

### Changelog — 2026-02-28 (Backend Audit Bug Fixes)

**Code fixes (4 bugs):**

1. **[HIGH] Pricing margin GST bug** (`src/utils/pricing.js:117,155`): `applyGenuineEnding()` and `applyCompatibleEnding()` compared margin thresholds against GST-inclusive prices, inflating the apparent margin by ~15%. Fixed — margin is now computed on the ex-GST price. Impact: compatible cartridges at $10+ cost now correctly get `.49` ending instead of `.79`. To apply corrected prices to existing DB products, re-run `node scripts/compatible.js`.

2. **[MEDIUM] Admin refunds non-standard pagination** (`src/routes/admin.js:2436`): `GET /api/admin/refunds` nested pagination in `data.pagination` instead of top-level `meta`, and was missing `total_pages`, `has_next`, `has_prev`. Fixed — now uses standard `meta` with all 6 fields.

3. **[MEDIUM] Admin customers missing pagination fields** (`src/routes/admin.js:1885`): `GET /api/admin/customers` meta was missing `has_next` and `has_prev`. Fixed — meta now includes all 6 standard fields.

4. **[LOW] Promo coupon order link error handling** (`src/routes/orders.js:734`): Supabase `{ error }` return on coupon_usage `order_id` update was silently ignored (only thrown exceptions were caught). Fixed — now captures `{ error }` and logs `promo_coupon:order_link:db_error` event.

**Documentation updates:**
- Section 2c: Replaced "Pagination Pattern Inconsistencies" (3-pattern table + workaround code) with single consistent "Pagination" section
- Section 4.17b: Updated `GET /api/admin/refunds` response shape to use top-level `meta`
- Section 4.19b: Removed "Pagination caveat (Pattern C)" from `GET /api/admin/customers`, updated response shape
- Section 14.6: Replaced 3-pattern table with single-pattern reference
- Updated 11 stale `admin.js` line refs shifted by pagination fixes

**Frontend action required:**
- **Admin refunds:** Replace `response.data.pagination` reads with `response.meta` (standard pattern)
- **Admin customers:** Remove `has_next`/`has_prev` computation workaround — values now provided by backend
- No action needed for pricing fix (backend-only) or coupon error handling fix (non-fatal logging)

### 2026-02-28 — Remove signup coupon system, fix order 500 error surfacing

**Changes:**

1. **Removed signup coupon system entirely:**
   - Deleted `src/routes/coupons.js` (claim-signup, my-coupons, redeem endpoints)
   - Deleted `src/services/couponService.js` (validateCoupon, redeemCoupon, unredeemCoupon)
   - Removed coupon route registration from `src/routes/index.js`
   - Removed `coupon_code` field from `POST /api/orders` request body
   - Removed `COUPON_STACKING_NOT_ALLOWED` error (no longer possible)
   - Removed coupon validation errors (400/403/404) from order creation
   - Only promotional coupons (via `POST /api/cart/coupon`) remain

2. **Improved order creation error surfacing:**
   - `create_order_atomic` RPC failures now return `ORDER_DB_ERROR` with the PostgreSQL error code in the message (e.g. `"Failed to create order (DB: 42883)"`)
   - Generic catch block now logs structured JSON with error name, message, code, and stack trace
   - Added `sql/migrations/025_fix_create_order_atomic.sql` — must be applied to production Supabase to fix the 500 error

**Frontend action required:**
- **Remove `coupon_code` from order request:** Do not send `coupon_code` in `POST /api/orders`. Promotional coupons are applied automatically from `user_applied_coupons`.
- **Remove coupon stacking logic:** No need to check for `COUPON_STACKING_NOT_ALLOWED` error.
- **Remove signup coupon UI:** Remove any calls to `POST /api/coupons/claim-signup`, `GET /api/coupons/my`, `POST /api/coupons/redeem`.
- **Remove `claimSignupCoupon` from post-login flow:** No longer needed after authentication.
- **Handle new `ORDER_DB_ERROR`:** Show generic "Order could not be processed, please try again" message.

### 2026-02-28 — Fix create_order_atomic overloads & column mismatch

**Database changes (no code changes):**

Fixed two issues preventing order creation:

1. **PGRST203 — Ambiguous function overloads:** Three versions of `create_order_atomic` existed in the database (20-arg varchar, 25-arg varchar, 25-arg text). PostgREST could not disambiguate between the two 25-arg versions. Dropped the 20-arg and 25-arg varchar overloads, leaving only the 25-arg `text`-params version.

2. **42703 — Column "sku" does not exist:** The remaining function's INSERT into `order_items` referenced columns `sku` and `name`, but the actual table uses `product_sku` and `product_name`. Fixed the function body to use the correct column names.

3. **Security hardening:** Updated `search_path = ''` (was `search_path = public`) with explicit `public.` schema prefixes on all table references.

**Diagnostic query** (verify fix is applied):
```sql
-- Should return exactly 1 row with pronargs = 25
SELECT proname, pronargs FROM pg_proc WHERE proname = 'create_order_atomic';
```

**Frontend action required:** None — this was a backend/database-only fix. Order creation (`POST /api/orders`) now works correctly.

### 2026-02-28 — Fix order CHECK constraint violation & GA4 tax reporting

**Code changes (commit `979cf62`):**

1. **[CRITICAL] Fix 23514 CHECK constraint violation in order creation:**
   - The `order_items` table enforces `CHECK (line_total = unit_price * quantity)`. The previous code adjusted the last item's `line_total` to absorb rounding residuals, which violated this constraint and caused all orders to fail with a 500 error.
   - **Fix:** Removed the residual `line_total` adjustment. Now `p_subtotal` is derived from the sum of per-item `line_total` values (which satisfy the CHECK), and `p_gst_amount` absorbs the cent-level rounding difference. The customer-facing `total` is unchanged.
   - **Files:** `src/routes/orders.js:473-481`

2. **Fix GA4 purchase events reporting zero tax:**
   - `ga4Service.js` queried column `gst` (does not exist) instead of `gst_amount`, causing `tax: 0` on all GA4 purchase events.
   - **Fix:** Corrected column name to `gst_amount`.
   - **Files:** `src/services/ga4Service.js:25,52`

3. **Updated tests:** Rounding tests now validate the new approach — each item satisfies `line_total = unit_price * quantity`, and `subtotal + gst` equals the GST-inclusive total.

**Frontend action required:** None — no API response shapes changed. The `subtotal` and `gst_amount` fields in order responses may shift by 1-2 cents compared to before (the accounting split between ex-GST and GST), but `total` is always identical. GA4 analytics will now correctly report tax amounts.

### 2026-03-01 — Add `compatibility` field to ribbon update endpoint

- `PUT /api/admin/ribbons/:ribbonId` now accepts `compatibility` (string, max 2000 chars, optional) in the request body.
- Previously this field could only be set on create or via feed import — it can now be edited by admins.
- **Files:** `src/validators/schemas.js` (`updateRibbonSchema`), `src/routes/adminRibbons.js` (allowed fields list)
- **Frontend action:** Admin ribbon edit form can now include a `compatibility` text field.

### 2026-03-01 — Security hardening (hostile audit findings)

**Code changes:**

1. **Newsletter anti-enumeration** (`newsletter.js:47`): Response message is now always `"Thank you for subscribing!"` for both new and duplicate subscriptions. Previously returned `"Subscribed successfully"` vs `"Already subscribed"`, which allowed email enumeration.

2. **Coupon brute-force rate limiter** (`cart.js:805-816`): `POST /api/cart/coupon` now has a dedicated `couponLimiter` (5 attempts per user per 5 minutes) in addition to the existing `cartLimiter`. 6th attempt within the window returns 429.

3. **Contact auto-reply removed** (`contact.js:67`): The auto-reply email to the customer-supplied address has been removed to prevent email relay abuse. Only the support team notification email is sent. The HTTP response still confirms receipt.

4. **Order RLS defense-in-depth** (`orders.js:125`): `POST /api/orders` handler now uses `setupSupabaseWithUser(req.token)` for user-scoped operations (product reads, address reads/inserts, post-creation order fetch) and `setupSupabaseAdmin()` only where service role is required (RPCs, coupon table, idempotency check). No API contract change.

5. **Cron cleanup-emails validation** (`admin.js:1557`, `schemas.js:571`): `POST /api/admin/cron/cleanup-emails` now validates `max_age_hours` via Joi (`cronCleanupEmailsSchema`: integer, min 1, max 168, default 24). Previously accepted unvalidated body input — `max_age_hours=0` could delete recent emails.

**Frontend action required:**
- If the frontend displayed different messages for new vs existing newsletter subscriptions, update to show the unified `"Thank you for subscribing!"` message.
- If the frontend showed a "we'll send you a confirmation email" message after contact form submission, remove it — no auto-reply is sent.
- Coupon apply may now return 429 after 5 attempts in 5 minutes — handle the `RATE_LIMITED` error code.

### 2026-03-01 — Fix broken analytics RPC functions (search_path qualification)

**Database changes (no code changes):**

The 6 analytics RPC functions from `002_admin_rpc_functions.sql` were deployed with unqualified table references (e.g. `orders` instead of `public.orders`) despite having `SET search_path = ''`. This caused all 6 functions to fail with `42P01: relation "orders" does not exist` when called from the frontend admin SPA.

**Functions fixed:**
- `admin_work_queue()` — referenced `orders`, `refunds` → `public.orders`, `public.refunds`
- `analytics_kpi_summary()` — referenced `orders`, `order_items`, `refunds`, `suppliers` → all `public.`-qualified
- `analytics_revenue_series()` — referenced `orders`, `order_items`, `suppliers` → all `public.`-qualified
- `analytics_brand_breakdown()` — referenced `orders`, `order_items`, `suppliers` → all `public.`-qualified
- `analytics_fulfillment_sla()` — referenced `orders`, `order_items`, `suppliers` → all `public.`-qualified
- `analytics_refunds_series()` — referenced `refunds`, `orders`, `order_items` → all `public.`-qualified
- `get_suppliers()` — re-deployed for consistency (was already working)

**Migration:** `sql/migrations/009_fix_analytics_rpc_search_path.sql` (applied)

**Frontend impact:** The admin dashboard analytics tabs (`admin_work_queue`, `analytics_kpi_summary`, `analytics_revenue_series`, `analytics_brand_breakdown`, `analytics_fulfillment_sla`, `analytics_refunds_series`) previously returned 500 errors with `42P01` — all now return correct JSON responses. No frontend code changes needed; the response shapes are unchanged from the original spec in Section 7.

### 2026-03-01 — Fix ribbon compatibility data consistency issues

**Code changes:**

1. **`margin_percent` consistency** (`scripts/import-ribbons.js:96–102`): The import script's `calculateRibbonPrice` wrapper was storing the tiered margin rate (35/28/22%) as `margin_percent`. Changed to compute the actual realized margin `((finalPrice - costPrice) / costPrice) * 100`, matching the formula used by admin PUT/POST handlers in `adminRibbons.js`.

2. **Normalize `device_brand`/`device_model` before RPC** (`src/routes/ribbons.js:46–47`): `GET /api/ribbons` now applies `.toLowerCase().trim()` to `device_brand` and `device_model` query params before passing them to the `filter_ribbons_by_device()` RPC. Previously these were passed raw, while `GET /api/ribbons/device-models` already normalized — this caused mismatches when users passed mixed-case values (e.g. `device_brand=Epson` would fail to match the lowercase `device_brand_norm` column).

3. **Slash-variant suffix parsing** (`scripts/ribbon-compat/config.js:253–258`): Fixed an edge case where models like `"LQ-590/II"` produced a standalone entry `"II"` instead of the correct `"LQ-590II"`. Letter-only suffixes (no digits) after a slash are now appended to the base model. Variants with digits (e.g. `"SP742"`) remain standalone as before.

4. **Ribbon pricing test coverage** (`__tests__/pricing.test.js`): Added 21 tests across 6 `describe` blocks covering `RIBBON_MARGINS`/`RIBBON_ENDINGS` constants, `getRibbonMargin` tier boundaries, `applyRibbonEnding` threshold behavior, `calculateRibbonPrice` happy-path arithmetic and guards, and `calculateRibbonPriceDetailed` return shape.

**Frontend action required:** None — no API response shapes changed. `device_brand`/`device_model` filtering on `GET /api/ribbons` is now case-insensitive, which may return results that were previously missed when passing non-lowercase values.

### 2026-03-01 — Security audit implementation (F1-F8, F10)

**Code changes:**

1. **[NEW] Cloudflare Turnstile bot protection** (`src/middleware/turnstile.js`): `POST /api/contact` and `POST /api/newsletter/subscribe` now verify a Turnstile token when `TURNSTILE_SECRET_KEY` is configured. Both Joi schemas accept an optional `turnstile_token` field (string, max 2048 chars). Fails closed in production if Cloudflare is unreachable (returns `503 TURNSTILE_UNAVAILABLE`); fails open in dev/staging. Returns `400 TURNSTILE_MISSING` or `403 TURNSTILE_FAILED`.

2. **[NEW] Checkout timeout recovery endpoint** (`src/routes/orders.js`): `GET /api/orders/check-pending` returns the most recent pending order from the last 30 minutes. Auth required. Use when checkout times out to detect if the order was actually created.

3. **[NEW] Coupon daily cap + progressive backoff** (`src/routes/cart.js`): `POST /api/cart/coupon` now has a third rate-limiting layer: 50 attempts/day per user/IP, with 1-hour block after 20 failures. Returns `429` with `retry_after` (seconds). Existing `couponLimiter` (5/5min) and `cartLimiter` (60/min) are unchanged.

4. **[NEW] Guest session flood protection** (`src/routes/cart.js`): New guest session creation limited to 10 per IP per hour. Exceeding returns `429 "Too many guest sessions."`. Existing sessions (cookie-based) are unaffected.

5. **[NEW] Admin import trigger endpoints** (`src/routes/admin.js`): `POST /api/admin/import/genuine` and `POST /api/admin/import/compatible` — triggers feed imports via admin panel or cron. Secured by `verifyCronAuth` (CRON_SECRET or super_admin). Returns import output on success. 10-minute timeout. Concurrent runs blocked (409).

6. **[NEW] Health check email alerts** (`src/cron/scheduler.js`): Daily health check now sends email + Sentry alert when status is `degraded` or `critical`. Uses existing `emailService` infrastructure.

7. **[NEW] Sentry Express error handler** (`src/server.js`): Added `Sentry.setupExpressErrorHandler(app)` before error middleware. Uncaught exceptions and unhandled rejections now report to Sentry.

8. **[NEW] CI pipeline** (`.github/workflows/ci.yml`): Runs `npm run lint` + `npm test` on push/PR to main. Node 18 + 20 matrix.

9. **[DB] Stock constraint migration** (`scripts/migrations/001_stock_quantity_check_constraint.sql`): `CHECK (stock_quantity >= 0)` — must be run manually in Supabase SQL editor.

**Frontend action required:**

- **Contact form + newsletter:** Add Cloudflare Turnstile widget and include `turnstile_token` in request body. See **Section 8 — Cloudflare Turnstile** for integration guide. No changes needed until `TURNSTILE_SECRET_KEY` is set on backend.
- **Checkout timeout handling:** On timeout/network error during `POST /api/orders`, call `GET /api/orders/check-pending` before showing an error or allowing retry. If `has_pending_order: true`, redirect to order status page.
- **Coupon errors:** Handle new `429` responses with `retry_after` field on `POST /api/cart/coupon`. Show the message from the response body.
- **Guest cart 429:** Handle `429` on `POST /api/cart/items` for unauthenticated users (edge case, unlikely for real users).

**No frontend changes needed for:** CI pipeline, Sentry, health check alerts, admin import endpoints, stock constraint.

**Updated sections:** 4.3 (new check-pending endpoint), 4.4 (coupon rate limits), 4.12 (newsletter Turnstile), 4.13 (contact Turnstile), 8 (Turnstile integration guide, guest session limits, rate limiting table).

### 2026-03-01 — Hostile production security audit

**Code changes:**

1. **[CHANGED] Turnstile fail-closed in production** (`src/middleware/turnstile.js`): If Cloudflare Turnstile API is unreachable in production, requests are now **rejected** with `503 TURNSTILE_UNAVAILABLE` instead of allowed through. Dev/staging still fails open. Frontend should handle `503` on contact/newsletter forms with a "service temporarily unavailable" message.

2. **[CHANGED] Webhook routes now have a 60s timeout** (`src/middleware/requestTimeout.js`): Previously webhook routes had no timeout at all. Now they get a generous 60s ceiling to prevent hung handlers from holding resources indefinitely. No frontend impact (Stripe-to-backend communication).

3. **[NEW] Per-admin rate limiting** (`src/routes/admin.js`): Admin orders listing, customers listing, and data export endpoints now have a per-user rate limit of 30 requests/minute. Prevents compromised admin accounts from rapid data exfiltration. Returns standard `429 RATE_LIMITED`.

4. **[CHANGED] Stale order cancellation: 24h → 1h, daily → every 30 min** (`src/cron/scheduler.js`, `src/cron/jobs.js`): Unpaid pending orders are now cancelled after 1 hour (was 24 hours) and the job runs every 30 minutes (was daily). Reduces stock lock-up window from unpaid orders. Frontend impact: users have ~1 hour to complete payment instead of 24 hours.

5. **[NEW] DB-backed rate limiting** (`src/routes/cart.js`, `scripts/migrations/003_rate_limit_entries.sql`): Coupon daily cap and guest session flood protection now sync to a `rate_limit_entries` database table for cross-instance consistency. In-memory Maps remain as fast-path cache. No API change — same `429` responses.

6. **[NEW] Orphaned PaymentIntent detection** (`src/cron/jobs.js`): `reconcilePayments` cron now includes Phase 2 — lists recent succeeded Stripe PaymentIntents and cross-references with orders table. Orphaned PIs (money captured but no order record) are logged with severity `critical` for manual reconciliation. No frontend impact.

7. **[DB] Order constraint migrations** (`scripts/migrations/002_order_constraints.sql`): Added `UNIQUE INDEX` on `orders(user_id, idempotency_key)` and `orders(payment_intent_id)`, plus `CHECK` on `order_items(line_total)`. Must be run manually in Supabase SQL editor.

8. **[DB] Rate limit table** (`scripts/migrations/003_rate_limit_entries.sql`): New `rate_limit_entries` table with RLS enabled. Must be run manually in Supabase SQL editor.

9. **[NEW] Supabase SQL version control** (`sql/functions/`): All 14+ RPC functions now have version-controlled reference copies. `sql/README.md` documents the workflow.

10. **[NEW] Constraint verification script** (`scripts/verify-constraints.js`): Calls `verify_db_integrity` RPC to check all expected constraints, indexes, and functions exist. Exit code 0/1 for CI use.

**Frontend action required:**

- **Turnstile 503 handling:** Handle new `503 TURNSTILE_UNAVAILABLE` on `POST /api/contact` and `POST /api/newsletter/subscribe` in production. Show "Service temporarily unavailable, please try again."
- **Stale order window:** Inform users that unpaid orders now expire after ~1 hour. Update any "complete payment within 24 hours" messaging to reflect the shorter window.

**No frontend changes needed for:** webhook timeouts, per-admin rate limits, DB-backed rate limiting, orphaned PI detection, SQL migrations, constraint verification, SQL version control.

**Updated sections:** 1 (updated date), 8 (rate limiting table — added admin limiter; Turnstile — fail-closed behavior; middleware pipeline — timeout values).

---

### Changelog — 2026-03-01 (Shipping Logic Fixes)

7 shipping issues fixed. Most impactful: GST on orders now correctly covers shipping charges.

1. **[HIGH] GST now includes shipping on tax invoices** (`src/routes/orders.js:88-121`): `calculateTotals` now extracts GST from `items + shipping - discount` instead of items-only. Shipping fees in NZ are GST-inclusive, so the previous formula understated GST. The `subtotal` field remains items-only ex-GST; `total` is unchanged. The `gst` and `gst_amount` fields will be slightly higher on orders with non-zero shipping.

2. **[FIX] Fallback shipping accepts zone keys** (`src/constants/shipping.js:63`): The hardcoded fallback `calculateShipping` now recognizes zone keys (`south-island`, `north-island`, `auckland`) directly, not just region names. Previously, passing `south-island` fell through to `north-island` default rates.

3. **[FIX] Gap tolerance in rate lookup** (`src/services/shippingService.js`): When DB rates have a gap in weight ranges (no exact match), the service now finds the closest rate for the zone+delivery_type instead of falling to hardcoded constants. A warning is logged.

4. **[NEW] Gap detection on admin shipping CRUD** (`src/routes/adminShipping.js`): `POST`, `PUT`, and `DELETE` responses for shipping rates now include `meta.gap_warnings` (string array) when the affected zone+delivery_type has non-contiguous weight ranges. Warnings are non-blocking.

5. **[FIX] Public shipping endpoint uses anonymous client** (`src/routes/shipping.js:3,25,35`): `POST /api/shipping/options` now uses `setupSupabase()` instead of `setupSupabaseAdmin()`. Products are public-readable via RLS; no admin client needed.

6. **[FIX] Lightweight shipping estimate weight** (`src/routes/shipping.js:61-66`): `item_count`-based requests now assume 0.5 kg per item (middle ground between 0.1 kg ink and 2 kg toner) instead of `null` (which fell to 0.1 kg fallback). `product_type` changed from `consumable` to `unknown`.

**Frontend action required:**

- **GST display:** If displaying `gst_amount` from order responses, values will be slightly higher on orders with non-zero shipping (now includes GST on shipping). No code change needed — just use the value as-is.

**No frontend changes needed for:** fallback zone-key fix, gap tolerance, admin gap detection warnings, anonymous client switch, lightweight weight change.

**Updated sections:** 4.10 (shipping options format note), 4.19b (admin shipping — gap_warnings in meta), 6 (order totals — GST formula), 7.4 (shipping notes — gap tolerance, gap detection, zone-key fallback).

---

### Changelog — 2026-03-01 (Shipping Rate Overhaul + Color Pack Weight)

Shipping rates updated to match new spec. Color pack shipping override added. Product weights for color packs fixed.

1. **[HIGH] Shipping rates updated** (`src/constants/shipping.js`): Fallback rates rewritten to match spec — Auckland flat $7/$14, North Island 2-tier (<0.5 kg $7/$14, >=0.5 kg $12/$20), South Island 3-tier (<0.5 kg $7/$14, >=0.5 kg $12/$20, >=2 kg $22/$30). Old `.95` prices and product-type heavy detection (drums, toner count, `HEAVY_SURCHARGE`) removed entirely.

2. **[NEW] Color pack shipping override** (`src/services/shippingService.js`): Orders containing CMY/KCMY/CMYK color packs are assigned a minimum effective weight of 2.0 kg. This forces color packs to the highest tier per zone: NI $12/$20, SI $22/$30, Auckland flat (unaffected). Regular items with the same actual weight (e.g., 3 individual ink cartridges = 0.3 kg) are NOT affected — only items with `color` = CMY/KCMY/CMYK trigger the override.

3. **[FIX] Color pack product weights** (`src/utils/colorPackGenerator.js`): CMY packs now weigh 0.3 kg (3 × 0.1 kg), KCMY packs weigh 0.4 kg (4 × 0.1 kg). Previously used dynamic `constituents.length × getProductWeight()` which could produce incorrect results.

4. **[FIX] Shipping routes pass color data** (`src/routes/shipping.js`, `src/routes/orders.js`): Product queries now fetch `color` and `pack_type` fields, passing them to the shipping calculator so color pack detection works.

**Frontend action required:**

- **Shipping fee display:** If caching or hardcoding shipping rates client-side, update to new values. Use `GET /api/shipping/rates` or `GET /api/settings` for current rates.
- **Shipping rate table:** The `GET /api/shipping/rates` response structure is unchanged but Auckland now returns 2 tiers (urban + rural, flat), North Island returns 4 tiers (2 weight × 2 delivery), South Island returns 6 tiers (3 weight × 2 delivery).

**No frontend changes needed for:** color pack weight fix, color pack shipping override (handled server-side), route field additions.

**Updated sections:** 4.3 (order shipping_tier enum), 4.10 (shipping options response + color pack note), 4.10 (shipping rates full example), 4.14 (settings shipping example), 6 (order totals — weight-tier rates replacing $4 surcharge), 7.4 (shipping constraints — full rewrite with zone rates, color pack override, product weights), 7.4 (deprecated shippingCalculator note), 7.4 (color packs — weight + shipping rules).

---

### 2026-03-02 — Label Tape Split from Ribbon + Consumable Filter Fixes

**Summary:** Label tapes (P-touch TZe tapes, DK/CZ label rolls) are now a distinct `product_type='label_tape'` instead of being stored as `product_type='ribbon'`. Consumable/cartridge filters now exclude ribbons and label tapes (they have dedicated types). Search endpoint supports ribbon and label_tape type filtering with proper compatibility enrichment.

**Files changed:**
- `src/constants/productTypes.js` — Added `label_tape` to `CONSUMABLE_TYPES`; added `CARTRIDGE_TYPES` constant (consumables excluding `ribbon` and `label_tape`)
- `src/utils/feedHelpers.js` — `mapProductTypeToDBValue()` no longer maps `label_tape` → `ribbon`; added `label_tape: 0.1` to `PRODUCT_WEIGHT_KG`
- `src/validators/schemas.js` — Added `label_tape` to `productQuerySchema` type filter; updated `fullProductUpdateSchema` `product_type` to match actual DB types (`ribbon`, `label_tape`, `photo_paper`, `belt_unit`, `fuser_kit`, `fax_film`, `fax_film_refill`)
- `src/routes/products.js` — `category=consumable`/`type=consumable`/`type=cartridge` now use `CARTRIDGE_TYPES` (excludes ribbons and label tapes)
- `src/routes/search.js` — `searchByPartSchema` accepts `type=consumable`/`ribbon`/`label_tape`; type filter excludes ribbons+label_tapes from consumable results; ribbon enrichment uses `ribbon_compatibility` table (returns `compatible_devices`); `compatible-printers/:sku` endpoint handles ribbons separately (returns `compatible_devices` from `ribbon_compatibility`)
- `scripts/migrations/004_add_label_tape_product_type.sql` — Adds `label_tape` to DB CHECK constraint; reclassifies existing label products from `ribbon` to `label_tape`

**Breaking changes:**

1. **`GET /api/products?type=consumable` and `?category=consumable`** — No longer includes ribbons or label tapes. Use `type=ribbon` or `type=label_tape` to query those separately.
2. **`GET /api/search/by-part?type=cartridge`** — No longer includes ribbons or label tapes in results. Use `type=ribbon` or `type=label_tape`.
3. **`GET /api/search/by-part`** — Ribbon results now include `compatible_devices` (array of `"brand model"` strings from `ribbon_compatibility`) instead of empty `compatible_printers`. Label tape results have no compatibility field.
4. **`GET /api/search/compatible-printers/:sku`** — For ribbon SKUs, response shape changes from `{ cartridge, compatible_printers }` to `{ ribbon: { sku, name }, compatible_devices: [{ brand, model }], total }`.
5. **`product_type` values** — Products previously stored as `product_type='ribbon'` that are actually label tapes/rolls (TZe, DK, CZ, HG prefixes) are now `product_type='label_tape'`. Ribbon endpoints (`/api/ribbons/*`, `/api/admin/ribbons/*`) no longer return label tape products.

**Frontend action required:**

- **Product type filters:** If the frontend has a "consumables" or "cartridges" filter, ribbons and label tapes no longer appear there. Add separate filter options for "Ribbons" (`type=ribbon`) and "Label Tapes" (`type=label_tape`) if those product categories should be browsable.
- **Search results:** Update search result rendering to handle `compatible_devices` on ribbons (instead of `compatible_printers`). Label tape results will have neither field.
- **Compatible printers endpoint:** If using `GET /api/search/compatible-printers/:sku` for ribbon SKUs, handle the different response shape (`ribbon` + `compatible_devices` instead of `cartridge` + `compatible_printers`).
- **Admin product editing:** The `product_type` dropdown should include `label_tape` as a valid option.

**Updated sections:** 4.1 (product type filter table + filtering behavior note), 4.1 products/:sku (compatible_printers note), 4.4 search/by-part (type values + enrichment), 4.4 compatible-printers/:sku (ribbon handling), 4.19d admin ribbons (label_tape exclusion note), 4.19 admin product update (valid product_type values), 4.22 ribbons public (label_tape exclusion note + key notes), 7 key tables (ribbon_compatibility note), 7.4 product weights (label_tape), 9 nullable fields (compatible_printers note).

### 2026-03-02 — ODS Ribbons Migrated to Products Table + Daily Import Cron

**Summary:** The ODS ribbon import (`scripts/import-ribbons.js`) now writes to the `products` table with `source='ribbon'` instead of the legacy `ribbons` table. All 115 ribbon products (95 ODS + 11 genuine + 9 compatible) are now in a single table, fully visible via `/api/ribbons` and `/api/products?type=ribbon`. Added a daily cron job to run all three import scripts sequentially, plus admin endpoints to trigger them.

**Files changed:**
- `scripts/import-ribbons.js` — Upsert target changed from `ribbons` → `products`. Object shape now matches products schema (`brand_id`, `retail_price`, `product_type='ribbon'`, `category='CON-RIBBON'`, `pack_type='single'`, `source='ribbon'`, `weight_kg=0.1`). Uses shared `deactivateRemovedProducts()` scoped to `source='ribbon'`. Correction tape display renamed to "Correction Ribbon Tape" so all ribbon products contain "Ribbon" in their name.
- `src/utils/feedHelpers.js` — `removeDisallowedBrands()` now skips brands that have no products in the current source (prevents genuine/compatible imports from deactivating ribbon-only brands like Citizen, IBM, Olivetti, Star).
- `src/cron/jobs.js` — Added `dailyProductImport()` job: runs genuine → compatible → ribbons sequentially with 10-min timeout per script. 30-minute lock TTL.
- `src/cron/scheduler.js` — Daily product import scheduled at 2pm UTC (2am NZST). Sends email + Sentry alert on failure.
- `src/routes/admin.js` — Added `POST /api/admin/import/ribbons` (trigger ribbon import) and `POST /api/admin/cron/daily-product-import` (trigger full import pipeline). Both secured by `verifyCronAuth`.
- `scripts/migrations/005_ribbons_brand_id.sql` — Adds `brand_id` FK to legacy `ribbons` table (transition helper).
- `scripts/migrations/006_add_ribbon_source.sql` — Adds `'ribbon'` to `check_product_source` CHECK constraint on `products` table.

**Product source values:**
The `products.source` column now allows three values:
| Source | Import script | Description |
|--------|--------------|-------------|
| `genuine` | `scripts/genuine.js` | DSNZ.xlsx — genuine OEM products (11 ribbons) |
| `compatible` | `scripts/compatible.js` | Augmento.xlsx — compatible/third-party products (9 ribbons) |
| `ribbon` | `scripts/import-ribbons.js` | RIBBONS Streamline.ods — ODS ribbon catalog (95 ribbons) |

Each source is fully isolated for deactivation — one import script can never deactivate products from another source.

**Import run order:**
The daily cron runs: `genuine.js` → `compatible.js` → `import-ribbons.js`. Genuine must run first (compatible depends on it for compatibility links). Order is safe because `removeDisallowedBrands()` is source-scoped — genuine/compatible imports skip ribbon-only brands (Citizen, IBM, Olivetti, Star, etc.). The daily cron at 2pm UTC (2am NZST) handles this automatically.

**New admin endpoints:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/admin/import/ribbons` | `verifyCronAuth` | Trigger ODS ribbon import. Returns output on success. 10-min timeout. 409 if already running. |
| POST | `/api/admin/cron/daily-product-import` | `verifyCronAuth` | Run full import pipeline (genuine → compatible → ribbons). Returns per-script results. 207 on partial failure. |

**Cron schedule (`src/cron/scheduler.js`):**

| Schedule | Job | Description |
|----------|-----|-------------|
| `0 14 * * *` | `daily-product-import` | Runs genuine → compatible → ribbons sequentially. 30-min distributed lock. Sends email + Sentry alert on any failure. |

**No frontend breaking changes.** The `/api/ribbons` endpoints continue to work identically — they query `products` with `product_type='ribbon'`, which now returns all 115 ribbons instead of only the 20 from genuine/compatible sources.

**Updated sections:** 4.1 (source field values), 4.19c (admin cron table — added import endpoints), 7 key tables (ribbons table LEGACY note), changelog (2026-02-19 cross-reference).

---

### 2026-03-02 — Production Hardening Audit Fixes

**Summary:** Hostile production-readiness audit findings implemented. Query pagination guards, input validation tightening, performance indexes, import pipeline hardening, and environment security.

**Files changed:**
- `src/server.js` — `TURNSTILE_SECRET_KEY` added to `PRODUCTION_REQUIRED_ENV_VARS` (production startup now fails without it)
- `src/middleware/requestId.js` — Client-supplied `X-Request-Id` now validated (alphanumeric, max 128 chars); invalid values are silently replaced with server-generated UUIDs
- `src/routes/admin.js` — `POST /api/admin/import/genuine` and `/compatible` now reject non-empty request bodies (400). `GET /api/admin/recovery/data-integrity-audit` queries capped at 5000 rows per table. `GET /api/admin/business-applications-stats` capped at 5000. Customer export order stats capped at 50000.
- `src/routes/adminAnalytics.js` — `GET /api/admin/analytics/customer-ltv` orders query capped at 50000. `GET /api/admin/analytics/stock-velocity` products query capped at 10000. `GET /api/admin/analytics/inventory-cash-lockup` products query capped at 10000.
- `src/routes/seo.js` — Sitemap generation now paginates product queries (1000 rows per batch) to avoid silent truncation with large catalogs
- `src/cron/jobs.js` — `reconcilePayments` now processes max 20 stale orders per run (oldest first) to avoid Stripe API rate limiting
- `src/utils/feedHelpers.js` — Added `DEACTIVATION_ALERT_THRESHOLD: 0.15` (15%) constant. `checkDeactivationSafety()` now returns `alert: true` when deactivation ratio >= 15% (below the 40% circuit breaker). SKU normalization via `.toUpperCase()` in `mapRowToProduct()`.
- `scripts/genuine.js` — SKU normalization (`.toUpperCase()`). High deactivation rate alert (logs warning + records `deactivation_alert_threshold` anomaly when >= 15%)
- `scripts/compatible.js` — Same SKU normalization and deactivation alert as genuine.js
- `scripts/verify-constraints.js` — Now verifies 4 additional indexes: `idx_products_sku_unique`, `idx_orders_status_created_at`, `idx_products_source_is_active`, `idx_cart_items_guest_session`

**New files:**
- `scripts/migrations/007_products_sku_unique.sql` — UNIQUE index on `products.sku` (partial, WHERE NOT NULL). Required for upsert `onConflict: 'sku'` to work correctly.
- `scripts/migrations/008_performance_indexes.sql` — Composite indexes: `orders(status, created_at)` for cron queries, `products(source, is_active)` for import deactivation, `cart_items(guest_session_id)` for guest cart operations.
- `scripts/migrations/ROLLBACK.md` — Reverse migration SQL for all 8 migrations.
- `sql/schema.sql` — Full table schema (reference document for disaster recovery).
- `sql/rls_policies.sql` — Row-Level Security policies (reference document).

**Frontend-relevant changes:**

1. **Import trigger endpoints** (`POST /api/admin/import/genuine`, `/compatible`): Now return 400 if request body is non-empty. If the frontend sends these as `POST` with `Content-Type: application/json` and an empty body `{}`, this is fine. If it sends `undefined`/`null` body, also fine. Only fails if actual properties are in the body.

2. **Admin analytics result caps**: `customer-ltv` (50k orders), `stock-velocity` (10k products), `inventory-cash-lockup` (10k products). These caps are well above current catalog size but will silently truncate if the catalog or order history grows very large. No response shape changes.

3. **Data integrity audit caps**: Each sub-query in `GET /api/admin/recovery/data-integrity-audit` is capped at 5000 rows. The `affected` arrays in the response may be truncated for very large issue sets. No response shape changes.

4. **Sitemap**: No change to sitemap URL or format. Now correctly includes all active products regardless of catalog size.

**No frontend breaking changes.** All response shapes are unchanged. The only new error is 400 on import endpoints with unexpected body content (admin/cron only).

**Updated sections:** 4.19c (import endpoint body validation note).

---

### 2026-03-03 — Ribbon Image Upload Script Migration to Products Table

**Summary:** The `scripts/uploadRibbonPhotos.js` script was targeting the legacy `ribbons` table with `image_path`/`image_hash` columns. Updated to target the `products` table (`product_type='ribbon'`) with `image_url`. Fixed a bug where files already in Supabase Storage were skipped without updating the DB, leaving `products.image_url` as NULL. 91 of 115 ribbon products now have images set.

**Files changed:**
- `scripts/uploadRibbonPhotos.js` — DB target changed from `ribbons` → `products` (filtered by `product_type='ribbon'`). Column changed from `image_path`/`image_hash` → `image_url`. Removed MD5 hash-based idempotency (products table has no `image_hash` column); replaced with storage-prefix check. Added `--force` flag for re-uploads. Fixed "already exists" code path to still update the DB. Post-upload consistency check replaced with coverage check (reports ribbon products still missing `image_url`). Removed `crypto` dependency.

**Image coverage:**
- 91 ribbon products now have `image_url` set (relative storage paths like `images/ribbons/655-02/main.png`)
- 14 ribbon products still missing images (no photo files available): `304-11`, `103.23`, `15633.01`, `81051-01`, `IERC30BR`, `IO393`, `IERC23`, `IERC23R`, `IERC30`, `IERC35`, `IO590`, `IO720`, `IO182`, `E15086`
- 5 photo files unmatched to any product SKU: `10323.01`, `153.01`, `15329.01`, `15339.01`, `82727.01`

**Frontend-relevant changes:**

1. **Ribbon `image_path` values now populated:** Previously `null` for most ribbons. Now returns relative storage paths (e.g., `images/ribbons/655-02/main.png`). Use `storageUrl()` helper to resolve to full URL, same as `product_images[].path`.

2. **Path format:** `images/ribbons/{sku-slug}/main.{ext}` — SKU dots become hyphens in the slug (e.g., SKU `655.02` → path `images/ribbons/655-02/main.png`).

3. **No response shape changes.** The `image_path` field in ribbon API responses (`GET /api/ribbons`, `GET /api/ribbons/:sku`, `GET /api/admin/ribbons`) was always present — it just returned `null` before. Now returns the storage path for 91 products.

**No frontend breaking changes.**

**Updated sections:** 4.19d (example `image_path` value), 4.22 (example `image_path` values in response samples).

---

### 2026-03-03 — Drop Legacy Ribbons Table + Code Cleanup

**Summary:** Dropped the legacy `ribbons` table (migration 010). Removed all code references to the legacy table. Re-seeded `ribbon_compatibility` from product names (204 entries).

**Migration:** `scripts/migrations/010_drop_legacy_ribbons_table.sql` — Drops stale FK from `ribbon_compatibility` → `ribbons`, deletes orphaned compatibility rows (ribbon_id not in products), adds correct FK to `products(id)`, drops `ribbons` table and index.

**Files changed:**
- `src/utils/feedHelpers.js` — Removed legacy `ribbons` table check in `removeDisallowedBrands()` brand deactivation. The `products` table check (all sources including `source='ribbon'`) is now sufficient.
- `scripts/ribbon-compat/phase-a-seed.js` — Queries `products` table with brand FK join instead of legacy `ribbons` table. Compatibility text column removed (all entries now use name parsing).
- `scripts/ribbon-compat/phase-b-enrich.js` — SKU lookup uses `products` table filtered by `product_type='ribbon'`.
- `scripts/ribbon-compat/report.js` — Queries `products` table with brand FK join, removed `compatibility` text column references.
- `sql/schema.sql` — Removed `ribbons` table definition (replaced with drop note).
- `sql/functions/compatibility_functions.sql` — Updated comment.
- `scripts/migrations/ROLLBACK.md` — Added rollback SQL for migration 010.

**No frontend breaking changes.** The `ribbons` table was internal-only — no API endpoints ever exposed it directly. All ribbon API responses come from the `products` table.

**Updated sections:** 7 Key Tables (`ribbons` row updated to DROPPED), 7 Migration Files (022_ribbons.sql note).
