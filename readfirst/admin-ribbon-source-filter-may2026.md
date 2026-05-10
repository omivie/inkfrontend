# Admin Ribbon source filter — May 2026

## What changed

The admin Products page (`/admin#products`) `Source` dropdown's "Ribbon" option
no longer filters by `source = 'ribbon'`. It now filters by
`product_type IN ('printer_ribbon', 'typewriter_ribbon', 'correction_tape')`.

## Why

Before the fix, selecting **Source: Ribbon** returned **34** products while
typing `ribbon` into the table search returned **116**. Same database, same
filter affordance, two answers — the dropdown was silently hiding ~70% of the
ribbon catalog from admins.

Root cause: "Ribbon" looked like a sibling of Genuine / Compatible /
Remanufactured in the dropdown, but it's actually a *product_type* concept.
The data shape:

| Bucket                                            | Row count |
| ------------------------------------------------- | --------: |
| `source = 'ribbon'` (legacy)                      |        34 |
| `product_type IN (printer_ribbon)`                |        88 |
| `product_type IN (typewriter_ribbon)`             |        22 |
| `product_type IN (correction_tape)`               |         6 |
| `product_type IN (all three)` — **truth**         |   **116** |
| `name ILIKE '%ribbon%'`                           |       116 |

All 34 `source='ribbon'` rows are also tagged with one of the three ribbon
product_types (verified — zero orphans), so the IN-clause is a strict superset
that loses nothing.

The 82 missing rows broke down by source: 67 `compatible`, 15 `genuine`. New
ribbons enter the catalog as compatible-source by default, so this gap was
growing over time.

## The fix

`inkcartridges/js/admin/pages/products.js`:

1. **`RIBBON_PRODUCT_TYPES`** constant at module scope — single source of
   truth for what the umbrella covers.

2. **Supabase query branching** — `_sourceFilter === 'ribbon'` now triggers
   `.in('product_type', RIBBON_PRODUCT_TYPES)`. The legacy
   `.eq('source', 'ribbon')` literal is gone. An explicit `_typeFilter` (the
   adjacent Type dropdown) wins and narrows further.

3. **Backend bypass** — `needsBackend` ANDs with `!ribbonUmbrella`. The
   backend's `/admin/products?source=ribbon` has the same legacy bug, so we
   keep the ribbon umbrella on the Supabase path even when image-filter,
   stock-filter, or margin sort are active.

4. **Image filter in Supabase** — for ribbon-umbrella + image-filter combos,
   we use `image_url IS [NOT] NULL` directly in the Supabase query. This is
   an approximation of the backend's join-aware check, but covers the case
   that matters (legacy `image_url` thumbnails are present on every row that
   has any image surface).

5. **Stock filter in Supabase** — `products.stock_status` is a real column, so
   we apply `.eq('stock_status', _stockFilter)` for the ribbon path.

6. **Client-side margin/markup/profit sort** — `computeProfitability(row)`
   from `utils/profitability.js` runs over the page (≤100 rows) when ribbon
   umbrella + margin sort. Order is stable and matches the badges the table
   already paints.

7. **Export** — `getProductExportParams()` translates `_sourceFilter='ribbon'`
   into `product_type=printer_ribbon,typewriter_ribbon,correction_tape`. CSV
   and PDF exports now scope to the same 116 rows the table shows.

## Verification

```bash
# Counts that drove the fix:
KEY="<anon key>"
URL="https://lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/products"

# Old behaviour — 34 rows
curl -sI "$URL?select=id&source=eq.ribbon" -H "apikey: $KEY" -H "Prefer: count=exact" | grep -i content-range
# content-range: 0-33/34

# New behaviour — 116 rows
curl -sI "$URL?select=id&product_type=in.(printer_ribbon,typewriter_ribbon,correction_tape)" -H "apikey: $KEY" -H "Prefer: count=exact" | grep -i content-range
# content-range: 0-115/116

# Search "ribbon" — same 116 rows, confirms parity
curl -sI "$URL?select=id&name=ilike.*ribbon*" -H "apikey: $KEY" -H "Prefer: count=exact" | grep -i content-range
# content-range: 0-115/116
```

## Tests

`tests/admin-ribbon-source-filter.test.js` (10 tests) pins:

- `RIBBON_PRODUCT_TYPES` lists exactly the three ribbon product_types.
- Supabase path uses `.in('product_type', RIBBON_PRODUCT_TYPES)` for ribbon.
- `.eq('source', 'ribbon')` literal does not appear anywhere in the file.
- Non-ribbon source values still flow through `.eq('source', _sourceFilter)`.
- `needsBackend` ANDs with `!ribbonUmbrella` — no backend leak.
- Image / stock filters and margin sort all work in the Supabase ribbon path.
- Export translates `source=ribbon` to the `product_type=` comma list.
- `<option value="ribbon">Ribbon</option>` is preserved in the dropdown.

## Backwards compatibility

- The user-facing dropdown is unchanged. "Ribbon" still appears, still has the
  same label, still appears in the same position.
- The legacy 34-row subset is still reachable: select **Type → Printer
  Ribbon** (or Typewriter Ribbon / Correction Tape) for narrower scopes.
- No backend change required. No schema change. No migration.

## Related

- `project_admin_ribbons_tab_removed_may2026.md` — separate "Ribbons" admin
  tab was retired in favor of folding ribbons into the unified Products tab.
  This fix completes that consolidation by making the Products tab's filter
  dropdown actually return all ribbons.
