# Backend — `kpi-summary.gross_profit` vs `gross_profit_series` disagree by ~2× (2026-07-20)

**Audience:** the backend repo's Claude / dev. **Author:** the frontend (Vercel SPA) repo.
**Status:** P0. This is the **direct follow-up to §1 of `backend-open-items-jul2026.md`.**
**TL;DR:** You fixed the null. The value that replaced it does not agree with your own
`gross_profit_series` — it is roughly **double**. §1's acceptance criterion is not yet met.

```bash
# Used throughout
API=https://ink-backend-zaeq.onrender.com/api
# All figures below: period=all, measured 2026-07-20 from the live admin dashboard.
```

---

## 0. What changed since 2026-07-14 — good news first

§1 of `backend-open-items-jul2026.md` reported `kpi-summary` returning
`gross_profit: null` / `net_profit: null` for any range containing an invoiced sale.
**That null is gone.** `period=all` now returns real numbers, the owner's dashboard tiles
have un-blanked, and our summing workaround has correctly self-disabled.

Thank you — that part works. The problem is the *value*.

§1 stated the acceptance criterion as:

> **Acceptance.** For `date_from=2026-06-22&date_to=2026-06-28`, `kpi-summary` returns a real
> `gross_profit` — **and it agrees with what `gross_profit_series` already reports for that bucket.**

The first half passes. **The second half fails.**

---

## 1. P0 — the two aggregates disagree by ~$1,307 (~2×)

### Symptom

On `/admin#dashboard?period=all` the **NET PROFIT** tile reads **$1,402.17**, but the
Performance-overview chart's cumulative **Net profit** line sits near zero — its 18 Jul point
reads **$92.40**. Both are supposed to be the same quantity. The tile reads your
`kpi-summary` scalars; the chart line is rebuilt from your `gross_profit_series`.

| Quantity, `period=all`, same request | Source | Value |
|---|---|---|
| Gross profit | `kpi-summary.gross_profit` | **$2,679.31** |
| Gross profit | `Σ gross_profit_series[].gross_profit` | **~$1,373** |
| Implied gross margin on ex-GST revenue | `kpi-summary` | **36.9%** |
| Implied gross margin on ex-GST revenue | series | **18.9%** |

**The series is running at half the margin rate the scalar claims. Shortfall ≈ $1,307.**

### How we measured it (no backend access required — it is readable off the chart)

We did not have a payload dump, so we derived `Σ gross_profit_series` from the chart's own
tooltip. The chart's COGS line is computed from the series via
`cost_incl_gst = revenue_gross × 20/23 − gross_profit` (your `profitability.js` convention).
At 18 Jul, cumulative: Revenue `$8,082.17`, Added expenses `$173.91`, Total expenses `$5,872.15`.

```
COGS                       = 5,872.15 − 173.91          = 5,698.24
Σ gross_profit_series      = 8,082.17 × 20/23 − 5,698.24 = 1,329.73   (to 18 Jul)
```

**Independent cross-check.** The chart derives its net line as
`Σ gross_series − (stripe_fees + operating_expenses) × revenue_weight`. From the tiles,
`fees + opex = 2,679.31 − 1,402.17 = 1,277.14`, and 18 Jul carries
`8,082.17 / 8,342.15 = 96.8835%` of range revenue:

```
1,329.73 − (1,277.14 × 0.968835) = 92.40   ← reproduces the tooltip to the cent
```

Two independent readings of the same tooltip agree exactly, so `Σ gross_profit_series ≈ 1,330`
(to 18 Jul) is a measurement, not an estimate.

**Third corroboration — your own 14 Jul capture.** The 19-week `gross_profit_series` we captured
live on 2026-07-14 sums to **$1,190.07** against revenue of `$7,091.58` → **19.3%** of ex-GST
revenue. Our 18 Jul figure gives **18.9%**. The series has been stable at ~19% all along.
`kpi-summary` now claims **36.9%**. The series did not change; the scalar appeared.

**We also ruled out the obvious alternative.** One hypothesis was that `kpi-summary.net_profit`
simply omits `operating_expenses`. That would require `Σ gross_series ≈ 2,600`, which implies
Total expenses of `$4,601.88` at 18 Jul. The chart reads **$5,872.15**. Rejected.

### Which side is wrong — we do not know, and we are not assuming

§1 asserted your series was the trustworthy one. **We are explicitly withdrawing that assumption.**
Either could be the defect, and the two point in opposite directions for the owner:

