# Backend Fix: Guest Email Not Showing in Admin Order Detail

## Problem

When a guest (non-logged-in) customer places an order, their email address does not appear in the admin order detail view. The Email field shows "—" instead of the guest's email.

## Root Cause

The frontend sends `guest_email` in the order creation payload for guest checkouts, but the admin order detail endpoint (`GET /api/admin/orders/:orderId`) does not return this field in its response.

## How the Frontend Sends Guest Email

Both Stripe and PayPal checkout flows include `guest_email` for guest orders:

```js
// Stripe (payment-page.js:513)
...(isGuest && { guest_email: this.checkoutData.email }),
...(isGuest && this.checkoutData.phone && { guest_phone: this.checkoutData.phone }),

// PayPal (payment-page.js:1030)
...(isGuest && { guest_email: self.checkoutData.email }),
...(isGuest && self.checkoutData.phone && { guest_phone: self.checkoutData.phone }),
```

## How the Frontend Reads the Email

The admin order detail (orders.js:257) looks for the email in this order:

```js
const custEmail = o.customer_email || profile.email || o.guest_email || MISSING;
```

Where `profile` is `o.user_profile || o.user_profiles || o.customer || {}`.

For guest orders, `o.customer_email` is null and `profile.email` is null (no user account), so it falls through to `o.guest_email` — but the backend doesn't include that field in the response.

## What Needs to Change

### Option A: Return `guest_email` in the admin order response (preferred)

In the `GET /api/admin/orders/:orderId` handler, ensure the `guest_email` column is included in the SELECT query and returned in the response object. The `guest_email` field should already exist in the orders table (it's written during order creation).

Check:
1. The orders table has a `guest_email` column — verify with: `SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'guest_email';`
2. The admin order detail query SELECTs `guest_email` — if it uses `SELECT *` this should already work; if it lists specific columns, add `guest_email`
3. The response object includes `guest_email` — if the handler transforms/maps the row before returning, ensure `guest_email` is included

### Option B: Populate `customer_email` for guest orders

Alternatively, during order creation, copy `guest_email` into `customer_email` so it's always available regardless of whether the customer is a guest or logged in. This is cleaner long-term but requires a migration for existing orders.

## Verification

After the fix, the API response for this specific order should include the email:

```
GET /api/admin/orders/<order-id-for-ORD-MNKR8WUB-85A5>
```

Expected: response should contain `guest_email: "kim's-email@example.com"` (or `customer_email` if using Option B).

## Also Consider: `guest_phone`

The same issue likely applies to `guest_phone` — it's sent during checkout but may not be returned in the admin order response. Worth fixing at the same time.

## Related Endpoints

- Order creation: `POST /api/orders` (already handles `guest_email`)
- Admin order list: `GET /api/admin/orders` (may also want `guest_email` for the list view)
- Admin order detail: `GET /api/admin/orders/:orderId` (this is the one that needs fixing)
