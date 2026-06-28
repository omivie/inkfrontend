# Admin: Customer Loyalty Points — Endpoints to Implement (frontend handoff, Jun 2026)

**Reporter:** storefront frontend (FEINK).
**Backend repo:** `ink-backend-zaeq` (`ink-backend-zaeq.onrender.com`).
**Context:** The admin centre now has a **per-customer loyalty panel** in the Customers detail drawer
(`inkcartridges/js/admin/pages/customers.js`) — it shows a customer's points balance + recent ledger and
lets an **owner** adjust the balance. The frontend is built and wired but the two endpoints below **do not
exist yet** (they 404). The frontend already degrades gracefully on 404 (shows "Loyalty data unavailable"),
so shipping these endpoints lights it up with no further frontend change. The admin AdminAPI wrappers are
`getCustomerLoyalty` / `adjustCustomerPoints` in `inkcartridges/js/admin/api.js`.

This reuses the existing customer-facing loyalty system (migration 090, `/api/user/loyalty`,
ledger types `earn|bonus|redeem|clawback|restore|adjust`, `redemption_rate` 100 = $1). The only new thing
is **admin-on-behalf-of** read + a manual **adjust** that writes one ledger row and recomputes the balance.

Envelope is the standard `{ ok, data, error: { code, message } }`. Both endpoints require a valid admin
session; the **adjust** action additionally requires **owner** (same gate as pricing commit / owner-only pages).

---

## 1. Read a customer's loyalty state

```
GET /api/admin/customers/:id/loyalty            (admin)
```

`:id` is the customer/user id (same id used by `GET /api/admin/customers` rows and
`GET /api/admin/orders?user_id=:id`).

**200 response** — mirror the `/api/user/loyalty` fields, but for the *target* customer:

```json
{
  "ok": true,
  "data": {
    "loyalty": {
      "points_balance": 1250,
      "lifetime_earned": 4300,
      "redemption_rate": 100,
      "min_redemption_points": 500,
      "program_active": true,
      "ledger": [
        {
          "type": "earn",
          "points": 88,
          "reason": "Order ORD-ABC123",
          "order_number": "ORD-ABC123",
          "created_at": "2026-06-26T03:00:29.911Z"
        }
      ]
    }
  }
}
```

Notes:
- The frontend reads `data.loyalty` (falls back to `data`). Either wrap in `loyalty` or return the object at
  `data` — both work, but `data.loyalty` is preferred for parity with single-resource endpoints.
- `ledger` should be the customer's most-recent entries (the UI shows the latest 5). A small page (e.g. 20)
  is fine; full pagination is **not** required for v1.
- `points` in each ledger row is **signed** (positive credit, negative debit). `reason` is free text;
  `order_number` optional (present for purchase-derived rows).
- Errors: `404 NOT_FOUND` (no such customer), `403 FORBIDDEN` (not admin), `401 UNAUTHORIZED`.

---

## 2. Adjust a customer's points (manual credit/debit)

```
POST /api/admin/customers/:id/loyalty/adjust    (owner)
```

**Request body:**

```json
{ "points": -200, "reason": "Goodwill reversal — duplicate credit", "type": "adjust" }
```

- `points` — **signed integer**, non-zero. Positive = credit, negative = debit. (The UI collects a positive
  number + an Add/Remove direction and sends the signed value.)
- `reason` — required, non-empty string (store it on the ledger row; it's shown in the admin ledger).
- `type` — `"adjust"` for manual admin changes. Accept `"bonus"`/`"restore"` too if you want to distinguish,
  but the UI sends `"adjust"`.

**Behaviour (server-side, must be atomic):**
1. Validate: `points` is a non-zero integer; `reason` non-empty; for a debit, `|points|` must not exceed the
   current balance (the FE pre-checks this too, but the server is the source of truth).
2. Insert one ledger row of the given `type` with the signed `points` and `reason`, stamped to the acting
   admin (record `admin_id`/`actor` for audit if your schema supports it).
3. **Recompute** `points_balance` (and `lifetime_earned` if a positive adjust should count toward lifetime —
   your call; the UI just displays whatever you return).

**200 response** — return the **updated** loyalty object, same shape as endpoint 1's `data.loyalty`, so the
drawer can repaint from it:

```json
{ "ok": true, "data": { "loyalty": { "points_balance": 1050, "lifetime_earned": 4300, "redemption_rate": 100, "ledger": [ /* incl. the new row first */ ] } } }
```

**Errors:**
- `400 VALIDATION_FAILED` — non-integer/zero points, or missing/empty reason.
- `409 INSUFFICIENT_BALANCE` — debit exceeds current balance. (The FE surfaces `error.message` to the owner.)
- `404 NOT_FOUND` — no such customer.
- `403 FORBIDDEN` — caller is admin but not owner.

---

## Frontend contract reference (do not change these without telling FE)

- AdminAPI: `getCustomerLoyalty(id)` → GET above (fail-soft, returns `null` on error).
  `adjustCustomerPoints(id, { points, reason, type })` → POST above (throws on `ok:false`, surfaces `error.message`).
- The drawer reads: `points_balance`, `redemption_rate`, `lifetime_earned`, `ledger[].{type,points,reason,created_at,order_number}`.
- Money is derived FE-side as `points_balance / redemption_rate` — keep `redemption_rate` accurate.
