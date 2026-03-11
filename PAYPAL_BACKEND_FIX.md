# PayPal Backend Integration Fix Guide

## Current Problem

The PayPal payment flow is broken. When the frontend calls `POST /api/orders` with `payment_method: "paypal"`, the backend returns a successful response (`ok: true`) with `payment_method: "paypal"` and an `order_number`, but **does not include `paypal_order_id`** in the response. This causes the frontend to show "PayPal setup did not complete."

The frontend uses the **PayPal JavaScript SDK buttons** (not redirect flow). The SDK's `createOrder` callback must return a PayPal order ID string. Without it, the PayPal popup never opens.

---

## What the Frontend Sends

### 1. Create Order: `POST /api/orders`

Request body (identical to Stripe, except `payment_method`):

```json
{
  "items": [
    { "product_id": "uuid", "quantity": 1 }
  ],
  "shipping_address": {
    "first_name": "John",
    "last_name": "Doe",
    "phone": "021...",
    "address_line_1": "123 Queen St",
    "address_line_2": "",
    "city": "Auckland",
    "region": "Auckland",
    "postal_code": "1010",
    "country": "NZ"
  },
  "shipping_tier": "auckland",
  "shipping_zone": "auckland",
  "delivery_type": "urban",
  "estimated_shipping": 5.99,
  "save_address": true,
  "customer_notes": "",
  "payment_method": "paypal",
  "idempotency_key": "sha256-hex-string"
}
```

The `idempotency_key` is a SHA-256 hash of `userId + sorted item IDs + address + "paypal"`. It differs from Stripe's key (which ends with `"stripe"`), so PayPal and Stripe orders should never collide on idempotency.

### 2. Capture Payment: `POST /api/orders/:orderNumber/capture-paypal`

Request body:

```json
{
  "paypal_order_id": "PAYPAL-ORDER-ID-FROM-SDK"
}
```

The `paypal_order_id` here comes from the PayPal SDK's `onApprove` callback (`data.orderID`), which is the same ID the backend returned during order creation.

### 3. Cancel Order: `POST /api/orders/:orderNumber/cancel`

No body. Called when the user closes the PayPal popup, when an error occurs, or when the frontend detects a stale/duplicate order it needs to clean up.

---

## What the Frontend Expects Back

### Success Response from `POST /api/orders` (PayPal)

The frontend reads these exact field paths from the response:

```json
{
  "ok": true,
  "data": {
    "order_number": "ORD-ABC123-XYZ",
    "payment_method": "paypal",
    "paypal_order_id": "PAYPAL-SDK-ORDER-ID"
  }
}
```

**Critical fields the frontend checks (in order):**

