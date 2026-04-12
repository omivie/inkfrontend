# Backend Fix: Guest Order Retrieval on Confirmation Page

## Problem

Guest users (no account, incognito checkout) cannot view their order details on the confirmation page after payment. The `GET /api/orders/{orderNumber}` endpoint returns **404** because:

1. Guest orders have `user_id = NULL` in the `orders` table
2. The Supabase RLS SELECT policy only matches `user_id = auth.uid()` for non-admin users
3. The backend endpoint likely requires a valid auth token and rejects guest requests

This means after a successful guest payment, the confirmation page shows "--" for payment method, order total, shipping details, items, and totals.

## Current Guest Session Flow (already working for cart)

The frontend already implements guest session auth for cart operations:

- **Header:** `X-Guest-Session: {uuid}` sent on every unauthenticated request
- **Storage:** Frontend stores the session ID in `localStorage` key `ink_guest_session_id`
- **Backend returns** the session ID via `X-Guest-Session` response header and/or `data.guest_session_id` in response body
- **Database column:** `orders.guest_session_id` (UUID) stores the guest session for each guest order

## What Needs to Change

### 1. Backend: `GET /api/orders/:orderNumber` endpoint

Add guest session authentication as a fallback when no auth token is present:

```
IF no auth token (anonymous request):
  1. Read X-Guest-Session header
  2. If present, query: SELECT * FROM orders WHERE order_number = :orderNumber AND guest_session_id = :guestSessionId
  3. If found, return the order (with items, invoice)
  4. If not found, return 404
ELSE (authenticated request):
  Keep existing behavior (query by user_id = auth.uid())
```

**Security:** This is safe because:
- Guest session IDs are UUIv4 (unguessable)
- The query requires BOTH the order_number AND the matching guest_session_id
- An attacker would need to know both values to access an order

### 2. Supabase RLS Policy Update (if the endpoint queries via Supabase client instead of service_role)

If the GET order endpoint uses the Supabase client (not service_role), you'll also need to update the RLS SELECT policy on the `orders` table to allow guest session access. The current policy is:

```sql
-- Current policy (no guest support):
(
  (SELECT auth.role()) = 'service_role'
  OR EXISTS (SELECT 1 FROM admin_roles WHERE admin_roles.user_id = auth.uid() AND admin_roles.role IN ('super_admin', 'order_manager', 'stock_manager'))
  OR user_id = auth.uid()
)
```

**If the endpoint uses service_role** (most likely), no RLS change is needed -- the backend just needs to add the guest_session_id check in its own code.

**If the endpoint uses the Supabase client with anon/user role**, you would need to add a guest session clause. However, since RLS can't read request headers, the backend would need to pass the guest_session_id as a parameter or use service_role for this specific query.

### 3. Same RLS consideration for `order_items` table

The `order_items` SELECT policy also restricts to `orders.user_id = auth.uid()`. If using service_role, this is not an issue. If using Supabase client, the same pattern applies.

Current `order_items` SELECT policy:
```sql
(
  (SELECT auth.role()) = 'service_role'
  OR EXISTS (SELECT 1 FROM admin_roles WHERE ...)
  OR EXISTS (SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.user_id = auth.uid())
)
```

## Database Schema Reference

### `orders` table (relevant columns)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| order_number | varchar | e.g. "ORD-MNL6YY16-858E" |
| user_id | uuid | NULL for guest orders |
| guest_session_id | uuid | Set for guest orders |
| guest_email | varchar | Guest's email |
| email | varchar | NULL for guest orders (user email from auth) |
| status | text | paid, processing, shipped, etc. |
| total | numeric | Order total |
| subtotal | numeric | Subtotal before shipping |
| shipping_cost | numeric | |
| shipping_fee | numeric | |
| shipping_tier | varchar | standard, express, overnight, etc. |
| delivery_zone | varchar | auckland, rural, etc. |
| shipping_recipient_name | varchar | |
| shipping_address_line1 | varchar | |
| shipping_address_line2 | varchar | |
| shipping_city | varchar | |
| shipping_region | varchar | |
| shipping_postal_code | varchar | |
| shipping_country | varchar | |
| payment_method | varchar | Currently NULL -- see note below |
| payment_intent_id | varchar | Stripe PaymentIntent ID |
| created_at | timestamptz | |

### `order_items` table (relevant columns)
| Column | Type |
|--------|------|
| id | uuid |
| order_id | uuid | FK to orders.id |
| product_id | uuid |
| product_sku | varchar |
| product_name | varchar |
| unit_price | numeric |
| quantity | integer |
| line_total | numeric |
| brand | text |
| category | text |

### `invoices` table (relevant columns)
| Column | Type |
|--------|------|
| id | uuid |
| order_id | uuid | FK to orders.id |
| invoice_number | varchar |
| invoice_date | timestamptz |

## Expected API Response

The `GET /api/orders/:orderNumber` response for a guest order should return the same shape as for authenticated orders. The frontend expects:

```json
{
  "ok": true,
  "data": {
    "order_number": "ORD-MNL6YY16-858E",
    "email": "guest@example.com",
    "guest_email": "guest@example.com",
    "status": "paid",
    "total": "15.95",
    "subtotal": "7.78",
    "shipping_fee": "7.00",
    "shipping_cost": "7.00",
    "shipping_tier": "standard",
    "delivery_zone": "auckland",
    "payment_method": "stripe",
    "shipping_recipient_name": "John Doe",
    "shipping_address_line1": "123 Main St",
    "shipping_address_line2": "",
    "shipping_city": "Auckland",
    "shipping_region": "auckland",
    "shipping_postal_code": "1010",
    "shipping_country": "NZ",
    "created_at": "2026-04-05T02:45:37.678Z",
    "order_items": [
      {
        "product_name": "HP 61 Black Ink Cartridge",
        "product_sku": "HP-61-BK",
        "quantity": 1,
        "unit_price": "8.95",
        "brand": "HP"
      }
    ],
    "invoice": {
      "invoice_number": "INV-0001",
      "invoice_date": "2026-04-05T02:45:37.678Z"
    }
  }
}
```

## Secondary Issue: `payment_method` is NULL

The `payment_method` column is NULL for all orders in the database. This means even when the API works, the confirmation page shows "--" for payment method.

The `POST /api/orders` endpoint receives `payment_method: 'stripe'` or `payment_method: 'paypal'` in the request body. This value should be saved to the `orders.payment_method` column when the order is created.

Check the order creation logic to ensure `payment_method` from the request body is persisted to the database.

## How to Verify

1. Place a guest order (incognito, no account) via Stripe
2. After payment, the confirmation page should show all fields populated:
   - Order number, date, payment method ("Credit/Debit Card"), total
   - Full shipping address, method, estimated delivery
   - All ordered items with names, quantities, prices
   - Subtotal, shipping, total paid
3. Hard refresh the confirmation page -- all data should still be visible
4. Check that `payment_method` is no longer NULL in the database after order creation

## Frontend Details (for context)

- **API call:** `GET /api/orders/{orderNumber}` (defined in `js/api.js` line 712)
- **Guest session header:** `X-Guest-Session` sent automatically on unauthenticated requests (api.js line 143)
- **Confirmation page JS:** `js/order-confirmation-page.js` -- calls `API.getOrder(orderNumber)`, transforms response via `transformAPIOrder()`, renders to DOM
- **The frontend already handles the `guest_email` field** as a fallback for `email` (line 139 of order-confirmation-page.js)
