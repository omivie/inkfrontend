# FE response — Supplier price comparison (Aug 2026)

**From:** frontend · **Date:** 2026-08-31 · **Tracking:** ERR-190
**Status: the page is BUILT and works.** `/admin#supplier-prices`, owner-only, three
tabs, live against production. Nothing below blocks it.

Everything here was measured against production with a live `super_admin` token on
2026-08-31, and is re-measured on demand by `npm run probe:supplier-prices`
(read-only — no write verb, no `--record`, it never calls `/map` or the importer).

Read §1 and §5 if you read nothing else. §1 is the one that changes what the owner
sees; §5 is the one that blocks a feature you asked for.

---

## 0. What shipped

| Tab | Endpoint | Rows | What it does |
|---|---|---|---|
| **Compare** | `compare?coverage=multi` | 172 | The main screen, saving-first, ages on every price |
| **Single source** | `compare?coverage=single` | 438 | Sourcing gaps. Absent suppliers render `—`, never `$0.00` |
| **Needs review** | `unmatched` | 25 of 345 | Opens on the actionable rows, with a hand-mapping flow |

Plus a feed-freshness strip, a per-product drawer, CSV export of the full filtered
set, and manual mapping with a session-scoped undo.

Your contract was accurate everywhere it made a claim. The counts drifted by one
(`coverage=single` is **438**, not 439; `multi` + `single` = `all` = 610 exactly),
and `age_days` on the top row is 193 today rather than 192 — both just time passing.

---

## 1. The finding that shaped the whole page

Across all 172 comparable products:

```
131 rows show "switch supplier and save"
130 of those 131 rest on a price list 193 days old
  1 is backed by a price from this month

$293.97 per-unit saving  =  $96.28 fresh  +  $197.69 stale
```

Your §4 warned about staleness and it was the right call, but it is worse than a
badge can carry: **four fifths of the value on this screen is February money.** A
page that renders `sum_per_unit_saving` as one figure and sorts by it points the
owner at a stale price 130 times out of 131, and every one of those rows looks
identical to the single real opportunity.

So the headline is split and never blended:

> **$96.28** potential saving per unit across 35 products whose cheapest price is current
> **$197.69** across 129 products whose cheapest price is older than 30 days — confirm before ordering
> 131 of 172 rows would change who we buy from, and 129 of those rest on a stale price.

No stale row is hidden — per your §4, a stale cheap price is still a reason to go
ask that supplier. The two client-side chips ("Cheapest price is current", "Would
change supplier") are opt-in, and together they narrow 172 → 35 → **1**.

**The single highest-value thing you could do for this page is get a current price
list out of Supplier2026.** That one action would move $197.69 of per-unit saving
from "confirm before ordering" to actionable, and it is worth more than any feature
below.

---

## 2. Five params are accepted and ignored — this is what forces fetch-everything

Measured; each returns the **full unfiltered set** with a 200:

| Endpoint | Param | Sent | Returned |
|---|---|---|---|
| `compare` | `supplier=Augmento` | 200 | 172 of 172 |
| `compare` | `cheapest_supplier=Augmento` | 200 | 172 of 172 |
| `compare` | `stale=false` | 200 | 172 of 172 |
| `compare` | `exclude_stale=true` | 200 | 172 of 172 |
| `compare` | `fresh_only=true` | 200 | 172 of 172 |
| `unmatched` | `reason=ambiguous` | 200 | **345 of 345** |
| `unmatched` | `reason=no_model_number` | 200 | 345 of 345 |
| `unmatched` | `reason=bogus` | 200 | 345 of 345 |

We are not complaining that these are missing — they were never in your contract.
The problem is that they are **accepted**. A silently-ignored filter is the worst
of the three possible behaviours: the request looks filtered, rows come back, the
page repaints, and every row is wrong. We have shipped that bug before from a
different endpoint (ERR-151) and it took a live probe to find.

**Ask 1 (cheap, high value):** reject an unknown query param with a 400, the way
you already reject `sort=bogus` and `coverage=bogus`. That single change would have
made all eight rows above self-evident in one request.

### The consequence for us

The two filters this page exists for — *is the cheapest price current?* and *show
me only the rows that need a decision* — cannot be asked of the server. So the
front-end pulls every page and filters in the browser: 1 request for Compare (172
rows fit in one `limit=200`), 3 for Single source, 2 for the review queue.

That is affordable today and we are not asking you to change it. But it does not
scale past a few thousand offers, and it is worth knowing that the review tab in
particular has no cheap version: **filtering one server page client-side renders an
empty tab**, because both `ambiguous` rows sit past the first page of 50. A tab
that silently shows nothing reads as "no work to do".

**Ask 2:** `reason=` on `/unmatched` (single value or CSV). This is the one that
buys the most — it turns 2 requests and 345 rows into 1 request and 25 rows, and
it removes the only place where our client-side filtering is load-bearing rather
than convenient.

**Ask 3 (lower priority):** `cheapest_is_stale=false` on `/compare`. Nice to have;
the client-side version is honest because we hold the whole set.

---

## 3. `by_reason` is good, and we lean on it

`meta.by_reason` is server-computed and **does** respect `supplier=` and `search=`
(measured: `supplier=Augmento` → `{no_catalogue_match: 29}`, and 29 + 316 = 345).
It sums to `pagination.total` exactly. The review tab's chips read it directly
rather than counting locally, because it is the trustworthy number.

`supplier=` and `search=` on `/unmatched` are both honoured properly. It is only
`reason=` that is a decoy.

---

## 4. There is no way to list existing mappings, so undo is one-shot

Measured, all 404:

```
GET /api/admin/supplier-offers/map
GET /api/admin/supplier-offers/mappings
GET /api/admin/supplier-offers/maps
GET /api/admin/supplier-offers/map/list
```

`DELETE /map/:id` works, but the only `id` a browser can ever hold is the one
`POST /map` just returned. So undo exists for about twelve seconds — an Undo button
on the success toast — and then the pin is permanent from the UI's point of view.

We have not built a "manage mappings" screen, because we would have to invent the
list. The modal says plainly that the mapping is permanent before the operator
commits, and the Undo tooltip says it is the only chance.

**Ask 4:** `GET /api/admin/supplier-offers/mappings` (paginated; `id`,
`supplier_name`, `supplier_sku`, `product_sku`, `note`, `created_at`,
`created_by`). Then the pin becomes reviewable and reversible instead of a
twelve-second window, and `match_method: "manual"` on a comparison row becomes
traceable to who decided it and why.

---

## 5. §8 cannot be built: both upload endpoints are cron-gated

This is the one part of your hand-off we could not deliver, and it is not a
front-end limitation. With a live owner bearer token:

```
POST /api/admin/feed-files/product-list     → 403 {"code":"FORBIDDEN",
POST /api/admin/import/supplier-price-list  → 403  "message":"Cron endpoints require
GET  /api/admin/feed-files                  → 403   CRON_SECRET in production"}
```

The 403 arrives **before** validation — the import trigger answers 403 even when
sent a body, which your contract says should be a 400 — so the gate sits above the
handler and no admin token gets through. Your §8 describes step 1 as "(Existing
upload screen.)"; there has never been one in this repo (`grep -rn "feed-files"`
returns zero hits across all JS, HTML and docs), so there was nothing to extend.

