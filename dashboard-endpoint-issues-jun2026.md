# Admin Dashboard Analytics — Endpoint Issues (found by frontend, Jun 2026)

**Reporter:** storefront frontend (FEINK).
**Backend repo:** `ink-backend-zaeq` (`ink-backend-zaeq.onrender.com`), routes in
`src/routes/adminDashboardAnalytics.js` (+ `src/utils/analyticsBuckets.js`, `src/utils/analyticsQueries.js`).
**Context:** The Jun 2026 release (`FRONTEND-HANDOFF-jun2026.md` → `dashboard-graph-endpoints-frontend.md`)
is deployed and the routes exist, but when the frontend dashboard loads, several endpoints **error**.
The frontend is verified correct and unchanged — it renders the endpoints that return `200` and shows
graceful empty states for the rest. **Every issue below is backend-side.**

## How it was observed

Logged into the admin dashboard as owner on localhost (against the live backend). The dashboard issues
one bundle call; on failure it falls back to the per-chart endpoints. Captured from the browser Network panel.

All requests below carried a valid owner session (other admin endpoints like `kpi-summary`, `refunds-series`,
`/api/admin/orders` returned `200` in the same session, so **auth is fine** — these are not 401s).

**Common query params used by the dashboard for the "All time" range:**
`date_from=2020-01-01&date_to=2026-06-25&granularity=month` (series endpoints); ranked endpoints add
`result_limit=10` and omit/ignore `granularity`.

---

## 🔴 Issue 1 (highest priority) — `dashboard-bundle` returns 500

```
GET /api/admin/analytics/dashboard-bundle?date_from=2020-01-01&date_to=2026-06-25&granularity=month
→ 500
```

- This is the **preferred single-call path** the spec tells the frontend to use to avoid the per-chart
  fan-out. While it 500s, the frontend falls back to ~18 individual calls, which (with retries) **trips the
  60/min rate limiter** and cascades into 429s on the otherwise-healthy endpoints. **Fixing this one
  endpoint resolves most of the dashboard.**
- The frontend retries idempotent GETs on 5xx, so you'll see this request ~6× per load — that's expected
  client behaviour, not 6 separate bugs.
- **Likely cause:** an unhandled exception while assembling one of the sub-charts (see Issues 2–4 — the
  bundle almost certainly calls the same code that fails standalone). A single failing sub-query should not
  500 the whole bundle — consider per-key try/catch so one bad chart returns `null`/`[]` for its key instead
  of failing the entire response.

## 🔴 Issue 2 — `series/gross-profit` returns 500

```
GET /api/admin/analytics/series/gross-profit?date_from=2020-01-01&date_to=2026-06-25&granularity=month
→ 500
```

- Sibling series endpoints `series/orders`, `series/aov`, `series/revenue-by-customer-type` return **200**
  with the same params, so the bucketing/window handling is fine in general — this is specific to the
  gross-profit computation (COGS / Stripe-fee math per the spec: "revenue ex-GST − COGS − Stripe fee").
- Suspect a divide-by-zero, a null COGS/cost row, or a missing join over the wide window.

## 🟠 Issue 3 — `top-skus/revenue` returns 400

```
GET /api/admin/analytics/top-skus/revenue?date_from=2020-01-01&date_to=2026-06-25&result_limit=10
→ 400
```

- Ranked endpoint; per the spec it should ignore `granularity` and accept `result_limit` 1–500.
- A 400 here is unexpected for valid dates + `result_limit=10`. **Hypotheses to check:**
  - Does the validator reject the wide window (`date_from=2020-01-01`, ~6.5 yrs)? The spec's documented cap
    is about `granularity` bucket count (e.g. `hour` over a year) — but ranked endpoints have no buckets, so
    they shouldn't be window-capped. If they are, please exempt ranked endpoints or raise the cap.
  - Is a `granularity` param being required/validated on a route that's supposed to ignore it? (The FE does
    **not** send `granularity` to ranked endpoints.)

## 🟠 Issue 4 — `customers/reorder-interval` returns 400

```
GET /api/admin/analytics/customers/reorder-interval?date_from=2020-01-01&date_to=2026-06-25
→ 400
```

- Same shape as Issue 3 — a 400 on valid dates with no `granularity`. Likely the same root cause
  (window cap or a required-param mismatch on an aggregate endpoint).

---

## ✅ Confirmed working (200, real data rendered)

- `GET /api/admin/analytics/series/orders` → 200
- `GET /api/admin/analytics/series/aov` → 200
- `GET /api/admin/analytics/series/revenue-by-customer-type` → 200
- Existing endpoints used by the KPI band/tables: `kpi-summary`, `refunds-series`,
  `/api/admin/margin/out-of-stock`, `/api/admin/orders`, `top-products-rpc` → all 200.

The remaining chart endpoints (`series/revenue`, `series/refund-rate`, `series/traffic-by-source`,
`forecast/revenue`, `top-skus/gross-profit`, `margin/by-brand`, `margin/by-category`,
`conversion-by-source`, `suppliers/revenue`, `suppliers/problem-rate`, `search/top-converting`,
`search/zero-result`) mostly returned **429** in this session — but that is a **side effect** of the
rate-limit cascade triggered by Issues 1–4 (bundle 500 → fan-out + retries → limiter exhausted), **not**
evidence they're individually broken. Please re-test them once the bundle is fixed; if any still error,
they likely share the Issue 2/3 root cause.

---

## Reproduce (curl, with an owner token)

```bash
TOKEN="<owner JWT / session>"
B="https://ink-backend-zaeq.onrender.com/api/admin/analytics"
A="Authorization: Bearer $TOKEN"

# All-time window (what the dashboard sends by default):
curl -sS -H "$A" "$B/dashboard-bundle?date_from=2020-01-01&date_to=2026-06-25&granularity=month" | head
curl -sS -H "$A" "$B/series/gross-profit?date_from=2020-01-01&date_to=2026-06-25&granularity=month" | head
curl -sS -H "$A" "$B/top-skus/revenue?date_from=2020-01-01&date_to=2026-06-25&result_limit=10" | head
curl -sS -H "$A" "$B/customers/reorder-interval?date_from=2020-01-01&date_to=2026-06-25" | head

# Compare with a NARROW window to isolate window-size vs logic bugs:
curl -sS -H "$A" "$B/dashboard-bundle?date_from=2026-05-27&date_to=2026-06-25&granularity=day" | head
curl -sS -H "$A" "$B/series/gross-profit?date_from=2026-05-27&date_to=2026-06-25&granularity=day" | head
```

(Check the Render server logs for the stack traces behind the two 500s.)

## What "fixed" looks like (frontend contract — already implemented FE-side)

- All endpoints return `200` with `{ ok: true, data: … }`; empty window → `200 { series: [] }` / `[]`
  (never 4xx/5xx for "no data" — a 4xx/5xx is the only thing that makes the FE show "Awaiting data").
- `dashboard-bundle` returns the full `data` map; a single failing sub-chart should degrade to that key
  being `null`/`[]`, not 500 the whole response.
- No frontend changes are required once these return 200 — the charts populate automatically.

## Lower-priority KPI gaps (not blocking; mentioned for completeness)

- `kpi-summary` has no `net_profit` field in `current`/`previous` → the dashboard's **Net Profit** tile shows
  "—". Adding `net_profit` (and ideally `refund_rate`) to `kpi-summary` would light it up.
- The `analytics_customer_stats` Supabase RPC returns **403** (grant dropped) → **Returning %** tile shows
  "—". Either restore the `GRANT EXECUTE`, or expose the `returning_pct` via the HTTP `/customer-stats`
  wrapper the handoff references.
