# Invoicing — Backend Handoff (Jun 2026)

**Audience:** backend dev (ink-backend repo, Render → `https://ink-backend-zaeq.onrender.com`).
**Status:** Frontend is **complete and live-wired**; these endpoints + tables **do not exist yet**. Until they do, the admin Invoices page falls back gracefully (client-side jsPDF for downloads; clean error toasts on save/email/void/list).

The frontend admin **Invoices** page (`inkcartridges/js/admin/pages/invoices.js`, owner-only, Sell section) lets an operator create an invoice from scratch or auto-filled from an order, preview it, save it, download a PDF, email it, and void it. This document is the exact contract the frontend already calls.

> Delete this file once implemented — we don't keep handoff `.md`s in the repo long-term.

---

## 0. Conventions (must match existing admin API)

- **Response envelope:** `{ ok: true, data: ... }` on success, `{ ok: false, error: "message" }` on failure (HTTP 4xx/5xx). This is the existing site convention — do **not** use `{ success }`.
- **Auth:** all routes require the existing admin auth middleware **AND owner role** (same gate as `/api/admin/settings`, `/api/admin/control-center`). Bearer token in `Authorization` header. Staff (non-owner) must get 403.
- **Currency:** NZD. **GST rate: 15%.** All money `numeric(10,2)`, rounded half-up to 2dp.
- **Request-id:** thread `x-request-id` into errors as elsewhere.

---

## 1. GST / money model (authoritative — recompute server-side)

The frontend sends line costs and freight **GST-EXCLUSIVE** and only sends `preview_totals` as an advisory display value. **Ignore `preview_totals`. Recompute everything server-side** from `line_items` + `freight_excl_gst`:

```
line_total_excl_gst   = quantity * unit_cost_excl_gst                 (per line, round 2dp)
subtotal_excl_gst     = Σ line_total_excl_gst
gst_amount            = round( (subtotal_excl_gst + freight_excl_gst) * 0.15 , 2 )
total_incl_gst        = subtotal_excl_gst + freight_excl_gst + gst_amount
```

Freight of `0` renders as "Free" on the document. This matches the operator's exemplar exactly (line 92.60 ex-GST → GST 13.89 → total $106.49).

> Note: order `shipping_fee` elsewhere in the system is **GST-inclusive**; the frontend already converts it to ex-GST (`/1.15`) before sending. So on **these** endpoints, `freight_excl_gst` is always ex-GST — store and use it as-is.

---

## 2. Database schema (Supabase / Postgres)

```sql
-- Continue the existing invoice-number series (exemplar shows No. 3253).
-- Seed the sequence at the current max so new invoices continue, not restart.
-- Run once: SELECT setval('invoice_number_seq', <current_max_invoice_no>, true);
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number     integer UNIQUE NOT NULL,           -- assigned from invoice_number_seq
  status             text NOT NULL DEFAULT 'unpaid'
                       CHECK (status IN ('draft','unpaid','paid','void')),
  issue_date         date NOT NULL,
  source_order_id    uuid NULL REFERENCES orders(id) ON DELETE SET NULL,

  -- Letterhead blocks (editable per-invoice on the page) stored as JSONB.
  seller             jsonb NOT NULL,   -- { name, gst, address:[string], phone, contact }
  customer           jsonb NOT NULL,   -- { attn, name, company, address:[string], phone, email }
  footer             jsonb NOT NULL,   -- { bankName, bankAcct, thankYou }

  freight_excl_gst   numeric(10,2) NOT NULL DEFAULT 0,
  subtotal_excl_gst  numeric(10,2) NOT NULL DEFAULT 0,  -- server-computed
  gst_amount         numeric(10,2) NOT NULL DEFAULT 0,  -- server-computed
  total_incl_gst     numeric(10,2) NOT NULL DEFAULT 0,  -- server-computed

  notes              text NULL,
  created_by         uuid NULL REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  emailed_at         timestamptz NULL,
  voided_at          timestamptz NULL
);

CREATE TABLE invoice_line_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position           integer NOT NULL DEFAULT 0,        -- preserve row order
  product_code       text NULL,
  description        text NULL,
  quantity           numeric(10,2) NOT NULL DEFAULT 1,
  unit_cost_excl_gst numeric(10,2) NOT NULL DEFAULT 0,
  line_total_excl_gst numeric(10,2) NOT NULL DEFAULT 0  -- = quantity * unit_cost_excl_gst
);

CREATE INDEX idx_invoices_number   ON invoices(invoice_number);
CREATE INDEX idx_invoices_status   ON invoices(status);
CREATE INDEX idx_invoices_issued   ON invoices(issue_date DESC);
CREATE INDEX idx_invoice_items_inv ON invoice_line_items(invoice_id);
-- Search uses invoice_number + customer name/email (customer->>'name', customer->>'email').
```

