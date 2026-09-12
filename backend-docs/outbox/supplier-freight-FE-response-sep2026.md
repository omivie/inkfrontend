# Supplier freight — FE response (ERR-255, Sep 2026)

**From:** frontend · **Date:** 2026-09-12 · **Answers:**
`supplier-freight-FE-handoff-sep2026.md` + `supplier-freight-backend-response-sep2026.md`

**Status: §1–§5, §7 and §8 are DONE and live. §6 is DECLINED for now, deliberately, by the
owner — see §6 below; it is the one thing in your hand-off we did not do.**

Everything in your response document that we could measure, we measured, and it was true.
Four things came out of doing it that you will want.

---

## 0. What we verified before wiring anything

Not taken from the hand-off — re-measured against the live API on 2026-09-10 and again on
09-12.

| Your claim | Our measurement |
|---|---|
| `supplier_freight` on detail **and** list rows | ✅ 150/150 live list rows, every detail |
| on `kpi-summary` / `pnl` / `dashboard-bundle` / `overview` | ✅ all four |
| `gross − net = stripe + opex + supplier_freight` | ✅ `2210.76 − (−56.06) = 2266.82 = 170.68 + 1593.50 + 502.64` — **exact** |
| `delivery_type_basis` spread | ✅ 63 `charged` / 17 `snapshot` / 69 `assumed` over 149 — exactly as documented |
| `supplier_basis` spread | ✅ 15 / 51 / 37 / 48 — exactly as documented |
| `unpriced_consignments: 0` across all 149 | ✅ and `complete:false` on **0** |
| `2026090902` = south-island rural 0.4 kg → $14.00 | ✅ |

One harmless slip in your §2 envelope sample: it shows `supplier_basis: "snapshot"` for
`2026090902`; live says `default`. No code impact, but the sample is what people copy.

## 1. The double-charge was real, and bigger than "delete the estimator"

Your §1 says running both double-charges every order. We can now put a number on the
containment, because it is the evidence the deletion rests on. Over **115 order-samples**:

- **0** orders where `shipping_absorbed` applies and `supplier_freight` does not;
- 41 orders carry both, and the amounts are **identical on 39**;
- the 2 exceptions are the same order both times — `2026090102`, two suppliers, where
  absorbed is **one** parcel rate ($7) and freight is **two** consignments ($14).

So `shipping_absorbed` is a strict **subset** of `supplier_freight`, and your tile identity
confirms it from the other side by having no absorbed-courier term at all. **The
"Courier absorbed" row is gone from the order modal** and the absorbed amount no longer
reduces take-home or credits GST. It is still parsed — the zone, area and amount are worth
showing — and the free-shipping fact now rides in the freight row's tooltip ("counted here
once, not twice") rather than being deleted along with the deduction.

## 2. 🚨 Two deletions that were NOT in your checklist — one of them cost 44% of the bill

Your §1 lists three things to remove. There was a fourth, and we would not have found it
from the document:

**`customerPaidFreight()`** short-circuited the entire rule whenever the customer paid for
delivery, on the reasoning that a charged delivery is a pass-through. Measured:

- **27 of 60 orders have customer-paid shipping AND a real backend freight bill**
- that is **$221.77 of $506.98 — 44% of the total freight**
- and **0** orders have customer-paid shipping *without* a freight bill.

The customer paying our courier to reach them says nothing about a supplier billing us to
reach our door. Two parcels, two invoices. **It was worse than the ladder's understatement
and worse in kind** — the floor was wrong by a visible amount on orders it did price; this
returned a clean "no freight owed" with no gap, no qualifier and no estimate flag, so there
was nothing on screen to be suspicious of.

The second deletion is the whole `estimated` vocabulary. Nothing left to estimate.

## 3. Two data findings from a check we built because of your §5

We now reconcile your per-consignment `goods_cost_ex_gst` against our own per-supplier cost
roll-up — the figure the Orders-list "Supplier cost" column is pinned to. It is
`npm run probe:supplier-freight` §6. On its first run, 34 of 36 consignments agreed and the
two that did not are both worth your time.

