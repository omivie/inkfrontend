# Backend Implementation: Notification Recipients System

## Overview

The frontend admin panel now has a **Notification Recipients** page where the site owner can manage email recipients and toggle which notification types each recipient receives. The preferences are stored in a new Supabase table `notification_preferences`. The backend needs to **read these preferences** at each event trigger point and **send emails** to the appropriate recipients.

---

## What Already Exists

### Supabase Tables

**`contact_emails`** (existing — unchanged)
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | `gen_random_uuid()` |
| `email` | text | UNIQUE |
| `created_at` | timestamptz | `now()` |

RLS: Public SELECT (`true`), admin-managed via backend API.

**`notification_preferences`** (NEW — already created via migration)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | uuid PK | `gen_random_uuid()` | |
| `contact_email_id` | uuid | — | FK → `contact_emails(id)` ON DELETE CASCADE, UNIQUE |
| `notify_orders` | boolean | `true` | New customer order placed |
| `notify_contact` | boolean | `true` | Contact form submission |
| `notify_low_stock` | boolean | `false` | Stock below threshold |
| `notify_refunds` | boolean | `false` | Refund requested or chargeback |
| `notify_signups` | boolean | `false` | New customer account created |
| `notify_reviews` | boolean | `false` | New product review submitted |
| `updated_at` | timestamptz | `now()` | |

RLS: Admin-only (requires `super_admin` role in `admin_roles` table). **The backend must use the Supabase service role key** to read this table, since backend API calls don't go through Supabase Auth.

### Current Recipients & Preferences

| Email | Orders | Contact | Low Stock | Refunds | Signups | Reviews |
|-------|--------|---------|-----------|---------|---------|---------|
| vielandvnnz@gmail.com | ON | ON | ON | ON | ON | ON |
| junjackson0915@gmail.com | ON | ON | OFF | OFF | OFF | OFF |
| inkandtoner@windowslive.com | ON | ON | OFF | OFF | OFF | OFF |

### Existing Backend API Endpoints (no changes needed)

```
GET    /api/admin/contact-emails       → List recipients
POST   /api/admin/contact-emails       → Add (body: { email })
DELETE /api/admin/contact-emails/:id   → Remove
```

These continue to manage the `contact_emails` table as before. The frontend handles `notification_preferences` directly via Supabase client.

---

## What the Backend Needs to Implement

### 1. Helper: Get Notification Recipients

Create a reusable helper function that queries both tables to get the list of emails for a given notification type.

**SQL query to use:**
```sql
SELECT ce.email
FROM contact_emails ce
JOIN notification_preferences np ON np.contact_email_id = ce.id
WHERE np.<notification_column> = true;
```

**Example helper (pseudocode):**
```js
// Using Supabase service role client
async function getNotificationRecipients(notificationType) {
  // notificationType = 'notify_orders' | 'notify_contact' | 'notify_low_stock' | etc.
  const { data, error } = await supabaseAdmin
    .from('notification_preferences')
    .select('contact_email_id, contact_emails!inner(email)')
    .eq(notificationType, true);

  if (error || !data) return [];
  return data.map(row => row.contact_emails.email);
}
```

**Important:** Use the **service role key** (not the anon key) since `notification_preferences` has admin-only RLS policies.

---

### 2. Hook Into Existing Event Points

For each notification type, hook into the existing backend route handler or webhook to send emails to the relevant recipients.

#### `notify_orders` — Customer Orders

**Trigger point:** After order payment is confirmed (Stripe webhook `payment_intent.succeeded` or PayPal capture).

**What to send:**
- Order number, customer name, customer email
- Order total, item count
- Shipping address summary
- Payment method (Stripe/PayPal)
- Link to admin order detail: `https://inkcartridges.co.nz/html/admin#orders` (or deep link if supported)

**Existing endpoint context:**
- Stripe webhook handler: processes `payment_intent.succeeded`
- PayPal capture: `POST /api/orders/:orderNumber/capture-paypal`
- Order status moves from `pending` → `paid` at this point

**Recipients query:** `getNotificationRecipients('notify_orders')`

---

#### `notify_contact` — Contact Form Submissions

**Trigger point:** `POST /api/contact` — this likely already sends emails to all `contact_emails` recipients.

**What needs to change:** Instead of emailing ALL `contact_emails`, filter to only those with `notify_contact = true`.

**What to send:** (probably already implemented)
- Sender name, email, phone
- Subject and message body
- Order number (if provided)

**Recipients query:** `getNotificationRecipients('notify_contact')`

---

