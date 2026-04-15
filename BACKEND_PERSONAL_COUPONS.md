# Backend Task: Personal Coupons Endpoint

## Goal
Add a new authenticated endpoint `GET /api/user/coupons` that returns admin-granted personal coupons for the logged-in user. The frontend (already shipped) calls this endpoint from the Loyalty Card page (`/account/loyalty`) and renders the results inside the "My rewards" section alongside loyalty-earned coupons.

Without this endpoint, the frontend fails gracefully (empty list, no error shown) — but personal coupons will never appear to users until it exists.

## Context
- Admin can create coupons via `POST /api/admin/coupons` with an `email_restrictions` array.
- Those coupons are intended to be "personal" — only redeemable by the listed emails.
- Currently, users have no way to see which personal coupons have been granted to them. They only learn the code out-of-band (email/chat).
- Loyalty coupons (issued automatically by the stamp-card system) are already returned by `GET /api/user/loyalty-coupons`. This new endpoint is for **non-loyalty** admin-granted coupons only, so the two lists don't duplicate.

## Endpoint Specification

### Route
```
GET /api/user/coupons
```

### Auth
- Required: Supabase JWT via `Authorization: Bearer <token>` (same middleware as `/api/user/loyalty-coupons` and `/api/user/stamp-card`).
- Return `401` if the token is missing/invalid (let the existing auth middleware handle this).

### Query logic
Return all coupons where ALL of the following are true:
1. `is_active = true` (or whatever the active flag is in the `coupons` table).
2. `deleted_at IS NULL` (soft-delete aware).
3. `expires_at IS NULL` OR `expires_at > NOW()` — not expired.
4. `starts_at IS NULL` OR `starts_at <= NOW()` — already started.
5. `email_restrictions` is a non-empty array AND contains the authenticated user's email (case-insensitive match recommended).
6. **Exclude loyalty-issued coupons.** If the `coupons` table has a `source` / `origin` / `loyalty_reward_id` / `created_via` column, filter those out (e.g. `source != 'loyalty'` or `loyalty_reward_id IS NULL`). If no such column exists, add one or use whatever flag distinguishes auto-loyalty coupons from manually-created admin coupons. The loyalty endpoint (`/api/user/loyalty-coupons`) already handles those — this endpoint must not duplicate them.
7. Exclude coupons the user has already fully redeemed: if `per_user_limit` is set, count this user's uses (via `coupon_usage` / `coupon_redemptions` table — whatever the audit table is) and exclude when `usage_count >= per_user_limit`.

### Response shape

Success (`200`):
```json
{
  "ok": true,
  "data": [
    {
      "code": "WELCOME10",
      "discount_type": "percentage",
      "discount_value": 10,
      "description": "Welcome offer for new customers",
      "minimum_order_amount": 50.00,
      "exclude_genuine": false,
      "expires_at": "2026-06-30T23:59:59Z",
      "per_user_limit": 1,
      "times_used_by_user": 0
    }
  ]
}
```

Use the standard `{ ok: true, data }` envelope (same as `/api/user/loyalty-coupons`). The frontend reads `res.data` directly, so the `ok` flag isn't load-bearing on the happy path.

### Field notes
| Field | Type | Notes |
|---|---|---|
| `code` | string | The redeemable coupon code — shown to user and copied to clipboard. |
| `discount_type` | `"percentage"` \| `"fixed_amount"` | Frontend formats label accordingly. |
| `discount_value` | number | Percent (e.g. `10`) or NZD amount (e.g. `5.00`). |
| `description` | string \| null | Optional — rendered after the discount label if present. |
| `minimum_order_amount` | number \| null | If set, renders "Valid on orders over $X". |
| `exclude_genuine` | boolean | If true, renders "Compatible products only". |
| `expires_at` | ISO 8601 string \| null | If present, renders "Expires {date}". |
| `per_user_limit` | number \| null | If `1`, renders "1 use per customer"; else "N uses per customer". |
| `times_used_by_user` | number | Informational; frontend currently doesn't render it but may in future. |

### Error shape
Failure (`500` or similar): match existing error envelope used by other `/api/user/*` routes.

Empty list: return `{ "ok": true, "data": [] }` with `200`. Do not return `404`.

### Field naming
`per_user_limit` in the response maps from the DB column `usage_limit_per_user`. Alias it in the serializer — the frontend keys off `per_user_limit`.

## Implementation Pointers
- The admin-side coupon CRUD logic is the best reference for the `coupons` table shape — see wherever `POST /api/admin/coupons` / `GET /api/admin/coupons` is implemented.
- The loyalty-coupons handler (`GET /api/user/loyalty-coupons`) is the best reference for:
  - Auth middleware pattern
  - Response envelope
  - How to join against usage/redemption tables
- User email comes from the decoded JWT (usually `req.user.email` or `req.auth.email` depending on the middleware).

## Database Considerations
- If there is no column distinguishing loyalty-auto-issued coupons from admin-created coupons, **add one** (e.g. `source TEXT DEFAULT 'admin'`, set to `'loyalty'` in the loyalty issuance code). Without this, the two endpoints will overlap.
- Ensure an index exists on `email_restrictions` if it's a JSONB/array column and the user table is large (GIN index for Postgres arrays/JSONB).

## Testing Checklist
1. User with no personal coupons → `{ data: [] }`.
2. User with one active personal coupon → returned with all fields populated.
3. Coupon with `expires_at` in the past → excluded.
4. Coupon with `is_active = false` → excluded.
5. Coupon with `email_restrictions` NOT containing the user's email → excluded.
6. Loyalty-issued coupon → excluded (not duplicated with `/api/user/loyalty-coupons`).
7. Coupon with `per_user_limit = 1` that the user has already redeemed → excluded.
8. Unauthenticated request → `401`.
9. Case sensitivity: `email_restrictions = ["User@Example.com"]` and JWT email `user@example.com` → matches.

## Frontend Contract (already live)
Frontend file: `inkcartridges/js/api.js`
```js
async getPersonalCoupons() {
  return this.get('/api/user/coupons');
}
```

Frontend file: `inkcartridges/js/loyalty-page.js` calls it via `Promise.allSettled` alongside `getStampCard()` and `getLoyaltyCoupons()`. If this endpoint returns a non-2xx, the page still renders loyalty coupons without breaking — but users will not see personal coupons.

Each returned coupon is rendered as a card with a blue "Personal" badge inside the "My rewards" section on the loyalty page, with the Copy-code button and conditions list reused from the loyalty reward component.
