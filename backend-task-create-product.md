# Backend Task: Implement POST /api/admin/products

## Context

The admin frontend already calls `POST /api/admin/products` to create new products. The endpoint currently returns `404 NOT_FOUND`. `GET /api/admin/products` and `PUT /api/admin/products/:id` already exist — follow the same auth, validation, and response envelope patterns they use.

---

## Endpoint

```
POST /api/admin/products
Authorization: Bearer <admin JWT>
Content-Type: application/json
```

---

## Request Body

All fields the frontend may send:

```json
{
  "sku":                "string, required, unique",
  "name":               "string, required",
  "description":        "string | null",
  "brand_id":           "string (UUID) | null",
  "product_type":       "string | null",
  "color":              "string | null",
  "source":             "string | null  (e.g. 'OEM', 'Compatible')",
  "retail_price":       "number, required, > 0",
  "compare_at_price":   "number | null",
  "cost_price":         "number | null  (owner-only field, may be present)",
  "stock_quantity":     "integer, default 0",
  "low_stock_threshold":"integer | null",
  "weight_kg":          "number | null",
  "is_active":          "boolean",
  "track_inventory":    "boolean",
  "meta_title":         "string | null",
  "meta_description":   "string | null",
  "page_yield":         "integer | null",
  "tags":               "string[]  (may be empty array)",
  "internal_notes":     "string | null"
}
```

**Required:** `sku`, `name`, `retail_price`
**`cost_price`** should only be stored if the requesting user has owner-level access (same role gate used elsewhere in admin).

---

## Validation

| Field | Rule |
|-------|------|
| `sku` | Non-empty string; must be unique across products — return `409 CONFLICT` if duplicate |
| `name` | Non-empty string |
| `retail_price` | Number > 0 |
| `brand_id` | If provided, must be a valid brand UUID — return `400` or `422` if not found |
| `stock_quantity` | Integer ≥ 0, default `0` if omitted |
| `tags` | Array of strings; store as-is (or join/normalise however existing products store them) |

Return validation errors in the same shape used by other endpoints:
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [{ "field": "sku", "message": "SKU is required" }]
  }
}
```

---

## Success Response

`201 Created`

```json
{
  "ok": true,
  "data": {
    "product": { ...full product object... }
  }
}
```

The frontend reads the new product from `result?.product ?? result` (see `AdminAPI.createProduct`), then immediately opens the product drawer with it. Return the full product object — same shape as a single product returned by `GET /api/admin/products/:id` — so the drawer has everything it needs without a second fetch.

---

## Error Responses

Follow the existing envelope pattern:

| Status | Code | When |
|--------|------|------|
| `400` | `VALIDATION_FAILED` | Missing/invalid fields |
| `401` | `UNAUTHORIZED` | Missing or invalid JWT |
| `403` | `FORBIDDEN` | Valid JWT but insufficient role |
| `409` | `DUPLICATE_SKU` (or similar) | SKU already exists |
| `500` | `INTERNAL_ERROR` | Unexpected server error |

---

## Notes

- Auth: same middleware used by `GET /api/admin/products` and `PUT /api/admin/products/:id`
- Do **not** compute or modify `retail_price` — store exactly what is sent
- `is_active` defaults to `false` if omitted (safer than publishing immediately)
- `tags` may be an empty array — handle gracefully
- Images are uploaded separately after creation via a different endpoint; no image handling needed here
