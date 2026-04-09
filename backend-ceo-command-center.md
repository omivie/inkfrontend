# CEO Command Center — Backend Requirements

## Context

The frontend admin panel has been redesigned into a "CEO Command Center" — a data-dense, margin-first interface optimized for desktop power users. The frontend is on branch `feat/ceo-command-center` in the FEINK repo.

**What changed on the frontend:**
- 14 admin pages consolidated into 7 (tabbed sub-views)
- Margin % column added to product table (computed client-side from `cost_price` + `retail_price`)
- Source/Type badge column added (genuine/compatible/ribbon)
- Analytics page renamed to "Profit Center" — now has 7 tabs including Margins, Pricing, Market Intel
- Orders page now includes Refunds + Compliance tabs
- Products page now includes Ribbons + Needs Review tabs
- Customers page now includes Reviews + B2B Partners tabs
- Control Center trimmed to "Operations" (Inventory, SEO, Monitoring only)
- Data-dense layout baked in (smaller padding, no max-width cap, ultra-wide breakpoints)
- Command palette (Cmd+K), keyboard shortcuts

**What the frontend DOES NOT need from you yet:**
- The page consolidation is purely frontend routing/UI — no backend changes needed for that
- The margin column computes `((retail_price / 1.15 - cost_price) / (retail_price / 1.15)) * 100` client-side
- The source badge reads the existing `source` field on products

---

## Backend Work Needed

### Priority 1: Supplier Data Transparency

**Problem:** The frontend currently shows a single `source` field (genuine/compatible/ribbon) per product. CEOs need to see which supplier is "winning" for each product, compare supplier prices, and see supplier-specific SKUs.

**Required: `product_suppliers` table**

If this table doesn't already exist, create it:

```sql
CREATE TABLE product_suppliers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  supplier_name TEXT NOT NULL,          -- e.g. "DSNZ", "Augmento", "InkStation"
  supplier_sku TEXT,                     -- the supplier's own SKU for this product
  cost_price DECIMAL(10,2) NOT NULL,    -- supplier's cost price
  is_winning BOOLEAN DEFAULT false,     -- true = this is the active/"buy box" supplier
  is_active BOOLEAN DEFAULT true,       -- false = supplier discontinued this product
  last_synced_at TIMESTAMPTZ,           -- last time supplier feed was checked
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(product_id, supplier_name)
);

CREATE INDEX idx_product_suppliers_product ON product_suppliers(product_id);
CREATE INDEX idx_product_suppliers_winning ON product_suppliers(product_id) WHERE is_winning = true;
```

**Required: API endpoint**

