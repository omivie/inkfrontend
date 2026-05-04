# Storefront API Changes — May 2026

**For:** storefront / frontend team
**Backend release:** May 4–5 2026 (catalog overhaul + naming + sort + pack-resolver hardening)
**Compatibility:** **mostly additive.** One string-format change on compatible product names — review any client-side regex parsing of `name`. Everything else is additive or a server-side correctness fix.

Companion: read [`api-changes-april-2026.md`](./api-changes-april-2026.md) first if you haven't applied that round yet (`canonical_url`, GST disclosure, discount badges, free-shipping nudge, etc.). Everything in this doc layers on top.

---

## TL;DR — what to do (or not do)

| Area | Change | Frontend action |
| --- | --- | --- |
| **Sort order** | Every product-list endpoint now applies a fixed catalog hierarchy server-side. | **Do NOT re-sort client-side.** Render in API order. |
| **Compatible name format** | New: `Compatible <Type> Cartridge Replacement for <Brand> <Codes> <Color>`. Old format gone. | If you regex `name` to extract brand/model/color, switch to fields (`brand.name`, `color`, `series_codes`). |
| **Search ranking** | `/api/search/smart` adds a name-token boost (server-side). | None. The score field is unchanged in shape. |
| **Epson chip page** | Specialty colors (T3127 Red, T3128 Matte Black, T3129 Orange, T0495 Light Cyan, …) now collapse into their base T-series chip. Bare-numeric Epson series (`212`, `802`, `46S`) are now their own chips. | If you cache chip-grid responses, bust caches once — chip counts will move. |
| **Pending Changes admin UI** | Bulk-approve script REJECTS genuine `image_url` rows (was "leave pending"). Counter drops sharply. | None. `status` field already supports `'rejected'`. |
| **Pack rendering** | More legitimate value packs (HP 63 KCMY, Brother DR233CL CMY drum, etc.) survive the orphan-deactivation sweep. | None. Just expect more pack rows. |
| **Catalog coverage** | Genuine 89.9% → 98.7%, Compatible 93.8% → 99.7%. ~270 products recovered. | None. More products on the storefront. |

---

## 1. Catalog sort hierarchy — **server-side, do not re-sort**

Every product-list endpoint now applies `sortByCatalogOrder` from `src/utils/productSort.js`. The sort key is:

```
(accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)
```

Where:

- `accessoryTier`: 0 for cartridges/toner/drums, 3 for paper/printer/label-tape (sort to end)
- `yieldTier`: 0 standard, 1 XL/HY, 2 XLL/SHY/XXL — **HY is treated identically to XL**
- `seriesBase`: e.g. `"LC3317"`, `"LC3319"`, `"LC3329"` (yield suffix stripped)
- `colorOrder`: 0 K, 1 C, 2 M, 3 Y, 4 CMY-pack, 5 KCMY-pack, 6 specialty (Photo/LC/LM/Red/MBK/Orange), 7 unknown
- `packRank`: 0 single, 1 value_pack, 2 multipack
- `name`: alpha tiebreak

Endpoints applying this:

- `GET /api/shop` — all variants (brand, category, code-filter, printer-fallback)
- `GET /api/products/printer/:slug`
- `GET /api/printers/:slug/products`
- `GET /api/search/by-printer` — **fixed today** (was unsorted, exposed by user 2026-05-05 paper-before-XL bug)
- `GET /api/search/by-part` — **fixed today** (same)
- `GET /api/prerender/printer/:brandSlug/:printerSlug`
- `GET /api/prerender/category/:category`

`GET /api/search/smart` uses `sortByRelevance` (relevance score primary, catalog hierarchy as tertiary tiebreaker). Same shape, score-aware.

### Frontend rule

**Render rows in the order the API returns them.** If your code does `products.sort(...)` on the response, **delete that line**. The hierarchy you'd build client-side cannot be stable because pack/yield/series detection requires the same regex set the backend uses. You will mis-sort.

The Brother MFC-J6945DW page rendered Paper before LC3339XL until 2026-05-05 because `/api/search/by-printer` was the only endpoint not yet wired to the sort util — that's now fixed server-side.

### Expected order on a Brother LC3317 / LC3319XL / LC3329XXL printer page

