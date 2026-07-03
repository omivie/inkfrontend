# Backend handoff — Invoice payment due date (saved contact term + manual override)

**Date:** 3 Jul 2026
**Repo:** backend = `ink-backend-zaeq` (Render, separate repo). Frontend = `inkcartridges/` (this repo, already shipped).
**Audience:** backend developer.
**Status of frontend:** ✅ DONE and shipped. It already sends the two new fields on every save and reads them back on load. Unknown keys are currently ignored by the API, so nothing is persisted yet and nothing is broken. Your job is to persist + echo them, and mirror the one-line footer on the server-side PDF.

---

## 1. Why this exists

The invoice "payment due by" date used to be **derived only** — hard-coded to the 20th of the month after the order month, with no way to save a per-customer term or override it. The owner wanted:

1. A **one-line** footer: `Payment due by 20th July 2026, please make payment to:` (was two lines). ✅ done client-side for the FE-rendered PDF.
2. A **saved payment term on the contact** — `10th / 20th / 30th / end of month` of the following month, default **20th**. Invoices filled from that contact adopt the term.
3. A **manual override** of the due date on the invoice itself.

The FE now computes the effective due date (`override || derive(order_date, term)`) and sends it as `payment_due`. The backend needs to store both new fields and render the same one-liner on the **customer-facing** PDF (`GET /invoices/:id/pdf` + email), so downloads/emails match the admin copy.

---

## 2. What the frontend already does (no action needed — for context)

**Contacts** — the contact editor now has a "Payment terms" select. On create/update the payload gains:
```
payment_due_pref: "10" | "20" | "30" | "eom"   // default "20"
```
sent to `POST /api/admin/contacts` and `PUT /api/admin/contacts/:id`, alongside the existing `bill_to`, `deliver_to`, `label`, `notes`.

**Invoices** — the invoice editor has a new editable "Payment due date" input. On create/update the payload gains:
```
payment_due:      "YYYY-MM-DD" | null   // the resolved due date (manual override OR derived)
payment_due_pref: "10"|"20"|"30"|"eom" | null   // the term used (for reference/audit)
```
sent to the existing `POST/PUT /api/admin/invoices[/:id]` alongside `order_date`, `line_items`, `footer`, etc.

On load, the FE reads `rec.payment_due` (locks the field to what was saved) and `rec.payment_due_pref` (falls back to `"20"`).

**Derivation rule** (for the server PDF fallback): month = **the month after `order_date`'s month** (roll Dec → Jan next year); day = the term (`10/20/30`), **clamped to the month's length**; `eom` = the last day of that month. Default term `"20"`. Formatting is an ordinal date, e.g. `20th July 2026`.

---

## 3. Tasks

### Task A — Contacts: persist `payment_due_pref`
- Add a column to the contacts table, e.g. `payment_due_pref TEXT NOT NULL DEFAULT '20'` (allowed values `'10' | '20' | '30' | 'eom'`; validate, default `'20'` on anything else/absent).
- Accept it on `POST /api/admin/contacts` and `PUT /api/admin/contacts/:id`.
- Return it on `GET /api/admin/contacts` (list) and `GET /api/admin/contacts/:id`.

### Task B — Invoices: persist `payment_due` + `payment_due_pref`
- Add `payment_due DATE NULL` and `payment_due_pref TEXT NULL` to the `invoices` table.
- Accept both on invoice create/update. Store `payment_due` verbatim (it is the resolved date — do **not** recompute over it).
- Return both on invoice get/list so the editor round-trips.

### Task C — Server-side PDF + email: mirror the one-line footer
- In the backend invoice PDF generator (the fallback used by `GET /invoices/:id/pdf` and the email attachment when no FE-uploaded PDF is stored — see `invoice-pdf-sync-backend-handoff-jun2026.md`), replace the two-line payment block with a **single bold line**:
  ```
  Payment due by <ordinal date>, please make payment to:
  ```
  followed by the existing `a/c Name` / `a/c Number` rows.
- Date to use: stored `payment_due` if present; otherwise derive from `order_date` + `payment_due_pref` (default `"20"`) using the rule in §2. If there's no `order_date` either, omit the "Payment due by …," prefix and print just `Please make payment to:`.

> Note: once the FE-rendered-PDF-as-source-of-truth work (that other handoff) is live, the FE PDF already carries this one-liner, so Task C only affects **pre-feature** invoices and any backend-generated fallback. Still worth doing so the two never diverge.

---

## 4. Conventions (house style)
- **Auth:** Supabase JWT `Authorization: Bearer <token>`, super_admin only (same as all `/api/admin/*`).
- **Envelope:** success `{ ok:true, data }`; error `{ ok:false, error:{ code, message, details? } }`.
- **Existing routes touched:** contacts (list/get/create/update), invoices (list/get/create/update), invoice pdf + email generators.

---

## 5. Acceptance criteria
1. Create a contact with `payment_due_pref:"30"` → GET returns `"30"`. Absent/invalid → `"20"`.
2. Save an invoice with `payment_due:"2026-08-31"` → GET returns exactly `2026-08-31`; editor reopens showing that date.
3. Save an invoice with `payment_due:null` but `order_date:"2026-06-15"`, `payment_due_pref:"eom"` → backend PDF prints `Payment due by 31st July 2026, please make payment to:`.
4. `payment_due_pref:"30"` with a following month of February → derived day clamps to 28/29.
5. Server PDF / email footer is a single line; no invoice shows the old two-line split.

---

*Per team convention (no lingering handoff files in the repo): delete this file once the backend work is merged and deployed.*
