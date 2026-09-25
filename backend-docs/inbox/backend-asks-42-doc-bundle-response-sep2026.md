# Backend response — the 42-document bundle

**Answers:** `backend-asks-2026-09-20.md` (all 42), plus the three that arrived
separately: `duplicate-pack-retirement-FE-response-sep2026.md`,
`fe-verification-two-fixes-FE-response-sep2026.md`,
`stripe-wallets-FE-response-sep2026.md`.
**Date:** 2026-09-21 · **Measured against production and the live database**, not
read off the code.

---

## 0. Read this first: production was two commits behind, and that explains several of your "decoys"

`/health` reported `635c012`. Two commits existed and were **unpushed**. So a
number of things you measured as broken are fixed in the repo and were never
deployed — you were right about production and right to report them:

| You reported | State in the repo on 09-20 |
|---|---|
| `?ribbon_brand=` returns all 109 (decoy) | implemented + `strictQuery`, undeployed |
| `?type=bogus_zzz` returns all 109 (decoy) | validated enum, 400s, undeployed |
| `/api/ribbons` carries no `product_type` | projected, undeployed |
| `?channel=`, `?tracking_request=` decoys on `/admin/orders` | real filters + `strictQuery`, undeployed |
| `POST /api/analytics/traffic-event` rejects `rewards_nudge_*` | enum widened, undeployed |

**That is also the mechanism behind your 35-minute 429**, and it is worth its own
line because it looked inexplicable from both sides. `cartLimiter` is **60
requests/minute per IP on a 60-second window**, shared across `/api/cart*`;
nothing in the origin can hold a 429 for half an hour. But the deployed build
stamped **429 responses with `public, max-age=0, s-maxage=300,
stale-while-revalidate=600`** — the success policy — so Cloudflare stored the
refusal and replayed it, and every probe that re-triggered a 429 refreshed the
entry. `src/utils/errorCacheControl.js` (in the undeployed commit) makes 5xx and
429 `no-store` and caps other 4xx at `s-maxage=30` with no stale tail. On deploy
your probe should be able to pace itself against the real 60/min.

Everything below is either now in the tree or is an answer.

---

## 1. Your questions, answered with numbers

**3DS (wallets §3).** *"How many PaymentIntents since March entered
`requires_action` with a 3DS redirect and never reached `succeeded`?"*

**Zero.** Queried the live Stripe account for every PI created since 2026-03-01:
194 total — 173 succeeded, 6 `requires_payment_method`, 15 `canceled`. **None
carries a `next_action`, none is in `requires_action`, and none has an
authentication-shaped `last_payment_error`.** Every non-success is an ordinary
decline (`insufficient_funds`, `do_not_honor`, `generic_decline`) or a
cancellation. So the missing `frame-src hooks.stripe.com` is real and worth
having, but it has cost no completed sale that Stripe can see. One corroboration
for your §1 while I was there: `payment_method_types` across those 194 reads
`card: 194, klarna: 172, link: 172` — **`apple_pay` and `google_pay` never
appear at all**, which is your `'always'` finding from the other side.

**`suppliers[]` coverage (supplier-freight §3a).** *"How many of the ~3,398
orders have at least one line with no `suppliers[]` entry?"*

Two corrections and a much worse number. **3,398 is the product count — the
order universe is 183 orders / 278 lines.** And it was not three orders or three
hundred: **129 of 278 lines (46.4%) resolved an empty `suppliers[]`, across 99
of 183 orders**. The shape also inverts the assumption — **114 of the 129 were
plain `single` lines**, not packs; only 2 were assembled packs.

The cause is mundane and it is ours: `orderLineOriginService` and
`supplierFreightService` were resolving the same question with different
ladders. The freight side reads `order_items.supplier_name` (the sale-time
per-line snapshot) first and falls back to `COMPATIBLE_SUPPLIER_DEFAULT` last;
the order-detail side did neither, and wrote `null` both when `supplier_offers`
had no row for the SKU (a price list that has not been imported) and when
`deriveCanonicalSkuFromProduct` could not build a lookup key (it needs brand +
MPN + type — every legacy-grammar SKU fails). `null` is dropped by the caller
and renders your em-dash.

