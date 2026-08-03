# Backend brief — Business Centre (`/business`)

**Date:** 2026-08-02
**Audience:** backend dev + backend CLI Claude (the `ink-backend-zaeq` service / Supabase)
**Repo affected:** backend API only — the frontend is already built and deployed
**Status (updated 2026-08-03): ALL SEVEN ROUTES ARE NOW LIVE.** This brief has been
implemented. Re-probed against production on 2026-08-03: every route below answers
`401 UNAUTHORIZED` unauthenticated, while an unknown path under the same prefix
(`/api/business/invoices/abc/nope`) answers `404 NOT_FOUND` — so the 401s are real
route matches, not a blanket prefix guard. **The §0 table's original "404 — build it"
rows were correct on 2026-08-02 and are now obsolete; do not re-implement them.**
The remaining open item is §7 (the `invoices.business_account_id` FK), without which
no admin-created invoice can appear on a customer's portal.
**Priority:** the endpoint work is DONE. §7 is the live gap.

This document is self-contained. You should not need the frontend repo.

---

## 0. What already exists

> **Re-verified 2026-08-03: the whole table is now "Live".** The states below are the
> 2026-08-02 snapshot, kept only so the history reads straight. See the Status note above.

| Endpoint | State |
|---|---|
| `GET /api/business/status` | **Live.** Returns `{status, application:{company_name}, credit_limit, credit_remaining, net30_approved}` |
| `GET /api/business/pricing?skus=` | **Live.** Volume ladders, max 100 SKUs |
| `GET /api/business/invoices` | **Live** — returns `{invoices:[], pagination:{total,page,limit}}`. Needs the fields in §3 and the account link in §7 |
| `GET /api/business/analytics/series` | **404 — build it** (§1) |
| `GET /api/business/top-products` | **404 — build it** (§2) |
| `GET /api/business/invoices/:id` | **untested — build/confirm** (§4) |
| `GET /api/business/invoices/:id/pdf` | **404 — build it** (§5) |
| `GET /api/business/account/summary` | **404 — build it** (§6) |

All new routes: `requireB2B`, envelope `{ok:true, data:{…}}`, and a signed-in
non-business user gets `403 B2B_REQUIRED` — a code the frontend already
recognises and treats as "not a business account" rather than an error.

---

## Two rules that apply to every field below

> ### R1 — `null` is not `0`
> Every money field is a number (**including `0`**) or `null`. Never omit a field
> to mean zero, and never default an unknown to `0`.
>
> `0` means *we measured it and it was zero*. `null` means *not reported* — the
> frontend renders `—`. Collapsing the two is the single most repeated defect on
> this codebase (ERR-063/068/073/075/076, and ERR-139 where business pricing was
> dark for days because a failure looked exactly like a success).

> ### R2 — these field names must never appear on a `/api/business/*` response
> `supplier_cost_excl_gst`, `cost_excl_gst`, `profit_excl_gst`, `margin_percent`,
> `cost_source`.
>
> On an invoice record `unit_cost_excl_gst` is the **sell** price shown to the
> customer, but `supplier_cost_excl_gst` is **what we paid**. They are one word
> apart in the risky direction. See §4 for a rename that removes the ambiguity
> permanently.

---

## 1. `GET /api/business/analytics/series` — the savings + spend charts

Drives the two charts and three headline tiles on the Overview tab.

**Auth:** `requireB2B` (403 `B2B_REQUIRED`). Suggested rate limit 60/min/user.
**Query:** `?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=month|week` (default: last
12 months, `month`).

```jsonc
{
  "ok": true,
  "data": {
    "granularity": "month",
    "currency": "NZD",
    "from": "2025-08-01",
    "to": "2026-08-01",
    "points": [
      {
        "period_start": "2025-08-01",      // ISO date, bucket START
        "spend_incl_gst": 1240.50,         // what they paid, GST INCLUSIVE
        "b2b_savings": 98.20,              // retail − business price, this bucket
        "other_savings": 15.00,            // coupons + loyalty + waived shipping
        "orders": 4
      }
    ],
    "totals": {
      "lifetime_spend_incl_gst": 18420.75,
      "lifetime_b2b_savings": 1290.40,
      "lifetime_other_savings": 210.00,
      "first_order_at": "2024-02-11T03:00:00Z"
    },
    "coverage": {
      "orders_counted": 112,
      "orders_missing_discount_breakdown": 3   // see below — this one matters
    }
  }
}
```

### Field rules

