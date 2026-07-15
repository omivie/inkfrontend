# Backend follow-ups after the invoice/quick-order SKU-integrity fix (ERR-071 → ERR-077)

**To:** backend dev (Render repo, `api.inkcartridges.co.nz`)
**From:** frontend (Vercel SPA)
**Date:** 2026-07-15 · **Re:** your `invoice-sku-integrity-backend-response-jul2026.md`
**Status:** 🟢 ERR-071 fully closed on both sides — this doc is **two small follow-ups**, one ask + one clarification. Nothing here is blocking.

Shared vars used in the repro commands below:

```bash
API=https://api.inkcartridges.co.nz
# An owner bearer token (Supabase access_token for an is_owner admin). Grab it in the
# admin tab: JSON.parse(localStorage.getItem(<sb-*-auth-token key>)).access_token
TOKEN='<owner access_token>'
AUTH="-H \"Authorization: Bearer $TOKEN\""
```

---

## 0. What's already confirmed done — no action needed

Your six asks all landed. I verified the two that touch the frontend against **live** data, and wired up our side:

- **§3.1 — the 400 backstop is now rendered LOUD.** When our client SKU guard fails soft (catalogue
  unreachable → the save is let through) your `400 VALIDATION_FAILED` +
  `error.details.unresolved: [{position, product_code}]` is the net. The FE now maps that payload back
  onto the offending invoice/quick-order line and pins it **inline** (highlighted, scrolled-to,
  focused) with the same sentence our client guard uses — not a generic toast. Verified end-to-end.
- **Quick-order envelope gap closed on our side.** `create/update/deleteQuickOrder` were throwing a bare
  `Error` and dropping `err.code`/`err.details`; they now go through the same envelope parser as the
  invoice writes, so your 400 body reaches the operator.
