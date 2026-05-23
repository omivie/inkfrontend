# Tracking Requests — Backend Implementation Spec (May 2026)

> **For the backend Claude.** This document is the complete contract for the
> customer-initiated "request tracking" feature. The **frontend is already
> built and merged** against the shapes below. Implement these endpoints + the
> two emails, run the SQL, and the feature is live end-to-end. Verify each item
> in the checklist at the bottom.
>
> Stack reminders: backend is the separate Render service
> (`https://ink-backend-zaeq.onrender.com`), Supabase project
> `lmdlgldjgcanknsjrcxh`, response envelope is `{ ok: true, data }` /
> `{ ok: false, error, code }` (NOT `success`). Frontend reads `res.data`.

---

## 1. Why this exists / behaviour change

We **no longer surface tracking to customers automatically**. Instead:

1. Customer visits **`/track-order`** (public page, also linked from the footer
   and the account sidebar), enters their **order number** + the **email** they
   used at checkout, and submits.
2. Backend **records a request** and **emails every admin recipient** who has
   `notify_tracking_requests = true`.
3. An admin opens **Admin → Tracking Requests**, clicks **“Add tracking &
   notify”**, enters the **carrier + tracking number**, and submits.
4. Backend **writes the tracking onto the order**, advances it to **`shipped`**,
   **marks the request fulfilled**, and **emails the customer** their tracking
   number + status.

The customer page **never** displays a tracking number, carrier, timeline, or
live events. It only confirms the request was received.

---

## 2. Database

Apply **`inkcartridges/sql/tracking_requests.sql`** (idempotent). It creates:

- **`public.tracking_requests`** — the queue. Columns:
  `id uuid pk`, `order_number text not null`, `order_id uuid null` (FK orders),
  `email text`, `customer_name text`,
  `status text` ∈ `{pending, fulfilled, dismissed}` default `pending`,
  `carrier text`, `tracking_number text`, `note text`, `request_ip text`,
  `created_at timestamptz`, `fulfilled_at timestamptz`, `fulfilled_by uuid`.
  RLS enabled with **no policies** → only the **service role** (backend)
  touches it.
- **`notification_preferences.notify_tracking_requests boolean default true`** —
  the admin opt-in flag (the `notification_preferences` table already exists and
  is keyed by `contact_email_id`).

---

## 3. Customer endpoint (public, rate-limited)

### `POST /api/orders/track-request`

Public — **no auth**. Rate-limit per IP (suggest ~5/min, 20/hour) and return
`429 { ok:false, code:'RATE_LIMITED' }` when exceeded (frontend shows a “wait a
minute” message keyed on `code === 'RATE_LIMITED'`).

**Request body**
```json
{ "order_number": "ORD-ABC123-XYZ", "email": "buyer@example.com" }
```
`email` may be `null` (a signed-in customer can omit it). `order_number` is
required, trim + cap at 40 chars.

**Behaviour**
1. Look up the order by `order_number`.
2. **Anti-enumeration:** ALWAYS respond `200 { ok: true, data: { received: true } }`
   regardless of whether the order exists or the email matches. Never leak
   existence/validity. The frontend shows an identical confirmation either way.
3. Only **when the order exists**:
   - Optionally verify `email` matches the order's email. If it doesn't match,
     still return success but you may skip notifying (your call — recommended:
     still record the request flagged, but only email admins when it's a
     plausible match, to cut spam). Record `request_ip`.
   - **Insert a `tracking_requests` row** (`status='pending'`, `order_id`,
     `order_number`, `email`, `customer_name` from the order if available).
     De-dupe: if an identical **pending** request for the same `order_id` was
     created in the last ~10 min, reuse it instead of inserting a duplicate.
   - **Email admins** — see §5.1. Recipients = `contact_emails` joined to
     `notification_preferences` where `notify_tracking_requests = true`.

**Response (always, on success path):**
```json
{ "ok": true, "data": { "received": true } }
```

> The frontend (`API.requestOrderTracking` in `inkcartridges/js/api.js`) only
> checks `response.ok`. On `code:'RATE_LIMITED'` it shows the throttle message;
> any other `ok:false` shows a generic retry message.

---

## 4. Admin endpoints (auth-gated, admin only)

All under the existing admin auth middleware. Standard envelope.

### 4.1 `GET /api/admin/tracking-requests`
Query params: `status` ∈ `{pending, fulfilled, dismissed}` (omit/`all` = all),
`search` (matches order_number or email), `page` (default 1), `limit`
(default 50).

**Response**
```json
{
  "ok": true,
  "data": {
    "requests": [
      {
        "id": "uuid",
        "order_number": "ORD-ABC123-XYZ",
        "order_id": "uuid|null",
        "email": "buyer@example.com",
        "customer_name": "Jane Doe|null",
        "status": "pending",
        "carrier": null,
        "tracking_number": null,
        "note": null,
        "created_at": "2026-05-22T03:14:00Z",
        "fulfilled_at": null
      }
    ],
    "pagination": { "page": 1, "limit": 50, "total": 12 }
  }
}
```
Frontend reads `data.requests` and `data.pagination.total` (the nav badge uses
`?status=pending&limit=1` and reads `pagination.total`).

### 4.2 `POST /api/admin/tracking-requests/:id/fulfill`
This is the **loop-closer**. One call must do everything atomically (or
best-effort sequential with a clear failure response).

