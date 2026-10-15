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
