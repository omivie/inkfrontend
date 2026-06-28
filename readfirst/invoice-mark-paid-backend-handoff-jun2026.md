# Invoice Mark-Paid — Backend Handoff (Jun 2026)

**Audience:** backend dev (ink-backend repo, Render → `https://ink-backend-zaeq.onrender.com`).
**Status:** Frontend is **complete and live-wired**. The admin Invoices list now has an inline
**Paid** toggle per row (replaces the old read-only Status badge) and a **Paid / Unpaid / Void**
filter. Status is **no longer shown on the customer-facing invoice** (preview + PDF) — it's an
internal field only. The toggle calls the endpoint below, which **does not exist yet**
(`POST /api/admin/invoices/:id/paid` currently 404s). Until it ships, the toggle flips
optimistically, then reverts with a clean toast ("Mark-paid isn't available yet…") on 404 — no
crash.

> Delete this file once implemented — we don't keep handoff `.md`s in the repo long-term.

---

## Why this exists

The invoice `status` field (was draft/unpaid/paid/void) is now operator-internal. **Draft is
retired.** Operators flip paid/unpaid inline from the list instead of opening the editor. Void is
unchanged (separate `/void` route, kept for records).

---

## Endpoint contract (exact shape the frontend calls)

AdminAPI method: `markInvoicePaid(id, paid)` in `inkcartridges/js/admin/api.js`
(next to `voidInvoice`) → `window.API.post('/api/admin/invoices/:id/paid', { paid: <bool> })`.

### `POST /api/admin/invoices/:id/paid`

- **Auth:** same gate as the other `/api/admin/invoices` routes (admin **and** owner role).
  Staff (non-owner) → **403**.
- **Body:** `{ "paid": true | false }`.
- **Behaviour:** set the invoice's `status` to `'paid'` when `paid:true`, else `'unpaid'`.
  No-op-safe (setting paid on an already-paid invoice returns 200). Do **not** change a
  `void` invoice's status — the frontend never shows the toggle for void rows, but if called,
  reject with **409** `{ code:"INVALID_STATE" }` or ignore; either is fine.
- **Unknown id:** **404** `{ ok:false, error:{ code:"NOT_FOUND", message:"Invoice not found" } }`.
- **Success:** **200** `{ ok:true, data:{ status:"paid" } }` (echo the new status).
- **Envelope:** house style — success `{ ok:true, data }`; error `{ ok:false, error:{ code, message } }`.
  Thread `x-request-id` into errors.

---

## Acceptance checklist

- [ ] `POST /api/admin/invoices/:id/paid { paid:true }` (owner) → `status='paid'`, `200 { ok:true, data:{ status:"paid" } }`.
- [ ] `{ paid:false }` → `status='unpaid'`.
- [ ] Unknown id → `404 NOT_FOUND`.
- [ ] Non-owner → `403`.
- [ ] After it ships, the frontend "just works": toggling a row persists and survives reload (no frontend change needed — already wired).

---

## Quick test (curl)

```bash
TOKEN="<owner supabase access_token>"
BASE="https://ink-backend-zaeq.onrender.com"
ID="<an existing invoice id>"

curl -s -X POST "$BASE/api/admin/invoices/$ID/paid" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"paid":true}' | jq
# expect: { "ok": true, "data": { "status": "paid" } }
```
