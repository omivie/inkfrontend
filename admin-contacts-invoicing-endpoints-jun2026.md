# Backend handoff — Admin Contacts + Customer Invoicing Profile (Jun 2026)

**To:** backend Claude (ink-backend repo)
**From:** frontend (matcha/FEINK)
**Status:** Frontend is SHIPPED and fails soft — every endpoint below 404s today and the UI degrades gracefully (empty lists / clean toasts). Implement these to make the feature live. No frontend changes needed once the shapes below are honoured.

---

## 1. Why / context

Invoice creation in the admin was slow: a customer record stored **no address** (it was scraped from their latest order), and there was no way to keep a reusable billing/delivery party. We added:

1. **Contacts** — a manually-entered address book of billing/delivery parties (accountants, resellers, "head office"), holding every *non-goods* invoice field. Surfaced as a tab inside the Customers page and selectable in the Invoices editor's "Fill details from…" picker.
2. **Customer invoicing profile** — a reusable bill-to / deliver-to profile saved on a customer, used to pre-fill invoices (preferred over scraping their latest order).

Both are **non-goods only** (no prices, no line items, no GST) — they fill the *parties* on an invoice, nothing financial.

---

## 2. Conventions (must match existing API)

- **Envelope:** every response is `{ ok: true, data: {...} }` on success, `{ ok: false, error: { message, code? } }` on failure. (Same as all `/api/admin/*` routes.)
- **Auth:** all routes require the existing admin auth middleware (Bearer token, admin role). The customer invoicing editor is **owner-gated on the frontend**; at minimum require admin, and ideally restrict the invoicing PUT to owner role to match.
- **Addresses are `string[]`** on the wire — one element per address line — identical to the invoice payload convention (`POST /api/admin/invoices` already sends `address` as an array). Do **not** store/return addresses as a single newline string; the frontend splits/join s lines itself.
- **Currency/GST:** N/A here. These objects carry no monetary fields.

---

## 3. Data shapes

### Contact object
```jsonc
{
  "id": "uuid",
  "label": "Acme Ltd – Accounts",          // list display name; required (FE falls back to bill_to.name/company if blank)
  "bill_to": {
    "attn":    "Jane Doe",
    "name":    "Acme Ltd",
    "company": "Acme Holdings Ltd",
    "phone":   "09 123 4567",
    "email":   "accounts@acme.co.nz",
    "address": ["12 Queen St", "Auckland 1010", "New Zealand"]   // string[]
  },
  "deliver_to": {                            // optional; goods delivery party
    "attn":    "Warehouse",
    "company": "Acme DC",
    "phone":   "09 123 9999",
    "address": ["8 Dock Rd", "Penrose", "Auckland 1061"]          // string[]
  },
  "notes": "PO required on all invoices",    // default note pre-filled onto invoices
  "created_at": "2026-06-29T...",
  "updated_at": "2026-06-29T..."
}
```

### Customer invoicing profile (subset of the above — no `label`, no `notes`)
```jsonc
{
  "bill_to":   { "attn": "", "name": "", "company": "", "phone": "", "email": "", "address": ["…"] },
  "deliver_to":{ "attn": "", "company": "", "phone": "", "address": ["…"] }
}
```

---

## 4. Endpoints to implement

### 4.1 Contacts CRUD — base `/api/admin/contacts`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/contacts?page=1&limit=20&search=&sort=&order=` | List + search + paginate |
| GET | `/api/admin/contacts/:id` | Fetch one |
| POST | `/api/admin/contacts` | Create |
| PUT | `/api/admin/contacts/:id` | Update (full replace of the editable fields) |
| DELETE | `/api/admin/contacts/:id` | Hard delete |

**GET (list) response** — FE reads `data.contacts` (also tolerates a bare array or `data.data`) and `data.pagination`:
```jsonc
{ "ok": true, "data": {
  "contacts": [ { /* Contact object */ } ],
  "pagination": { "total": 42, "page": 1, "limit": 20 }
} }
```
- `search` must match **label, bill_to.company, and bill_to.email** (case-insensitive, partial). The invoice picker calls this with `limit=6`.
- `sort`/`order` optional (e.g. `label` asc). Default sort by `label` or `updated_at desc` is fine.

**GET (one) / POST / PUT response** — FE reads `data.contact` (tolerates bare `data`):
```jsonc
{ "ok": true, "data": { "contact": { /* full Contact object incl. id */ } } }
```
- **POST** body = Contact without `id` (label + bill_to + deliver_to + notes). Return the created record (with `id`).
- **PUT** body = same editable fields; return the updated record.
- **DELETE** response: `{ "ok": true, "data": { "deleted": true } }` (FE only checks `ok`).

### 4.2 Customer invoicing profile

| Method | Path | Purpose |
|--------|------|---------|
| PUT | `/api/admin/customers/:id/invoicing` | Save the customer's invoicing profile |