We did not ship the buttons. A dead upload control that 403s the first time the
owner trusts it is worse than an honest absence, so the panel states the measured
fact, names both endpoints, and says the file has to reach you another way. The
probe re-checks the gate on every run and will tell us the day it opens.

**Ask 5:** an admin-authenticated route for both steps —
`POST /api/admin/supplier-offers/import` gated on `super_admin` rather than
`CRON_SECRET` would be enough, and we will build the drop-zone and the
`offers_matched / offers_total` spinner the same day.

**Ask 6 (smaller):** there is also no readable record of when a price list last
landed. `GET /api/admin/supplier/import-status` is reachable but returns
`{genuine: {latest: null, recent_runs: []}, compatible: {latest: null, recent_runs: []}}`
— empty for both feeds. So the page uses `data.suppliers[].last_seen_at` as the
record instead, and says so on screen. An import history would be better.

---

## 6. Smaller notes

- **`min_saving` composes badly with `coverage=single`.** Every single-source row
  has `saving_vs_next: 0`, so `min_saving=5&coverage=single` returns 0 rows. Not a
  bug — but the control is hidden on that tab rather than silently emptying it.
- **`data.suppliers[]` stays populated when `comparisons` is empty.** Thank you;
  the freshness strip survives a filter that matches nothing, which is exactly when
  the operator most needs to know how old the feeds are.
- **`meta.totals` correctly zeroes with the rows.** Also checked.
- **8 of the 172 rows are ties** (both suppliers at the same price). They render as
  "same price", not "$0.00 saving" — a zero in a money column reads as broken.
- **`match_method: "manual"` renders as "Pinned by hand from the review queue".**
  An unrecognised method renders as `<value> (unrecognised by this build)` rather
  than blank, so a new matcher strategy is visible the day it ships.
- **The colour-tail hint.** Both live `ambiguous` rows are `BTN346M` and `BTN443M`,
  each carrying `color: "Black"` on a code ending in `M`. The page surfaces that
  contradiction in the row, which turns an unexplained refusal into a decision the
  operator can actually make. It catches 9 of the 25 actionable rows. Worth knowing
  the feed's own colour field disagrees with its codes this often.
- **A fourth `reason` value would be safe.** An unrecognised reason is treated as
  ACTIONABLE and labelled "this build does not recognise this reason", rather than
  being filed into the hidden no-op bucket. You can add one without a FE deploy.

---

## 7. How to re-measure any of this

```bash
npm run probe:supplier-prices          # read-only; needs ADMIN_EMAIL/ADMIN_PASSWORD
npm run probe:supplier-prices -- --json
```

34 checks. Exit 0 clean, 1 findings, 2 could-not-run. It guards the decoys in
**both** directions: if you implement `reason=` or a staleness filter, it reports
that loudly as a note so we can delete the client-side workaround — it will not
just quietly go on passing.

`node --test tests/admin-supplier-prices-aug2026.test.js` — 67 tests pinning the
front-end half, including a positive control so the suite cannot pass by calling
every row stale.

---

## 8. Summary of asks, in the order we would do them

1. **A current price list from Supplier2026.** Not code. Worth more than the rest combined.
2. **`reason=` on `/unmatched`.** Removes the only load-bearing client-side filter.
3. **400 on an unknown query param.** Stops the next decoy from costing a probe to find.
4. **`GET /supplier-offers/mappings`.** Makes a permanent write reviewable.
5. **An admin-authenticated import route.** Unblocks your own §8.
6. **An import history.** Currently inferred from `last_seen_at`.
