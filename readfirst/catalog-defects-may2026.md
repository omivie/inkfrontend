# Catalog defects backend handoff — May 2026

This document is the single source of truth for backend tasks identified during the May 8 2026 storefront audit. Frontend fixes that close the visible loop are already in flight on `main` (commit message: "feat(catalog): stale-swatch fallback + value-pack savings + series-codes grouping"). Each section below is **backend work that no frontend trick can substitute**.

Frontend changes shipped in the same audit (for context — do not re-implement):

- `ProductColors.isPlaceholderSwatchImage(url)` in `js/utils.js` — every render path now drops the per-SKU `color-swatch-vN.png` placeholder when admin color edits go stale, and falls through to a CSS color block whose styling derives from the canonical `color` field.
- Value-pack / multipack savings render dollars only — no `(N%)` — across `products.js`, `shop-page.js` and `product-detail-page.js`. Pinned by `tests/value-pack-savings-no-percent.test.js`.
- `ProductSort.familyKey` in `js/utils.js` now prefers backend-supplied `series_codes[]` when present (shortest code wins, yield prefix stripped) so the storefront grouping converges with whatever the backend extracts.

Pinned by `tests/stale-color-swatch.test.js` and the existing `tests/genuine-no-color-tile.test.js` regression suite.

---

## 1. DR251CL compatible singles missing  *(blocking — visible on PDP today)*

**Symptom:** the DR251CL drum-unit PDP shows a 4-pack (`C-BRO-DR251CL-DRM-VP`) but no compatible singles. Genuine has only `G-BRO-DR251CL-DRM-BK` ($285.49, 1 in stock), so a customer who needs one cyan drum has nothing affordable to buy.

**Backend status:**

```
GET /api/search/smart?q=DR251CL
→ products: [
    G-BRO-DR251CL-DRM-BK    (genuine single Black, $285.49)
    C-BRO-DR251CL-DRM-VP    (compatible 4-pack KCMY, $122.79)
  ]
```

**Action:** add four compatible singles `C-BRO-DR251CL-DRM-{BK,CY,MG,YL}` mirroring the pricing tier of the existing 4-pack ($30–$32 each). Once they exist, frontend grouping will display them under the same family + yield row as the 4-pack automatically.

**Acceptance:** `GET /api/search/smart?q=DR251CL` returns ≥ 5 rows (genuine BK + 4 compatible singles + compatible 4-pack); `GET /api/products/C-BRO-DR251CL-DRM-CY` returns 200 with `pack_type: "single"`.

---

## 2. DR233CL has no KCMY 4-pack  *(matches DR251CL gap)*

**Symptom:** the DR233CL family ships only the genuine Black single + a genuine **CMY 3-pack**. There is no KCMY 4-pack and no compatible 4-pack at all. The user expected a 4-pack (the screenshot shows them looking for one).

**Backend status:**

```
GET /api/search/smart?q=DR233CL
→ products: [
    G-BRO-DR233CL-DRM-BK    (genuine Black single, $76.49)
    G-BRO-DR233CL-DRM-VP    (genuine CMY 3-Pack, $76.99) — color="CMY"
  ]
```

**Action:** see §4 below — once the CMY/KCMY auto-synthesis lands, this row will be filled in automatically. As an interim, manually add a `G-BRO-DR233CL-DRM-VP-KCMY` (or compatible equivalent) so the family is complete.

---

## 3. Tri-colour audit — products mislabelled "Red"  *(data hygiene)*

**Symptom:** SKUs whose suffix is `-RD` (originally seeded as "Red" colour) are sometimes actually tri-colour cartridges. The frontend now renders the canonical `color` field as the swatch image — so admin edits flow through visually — but the underlying mislabels still skew search facets, the colour filter and analytics.

**Confirmed mislabel pattern (4 compatibles already corrected by an admin, more likely lurking):**

```
C-CAN-CL41-INK-RD    color="Tri-Colour"   ← was Red
C-CAN-CL511-INK-RD   color="Tri-Colour"   ← was Red
C-CAN-CL513-INK-RD   color="Tri-Colour"   ← was Red
C-CAN-CL641XL-INK-RD color="Tri-Colour"   ← was Red
```

**Action:**