**3a. `20260821000002` — our column is the wrong one, and it is user-visible.**
You report `goods_cost_ex_gst: 18.41` for Augmento; we compute $2.63. The order has a
second line (`CLC77CMY`, $15.78) whose `suppliers[]` is **empty**. Our roll-up refuses to
attribute unnamed lines; your ladder attributes them (`default` → the sole compatible
supplier). **Your figure is the more complete one**, which means our Orders-list Supplier
cost column is *understating that order today* on a screen an operator reads as a number.
That is ours to fix, not yours — but if you can tell us **how many of the ~3,398 orders have
at least one line with no `suppliers[]` entry**, we will know whether this is three orders
or three hundred before we choose a fix.

**3b. `INV-3276` — `goods_cost_ex_gst: 0.00` where the line carries $70.51.**
The line has `supplier_cost_snapshot: 70.51` and names DSNZ; your consignment reports goods
of `0` with `reason: always_billed`. **Harmless here** — DSNZ bills on every purchase order,
so no threshold consulted the number and the $7 is right regardless. It is an `INV-`
invoice-shadow order, so we suspect the goods-cost join does not cover those.

**But the same gap on an Augmento consignment would read as `$0 < $100` and bill freight on
an order that may owe none.** That is absence-as-zero with a billing decision on the end of
it, and it is the exact failure family this codebase keeps getting bitten by. Worth a guard
on your side: a consignment whose goods cost could not be resolved should probably be
`unpriced` rather than `0`.

## 4. 🚨 §6 (the Stripe fee GST) is DECLINED for now — and we think the reasoning matters

We did the reconciliation you asked for and it is perfect:

```
Σ over 53 card orders of (total × 2.65% + $0.30) / 1.15  =  $170.68
kpi-summary.stripe_fees for the same window              =  $170.68
```

To the cent. **And we are still not making the change**, because that result proves what the
*backend* does, not what *Stripe* charges. Whether Stripe NZ adds 15% on top of
2.65% + $0.30 or includes it is a fact about a Stripe invoice, and no amount of agreement
between two of our own surfaces can settle it. We had mistaken agreement-with-the-backend
for correctness.

The owner's decision is to verify against a real payout first. The settling check is one
line: **for the $134.49 charge on `2026090902`, does the Stripe fee read $3.86 or $3.36?**
If it is $3.36 you are right and we will align immediately.

Until then the ~$0.48/order modal-vs-dashboard divergence is **documented rather than
closed**, and `2026090902` lands at **$24.92 / 21.3%** on our side rather than the
$25.42 / 21.7% in your §4. Everything else in that table we reproduce.

## 5. What we did with the rest

| Your § | Status |
|---|---|
| §1 delete the estimator, the fallback, the qualifier | done — plus the two extras in §2 above |
| §2 read `amount_ex_gst`, new row, reduce IRD line | done; take-home drops by the ex-GST amount |
| §3 per surface | order modal, Orders list, Dashboard KPI, P&L, net-profit chart — all reading it |
| §4 the tile identity gained a term | done, and it is the local rebuild's formula too |
| §5 the three states | done, plus a **fourth** — see below |
| §6 Stripe ÷1.15 | **declined, see §4 above** |
| §7 expect these to move | confirmed; no surprises |
| §8 verifying | `freight applied: 38 (0 estimated)` on a 40-order sample |

**We render a FOURTH state you did not list.** Your §2 says `supplier_freight` is absent for
`order_manager` and to "render nothing, not a zero". We do — but absence and
`{applies:false}` produce the same dollar figure and mean opposite things, so we branch on
`hasOwnProperty`, not on the value. And absence can never actually be the permissions case
for us: the profit column and the modal breakdown are both `super_admin`-gated, so the field
is present exactly when the profit UI renders at all. If we see a breakdown with no envelope,
the viewer is an owner and the payload is stale — which we render loudly as a ceiling, never
as $0.

**`METRIC_KEYS`.** Your §2 notes the kpi-summary RPC-error fallback returns
`supplier_freight {current, previous}` — the metric-keyed shape. Our `normalizeKpiSummary`
rebuilds from a fixed allow-list, so we had to add all three freight keys or they would be
dropped **precisely when your RPC is degraded**, on a fallback whose `net_profit` already has
freight removed. Fixed. Flagging it because it is a general hazard for any field you add to
that fallback.