**Number assignment:** on create, if the client sends `invoice_number: null` (the normal case), assign `nextval('invoice_number_seq')` inside the insert transaction (concurrency-safe). Numbers may have gaps; that's acceptable. The operator does not type numbers.

**RLS / grants:** mirror the other admin tables — service-role / owner access only; make sure `EXECUTE`/`SELECT` grants are in place so you don't hit the silent-blank failure mode we've had before (revoked grants = empty admin screens).

---

## 3. Endpoints (exact contract the frontend already calls)

All under `/api/admin/invoices`. AdminAPI methods are in `inkcartridges/js/admin/api.js` (search `Standalone Invoices`).

### 3.1 `GET /api/admin/invoices`
List + search + paginate.
**Query:** `page` (1-based), `limit`, `search` (matches invoice_number, customer name, customer email), `status` (`unpaid|paid|draft|void`), `sort` (`invoice_number|issue_date|total`), `order` (`asc|desc`).
**Response:**
```json
{ "ok": true, "data": {
  "invoices": [
    { "id": "uuid", "invoice_number": 3254, "issue_date": "2026-06-26",
      "customer_name": "W F Hartley", "total_incl_gst": 106.49, "status": "unpaid" }
  ],
  "pagination": { "total": 42, "page": 1, "limit": 20 }
}}
```
> List rows MUST include flat `customer_name` and `total_incl_gst` (the table reads `r.customer_name` and `r.total_incl_gst`). `customer_name` = `customer->>'name'`.

### 3.2 `GET /api/admin/invoices/:id`
**Response:** `{ ok:true, data:{ invoice: <full record> } }` where the full record is the shape in §4. Include the `line_items` array (ordered by `position`).

### 3.3 `POST /api/admin/invoices`
Create. **Request body** (verbatim from frontend `buildPayload`):
```json
{
  "invoice_number": null,
  "status": "unpaid",
  "issue_date": "2026-06-26",
  "source_order_id": "uuid-or-null",
  "seller":   { "name": "Office Consumables Ltd", "gst": "94-509-459",
                "address": ["37A Archibald Road", "Kelston, Auckland 0602", "New Zealand"],
                "phone": "09 813 3882", "contact": "Trevor Walker" },
  "customer": { "attn": "William Hartley", "name": "W F Hartley", "company": "Motorola Country Estate",
                "address": ["146 / 5 Anderley Avenue", "Omokoroa 3143"],
                "phone": "6475481939", "email": "hartleyfm@yahoo.co.nz" },
  "line_items": [
    { "product_code": "CLC531XLKCMY", "description": "Brother Comp. LC531XL Ink Set of 4",
      "quantity": 1, "unit_cost_excl_gst": 92.60 }
  ],
  "freight_excl_gst": 0,
  "footer": { "bankName": "Office Consumables Ltd", "bankAcct": "01 0186 0335027 00",
              "thankYou": "Thank you very much for your business and for checking out InkCartridges.co.nz." },
  "notes": "",
  "preview_totals": { "subtotal": 92.60, "freight": 0, "gst": 13.89, "total": 106.49 }
}
```
**Behaviour:** assign `invoice_number` from the sequence; **recompute** subtotal/gst/total (§1); persist invoice + line items; **ignore `preview_totals`.**
**Response:** `{ ok:true, data:{ invoice: <full record incl. assigned invoice_number + computed totals> } }`.
The frontend reads `data.invoice.id` and `data.invoice.invoice_number` after save.

### 3.4 `PUT /api/admin/invoices/:id`
Update. Same body shape as create. Recompute totals. Reject edits to a `void` invoice (`{ ok:false, error:"Invoice is void" }`). Keep the existing `invoice_number`. Bump `updated_at`.
**Response:** `{ ok:true, data:{ invoice } }`.

### 3.5 `POST /api/admin/invoices/:id/void`
Set `status='void'`, `voided_at=now()`. Idempotent. **Response:** `{ ok:true, data:{ invoice } }`.

### 3.6 `POST /api/admin/invoices/:id/email`
Generate the PDF (§5) and email it to `customer.email` as an attachment. **Reuse the existing order invoice-email plumbing** (the same templating used by `POST /api/admin/orders/:id/resend-invoice`). Set `emailed_at=now()`. Fail with a clear error if `customer.email` is empty.
**Response:** `{ ok:true, data:{ emailed_at } }`.

