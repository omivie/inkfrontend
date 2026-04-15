# InkCartridges Backend — Admin Data Handoff

**Date:** 2026-04-16
**Repo:** backend service deployed at `https://ink-backend-zaeq.onrender.com`
**Supabase project:** `lmdlgldjgcanknsjrcxh`

This is a self-contained brief for the backend engineer (or an AI agent working in the backend repo). Everything below was verified against the live backend by hitting the actual endpoints with an authenticated admin session. No speculation — reproductions and expected shapes are real.

Please tackle items in order of priority below.

---

## 1. 🐞 BUG — `GET /api/admin/margin/summary` caps counts at 1000

### Reproduction
```bash
curl -s -H "Authorization: Bearer <admin-token>" \
  "https://ink-backend-zaeq.onrender.com/api/admin/margin/summary?days=30" | jq '.data.total_active_products'
# → 1000
```
But the real row count is much higher:
```bash
curl -sI -H "apikey: <anon-key>" -H "Authorization: Bearer <admin-token>" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  "https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/products?is_active=eq.true"
# → Content-Range: 0-999/3748   ← 3,748 actual active products
```

### Root cause
The handler is almost certainly doing something like:
```js
const { data } = await supabase.from('products').select('*').eq('is_active', true);
return { total_active_products: data.length };   // capped by PostgREST max-rows
```
PostgREST caps responses at 1,000 rows by default, so `data.length` silently tops out at 1000.

### Fix
Use a proper count query:
```js
const { count } = await supabase
  .from('products')
  .select('*', { count: 'exact', head: true })
  .eq('is_active', true);
return { total_active_products: count };
```

### Apply the same review to
- `underpriced_count` and `out_of_stock_count` in the same handler — they're under 1000 today (654, 578) so they look right, but they'll silently cap as the catalog grows. Convert each to `{ count: 'exact', head: true }` too.
- Any other `.from(...).select(...)` in the repo that's later read via `.length` for counting. Fetch-then-count is a repo-wide smell worth grepping for.

---

## 2. 🔴 MISSING — Supabase RPC `analytics_customer_stats` (deferred — tab removed from UI)

### Context
The admin's Finance → Customers tab was removed from the UI for now because this Supabase RPC **does not exist** and the tab was showing placeholders. When product decides to bring Customer analytics back (either as a tab or a dedicated page), this RPC needs to be created. All other analytics RPCs in the family work correctly (`analytics_kpi_summary`, `analytics_revenue_series`, `analytics_brand_breakdown`, `analytics_refunds_series`, `analytics_top_products`).

### Reproduction
```bash
curl -s -X POST \
  -H "apikey: <anon-key>" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"date_from":"2026-03-17","date_to":"2026-04-16","brand_filter":null}' \
  "https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/rpc/analytics_customer_stats"
# → 404 PGRST202: Could not find the function public.analytics_customer_stats
```

### Signature to create
```sql
create or replace function public.analytics_customer_stats(
  date_from    date,
  date_to      date,
  brand_filter text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- ... see "Return shape" and "Semantics" below
  return result;
end;
$$;

-- match RLS/grants pattern of the other analytics RPCs
revoke all on function public.analytics_customer_stats(date, date, text) from public;
grant execute on function public.analytics_customer_stats(date, date, text) to authenticated;
```

### Return shape (exact — the frontend reads these property paths)
```json
{
  "current": {
    "total_customers": 123,
    "new_customers": 42,
    "returning_customers": 81,
    "returning_pct": 65.9,
    "returning_revenue": 8420.15,
    "returning_revenue_pct": 72.3
  },
  "previous": {
    "total_customers": 110,
    "new_customers": 38,
    "returning_customers": 72,
    "returning_pct": 65.5,
    "returning_revenue": 7100.00,
    "returning_revenue_pct": 70.1
  }
}
```

### Semantics
- **total_customers** — distinct customers who placed ≥1 order in the window `[date_from, date_to]`.
- **new_customers** — customers whose *first-ever* order falls inside the window.
- **returning_customers** — customers with ≥1 order in the window AND ≥1 order strictly before `date_from`.
- **returning_pct** — `returning_customers / total_customers * 100`, rounded to 1 dp.
- **returning_revenue** — sum of order totals (excluding refunded portions) for returning customers, in the window.
- **returning_revenue_pct** — `returning_revenue / total_revenue_in_window * 100`, rounded to 1 dp.
- **previous** — the same metrics computed over the immediately preceding window of equal length (`date_from - window_length` to `date_from - 1 day`).
- **brand_filter** (optional) — when non-null, scope all counts/revenue to orders whose line items include that brand.