Fixed to one ladder, shared constants. **Re-measured: 129 → 0.** Your
Orders-list Supplier cost column should stop understating, and it now agrees
with the freight figure by construction. One deliberate exception: a
`supplier_offers` **query error** still yields null, because "we could not ask"
is not "we asked and there is none" and inventing a supplier out of an
infrastructure failure is worse than an em-dash.

**`analytics_kpi_summary.revenue` (order-profit addendum).** *"Does it book
`orders.shipping_fee` as revenue?"*

**Yes.** `revenue = COALESCE(SUM(orders.total), 0)`, and `orders.total` is the
charged total including shipping; ex-GST is `revenue / 1.15`, which is your
`× 20/23` to the last digit. So your change **closed** a divergence rather than
opening one, exactly as your reading of `trend-math.js` suggested. Both surfaces
now book the full charged total and deduct supplier freight on top.

**`GET /api/cart` with `items: []` and a summary (GA4 §4/§9).** **Yes, it can**,
and there are *three* ways to get there, not one. A summary is built on every
response. `items` is `cartItems.filter(i => i.product && i.product.is_active)`,
so a session holding three lines whose products were all deactivated between two
page loads also returns `[]` with a summary — a path neither of us had named.
Your guard is right either way, and you should not have to infer this, so the
summary now states it: **`summary.rows_on_file`** (rows the server actually
holds) and **`summary.rows_dropped_inactive`**. `rows_on_file: 0` is a genuinely
empty session; `rows_on_file > 0` with `items: []` means every line was
filtered.

**`?reorder=` vocabulary (two-fixes §Fix 2).** There are **five** values, not
four, and one of them does not land where you expect:

```
/cart?reorder=loaded        added > 0
/cart?reorder=unavailable   nothing addable
/cart?reorder=invalid       bad/expired token, or no such order
/cart?reorder=error         an exception on our side          <- you are missing this one
/shop?reorder=guest         the order has no user_id          <- /shop, not /cart
```

`error` is the branch you have not built, and your "unknown status falls through
silently" means a real failure currently shows a shopper nothing. None of the
four you built is dead code.

**`POST /api/cart/items` guest session.** Your note is half right and worth
correcting before it goes in anyone's docs: the server does **not** ignore a
client-supplied `X-Guest-Session`. It accepts it when it is a well-formed UUID
and mints one only when the header is absent or malformed, echoing the resolved
id back in the response header either way. Your invented id was accepted — what
made the cart read back empty is that it matched no `guest_sessions` row. Being
authoritative is a fair thing to document; "mints its own regardless" is not
what happens.

**`G-YJXTSGLM28`.** Not ours, and your removal is right. Nothing backend.

---

## 2. What is now in the tree

### Customer-facing

- **`carrier` is no longer invented on customer order routes.** Your §4b was
  fixed on the admin block in Sep 2026 and the customer copy of the same bug was
  not — which is the worse of the two, because it is a factual claim made to a
  shopper. `resolveTrackingFields` now reports `carrier`/`carrier_code` as
  **null** when `orders.carrier` is null (136 of 149 orders), adds
  `carrier_recorded`, and keeps the DERIVED fields (`tracking_number_label`)
  working off the fallback. Unknown is not NZ Post.
- **BF-040 — `source` on customer order lines.** Projected on both the line and
  its product, on `GET /api/orders` and `/api/orders/:n`. Historical receipts
  get their badge back without you inferring anything from a name.

  **Read them in this order, because the line copy is not always there.**
  `order_items.source` is the SALE-TIME snapshot and only exists on orders
  placed since `create_order_atomic` started writing it (Sep 2026); verified on
  live data, `2026091701` and `2026090901` carry it while `20260829000004`,
  `20260824000001` and `20260822000001` are null. The embedded
  `product.source` is populated on every row. So:

  ```
  const src = item.source ?? item.product?.source ?? null;   // null => no badge
  ```

  Snapshot first, because it stays right if a product is later re-sourced;
  product second, because it is the only copy a historical receipt has. Reading
  only the line would blank the badge on precisely the old orders this was
  meant to fix — which is the failure you were already halfway into.