| Field | Type | Required | Notes |
|---|---|---|---|
| `period_start` | ISO date | yes | Bucket start. The FE plots on this. |
| `spend_incl_gst` | number \| null | yes | **GST-inclusive.** The name says so on purpose — there is a whole `js/admin/utils/gst-basis.js` because this went wrong before. |
| `b2b_savings` | number \| null | yes | `null` = the split wasn't recorded for this bucket. The FE leaves a **gap** in the line; it does not plot 0. |
| `other_savings` | number \| null | yes | Same. **Do not** compute it as `total − b2b` to avoid a null — if you can't split it, send `null`. |
| `orders` | integer | yes | |
| `coverage.orders_missing_discount_breakdown` | integer | yes | Orders you could not split. **`0` is a real and expected value.** |

### Why `coverage` exists

If some orders can't be broken down, the chart is a partial picture. The frontend
renders a visible caveat under it — *"3 orders couldn't be broken down by discount
type, so they're not in this chart"* — so a partial chart **looks** partial. Send
`0` when everything was counted; the caveat then stays hidden. Please do not omit
the object to mean zero (R1).

---

## 2. `GET /api/business/top-products` — quick reorder

**Auth:** `requireB2B`. **Query:** `?limit=8&from=&to=`

```jsonc
{
  "ok": true,
  "data": {
    "items": [
      {
        "sku": "CTN258XLK",
        "name": "Brother TN-258XL Black",
        "product_url": "/product/brother-tn-258xl-black",  // site-relative, NEVER /html/...
        "quantity_ordered": 42,
        "order_count": 9,
        "last_ordered_at": "2026-07-02T21:15:00Z",
        "in_stock": true,
        "purchasable": true
      }
    ],
    "complete": true
  }
}
```

**No price on this payload, deliberately.** Reorder tiles get their price from the
live pricing path, never from a historical figure re-presented as today's price.

`purchasable:false` or `in_stock:false` renders a disabled tile **with a stated
reason** — the row is never silently dropped, because a missing row is
indistinguishable from "you never ordered this".

`product_url` must not start with `/html/` (`tests/url-consolidation.test.js:148`
bans those site-wide).

---

## 3. `GET /api/business/invoices` — the list (EXISTS, needs fields)

Already live and already returns `{invoices, pagination}`. Two changes:

**a) Server-side filtering.** Accept `?status=unpaid|paid|void|all&from=&to=&page=&limit=`.
The frontend sends these as query parameters and does **not** filter in the
browser — filtering page 1 of a paginated list client-side produces a confidently
wrong result set.

**b) Each row needs these fields:**

```jsonc
{
  "id": "…",
  "invoice_number": "INV-3301",
  "issue_date": "2026-07-01",
  "due_date": "2026-07-31",              // null when show_due_date is false
  "status": "unpaid",                    // draft | unpaid | paid | void
  "paid_at": null,
  "subtotal_excl_gst": 420.00,
  "freight_excl_gst": 9.50,
  "gst_amount": 64.43,
  "total_incl_gst": 493.93,
  "amount_outstanding": 493.93,          // null if not tracked — NOT 0
  "has_stored_pdf": true,                // see §5
  "po_number": "PO-9921",
  "source_order_id": null
}
```

> **Note on `status`:** the admin tool currently treats paid/unpaid as internal-only
> and deliberately keeps it off customer-facing artefacts
> (`js/admin/pages/invoices.js:236-238`). Showing it here is a **deliberate
> product decision**, made 2026-08-02 — not drift. Flagging it so nobody
> "fixes" it back.

---

## 4. `GET /api/business/invoices/:id` — detail

List shape plus:

```jsonc
"bill_to": { "name":"…", "company":"…", "email":"…", "address_lines":["…"] },
"lines": [
  {
    "code": "CTN258XLK",
    "description": "Brother TN-258XL Black",
    "qty": 6,
    "unit_price_excl_gst": 70.00,      // ← see the rename below
    "line_total_excl_gst": 420.00
  }
],
"payment_terms": "Net 30",
"notes": "…",
"emailed_at": "2026-07-01T04:02:00Z"
```

### The one rename worth doing now

The admin model calls the customer-facing **sell** price `unit_cost` /
`unit_cost_excl_gst`, and the **supplier** price `supplier_cost_excl_gst`. Two
different things, one word apart, and the dangerous one sorts adjacent to the safe
one in every autocomplete and grep.

**On this new customer contract, please name it `unit_price_excl_gst`.** It costs
nothing today and permanently removes the chance of a copy-paste leaking supplier
cost onto a customer's invoice. The frontend already reads
`unit_price_excl_gst`.

**Ownership:** another account's invoice must return **`403`, not `404`** — the
frontend needs to say "that invoice isn't on your account" rather than "gone".

---

## 5. `GET /api/business/invoices/:id/pdf` — the stored file

**The file we serve must be the file we emailed.** The admin tool renders the PDF
client-side and uploads it (`POST /api/admin/invoices/:id/pdf`) precisely so the
emailed bytes and the stored bytes are identical. This route returns those bytes.

