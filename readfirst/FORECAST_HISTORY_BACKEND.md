# Backend: Forecast History — Handoff

## Goal

The admin dashboard currently shows a **30-day revenue forecast** (a single forward-looking number from `/api/admin/analytics/forecasts`). We want to also plot **what the forecast looked like at past dates**, so the store owner can visually compare _"what we predicted"_ vs _"what actually happened"_ on the same chart.

Concretely, the frontend needs a new endpoint that returns **a daily series of historical forecast snapshots** — one row per day, each containing the 30/60/90-day projection _as it would have been computed at that point in time_.

---

## Scope — what to build

1. **New table** `forecast_snapshots` — stores daily snapshots of the forecast.
2. **Backfill** — populate the table with synthetic past snapshots computed against historical order data, so the chart isn't empty on day one.
3. **Daily snapshot job** — write today's forecast to the table every day at ~01:00 NZ time.
4. **New endpoint** `GET /api/admin/analytics/forecast-history` — returns the daily snapshot series.
5. **(Optional but recommended)** extend the existing `GET /api/admin/analytics/forecasts` response to include `generated_at` so a fresh call can be inserted without re-running the model.

---

## 1. Table schema

```sql
-- migrations/YYYYMMDD_forecast_snapshots.sql

CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_date   DATE        NOT NULL,           -- the day this forecast was made
  horizon_days    INTEGER     NOT NULL,           -- 30, 60, or 90
  projected_revenue NUMERIC(12, 2) NOT NULL,      -- total revenue projected over that horizon
  confidence      TEXT        NULL,               -- 'low' | 'medium' | 'high' (or numeric 0-100)
  model_version   TEXT        NULL,               -- e.g. 'v1-rolling-avg', 'v2-linear-reg'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (snapshot_date, horizon_days, model_version)
);

CREATE INDEX idx_forecast_snapshots_date
  ON forecast_snapshots (snapshot_date DESC);

CREATE INDEX idx_forecast_snapshots_horizon
  ON forecast_snapshots (horizon_days, snapshot_date DESC);

-- RLS: same as other analytics tables — owner-only read, service-role write.
ALTER TABLE forecast_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners read forecast_snapshots"
  ON forecast_snapshots FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM admin_users WHERE user_id = auth.uid() AND role = 'owner')
  );

CREATE POLICY "service role writes forecast_snapshots"
  ON forecast_snapshots FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
```

**Notes**
- `snapshot_date` is the _prediction date_ (not the horizon end date). If today is 2026-04-24 and we predict $5,000 in next 30 days, that's one row: `snapshot_date=2026-04-24, horizon_days=30, projected_revenue=5000`.
- `UNIQUE` key prevents dup rows when the backfill or cron re-runs.

---

## 2. Backfill (seed historical snapshots)

Run this **once** after the migration to populate the table with past forecasts, so the graph isn't empty on day one. It replays the forecast algorithm against historical order data — for each past day `D`, compute what a 30/60/90-day forecast would have looked like using only orders placed _before_ `D`.

### Algorithm to use

Use **whatever the live `/forecasts` endpoint already uses** — that way the backfill matches what users saw historically. If the live endpoint uses a simple rolling average, the backfill does too. If it uses linear regression or something fancier, the backfill uses the same code path, just with a cutoff date.

**Pseudocode:**

```js
// scripts/backfill-forecast-snapshots.js

import { supabase } from '../lib/supabase.js';
import { computeForecast } from '../services/forecast.js'; // <-- your existing forecast function

const START_DATE = '2025-01-01';  // earliest date worth backfilling (adjust to when orders started)
const END_DATE   = new Date().toISOString().slice(0, 10);
const HORIZONS   = [30, 60, 90];

async function backfill() {
  const rows = [];
  for (let d = new Date(START_DATE); d <= new Date(END_DATE); d.setDate(d.getDate() + 1)) {
    const snapshotDate = d.toISOString().slice(0, 10);

    for (const horizon of HORIZONS) {
      // IMPORTANT: pass `asOf: snapshotDate` so computeForecast uses only orders
      // placed BEFORE that date — no future data leaks.
      const { projected_revenue, confidence } = await computeForecast({
        asOf: snapshotDate,
        horizonDays: horizon,
      });

      rows.push({
        snapshot_date: snapshotDate,
        horizon_days: horizon,
        projected_revenue,
        confidence,
        model_version: 'v1-backfill',
      });
    }
  }

  // Batch upsert
  const { error } = await supabase
    .from('forecast_snapshots')
    .upsert(rows, { onConflict: 'snapshot_date,horizon_days,model_version' });

  if (error) throw error;
  console.log(`Backfilled ${rows.length} forecast snapshots`);
}

backfill().catch(console.error);
```

### Refactor note

If the existing forecast code doesn't already accept an `asOf` parameter, **refactor it first** so it does. The function needs to be pure-ish: given a date, return what the forecast would have been at that date. Something like:

