# Backend asks — 2026-11-24

From FE. Each section is one ask. Delete a section once it is answered and verified live.

All figures were measured on 2026-11-24 with GET requests only against `https://api.inkcartridges.co.nz`:
`GET /api/shop` for every brand in `/api/brands`, ink and toner (3,366 rows), `GET /api/products/<sku>`, and
`GET /api/search/smart`. Printer lists are `compatible_printer_slugs` on the listing rows.

---

## §1 Brother split-black 4-packs: LC135 and LC235 (8 new value packs)

**Ask:** generate 8 KCMY value packs. Each one combines a colour series with the black that fits the same
printers. Price them, name them, set their constituents and tag their series codes the way the pack generator
does for any other value pack. The FE does not compute pack prices.

**Why:** in these two series the colours have one code, and each printer group uses a black with a different code.
Today we sell only the CMY 3-packs. A customer must buy the black separately and cannot buy a 4-pack.

| Colours | Colours fit | Black | Black fits |
|---|---|---|---|
| LC135 C/M/Y | DCP-J4110DW, MFC-J4410DW, MFC-J4510DW, MFC-J4710DW, MFC-J6520DW, MFC-J6720DW, MFC-J6920DW | LC137XL | DCP-J4110DW, MFC-J4410DW, MFC-J4510DW, MFC-J4710DW |
| | | LC139XL | MFC-J6520DW, MFC-J6720DW, MFC-J6920DW |
| LC235XL C/M/Y | DCP-J4120DW, MFC-J4620DW, MFC-J5320DW, MFC-J5720DW | LC237XL | DCP-J4120DW, MFC-J4620DW |
| | | LC239XL | MFC-J5320DW, MFC-J5720DW |

The 8 packs, built from singles we already sell:

