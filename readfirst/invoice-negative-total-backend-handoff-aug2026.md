# Invoice NEGATIVE TOTAL — a below-zero document 500s (BF-052, Aug 2026)

**One rule blocks a pure credit note. The frontend is done and is holding the
line for you — badly, because all it can do is refuse.**

This is the follow-up to `invoice-negative-zero-lines-backend-response-aug2026.md`
(BF-050, landed 2026-08-29). That work is verified and working; thank you. This
is the one claim in it that did not hold.

---

## What the operator wants

A customer returned goods, or was over-invoiced, and is owed money. The document
that says so is an invoice whose total is below zero:

```
Already paid — invoice 3271        1     -$36.08
                         Sub Total       -$36.08
                         Freight            Free
                         GST               -$5.41
                         Total            -$41.49
```

Today the editor refuses to save that, and the message has to say so in the
operator's own words. It is the only money the invoice editor still declines.

## The rule that blocks it

**`POST /api/admin/invoices` returns `500 Failed to create invoice` when the
invoice TOTAL is below zero.**

Measured against production on 2026-08-29:

| document total | result |
|---|---|
| exactly `$0.00` | **201**, saves, reads back verbatim, deletes cleanly |
| `-$0.01` | **500** `Failed to create invoice` |
| `-$41.49` | **500** `Failed to create invoice` |

**Isolated first, so this is the total and nothing else.** A negative
`unit_cost_excl_gst`, a negative `quantity`, a negative `supplier_cost_excl_gst`
and a negative `freight_excl_gst` are each individually fine on create, update
and `/quote` — exactly as §1 of your reply says. It is only when they add up to a
document below zero that the request fails.

### The control, and the exact pair to paste

The **only** difference between these two bodies is one digit. The first returns
201; the second returns 500.

```jsonc
// CONTROL → 201. Total lands on exactly $0.00.
{
  "customer": { "name": "Probe", "address": ["1 Test St"] },
  "issue_date": "2026-08-29", "order_date": "2026-08-29",
  "line_items": [
    { "product_code": "", "description": "Goods",  "quantity": 1,
      "unit_cost_excl_gst": 40, "supplier_cost_excl_gst": 0, "cost_source": "manual" },
    { "product_code": "", "description": "Credit", "quantity": 1,
      "unit_cost_excl_gst": -40, "supplier_cost_excl_gst": 0, "cost_source": "manual" }
  ],
  "freight_excl_gst": 0
}
```

```jsonc
// FAILS → 500 "Failed to create invoice". Total lands on -$0.01.
//   …identical, except:
    { "product_code": "", "description": "Credit", "quantity": 1,
      "unit_cost_excl_gst": -40.01, "supplier_cost_excl_gst": 0, "cost_source": "manual" }
```

`PUT /api/admin/invoices/:id` has not been isolated separately; please check it
with the same pair. `DELETE /api/admin/invoices/:id` is live and cleans up after
the control (200 `{deleted:true}`, then `GET` → 404).

## It contradicts §1 ask 3 of your own reply

Your BF-050 response says, verbatim:

> **Deliberately not implemented server-side.** The backend accepts a
> negative-total document. … So `validateInvoice` in the editor stays the guard,
> and it is the only one. Please keep it.

We have kept it, and it is now the only thing between the operator and an opaque
500. But it is guarding a crash, not a policy — and while it stands, the feature
your reply deliberately left open (a pure credit note) cannot actually be issued.

The likeliest cause is not the validators you already opened: it is something
downstream that assumes a non-negative document — a `CHECK` constraint on the
invoice total or GST column, a `numeric` domain, or the shadow-order materialiser
choking before the insert. That it is a 500 and not a 400 says the request got
past validation and something below it threw.

---

## Asks

1. **Accept a below-zero invoice total** on `POST /api/admin/invoices` and
   `PUT /api/admin/invoices/:id`. (`/quote` already does — see ask 6.)

