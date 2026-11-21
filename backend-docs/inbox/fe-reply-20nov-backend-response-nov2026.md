# Backend response, 20 November 2026 (ERR-383 invoice 3297, ERR-379 toner codes)

Answers `invoice-3297-urgent-2026-11-20.md` and ask 4.5 of `fe-reply-2026-11-07.md`.
Sections 4.1 to 4.4 of the 7 November reply were answered in
`fe-reply-7nov-backend-response-nov2026.md` and are live (re-checked 20 November).

Commits on `main`: `d759957` (invoices), `5c8b73b` (shop codes), `b350655` (copy).
No FE change is needed for any of it.

## ERR-383 — invoice 3297 could not be saved

### 1. Data repaired (applied 2026-11-20 06:41 UTC)

| Row | Before | After |
|---|---|---|
| Order INV-3274 (`24a9f5ab…`) `invoice_id` | 3297 (`1e351785…`) | 3274 (`17c0ee9e…`) |
| Invoice 3297 `source_order_id` | `24a9f5ab…` | `NULL` |
| Order INV-3297 | did not exist | `13e56979-8133-48f7-a74f-f65fa9e5a1b0`, channel `invoice`, total $685.49, 1 line (`GTK5494KCMY` ×1) |

Nothing else on INV-3274 changed (its line item included). Your cross-reference query
returns 0 rows, and no invoice now has a `source_order_id`. A rolled-back test save of
3297 with a changed unit price succeeded.

**The owner must reload invoice 3297 before re-applying the edit.** An editor tab
opened before the repair still holds the old order link, and the server now refuses that
save (with a readable message, see 3).

### 2. The 500 cause

Invoice 3297 was created from the "Existing order" picker with `source_order_id` =
INV-3274. INV-3274 is not a customer order; it is the sales record of invoice 3274. The
database function that links an invoice to its order (`sync_invoice_shadow_order`) did
not check ownership, so it re-pointed INV-3274 at 3297, and invoice 3274 lost its sales
record. Every later save of 3297 first deletes "this invoice's own sales record" before
linking, and that was now INV-3274. The database refused the delete because the order
still had a line item (`order_items_order_id_fkey`, error 23503), and the route did not
map that error, so it answered the generic 500. Without that line item the save would
have deleted invoice 3274's sales record and answered 200.

### 3. Server-side guard

On `POST` and `PUT /api/admin/invoices`, before anything is written, a set
`source_order_id` is refused with **400** when:

| `error.code` | When |
|---|---|
| `SOURCE_ORDER_NOT_FOUND` | the order does not exist |
| `SOURCE_ORDER_IS_INVOICE` | the order has `channel = 'invoice'` |
| `SOURCE_ORDER_ALREADY_INVOICED` | another invoice owns the order (on create: any invoice) |

A lookup failure answers **503** `SOURCE_ORDER_LOOKUP_FAILED` and writes nothing. The
database function refuses the same cases itself (`SOURCE_ORDER_NOT_LINKABLE`, 400), so a
race or a script cannot get past it. A foreign-key failure inside the save now answers a
sentence (409 `INVOICE_REFERENCE_CONFLICT`), and any remaining 500 carries its reason in
`error.message`: "Failed to update invoice: <reason>". `error.message` is what your
toast shows.

Your picker fix (never link a `channel = 'invoice'` order) stays correct; the server now
enforces it too.

### 4. Void now reports a failed sales-record sync

`POST /api/admin/invoices/:id/void` still voids the invoice when cancelling its sales
record fails. Before, that failure was silent, and the voided sale kept counting in
sales reports. Now the 200 carries
`data.warnings: [{code: 'SALES_RECORD_NOT_CANCELLED', message}]`, the same `warnings`
shape that create already returns. Please show `message` when it is present.

## ERR-379 — toner rows carried drum codes

Cause: two kinds of `product_codes` rows, both entered by hand in the admin UI on 29 Sep
and 15 Oct, before toners and drums were paired by printer.

- Rows with a `chip_category` are tags ("also show this toner under the DR2415 drum
  tile"). The loader also treated them as the product's own codes, so a tagged toner
  carried DR2415 in `series_codes` and as a tile on the toner page. The drums page had
  the mirror image (TN tiles).
- Seven plain rows filed toners under a drum code. A plain row replaces the derived
  codes, so the five TN3605 toners carried only `DR3605`.

Fix:

- A tag now applies only on the category page it names, and never enters `series_codes`.
- The seven plain rows are deleted (live since 20 November). Toners and drums still show
  together, because they are paired by printer.

What you will see:

- `GET /api/shop?brand=brother&category=toner` `series`: no DR tiles. `TN3605` has 7
  products (5 toners and the 2 drums for the same printers).
- The TN3605 toners: `series_codes: ["TN3605"]` (already live).
- `GET /api/shop?brand=brother&category=drums` loses its five TN tiles (TN1070, TN2415,
  TN2449, TN2530, TN3605), the same defect mirrored. Every DR tile keeps its count.
- `?brand=brother&code=<CODE>` with no category no longer lists the other type's tagged
  rows. Every such page still lists 2 or more products.
- Old tile links `?category=toner&code=DR…` and `?category=drums&code=TN…` now return an
  empty list.

Every tile's count still equals the rows its `?code=` listing returns, for all 28 brands.

**Admin UI ask:** please stop offering a plain (no `chip_category`) code row that names
the other type's code (a DR code on a toner, a TN code on a drum). The backend cannot tell
that from a deliberate override, and it brings this bug back.

## Copy: the last reply-time promises

Under the owner's 7 November rule, these strings no longer say "within one business day":

- the printer bot page and its FAQ when a printer has no product listed
- the return-request API message: "Return request received. Our team will reply by email
  with the next steps."
- the return-request email

The www printer page renders no intro or FAQ of its own, so nothing there needs mirroring.
If www shows its own copy of the return confirmation, drop any reply time from it too.
