# FE hand-off — One-click Business upgrade (in-person sales)

**Date:** 2026-08-09 · **Backend:** live on `main` (`968db00`+) · **Audience:** admin FE

## What this is

The sales team visits a business in person and upgrades that customer's existing
account to a Business account on the spot — no self-submitted application. The
backend endpoint exists and is live; this doc is the contract for wiring an
admin-UI button/modal to it.

Suggested UI: on the admin customer detail (or a customer search picker), an
**"Upgrade to Business"** button opening a small modal:

- Company name (required)
- Credit limit $ (required — enter `0` unless Net 30 credit is being granted)
- Net 30 approved (toggle, default off)
- NZBN, contact/AP email, billing/shipping address (all optional)

## Endpoint

`POST /api/admin/business/accounts`

- Auth: standard admin JWT — **super_admin role required**.
- Rate limit: 30/min (shared admin limiter).

### Request body

```json
{
  "user_id": "<auth.users.id UUID>",         // required
  "company_name": "Acme Print Co",           // required, ≤255
  "credit_limit": 0,                          // required, 0–1,000,000 (NZD, Net 30 exposure)
  "net30_approved": false,                    // optional, default false
  "nzbn": "9429012345678",                   // optional, 13 digits
  "contact_name": "Jo Smith",                // optional (defaults to profile name)
  "contact_email": "jo@acme.co",             // optional (defaults to the user's auth email)
  "ap_email": "accounts@acme.co",            // optional (defaults to contact email)
  "billing_address": { "address1": "…", "address2": null, "city": "…", "region": null, "postcode": "…" },  // optional
  "shipping_address": { "address1": "…", "city": "…", "postcode": "…" }                                    // optional
}
```

### Responses

| Status | Body (`{ok:false → error.message}`) | Meaning / UI copy |
|---|---|---|
| 201 | `{ok:true, data:{id, application_id}}` | Upgraded. `id` = business account id. |
| 404 | `User not found` | The `user_id` has no profile — re-pick the customer. |
| 409 | `User already has a business account` | Already upgraded (possibly suspended/closed — manage via PATCH below). |
| 400 | `contact_email is required (…)` | Could not resolve any email — ask for one in the modal. |
| 400 | Joi message | Field validation (bad NZBN, credit_limit out of range, …). |

### Side effects (all backend, nothing for the FE to do)

- `business_accounts` row created **active**; audit application auto-minted
  (status `approved`, note "Manually created by sales team").
- Any of the user's other **pending** applications are auto-closed as
  `rejected` w/ a "Superseded" note (queue hygiene — no decline email sent).
- `user_profiles` business mirror updated; B2B welcome email sent to the
  contact/AP email.
- Customer immediately gets: `/api/business/status` → `approved`, Business
  Centre access, promo-coupon exclusion, Net 30 at checkout (only if
  `net30_approved` and within credit).

## Managing the account afterwards

`PATCH /api/admin/business/accounts/:id` (super_admin) — body: any of
`credit_limit` (0–1,000,000), `net30_approved` (bool),
`status` (`active` | `suspended` | `closed`). Returns the updated account.
Suspending/closing takes effect immediately (portal/Net 30 reject; customer's
`/api/business/status` reports `suspended`/`closed`, `can_apply:false`).

## Notes

- `credit_limit` is Net 30 exposure only — volume pricing does NOT depend on
  it. `0` is the right default for a cash/card business.
- There is deliberately NO bulk variant and no non-super_admin path.
- The applications review queue (`/admin/business/applications*`) is unchanged;
  in-person upgrades bypass it by design but leave the audit application behind.