## 6. What we cannot verify, and are not pretending to

`complete:false`, `unpriced_consignments > 0` and a missing envelope fire on **0 of 149 live
orders**. Multi-consignment fires on 3. So four render paths cannot be exercised by any
live-data probe. They are unit-tested, the multi-consignment path has a named fixture rather
than relying on the sample containing `2026090102`, and **the probe prints them as SKIPPED by
name** rather than reporting green over checks that declined to run.

If you ever want the `complete:false` path exercised end-to-end, a single order with one
deliberately unpriceable consignment on a staging dataset would do it.

## 7. Verifying on our side

- `npm run probe:supplier-freight` — READ-ONLY, mode printed, 6 sections. §1 now validates
  **your** `parcel_rate_incl_gst` against the live `/api/settings` rate card; §2 asserts the
  absorbed courier moves nothing and re-measures containment; §5 reconciles our modal's own
  sum against `kpi-summary`; §6 is the goods-cost check in §3 above.
- `node --test tests/*.test.js` — 5,965 pass, 0 fail.
- Browser-verified against the real ESM modules and the live `2026090902` payload: $24.92,
  21.3%, waterfall footing to the cent on four outflows.

## 8. Addendum, 2026-09-12 — the two aggregate surfaces, and a re-run at 60 orders

Everything above was written when the order-level half had landed. Two aggregate surfaces
had not, and §5's table row claiming the P&L was "reading it" was ahead of the code. Both
are in now (commit `0e9ab7a`), so that row is true as of this addendum rather than as of
the table.

**The P&L had stopped accounting for its own bottom line.** `pages/financial-health.js` is
the only surface in our admin that lays gross → net out line by line, and it listed Revenue
/ COGS / Gross / Stripe / Opex / Net. The gap between the last two silently held **$502.64**
— an owner could subtract every printed row from gross profit and not arrive at net. It now
carries `Supplier Freight (excl. GST)` between Operating Expenses and Net Profit, and the
test asserts the rows **reconcile** your identity rather than merely that the row exists.

**Our bucket cash waterfall had the same hole.** `utils/trend-math.js` accounted for COGS +
opex + Stripe + GST and no freight. It now carries a freight term and — the part that would
have been quietly wrong — treats freight as the **fourth reclaimable GST input credit**,
alongside COGS and Stripe. Without that, each bucket remits GST on money it never kept.

**One thing your payload made easy that we want to acknowledge.** `trend-math` builds from
**list** rows, and the ERR-241 brief told you it could not see freight at all because the
list carried no `suppliers[]`, no `supplier_cost_snapshot` and no `shipping_absorbed`. You
put the whole envelope on every list row — measured 60/60 — and that is what closed it. It
was not on our ask list; it is the item that unblocked the surface we had documented as
unfixable.

**A naming hazard, offered as feedback rather than a complaint.** `supplier_freight` and
`supplier_freight_incl_gst` differ by 15% ($502.64 vs $578.00), sit on the same object, and
are both plain numbers. Our two surfaces need *different* ones — the P&L is an ex-GST
statement, the waterfall is incl-GST cash — and either field is silently accepted where the
other belongs. We pinned each with its own test. If you add more paired ex/incl figures,
that suffix is carrying a lot of weight.

**Re-run at 60 orders (the numbers above were a 40-order sample).** `freight applied: 58
(0 estimated)`, tile identity holds, three paths SKIPPED by name. §6 grew with the sample
and found one more instance of each finding in §3: **49 of 52** consignments agree, two
disagree because a line names no supplier (`20260821000002`, `20260815000003` — both
Augmento, backend $18.41/$13.15 vs our $2.63), and `INV-3276` is still the zero-goods-cost
case. So §3a is at least two orders, not one — the question there about how many of the
~3,398 orders carry a line with no `suppliers[]` entry is the one we would most like
answered.

Suite is now **5,993 pass / 0 fail / 19 skipped** of 6,012.

---

Thank you for the response document — §0 was right that it needed reading first, and the
containment measurement only exists because you said plainly that keeping both would
double-charge.
