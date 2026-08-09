# One-click Business upgrade — frontend response (Aug 2026)

**From:** frontend · **Date:** 2026-08-09 · **Re:** `readfirst/business-one-click-upgrade-FE-handoff-aug2026.md`
**Tracking:** ERR-151 … ERR-155 (FE) · **BF-021 (backend, still open — now blocking a second feature)**
**Status: the upgrade flow is built, tested and verified live. `PATCH` is unreachable from a browser and needs a one-line fix from you.**

Thank you — the contract was accurate on every field, the Joi messages are genuinely usable as UI copy,
and the auto-minted approved application turned out to be the only way the frontend can tell who is a
business account at all. That mattered more than you probably intended; see ask 2.

Everything below was measured against production with an admin JWT before a line was written. **No
business account was created** — every path except the 201 is side-effect free, and the 201 is covered
by fixtures and tests rather than by upgrading a real customer and emailing them.

```
Shipped
  Customers ▸ drawer ▸ "Business account"   4 honest states + Upgrade to Business
  Admin ▸ Business (new page, owner-only)   applications queue (read-only) · customer picker
                                            · accounts created on this device
  js/admin/utils/business-accounts.js       payload/validation/error/registry vocabulary
  js/admin/components/business-upgrade.js   one modal, both doors
  tests/admin-business-upgrade-aug2026.test.js   67 tests · full suite 3745 / 3726 pass / 0 fail

Verified live, in the browser, against production
  POST …/business/accounts  409  → "This customer already has a business account…"  ✓ modal stays open
  PATCH …/accounts/:id           → BLOCKED BY CORS PREFLIGHT — never sent            ✗ see ask 1
  applications queue        200  → renders, status filter works, 1 row on file       ✓
  blank / bad NZBN / credit 2,000,000 → caught client-side, ZERO requests            ✓
```

---

## Ask 1 — 🚨 add `PATCH` to `Access-Control-Allow-Methods` (this is BF-021, still open)

`PATCH /api/admin/business/accounts/:id` **cannot be called from a browser.** The preflight answers:

```
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS      ← no PATCH
```

so Chrome kills the request before dispatch. curl works, which is why the route tested clean — curl
does no preflight. There is no way around it from our side:

| Attempt | Result |
|---|---|
| `PUT …/business/accounts/:id` | 404 |
| `POST …/business/accounts/:id` | 404 |
| `DELETE …/business/accounts/:id` | 404 |
| `X-HTTP-Method-Override` | not in `Access-Control-Allow-Headers` |

The invoices PATCH hit this same wall on 2026-07-25 and survived only because
`PUT /api/admin/invoices/:id` exists to fall back to. Here PATCH is the only verb the route answers,
and it is the one verb the browser may not use — so **credit limit, Net 30 and suspend/close are
currently server-side-only operations.**

The frontend already attempts PATCH first and directly, so **this starts working the day the header
changes, with no frontend deploy.** Until then the failure is labelled honestly on screen ("the request
was never sent … nothing was changed") rather than as a generic network error, because "Failed to
fetch" reads like a timeout and a timeout is the one reading under which the write might have landed.

---

## Ask 2 — please ship `GET /api/admin/business/accounts`, or return `id` in the 409

`business_accounts.id` is unobtainable. We checked everywhere it could plausibly be:

| Source | Carries an account id? |
|---|---|
| `GET /api/admin/business/accounts` | **404** |
| `GET /api/admin/business-accounts` | **404** |
| 409 body on a duplicate POST | no — `{code:"CONFLICT", message:"User already has a business account"}` |
| `GET /api/admin/business-applications` | no — `business_applications.id` only |
| `GET /api/business/status` | no — status / credit / net30 only |

So **the 201 response is the only moment this id ever exists for us.** Two consequences:

1. Every account created before today — including the one live approved account — can never be
   managed from the admin UI, whatever happens to ask 1. There is no id to PATCH.
2. We had to write the id down at creation time or lose it. `BusinessAccountRegistry` stores it in
   `localStorage`, and every surface that shows it says "recorded on this device" and states why. The
   Business page's third section is headed *"Accounts created on this device"* and opens with **"This
   is not the list of business accounts"**, because it isn't one and we won't imply otherwise.

Either fix closes this: a list endpoint (ideal — it also revives the invoice → Business Centre link,
dead since 2026-08-03 for exactly this reason), or `data: { id }` on the 409, which would at least let
an operator recover the id by attempting the upgrade again.

---

## Ask 3 — `user_id` and `search` on the applications list are accepted and ignored

This is the one that nearly shipped a real bug.

```
GET /api/admin/business-applications?user_id=00000000-0000-0000-0000-000000000000   → the FULL table
GET /api/admin/business-applications?search=zzzznotreal                             → the FULL table
GET /api/admin/business-applications?status=bogus                                   → 400 (correct!)
```

`status` is properly validated; the identity parameters are silently dropped. The natural pre-flight —
"fetch this customer's applications" — would have returned row 1 of the whole table for *every*
customer, and the drawer would have reported a stranger's real company name as theirs and marked them
already upgraded. Nothing in the 200 distinguishes "filtered" from "everything".

We now match on `user_id` in the frontend over an unfiltered read, and a test forbids either parameter
from ever appearing in the URL. **Please either implement them or 400 them** — an ignored filter is
worse than an absent one, because absent fails visibly.

Related, and the reason we page: `limit` is capped at **100 with a 400, not a clamp**. We walk pages
until `pagination.total` is covered, because "does this customer have an application" can only be
answered *no* by a complete read.

---

## Ask 4 — two documentation gaps worth a line each

**Addresses are all-or-nothing.** The handoff lists `billing_address` / `shipping_address` as optional,
which reads as "every field inside is optional too". Measured:

```
{"billing_address": {"address1": "1 Test St"}}
→ 400  billing_address.city is required, billing_address.postcode is required
```

Send the object at all and `address1` + `city` + `postcode` all become required; `address2` and
`region` stay optional; omitting the object entirely and sending `null` are both fine. We drop a
part-filled address rather than sending it, and tell the operator on screen that we did — silently
dropping typed input would look saved.

**Empty strings are accepted but are not the documented default path.** `nzbn: ""`, `contact_email: ""`
and friends pass validation, but your fallbacks ("defaults to the user's auth email") are specified for
an *absent* field, and `contact_email: ""` is the one shape that could plausibly earn the documented
`400 contact_email is required`. We omit empty optionals entirely rather than blanking them. Worth one
line in the doc either way.

---

## What we built, for your reference

| File | Role |
|---|---|
| `js/admin/utils/business-accounts.js` | payload builder, validation mirror, error copy, `matchApplications`, `BusinessAccountRegistry` — pure, no DOM |
| `js/admin/components/business-upgrade.js` | the panel, the upgrade modal and the manage modal, shared by both entry points |
| `js/admin/pages/business.js` | new owner-only page |
| `js/admin/pages/customers.js` | the drawer block |
| `js/admin/api.js` | `createBusinessAccount`, `updateBusinessAccount`, `listBusinessApplications` |

Notes on our side, not asks:

- The applications queue is **read-only** — no approve/decline endpoint is published, and a button
  that 404s is worse than no button. Say the word and we'll build the review UI.
- Everything is gated on `AdminAuth.isOwner()`, which is your `super_admin` after normalisation, so a
  plain admin never sees a control that would 403.
- We record and display `application_id` from the 201 but do nothing with it yet.
- The 201 id is written to the registry **before** the modal closes or any callback runs, since
  anything that throws in between would lose it permanently. If the write fails we put the id on
  screen and tell the operator to copy it.
