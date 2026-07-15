# Backend brief — Quick Orders sales integration: FE done, 2 asks back

**Response to** `quick-orders-sales-integration-FE-handoff-jul2026.md` (your handoff, backend migration 108, commits `c191d4a` / `5a99d3c`).
**FE shipped** 2026-07-15 (ERR-077). All three blocking items are done. Below: what the FE now does, then **2 things I need from you** (1 confirmation, 1 bug), then an optional hardening idea.

---

## TL;DR — what you need to do

1. **CONFIRM (blocking-ish):** `PUT /api/admin/quick-orders/:id` must accept a **partial `{ "status": "invoiced" }`** body without wiping the order's `line_items` / customer. The FE now sends exactly that on convert-to-invoice. If your PUT is full-replace, say so and I'll switch to fetch-then-PUT. **This is the one thing that can break silently.**
2. **FIX (still open):** `DELETE /api/admin/invoices/:id` still **500s** for a product-backed invoice. It's your own listed open item, but it now also **blocks live E2E test-data cleanup**, so the flip round-trip is unverified against the live endpoint. Please bump it.

Everything else below is FYI.

---

## 1. What the FE shipped (all 3 blocking items)

### Blocking #1 — no double overlay ✅
Confirmed there is **no** client-side revenue overlay anywhere (dashboard & finance render your totals, they never aggregate). Nothing to disable. I did **not** consume `dashboard-bundle.meta.quickorder_revenue` / `quickorder_orders` — they're plumbed through but unused (no overlay to guard). The on-page notice that used to say *"quick orders aren't in your sales figures yet"* was corrected — it now tells the owner they **are** counted.

### Blocking #2 — convert-to-invoice flips the quick order to `invoiced` ✅
This is the double-count guard. Because there's no backend invoice→quick-order link, the FE owns it:

- The convert bridge now carries the quick-order `id` into the invoice editor.
- **After the invoice actually saves** (not at "Create invoice" click time), the FE calls:

  ```
  PUT /api/admin/quick-orders/:id
  Content-Type: application/json

  { "status": "invoiced" }
  ```

- **Why after-save, not at click time:** "Create invoice" only pre-fills the editor. If we flipped at click time and the operator then cancelled, the quick order would be `invoiced` (shadow cancelled) with **no** invoice → the sale would vanish from analytics. Flipping only after a real save guarantees **exactly one count** in every path (save / cancel / email / download).
- **Idempotent:** the FE clears its internal link on the first successful flip, so the invoice's email/download re-saves don't re-PUT.
- **Loud on failure:** if the PUT errors, the invoice is already saved, so the sale *would* double-count — the operator gets an explicit warning ("Invoice saved, but the source quick order couldn't be marked invoiced — it may double-count until you delete it"), and the FE retries on the next save. It never swallows this.

> ⚠️ **This is ask #1.** The body is status-only. Confirm PUT treats it as a partial update.

### Blocking #3 — unresolvable `product_code` → 400 ✅ (+ hardened)
Already surfaced via the pre-flight SKU check + `err.message` toast. While wiring it I found the **inline per-line pin was silently dead**, and fixed it:

- Your 400 shape is `{ ok:false, error:{ code:"VALIDATION_FAILED", message, details:{ unresolved:[{position, product_code}] } } }`.
- The FE's shared client **flattens** that to `{ ok:false, error:"<message string>", code:"VALIDATION_FAILED", details:{unresolved:[…]} }` (top-level `code`/`details`).
- The FE now maps `details.unresolved` back onto the offending line(s) and highlights each code box — for **both** invoices and quick orders. It matches **by `product_code` first** (case-insensitive), treating `position` as a fallback, so whatever base your `position` counts from doesn't matter.

No backend change needed here — just noting the FE consumes `details.unresolved` by code, so keep `product_code` in each entry.

### §4 reference fields — honoured
- Quick-order lines still send `supplier_cost_excl_gst` (null = "you snapshot it") + `cost_source` (`auto`/`manual`); these stay internal, never on any printed/exported view.
- Null-COGS → `—` rendering already applies to quick orders (same COGS-honesty path as invoices).

---

## 2. Ask #1 (confirmation) — is `PUT /quick-orders/:id` a partial update?

The flip sends **only** `{ "status": "invoiced" }`. I need this to be safe:

- **If PUT is a partial/merge update** (status-only leaves `line_items`, customer, costs untouched): ✅ nothing to do, we're done.
- **If PUT is a full replace** (missing keys are cleared): 🚫 a status-only body would wipe the quick order's lines. Tell me and I'll change the FE to `GET` the record, set `status`, and PUT the whole thing back. I'd rather not do that pre-emptively (it re-runs your SKU write-guard and materialiser needlessly) if a partial update is supported.

Please just reply "partial, status-only is fine" or "full-replace, send the whole record".

Related: confirm the accepted `status` vocabulary is `open` | `invoiced` | `cancelled` (per your handoff), and that `invoiced` cancels the shadow order the same way `cancelled` does. That's what the guard assumes.

---

## 3. Ask #2 (bug, still open) — invoice DELETE 500 blocks cleanup

From your handoff's own "Open backend item":

> `DELETE /api/admin/invoices/:id` still 500s for a **product-backed** invoice (the shadow order's `order_items` block the cascade — `ON DELETE RESTRICT`). The quick-order DELETE was fixed; the invoice DELETE needs the same fix.

Impact on this work: I **could not** run a full create-QO → convert → save-invoice → assert-flip E2E on live, because saving a test invoice mints permanent financial data I can't remove (this bug). So the flip's live round-trip is **unverified** — the logic is exhaustively unit-tested (`tests/admin-quick-order-invoice-integration.test.js`, 12 cases) and a non-destructive smoke test confirmed the pages/modules load, but the actual PUT hasn't hit your live endpoint under test.

**What would unblock full verification:** the invoice DELETE fix (same cascade fix you applied to quick orders), or a staging environment where test invoices can be discarded.

---

## 4. Optional hardening (not required)

The double-count guard currently rests **entirely** on the FE flip. If the browser dies between "invoice saved" and the flip PUT, the operator sees the loud warning but the quick order is momentarily still `open` (double-counting until they act).

A more robust design: add an optional `source_quick_order_id` to the invoice create payload. If the FE sends it, the backend cancels that quick order's shadow **server-side** in the same transaction that materialises the invoice's shadow — making the guard atomic and browser-crash-proof. The FE already knows the id at save time and can start sending it whenever you're ready to consume it. Purely additive; today's flip keeps working until then.

---

## Reference — FE touch points (for your mental model)
- Bridge shape / flip decision: `inkcartridges/js/admin/utils/quick-order-bridge.js` (pure, unit-tested)
- The flip call: `flipSourceQuickOrder()` in `inkcartridges/js/admin/pages/invoices.js` (`persistDraft` → after save)
- 400 line-pin: `surfaceUnresolvedCodes()` (invoices.js + quick-order.js) ← `unresolvedLineErrors()` in `utils/line-codes.js`
- Error plumbing: `invoiceError()` in `inkcartridges/js/admin/api.js` (now carries top-level `resp.details`)
