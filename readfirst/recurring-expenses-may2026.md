# Recurring Expenses + P&L granularity rule (May 2026)

Spec for the dashboard Trends-chart change shipped 2026-05-10. Pinned by:
- `tests/dashboard-trend-math.test.js` (recurring expansion + integration guard)
- `tests/dashboard-pnl-no-smear.test.js` (P&L granularity rule + import wiring)

## Why this exists

User report 2026-05-08:

> what is this $29.80 expense its taking every day

The Trends chart was showing a phantom ~$29.80 expense bar on every day in
the 7-day window, including days with $0 revenue and zero orders. Root cause:
backend `/api/admin/analytics/pnl` returns one row per **calendar month**
(`period: "2026-05"`). The frontend was distributing each P&L row's COGS
across visible buckets weighted by **time overlap**, which concentrated the
entire month's COGS into the visible day-buckets — painting a fake daily
expense on every day in the window regardless of where the orders actually
happened.

User's two asks (2026-05-10):
1. **Cash basis**: every expense lands on the day it was actually accrued.
2. **Recurring subscriptions** fire on their real billing day each period
   (per-row day-of-month, not all pinned to the 1st).

This produces a chart that matches the bank statement.

## Schema additions (expenses)

The `/api/admin/analytics/expenses` row gains five optional fields. Missing
keys → row is treated as a one-off (full backwards-compat with rows already
in the DB).

| Field | Type | Used when |
|---|---|---|
| `recurrence` | `'none' \| 'weekly' \| 'monthly' \| 'yearly' \| 'custom'` | always (default `'none'`) |
| `recurrence_day_of_month` | int 1–31 | monthly, yearly |
| `recurrence_day_of_week` | int 0–6 (Sun=0) | weekly |
| `recurrence_month` | int 1–12 | yearly (combined with `_day_of_month`) |
| `recurrence_interval_days` | int ≥ 1 | custom |
| `recurrence_end` | ISO date, nullable | all recurring (cancellation day) |

`date` doubles as `recurrence_start` — no new column needed.

**Month-end clamp**: `day_of_month=31` in February fires on Feb 28 (Feb 29 in
leap years). Implementation: `Math.min(target_day, daysInMonth(year, month))`.

## Frontend behaviour

### Add Expense form (`inkcartridges/js/admin/pages/financial-health.js`)

A "Repeats" select progressively reveals fields:

- **One-off** (default) → existing UI unchanged.
- **Weekly** → day-of-week dropdown.
- **Monthly** → day-of-month input (1–31).
- **Yearly** → month + day-of-month pickers.
- **Custom** → "Every N days" number input.

All recurring variants expose an optional **"Stops on"** date. A one-off
submit is byte-identical to today's payload (no new keys sent).

### Recurring-expense expansion (`inkcartridges/js/admin/utils/trend-math.js`)

Pure helper:

```
expandRecurringExpenses(rows, windowStartMs, windowEndMs) → flatRows[]
```

For each row, emit one virtual occurrence per fire-date inside the window:
- one-off / unknown recurrence → emit row as-is.
- weekly → walk forward in 7-day steps from the first matching weekday on or after start.
- monthly → for each month overlapping the window, emit one row dated `clamp(day_of_month, daysInMonth)`.
- yearly → emit on `(month, day_of_month)` for each year between start and window end.
- custom → walk in `interval_days` steps from start.

Each emitted row carries the original `amount`, `category`, `vendor`, plus a
synthesised `expense_date` (so `pickExpenseDate` picks it up) and the
recurrence keys are stripped (so a downstream bug can't re-expand).

Caller wiring at `dashboard.js`:

```js
const expandedRows = expandRecurringExpenses(expenseRows, firstStart, windowEndMs);
bucketOperatingExpenses(buckets, expandedRows, indexFor);
```

`bucketOperatingExpenses` is unchanged — it already lands each row on its
exact `expense_date`.

## P&L granularity rule

```js
if (cfg.unit === 'month') {
  for (const p of pnlPeriods) { /* per-period smearing */ }
}
```

P&L periods **are months**. Smearing them across day/week buckets invents
data and is the root cause of the $29.80 ghost. At month granularity each
P&L row maps to exactly one bucket — no smearing, no distortion. Daily and
weekly views fall through to:

- **COGS** → per-order `items[].supplier_cost_snapshot × qty × 1.15` (exact,
  lands on order day) + KPI residual revenue-share for orders missing
  `items[]` (already implemented in `dashboard.js`).
- **Stripe / GST** → revenue-derived per bucket (`assembleBucketExpense`
  in `trend-math.js`).
- **Opex** → expanded recurring rows + dated logged expenses, exact day.

Empty days now correctly show $0.

## Backend tasks (handoff)

`/api/admin/analytics/expenses` POST currently forwards arbitrary JSON keys
through to Supabase — confirm the new optional columns persist and round-
trip on GET. If the table schema rejects unknown columns, add:

```sql
ALTER TABLE analytics_expenses
  ADD COLUMN recurrence TEXT,
  ADD COLUMN recurrence_day_of_week SMALLINT,
  ADD COLUMN recurrence_day_of_month SMALLINT,
  ADD COLUMN recurrence_month SMALLINT,
  ADD COLUMN recurrence_interval_days INTEGER,
  ADD COLUMN recurrence_end DATE;
```

Until backend persists these, recurring entries work for the current admin
session only and disappear on reload. The P&L ghost fix and one-off
behaviour ship cleanly without any backend change.

## Verification

Full plan + steps in `~/.claude/plans/i-want-all-expenses-glowing-nova.md`.
Quick form:

1. `npx serve inkcartridges -l 3000` → `localhost:3000/admin#dashboard?period=7d`.
2. Confirm empty days now show $0 (was $29.80).
3. Add monthly recurring "Vercel Pro / Day 12 / $30" — confirm $30 spike on
   the 12th of each month at `period=3m`.
4. Add monthly day-31 — confirm Feb 28 / Apr 30 clamp at `period=6m`.
5. Set `recurrence_end` mid-window — confirm spikes stop after end date.
6. Switch to `period=1y` (month granularity) — confirm P&L cogs reappears.
7. `node --test tests/dashboard-trend-math.test.js tests/dashboard-pnl-no-smear.test.js` → 59/59 pass.