#### `notify_low_stock` — Low Stock Alerts

**Trigger point:** When stock quantity drops below a threshold. This could be:
- After an order is placed (stock deducted)
- A scheduled check / cron job
- The `GET /api/settings` endpoint already returns `stock_thresholds`

**What to send:**
- Product name, SKU
- Current stock quantity
- Threshold that was breached
- Link to admin products page

**Recipients query:** `getNotificationRecipients('notify_low_stock')`

**Note:** If no stock alert system exists yet, this can be deferred. The frontend toggle is ready for when it's implemented.

---

#### `notify_refunds` — Refunds & Chargebacks

**Trigger point:** `POST /api/admin/refunds` (refund created) or Stripe chargeback webhook.

**What to send:**
- Order number
- Refund amount
- Reason
- Customer email
- Link to admin refunds page

**Recipients query:** `getNotificationRecipients('notify_refunds')`

---

#### `notify_signups` — New Account Signups

**Trigger point:** `POST /api/account/sync` — this is called after a user logs in / signs up for the first time. It creates the profile if it doesn't exist.

**What to send:**
- Customer email
- Signup timestamp
- Link to admin customers page

**Note:** Only send on *new* profile creation, not on every sync call. Check if the profile was just created vs. already existed.

**Recipients query:** `getNotificationRecipients('notify_signups')`

---

#### `notify_reviews` — Product Reviews

**Trigger point:** `POST /api/reviews` — when a customer submits a review.

**What to send:**
- Product name, SKU
- Customer name/email
- Rating (1-5 stars)
- Review title and body
- Status (pending approval)
- Link to admin reviews page: `https://inkcartridges.co.nz/html/admin#product-review`

**Recipients query:** `getNotificationRecipients('notify_reviews')`

---

### 3. Email Format

Use the same email sending infrastructure already in place for order confirmations and contact form forwarding. Suggested subject lines:

| Type | Subject Line Example |
|------|---------------------|
| `notify_orders` | `[InkCartridges] New Order #ORD-42-a3f1 — $124.90` |
| `notify_contact` | `[InkCartridges] Contact Form: {subject}` |
| `notify_low_stock` | `[InkCartridges] Low Stock Alert: {product_name} ({quantity} remaining)` |
| `notify_refunds` | `[InkCartridges] Refund Requested — Order #ORD-42-a3f1` |
| `notify_signups` | `[InkCartridges] New Customer Signup: {email}` |
| `notify_reviews` | `[InkCartridges] New Review: {product_name} — {rating} stars` |

---

### 4. Edge Case: New Email Added Without Preferences Row

When a new email is added via `POST /api/admin/contact-emails`, the frontend automatically creates a `notification_preferences` row with defaults (`notify_orders` and `notify_contact` = true, rest = false).

However, as a safety net, the backend should handle the case where a `contact_emails` row exists but has no matching `notification_preferences` row. In that case, treat it as if all defaults apply (orders + contact = ON, rest = OFF). Or better yet, auto-create the preferences row in the `POST /api/admin/contact-emails` handler:

```sql
INSERT INTO notification_preferences (contact_email_id, notify_orders, notify_contact)
VALUES (:newEmailId, true, true)
ON CONFLICT (contact_email_id) DO NOTHING;
```

---

## Supabase Connection Details

| Key | Value |
|-----|-------|
| Project ID | `lmdlgldjgcanknsjrcxh` |
| API URL | `https://lmdlgldjgcanknsjrcxh.supabase.co` |
| Service Role Key | Check Render environment variables (likely `SUPABASE_SERVICE_ROLE_KEY`) |

The backend should already have a Supabase admin/service client configured since it reads/writes `contact_emails`, `orders`, `products`, etc.

---

## Priority Order for Implementation

1. **`notify_reviews`** — User is actively requesting this
2. **`notify_orders`** — High value, may already partially exist
3. **`notify_contact`** — Likely just needs filtering added to existing logic
4. **`notify_refunds`** — Hook into existing refund endpoint
5. **`notify_signups`** — Hook into account sync
6. **`notify_low_stock`** — May need a new stock-check mechanism

---

## Testing

After implementation, verify each notification type:

1. Submit a review on any product → check that `vielandvnnz@gmail.com` receives a review notification email (only recipient with `notify_reviews = true`)
2. Place a test order → all 3 emails should receive order notifications
3. Submit the contact form → all 3 emails should receive it
4. Toggle a preference OFF in the admin UI → verify that recipient stops getting that notification type
5. Add a new email in admin UI → verify it gets default preferences and receives orders + contact notifications
