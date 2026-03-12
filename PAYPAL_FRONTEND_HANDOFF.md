# PayPal Frontend Integration Guide

The backend has a **custom PayPal integration** (not Stripe). The "Pay with PayPal" button must NOT go through Stripe — it needs its own flow.

> **Important:** Remove the PayPal button from Stripe's Payment Element. The PayPal button should be a separate, custom button that triggers the flow below.

---

## Flow Overview

```
1. User clicks "Pay with PayPal"
2. Frontend calls POST /api/orders with payment_method: "paypal"
3. Backend returns paypal_order_id + paypal_approve_url
4. Frontend redirects user to paypal_approve_url (PayPal login/approval)
5. User approves → PayPal redirects back to your site
6. Frontend calls POST /api/orders/:orderNumber/capture-paypal
7. Backend captures payment → order moves to "paid"
8. Frontend shows order confirmation
```

---

## Step 1: Create Order with PayPal

```js
const res = await fetch(`${API_BASE}/api/orders`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    items: [{ product_id: 'uuid', quantity: 1 }],
    shipping_address: {
      first_name: 'John',
      last_name: 'Doe',
      address_line_1: '123 Queen St',
      city: 'Auckland',
      region: 'Auckland',
      postal_code: '1010',
      country: 'NZ',
      phone: '021...'
    },
    payment_method: 'paypal',       // ← THIS IS THE KEY PART
    delivery_type: 'urban',
    idempotency_key: 'sha256-hash',
    save_address: true
  })
});

const data = await res.json();
```

### Response (PayPal order):

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
    "paypal_approve_url": "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    "items": [...],
    "shipping_address": {...},
    "created_at": "2026-03-12T..."
  }
}
```

## Step 2: Redirect to PayPal

```js
if (data.ok && data.data.payment_method === 'paypal') {
  // Save order info for when user comes back
  sessionStorage.setItem('pending_paypal_order', JSON.stringify({
    order_number: data.data.order_number,
    paypal_order_id: data.data.paypal_order_id
  }));

  // Redirect to PayPal for approval
  window.location.href = data.data.paypal_approve_url;
}
```

## Step 3: Handle PayPal Return

When the user approves payment, PayPal redirects them back to your site. Set up a return page (e.g., `/checkout/paypal-return`).

PayPal appends `?token=PAYPAL_ORDER_ID&PayerID=XXXXX` to the return URL.

```js
// On your /checkout/paypal-return page:
async function handlePayPalReturn() {
  const urlParams = new URLSearchParams(window.location.search);
  const paypalToken = urlParams.get('token'); // This is the PayPal order ID

  // Retrieve saved order info
  const pending = JSON.parse(sessionStorage.getItem('pending_paypal_order'));

  if (!pending || !paypalToken) {
    showError('PayPal payment session expired. Please try again.');
    return;
  }

  // Step 4: Capture the payment
  const res = await fetch(
    `${API_BASE}/api/orders/${pending.order_number}/capture-paypal`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        paypal_order_id: pending.paypal_order_id
      })
    }
  );

  const data = await res.json();

  if (data.ok && data.data.status === 'paid') {
    // Payment successful!
    sessionStorage.removeItem('pending_paypal_order');
    window.location.href = `/order-confirmation?order=${pending.order_number}`;
  } else {
    showError(data.error?.message || 'Payment capture failed. Please contact support.');
  }
}

handlePayPalReturn();
```

## Step 4: Handle PayPal Cancel

If the user clicks "Cancel" on PayPal, they are redirected to your cancel URL. The order stays in `pending` status and can be retried.

```js
// On your /checkout/paypal-cancel page:
function handlePayPalCancel() {
  sessionStorage.removeItem('pending_paypal_order');
  // Redirect back to checkout so they can try again
  window.location.href = '/html/checkout';
}
```

---

## Alternative: PayPal JS SDK (Popup Instead of Redirect)

Instead of redirecting, you can use PayPal's JS SDK to open a popup:

```html
<!-- Add to <head> -->
<script src="https://www.paypal.com/sdk/js?client-id=YOUR_CLIENT_ID&currency=NZD"></script>
```

```js
paypal.Buttons({
  createOrder: async () => {
    const res = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        ...orderData,
        payment_method: 'paypal'
      })
    });
    const data = await res.json();
    // Store order_number for capture step
    window._pendingOrderNumber = data.data.order_number;
    // Return the PayPal order ID to the SDK
    return data.data.paypal_order_id;
  },

  onApprove: async (data) => {
    const res = await fetch(
      `${API_BASE}/api/orders/${window._pendingOrderNumber}/capture-paypal`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          paypal_order_id: data.orderID
        })
      }
    );
    const result = await res.json();
    if (result.ok) {
      window.location.href = `/order-confirmation?order=${window._pendingOrderNumber}`;
    }
  },

  onCancel: () => {
    showMessage('Payment cancelled. You can try again.');
  },

  onError: (err) => {
    console.error('PayPal error:', err);
    showError('Something went wrong with PayPal. Please try again.');
  }
}).render('#paypal-button-container');
```

> **Note:** For the JS SDK, use the PayPal Client ID (not the secret). The live client ID is in the backend env vars — ask Jackson for it.

---

## PayPal Client ID for JS SDK

| Environment | Client ID |
|---|---|
| Sandbox | `AUyIr230THGicIydzuW` |
| Live | `ASCSnoeTrj2EkqTuWH_JBnuCzYzGVcGk05BpeeTu46up60pJIBsbVN0Z6Prvj9Bjq6YXsGYNOOfKwHAG` |

> **Production is already set to `live` mode on Render.** The sandbox credentials below are for local development/testing only.

For the PayPal JS SDK `<script>` tag, use the **live** Client ID in production and **sandbox** in development.

---

## Capture Response

```json
{
  "ok": true,
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-ABC123-XY4Z",
    "status": "paid",
    "total_amount": 29.95,
    "payment_method": "paypal",
    "paypal_order_id": "5O190127TN364715T",
    "paypal_capture_id": "3C679366HH908993F"
  }
}
```

## Error Handling

| Error | Meaning | Action |
|---|---|---|
| `PAYMENT_ERROR` (500) | Backend couldn't create PayPal order | Show "PayPal unavailable, try card" |
| `PAYPAL_CAPTURE_FAILED` (400) | User didn't complete PayPal approval | Show "Payment not completed" |
| `RATE_LIMITED` (429) | Too many attempts | Show "Please wait and try again" |
| `ORDER_TOTAL_TOO_LOW` (400) | Total < $0.50 NZD | Show minimum order message |

## Checklist

- [ ] Remove PayPal from Stripe Payment Element (it doesn't work through Stripe)
- [ ] Add separate "Pay with PayPal" button (styled to match PayPal branding)
- [ ] Wire button to create order with `payment_method: "paypal"`
- [ ] Handle redirect flow OR use PayPal JS SDK popup
- [ ] Create `/checkout/paypal-return` page (if using redirect flow)
- [ ] Create `/checkout/paypal-cancel` page (if using redirect flow)
- [ ] Call capture endpoint after user approves
- [ ] Show order confirmation on success
- [ ] Test with sandbox credentials first
