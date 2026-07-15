# Backend: an invoice line that doesn't resolve must FAIL, not silently vanish

**Status:** ✅ **RESOLVED** (backend shipped `c191d4a` + data repaired; FE wiring shipped 2026-07-15) · **Raised:** 2026-07-14
**Severity:** silent data loss — a write that looks successful produces a **paid order with zero line items**.
**Storefront ticket:** ERR-071 · **Frontend:** ✅ shipped (guard `c4017c2`; 400-backstop wiring 2026-07-15)

> **Resolution (2026-07-15).** Backend response: `invoice-sku-integrity-backend-response-jul2026.md`.
> All six asks delivered. FE side now wired:
> - **§3.1 the 400 backstop is rendered LOUD.** The backend returns `400 VALIDATION_FAILED` with
>   `error.details.unresolved: [{position, product_code}]` when the client guard fails soft (catalogue
>   unreachable → the save is let through and the backend catches it). Both writers now map that payload
>   back onto the offending line and pin it inline — highlighted, scrolled-to, focused — with the SAME
>   sentence the client guard shows. New pure mapper `unresolvedLineErrors()` +
>   `surfaceUnresolvedCodes()` in each page. Verified end-to-end in the running admin (the real
>   `invoiceError` → mapper → `markInvoiceErrors` chain marks the code box and toasts).
> - **Quick-order envelope gap closed.** `create/update/deleteQuickOrder` bypassed `invoiceError`, so
>   they never carried `err.code`/`err.details` (and risked `[object Object]`). Now routed through it,
>   matching the invoice writes.
> - **§3.6 workaround retired.** Verified live that `GET /api/admin/invoices/:id` echoes
>   `supplier_cost_excl_gst` (e.g. `139.8` on #3263, `cost_source:"auto"`). The
>   `fetchProductCosts`/`backfillCostsFromCatalogue` workaround is deleted — cost is read straight from
>   the record.
>
> Tests: `tests/admin-invoice-sku-integrity.test.js` extended (10 new `unresolvedLineErrors` cases).
> Full suite green.

---

## 1. What happened

Invoices **#3263** and **#3264** were saved with `product_code` values `CTN258` and `CLC531XL` — the
series codes printed on the cartridge box — instead of the real SKUs `CTN258XLKCMY` and
`CLC531XLKCMY`.

The invoice→shadow-order materialiser matches line items **by SKU**. Neither code matched anything, so
**both lines were dropped** and the result was two paid orders carrying revenue but containing no line
items. That nulled out profit for those orders and tripped a CRITICAL data-integrity alert.

Nothing errored. The invoice saved, the order materialised, money was recorded. The only signal was a
downstream alert firing days later.

## 2. What the frontend has already fixed

Shipped and live — see §5 for exactly what it does and doesn't cover.

The admin invoice editor and Quick Order editor now verify **every non-empty line code against
`products.sku`** before writing, at the single save choke point on each page:

- Resolvable codes are **canonicalised** (a typed `ctn258xlkcmy` becomes `CTN258XLKCMY`).
- Unresolvable codes **block the save** with a per-line inline error.
- An **empty** code stays legal — freight/labour/one-off lines are description-only by design.
- A prefix is **never** auto-resolved. `CTN258` prefixes both `CTN258BK` and `CTN258XLKCMY`; guessing
  would invoice the *wrong product*, which is worse than the bug being fixed.
- Fail-soft: if the catalogue lookup itself fails, the save proceeds (our outage must not stop
  invoicing).

Root cause on our side, for the record: the picker was **never** wrong — it selects `products.sku` and
stores it verbatim. The hole was that the code box is a **free-text input**, so a code *typed* rather
than *picked* reached the payload unverified.

---

## 3. The asks

### 3.1 — P0: reject an unresolvable `product_code` instead of dropping the line

Today an unmatched line is silently discarded and the order is materialised anyway. Please make the
write **fail loudly** — a `400` naming the offending line — rather than producing a zero-item order.

A refused invoice is recoverable in ten seconds. A paid order with no line items is a forensic
exercise, and it corrupts profit/COGS until someone notices.

> The frontend already surfaces `err.message` from a failed save as a toast on all three persisting
> paths (save, email, download), so a descriptive 400 body will land in front of the operator with no
> further FE work.

### 3.2 — P0: make the fallback resolver LOUD

The new fallback chain (`SKU → sku_redirects → legacy_sku → exact name match`) is a good safety net,
but **silent absorption is exactly the mechanism that let this run undetected**. It converts a visible
failure into an invisible one: everything looks healthy while per-SKU analytics and reorder-by-SKU
quietly drift.

Please log/flag/alert **every time the resolver falls back past an exact SKU hit**. The net should
catch the fall *and tell someone it caught one*.

### 3.3 — P1: write the canonical SKU back when the resolver resolves a mismatch

When the fallback chain does resolve a bad code, persist the canonical `products.sku` onto the invoice
line. That self-heals the record instead of re-resolving the same bad code forever and leaving the
stored data permanently wrong.

### 3.4 — P1: repair the two existing invoice rows

The shadow orders were fixed backend-side, but **the invoice records themselves still hold the
truncated codes**:

| Invoice | stored `product_code` | should be      |
|---------|-----------------------|----------------|
| #3263   | `CTN258`              | `CTN258XLKCMY` |
| #3264   | `CLC531XL`            | `CLC531XLKCMY` |

A two-row `UPDATE` is the quickest path. (The alternative — reopening each invoice in the admin editor
and hitting Save — now works too: the new guard forces the real SKU to be picked. Either is fine;
please just don't leave them as-is.)

### 3.5 — P1: confirm the profit P0 is actually cleared

There's an open P0 on our side that **zero-item shadow orders null out all profit**. Those two orders
should now have line items — please confirm profit actually recomputes for them rather than assuming
the backfill was sufficient.

### 3.6 — P2: echo `supplier_cost_excl_gst` back on `GET /invoices/:id`

Unrelated to the SKU bug, but it lives in the same code path. The endpoint accepts
`supplier_cost_excl_gst`, snapshots it onto the shadow order, and then leaves the **invoice line
null**. So reopening a saved invoice shows an empty "Our Cost" box even for a product whose cost we
know, and the invoice's Profit column can never read anything but "—".

The frontend works around this by re-fetching costs from the catalogue on open
(`fetchProductCosts` in `js/admin/components/product-search.js`). Echoing the field back on read lets
that workaround be deleted.

---

## 4. Why the backend fix is still needed given the FE guard

The frontend guard covers **the admin UI, on a fresh build**. It does not cover:

- scripts, backfills, migrations, or any direct API write;
- future integrations (a reseller portal, a bulk importer, a mobile client);
- an operator on a stale cached build (the guard shipped with an admin asset-version bump, but caches
  are caches);
- anything at all that isn't `pages/invoices.js` / `pages/quick-order.js`.

**A client-side check is a UX affordance, not an invariant.** The invariant belongs at the write
boundary — which is you.

## 5. Contract we're now relying on

- `product_code` on an invoice/quick-order line item **is a `products.sku`**, always. Not a series
  code, not a base code, not free text.
- An **empty** `product_code` remains valid and means "description-only line" (freight, labour,
  one-off). Please don't start rejecting those — every invoice with a shipping line would break.
- `products.sku` is the canonical product identity. It is a **different namespace** from the
  `product_codes` chip table (the `/shop` drilldown categories like `PG40/CL41`), which is
  many-to-many with products and is *not* a product identifier. Please don't cross them.

---

## 6. Frontend reference (for context, no action needed)

| File | Role |
|---|---|
| `js/admin/utils/line-codes.js` | pure gate — `codesToVerify()` + `applyResolvedCodes()`; `unresolvedLineErrors()` maps a backend 400 back onto lines; shared `skuLineMsg()` |
| `js/admin/components/product-search.js` | `resolveSkus()` — one batched `products.sku` lookup (the `fetchProductCosts` workaround was removed) |
| `js/admin/api.js` | `invoiceError()` envelope parser; the quick-order writes now route through it |
| `js/admin/pages/invoices.js` | guard in `persistDraft()` (save + email + download) + `surfaceUnresolvedCodes()` in every catch |
| `js/admin/pages/quick-order.js` | guard in `saveQuickOrder()` (writes REAL orders) + `surfaceUnresolvedCodes()` |
| `tests/admin-invoice-sku-integrity.test.js` | 19 tests pinning the guard rules **and** the 400-backstop mapping |
