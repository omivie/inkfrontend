# Backend brief — GST basis of admin money fields

**Audience:** backend dev + backend CLI Claude (the `ink-backend-zaeq` service / Supabase).
**Status:** Frontend is LIVE. Every admin money header now prints a small sub-line naming its
GST basis — `incl. GST`, `excl. GST`, `net of GST`. About 25 fields print **nothing**, because
nobody can prove their basis. This brief is the register of those blanks and the ask that
would let us fill them.
**Priority:** medium. Nothing is broken; the admin is simply honest about what it doesn't know.
**Nothing here requires a frontend deploy to consume** — each answer is a one-line change on
our side.

---

## 1. Why this exists

NZ GST is 15%, and the admin shows money on both sides of it in adjacent columns. On the
Products list `retail_price` is GST-**inclusive** and `cost_price` is GST-**exclusive**, two
columns apart, with nothing on screen to say so. Same on Orders (Total incl. / line Price
excl.), Invoices, Expenses and the Dashboard KPIs.

So each money header gained a muted second line:

```
PRICE        COST        PROFIT $
incl. GST    excl. GST   excl. GST
$11.49       $5.41       $4.28
```

The vocabulary is frozen in `inkcartridges/js/admin/utils/gst-basis.js` and pinned by
`tests/admin-gst-basis-labels.test.js`.

**A blank sub-line is a deliberate signal, not an oversight.** It means the frontend receives
that number from you and has no way to know its basis: no arithmetic in our code touches it,
no field name asserts it, and no note anywhere records it. We deliberately do **not** guess. A
wrong GST basis on an admin money figure is worse than no basis — it is how a wrong GST return
gets filed.

The test suite actively forbids anyone labelling the fields in §3 without an answer from you.

---

## 2. The two live contradictions — please settle these first

These two are worse than unknown: our own codebase asserts **opposite** answers.

### 2A. `pnl.revenue` — is it GST-inclusive or exclusive?

| Source | Claim |
|---|---|
| `js/admin/utils/expense-math.js` (+ the Expenses "% of revenue" tooltip) | denominator is **ex-GST** |
| `js/admin/pages/financial-health.js` | **incl-GST**, and it shows the arithmetic: `8342.15 × 20/23 − 5662.84 = 1591.20 = gross_profit`, which only foots if `revenue` is gross |

Endpoint: the P&L payload (`periods[].revenue`).

**Impact:** the Expenses → Overview "% of revenue" KPI divides GST-netted spend by
`Σ periods[].revenue`. If financial-health is right (it has the proof), that ratio is
understated by ~13%. The KPI currently prints with no basis.

**What we need:** confirm the basis of `periods[].revenue`, and if it is incl-GST, either
(a) add a sibling `revenue_excl_gst`, or (b) tell us to apply `× 20/23` ourselves.

### 2B. Stripe fees — three conventions, all live (ERR-114)

| Where | Convention |
|---|---|
| Backend P&L / `net_profit_series.stripe_fees` | `(2.65% × card revenue + $0.30 × orders) × 20/23` — i.e. the rate is treated as GST-**inclusive** |
| `js/admin/utils/profitability.js` (order + invoice profit) | rate treated as **ex-GST**, GST added on top |
| `js/admin/utils/pricingCalculator.js` (Control Center margin simulator) | `retail × 0.0265 × 1.15` |

The first two are ~15% / ~$26.80 all-time apart. Our tests currently **document** the
divergence rather than pick a winner.

**What we need:** a ruling on what Stripe's 2.65% + $0.30 actually is in NZ — GST-inclusive or
GST-exclusive — so all three converge. Until then every Stripe-derived figure prints no basis,
which also blanks the Control Center's "Δ profit/unit" and "Net margin" columns.

---

## 3. The register of blanks

Every row below currently prints **no** GST sub-line. For each, we need one of:
`incl` · `excl` · `excl_base` (a % whose denominator is ex-GST) · `net` (GST-neutral) ·
`mixed` · `not_money` · **`unknown`**.

> **`unknown` is a valid, welcome answer.** If you are not certain, say so and we keep the
> blank. Do not guess on our behalf.

