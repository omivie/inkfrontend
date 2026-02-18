# Backend API Documentation for Frontend Developers

> Complete API reference for integrating with the Ink Cartridge E-Commerce backend.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Authentication](#authentication)
3. [Response Format](#response-format)
4. [Rate Limiting](#rate-limiting)
5. [Settings Endpoint](#settings-endpoint)
6. [Public Endpoints](#public-endpoints)
7. [Cart Endpoints](#cart-endpoints)
8. [Order Endpoints](#order-endpoints)
9. [User Endpoints](#user-endpoints)
10. [Auth Endpoints](#auth-endpoints)
11. [Shipping Endpoints](#shipping-endpoints)
12. [Business Account Endpoints](#business-account-endpoints)
13. [Chatbot Endpoints](#chatbot-endpoints)
14. [Admin Endpoints](#admin-endpoints)
15. [Analytics Endpoints](#analytics-endpoints)
16. [Admin Analytics Dashboard](#admin-analytics-dashboard)
17. [Error Handling](#error-handling)

---

## Quick Start

### Base URL

```
Production: https://your-api-domain.com
Development: http://localhost:3000
```

All API routes are prefixed with `/api/`.

### Authentication Overview

- **Public endpoints**: No authentication required
- **User endpoints**: Require `Authorization: Bearer <supabase_jwt_token>`
- **Guest cart**: Supports anonymous users via HTTP-only cookies
- **Admin endpoints**: Require JWT + admin role in database

### Key Business Rules

- **Currency**: NZD (New Zealand Dollars)
- **GST**: 15% included in all `retail_price` values
- **Shipping**: Flat rate $5.00 NZD (free shipping thresholds may apply)
- **Timezone**: NZ timezone for all timestamps

---

## Authentication

### Supabase JWT Authentication

The API uses Supabase Auth tokens. Get tokens via Supabase client-side SDK.

```javascript
// Frontend: Get token from Supabase
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// Include in API requests
fetch('/api/user/profile', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

### Auth Middleware Types

| Middleware | Description |
|------------|-------------|
| `requireAuth` | Request fails with 401 if no valid token |
| `optionalAuth` | Attempts auth but continues as anonymous if no token |
| `requireVerifiedEmail` | Requires `requireAuth` + verified email |
| `requireAdmin` | Requires `requireAuth` + admin role in database |

### Token Validation

The backend validates tokens against Supabase Auth on every request:

```javascript
// Backend validates via Supabase
const { data: { user }, error } = await supabase.auth.getUser(token);
```

If validation fails, you'll receive:

```json
{
  "success": false,
  "error": "Invalid token"
}
```

---

## Response Format

### Success Response

```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

### Error Response

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": { ... }
}
```

### Pagination

Paginated endpoints return:

```json
{
  "success": true,
  "data": {
    "items": [ ... ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "total_pages": 8,
      "has_next": true,
      "has_prev": false
    }
  }
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing/invalid token) |
| 403 | Forbidden (no permission / email not verified) |
| 404 | Not Found |
| 409 | Conflict (duplicate resource) |
| 429 | Too Many Requests |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

---

## Rate Limiting

| Endpoint Category | Limit | Window |
|-------------------|-------|--------|
| General API (`/api/*`) | 100 requests | 1 minute |
| Cart operations | 60 requests | 1 minute |
| Auth verification | 5 requests | 15 minutes |
| Chatbot | Custom per-user | Varies |

Rate limit exceeded response:

```json
{
  "success": false,
  "error": "Too many requests"
}
```

---

## Settings Endpoint

### GET /api/settings

Get frontend configuration settings.

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
    "currency": "NZD",
    "country": "NZ",
    "features": {
      "businessAccounts": true,
      "chatbot": true,
      "colorPacks": true,
      "guestCheckout": false
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `FREE_SHIPPING_THRESHOLD` | number | Order total for free standard shipping (NZD) |
| `SHIPPING_FEE` | number | Standard shipping fee (NZD) |
| `LOW_STOCK_THRESHOLD` | number | Threshold for "low stock" warning |
| `CRITICAL_STOCK_THRESHOLD` | number | Threshold for "critical stock" warning |
| `currency` | string | Currency code |
| `country` | string | Default country code |
| `features` | object | Feature flags for frontend |

---

## Public Endpoints

### Products

#### GET /api/products

List products with filtering and pagination.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number |
| `limit` | integer | 20 | Items per page (max 100) |
| `search` | string | - | Search by name or SKU |
| `brand` | string | - | Filter by brand slug |
| `color` | string | - | Filter by color |
| `type` | string | - | `cartridge`, `consumable`, or `printer` |
| `category` | string | - | `ink`, `toner`, `printer`, `laser`, `inkjet`, `consumable`, `cartridge` |
| `source` | string | - | `genuine` or `compatible` |
| `sort` | string | `name_asc` | `price_asc`, `price_desc`, `name_asc`, `name_desc` |

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
        "brand": { "id": "uuid", "name": "Brother", "slug": "brother" },
        "manufacturer_part_number": "LC131BK",
        "retail_price": 24.90,
        "color": "Black",
        "page_yield": "300 pages",
        "stock_quantity": 45,
        "image_url": "https://...",
        "is_featured": false,
        "product_type": "ink_cartridge",
        "category": "CON-INK",
        "source": "genuine",
        "specifications": { ... },
        "in_stock": true
      }
    ],
    "pagination": { ... }
  }
}
```

---

#### GET /api/products/:sku

Get single product by SKU.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "sku": "B131B",
    "name": "Brother LC131 Black Ink Cartridge",
    "brand": { "id": "uuid", "name": "Brother", "slug": "brother", "logo_url": "..." },
    "manufacturer_part_number": "LC131BK",
    "retail_price": 24.90,
    "color": "Black",
    "page_yield": "300 pages",
    "barcode": "4977766703178",
    "category": "CON-INK",
    "weight_kg": 0.05,
    "stock_quantity": 45,
    "low_stock_threshold": 5,
    "image_url": "https://...",
    "is_featured": false,
    "product_type": "ink_cartridge",
    "specifications": { ... },
    "in_stock": true,
    "is_low_stock": false,
    "compatible_printers": [
      {
        "id": "uuid",
        "model_name": "MFC-J870DW",
        "full_name": "Brother MFC-J870DW",
        "brand": "Brother"
      }
    ]
  }
}
```

---

#### GET /api/products/printer/:printerSlug

Get products compatible with a specific printer.

**Response:**

```json
{
  "success": true,
  "data": {
    "printer": {
      "id": "uuid",
      "model_name": "MFC-J870DW",
      "full_name": "Brother MFC-J870DW",
      "slug": "brother-mfc-j870dw",
      "brand": { "name": "Brother", "slug": "brother" }
    },
    "compatible_products": [ ... ],
    "total_compatible": 12
  }
}
```

---

#### GET /api/products/printer/:printerSlug/color-packs

Get auto-generated CMY/KCMY color pack bundles for a printer.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `include_unavailable` | boolean | Include packs that can't be created (with reasons) |
| `source` | string | Filter by `genuine` or `compatible` |

**Response:**

```json
{
  "success": true,
  "data": {
    "printer": { ... },
    "genuine": {
      "packs": [
        {
          "pack_type": "KCMY",
          "items": [ ... ],
          "original_price": 99.60,
          "discounted_price": 92.90,
          "savings": 6.70
        }
      ],
      "total": 2
    },
    "compatible": {
      "packs": [ ... ],
      "total": 2
    },
    "total_packs": 4,
    "discount_rate": 0.07
  }
}
```

---

### Brands

#### GET /api/brands

List all active brands.

**Response:**

```json
{
  "success": true,
  "data": [
    { "id": "uuid", "name": "Brother", "slug": "brother", "logo_url": "https://..." },
    { "id": "uuid", "name": "Canon", "slug": "canon", "logo_url": "https://..." }
  ]
}
```

---

### Printers

#### GET /api/printers/search

Search/autocomplete printer models.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query (min 2 chars) |
| `brand` | string | No | Filter by brand slug |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "model_name": "MFC-J870DW",
      "full_name": "Brother MFC-J870DW",
      "slug": "brother-mfc-j870dw",
      "brand": { "name": "Brother", "slug": "brother" },
      "compatible_products_count": 12
    }
  ]
}
```

---

### Search

#### GET /api/search/by-printer

Find cartridges compatible with a printer.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Printer name/model |
| `limit` | integer | No | Results per page (default: 20) |
| `page` | integer | No | Page number (default: 1) |

**Response:**

```json
{
  "success": true,
  "data": {
    "printer_search": "Brother MFC-J870",
    "products": [ ... ],
    "total": 15,
    "page": 1,
    "limit": 20,
    "total_pages": 1
  }
}
```

---

#### GET /api/search/by-part

Search products by SKU, part number, or name.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search term |
| `type` | string | No | `cartridge`, `consumable`, or `printer` |
| `limit` | integer | No | Results per page (default: 20) |
| `page` | integer | No | Page number (default: 1) |

**Response:**

```json
{
  "success": true,
  "data": {
    "search_term": "LC131",
    "filter": "cartridge",
    "products": [
      {
        "product_id": "uuid",
        "sku": "B131B",
        "name": "Brother LC131 Black",
        "brand_name": "Brother",
        "retail_price": 24.90,
        "color": "Black",
        "page_yield": "300 pages",
        "product_type": "ink_cartridge",
        "source": "genuine",
        "stock_quantity": 45,
        "compatible_printers": ["Brother MFC-J870DW", "Brother DCP-J752DW"]
      }
    ],
    "total": 4,
    "page": 1,
    "limit": 20,
    "total_pages": 1
  }
}
```

---

#### GET /api/search/autocomplete

Fast autocomplete for search box.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search term (min 2 chars) |
| `limit` | integer | No | Max suggestions (default: 10, max: 20) |

**Response:**

```json
{
  "success": true,
  "data": {
    "search_term": "bro",
    "suggestions": [
      { "type": "printer", "label": "Brother MFC-J870DW", "slug": "brother-mfc-j870dw" },
      { "type": "product", "label": "Brother LC131 Black", "sku": "B131B" }
    ]
  }
}
```

---

#### GET /api/search/compatible-printers/:sku

Get all printers compatible with a specific cartridge.

**Response:**

```json
{
  "success": true,
  "data": {
    "cartridge": { "sku": "B131B", "name": "Brother LC131 Black" },
    "compatible_printers": [
      { "id": "uuid", "full_name": "Brother MFC-J870DW", "model_name": "MFC-J870DW", "brand": "Brother" }
    ],
    "total": 8
  }
}
```

---

## Cart Endpoints

The cart supports both authenticated users and anonymous guests via HTTP-only cookies.

### GET /api/cart

Get current cart contents.

**Auth:** Optional (works for both guests and authenticated users)

**Response:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "quantity": 2,
        "product": {
          "id": "uuid",
          "sku": "B131B",
          "name": "Brother LC131 Black",
          "retail_price": 24.90,
          "stock_quantity": 45,
          "color": "Black",
          "image_url": "https://...",
          "brand": { "name": "Brother", "slug": "brother" }
        },
        "price_snapshot": 24.90,
        "line_total": 49.80,
        "in_stock": true,
        "created_at": "2024-01-15T10:30:00Z",
        "updated_at": "2024-01-15T10:30:00Z"
      }
    ],
    "coupon": null,
    "summary": {
      "item_count": 2,
      "unique_items": 1,
      "subtotal": 49.80,
      "discount": 0,
      "total": 49.80
    },
    "is_guest": false
  }
}
```

---

### POST /api/cart/items

Add item to cart.

**Auth:** Optional

**Request Body:**

```json
{
  "product_id": "uuid",
  "quantity": 1
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `product_id` | uuid | Yes | Product UUID |
| `quantity` | integer | No | Quantity (default: 1, max: 100) |

**Response (201 Created):**

```json
{
  "success": true,
  "message": "Added to cart",
  "data": {
    "id": "uuid",
    "product_id": "uuid",
    "quantity": 1,
    "price_snapshot": 24.90,
    "product": { "sku": "B131B", "name": "Brother LC131 Black", "retail_price": 24.90 }
  }
}
```

**Error Responses:**

- `404` - Product not found
- `400` - Product not available / Insufficient stock

---

### PUT /api/cart/items/:productId

Update cart item quantity.

**Auth:** Optional

**Request Body:**

```json
{
  "quantity": 3
}
```

**Response:**

```json
{
  "success": true,
  "message": "Cart updated",
  "data": { "id": "uuid", "product_id": "uuid", "quantity": 3 }
}
```

---

### DELETE /api/cart/items/:productId

Remove item from cart.

**Auth:** Optional

**Response:**

```json
{
  "success": true,
  "message": "Item removed from cart"
}
```

---

### DELETE /api/cart

Clear entire cart.

**Auth:** Optional

**Response:**

```json
{
  "success": true,
  "message": "Cart cleared"
}
```

---

### GET /api/cart/count

Quick cart count for header badge.

**Auth:** Optional

**Response:**

```json
{
  "success": true,
  "data": { "count": 5, "unique_items": 3 }
}
```

---

### POST /api/cart/merge

Merge guest cart into authenticated user's cart (call after sign-in).

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "message": "Cart merged successfully",
  "data": {
    "merged_count": 2,
    "added_count": 1,
    "total_items": 5
  }
}
```

---

### POST /api/cart/validate

Validate cart before checkout.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "is_valid": true,
    "valid_items": [
      {
        "product_id": "uuid",
        "sku": "B131B",
        "name": "Brother LC131 Black",
        "quantity": 2,
        "unit_price": 24.90,
        "price_snapshot": 24.90,
        "price_changed": false,
        "line_total": 49.80
      }
    ],
    "issues": [],
    "summary": {
      "valid_item_count": 1,
      "issue_count": 0,
      "subtotal": 49.80
    }
  }
}
```

**Possible Issues:**

```json
{
  "issues": [
    { "cart_item_id": "uuid", "sku": "X123", "name": "...", "issue": "Product is no longer available" },
    { "cart_item_id": "uuid", "sku": "Y456", "name": "...", "issue": "Insufficient stock", "requested": 10, "available": 3 }
  ]
}
```

---

### Coupon Endpoints (Authenticated Only)

#### POST /api/cart/coupon

Apply a coupon code.

**Auth:** Required

**Request Body:**

```json
{
  "code": "SAVE10"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Coupon applied!",
  "data": {
    "code": "SAVE10",
    "description": "10% off your order",
    "discount_type": "percentage",
    "discount_value": 10,
    "discount_amount": 4.98,
    "subtotal": 49.80,
    "new_total": 44.82
  }
}
```

#### DELETE /api/cart/coupon

Remove applied coupon.

**Auth:** Required

#### GET /api/cart/coupon

Get currently applied coupon.

**Auth:** Required

---

## Order Endpoints

### POST /api/orders

Create a new order with Stripe payment.

**Auth:** Required + Verified Email

**Request Body:**

```json
{
  "items": [
    { "product_id": "uuid", "quantity": 2 }
  ],
  "shipping_address": {
    "recipient_name": "John Smith",
    "phone": "021 123 4567",
    "address_line1": "123 Main Street",
    "address_line2": "Unit 4",
    "city": "Auckland",
    "region": "Auckland",
    "postal_code": "1010",
    "country": "NZ"
  },
  "save_address": true,
  "customer_notes": "Please leave at door"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | Yes | Array of `{ product_id, quantity }` |
| `items[].product_id` | uuid | Yes | Product UUID |
| `items[].quantity` | integer | Yes | Quantity (1-100) |
| `shipping_address` | object | Yes | Shipping details |
| `shipping_address.recipient_name` | string | Yes | Recipient name (max 200) |
| `shipping_address.phone` | string | No | Phone number (max 20) |
| `shipping_address.address_line1` | string | Yes | Street address (max 255) |
| `shipping_address.address_line2` | string | No | Apartment/unit (max 255) |
| `shipping_address.city` | string | Yes | City (max 100) |
| `shipping_address.region` | string | No | Region/state (max 100) |
| `shipping_address.postal_code` | string | Yes | Postal code (max 20) |
| `shipping_address.country` | string | No | 2-letter code (default: "NZ") |
| `save_address` | boolean | No | Save address for future orders |
| `customer_notes` | string | No | Notes for the order (max 500) |

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-LX3F2K-A9B1",
    "status": "pending",
    "total_amount": 54.80,
    "client_secret": "pi_xxx_secret_xxx",
    "items": [ ... ],
    "shipping_address": { ... },
    "created_at": "2024-01-15T10:30:00Z"
  }
}
```

**Important:** Use the `client_secret` with Stripe.js to complete payment:

```javascript
const stripe = await loadStripe('pk_...');
const { error } = await stripe.confirmPayment({
  clientSecret: response.data.client_secret,
  confirmParams: {
    return_url: 'https://yoursite.com/order/confirm'
  }
});
```

**Error Responses:**

- `400` - Validation failed / Stock issues
- `403` - Email not verified (`code: EMAIL_NOT_VERIFIED`)
- `409` - Duplicate order (`code: DUPLICATE_REQUEST`)

---

### GET /api/orders

Get user's order history.

**Auth:** Required

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number |
| `limit` | integer | 20 | Items per page (max 100) |
| `status` | string | - | Filter: `pending`, `paid`, `processing`, `shipped`, `completed`, `cancelled` |

**Response:**

```json
{
  "success": true,
  "data": {
    "orders": [
      {
        "id": "uuid",
        "order_number": "ORD-LX3F2K-A9B1",
        "status": "shipped",
        "subtotal": 43.30,
        "gst_amount": 6.50,
        "shipping_cost": 5.00,
        "total": 54.80,
        "shipping_recipient_name": "John Smith",
        "shipping_city": "Auckland",
        "created_at": "2024-01-15T10:30:00Z",
        "updated_at": "2024-01-16T14:00:00Z",
        "order_items": [
          {
            "id": "uuid",
            "product_id": "uuid",
            "product_sku": "B131B",
            "product_name": "Brother LC131 Black",
            "quantity": 2,
            "unit_price": 21.65,
            "line_total": 43.30,
            "product": { "id": "uuid", "sku": "B131B", "name": "...", "image_url": "..." }
          }
        ]
      }
    ],
    "pagination": { ... }
  }
}
```

---

### GET /api/orders/:orderNumber

Get specific order details.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "order_number": "ORD-LX3F2K-A9B1",
    "status": "shipped",
    "subtotal": 43.30,
    "gst_amount": 6.50,
    "shipping_cost": 5.00,
    "total": 54.80,
    "shipping_recipient_name": "John Smith",
    "shipping_phone": "021 123 4567",
    "shipping_address_line1": "123 Main Street",
    "shipping_address_line2": "Unit 4",
    "shipping_city": "Auckland",
    "shipping_region": "Auckland",
    "shipping_postal_code": "1010",
    "shipping_country": "NZ",
    "customer_notes": "Please leave at door",
    "tracking_number": "NZ12345678",
    "created_at": "2024-01-15T10:30:00Z",
    "updated_at": "2024-01-16T14:00:00Z",
    "order_items": [ ... ]
  }
}
```

---

## User Endpoints

### Profile

#### GET /api/user/profile

Get user profile.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "first_name": "John",
    "last_name": "Smith",
    "phone": "021 123 4567",
    "email": "john@example.com",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-15T10:30:00Z"
  }
}
```

---

#### PUT /api/user/profile

Update user profile.

**Auth:** Required

**Request Body:**

```json
{
  "first_name": "John",
  "last_name": "Smith",
  "phone": "021 123 4567"
}
```

All fields are optional but at least one must be provided.

---

### Addresses

#### GET /api/user/addresses

Get user's saved addresses.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "recipient_name": "John Smith",
      "phone": "021 123 4567",
      "address_line1": "123 Main Street",
      "address_line2": "Unit 4",
      "city": "Auckland",
      "region": "Auckland",
      "postal_code": "1010",
      "country": "NZ",
      "is_default": true,
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

#### POST /api/user/address

Add new address.

**Auth:** Required

**Request Body:**

```json
{
  "recipient_name": "John Smith",
  "phone": "021 123 4567",
  "address_line1": "123 Main Street",
  "address_line2": "Unit 4",
  "city": "Auckland",
  "region": "Auckland",
  "postal_code": "1010",
  "country": "NZ",
  "is_default": true
}
```

---

#### PUT /api/user/address/:addressId

Update existing address.

**Auth:** Required

---

#### DELETE /api/user/address/:addressId

Delete an address.

**Auth:** Required

---

### Saved Printers

#### GET /api/user/printers

Get user's saved printers.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "printer_id": "uuid",
      "created_at": "2024-01-15T10:30:00Z",
      "printer": {
        "id": "uuid",
        "model_name": "MFC-J870DW",
        "full_name": "Brother MFC-J870DW",
        "slug": "brother-mfc-j870dw",
        "brand": { "name": "Brother", "slug": "brother" }
      }
    }
  ]
}
```

---

#### POST /api/user/printers

Save a printer to user's list.

**Auth:** Required

**Request Body:**

```json
{
  "printer_id": "uuid"
}
```

---

#### PUT /api/user/printers/:printerId

Update a saved printer (e.g., set nickname).

**Auth:** Required

**Request Body:**

```json
{
  "nickname": "Office Printer"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nickname` | string | No | Custom name for the printer (max 100 chars) |

**Response:**

```json
{
  "success": true,
  "message": "Printer updated",
  "data": {
    "id": "uuid",
    "printer_id": "uuid",
    "nickname": "Office Printer",
    "updated_at": "2024-01-15T10:30:00Z",
    "printer": {
      "id": "uuid",
      "model_name": "MFC-J870DW",
      "full_name": "Brother MFC-J870DW",
      "slug": "brother-mfc-j870dw"
    }
  }
}
```

---

#### DELETE /api/user/printers/:printerId

Remove a saved printer.

**Auth:** Required

---

### Favourites

#### GET /api/user/favourites

Get user's favourite products.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "favourites": [
      {
        "id": "uuid",
        "product_id": "uuid",
        "product_sku": "B131B",
        "product": {
          "id": "uuid",
          "sku": "B131B",
          "name": "Brother LC131 Black",
          "retail_price": 24.90,
          "stock_quantity": 45,
          "image_url": "https://...",
          "color": "Black",
          "is_active": true,
          "brand": { "name": "Brother", "slug": "brother" },
          "in_stock": true
        },
        "added_at": "2024-01-15T10:30:00Z"
      }
    ],
    "count": 5
  }
}
```

---

#### POST /api/user/favourites

Add product to favourites.

**Auth:** Required

**Request Body:**

```json
{
  "product_id": "uuid"
}
```

---

#### DELETE /api/user/favourites/:productId

Remove product from favourites.

**Auth:** Required

---

#### POST /api/user/favourites/sync

Bulk sync favourites (merge localStorage on login).

**Auth:** Required

**Request Body:**

```json
{
  "product_ids": ["uuid1", "uuid2", "uuid3"]
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "synced": 2,
    "already_existed": 1,
    "invalid_products": 0,
    "total_favourites": 5
  }
}
```

---

#### GET /api/user/favourites/check/:productId

Check if a product is favourited.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "is_favourite": true,
    "favourite_id": "uuid",
    "added_at": "2024-01-15T10:30:00Z"
  }
}
```