```js
// services/forecast.js

export async function computeForecast({ asOf = new Date(), horizonDays = 30 }) {
  // Get daily revenue for the 90 days prior to `asOf`
  const lookbackDays = 90;
  const from = new Date(asOf);
  from.setDate(from.getDate() - lookbackDays);

  const { data: orders } = await supabase
    .from('orders')
    .select('total, created_at')
    .gte('created_at', from.toISOString())
    .lt('created_at', new Date(asOf).toISOString())
    .in('status', ['paid', 'shipped', 'completed']);

  const totalRevenue = orders.reduce((s, o) => s + Number(o.total), 0);
  const dailyAvg = totalRevenue / lookbackDays;
  const projected_revenue = dailyAvg * horizonDays;

  // Confidence: high if we have ≥60 days of order history, medium 30-60, low <30
  const daysWithOrders = new Set(orders.map(o => o.created_at.slice(0, 10))).size;
  const confidence = daysWithOrders >= 60 ? 'high' : daysWithOrders >= 30 ? 'medium' : 'low';

  return { projected_revenue, confidence, daysWithOrders };
}
```

If you already have a more sophisticated model, keep it — just make sure `asOf` is respected.

---

## 3. Daily snapshot job

Write today's forecast to the table every morning.

### Option A — Supabase `pg_cron` (preferred if available)

```sql
SELECT cron.schedule(
  'forecast-snapshot-daily',
  '0 13 * * *',  -- 13:00 UTC = 01:00 NZST (adjust for DST as needed)
  $$
  INSERT INTO forecast_snapshots (snapshot_date, horizon_days, projected_revenue, confidence, model_version)
  VALUES
    (CURRENT_DATE, 30, compute_forecast_sql(CURRENT_DATE, 30), compute_forecast_confidence_sql(CURRENT_DATE), 'v1-rolling-avg'),
    (CURRENT_DATE, 60, compute_forecast_sql(CURRENT_DATE, 60), compute_forecast_confidence_sql(CURRENT_DATE), 'v1-rolling-avg'),
    (CURRENT_DATE, 90, compute_forecast_sql(CURRENT_DATE, 90), compute_forecast_confidence_sql(CURRENT_DATE), 'v1-rolling-avg')
  ON CONFLICT (snapshot_date, horizon_days, model_version) DO NOTHING;
  $$
);
```

You'll need to expose `compute_forecast_sql()` as a Postgres function if you go this route, or call the Node service via HTTP from `pg_net`.

### Option B — Node cron on Render (simpler)

Add a scheduled job to the backend Render service (either via `node-cron` in-process or a Render Cron Job):

```js
// jobs/forecast-snapshot.js

import cron from 'node-cron';
import { supabase } from '../lib/supabase.js';
import { computeForecast } from '../services/forecast.js';

export function startForecastSnapshotJob() {
  // 01:00 Pacific/Auckland every day
  cron.schedule('0 1 * * *', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];

    for (const horizon of [30, 60, 90]) {
      const { projected_revenue, confidence } = await computeForecast({
        asOf: today,
        horizonDays: horizon,
      });
      rows.push({
        snapshot_date: today,
        horizon_days: horizon,
        projected_revenue,
        confidence,
        model_version: 'v1-rolling-avg',
      });
    }

    const { error } = await supabase
      .from('forecast_snapshots')
      .upsert(rows, { onConflict: 'snapshot_date,horizon_days,model_version' });

    if (error) console.error('[forecast-snapshot] upsert failed', error);
    else       console.log(`[forecast-snapshot] wrote ${rows.length} rows for ${today}`);
  }, { timezone: 'Pacific/Auckland' });
}
```

Start it from the main server file:

```js
// server.js (or app.js)
import { startForecastSnapshotJob } from './jobs/forecast-snapshot.js';
startForecastSnapshotJob();
```

---

## 4. New endpoint

### Route

```
GET /api/admin/analytics/forecast-history
```

### Query params

| Param | Type | Default | Description |
|---|---|---|---|
| `days` | integer | `90` | How far back to return snapshots. Capped at 365. |
| `horizon` | integer | `30` | Which horizon to return (30/60/90). |

### Auth

Same middleware as the rest of `/api/admin/*` — owner-only.

### Response

```json
{
  "ok": true,
  "data": {
    "horizon_days": 30,
    "snapshots": [
      { "snapshot_date": "2026-01-25", "projected_revenue": 4532.10, "confidence": "medium" },
      { "snapshot_date": "2026-01-26", "projected_revenue": 4610.45, "confidence": "medium" },
      ...
      { "snapshot_date": "2026-04-24", "projected_revenue": 5120.00, "confidence": "high" }
    ]
  }
}
```

### Error shape (on failure)

```json
{ "ok": false, "error": { "message": "..." } }
```

