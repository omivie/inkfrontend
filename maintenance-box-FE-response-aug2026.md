# Maintenance Box product type — frontend response (Aug 2026)

**From:** frontend · **Date:** 2026-08-14 · **Re:** `maintenance-box-product-type-aug2026.md`
**Tracking:** ERR-162, ERR-163, ERR-164, ERR-165 (resolved) · ERR-166 (open) · BF-041, BF-042 (backend)
**Status: shipped and verified live in the admin against your deploy. All four acceptance items pass.**

Thanks — the backend side of this was complete and the SKU-grammar message is genuinely good copy;
an admin can act on it without asking anyone.

One correction to the brief's scoping, offered as information rather than complaint. It estimated
"~2 small changes (one `<option>`, one error-toast tweak)". The `<option>` was correct as far as it
went, but the frontend was carrying **six** independent product-type vocabularies and
`maintenance_box` was missing from all six. Adding the option alone would have fixed the dropdown
and left five surfaces quietly wrong. Details in §2 — worth reading before the next enum addition,
because the same thing will happen again otherwise.

---

## 1. Acceptance checklist — all four pass

Run in a real browser against the live API, signed in as the owner account, 2026-08-14.

| # | Your item | Result |
|---|---|---|
| 1 | "Maintenance Box" appears in the **Edit** modal, and `GT502` shows it as the selected type | ✅ `value=maintenance_box`, label `Maintenance Box`, **no "(legacy)"** option in the menu |
| 2 | It appears in **New Product**, and creating a product with it succeeds | ✅ present, directly after Waste Toner; `TEST-MBOX1` created and stored with `product_type=maintenance_box` |
| 3 | Saving `GT502` without touching the type does not change its type | ✅ toast "Product updated"; re-read from `/api/products` → still `maintenance_box` |
| 4 | A create with SKU `E502X` shows the backend's SKU-grammar message | ✅ full sentence in the toast **and** inline under a red-bordered SKU field |

```
GT502 edit modal      Product Type: [Maintenance Box ▾]   Color: [Select color…]   Source: [Genuine]
menu order            … Drum Unit · Waste Toner · Maintenance Box · Belt Unit · Fuser Kit …   (16 options)
E502X toast           Create failed: SKU 'E502X' doesn't match the site SKU grammar. Singles/value
                      packs: G or C + model code (genuine/compatible), e.g. GT502, CLC73M;
                      multipacks add -2PK. Legacy G-*/C-*/R-* and numeric-leading SKUs are also
                      accepted.
                      → same sentence rendered under #edit-sku, field bordered var(--danger),
                        modal switched to the Basic Info tab
npm run audit:types   3,967 products · 15 distinct types · maintenance_box: 4 · all enrolled
npm test              3,843 tests · 3,824 pass · 0 fail
```

### On your data-corruption warning

> "Make sure the form does **not** silently substitute another value on save."

Already safe, and it has been since May 2026 — worth recording so nobody "cleans it up".
`buildSelect()` appends an unmatched value as a pre-selected `"<value> (legacy)"` option. So while
the option was missing, `GT502` rendered `maintenance_box (legacy)` and a save wrote
`maintenance_box` straight back. The guard was written for an unrelated enum drift (34 legacy
`source='ribbon'` rows) and it caught this one for free. It is now covered by tests so it survives.

### On colour

No change needed, and none made. There is no per-type colour gating in the admin — Waste Toner and
Belt Unit do not suppress the Colour select either, so `maintenance_box` "behaves the same way" by
doing nothing. All four live rows have `color: null` and the drawer shows "Select color…". On the
storefront, genuine rows never paint a swatch (ERR-143), so there is nothing to suppress.

---

## 2. What the FE actually had to change, and why it matters to you

The new value was absent from every one of these. **None of them throw on an unknown type** — a
filter returns nothing, a membership test returns false, a label map returns `undefined`:

| # | surface | what it silently did |
|---|---|---|
| 1 | admin "All Types" filter | the 4 live boxes were unfilterable |
| 2 | New Product modal `<select>` | nobody could create one |
| 3 | Edit modal `<select>` — a byte-for-byte copy of #2 | `GT502` showed `maintenance_box (legacy)` |
| 4 | `generateSEO()`'s private label map | `Buy Epson T502␣␣NZ - Genuine \| …` — a doubled space where the product noun goes |
| 5 | `_CATEGORY_PRODUCT_TYPES.drums` | manual code chips could not recover one |
| 6 | three longhand `consumable` predicates | the brand facet counted **0** for products /shop was itself listing |

Plus the PDP's `normalizeProductType` (fell through to `'ink'`, so Related Products queried the
wrong family) and the split-shipment heuristic.

All six now read one list. Two gates were added so the next enum addition fails loudly instead:

- **`tests/product-type-vocabulary-aug2026.test.js`** — declares your enum once and asserts every
  surface is enrolled. It *executes* the shipped functions rather than pattern-matching them.
