# Quote PDF (`GET /api/cart/quote.pdf`): two defects and a design brief

**From:** frontend (ERR-316 follow-up) · **Date:** 2026-10-13 · **Asks:** Q1–Q3 below
**Why now:** The owner asked for the quote PDF to "look more professional". The FE only downloads the bytes (`js/cart-quote-pdf.js`), so the document itself is yours.

## 1. What we measured (2026-10-13, local FE against the production API, guest cart)

We downloaded two real quotes with Playwright. Both returned 200, a `%PDF-` header, PDFKit, 1 page, A4, and filename `inkcartridges-quote-Q-261012-<id>.pdf`.

| Quote | Cart | PDF figures | `GET /api/cart` / `/api/shipping/options` |
|---|---|---|---|
| from /cart, company "Probe Printing Ltd", ref "PO-4471" | G71180MLBK × 1 | Subtotal $136.99 · Shipping Free · Total $136.99 · GST $17.87 | 136.99 / 0 / 136.99 / 17.87 ✔ |
| from /checkout, Canterbury 8011 urban | CLC431XLBK × 1 | Subtotal $43.49 · "Shipping (South Island, urban)" $7.00 · Total $50.49 · GST $6.59 | 43.49 / fee 7 (zone `south-island`) / 50.49 / 6.59 ✔ |

The company and reference fields printed. **Every figure matched the server.** The PDF works.

## 2. Two defects

- **Q1 — The line description is garbled.** The PDF reads `HP Genuine 711 80mlBK Ink Cartridge 711 80ml Black`. The product name appears to be concatenated with another field (code/colour), with no separator. Please print the product's display name once. We suggest the `display_name`/`name` the cart API returns, not a composed string.
- **Q2 — The quote date is UTC, not NZ time.** The quote was generated at 00:33 NZDT on **13 October 2026** but is dated **"12th October 2026"**. The number `Q-261012-…` carries the UTC date too. Please date it in `Pacific/Auckland`. The quote number is your call, but it should agree with the printed date.

## 3. Design brief (Q3) — "more professional"

The current page is correct but plain. The page is mostly empty below the totals. There is no brand mark, no validity date, and the totals block is not visually separated. Requested layout, top to bottom (A4, 20mm margins, one font family, two weights):

1. **Header band.** On the left, the InkCartridges.co.nz logo (`https://api.inkcartridges.co.nz/logo.png` or your hosted copy, 40mm wide). On the right, **QUOTE** in 22pt, with the quote number and dates under it in a 2-column key/value block:
   - Quote number
   - Date (NZ)
   - **Valid until** (date + 14 days, or your policy)
2. **Seller / customer row, two columns.**
   - Left, "From": Office Consumables Ltd, address, phone, email, GST 94-509-459 and NZBN 9429033934204 (as printed in our site footer).
   - Right, "Prepared for": Company, Attention and Reference, **only the lines that were supplied** (no empty labels).
3. **Line table.**
   - Columns: Code · Description · Qty · Unit price (incl. GST) · Amount.
   - Header row in a light grey fill (`#F5F5F5`), hairline rules between rows, amounts right-aligned with tabular figures.
   - Volume-priced lines: show the struck retail and the price charged, or a "Volume price" note. These must be the same figures `GET /api/cart` returns (`volume_figures`).
4. **Totals block.**
   - Right-aligned, about 80mm wide, rows: Subtotal, Volume discount (if any), Coupon (if any), Shipping (with zone wording as now), then **Total NZD (incl. GST)** in bold 13pt over a 1pt rule, then "Includes GST of $x".
5. **Notes.**
   - Keep your current sentences (quote-not-invoice; prices can change; how to order; Net 30 for approved accounts).
   - Group them under a small "Terms" heading.
   - The reward-points sentence only for an identifiable shopper. On a guest quote it reads as an upsell in a formal document.
6. **How to pay / order** (if you are willing): a short block with the cart link and, for business approval, your bank account for direct credit with the quote number as reference. Leave it out if direct credit is not accepted.
7. **Footer** on every page: company name · GST number · website · "Page x of y".

Colours: text `#111`, muted `#666`, and one accent for the QUOTE title and rules (our primary `#267FB5`). No background images.

## 4. What the FE did in the same change

- The "Download PDF quote" control on /cart and /checkout was restyled: a quiet outlined button with a document icon, and the company/PO fields under a small "+ Add company or PO reference" link.
- The behaviour is unchanged: same endpoint, headers, query and status messages.
- If you change the filename, `Content-Disposition` must stay CORS-exposed. The FE reads the filename from it.

**How we will verify once you ship:** re-run the same two downloads. Then check the text for one description per line, a `Pacific/Auckland` date and a "Valid until" date, and that the figures still equal `GET /api/cart`.
