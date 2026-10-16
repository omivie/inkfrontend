# Backend asks — 2026-10-16 (frontend → backend)

Context: the owner decided on 2026-10-16 that toners and drums match **by printer model**. A toner code
page shows the drums that fit the same printers, and a drum code page shows the toners (any brand).
The frontend shipped this as ERR-358. It uses the `compatible_printers` sample on `/api/shop` rows,
which is capped at 2. All measurements are READ-ONLY GETs.

(The earlier §1 here, "`?code=TN1070` omits the DR1070 drums", is withdrawn. A cache-busted GET on
2026-10-16 returned all 4 rows: thank you.)

## §1 Full printer list on `/api/shop` rows (makes the printer match exact)

Today each row carries `compatible_printers` (max 2 entries) plus `compatible_printers_count`. We
match a drum to a toner when they share at least one printer. With only 2 sampled printers, a drum
and toner that share a printer outside both samples are missed.

**Ask, either one:**
- (a) Add `compatible_printer_slugs: string[]` (the FULL list, slugs only, to keep it small) to every
  `/api/shop` row. Keep `compatible_printers` as it is, because the card "Fits …" line uses it.
- (b) Add `GET /api/shop?brand&category&code=X&with=printer_partners`. It returns the code's rows plus
  the toner ⇄ drum rows that share ≥1 printer with them.

Either one removes the sample limit at no extra request cost.

## §2 Printer compatibility gaps: toners list fewer printers than their drums

- `GET /api/products/printer/brother-dcp-1610w` returns only GDR1070BK and CDR1070BK. It returns no
  TN1070 toner, although TN1070 fits the DCP-1610W.
- More generally, CTN1070BK lists 3 printers and the DR1070 drum lists 8.

The printer match can only be as good as this data.

**Ask:**
- Add the missing toner compatibility rows.
- If you can, list the printers that have a Brother DR#### but no TN#### that shares the drum's
  printers. We can review that list together.
