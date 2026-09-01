# Shipping Information section + NZ Couriers — FE hand-off (Sep 2026)

Backend is **done and deployed-ready** (migration 158 applied; 27 new tests, full suite green).
This is everything the frontend needs to build the panel.

## What we're building

Today the only place to record a courier and a tracking number is inside the **Update Status**
modal, and only when you're flipping the order to `shipped`. That has three problems:

1. Shipping details are a *thing about the parcel*, not a *status change* — you cannot revisit
   or correct them without re-opening a status modal.
2. There is no way to send the customer their tracking details on demand.
3. **NZ Couriers** (new carrier) cannot be expressed at all: it identifies a consignment by a
   2–4 character **ticket product code** *plus* the 8-digit **ticket number**. The ticket
   number alone does not resolve to a tracking page.

So: a **separate "Shipping Information" section** in the order detail modal, with its own Save
and its own "Send to customer" action. **Update Status keeps working exactly as it does now** —
nothing you already ship breaks.

---

## 1. The three inputs

| UI field | Sends as | Stored in | Notes |
|---|---|---|---|
| Carrier (dropdown) | `carrier` | `orders.carrier` | Send the **`code`** (`nz_couriers`) or the display name — both accepted, stored canonically. |
| Tracking / Ticket number | `tracking_number` (alias `ticket_number`) | `orders.tracking_number` | **Same field, relabelled per carrier.** See below. |
| Ticket product code | `ticket_product_code` | `orders.ticket_product_code` | Only shown when the carrier needs it. NZ Couriers: the 2–4 char code (e.g. `LH`). |
| Tracking URL | `tracking_url` | `orders.tracking_url` | Optional full `https://` link. **Overrides** everything derived. |

**Why "ticket number" is not its own column.** The NZ Couriers ticket number *is* the tracking
reference — it is what the customer types into track-and-trace. It therefore lives in
`orders.tracking_number`, the column the order state machine, the customer's order page, the
shipping email and the CSV export already read. A parallel column would have meant a dual write
with no second source of truth. You may **send** `ticket_number` if that reads better in your
code; it writes to the same place. Sending both with *different* values is a `400`.

**Relabel, don't branch.** Every response carries `tracking_number_label` — `"Ticket number"`
for NZ Couriers, `"Tracking number"` for everyone else. Render that string; don't hard-code a
carrier check in the FE.

---

## 2. Carrier dropdown — `GET /api/admin/shipping/carriers`

Populate the `<select>` from this, do not hard-code the list. Auth: any admin.

```jsonc
{ "ok": true, "data": { "carriers": [
  { "code": "nz_post",     "name": "NZ Post",     "number_label": "Tracking number",
    "requires_product_code": false, "builds_tracking_url": true,  "supports_live_tracking": true },
  { "code": "courierpost", "name": "CourierPost", "number_label": "Tracking number",
    "requires_product_code": false, "builds_tracking_url": true,  "supports_live_tracking": true },
  { "code": "nz_couriers", "name": "NZ Couriers", "number_label": "Ticket number",
    "requires_product_code": true,  "builds_tracking_url": true,  "supports_live_tracking": false },
  { "code": "post_haste",  "name": "Post Haste",  ... },
  { "code": "aramex",      "name": "Aramex",      ... },
  { "code": "dhl",         "name": "DHL",         "number_label": "Tracking number",
    "requires_product_code": false, "builds_tracking_url": false, "supports_live_tracking": false },
  { "code": "other",       "name": "Other",       "number_label": "Tracking number",
    "requires_product_code": false, "builds_tracking_url": false, "supports_live_tracking": false }
] } }
```

Drive the form off these flags:

- `requires_product_code: true` → **show and require** the Ticket product code input.
- `builds_tracking_url: false` (**`DHL` and `Other`**) → the Tracking URL input is the only way
  to give the customer a link; surface it prominently. DHL publishes no documented tracking
  deep link, so we never invent one — the operator pastes the URL DHL gave them.
