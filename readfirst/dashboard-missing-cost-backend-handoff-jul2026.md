# Backend handoff — cost-completeness flag on `GET /api/admin/orders`

**Date:** 2026-07-27
**Requested by:** frontend (InkCartridges.co.nz admin dashboard)
**Repo affected:** backend API (`https://ink-backend-zaeq.onrender.com`) — separate repo from the frontend
**Status:** proposal, not yet implemented
**Priority:** medium — the frontend has already shipped a workaround, this removes the cause

This document is self-contained. You should not need the frontend repo to implement it.

---

## 1. Problem

The admin dashboard has an "Action needed" panel with a card titled **"Sales missing a cost"**.
It lists orders whose line items have no `supplier_cost_snapshot`, because those are exactly the
orders that stop the backend from computing gross profit for any date range containing them.

The list endpoint `GET /api/admin/orders` **does not expose `supplier_cost_snapshot`** — that
field is only visible on the single-order detail endpoint `GET /api/admin/orders/{id}`.

So to populate one card, the frontend currently:

1. pages through `GET /api/admin/orders` (up to 3 pages × 100), then
2. issues **one `GET /api/admin/orders/{id}` per order**, up to 120 of them, on **every
   dashboard load**.

That is up to ~123 requests per dashboard open, against a 60 req/min limiter, purely to derive
a boolean per order. Until 2026-07-27 it was also on the critical render path, which is why
the whole dashboard took seconds to paint.

## 2. The ask

Add a per-order cost-completeness signal to the **list** response so the detail fan-out can be
deleted outright.

This is a **purely additive** change to an existing response. No existing field changes shape,
and no query parameter is added or removed.

## 3. Proposed contract

Add three fields to each order object in `GET /api/admin/orders` → `data.orders[]`:

| Field | Type | Meaning |
|---|---|---|
| `cost_complete` | `boolean \| null` | `true` = every line item has a non-null `supplier_cost_snapshot`. `false` = at least one does not, **or** the order has zero line items and a non-zero total. `null` = **not determined** (see §4). |
| `items_missing_cost` | `integer` | Count of line items on this order with a null `supplier_cost_snapshot`. `0` when `cost_complete === true`. Omit or send `null` when `cost_complete` is `null`. |
| `missing_cost_skus` | `string[]` | SKUs of those line items, capped at the first **2** — that is all the UI renders. `[]` when none. |

### Distinguishing "zero line items"

The frontend currently reports two different reasons on the card, and needs to keep both:

- `no cost: SKU-A, SKU-B` — the order has items, some lack a cost.
- `no items recorded` — the order has a **total > 0 but zero line items**. Historically caused
  by an invoice whose `product_code` didn't resolve.

So an order with no line items and a non-zero total must be reportable. Represent it as:

```json
{ "cost_complete": false, "items_missing_cost": 0, "missing_cost_skus": [] }
```

`cost_complete: false` with `items_missing_cost: 0` unambiguously means "nothing to cost" —
the frontend maps that to `no items recorded`.

### Response example

```
GET /api/admin/orders?page=1&limit=100&date_from=2026-01-01&date_to=2026-07-27
```

```json
{
  "ok": true,
  "data": {
    "orders": [
      {
        "id": "8f3c…",
        "order_number": "INV-1042",
        "status": "invoiced",
        "total_amount": 289.50,
        "cost_complete": false,
        "items_missing_cost": 2,
        "missing_cost_skus": ["G-HP-963XL-INK", "G-HP-963-INK"]
      },
      {
        "id": "a91b…",
        "order_number": "ORD-2213",
        "status": "shipped",
        "total_amount": 74.90,
        "cost_complete": true,
        "items_missing_cost": 0,
        "missing_cost_skus": []
      },
      {
        "id": "c40d…",
        "order_number": "INV-1039",
        "status": "invoiced",
        "total_amount": 130.00,
        "cost_complete": false,
        "items_missing_cost": 0,
        "missing_cost_skus": []
      }
    ],
    "pagination": { "page": 1, "limit": 100, "total": 217, "total_pages": 3 }
  }
}
```

(The third row is the "no items recorded" case.)

## 4. `null` is not `0` — please do not default this field

**This is the most important requirement in the document.**

If the flag cannot be computed for an order — the join failed, the field was added before a
backfill ran, the query timed out and you degraded — send **`cost_complete: null`**. Do **not**
send `false`, and do **not** send `true`.

Reason: this codebase has an explicit, repeatedly-burned rule that an unknown value must never
be rendered as a known one. A `cost_complete: true` that actually means "we didn't check"
causes the dashboard to print *"all sales are costed"* while profit is silently missing, and
the owner then hunts for a problem that the dashboard has told them does not exist. That exact
bug has already shipped once (logged internally as ERR-074) and the whole card was rewritten
around not repeating it. `items_missing_cost: 0` has the same hazard — absence-as-zero.

The frontend treats `null` as "unknown" and renders an explicit unknown state. That is a
supported, tested outcome. A wrong `true`/`false` is not recoverable on our side.

## 5. What the frontend derives today

This is the current client-side logic, and is the authoritative spec of the behaviour the flag
must reproduce. It lives in `js/admin/pages/dashboard.js` (`computeMissingCostAlert`).