| Field Path | Required | What frontend does |
|---|---|---|
| `ok` | Yes | If `false`, enters error handling |
| `data.is_duplicate` | Optional | If `true`, frontend cancels the order and asks user to retry (PayPal order IDs expire, can't reuse) |
| `data.order_number` | Yes | Stored for capture and cancel calls |
| `data.payment_method` | Yes | Must be `"paypal"`. If not, frontend cancels the order (assumes stale Stripe duplicate) |
| `data.paypal_order_id` | **YES** | **This is the missing field.** Returned to the PayPal SDK to open the payment popup. Without it, payment fails. |

The `paypal_order_id` must be the PayPal order ID created via the [PayPal Orders API v2](https://developer.paypal.com/docs/api/orders/v2/#orders_create) `POST /v2/checkout/orders`. The PayPal API returns it as `id` in the response.

### For comparison, the Stripe success response:

```json
{
  "ok": true,
  "data": {
    "order_number": "ORD-ABC123-XYZ",
    "payment_method": "stripe",
    "client_secret": "pi_xxx_secret_xxx",
    "order_id": "internal-uuid",
    "total_amount": 50.00
  }
}
```

The PayPal response should mirror this structure, just with `paypal_order_id` instead of `client_secret`.

### Success Response from `POST /api/orders/:orderNumber/capture-paypal`

```json
{
  "ok": true,
  "data": {
    "order_number": "ORD-ABC123-XYZ",
    "status": "paid"
  }
}
```

After a successful capture, the frontend clears the cart and redirects to the order confirmation page.

---

## Error Response Format

The frontend's API wrapper (`api.js`) parses errors using the standard envelope:

```json
{
  "ok": false,
  "error": {
    "code": "DUPLICATE_ORDER",
    "message": "An order already exists for this cart",
    "details": {
      "order_number": "ORD-ABC123-XYZ",
      "payment_method": "paypal",
      "client_secret": null
    }
  }
}
```

### Error Codes the Frontend Handles

These codes are handled by both the PayPal and Stripe flows in `payment-page.js`:

| Error Code | HTTP Status | What frontend does |
|---|---|---|
| `DUPLICATE_ORDER` | 409 | Reads `details.order_number` and `details.payment_method`, cancels the existing order, asks user to retry |
| `DUPLICATE_REQUEST` | 409 | Waits 2 seconds, asks user to retry |
| `PROMO_COUPON_LIMIT_REACHED` | 400/422 | Shows "coupon limit reached" message |
| `ORDER_TOTAL_TOO_LOW` | 400 | Shows "order total below minimum" message |
| `ACCOUNT_FLAGGED` | 403 | Shows persistent toast, blocks payment |

**Important for `DUPLICATE_ORDER` details:** The frontend reads `details.order_number` and `details.payment_method` from the error response to decide how to handle the duplicate. For PayPal duplicates specifically, the frontend always cancels and retries (because PayPal order IDs expire on PayPal's side).

---

## Backend Implementation Checklist

### 1. Fix `POST /api/orders` for `payment_method: "paypal"`

When the backend receives `payment_method: "paypal"`:

1. Create the order in the database (same as Stripe flow)
2. **Call PayPal Orders API v2** to create a PayPal order:
   ```
   POST https://api-m.paypal.com/v2/checkout/orders
   ```
   (or `https://api-m.sandbox.paypal.com/v2/checkout/orders` for sandbox)
3. **Include the PayPal order `id` in the response** as `data.paypal_order_id`

The PayPal Orders API v2 request body should look something like:

```json
{
  "intent": "CAPTURE",
  "purchase_units": [{
    "reference_id": "ORD-ABC123-XYZ",
    "amount": {
      "currency_code": "NZD",
      "value": "50.00"
    },
    "shipping": {
      "name": { "full_name": "John Doe" },
      "address": {
        "address_line_1": "123 Queen St",
        "admin_area_2": "Auckland",
        "admin_area_1": "Auckland",
        "postal_code": "1010",
        "country_code": "NZ"
      }
    }
  }]
}
```

The PayPal API will return something like:

```json
{
  "id": "5O190127TN364715T",
  "status": "CREATED",
  "links": [...]
}
```

That `id` field (`"5O190127TN364715T"`) is what must be returned as `data.paypal_order_id`.

### 2. Ensure `POST /api/orders/:orderNumber/capture-paypal` works

This endpoint should:

1. Receive `{ paypal_order_id: "..." }` in the body
2. Call PayPal Orders API v2 to capture:
   ```
   POST https://api-m.paypal.com/v2/checkout/orders/{paypal_order_id}/capture
   ```
3. Verify the capture was successful
4. Update the order status to `paid` in the database
5. Return `{ ok: true, data: { order_number, status: "paid" } }`

### 3. Ensure `POST /api/orders/:orderNumber/cancel` works for PayPal orders

This is called frequently by the frontend (user closes popup, errors, duplicate cleanup). It should:

1. Set order status to `cancelled` in the database
2. Optionally void/cancel the PayPal order on PayPal's side if it was created
3. Return success even if the PayPal void fails (so the frontend can retry cleanly)

### 4. Handle `is_duplicate` correctly for PayPal

When the backend receives a duplicate idempotency key for a PayPal order:

- If the original PayPal order was already captured/paid: return the order info (frontend will check status)
- If the original PayPal order is still pending: return `is_duplicate: true` so the frontend cancels it and retries with a fresh PayPal order (PayPal order IDs expire after ~3 hours)
- **Do NOT** return a stale `paypal_order_id` from a previous attempt — it may have expired on PayPal's side

---

## PayPal SDK Configuration (Frontend)

The frontend loads the PayPal JS SDK with:

```
https://www.paypal.com/sdk/js?client-id=ASCSnoeTrj2EkqTuWH_JBnuCzYzGVcGk05BpeeTu46up60pJIBsbVN0Z6Prvj9Bjq6YXsGYNOOfKwHAG&currency=NZD&disable-funding=card,credit
```

- **Client ID**: `ASCSnoeTrj2EkqTuWH_JBnuCzYzGVcGk05BpeeTu46up60pJIBsbVN0Z6Prvj9Bjq6YXsGYNOOfKwHAG`
- **Currency**: NZD
- **Disabled funding**: card, credit (only PayPal button shown)

The backend must use the **matching PayPal credentials** (same account/environment). If the frontend uses a live client ID, the backend must use the corresponding live secret key. If sandbox, both must be sandbox.

---

## Complete PayPal Flow (Happy Path)

```
1. User clicks "Pay with PayPal" button
2. Frontend → POST /api/orders { payment_method: "paypal", ... }
3. Backend creates DB order + calls PayPal Orders API v2 to create PayPal order
4. Backend → { ok: true, data: { order_number, payment_method: "paypal", paypal_order_id: "5O190127TN364715T" } }
5. Frontend returns paypal_order_id to PayPal SDK
6. PayPal SDK opens popup → user logs in and approves
7. PayPal SDK calls onApprove with { orderID: "5O190127TN364715T" }
8. Frontend → POST /api/orders/ORD-xxx/capture-paypal { paypal_order_id: "5O190127TN364715T" }
9. Backend calls PayPal Orders API v2 capture endpoint
10. Backend → { ok: true, data: { order_number, status: "paid" } }
11. Frontend clears cart, redirects to order confirmation
```

## Error/Cancel Flows

```
User closes PayPal popup:
  → Frontend calls POST /api/orders/ORD-xxx/cancel
  → Shows "Payment cancelled" toast

PayPal capture fails:
  → Frontend shows error near PayPal button (#paypal-errors element)
  → Order remains in pending state (user can retry)

Duplicate order (409):
  → Frontend cancels the existing order
  → Shows "A previous payment attempt was cleared. Please click Pay with PayPal again."

Backend returns ok:true but no paypal_order_id (CURRENT BUG):
  → Frontend cancels the order
  → Shows "PayPal setup did not complete. Please click Pay with PayPal again."
```

---

## Quick Diagnostic

To verify the fix, the backend response for `POST /api/orders` with `payment_method: "paypal"` should look exactly like:

```json
{
  "ok": true,
  "data": {
    "order_number": "ORD-XXXXXX-XXXX",
    "payment_method": "paypal",
    "paypal_order_id": "XXXXXXXXXXXXXXX"
  }
}
```

If `paypal_order_id` is missing, null, or empty string, the frontend will reject it.