**PUT body** = the Customer invoicing profile object (§3). **Response** — FE reads `data.customer` (tolerates bare `data`):
```jsonc
{ "ok": true, "data": { "customer": { "id": "…", "invoicing": { "bill_to": {…}, "deliver_to": {…} } } } }
```

**IMPORTANT — also extend the existing customers list:** `GET /api/admin/customers` rows must now include the saved `invoicing` object (or `null` if none). The Invoices editor's `loadFromCustomer()` reads `customer.invoicing.bill_to` / `.deliver_to` directly off the search result to pre-fill **without a second round-trip**. If `invoicing` is absent the FE silently falls back to scraping the customer's latest order address (current behaviour), so this is non-breaking — but the feature only shines once `invoicing` is returned on the rows.

---

## 5. Suggested DB schema

Simplest is JSONB for the nested party objects.

```sql
-- Contacts address book
create table contacts (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  bill_to     jsonb not null default '{}'::jsonb,   -- {attn,name,company,phone,email,address:[]}
  deliver_to  jsonb default '{}'::jsonb,            -- {attn,company,phone,address:[]}
  notes       text default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- search support (label/company/email)
create index contacts_search_idx on contacts using gin (
  to_tsvector('simple', coalesce(label,'') || ' ' ||
    coalesce(bill_to->>'company','') || ' ' || coalesce(bill_to->>'email',''))
);

-- Customer invoicing profile: add a column to the customers/users table
alter table customers add column if not exists invoicing jsonb;  -- {bill_to:{…}, deliver_to:{…}} or null
```
(`address` arrays live inside the JSONB as JSON arrays of strings.)

---

## 6. Validation

- `label` (contacts): required, ≤ 200 chars. If the FE sends an empty label it will have already substituted `bill_to.name`/`company`, but guard anyway.
- All party string fields: optional, trim, reasonable max (e.g. 200). `email`: optional, validate format if present.
- `address`: array of strings; drop empties; cap ~8 lines.
- `notes`: optional, ≤ 2000.
- On validation failure return `{ ok:false, error:{ message, code:'VALIDATION_FAILED' } }` (FE surfaces `error.message` in a toast).

---

## 7. Frontend call sites (for shape verification)

All in `matcha/FEINK`:
- `inkcartridges/js/admin/api.js` — `listContacts / getContact / createContact / updateContact / deleteContact / updateCustomerInvoicing` (read `resp.data.contact` / `resp.data.contacts` + `pagination` / `resp.data.customer`).
- `inkcartridges/js/admin/pages/contacts.js` — list + drawer editor (builds the Contact payload; address via `textToLines` → `string[]`).
- `inkcartridges/js/admin/pages/customers.js` — `invoicingBlock` / `collectInvoicing` (builds the invoicing payload) + reads `customer.invoicing` back.
- `inkcartridges/js/admin/pages/invoices.js` — `attachTopAutocompletes` (unified picker fetches `listContacts` + `getCustomers`), `loadFromContact`, `loadFromCustomer` (prefers `c.invoicing`).

---

## 8. Acceptance checklist

- [ ] `GET /api/admin/contacts` returns `{ok,data:{contacts,pagination}}`; `search=acme` matches label/company/email.
- [ ] `POST` then `GET /:id` round-trips all fields incl. `address` as `string[]` (not a joined string).
- [ ] `PUT /:id` updates; `DELETE /:id` returns `{ok:true}` and the row is gone.
- [ ] `PUT /api/admin/customers/:id/invoicing` persists and echoes `data.customer.invoicing`.
- [ ] `GET /api/admin/customers` rows now carry `invoicing` (object or null).
- [ ] All routes require admin auth; invoicing PUT ideally owner-only.
- [ ] Errors use `{ok:false,error:{message,...}}`.

---

## 9. Curl smoke tests

```bash
TOKEN="<admin bearer>"
BASE="https://ink-backend-zaeq.onrender.com"

# create
curl -s -X POST "$BASE/api/admin/contacts" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "label":"Acme Ltd – Accounts",
    "bill_to":{"name":"Acme Ltd","company":"Acme Holdings","email":"accounts@acme.co.nz",
               "phone":"09 123 4567","address":["12 Queen St","Auckland 1010"]},
    "deliver_to":{"company":"Acme DC","address":["8 Dock Rd","Penrose"]},
    "notes":"PO required"}'

# list + search
curl -s "$BASE/api/admin/contacts?search=acme&limit=6" -H "Authorization: Bearer $TOKEN"

# customer invoicing profile
curl -s -X PUT "$BASE/api/admin/customers/<CUSTOMER_ID>/invoicing" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "bill_to":{"name":"Jane Doe","email":"jane@x.co.nz","address":["1 High St","Wellington 6011"]},
    "deliver_to":{"address":["Rear entrance","1 High St"]}}'
```

When all green, the admin Contacts tab, the Customers-drawer invoicing editor, and the Invoices "Fill details from…" picker all go live with zero frontend changes.
