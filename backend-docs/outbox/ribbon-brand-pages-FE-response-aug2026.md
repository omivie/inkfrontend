# Ribbon brand pages — frontend response (Sep 2026) · SHIPPED

**From:** frontend · **Date:** 2026-09-01 · **Re:** your `ribbon-brand-pages-anon-rpc-fix-aug2026.md`
**Our log:** `errors.md` ERR-193

Thank you for this one. The write-up was accurate, the diagnosis was right, and "it surfaced only by
capturing the page's actual network traffic" is the sentence that made the rest of it findable.

**FE-1, FE-2 and FE-3 are all shipped.** FE-2 turned out not to need you — details below, because the
reasoning in §FE-2 of your doc is the one thing in it that does not hold, and it is worth correcting
before it becomes the argument for a piece of backend work.

| | Item | Status |
|---|---|---|
| FE-1 | A failed request renders as "No ribbons found" | **Done** |
| FE-2 | Brand pages show no bulk-pricing ladder | **Done — frontend only, 100% coverage** |
| FE-3 | Brand pages ignore sort, paging, colour and model filters | **Done** |
| FE-4 | Move the page off the direct anon-key RPC | **Yes please — but not as described; see BF-054** |

Everything we assert below is measured against production, and `npm run probe:ribbon-brands`
(read-only, no credentials, 20 checks) re-measures all of it on demand.

---

## FE-1 — done, with one correction

Split into `showError(message, onRetry)` and `showEmpty(message)`, with a separate `#drilldown-error`
pane, its own heading and a Retry — the same three element ids and the same CSS `/shop` has had since
May 2026. `getRibbonsByBrand` and `getRibbonBrandsList` now return
`{ok:false, error, code, status, data:{…:[]}}`, where `code` is **PostgREST's own** when it sends one.
Had this been in place on 2026-08-29 the page would have carried the string `42501` from the first
minute.

**The correction: the telemetry you asked for would have emitted nothing.** You suggested "a
`DebugLog.error` / analytics event rather than a warn". `DebugLog` gates all four of its methods on
`_isDev` — `hostname === 'localhost' || '127.0.0.1'` — so it is a no-op in production, and the page
*already* called `DebugLog.error` on one of the three failure paths. That is a large part of why 44
hours produced no log line. Worth knowing next time you read a `DebugLog` call and assume it lands.

So the failure now goes to GA. It does **not** go to our own tracker, because it cannot:

```
POST /api/analytics/traffic-event {"event_type":"catalogue_load_failed"}
  → 400 VALIDATION_FAILED: "event_type" must be one of [pageview, click]
```

We did not ship the call. A request that always 400s is not instrumentation — it is the same mistake
as the `DebugLog` line above it, one layer out. And we did not send it as `click`: that would file an
interaction the visitor never performed and corrupt the metric the endpoint exists to collect.

---

## FE-2 — done, and it did not need the backend

> "The ladder cannot be computed client-side — it is priced off `cost_price`, which the browser must
> never hold. So this is only fixable by serving brand pages from the API (FE-4)."

The first sentence is right and the conclusion does not follow. **The ladder does not need to be
computed, only fetched — and `GET /api/ribbons` already serves it, publicly.** No `cost_price`
anywhere near the browser.

What we measured before writing anything:

| | |
|---|---|
| Brand-page rows across all 63 brands | **368** |
| …which are only this many distinct SKUs | **82** |
| Ribbons in `/api/ribbons` | **109**, every one with a populated `quantity_breaks[]` |
| `limit` maximum | **200** (201 is a clean 400 — thank you, not a silent clamp) |
| Brand-page SKUs covered by one `?limit=200` call | **82 / 82 — 100%** |
| …agreeing with the RPC on price | **82 / 82** |
| …agreeing with the RPC on `stock_quantity` | **82 / 82** |

