# Admin Products Page — Data & Calculation Reference (for Backend Review)

**Scope:** the admin **Products** list page (`/admin#products`, "All Products" tab).
**Date prepared:** 2026-06-24
**Frontend source of truth:**
- `inkcartridges/js/admin/pages/products.js` — page controller, table columns, data loading
- `inkcartridges/js/admin/utils/profitability.js` — ALL margin/markup/profit math
- `inkcartridges/js/admin/api.js` — `AdminAPI.getProducts` / `getProduct` (backend calls)
- `inkcartridges/js/api.js` — `API.getCompatiblePrinters` (compat column)

---

## ✅ Instructions for the backend developer

Please **review every data connection and every calculation** documented below and confirm each one is correct against the backend/database, or tell us what needs to change. Specifically:

1. **Confirm each "PULLED" field** below is a real column/field the backend returns on the documented endpoint, with the documented name, type, and unit (especially GST-inclusive vs ex-GST). Flag any field the frontend reads that the backend does **not** send.
2. **Confirm each "COMPUTED" value** uses inputs whose stored units match what the formula assumes. The profit math assumes **`retail_price` is stored GST-INCLUSIVE** and **`cost_price` is stored EX-GST**. If either assumption is wrong in the database, the margin/profit numbers shown to the owner are wrong — please confirm or correct.
3. **Confirm the two query paths agree.** The frontend loads rows either by a **direct Supabase query** OR by the **`/api/admin/products` backend endpoint** (see "Data load paths"). For the same filters they must return the same rows, counts, and ordering. Confirm the backend sort/filter semantics match what's documented.
4. **Confirm the server-side sorts** (`margin_pct`, `profit_ex_gst`) compute profit the **same way** as the frontend formula in `profitability.js`. If the backend sorts by a different profit definition than the page displays, rows will appear mis-ordered.
5. **Request or propose any change** by replying inline in this doc (per numbered item) — add a `> BACKEND:` note under any item that needs action. Provide or ask for anything else needed to verify correctness.

> ⚠️ **Repo convention note (for the FE team):** this project deletes backend handoff `.md` files after delivery (`tests/no-ghost-files.test.js`). Hand this file to the backend dev, then remove it from the repo once reviewed — do not leave it tracked long-term.

---

## 1. What loads the page

`loadProducts()` in `products.js` runs on every filter/sort/page change. It picks **one of three** paths:

| # | Path | When used | Returns |
|---|------|-----------|---------|
| A | **Backend API** `/api/admin/products` | a margin/profit **sort** is active, OR an **image** filter, OR a **stock** filter is set (and source ≠ ribbon) | server already filters/sorts |
| B | **Direct Supabase** `from('products').select(...)` | the normal/default path (fast — skips the Render hop) | client maps brand + image |
| C | **Backend API fallback** | Supabase path throws | same endpoint as A, fewer filters |

`products.js:616` decides path A:
```js
const isMarginSort = _sort === 'margin_pct' || _sort === 'profit_ex_gst';
const ribbonUmbrella = _sourceFilter === 'ribbon';
const needsBackend = !ribbonUmbrella && (isMarginSort || !!_imageFilter || !!_stockFilter);
```

> BACKEND: please confirm paths A and B return **identical row sets, counts, and order** for the same filters.

### Path A/C — backend endpoint contract

`AdminAPI.getProducts(filters, page, limit)` (`api.js:498`) calls:

```
GET /api/admin/products?page={n}&limit={n}&...
```

Query params the FE sends:

| Param | Source state | Notes |
|-------|--------------|-------|
| `page` | `_page` | 1-based |
| `limit` | `LIMIT` | page size |
| `brand` | `_brandFilter` | brand id |
| `search` | `_search` | matched against name + SKU |
| `is_active` | `_activeFilter` | `'true'`/`'false'` |
| `sort` | `_sort` | column key (see §3) |
| `order` | `_sortDir` | `asc`/`desc` |
| `source` | `_sourceFilter` | genuine / compatible / remanufactured / ribbon |
| `product_type` | `_typeFilter` | ink_cartridge / toner_cartridge / printer_ribbon / … |
| `category` | — | available, not currently sent by this page |
| `has_images` | `_imageFilter` | `'true'`/`'false'` |
| `stock_status` | `_stockFilter` | stock filter value |
| `is_reviewed` | — | used by the review queue, not this page |

Expected response shape (FE reads, `products.js:631`):
```js
const rows = Array.isArray(data) ? data : (data.products || data.data || []);
const pagination = data.pagination || { total: data.total || rows.length, page, limit };
```
> BACKEND: confirm the response envelope is `{ ok, data: { products: [...], pagination: { total, page, limit } } }`.

### Path B — direct Supabase select