### Handler sketch

```js
// routes/admin/analytics/forecast-history.js

router.get('/forecast-history', requireOwner, async (req, res) => {
  const days    = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  const horizon = [30, 60, 90].includes(Number(req.query.horizon))
    ? Number(req.query.horizon)
    : 30;

  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('forecast_snapshots')
    .select('snapshot_date, projected_revenue, confidence')
    .eq('horizon_days', horizon)
    .gte('snapshot_date', fromStr)
    .order('snapshot_date', { ascending: true });

  if (error) {
    return res.status(500).json({ ok: false, error: { message: error.message } });
  }

  res.json({
    ok: true,
    data: {
      horizon_days: horizon,
      snapshots: data || [],
    },
  });
});
```

---

## 5. (Optional) Extend `/api/admin/analytics/forecasts`

To make the live forecast self-persisting (so the cron is a belt-and-braces rather than the only source), have the existing `/forecasts` handler **also upsert today's row** into `forecast_snapshots` as a side effect:

```js
router.get('/forecasts', requireOwner, async (req, res) => {
  const result = await computeForecast({ asOf: new Date(), horizonDays: 30 });
  const result60 = await computeForecast({ asOf: new Date(), horizonDays: 60 });
  const result90 = await computeForecast({ asOf: new Date(), horizonDays: 90 });

  // Side-effect: persist today's snapshot (fire-and-forget)
  const today = new Date().toISOString().slice(0, 10);
  supabase.from('forecast_snapshots').upsert([
    { snapshot_date: today, horizon_days: 30, projected_revenue: result.projected_revenue,   confidence: result.confidence,   model_version: 'v1-rolling-avg' },
    { snapshot_date: today, horizon_days: 60, projected_revenue: result60.projected_revenue, confidence: result60.confidence, model_version: 'v1-rolling-avg' },
    { snapshot_date: today, horizon_days: 90, projected_revenue: result90.projected_revenue, confidence: result90.confidence, model_version: 'v1-rolling-avg' },
  ], { onConflict: 'snapshot_date,horizon_days,model_version' })
    .then(({ error }) => { if (error) console.error('snapshot side-effect failed', error); });

  res.json({
    ok: true,
    data: {
      next_30_days: { revenue: result.projected_revenue },
      next_60_days: { revenue: result60.projected_revenue },
      next_90_days: { revenue: result90.projected_revenue },
      confidence: result.confidence,
      generated_at: new Date().toISOString(),
    },
  });
});
```

---

## 6. Testing checklist

- [ ] Migration runs cleanly on a fresh DB.
- [ ] Backfill script produces rows for every day in the window, for all three horizons.
- [ ] `SELECT count(*) FROM forecast_snapshots` shows `(days × 3)` rows after backfill.
- [ ] `GET /api/admin/analytics/forecast-history?days=30&horizon=30` returns 30 rows.
- [ ] Endpoint returns `401/403` for non-owners.
- [ ] Invalid `horizon` (e.g. `?horizon=45`) falls back to `30` (or returns 400 — your call, just document it).
- [ ] Cron inserts exactly 3 rows each morning (one per horizon).
- [ ] Running `/forecasts` twice on the same day doesn't create duplicate snapshot rows (ON CONFLICT works).
- [ ] Confidence values are `'low' | 'medium' | 'high'` (not numeric) — the frontend expects strings.

---

## 7. Frontend integration (for reference)

Once the endpoint is live, the frontend will:

1. Add an API wrapper in `inkcartridges/js/admin/api.js`:

   ```js
   async getAdminAnalyticsForecastHistory(days = 90, horizon = 30) {
     try {
       const resp = await window.API.get(
         `/api/admin/analytics/forecast-history?days=${days}&horizon=${horizon}`
       );
       return resp?.data ?? null;
     } catch (e) { adminApiWarn('analytics/forecast-history', e); return null; }
   },
   ```

2. Pull it in `loadDashboard()` alongside the other forecasts call.
3. Plot it as a third line on the 30-day Forecast chart (`inkcartridges/js/admin/pages/dashboard.js`, `drawForecastChart()`) — a dotted orange/yellow line labeled **"Prior forecasts"**, aligned to each snapshot's `snapshot_date`. Where this line intersects the solid "Actual" revenue line, the user can visually see how accurate each historical forecast was.

The frontend change is ~40 lines; the backend work in this doc is the blocker.

---

## Summary

| Deliverable | Est. effort |
|---|---|
| Migration (`forecast_snapshots` table) | 15 min |
| Refactor `computeForecast` to accept `asOf` | 30 min |
| Backfill script + one-time run | 30 min |
| Daily cron job | 20 min |
| `GET /forecast-history` endpoint | 30 min |
| Tests + smoke-check | 30 min |
| **Total** | **~2.5 hours** |

Ping when the endpoint is live on the Render deploy and I'll wire up the frontend.