### Model after
`analytics_kpi_summary` in the same schema — it already splits into `{current, previous}` and has the correct RLS/grants pattern.

---

## 3. 🟡 OPTIONAL — PnL granular breakdown

### Status
The P&L table on Finance → Health is **working now** (frontend rewritten to consume what backend returns). This is a product-polish upgrade, not a bug fix.

### Current response
```http
GET /api/admin/analytics/pnl?days=30
```
```json
{
  "ok": true,
  "data": {
    "granularity": "monthly",
    "date_range": { "start": "...", "end": "..." },
    "periods": [
      { "period": "2026-04", "revenue": 585.90, "cogs": 367.14,
        "gross_profit": 218.76, "gross_margin_pct": 37.3,
        "operating_expenses": 0, "expenses_by_category": {},
        "net_profit": 218.76, "net_margin_pct": 37.3 }
    ],
    "totals": { "revenue": 646.27, "gross_profit": 259.50,
                "operating_expenses": 0, "net_profit": 259.50 }
  }
}
```

The frontend currently renders 5 rows: **Revenue, COGS, Gross Profit, Operating Expenses, Net Profit**.

### Nice-to-have: expand to full P&L rows
If product wants the traditional 10-row P&L (Gross Sales / Discounts & Returns / Net Revenue / Shipping Costs / Marketing / Platform Fees / Other Operating), each `periods[]` entry should include:
```json
{
  "period": "2026-04",
  "gross_sales": 600.00,
  "discounts": 14.10,
  "net_revenue": 585.90,
  "cogs": 367.14,
  "shipping_costs": 12.50,
  "gross_profit": 206.26,
  "expenses_by_category": {
    "marketing": 0,
    "platform_fees": 0,
    "other_operating": 0
  },
  "operating_expenses": 0,
  "net_profit": 206.26
}
```
If this arrives, the frontend will swap its 5-row table for the 10-row version. Until then, no action needed.

### Also nice-to-have: `previous_totals`
The frontend currently computes "previous period" from the second-to-last bucket in `periods[]`. Cleaner would be to include a sibling to `totals`:
```json
"previous_totals": {
  "revenue": 60.37, "cogs": 19.63, "gross_profit": 40.74,
  "operating_expenses": 0, "net_profit": 40.74
}
```
covering the period immediately before `date_range.start`. This lets the FE show accurate period-over-period change regardless of how many buckets are in `periods[]`.

---

## 4. 🟡 VERIFY — `GET /api/admin/market-intel/report` response shape

### Status
The endpoint exists and the FE handles the "no report yet" case gracefully (shows *"No report yet — run a competitive price check to generate one"*). Once a reconciliation report is generated, the summary cards should populate automatically — but only if the response keys match what the frontend reads.

### Expected response shape (when a report exists)
```json
{
  "ok": true,
  "data": {
    "avg_price_gap": 12.4,          // percent; FE formats as "12.4%"
    "overpriced_count": 37,          // FE also accepts "total_overpriced" as alias
    "underpriced_count": 82,         // FE also accepts "total_underpriced" as alias
    "coverage": 74,                  // percent; FE also accepts "products_tracked" (raw count)
    "generated_at": "2026-04-15T…"   // optional
  }
}
```

### 404 path (no report generated yet)
Current response is good — keep it:
```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "No reconciliation report found. Run the competitive price check first." } }
```

### Property paths the frontend reads
See `inkcartridges/js/admin/pages/cc-market-intel.js:32-36`:
- `data.avg_price_gap`
- `data.overpriced_count ?? data.total_overpriced`
- `data.underpriced_count ?? data.total_underpriced`
- `data.coverage ?? data.products_tracked`

Either form of each key works; pick one.

---

## 5. ✅ CONFIRM — POST handlers exist