- **If `kpi-summary` is over-stating**, the owner is being shown ~$1,300 of profit that does not
  exist, and every pricing decision made off that dashboard is wrong in the dangerous direction.
- **If the series is under-stating**, the chart is libelling a healthy business.

**Our strongest lead points at `kpi-summary` over-stating, on invoiced sales.** The shortfall
(**$1,306.80**) is close to `invoice_revenue` (**$1,268.48** as of 14 Jul, higher now). That is the
signature of invoice-line COGS being read as **0** rather than as a real cost — which would make
`gross_profit ≈ revenue_ex` for those lines and inflate the aggregate by roughly the invoice
revenue. It would also be the natural failure mode of a fix that resolved §1's null by
coalescing (`COALESCE(cost, 0)`) instead of by repairing the join.

**If that is what happened, it is ERR-068 and §1 warned about it explicitly:**

> Whatever the cause: **never coerce the fix to `0`** (ERR-068 — `Number(null) === 0` once
> produced a false "0.0% margin, reprice-or-drop" alert on the owner's dashboard).

A null that becomes `0` inside a COGS sum does not blank the dashboard — it *inflates profit
silently*, which is strictly worse than the null it replaced. Please check for this first.

Note the three known invoice orders carry real costs — INV-3263 `$139.80`, INV-3264 `$58.96`,
INV-3265 `$776.64` (≈ `$975.40` incl-GST, ≈ `$848` ex-GST). The costs exist in the data. The
question is whether the `kpi-summary` code path is reading them.

### Repro

```bash
# 1. The headline disagreement. Compare the scalar against the sum of your own series.
curl -s "$API/admin/analytics/dashboard-bundle?period=all" -H "Authorization: Bearer $TOKEN" \
  | jq '{
      kpi_gross:   .data.kpi_summary.current.gross_profit,
      kpi_net:     .data.kpi_summary.current.net_profit,
      fees:        .data.kpi_summary.current.stripe_fees,
      opex:        .data.kpi_summary.current.operating_expenses,
      series_sum:  ([.data.gross_profit_series[]?.gross_profit] | add),
      series_nulls:([.data.gross_profit_series[]?.gross_profit] | map(select(.==null)) | length)
    }'
# EXPECT (defect): kpi_gross ~2679, series_sum ~1373. They must be equal.

# 2. Isolate to the invoice weeks — §1's own acceptance window.
for W in 2026-06-15 2026-06-22 2026-06-29 2026-07-06 2026-07-13; do
  curl -s "$API/admin/analytics/kpi-summary?date_from=$W&date_to=$(date -j -v+6d -f %Y-%m-%d $W +%Y-%m-%d)" \
    -H "Authorization: Bearer $TOKEN" \
    | jq -c "{week:\"$W\", gross:.data.current.gross_profit, invoices:.data.current.invoice_orders}"
done
# The two invoice weeks previously returned null and the series returned
# 2026-06-22 -> $193.52, 2026-07-06 -> $183.11. If kpi-summary now returns
# markedly MORE than those for the same weeks, the invoice-COGS-as-zero lead is confirmed.

# 3. Direct check on the lead.
#    For the invoice-channel orders (payment_method = 'invoice'), confirm the COGS aggregate
#    inside kpi-summary reads a non-zero supplier_cost_snapshot per line — the same value
#    gross_profit_series reads. If one path COALESCEs a null to 0 and the other drops the row,
#    that single difference explains the whole gap.
```

### What to change

1. **Make one code path the source of truth.** `kpi-summary.gross_profit` and
   `gross_profit_series` must be the same aggregate over the same rows. Today they are two
   queries that disagree by 2× — the exact condition §1 flagged ("one aggregate, two code paths,
   different answers"), now surviving in a new form.
2. **Audit the §1 fix for `COALESCE(cost, 0)` or equivalent** in the COGS aggregate. If a line's
   `supplier_cost_snapshot` is genuinely unknown, the correct output is still **`null`**, not `0`
   and not a silent omission from the sum. UNKNOWN ≠ ZERO in both directions (ERR-068).
3. **Ship a range-level self-check** if cheap: if `Σ gross_profit_series` over a range does not
   equal that range's `kpi-summary.gross_profit` to the cent, that is a bug by construction and
   worth an assertion in your test suite. It would have caught this before the owner saw it.

### Acceptance

- For `period=all`: `kpi-summary.gross_profit == Σ gross_profit_series[].gross_profit`, to the cent.
- Same for `date_from=2026-06-22&date_to=2026-06-28` (§1's original window) and for any range
  containing an invoiced sale.
- Whichever value moves, state **which one was wrong and why** in your reply — the frontend needs
  to know whether the owner's historical dashboard readings were inflated, because that affects
  pricing decisions already made.
- Any line whose cost is genuinely unknown yields `null` for the range, never a `0`-coerced profit.

---

## 2. P1 — is `operating_expenses` the same quantity we compute? (likely ~6× apart)

**Symptom.** From the tiles, `stripe_fees + operating_expenses = $1,277.14`. Stripe fees on
`$8,342.15` / 63 orders should be roughly `$220–240` (2.65% + $0.30), which leaves
`operating_expenses ≈ $1,040–1,057`. But the frontend's own **Added expenses** line — summed from
`GET /api/admin/analytics/expenses` — totals only **$173.91** over the same range.

**This is inferred, not measured:** we cannot split the two scalars from the tiles alone. Step 1 of
the repro above prints both; please read them and tell us the split. If `operating_expenses` really
is ~$1,040, we have a second reconciliation problem and the dashboard is currently showing two
mutually contradictory expense figures on the same chart.

**Questions we need answered:**

1. What exactly does `kpi-summary.operating_expenses` sum? Specifically: is it **cash-basis**
   (paid only) or accrual? Is it **GST-net** or gross? Does it **include `kind = 'order_linked'`
   rows** (which we treat as COGS, not opex, and deliberately exclude to avoid double-counting
   them against the COGS aggregate)?
2. Does `GET /api/admin/analytics/expenses` accept `date_from` / `date_to`? The frontend currently
   calls it with `{ limit: 1000 }` and no range, then buckets client-side — which means expenses
   outside the chart's window are mishandled. **This one is our bug to fix**, but if you already
   support range params, say so and we will use them instead of paginating blind.

**Acceptance.** A one-line definition of `operating_expenses` we can mirror exactly, and a yes/no
on range params for the expenses endpoint.

---

## 3. Status carry-over — `net_profit_series` (was §1b)

Still no `net_profit_series` key in `dashboard-bundle`. Unchanged ask, unchanged low priority:
**either ship it or tell us it isn't coming** and we will stop reserving the slot. We no longer
need it to draw the line — we reconstruct net from `gross_profit_series` minus your two scalars —
but that reconstruction is exactly what item 1 above shows to be fragile. If you ship a
`net_profit_series` that reconciles to `kpi-summary.net_profit` by construction, we will drop the
reconstruction entirely and this class of bug disappears.

---

## 4. What the frontend is doing meanwhile

We are **not** papering over this. Specifically we will **not**:

- scale the series to match the scalar, or vice versa;
- fall back to `net_profit_series` (retired on our side);
- let the KPI tile quietly read from a different source than the chart.

We are adding a visible in-chart warning: when `Σ net` disagrees with `kpi-summary.net_profit` by
more than $1, the dataset is relabelled and a caption names both figures and the gap. The owner
will see "these two numbers disagree" rather than a confident wrong line. A console warning for
this already exists (`[Dashboard] net-profit line ($X) does not reconcile to the Net Profit KPI
($Y)`) — it fired correctly here; it was just too quiet to reach anyone.

**Please do not treat the FE warning as the fix.** It makes the defect visible; it does not make
the owner's profit figure correct. Until item 1 is resolved the owner cannot trust either number.

---

## Appendix — the raw numbers, so you can check our arithmetic

Dashboard tiles, `period=all`, 2026-07-20:

```
REVENUE        $8,342.15      ORDERS              63
GROSS PROFIT   $2,679.31      GROSS MARGIN     32.1%   (= 2679.31 / 8342.15, on GROSS revenue)
NET PROFIT     $1,402.17      NET MARGIN       16.8%   (= 1402.17 / 8342.15)
                              => stripe_fees + operating_expenses = $1,277.14
```

Performance-overview chart, cumulative, 18 Jul bucket:

```
Revenue $8,082.17 · Net profit $92.40 · Added expenses $173.91 · Total expenses $5,872.15 · Orders 62
```

Conventions we relied on (yours, from `profitability.js`): `gross_profit = revenue_ex_gst −
cost_incl_gst`; `revenue_ex_gst = revenue_gross × 20/23`; GST fraction of a gross figure is
`3/23`, never `× 0.15`.

Prior context, in this repo: `readfirst/backend-open-items-jul2026.md` §1 / §1b / §1c.