So `getRibbonLadders()` makes that one request per session, memoised, **after** the paint and never
blocking it, and patches the cards in place. Epson's 25 cards now read *"Bulk price $14.35 ea · Buy
3+ · down to $13.46 at 8+"*, 25 of 25.

Two smaller things fell out of the same response, at no extra cost:

- **`data-product-brand=""` is fixed.** You flagged it; the fix is that `/api/ribbons` carries `brand`
  as a resolved name string where the RPC has only `brand_id`.
- We copy **only** `quantity_breaks` and `brand`. We deliberately do **not** copy price or stock even
  though they agree 82/82 today — the RPC row stays the page's source of truth for what a ribbon
  costs. The probe asserts that agreement instead, so a future divergence is loud rather than papered
  over.

None of this makes FE-4 unnecessary. It just means guests are not waiting on it.

---

## FE-3 — done

Sort, colour, manufacturer brand and paging now apply on the brand branch. This is **exact rather than
approximate**, which is the only reason we were willing to do it client-side: the RPC returns each
brand's complete, unpaginated set, and the largest brand is Epson at 25 rows against a page size of
48. Filtering one page of a paginated set in the browser would be the trap we hit in ERR-190;
filtering a whole set is just filtering.

Three notes:

- **A `?brand=` filter blocks on the brand names and refuses if it cannot get them** — it does not
  render the unfiltered set. A page that looks filtered and is not is worse than an error.
- **A `?printer_model=` URL now takes the API branch**, which can actually answer it. The RPC has no
  device data, so the old code silently widened to the whole brand.
- `renderPagination` was being handed a `pagination` that was `null` on **every** brand page.

Also fixed on the way past, both caused by `/api/ribbons` rather than the RPC: it sends **no
`product_type` on any of its 109 rows**, so every typewriter ribbon and correction tape reached by a
`?color=` or `?printer_model=` URL was being rendered under the heading **"Printer Ribbons"** — and a
row carrying a type outside the three known ones was dropped from the page entirely, silently. Both
now render in an unlabelled grid. **If you can add `product_type` to that payload we will label them
properly (BF-055).**

---

## Asks, in the order we would do them

### BF-053 — widen the `traffic-event` enum (smallest, highest leverage)

`event_type` accepts exactly `[pageview, click]`. One more accepted value —
`catalogue_load_failed`, or a general `client_error` with a `surface` field — means the next outage of
this class is visible in **our own data on the day it starts**, rather than in GA, or in nothing.

**This is not hypothetical, and it is not only about our new event.** While checking the enum we found
that `js/rewards-nudge.js` has been sending three events through this endpoint since it launched, and
**every one of them has been rejected**:

```
POST /api/analytics/traffic-event  {"event_type":"rewards_nudge_shown"}        → 400  (rejected)
                                   {"event_type":"rewards_nudge_cta_clicked"}  → 400  (rejected)
                                   {"event_type":"rewards_nudge_dismissed"}    → 400  (rejected)
                                   {"event_type":"pageview"}                   → 204  (accepted)
```

Verified against production, using a body that omits three required fields so it can never be
recorded either way. So `traffic_events` holds **no rewards-nudge rows at all** — the nudge's
impression, click-through and dismissal rates have only ever existed in GA, and anyone who has
queried our own table for them has been reading an empty result as a zero. We have not touched
`rewards-nudge.js`: the calls are correct and the enum is what needs widening. **If you would rather
reject unknown types than accept them, that is a legitimate choice — but then the 400 needs to be
visible to us, because right now `send()` swallows it and the page believes it is instrumented.**

This is the single change that would have shortened those 44 hours, and it is smaller than everything
below it. `npm run probe:ribbon-brands` §7 watches the enum and will tell us the day it widens — it
reads the validator with a body missing three required fields, so it can never write a row.

### BF-054 — `GET /api/ribbons?ribbon_brand=<slug>`: yes, but two things first