1. Run an audit query: every product where `name ILIKE '%tri-colour%' OR name ILIKE '%tri-color%'` AND `color != 'Tri-Colour' AND color != 'CMY'`. Surface in admin for review.
2. Same for SKUs ending `-RD`: check that the product's name contains the literal word "Red" (vs "Tri-Colour"). Mismatches need `color` corrected.
3. Backfill `color` to `'Tri-Colour'` (or `'CMY'`, whichever you treat as canonical) on the 4 SKUs above and any others surfaced.
4. **Optional but recommended:** schedule a weekly job that regenerates the per-SKU `color-swatch-vN.png` from the canonical `color` field whenever `color` changes. Until that lands the frontend `isPlaceholderSwatchImage` fallback covers the gap.

**Out of scope for this doc:** unifying the colour vocabulary (`Tri-Colour` vs `CMY` vs `Colour` vs `Color`) — the frontend tier mapping handles all four already, but a single canonical value would simplify analytics. See utils.js `COLOR_ORDER`.

---

## 4. Auto-synthesise CMY / KCMY packs when components exist  *(major — issues #6 and #11)*

**Symptom:** product family ships `K + C + M + Y` singles but no `KCMY` pack; or `C + M + Y` singles but no `CMY` pack. Customers who want the bundle have to add four individual cards to cart manually.

**Action:** add a backend pack-synthesis pass. For every (brand, series_code, yield_tier) tuple:

- If singles for `K, C, M, Y` all exist (and no `KCMY` pack does), emit a virtual `KCMY` row whose price = sum(singles) × `value_pack_multiplier` (eg. 0.92 for an 8% bundle discount), tagged `pack_type='value_pack'`, `pack_constituents=[<sku>×4]`.
- If singles for `C, M, Y` all exist (and no `CMY` pack does), emit a virtual `CMY` row similarly.
- Genuine vs compatible synthesis stays inside its own source bucket (a genuine pack is composed of genuine singles, etc.).

The synthesis can ship as either:

- **Real rows** in the products table (cron job; safest for SEO and search ranking), or
- **Virtual rows** materialised at response time in `/api/shop`, `/api/search/smart`, `/api/printers/:slug/products` (no SEO benefit but zero migration risk).

Either way, ensure the synthesised rows include `gst_amount`, `canonical_url`, `slug` and the discount fields (`original_price`, `discount_amount`, `discount_percent`) so the frontend doesn't need any new code to display them.

**Acceptance:** `GET /api/search/smart?q=DR233CL` returns ≥ 1 row with `color='KCMY'` (currently 0). Same for any family where the four colour singles exist.

---

## 5. Yellow priced differently from Cyan/Magenta in same yield  *(price audit)*

**Symptom:** within a (family, yield_tier) bucket, the Yellow single's `retail_price` doesn't match Cyan/Magenta (which should be identical for a same-yield triplet).

**Action:** run an audit query — for every (brand, series_code, yield_tier) where C and M exist with the same retail_price, flag any Y in the same bucket whose price differs by > 0.10. Surface in admin "Pending Changes" tab so an admin can review and align.

The frontend has no fix for this — pricing is authoritative on the backend.

---

## 6. Pack count mismatched on pack name  *(data hygiene — issue #14)*

**Symptom:** Several drum and toner packs are titled "4-Pack" but physically contain `2 × Black + 1 × Tri-Colour = 3 cartridges` (not 4). The "4" advertises *colour coverage* (the pack covers all four colour channels with one tri-colour cartridge replacing C+M+Y), but customers read it as "4 physical cartridges" and feel misled when they unbox 3.

**Action:** for every product where:

- `pack_type = 'value_pack'`, AND
- `name` contains "4-pack" or "4 pack", AND
- `pack_constituents` length ≠ 4 (or `package_quantity != 4`)

Either:

(a) Rename to "X-Pack" matching the physical count (eg. "3-Pack: 2 Black + 1 Tri-Colour"), preferred. The frontend already renders whatever the name says.

OR

(b) Add a `physical_pack_count` field that the frontend can render alongside the name (eg. "4-Pack — 3 cartridges (2 Black + 1 Tri-Colour)"). If you ship this, also add `pack_breakdown: { black: 2, tri_colour: 1 }` so the frontend can render the breakdown deterministically.

Recommended: (a). Fewer fields, less drift.

**Acceptance:** no product has `name LIKE '%4-Pack%' AND package_quantity != 4`.

---

