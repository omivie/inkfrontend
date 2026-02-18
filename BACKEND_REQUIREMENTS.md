# Backend Requirements — InkCartridges.co.nz
> **Consolidated**: 2026-02-19 | All backend work needed for the frontend to be fully functional.
> **Backend repo**: https://ink-backend-zaeq.onrender.com
> **Frontend origin**: http://localhost:3000 (dev) / https://inkcartridges.co.nz (prod)

---

## Table of Contents

1. [Bug Fixes (Immediate)](#1-bug-fixes-immediate)
2. [Shipping — Zone-Based Rates](#2-shipping--zone-based-rates)
3. [Order Enhancements](#3-order-enhancements)
4. [Admin Dashboard Analytics](#4-admin-dashboard-analytics)
5. [Conversion & Revenue Features](#5-conversion--revenue-features)
6. [SEO & Discovery](#6-seo--discovery)
7. [Customer Retention Features](#7-customer-retention-features)
8. [Analytics Endpoint Specs](#8-analytics-endpoint-specs)
9. [Data Issues](#9-data-issues)

---

## 1. Bug Fixes (Immediate)

### BF-001: POST /api/analytics/cart-event returns 400
- **Endpoint**: `POST /api/analytics/cart-event`
- **Symptom**: Returns 400 on every cart page load
- **Payload**: `{ "event_type": "cart_viewed", "session_id": "cs_<timestamp>_<random>" }`
- **Cause**: The Joi `cartAnalyticsEventSchema` likely doesn't include `cart_viewed`, `checkout_started`, or `checkout_completed` as valid `event_type` values.
- **Fix**: Add `cart_viewed`, `checkout_started`, `checkout_completed` to the allowed `event_type` enum in the schema validator, or confirm which event types are accepted so we can update the frontend.

### BF-002: POST /api/newsletter/subscribe returns 500 intermittently
- **Endpoint**: `POST /api/newsletter/subscribe`
- **Payload**: `{ "email": "...", "source": "landing" }`
- **Symptom**: Intermittent 500 errors — works when backend is warm
- **Likely cause**: Render free-tier cold start or transient error
- **Priority**: Low — may resolve with Render plan upgrade

### BF-003: GET /api/admin/analytics/overview returns 404
- **Endpoint**: `GET /api/admin/analytics/overview?days=7`
- **Called by**: `admin.js:hydrateAnalytics()` via `API.getAdminAnalyticsOverview()`
- **Fix**: Implement the endpoint (see Section 4 for response shape)

### BF-004: GET /api/admin/analytics/summary/executive returns 404
- **Endpoint**: `GET /api/admin/analytics/summary/executive`
- **Called by**: `admin.js:hydrateAnalytics()` via `AnalyticsAPI.getExecutiveDashboard()`
- **Fix**: Implement the endpoint (see Section 4 for response shape)

### BF-005: Product brand field returned as object instead of string
- **Endpoint**: `GET /api/admin/products`
- **Symptom**: `product.brand` is `{ id: ..., name: "..." }` instead of a string
- **Frontend workaround**: Added `getBrandName()` helper to extract string
- **Fix**: Consider normalizing brand to a string in the API response, or document the object shape as intentional

---

## 2. Shipping — Zone-Based Rates

The frontend now sends `shipping_tier` and `shipping_zone` in the order payload and displays zone-based shipping costs and ETAs. **The backend MUST recalculate shipping server-side — frontend values are display-only hints.**

### Zone-Based Rate Table

| Zone | Standard Fee | Heavy Fee (+$4 surcharge) | ETA |
|------|-------------|---------------------------|-----|
| **Auckland** | $7.95 | $11.95 | 1-2 business days |
| **North Island** | $9.95 | $13.95 | 1-3 business days |
| **South Island** | $13.95 | $17.95 | 2-4 business days |

### Rules (in priority order)
1. **Free shipping**: subtotal >= $100 NZD — always wins, even for heavy items
2. **Heavy shipping**: zone standard + $4.00 if order has drum products OR toner quantity >= 3
3. **Standard**: zone rate as default

### Heavy Item Detection
- **Drum products**: `category = 'drum'` or product name contains "drum" (case-insensitive)
- **Bulk toner**: Sum of quantities where `category = 'toner'` or name contains "toner" — if >= 3, qualifies as heavy

### Region to Zone Mapping

| Zone | Regions |
|------|---------|
| `auckland` | `auckland` |
| `north-island` | `northland`, `waikato`, `bay-of-plenty`, `gisborne`, `hawkes-bay`, `taranaki`, `manawatu-wanganui`, `wellington` |
| `south-island` | `tasman`, `nelson`, `marlborough`, `west-coast`, `canterbury`, `otago`, `southland` |

### Updated Order Payload

Frontend now sends these additional fields in `POST /api/orders`:

```json
{
  "shipping_tier": "standard",
  "shipping_zone": "auckland"
}
```

`shipping_tier` values: `"free"` | `"standard"` | `"heavy"`
`shipping_zone` values: `"auckland"` | `"north-island"` | `"south-island"`

> **IMPORTANT**: Do NOT trust frontend values. Recalculate server-side from shipping address region.

### Backend Pseudocode

```python
ZONE_FEES = {
    'auckland':     { 'standard': 7.95,  'heavy': 11.95 },
    'north-island': { 'standard': 9.95,  'heavy': 13.95 },
    'south-island': { 'standard': 13.95, 'heavy': 17.95 },
}

REGION_TO_ZONE = {
    'auckland': 'auckland',
    'northland': 'north-island', 'waikato': 'north-island',
    'bay-of-plenty': 'north-island', 'gisborne': 'north-island',
    'hawkes-bay': 'north-island', 'taranaki': 'north-island',
    'manawatu-wanganui': 'north-island', 'wellington': 'north-island',
    'tasman': 'south-island', 'nelson': 'south-island',
    'marlborough': 'south-island', 'west-coast': 'south-island',
    'canterbury': 'south-island', 'otago': 'south-island',
    'southland': 'south-island',
}

def calculate_shipping(order_items, subtotal, shipping_region):
    zone = REGION_TO_ZONE.get(shipping_region.lower(), 'north-island')
    fees = ZONE_FEES[zone]

    if subtotal >= 100.00:
        return { 'tier': 'free', 'fee': 0.00, 'zone': zone }

    has_drum = any(
        item.product.category == 'drum' or 'drum' in item.product.name.lower()
        for item in order_items
    )
    toner_qty = sum(
        item.quantity for item in order_items
        if item.product.category == 'toner' or 'toner' in item.product.name.lower()
    )

    if has_drum or toner_qty >= 3:
        return { 'tier': 'heavy', 'fee': fees['heavy'], 'zone': zone }

    return { 'tier': 'standard', 'fee': fees['standard'], 'zone': zone }
```

### Database Schema Addition

Add these columns to the `orders` table:

| Column | Type | Description |
|--------|------|-------------|
| `shipping_tier` | `varchar(20)` | `'free'`, `'standard'`, `'heavy'` |
| `shipping_fee` | `decimal(10,2)` | Actual shipping cost charged |
| `delivery_zone` | `varchar(20)` | `'auckland'`, `'north-island'`, `'south-island'` |
| `estimated_delivery_days_min` | `integer` | Min delivery days (1, 1, or 2) |
| `estimated_delivery_days_max` | `integer` | Max delivery days (2, 3, or 4) |

### Endpoint Changes

**`POST /api/orders`** — Accept `shipping_tier` and `shipping_zone` (optional, for logging). Recalculate shipping server-side. Include in order total and Stripe PaymentIntent amount. Store tier, fee, zone on order record.

**`GET /api/shipping/rates`** — Update to return zone-based rates:

```json
{
  "success": true,
  "data": {
    "free_threshold": 100,
    "heavy_surcharge": 4.00,
    "currency": "NZD",
    "zones": {
      "auckland": { "label": "Auckland", "standard": 7.95, "heavy": 11.95, "eta_min": 1, "eta_max": 2 },
      "north-island": { "label": "North Island", "standard": 9.95, "heavy": 13.95, "eta_min": 1, "eta_max": 3 },
      "south-island": { "label": "South Island", "standard": 13.95, "heavy": 17.95, "eta_min": 2, "eta_max": 4 }
    },
    "heavy_criteria": { "drum": true, "toner_qty_threshold": 3 }
  }
}
```

**`POST /api/shipping/options`** — Calculate for specific cart:

```json
// Request
{ "cart_total": 85.50, "items": [{ "product_id": "uuid", "quantity": 2 }], "region": "canterbury" }

// Response
{
  "success": true,
  "data": {
    "tier": "standard", "fee": 13.95, "zone": "south-island",
    "zone_label": "South Island", "eta": "2-4 business days",
    "free_threshold": 100, "spend_more_for_free": 14.50
  }
}
```

**`GET /api/settings`** — Add shipping config to existing response:

```json
{
  "FREE_SHIPPING_THRESHOLD": 100,
  "SHIPPING_FEE_AUCKLAND": 7.95,
  "SHIPPING_FEE_NORTH_ISLAND": 9.95,
  "SHIPPING_FEE_SOUTH_ISLAND": 13.95,
  "HEAVY_SURCHARGE": 4.00
}
```

---

## 3. Order Enhancements

### 3.1 Order Line Items on GET /api/admin/orders

**Problem**: Admin dashboard recent orders and order drawer show `--` for items because `GET /api/admin/orders` doesn't include line items.

**What's needed**: Include an `items[]` array on each order object:

```json
{
  "product_name": "Brother TN-2450 Toner",
  "quantity": 2,
  "price": 45.00,
  "line_total": 90.00,
  "sku": "TN-2450"
}
```

### 3.2 Order Line Items on GET /api/orders (User-Facing)

**Problem**: Account dashboard "Quick Reorder" card can't show product details without line items.

**What's needed**: Include `items[]` on each order in user orders response:

| Field | Type | Used by |
|-------|------|---------|
| `items[].product_name` | string | Quick Reorder card display |
| `items[].product_slug` | string | "Buy Again" link to product page |
| `items[].image_url` | string | Product thumbnail (48x48) |

**Graceful degradation**: Frontend handles missing items — shows "Order #123" fallback instead of product details.

### 3.3 Customer Phone on Admin Orders

**What's needed**: `shipping_phone` field on order objects from `GET /api/admin/orders`.

Frontend only renders phone if it exists — no breaking change.

### 3.4 Tracking URL and Estimated Delivery

**What's needed on `GET /api/orders`**:

| Field | Type | Description |
|-------|------|-------------|
| `estimated_delivery` | ISO date string | e.g. "2026-02-21". Falls back to order date if missing. |
| `tracking_url` | string | External tracking link (NZ Post). Falls back to internal order detail. |

---

## 4. Admin Dashboard Analytics

The admin dashboard KPI strip and analytics tabs call these endpoints. Most return 404 because they're unimplemented.

### 4.1 Executive Dashboard Summary (HIGH PRIORITY)

**Endpoint**: `GET /api/admin/analytics/summary/executive`
**Query params**: `?timeRange=7` (days)

**Response**:
```json
{
  "success": true,
  "data": {
    "grossProfit": 12500.00,
    "netProfit": 8200.00,
    "refundRate": 2.3,
    "avgFulfilmentTime": 1.8,
    "revenueSparkline": [120, 180, 150, 200, 190, 220, 210],
    "ordersSparkline": [5, 8, 6, 9, 7, 10, 8],
    "revenueTrend": { "direction": "up", "change": "12.5" },
    "ordersTrend": { "direction": "up", "change": "8.2" }
  }
}
```

Without this, KPIs for Gross Profit, Net Profit, Refund Rate, and Fulfilment Time show `--`.

### 4.2 Top Products by Quantity Sold

**Endpoint**: `GET /api/admin/analytics/top-products?metric=quantity&limit=8`

**What's needed**: Return products with a `units_sold` field representing total units sold in the selected period.

**Current workaround**: Frontend sorts by `retail_price` DESC (most expensive, not most sold).

### 4.3 Top Products by Revenue

**Endpoint**: `GET /api/admin/analytics/top-products?metric=revenue&limit=8`

**What's needed**: Return products with a `total_revenue` field representing total revenue in the selected period.

**Current workaround**: Same price-based fallback sort.

### 4.4 Conversion Funnel

**Endpoint**: `GET /api/admin/analytics/conversion-funnel`
**Query params**: `?days=30`

**Response**:
```json
{
  "success": true,
  "data": {
    "steps": [
      { "label": "Visitors", "count": 12500, "percentage": 100 },
      { "label": "Product Views", "count": 7500, "percentage": 60 },
      { "label": "Add to Cart", "count": 3125, "percentage": 25 },
      { "label": "Checkout", "count": 1250, "percentage": 10 },
      { "label": "Purchase", "count": 625, "percentage": 5 }
    ]
  }
}
```

**Current workaround**: Placeholder bars with `--` values; purchase step shows real order count.

### 4.5 Analytics Overview

**Endpoint**: `GET /api/admin/analytics/overview`
**Query params**: `?days=7` (or `timeRange=7`)

**Response** (same data as executive but used by a different code path):
```json
{
  "success": true,
  "data": {
    "grossProfit": 12500.00,
    "netProfit": 8200.00,
    "refundRate": 2.3,
    "avgFulfilmentTime": 1.8,
    "revenueSparkline": [120, 180, 150, 200, 190, 220, 210],
    "ordersSparkline": [5, 8, 6, 9, 7, 10, 8],
    "revenueTrend": { "direction": "up", "change": "12.5" },
    "ordersTrend": { "direction": "up", "change": "8.2" }
  }
}
```

---

## 5. Conversion & Revenue Features

### 5.1 Purchase Event Tracking (Server-Side)

**Why**: Revenue attribution needs a trusted backend event, not just a frontend `page_view`.

**What's needed**: After successful payment, push a `purchase` event with `order_id`, `total`, `currency: NZD`, `items[]` to analytics (GA4 Measurement Protocol or server-side GTM).

### 5.2 Abandoned Cart Recovery

**Why**: Cart abandonment is 60-80% in e-commerce. Email recovery recovers 5-15%.

**What's needed**:
- Endpoint to save cart state: `POST /api/cart/save` with `{ user_id, items[] }`
- Scheduled job: If cart hasn't converted in 1h / 24h / 72h, trigger recovery email
- Email template with cart contents + "Complete Your Order" CTA

### 5.3 Email/Newsletter Capture

**Why**: Newsletter signup drives repeat purchases.

**What's needed**: `POST /api/newsletter/subscribe` accepting `{ email }` with validation and duplicate handling. Consider Mailchimp/Brevo integration.

**Note**: This endpoint may already exist (see BF-002 above) but has intermittent 500 errors.

---

## 6. SEO & Discovery

### 6.1 Sitemap.xml

**What's needed**: Auto-generated `/sitemap.xml` including:
- All static pages
- All product detail pages
- `<lastmod>` dates from product update timestamps
- `<changefreq>` and `<priority>` values

**Note**: `seo.js` route file exists in the backend — verify it's working correctly.

### 6.2 Robots.txt

**What's needed**: `/robots.txt` with:
```
User-agent: *
Allow: /
Disallow: /html/admin/
Disallow: /html/account/
Sitemap: https://inkcartridges.co.nz/sitemap.xml
```

**Note**: `seo.js` route file exists — verify it serves this correctly.

---

## 7. Customer Retention Features

### 7.1 Product Reviews

**Why**: Social proof increases conversion by 15-30%.

**What's needed**:
- `POST /api/reviews` — submit review (post-purchase, authenticated)
- `GET /api/products/:id/reviews` — fetch reviews for display
- Review moderation in admin panel
- Post-purchase email trigger (7 days after delivery)

**Note**: `reviews.js` route file exists in the backend — verify implementation status.

### 7.2 Reorder Reminders

**Why**: Order confirmation has a "Save My Printer" CTA but no backend support.

**What's needed**:
- `POST /api/users/:id/printers` — save printer model association (may already exist as `POST /api/user/printer`)
- Estimated ink life calculation (cartridge yield + avg usage)
- Scheduled "Time to reorder?" email with one-click reorder link

### 7.3 Wishlist/Favourites Sync

**Current state**: Favourites endpoints exist (`GET/POST /api/user/favourites`, `POST /api/user/favourites/sync`).

**Nice-to-have**: Price drop notification emails when a wishlisted item goes on sale.

---

## 8. Analytics Endpoint Specs

The frontend (`analytics-api.js`) defines 30+ analytics endpoints. Below are the detailed response shapes needed.

### 8.1 Financial Analytics

#### `GET /api/admin/analytics/pnl`
**Params**: `?start_date=2026-01-01&end_date=2026-02-18&granularity=monthly`
```json
{
  "success": true,
  "data": {
    "periods": [
      { "period": "2026-01", "revenue": 45000, "cogs": 27000, "grossProfit": 18000, "expenses": 5000, "netProfit": 13000 }
    ],
    "summary": { "totalRevenue": 45000, "totalCOGS": 27000, "grossMargin": 0.4, "netMargin": 0.29 }
  }
}
```

#### `GET /api/admin/analytics/cashflow`
**Params**: `?months=12&projections=true`
```json
{
  "success": true,
  "data": {
    "months": [
      { "month": "2026-01", "inflow": 45000, "outflow": 32000, "net": 13000, "balance": 58000 }
    ],
    "projections": [
      { "month": "2026-03", "inflow": 48000, "outflow": 33000, "net": 15000, "balance": 73000 }
    ]
  }
}
```

#### `GET /api/admin/analytics/daily-revenue`
**Params**: `?days=30`
```json
{
  "success": true,
  "data": {
    "days": [
      { "date": "2026-02-17", "revenue": 1500, "orders": 8, "aov": 187.50 }
    ]
  }
}
```

#### `GET /api/admin/analytics/burn-runway`
Burn rate and runway projections.

#### `GET /api/admin/analytics/forecasts`
Financial forecasts (30/60/90 day).

#### `POST /api/admin/analytics/expenses` / `GET /api/admin/analytics/expenses`
Add and retrieve expense records.

#### `GET /api/admin/analytics/expense-categories`
Get expense category definitions.

### 8.2 Customer Analytics

#### `GET /api/admin/analytics/customer-ltv`
**Params**: `?segment=all`
```json
{
  "success": true,
  "data": {
    "averageLTV": 285.50,
    "medianLTV": 195.00,
    "distribution": [
      { "bucket": "0-100", "count": 45 },
      { "bucket": "100-300", "count": 80 },
      { "bucket": "300-500", "count": 35 },
      { "bucket": "500+", "count": 15 }
    ]
  }
}
```

#### `GET /api/admin/analytics/cohorts`
**Params**: `?months=6`
```json
{
  "success": true,
  "data": {
    "cohorts": [
      { "month": "2025-09", "initialSize": 50, "retention": [100, 42, 28, 20, 16, 14] }
    ]
  }
}
```

#### `GET /api/admin/analytics/churn`
```json
{
  "success": true,
  "data": {
    "currentChurnRate": 8.5,
    "trend": [9.2, 8.8, 8.5],
    "atRiskCustomers": [
      { "id": "uuid", "name": "John Doe", "email": "john@example.com", "lastOrder": "2025-11-15", "totalSpent": 450 }
    ]
  }
}
```

#### `GET /api/admin/analytics/cac`
Customer Acquisition Cost by channel.

#### `GET /api/admin/analytics/ltv-cac-ratio`
LTV:CAC ratio analysis.

#### `GET /api/admin/analytics/customer-health`
Customer health scores.

#### `GET /api/admin/analytics/nps`
NPS and customer feedback summary.

#### `POST /api/admin/analytics/feedback`
Submit customer feedback.

#### `GET /api/admin/analytics/repeat-purchase`
Repeat purchase metrics.

### 8.3 Inventory Analytics

#### `GET /api/admin/analytics/inventory-turnover`
```json
{
  "success": true,
  "data": {
    "overallTurnover": 4.2,
    "byCategory": [
      { "category": "ink-cartridges", "turnover": 5.1 },
      { "category": "toner", "turnover": 3.8 }
    ]
  }
}
```

#### `GET /api/admin/analytics/dead-stock`
```json
{
  "success": true,
  "data": {
    "totalDeadStock": 12,
    "totalValue": 3400,
    "products": [
      { "sku": "EP-T0631", "name": "Epson T0631 Black", "stock": 25, "lastSold": "2025-10-15", "value": 450 }
    ]
  }
}
```

#### `GET /api/admin/analytics/stock-velocity`
```json
{
  "success": true,
  "data": {
    "products": [
      { "sku": "HP-950XL", "name": "HP 950XL Black", "velocity": 12.5, "daysOfStock": 8, "reorderSuggested": true }
    ]
  }
}
```

#### `GET /api/admin/analytics/inventory-cash-lockup`
Inventory tied capital analysis.

#### `GET /api/admin/analytics/product-performance`
Product performance metrics.

#### `GET /api/admin/analytics/page-revenue`
Page-level revenue contribution.

### 8.4 Marketing Analytics

#### `GET /api/admin/analytics/campaigns` / `POST /api/admin/analytics/campaigns`
Campaign performance and creation.

#### `POST /api/admin/analytics/marketing-spend`
Record marketing spend.

#### `GET /api/admin/analytics/channel-efficiency`
Marketing channel ROI analysis.

### 8.5 Dashboard Summaries

#### `GET /api/admin/analytics/summary/financial`
Financial health dashboard summary.

#### `GET /api/admin/analytics/summary/customers`
Customer intelligence dashboard summary.

#### `GET /api/admin/analytics/summary/operations`
Operations intelligence dashboard summary.

### 8.6 Alerts

#### `GET /api/admin/analytics/alerts`
Get active alerts.

#### `PUT /api/admin/analytics/alerts/:alertId/acknowledge`
Acknowledge an alert.

#### `GET /api/admin/analytics/alert-thresholds` / `PUT /api/admin/analytics/alert-thresholds/:thresholdId`
Get and update alert threshold configuration.

---

## 9. Data Issues

### 9.1 Cost Price is Mostly NULL

**Problem**: `cost_price` on product objects from `GET /api/admin/products` is mostly `null`.

**Impact**: Blocks gross profit calculations, margin analysis, and profit-based product rankings in the admin dashboard.

**Required**: Populate `cost_price` for all products in the database. The import scripts (`genuine.js`, `compatible.js`) calculate prices from cost — ensure `cost_price` is stored during import.

---

## Implementation Priority

| Priority | Items | Impact |
|----------|-------|--------|
| **P0 — Fix Now** | BF-001 (cart-event 400), BF-005 (brand object) | Errors on every page load |
| **P1 — High** | Order line items (3.1, 3.2), Executive dashboard (4.1), Shipping zones (2) | Core admin + checkout functionality |
| **P2 — Medium** | Top products (4.2, 4.3), Conversion funnel (4.4), Cost price (9.1), Tracking URL (3.4) | Dashboard completeness |
| **P3 — Revenue** | Purchase tracking (5.1), Abandoned cart (5.2), Reviews (7.1) | Conversion optimization |
| **P4 — Nice-to-have** | All 30+ analytics endpoints (8.x), Alerts (8.6), Reorder reminders (7.2) | Advanced analytics |

---

## Notes

- All endpoints require `Authorization: Bearer <supabase-jwt-token>` unless marked public
- All responses follow `{ "success": true/false, "data": {...}, "error": "..." }` envelope
- Currency is NZD, all prices include 15% GST
- Frontend gracefully handles all missing endpoints (try/catch with `--` fallback rendering)
- The frontend NEVER computes prices — backend is always the source of truth

*Consolidated from: BACKEND_HANDOFF.md, BACKEND_TODO.md, BACKEND_SHIPPING_HANDOFF.md, BACKEND_ADMIN_GAPS.md, BACKEND_REQUIRED_CHANGES.md, backend-fixes.md, backend_dashboard_requirements.md*
