# Admin Ribbons tab removal — May 2026

**Status:** shipped 2026-05-10
**Pinned by:** `tests/no-admin-ribbons-tab.test.js`

## What changed

The dedicated **Ribbons** tab on `/admin#products` was removed. Ribbons,
typewriter ribbons, and correction tape are managed from the **All Products**
tab via the existing Type and Source filters — same data, same edit drawer,
one less place to maintain.

The customer-facing `/ribbons` browsing page was **not** touched. It is a
real shopper surface (mega-nav → "Typewriter and Printer Ribbons" → brand
grid → ribbons listing) and is unrelated to the admin cleanup.

## Files touched

| File | Change |
|------|--------|
| `inkcartridges/js/admin/pages/products.js` | Removed `<button data-prod-tab="ribbons">` and the `tab === 'ribbons'` branch in `switchProductTab`. Comment updated. |
| `inkcartridges/js/admin/pages/ribbons.js` | **Deleted** (1366 lines). |
| `inkcartridges/js/admin/app.js` | Kept the `'ribbons':'products'` entry in `ROUTE_REDIRECTS` so old `/admin#ribbons` bookmarks still resolve to the Products page. |
| `tests/no-admin-ribbons-tab.test.js` | New regression test (5 cases). |
| `readfirst/admin-ribbons-tab-removed-may2026.md` | This file. |

## Why

The Ribbons admin module was a near-duplicate of the Products module —
same table, same filters, same edit drawer — scoped to a `product_type IN
(printer_ribbon, typewriter_ribbon, correction_tape)` filter. Every fix
to one had to be mirrored to the other (see drift around the import-lock
button, the SEO meta builder, and the brand dropdown). Removing it
collapses two surfaces into one without losing any capability:

- **Filter by ribbons:** All Products → Type filter → "Printer Ribbon"
  / "Typewriter Ribbon" / "Correction Tape", or Source filter → "Ribbon".
- **Edit a ribbon:** click the row in All Products. The drawer already
  renders the manual-compatibility "Compatible Devices" UI when
  `product_type` is in `manualCompatTypes`.
- **Add a ribbon:** "Add Product" → set type to one of the ribbon types.

## Why we kept the legacy route redirect

Users with bookmarks to `/admin#ribbons` keep working — they land on the
Products page instead of seeing an empty container or 404. The redirect
costs one line in `ROUTE_REDIRECTS` and shows up in the regression test
so a future cleanup doesn't accidentally drop it.

## Verification

- `node --test tests/no-admin-ribbons-tab.test.js` — 5/5 pass
- `node --test tests/*.test.js` — 695 pass, 7 skipped, 0 fail (full suite)
- `npx serve inkcartridges -l 3000` → `GET /js/admin/pages/ribbons.js`
  returns 404 (file gone), `GET /js/admin/pages/products.js` returns 200,
  and the admin page shows two tabs (All Products / Printers).

## Out of scope

- Customer-facing `/ribbons.html`, `js/ribbons-page.js`, mega-nav
  `nav-ribbons-toggle`, `ribbons.css`, `vercel.json` ribbon rewrites — all
  untouched. Those serve real shopper traffic.
- Backend `product_type` enum — unchanged. Ribbons remain first-class
  products in the catalog.
