# Product suppliers: ribbons are now Streamline (FE handoff, Nov 2026)

Backend live on `main` (commit `fe97a98`, 2026-11-26).

## Background

Ribbon products (printer ribbons, typewriter ribbons, correction tapes) had no supplier assigned, so the admin Orders page showed every ribbon order as **Augmento**. They now belong to the ribbon supplier, **Streamline**:

- `products.supplier` key: `ribbon`
- Display name: `Streamline`
- Freight terms: same as Augmento (free from $100 incl GST)

96 products were moved in production. The 7 ribbons that really come from Augmento and the 14 genuine (DSNZ) ribbons are unchanged.

## 1. Orders page: no action needed

Unless the UI hard-codes a list of supplier names or colours, there is nothing to change.

- Ribbon order lines now come back as `"Streamline"` instead of `"Augmento"`. This applies to past orders too. Where it appears:
  - `items[].suppliers[].name` on order detail
  - the supplier name on each `supplier_freight` consignment
- If you map supplier names to badges or colours, add `Streamline`. Anything not in your map should still display as plain text.
- A freight consignment can now carry `supplier_basis: "product"`, meaning the supplier came from the product itself. If you show basis labels, treat it like the existing `snapshot` / `fulfillment` values.

## 2. Admin Products page: new UI needed

The backend for everything below is already live.

### Supplier column

`GET /api/admin/products` already returns `supplier` on each row. Values are lowercase keys. Suggested labels:

| Key | Label |
|---|---|
| `ribbon` | Streamline |
| `augmento` | Augmento |
| `dsnz` | DSNZ |
| `unknown` | Unassigned |

### Supplier filter

```
GET /api/admin/products?supplier=ribbon
```

Exact key match.

### Single edit

```
PUT /api/admin/products/:id
{ "supplier": "ribbon" }
```

### Bulk "Set supplier" action

```
POST /api/admin/products/bulk-supplier
{ "product_ids": ["<uuid>", "..."], "supplier": "ribbon", "dry_run": true }
```

- 1 to 500 ids per request.
- `supplier` must be lowercase letters, digits or `_`.
- Only `super_admin` and `stock_manager` can call it.
- **It previews by default.** Without `"dry_run": false` it changes nothing. Show the preview, then send the same request with `"dry_run": false` to apply.

Response `data`:

| Field | Meaning |
|---|---|
| `dry_run` | `true` for a preview |
| `would_change` / `changed` | rows that will change (preview) / did change (applied) |
| `products[]` | `{ id, sku, name, product_type, from, to }` for each row that changes |
| `unchanged` | rows that already had that supplier |
| `not_found` | ids that matched no product |
| `refused_genuine[]` | SKUs of genuine products. These are always DSNZ and are never changed |

Show `refused_genuine` and `not_found` to the user, so nothing is skipped silently.

Warning text for the confirm step:

> Changing a product's supplier puts it under that supplier's import. If that supplier's feed doesn't list it, the next import can deactivate it.