---

### Savings

#### GET /api/user/savings

Get user's total savings summary.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "total_savings": 45.50,
    "savings_by_type": [
      { "type": "free_shipping", "total": 15.00, "order_count": 3, "label": "Free Shipping" },
      { "type": "coupon", "total": 30.50, "order_count": 2, "label": "Coupon Discount" }
    ],
    "recent_savings": [ ... ],
    "account_type": "personal",
    "business_discount": null,
    "savings_message": "You've saved $45.50 shopping with us!"
  }
}
```

---

## Auth Endpoints

### GET /api/auth/verification-status

Check if user's email is verified.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "email": "john@example.com",
    "email_verified": true,
    "verified_at": "2024-01-01T00:00:00Z"
  }
}
```

---

### POST /api/auth/resend-verification

Resend verification email.

**Auth:** Required
**Rate Limit:** 5 requests per 15 minutes

**Response:**

```json
{
  "success": true,
  "message": "Verification email sent successfully",
  "data": { "email": "john@example.com" }
}
```

**Error:** `400` if email already verified.

---

### POST /api/auth/verify-email

Verify email with token (for custom verification flows).

**Request Body:**

```json
{
  "token": "verification_token_hash",
  "type": "email"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | Yes | Token hash from email link |
| `type` | string | No | `email`, `signup`, or `recovery` (default: `email`) |

**Response:**

```json
{
  "success": true,
  "message": "Email verified successfully",
  "data": {
    "user": { "id": "uuid", "email": "john@example.com", "email_verified": true },
    "session": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": 1234567890
    }
  }
}
```

---

## Shipping Endpoints

### GET /api/shipping/rates

Get all shipping rates (public).

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "standard",
      "name": "Standard Shipping",
      "description": "Delivered in 3-5 business days",
      "price": 5.00,
      "free_threshold": 75.00,
      "estimated_days": "3-5"
    },
    {
      "id": "express",
      "name": "Express Shipping",
      "description": "Delivered in 1-2 business days",
      "price": 12.00,
      "free_threshold": null,
      "estimated_days": "1-2"
    }
  ]
}
```

