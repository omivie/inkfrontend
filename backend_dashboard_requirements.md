# Backend Dashboard Requirements

The admin dashboard frontend calls these analytics endpoints via `analytics-api.js`. Most do not yet exist on the backend. Each endpoint requires admin authentication (Bearer token from Supabase).

## Priority 1: Executive Dashboard KPIs

### `GET /api/admin/analytics/summary/executive`
Returns KPI data for the dashboard strip.

**Query params:** `?timeRange=7` (days)

**Response:**
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

## Priority 2: Financial Analytics

### `GET /api/admin/analytics/pnl`
Profit & Loss statement.

**Query params:** `?start_date=2026-01-01&end_date=2026-02-18&granularity=monthly`

**Response:**
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

### `GET /api/admin/analytics/cashflow`
Cash flow analysis.

**Query params:** `?months=12&projections=true`

**Response:**
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

### `GET /api/admin/analytics/daily-revenue`
Daily revenue for charting.

**Query params:** `?days=30`

**Response:**
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

## Priority 3: Customer Analytics

### `GET /api/admin/analytics/customer-ltv`
Customer lifetime value distribution.

**Query params:** `?segment=all`

**Response:**
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

### `GET /api/admin/analytics/cohorts`
Cohort retention analysis.

**Query params:** `?months=6`

**Response:**
```json
{
  "success": true,
  "data": {
    "cohorts": [
      {
        "month": "2025-09",
        "initialSize": 50,
        "retention": [100, 42, 28, 20, 16, 14]
      }
    ]
  }
}
```

### `GET /api/admin/analytics/churn`
Churn analysis.

**Response:**
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

## Priority 4: Inventory Analytics

### `GET /api/admin/analytics/inventory-turnover`
Inventory turnover rate.

**Response:**
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

### `GET /api/admin/analytics/dead-stock`
Products with no sales in 90+ days.

**Response:**
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

### `GET /api/admin/analytics/stock-velocity`
Sales velocity per product.

**Response:**
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

## Priority 5: Conversion & Marketing

### `GET /api/admin/analytics/conversion-funnel`
Conversion funnel metrics.

**Query params:** `?days=30`

**Response:**
```json
{
  "success": true,
  "data": {
    "visitors": 12500,
    "productViews": 7500,
    "addToCart": 3100,
    "checkout": 1250,
    "purchase": 620,
    "rates": {
      "viewRate": 60.0,
      "cartRate": 41.3,
      "checkoutRate": 40.3,
      "purchaseRate": 49.6
    }
  }
}
```

## Notes

- All endpoints require `Authorization: Bearer <token>` header
- All endpoints should return `{ "success": false, "error": "message" }` on failure
- Time-based endpoints should accept `timeRange` or `days` query params
- Data should be computed server-side from the orders, products, and users tables
- Until these endpoints exist, the frontend gracefully degrades (shows `--` for missing data)
