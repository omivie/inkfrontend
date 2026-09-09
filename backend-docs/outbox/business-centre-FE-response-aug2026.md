# Frontend response — Business Centre (`/business`)

**Date:** 2026-08-03
**Re:** `business-centre-backend-response-aug2026.md` (your note of the same day)
**Status:** all six endpoints verified live against production. Frontend shipped.
**One thing is blocked on you** — §1 below. Everything else is done.

Thanks — the six endpoints are up and every shape matches what you documented. I ran a real
approved-business token against all of them and wired the frontend to what came back. `npm run
verify:business` (new, `scripts/verify-business-centre.mjs`) re-runs that whole contract check on
demand; it passes 34/34 today.

Two things need your attention: a **hard blocker** (§1) and a **data-integrity bug** I hit while
testing it (§2). The rest is confirmation and FYI.

---

## 1. BLOCKER — nothing can set `business_account_id`, so no invoice can ever reach a portal

Your §A2 says invoices stay empty "until an operator opens the admin invoice editor and sets the
contact-picker link". I built that picker. It cannot work, and the reason is on your side.

`business_accounts.id` is **not exposed by any endpoint**. Verified against production:

| Attempt | Result |
|---|---|
| `POST /api/admin/invoices` with `business_account_id` = `business_applications.id` | `500` — `violates foreign key constraint "standalone_invoices_business_account_id_fkey"` |
| …with `business_account_id` = `user_id` | `500` — same FK violation |
| `GET /api/admin/business-accounts` | `404` |
| `GET /api/admin/business/accounts` | `404` |
| `GET /api/admin/business-applications` (list **and** `/:id`) | `200` — returns `id`, `user_id`, `company_name`, `contact_email`; **no account id** |
| `GET /api/business/status`, `GET /api/business/account/summary` | `200` — **no account id** |

`business_accounts` is a different table from `business_applications`, and its primary key is
reachable from nowhere. So the FK can never be satisfied by any client, and the invoices half of
the Business Centre is unreachable — not merely un-linked.

**The ask (small):** expose approved business accounts with their real `business_accounts.id`.
Either shape works:

```jsonc
// preferred — a list endpoint
GET /api/admin/business-accounts?limit=200
{ "ok": true, "data": { "accounts": [
    { "id": "<business_accounts.id>", "company_name": "Acme Ltd",
      "contact_email": "ap@acme.co.nz", "user_id": "…", "status": "approved" } ] } }
```

…or simply add `business_account_id` to the existing `/api/admin/business-applications` rows.

The frontend is already written against the first shape and **fails soft and loud** until it
lands: the editor's Business-account block says *"Linking is unavailable: the backend has no
endpoint that exposes business-account ids yet"* rather than offering a picker that would write a
value the database refuses. It lights up the moment you ship, with no further frontend work.

## 2. BUG — `POST /api/admin/invoices` is not atomic

A payload whose `business_account_id` fails the FK returns `500 INTERNAL_ERROR` **after inserting
the invoice row**. Two of my test calls created orphaned invoices (`3269`, `3270`) that reported
failure; I deleted both by hand, so the series is intact and there is no gap. Worth wrapping the
insert and the FK-bearing update in one transaction — a create that says "failed" and leaves a
numbered tax document behind is worse than either outcome alone.

## 3. FYI — your §A1 is right about the wire, but don't let anyone "fix" the frontend to match

`.error.code` is exactly where the code lives on the wire; your correction to the acceptance test
is correct. But `js/api.js:329-331` already normalises it before any caller sees it —
`errorCode = data.error.code ?? data.code` — and hands callers a **flat**
`{ok:false, error:<message string>, code:<CODE>}`. On the failure path `res.error` is a *string*,
so `res.error.code` reads `.code` off a string, gets `undefined`, and sends every error down the
wrong branch silently. The frontend keys off `.code` and is correct as-is. There's now a test
pinning it, because your note reads like an instruction to change it.

## 4. Confirmations

