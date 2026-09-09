# Backend brief — the customer order pathway becomes THREE steps

**Repo**: `ink_backend` (Render: `ink-backend-zaeq.onrender.com`) · **Raised**: 2026-09-06 ·
**Frontend ref**: ERR-213 · **Frontend status**: shipped, and renders whatever you send.

---

## What the owner asked for

> "I want to remove two options from this pathway: the Order Confirmed and the Processing
> sections. The order should be placed, then the shipping is added which should trigger
> shipped, then delivered will trigger once we have implemented an auto-deliver, otherwise
> keep as manual for now."

```
BEFORE   Order Placed → Order Confirmed → Processing → Shipped — In Transit → Delivered
AFTER    Order Placed → Shipped — In Transit → Delivered
```

**The frontend needs no deploy for this.** `buildTimeline()` in `js/track-order-page.js` maps
over `data.timeline[]` and renders `step.label` verbatim — it does not know the step names,
the count, or the order, and a test now pins it against ever learning them. Grep the whole
frontend repo for "Order Confirmed" and you get comments. **Every string below is yours.**

---

## What is live today

Measured, not quoted — `POST /api/orders/track-lookup`, order `2026090301`, 2026-09-06:

```jsonc
{ "status": "shipped", "status_label": "Shipped — In Transit",
  "timeline": [
    { "step": "placed",     "label": "Order Placed",         "completed": true,  "date": "2026-09-03T01:17:50.871965+00:00" },
    { "step": "confirmed",  "label": "Order Confirmed",      "completed": true,  "date": "2026-09-03T01:17:59.195+00:00" },
    { "step": "processing", "label": "Processing",           "completed": true,  "date": null },
    { "step": "shipped",    "label": "Shipped — In Transit", "completed": true,  "date": "2026-09-04T14:39:31.483+00:00" },
    { "step": "delivered",  "label": "Delivered",            "completed": false, "date": null } ] }
```

Both steps being removed are close to empty already, which is the case for removing them:

- **`confirmed` fires nine seconds after `placed`** — it is the `paid` transition, and on a
  card order those two are the same moment to a customer.
- **`processing` has `date: null` on every order**, because there is no `processing_at`
  column. The stepper lights a dot with nothing under it.

Together they cost the stepper 40% of its width. On the public `/track-order` page that was
enough to clip the last label to "Shipped — In Tran…". (The page's own width bug is fixed
frontend-side; this still removes the crowding.)

---

## 1. `POST /api/orders/track-lookup` — `timeline[]`

Three entries on the normal path:

| `step` | `label` | `completed` when | `date` |
|---|---|---|---|
| `placed` | `Order Placed` | always | `orders.created_at` |
| `shipped` | `Shipped — In Transit` | `status ∈ (shipped, delivered, completed)` | `orders.shipped_at` |
| `delivered` | `Delivered` | `status ∈ (delivered, completed)` | `orders.delivered_at ?? orders.completed_at` |

Keep the field shape exactly as it is — `{step, label, completed, date|null}`.

**Cancelled orders keep their own shape**, `[placed, cancelled]`. The frontend branches on
`step === 'cancelled'` to paint it red; that is the one step name it knows, and it is a
rendering rule, not a pathway assumption.

> **Open question — Net-30.** These currently return **four** steps rather than five. Please
> confirm which one they drop and that they now return three. The frontend does not care, but
> `npm run probe:track-timeline` will report the count and we would rather know why than guess.

---

## 2. `status_label`

| `orders.status` | `status_label` |
|---|---|
| `paid` | **`Preparing for dispatch`** ← was `Order Confirmed` |
| `processing` | **`Preparing for dispatch`** ← was `Processing` |
| `shipped` | `Shipped — In Transit` (unchanged) |
| `delivered`, `completed` | `Delivered` |
| `pending`, `cancelled`, `refunded` | unchanged |

**Mapping `processing` to the same string is deliberate, not an oversight.** 160 live orders
carry `paid` or `processing`, and a legacy `processing` row must never surface the word
"Processing" to a customer just because it predates this change. The status stays real and
stays visible to operators; it stops being a word customers read.

