# FE reply: best sellers (BF-089, BF-090) and round 2 of the four replies (BF-088, BF-091, BF-092, BF-093)

**From:** FE · **For:** backend · **Date:** 2026-09-29
**Answers:** `fe-best-sellers-and-four-replies-round2-backend-response-sep2026.md` (all but §8, which `business-apply-FE-reply-sep2026.md` answers as ERR-297)
**FE ref:** ERR-299 · **New ask:** BF-094

Thank you. We measured every claim on production before we deleted anything. Every claim held. Each workaround your builds made unnecessary is now deleted from the frontend.

## 0. Build identity

`GET /health` returns `data.commit` = `75370e0…`, not the `e89c470` your doc names. All the behaviour your doc describes is live on `75370e0`, so this changes nothing for us. We note it only so the two logs agree.

## 1. BF-089 and BF-090: built on

Measured all-time: 199 rows, 199 distinct `product_sku`. Every row carries `sale_skus`, `product_id`, `brand`, `product_type`, `pack_type` and `source`. 33 products were sold under another SKU.

- We deleted our merge-by-SKU step and our direct `products` catalogue read. If a SKU ever arrives on two rows again, we now count it and say so on screen. We do not merge it.
- We show `sale_skus` as "sold as …" under the product. As you said, that is the key for matching an order line.
- A row with `pack_type: null` is shown as "no longer in the catalogue". There are 0 such rows today.
- Every filter bites. Measured negative controls: an unknown category or supplier gives 0 rows, and an unknown status gives 400. `hp` and `HP` both give 41 rows.
- `sort_by` gives 400 `VALIDATION_FAILED` naming the parameter. We measured that every parameter we send is accepted: `date_from`, `date_to`, `result_limit`, `granularity` and all four filters. A 400 is now shown to the admin with your message. It is never shown as an empty ranking.

**Your question: what does our category control send?** `CON-*` codes, never storefront slugs. The global filter bar's category list had never been filled before this change. It now carries the fixed list `CON-INK, CON-LASER, CON-RIBBON, CON-LABELS, CON-PAPER, CON-COPIER, CON-A3, CON-FAX, CON-OTHER, HW-ACCESS`. It is shown only on pages that ask for it; today that is Best Sellers only. Measured: `category_filter=ink` gives 0 rows and `CON-INK` gives 134. Checked in the browser: selecting Ribbons gives 16 rows, all ribbon types.

## 2. BF-088: agreed, the view read is deleted

`code=950XL` and `code=950` list the same two products (`C950XLBK`, `G950XLBK`). Our probe read `product_code_chip_counts` and checked every override code it lists: 21 codes in 4 brand·category groups. Each one is in `series`, either under its own code or under its base chip with the yield tier stripped. That read was the last one in our manual-code layer, so the whole layer is gone. **The storefront now makes no `product_codes` read of any kind.** The view is still in the database; dropping it is the owner's call. The frontend no longer needs it.

## 3. BF-091: built on

Drums, `/api/products/counts` against `?category=drums` `meta.total`: epson 5/5, canon 12/12, brother 61/61, hp 33/33, lexmark 72/72. The `/api/shop` counts facet agrees as well. We deleted both confirming reads. A 0 or absent count now hides the tile directly. Our probe compares the two numbers on every run, so drift would show up there rather than on the page.

## 4. BF-092: built on

`307.11` → `C141LOT`, `C143LOT`; `153.11` → `C143LOT`; `72200.01` → `72200.02`; `691.01` → `[]`. Each card carries `in_stock` and `stock_status`. The ribbon product page now renders `related_products` and makes no Supabase read. Measured in the browser: the local build makes 0 direct `products` reads on the ribbon page; production, before our deploy, still makes one.

We treat `null` as a failed lookup and show a retry message. `[]` means nothing to show.

## 5. BF-093: built on, with one gap left, BF-094

`display_name` is read first everywhere it is present: the product-page printer lists and fit checker, the printer hub name, the fit line and the ink finder tiles. Across 47 sampled printers it equals the prerender `<h1>`. The `E-ALL-IN-ONE-PRINTER` entry is covered by your side now.

**BF-094: `display_name` is missing on two surfaces we render.**

| Surface | Measured 2026-09-29 |
|---|---|
| `GET /api/shop` (and `/api/products`) listing rows, `compatible_printers[]` (the card "Fits …" line) | 0 of 40 rows carry it: `{ slug, full_name }` only |
| `GET /api/printers/search?q=` (the landing printer finder) | 0 of 2 rows carry it |

Until these carry `display_name`, we keep our copy of your name rule (the mirror that drifted within a day in ERR-294) as the fallback for these rows only. Once they carry it, we delete the mirror. Our probe checks both surfaces on every run and will tell us when to delete it.

## 6. Still with the owner

BF-077 (the $0.50 test order) and the apex 307 → 308 redirect. Thank you for excluding test orders from every order analytic.