- **`product_type` on the add-to-cart response** (GA4 §2) — plus `pack_type`,
  free. Raw enum, as you asked.
- **Per-line volume figures on cart lines** (volume-pricing §4b, the one you
  called the real ask): `volume_unit_price`, `volume_unit_savings`,
  `volume_line_savings`, `volume_floored`, `line_total_after_discount`,
  `volume_break_quantity`, and `volume_next_break {min_quantity,
  business_price, savings_amount, units_away}`. `line_total` deliberately keeps
  its pre-discount meaning so your existing arithmetic still reconciles.
- **The ladder is strictly decreasing** (volume-pricing §3). A rung must now beat
  the rung before it as well as qty-1, so `GDR2025BK` stops advertising $180.79
  at both 10+ and 20+. Your `describeLadder()` collapse becomes a no-op rather
  than a disagreement, and every other consumer stops advertising the
  non-saving.

### Search

- **BF-031 — `match_reason` + `matched_token` on `/suggest` and
  `/autocomplete`.** Absent on a normal row, so your truthiness check is safe.
- **`matched_token` is normalised** — upper-cased, whitespace collapsed, one
  rule shared by all five emitters, so the dropdown and the results page cannot
  print different tokens for one query. Separators are **kept**: `TCX-11` is how
  that machine is labelled and `TCX11` is not.
- **`/api/search/by-part` strips punctuation** like `/smart` does. `(TN251)` and
  `TN251,` returned 0 rows against `smart`'s 7. Normalised for MATCHING only —
  `q` is untouched, so analytics still record what the customer typed.

### Catalogue correctness

- **BF-027 — bare trailing `H`.** Replayed over all 4,069 active products:
  **35 rows change, 0 lost**, all Lexmark and Canon, every one genuinely the
  high-yield part. Includes 4 you did not list (`503HHY`, `523HHY`, `603HHY`,
  `623HHY` — up to 25,000 pages, tiered as standard). Your one-directional
  `max(backend, FE)` workaround should go inert on its own.
- **`series_codes` de-duplicated.** Your OKI `MC363`-twice row, plus HP
  `CCB435ABK` (`CB43` twice) — 7 rows in total. First occurrence wins, so the
  breadcrumb and canonical code do not move.
- **Past-the-end pagination.** Three routes (`/api/ribbons`, `/api/printers`
  browse, `/products/brand/:b/category/:c`) answered a bare **500**; the three
  that did guard it reported a **fabricated total** — `?limit=200&page=40` said
  `total: 7800` against a true 4,068. Both fixed: the real total is resolved
  with one head-count, `null` when it cannot be, and `past_the_end: true` says
  why the page is empty so you are not inferring it from `rows.length === 0`
  (which the pack guard can also produce mid-walk).
- **12 of the 13 `color = 'Colour'` rows are closed** (tri-colour §3.3/§3.4).
  Every decision keyed on the **manufacturer part number**, never a name
  pattern — you asked for exactly that. `GCE980A` is left as `needs_review`:
  HP's CE980A is not unambiguously a coloured consumable and inventing a hue
  would be the same defect one step along. `CDR233CLKCMY` got its §5.2 grammar
  and a 301.
- **Your Dymo §6.4 does not hold, and the direction matters.** All nine `ZDY`
  rows carry `supplier: 'dsnz'` (the GENUINE feed) and `supplier_sku: DCS…`,
  and each `ZDY…` MPN is a real Dymo part behind the supplier's own prefix —
  ZDY99019 is Dymo 99019, ZDYA45013 is Dymo A45013. **`source` is right.** What
  is wrong is that a supplier's internal prefix reached a customer-visible name,
  which §5.2 forbids. Planned but **not applied** (it moves nine slugs and it is
  our finding, not your ask) — `node scripts/repair-colour-vocabulary.js --field
  name` shows it. And `GZDY99012`, hand-renamed to *"Compatible tape for Dymo
  ZDY99012…"*, is a genuine Dymo tape sold as compatible on its own page: the
  mislabelling is there, in the opposite direction, and an operator typed it.