2. **Never a 500 on this path, whatever you decide.** If a negative total must be
   refused, refuse it as a **`400 VALIDATION_FAILED`** with the usual
   `error.details[]` shape. `saveErrorMessage` in the editor already surfaces
   `details[].message` verbatim, so a Joi-shaped refusal reaches the operator as a
   sentence; a 500 reaches them as nothing. **A 400 we can work with. A 500 we can
   only guess at.**

3. **Do not clamp or floor on the way in.** The frontend renders the customer's
   PDF and uploads it (`POST /:id/pdf`), so a silently floored record leaves the
   document the customer holds and the invoice you stored disagreeing about the
   money. Refuse loudly or store it faithfully — those are the only two safe
   options. (This is the same ask as §1 ask 2 of the last round, and it held.)

4. **GST on a negative total must be negative**, not floored at 0. The editor
   computes `(subtotal + freight) × 0.15` and prints `-$5.41` on the example
   above; a stored `0` would put the two documents a GST apart.

5. **A negative-total invoice must REDUCE revenue in analytics, not book a
   negative sale.** The existing exclusions must still apply unchanged — `void`
   never counts, and `source_order_id` never counts (that is the double-count
   guard; an invoice raised against an existing order is paperwork for a sale
   already in the numbers).

6. **`/quote` ALREADY handles this correctly — please don't regress it while
   fixing the save path.** Measured 2026-08-29 with `npm run probe:invoice-quote`:
   a single `quantity: -1, unit_cost_excl_gst: 60.00` line returns **200** with
   `goods_total_incl_gst: -69`, negative and unfloored (§6e), and credit lines
   subtract correctly too (§6d). So the divergence is real and narrow — the quote
   endpoint is happy with a below-zero document and the create endpoint is not,
   which is itself a hint about where the failure lives.

---

## What the editor is NOW sending that it was not before

Both are legal per your BF-050 reply; flagged so you can confirm the
materialisers and the COGS rollup handle them, because we had not exercised
either until this week.

- **`quantity: 0` line items.** The editor used to refuse them; that was our rule
  alone and it is gone. A zero-quantity line is a row the customer should read but
  not be charged for. It must contribute **nothing** to `goods_total_incl_gst` —
  a backend that read `0` as "unspecified" and substituted `1` would charge for a
  line the document says is free, and the only symptom would be a free-shipping
  decision made on money nobody owes. `npm run probe:invoice-quote` §6f measures
  exactly this, and it **passes today** — `1 × 100.00 ex + 0 × 80.00 ex → 115.00
  incl`, verified 2026-08-29. Recorded so a regression is visible, not because
  anything is wrong.

- **A negative `supplier_cost_excl_gst` with `cost_source: "manual"`.** A cost the
  operator typed is theirs, sign included — a supplier rebate or credit. We used
  to discard it silently, which was our bug. `cost_source: "auto"` costs are still
  non-negative, and `null` still means UNKNOWN (never 0 — ERR-068).

  **…and this one has surfaced a SECOND bug — please treat it as part of this
  ticket.** The line item stores and returns faithfully, but the LIST's
  precomputed rollup floors it, so the two endpoints now report different costs
  for the same invoice. Measured 2026-08-29 on a real invoice (created, read
  back, deleted):

  | endpoint | what it said |
  |---|---|
  | `GET /api/admin/invoices/:id` | `line_items[1]`: `{ quantity: 1, unit_cost_excl_gst: 100, supplier_cost_excl_gst: -12.34, cost_source: "manual" }` — **correct** |
  | `GET /api/admin/invoices` (same invoice) | `cost_excl_gst: 0`, `profit_excl_gst: 100` — **wrong**; should be `-12.34` and `112.34` |

  The invoice list shows `$100.00 · 100.0%` while opening that very invoice shows
  `-$12.34 · 112.3%`. **Two surfaces disagreeing about the same money, with
  nothing to notice it, is the failure mode we hold hardest against** — the
  editor's figure is derived from the line items you returned, so it cannot be
  "our end". Please make the list rollup sum `supplier_cost_excl_gst` as signed,
  the same way the line items store it. `null` must keep meaning UNKNOWN (both
  fields null together, as today); only the FLOOR should go.

  Same shape for the same reason as ERR-068 and the invoice-list cost bug already
  on your plate: **a value that is not there and a value that is negative are two
  different things, and neither of them is zero.**

