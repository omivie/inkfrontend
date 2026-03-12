# PayPal Backend Issue — Frontend Getting Error on Pay

## Problem

When the user clicks "Pay with PayPal" on the payment page, the PayPal JS SDK popup fails immediately with a generic error. The frontend `onError` callback fires, which means either:

1. The `POST /api/orders` call with `payment_method: "paypal"` is returning an error, OR
2. The `paypal_order_id` returned is not valid / not recognized by PayPal's SDK

## What the Frontend Does

When the user clicks the PayPal button, the frontend calls:

```
POST /api/orders
```

With this payload:

```json
{
  "items": [{ "product_id": "uuid", "quantity": 1 }],
  "shipping_address": { ... },
  "payment_method": "paypal",
  "delivery_type": "urban",
  "idempotency_key": "sha256-hash",
  "save_address": true
}
```

### Expected Response (from PAYPAL_FRONTEND_HANDOFF.md)

```json
{
  "ok": true,
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-ABC123-XY4Z",
    "status": "pending",
    "total_amount": 29.95,
    "payment_method": "paypal",
    "paypal_order_id": "5O190127TN364715T",
    "paypal_approve_url": "https://www.sandbox.paypal.com/checkoutnow?token=...",
    "items": [...],
    "shipping_address": {...}
  }
}
```

The frontend then returns `data.paypal_order_id` to the PayPal JS SDK, which uses it to open the approval popup.

## What to Check

1. **Does `POST /api/orders` accept `payment_method: "paypal"`?**
   - Try calling it manually with curl/Postman and check the response
   - Is it returning `{ ok: true, data: { paypal_order_id: "..." } }`?

2. **Is the PayPal order being created on PayPal's side?**
   - The backend should call PayPal's `POST /v2/checkout/orders` API to create the order
   - The returned PayPal order ID must be a valid, active PayPal order

3. **Is it a sandbox vs live mismatch?**
   - The frontend is using the **live** PayPal client ID: `ASCSnoeTrj2EkqTuWH_JBnuCzYzGVcGk05BpeeTu46up60pJIBsbVN0Z6Prvj9Bjq6YXsGYNOOfKwHAG`
   - The backend must also be using **live** PayPal credentials (not sandbox)
   - If the backend creates a sandbox order but the frontend SDK is using a live client ID, PayPal will reject it

4. **Check the capture endpoint exists too:**
   ```
   POST /api/orders/:orderNumber/capture-paypal
   Body: { "paypal_order_id": "..." }
   ```
   - This is called after the user approves — but the current error happens *before* this step

## Quick Diagnostic

Run this curl to test the order creation endpoint directly:

```bash
curl -X POST https://ink-backend-zaeq.onrender.com/api/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "items": [{"product_id": "SOME_PRODUCT_UUID", "quantity": 1}],
    "shipping_address": {
      "first_name": "Test",
      "last_name": "User",
      "address_line_1": "123 Queen St",
      "city": "Auckland",
      "region": "auckland",
      "postal_code": "1010",
      "country": "NZ",
      "phone": "0210000000"
    },
    "payment_method": "paypal",
    "delivery_type": "urban",
    "idempotency_key": "test-paypal-123",
    "save_address": false
  }'
```

Check if the response has `paypal_order_id` and it's a real PayPal order ID.

## Most Likely Cause

**Sandbox/Live mismatch.** The frontend SDK is loaded with the live client ID. If the backend is creating PayPal orders with sandbox credentials, the SDK will reject the order ID. Both sides must use the same environment (live or sandbox).