---

### POST /api/shipping/options

Get personalized shipping options for cart.

**Auth:** Required

**Request Body:**

```json
{
  "cart_total": 65.50,
  "item_count": 3,
  "postal_code": "1010"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "options": [
      {
        "id": "standard",
        "name": "Standard Shipping",
        "description": "3-5 business days",
        "price": 5.00,
        "original_price": 5.00,
        "is_free": false,
        "free_threshold": 75.00,
        "estimated_days": "3-5",
        "available": true
      }
    ],
    "cart_summary": {
      "subtotal": 65.50,
      "item_count": 3,
      "qualifies_for_free_shipping": false
    },
    "free_shipping": {
      "threshold": 75.00,
      "amount_needed": 9.50,
      "message": "Add $9.50 more for free shipping!"
    },
    "business_benefits": null
  }
}
```

---

## Business Account Endpoints

### POST /api/business/apply

Submit business account application.

**Auth:** Required

**Request Body:**

```json
{
  "company_name": "Acme Ltd",
  "nzbn": "9429041234567",
  "contact_name": "John Smith",
  "contact_email": "john@acme.co.nz",
  "contact_phone": "09 123 4567",
  "estimated_monthly_spend": "500_1000",
  "industry": "technology"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `company_name` | string | Yes | Company name (max 255) |
| `nzbn` | string | No | NZ Business Number (13 digits) |
| `contact_name` | string | Yes | Contact person name |
| `contact_email` | string | Yes | Contact email |
| `contact_phone` | string | No | Contact phone |
| `estimated_monthly_spend` | string | No | `under_500`, `500_1000`, `1000_2500`, `2500_5000`, `over_5000` |
| `industry` | string | No | `education`, `healthcare`, `government`, `retail`, `technology`, `manufacturing`, `professional_services`, `hospitality`, `other` |

**Response (201 Created):**

```json
{
  "success": true,
  "data": {
    "application_id": "uuid",
    "status": "pending",
    "company_name": "Acme Ltd",
    "submitted_at": "2024-01-15T10:30:00Z",
    "message": "Your business account application has been submitted. We will review it within 1-2 business days."
  }
}
```

**Error:** `409` if already has pending/approved application.

---

### GET /api/business/status

Get current business account status.

**Auth:** Required

**Response:**

```json
{
  "success": true,
  "data": {
    "status": "approved",
    "account_type": "business",
    "business_details": {
      "company_name": "Acme Ltd",
      "nzbn": "9429041234567",
      "business_status": "active",
      "credit_limit": 5000.00,
      "payment_terms": "net_30",
      "discount_percentage": 10
    },
    "application": {
      "id": "uuid",
      "company_name": "Acme Ltd",
      "status": "approved",
      "submitted_at": "2024-01-15T10:30:00Z",
      "reviewed_at": "2024-01-16T14:00:00Z"
    },
    "can_apply": false
  }
}
```

Possible `status` values: `personal`, `pending`, `approved`, `rejected`

---

## Chatbot Endpoints

### POST /api/chat

Send message to AI chatbot.

**Auth:** Optional (enhanced context for authenticated users)

**Request Body:**

```json
{
  "message": "Do you have HP 63 ink cartridges?",
  "session_id": "optional-existing-session-id",
  "context": {
    "current_product_sku": "H63XLB",
    "current_printer_slug": "hp-deskjet-3630",
    "page": "product_detail"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message (max 2000 chars) |
| `session_id` | string | No | Session ID for conversation continuity |
| `context.current_product_sku` | string | No | SKU of product user is viewing |
| `context.current_printer_slug` | string | No | Printer slug user is viewing |
| `context.page` | string | No | `home`, `products`, `product_detail`, `cart`, `checkout`, `orders`, `account` |

**Response:**

```json
{
  "success": true,
  "data": {
    "response": "Yes, we have HP 63 cartridges in both standard and XL sizes...",
    "session_id": "abc123-def456",
    "intent": "product_search",
    "blocked": false
  }
}
```

---

### DELETE /api/chat/session/:session_id

Clear conversation history for a session.

**Response:**

```json
{
  "success": true,
  "message": "Session cleared"
}
```

---

### GET /api/chat/health

Check chatbot service health.

**Response:**

```json
{
  "success": true,
  "data": {
    "status": "operational",
    "ai_service": { "configured": true, "provider": "anthropic" },
    "usage": { "active_sessions": 15 },
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

---

## Admin Endpoints

> These endpoints require admin authentication (`requireAdmin` middleware).

### GET /api/admin/verify

Verify admin access and get role info.

**Response:**

```json
{
  "success": true,
  "data": {
    "is_admin": true,
    "role": "super_admin",
    "roles": ["super_admin"],
    "email": "admin@example.com"
  }
}
```

---

### GET /api/admin/orders

List all orders with filtering.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | integer | Page number (default: 1) |
| `limit` | integer | Items per page (default: 50, max: 500) |
| `status` | string | Filter by status |
| `customer_email` | string | Filter by customer email |
| `date_from` | string | Filter from date (YYYY-MM-DD) |
| `date_to` | string | Filter to date (YYYY-MM-DD) |
| `sort` | string | `newest`, `oldest`, `total-high`, `total-low` |

---

### PUT /api/admin/orders/:orderId

Update order status.

**Request Body:**

```json
{
  "status": "shipped",
  "tracking_number": "NZ12345678",
  "admin_notes": "Shipped via NZ Post"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | `paid`, `processing`, `shipped`, `completed`, `cancelled` |
| `tracking_number` | string | No | Tracking number (required for `shipped`) |
| `admin_notes` | string | No | Internal notes |
| `confirm_processing_cancellation` | boolean | No | Required when cancelling `processing` orders |

---

### GET /api/admin/products

List all products (including cost prices and inactive).

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | integer | Page number |
| `limit` | integer | Items per page (max: 500) |
| `search` | string | Search by name, SKU, or MPN |
| `brand` | string | Filter by brand slug |
| `is_active` | string | `true` or `false` |

---

### PUT /api/admin/products/:sku

Update product (by SKU).

**Request Body:**

```json
{
  "retail_price": 29.90,
  "stock_quantity": 100,
  "is_active": true
}
```

---

### GET /api/admin/products/:productId

Get full product details for editing (by UUID).

---

### PUT /api/admin/products/:productId

Full product update (by UUID).

---

### Product Image Management

- `POST /api/admin/products/:productId/images` - Upload image
- `DELETE /api/admin/products/:productId/images/:imageId` - Delete image
- `PUT /api/admin/products/:productId/images/reorder` - Reorder images

---

### GET /api/admin/customers

List all customers with order stats.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | integer | Page number (default: 1) |
| `limit` | integer | Items per page (default: 50) |
| `search` | string | Search by email, name |
| `sort` | string | `newest`, `orders`, `spent` |

---

### Business Applications

#### GET /api/admin/business-applications

List all business account applications.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | integer | Page number (default: 1) |
| `limit` | integer | Items per page (default: 50) |
| `status` | string | Filter: `pending`, `approved`, `rejected` |
| `sort` | string | `newest`, `oldest`, `company_name` |

**Response:**

```json
{
  "success": true,
  "data": {
    "applications": [
      {
        "id": "uuid",
        "user_id": "uuid",
        "company_name": "Acme Ltd",
        "nzbn": "9429041234567",
        "contact_name": "John Smith",
        "contact_email": "john@acme.co.nz",
        "contact_phone": "09 123 4567",
        "estimated_monthly_spend": "500_1000",
        "industry": "technology",
        "status": "pending",
        "submitted_at": "2024-01-15T10:30:00Z",
        "reviewed_at": null,
        "reviewed_by": null,
        "admin_notes": null,
        "user": {
          "email": "john@example.com",
          "first_name": "John",
          "last_name": "Smith"
        }
      }
    ],
    "pagination": { ... }
  }
}
```

---

#### GET /api/admin/business-applications/:applicationId

Get single application details.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "user_id": "uuid",
    "company_name": "Acme Ltd",
    "nzbn": "9429041234567",
    "contact_name": "John Smith",
    "contact_email": "john@acme.co.nz",
    "contact_phone": "09 123 4567",
    "estimated_monthly_spend": "500_1000",
    "industry": "technology",
    "status": "pending",
    "submitted_at": "2024-01-15T10:30:00Z",
    "reviewed_at": null,
    "reviewed_by": null,
    "admin_notes": null,
    "user": {
      "id": "uuid",
      "email": "john@example.com",
      "first_name": "John",
      "last_name": "Smith",
      "created_at": "2024-01-01T00:00:00Z"
    },
    "user_orders": {
      "total_orders": 5,
      "total_spent": 450.00,
      "last_order_at": "2024-01-10T10:00:00Z"
    }
  }
}
```

---

#### PUT /api/admin/business-applications/:applicationId

Approve or reject business application.

**Request Body:**

```json
{
  "status": "approved",
  "admin_notes": "Verified business registration",
  "credit_limit": 5000,
  "discount_percentage": 10,
  "payment_terms": "net_30"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | `approved` or `rejected` |
| `admin_notes` | string | No | Internal notes |
| `credit_limit` | number | No | Credit limit for approved accounts (default: 1000) |
| `discount_percentage` | number | No | Business discount % (default: 5) |
| `payment_terms` | string | No | `prepay`, `net_7`, `net_14`, `net_30` (default: `prepay`) |

**Response:**

```json
{
  "success": true,
  "message": "Application approved",
  "data": {
    "id": "uuid",
    "status": "approved",
    "reviewed_at": "2024-01-16T14:00:00Z",
    "email_sent": true
  }
}
```

**Note:** When status is updated, an email notification is automatically sent to the applicant.

---

#### GET /api/admin/business-applications-stats

Get business applications statistics.

**Response:**

```json
{
  "success": true,
  "data": {
    "total": 50,
    "pending": 5,
    "approved": 40,
    "rejected": 5,
    "this_month": {
      "submitted": 8,
      "approved": 6,
      "rejected": 1
    },
    "average_review_time_hours": 18.5
  }
}
```

---

## Analytics Endpoints

> Cart and marketing analytics for tracking user behavior.

### POST /api/analytics/cart-event

Track cart events (add, remove, view, checkout, abandon).

**Auth:** None (supports anonymous tracking)

**Request Body:**

```json
{
  "event_type": "add_to_cart",
  "product_id": "uuid",
  "quantity": 2,
  "session_id": "anonymous-session-123",
  "metadata": {
    "source": "product_page",
    "printer_context": "brother-mfc-j870dw"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_type` | string | Yes | `view_cart`, `add_to_cart`, `remove_from_cart`, `update_quantity`, `begin_checkout`, `abandon_cart`, `complete_purchase` |
| `product_id` | uuid | No | Product UUID (required for add/remove/update) |
| `quantity` | integer | No | Quantity involved |
| `session_id` | string | No | Session identifier for anonymous tracking |
| `metadata` | object | No | Additional context (source, printer_context, etc.) |

**Response (201 Created):**

```json
{
  "success": true,
  "message": "Event recorded",
  "data": {
    "event_id": "uuid"
  }
}
```

---

### GET /api/analytics/cart-summary

Get cart analytics summary (admin only).

**Auth:** Required (Admin)

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | integer | Number of days to analyze (default: 30) |

**Response:**

```json
{
  "success": true,
  "data": {
    "period_days": 30,
    "events": {
      "total": 1250,
      "by_type": {
        "add_to_cart": 450,
        "remove_from_cart": 120,
        "view_cart": 380,
        "begin_checkout": 200,
        "complete_purchase": 85,
        "abandon_cart": 15
      }
    },
    "conversion": {
      "cart_to_checkout_rate": 0.44,
      "checkout_to_purchase_rate": 0.425,
      "overall_conversion_rate": 0.19
    },
    "top_products": [
      {
        "product_id": "uuid",
        "sku": "B131B",
        "name": "Brother LC131 Black",
        "add_count": 45,
        "purchase_count": 32
      }
    ]
  }
}
```

---

### GET /api/analytics/abandoned-carts

Get abandoned cart details (admin only).

**Auth:** Required (Admin)

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | integer | Days to look back (default: 7) |
| `min_value` | number | Minimum cart value |
| `page` | integer | Page number |
| `limit` | integer | Items per page |

**Response:**

```json
{
  "success": true,
  "data": {
    "abandoned_carts": [
      {
        "session_id": "abc123",
        "user_id": "uuid",
        "user_email": "john@example.com",
        "cart_value": 89.50,
        "item_count": 3,
        "last_activity": "2024-01-15T10:30:00Z",
        "abandoned_at": "2024-01-15T11:00:00Z",
        "items": [
          { "sku": "B131B", "name": "Brother LC131 Black", "quantity": 2 }
        ]
      }
    ],
    "summary": {
      "total_abandoned": 15,
      "total_value": 1250.00,
      "average_value": 83.33
    },
    "pagination": { ... }
  }
}
```

---

### GET /api/analytics/marketing

Get marketing metrics (admin only).

**Auth:** Required (Admin)

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | integer | Analysis period (default: 30) |

**Response:**

```json
{
  "success": true,
  "data": {
    "period_days": 30,
    "sessions": {
      "total": 2500,
      "unique": 1800,
      "returning": 700
    },
    "engagement": {
      "avg_session_duration_seconds": 245,
      "avg_pages_per_session": 4.2,
      "bounce_rate": 0.35
    },
    "acquisition": {
      "by_source": {
        "direct": 800,
        "organic_search": 600,
        "referral": 300,
        "social": 200,
        "email": 100
      }
    },
    "products": {
      "most_viewed": [...],
      "most_added_to_cart": [...],
      "highest_conversion": [...]
    }
  }
}
```

---

## Admin Analytics Dashboard

> Comprehensive business intelligence endpoints for the admin dashboard. All endpoints require admin authentication.

### Dashboard Summaries (HIGH PRIORITY)

#### GET /api/admin/analytics/summary/financial

Get financial health dashboard summary.

**Response:**

```json
{
  "success": true,
  "data": {
    "revenue": { "current": 15000, "previous": 12000, "change_percent": 25 },
    "gross_margin": { "current": 45.5, "previous": 42.0 },
    "net_margin": { "current": 22.3, "previous": 20.1 },
    "cash_balance": 50000,
    "runway_months": 8.5
  }
}
```

---

#### GET /api/admin/analytics/summary/customers

Get customer intelligence dashboard summary.

**Response:**

```json
{
  "success": true,
  "data": {
    "total_customers": 1500,
    "new_customers_30d": 120,
    "avg_ltv": 245.50,
    "churn_rate": 5.2,
    "nps_score": 45
  }
}
```

---

#### GET /api/admin/analytics/summary/operations

Get operations intelligence dashboard summary.

**Response:**

```json
{
  "success": true,
  "data": {
    "inventory_value": 125000,
    "inventory_retail_value": 250000,
    "turnover_rate": 4.2,
    "dead_stock_value": 8500,
    "avg_fulfillment_time_hours": 18
  }
}
```

---

#### GET /api/admin/analytics/summary/executive

Get executive overview with all key metrics combined.

**Response:**

```json
{
  "success": true,
  "data": {
    "financial": { ... },
    "customers": { ... },
    "operations": { ... },
    "alerts": { "critical": 2, "warning": 5 }
  }
}
```

---

### Financial Health Endpoints

#### GET /api/admin/analytics/pnl

Profit & Loss statement.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_date` | string | 1 year ago | Start date (YYYY-MM-DD) |
| `end_date` | string | today | End date (YYYY-MM-DD) |
| `granularity` | string | `monthly` | `daily` or `monthly` |

**Response:**

```json
{
  "success": true,
  "data": {
    "granularity": "monthly",
    "date_range": { "start": "...", "end": "..." },
    "periods": [
      {
        "period": "2024-01",
        "revenue": 15000,
        "cogs": 6000,
        "gross_profit": 9000,
        "gross_margin_pct": 60.0,
        "operating_expenses": 3000,
        "expenses_by_category": { "marketing": 1500, "operations": 1500 },
        "net_profit": 6000,
        "net_margin_pct": 40.0
      }
    ],
    "totals": {
      "revenue": 180000,
      "gross_profit": 108000,
      "operating_expenses": 36000,
      "net_profit": 72000
    }
  }
}
```

---

#### GET /api/admin/analytics/cashflow

Cash flow analysis with optional projections.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `months` | integer | 6 | Months of history |
| `projections` | boolean | false | Include 3-month forecast |

---

#### GET /api/admin/analytics/burn-runway

Burn rate and runway projections.

**Response:**

```json
{
  "success": true,
  "data": {
    "monthly_burn": 5000,
    "monthly_revenue": 15000,
    "net_burn": 500,
    "cash_balance": 50000,
    "runway_months": 100,
    "burn_trend": "positive"
  }
}
```

---

#### GET /api/admin/analytics/daily-revenue

Daily revenue metrics.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days` | integer | 30 | Days to include |

---

#### GET /api/admin/analytics/forecasts

Financial forecasts (30/60/90 day).

**Response:**

```json
{
  "success": true,
  "data": {
    "historical_average": 15000,
    "trend_per_month": 500,
    "forecasts": {
      "30_days": 15500,
      "60_days": 31500,
      "90_days": 48000
    },
    "confidence": "medium",
    "methodology": "linear_trend"
  }
}
```

---

#### POST /api/admin/analytics/expenses

Add expense record.

**Request Body:**

```json
{
  "category": "marketing",
  "amount": 500.00,
  "description": "Facebook ads",
  "date": "2024-01-15",
  "recurring": false,
  "recurring_frequency": null
}
```

---

#### GET /api/admin/analytics/expenses

Get expenses with filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `start_date` | string | Filter from date |
| `end_date` | string | Filter to date |
| `category` | string | Filter by category |
| `limit` | integer | Max results (default: 100) |

---

#### GET /api/admin/analytics/expense-categories

Get available expense categories.

---

### Customer Analytics Endpoints

#### GET /api/admin/analytics/customer-ltv

Customer Lifetime Value metrics.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `segment` | string | - | Customer segment filter |
| `sort_by` | string | `lifetime_value` | Sort field |
| `limit` | integer | 50 | Max results |

---

#### GET /api/admin/analytics/cac

Customer Acquisition Cost by channel.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `months` | integer | 3 | Period in months |
| `channel` | string | - | Filter by channel |

---

#### GET /api/admin/analytics/ltv-cac-ratio

LTV:CAC ratio analysis with health assessment.

**Response:**

```json
{
  "success": true,
  "data": {
    "ltv": 245.50,
    "cac": 35.00,
    "ratio": 7.01,
    "health": "excellent",
    "recommendation": "Healthy ratio - consider scaling acquisition"
  }
}
```

---

#### GET /api/admin/analytics/cohorts

Cohort analysis data for retention tracking.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `months` | integer | 6 | Number of cohorts |
| `metric` | string | `retention` | `retention` or `revenue` |

---

#### GET /api/admin/analytics/churn

Churn analysis with optional at-risk customer list.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `include_at_risk` | boolean | false | Include at-risk customer list |

---

#### GET /api/admin/analytics/customer-health

Customer health scores.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | - | `excellent`, `good`, `at_risk`, `critical` |
| `sort_by` | string | `health_score` | Sort field |
| `limit` | integer | 50 | Max results |

---

#### GET /api/admin/analytics/nps

NPS and customer feedback summary.

**Response:**

```json
{
  "success": true,
  "data": {
    "nps_score": 45,
    "total_responses": 150,
    "promoters": { "count": 90, "percentage": 60.0 },
    "passives": { "count": 30, "percentage": 20.0 },
    "detractors": { "count": 30, "percentage": 20.0 },
    "recent_comments": [...]
  }
}
```

---

#### POST /api/admin/analytics/feedback

Submit customer feedback record.

**Request Body:**

```json
{
  "user_id": "uuid",
  "order_id": "uuid",
  "feedback_type": "nps",
  "nps_score": 9,
  "comment": "Great service!",
  "tags": ["fast-delivery", "quality"]
}
```

---

#### GET /api/admin/analytics/repeat-purchase

Repeat purchase metrics.

---

### Marketing Analytics Endpoints

#### GET /api/admin/analytics/campaigns

Get marketing campaigns with performance metrics.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | `draft`, `active`, `paused`, `completed` |
| `channel` | string | Filter by channel |

---

#### POST /api/admin/analytics/campaigns

Create marketing campaign.

**Request Body:**

```json
{
  "name": "Summer Sale",
  "channel": "email",
  "budget": 1000,
  "start_date": "2024-01-15",
  "end_date": "2024-02-15",
  "target_audience": "repeat_customers",
  "goals": { "conversions": 100, "revenue": 5000 }
}
```

---

#### POST /api/admin/analytics/marketing-spend

Record marketing spend with performance data.

**Request Body:**

```json
{
  "campaign_id": "uuid",
  "channel": "facebook",
  "amount": 250.00,
  "date": "2024-01-15",
  "impressions": 50000,
  "clicks": 1200,
  "conversions": 45
}
```

---

#### GET /api/admin/analytics/channel-efficiency

Marketing channel ROI analysis.

**Response:**

```json
{
  "success": true,
  "data": {
    "channels": [
      {
        "channel": "email",
        "spend": 500,
        "revenue": 2500,
        "cpc": 0.42,
        "cpa": 11.11,
        "roas": 5.0,
        "efficiency_score": 500
      }
    ],
    "best_performing": "email",
    "total_spend": 2000,
    "total_revenue": 8000
  }
}
```

---

#### GET /api/admin/analytics/conversion-funnel

Conversion funnel metrics.

---

### Operational Analytics Endpoints

#### GET /api/admin/analytics/inventory-turnover

Inventory turnover metrics per product.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sort_by` | string | `turnover_rate` | Sort field |
| `limit` | integer | 50 | Max results |

---

#### GET /api/admin/analytics/dead-stock

Dead stock analysis (products with no sales).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `days_threshold` | integer | 90 | Days without sales |
| `min_value` | number | 0 | Minimum cost value |

---

#### GET /api/admin/analytics/stock-velocity

Stock velocity per SKU with reorder urgency.

**Response:**

```json
{
  "success": true,
  "data": {
    "products": [
      {
        "sku": "B131B",
        "name": "Brother LC131 Black",
        "current_stock": 45,
        "units_sold_30d": 30,
        "daily_velocity": 1.0,
        "days_of_stock": 45,
        "reorder_urgency": "low"
      }
    ],
    "summary": {
      "critical_reorder": 5,
      "high_reorder": 12,
      "avg_velocity": 0.75
    }
  }
}
```

---

#### GET /api/admin/analytics/inventory-cash-lockup

Inventory tied capital analysis by category.

---

#### GET /api/admin/analytics/product-performance

Product performance metrics (revenue, profit, margin).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sort_by` | string | `revenue` | `revenue`, `profit`, `margin`, `units` |
| `limit` | integer | 50 | Max results |
| `include_unprofitable` | boolean | false | Include negative margin products |

---

#### GET /api/admin/analytics/page-revenue

Page-level revenue contribution (estimated).

---

### Alerts & Thresholds Endpoints

#### GET /api/admin/analytics/alerts

Get active alerts.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `severity` | string | - | `critical`, `warning`, `info` |
| `acknowledged` | boolean | false | Filter by acknowledged status |

**Response:**

```json
{
  "success": true,
  "data": {
    "alerts": [
      {
        "id": "uuid",
        "alert_type": "low_stock",
        "severity": "critical",
        "title": "Low Stock Alert",
        "message": "5 products below critical threshold",
        "data": { "products": [...] },
        "acknowledged": false,
        "created_at": "2024-01-15T10:30:00Z"
      }
    ],
    "summary": {
      "total": 10,
      "critical": 2,
      "warning": 5,
      "info": 3
    }
  }
}
```

---

#### PUT /api/admin/analytics/alerts/:alertId/acknowledge

Acknowledge an alert.

---

#### GET /api/admin/analytics/alert-thresholds

Get alert threshold configuration.

---

#### PUT /api/admin/analytics/alert-thresholds/:thresholdId

Update alert threshold.

**Request Body:**

```json
{
  "threshold_value": 10,
  "severity": "warning",
  "is_enabled": true,
  "cooldown_hours": 24
}
```

---

## Error Handling

### Validation Errors (400)

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    { "field": "email", "message": "\"email\" must be a valid email" },
    { "field": "quantity", "message": "\"quantity\" must be greater than 0" }
  ]
}
```

### Authentication Errors (401)

```json
{
  "success": false,
  "error": "Missing authorization header"
}
```

```json
{
  "success": false,
  "error": "Invalid token"
}
```

### Authorization Errors (403)

```json
{
  "success": false,
  "error": "Admin access required"
}
```

```json
{
  "success": false,
  "error": "Email verification required",
  "code": "EMAIL_NOT_VERIFIED",
  "message": "Please verify your email address to access this resource"
}
```

### Not Found (404)

```json
{
  "success": false,
  "error": "Product not found"
}
```

### Conflict (409)

```json
{
  "success": false,
  "error": "Order already being processed. Please wait.",
  "code": "DUPLICATE_REQUEST"
}
```

### Stock/Availability Errors (400)

```json
{
  "success": false,
  "error": "Insufficient stock",
  "available": 3
}
```

```json
{
  "success": false,
  "error": "Stock validation failed",
  "details": [
    { "product_id": "uuid", "sku": "B131B", "available": 3, "requested": 10, "issue": "Insufficient stock" }
  ]
}
```

### Rate Limit (429)

```json
{
  "success": false,
  "error": "Too many requests. Please try again later."
}
```

### Server Errors (500)

```json
{
  "success": false,
  "error": "Internal server error"
}
```

In development, includes stack trace:

```json
{
  "success": false,
  "error": "Detailed error message",
  "stack": "Error: ...\n    at ..."
}
```

---

## Common Integration Patterns

### Authentication Flow

```javascript
// 1. User signs up/signs in via Supabase
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'password'
});

