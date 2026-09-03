# Orders page — show "Tracking requested" in the Invoice sent column (Sep 2026)

**FE action required.** `GET /api/admin/orders` now tells you, per order row,
whether the customer has asked for tracking and whether we've answered them.
Render it in the **Invoice sent** cell — the column that is an em-dash on every
website row today, which is exactly where tracking requests live.

Also shipped on `GET /api/admin/orders/:orderId` (same envelope) so the order
modal can show it when the operator arrives from the Tracking Requests panel.

---

## 1. Why

A customer who can't see where their parcel is fills in the form at
`/track-order`. That writes an `order_tracking_requests` row and lights up the
standalone **Tracking Requests** page — and nowhere else. The operator working
the **Orders** list, which is where they actually process orders, gets no signal
at all: order `2026090203` looks identical to the four orders either side of it,
even though that customer asked for tracking on 2 Sept and is still waiting.

Meanwhile the Invoice-sent column is `null` on every website row (see
`orders-invoice-sent-column-FE-handoff-sep2026.md`), and website rows are the
only rows tracking requests ever come from. The cell is free. Use it.

---

## 2. Contract

Each element of `data[]` gains **one** field (and `data.order` on the detail
endpoint gains the same):

```jsonc
{
  // ...existing order fields (order_number, status, channel, invoice_sent, ...)

  "tracking_request": null | {
    "state":         "requested" | "sent",
    "requested_at":  "2026-09-02T07:29:38.364Z",
    "sent_at":       null | "2026-09-03T21:04:11.902Z",
    "request_count": 1
  }
}
```

| Value | Meaning | Render |
|---|---|---|
| `null` | The customer never asked for tracking. | Nothing — fall through to `invoice_sent` (em-dash on web rows). |
| `state: "requested"` | **Outstanding.** They asked; we have not sent tracking. | `Tracking requested` — amber/actionable chip, dated from `requested_at`. |
| `state: "sent"` | Answered. The shipping-information email went out. | `Tracking sent` — muted/green chip, dated from `sent_at`. |

### Rules

1. **`state` is the authority.** Don't re-derive it from `order.status` or
   `tracking_number`: an order can be shipped with tracking and still have an
   open request if the email hasn't gone out, and vice versa.
2. **`sent_at` can be non-null while `state` is `"requested"`.** That means the
   customer was answered once and has asked *again* — worth showing as
   `Tracking requested (2nd time)` if you have room. `request_count` is the total
   number of asks.
3. **`requested_at` is the OPEN request's date**, not the newest row's. When a
   request is open, that date is how long the customer has actually been waiting
   — surface it, because some of the live ones are months old.
4. **Mute the chip on cancelled orders.** A `cancelled` order will never ship, so
   its request can never clear itself (see §4). Use the row's existing `status`
   field for this — the backend deliberately doesn't fold order status into
   `state`, because "the customer asked" stays true either way.

### Precedence in the cell

Both facts can apply to one row (an invoice-claimed order whose customer also
asked for tracking). Recommendation:

```
if (tracking_request?.state === 'requested')  →  Tracking requested   (outranks everything: someone is waiting)
else if (invoice_sent)                        →  existing invoice rendering
else if (tracking_request?.state === 'sent')  →  Tracking sent        (muted)
else                                          →  —
```

If you'd rather stack two chips, that's fine too — the fields are independent.
Consider renaming the column header to **Invoice / tracking** so it reads
honestly; the backend doesn't care what you call it.

---

## 3. Worked example — page 1 of the live Orders list

Replayed against live data (7 open requests exist catalogue-wide, all on website
rows, all unanswered):

| Order # | Status | Before | After |
|---|---|---|---|
| 2026090205 | paid | `—` | `—` |
| 2026090204 | paid | `—` | `—` |
| **2026090203** | paid | `—` | **`Tracking requested · 2 Sept`** |
| 2026090202 | paid | `—` | `—` |
| INV-3278 | paid (invoice) | `2 Sept` | `2 Sept` (unchanged) |
| …the rest of page 1 | — | `—` | `—` |

Older pages pick up six more: `20260814000001`, `20260813000002`,
`20260731000001`, `20260716000001`, `20260714000001` (**cancelled** — mute it),
`20260623000001`.

---

## 4. Backend notes (no FE action)

- **Source of truth:** `order_tracking_requests` (mig 083). `status='pending'`
  → `state:'requested'`; `status='fulfilled'` → `state:'sent'`.
- **What flips it to `sent`:** a shipping-information email that actually went
  out. All five admin send paths now clear the open request through one helper
  (`fulfillPendingTrackingRequests`), gated on the send returning true.
  **Two of them previously didn't clear it at all** — the Update Status modal's
  transition to `shipped`, and marking shipped from the Shipping panel without
  ticking "send email". Those are the busiest ship paths, so before this fix the
  chip would have stuck on `Tracking requested` after the customer had already
  been emailed. Fixed in the same change.
- **A failed or skipped send leaves the request open.** Flipping an order to
  `shipped` with no tracking number on it emails nothing, so the chip correctly
  stays `Tracking requested` — the customer really is still waiting.
- **Cost:** batched — one query per 100 orders on the list, zero extra round
  trips per row. The id filter is chunked at 100 because PostgREST answers a
  500-UUID `.in()` with an opaque "fetch failed".
- **Fail-soft:** a lookup failure degrades every row on the page to `null` (the
  chip disappears) rather than failing the order list.
- **Shaping logic:** `src/utils/orderTrackingRequest.js` (pure), pinned by
  `__tests__/order-tracking-request.test.js`.

### Known gap — a request on a cancelled order can't be cleared

`20260714000001` was cancelled on 14 Jul with an open tracking request against
it. Nothing will ever ship, so no email will ever fire, so the request stays
`pending` forever and the row keeps its amber chip permanently.

There is currently **no manual "dismiss" action** — the Tracking Requests panel
only offers "Open order to add tracking". Muting the chip on `status: 'cancelled'`
rows (rule 4 above) handles the display side. If you want a real resolve button,
say the word and I'll add `POST /api/admin/orders/:orderId/tracking-request/dismiss`
plus a `'dismissed'` status — it needs a migration to widen the CHECK constraint,
which is why it isn't in this change.
