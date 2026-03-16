# Backend Task: Implement `delete_cancelled_order` Supabase RPC

## Context

The admin panel needs to hard-delete cancelled orders. The backend does not have a `DELETE /api/admin/orders/:id` endpoint, so the frontend is calling Supabase REST directly. This fails because child tables (`order_fulfillment`, `order_items`, `order_events`) have foreign key constraints referencing `orders.id`, and their RLS policies block direct deletion from the frontend.

The solution is a `SECURITY DEFINER` Postgres function that performs the cascade delete in a single transaction server-side.

---

## What to implement

### Option A — Supabase SQL function (preferred, no backend code change needed)

Run the following in the **Supabase SQL editor** for the `lmdlgldjgcanknsjrcxh` project:

```sql
CREATE OR REPLACE FUNCTION delete_cancelled_order(order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Safety: only allow deleting cancelled orders
  IF NOT EXISTS (
    SELECT 1 FROM orders WHERE id = order_id AND status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Order % not found or is not cancelled', order_id;
  END IF;

  DELETE FROM order_events      WHERE order_events.order_id      = delete_cancelled_order.order_id;
  DELETE FROM order_fulfillment WHERE order_fulfillment.order_id = delete_cancelled_order.order_id;
  DELETE FROM order_items       WHERE order_items.order_id       = delete_cancelled_order.order_id;
  DELETE FROM orders            WHERE id                         = delete_cancelled_order.order_id;
END;
$$;
```

> **Note:** If there are additional tables with FK references to `orders.id` that aren't listed above, add `DELETE FROM <table> WHERE order_id = delete_cancelled_order.order_id;` lines before the final `orders` delete.

### Option B — Backend REST endpoint (alternative)

If you'd prefer a proper REST endpoint instead, implement:

```
DELETE /api/admin/orders/:id
```

Requirements:
- Verify the order exists and has status `cancelled` — reject with 400 if not
- Delete child rows first (respecting FK order): `order_events`, `order_fulfillment`, `order_items`
- Delete the order
- Return `204 No Content` on success
- Require admin auth (same as other `/api/admin/*` routes)

---

## How the frontend calls it

The frontend (`js/admin/api.js`) will call the RPC like this once it exists:

```js
async deleteOrder(orderId) {
  return rpc('delete_cancelled_order', { order_id: orderId });
}
```

The `rpc()` helper already exists in `js/admin/api.js` and handles auth headers automatically.

---

## Known child tables with FK references to `orders.id`

Discovered during frontend delete attempts (FK constraint errors in order):

1. `order_items` — constraint `order_items_order_id_fkey`
2. `order_fulfillment` — constraint `order_fulfillment_order_id_fkey`
3. `order_events` — likely exists based on backend event endpoints (not confirmed via FK error yet)

If there are others, the SQL function will surface them as a Postgres FK violation when first run — just add them to the delete chain.