`products.js:633` selects **exactly** these columns from `products` (+ joins):
```
id, sku, name, retail_price, cost_price, is_active, import_locked,
is_reviewed, reviewed_at, reviewed_by_email, image_url, color, source,
weight_kg, page_yield, category, product_type, brand_id, description,
description_html, compatible_devices_html, compare_price, meta_title,
meta_description, tags, internal_notes,
brands(name, slug),
product_images(path, is_primary, sort_order)
```
Supabase-side filters applied: `brand_id`, `name/sku ilike` search, `is_active`, `source` (or `product_type IN (...)` for the ribbon umbrella), `product_type`, image presence, `stock_status`, ordering, range pagination.

> BACKEND: confirm every column above still exists on `products` with these names and that `brands` / `product_images` FKs are intact.

---

## 2. Table columns — what is PULLED vs COMPUTED

Column builder: `buildColumns()` in `products.js` (≈ line 130–243). Owner-only columns (Cost, Margin %, Profit $) only render when `AdminAuth.isOwner()`.

| Column (header) | Origin | How it's derived |
|-----------------|--------|------------------|
| **Image** | PULLED | `image_url` → else primary `product_images.path` → else lowest `sort_order` |
| **Name** | PULLED | `name` |
| **SKU** | PULLED | `sku` |
| **Brand** | PULLED | joined `brands.name` (mapped from `brand_id`) |
| **Price** | PULLED | `retail_price` (falls back to `cost_price` if null) — **displayed as stored** |
| **Cost** *(owner)* | PULLED | `cost_price` — displayed as stored |
| **Margin %** *(owner)* | **COMPUTED** | `computeProfitability(row).marginPct` — see §4 |
| **Profit $** *(owner)* | **COMPUTED** | `computeProfitability(row).profitDollars` — see §4 |
| **Type** | PULLED | `source` (genuine/compatible/remanufactured/ribbon) → coloured badge |
| **Active** | PULLED | `is_active` (≠ false ⇒ on) |
| **Lock** | PULLED | `import_locked` (+ `product_type` to choose lock copy) |
| **Compat** | PULLED (async) | count from `GET /api/search/compatible-printers/{sku}` — see §5 |
| **For Use In** *(optional col)* | PULLED (async) | Supabase `product_ribbon_brands` junction — see §5 |

> **NOTE:** The **Markup %** column was **removed on 2026-06-24** by request. The `markupPct` value is still computed in `profitability.js` (used by the separate `/admin#margin` analytics page) but no longer shown on this products table.

---

## 3. Sorting, filtering, pagination

State variables (`products.js:82–95`): `_page`, `_search`, `_sort`, `_sortDir`, `_brandFilter`, `_activeFilter`, `_imageFilter`, `_sourceFilter`, `_typeFilter`, `_stockFilter`.

- **Default sort:** `name` ascending.
- **Sortable column keys:** `name`, `sku`, `brand` (→ `brand_id` in Supabase), `retail_price`, `cost_price`, `margin_pct`, `profit_ex_gst`, `source`, `is_active`, `import_locked`.
- **Computed-value sorts** (`margin_pct`, `profit_ex_gst`) force **Path A (backend)** so the server orders by profit — the page only holds one page of rows, so it can't sort the whole table client-side.
  - **Exception — ribbon umbrella** (`source=ribbon`): forced through Supabase, then the page sorts the current page **client-side** (`products.js:695`):
    ```js
    const key = _sort === 'profit_ex_gst' ? 'profit_dollars' : 'margin_pct';
    ```
    (uses `computeProfitability()` values for each row).

> BACKEND: confirm the server's `sort=margin_pct` and `sort=profit_ex_gst` use the **same profit definition** as §4. If they differ, the displayed order won't match the displayed numbers.

> BACKEND: confirm `source=ribbon` on the endpoint expands to the full ribbon umbrella `product_type IN (printer_ribbon, typewriter_ribbon, correction_tape)` — the FE works around an older backend that only matched `source='ribbon'` (34 legacy rows). If the backend now expands it, the FE workaround can be simplified.

---

## 4. The profit calculation (CRITICAL — please verify the unit assumptions)

All math lives in `computeProfitability(row)` (`profitability.js:31`). It is **GST-neutral** (GST is a pass-through that nets to zero) and runs **entirely on the frontend** from two stored fields: `retail_price` and `cost_price`.

### Constants (`profitability.js:26–28`)
```
GST_RATE     = 0.15      // NZ GST 15%
STRIPE_RATE  = 0.0265    // NZ domestic card 2.65%
STRIPE_FIXED = 0.30      // $0.30 per transaction (per-ORDER, not per product row)
```

### Stored-unit assumptions (MUST be confirmed)
- **`retail_price` is stored GST-INCLUSIVE.**
- **`cost_price` is stored EX-GST**, and is deducted **as-is** (NOT grossed up — the GST paid to the supplier is reclaimed as an input tax credit).

