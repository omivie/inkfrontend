# Backend response, 22 November 2026 (ERR-385 invoice delivery, drum-code titles)

Answers `fe-reply-2026-11-21.md`.

## ERR-383 and ERR-379 — checked, no change

Re-measured read-only against the live DB on 22 November:

- INV-3274 `invoice_id` = invoice 3274. Invoice 3297 `source_order_id` = null.
- INV-3297 exists, channel `invoice`. Its total is now **$712.54**, not the $685.49 in your
  note, because the owner edited the line on 21 November (unit 619.60). That is the edit
  described under ERR-385, not a regression.
- ERR-379: we have no change planned to toner/drum pairing. If `loadPrinterPair` /
  `printerPartnerRows` or the `/shop` `series[].count` rule changes, we will tell you in the
  same response that ships it.

## ERR-385 — "Deliver to" is now stored

Live once the deploy finishes. Migration 215 is already applied.

1. `standalone_invoices.delivery jsonb NULL`. POST and PUT `/api/admin/invoices` store
   `delivery` as sent. Rules:
   - `delivery: null`, or a block whose fields are all blank, is stored as `null`
     (= ship to the invoice address).
   - **No `delivery` key in the body leaves the stored value unchanged.** Send the key on
     every save if you want a clear to stick.
   - Validated shape: `attn`, `company`, `phone` strings (≤200 / ≤60 chars), `address` an
     array of up to 8 strings. Extra keys are kept.
   - On POST, a failed write of this field returns the invoice with the existing
     `BUSINESS_LINK_NOT_SAVED` warning (message now names the Deliver-to address too).
2. `GET /api/admin/invoices/:id` returns `invoice.delivery` **always**, `null` when not stored.
   PUT and POST responses carry it too. Your stopgap can switch off on the key's presence.
   Invoices saved before this deploy return `null`: the lost blocks were never stored, so
   re-enter them from your browser copy and save once.
3. The server PDF (fallback renderer, used when no stored PDF exists) prints a
   **Deliver To:** block under the bill-to block: `Attn: …`, company, address lines, phone.
   Nothing prints when `delivery` is null.
4. `pdf_updated_at`: the column **does** move on every upload. The audit log for invoice 3297
   shows each save followed by a PDF store within 2 s (06:19:46/47, 06:23:01/02,
   06:23:12/14, then 10:33 and 10:34), and the row now reads `2026-11-21T10:34:25Z`.
   A reading of `2026-11-20 00:26` at 06:23 is a read taken before the upload finished, or
   the PUT response, which is built before you upload. Re-read the invoice after
   `POST /:id/pdf` resolves.

## Drum-code bot pages

`/api/prerender` brand+code pages now take their noun from what the page lists:

| Page lists | `<title>` / `<h1>` noun |
|---|---|
| only drum-category rows (drum, waste, belt, fuser, maintenance) | `Drums & Supplies` |
| only ribbons / label tape / photo paper / receipt rolls | that category's label |
| any ink row | `Ink Cartridges` |
| otherwise (toner, or toner + drums) | `Toner Cartridges` |

So `/shop?brand=brother&category=drums&code=DR2415` is now
`<title>Brother DR2415 Drums & Supplies NZ | InkCartridges.co.nz</title>` and
`<h1>Brother DR2415 Drums &amp; Supplies</h1>`. We used the category label you already show
in the breadcrumb ("Drums & Supplies"), not "Drum Units & Supplies", so the page has one name
for the category. The CollectionPage JSON-LD name changed with it.

The page cache holds an hour, so old titles can show for up to an hour after the deploy.
www mirrors the h1, so no FE change is needed.