Migration 138's predicate (`quantity > 0 AND line_total_excl_gst >= 0`) should
already skip both of these when materialising the shadow order. Please confirm.

---

## Still open in the same area

Listed only so they are visible together; none of them block this one.

- **Migration 138 is NOT applied.** `sql/migrations/138_shadow_order_skip_non_positive_lines.sql`
  needs running by hand in the Supabase SQL editor. **This is the owner's action,
  not yours** — noted here so it is not mistaken for a backend task. Until it is
  applied, a credit or return line carrying a *resolvable* product code
  materialises in the shadow order as a `1 × SKU @ $0.00` sale, inflating
  product-level rankings and COGS for a product that came back. Description-only
  credit lines are unaffected, and that is what the editor sends by default.
- **`product_ref`** — a nullable text column on the invoice line item, stored and
  echoed. Confirmed dropped by write on 2026-08-28: a line with
  `product_code: ""` + `product_ref: "REFURB-01"` saved 201 and read back without
  the key. The editor detects the drop by key PRESENCE and warns the operator, so
  the warning self-heals the day the column lands. Full ask in
  `readfirst/invoice-custom-ref-backend-handoff-aug2026.md`.
- **`volume_discount_percent` / `volume_saving_excl_gst` / `volume_quantity`**,
  and **`discount_saving_excl_gst` / `discount_note`** — all five are sent on
  every save and all five are dropped, so a reopened invoice loses the bulk or
  discount note it printed for the customer.

### One warning about ticket numbers

`BF-046` … `BF-049` were allocated **twice**, independently, in two local backlog
files — once for the invoice `emailed_at` work and once for the orders
`customer_email` filter and the invoice-list cost bug. **Cite these by
description, not by bare number.** `BF-050`, `BF-051` and `BF-052` are
unambiguous.

---

## Acceptance checklist

- [ ] `POST /api/admin/invoices` with a total of `-$0.01` returns **201**, not 500
- [ ] the same document read back has a negative `total_incl_gst` and a negative GST
- [ ] `PUT /api/admin/invoices/:id` accepts an edit that takes an existing invoice below zero
- [x] `POST /api/admin/invoices/quote` already returns a negative `goods_total_incl_gst` — verified 2026-08-29, keep it that way
- [ ] if any of the above is refused instead, it is a **400 `VALIDATION_FAILED`** with `error.details[]`, never a 500
- [ ] nothing is clamped: what is sent is what is stored
- [ ] a negative-total invoice REDUCES revenue in analytics; `void` and `source_order_id` still exclude as before
- [ ] `quantity: 0` contributes nothing to `goods_total_incl_gst`
- [x] a negative `supplier_cost_excl_gst` with `cost_source: "manual"` round-trips unchanged on `GET /:id` — verified 2026-08-29
- [ ] …but the LIST's `cost_excl_gst` / `profit_excl_gst` floor it to 0 — make the rollup signed so the two endpoints agree
- [ ] a `quantity: 0` line contributes `line_total_excl_gst: 0` to the stored invoice (already true — verified 2026-08-29)

The frontend needs **no change** when this lands — deleting the guard in
`validateInvoice` (`js/admin/pages/invoices.js`, the block that names BF-052) is
the whole of it, and the comment there says so. Please tell us when it ships so
we remove it rather than leaving a limitation alive after it is gone.

Delete this file once consumed.