```js
// Cancelled orders carry no revenue and the backend excludes them from COGS,
// so they are excluded from this scan too.
const revenueOrders = list.filter(o => String(o.status || '').toLowerCase() !== 'cancelled');

for (const order of revenueOrders) {
  const detail = await AdminAPI.getOrder(order.id);          // ← the call we want to delete
  const items = detail.items || detail.order_items || [];

  // (1) has a total but zero line items → nothing to attach a cost to
  if (!items.length && totalOf(order) > 0) {
    culprits.push({ order, reason: 'no items recorded' });
    continue;
  }

  // (2) has items, one or more with no supplier_cost_snapshot
  const un = items.filter(it => it.supplier_cost_snapshot == null);
  if (un.length) {
    const skus = un.map(it => it.sku || it.product_sku).filter(Boolean).slice(0, 2).join(', ');
    culprits.push({ order, reason: skus ? `no cost: ${skus}` : 'no cost recorded' });
  }
}
```

Notes:

- **`cancelled` orders are excluded.** If you compute the flag server-side, either exclude them
  the same way or leave the flag populated and let the frontend keep filtering — either is fine,
  but say which you chose.
- **Every other status is in scope** — `paid`, `processing`, `shipped`, `completed`,
  `invoiced`. An earlier version of this scan only looked at `paid|processing` and was
  structurally blind to 10 of 59 live orders. Do not narrow it.
- The SKU field is read as `it.sku || it.product_sku`. Send whichever your line items carry;
  the frontend accepts either name in `missing_cost_skus[]` (it's a flat string array).

The card also routes each row to a different admin page depending on order type, using this
predicate — no backend change needed, listed only so the flag's semantics are unambiguous for
invoiced sales:

```js
const isInvoiceOrder = (o) => {
  if (o.channel)        return String(o.channel).toLowerCase() === 'invoice';
  if (o.payment_method) return String(o.payment_method).toLowerCase() === 'invoice';
  return /^INV-/i.test(String(o.order_number || ''));
};
// invoice → fix in the invoice editor ("Our Cost"); website order → fix on the product
```

## 6. Conventions this must follow

- **Envelope:** the standard `{ ok, data }` shape. Orders live at `data.orders[]`; pagination
  metadata at `data.pagination`.
- **Existing query params are unchanged:** `page`, `limit`, `date_from`, `date_to`, `status`
  (comma-separated), `user_id`, `search` / `customer_email`, `sort`.
- **Pagination:** the frontend now reads `data.pagination.total_pages` (falling back to
  `Math.ceil(total / limit)`) to fetch remaining pages in parallel. If `total_pages` is not
  currently emitted, adding it is a small, welcome bonus — but `total` alone is sufficient.
- **Rate limit:** 60 req/min. The whole point of this change is to drop ~120 requests per
  dashboard load, so please do not implement the flag as an N+1 inside the list handler —
  it should be a single aggregate join, e.g. a `LEFT JOIN LATERAL` / grouped subquery over
  `order_items` counting rows where `supplier_cost_snapshot IS NULL`.
- **Performance:** the list endpoint is called with `limit=100` on the dashboard's hot path.
  The added aggregate must not measurably slow it; if it does, an index on
  `order_items(order_id) WHERE supplier_cost_snapshot IS NULL` is the obvious lever.

## 7. Acceptance criteria

1. `GET /api/admin/orders` returns `cost_complete`, `items_missing_cost` and
   `missing_cost_skus` on every order object.
2. An order whose line items all carry a `supplier_cost_snapshot` → `cost_complete: true`,
   `items_missing_cost: 0`, `missing_cost_skus: []`.
3. An order with ≥1 line item missing a snapshot → `cost_complete: false`,
   `items_missing_cost` = the exact count, `missing_cost_skus` = up to 2 SKUs.
4. An order with `total_amount > 0` and **zero** line items → `cost_complete: false`,
   `items_missing_cost: 0`, `missing_cost_skus: []`.
5. If the value cannot be determined → `cost_complete: null`. Never a defaulted `true`/`false`,
   never a defaulted `0`.
6. Response time for `limit=100` is not materially worse than before the change.
7. No existing field is renamed, removed or changed in type.

### Verify with

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  "https://ink-backend-zaeq.onrender.com/api/admin/orders?page=1&limit=100&date_from=2026-01-01&date_to=2026-07-27" \
| jq '.data.orders[] | select(.cost_complete != true)
      | {order_number, status, total_amount, cost_complete, items_missing_cost, missing_cost_skus}'
```

Cross-check a couple of the returned ids against the detail endpoint — the two must agree:

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  "https://ink-backend-zaeq.onrender.com/api/admin/orders/<id>" \
| jq '[.data.order.items[] | select(.supplier_cost_snapshot == null) | .sku]'
```

## 8. Rollout

The frontend does **not** need a coordinated deploy.

1. **Backend ships the fields.** Nothing breaks — the frontend ignores unknown fields today.
2. **Frontend follow-up (separate PR):** read `cost_complete` straight off the list response
   and delete the detail fan-out in `computeMissingCostAlert`. The fan-out stays in place as a
   fallback until the field is actually observed in a live response, so there is no window
   where the card goes blank.
3. Once the fan-out is gone, `MISSING_COST_DETAIL_CAP` / `MISSING_COST_BATCH` and the
   `AdminAPI.getOrder` signal plumbing added for it can be retired.

Please reply with which of the two `cancelled`-handling options you implemented (§5) so the
frontend follow-up matches.
