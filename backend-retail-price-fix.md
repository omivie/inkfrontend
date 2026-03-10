# Fix: Include `retail_price` and `brand_name` in Admin Products List API

## Problem

The `GET /api/admin/products` endpoint does not return `retail_price` or `brand_name` in the product list response. This causes:

1. **Price column shows `—`** in the admin products table and PDF export
2. **Brand column shows `[object Object]`** in the PDF export (brand is returned as a nested object without a flat `brand_name` string)

Screenshot evidence: all 115 ribbon products show `—` for Price and `[object Object]` for Brand in the exported PDF.

## Endpoint

```
GET /api/admin/products?page=1&limit=200&search=ribbon&sort=name&order=asc&is_active=true&brand=Brother
```

## Current Response Shape

```json
{
  "products": [
    {
      "id": "uuid",
      "name": "Brother AX 10 Typewriter Ribbon Black",
      "sku": "153.11",
      "brand": { "id": "uuid", "name": "Brother" },
      "cost_price": 14.40,
      "stock_quantity": 100,
      "is_active": false,
      "images": []
    }
  ],
  "pagination": { "total": 115, "page": 1, "limit": 200 }
}
```

**Missing fields:** `retail_price` and `brand_name` (flat string).

## Required Response Shape

Each product object in the array must include:

| Field | Type | Notes |
|---|---|---|
| `retail_price` | `number \| null` | The retail/selling price. Currently missing. |
| `brand_name` | `string` | Flat brand name string (e.g. `"Brother"`). Avoids frontend needing to destructure the brand object. |

### Target response per product:

```json
{
  "id": "uuid",
  "name": "Brother AX 10 Typewriter Ribbon Black",
  "sku": "153.11",
  "brand": { "id": "uuid", "name": "Brother" },
  "brand_name": "Brother",
  "retail_price": 14.40,
  "cost_price": 14.40,
  "stock_quantity": 100,
  "is_active": false,
  "images": []
}
```

## What to Change

### In the admin products list query/controller:

1. **Include `retail_price`** in the SELECT fields. It's likely in the products table but excluded from the list query. The single-product detail endpoint (`GET /api/admin/products/:id`) probably already returns it — match that.

2. **Add `brand_name`** as a flat string field. Options:
   - If using an ORM join/include on the brands table, add a computed `brand_name` field: `product.brand_name = product.brand?.name`
   - Or add it in the SQL: `SELECT ..., brands.name AS brand_name FROM products LEFT JOIN brands ON ...`
   - Keep the existing `brand` object too — just add the flat string alongside it.

### Sorting support

The frontend sorts by `retail_price` — make sure this column is sortable in the query:
```
GET /api/admin/products?sort=retail_price&order=desc
```

## Frontend Field Usage

For reference, here's how the frontend uses these fields:

```javascript
// Table column
r.retail_price != null ? formatPrice(r.retail_price) : '—'

// PDF export
p.retail_price != null ? formatPrice(p.retail_price) : '—'

// Brand in table
const raw = r.brand_name || r.brand || '';
const brand = typeof raw === 'object' ? (raw.name || raw.brand || '') : raw;

// Brand in PDF
const rawBrand = p.brand_name || p.brand || '';
const brand = (typeof rawBrand === 'object' ? (rawBrand.name || rawBrand.brand || '') : rawBrand) || '—';
```

## Verification

After deploying the fix:

1. `GET /api/admin/products?limit=5` — confirm `retail_price` and `brand_name` appear in each product
2. `GET /api/admin/products?sort=retail_price&order=asc` — confirm sort works
3. On the frontend admin page (`/html/admin#products`), confirm:
   - Price column shows actual prices (e.g. `$14.40`) instead of `—`
   - Brand column shows brand names instead of `[object Object]`
4. Export → PDF — confirm both columns render correctly