```
GET /api/admin/products/:productId/suppliers
```

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "supplier_name": "DSNZ",
      "supplier_sku": "DSNZ-EP-T0631",
      "cost_price": 5.20,
      "is_winning": true,
      "is_active": true,
      "last_synced_at": "2026-04-08T12:00:00Z"
    },
    {
      "id": "uuid",
      "supplier_name": "Augmento",
      "supplier_sku": "AUG-631BK",
      "cost_price": 5.85,
      "is_winning": false,
      "is_active": true,
      "last_synced_at": "2026-04-08T11:30:00Z"
    }
  ]
}
```

**Frontend integration:** The product modal's "Supplier" tab will call this endpoint and display a comparison table showing all suppliers, their SKUs, prices, and which one is winning. The winning supplier gets a green badge.

**Buy box logic:** The backend should determine `is_winning` based on whatever logic you already use (lowest cost? preferred supplier? stock availability?). The frontend only displays it — it doesn't compute it.

---

### Priority 2: Margin Trend Sparklines

**Problem:** The product table shows a static margin % badge. CEOs want to see if margin is trending up or down over the last 30 days (supplier cost changes affect this).

**Required: API endpoint**

```
GET /api/admin/margin/trends?product_ids=uuid1,uuid2,...&days=30
```

Accept up to 200 product IDs (the current page size). Return a compact array of daily margin percentages.

Response:
```json
{
  "data": {
    "uuid1": [45.2, 45.2, 44.8, 44.8, 43.1, 43.1, ...],  // 30 values, one per day
    "uuid2": [22.0, 22.0, 22.0, 21.5, 21.5, ...],
  }
}
```

If you don't have historical cost_price snapshots, this could be derived from:
- A `cost_price_history` table (if it exists)
- Or supplier feed import logs
- Or just return `null` for products without history

**Frontend integration:** The product table will render a tiny 60x20px SVG sparkline next to each margin badge. Green line = improving, red = declining. No Chart.js needed — just a polyline SVG.

---

### Priority 3: Analytics Margin Distribution

**Problem:** The Profit Center's Products tab shows a simple "top products" table. CEOs want to see the distribution of products across margin tiers at a glance.

**Required: Extend existing RPC or new endpoint**

Option A — extend `analytics_kpi_summary` to include:
```json
{
  "margin_distribution": {
    "critical": 12,    // products with margin < 5%
    "warning": 45,     // 5-15%
    "healthy": 180,    // 15-30%
    "excellent": 320   // 30%+
  }
}
```

Option B — new endpoint:
```
GET /api/admin/margin/distribution
```

Response:
```json
{
  "data": {
    "critical": { "count": 12, "pct": 2.2 },
    "warning": { "count": 45, "pct": 8.1 },
    "healthy": { "count": 180, "pct": 32.3 },
    "excellent": { "count": 320, "pct": 57.4 }
  }
}
```

Margin calculation: `((retail_price / 1.15 - cost_price) / (retail_price / 1.15)) * 100`
- Critical: < 5%
- Warning: 5-15%
- Healthy: 15-30%
- Excellent: 30%+

Only count products where both `retail_price` and `cost_price` are not null and `cost_price > 0`.

**Frontend integration:** Rendered as a horizontal stacked bar chart in the Profit Center's Products tab with red/yellow/cyan/green segments.

---

## Existing Endpoints the Frontend Already Uses

These are working and don't need changes. Listed for reference so you know what's already wired up:

### Products & SKUs
- `GET /api/admin/products` — paginated product list with filters
- `GET /api/admin/products/:id` — single product detail
- `PUT /api/admin/products/:id` — update product
- `POST /api/admin/products` — create product
- `PUT /api/admin/products/:id/import-lock` — toggle import lock
- `GET /api/admin/product-diagnostics` — product health stats

### Margin & Pricing
- `GET /api/admin/margin/summary` — margin overview KPIs
- `GET /api/admin/margin/recommended-prices` — price recommendations
- `GET /api/admin/margin/price-changes` — supplier cost changes
- `GET /api/admin/margin/out-of-stock` — OOS products
- `GET /api/admin/margin/top-profit` — highest profit products
- `GET /api/admin/pricing/heatmap` — pricing health heatmap
- `GET /api/admin/pricing/under-margin` — products below margin threshold
- `GET /api/admin/pricing/global-offset` — global price offset
- `GET /api/admin/pricing/tier-multipliers` — B2B tier pricing

### Analytics (Supabase RPCs)
- `analytics_kpi_summary` — revenue, AOV, volatility, refund rate, etc.
- `analytics_revenue_series` — daily revenue with anomaly detection
- `analytics_brand_breakdown` — revenue/orders by brand
- `analytics_customer_stats` — new/returning customers
- `analytics_top_products` — top products by revenue
- `analytics_refunds_series` — refund rate + reasons

### Suppliers
- `GET /api/admin/supplier/import-status` — cron job status
- `GET /api/admin/supplier/price-discrepancies` — price mismatches
- `POST /api/admin/supplier/trigger-reconcile` — manual reconcile

### Orders
- `GET /api/admin/orders` — paginated order list
- `PUT /api/admin/orders/:id/status` — update order status
- `POST /api/admin/orders` — create order
- `DELETE /api/admin/orders/:id` — delete order

### Refunds
- `GET /api/admin/refunds` — paginated refund list
- `POST /api/admin/refunds` — create refund
- `PUT /api/admin/refunds/:id/status` — update refund status

### Customers
- `GET /api/admin/customers` — paginated customer list

### Reviews
- `GET /api/admin/reviews` — paginated review list with status filter
- `PUT /api/admin/reviews/:id` — update review status

### B2B
- `GET /api/admin/b2b/applications` — business applications
- `GET /api/admin/b2b/invoices` — B2B invoices

### Export
- `GET /api/admin/export/:type?format=csv|excel|pdf|json` — data export

---

## Frontend File Reference

Key files if you need to see how the frontend calls your endpoints:

- **API client:** `inkcartridges/js/admin/api.js` — all `AdminAPI` methods
- **Products page:** `inkcartridges/js/admin/pages/products.js` — product table, modal, filters
- **Profit Center:** `inkcartridges/js/admin/pages/analytics.js` — 7-tab analytics view
- **Margin Analysis:** `inkcartridges/js/admin/pages/margin.js` — margin sub-tabs
- **CC Profit:** `inkcartridges/js/admin/pages/cc-profit.js` — pricing heatmap, under-margin

---

## Summary of What to Build

| # | What | Endpoint | Effort | Depends On |
|---|------|----------|--------|------------|
| 1 | `product_suppliers` table | Migration | Medium | Nothing |
| 2 | Supplier alternatives API | `GET /api/admin/products/:id/suppliers` | Small | #1 |
| 3 | Populate supplier data | Extend import cron to write to `product_suppliers` | Medium | #1 |
| 4 | Margin trends API | `GET /api/admin/margin/trends` | Medium | Cost history data |
| 5 | Margin distribution | Extend KPI RPC or new endpoint | Small | Nothing |

Items 1-3 are the highest priority — they enable the "Supplier Data Transparency" feature that's core to the CEO Command Center vision. Items 4-5 are enhancements.