- `Content-Type: application/pdf`
- `Content-Disposition: attachment; filename="Invoice-INV-3301.pdf"`
- The **one** route in this brief that is not `{ok, data}`.

### Please return `409 NO_STORED_PDF` when there is no stored file

Not `404`. `404` is ambiguous with "that invoice doesn't exist", and the frontend
behaves very differently in the two cases:

- **409 / 404** → the frontend generates a local copy, **visibly stamped**
  *"Reproduced from your account on 2 Aug 2026 — a copy of invoice INV-3301."*
- **5xx / network** → error + Retry, and **no** local generation.

That asymmetry is deliberate. Falling back on *any* failure would hand a customer
a document that differs from the one we emailed — different renderer build, or
edits made since — while they believe it is the same file. A visible error is
better than a silent substitution.

**Ideal fix:** generate and store a PDF server-side for any non-draft invoice that
lacks one, so the fallback path is never taken. Until then, `409` is what makes
the frontend honest.

---

## 6. `GET /api/business/account/summary` — the outstanding-balance tile

```jsonc
{
  "ok": true,
  "data": {
    "outstanding_balance": 1284.30,   // null if unknown — NOT 0
    "overdue_balance": 493.93,
    "unpaid_invoice_count": 3,
    "overdue_invoice_count": 1,
    "oldest_due_date": "2026-06-30",
    "credit_limit": 5000,
    "credit_remaining": 3715.70,
    "net30_approved": true,
    "company_name": "Acme Ltd",
    "as_at": "2026-08-02T09:00:00Z"
  }
}
```

This endpoint exists specifically so **the frontend never sums the invoice list**
to produce the headline balance. That list is paginated: summing page 1
understates what the customer owes, with total confidence and no visible symptom.
If you can't compute it, send `null` and the tile renders `—`.

---

## 7. Schema — the invoice → business account link

```sql
ALTER TABLE invoices
  ADD COLUMN business_account_id uuid REFERENCES business_accounts(id);
CREATE INDEX ON invoices (business_account_id);
```

- Backfill from `bill_to.email` **once, at migration time**, then never again.
- Admin invoice create/update accepts and returns `business_account_id`; the
  contact picker in the admin invoice editor should set it.
- `GET /api/business/invoices` filters on `business_account_id`, **never on email**.

### Why not email matching

A customer who changes their billing email loses their whole invoice history. Worse,
a shared or mistyped address exposes **another company's invoices** — a data-leak
bug wearing UX clothes. The link has to be a real foreign key.

**Follow-on worth scheduling (not in scope here):** show the linked business
account in the admin invoice list, or operators can't diagnose *"why isn't this
invoice on my customer's portal?"*.

---

## 8. Acceptance test

With an approved business account's bearer token:

```bash
TOKEN=...   # a signed-in approved business account
BASE=https://ink-backend-zaeq.onrender.com

# 1. Series: 12 monthly buckets, coverage present, nulls preserved
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/business/analytics/series?granularity=month" | jq '.data.coverage, .data.points[0]'

# 2. Summary: outstanding_balance is a number or null, never absent
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/business/account/summary" | jq '.data.outstanding_balance'

# 3. Invoices filter server-side — this must NOT return paid rows
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/business/invoices?status=unpaid&limit=50" | jq '[.data.invoices[].status] | unique'

# 4. Stored PDF is a real PDF
curl -s -D- -o /tmp/inv.pdf -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/business/invoices/<id>/pdf" | head -5
file /tmp/inv.pdf     # → PDF document

# 5. An invoice with no stored file answers 409, not 404
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/business/invoices/<id-with-no-pdf>/pdf"     # → 409

# 6. Someone else's invoice is 403, not 404
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/business/invoices/<other-companys-id>"      # → 403

# 7. A retail (non-business) account is refused with the code the FE expects
curl -s -H "Authorization: Bearer $RETAIL_TOKEN" \
  "$BASE/api/business/account/summary" | jq '.code'      # → "B2B_REQUIRED"

# 8. R2 — no cost/margin field leaks onto any customer response
for p in "analytics/series?granularity=month" "top-products?limit=8" "invoices?limit=5"; do
  curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/business/$p" \
    | grep -Ei 'supplier_cost|cost_excl_gst|profit|margin|cost_source' && echo "LEAK in $p"
done
```

---

## Reference files (frontend, for context — do not edit)

- `inkcartridges/js/business-page.js` — the controller. Every fetch, the three
  gate states, and the render functions.
- `inkcartridges/js/business-invoice-pdf.js` — stored-PDF download and the narrow
  fallback described in §5.
- `inkcartridges/js/business.js` — `getStatus()`, `_statusDegraded`, and the
  header button.
- `inkcartridges/html/business.html` — the page and every element id.
- `tests/business-centre-aug2026.test.js` — 24 assertions pinning the above,
  including the supplier-cost leak guard.