```
LC3317-Black, LC3317-Cyan, LC3317-Magenta, LC3317-Yellow, LC3317-CMY-pack, LC3317-KCMY-pack
LC3319XL-Black, LC3319XL-Cyan, LC3319XL-Magenta, LC3319XL-Yellow, LC3319XL-CMY-pack, LC3319XL-KCMY-pack
LC3329XXL-Black, LC3329XXL-Cyan, LC3329XXL-Magenta, LC3329XXL-Yellow, LC3329XXL-CMY-pack, LC3329XXL-KCMY-pack
BP60MA-Paper, BP71GA4-Paper, BP71GP20-Paper
```

Within a tier, Genuine and Compatible are interleaved in the response. If your UI splits them into two sections, it's safe to filter by `source` — the per-source ordering preserves the hierarchy.

---

## 2. Compatible product name format

**Old format (pre-2026-05-04):**

```
Brother Compatible LC37/LC57 Ink Cartridge Black
HP Compatible CF400X Black Toner Cartridge
HP Compatible 96A (C4096A) Black Toner Cartridge
```

**New format:**

```
Compatible Ink Cartridge Replacement for Brother LC37/LC57 Black
Compatible Toner Cartridge Replacement for HP 201X (CF400X) Black
Compatible Toner Cartridge Replacement for HP 96A (C4096A) / Canon EP32 Black
Compatible Ink Cartridge Replacement for Brother LC37/LC57 KCMY 4-Pack
```

Multi-brand cross-compat is supported and surfaces in the name (e.g. `HP 96A (C4096A) / Canon EP32`). The supplier (Augmento.xlsx) already encodes multi-brand cross-compat in the description; the new builder splits and re-formats it.

**Genuine product names are UNCHANGED.** Only `source = 'compatible'` rows changed format.

### Frontend impact

Any client-side regex on `name` to extract brand / model / color **will break** for compatible products. Two examples we know about:

- Splitting `name` on `Ink Cartridge` to extract the model — no longer works (the new format puts "Ink Cartridge" right after "Compatible", not after the model).
- Detecting source from the name — was previously inferable from leading `<Brand> Compatible…`. Now use the `source` field directly.

**Action:** stop parsing `name` for structural data. Use these fields instead:

```ts
type Product = {
  source: 'genuine' | 'compatible';
  brand: { name: string; slug: string; ... };
  color: 'Black' | 'Cyan' | 'Magenta' | 'Yellow' | 'CMY' | 'KCMY' | 'Photo' | string;
  pack_type: 'single' | 'value_pack' | 'multipack';
  product_type: 'ink_cartridge' | 'toner_cartridge' | 'drum_unit' | 'photo_paper' | 'label_tape' | string;
  // ...
};
```

For the customer-visible series chip codes, the API returns `series_codes: string[]` on shop responses (e.g. `["LC3317", "LC3319XL"]`). Trust that — the backend uses the same `extractSeriesCodes` you'd want.

---

## 3. Search ranking — name-token boost

`GET /api/search/smart` now applies a server-side `+50` per query-token name match (capped at `+150`) on top of the `ranked_product_search` RPC score. The boost runs after stripping page-yield parentheticals from the name (so "Brother Genuine LC3311 Ink Cartridge Black (200 Pages)" does NOT receive a `q=200` boost — only Epson Genuine 200 does).

### What changed in the response

Nothing. The `score` field is unchanged in shape — it's just larger for products whose name contains the query.

### Why it matters

The user reported that searching `q=200` returned `HP 126A` and `Brother LC3311` interleaved with Epson 200 family because the page-yield "200" in their description was matching the RPC's tsvector. The boost gives explicit-name-match products clear ranking dominance without rewriting the SQL function.

### Frontend rule

Render search results **in API order**. Do not re-rank client-side.

---

## 4. Series chip aggregation

The `GET /api/products/series` chip-grid response was rebuilt around two fixes:

### 4a. Epson specialty colors collapse

Previously T3127 (Red), T3128 (Matte Black), T3129 (Orange) appeared as separate single-product chips next to T312 (which had 5 products). They now collapse into the T312 chip (8 products).

**Mappings** (in `src/utils/epsonSeries.js`):
- digit 0: Gloss Optimiser / Light Light Black
- digit 1: Black variants (Photo Black, Matte Black, Pigment Black, plain Black)
- digit 2: Cyan
- digit 3: Magenta
- digit 4: Yellow
- digit 5: Light Cyan
- digit 6: Light Magenta
- digit 7: Red / Light Light Black (UltraChrome HD)
- digit 8: Matte Black / Orange (series-dependent)
- digit 9: Orange / Photo Gray (series-dependent)

