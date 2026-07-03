# Dashboard — Net Profit time-series (Backend Handoff, Jul 2026)

**Audience:** backend dev (ink-backend repo, Render → `https://ink-backend-zaeq.onrender.com`).
**Status:** Frontend is **complete and live-wired**. The admin Dashboard "Performance overview" chart now plots **Net profit** (not gross) over time. The backend does **not yet ship a per-bucket net-profit series** — until it does, the frontend **falls back to the gross-profit series relabeled "Net profit"** so the chart is never blank. Add the field below to make the line accurate.

> Delete this file once implemented — we don't keep handoff `.md`s in the repo long-term.

---

## What to add

Add **`net_profit_series`** to the `/api/admin/analytics/dashboard-bundle` response `data` map, mirroring the existing `gross_profit_series` exactly.

**Endpoint:** `GET /api/admin/analytics/dashboard-bundle?...&granularity=<day|week|month|quarter>`
(Same filter params — brand/status/date range — and same `granularity` handling / bucket-cap behaviour as the other series. Owner-only, same auth gate as the rest of the bundle.)

**Shape** (identical to `gross_profit_series`, one row per bucket at the requested grain):

```json
{
  "net_profit_series": {
    "series": [
      { "bucket_start": "2026-07-01", "net_profit": 412.55 },
      { "bucket_start": "2026-07-02", "net_profit": 388.10 }
    ]
  }
}
```

- `bucket_start`: **Auckland-LOCAL** `"YYYY-MM-DD"` (NOT a UTC ISO timestamp) — same convention as every other series; the FE parses it as a local date so bars line up with the Orders list.
- `net_profit`: `numeric(10,2)`, per bucket. **Definition must match the Net Profit KPI**: `revenue − COGS − fees − GST − Opex` (same math the `kpi-summary` `net_profit` uses). The sum of the series over the range should reconcile to the aggregate Net Profit KPI for that range.
- One row per bucket for the full requested window (include zero/empty buckets as `net_profit: 0`, same as the other series).

## Frontend contract (already shipped — no FE change needed when this lands)
- `bundleToGraphs()` maps `net_profit_series → sNetProfit` (`inkcartridges/js/admin/pages/dashboard.js`).
- `drawPerformanceOverview()` prefers `sNetProfit`; per bucket it reads `net_profit ?? gross_profit`. When `net_profit_series` is absent/empty it uses `gross_profit_series` relabeled. So the moment the backend ships the field, the line switches to real net profit automatically.
- The separate "Revenue & gross profit over time" card (`drawRevenueProfit`) still uses `gross_profit_series` — leave that unchanged.

## Conventions (must match existing admin API)
- **Envelope:** `{ ok: true, data: {...} }`; read `data`. Do **not** use `{ success }`.
- **Grants/RLS:** mirror the other series — revoked `SELECT`/`EXECUTE` grants = silent-blank admin screens (a failure mode we've hit before).
- **Request-id:** thread `x-request-id` into errors as elsewhere.
