# Backend response: best sellers (BF-089, BF-090) and your reply to our four replies (BF-088, BF-091, BF-092, BF-093)

**From:** backend · **For:** FE developer · **Date:** 2026-09-29
**Answers:** `best-sellers-top-products-backend-brief-sep2026.md` (ERR-295) and `four-replies-backend-response-FE-reply-sep2026.md` (ERR-294)
**Backend build:** `e89c470` on `api.inkcartridges.co.nz` (`GET /health` → `data.commit`). It contains `7ab32fa` (BF-092, BF-093). Migrations 192 and 193 are applied to production.

Thank you for the negative controls. The `status_filter` / `category_filter` result is exactly the failure a normal test cannot see.

| Ask | Status |
|---|---|
| BF-089 one row per product | **Built** |
| BF-090 ignored filters | **Built.** Both filters work, and the endpoint now rejects unknown parameters. |
| Optional `brand` / `product_type` / `pack_type` | **Built** |
| BF-088 `950XL` chip | **Declined.** No change is needed; you can delete the view read now. |
| BF-091 counts undercount | **Built** |
| BF-092 ribbon `related_products` | **Built** |
| BF-093 `display_name` | **Built** |
| §5 turnaround doc | **Sent** with this reply |
| §5 #10 `/business` Apply | **The endpoint exists.** Your 404 came from a GET. See §8. |

---

## 1. BF-089: one row per product

`GET /api/admin/analytics/top-products-rpc` now groups by **product** (`order_items.product_id`), not by the order line's name and SKU.

| Field | Meaning |
|---|---|
| `product_sku` | The product's **current** SKU |
| `product_name` | The product's **current** name |
| `sale_skus` | New. Every SKU the product was sold under, sorted |
| `product_id` | New |
| `brand`, `product_type`, `pack_type`, `source` | New (the optional ask). Read from the product row. For a product that no longer exists, `brand`, `product_type` and `source` come from the order line's own snapshot, and `pack_type` is `null`. |
| `revenue`, `units_sold`, `order_count` | Unchanged meaning |

Measured all-time on production, before and after:

| | Before | After |
|---|---|---|
| Rows | 209 | **199** |
| Distinct `product_sku` | 202 | **199** |
| Revenue | 24,985.25 | 24,985.25 |
| Units | 353 | 353 |

The six SKUs you named that still exist under the same SKU (`CLC431XLKCMY`, `CTN258XLKCMY`, `CTN258XLBK`, `CLC3319XLKCMY`, `CLC3317KCMY`, `CLC73BK`) are each one row now.

**Why 199 and not 202.** Three products were sold under two SKUs, because the product was renamed between sales. Each is now one row:

| `product_sku` (current) | `sale_skus` |
|---|---|
| `CTN258XLBK` | `C-BRO-TN258XL-TNR-BK`, `CTN258XLBK` |
| `GPG640VPVP` | `G-CAN-PG640-INK-VP-2PK`, `GPG640VPVP` |
| `GPG660XLHYBK` | `GPG660XLBK`, `GPG660XLHYBK` |

The seventh SKU you named, `C62BK`, is now reported as **`C62XLBK`** with `sale_skus: ["C62BK"]`. That cartridge's own part number (C2P05AA) is HP 62**XL**, and the HP compatible XL repair renamed it.

**For your reconciliation against `/api/admin/orders`:** order lines carry the sale-time SKU. So match an order line to a best-sellers row through `sale_skus`, not `product_sku`. Your merge by SKU is now a no-op, as you expected.

**Brand, type and pack:** all 199 rows carry `brand` and `product_type`. Your 33 "no longer in the catalogue" SKUs were renamed SKUs: every order line still points at a live product row. So the "—" fallback should no longer appear.

## 2. BF-090: every filter is honoured, and an unknown parameter is a 400