This applies to both T-prefixed 3-digit codes (T312, T049, T087) and 4-digit forms (T3127, T0495, T0878). Pinned by `__tests__/extractSeriesCodes-epson-digit-suffix.test.js`.

### 4b. Bare-numeric Epson chips appear

Epson sometimes ships codes without the `T` prefix (`212`, `46S`, `802`, `604`). These previously failed the chip extractor's letter+digit gate and got dropped. They're now first-class chips.

**Important:** `312` (consumer Epson 312 with HY/LC/LM variants) and `T312` (SureColor pro photo extended-gamut) are **different physical product families**. Both appear in the chip grid — do not merge them.

### Frontend rule

If you cache chip-grid responses, bust caches once. Chip codes won't change (T312, 312) but counts will.

---

## 5. Pack rendering — more legitimate packs survive

`detectStalePacks` (the orphan deactivation sweep that runs daily and during every import) now exempts feed-supplied packs. Tri-color cartridges that ship as a single physical product without separate C/M/Y constituents (HP 63 KCMY, Brother DR233CL CMY drum, Lexmark 73D0Q00 toner) used to be silently deactivated on every run because the resolver couldn't find their constituents. They survive now.

`packResolver` also recognises:
- Brother LC*/Canon CART* letter-encoded color in series (`G-BRO-LC536C-INK-CY`, `G-CAN-CART329BK-TNR-BK`)
- Generalized digit-suffix (Epson T6641-T6644 → T664, **and** Fuji Xerox CT201370-CT201373 → CT20137; previously Epson-only)
- Legacy `<base>-INK-KCMY-4PK` SKU shapes (e.g. `G-BRO-LC536XL-INK-KCMY-4PK`)

### Frontend impact

Some pack rows that were previously hidden (deactivated) will reappear. They were always real products — just incorrectly deactivated by the resolver. No code change needed.

If your UI has a "no longer available" fallback when a pack's constituents look broken, it'll fire less often. Still keep the fallback — `filterBrokenPacks` (server-side, applied to all 8 pack-returning endpoints) handles the actual broken-constituent case.

---

## 6. Pending Changes admin UI

The bulk-approve flow (`scripts/approve-pending-except-genuine-singles-and-cmykcmy.js`) now **REJECTS genuine `image_url` field changes** instead of leaving them pending. The `pending_product_changes.status` enum already supports `'rejected'` (no schema change). Per-row API shape:

```ts
type PendingChange = {
  id: string;
  product_id: string;
  sku: string;
  source: 'genuine' | 'compatible';
  change_type: 'ADD' | 'UPDATE' | 'DEACTIVATE';
  status: 'pending' | 'approved' | 'rejected' | 'partial' | 'superseded';
  changed_fields: string[];                    // e.g. ['cost_price', 'retail_price', 'image_url']
  field_decisions?: Record<string, 'approved' | 'rejected'>;  // per-field after partial review
  // ...
};
```

### What's new

- Rows can land in `status='partial'` when some fields approve and others (genuine `image_url`) reject.
- `field_decisions` is the per-field map, populated by `reviewChange` and the bulk-approve script.

### Frontend impact

If you render pending counts, **a one-time large drop** (~700 → ~50) is expected after the admin runs the bulk approval. If your UI has filter chips by `status`, add `'partial'` if you don't already.

---

## 7. Pack-returning endpoints — pack guard rollout

`filterBrokenPacks` (drops any value/multipack whose constituent singles are missing or inactive) now runs on all 8 product-returning surfaces:

- `/api/shop`
- `/api/products/printer/:slug`
- `/api/printers/:slug/products`
- `/api/search/smart`
- `/api/search/by-printer`
- `/api/search/by-part`
- `/api/prerender/printer/:brandSlug/:printerSlug`
- `/api/prerender/category/:category`

5-minute per-pack-SKU verdict cache, fail-open posture (a query failure serves the un-vetted slice rather than blocking the whole response). Frontend doesn't see anything different — packs that would have led to a broken cart just don't appear.

### Frontend impact

None. But if you have an "Add to cart" handler with a fallback for "constituent missing" errors, it'll fire less often.

---

## 8. Catalog reconciliation results

For visibility — these are server-side improvements that ship more inventory to the storefront:

| Source | Before session | After |
| --- | --- | --- |
| Genuine (DSNZ.txt → DB active) | 2363 / 2628 = 89.9% | **2593 / 2628 = 98.7%** |
| Compatible (Augmento.xlsx → DB active) | 607 / 647 = 93.8% | **645 / 647 = 99.7%** |