### 3.1 Price Monitor — every money field
Endpoint: the price-monitor products feed. Admin surface: `js/admin/pages/price-monitor.js`.
There is **zero** GST arithmetic anywhere in that file.

| Field | Need | Why we can't infer it |
|---|---|---|
| `our_price` | ? | Falls back to `retail_price` (which *is* incl-GST), so probably incl — but the inline edit writes back through a different path and nothing asserts it. |
| competitor price cells | ? | Scraped competitor prices. Almost certainly incl-GST NZ shelf prices, but there is no code or note anywhere that says so. |
| `market_lowest` | ? | Passthrough. |
| `margin_floor_price` | ? | Passthrough. If it is comparable to `our_price` it must share its basis — nothing states that. |
| `estimated_margin_pct` / `margin_pct` | ? | Passthrough, no consistency gate. **This same field feeds the Dashboard's low-margin alert**, so a wrong denominator propagates. |
| bulk match/undercut target price | ? | Writes `manual_retail_price`, which **is** documented incl-GST — so the comparison basis matters. |

Same question for `js/admin/pages/cc-market-intel.js`: `our_price`, `market_price`, `variance`,
`competitor_price`.

### 3.2 Customers
| Field | Surface | Need | Why |
|---|---|---|---|
| `total_spent` | list column + detail drawer | ? | Pure passthrough. Most likely a sum of order totals (⇒ incl-GST) but unlabelled and unasserted. |
| `ltv` / `lifetime_value` | LTV chart | ? | Passthrough. |
| order-history `total` in the drawer | modal table | ? | Different endpoint from the Orders list, where `total_amount` **is** proven incl-GST. |

### 3.3 Finance → Financial Health, TOP KPI strip
These come from `analytics/overview` — a **different endpoint** from the P&L rendered directly
below them, which documents its own basis. Two "net profit" figures sit ~100px apart, sourced
differently.

| Field | Need | Why |
|---|---|---|
| `grossMargin` (30d) | ? | No gate, no documented denominator. Must not be assumed to match the Dashboard's ex-GST-based Gross Margin. |
| `netProfit` (break-even panel) | ? | Not the P&L's `net_profit`. |
| `monthlyBurn` | ? | Passthrough. |
| `forecast30/60/90` | ? | Presumably tracks `revenue`, so presumably incl — unstated. |
| cash-flow `inflow` / `outflow` | ? | Cash movements, so probably incl — unstated. |
| `cashBalance` | probably `not_money`-style N/A | A bank balance has no GST basis; confirm and we'll mark it exempt rather than blank. |

Also `js/admin/pages/analytics.js` KPI tiles (`Revenue`, `AOV`, `Rev Volatility`) — from
`getDashboardKPIs` / `getRevenueSeries`, again not the P&L path.

### 3.4 Dashboard chart breakdowns
The KPI strip is labelled (Revenue incl., Gross/Net Profit excl., margins excl.-base). The
**charts below it are not**, because they are passthrough with no `checkMarginConsistency`
gate — exactly the ERR-111/ERR-113 failure mode, still ungated here.

| Field | Need | Why |
|---|---|---|
| gross margin by brand — `margin_pct` | ? | An incl-GST denominator understates margin ~13% and would go undetected. |
| gross margin by category — `margin_pct` | ? | Same. |
| worst-margin SKUs — `net_margin_pct` / `estimated_margin_pct` / `margin_pct` | ? | We currently field-sniff across three possible names. |
| Top SKUs `revenue` and `gross_profit` | ? | Inferred incl / excl from the KPI convention — but a revenue bar and a profit bar sit side by side on (presumably) different bases with no label. |
| `new_revenue` / `returning_revenue` | ? | Passthrough. |
| Recent Orders `total` | ? | Same field name as the Orders list, but rendered from a different payload. |

### 3.5 Refunds
| Field | Surface | Need | Why |
|---|---|---|---|
| refund `amount` | Refunds list, refund form | ? | No documented basis anywhere. |
| Dashboard "Refund Rate" numerator | KPI | ? | Denominator is incl-GST revenue; numerator basis unknown, so the ratio's meaning is unknown. |

