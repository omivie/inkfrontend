# Backend asks — one index, 2026-09-09

Five frontend sessions worked this repo today and each wrote its own hand-off.
**This file restates nobody's measurements.** It says what is open, who measured
it, and which document carries the numbers — so nothing has to be reconstructed
by reading five briefs, and so the one item that sits in *none* of them is
visible.

Ordered by urgency, not by author.

---

## 🔴 0. Live breakage — in no brief, only in `errors.md`

**The admin analytics RPCs are dark. Fourth recurrence.** (ERR-232, `errors.md`)

Measured today with a real super-admin JWT and each function's real named params:

```
analytics_kpi_summary  ·  analytics_revenue_series  ·  analytics_refunds_series
analytics_top_products ·  analytics_customer_stats  ·  analytics_brand_breakdown
    all → 403  42501 permission denied for function
get_suppliers          → 403  42501   ← collateral: it is all of public again
```

Controls on the same token: `products` select → 200, `cost_price` → 403 (correct).
The JWT is valid; the denial is specific to function EXECUTE.

The round-2 security hand-off §2 stated these still worked — that was not
re-measured. **The fix is to re-run backend migration 163**, never to widen the
grant from this repo. This is the ERR-010 / ERR-029 / ERR-035 family, live now.

*No brief carries this because it was found as collateral during ERR-229. It is
the most operationally urgent thing on this page.*

---

## 🟢 1. One green light we owe you

**Migration 132 is safe to run.** (ERR-243 — `printer-canonicals-backend-brief-sep2026.md`)

The PDP no longer reads `products.compatible_devices_html`; it is on
`GET /api/products/:sku/for-use-in`. Verified in a real browser: 0 requests
naming the column, and `npm run probe:for-use-in` compares every list old-source
vs new-source — 91 rows, 87 byte-identical, 4 differing only by your sanitiser,
**0 missing**. You were holding this migration on our word; you have it.

---

## The rest, by document

| # | Ask | Doc | Raised by |
|---|---|---|---|
| 2 | Prerender canonical for 15 duplicate printer URLs; drop losers from `sitemap-printers.xml`; send your 21-pair table (we measure 15) | `printer-canonicals-backend-brief-sep2026.md` | ERR-242 |
| 3 | `admin_only` schema, RLS, an admin catalogue mirror route (BF-013 as written does not suffice), write-path refusal, analytics exclusion — **carries a sequencing constraint to read before deploying** | `admin-only-test-product-backend-brief-sep2026.md` | ERR-234 |
| 4 | Send the zone rate unconditionally; apply the freight rule server-side; confirm the DSNZ/Augmento asymmetry is intended | `supplier-freight-backend-brief-sep2026.md` | ERR-241 |
| 5 | Does `search_analytics` now carry a `session_id`, and **what actually writes that table** — `?sid=` ran for six months and produced zero rows | `fe-backend-asks-sep2026.md` §2 | ERR-237 |
| 6 | Keep `X-Session-Id` / `X-Visitor-Id` in the allow-list — search now depends on them | `fe-backend-asks-sep2026.md` §3 | ERR-237 |
| 7 | `delivery_type` is not stored on the order, and we now send a real one | `fe-backend-asks-sep2026.md` §1 | ERR-235 |
| 8 | `/api/search/smart` takes ~3.0s | `fe-backend-asks-sep2026.md` §4 | ERR-237 |
| 9 | **BF-021 — `PATCH` is not in `Access-Control-Allow-Methods`** (`GET,POST,PUT,DELETE,OPTIONS`). The quick-order outcome modal is built, correct and unreachable from a browser. Note `quick_orders` is empty in production | `fe-backend-asks-sep2026.md` §6 | earlier rounds |
| 10 | Rate limiter advertises 30 but 429s at 21 with `limit: 20`; `offshore_bounce_views_excluded` absent from `/catalog/brands`; `/acquisition/search-terms` should emit `null` not `0` for `paid_*` while Ads is unconnected; four decoy params on `/catalog/products` mean there is no pagination | `analytics-dashboards-FE-response-sep2026.md` | ERR-204 |

---

## Two small corrections to your own surfaces

Both sent someone back to us for work that was already done:

- **`meta.coverage.clicks` still advertises an 80-character click truncation.**
  It has been **200** since ERR-204 (2026-09-03). That stale field is what put
  "raise the truncation" on the September checklist.
- **`/api/products/popular` hard-400s on `consumable` and `label_tape`**, two of
  our own internal category ids. `drums` / `paper` are the right names and we map
  before calling — flagging only in case you would rather accept the aliases.

## One trap worth documenting on your side

**A 429 from `/api/products/:sku/for-use-in` has no `for_use_in_html` key.** Any
reader doing `resp.data.for_use_in_html ?? null` scores a *refusal* as an
*absence*. Ours did, on its first run, and reported "43 of 91 lists missing" —
we nearly sent that as a data-loss alarm. Real traffic never sees it (the
endpoint is edge-cached, `cf-cache-status: HIT`, and a 45-request burst on one
SKU never reached your origin), but any tool walking many distinct SKUs will.

## Still open from earlier rounds

ERR-170 (`cost_price` phase 2, blocked on BF-044) · ERR-175 / BF-046 (invoice
send history) · ERR-161 / BF-040 (order lines missing `source`) · ERR-114 (15%
disagreement on whether Stripe's 2.65% is GST-inclusive).

---

*Index only. Every number above lives in the document named beside it, measured
by the session that wrote it.*