| Parameter | Meaning |
|---|---|
| `status_filter` | Comma list of order statuses. It **replaces** the default rule. Valid values: `pending, invoiced, paid, processing, shipped, delivered, completed, cancelled, refunded`. A value outside this list returns **400 `VALIDATION_FAILED`**, and the message names the value. |
| `category_filter` | Comma list of `products.category` codes (`CON-INK`, `CON-LASER`, `CON-RIBBON`, `CON-LABELS`, `CON-PAPER`, `CON-COPIER`, `CON-A3`, `CON-FAX`, `CON-OTHER`, `HW-ACCESS`). Not case-sensitive. The dashboard chart endpoints use the same values, so the card and the charts agree. |
| `supplier_filter` | Supplier name (`suppliers.name`). Not case-sensitive. We added it because the global filter bar carries it. |
| `brand_filter` | Brand **name or slug**. Not case-sensitive. It used to accept the exact current brand name only. |
| `granularity` | Accepted and has **no effect**, because a ranking has no time buckets. We accept it because the global filter bar sends it with every call. |
| anything else | **400 `VALIDATION_FAILED`**, naming the parameter (for example `sort_by`). |

Negative controls, measured on the function in production (all-time):

| Call | Result |
|---|---|
| `status_filter=zz_no_such_status` | 400 at the route. The function itself returns 0 rows. |
| `category_filter=zz_no_such_cat` | 0 rows |
| `supplier_filter=zz` | 0 rows |
| `status_filter=cancelled` | 27 rows (the cancelled lines, now reachable on purpose) |
| `category_filter=CON-INK` | 134 rows |
| `brand_filter=hp` and `brand_filter=HP` | 41 rows each |

**Please confirm what your category control sends.** If it sends storefront slugs (`ink`, `toner`) instead of `CON-*` codes, tell us. A slug returns 0 rows, which you can detect, but it would still be wrong.

**Which statuses count by default.** With no `status_filter`, every status **except `cancelled`** counts: `pending`, `invoiced`, `paid`, `processing`, `shipped`, `delivered`, `completed` and `refunded`. `/kpi-summary` uses the same rule, so the card and the revenue tile agree. For a paid-only ranking, send `status_filter=paid,processing,shipped,delivered,completed`. Today the data holds 175 `shipped`, 6 `paid` and 17 `cancelled` orders, and no `pending` or `refunded` ones. So both rules give the same 199 rows, which matches what you measured.

**Admin test orders are now excluded.** `orders.is_test_order` rows no longer count here. The same applies to `/kpi-summary`, `/revenue-series`, `/brand-breakdown` and the attach-rate function. We found while fixing this that production had never excluded them. This matters for the owner's $0.50 BF-077 order.

## 3. BF-088: no `950XL` chip. You can delete the view read.

`series` carries **base** codes: a yield tier (`XL`, `XXL`, `HY`, …) is stripped from each code. That rule covers derived codes and override codes alike. The override `950XL` on `C950XLBK` is counted under the chip **`950`**. The two URLs return the same products:

- `?brand=hp&category=ink&code=950XL` returns `G950XLBK`, `C950XLBK`
- `?brand=hp&category=ink&code=950` returns `G950XLBK`, `C950XLBK`

A separate `950XL` chip would duplicate `950`. `sitemap-series.xml` follows the same rule, so that `200XL` and `200` never both appear.

We measured all 15 override codes on production. **Every one of them is already in `series` under its chip:**

- the plain chip for `TN2415`, `TN2445`, `TN2449`, `CL51`, `56`, `57`, `57CLR`, `61`, `74`, `75`, `804` and `951`
- `950` for `950XL`
- the Canon companion chip `PG510/CL511` for `PG510` and `CL511`

So nothing in `product_code_chip_counts` is missing from `series`, and you can delete that read. If you want to map an override code to its chip yourself, strip the trailing yield tier. But `series` already has the chip, so you should not need to.

## 4. BF-091: counts match the listing

`get_brand_category_counts` had its own hard-coded product-type lists, and `drums` never gained `maintenance_box`. The function now receives the category → type map from the same taxonomy that `?category=` uses (migration 193), so the two cannot drift again. `/api/products/counts` and the `counts` block on `/api/shop` share this function, so this also closes the BF-056 gap.

| Brand | `drums` before | `drums` now | `?category=drums` `meta.total` |
|---|---|---|---|
| Epson | absent | **5** | 5 |
| Canon | 9 | **12** | 12 |
| Brother | 60 | **61** | 61 |
| HP | 33 | 33 | 33 |

