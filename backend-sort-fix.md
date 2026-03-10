# Backend Fix: Admin Products Sort by `cost_price` Not Working

## Problem

On the admin Products page, clicking the **Cost** column header to sort products by cost price does nothing — the products remain in their default order. All other sortable columns (Name, Brand, Price, Stock) work correctly after a recent frontend fix.

## What the Frontend Sends

When a user clicks the Cost column header, the frontend sends a request like:

```
GET /api/admin/products?page=1&limit=200&search=ribbon&sort=cost_price&order=asc
```

The `sort` and `order` query params are now correctly included (fixed in commit `f617d3d`).

## Sortable Columns from the Frontend

The admin products table defines these sortable columns with these exact `sort` key values:

| Column Header | `sort` param value | Works? |
|---------------|-------------------|--------|
| Name          | `name`            | Yes    |
| Brand         | `brand`           | Yes    |
| Price         | `retail_price`    | Yes    |
| **Cost**      | **`cost_price`**  | **No** |
| Stock         | `stock_quantity`  | Yes    |

## Likely Root Cause

The backend API endpoint for `GET /api/admin/products` almost certainly has an allowlist of valid sort fields. The field `cost_price` is probably missing from that allowlist, so the backend ignores it and falls back to default sorting.

## What to Fix

1. Find the route handler for `GET /api/admin/products`
2. Locate the sort field validation/allowlist — it probably looks something like:
   ```
   ['name', 'brand', 'retail_price', 'stock_quantity']
   ```
3. Add `'cost_price'` to that allowlist
4. If the database column is named something other than `cost_price` (e.g. `supplier_price`, `wholesale_price`), either:
   - Map `cost_price` to the actual column name, OR
   - Let me know the actual column name so I can update the frontend

## How to Verify

After deploying, this request should return products sorted by cost ascending:

```
GET /api/admin/products?sort=cost_price&order=asc
```

And this should return them sorted descending:

```
GET /api/admin/products?sort=cost_price&order=desc
```
