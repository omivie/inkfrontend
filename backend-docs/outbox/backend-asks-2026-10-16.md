# Backend asks — 2026-10-16 (frontend → backend)

Two catalogue data asks from the owner's report that Brother toners and drums do not show together.
All numbers below come from READ-ONLY GETs against `https://api.inkcartridges.co.nz` on 2026-10-16,
including a cache-busted MISS, so CF edge staleness is ruled out.

## §1 `/api/shop?code=X` must return every row whose `series_codes` contains X (extends BF-102)

| Request | Rows returned (sku → `series_codes`) |
|---|---|
| `brand=brother&category=toner&code=TN1070` | GTN1070BK `['TN1070']`, CTN1070BK `['TN1070','DR1070']` |
| `brand=brother&category=drums&code=TN1070` | the same 2 toners, **no drums** |
| `brand=brother&category=drums&code=DR1070` | GDR1070BK + CDR1070BK `['DR1070','TN1070']`, GTN1070BK, CTN1070BK |

Both DR1070 drums are tagged `TN1070`, but `?code=TN1070` does not return them in either category.
`?code=DR1070` does return all four rows. So the filter is asymmetric.

**Ask:** `?code=X` returns every row whose effective `series_codes` contains X, in every category the
request names. This is the same family as BF-102 (series count vs listing).

**Frontend stop-gap (ERR-354):** for Brother only, a TN#### click also asks the related category for
DR#### (and the reverse). It keeps only rows that carry the clicked code. This misses Brother pairs
with different numbers (TN2450/DR2425, TN660/DR630). Your fix covers those; when it ships, we remove
the stop-gap.

## §2 Printer compatibility: Brother DCP-1610W lists the DR1070 drum but no TN1070 toner

`GET /api/products/printer/brother-dcp-1610w` returns only GDR1070BK and CDR1070BK (`drum_unit`).
No toner is returned, genuine or compatible. The TN1070 toner fits the DCP-1610W. The frontend renders
this response as-is, so the printer page shows a drum and no toner.

**Ask:**
- Add the missing toner compatibility rows for the DCP-1610W.
- Check for the same gap on other printers: a printer that lists a Brother DR#### but no TN#### that
  shares the drum's `series_codes`. If you can produce a list of these printers, we can audit them
  together.

## §3 Wrong colour and pack data: a customer bought "HP 67 4-Pack" expecting four cartridges

The owner reported two products on 2026-10-16. We then swept all 4,119 live products (READ-ONLY,
`npm run probe:product-titles` plus a name-versus-`color` scan). The frontend prints `color` and
`name` as stored, so these rows are wrong on the live site until the data changes.

**A. C67XXLRD (compatible HP 67XXL Tri-Colour) is stored as Red.**
Live: `color: "Red"`, `color_hex: ["#f44336"]`. The description says "This Red cartridge" and
"Red ink cartridge", and `meta_keywords` says "HP Red cartridge". The name and image are Tri-Colour.
The PDP colour chip and "Pack contents" both say "Red".
**Ask:** `color` = `Tri-Colour` (and `color_hex` to match), with "Red" changed to "Tri-Colour" in the
description and keywords. Keep the slug, or 301 the old one.

**B. Value packs whose `color` is the bare "Value Pack" (contents unknown to the frontend).**
G67VPVP is named "HP Genuine 67 Ink Cartridge 4-Pack". Its MPN 6ZD26AA is HP's black + tri-colour
combo, which is **2 cartridges**, not 4. `GET /api/products/G67VPVP/constituents` returns `[]`.
Please verify every row below against its MPN before you write. The groups are what the names
suggest, not a measurement of the box contents.

| Suggested `color` | SKUs |
|---|---|
| `Black/Colour` (one black + one tri-colour) | G67VPVP, G804VPVP, GPG640VPVP, GPG645VPVP |
| `KCMY` | G604VPVP, GCLI651XLVPVP, GCLI671XLVPVP, G432KCMY, G200VPVP, G212VPVP, G220VPVP, G812VPVP, G905VPVP, G915XLCMYK, G955VPVP, G965XLCMYK |
| `CMY` | G432VPVP |
| `Black`, `pack_type: multipack` (twin black) | GPGI650XLVPVP, GPGI670XLVPVP |

**C. GCLTP407C (Samsung CLT-P407C, a 4-colour kit) is stored as `pack_type: single`, `color: Black`.**
**Ask:** `pack_type` = `value_pack`, `color` = `KCMY`.

**D. Pack constituents.** Populate `/constituents` for every pack in B and C. The PDP "Pack contents"
list reads it.

**Frontend stop-gap (ERR-357):** when `color` is "Value Pack", the title shows "Value Pack" in
place of "N-Pack". Once a row has a real code, it gets a full title, e.g.
"HP 67 Genuine Ink Cartridges – Black + Tri-Colour Combo Pack" for `Black/Colour`. Nothing to undo
on your side: fix the data and the stop-gap stops firing for that row.
