# URGENT — invoice 3297 cannot be saved ("Failed to update invoice", HTTP 500)

From: frontend · 2026-11-20 · ERR-383

## What the owner sees

Admin → Invoices → invoice **3297** → edit (bill-to, delivery address and unit price changed) → Save → toast **"Failed to update invoice"**.

That is the `error` string of your `PUT /api/admin/invoices/:id` response (HTTP 500).
It has no detail on our side. **Please pull the Render log line for this request** —
2026-11-20 around 04:31 UTC (5:31pm NZDT), `PUT /api/admin/invoices/1e351785-6ca8-4f53-9750-b8676a8c2d5a`.

## What we measured (read-only)

| Record | id | State |
|---|---|---|
| Invoice **3297** | `1e351785-6ca8-4f53-9750-b8676a8c2d5a` | created 2026-11-20 00:26 UTC, unpaid, $685.49, **`source_order_id = 24a9f5ab-7743-45a0-90d2-b7832e1deb12`** |
| Order **INV-3274** | `24a9f5ab-7743-45a0-90d2-b7832e1deb12` | `channel: 'invoice'`, shipped, $685.49 — the shadow order of invoice 3274. **`invoice_id` is now 3297's id**; `updated_at` = 3297's `created_at` to the microsecond |
| Invoice **3274** | `17c0ee9e-f114-4f08-a18a-7f7547462845` | paid, $685.49 — **no longer owns a shadow order** |

How it happened: the admin "Existing order" picker offered INV-3274 (your
`/api/admin/orders?search=` returns invoice shadow orders), the operator picked it, and
the create set `orders.invoice_id` on that row to the new invoice — stealing it from 3274.

Frontend fix shipped: the picker now never sets `source_order_id` to an order with
`channel = 'invoice'` (lines are copied, no link).

## Asks

1. **Repair the data now** (so the owner can save 3297):
   - `orders` `24a9f5ab-7743-45a0-90d2-b7832e1deb12`: set `invoice_id` back to `17c0ee9e-f114-4f08-a18a-7f7547462845` (invoice 3274).
   - invoice 3297: set `source_order_id = NULL`, so it materialises its own shadow order
     (it is a new sale dated 2026-11-20, not paperwork for the August order).
   - Check whether any other invoice has a `source_order_id` pointing at a `channel = 'invoice'` order:
     ```sql
     select i.invoice_number, o.order_number, o.invoice_id = i.id as stolen
     from admin_invoices i join orders o on o.id = i.source_order_id
     where o.channel = 'invoice';
     ```
     (Adjust the table name to wherever invoices live; PostgREST says `admin_invoices` has no `invoice_number` column.)
2. **Tell us the 500 cause** from the log. If it is not the link above, we need to know what it is.
3. **Guard server side:** refuse (400, not 500) a `source_order_id` whose order is
   `channel = 'invoice'` or whose `invoice_id` already belongs to a different invoice.
   Any failure on PUT should return a specific message, not the generic one.

After (1), the owner re-opens 3297, re-applies the edit and saves.