- **§3.6 — `supplier_cost_excl_gst` echo confirmed, workaround deleted.** `GET /invoices/:id` returns it
  (I saw `139.8`, `cost_source:"auto"` on #3263), so I removed our `fetchProductCosts` /
  `backfillCostsFromCatalogue` back-fill entirely. **You can consider that fully closed on both sides.**

So the only open items are the two below.

---

## 1. ASK — the invoice **list** endpoint returns no cost/profit, so the admin "Profit" column is dead

**Priority:** P2 (owner-facing analytics gap, no data loss)

### What I see

`GET /api/admin/invoices` returns lightweight rows — **no line items, no cost, no profit**:

```bash
curl -s "$API/api/admin/invoices?page=1&limit=20" -H "Authorization: Bearer $TOKEN"
```
```json
{"ok":true,"data":{"invoices":[
  {"id":"576f0071-…","invoice_number":3265,"issue_date":"2026-07-08","customer_name":"Ian Cozens","total_incl_gst":966,"status":"unpaid"},
  {"id":"0bb1f49c-…","invoice_number":3264,"issue_date":"2026-07-03","customer_name":"William Hartley","total_incl_gst":106.49,"status":"unpaid"},
  {"id":"8a4b7367-…","invoice_number":3263,"issue_date":"2026-06-22","customer_name":"Felix Wong","total_incl_gst":195.99,"status":"unpaid"}
],"pagination":{"total":3,"page":1,"limit":20}}}
```

The **detail** endpoint, by contrast, has everything and computes profit fine:

```bash
curl -s "$API/api/admin/invoices/8a4b7367-b9db-4959-bd7f-c5062cb3ac42" -H "Authorization: Bearer $TOKEN"
# line_items[0] = { product_code:"CTN258XLKCMY", unit_cost_excl_gst:170.43,
#                   supplier_cost_excl_gst:139.8, cost_source:"auto", … }
# → editor shows: Cost of goods $139.80 · Gross profit $30.63 · 18.0%
```

### Why it matters

The admin invoice **list** has an owner-only **Profit** column. The FE derives it from each row's
`line_items[].supplier_cost_excl_gst`. Since the list rows carry no line items, every invoice reads
**"—"** — including the three you just repaired. The column is structurally dead: it can never show a
number no matter how healthy the data is.

(This is **separate** from the `kpi-summary` dashboard-profit P0 in `backend-open-items-jul2026.md §1`.
That one is about a period aggregate nulling out; this is the per-invoice list serializer simply not
carrying the fields.)

### What I'm asking for

Add a **precomputed** profit (and ideally cost) figure to each list row. Precomputed, not the raw line
items — a list response shouldn't ship per-line supplier cost, and the FE only needs the summary here.

```jsonc
// GET /api/admin/invoices → data.invoices[]
{
  "id": "…", "invoice_number": 3263, "issue_date": "2026-06-22",
  "customer_name": "Felix Wong", "total_incl_gst": 195.99, "status": "unpaid",

  "profit_excl_gst": 30.63,   // NEW: ex-GST revenue − ex-GST supplier cost. Same number the detail computes.
  "cost_excl_gst": 139.80     // NEW (optional): ex-GST supplier cost, if cheap to include.
}
```

**Critical — honour UNKNOWN ≠ 0** (same discipline as ERR-028/068 on our side): if **any** coded line on
that invoice has no `supplier_cost_excl_gst`, return **`profit_excl_gst: null`** (and `cost_excl_gst:
null`), *not* `0`. The FE renders `null` as "—" ("cost not recorded"); a literal `0` would render as a
real $0.00 profit and silently misstate margin. Only emit a number when **every** coded line has a
known cost. Void invoices can be `null` too — the FE already suppresses their profit.

Once that's in, our list column lights up with a **one-line FE change** — `normalizeInvoice()` currently
derives profit from the row's line items (which the list omits), so I'll have it prefer a top-level
`profit_excl_gst` when present. I'll ship that the moment the field lands; you don't need to wait on us.

---

## 2. CLARIFY — semantics of `position` in `error.details.unresolved[]`

**Priority:** P3 (our handling is already robust; this just lets me trust a fallback)

Your 400 body is:

```json
{ "ok": false,
  "error": { "code": "VALIDATION_FAILED", "message": "…",
             "details": { "unresolved": [ { "position": 2, "product_code": "CTN258" } ] } } }
```

Two questions so I can document the contract precisely:

1. Is `position` **1-based** or **0-based**?
2. Does it index the **full `line_items` array as submitted** (including empty-code freight/labour
   lines), or only the **coded** lines?

**Why I'm asking, and why it's not blocking:** our mapper (`unresolvedLineErrors()` in
`utils/line-codes.js`) matches each unresolved entry to a line **by `product_code` first** — case-
insensitive, and it flags *every* line carrying that code — precisely because `position` semantics
weren't specified. `position` is only a **fallback** for the rare case where the code no longer matches
any line (e.g. it was edited mid-request). So we're correct either way today; confirming the semantics
just lets me rely on the fallback and pin the exact row in that edge case.

No change requested if the current shape is intentional — a one-line reply ("1-based, indexes all
line_items") is all I need.

---

## 3. Reference — the contract the FE now depends on (unchanged from ERR-071, restated for completeness)

- `product_code` on an invoice/quick-order line **is a `products.sku`**, always. Empty = description-only
  line (freight/labour) and stays valid. Never cross it with the `product_codes` chip table (the `/shop`
  drilldown categories).
- On a bad code, **fail loud** (the 400 you shipped) — never materialise a zero-item shadow order.
- `supplier_cost_excl_gst` is **internal** (our cost), never printed on the customer document. `null` =
  UNKNOWN, never `0`, on every read and every aggregate.

## 4. FE reference (for context, no action needed)

| File | Role |
|---|---|
| `js/admin/utils/line-codes.js` | `unresolvedLineErrors()` maps your 400 back onto lines; `applyResolvedCodes()` + shared `skuLineMsg()` |
| `js/admin/pages/invoices.js` | list `Profit` column (currently derives from line items; will prefer a top-level `profit_excl_gst`); `surfaceUnresolvedCodes()` in every save/email/download catch |
| `js/admin/pages/quick-order.js` | `surfaceUnresolvedCodes()` on save |
| `js/admin/api.js` | `invoiceError()` envelope parser (quick-order writes now route through it) |
| `js/admin/utils/invoice-math.js` | `normalizeInvoice()` / `computeInvoiceProfit()` — where `profit_excl_gst` would slot in |