**Recovered:** ~280 products. Mostly Lexmark digit-leading toners (12A7462, 56F6X0E), Brother label tapes (TZeMPRG31, TZeFX431, TC201, TZeRW34), Brother dual-pack drums (BR233 4-pack), Canon Twin Packs (PG640/CL641 XL Twin), HP+Canon multi-brand cross-compat toners, and ~50 dormant rows that the auto-reactivation gate had been blocking.

**Remaining gap (50 products, all policy-bounded — not bugs):**

- 5 Dell toners (`D1320XB/XC/XM/XY`, `D1265X`) — Dell isn't in `ALLOWED_BRANDS`. Add to that list if Dell coverage is desired.
- 2 Epson POS ribbons (`IERC23`, `IERC30`) — ribbon imports are excluded by policy. Manual upload via admin only.
- ~40 stragglers from supplier feed-data errors (e.g. CART055BHY's name says "Black HY" but the supplier's color column says "Yellow") and edge-case Brother TZE color variants.

---

## 9. New / updated server-side helpers

For reference if your test fixtures or local dev tooling depends on these:

- `src/utils/feedHelpers.js`
  - `buildBrandGroupedCodes(modelPortion, primaryBrand)` — splits a stripped name into per-brand `{brand, codes[]}` groups
  - `formatBrandGroupedCodes(groups)` — joins them with HP marketing-series transform per group
  - `BRAND_SENTINELS` — list of recognised brand prefixes
  - `extractModelNumber` — page-yield parenthetical stripped before regex pass; rejects size-string false positives (`12MM`, `57X32MM`, `12MMX4M`); adds Lexmark digit-leading codes (`12A7462`, `56F6X0E`), Brother TZ multi-letter color variants (`TZeMPRG31`, `TZeFX431`), and Brother TC tapes (`TC201`)
- `src/utils/productSort.js`
  - `sortByCatalogOrder(products)` — primary sort for browse pages
  - `sortByRelevance(products)` — score-aware sort for `/search/smart`
  - `yieldTier`, `colorOrder`, `seriesBase`, `accessoryTier` — exported helpers
- `src/utils/epsonSeries.js`
  - `colorMatchesDigit(digit, color)` — extended to digits 5–9
  - `EPSON_DIGIT_SUFFIX_RE` — now `^(T\d{3})([0-9])$`
- `src/utils/colorPackGenerator.js`
  - `buildCompatiblePackName({packType, count, productTypeName, displayBrand, displaySeries})` — single source of truth for compatible pack names; backfill script `scripts/backfill-compatible-pack-names.js` rewrites legacy rows
  - `detectStalePacks(supabase, validPackSKUs, source, feedSupplierSKUs)` — accepts `feedSupplierSKUs` to exempt feed-supplied tri-color packs from orphan deactivation
- `src/utils/packResolver.js`
  - `analyzePackConstituents` / `resolvePackConstituentSkus` / `findBrokenPackConstituentsBatch` — letter-encoded color probe + generalized digit-suffix probe; legacy-base path injects the color letter at the `seriesPart`/`categoryPart` boundary
- `scripts/lib/pendingApprovalFilter.js`
  - `decidePending(row, packTypeResolver)` — returns `'reject_all' | 'approve_partial_reject' | 'approve_all' | 'skip'`

---

## 10. Migration / rollback notes

Nothing in this round requires a frontend deploy. The backend changes are server-side only and the response shapes are additive (no field removed, no type changed except the compatible-name string format).

**If you ship a frontend update that consumes new fields or relies on the new sort:**

- Test against `/api/products/printer/brother-mfc-j6945dw` — paper should be last.
- Test against `/api/search/smart?q=200` — Epson 200 family should occupy the top.
- Test against `/api/shop?brand=brother&category=ink&code=LC37` — compatible KCMY pack and 4 compatible singles, names start with `Compatible Ink Cartridge Replacement for Brother LC37/LC57`.

**To roll back the naming-format change** (if a regex on the frontend breaks before you can patch): there's no toggle. The compatible names are committed in the DB. You can rewrite them with `scripts/backfill-compatible-pack-names.js` (for packs) and the `compatible.js` import path (for singles) — but easier to just patch the regex on the frontend.

**For questions:** see `CLAUDE.md` "Search response contract" and "Pack Naming Convention (May 2026)" sections.