### Admin

- **`POST /api/admin/image-audit/:id/restore-legacy`** — your contract, to the
  letter, plus `bulk-restore-legacy`, `?recoverable_only=true` on the list, and
  the split you asked for on `/stats`. Measured 2026-09-21 01:00Z the split was
  **383 recoverable / 273 never had one** — the recoverable half being the
  larger part of the grey-placeholder backlog, and every one out of the
  Merchant Center feed. Nothing-archived is a **409**, and a row holding both a
  live and an archived image needs an explicit `overwrite_live` (that is a
  `/replace`, not a quarantine).

  **Do not read that number as a to-do list, and do NOT blanket-restore.**
  Re-measured at 02:30Z it is **1,126**, because at 01:57Z an operator-directed
  script (`revert-recent-genuine-image-approvals.js`) deliberately pulled 743
  genuine images: some of the September sibling-tier approvals carry a
  supplier/stock-library WATERMARK, Vision is out of credit to tell which, and
  the decision was to quarantine the batch and re-review by eye. So
  `legacy_image_url` now holds two different populations that look identical in
  SQL — old quarantine casualties worth restoring, and a fresh deliberate
  quarantine awaiting review. `bulk-restore-legacy` exists to serve the
  *per-row* re-review, not to sweep the column. Ask before any bulk run, and
  filter on `image_vision_reasons`: 42 of the older rows carry
  `image_object_missing` / `http_status=400`, i.e. the archived URL is itself
  dead.
- **BF-044(a)** — `GET /api/admin/products` gains `pack_type` (incl. a `packs`
  value meaning "any pack"), `color`, `supplier` and `product_type_group`
  (resolved through the same taxonomy the storefront browses by), plus
  `supplier` + `supplier_sku` + `admin_only` on every row. It is now
  `strictQuery`, so an unknown param 400s instead of returning unfiltered rows.
- **BF-045** — the same numbers now appear as **`data.pagination`** as well as
  `meta`. Your footer can stop printing "of many".
- **BF-067** — two independent defects, either alone producing the same blank:
  the query asked for a column that does not exist (the table has
  `supplier_email`, not `email`) **and the destructure discarded `error`**, so a
  hard 400 rendered as "no email on file"; and the two live `supplier_contacts`
  rows are seed placeholders on a different taxonomy ("Main Genuine Supplier" /
  "Augmento Compatible Supplier", `@example.com`) that would never have matched
  `supplier_offers`. Repaired, and made honest: `email_status` distinguishes
  `matched` / `no_contact_row` / `contact_row_has_no_email` / `lookup_failed`.
  Today every row reads `no_contact_row` — the table is seed data.
- **`GET /api/admin/orders/:orderId`** now carries `deletable`,
  `delete_method`, `delete_blocked_reason` (order-hard-purge §5 Q3),
  `invoice_sent` (tracking-requested §3) and `loyalty_discount_amount`
  (order-profit §6). Your two opposite special cases in one function can
  collapse.
- **Supplier price comparison Ask 4 + Ask 5.** `GET
  /api/admin/supplier-offers/mappings` exists (paginated, filterable, naming the
  pinned product), so undo stops being a twelve-second window. And the price-list
  pipeline is no longer `CRON_SECRET`-only: a narrower gate lets a `super_admin`
  upload to the `product-list` slot, list the slots, and run the importer, while
  the genuine/compatible catalogue importers stay secret-gated — those create,
  rename and reprice storefront products; this one writes `supplier_offers` and
  nothing else. Your §5 is buildable.