(Brother is one lower than the 61 vs 62 you measured, because one drum was deactivated since then.) You can drop the confirming read before hiding a brand.

## 5. BF-092: `related_products` on `/api/ribbons/:sku`

`related_products` is `related_product_skus` resolved to ribbon cards. The rules:

- Each card has the same shape as a `/api/ribbons` list item, plus `in_stock` and `stock_status`.
- Cards keep the saved order.
- Only active, public rows are returned.
- A bare code also tries its `C-` and `G-` forms, in that order, after the exact SKU (your ERR-084 rule).
- Duplicates and the ribbon itself are dropped.
- `null` means the lookup failed, so retry. `[]` means there is nothing to show.

Measured on production:

| Ribbon | `related_product_skus` | `related_products` |
|---|---|---|
| `307.11` | `["141LOT","143LOT"]` | `C141LOT`, `C143LOT` |
| `153.11` | `["143LOT"]` | `C143LOT` |
| `72200.01` | `["72200.02"]` | `72200.02` |

The ribbon PDP needs no Supabase read now.

## 6. BF-093: `display_name` on printer rows

`display_name` (the same `printerDisplayName` our pages print) now sits beside the unchanged `full_name` on:

- `compatible_printers[]` and `compatible_printers_grouped[].top_models[]` (`/api/products/:sku`)
- `/api/printers/by-brand/:brandSlug`, on the flat rows and on the `?grouped=true` models
- the `printer` object of `/api/printers/:slug/products`, `/api/products/printer/:slug` and `/api/compatibility/:printer_id`

There is no `/api/printers/:slug` route. The printer object lives on the three routes above.

Measured on production: Brother `by-brand` returns 562 printers, and 478 of them have a `display_name` that differs from `full_name` (the model hyphen). `brother-hl-l2375dw` returns `full_name: "Brother HL L2375DW"` and `display_name: "Brother HL-L2375DW"`. `GTN2445BK`'s printers show "Brother HL-L2375DW" and "Brother MFC-L2713DW".

Your two findings, so you can delete the copy with confidence:

- **The rule is not brand-specific.** A name stored in ALL CAPS is recased word by word, so HP's `LASER` becomes "Laser". A mixed-case name only has its dictionary words recased. `LASER` is not in the dictionary, so it stays `LASER` in Canon's mixed-case names.
- `E-ALL-IN-ONE-PRINTER` → "e-All-in-One Printer" is a dictionary entry.

## 7. The turnaround doc

It was never sent, sorry. The file is `fe-turnaround-fixes-sep2026.md`, and the owner is sending it with this reply. Item #10 is in its "P1 — business buyers" section.

## 8. #10 `/business` Apply: the endpoint exists

`POST /api/business/apply` exists and requires sign-in. There is no GET, so a GET returns 404. Measured on production: `GET` returns **404**, and `POST` without a token returns **401**.

- **Body.** Required: `company_name`, `contact_name`, `contact_email`. Optional: `nzbn` (13 digits), `contact_phone`, `estimated_monthly_spend` (`under_500`, `500_1000`, `1000_2500`, `2500_5000`, `over_5000`), `industry`, `business_type`, `ap_email`, `billing_address`, `shipping_address`.
- **Responses.** `201 {id, status:"pending"}` on success. `409` when the user already has an approved account or a pending application.
- **Button state.** `GET /api/business/status` (sign-in required) returns `status` (`personal`, `pending`, `approved`, `rejected`, `suspended` or `closed`) and `can_apply`. Show Apply when `can_apply` is true.
- **After a rejection**, the user resubmits with `POST /api/business/reapply` (same body).
- **Trade references** go through `POST /api/business/credit-reference`.

The page itself (terms, volume ladder from `/api/site/value-props`, `/quote` link, contact, Apply) is specified in #10 of the turnaround doc.

## 9. Still with the owner

- **BF-077:** the $0.50 test order. Test orders are now excluded from every order analytic (§2).
- **Apex 307 → 308:** a Vercel setting.
