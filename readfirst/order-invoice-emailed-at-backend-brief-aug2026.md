# Backend brief — record when an order's invoice email is sent

**Date:** 2026-08-28
**Audience:** backend dev + backend CLI Claude (the `ink-backend-zaeq` service / Supabase)
**Repo affected:** backend API + Supabase only — the frontend is already built
**Status:** OPEN. The frontend ships today reading the field described here; it is
NULL on every row, so almost every order displays "Not recorded".
**Priority:** §1 is the real fix. §0's question comes first.

This document is self-contained. You should not need the frontend repo.

---

## 0. Read this before anything else

`public.invoices.emailed_at` is **NULL on all 126 rows.** So is `pdf_url`.

That is consistent with two very different worlds:

1. The invoice email **is** sent at checkout, and nothing stamps the column. A
   reporting gap — annoying, cheap to fix, everything below applies.
2. The invoice email **is not actually being sent at all.** Customers are not
   receiving invoices, and no amount of frontend work will show a send that never
   happened.

**Please answer which one it is before implementing anything below.** If it is (2),
that is a much bigger problem than the column this brief is about, and it should be
fixed first. The frontend cannot tell the two apart from outside — that is precisely
why it now renders "Not recorded" rather than guessing.

---

## 1. What exists today

| Thing | State |
|---|---|
| `public.invoices` | **1 row per order.** `id, order_id, invoice_number ("INV-2026-0128"), invoice_date, subtotal, gst_amount, shipping_cost, total, customer_name, customer_email, billing_address, pdf_url, emailed_at, created_at`. 126 rows, every one carrying `order_id`. Created within seconds of purchase. |
| `public.invoices.emailed_at` | **Column exists. 0 of 126 rows populated.** Nothing writes it. |
| `POST /api/admin/orders/:id/resend-invoice` | **Live**, and it works. But it returns nothing usable and stamps nothing. |
| `GET /api/admin/orders` and `/api/admin/orders/:id` | **Carry no send field at all** (payload keys dumped live 2026-08-28). |
| `POST /api/admin/orders/:id/events` | **Live.** Validates `type` against **exactly `[note]`** — a POST with `type: "invoice_sent"` returns `400 VALIDATION_FAILED`, `"type" must be [note]`. |
| `public.order_events` | 180 rows, two types in the wild: `status_change`, `note`. |

> ### R1 — `null` is not "not sent"
> `emailed_at: null` means **we have no record**. It does not mean no email went
> out. Never omit the field to signal "no", and never populate it with a guess.

> ### R2 — `public.invoices` is NOT `public.admin_invoices`
> Two separate systems, easily confused, and implementing this on the wrong one
> would be silent:
> - **`public.invoices`** — one per **order**, string invoice numbers
>   (`INV-2026-0128`). What the admin Orders page reads. **This brief is about this table.**
> - **`admin_invoices`** — the standalone Invoicing page, reached via
>   `/api/admin/invoices`, integer invoice numbers (`3274`), with its own
>   `emailed_at` / `email_count` / `status`. Not this.
>
> Those extra columns (`emailed_to`, `email_count`, `last_emailed_at`, `status`) do
> **not** exist on `public.invoices` — selecting one is a hard 400. The frontend
> deliberately selects only `id, order_id, invoice_number, invoice_date, emailed_at`,
> and `npm run probe:invoice-sent` asserts both halves of that on every run.

---

## 2. §1 — Stamp the automatic checkout send  ← the root fix

Whatever handler emails the invoice at purchase should, **after the mail provider
accepts the message**:

```sql
UPDATE public.invoices SET emailed_at = now() WHERE order_id = $1;
```

If the send fails, **leave it NULL.** A stamp is a claim that an email went out.

Everything else in this brief is reporting. This is the fix.

---

## 3. §2 — Stamp the resend too, and return the stamp

`POST /api/admin/orders/:id/resend-invoice` should do the same update, and then say so:

```jsonc
{ "ok": true,
  "data": {
    "emailed_at": "2026-08-28T21:04:11.000Z",  // the stamp just written
    "emailed_to": "customer@example.com",       // optional but useful
    "email_count": 3                            // optional; null = unknown, not 0
  } }
```

The frontend currently **discards this response, because there is nothing in it.**
It will start reading it the day it has content.

---

## 4. §3 — DO NOT BACKFILL

Do not populate the 126 existing rows from `invoice_date`, `created_at` or `paid_at`.

Those timestamps sit within seconds of purchase, so a backfill would look completely
plausible and be entirely unevidenced. **A wrong send date is worse than a blank
one:** it is exactly what would stop the owner resending an invoice a customer never
received. The frontend renders all 126 as "Not recorded" on purpose.

---

## 5. §4 — Put it on the order payload (optional, but it retires code)

If `GET /api/admin/orders` list rows and `GET /api/admin/orders/:id` carried:

- `invoice_emailed_at` — ISO string or null
- `invoice_emailed_to` — string or null
- `invoice_email_count` — int or null (**null = unknown, 0 = known-zero**)
- `invoice_number` — string or null

…then the Orders page could delete two Supabase round-trips per page and its only
direct PostgREST read of `public.invoices`. Purely an optimisation; the feature works
without it.

---

## 6. §5 — Does `order_events.type` have an enum?

Right now it validates to exactly `[note]`. Because of that, the frontend records a
resend as a **note carrying a sentinel**:

```jsonc
{ "type": "note",
  "payload": { "kind": "invoice_sent",
               "at": "2026-08-28T21:04:11.000Z",
               "note": "[invoice-sent] Invoice email sent from the admin Orders page." } }
```

The sentinel is in the note **text** because that is the only payload field every
existing row uses, and so the only one proven to survive the write.

Two asks:
1. If `type` is an enum, please **add `invoice_sent`**. The frontend reads
   `payload.kind` first and will pick a real type up with no change.
2. Confirm whether arbitrary extra payload keys (`kind`, `at`) are preserved or
   stripped. If preserved, the text sentinel becomes belt-and-braces rather than
   load-bearing.

---

## 7. §6 — `order_events.actor_id` is a bare uuid

There is nothing to resolve it against, so the order timeline cannot say **which**
operator resent an invoice. An `actor_email` or `actor_name` on
`GET /api/admin/orders/:id/events` would fix that. Same ask as BF-023 on the
invoices send log — worth doing once, for both.

---

## 8. Acceptance

`npm run probe:invoice-sent` (read-only, in the frontend repo) is the check:

| Check | Today | After §1 |
|---|---|---|
| `N of 126 invoices carry a send stamp` | `0 of 126` — a soft note | climbs with each new order |
| order payload carries a send field | no (expected) | yes, once §4 ships |
| `order_events` types in the wild | `note, status_change` | `+ invoice_sent`, once §5 ships |

The probe is GET-only and has no recording mode. It prints its mode on every run.

**Tracker:** BF-046 (§1 stamp on checkout), BF-047 (§2 resend stamp + response),
BF-048 (§4 fields on order payloads), BF-049 (§5 event-type enum answer).