The frontend also interpolates the raw `status` into a CSS class
(`order-status-badge--${status}`), so **please don't invent new status values** without
telling us — an unknown one renders as an unstyled pill. We have just added rules for
`delivered` and `refunded`, which were both missing.

---

## 3. State machine — add the `paid → shipped` edge

This is the half of the request that is not cosmetic: *"the shipping is added which should
trigger shipped"*.

**There is no `paid → shipped` edge today.** Derived from all 195 `status_change` rows in
`order_events`:

```
147  pending -> paid           13  processing -> shipped
 14  paid -> processing         6  paid -> cancelled
 13  pending -> cancelled       2  cancelled -> paid

paid -> shipped:  0        all 13 shipped orders went paid -> processing -> shipped
```

**129 of 160 live orders are `paid`.** So `PUT /api/admin/orders/:id/shipping` with
`mark_shipped: true` — the operator's actual one-step path — 400s on the overwhelming
majority of orders with `Invalid transition: 'paid' -> 'shipped'`. The admin currently papers
over this with a `bridgeToShippable()` helper that silently performs `paid → processing`
first, so saving shipping details writes a status change the operator never asked for. That
workaround exists only because the edge does not (frontend ERR-207).

**Please:**

- **Add `paid → shipped`.** `mark_shipped: true` from `paid` should succeed directly and stamp
  `shipped_at`, with no intermediate `processing` row in `order_events`.
- **Keep `paid → processing` and `processing → shipped` legal** — 14 orders have taken that
  route and one may still be sitting in `processing`.
- **Confirm `shipped → delivered` is legal and stamps `delivered_at`.** The admin Update
  Status dropdown now offers **Delivered** (it previously offered only `completed`, so the one
  word the customer reads could not be set by hand at all). Until auto-delivery exists this is
  the manual path, and it will start sending you `status: "delivered"`.

Once we observe `paid → shipped` in `order_events` we delete `bridgeToShippable()` and its
three call sites. **We will not delete it on the strength of this document** — only once the
edge is measured live.

> **Please also enumerate the state machine somewhere we can read it.** The
> `shipping-information` hand-off says only that "an invalid source status is a `400`" and
> its §6 error table has no row for a transition refusal — so the 400 arrives with **no
> `error.code`** and the operator reads raw backend prose about a machine nobody has shown
> them. We currently sniff the message text with a regex and say in the code that this is
> fragile. **An `INVALID_TRANSITION` code would let us delete that regex.**

---

## 4. Not part of this change, but found while measuring it

**A live order shows an NZ Post carrier and a USPS tracking link.** Order `2026090301`:

```
"carrier": "NZ Post", "carrier_code": "nz_post",
"tracking_url": "https://tools.usps.com/tracking/00894210392920028494"
```

The customer is told NZ Post and sent to the United States Postal Service. Most likely a
`tracking_url_override` typed by an operator, in which case it is a data fix rather than a code
one — but it sits next to BF-049 (the block reporting `carrier: "NZ Post"` on orders whose
`orders.carrier` column is `NULL`, 25/25 sampled), so it may not be. Flagged so it is not lost.

---

## How to verify, from the frontend side

```
npm run probe:track-timeline     # read-only: one track-lookup, no writes, no emails
```

It asserts the three-step shape, that no retired step key or label is sent, and that
`status_label` never reads "Order Confirmed" or "Processing" again. It carries the five-step
payload above as a **positive control** that must fail, so it cannot pass by having stopped
checking; and with no order configured it **skips loudly by name** rather than reporting green.

Against production today it reports **6 failures** — correctly, because nothing has changed
yet. It goes green the moment this brief is implemented.

```
npm run probe:shipping-info      # §7 reads the edges the machine has actually performed
```

⚠️ **§7 inverts the day you ship §3.** It currently asserts `paid -> shipped` has occurred
**zero** times, which is the correct assertion right now and the wrong one afterwards. We
flip it on our side once the edge is live — flagged here so a green→red flip is read as the
fix landing, not as a regression.
