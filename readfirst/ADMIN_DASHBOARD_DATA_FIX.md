# Backend: Admin Dashboard Data Fix — Handoff

**Date:** 2026-05-01
**Frontend repo:** `inkcartridges/` (this repo)
**Backend repo:** deployed at `https://ink-backend-zaeq.onrender.com`
**Supabase project:** `lmdlgldjgcanknsjrcxh`

This is a self-contained brief. Every issue below was reproduced against the live backend and Supabase using a real authenticated owner session (Playwright + browser DevTools). Responses are real, not assumed. Frontend handling is already correct (graceful degradation via `try/catch` and `Promise.allSettled`); no frontend changes are required.

---

## Symptom

Admin Dashboard (`/html/admin/`) renders, but most data tiles are empty:

| Tile | State |
| --- | --- |
| Revenue / Gross Profit / Orders / AOV | "—" |
| New Customers / Returning % | "—" |
| Refund Rate / Refunds card | "—" / "No refund data" |
| Most Bought | "Top product data unavailable" |
| Market Intel | "No market alerts" |
| Payment Methods | "No payment data yet" |
| Revenue / Orders sparklines | blank |

Working tiles: Recent Orders, Trends bars (revenue from order fallback, expenses from P&L), 30-day Forecast, Cash Runway, Out of Stock, Recent Activity. **All working tiles use the REST backend; all broken tiles use Supabase RPCs or specific REST endpoints below.** That pattern proves the user's auth is valid — it's a per-endpoint problem.

---

## Issues — work in this order

1. Grant `EXECUTE` on 5 existing Supabase analytics RPCs (15-minute fix, unblocks the most tiles)
2. Create the missing `analytics_customer_stats` RPC
3. Fix 3 backend REST endpoints (market-intel × 2, payment-breakdown)

Reproductions, root cause, and fix details below.

---

## 1. 🔴 GRANT EXECUTE missing on 5 Supabase RPCs

### Reproduction

With an authenticated owner session (`vielandvnnz@gmail.com`), every one of these RPCs returns **HTTP 403** with body `{"code":"42501","message":"permission denied for function <name>"}`:

| RPC | Called by frontend |
| --- | --- |
| `analytics_kpi_summary` | `AdminAPI.getDashboardKPIs` (KPI strip — Revenue, Gross Profit, Orders, AOV) |
| `analytics_revenue_series` | `AdminAPI.getRevenueSeries` (Revenue/Orders sparklines, daily series) |
| `analytics_top_products` | `AdminAPI.getTopProducts` (Most Bought card) |
| `analytics_refunds_series` | `AdminAPI.getRefundAnalytics` (Refund Rate KPI, Refunds card) |
| `get_suppliers` | `AdminAPI.getSuppliers` (filter dropdown) |

Verbatim from browser console:

```
[ERROR] Failed to load resource: the server responded with a status of 403 ()
@ https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/rpc/analytics_kpi_summary
[WARNING] [AdminAPI] RPC analytics_kpi_summary failed:
permission denied for function analytics_kpi_summary
```

### Root cause

The functions exist in `public` schema (we get `42501 permission denied`, not `PGRST202 not found`) but `EXECUTE` has not been granted to the role the owner JWT presents (`authenticated`). Either the migration that created them never ran the `GRANT`, or a `REVOKE ALL FROM PUBLIC` ran without a follow-up grant.

### Fix

Run the following on the Supabase SQL editor (or as a migration). **Replace `<arg types>` with the real argument types from `\df <fn_name>` — Postgres requires exact arg types in the GRANT.** Best-guess signatures from the frontend call sites are below; adjust if your function signatures differ:

```sql
-- KPI summary: 3 month-aware metrics + comparison window
GRANT EXECUTE ON FUNCTION public.analytics_kpi_summary(
  date,    -- date_from
  date,    -- date_to
  text,    -- brand_filter (CSV or single brand; nullable)
  text,    -- supplier_filter
  text     -- status_filter
) TO authenticated;

-- Revenue series: daily revenue/orders/aov per day
GRANT EXECUTE ON FUNCTION public.analytics_revenue_series(
  date,    -- date_from
  date,    -- date_to
  text,    -- brand_filter
  text     -- supplier_filter
) TO authenticated;

-- Top products: best sellers by revenue
GRANT EXECUTE ON FUNCTION public.analytics_top_products(
  date,    -- date_from
  date,    -- date_to
  text,    -- brand_filter
  int      -- result_limit (frontend passes 10)
) TO authenticated;

-- Refunds series: per-period refund counts and amounts
GRANT EXECUTE ON FUNCTION public.analytics_refunds_series(
  date,    -- date_from
  date,    -- date_to
  text     -- brand_filter
) TO authenticated;

-- Suppliers list (no args expected — confirm with \df)
GRANT EXECUTE ON FUNCTION public.get_suppliers() TO authenticated;
```