- `supports_live_tracking: false` → hide/grey any "live tracking events" UI; only NZ Post-family
  numbers can be polled (the poller runs against the NZ Post parcel API).

---

## 3. Read the current values

Two ways, pick whichever fits your data flow:

**a. Already in the order detail** — `GET /api/admin/orders/:orderId` now returns a
`shipping_information` object (same shape as below, except `email` is `null` — it skips the
extra query). Good for rendering the panel from data you already have.

**b. Dedicated fetch** — `GET /api/admin/orders/:orderId/shipping`. Use this when the panel
opens, so you get the email history too.

```jsonc
{ "ok": true, "data": {
  "order_id": "…", "order_number": "2026090101", "status": "shipped",
  "shipping": {
    "carrier": "NZ Couriers",
    "carrier_code": "nz_couriers",
    "tracking_number": "16025241",
    "tracking_number_label": "Ticket number",
    "ticket_product_code": "LH",

    // Where the customer actually gets sent. Render this as the link.
    "tracking_url": "https://www.nzcouriers.co.nz/nzc/servlet/TAndTServlet?page=1&product_code=LH&serial_number=16025241&request_id=1",
    // The raw stored override (what an operator typed), null when derived.
    "tracking_url_override": null,
    // "operator" | "carrier_template" | null — lets you show "auto-generated link".
    "tracking_url_source": "carrier_template",

    "requires_product_code": true,
    "builds_tracking_url": true,
    "supports_live_tracking": false,
    "shipped_at": "2026-09-01T02:00:00.000Z",
    "is_shipped": true,
    "can_send_email": true,

    "email": { "send_count": 1, "last_status": "sent",
               "last_sent_at": "2026-09-01T02:00:05.000Z",
               "last_queued_at": "2026-09-01T02:00:04.000Z" }
  }
} }
```

- `can_send_email` — enable/disable the "Send to customer" button off this. It is
  `is_shipped && (tracking_number || tracking_url)`.
- `email.send_count > 0` → the customer has already been emailed. Show
  "Last sent {last_sent_at}" and make a second send a deliberate act (confirm dialog), because
  it really does send another email.

---

## 4. Save — `PUT /api/admin/orders/:orderId/shipping`

Roles: `super_admin`, `order_manager`. Rate limit: the shared admin limiter.

```jsonc
// request — every field optional, at least one required
{
  "carrier": "nz_couriers",
  "tracking_number": "16025241",     // or "ticket_number": "16025241"
  "ticket_product_code": "LH",
  "tracking_url": "https://…",       // optional override
  "shipped_at": "2026-09-01T02:00:00Z",  // optional explicit dispatch time
  "mark_shipped": true,              // default false
  "send_email": true                 // default false
}
```

**Merge semantics** — an **omitted** field keeps its stored value; an **empty string** (`""`)
clears it to `null`. So a partial save is safe: sending only `{ "ticket_product_code": "LH" }`
will not wipe the carrier or number.

```jsonc
// 200 response
{ "ok": true, "data": {
  "order_id": "…", "order_number": "2026090101",
  "status": "shipped",
  "status_changed": true,                 // did this request flip the status?
  "shipping": { …same block as above… },
  "email": { "requested": true, "sent": true, "reason": null }
} }
```

### `mark_shipped`

Flips the order to `shipped` **through the same state machine** the Update Status modal uses
(so an invalid source status is a `400`, and a concurrent change is a `409`). It also stamps
`shipped_at` when unset. Leave it `false` to correct details on an order that is already shipped.

### `send_email`

- `true` → sends the shipping-information email **now**, and marks any pending customer
  "where is my order?" tracking requests as fulfilled.