## 7. Toner products misclassified as ink  *(category — issues #15 and #16)*

**Symptom:** TN150 (Brother) and HP 143A (genuine) appear in ink-category surfaces despite being toner products.

**Backend status:**

```
TN150 (G-BRO-TN150-TNR-{BK,CY,MG})
  product_type: "toner_cartridge"   ← correct
  category:     { name: "Toner", slug: "toner" }   ← correct

HP 143A genuine (G-HP-143A-INK-BK)
  product_type: "ink_cartridge"   ← WRONG (this is a toner reload kit for HP Neverstop Laser 1001NW)
  category:     { name: "Ink", slug: "ink" }   ← WRONG

HP 143A compatible (C-HP-143A-TNR-BK)
  product_type: "toner_cartridge"   ← correct
```

**Action:**

1. Reclassify `G-HP-143A-INK-BK` to `product_type='toner_cartridge'`, `category.slug='toner'`. Update the SKU to `G-HP-143A-TNR-BK` (matches the convention) and rename to "HP Genuine 143A Toner Reload Kit Black (2,500 Pages)". Set up a 301 from the old slug.
2. Audit the wider catalogue: any `product_type='ink_cartridge'` whose `name` matches `/toner|reload kit/i` should be reviewed.
3. TN150 — the backend data is correct. Surface confirmed via `GET /api/search/smart?q=TN150`. If the frontend is showing it under ink, that's a category-filter bug in the storefront and should be reported back to the frontend channel (see `js/shop-page.js` category filter — currently shop-page filters by `category` slug from URL; the API obeys, so verify the request URL on the offending page). **No backend action.**

---

## 8. Storefront grouping needs `series_codes` on every endpoint  *(data shape)*

**Symptom:** `js/utils.js ProductSort.familyKey` extracts the product code from the **name** via regex when `series_codes` is missing. The shop endpoint also returns no `series_codes` (verified May 2026). For oddly-named products this can split same-code SKUs into different family buckets, and `rowBreakIndices` then inserts a row break between cards that should sit on the same line.

**Backend status:** `series_codes` ships on `/api/shop` according to api-changes-may2026.md §2, but verification today shows it's missing from the response payload:

```
GET /api/shop?category=ink&brand=canon&limit=10
→ products[0] keys: [
    "id","sku","slug","name","manufacturer_part_number",
    "retail_price","compare_price","color","page_yield",
    "stock_quantity","image_url","color_hex","is_featured",
    "product_type","category","source","pack_type","brand",
    "in_stock","stock_status","price_includes_gst","gst_amount",
    "waitlist_available","canonical_url"
  ]
  ← no series_codes
```

**Action:** add `series_codes: string[]` to the projection on:

- `/api/shop` (and any cached variants)
- `/api/search/smart`
- `/api/printers/:slug/products`
- `/api/printers/by-brand/:slug` (any pack-resolver path)

The frontend already handles the field — `familyKey` in `js/utils.js` will switch to backend-driven grouping the moment any of these endpoints starts shipping it. No frontend deploy required.

**Acceptance:** every `products[]` row in the four endpoints above carries `series_codes: string[]` (length ≥ 1 for any product whose name yields a recognisable code).

---

## 8a. `series_codes` empty on compatibles via `/api/shop` default join  *(blocking — visible May 10 2026)*

**Symptom:** every code-filtered storefront URL drops compatibles. `/shop?brand=hp&category=ink&code=02` rendered 0 products (8 expected). `/shop?brand=hp&category=ink&code=564` rendered 7 of 14. The codes drilldown chip strip lost ~16 entries on HP alone (HP 02, 15, 22, 27, 28, 56, 57, 74, 75, 92, 93, 95, 98 …) because their counts collapsed to zero. Brother LC67 lost its 6 multi-printer compatibles (`for Brother LC38/LC67`).

**Backend status — the inconsistency is in the same endpoint:**

```
GET /api/shop?brand=hp&category=ink&limit=200
→ compatible products carry series_codes: []     ← EMPTY

GET /api/shop?brand=hp&category=ink&source=compatible&limit=200
→ same products carry series_codes: ["02"], ["LC38","LC67"], …   ← POPULATED

GET /api/shop?brand=hp&category=ink&code=02
→ matches by series_codes-array-contains → drops every compatible because its array is empty in this query path
```