### How to confirm signatures

Run in Supabase SQL editor:

```sql
SELECT n.nspname AS schema,
       p.proname  AS name,
       pg_get_function_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'analytics_kpi_summary',
    'analytics_revenue_series',
    'analytics_top_products',
    'analytics_refunds_series',
    'get_suppliers'
  );
```

### Verification

After granting, hit Supabase from the admin owner session (or via curl with a fresh owner JWT):

```bash
curl -s -X POST \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <OWNER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"date_from":"2026-02-01","date_to":"2026-05-01","brand_filter":null,"supplier_filter":null,"status_filter":null}' \
  "https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/rpc/analytics_kpi_summary"
```

Should return **200** with a body shaped like `{"current": {...}, "previous": {...}}` (see Section 2 "Existing response shapes" for what the frontend actually reads from each).

### Reference: frontend call signatures

`inkcartridges/js/admin/api.js` lines 232–283:

```js
async getDashboardKPIs(filterParams, signal) {
  return rpc('analytics_kpi_summary', {
    date_from, date_to, brand_filter, supplier_filter, status_filter,
  });
},
async getRevenueSeries(filterParams, signal) {
  return rpc('analytics_revenue_series', {
    date_from, date_to, brand_filter, supplier_filter,
  });
},
async getCustomerStats(filterParams, signal) { /* see Section 2 */ },
async getTopProducts(filterParams, signal) {
  return rpc('analytics_top_products', {
    date_from, date_to, brand_filter, result_limit: 10,
  });
},
async getRefundAnalytics(filterParams, signal) {
  return rpc('analytics_refunds_series', {
    date_from, date_to, brand_filter,
  });
},
```

---

## 2. 🔴 MISSING — Supabase RPC `analytics_customer_stats`

### Reproduction

```bash
curl -s -X POST \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <OWNER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"date_from":"2026-02-01","date_to":"2026-05-01","brand_filter":null}' \
  "https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/rpc/analytics_customer_stats"
# → 404 PGRST202: Could not find the function public.analytics_customer_stats
```

### Context

This RPC was flagged as missing in a previous handoff doc (deleted in commit `3621b1e`, now restored below). The frontend's customer-intelligence tab was removed at the time, but `js/admin/pages/dashboard.js:83` still calls `getCustomerStats()`. The result: the dashboard's "New Customers" and "Returning %" KPI tiles always show "—".

### Signature to create

```sql
CREATE OR REPLACE FUNCTION public.analytics_customer_stats(
  date_from    date,
  date_to      date,
  brand_filter text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  -- See "Return shape" and "Semantics" below for the exact fields.
  -- Model after analytics_kpi_summary — same {current, previous} shape and
  -- same RLS/owner gating pattern.
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_customer_stats(date, date, text) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_customer_stats(date, date, text) TO authenticated;
```

### Return shape (exact — frontend reads these property paths)

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

- **`total_customers`** — distinct customers who placed ≥1 order in the window `[date_from, date_to]`.
- **`new_customers`** — customers whose *first-ever* order falls inside the window.
- **`returning_customers`** — customers with ≥1 order in the window AND ≥1 order strictly before `date_from`.
- **`returning_pct`** — `returning_customers / total_customers * 100`, rounded to 1 dp.
- **`returning_revenue`** — sum of order totals (excluding refunded portions) for returning customers, in the window.
- **`returning_revenue_pct`** — `returning_revenue / total_revenue_in_window * 100`, rounded to 1 dp.
- **`previous`** — same metrics over the immediately preceding window of equal length: `[date_from - window_length, date_from - 1 day]`.
- **`brand_filter`** — when non-null, scope all counts/revenue to orders whose line items include that brand.

### Frontend property paths consumed

`js/admin/pages/dashboard.js:201-202`:

