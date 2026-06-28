# Invoice Delete — Backend Handoff (Jun 2026)

**Audience:** backend dev (ink-backend repo, Render → `https://ink-backend-zaeq.onrender.com`).
**Status:** Frontend is **complete and live-wired**. The admin Invoices page now has two
distinct row actions — **Void** (already implemented: `POST /api/admin/invoices/:id/void`)
and a new **Delete** (permanent removal). The Delete endpoint below **does not exist yet**
(`DELETE /api/admin/invoices/:id` currently returns 404 `NOT_FOUND`). Until it ships, the
frontend Delete button fails soft with a clean toast ("Delete isn't available yet (backend
endpoint pending).") and never crashes the page.

> Delete this file once implemented — we don't keep handoff `.md`s in the repo long-term.

---

## Why this exists

Void marks an invoice `status='void'` but keeps the row for records — correct for real
invoices. Operators also need to **permanently remove** test / mistaken invoices so they
stop cluttering the list. That's a hard delete, distinct from void.

- **Void** (trash-was-here, now a slash-circle icon): keep — records retained.
- **Delete** (trash icon): NEW — permanent removal, for cleanup of test/erroneous invoices.

---

## Endpoint contract (exact shape the frontend calls)

AdminAPI method: `deleteInvoice(id)` in `inkcartridges/js/admin/api.js`
(next to `voidInvoice`) → `window.API.delete('/api/admin/invoices/:id')`.

### `DELETE /api/admin/invoices/:id`

- **Auth:** existing admin middleware **AND owner role** — same gate as the other
  `/api/admin/invoices` routes (`/void`, `/email`, `/pdf`, create/update). Staff (non-owner) → **403**.
- **Behaviour:** hard-delete the `invoices` row for `:id`. `invoice_line_items` rows
  cascade automatically (`ON DELETE CASCADE`, per the invoicing handoff schema). Also
  delete the stored PDF object `invoices/<id>.pdf` from Supabase Storage if present
  (best-effort; don't fail the delete if the object is missing).
- **Unknown id:** **404** `{ ok:false, error:{ code:"NOT_FOUND", message:"Invoice not found" } }`.
  (Treating a repeat delete of an already-removed id as 404 is fine — the frontend just
  shows the error toast; the row is already gone after reload.)
- **Success:** **200** `{ ok:true, data:{ deleted:true } }` (a `204 No Content` is also
  accepted — the frontend's `API.delete` maps 204 to `{ ok:true, data:null }`).
- **Envelope:** house style — success `{ ok:true, data }`; error
  `{ ok:false, error:{ code, message, details? } }`. Thread `x-request-id` into errors.

---

## Acceptance checklist

- [ ] `DELETE /api/admin/invoices/:id` (owner) hard-deletes the invoice + cascaded line items → `200 { ok:true, data:{ deleted:true } }`.
- [ ] Stored `invoices/<id>.pdf` is removed from Storage (no orphaned files); missing object doesn't fail the request.
- [ ] Unknown id → `404 NOT_FOUND`.
- [ ] Non-owner → `403`.
- [ ] After it ships, the frontend "just works": clicking **Delete** removes the row and shows "Invoice deleted." (no frontend change needed — already wired).

---

## Quick test (curl)

```bash
TOKEN="<owner supabase access_token>"
BASE="https://ink-backend-zaeq.onrender.com"
ID="<an existing invoice id>"

curl -s -X DELETE "$BASE/api/admin/invoices/$ID" \
  -H "Authorization: Bearer $TOKEN" | jq
# expect: { "ok": true, "data": { "deleted": true } }

# verify it's gone
curl -s "$BASE/api/admin/invoices/$ID" -H "Authorization: Bearer $TOKEN" | jq
# expect: 404 NOT_FOUND
```