**Say the word and it ships** — please do. Two corrections to the plan, though:

**1. It is not a one-line swap. The two routes disagree.**

```
get_ribbons_by_brand('brother')            → 10 rows
GET /api/ribbons?printer_brand=brother     →  7 rows
missing: 81001.01, 81001.02, C143LOT
```

Your doc says these are different taxonomies, and that is exactly the point: whatever
`?ribbon_brand=` is built on must reproduce the **`product_ribbon_brands`** mapping, row for row, or
brand pages quietly lose ribbons. We would like to compare counts across all 63 brands against the
RPC before cutting over, and we will keep the RPC path until they match.

**2. `?ribbon_brand=` is not inert today — it is a decoy.**

```
GET /api/ribbons?ribbon_brand=brother  →  200 ok:true, meta.total = 109   (the full unfiltered set)
GET /api/ribbons                       →  200 ok:true, meta.total = 109   (byte-identical SKU list)
```

It does not 404 and does not 400. A frontend that shipped it a week early would render all 109
ribbons on every brand page and **look like it worked**. That is the fourth time this pattern has bitten
us (ERR-151, ERR-173, ERR-190, now this), so our probe asserts it in **both** directions and will flag
the day it starts filtering. **An unimplemented param that returns 200 and ignores itself is worse than
a 404.**

Same family, and worth cleaning up while you are in there: **`type=` and `search=` are also silently
ignored** on `/api/ribbons` (`type=bogus_zzz` returns all 109). Both were documented as working
filters in our own `getRibbons()` JSDoc for months. Either implement or reject them.

### BF-055 — add `product_type` to `/api/ribbons` rows

12 fields come back; `product_type` is not one of them, on any of the 109. It is what the page groups
by. See FE-3 above for what it currently costs us.

### BF-056 — the sweep missed three direct database calls

Your doc says `get_ribbons_by_brand` + `ribbon_brands` are the storefront's only direct database
calls, swept across all 22 scripts. Three more, all anon, all live:

- `API._supabaseSelect` — `js/api.js`, three call sites on the product-codes path
- the PDP enrichment fetch — `js/product-detail-page.js`, `products?select=id,description_html,compatible_devices_html,related_product_skus`
- `js/site-guard.js` — queries `site_settings` via the supabase-js SDK, and **inlines its own second
  copy of the anon key** rather than reading `Config`

All three survived 2026-08-29 **only because they name explicit columns**. That is the rule ERR-170
wrote into `product-detail-page.js` in as many words — and the RPC, being SQL rather than JS, was
never swept for it. Worth a look on your side for the same shape: any `SECURITY INVOKER` function
with a star projection over `products` is one grant away from this outage.

---

## Two corrections to the record, and one thank-you

- **The ten empty brands are exactly as you listed.** We re-ran all 63 slugs: 53 return rows, 368 rows
  total, 10 empty, no errors. They are pinned by name in our probe so an outage affecting one brand
  cannot hide inside the expected-empty set. One small thing: **Texas Instruments is misspelled in the
  database** — slug `texas-instuments`, name `"Texas Instuments"`, missing the "r". It renders on the
  brand grid.
- **`cost_price` really is revoked now.** Our notes still said migration 137 had never landed. It has:
  `select=cost_price`, `profit_ex_gst`, `margin_pct` and `select=*` are all 401 to anon; explicit
  column selects still return 200. We have corrected our side.
- **Thank you for the explicit column list rather than a wider grant.** Withholding
  `compatible_devices_html` and `color_hex` alongside the three cost columns was the right call and we
  are not asking for either back. If we need a field we will ask for the field.

## Verifying any of this yourself

```bash
npm run probe:ribbon-brands          # 20 checks, read-only, no credentials, ~30s
npm run probe:ribbon-brands -- --fast
```

Exit `0` pass · `1` a real finding · `2` could not run. It writes nothing, anywhere, and prints its
mode on every run.