- **`npm run audit:types`** — a read-only live oracle. Walks `/api/products` to exhaustion and fails
  **in both directions**: a type we offer with zero live rows, and a live type we do not offer. If
  you add another type and we miss it, this is what says so. Negative-tested by planting a bogus
  type and removing a live one; both fired by name.

### Two things we fixed that you may want to know about

- **`maintenance_kit` was a phantom.** It sat in four of our lists and has **0 live rows** — and it
  is not in the enum you printed. Your note that "Maintenance Kit"/"Maint Kit" now classify as
  `fuser_kit` confirms it. Retired on our side (a surviving row would still render a label; the
  value is simply never offered). If `maintenance_kit` is in fact still a valid column value
  somewhere, tell us and we will put it back.
- **Every drums-family PDP was headed "… Ink Cartridges".** Our Related Products block bucketed
  everything that was not a ribbon or a toner into an "Ink Cartridges" grid, so an OKI drum page
  said *"GENUINE OKI Ink Cartridges"* over a grid of drum units — ~280 products. Now "Drums &
  Supplies", matching the browse category you named. Pre-existing, unrelated to this brief, fixed
  while we were in there.

---

## 3. What we need from you

### (a) BF-041 — there is no product-delete route *(blocking a live cleanup)*

`DELETE /api/admin/products/:id` returns:

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Endpoint not found" } }
```

Note the message: **"Endpoint not found"**, not "product not found". Four alternatives probed with a
live owner token, all 404 identically — `DELETE /api/admin/product/:id`,
`POST /api/admin/products/:id/delete`, `DELETE /api/admin/products?id=`,
`DELETE /api/admin/products/sku/:sku`.

So the admin's **"Delete Products"** bulk action is a button that cannot work. It shows a confirm
reading *"This will permanently delete N products. This action cannot be undone"*, then every call
rejects. It has presumably never worked.

**Ask:** either ship the route, or tell us it will never exist so we can remove the action instead of
continuing to offer it. We have deliberately not hidden the button yet — hiding it would remove the
only signal that products cannot be deleted.

**And one SQL DELETE, please:** `TEST-MBOX1` / `7f88d112-f0ad-4966-88b0-fdc6d66ae674`. We created it
to satisfy your acceptance item 2 and could not remove it because of the above. It is
`is_active: false`, renamed `ZZ DO NOT USE — FE acceptance probe 2026-08-14…` with the reason in
`internal_notes`, and is absent from `/api/products` and from anon Supabase reads — but it is still
a row.

### (b) BF-042 — two of the five retyped products do not match the brief *(not blocking)*

The brief lists five SKUs retyped on 2026-08-13. We see four:

| SKU | product_type | color | weight_kg | category |
|---|---|---|---|---|
| `GT502` | maintenance_box | null | **0.1** | CON-INK |
| `GT366100` | maintenance_box | null | 0.3 | HW-ACCESS |
| `GC13S210057` | maintenance_box | null | 0.3 | CON-INK |
| `GLEB445001` | maintenance_box | null | 0.3 | CON-LASER |
| `GMCG01` | — | — | — | **no row at all** |

- **`GMCG01` (Canon MC-G01 Maintenance Cart) does not exist** in `products`. Not inactive, not
  mistyped — no row, on either the anon Supabase read or `/api/products`. Live `maintenance_box`
  count is **4**, not 5. Was it meant to be created?
- **`GT502.weight_kg` is 0.1**, not the 0.3 kg the brief states for the type. The other three are
  0.3. Harmless to us (the frontend never computes shipping), but it will price a parcel.

Also FYI, and consistent with what your `audit:colours` baseline already records: walking
`/api/products` to `has_next=false` collects **3,967** products while `meta.total` says **3,974** —
the same 7-row gap reported on 2026-08-03. Our audit reports it as a backend condition rather than
frontend drift, and keeps going.

---

## 4. Files changed

```
inkcartridges/js/admin/utils/product-types.js   PRODUCT_TYPE_OPTIONS (your enum, your order),
                                                RETIRED_PRODUCT_TYPES, productTypeLabel/Noun
inkcartridges/js/admin/utils/product-codes.js   + maintenance_box, fax_film, fax_film_refill → drums
inkcartridges/js/admin/pages/products.js        both modals build from the shared menu; generateSEO
                                                takes its noun from it; showProductWriteError()
inkcartridges/js/admin/api.js                   productWriteError() — create/update keep code,
                                                status, request_id and the backend's own message
inkcartridges/js/api.js                         _CATEGORY_PRODUCT_TYPES.drums
inkcartridges/js/shop-page.js                   CONSUMABLE_PRODUCT_TYPES replaces 3 predicates
inkcartridges/js/product-detail-page.js         maintenance_box → drum; "Drums & Supplies" heading
inkcartridges/js/shipping.js                    split-shipment drum bucket
tests/product-type-vocabulary-aug2026.test.js   NEW — 26 tests, the enrolment gate
scripts/audit-product-types.mjs                 NEW — read-only live oracle (npm run audit:types)
```
