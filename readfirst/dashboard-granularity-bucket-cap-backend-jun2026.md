# Backend Handoff — Analytics granularity "Too many buckets (751)" bucket-cap miscount

**Owner:** Backend (`ink-backend-zaeq` repo)
**Reported:** 2026-06-26 · **Severity:** High (dashboard graphs blank for Week/Day grain)
**Frontend status:** Mitigated (auto-escalates to a coarser grain so graphs still load).
The real fix is backend. Once fixed, the frontend automatically uses the finer grain again
— **no frontend change required.**

---

## ⚠️ UPDATE 2026-06-26 (re-verified after backend reported "fixed")

The backend was reported fixed, but re-probing shows **Week is still broken** and the
response shape changed. Two action items remain for the backend:

**A. `week` is STILL miscounted — the cap check ignores the requested range.**
Re-probed live: `granularity=week` with `date_from=2026-03-01` (a **118-day** window = ~17
weeks) **still returns `400 "Too many buckets (751)"`**. 751 is the count for the *whole
dataset in days*, not the requested window in weeks. Compare same window:
- `granularity=day` · `date_from=2026-03-01` → **200**, returns **118** day buckets ✅ (day
  correctly honours the range)
- `granularity=week` · `date_from=2026-03-01` → **400 "751"** ❌ (week ignores the range AND
  doesn't divide by 7)
So the `week` branch must (1) scope to the requested `[date_from, date_to]` and (2) bucket by
`date_trunc('week', …)` / `generate_series(..., '1 week')`. See §3–§4 below — still open.

**B. Time-series response shape changed to a wrapper (heads-up — FE already adapted).**
Each series is now an object, not a bare array:
`revenue_series` → `{ "series": [ { "bucket_start", "revenue" }, … ] }`;
`traffic_by_source`/`conversion_by_source` → `{ "sources": [...] }`;
`reorder_interval` → `{ "median_days", "buckets": [...] }`.
The frontend already unwraps these, so no breakage — but please **keep these keys stable**.

**C. Request: expose the data's earliest date.** Add `data_min_date` (the date of the first
order / first non-empty bucket, `YYYY-MM-DD`) to `pagination.range`. The frontend currently
derives the dashboard's "all time" start by fetching the oldest order separately
(`GET /api/admin/orders?sort=oldest&limit=1`); a `data_min_date` on the bundle would let us
drop that extra round-trip. (`pagination.range` today only echoes the *requested* dateFrom/
dateTo, which isn't useful for this.)

---

## 1. Symptom

On the admin dashboard (`/admin#dashboard`), selecting the **Week** bar-width (and **Day**
on wide ranges) blanks every time-series graph with the empty state
"Awaiting data — backend endpoint pending".

Root cause is a **400** from the analytics bundle endpoint:

```
GET /api/admin/analytics/dashboard-bundle?date_from=2020-01-01&date_to=2026-06-26&granularity=week
→ 400  { error: "Too many buckets (751) for granularity 'week'. Narrow the window or use a coarser granularity." }
```

The frontend correctly offers Week (its own bucket math says a 6.5-year span ÷ 7 ≈ 338
weekly buckets, well under the 750 cap). The backend disagrees and returns **751**.

---

## 2. Evidence — the bucket count is wrong, not the cap

Probed live against production with a valid admin session. Same endpoint, varying
`granularity` and the date window:

| Request | Expected buckets | Backend result |
|---|---|---|
| `granularity=week`  · `date_from=2026-06-19` (7 days) | 1–2 | ✅ **200 OK** |
| `granularity=week`  · `date_from=2025-06-26` (1 year, ~52 wk) | ~52 | ❌ **400 — "751"** |
| `granularity=week`  · `date_from=2020-01-01` (all, ~338 wk) | ~338 | ❌ **400 — "751"** |
| `granularity=week`  · `date_from=2025-12-28` (6 months, ~26 wk) | ~26 | ❌ **400 — "751"** |
| `granularity=day`   · `date_from=2020-01-01` (all) | ~751 (real days of data) | ❌ **400 — "751"** |
| `granularity=month` · `date_from=2020-01-01` (all) | ~25 | ✅ **200 OK** |
| `granularity=quarter` · `date_from=2020-01-01` (all) | ~8 | ✅ **200 OK** |

**The tell:** `week@1y`, `week@all`, `week@6m`, and `day@all` **all report exactly 751** —
even though those windows contain 52, 338, 26, and ~751 buckets respectively. 751 is the
number of **days** of order data in the store (≈ earliest order → today). So:

- For **`week`**, the backend is counting **one bucket per day** (751), not per week
  (~108). It is **not** collapsing the series to weekly granularity.
- For **`day`**, 751 is legitimately just over the 750 cap (the store has ~751 days of
  data), so that rejection is *arguably* correct — but see §4, the cap should be measured
  against the **requested window**, not the full dataset.
- **`month`/`quarter` work**, which proves the per-grain bucketing is correct for those —
  so the defect is isolated to the **`week`** path (and the cap's handling of `day`).

---

## 3. Primary bug to fix

**`week` granularity produces day-level buckets instead of week-level buckets.**

Most likely one of:

- The bucket key uses `date_trunc('day', …)` (or `::date`) in the `week` branch instead of
  `date_trunc('week', …)`.
- The `generate_series(start, end, interval)` (used to fill empty buckets) is stepping by
  `'1 day'` for the `week` case instead of `'1 week'`.
- The pre-query **cap check** computes `bucket_count` from `(date_to - date_from)` in days
  without dividing by the grain's unit, so it always uses the day count for `week`.

Wherever the grain → interval mapping lives, make sure `week` maps to a 7-day step on both
the **cap check** and the **actual bucket aggregation**:

```
hour    → 1 hour
day     → 1 day
week    → 1 week     ← currently behaving like 1 day
month   → 1 month
quarter → 3 months
```

The cap check should be, conceptually:

```
estimated_buckets = ceil( span_in_unit(date_from, date_to, granularity) )
if (estimated_buckets > 750) → 400
```

i.e. `span_days / 7` for week, `span_days / ~30.4` for month, etc. — **never** the raw
day count for a non-day grain.

---

## 4. Secondary issue — cap measured against full dataset, not the requested window

`week@1y` and `week@6m` also returned **751** (the full-dataset day span), not the
requested window's span (365 and 180 days). That implies the **bucket-cap check ignores
`date_from`/`date_to`** and measures the entire data range.

Please confirm the cap (and the bucketing) is scoped to the **requested
`[date_from, date_to]`**, not `min(order_date) … now()`. After the §3 fix this matters less
(weekly counts are tiny), but it's the correct behavior and avoids surprise rejections when
the dataset grows.

---

## 5. Scope — other endpoints sharing the helper

The frontend's per-chart endpoints take the same `granularity` param and almost certainly
share the bucketing/cap helper. Fix once, verify all:

- `GET /api/admin/analytics/dashboard-bundle` (the one the dashboard uses today)
- `GET /api/admin/analytics/series/revenue`
- `GET /api/admin/analytics/series/gross-profit`
- `GET /api/admin/analytics/series/orders`
- `GET /api/admin/analytics/series/aov`
- `GET /api/admin/analytics/series/refund-rate`
- `GET /api/admin/analytics/series/revenue-by-customer-type`
- `GET /api/admin/analytics/forecast/revenue`

---

## 6. Acceptance criteria

Against a dataset spanning ~2 years, with a valid admin token:

1. `granularity=week` · all-time window → **200**, returns **one row per ISO week**
   (~100–340 rows depending on span), `bucket_start` aligned to week boundaries.
2. `granularity=week` · 1-year window → **200**, ~52 rows.
3. `granularity=day` · window ≤ 750 days → **200**; only a window whose **requested** day
   span exceeds 750 returns the 400 (and the message's N equals that requested-window day
   count, not the dataset's).
4. `month` / `quarter` continue to return 200 (no regression).
5. The `Too many buckets (N)` message reports an **N that matches the requested window at
   the requested grain** (e.g. weeks for `week`), so it's diagnostic rather than misleading.
6. Same behavior across all endpoints in §5.

Quick verification (replace host/token):

```bash
HOST=https://ink-backend-zaeq.onrender.com
TOK="<admin bearer>"
for G in week day month quarter; do
  echo "== $G (all) =="
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOK" \
    "$HOST/api/admin/analytics/dashboard-bundle?date_from=2020-01-01&date_to=2026-06-26&granularity=$G"
done
# Expect: week 200, day 400 (only because >750 real days), month 200, quarter 200
```

---

## 7. What the frontend already did (context, no action needed)

To stop the blank graphs while this is open, the frontend now **auto-escalates**: on the
`Too many buckets` 400 it retries one grain coarser (`…→week→month→quarter`) until the
backend accepts, and labels the x-axis to match whatever grain actually served. So Week
currently renders **monthly** bars. Once the backend serves weekly buckets, the escalation
becomes a no-op and Week renders weekly again automatically — **no coordinated frontend
deploy required.** (FE detail: `getDashboardBundle()` in `js/admin/api.js`; tracked as
ERR-047 in the frontend repo.)
