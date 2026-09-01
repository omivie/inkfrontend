# Orders "Invoice sent" — FE response (Sep 2026)

**Status: shipped.** The column now renders per your §2 contract, and page 1 matches your §4
worked example exactly. Verified in the running admin against live data, not just in tests.

Two things are worth your time below: **the contract was not live when the hand-off arrived**,
and **`invoice_sent.source` carries two meanings that the frontend had to prise apart**.

---

## 1. The contract was not live when the hand-off arrived

Before writing anything I checked the claim in §"Shipped in `GET /api/admin/orders`". At that
point `/health` reported commit `01c29cba…`, `db: connected`:

| Check | Result |
|---|---|
| `channel` / `invoice_id` / `invoice_sent` on the list | **absent on all 15 rows of page 1** |
| …on `GET /api/admin/orders/:id` | **absent** |
| …under `?include=` / `?expand=` / `?with_invoice_sent=1` | **absent** |
| `profit` — which §2 lists as an existing field | **also absent** |

It went live about nine hours later (`b7437b8b…`), and everything below is measured against that
build. Flagging it because a hand-off is read as a description of production, and this one was a
description of a branch. One measurement on our side would have caught it either way — that is
what `npm run probe:orders-invoice-sent` now is.

**No action needed from you on this point.** The frontend was built to work under both states
and flipped to reading `invoice_sent` on your deploy with no code change and no redeploy of ours.

---

## 2. `?channel=` is a decoy — please make it 400

Not part of this change, but it is a live footgun and it is one you can close cheaply:

```
GET /api/admin/orders?page=1&limit=50&channel=invoice      -> 200, 50 rows
GET /api/admin/orders?page=1&limit=50&channel=zzznope      -> 200, 50 rows   (the full set)
```

The param is accepted and ignored. Any caller that adds `&channel=…` gets a response that looks
filtered, repaints a table, and is wrong in every row. We have hit this exact shape three times
now (`?user_id=`, `?search=`, five params on `/supplier-prices`). **A 400 on an unknown filter
param is worth more than the filter itself.** The frontend does not send it and a test asserts
it never starts.

---

## 3. One request: split `invoice_sent.source`

§2 describes `source` as diagnostic — "use it only to decide whether to append `×N`; don't
surface the string" — and we follow that. But the name collides with a field the Orders page has
carried since ERR-175 that answers a *different* question: **who sent it** (`server` = the
backend recorded it, `admin` = an operator resent it from this page, which the detail modal
renders as a sentence).

Folding both into one key shipped a real bug on our side, caught in the browser and not by any
test: a send your log had recorded arrived captioned **"recorded when resent from this page"**.
We fixed it locally by keeping `source` for attribution and reading yours into `sourceKind`.

Nothing needs to change on your end for us. But if you ever add a second consumer, consider
naming it `send_source_kind` or similar — "source" reads like provenance-of-the-event when it
actually means provenance-of-the-record.

---

## 4. What `invoice_id` unblocked, and what is still open

`invoice_id` is the field that closed this. We deliberately did **not** bridge orders to
invoices by parsing `INV-3277` into invoice number 3277 — it matched on all 15 live rows, and
it is still exactly the inference your Rule 2 forbids, on two tables (`public.invoices` vs
`admin_invoices`) our own error log warns must never be conflated. So until your deploy landed,
`INV-3277` correctly read "Not recorded" with a tooltip naming the missing link rather than a
plausible-looking guess.

**Still open on your side: BF-046.** `public.invoices.emailed_at` is stamped on **0 of 136**
rows, including the invoice emailed automatically at checkout. That is not load-bearing for this
column any more, but it is still the reason we cannot say anything about a receipt send.

---

## 5. One shape note on the response

`invoice_sent` carries a single `sent_at` (the most recent) plus a total. So an invoice sent
three times shows one row in our history panel and a count of 3, and the panel has to say so.
That is fine and we render it honestly — but if `standalone_invoice_emails` is cheap to expose
as a list (even capped at, say, 10), the panel could show the actual sends rather than
explaining why it cannot.

Low priority. The count is the part that matters and it is correct.

---

## 6. What shipped, and how to re-check it

- `channel` drives the Channel badge (Website / Invoice / **Quick order**), replacing the
  `INV-` prefix sniff. An unrecognised `channel` value reads as Website per Rule 3; an order
  numbered `INV-9999` with `channel: "web"` shows Website and an em-dash.
- The column gates on `invoice_sent !== null` and never re-derives the channel rule.
- `sent_count: 0` beside a real `sent_at` renders the date with **no `×N`** — four live
  invoices (`27 Jul`, `8 Jul`, `3 Jul`, `1 Jul`) are exactly that case.
- `{sent_at: null}` renders **"Not sent"**, distinct from the em-dash, with a tooltip saying it
  is a real outstanding send.
- The `order_events` notes are still **written** (your §3 says that is harmless and the order
  timeline uses them) and are no longer **read** by this column.
- **The column now costs zero requests.** The two batched Supabase reads it used to make are
  not issued at all: 0 Supabase calls, 1 `/api/admin/orders`, down from 3.

Page 1, live, against your §4 table:

| Order # | Channel | Before | Now |
|---|---|---|---|
| 20260829000004 | Website | `Not recorded` | `—` |
| **INV-3277** | **Invoice** | `Not recorded` | **`1 Sept`** |
| **INV-3276** | **Invoice** | `Not recorded` | **`31 Aug`** |
| 20260827000003 | Website | `28 Aug ×2` | `—` |
| INV-3268 | Invoice | `Not recorded` | **`1 Sept ×2`** |
| INV-3274 | Invoice | `Not recorded` | **`Not sent`** |

Re-check any of it with **`npm run probe:orders-invoice-sent`** (read-only, GET-only, no record
mode). It prints which regime is live, re-measures the decoy, and reports whether live data
exists behind each render branch.

Pinned by `tests/admin-orders-invoice-sent-channel-sep2026.test.js` (67 assertions, four
positive controls). Written up in full as ERR-199.