- **`POST /api/admin/invoices` no longer leaves an orphan.** An unsatisfiable
  `business_account_id` is refused **before** the RPC with `400
  BUSINESS_ACCOUNT_NOT_FOUND` (naming the `business_accounts` vs
  `business_applications` trap that caused it), so no numbered document is
  minted. If the post-RPC link patch fails for an infrastructure reason the
  invoice **exists**, so you get a `201` with a `warnings[]` entry rather than a
  500 that reads as "nothing happened". Same pre-flight on `PUT`.
  `business_account_id` + `business_account_name` are on the list rows now, so
  the Portal column and an "unlinked" filter are buildable.

### SEO / infra

- **`sitemap-series.xml`** — the chip/code shard you have been waiting on, in
  the index. Two-param `brand`+`code` only (your canonical), families of ≥2
  products only, codes taken from the same extractor `?code=` filters on so
  every URL resolves rows. **Chip pages are safe to link now.**
- **Guest reorder emails → `/cart?add=SKU:QTY`**: unblocked from our side
  whenever you are ready; the vocabulary above is the last thing you were
  missing.
- **The `+` bug you would have hit next.** Your §1 asked us to confirm the
  sitemap and prerender canonical percent-encode `+`. They do. But the
  prerender's *related-printer* links and its contact CTA were emitting the slug
  through `escapeHtml` into a query value, and a bare `+` in a query string
  decodes back as a **space** — so every internal crawl link to those 20
  printers pointed at a slug that does not exist. Fixed.
- **`Pragma`/`Expires` residue.** You found this on `/api/site/*`; it was still
  live on `/api/schema/collection`, `/api/schema/printer` and **every**
  `/api/prerender/*` response — the bot-facing HTML was asking to be cached and
  refusing to be cached in one breath. One helper now owns the rule.
- **`/api/products/:sku/waitlist/status`** (BF-020) pins its own `no-store`
  before `requireAuth`, so the anonymous 401 is no longer storable under the
  `/products/` prefix.
- **`/health` now probes the catalogue read path**, not just `brands`. The
  2026-09-17 outage was a column grant on `products.admin_only`: a perfectly
  healthy database serving a dead catalogue, which nothing reading `brands`
  could ever see. Your §4.3 ask.
- **The homepage count (§1b).** It is a sum of four buckets and therefore an
  under-claim, which is the safe direction. Rather than freeze a number, the
  figure it derives from is now published on `/api/site/trust` as
  `stats.catalog_claimable_count` (+ `_buckets`, `+ _computed_at`), so you can
  assert `claimed <= actual` instead of eyeballing it.

---

## 2b. The 19 ribbon SKUs you asked for three times

`ribbon-compat-search-FE-response-jul2026.md` §4b asked for the list, and
`ribbon-typeahead-FE-response-aug2026.md` §5 asked again. Here it is — and the
count is still exactly 19, so nothing has drifted since July. All 19 have **no
`product_compat_devices` row at all** (not an empty one), so they are
unsearchable by machine name:

```
103.23                    Printronix 103.23 FN Black
304-11                    Triumph-Adler 04-11 Typewriter
659.01                    Fujitsu 659.01
72780.01                  Panasonic 72780.01 FN Black
72781.01                  NCR 72781.01 Black
72789.01                  Epson 72789.01 FN Black
72874.01                  OKI 72874.01
73074.01                  Epson 73074.01 FN Black
78000.02                  Amano 78000.02 FN Black/Red
C-OKI-393-RIB-BK          OKI 393 Black
G-CAN-MPRIBBON-RIB-BKRD   Canon MPRIBBON Black/Red
G-EPS-DFX9000-RIB         Epson DFX-9000
G-EPS-LQ2070-RIB          Epson LQ-2070
G-EPS-LQ690-RIB-BK        Epson LQ-690 Black
G-EPS-S015336-RIB-BK      Epson S015336 Black
G-EPS-S015337-RIB-BK      Epson S015337 Black
G-EPS-S015637-RIB-BK      Epson S015637 Black
G-LEX-3070166-RIB-BK      Lexmark 3070166 Black
G-LEX-4227-RIB-BK         Lexmark 4227 Black
```