```js
const newCustomers     = cc.new_customers ?? cc.new ?? cc.newCustomers ?? null;
const newCustomersPrev = cp.new_customers ?? cp.new ?? cp.newCustomers ?? null;
// ...
{ label: 'Returning %', value: cc.returning_pct != null ? `${cc.returning_pct}%` : null, ... }
```

So the minimum the dashboard needs from `current`/`previous` is `new_customers` and `returning_pct`. The other fields are forward-compatible for the customer-intelligence page when it's reintroduced.

### Model after

`analytics_kpi_summary` in the same schema — already splits into `{current, previous}` and presumably has the correct RLS/grants pattern (after Section 1 fix).

---

## 3. 🟡 Backend REST endpoints failing

### 3a. `GET /api/admin/market-intel/discrepancies` → 404

```
Status: 404
Body:   {"message":"No discrepancies report found."}
URL:    /api/admin/market-intel/discrepancies?min_variance=15
```

Called by `AdminAPI.getMarketDiscrepancies` (`js/admin/api.js:1362`). Result: dashboard's Market Intel card shows empty.

**Likely cause:** the discrepancies report is produced by a scheduled job (or stored in a table) that is empty / hasn't run yet. A 404 for "report doesn't exist yet" is misleading — the endpoint *does* exist.

**Fix:** either ensure the report-producer job runs, OR change the empty-state response to **HTTP 200 with `{ items: [] }`** rather than 404. The frontend treats 200-empty and 404 the same (both render "No market alerts"), so 200 is preferable for log cleanliness.

### 3b. `GET /api/admin/market-intel/overpriced` → 404

```
Status: 404
Body:   {"message":"No proposed fixes report found."}
URL:    /api/admin/market-intel/overpriced?page=1&limit=5
```

Same shape and same fix as 3a. Called by `AdminAPI.getOverpricedProducts` (`js/admin/api.js:1353`).

### 3c. `GET /api/admin/audit/payment-breakdown` → 500

```
Status: 500
Body:   {"message":"Failed to fetch payment breakdown"}
URL:    /api/admin/audit/payment-breakdown?start_date=2026-04-30&end_date=2026-05-01
```

Called by `AdminAPI.getPaymentBreakdown` (`js/admin/api.js:1275`). Result: dashboard's Payment Methods card shows "No payment data yet".

**Action:** investigate the server stack trace for this exact request. The date range is a 1-day window (`start_date=2026-04-30&end_date=2026-05-01`) so it's not a date-parsing issue at the boundary. Most likely a SQL/query failure when the result set is empty or a NULL handling bug.

### Frontend response shape expectations (for completeness)

These are what the dashboard reads — return the shapes **plus more is fine**, but don't change these field names without coordinating:

```js
// market-intel/discrepancies → expected shape
{ items: [{ product_name, product_sku, variance_pct }, ...] }
// Frontend reads: p.product_name | p.name | p.sku, and p.variance_pct | p.variance

// market-intel/overpriced → expected shape
{ items: [{ product_name, product_sku, gap_pct }, ...] }
// Frontend reads: p.product_name | p.name | p.sku, and p.gap_pct | p.diff_pct | p.variance

// audit/payment-breakdown → expected shape
{ methods: [{ name: "card" | "bank-transfer" | ..., total: 1234.56 }, ...] }
// Frontend also accepts: top-level array, or { card: { total }, ... }
```

---

## Verification checklist (post-fix)

After deploying all three fixes, log into `/html/admin/` as an owner and confirm:

- [ ] Revenue, Gross Profit, Orders, AOV KPI tiles show numbers, not "—"
- [ ] New Customers and Returning % show numbers
- [ ] Refund Rate shows a percentage; Refunds card shows totals
- [ ] Most Bought card lists products
- [ ] Revenue/Orders sparklines render under their KPI tiles
- [ ] Market Intel card lists alerts (or shows clean empty-state with 200, not console errors)
- [ ] Payment Methods donut chart renders
- [ ] Browser DevTools console is free of `[AdminAPI] RPC ... failed:` warnings on dashboard load

Frontend will pick up all fixes immediately — no rebuild, no flag, no version bump.

---

## Tracking

- Frontend error log: `/Users/matcha/Desktop/FEINK/.claude/memory/errors.md` → ERR-010
- Frontend backend-fixes log: `/Users/matcha/Desktop/FEINK/.claude/memory/backend-fixes.md` → BF-006, BF-007, BF-008