- The order must be `shipped`/`completed` first (send `mark_shipped: true` in the same request,
  or you'll get `ORDER_NOT_SHIPPED`). This is deliberate: the email says "your order has
  shipped", and the customer's own order page hides tracking until the status flips — sending
  early points them at a blank page.
- **`send_email: true` always sends**, even if one went out before. The operator ticked the box
  for *this* save (typically after fixing a mistyped ticket number). Use `email.send_count` to
  warn them first.
- `mark_shipped: true` **without** `send_email` still emails once automatically — same as the
  Update Status modal does today. The response says `"reason": "auto_on_ship"`.

---

## 5. Re-send — `POST /api/admin/orders/:orderId/shipping/send-email`

Body `{}` (or `{ "force": false }` to respect the once-per-order guard). Sends without touching
any stored value. Same 400s as above. Returns `{ email: { requested, sent, reason }, shipping }`.

---

## 6. Errors to handle

| HTTP | `error.code` | When | Suggested UI |
|---|---|---|---|
| 400 | `UNKNOWN_CARRIER` | carrier isn't in the registry | Shouldn't happen if the dropdown is server-driven. `details.allowed` has the valid list. |
| 400 | `TICKET_PRODUCT_CODE_REQUIRED` | NZ Couriers + ticket number, no product code and no URL | Focus the product-code input. **Validate this client-side too.** |
| 400 | `CONFLICTING_TRACKING_NUMBER` | both `tracking_number` and `ticket_number` sent, different values | Bug in the FE — send one. |
| 400 | `INVALID_TRACKING_URL` | not a valid `https://` URL | Inline field error. `http://` is rejected. |
| 400 | `ORDER_NOT_SHIPPED` | `send_email` on a non-shipped order | Prompt: "Mark as shipped and send?" → retry with `mark_shipped: true`. |
| 400 | `NO_TRACKING_INFORMATION` | send with neither number nor URL | Disable the button (`can_send_email`). |
| 400 | `VALIDATION_ERROR` | `mark_shipped` with nothing to track by | Message names the missing field. |
| 409 | — | someone else changed the status mid-edit | Refresh the order, keep the operator's typed values. |

**Why we refuse a half-filled NZ Couriers entry rather than saving it:** the resulting
track-and-trace URL 404s. A dead link in a customer email is worse than no link.

---

## 7. Customer-facing side (storefront)

Already live in the same change — no FE work required unless you want to surface the new fields:

- `GET /api/orders/:orderNumber`, `GET /api/orders`, `GET /api/orders/track/:orderNumber` and
  `POST /api/orders/track-lookup` now return `ticket_product_code`, `carrier_code` and
  `tracking_number_label` alongside the existing `tracking_number` / `tracking_url` / `carrier`.
- `tracking_url` is **no longer hard-coded to NZ Post**. It is the carrier's real link (or the
  operator's override). Previously an Aramex parcel was linked to an NZ Post tracking page that
  could never find it.
- The null-until-shipped contract is unchanged: all tracking fields stay `null` until the order
  is `shipped`/`completed`.

## 8. Shipping email

Same template, three changes: the number row is labelled per carrier ("Ticket number" for NZ
Couriers), a "Ticket product code" row appears when one is set, and the **Track your package**
button uses the carrier's real URL. An order with only a tracking URL and no number still gets a
working email.

---

## Backend reference

| Thing | Where |
|---|---|
| Carrier registry (names, URL templates, labels, poll support) | `src/utils/carriers.js` |
| Admin endpoints | `src/routes/admin.js` — search `SHIPPING INFORMATION` |
| Validation | `src/validators/schemas.js` — `updateOrderShippingSchema` |
| Email | `src/services/emailService.js` — `sendShippingConfirmationEmail(orderId, { force })` |
| Migration | `sql/migrations/158_order_shipping_information.sql` (applied) |
| Tests | `__tests__/order-shipping-information.test.js` (27) |

**Adding another carrier later is a one-file change** (`src/utils/carriers.js`) — the dropdown,
the URL builder, the email and the poll gate all read from it. Don't hard-code carrier names
anywhere in the FE.
