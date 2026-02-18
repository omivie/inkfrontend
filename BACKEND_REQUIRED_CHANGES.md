# Backend Required Changes

> **Updated**: 2026-02-07
> **Status**: Endpoints verified against `BACKEND_FOR_FRONTEND (2).md`

This document lists backend endpoints that the frontend uses but are **NOT documented** in the current API contract.

---

## Summary

| Priority | Category | Count |
|----------|----------|-------|
| — | All categories | 0 |

**Total Missing Endpoints: 0**

All previously missing endpoints are now documented in `BACKEND_FOR_FRONTEND (2).md`.

---

## Resolved (Now Documented)

The following endpoints were previously missing but are now documented in the API contract:

### General Endpoints
- `GET /api/settings` - Frontend configuration
- `PUT /api/user/printers/:printerId` - Update saved printer nickname
- `GET /api/admin/customers` - List customers with stats
- `POST /api/analytics/cart-event` - Track cart events
- `GET /api/analytics/cart-summary` - Cart analytics (admin)
- `GET /api/analytics/abandoned-carts` - Abandoned cart details (admin)
- `GET /api/analytics/marketing` - Marketing metrics (admin)
- `GET /api/shipping/rates` - Public shipping rates
- `POST /api/shipping/options` - Personalized shipping options
- `POST /api/business/apply` - Business account application
- `GET /api/business/status` - Business account status
- Chatbot endpoints (`POST /api/chat`, `DELETE /api/chat/session/:id`, `GET /api/chat/health`)

### Admin Analytics - Dashboard Summaries (4 endpoints)
- `GET /api/admin/analytics/summary/financial` - Financial health dashboard summary
- `GET /api/admin/analytics/summary/customers` - Customer intelligence dashboard summary
- `GET /api/admin/analytics/summary/operations` - Operations intelligence dashboard summary
- `GET /api/admin/analytics/summary/executive` - Executive overview with all key metrics

### Admin Analytics - Financial Health (8 endpoints)
- `GET /api/admin/analytics/pnl` - Profit & Loss statement
- `GET /api/admin/analytics/cashflow` - Cash flow analysis
- `GET /api/admin/analytics/burn-runway` - Burn rate and runway projections
- `GET /api/admin/analytics/daily-revenue` - Daily revenue metrics
- `GET /api/admin/analytics/forecasts` - Financial forecasts (30/60/90 day)
- `POST /api/admin/analytics/expenses` - Add expense record
- `GET /api/admin/analytics/expenses` - Get expenses with filters
- `GET /api/admin/analytics/expense-categories` - Get expense categories list

### Admin Analytics - Customer Intelligence (9 endpoints)
- `GET /api/admin/analytics/customer-ltv` - Customer Lifetime Value metrics
- `GET /api/admin/analytics/cac` - Customer Acquisition Cost by channel
- `GET /api/admin/analytics/ltv-cac-ratio` - LTV:CAC ratio analysis
- `GET /api/admin/analytics/cohorts` - Cohort analysis data
- `GET /api/admin/analytics/churn` - Churn analysis
- `GET /api/admin/analytics/customer-health` - Customer health scores
- `GET /api/admin/analytics/nps` - NPS and customer feedback summary
- `POST /api/admin/analytics/feedback` - Submit customer feedback
- `GET /api/admin/analytics/repeat-purchase` - Repeat purchase metrics

### Admin Analytics - Marketing (5 endpoints)
- `GET /api/admin/analytics/campaigns` - Marketing campaign performance
- `POST /api/admin/analytics/campaigns` - Create marketing campaign
- `POST /api/admin/analytics/marketing-spend` - Record marketing spend
- `GET /api/admin/analytics/channel-efficiency` - Marketing channel ROI analysis
- `GET /api/admin/analytics/conversion-funnel` - Conversion funnel metrics

### Admin Analytics - Operations (6 endpoints)
- `GET /api/admin/analytics/inventory-turnover` - Inventory turnover metrics
- `GET /api/admin/analytics/dead-stock` - Dead stock analysis
- `GET /api/admin/analytics/stock-velocity` - Stock velocity per SKU
- `GET /api/admin/analytics/inventory-cash-lockup` - Inventory tied capital analysis
- `GET /api/admin/analytics/product-performance` - Product performance metrics
- `GET /api/admin/analytics/page-revenue` - Page-level revenue contribution

### Admin Analytics - Alerts & Thresholds (4 endpoints)
- `GET /api/admin/analytics/alerts` - Get active alerts
- `PUT /api/admin/analytics/alerts/:alertId/acknowledge` - Acknowledge an alert
- `GET /api/admin/analytics/alert-thresholds` - Get alert threshold configuration
- `PUT /api/admin/analytics/alert-thresholds/:thresholdId` - Update alert threshold

---

## Frontend Files Affected

| File | Dependency | Status |
|------|------------|--------|
| `js/analytics-api.js` | All admin analytics endpoints | All endpoints now documented |
| Admin dashboard pages | Summary endpoints | All endpoints now documented |

---

*Generated: 2026-02-07*