- **§A2 — empty invoices render as an empty state, not an error.** Already did. The copy now adds a
  recovery line ("if you've been invoiced recently and don't see it here, let us know"), because
  once §1 lands, "No invoices yet" will still be a false statement for anyone whose invoices
  haven't been linked.
- **§A3 — no `show_due_date` anywhere in the customer frontend.** `due_date` is handled defensively
  for `null` and that's all.
- **§A4 — `invoice_number` branded.** Our PDF filename was already `Invoice-${number}.pdf`, so it
  produces `Invoice-INV-3264.pdf` and matches your `Content-Disposition` exactly.
- **§A4 — `paid_at` always null.** Nothing reads it. Paid-ness comes from `status` +
  `amount_outstanding`, and part-paid invoices now show what's still owing.
- **§A4 — `po_number`.** Now editable in the admin editor, sent on create/update, shown on the
  invoice row and detail panel, and printed on the locally-generated copy.
- **§A4 — drafts never returned.** The status filter offers `unpaid / overdue / paid / void` and
  deliberately has no Draft option.
- **§1 — waived shipping omitted from `other_savings`.** This one made our existing copy false: the
  legend read "Coupons, loyalty **& shipping**". Now "Coupons & loyalty". Thanks for flagging it —
  it would have been invisible from your side.
- **§1 — `coverage`.** Both fields are used: `orders_missing_discount_breakdown > 0` shows the
  caveat, and `orders_counted === 0` is what distinguishes "no orders yet" (empty state) from
  "ordered but saved nothing" (a real flat line). Before that, a new account was shown twelve
  buckets of real `0`s plotted as a flat line — which looks like data.
- **§2 — no price on top-products.** Agreed and relied upon. Reorder tiles read today's price from
  `/api/business/pricing` via the existing ladder interpreter.
- **§3 — server-side filtering + pagination.** All five status values verified accepted. The list is
  now paged at 20 with "Showing 20 of N" and Load more; it previously asked for 50 and truncated
  silently.
- **§4 — `unit_price_excl_gst`.** Thank you for the rename. The detail panel is live and renders
  line items under that name; `unit_cost_excl_gst` appears nowhere on a customer surface.
- **§4 — 403 vs 404.** Verified: a cross-account invoice returns `403 FORBIDDEN`, and the page says
  "That invoice isn't on your account."
- **§5 — 409 `NO_STORED_PDF`.** The fallback stays narrow (409/404 only). One change on our side:
  when we *do* generate a local copy, the page now says so out loud instead of only stamping the
  file — previously the customer received a reproduction with the UI silent about it.
- **§6 — outstanding balance is read, never summed.** Unchanged. `credit_remaining: null` is handled
  as "not reported", distinct from `0`.

## 5. Re: your §D — the admin invoice list

Confirmed from this side: `GET /api/admin/invoices` rows are
`id, invoice_number, issue_date, customer_name, total_incl_gst, status, profit_excl_gst,
cost_excl_gst, emailed_at, email_count` — no `business_account_id`, so a "Portal" column isn't
buildable yet.

I'd rank it **below §1** but worth doing at the same time, since it's the same join: adding
`business_account_id` (and ideally `business_account_name`) to the list rows would let us show a
Portal column and an "unlinked" filter. In the meantime the **editor** now states the link
explicitly — "Linked to Acme Ltd" or "Not linked — this invoice will not appear on any customer's
Business Centre" — so at least a per-invoice diagnosis is possible.

---

**Frontend changes:** `js/business-page.js`, `js/business-invoice-pdf.js`, `html/business.html`,
`css/pages.css`, `js/admin/pages/invoices.js`, `js/admin/api.js`, `css/admin.css`.
**Tests:** `tests/business-centre-aug2026.test.js` §7 (11 new),
`tests/admin-invoice-business-link-aug2026.test.js` (12 new), `npm run verify:business` (34 live
checks). Full suite green.
**Postmortems:** ERR-141 (the six defects), ERR-142 (the link blocker) in `errors.md`.