So the backend's series-code extractor IS wired up for compatibles — it just doesn't run on the default `/api/shop` join, only on the `?source=compatible` join. The `?code=` filter then queries against the empty array and hides them.

**Frontend mitigation shipped 2026-05-10:** `api.js` `getShopData(params)` fires a parallel `?source=compatible` sidecar fetch when brand+category are set and `source !== 'genuine'`, then merges missing compatibles into the primary response (`products` for code-filtered calls, `series` for drilldown). `_enrichSeriesCodes(product)` derives codes from name/SKU as a backstop for any compatibles that still come back with empty arrays. SWR-cached so the customer pays for the sidecar once per brand+category per session. Pinned by `tests/compatible-products-recovery.test.js` (16 tests). Spec: `readfirst/compatible-products-recovery-may2026.md`.

**Backend action (still needed — frontend mitigation is a workaround, not a fix):**

1. Make `/api/shop` always project `series_codes` as it does on the `?source=compatible` path. The discrepancy is one join clause away — the SQL that populates the array on the source-filtered query needs to run on the default query too. This automatically fixes:
   - `/api/shop?code=X` server-side filter (no FE recovery needed)
   - `/api/search/smart` (recovery doesn't cover search; users searching `02` or `LC67` still see only genuines until backend lands)
   - Sitemap and structured-data emissions
   - Admin filter views

2. Once shipped, the frontend recovery becomes a no-op (the merge will find no compatibles missing from the primary response), but it can stay as defense in depth — there's no perf cost when the sidecar finds zero rows to add.

**Acceptance:**

- `GET /api/shop?brand=hp&category=ink&limit=10` returns at least one row with `source='compatible' AND series_codes!='{}'`.
- `GET /api/shop?brand=hp&category=ink&code=02` returns `meta.total ≥ 8` (the eight HP-02 compatibles).
- `GET /api/search/smart?q=02` returns those same compatibles in the products list.

---

## 9. "Inc. GST $X" breakdown — N/A

The PDP and cards no longer render the per-line GST breakdown (pinned by `tests/inc-gst-amount-removed.test.js`). No backend work required.

---

## 10. Test coverage to ship alongside backend changes

When the backend ships, add or extend these tests:

- `series_codes` projection — extend `tests/api-changes-may2026.test.js` to assert the field exists on each endpoint above.
- KCMY synthesis — add a test that asserts `GET /api/shop?series=DR233CL` returns at least one `pack_type='value_pack' AND color='KCMY'` row.
- Pack count vs name — a contract test that fails when any row has `name ~ '4[- ]?Pack' AND package_quantity != 4`.
- Reclassified HP143A genuine — `GET /api/search/smart?q=HP143A` must return the genuine row with `category.slug='toner'`.

---

## 11. Admin orders list — ship cost data per row

The dashboard's Revenue & Expenses chart wants per-order COGS so the pink
bar matches the order detail page exactly. Today the bulk endpoint
`GET /api/admin/orders` ships order-level fields but not item-level cost,
so the frontend falls back to a window-level KPI estimate
(`(revenue − gross_profit) × 1.15` distributed by revenue share).

**Ask:** Add ONE of the following to every row in `GET /api/admin/orders`:

- `items[]` with `supplier_cost_snapshot` and `qty` (matches the detail
  endpoint shape — easiest to consume), OR
- An aggregated `cost_total_excl_gst: number` on the order itself.

The frontend already prefers either field via
`inkcartridges/js/admin/utils/trend-math.js::orderCostInclGst`. Once
shipped, the dashboard chart's per-bucket COGS becomes exact and the
residual KPI fallback goes silent.

**Pinned by:** `tests/dashboard-trend-math.test.js` integration test for
the user's 4 May order fixture (asserts cost-incl-GST = $228.45 exact when
items[] are present).

---

## Source-of-truth pointers

- **Affected frontend memories:** `MEMORY.md` entries for catalog-overhaul, ink-finder-grouped, code-yield-grouping, color-display-order, dashboard-expenses-total-cash-out. Update once the backend ships `series_codes` everywhere.
- **Original specs reused for context:** `readfirst/api-changes-may2026.md` §1 (catalog ordering), `readfirst/code-yield-grouping-may2026.md`, `readfirst/color-display-order-may2026.md`, `readfirst/dashboard-expense-rebuild-may2026.md`.
- **This doc supersedes:** none.