### 3.6 Smaller passthrough surfaces
| Field | Surface | Need |
|---|---|---|
| `discount`, `min_order_amount` | Promotions | ? (is a $ discount applied to an incl- or excl-GST subtotal?) |
| `discount` | Coupons | ? (same) |
| `old_price` / `new_price` | Control Center → Inventory price-change feed | ? |
| `net_margin`, `gap` | Control Center → Profit | ? (no consistency gate) |
| all summary/average figures | Margin Analysis page | ? (100% passthrough; only Cost/Retail are labelled, by inheritance from the Products convention) |

---

## 4. How to answer — suggested response shape

Either form works. **(A) is preferred** because it needs no second lookup table and follows a
convention you already use.

### (A) Per-field suffix — preferred
The invoices endpoint already does exactly this: `total_incl_gst`, `subtotal_excl_gst`,
`freight_excl_gst`, `unit_cost_excl_gst`, `supplier_cost_excl_gst`. Extend it. Rename, or
dual-emit alongside the current name during a transition:

```jsonc
{
  "market_lowest_incl_gst": 34.99,
  "margin_floor_price_incl_gst": 28.50,
  "estimated_margin_pct": 31.2          // a % — see (B) or use _excl_gst_base
}
```

The frontend derives the sub-line from the field name alone.

### (B) Sibling `gst_basis` map — fallback where renaming would break clients

```jsonc
{
  "our_price": 42.99,
  "market_lowest": 34.99,
  "estimated_margin_pct": 31.2,
  "gst_basis": {
    "our_price": "incl",
    "market_lowest": "incl",
    "estimated_margin_pct": "excl_base"
  }
}
```

Enum: `incl | excl | excl_base | net | mixed | not_money | unknown`. We map it straight onto
the constants in `gst-basis.js` — one switch, no per-field frontend code.

### (C) Explicitly rejected — a payload-level flag
Please do **not** send one "everything in this response is incl. GST" flag. The Finance P&L
already proves a single payload mixes bases row by row (Revenue incl., COGS excl., profit
excl.), so a payload-level flag would be wrong on day one.

---

## 5. What we already label (for your reference — no action needed)

So you can see the conventions we're treating as settled:

| Surface | Field | Basis | Established by |
|---|---|---|---|
| Products | `retail_price` | incl. GST | `profitability.js` divides by 1.15 before use |
| Products | `cost_price` | excl. GST | subtracted from an ex-GST price with no gross-up |
| Products | `profit_incl_fixed_ex_gst`, margin % | excl. GST (base) | field name + the local fallback's arithmetic |
| Orders | `total_amount` | incl. GST | modal label + profit maths |
| Orders | `shipping_fee` | incl. GST | `shipping_rates` stores gross; GST inside = `× 3/23` |
| Orders | `sell_price`, `supplier_cost_snapshot` | excl. GST | documented in `order-profit.js` |
| Orders / Invoices | profit | **net of GST** (GST-neutral) | ex-GST both sides; GST nets to zero |
| Invoices | `subtotal_excl_gst` / `total_incl_gst` / `freight_excl_gst` | excl / incl / excl | field names |
| Expenses | `amount` | incl. GST | stored gross; P&L cost = `× 20/23` when `gst_claimable` |
| Dashboard | `revenue` | incl. GST | `8342.15 × 3/23 = 1088.11` |
| Dashboard | `gross_profit`, `net_profit` | excl. GST | migration 118: `gross_profit = revenue_ex − cogs_ex` |

One note on wording: our profit figures say **"net of GST"**, not "excl. GST". Order and
invoice profit is GST-*neutral* — ex-GST on the revenue side and the cost side, so GST passes
through and nets to zero. Labelling it "excl. GST" would imply a further 15% is still to come
off, which is not true.

---

## 6. What happens when you answer

Per field: we add one property to a column definition (`gst: GST_INCL`) or one entry to a KPI
tile. No schema work, no migration, no redeploy on your side beyond the field itself. The
`unknown` answers stay blank and stay listed here.

Questions → reply to whoever sent you this brief. Frontend contact points:
`inkcartridges/js/admin/utils/gst-basis.js` (the vocabulary) and
`tests/admin-gst-basis-labels.test.js` (what is pinned).
