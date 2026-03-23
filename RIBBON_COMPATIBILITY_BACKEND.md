# Backend Implementation: Ribbon/Typewriter Compatibility

## Context

The frontend admin has a "Paste Bulk" + "Parse Ribbon Text" workflow that lets admins paste the raw "for use in" text from ribbon/typewriter product descriptions and extract a clean list of ~100–130 compatible typewriter/printer models.

The current flow makes **one API call per model** (search + create + link = up to 3 calls × 128 models = ~384 requests). This is too slow and the `internal_notes` workaround for tracking unmatched models hits a 2000-char validation limit.

**Goal:** Add a single bulk endpoint that takes an array of model names, finds or creates each printer record, and links them all to a product in one transaction.

---

## Required Changes

### 1. New Endpoint: `POST /api/admin/compatibility/bulk-upsert`

This is the most important change. It replaces up to 384 sequential API calls with one.

**Request body:**
```json
{
  "sku": "154-11",
  "models": [
    "Brother CE25",
    "Brother CE30",
    "Casio CW110",
    "Epson CRII",
    "..."
  ]
}
```

**Backend logic:**
1. For each name in `models`:
   - Look up printer by normalized name (case-insensitive, strip extra whitespace)
   - If not found → INSERT into `printers` table (use the name as both `name` and `full_name`)
2. Bulk INSERT all printer IDs into the product compatibility junction table for the given SKU
   - Use `ON CONFLICT DO NOTHING` (idempotent — safe to re-run)
3. Return a summary

**Response:**
```json
{
  "ok": true,
  "data": {
    "sku": "154-11",
    "total": 128,
    "created": 95,
    "already_existed": 33,
    "linked": 128,
    "already_linked": 0
  }
}
```

**Auth:** Requires admin JWT (same as other `/api/admin/` routes).

**Validation:**
- `sku` — required string
- `models` — required array of strings, min 1, max 500
- Each model name — trimmed, non-empty, max 200 chars

---

### 2. Fix: Increase or Remove `internal_notes` Length Limit

The `internal_notes` field currently has a 2000 character validation limit. This causes a visible error toast in the admin UI when saving unmatched model lists for ribbon products.

**Change:** Increase the validation max to `10000` characters (or remove the limit entirely if the column is `TEXT`).

Find the validation schema (likely Joi or Zod) where `internal_notes` is defined and update the `.max(2000)` to `.max(10000)`.

If the database column is `VARCHAR(2000)`, change it to `TEXT` with a migration.

---

### 3. Existing Endpoints to Verify (No Changes Needed If Working)

The frontend also uses these — confirm they exist and work as documented:

#### `POST /api/admin/printers`
Creates a single printer. Must handle duplicates gracefully.

**Request:** `{ "name": "Brother CE25" }`

**Response (success — new):**
```json
{ "ok": true, "data": { "id": "uuid", "name": "Brother CE25", "full_name": "Brother CE25" } }
```

**Response (conflict — already exists):**
```json
{
  "ok": false,
  "status": 409,
  "data": {
    "error": {
      "details": {
        "printer": { "id": "uuid", "name": "Brother CE25", "full_name": "Brother CE25" }
      }
    }
  }
}
```
The frontend handles the 409 case and extracts the existing printer from `resp.data.error.details.printer`.

#### `POST /api/admin/compatibility`
Links one printer to one product.

**Request:** `{ "sku": "154-11", "printer_id": "uuid" }`

#### `DELETE /api/admin/compatibility/:sku/:printerId`
Removes a printer link from a product.

#### `GET /api/printers/search?q=Brother+CE25`
Searches printers by name. Used in the "Find Printers" step before bulk upsert.

**Response:**
```json
{
  "ok": true,
  "data": {
    "printers": [
      { "id": "uuid", "name": "Brother CE25", "full_name": "Brother CE25" }
    ]
  }
}
```

#### `GET /api/search/compatible-printers/:sku`
Returns all compatible printers for a product. Loaded when the admin opens a product's Compatibility tab.

**Response:**
```json
{
  "ok": true,
  "data": {
    "compatible_printers": [
      { "id": "uuid", "name": "Brother CE25", "full_name": "Brother CE25" }
    ]
  }
}
```

---

## Frontend Integration

Once the backend endpoint is live, the frontend `products.js` "Create All" button will be updated to call `POST /api/admin/compatibility/bulk-upsert` instead of looping through individual create + link calls.

The frontend call will look like:
```javascript
await AdminAPI.bulkUpsertCompatibility(product.sku, unmatchedNames);
// where unmatchedNames = ["Brother CE25", "Brother CE30", ...]
```

The frontend `AdminAPI` method to add:
```javascript
async bulkUpsertCompatibility(sku, models) {
  const resp = await this.post('/api/admin/compatibility/bulk-upsert', { sku, models });
  return resp?.data ?? null;
}
```

---

## Database Schema Reference

Relevant tables (confirm names match your actual schema):

| Table | Key Columns |
|---|---|
| `printers` | `id` (uuid PK), `name`, `full_name`, `brand`, `slug` |
| `product_compatible_printers` (or similar) | `product_sku`, `printer_id` (FK), composite PK |
| `products` | `id`, `sku`, `internal_notes` (TEXT) |

---

## Priority Order

1. **`POST /api/admin/compatibility/bulk-upsert`** — highest priority, unblocks the ribbon workflow
2. **Increase `internal_notes` limit** — quick fix, stops the error toast
3. **Verify existing endpoints** — only if the frontend reports issues