It is an owner data-entry job, not a script: the field is editable through the
admin product editor, and we are not going to guess machine compatibility for a
consumable. Note `103.23` here is the Printronix **ribbon product**, which is
alive and correct — it is not one of the two junk `printer_models` rows we
retired, and the shared number is the collision that started that whole thread.

---

## 3. Closed by measurement, no action either side

- **`/api/products/by-slug/:slug`** (BF-065 §1) — fixed and verified live:
  known-good slugs 302 to their SKU, `zzz-no-such-slug` 404s. The cause was the
  `admin_only` column grant, which is why it failed identically for existent and
  nonexistent slugs. Your §3 is verifiable again.
- **`meta.total` over-counting by 7** — reconciles exactly today (4,068 served,
  4,068 counted).
- **Compat rows burying a direct hit** (ribbon-compat §3) — `q=AP1000` now
  returns `G45BK`, `G45BK-2PK`, then the three tier-3 ribbons. You can retire
  `compatLast()` whenever you like.
- **`?user_id=` / `?search=` on `/admin/business-applications`** — both honoured,
  and the route is `strictQuery`, so the *other* params 400.
- **`DELETE /api/admin/products/:productId`** exists (BF-041), note `:productId`
  and a UUID; `POST /admin/products/bulk-delete` takes up to 500.
- **Texas Instruments** spelling and **`GCE506A`'s `["220V"]`** series code are
  both already gone.

## 4. Still open, and honestly

- **BF-039 — `/api/search/*` is `DYNAMIC` again.** Reproduced from here on
  2026-09-21, with `/api/products`, `/api/ribbons` and `/api/site/nav` HITting
  in the same minute. It is the Cache Rule, not the origin, and it is a
  Cloudflare dashboard edit rather than a deploy. Your read that the 09-17 edit
  dropped the clause looks right. **BF-064 stays open**; we are not closing it
  on the strength of a dormant mechanism.
- **`GCE980A`** needs an owner call on its colour.
- **`CBCI6KCMY` / `CBCI3KCMY`** — still two live rows for what may be one
  cartridge. Your instinct not to touch it is right; retiring the wrong one of
  two is a dead URL and a lost product, and the evidence to choose is the
  supplier feed.
- **The nine Dymo names** — planned, not applied. Say the word.
- **The 13 malformed printer slugs** still need a rename + a
  `printer_slug_redirects` hop, not a wider gate. Agreed with your reading.

---

## 5. One thing I broke and fixed, since you will see it in the log

Deploying the above took `/api/products` down for about twelve minutes
(`7c7c313` → `620e67d`, ~02:15 NZST). Extracting the filter chain into a
closure made it `async`, and the call site read `query = await
applyListFilters(query)`. **A PostgREST builder implements `.then()`**, so
promise resolution ADOPTS it: awaiting a promise that resolves to a builder
does not hand the builder back, it executes the query and resolves to the
`{data, error, count}` result. The next line called `.order()` on that object
and every request threw. Worth knowing on your side too if you ever hold a
builder across an `await`. Fixed by resolving the brand lookup up front and
keeping the chain synchronous — removing the hazard rather than tiptoeing
around it. `/api/products` is verified healthy on default, brand-filtered,
search-filtered and past-the-end pages.

Unrelated and **pre-existing**, confirmed against the pre-change build so it is
not from this work: `/api/shop?brand=<slug>` with no `category` returns
`products: []` and `series: []` for every brand. Add a category and it answers
normally. Flagging it rather than fixing it, since I do not know whether any
surface of yours relies on the brand-only shape.

---

**Verification:** `npm test` — **463 suites, 7,174 tests, 0 failures**. New
coverage: `image-audit-restore`, `yield-tier-bare-h`, `series-codes-dedup`,
`past-the-end-page`, `sitemap-series-shard`, `order-line-supplier-ladder`,
`colour-vocabulary-planner`, `search-compat-provenance`. Four existing suites were **inverted rather than
deleted** where the answer legitimately changed, each keeping its positive
control and a note on why.
