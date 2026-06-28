# Backend handoff — Invoice PDF sync (frontend-rendered PDF is the source of truth)

**Date:** 28 Jun 2026
**Repo:** backend = `ink-backend-zaeq` (Render, separate repo). Frontend = `inkcartridges/` (this repo, already shipped).
**Audience:** backend developer.
**Status of frontend:** ✅ DONE and live. The frontend already uploads its rendered PDF on every save. It currently receives **HTTP 404** (endpoint doesn't exist) and swallows it gracefully — nothing is stored yet. Your job is the three backend changes below.

---

## 1. Why this exists

The admin invoice editor renders a polished "TAX INVOICE" PDF **client-side** (jsPDF). That client PDF is what the admin downloads.

Problem: the **customer-facing** PDF — what `GET /api/admin/invoices/:id/pdf` returns and what the **email** endpoint attaches — is generated **separately by the backend**, in an older layout. So the admin download and the customer copy look different, and any future design change the frontend makes does **not** reach customers.

**Goal:** make the **frontend-rendered PDF the single source of truth.** The frontend uploads the exact PDF on save; the backend stores it and serves/attaches that stored file. After this one-time wiring, every future frontend layout change automatically flows to downloads **and** emails with no backend redeploy.

---

## 2. What the frontend already does (no action needed — for your context)

On every successful invoice **save** (create *or* update), after the existing `POST/PUT /api/admin/invoices[/:id]` call returns, the frontend:

1. Reads the authoritative totals from your save response (so the PDF matches your numbers — see §5).
2. Renders the invoice to a PDF with jsPDF.
3. Uploads it by calling:

```
POST /api/admin/invoices/:id/pdf
Authorization: Bearer <supabase access_token>     (same super_admin auth as all other admin invoice routes)
Content-Type: application/json

{
  "pdf_base64": "<RAW base64 of the PDF bytes — NO 'data:application/pdf;base64,' prefix>",
  "filename":   "Invoice-3258.pdf"
}
```

This upload is **best-effort** on the frontend: a 404 or any error is logged as a warning and never blocks the save or shows the user an error. So you can deploy the three changes below in any order without breaking the current UX.

---

## 3. Tasks

### Task A — NEW endpoint: store the uploaded PDF
```
POST /api/admin/invoices/:id/pdf
Auth: super_admin (same middleware as the other /api/admin/invoices routes)
Body (JSON): { "pdf_base64": string, "filename": string }
```
Behaviour:
- Validate `:id` exists (404 `NOT_FOUND` if not). Reject if the invoice is **void** (409 `CONFLICT "Invoice is void"`) — keep parity with the existing PUT behaviour.
- `Buffer.from(pdf_base64, 'base64')` → upload to **Supabase Storage**, bucket `invoices` (private), path `invoices/<id>.pdf`, **upsert = true** (re-saves overwrite, keeping the stored copy in sync with edits), `contentType: 'application/pdf'`.
- Optionally record `pdf_path` / `pdf_updated_at` on the `invoices` row (handy but not required).
- Success response (house envelope):
  ```json
  { "ok": true, "data": { "stored": true, "path": "invoices/<id>.pdf" } }
  ```
- Size guard: accept up to ~5 MB (these PDFs are ~10–20 KB; base64 inflates ~33%). Return 413 / 400 if absurdly large.

### Task B — CHANGE `GET /api/admin/invoices/:id/pdf`
- If a stored file exists at `invoices/<id>.pdf`, **stream/return that file** with `Content-Type: application/pdf` (and `Content-Disposition: inline; filename="Invoice-<number>.pdf"`).
- **Fallback:** if no stored file exists (invoices saved before this feature shipped), keep the **current backend generator** so old invoices still produce something. Do not 404.

### Task C — CHANGE the email endpoint `POST /api/admin/invoices/:id/email`
- Attach the **stored** `invoices/<id>.pdf` to the customer email.
- Same fallback: if no stored file, fall back to the current backend-generated PDF (or call the generator once and store it, then attach).
- Everything else about emailing (recipient, subject, RESEND wiring) stays as-is.

---

## 4. Storage notes

- Bucket: **`invoices`**, **private** (do not make public). Create it if it doesn't exist.
- Path: **`invoices/<invoice_id>.pdf`** — keyed by the invoice UUID (stable across re-saves; `filename` from the request is only a display hint).
- Serving: stream through the API with the existing auth, **or** generate a short-lived signed URL — your call. Do not expose the bucket publicly.
- Overwrite on every upload (upsert) so the stored copy always reflects the latest save.

---

## 5. Totals authority (important)

The backend remains the **source of truth for GST and totals.** The frontend renders the PDF using the totals it reads back from your save response, so the stored PDF agrees with your records. To make this robust, your **create/update invoice response** should include the computed totals on the invoice object. The frontend reads them **tolerantly** — it accepts any of these field names (first match wins):

| Concept            | Field names the frontend looks for (in order)                     |
|--------------------|--------------------------------------------------------------------|
| Subtotal (ex-GST)  | `subtotal_excl_gst`, `subtotal`, `sub_total`                       |
| GST amount         | `gst_amount`, `gst`, `tax_amount`                                  |
| Total (incl-GST)   | `total_incl_gst`, `total`, `grand_total`                          |
| Freight (ex-GST)   | `freight_excl_gst`, `freight`, `shipping_excl_gst`                 |

If none are present, the frontend falls back to its own computation (same GST math — 15%, line subtotals ex-GST, GST added on top, freight 0 ⇒ "Free"), which matches the existing exemplar (e.g. 92.60 / 13.89 / 106.49). Returning the totals explicitly is preferred so there's zero chance of divergence.

---

## 6. Conventions (house style — match existing invoice routes)

- **Auth:** Supabase JWT `Authorization: Bearer <token>`, super_admin only.
- **Response envelope:** success `{ ok: true, data: {...} }`; error `{ ok: false, error: { code, message, details? } }`. (The frontend unwraps `error.message` and appends `error.details[]`.)
- **Error codes already in use:** `VALIDATION_FAILED` (400), `CONFLICT` (409, e.g. "Invoice is void"), `NOT_FOUND` (404).
- **Existing tables:** `invoices`, `invoice_line_items`, `invoice_number_seq`. Existing routes: list / get / create / update / void / email / pdf (the 7 invoice routes).

---

## 7. Acceptance criteria

1. `POST /api/admin/invoices/:id/pdf` with `{ pdf_base64, filename }` → **200** `{ ok:true, data:{ stored:true } }`, and `invoices/<id>.pdf` exists in Supabase Storage with the exact bytes.
2. Re-uploading for the same id **overwrites** the stored file (no duplicates).
3. `GET /api/admin/invoices/:id/pdf` returns the **stored** file (`application/pdf`) when present; falls back to the generator when absent (no 404 for valid ids).
4. `POST /api/admin/invoices/:id/email` attaches the **stored** file when present; falls back otherwise.
5. Void invoice → upload returns **409 `CONFLICT`**.
6. Unknown id → **404 `NOT_FOUND`**.
7. Non-super_admin → **401/403** (same as other admin routes).

### Quick test (curl)
```bash
TOKEN="<super_admin supabase access_token>"
BASE="https://ink-backend-zaeq.onrender.com"
ID="<an existing, non-void invoice id>"

# A) store
B64=$(base64 -i sample.pdf | tr -d '\n')
curl -s -X POST "$BASE/api/admin/invoices/$ID/pdf" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"pdf_base64\":\"$B64\",\"filename\":\"Invoice-test.pdf\"}" | jq

# B) fetch it back — should be the bytes you just uploaded
curl -s "$BASE/api/admin/invoices/$ID/pdf" -H "Authorization: Bearer $TOKEN" -o out.pdf
cmp sample.pdf out.pdf && echo "stored file matches upload"

# C) email it — should attach the stored PDF
curl -s -X POST "$BASE/api/admin/invoices/$ID/email" -H "Authorization: Bearer $TOKEN" | jq
```

To verify end-to-end through the UI once deployed: open `/admin#invoices` → **New Invoice** → fill it → **Save** → the frontend POSTs the PDF (watch for `POST /invoices/:id/pdf → 200` instead of 404 in the network tab). Then click the row's **Download PDF** (or email it) and confirm it's the "TAX INVOICE" layout.

---

## 8. Out of scope / notes

- **Snapshot semantics:** the stored PDF reflects the layout at the moment of save. To refresh the look of *old* invoices after a future redesign, they must be re-saved (or add a one-off backend re-render/backfill job — not required now).
- No frontend changes are required for this work; the frontend half is already deployed and waiting for the endpoint.
- Once this is live, the backend's standalone PDF generator becomes a **fallback only** (for pre-feature invoices) — you may eventually retire it.

---

*Per the team convention (no lingering handoff files in the repo): delete this file once the backend work is merged and deployed.*