### 3.7 `GET /api/admin/invoices/:id/pdf`
Return the rendered PDF.
**Response:** raw bytes, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="Invoice-<number>.pdf"`. Bearer-authed (the frontend fetches this with the access token and turns it into a blob — same pattern as the existing `GET /api/admin/audit/invoice-preview/:orderId`).

---

## 4. Full invoice record shape (returned by 3.2–3.5)

```json
{
  "id": "uuid",
  "invoice_number": 3254,
  "status": "unpaid",
  "issue_date": "2026-06-26",
  "source_order_id": null,
  "seller":   { "name": "...", "gst": "...", "address": ["...","..."], "phone": "...", "contact": "..." },
  "customer": { "attn": "...", "name": "...", "company": "...", "address": ["...","..."], "phone": "...", "email": "..." },
  "footer":   { "bankName": "...", "bankAcct": "...", "thankYou": "..." },
  "line_items": [
    { "product_code": "...", "description": "...", "quantity": 1,
      "unit_cost_excl_gst": 92.60, "line_total_excl_gst": 92.60 }
  ],
  "freight_excl_gst": 0,
  "subtotal_excl_gst": 92.60,
  "gst_amount": 13.89,
  "total_incl_gst": 106.49,
  "notes": "",
  "customer_name": "W F Hartley",
  "created_at": "2026-06-26T...Z",
  "updated_at": "2026-06-26T...Z",
  "emailed_at": null,
  "voided_at": null
}
```
The frontend `draftFromInvoice()` reads `address` as either an array or a string — arrays are preferred. `line_items` may also be returned as `lines`; arrays preferred under `line_items`.

---

## 5. PDF template (match the exemplar / on-screen preview)

The frontend already renders an on-screen preview that mirrors the operator's exemplar; reproduce that layout in the PDF. **Recommended:** reuse the renderer behind the existing `/api/admin/audit/invoice-preview/:orderId` (it already produces an order-invoice PDF in this house style) and feed it the invoice record.

Layout (A4, portrait):
- **Top-left** "Invoice from:" → **seller.name** (large bold) → `Invoice No: <number>`, `Date: <25th June 2026>` (ordinal day + month name), `Gst: <seller.gst>` → seller.address lines → `ph: <seller.phone>` → `Contact : <seller.contact>`.
- **Top-right** `Attn: <customer.attn>` (bold), then "Invoice To:" → **customer.name** (bold) → customer.company → address lines → phone → email.
- **Items table**, columns: `Product Code | Description | Number | Cost`, where **Cost = quantity × unit_cost_excl_gst** (line total, ex-GST), right-aligned; Number centered.
- **Totals** (right-aligned block): `Sub Total`, `Freight` (amount or "free" when 0), `GST`, **`Total`** (bold, underlined, GST-inclusive).
- **Payment footer**: "Please make payment to:" → `a/c Name: <footer.bankName>` → `a/c Number: <footer.bankAcct>`.
- **Thank-you** line (`footer.thankYou`).

Date format helper: `"2026-06-26"` → `"26th June 2026"`.

---

## 6. Validation

Reject (`{ ok:false, error }`, HTTP 422) when:
- `issue_date` missing/invalid.
- `line_items` empty or every line blank (no code, description, qty, or cost).
- `customer.name` empty.
- `status` not in the enum.
- Any `quantity`/`unit_cost_excl_gst`/`freight_excl_gst` negative or non-numeric.

Coerce/normalise: trim strings; default `freight_excl_gst` to 0; default `status` to `unpaid`.

---

## 7. Acceptance checklist

- [ ] Sequence seeded at current max invoice number; first new invoice continues the series (e.g. 3254).
- [ ] Create recomputes totals server-side and ignores `preview_totals`; exemplar inputs yield subtotal 92.60 / GST 13.89 / total 106.49.
- [ ] List returns flat `customer_name` + `total_incl_gst`; search hits invoice_number + customer name/email; status filter + sort work.
- [ ] GET `:id` returns the full record incl. ordered `line_items` and array `address` fields.
- [ ] PUT recomputes; void invoices are immutable.
- [ ] `:id/pdf` returns `application/pdf` (Bearer-authed) matching the exemplar layout.
- [ ] `:id/email` attaches the PDF and sends to `customer.email`, reusing existing email plumbing; sets `emailed_at`.
- [ ] All routes owner-gated (staff → 403); envelope is `{ ok, data }`; grants in place (no silent-blank).
- [ ] Once live, the frontend "just works" — it already calls every endpoint above; no frontend change needed (the client-side jsPDF download fallback simply stops being used for saved invoices).
```