### Formulas (per product row)
```
priceExGst    = retail_price / 1.15
stripeFee     = retail_price × 0.0265        // 2.65% of the GST-inclusive charge
profitDollars = priceExGst − cost_price − stripeFee
marginPct     = profitDollars / priceExGst × 100      // % of ex-GST revenue
markupPct     = profitDollars / cost_price × 100      // % of supplier cost (computed, no longer displayed here)
```

### Guard
If `retail_price` or `cost_price` is missing / ≤ 0, every output is `null` and the cell renders `—` (`profitability.js:34`). Margin/Profit are never shown as `$0.00` when an input is unknown.

### What the row-level math does NOT include
- The **$0.30 fixed Stripe fee** is **per order**, so it is intentionally NOT subtracted on a per-product row (only the 2.65% rate is). The full per-order math (with the $0.30 allocated across lines) lives in `computeOrderProfit` / `computeLineProfits` / `computeProfitBreakdown` in the same file — used by the **dashboard/orders**, not this products table.

> BACKEND: **please confirm both stored-unit assumptions** (`retail_price` incl-GST, `cost_price` ex-GST). This is the single most important thing to verify — if either is stored differently, every owner-facing margin/profit on this page is wrong.

> BACKEND: confirm Stripe's NZ domestic rate is still **2.65% + $0.30**. If your Stripe contract differs, give us the correct numbers.

---

## 5. Async columns (filled after the table renders)

`loadRowExtras()` (`products.js:479`) runs after each render and fills two columns that need extra reads.

### Compat (printer count)
- Each row first renders a placeholder `—` with `data-compat-sku="{sku}"`.
- `loadCompatCounts()` (`products.js:389`) batches **5 SKUs at a time** (300 ms gap) and calls:
  ```
  GET /api/search/compatible-printers/{sku}
  ```
- Reads `res.data.compatible_printers` (or `res.data.printers`); renders `N printers` or `⚠ None`.

> BACKEND: confirm `/api/search/compatible-printers/{sku}` returns `{ data: { compatible_printers: [...] } }`. Confirm batching 5×/300 ms is within rate limits, and that "⚠ None" genuinely means zero compatible printers (not a data gap).

### For Use In (ribbon brands — optional column)
- `loadForUseInBrands()` (`products.js:434`) does ONE batched **Supabase** read of `product_ribbon_brands` joined to `ribbon_brands` for all visible product ids, rendered as brand chips.

> BACKEND: confirm `product_ribbon_brands` (FK `product_ribbon_brands_ribbon_brand_id_fkey`) and `ribbon_brands(id, name)` are correct.

---

## 6. PDF export

`Export` builds a PDF (`products.js` ≈ 3376). Header + body for owners:
```
Name, SKU, Brand, Price, [Cost, Margin %, Profit $], Active
```
Cost/Margin/Profit cells reuse `computeProfitability(p)` — same math as §4. (Markup column was removed here too on 2026-06-24.)

---

## 7. Product drawer (edit) — fields written back

Opening a row calls `GET /api/admin/products/{id}` (`api.js:544`) and merges with the list row. Saving writes via `PUT /api/admin/products/{id}` with this payload (`products.js` ≈ 1095):
```
brand_id, product_type, color, source, retail_price, compare_at_price,
weight_kg, is_active, description_html, compatible_devices_html,
meta_title, meta_description, page_yield, tags[], internal_notes
+ cost_price   (owner only)
```
> BACKEND: confirm `PUT /api/admin/products/{id}` accepts all of these field names and that `compare_at_price` (sent) maps to the `compare_price` column (read on load). The read uses `compare_price`; the write sends `compare_at_price` — **please confirm these are the same field** or tell us the canonical name.

---

## 8. Summary of items needing a backend ✅ / change request

| # | Item | Confirm |
|---|------|---------|
| 1 | `retail_price` stored **GST-inclusive** | ☐ |
| 2 | `cost_price` stored **ex-GST**, deducted as-is | ☐ |
| 3 | Stripe NZ = **2.65% + $0.30** | ☐ |
| 4 | `/api/admin/products` envelope `{ ok, data: { products, pagination } }` | ☐ |
| 5 | Server `sort=margin_pct` / `profit_ex_gst` use the §4 profit definition | ☐ |
| 6 | `source=ribbon` expands to the 3 ribbon `product_type`s | ☐ |
| 7 | Supabase `select` columns (§1) all exist | ☐ |
| 8 | `/api/search/compatible-printers/{sku}` shape + rate limits | ☐ |
| 9 | `product_ribbon_brands` / `ribbon_brands` joins | ☐ |
| 10 | Write `compare_at_price` == read `compare_price` (same column?) | ☐ |

Please tick / annotate each, and add `> BACKEND:` notes inline where anything needs to change.
