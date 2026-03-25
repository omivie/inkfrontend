# Ribbon Backend — Issues to Investigate & Fix

## Context

The frontend has been updated to use the correct API parameter names as confirmed previously:
- `GET /api/ribbons/device-brands` — list all printer/device brands
- `GET /api/ribbons/device-models?printer_brand=epson` — list models for a brand
- `GET /api/ribbons?printer_model=TM-U220` — filter ribbons by model
- `GET /api/ribbons?printer_brand=epson` — filter ribbons by brand (**BROKEN — see Issue 1**)

Frontend is on Vercel (static). Backend is on Render (`https://ink-backend-zaeq.onrender.com`). Database is Supabase project `lmdlgldjgcanknsjrcxh`.

---

## Issue 1 — `GET /api/ribbons?printer_brand=X` returns INTERNAL_ERROR

### Symptom
Filtering ribbons by printer brand fails with a 500-level error:

```
GET https://ink-backend-zaeq.onrender.com/api/ribbons?printer_brand=epson

Response:
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to filter by printer"
  }
}
```

### Expected behaviour
Should return the subset of ribbons compatible with any printer of that brand (e.g. all Epson-compatible ribbons).

### What works for comparison
- `GET /api/ribbons?printer_model=TM-U220` — works correctly, returns filtered results
- `GET /api/ribbons/device-models?printer_brand=epson` — works correctly, returns 154 Epson models

### Frontend impact
When a user clicks a brand (e.g. "Epson") on the ribbons page or shop, the page loads but shows **all 120 ribbons** because the brand filter errors out. The frontend currently passes `printer_brand` correctly — this is purely a backend routing/query bug.

### Likely cause
The brand-level filter on `/api/ribbons` probably attempts a JOIN or subquery that references a table or column that doesn't exist or has a different name than expected (possibly related to the `ribbon_compatibility` table — see Issue 2).

---

## Issue 2 — `filter_ribbons_by_device` Supabase RPC is broken

### Symptom
The Supabase RPC function `filter_ribbons_by_device` (which takes `p_device_brand`, `p_device_model`) fails because it references `public.ribbon_compatibility`, a table that **does not exist** in the database.

### What was found in Supabase
- Table `product_compatibility` exists: maps `product_id → printer_model_id`
- Table `ribbon_compatibility` does **not** exist — the RPC references it but it was never created
- The RPC is therefore broken and cannot be called

### What needs to happen
Two options — pick one:

**Option A** — Fix the RPC to use the existing `product_compatibility` table instead of `ribbon_compatibility`:
- Update `filter_ribbons_by_device` to JOIN through `product_compatibility` and `printer_models`
- Align column/table names with what actually exists in the schema

**Option B** — Remove the RPC entirely and ensure the REST endpoints (`/api/ribbons?printer_brand=X` and `/api/ribbons?printer_model=X`) handle all filtering:
- The frontend no longer calls this RPC directly — it goes through the backend REST API
- If the backend itself calls this RPC internally to implement the `printer_brand` filter, that would explain Issue 1 above

---

## Issue 3 — Missing `product_compatibility` data for most ribbons

### Symptom
Only **8 out of 117** ribbon products have any entries in `product_compatibility`. The remaining 109 ribbons have no device/model associations at all.

### Impact
- `GET /api/ribbons?printer_model=TM-U220` works technically but returns very few (or zero) results for most models, because the ribbons aren't linked to any printer models in the database
- The model-filter pills on the ribbons page show Epson models, but selecting one returns no results unless it happens to be one of the 8 linked SKUs

### What needs to happen
Ribbon products need to be linked to their compatible printer models in `product_compatibility`. This is a data entry task:

1. For each ribbon in the `products` table (where `category = 'ribbon'`), determine which printer models it is compatible with
2. Insert rows into `product_compatibility`: `{ product_id, printer_model_id }`
3. Printer models are in the `printer_models` table — use existing IDs, do not create duplicates

This may be partially automatable if ribbon names follow a pattern that matches printer model names (e.g. a ribbon named "Epson TM-U220 Ribbon" should link to the `TM-U220` printer model).

---

## Issue 4 — 3 ribbon SKUs exist in backend but not in Supabase

### Symptom
The following SKUs appear in the backend product catalogue but have no matching row in Supabase:

| SKU |
|-----|
| 81051-01 |
| 81051-02 |
| 81051-09 |

### Impact
These products cannot be displayed, filtered, or purchased through the storefront.

### What needs to happen
Either:
- Insert these SKUs into the Supabase `products` table with correct metadata, OR
- Confirm they are discontinued/removed and remove them from the backend catalogue

---

## Summary Table

| # | Issue | Severity | Type |
|---|-------|----------|------|
| 1 | `GET /api/ribbons?printer_brand=X` → INTERNAL_ERROR | High | Backend bug |
| 2 | `filter_ribbons_by_device` RPC references non-existent table | High | Database schema bug |
| 3 | 109/117 ribbons have no `product_compatibility` entries | High | Missing data |
| 4 | 3 SKUs in backend catalogue missing from Supabase | Low | Missing data |

---

## Verification Steps (after fixes)

Once fixed, the frontend will work correctly if these all return valid results:

```
# 1. Brand filter — should return only Epson-compatible ribbons (not all 120)
GET https://ink-backend-zaeq.onrender.com/api/ribbons?printer_brand=epson

# 2. Model filter — should return ribbons compatible with this specific model
GET https://ink-backend-zaeq.onrender.com/api/ribbons?printer_model=TM-U220

# 3. Device models for brand — already works, confirm still works after schema changes
GET https://ink-backend-zaeq.onrender.com/api/ribbons/device-models?printer_brand=epson

# 4. Device brands — already works, confirm still works
GET https://ink-backend-zaeq.onrender.com/api/ribbons/device-brands
```

No frontend changes are required — the parameter names and API calls are already correct.