| New pack | Constituents | Printers (= the black's printers) |
|---|---|---|
| Genuine LC137XL + LC135XL KCMY | GLC137XLBK, GLC135XLC, GLC135XLM, GLC135XLY | the 4 J4 models |
| Genuine LC139XL + LC135XL KCMY | GLC139XLBK, GLC135XLC, GLC135XLM, GLC135XLY | the 3 J6 models |
| Compatible LC137 + LC135 KCMY | CLC137BK, CLC135C, CLC135M, CLC135Y | the 4 J4 models (see §3) |
| Compatible LC139XL + LC135 KCMY | CLC139XLBK, CLC135C, CLC135M, CLC135Y | the 3 J6 models |
| Genuine LC237XL + LC235XL KCMY | GLC237XLBK, GLC235XLC, GLC235XLM, GLC235XLY | DCP-J4120DW, MFC-J4620DW |
| Genuine LC239XL + LC235XL KCMY | GLC239XLBK, GLC235XLC, GLC235XLM, GLC235XLY | MFC-J5320DW, MFC-J5720DW |
| Compatible LC237XL + LC235XL KCMY | CLC237XLBK, CLC235XLC, CLC235XLM, CLC235XLY | DCP-J4120DW, MFC-J4620DW |
| Compatible LC239XL + LC235XL KCMY | CLC239XLBK, CLC235XLC, CLC235XLM, CLC235XLY | MFC-J5320DW, MFC-J5720DW |

**Where they must show (owner requirement):** under the colour set's code, next to the existing CMY packs.
That is `/shop?category=ink&code=LC135` (and `code=LC235`), on the listing and in the code tile count.
Each pack must also show under its black's code (`code=LC137`, `LC139`, `LC237`, `LC239`), so a customer who
starts from the black finds it too. `G932XLCMYK` already works this way (`series_codes: ['932','933']`).
The FE reads `series_codes`, so it needs no change for either. If series codes come from the product name,
the name must carry both codes.

**Name (owner requirement):** the name must say which black is inside, for example "LC139XL + LC135XL".
Two packs share the same colours and differ only in the black. A name that only says "LC135 KCMY" would let
a J4 customer buy the J6 black.

**Please reply with:** the 8 SKUs and their prices, and confirm that `/api/products/<sku>/constituents`
returns 4 rows for each one.

---

## §2 HP split-black 4-packs (same pattern as §1)

**Ask:** the same as §1 for the HP series where the black and the colours have different codes and fit the
same printers. Please generate the KCMY packs that are missing:

| Series | Printers | KCMY pack today | Missing |
|---|---|---|---|
| HP 932 black + 933 colours | 7 (same 7 for both) | genuine `G932XLCMYK` only | compatible: C932XLBK + C933XLC/M/Y |
| HP 934 black + 935 colours | 3 (same 3 for both) | none | genuine XL: G934XLBK + G935XLC/M/Y; genuine standard: G934BK + G935C/M/Y; compatible: C934XLBK + C935XLC/M/Y |
| HP 950 black + 951 colours | 7 (same 7 for both) | none | genuine: G950XLBK + G951XLC/M/Y; compatible: C950XLBK + C951XLC/M/Y |

Each of these series has CMY packs already (`G933XLCMY`, `C933XLCMY`, `G935CMY`, `G935XLCMY`, `C935XLCMY`,
`G951XLCMY`, `C951XLCMY`). The same requirements apply: show under both codes, and the price comes from the pack
generator.

**Not asked, for your information:**
- **HP 970 + 971:** 970 fits 4 printers and 971 fits 8, so 970 is not the only black for 971. No pack asked until the
  other 4 printers' black is known. Compatible 971 also has no magenta single (`C971XLC`, `C971XLY` only).
- **HP 647A + 648A toner:** we stock 648A cyan and yellow only, so no 4-pack can be built.

---

## §3 CLC137BK printer list disagrees with GLC137XLBK

`CLC137BK` (compatible) lists 7 printers: the 4 J4 models plus MFC-J6520DW, MFC-J6720DW and MFC-J6920DW.
`GLC137XLBK` (genuine) lists only the 4 J4 models.

**Ask:** check against the maker's list and correct whichever row is wrong. Until then, the compatible LC137 pack
in §1 should fit the 4 J4 models only.

---

## §4 C950XLBK carries the wrong series codes

`C950XLBK` (HP 950XL compatible black) has `series_codes: ['950XL', '951']`. Every other 950/951 row has the bare
code (`G950XLBK` = `['950']`). So this black single is tagged with the colour code 951, and with `950XL` instead
of `950`.

**Ask:** make it `['950']`, like `G950XLBK`.

---

## §5 Search: an exact code match ranks last

`GET /api/search/smart?q=LC139` returns 20 products. The 2 LC139XL products (`GLC139XLBK`, `CLC139XLBK`) are
positions 19 and 20. The 18 above them are LC133, LC135 and LC3313 rows. `intent` is all null.

**Ask:** rank products whose series code exactly matches the query (yield variants included, so `LC139` matches
`LC139XL`) above fuzzy matches.

---

## §6 50 products return fewer printer slugs than their printer count

On these rows, `compatible_printer_slugs` is shorter than `compatible_printers_count` (slugs / count). The FE uses
the slugs for printer matching, so the missing printers are not matched. It looks like printers without a slug.

G61CLR 28/29, G61XLBK-2 25/26, C61XLBK 25/26, C61XLCLR 25/26, G62BK 13/14, G62CLR 11/14, G62XLBK 18/21,
G62XLCLR 11/14, C62XLBK 18/21, C62XLCLR 18/21, G70 9/12, G70C 9/12, G70M 9/12, G70Y 9/12, G70PBK 9/12,
G70MBK 9/12, G70LC 9/12, G70LM 9/12, G70GY 9/12, G70RD 9/12, G70BL 9/12, G70GR 9/12, G70LGY 9/12,
G70CMY 9/12, G727130MLC 7/8, G727300MLC 7/8, G727130MLM 7/8, G727300MLM 7/8, G727130MLY 7/8, G727300MLY 7/8,
G727130MLPBK 7/8, G727300MLPBK 7/8, G727300MLMBK 7/8, G727130MLGY 7/8, G727300MLGY 7/8, G727130MLCMY 7/8,
G727300MLCMY 7/8, G728130MLC 2/3, G728300MLC 2/3, G728130MLM 2/3, G728300MLM 2/3, G728130MLY 2/3,
G728300MLY 2/3, G728130MLMBK 2/3, G728300MLMBK 2/3, G728130MLCMY 2/3, G728300MLCMY 2/3, C90XBK 14/15,
G90ABK 14/15, G90XBK 14/15

**Ask:** give the missing printers a slug, or tell us which printers they are and why they have none.
