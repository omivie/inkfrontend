# Quick Orders — Backend Handoff (Jul 2026)

**Audience:** backend dev (ink-backend repo, Render → `https://ink-backend-zaeq.onrender.com`).
**Status:** Frontend is **complete and live-wired**; these endpoints + table **do not exist yet**. Until they do, the admin **Quick Order** page falls back gracefully — the list shows empty, and save/delete surface a clean error toast (no crash).

The frontend admin **Quick Order** page (`inkcartridges/js/admin/pages/quick-order.js`, owner-only, Sell section) is a **phone / walk-in order register**. When a customer rings to order (instead of checking out on the website), the operator looks up an existing customer or contact to auto-fill their details — or types a brand-new caller's details (optionally saving them as a reusable Contact) — then adds the products they want as searchable line items and saves. **Each save is one dated order line**; the same caller ringing today and again tomorrow makes two separate, searchable rows.

This is deliberately **separate from website Orders** (so it never pollutes sales analytics) and from Invoices (a quick order MAY become an invoice via the page's "Create invoice" bridge, but needn't).

> Delete this file once implemented — we don't keep handoff `.md`s in the repo long-term.

---

## 0. Conventions (must match existing admin API)

- **Response envelope:** `{ ok: true, data: ... }` on success, `{ ok: false, error: "message" }` on failure (HTTP 4xx/5xx). Existing site convention — do **not** use `{ success }`.
- **Auth:** all routes require the existing admin auth middleware **AND owner role** (same gate as `/api/admin/invoices`, `/api/admin/settings`). Bearer token in `Authorization`. Staff (non-owner) → 403.
- **Currency:** NZD. **GST rate: 15%.** All money `numeric(10,2)`, rounded half-up to 2dp.
- **Request-id:** thread `x-request-id` into errors as elsewhere.
- **Grants/RLS:** mirror the other admin tables — service-role / owner access only, `SELECT`/`EXECUTE` grants in place (revoked grants = silent-blank admin screens, a failure mode we've hit before).

---

## 1. GST / money model (authoritative — recompute server-side)

The frontend sends line prices **GST-EXCLUSIVE** and only sends `preview_totals` as an advisory display value. **Ignore `preview_totals`. Recompute server-side** from `line_items`:

```
line_total_excl_gst = quantity * unit_price_excl_gst          (per line, round 2dp)
subtotal_excl_gst   = Σ line_total_excl_gst
gst_amount          = round( subtotal_excl_gst * 0.15 , 2 )
total_incl_gst      = subtotal_excl_gst + gst_amount
```

(No freight on quick orders — freight/shipping is handled later if this becomes an invoice.)

---

## 2. Database schema (Supabase / Postgres)

```sql
CREATE TABLE quick_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_date        date NOT NULL DEFAULT CURRENT_DATE,   -- the date the order was TAKEN (operator-set, searchable)

  -- Party snapshot. Stored on the row even when linked to a contact/customer so
  -- the record is self-contained (the caller's details at time of order).
  customer_name     text NULL,
  customer_company  text NULL,
  customer_email    text NULL,
  customer_phone    text NULL,
  bill_to           jsonb NULL,   -- { name, company, phone, email, address:[string] }

  -- Optional links to existing records (nullable — a brand-new caller has neither).
  contact_id        uuid NULL REFERENCES contacts(id) ON DELETE SET NULL,
  customer_id       uuid NULL REFERENCES customers(id) ON DELETE SET NULL,

  subtotal_excl_gst numeric(10,2) NOT NULL DEFAULT 0,   -- server-computed
  gst_amount        numeric(10,2) NOT NULL DEFAULT 0,   -- server-computed
  total_incl_gst    numeric(10,2) NOT NULL DEFAULT 0,   -- server-computed

  notes             text NULL,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','invoiced','cancelled')),
  created_by        uuid NULL REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quick_order_line_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quick_order_id      uuid NOT NULL REFERENCES quick_orders(id) ON DELETE CASCADE,
  position            integer NOT NULL DEFAULT 0,        -- preserve row order
  product_code        text NULL,
  description         text NULL,
  quantity            numeric(10,2) NOT NULL DEFAULT 1,
  unit_price_excl_gst numeric(10,2) NOT NULL DEFAULT 0,
  line_total_excl_gst numeric(10,2) NOT NULL DEFAULT 0   -- = quantity * unit_price_excl_gst
);

CREATE INDEX idx_quick_orders_date   ON quick_orders(order_date DESC);
CREATE INDEX idx_quick_orders_status ON quick_orders(status);
CREATE INDEX idx_qo_items_order      ON quick_order_line_items(quick_order_id);
```

> `contacts` / `customers` FK targets: if the contacts table isn't live yet, make `contact_id` a plain nullable `uuid` (no FK) for now — the frontend only ever sends the id back, it doesn't require referential integrity.

---

## 3. Search requirement (the core feature — read carefully)

The list's single search box must let the operator **find every order line of a given caller**, plus filter by date. `search` (case-insensitive, partial) must match **any** of:

- `customer_name`, `customer_company`, `customer_email`, `customer_phone`
- `bill_to->>'name'`, `bill_to->>'email'`, `bill_to->>'phone'`
- **product codes / descriptions** on the child line items (`quick_order_line_items.product_code` / `description`) — so "find every order that included CLI-651" works
- **the date** — if `search` parses as a date (e.g. `2026-07-03`) or a partial (`Jul 2026`), match `order_date`. (Simplest acceptable version: also match `order_date::text ILIKE %search%`.)

Because the same person appears on multiple rows (one per call), searching their name/email/phone returns all their historical quick orders — that's the intended behaviour, do **not** dedupe by customer.

---

## 4. Endpoints (exact contract the frontend already calls)

All under `/api/admin/quick-orders`. AdminAPI methods are in `inkcartridges/js/admin/api.js` (search `Quick Orders`).

### 4.1 `GET /api/admin/quick-orders`
List + search + paginate.
**Query:** `page` (1-based), `limit`, `search` (see §3), `sort` (`order_date|total`), `order` (`asc|desc`). Default sort `order_date desc`.
**Response:**
```json
{ "ok": true, "data": {
  "quick_orders": [
    { "id": "uuid", "order_date": "2026-07-03",
      "customer_name": "Glenys McBain", "customer_email": "geesmcb@outlook.co.nz",
      "customer_phone": "021 555 0102",
      "line_items": [ { "product_code": "CLI-651BK", "description": "Canon ink black", "quantity": 2 } ],
      "item_count": 2, "total_incl_gst": 69.00, "status": "open" }
  ],
  "pagination": { "total": 12, "page": 1, "limit": 20 }
}}
```
> List rows MUST include flat `customer_name`, `customer_email`/`customer_phone`, `total_incl_gst`, and either an `item_count` **or** the `line_items` array (the table reads `r.item_count` else `line_items.length`, and shows the first line's `product_code`).

### 4.2 `GET /api/admin/quick-orders/:id`
**Response:** `{ ok:true, data:{ quick_order: <full record> } }` (shape in §5), incl. `line_items` ordered by `position`.

### 4.3 `POST /api/admin/quick-orders`
Create. **Request body** (verbatim from frontend `buildPayload`):
```json
{
  "order_date": "2026-07-03",
  "contact_id": null,
  "customer_id": null,
  "customer_name": "Glenys McBain",
  "customer_company": "",
  "customer_phone": "021 555 0102",
  "customer_email": "geesmcb@outlook.co.nz",
  "bill_to": { "name": "Glenys McBain", "company": "", "phone": "021 555 0102",
               "email": "geesmcb@outlook.co.nz", "address": ["12 Queen St", "Auckland 1010"] },
  "line_items": [
    { "product_code": "CLI-651BK", "description": "Canon ink black", "quantity": 2, "unit_price_excl_gst": 18.50 },
    { "product_code": "PG-645XL",  "description": "Canon ink pigment", "quantity": 1, "unit_price_excl_gst": 32.00 }
  ],
  "notes": "",
  "preview_totals": { "subtotal": 69.00, "gst": 10.35, "total": 79.35 }
}
```
**Behaviour:** persist the order + line items; **recompute** subtotal/gst/total (§1); **ignore `preview_totals`**; default `status='open'`, `order_date` to today if absent.
**Response:** `{ ok:true, data:{ quick_order: <full record incl. computed totals> } }`. The frontend reads `data.quick_order.id`.

### 4.4 `PUT /api/admin/quick-orders/:id`
Update. Same body shape as create. Recompute totals. Bump `updated_at`.
**Response:** `{ ok:true, data:{ quick_order } }`.

### 4.5 `DELETE /api/admin/quick-orders/:id`
Hard-delete (operator cleanup of a mistaken record). Cascade the line items.
**Response:** `{ ok:true, data:{ deleted: true } }`.

---

## 5. Full record shape (returned by 4.2–4.4)

```json
{
  "id": "uuid",
  "order_date": "2026-07-03",
  "status": "open",
  "contact_id": null,
  "customer_id": null,
  "customer_name": "Glenys McBain",
  "customer_company": "",
  "customer_email": "geesmcb@outlook.co.nz",
  "customer_phone": "021 555 0102",
  "bill_to": { "name": "...", "company": "...", "phone": "...", "email": "...", "address": ["...","..."] },
  "line_items": [
    { "product_code": "CLI-651BK", "description": "Canon ink black", "quantity": 2,
      "unit_price_excl_gst": 18.50, "line_total_excl_gst": 37.00 }
  ],
  "subtotal_excl_gst": 69.00,
  "gst_amount": 10.35,
  "total_incl_gst": 79.35,
  "notes": "",
  "created_at": "2026-07-03T...Z",
  "updated_at": "2026-07-03T...Z"
}
```
The frontend `draftFromRecord()` reads `bill_to.address` as either an array or a string (arrays preferred), and `line_items` may also be returned as `lines` (arrays under `line_items` preferred).

---

## 6. Validation

Reject (`{ ok:false, error }`, HTTP 422) when:
- `line_items` empty or every line blank (no code, description, qty, or price).
- both `customer_name` and `customer_company` empty (must identify the caller).
- any `quantity`/`unit_price_excl_gst` negative or non-numeric.
- `status` (if sent) not in the enum.

Coerce/normalise: trim strings; default `order_date` to today; default `status` to `open`.

---

## 7b. Dependency — product image fields on `GET /api/admin/products`

The Quick Order **and** Invoices product-line search now renders a storefront-style
dropdown with a **product thumbnail** per result. It calls the existing
`GET /api/admin/products?search=&page=&limit=` and reads the image from (in order)
`images[0]` / `primary_image` / `image_url` on each product row.

**Action:** ensure that endpoint's product rows include a usable image field
(`image_url` as a full URL, or `images: [{ image_url | path }]`). If a row has no
image field the frontend degrades gracefully to a placeholder tile — not broken,
but no thumbnail. The rows already return `sku`, `name`, and `retail_price`
(GST-inclusive), which the picker also uses; no change needed there.

No new endpoint — this is just a field-presence check on an endpoint you already
serve.

---

## 7. Acceptance checklist

- [ ] `quick_orders` + `quick_order_line_items` tables created, indexed, owner-gated grants in place (no silent-blank).
- [ ] Create/PUT recompute totals server-side and ignore `preview_totals`; example inputs yield subtotal 69.00 / GST 10.35 / total 79.35.
- [ ] List returns flat `customer_name` + `customer_email`/`phone` + `total_incl_gst` + `item_count`/`line_items`; pagination works; default sort `order_date desc`.
- [ ] **Search matches customer name/email/phone AND product code/description AND date** (§3); the same caller's multiple orders all return (no dedupe).
- [ ] GET `:id` returns the full record incl. ordered `line_items` and array `bill_to.address`.
- [ ] DELETE cascades line items.
- [ ] All routes owner-gated (staff → 403); envelope `{ ok, data }`.
- [ ] Once live the frontend "just works" — it already calls every endpoint above; no frontend change needed.
```