**Request body**
```json
{ "carrier": "NZ Post", "tracking_number": "ABC123456789NZ", "status": "shipped", "note": "Dispatched today" }
```
`carrier` and `note` may be `null`. `tracking_number` is required. `status`
defaults to `"shipped"`.

**Behaviour**
1. Load the request; 404 if missing. If already `fulfilled`, return a clear
   error (or be idempotent — your call).
2. **Update the order** (`order_id` or resolve via `order_number`): set
   `carrier`, `tracking_number`, `shipped_at = now()`, and transition status to
   `shipped` (bridge through `processing` if your state machine requires it, as
   the admin orders flow already does).
3. **Mark the request** `status='fulfilled'`, `carrier`, `tracking_number`,
   `note`, `fulfilled_at=now()`, `fulfilled_by = <admin uid>`.
4. **Email the customer** their tracking — see §5.2.

**Response**
```json
{ "ok": true, "data": { "request": { "...": "updated row" }, "order": { "...": "updated order" } } }
```
On failure return `{ ok:false, error, code, request_id }` (frontend surfaces
`error` + the 8-char `request_id`).

### 4.3 `PUT /api/admin/tracking-requests/:id`
Body `{ "status": "dismissed" }` — dismiss without sending tracking (spam /
duplicate). Set `status='dismissed'`. Response `{ ok:true, data:{...} }`.

---

## 5. Emails

Reuse the existing transactional email pipeline (the same one that sends order
confirmations / contact-form notifications). Both emails must be plain-branded,
mobile-friendly, and include the standard footer (Office Consumables Ltd, NZBN,
GST, support contact).

### 5.1 Admin notification — “New tracking request”
- **To:** every `contact_emails` row whose `notification_preferences.notify_tracking_requests = true`.
- **Subject:** `New tracking request — {order_number}`
- **Body:** order number, customer email, requested-at timestamp, and a deep
  link to **`/admin#tracking-requests`**. If the order couldn't be matched, say
  so (“no matching order found for this number”) so the admin can investigate.

### 5.2 Customer tracking email — “Your order is on its way”
- **To:** the **order's email on file** (NOT a requester-supplied email that
  didn't match — never email tracking to an unverified address).
- **Subject:** `Your InkCartridges.co.nz order {order_number} has shipped`
- **Body:** carrier, tracking number, a tracking URL when the carrier is known
  (e.g. NZ Post: `https://www.nzpost.co.nz/tools/tracking?trackid={tracking_number}`),
  the optional `note`, and the order contents/summary if convenient.

---

## 6. Security / edge cases

- **Enumeration:** the public endpoint must be constant-response. Same body +
  status for valid, invalid, and non-matching-email order numbers.
- **Rate limiting:** per-IP on `POST /api/orders/track-request`. Also de-dupe
  pending requests per order within ~10 min.
- **Tracking destination:** the customer email (§5.2) always goes to the order's
  stored email, never to an arbitrary address from the request body.
- **Admin authz:** list/fulfill/dismiss require the admin role (same guard as
  `/api/admin/orders`). Regular admins (not just owners) should be able to
  fulfil — the frontend nav item is NOT owner-gated.

---

## 7. Frontend touch-points (already shipped — for your reference)

| Concern | File |
|---|---|
| Customer API call | `inkcartridges/js/api.js` → `API.requestOrderTracking()` |
| Customer page controller | `inkcartridges/js/track-order-page.js` |
| Public page | `inkcartridges/html/track-order.html` (route `/track-order`) |
| Account page | `inkcartridges/html/account/track-order.html` |
| Footer links | `inkcartridges/js/footer.js` (Information column + bottom nav) |
| Admin API calls | `inkcartridges/js/admin/api.js` → `getTrackingRequests`, `getPendingTrackingRequestCount`, `fulfillTrackingRequest`, `dismissTrackingRequest` |
| Admin page + nav badge | `inkcartridges/js/admin/pages/tracking-requests.js`, `inkcartridges/js/admin/app.js` |
| Admin opt-in toggle | `inkcartridges/js/admin/pages/contact-emails.js` (`notify_tracking_requests`) |
| Schema | `inkcartridges/sql/tracking_requests.sql` |

---

## 8. Verification checklist

- [ ] `tracking_requests.sql` applied; table + `notify_tracking_requests` column exist.
- [ ] `POST /api/orders/track-request` returns identical `200 {ok:true,data:{received:true}}` for a real order, a fake order number, and a mismatched email.
- [ ] Submitting for a **real** order inserts a `pending` row and emails opted-in admins only.
- [ ] Rate limit returns `429 {ok:false,code:'RATE_LIMITED'}`.
- [ ] `GET /api/admin/tracking-requests?status=pending` returns the row with `pagination.total`.
- [ ] Nav badge: `GET /api/admin/tracking-requests?status=pending&limit=1` → `pagination.total` reflects the count.
- [ ] `POST /api/admin/tracking-requests/:id/fulfill` updates the order to `shipped` with carrier+tracking, marks the request `fulfilled`, and emails the **order's** email.
- [ ] `PUT /api/admin/tracking-requests/:id {status:'dismissed'}` works.
- [ ] Turning off `notify_tracking_requests` for a recipient stops their admin emails.
- [ ] Customer tracking email never sent to an unverified requester email.