These GET probes returned 404 (expected — they're POST-only routes), but I can't verify the POST handlers themselves are wired. Please confirm each handler exists and returns the `{ok, data}` envelope:

| Route | Called by | Purpose |
|---|---|---|
| `POST /api/admin/supplier/trigger-reconcile` | `AdminAPI.triggerReconcile` | Trigger a supplier reconciliation run |
| `POST /api/admin/price-monitor/bulk-action` | Price Monitor page bulk actions | Apply bulk price changes |
| `POST /api/admin/email/send-announcement` | Segments → email send | Send marketing announcement |
| `POST /api/admin/bulk-publish` | Products page bulk publish | Toggle active on many SKUs |
| `POST /api/admin/market-intel/match-price` | Market Intel → match competitor | Adjust price to match competitor |

---

## 6. 🟡 FUTURE — Customer-analytics endpoints not yet wired

These five frontend methods currently return `null` without hitting the backend (they're stubs at `inkcartridges/js/admin/api.js:313-317`):

- `getCustomerLTV` — lifetime value per customer
- `getCohorts` — retention cohort analysis (signups grouped by month, with retention % per subsequent month)
- `getChurn` — churn rate over time
- `getNPS` — Net Promoter Score breakdown
- `getRepeatPurchase` — repeat-purchase rate / time-to-second-order

If/when product wants these shown on Finance → Customers (or a dedicated Customer Insights page), we'll need endpoints for them. Not blocking — the frontend hides the sections today via `.admin-stub` placeholders. Flag this for roadmap planning only.

---

## 7. 🔍 CONFIRM — Recovery routes use 403 instead of 401 unauth

Every other admin route returns `401 Unauthorized` when called without a token. The `/api/admin/recovery/*` routes return `403 Forbidden` for the same unauthenticated request. Harmless, but worth confirming the auth middleware order on those routes is intentional and not a misconfiguration.

---

## 8. 📎 Reference — working endpoint shapes (for your own sanity check)

These are the exact response payloads the frontend was wired against. If any of these break in the future, the admin pages will fall back to zeros / placeholders.

**`GET /api/admin/analytics/overview?days=30`**
```json
{ "ok": true, "data": {
  "grossProfit": 242.44, "netProfit": 242.44,
  "grossMargin": 38.9, "prevGrossMargin": 73.3,
  "prevGrossProfit": 17.06, "prevNetProfit": 17.06,
  "refundRate": 30.8, "avgFulfilmentTime": 1.1,
  "revenueSparkline": [/* N numbers */],
  "ordersSparkline":  [/* N numbers */],
  "revenueTrend": { "direction": "up", "change": "2574.9" },
  "ordersTrend":  { "direction": "up", "change": "125.0" }
}}
```

**`GET /api/admin/analytics/burn-runway`**
```json
{ "ok": true, "data": {
  "monthly_burn": 0, "monthly_revenue": 215.42, "net_burn": -86.5,
  "cash_balance": 646.27, "runway_months": 24, "burn_trend": "positive"
}}
```

**`GET /api/admin/analytics/forecasts`** (nested `forecasts` key)
```json
{ "ok": true, "data": {
  "historical_average": 323.13,
  "trend_per_month": -262.76,
  "forecasts": { "30_days": 60.37, "60_days": -142.02, "90_days": -607.18 },
  "confidence": "medium",
  "methodology": "linear_trend"
}}
```

**`GET /api/admin/analytics/cashflow?months=12`**
```json
{ "ok": true, "data": {
  "historical": [{ "month": "2026-04", "inflows": 585.9, "outflows": 0,
                   "net_flow": 585.9, "closing_balance": 646.27 }],
  "projections": [],
  "current_balance": 646.27
}}
```

**`GET /api/admin/analytics/expenses?limit=5`**
```json
{ "ok": true, "data": { "expenses": [], "total_amount": 0, "count": 0 } }
```

**Supabase RPCs that work** (Finance and Dashboard depend on these):
- `analytics_kpi_summary(date_from, date_to, brand_filter, supplier_filter, status_filter)` → `{current, previous}`
- `analytics_revenue_series(date_from, date_to, brand_filter, supplier_filter)` → `{series: [{date, revenue, orders, aov, is_anomaly}]}`
- `analytics_brand_breakdown(date_from, date_to, metric, supplier_filter, status_filter)` → `{brands: [...]}`
- `analytics_refunds_series(date_from, date_to, brand_filter)` → `{series: [{date, refund_count, total_orders, total_amount}]}`
- `analytics_top_products(date_from, date_to, brand_filter, result_limit)` → `[{product_name, product_sku, revenue, units_sold, order_count, ...}]`

Please don't break these — the admin pages read specific property paths and will silently zero out if keys change.

---

## Response-envelope convention

All REST routes under `/api/admin/*` must return:
```json
{ "ok": true, "data": { ... } }
```
or
```json
{ "ok": false, "error": "Human-readable message", "code": "OPTIONAL_CODE" }
```
Frontend strips to `response.data` before reading fields. Do not return bare arrays or bare objects at the top level.

---

**Questions?** The full audit trail (every admin page, every section, every endpoint mapped to its frontend reader) lives in the frontend repo at `.claude/memory/admin-data-audit.md`.
