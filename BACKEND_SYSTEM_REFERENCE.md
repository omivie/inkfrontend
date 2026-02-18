# Backend System Reference

Complete API reference for the Ink Cartridge E-Commerce Backend.
Generated: 2026-02-15

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Authentication Flow](#2-authentication-flow)
3. [API Endpoint Reference](#3-api-endpoint-reference)
4. [Order Flow](#4-order-flow)
5. [Payment Flow](#5-payment-flow)
6. [Stock Handling Logic](#6-stock-handling-logic)
7. [Import Pipeline](#7-import-pipeline)
8. [Database Schema Summary](#8-database-schema-summary)
9. [Table-by-Table Explanation](#9-table-by-table-explanation)
10. [Enum Definitions & Allowed Values](#10-enum-definitions--allowed-values)
11. [RLS Summary](#11-rls-summary)
12. [Webhook Logic](#12-webhook-logic)
13. [Environment Variables](#13-environment-variables)
14. [Data Formats](#14-data-formats)
15. [Naming Conventions](#15-naming-conventions)
16. [Frontend Validation Constraints](#16-frontend-validation-constraints)
17. [Backend Assumptions About Frontend](#17-backend-assumptions-about-frontend)
18. [Rate Limits](#18-rate-limits)
19. [CORS Policy](#19-cors-policy)
20. [Error Response Format](#20-error-response-format)
21. [Example Request/Response JSON](#21-example-requestresponse-json)
22. [Audit Findings](#22-audit-findings)
23. [Missing Features & Improvements](#23-missing-features--improvements)

---

## 1. System Overview

### Tech Stack
- **Runtime:** Node.js >= 18
- **Framework:** Express.js 4.18.2
- **Database:** Supabase (PostgreSQL with Row-Level Security)
- **Payments:** Stripe (PaymentIntents API)
- **Email:** Resend API (primary) / SMTP via Nodemailer (fallback)
- **AI Chatbot:** Anthropic Claude (claude-sonnet-4-20250514)
- **Hosting:** Render (with GitHub Actions cron jobs)

### Architecture
```
Frontend (Next.js)
    |
    v
Express.js API (Render)
    |
    +---> Supabase (PostgreSQL + Auth + Storage)
    +---> Stripe (Payments)
    +---> Anthropic Claude (AI Chatbot)
    +---> Resend / SMTP (Email)
```

### Key Patterns
- **Three Supabase clients:** anon (public), admin (service role), user (JWT-scoped)
- **Atomic order creation:** Single DB transaction for order + items + stock decrement
- **4-layer webhook idempotency:** Event-level, status-based, atomic update, PGRST116
- **State machines:** Orders and emails have enforced state transitions via DB triggers
- **Role-based access:** super_admin, stock_manager, order_manager

---

## 2. Authentication Flow

### How It Works
1. Frontend calls **Supabase Auth** directly for signup/login (not the backend)
2. Supabase returns a JWT access token
3. Frontend sends JWT in `Authorization: Bearer <token>` header on all authenticated requests
4. Backend `requireAuth` middleware validates the JWT against Supabase

### Email Verification
- Order creation requires a verified email (`requireVerifiedEmail` middleware)
- Check status: `GET /api/auth/verification-status`
- Resend verification: `POST /api/auth/resend-verification`

### Admin Roles
Three admin roles stored in `admin_roles` table:

| Role | Access |
|------|--------|
| `super_admin` | Full access to all admin endpoints |
| `order_manager` | Orders, customers |
| `stock_manager` | Products, images, inventory |

Middleware chain: `requireAuth` -> `requireAdmin` -> `requireRole('super_admin', 'order_manager')`

### Auth Headers
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
```

---

## 3. API Endpoint Reference

### 3.1 Products (Public)

#### GET /api/products
List products with filtering, pagination, and sorting.

**Auth:** None

**Query Parameters:**

| Param | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| page | integer | No | 1 | min: 1 |
| limit | integer | No | 20 | min: 1, max: 100 |
| search | string | No | - | max: 200 chars |
| brand | string | No | - | brand slug, max: 50 |
| color | string | No | - | max: 50 |
| type | string | No | - | `cartridge`, `consumable`, `printer` |
| category | string | No | - | `ink`, `toner`, `printer`, `laser`, `inkjet`, `consumable`, `cartridge` |
| source | string | No | - | `genuine`, `compatible` |
| sort | string | No | `name_asc` | `price_asc`, `price_desc`, `name_asc`, `name_desc` |

**Response:**
```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "uuid",
        "sku": "B131B",
        "name": "Brother LC131 Black Ink Cartridge",
        "brand": { "name": "Brother", "slug": "brother" },
        "retail_price": 14.49,
        "color": "Black",
        "page_yield": "300",
        "product_type": "ink_cartridge",
        "pack_type": "single",
        "source": "compatible",
        "stock_quantity": 45,
        "image_url": "https://...",
        "is_active": true,
        "manufacturer_part_number": "LC131BK"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "total_pages": 8
    }
  }
}
```

---

#### GET /api/products/:sku
Get single product by SKU with compatible printers.

**Auth:** None
**Params:** `sku` (string, max: 50, required)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "sku": "B131B",
    "name": "Brother LC131 Black Ink Cartridge",
    "brand": { "name": "Brother", "slug": "brother" },
    "retail_price": 14.49,
    "color": "Black",
    "page_yield": "300",
    "product_type": "ink_cartridge",
    "pack_type": "single",
    "source": "compatible",
    "stock_quantity": 45,
    "specifications": {},
    "compatible_printers": [
      {
        "id": "uuid",
        "full_name": "Brother MFC-J870DW",
        "slug": "brother-mfc-j870dw"
      }
    ]
  }
}
```

---

#### GET /api/products/printer/:printerSlug
Get all products compatible with a printer.

**Auth:** None
**Params:** `printerSlug` (string, regex: `^[a-z0-9][a-z0-9_-]*$`, max: 200)

**Response:**
```json
{
  "success": true,
  "data": {
    "printer": {
      "id": "uuid",
      "full_name": "Brother MFC-J870DW",
      "brand": { "name": "Brother" }
    },
    "products": [ /* product objects */ ],
    "total": 12
  }
}
```

---

#### GET /api/products/printer/:printerSlug/color-packs
Get auto-generated color packs (CMY/KCMY) for a printer.

**Auth:** None

**Response:**
```json
{
  "success": true,
  "data": {
    "genuine": {
      "packs": [
        {
          "type": "KCMY",
          "items": [ /* 4 products */ ],
          "total_individual_price": 59.96,
          "pack_price": 55.90,
          "savings": 4.06,
          "savings_percentage": 6.77
        }
      ]
    },
    "compatible": {
      "packs": [ /* same structure */ ]
    }
  }
}
```

---

#### GET /api/printers/search
Search printer models.

**Auth:** None

**Query:**

| Param | Type | Required | Constraints |
|-------|------|----------|-------------|
| q | string | Yes | min: 2, max: 200 |
| brand | string | No | max: 50 |

---

#### GET /api/brands
List all active brands.

**Auth:** None

---

### 3.2 Search (Public)

All search endpoints have a **30 req/min rate limit**.

#### GET /api/search/by-printer
Search products by printer name.

| Param | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| q | string | Yes | - | min: 2, max: 200 |
| limit | integer | No | 20 | min: 1, max: 100 |
| page | integer | No | 1 | min: 1 |

#### GET /api/search/by-part
Search by SKU, MPN, or product name.

| Param | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| q | string | Yes | - | min: 1, max: 200 |
| type | string | No | - | `cartridge`, `printer` |
| limit | integer | No | 20 | min: 1, max: 100 |
| page | integer | No | 1 | min: 1 |

#### GET /api/search/autocomplete
Fast autocomplete suggestions.

| Param | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| q | string | Yes | - | min: 2, max: 100 |
| limit | integer | No | 10 | min: 1, max: 20 |

#### GET /api/search/compatible-printers/:sku
Find printers compatible with a specific product.

---

### 3.3 Cart

Cart supports both **authenticated** and **guest** users via cookies.

#### GET /api/cart
**Auth:** Optional (guest uses cookie session)

**Response:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "product_id": "uuid",
        "quantity": 2,
        "product": {
          "name": "Brother LC131 Black",
          "sku": "B131B",
          "retail_price": 14.49,
          "stock_quantity": 45,
          "image_url": "https://...",
          "is_active": true
        }
      }
    ],
    "summary": {
      "item_count": 2,
      "unique_items": 1,
      "subtotal": 28.98
    }
  }
}
```

#### POST /api/cart/items
**Auth:** Optional
**Body:**
```json
{
  "product_id": "uuid",
  "quantity": 1
}
```
Constraints: quantity 1-100, default 1.

#### PUT /api/cart/items/:productId
**Auth:** Optional
**Body:**
```json
{
  "quantity": 3
}
```
Constraints: quantity 1-100.

#### DELETE /api/cart/items/:productId
**Auth:** Optional

#### DELETE /api/cart
Clear entire cart.
**Auth:** Optional

#### POST /api/cart/merge
Merge guest cart into authenticated cart (called after login).
**Auth:** Required

#### GET /api/cart/count
**Auth:** Optional
**Response:** `{ "success": true, "data": { "count": 3 } }`

#### POST /api/cart/validate
Validate all cart items before checkout (stock check, price check).
**Auth:** Optional

**Response:**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "items": [ /* validated items with current prices */ ],
    "warnings": [],
    "subtotal": 28.98,
    "gst_amount": 3.78,
    "shipping": 5.00,
    "total": 33.98
  }
}
```

#### POST /api/cart/coupon
Apply coupon code.
**Auth:** Required

#### DELETE /api/cart/coupon
Remove applied coupon.
**Auth:** Required

#### GET /api/cart/coupon
Get current applied coupon.
**Auth:** Required

---

### 3.4 Orders

#### POST /api/orders
Create a new order. Requires authenticated user with verified email.

**Auth:** Required + Verified Email

**Body:**
```json
{
  "items": [
    { "product_id": "uuid", "quantity": 2 }
  ],
  "shipping_address": {
    "recipient_name": "John Smith",
    "phone": "0211234567",
    "address_line1": "123 Main Street",
    "address_line2": "Unit 5",
    "city": "Auckland",
    "region": "Auckland",
    "postal_code": "1010",
    "country": "NZ"
  },
  "save_address": true,
  "customer_notes": "Please leave at door"
}
```

**Constraints:**
- items: 1-50 items, quantity 1-100 per item
- recipient_name: max 200
- address_line1: max 255
- city: max 100
- postal_code: max 20
- country: exactly 2 chars, uppercase, default "NZ"
- customer_notes: max 500

**Response (201):**
```json
{
  "success": true,
  "data": {
    "order": {
      "id": "uuid",
      "order_number": "ORD-M1K2N3-A4B5",
      "status": "pending",
      "subtotal": 28.98,
      "gst_amount": 3.78,
      "shipping_cost": 5.00,
      "total": 33.98
    },
    "payment": {
      "payment_intent_id": "pi_xxx",
      "client_secret": "pi_xxx_secret_xxx"
    }
  }
}
```

**Errors:**
- 400: Validation errors, out of stock
- 401: Not authenticated
- 403: Email not verified
- 409: Duplicate order (idempotency)
- 500: Stripe or DB error

#### GET /api/orders
**Auth:** Required

**Query:**

| Param | Type | Default | Constraints |
|-------|------|---------|-------------|
| page | integer | 1 | min: 1 |
| limit | integer | 20 | min: 1, max: 100 |
| status | string | - | `pending`, `paid`, `processing`, `shipped`, `completed`, `cancelled` |

#### GET /api/orders/:orderNumber
**Auth:** Required

---

### 3.5 User

#### GET /api/user/profile
**Auth:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "first_name": "John",
    "last_name": "Smith",
    "phone": "+64211234567",
    "account_type": "personal",
    "email": "john@example.com"
  }
}
```

#### PUT /api/user/profile
**Auth:** Required
**Body:** At least one of:
```json
{
  "first_name": "John",
  "last_name": "Smith",
  "phone": "0211234567"
}
```
Constraints: all max 100 chars.

#### GET /api/user/addresses
**Auth:** Required

#### POST /api/user/address
**Auth:** Required
**Body:**
```json
{
  "recipient_name": "John Smith",
  "phone": "0211234567",
  "address_line1": "123 Main Street",
  "address_line2": "",
  "city": "Auckland",
  "region": "Auckland",
  "postal_code": "1010",
  "country": "NZ",
  "is_default": true
}
```

#### PUT /api/user/address/:addressId
**Auth:** Required (same body as POST)

#### DELETE /api/user/address/:addressId
**Auth:** Required

#### POST /api/user/favourite
**Auth:** Required
**Body:** `{ "product_id": "uuid" }`

#### DELETE /api/user/favourite/:productId
**Auth:** Required

#### GET /api/user/favourites
**Auth:** Required

#### POST /api/user/favourites/sync
Sync local favourites to server (after login).
**Auth:** Required
**Body:** `{ "product_ids": ["uuid1", "uuid2"] }` (max 100)

#### POST /api/user/printer
Save a printer to user profile.
**Auth:** Required
**Body:** `{ "printer_id": "uuid" }`

#### DELETE /api/user/printer/:printerId
**Auth:** Required

#### GET /api/user/printers
**Auth:** Required

#### GET /api/user/savings
Get user's total savings summary.
**Auth:** Required

---

### 3.6 Auth

#### GET /api/auth/verification-status
**Auth:** Required
**Rate Limit:** 10 req/min

#### POST /api/auth/resend-verification
**Auth:** Required
**Rate Limit:** 3 req/min

#### POST /api/auth/verify-email
**Body:**
```json
{
  "token": "verification-token-string",
  "type": "email"
}
```
type: `email` (default), `signup`, `recovery`

---

### 3.7 Business

#### POST /api/business/apply
**Auth:** Required
**Body:**
```json
{
  "company_name": "Acme Office Supplies",
  "nzbn": "9429041234567",
  "contact_name": "John Smith",
  "contact_email": "john@acme.co.nz",
  "contact_phone": "0211234567",
  "estimated_monthly_spend": "1000_2500",
  "industry": "retail"
}
```

Allowed `estimated_monthly_spend`: `under_500`, `500_1000`, `1000_2500`, `2500_5000`, `over_5000`
Allowed `industry`: `education`, `healthcare`, `government`, `retail`, `technology`, `manufacturing`, `professional_services`, `hospitality`, `other`
NZBN: exactly 13 digits (optional)

#### GET /api/business/status
**Auth:** Required

---

### 3.8 Shipping

#### POST /api/shipping/options
**Auth:** Required
**Body:**
```json
{
  "cart_total": 75.50,
  "item_count": 3,
  "postal_code": "1010"
}
```

#### GET /api/shipping/rates
**Auth:** None (public)

---

### 3.9 Settings

#### GET /api/settings
**Auth:** None (public)

**Response:**
```json
{
  "success": true,
  "data": {
    "FREE_SHIPPING_THRESHOLD": 100,
    "SHIPPING_FEE": 5,
    "LOW_STOCK_THRESHOLD": 10,
    "CRITICAL_STOCK_THRESHOLD": 2,
    "GST_RATE": 0.15,
    "CURRENCY": "NZD",
    "COUNTRY": "NZ",
    "FEATURES": {
      "chatbot_enabled": true,
      "business_accounts_enabled": true,
      "guest_checkout_enabled": false
    }
  }
}
```

---

### 3.10 Chatbot

#### POST /api/chat
**Auth:** Optional (authenticated users get higher rate limits)

**Body:**
```json
{
  "message": "What ink cartridges work with my Brother printer?",
  "session_id": "optional-session-id",
  "context": {
    "current_product_sku": "B131B",
    "current_printer_slug": "brother-mfc-j870dw",
    "page": "product_detail"
  }
}
```

**Constraints:**
- message: 1-2000 chars
- session_id: max 100 chars
- page: `home`, `products`, `product_detail`, `cart`, `checkout`, `orders`, `account`

**Rate Limits:**
- Anonymous: 10 req/min per IP
- Authenticated: 20 req/min per user
- Session: 100 req/hour per session

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "For your Brother MFC-J870DW, I'd recommend...",
    "session_id": "generated-session-id",
    "usage": {
      "input_tokens": 150,
      "output_tokens": 200
    }
  }
}
```

#### DELETE /api/chat/session/:session_id
Clear chat history for a session.

#### GET /api/chat/health
AI service health check.

---

### 3.11 Webhooks

#### POST /api/webhooks/payment
**Auth:** Stripe signature verification (not user auth)
**Body:** Raw JSON (Stripe event)

This endpoint is called by Stripe, not the frontend. See [Section 12](#12-webhook-logic) for details.

---

### 3.12 Cart Analytics (Public + Admin)

#### POST /api/analytics/cart-event
Track cart interactions (public).
**Auth:** None

#### GET /api/analytics/cart-summary
**Auth:** Admin

#### GET /api/analytics/abandoned-carts
**Auth:** Admin

#### GET /api/analytics/marketing
**Auth:** Admin

---

### 3.13 Admin Endpoints

All admin endpoints require `requireAdmin` middleware. Many also require specific roles via `requireRole()`.

#### Orders (order_manager, super_admin)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/orders` | List all orders with filters |
| PUT | `/api/admin/orders/:orderId` | Update order status |

Admin order query supports: page, limit, status, customer_email, date_from (YYYY-MM-DD), date_to, sort (newest/oldest/total-high/total-low).

Update order body:
```json
{
  "status": "shipped",
  "tracking_number": "NZ123456789",
  "admin_notes": "Shipped via CourierPost"
}
```

#### Products (stock_manager, super_admin)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/products` | List products with cost price |
| GET | `/api/admin/products/:productId` | Get product by UUID |
| PUT | `/api/admin/products/:sku` | Quick update (price/stock/active) |
| PUT | `/api/admin/products/:productId` | Full product edit |
| POST | `/api/admin/products/bulk-activate` | Bulk activate |
| POST | `/api/admin/products/:productId/images` | Upload image |
| DELETE | `/api/admin/products/:productId/images/:imageId` | Delete image |
| PUT | `/api/admin/products/:productId/images/reorder` | Reorder images |
| GET | `/api/admin/products/diagnostics` | Data quality checks |

#### Customers (order_manager, super_admin)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/customers` | List all customers |

#### Business Applications (super_admin only)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/business-applications` | List applications |
| GET | `/api/admin/business-applications/:applicationId` | Get details |
| PUT | `/api/admin/business-applications/:applicationId` | Approve/reject |
| GET | `/api/admin/business-applications-stats` | Statistics |

#### System/Recovery (cron auth)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/admin/cron/process-emails` | Send pending emails |
| POST | `/api/admin/cron/cleanup-emails` | Clean stuck emails |
| POST | `/api/admin/cron/cleanup-data` | Data retention cleanup |
| GET | `/api/admin/recovery/health-check` | Data integrity audit |
| POST | `/api/admin/recovery/fix-missing-invoices` | Fix missing invoices |
| POST | `/api/admin/recovery/cancel-stale-orders` | Cancel old pending orders |
| GET | `/api/admin/recovery/data-integrity-audit` | Full integrity audit |

---

### 3.14 Analytics (Admin)

| Method | Path | Schema |
|--------|------|--------|
| GET | `/api/analytics/overview` | timeRange (1-365, default 30) |
| GET | `/api/analytics/top-products` | metric, productType, compatibilityType, days, limit |
| GET | `/api/analytics/attach-rate` | startDate, endDate, customerType |
| GET | `/api/analytics/genuine-vs-compatible` | startDate, endDate, productType, customerType |
| GET | `/api/analytics/customer-behavior` | customerType, minOrders, sortBy, limit |
| GET | `/api/analytics/b2b-opportunities` | minScore |
| GET | `/api/analytics/stock-coverage` | productType, compatibilityType, maxDays, sortBy |
| GET | `/api/analytics/pricing-intelligence` | productType, compatibilityType, days |
| POST | `/api/analytics/refresh` | None |

---

### 3.15 Admin Analytics (Admin)

30+ endpoints under `/api/admin/analytics/`. See the `/api/docs` endpoint for the full list.

Key categories:
- **Financial:** pnl, cashflow, burn-runway, daily-revenue, forecasts, expenses
- **Customer Intelligence:** customer-ltv, cac, ltv-cac-ratio, cohorts, churn, customer-health, nps, repeat-purchase
- **Marketing:** campaigns, marketing-spend, channel-efficiency, conversion-funnel
- **Operations:** inventory-turnover, dead-stock, stock-velocity, inventory-cash-lockup, product-performance, page-revenue
- **Alerts:** alerts, acknowledge, alert-thresholds

---

## 4. Order Flow

```
1. Frontend: User adds items to cart
2. Frontend: User goes to checkout, enters shipping info
3. Frontend: POST /api/orders → Backend creates order + Stripe PaymentIntent
4. Backend returns { payment_intent_id, client_secret }
5. Frontend: Uses client_secret with Stripe.js to confirm payment
6. Stripe: Sends payment_intent.succeeded webhook to backend
7. Backend: Marks order as "paid", queues invoice email
8. Backend: Clears user's cart
9. Admin: Updates order to "processing" (picking items)
10. Admin: Adds tracking number → marks as "shipped" → triggers tracking email
11. Admin: Marks as "completed" when delivered

Cancellation:
- If payment fails: Stripe webhook triggers atomic cancellation + stock restore
- Admin can cancel pending/paid orders (stock restored atomically)
```

### State Machine

| From | To | Trigger |
|------|----|---------|
| pending | paid | Stripe webhook (payment_intent.succeeded) |
| pending | cancelled | Payment failure webhook / admin |
| paid | processing | Admin action |
| paid | cancelled | Admin action (stock restored) |
| processing | shipped | Admin action (requires tracking_number) |
| processing | cancelled | Admin action (requires confirm_processing_cancellation) |
| shipped | completed | Admin action |

**Terminal states:** `completed`, `cancelled` (no further transitions allowed)

---

## 5. Payment Flow

### Frontend Responsibilities
1. Call `POST /api/orders` with items and shipping address
2. Receive `client_secret` from response
3. Use Stripe.js `confirmCardPayment(client_secret)` to collect payment
4. Handle payment result (success/failure) in UI
5. Redirect to order confirmation page

### Backend Responsibilities
1. Create Stripe PaymentIntent with order amount
2. Create order in DB atomically (order + items + stock decrement)
3. Return `client_secret` to frontend
4. Handle Stripe webhooks for payment status changes
5. Send invoice email on successful payment
6. Restore stock on payment failure/cancellation

### Important Notes
- **All prices include 15% GST** — what the customer sees is what they pay
- **Shipping:** Flat $5 NZD, free over $100 subtotal
- **Currency:** NZD only
- **Idempotency:** Backend generates a hash of (userId + items + address) to prevent duplicate orders

---

## 6. Stock Handling Logic

### Stock Decrement
- Happens **atomically** during order creation via `create_order_atomic()` DB function
- Uses row-level locks to prevent race conditions
- If any item is out of stock, the entire order fails (rollback)

### Stock Restore
- On payment failure: `cancel_order_restore_stock()` atomically cancels order and restores stock
- On admin cancellation: Same atomic function
- Prevents double-restore via status check (`ALREADY_CANCELLED` error code)

### Import Updates
- Import scripts (genuine.js, compatible.js) update `stock_quantity` from supplier feed
- Products not in the feed are deactivated (with circuit breaker: max 30% deactivation)
- Never mixes genuine and compatible product data

---

## 7. Import Pipeline

Two independent import scripts, one per supplier:

| Script | File | Supplier | Pricing |
|--------|------|----------|---------|
| `scripts/genuine.js` | DSNZ.xlsx | Dynamic Supplies NZ | 18% margin + GST |
| `scripts/compatible.js` | Augmento.xlsx | Augmento | Tiered multiplier + GST |

### Pricing Formulas

**Genuine Products:**
- `finalPrice = costPrice * 1.18 * 1.15` (18% margin + 15% GST)
- Price endings: .95 or .99 depending on margin

**Compatible Toner:**
- Cost < $10: `cost * 2.7 * 1.15`
- Cost $10-25: `cost * 2.1 * 1.15`
- Cost >= $25: `cost * 1.85 * 1.15`
- Price endings: .49 or .79

**Compatible Cartridge:**
- Cost < $5: `cost * 1.9 * 1.15`
- Cost $5-10: `cost * 1.65 * 1.15`
- Cost >= $10: `cost * 1.45 * 1.15`
- Price endings: .49 or .79

### Safety Features
- Advisory lock (prevents concurrent runs)
- Crash recovery (detects abandoned runs)
- Duplicate SKU detection
- Source isolation (genuine script never touches compatible products)
- Deactivation circuit breaker (max 30%)
- Dry-run mode

---

## 8. Database Schema Summary

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| brands | Printer/product brands | id, name, slug, is_active |
| products | All products (ink, toner, etc.) | id, sku, name, retail_price, cost_price, stock_quantity, color, product_type, pack_type, source, is_active |
| printer_models | Printer models | id, brand_id, model_name, full_name, slug |
| product_compatibility | Product-printer junction | product_id, printer_model_id (unique pair) |

### Order Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| orders | Customer orders | id, user_id, order_number, status, subtotal, gst_amount, shipping_cost, total, payment_intent_id, idempotency_key |
| order_items | Line items | order_id, product_id, product_sku, product_name, quantity, unit_price, line_total |
| order_status_history | Status change audit log | order_id, old_status, new_status, actor_type, reason |

### User Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| user_profiles | Extended user data | id (=auth.users.id), first_name, last_name, phone, account_type |
| user_addresses | Saved addresses | user_id, recipient_name, address_line1, city, postal_code |
| user_favourites | Wishlisted products | user_id, product_id |
| user_printers | Saved printers | user_id, printer_model_id, nickname |

### Cart Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| cart_items | Shopping cart | user_id, product_id, quantity, guest_session_id, price_snapshot |
| guest_sessions | Anonymous sessions | id, session_token, expires_at |

### Email Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| email_queue | Outgoing emails | id, order_id, email_type, recipient_email, subject, status, retry_count |

### Admin Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| admin_roles | Admin permissions | user_id, role |
| audit_logs | Compliance audit trail | user_id, action, resource_type, resource_id, details |

### Business Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| business_applications | B2B signup | user_id, company_name, nzbn, status, credit_limit |
| shipping_rates | Shipping options | name, base_price, free_threshold, estimated_days |
| order_savings | Discount tracking | order_id, user_id, savings_type, savings_amount |

### Analytics Tables

| Table | Purpose |
|-------|---------|
| cart_analytics_events | Cart interaction tracking |
| expense_categories | Expense type definitions |
| expenses | Expense records |
| marketing_campaigns | Campaign tracking |
| marketing_spend | Marketing spend records |
| customer_feedback | NPS and reviews |
| analytics_alerts | Alert notifications |
| alert_thresholds | Alert configuration |

### Import Tables

| Table | Purpose |
|-------|---------|
| import_runs | Immutable audit log of import executions |
| import_run_anomalies | Issues found during imports |

### Webhook Tables

| Table | Purpose |
|-------|---------|
| webhook_event_log | Processed Stripe events (idempotency) |

---

## 9. Table-by-Table Explanation

### products
The central table. Every item for sale (ink cartridges, toner, drums, etc.) is a row in products.
- `sku` is the unique business identifier (used in URLs)
- `retail_price` includes 15% GST — this is what the customer pays
- `cost_price` is the supplier cost — **never exposed to non-admin users**
- `source` is either `genuine` (OEM) or `compatible` (third-party)
- `product_type` classifies the product (ink_cartridge, toner_cartridge, drum_unit, etc.)
- `pack_type` is `single`, `value_pack`, or `multipack`
- `is_active` controls visibility — inactive products are hidden from public API

### orders
Each row is a customer order. Orders are created atomically with stock decrement.
- `order_number` format: `ORD-XXXXX-XXXX` (human-readable, shown to customer)
- `idempotency_key` prevents duplicate orders from frontend retries
- `payment_intent_id` links to Stripe PaymentIntent
- Status progression: pending -> paid -> processing -> shipped -> completed

### cart_items
Supports both authenticated and guest carts.
- Authenticated: identified by `user_id`
- Guest: identified by `guest_session_id` (cookie-based)
- `price_snapshot` captures price at add-time for comparison

### product_compatibility
Junction table linking products to compatible printers. A product can work with many printers, and a printer can use many products. The unique constraint on (product_id, printer_model_id) prevents duplicates.

---

## 10. Enum Definitions & Allowed Values

### Product Types
```
ink_cartridge, ink_bottle, toner_cartridge, waste_toner,
drum_unit, belt_unit, fuser_kit, fax_film, fax_film_refill,
ribbon, photo_paper, label, printer, accessory, other
```

### Pack Types
```
single, value_pack, multipack
```

### Product Source
```
genuine, compatible
```

### Order Statuses
```
pending, paid, processing, shipped, completed, cancelled
```

### Email Statuses
```
pending, processing, sent, retrying, failed, service_unavailable
```

### Admin Roles
```
super_admin, stock_manager, order_manager
```

### Business Application Status
```
pending, approved, rejected
```

### Account Types
```
personal, business
```

### Expense Categories
```
marketing, operations, payroll, technology, shipping,
office, professional_services, inventory, other
```

### Standard Colors
```
Black, Cyan, Magenta, Yellow
```

### Allowed Brands
```
Brother, Canon, Epson, Fuji Xerox, HP, Kyocera, Lexmark, OKI, Samsung
```

---

## 11. RLS Summary

Row-Level Security is enabled on all user-facing tables. Key rules:

| Table | Users Can | Admin Can |
|-------|-----------|-----------|
| products | SELECT (active only) | Full CRUD |
| cart_items | CRUD own items only | Full access |
| orders | SELECT own orders only | Full CRUD |
| order_items | SELECT own order's items | Full access |
| user_profiles | CRUD own profile | SELECT all |
| user_addresses | CRUD own addresses | SELECT all |
| user_favourites | CRUD own favourites | SELECT all |
| user_printers | CRUD own printers | SELECT all |
| admin_roles | No access | SELECT (super_admin for CRUD) |
| email_queue | No access | Service role only |
| webhook_event_log | No access | Admin SELECT, service role INSERT |

**Important:** The service_role key bypasses ALL RLS policies. Backend uses it for admin operations and webhooks.

---

## 12. Webhook Logic

### Stripe Events Handled

| Event | Action |
|-------|--------|
| `payment_intent.succeeded` | Mark order paid, clear cart, queue invoice email, calculate savings, update profile |
| `payment_intent.payment_failed` | Atomically cancel order and restore stock |
| `payment_intent.canceled` | Atomically cancel order and restore stock |

### Idempotency Layers
1. **Event-level:** `is_webhook_processed(event.id)` — skips replayed events
2. **Status-based:** Checks if order already in target state (skip if already paid/cancelled)
3. **Atomic update:** `UPDATE orders SET status='paid' WHERE id=X AND status='pending'`
4. **PGRST116:** If no rows matched (status changed), returns idempotent success

### What Happens After Payment Success
1. Order status -> `paid`
2. User's cart cleared
3. Invoice email queued and sent
4. Supplier notification email sent
5. Order savings calculated and recorded
6. User profile updated with checkout data (fills missing fields only)

---

## 13. Environment Variables

### Required
| Name | Purpose |
|------|---------|
| SUPABASE_URL | Supabase project URL |
| SUPABASE_ANON_KEY | Supabase anonymous key |
| SUPABASE_SERVICE_ROLE_KEY | Supabase service role key |
| STRIPE_SECRET_KEY | Stripe API key |

### Required in Production
| Name | Purpose |
|------|---------|
| STRIPE_WEBHOOK_SECRET | Stripe webhook signature secret |
| ALLOWED_ORIGINS | Comma-separated allowed CORS origins |

### Optional
| Name | Purpose |
|------|---------|
| ANTHROPIC_API_KEY | Enables AI chatbot |
| FRONTEND_URL | Email verification redirect URL |
| EMAIL_USER | SMTP username |
| EMAIL_PASSWORD | SMTP password |
| RESEND_API_KEY | Resend email API key |
| CRON_SECRET | Secret for cron job endpoints |
| FREE_SHIPPING_THRESHOLD | Default: 100 |
| FLAT_SHIPPING_RATE_NZD | Default: 5 |

---

## 14. Data Formats

| Data | Format | Example |
|------|--------|---------|
| IDs | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |
| Order numbers | `ORD-XXXXX-XXXX` | `ORD-M1K2N3-A4B5` |
| Prices | Decimal (NZD, GST inclusive) | `14.49` |
| Dates | ISO 8601 | `2026-02-15T10:30:00.000Z` |
| Phone numbers | String, E.164 preferred | `+64211234567` |
| Country codes | ISO 3166-1 alpha-2 | `NZ` |
| SKU | Alphanumeric string | `B131B`, `DSNZ-HP-CF400A` |
| Currency | NZD (New Zealand Dollar) | Always NZD |
| GST | 15% included in all prices | `retail_price` already includes GST |

---

## 15. Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| API fields | snake_case | `order_number`, `retail_price` |
| URL paths | kebab-case | `/api/search/by-printer` |
| URL params | camelCase | `:printerSlug`, `:orderId` |
| DB columns | snake_case | `stock_quantity`, `is_active` |
| DB tables | snake_case | `cart_items`, `order_items` |
| JS variables | camelCase | `cartItems`, `orderNumber` |
| Constants | UPPER_SNAKE_CASE | `BATCH_SIZE`, `GST_RATE` |

---

## 16. Frontend Validation Constraints

These are the exact constraints enforced by the backend. Frontend should validate these before sending requests.

### Product Search
- search: max 200 chars
- page: integer >= 1
- limit: integer 1-100

### Cart
- quantity: integer 1-100
- product_id: valid UUID

### Order Creation
- items: 1-50 items
- quantity per item: 1-100
- recipient_name: max 200 chars
- address_line1: max 255 chars
- city: max 100 chars
- postal_code: max 20 chars
- country: exactly 2 uppercase chars
- customer_notes: max 500 chars

### Profile
- first_name: max 100 chars
- last_name: max 100 chars
- phone: max 20 chars
- At least one field required per update

### Address
- recipient_name: required, max 200
- address_line1: required, max 255
- city: required, max 100
- postal_code: required, max 20

### Business Application
- company_name: required, max 255
- nzbn: optional, exactly 13 digits
- contact_name: required, max 255
- contact_email: required, valid email, max 255

### Chatbot
- message: 1-2000 chars
- session_id: max 100 chars

---

## 17. Backend Assumptions About Frontend

1. **Auth header:** JWT sent as `Authorization: Bearer <token>` on all authenticated requests
2. **Content-Type:** `application/json` for all POST/PUT requests
3. **Stripe.js:** Frontend uses Stripe.js to confirm payment with `client_secret` returned from `POST /api/orders`
4. **Cart merging:** After login, frontend calls `POST /api/cart/merge` to merge guest cart
5. **Email verification:** Frontend checks `GET /api/auth/verification-status` before attempting checkout
6. **Pagination:** Frontend handles pagination using `page` and `limit` params
7. **Error handling:** Frontend checks `success` field in all responses
8. **Price display:** `retail_price` is the final price (GST included) — show as-is
9. **Favourites sync:** After login, frontend calls `POST /api/user/favourites/sync` with locally stored favourites
10. **Printer slug:** Frontend uses `slug` field from printer search results for product lookup URLs

---

## 18. Rate Limits

| Scope | Limit | Applies To |
|-------|-------|------------|
| Global API | 100 req/min per IP | All `/api/*` endpoints |
| Cart | 30 req/min per IP | All `/api/cart/*` endpoints |
| Search | 30 req/min per IP | All `/api/search/*` endpoints |
| Chatbot (anon) | 10 req/min per IP | `POST /api/chat` (no auth) |
| Chatbot (auth) | 20 req/min per user | `POST /api/chat` (with auth) |
| Chatbot (session) | 100 req/hour per session | `POST /api/chat` |
| Webhook | 200 req/min | `POST /api/webhooks/payment` |
| Email verification | 3 req/min | `POST /api/auth/resend-verification` |
| Verification status | 10 req/min | `GET /api/auth/verification-status` |

**Response on limit exceeded:**
```json
{
  "success": false,
  "error": "Too many requests"
}
```
HTTP Status: 429

---

## 19. CORS Policy

### Production
- Only origins listed in `ALLOWED_ORIGINS` env var are permitted
- Localhost/127.0.0.1 is **blocked** in production

### Development
- Localhost with any port is allowed (`http://localhost:*`, `http://127.0.0.1:*`)

### Configuration
- Methods: GET, POST, PUT, DELETE, OPTIONS
- Allowed Headers: Content-Type, Authorization, X-Requested-With
- Credentials: true
- Preflight cache: 24 hours

### Requests Without Origin
Mobile apps, Postman, and server-to-server requests (no Origin header) are always allowed.

---

## 20. Error Response Format

All errors follow this format:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created (new resource) |
| 400 | Bad request / validation error |
| 401 | Not authenticated |
| 403 | Forbidden (insufficient permissions or unverified email) |
| 404 | Not found |
| 409 | Conflict (duplicate order, existing application) |
| 429 | Rate limited |
| 500 | Internal server error |

### Validation Errors
```json
{
  "success": false,
  "error": "\"quantity\" must be less than or equal to 100"
}
```

### Auth Errors
```json
{
  "success": false,
  "error": "Authentication required"
}
```

### Stock Errors
```json
{
  "success": false,
  "error": "Insufficient stock for product: Brother LC131 Black (available: 2, requested: 5)"
}
```

---

## 21. Example Request/Response JSON

### List Products
```bash
GET /api/products?source=compatible&brand=brother&sort=price_asc&limit=5
```
```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "sku": "B131B",
        "name": "Brother LC131 Black Ink Cartridge (Compatible)",
        "brand": { "name": "Brother", "slug": "brother" },
        "retail_price": 9.49,
        "color": "Black",
        "page_yield": "300",
        "product_type": "ink_cartridge",
        "pack_type": "single",
        "source": "compatible",
        "stock_quantity": 120,
        "image_url": null,
        "is_active": true
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 5,
      "total": 42,
      "total_pages": 9
    }
  }
}
```

### Add to Cart
```bash
POST /api/cart/items
Authorization: Bearer eyJ...
Content-Type: application/json

{ "product_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "quantity": 2 }
```
```json
{
  "success": true,
  "data": {
    "id": "cart-item-uuid",
    "product_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "quantity": 2,
    "product": {
      "name": "Brother LC131 Black Ink Cartridge (Compatible)",
      "sku": "B131B",
      "retail_price": 9.49
    }
  }
}
```

### Create Order
```bash
POST /api/orders
Authorization: Bearer eyJ...
Content-Type: application/json
```
```json
{
  "items": [
    { "product_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "quantity": 2 }
  ],
  "shipping_address": {
    "recipient_name": "John Smith",
    "phone": "021 123 4567",
    "address_line1": "123 Queen Street",
    "city": "Auckland",
    "region": "Auckland",
    "postal_code": "1010",
    "country": "NZ"
  }
}
```
**Response (201):**
```json
{
  "success": true,
  "data": {
    "order": {
      "id": "order-uuid",
      "order_number": "ORD-M1K2N3-A4B5",
      "status": "pending",
      "subtotal": 18.98,
      "gst_amount": 2.48,
      "shipping_cost": 5.00,
      "total": 23.98,
      "created_at": "2026-02-15T10:30:00.000Z"
    },
    "payment": {
      "payment_intent_id": "pi_3ABC123def456",
      "client_secret": "pi_3ABC123def456_secret_xyz789"
    }
  }
}
```

### Check Order Status
```bash
GET /api/orders/ORD-M1K2N3-A4B5
Authorization: Bearer eyJ...
```
```json
{
  "success": true,
  "data": {
    "id": "order-uuid",
    "order_number": "ORD-M1K2N3-A4B5",
    "status": "shipped",
    "subtotal": 18.98,
    "gst_amount": 2.48,
    "shipping_cost": 5.00,
    "total": 23.98,
    "tracking_number": "NZ123456789",
    "created_at": "2026-02-15T10:30:00.000Z",
    "items": [
      {
        "product_sku": "B131B",
        "product_name": "Brother LC131 Black Ink Cartridge (Compatible)",
        "quantity": 2,
        "unit_price": 9.49,
        "line_total": 18.98
      }
    ]
  }
}
```

### Submit Business Application
```bash
POST /api/business/apply
Authorization: Bearer eyJ...
Content-Type: application/json
```
```json
{
  "company_name": "Acme Office Supplies Ltd",
  "nzbn": "9429041234567",
  "contact_name": "Jane Doe",
  "contact_email": "jane@acme.co.nz",
  "contact_phone": "09 555 1234",
  "estimated_monthly_spend": "1000_2500",
  "industry": "retail"
}
```
**Response (201):**
```json
{
  "success": true,
  "data": {
    "application_id": "app-uuid",
    "status": "pending",
    "company_name": "Acme Office Supplies Ltd",
    "submitted_at": "2026-02-15T10:30:00.000Z",
    "message": "Your business account application has been submitted. We will review it within 1-2 business days."
  }
}
```

---

## 22. Audit Findings

### Issues Found (February 2026)

#### HIGH
| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| 1 | `src/routes/business.js` | 82 | PII leak: logs `contact_email` to console | Replace with user_id |
| 2 | `src/routes/shipping.js` | 56 | `rate.id === 'standard'` compares UUID to string literal | Use name-based check |

#### MEDIUM
| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| 3 | `src/utils/stateMachine.js` | 86,95,155,164 | Direct `hasOwnProperty` call on objects | Use `Object.prototype.hasOwnProperty.call()` |

#### LOW (Code Quality)
| # | File | Issue |
|---|------|-------|
| 4 | `src/routes/cart.js:7` | `setupSupabaseWithUser` imported but unused |
| 5 | `src/routes/products.js:9,19` | `productIdSchema`, `PACK_TYPES` unused |
| 6 | `src/routes/search.js:9` | `CONSUMABLE_TYPES` unused |
| 7 | `src/routes/orders.js:20` | `orderIdSchema` unused |
| 8 | `src/routes/business.js:3` | `setupSupabaseAdmin` imported but unused |
| 9 | `src/routes/adminAnalytics.js` | Multiple unused variables |
| 10 | `src/services/colorPackService.js:150` | `baseSku` should be `const` |
| 11 | `src/services/profileService.js:18` | `digits` should be `const` |

### Previously Fixed (Security Audit — same session)
- HTML injection in email templates (escapeHtml added)
- Webhook event-level idempotency (wired existing DB functions)
- AI prompt injection defense (sanitizeForPrompt)
- PostgREST filter sanitization (sanitizeFilterQuery)
- PII redaction in email logs
- Production cron auth guard
- Search rate limiting (30 req/min)
- CORS localhost restriction in production
- Admin RBAC (requireRole middleware)
- Order number generation (crypto.randomBytes instead of Math.random)

---

## 23. Missing Features & Improvements

### Missing Production Features
1. **APM/Monitoring:** No application performance monitoring (consider Sentry, Datadog, or New Relic)
2. **Structured Logging Service:** Uses console.log/error — consider Winston or Pino with JSON output
3. **Request ID Tracking:** No correlation ID for tracing requests across services
4. **Health Check Detail:** `/health` endpoint doesn't check DB/Stripe connectivity (only returns static JSON)
5. **API Versioning:** No version prefix (currently `/api/` — consider `/api/v1/`)

### Performance Improvements
1. **Redis:** In-memory rate limiting, token tracking, and idempotency sets won't survive server restarts or scale to multiple instances. Use Redis.
2. **Query Caching:** Frequently accessed data (brands, shipping rates, settings) could be cached
3. **Database Indexes:** Already has 50+ indexes — verify with `EXPLAIN ANALYZE` on slow queries

### Scalability Concerns
1. **Single instance:** All in-memory state (rate limits, AI token tracking, email rate tracking) is lost on restart
2. **Webhook processing:** Single-threaded — could bottleneck under high order volume
3. **Email queue:** Processes 10 emails per batch — may need to increase for scale

### Technical Debt
1. **32+ SQL utility files:** Could be consolidated into numbered migrations for cleaner management
2. **Admin routes file:** `admin.js` is ~2600 lines — consider splitting by domain (orders, products, customers)
3. **Unused imports:** 8+ files have unused imports (see audit findings above)

### Security Improvements
1. **CSP Headers:** Helmet is configured with `contentSecurityPolicy: false` — consider enabling
2. **API Key Rotation:** No mechanism for rotating Stripe/Supabase keys without downtime
3. **Audit Log Coverage:** `audit_logs` table exists but is not used by all admin actions