// 2. Get access token
const token = data.session.access_token;

// 3. Make authenticated API calls
const response = await fetch('/api/user/profile', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// 4. Merge guest cart after login
await fetch('/api/cart/merge', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});
```

### Checkout Flow

```javascript
// 1. Validate cart
const validation = await fetch('/api/cart/validate', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});

if (!validation.data.is_valid) {
  // Handle issues (stock, price changes, etc.)
}

// 2. Create order
const order = await fetch('/api/orders', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    items: cartItems,
    shipping_address: address,
    save_address: true
  })
});

// 3. Complete payment with Stripe
const stripe = await loadStripe('pk_...');
const { error } = await stripe.confirmPayment({
  clientSecret: order.data.client_secret,
  confirmParams: { return_url: 'https://yoursite.com/order/confirm' }
});

// 4. Redirect handles payment confirmation via webhook
```

### Guest Cart to Authenticated

```javascript
// Guest adds items (no auth header)
await fetch('/api/cart/items', {
  method: 'POST',
  body: JSON.stringify({ product_id: 'uuid', quantity: 1 })
});

// User logs in
const { data } = await supabase.auth.signInWithPassword({ ... });

// Merge guest cart
await fetch('/api/cart/merge', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${data.session.access_token}` }
});

// Guest cart is now merged with user cart
```

---

*Last Updated: 2026-02-07*
