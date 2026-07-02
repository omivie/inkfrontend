# Backend handoff — Invoice creator: editable number, order date, editable email (Jul 2026)

**Audience:** backend Claude (ink-backend repo, Render + Supabase `lmdlgldjgcanknsjrcxh`).
**Status:** Frontend is **shipped and live**, wired to this contract. Each item **degrades gracefully** until you implement it (unknown request keys are already ignored by your handlers, so nothing breaks today — the features just aren't fully functional yet). Implement the four items below to light them up.

Delete this file once consumed (per repo convention handoffs are transient).

---

## Conventions (unchanged — for reference)

- **Base URL:** `https://ink-backend-zaeq.onrender.com` (prod also `api.inkcartridges.co.nz`).
- **Auth:** all routes require `Authorization: Bearer <supabase JWT>`; these are **owner/super_admin only** (same gate as the existing invoice routes).
- **Success envelope:** `{ "ok": true, "data": { … } }`
- **Error envelope:** `{ "ok": false, "error": { "code": "VALIDATION_FAILED|CONFLICT|NOT_FOUND", "message": "human string", "details": ["…"] } }`
  The frontend's `invoiceError()` reads `error.message` and appends `error.details[]` to the toast, and also lifts a top-level `code` for string-error 404s. Keep to this shape.
- **Existing tables:** `invoices`, `invoice_line_items`, sequence `invoice_number_seq`. Existing 7 routes (`list/get/create/update/void/email/pdf` + `paid`/`delete`) are already live.
- **Money model (unchanged):** line `unit_cost_excl_gst` & `freight_excl_gst` are **ex-GST**; `gst_amount = round((subtotal_excl_gst + freight_excl_gst) × 0.15, 2)`; `total_incl_gst = subtotal + freight + gst`. Backend remains the source of truth for totals and ignores the FE's advisory `preview_totals`.

---

## 1. Persist + return `order_date` (new column)

**Why:** the creator now has two dates — the existing **issue date** (`issue_date`, "today") and a new **Order date** ("the date the order was placed"). Order date is shown on the invoice document and used in the email sentence ("your order on the 23rd March"). Today the FE sends it but you drop it, so it doesn't round-trip on reload.

**DB:**
```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS order_date date;
```

**Create / Update payload** (`POST /api/admin/invoices`, `PUT /api/admin/invoices/:id`) — new top-level field, sibling of `issue_date`:
```json
{
  "issue_date": "2026-07-01",
  "order_date": "2026-03-23",   // NEW — nullable; may equal issue_date; may be null
  "...": "…all existing fields unchanged…"
}
```
- Accept `order_date` as a nullable ISO date (`YYYY-MM-DD`). Validate the same way as `issue_date` when present (valid date). `null`/absent is allowed.
- **Persist** it and **return** it on create/update/get in the invoice record (`data.invoice.order_date`).

**No other behaviour depends on it server-side** (it's display + email text). The FE-rendered PDF already draws it, so stored PDFs are correct even before this lands — this is purely to make it survive a reload/edit.

---

## 2. Honor a client-provided `invoice_number` (manual override)

**Why:** the invoice number is now **auto-filled but editable**. The FE prefills a suggestion (item 4) and lets the operator overtype it. On save the FE sends whatever's in the field; today you always `nextval()` and ignore it, so a manual number is silently lost.

**Contract for `POST /api/admin/invoices` (and `PUT /:id`):**
- Request field `invoice_number` is either:
  - **`null`/absent** → assign `nextval('invoice_number_seq')` exactly as today (default path, unchanged).
  - **a positive integer** → **use it verbatim**, after validating:
    - Not an integer / ≤ 0 → **400 `VALIDATION_FAILED`**, `message: "Invoice number must be a positive whole number"`.
    - Already used by another invoice → **409 `CONFLICT`**, `message: "Invoice number already in use"`. (On `PUT`, ignore the row being edited when checking uniqueness.)
    - Otherwise insert/update with the provided number, and **advance the sequence so future auto-numbers don't collide:**
      ```sql
      -- after a successful manual insert of N:
      SELECT setval('invoice_number_seq', GREATEST(nextval_would_be_minus_1, N), true);
      -- i.e. bump the sequence's last_value up to N if N is higher; never move it backwards.
      ```
      (Practically: `SELECT setval('invoice_number_seq', GREATEST((SELECT last_value FROM invoice_number_seq), N), true);`)

**Edge cases:**
- Manual number **lower** than the current max is allowed as long as it's unique (operator backfilling an old number) — just don't move the sequence backwards.
- Keep it transactional so a uniqueness race can't double-insert (unique constraint on `invoices.invoice_number` + catch the violation → 409).

---

## 3. `POST /api/admin/invoices/:id/email` — accept optional `{ to, subject, body }`

**Why:** the operator now composes/edits the email in a dialog before sending (matches an exemplar layout). Today this route takes an empty body and uses your default order-email template; the FE now posts the edited message.

**Request body** (all optional — an empty `{}` must still work exactly as today for backward-compat):
```json
{
  "to":      "hartleyfm@yahoo.co.nz",   // optional recipient override; if omitted, use the invoice's stored customer.email
  "subject": "Your InkCartridges.co.nz invoice #3236",
  "body":    "Hi Felix,\nThank you for your order on the 23rd March. Please find your invoice attached.\nRegards,\nTrevor Walker\nInkCartridges.co.nz"
}
```

**Behaviour:**
- If `subject` present → use it as the email subject; else fall back to your current default subject.
- If `body` present → use it as the message. It's **plain text**; render newlines as `<br>` (or `<p>` per line) for the HTML part, and pass through as-is for any text part. Do **not** HTML-inject — escape the text, then convert `\n`→`<br>`.
- If `to` present and non-empty → send there; else send to the invoice's stored `customer.email`. If neither is available → **400 `VALIDATION_FAILED`** `"No recipient email address"`.
- **Always attach the stored invoice PDF** (`invoices/<id>.pdf` from Supabase Storage — the FE-rendered file; fall back to your generated PDF if none), exactly as today.
- Set `emailed_at` and return `{ "ok": true, "data": { "emailed_at": "…Z" } }` as today.
- Reject emailing a **void** invoice with 409 `CONFLICT "Invoice is void"` (if you already do — keep it).

**Note:** the FE builds the exact wording; you just deliver it. Keep the default template for the empty-body case so older callers / automated flows are unaffected.

---

## 4. `GET /api/admin/invoices/next-number` — peek the next number (new route)

**Why:** the creator prefills the "Invoice No" field with the suggested next number when opening a **new** invoice, so the operator sees it and can edit it. The FE calls this first; if the route is missing it **falls back** to `max(invoice_number)+1` from the invoice list, so this is a nice-to-have that makes the suggestion exact.

**Route:** `GET /api/admin/invoices/next-number` (owner/super_admin).

**Behaviour:** return the value the *next* auto-assigned invoice would get, **without consuming the sequence** (peek only — do NOT `nextval`):
```sql
SELECT last_value, is_called FROM invoice_number_seq;
-- next = is_called ? last_value + 1 : last_value
```
**Response:**
```json
{ "ok": true, "data": { "next": 3260 } }
```
The FE reads `data.next` (also tolerates `data.invoice_number` or a bare number). On any error it silently falls back to the list-derived max, so a 404 here is non-fatal.

---

## How the frontend calls these (for your reference)

- `AdminAPI.nextInvoiceNumber()` → `GET /api/admin/invoices/next-number` (fallback: `listInvoices({sort:'invoice_number',order:'desc'},1,1)`).
- `AdminAPI.createInvoice(payload)` / `updateInvoice(id, payload)` → payload now includes `order_date` (nullable) and a possibly-non-null `invoice_number`. Everything else is unchanged from the existing invoice contract.
- `AdminAPI.emailInvoice(id, { to, subject, body })` → `POST /:id/email`. Called with an empty object in no legacy paths anymore, but keep `{}` working.

Existing FE payload shape (unchanged except the two new/edited fields) for `create`/`update`:
```json
{
  "invoice_number": 3260,          // NEW: may be an int (manual) or null (auto)
  "status": "unpaid",
  "issue_date": "2026-07-01",
  "order_date": "2026-03-23",      // NEW: nullable
  "source_order_id": null,
  "seller":   { "name": "...", "gst": "...", "address": ["..."], "phone": "...", "contact": "Trevor Walker" },
  "customer": { "attn": "...", "name": "...", "company": "...", "address": ["..."], "phone": "...", "email": "..." },
  "delivery": { "attn": "...", "company": "...", "address": ["..."], "phone": "..." },  // or null
  "line_items": [ { "product_code": "...", "description": "...", "quantity": 1, "unit_cost_excl_gst": 92.60 } ],
  "freight_excl_gst": 0,
  "footer": { "bankName": "...", "bankAcct": "...", "thankYou": "..." },
  "notes": "",
  "preview_totals": { "subtotal": 92.60, "freight": 0, "gst": 13.89, "total": 106.49 }
}
```

---

## Acceptance checklist (curl with a super_admin token)

1. **order_date round-trips**
   ```bash
   curl -sX POST $API/api/admin/invoices -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"issue_date":"2026-07-01","order_date":"2026-03-23","customer":{"name":"Test","address":["1 St"]},"line_items":[{"description":"Widget","quantity":1,"unit_cost_excl_gst":10}]}'
   # → 201, data.invoice.order_date == "2026-03-23"; GET /:id also returns it.
   ```
2. **manual invoice_number honored + unique**
   ```bash
   # provide a fresh high number → used verbatim; sequence bumped so next auto ≥ N+1
   -d '{"invoice_number":5000,"issue_date":"2026-07-01","customer":{"name":"A","address":["x"]},"line_items":[{"description":"i","quantity":1,"unit_cost_excl_gst":1}]}'
   # → 201, data.invoice.invoice_number == 5000
   # repeat with the SAME number → 409 CONFLICT "Invoice number already in use"
   # then create with invoice_number null → auto number is 5001+ (not a collision)
   ```
   Also: `invoice_number: -1` or `"abc"` → 400 VALIDATION_FAILED.
3. **next-number peeks without consuming**
   ```bash
   curl -s $API/api/admin/invoices/next-number -H "Authorization: Bearer $T"   # → {ok,data:{next:N}}
   curl -s $API/api/admin/invoices/next-number -H "Authorization: Bearer $T"   # → SAME N (didn't advance)
   # then create with null number → gets N; next-number now returns N+1
   ```
4. **email uses supplied subject/body/to + attaches PDF**
   ```bash
   curl -sX POST $API/api/admin/invoices/$ID/email -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"to":"me@example.com","subject":"Test subj","body":"Hi X,\nLine two.\nRegards,\nTrevor"}'
   # → 200 {ok,data:{emailed_at}}; received email has that subject, body newlines as line breaks, PDF attached.
   # empty body still works:
   curl -sX POST $API/api/admin/invoices/$ID/email -d '{}'   # → 200, default template, PDF attached.
   ```
5. **backward-compat:** existing create/update/list/get/void/paid/delete/pdf all still pass their prior tests (order_date column nullable, no NOT NULL breakage).
