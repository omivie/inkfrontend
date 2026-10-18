# Backend response to the 15 and 16 October FE files

**From:** backend · **Date:** 17 October 2026 (NZDT)

This one file answers all three of your files from 15–16 October:

- `backend-asks-2026-10-15.md` (15 Oct): series counts, pack names, Admin Pricing page, net-margin sort, quote PDF, notes.
- `backend-asks-2026-10-15` (filed 16 Oct), your master list: §1–§8. Below, **"File A"**.
- `backend-asks-2026-10-16.md`, the printer-match file: §1–§2. Below, **"File B"**.

It replaces our two earlier replies (`backend-asks-15oct-…` and `backend-asks-16oct-…`). Nothing in them is lost.

**Everything below is live.**

| Deploy | Time |
|---|---|
| Series counts, pack-name code | 05:12 UTC 15 Oct (18:12 NZDT) |
| Pack rename, 826 rows | 05:13–05:29 UTC 15 Oct |
| Admin Pricing page | 05:39 UTC 15 Oct |
| Printer list, titles, pack contents, points | 23:18 UTC 16 Oct (12:18 NZDT 17 Oct) |
| Breadcrumb title | 06:25 UTC 17 Oct |
| Retired printer rows | 08:44 UTC 17 Oct |
| Net-margin sort, quote PDF | 20:10 UTC 12 Oct (09:10 NZDT 13 Oct) |

Edge caches can hold old `/api/*` answers for up to 5 minutes after a change.

---

## What you need to do

1. **Titles:** show `display_name` exactly as sent, everywhere, and delete `ProductName.build` and `packRename`. `ProductName.clean` now changes only the 46 packs waiting for owner names; delete it once they are named. See [Product titles](#product-titles-err-341) and [Pack names](#pack-names-err-335).
2. **Series tiles:** delete `_recountChipsFromListing`. Ask for drums with `category=drums`, never `category=consumable`. See [Series tile counts](#series-tile-counts-bf-102).
3. **Toner ⇄ drum match:** match on `compatible_printer_slugs` on each `/api/shop` row. When the field is missing, fall back to your sample. See [Printer list](#printer-list-on-apishop-rows-file-b-1).
4. **Pack contents:** read `quantity`, `page_yield` and `contents_known` on `/constituents`, and `page_yield_pages` on products. `is_complete` keeps its meaning. See [Pack contents](#pack-contents-err-340).
5. **Points checkout:** read the new `loyalty` fields, and place a $0 order with `payment_method: "points"`. Handle the new error codes; `EXCEEDS_ORDER_TOTAL` replaces `EXCEEDS_CART_SUBTOTAL`. Hide the wallet buttons when the total is $0. See [Loyalty points](#loyalty-points-pay-the-whole-order-err-345).
6. **Admin Pricing page:** use the parameter names we built (rename table in that section), and show `gross_margin_pct` in the "Gross margin" column. `POST /api/admin/pricing/bulk` replaces the per-product loop. See [Admin Pricing page](#admin-pricing-page-err-336).
7. **Net-margin sort:** map the two columns to the sort keys, and remove the tooltip note.
8. **Quote PDF:** nothing to change.

**Optional:**
- **Old pack URLs:** www answers 200 with the new canonical. If you want a hard 301 on www, see [Pack names](#pack-names-err-335), ask 2.
- **Old printer URLs:** a shopper on a retired printer URL sees the real printer's products, but the address bar keeps the old slug. To fix that, replace it with `printer.slug` from the response. See [Toner compatibility gaps](#toner-compatibility-gaps-file-b-2).

## What we need from you

- **Colour mismatches:** the 16 SKUs, if you still see any after this deploy. We found only one (C67XXLRD), and it is fixed.
- **Printer rows:** which of the 5 unconfirmed printer rows we should review first.
- **Option (b):** tell us if you want the server to pair toner and drum tiles by printer. Today it pairs them by code.

**Waiting on the owner, not on you:** names for 46 packs, and the names of 89 HP DesignJet inks.

---

## Status by file

| File | § | Ask | Status |
|---|---|---|---|
| 15 Oct | 1 | BF-102 series counts | **Done**, all three asks |
| 15 Oct | 2 | ERR-335 pack names | **Done**: 826 renamed, with 301s; 46 wait for the owner |
| 15 Oct | 3 | ERR-336 Admin Pricing page | **Done**, all eight asks |
| 15 Oct | 4 | ERR-311 net-margin sort | **Live since 12 Oct** |
| 15 Oct | 5 | ERR-316 quote PDF | **Live since 12 Oct**; two items left out on purpose |
| 15 Oct | 6 | ERR-312/313 notes | Answered below |
| A | 1 | BF-102 tile counts | **Done.** You confirmed it in File B |
| A | 2 | Product titles (ERR-341) | **Done.** Owner chose a separate title field, not a rename |
| A | 3 | Admin Pricing page (ERR-336) | **Live.** Your names differ from the ones built; see the rename table |
| A | 4 | Pack contents (ERR-340) | **Done** |
| A | 5 | Net-margin sort (ERR-311) | **Live** |
| A | 6 | Quote PDF (ERR-316) | **Live.** "Valid until" stays out: owner decision |
| A | 7 | Three confirmations | Answered below |
| A | 8 | Points pay the whole order (ERR-345) | **Done** |
| B | 1 | Full printer list on `/api/shop` rows | **Done:** option (a), `compatible_printer_slugs` |
| B | 2 | Toner compatibility gaps | **43 links added; 13 duplicate printer rows retired**; 5 rows for review |

---

## Series tile counts (BF-102)

15 Oct §1 and File A §1. Live since 05:12 UTC 15 Oct (commit `b6a4584`).

### Ask 1: the count uses the listing's predicate

A tile's `series[].count` is now the number of rows its `?code=` click returns.
- The count uses the listing's own test: the same `buildSeriesCodeMatchSet` code match over the same product codes, including `product_codes` overrides.
- It runs the same two de-duplication passes the listing runs.
- A tile whose listing would be empty is no longer sent.

The old count disagreed for two reasons:
- A product tagged into a category for one code was counted under **every** code it carries. `CDR2415BK` is tagged into toner for TN2415 and TN2449, so it was also counted on the toner DR2415 tile, which never listed it. The same rule produced the toner DR2530 tile ("2", opening nothing) and the drums TN2445 tile.
- The listing's de-duplication never ran on the count.

**Replayed against production:** every brand × ink/toner/drums/label/paper/ribbon gave 0 tiles whose count differs from its listing (1,215 tiles on 15 Oct, 2,363 on 16 Oct). Two tiles disappeared, and both opened empty pages before: toner DR2530 and drums TN2445.

Your `probe:chip-counts` should log nothing, so you can delete `_recountChipsFromListing`.

### Ask 2: toner and drums include each other

For `category=toner` and `category=drums` only:
- **Count:** a row of the other category counts toward a tile when its own codes contain the tile's code.
- **`?code=` listing:** returns both categories' rows on the same rule.
- **Which tiles appear:** tiles are still made only from the page's own category. The toner page gets no drum-only tile; a drum's code becomes a toner tile only when a toner carries that code.
- **Unchanged:** a listing with no `?code=` still shows only its own category. The `counts` object and every other category are unchanged.
- **Facets** for a toner/drums `?code=` page use the same rows.

Brother on production:

| page | tile | count = rows listed |
|---|---|---|
| toner | DR2415 | **6** (4 toners + the genuine drum + the compatible drum) |
| toner | TN2415 / TN2445 / TN2449 | 4 / 2 / 5 |
| toner | DR2530 | gone (no toner carries it) |
| drums | DR2415 | 6 |
| drums | TN2445 | gone (no drum carries it) |

`?code=DR2415` on toner lists GDR2415BK, CDR2415BK, GTN2415BK, GTN2445BK, CTN2445BK and CTN2449BK.

**Your File A ask 2 says `category=consumable` for drums.** The drums category is `category=drums` (alias `drum-units`). `consumable` is a retired alias that applies **no** category filter. A `category=consumable` request is therefore brand-wide, and the toner ⇄ drums pairing does not apply to it.

**The 16 Oct owner decision changes the pairing rule.** Toners and drums now match **by printer** (see [Printer list](#printer-list-on-apishop-rows-file-b-1)). The server-side counts and the `?code=` listing still pair by code, as BF-102 specified. If you want the server to pair by printer too, so your tile counts need no recount, ask for option (b) and we will build it.

### Ask 3: the family fold

We chose **tagging**, as you preferred.

**What the "fold" was.** It was not a family rule. When a `?code=` listing found **zero** rows, the route fell back to the printer with that model name and listed everything linked to it. On the drums page, `?code=C544` matched no drum, so it listed the products linked to the Lexmark C544 printer, which include the C540 drum. With ask 2 the toner and drums listings find the toners first, so that fallback no longer fires for these tiles.

**What we tagged** (21 `product_codes` rows). Each drum or waste unit now also carries the code of the toner family it serves. The products' own codes stay first, so `series_codes[0]` and the family key do not move.

| SKU | codes now | now shows under |
|---|---|---|
| GC540X35GBK, GC540X75G | C540, **C544** | C544 |
| G10B3100 (waste) | 10, **C780** | C780 |
| GE260X22GBK | E260, **E360, E460, X264, X463** | E360, E460, X264, X463 |
| GE250X22GBK | E250, **E450** | E450 |
| GC950X71GBK, GC950X76G | C950, **X950** | X950 |
| GMB451BK | MB451, **B401** | B401 |
| GB431BK | B431, **B411** | B411 |

These rows appear under those tiles in both the count and the listing, with no frontend change. A tagged drum also gets the matching tile on the drums page (drums E360 lists the E260 drum and the E360 toners).

**What we did not tag.** The same fallback would also have put 13 OKI drums, belts and fusers under other toner tiles: B412, B432, B512, C301, C321, C330, C332, C510, C530, C810 and C910. Those come from printer-compatibility links, and several are wrong (the C9600 drum does not fit the C910). We left them untagged until the links are reviewed. Your frontend already drops them, so nothing you show changes.

---

## Printer list on `/api/shop` rows (File B §1)

**Done: option (a).** Live since 23:18 UTC 16 Oct. Every `/api/shop` row now carries `compatible_printer_slugs: string[]`: every active printer the product fits, slugs only, sorted.

- **Unchanged:** `compatible_printers` (max 2, for the "Fits …" line) and `compatible_printers_count`.
- **Duplicate printer rows fold onto one slug.** One machine listed twice in our data yields one slug, so a drum on one twin and a toner on the other still match.
- **A failed lookup leaves the field absent, never `[]`.** `[]` means the row fits no printer we know. When the field is absent, fall back to your sample.
- **Size:** about 120 bytes per row on average. 95% of toner/drum rows fit 13 printers or fewer; the most is 47.
- **Scope:** only `/api/shop` carries it. The other listings make no extra call.

Measured live: CTN1070BK lists 6 printers and the DR1070 drums 8. They share 6.

---

## Toner compatibility gaps (File B §2)

### Ask 1: missing toner rows

**43 links added on 17 Oct** (genuine and compatible, every colour). Each family/printer pair was checked against Brother's own NZ/AU supplies pages first.

| Toner | Added to |
|---|---|
| TN1070 | DCP-1510, **DCP-1610W**, MFC-1910W |
| TN233, TN237 | HL-L3230CDW |
| TN233 | HL-L3210CW |
| TN446 | HL-L9310CDW |
| TN2315, TN2345 | HL-L2380DW |
| TN3185 | DCP-8060 |

- `GET /api/products/printer/brother-dcp-1610w` now returns TN1070 as well as the drums.
- Every link went through our compatibility guards (suppression list, type check, cross-brand check). A rollback file exists.

### Ask 2: printers with a Brother drum but no toner sharing it

There were 26. 8 were fixed by ask 1, 13 are retired, and 5 remain for review.

**Duplicate or typo printer rows: retired on 17 Oct (owner's go).**
- Each was a second row for a machine whose real row already lists its toners. It showed a drum-only page because the drum was linked to both rows.
- Each row below is now hidden and 301s to its real row. This applies to `/api/printers/:slug/products`, `/api/products/printer/:slug` and the bot prerender, which sends crawlers to `/shop?brand=brother&printer_slug=<real>`.
- Two twins held a drum link the real row lacked: genuine DR150CL on DCP-9042CDN, and genuine DR3000 on MFC-8840D. We copied both to the real rows first, so no page lost a product.
- **Your side (optional):** the SPA's fetch follows the 301, so a shopper on an old URL already sees the real printer's products. The address bar keeps the old slug. Both endpoints return the real slug in `printer.slug` if you want to replace it.

| Retired row | Real row |
|---|---|
| `brother-dpc-1510` | `brother-dcp-1510` |
| `brother-hl-1210w-printer` | `brother-hl-1210w` |
| `brother-hl-2070` | `brother-hl-2070n` |
| `brother-hl-l2310` | `brother-hl-l2310d` |
| `brother-hl-l2375` | `brother-hl-l2375dw` |
| `brother-mfc-7440n` | `brother-mfc-7440` |
| `brother-mfc-7820` | `brother-mfc-7820n` |
| `brother-mfc-l2713` | `brother-mfcl2713dw` |
| `brother-mfc-l2770` | `brother-mfcl2770dw` |
| `brother-mfc8840` | `brother-mfc-8840d` |
| `brother-dcp-9042` | `brother-dcp-9042cdn` |
| `brother-dcp-l355cdw` | `brother-dcp-l3551cdw` |
| `brother-hll-3230cdw` | `brother-hl-l3230cdw` |

**Not changed: we could not confirm the toner from Brother.**

| Row | Drum linked | Why not added |
|---|---|---|
| `brother-hl-l9430cdn` | DR851CL | TN851 likely; only a reseller lists it |
| `brother-mfc-8380dn` | DR3115 | no Brother source for this model; the DR3115 link itself may be wrong |
| `brother-fax-2890` | DR2025 | no such Brother model found |
| `brother-hl-2060` | DR2025 | HL-2060 is a much older machine; the drum link is probably wrong |
| `brother-hll-3210cdw` | DR233CL | no HL-L3210CDW model exists |

Tell us which of these to review first. A wrong link we remove goes on our suppression list, so the nightly import cannot re-add it.

---

## Pack names (ERR-335)

15 Oct §2. Code (commit `90e32b2`) live at 05:12 UTC 15 Oct; the rename ran 05:13–05:29 UTC.

- **The rename:** 826 rows and 826 slug 301s written. 1,061 older redirect hops were re-pointed to the new addresses, with 0 conflicts. A dry run afterwards finds 0 rows left to rename.
- **Live check:** `GET /api/products/CLC3313KCMY` returns "LC3313KCMY Compatible Ink Cartridge for Brother LC3313 KCMY-Pack", slug `…-lc3313-kcmy-pack`, no stored `meta_title`.
- **Redirects:** both older addresses (`…-kcmy-4-pack/CLC3313KCMY` and the legacy `C-BRO-LC3313-INK-KCMY` one) 301 straight to the new one.

### Ask 1: rename the stored names

Done by one script. It uses the same rewrite the importers and the pack generator now run (`applyPackColourNameGrammar`), so a renamed row and a newly made pack can never disagree.

Your rule, applied server-side:
- A pack whose colour code is KCMY, CMYK or BCMY, and whose name says "4-Pack", is named `… KCMY-Pack`.
- A pack whose colour code is CMY, and whose name says "3-Pack", is named `… CMY-Pack`.
- The words "Value Pack" are dropped from those names.
- A row whose colour code is `Value Pack` is renamed only when its own name puts the colour next to the count (`KCMY 4-Pack`, `CMY 3-Pack`). A bare "4-Pack" on such a row is left for the owner.

| | Rows |
|---|---|
| Renamed | **826** (442 CMY, 371 KCMY, 3 CMYK, 10 with colour `Value Pack`), the same 826 your CSV found |
| Left for the owner | **46**, the same 46 your CSV marked NEEDS OWNER (list below) |
| Refused (slug taken, or a redirect already leaves the new address) | 0 |

- 21 of the 826 have a hand-set name and 2 are import-locked. They are renamed too, because this is the owner's own wording rule. The pin still protects the new name from the importer.
- The script writes the name and slug, and clears the stored `meta_title`. It never changes the SKU, the price or the image.
- **Replayed before writing.** For each of the 826 rows we compared every value the backend reads from a product name, on the old name and the new one: series codes and chips, the generator's series keys, yield tier, pack de-duplication tier, cousin-pack codes, catalogue sort keys, the colour-sequence check and the generator's pack index. All are identical, so chips, grouping, sort order and pack matching do not move.

**The 46 rows the owner will name:**
- **Two different cartridges in one box (8):** `GPG640VPVP` Canon PG640/CL641 2-Pack · `GPG645VPVP` PG645/CL646 2-Pack · `GPGI650XLVPVP` PGI650XL 2-Pack · `GPGI670XLVPVP` PGI670XL 2-Pack · `GBCI16VP` BCI16 Colour 2-Pack · `G804VPVP` HP 804 Black + Tri-Colour 2-Pack · `G60BKCLRVP` HP 60 Black/Colour Combo Pack · `G3YP09AABKCLRVP` HP 3YP09AA Black/Colour Combo Pack.
- **Colour code `Value Pack` with a bare "4-Pack" or "HY 4-Pack" (5):** `G604VPVP` Epson 604 · `G67VPVP` HP 67 · `GCLI651XLVPVP` Canon CLI651XL · `GCLI671XLVPVP` Canon CLI671XL · `G252VPVP` Epson 252 HY.
- **XL black plus three standard colours (2):** `G212XLKCMY` Epson 212XL · `G288BXLCMY` Epson 288XL, both named "Black + 3 Standard Colours Value Pack".
- **Two or three of the same colour (14):** `G12ABK-2PK`, `G78ABK-2PK`, `G85ABK-2PK`, `GW1143ADBK-2PK`, `G45BK-2PK`, `GLC39BK-2PK`, `GTN2530XLBK-2PK`, `GTN258XLBK-2PK`, and the HP 711 / 712 29ml Cyan, Magenta and Yellow 3-Packs (`G71129MLC-3PK`, `G71129MLM-3PK`, `G71129MLY-3PK`, `G71229MLC-3PK`, `G71229MLM-3PK`, `G71229MLY-3PK`).
- **Photo value packs (4):** `GLC73PHVP`, `GLC133PHVP`, `GLC233PHVP`, `GLC3317PHVP`.
- **Paper, labels and a fuser stored as packs (13):** `G20PKVP-3`, `GRP54VP`, `GRP108VP`, `G7737A001AHVP`, `GPP301SQ5IN20VP`, `GPT101A320VP`, `G-CAN-10PK-PPR-10PK`, `G-CAN-50PK-PPR-50PK`, `G-CAN-101-PPR-200PK`, `G-DYM-12MM-LBL-2PK`, `GTZE33M3BKVP`, `G1741670BK-3PK`, `GCC383AVP`. Some of these may not be packs at all.

### Ask 2: 301 every slug that moves

Done in the same script. Each moved slug gets a `slug_redirects` hop from `/products/<old-slug>/<SKU>` to `/products/<new-slug>/<SKU>`. A hop that already pointed at the old address is re-pointed to the new one, so nothing chains. The PDP still resolves by SKU, so an old link never 404s.

Measured on production after the rename, for the old CLC3313KCMY address `/products/lc3313kcmy-compatible-ink-cartridge-for-brother-lc3313-kcmy-4-pack/CLC3313KCMY`:

| Request | Result |
|---|---|
| `api.inkcartridges.co.nz` + old path | **301** to `https://www.inkcartridges.co.nz/products/…-kcmy-pack/CLC3313KCMY` |
| `www` + old path, as Googlebot | **200**, prerendered with the new title and `<link rel="canonical">` pointing at the new address |
| `www` + old path, as a browser | **200**, the PDP (resolved by SKU) |

So www does not send a hard 301; it serves the page with the new canonical. This is not new: an August hop (`/products/compatible-drum-unit-for-brother-dr233cl-18000-pages/CDR233CLBK`) also answers 200 on www. The backend's hops exist for all 826 rows, so a www 301 is a change on your side.

- **If you want one,** your middleware can ask `GET https://api.inkcartridges.co.nz/products/<slug>/<SKU>`. It answers 301 with the new address when a hop exists, and passes through when none does.
- **Shopping already uses the new addresses.** The live Shopping feed lists 0 old pack addresses.

### Ask 3: the importers keep the new grammar

One rewrite runs last wherever a pack is named:
- both supplier importers (`prepareProductForBatch`);
- the pack generator and `generate-missing-packs` (`buildPackProductRecord`, `buildCompatiblePackName`);
- the consumables sync and two one-off pack scripts that type a name.

**Checked against the real feed.** We ran the genuine importer's own row mapping and naming over the 14 October DSNZ feed file (87 feed packs).
- **None** comes out with the old wording.
- 72 come out exactly as the live row is named.
- The rest are hand-named rows (the importer keeps those), inactive rows, and one older name difference unrelated to packs (G126ACMY).

The pack generator's dry run still recognises every renamed pack, and plans no duplicate. So the next import cannot bring "4-Pack" back.

### Ask 4: SEO title, Merchant Center, emails, naming spec

- **Page `<title>`:** generated from the product, not the stored name. It reads `KCMY-Pack` / `CMY-Pack`, for example "Brother LC3313 Ink Cartridge KCMY-Pack - Compatible". The stored `meta_title` is cleared on every renamed row, so the generated title wins.
- **Merchant Center, compatible:** a full colour set reads "LC73 Compatible KCMY-Pack — 600 pages each Ink Cartridge — Fits Brother". Other packs keep "Value Pack".
- **Merchant Center, genuine:** since 16 Oct a genuine row's Shopping title is the descriptive title (see [Product titles](#product-titles-err-341), ask 6).
- **Order emails and invoices** print the name stored on the order line when it was bought. New orders show the new name; past orders keep the old one.

### Ask 5: when you can delete the bridge

Now, except for the 46 owner rows. The stored names, slugs, page titles and Shopping titles carry the new grammar, so your `ProductName.clean` rewrite changes only those 46. Delete it once the owner has named them.

---

## Product titles (ERR-341)

File A §2. Live since 23:18 UTC 16 Oct.

**Owner decision, 17 Oct:** the descriptive title ships as a **separate, computed title**. Stored product names, SKUs and URLs do not change.

The stored name is not cosmetic: the series chips, the pack generator, SKU generation and pack matching all read it, and every URL is its slug. Rewriting it would have changed 3,345 URLs, the day after the 826 pack renames, and put each of those systems at risk. A computed title gives customers and Google the same words without either cost.

### Ask 1: the new title

Every product response now carries **`display_name`**, in your format:

`Brother LC432XL Compatible Ink Cartridges – 4 Colour Set BK, C, M, Y – High Yield`
`HP 126A Compatible Toner Cartridge – Cyan (~1,000 pages)`

- **Always present** when `name` is. When the title cannot be composed, `display_name` is the stored name, so you can show `display_name` verbatim everywhere.
- **Parts of the title:**
  - **Brand and code:** the code keeps its tier (`LC432XL`, `126A`, `213Y`).
  - **Genuine/Compatible**, then the type, plural for packs.
  - **Colour:** the colour, or `4 Colour Set BK, C, M, Y` / `3 Colour Set C, M, Y` on a pack.
  - **Tier:** `High Yield` / `Extra High Yield`, from the part's own number, never from a page count. HP's own suffix counts: X = High Yield, Y = Extra High Yield (81X, 26X, 89Y). Drums never get a tier.
  - **Pages:** ` (~N pages)` on singles only. Packs never show pages.
- **Measured over all 4,121 live products:** **3,350 composed** (your probe: 3,345 of 4,117), 0 duplicate titles, longest 88 characters, 0 hits on the banned-claims list.
- **Where it appears:**
  - `/api/shop`, `/api/products`, `/api/products/:sku`;
  - `/api/search/smart`, `/by-part`, `/by-printer`;
  - both printer grids;
  - cart lines (`items[].product.display_name`) and the free-shipping suggestions;
  - the bot-rendered PDP.
- **`/api/products/:sku` already had a `display_name`** (the stored name minus its "Genuine"/"Compatible" prefix). It is now the new title wherever one composes, and the old value otherwise.

### Ask 2: the rows that keep their stored name

Each class keeps its stored name until the owner names it:

| Class | Rows |
|---|---|
| label tape | 258 |
| no code (HP ml-volume inks like "711 29ml", imaging kits, photo value packs) | 180 |
| printer ribbon | 82 |
| fuser kit | 58 |
| photo paper | 55 |
| waste toner | 42 |
| pack contents not a plain colour set ("Value Pack" colour, "Black + 3 Standard Colours", two-cartridge boxes) | 26 |
| typewriter ribbon | 22 |
| twin / same-colour multipacks (`-2PK`, `-3PK`) | 14 |
| belt unit | 11 |
| maintenance box | 9 |
| correction tape | 6 |
| fax film / refill | 5 / 2 |
| colour mismatch | 1, fixed (see ask 3) |

### Ask 3: colour mismatches

Our check compares each row's colour column with the colour its name states. It found **one** real contradiction, your example: **C67XXLRD** ("67XXLRD Compatible Ink Cartridge for HP 67XXL Tri-Colour", stored as Red).

**Fixed:**
- the colour is now Tri-Colour, with the CMY swatch colours;
- the slug moved, with a 301;
- the Merchant Center resync was queued.

HP's own part numbers back it: 67 and 67XL are tri-colour cartridges.

We could not reproduce the other 15 of your 16.
- **Likely culprits:** 11 compatible mono drums whose names carry no colour word ("Compatible Drum Unit for Brother DR2415", colour Black). Those are not contradictions; they compose as "… Drum Unit – Black".
- **If others remain,** please send the 16 SKUs.

### Ask 4: 301s

No slug changes, because no stored name changed. The only exception is C67XXLRD above, which has its 301.

### Ask 5: importers

Nothing to change. The title is computed from the same columns every time it is served, so a new row gets it on its first read.

### Ask 6: `seo.title` and the other Google surfaces

- **Bot-rendered PDP:** the `<h1>`, `og:title`, the JSON-LD Product `name` and the last BreadcrumbList item are `display_name` (the breadcrumb since 06:25 UTC 17 Oct, also in `/api/products/:sku` `breadcrumbJsonLd`). That matches the h1 your page shows. Live example: CLC3313KCMY renders "Brother LC3313 Compatible Ink Cartridges – 4 Colour Set BK, C, M, Y".
- **`<title>`: unchanged** (`Brother LC3313 Ink Cartridge KCMY-Pack - Compatible`). It is the search-result title: searched code first, kept near 60 characters. The descriptive title runs up to 88 characters and Google would cut it.
- **Merchant Center, genuine:** the Shopping title is now the descriptive title. A single adds its top printer when the total stays within 150 characters, for example "Brother TN2445 Genuine Toner Cartridge – Black (~3,000 pages) for HL-L2350DW". This covers 2,587 of 3,214 genuine rows.
- **Merchant Center, compatible: unchanged on purpose.** Since the July 2026 Google Ads re-appeal, a compatible Shopping title never leads with the OEM brand: "TN2445BK Black 3,000 pages Compatible Toner Cartridge — Fits Brother HL-L2350DW". The descriptive format leads with the brand, and the suspension was about exactly that. On the site, where the shopper sees "Compatible" right after the code, the descriptive title is used for compatibles too.
- **Order emails and invoices** print the name saved on the order line at checkout (the stored name). Past orders keep it. Changing what is saved means changing the order-creation transaction, so we left it alone for now.

You can now delete `ProductName.build` and `packRename` and show `display_name` verbatim.

---

## Pack contents (ERR-340)

File A §4. Live since 23:18 UTC 16 Oct.

### Ask 1: `quantity` and `page_yield` on each row

`GET /api/products/:sku/constituents` now returns:

```json
{
  "pack_sku": "GLC432XLKCMY",
  "pack_type": "value_pack",
  "constituents": [
    { "sku": "GLC432XLBK", "name": "…", "color": "Black", "quantity": 1, "page_yield": 3000, "is_active": true, "in_stock": true },
    { "sku": "GLC432XLC",  "name": "…", "color": "Cyan",  "quantity": 1, "page_yield": 1500, "is_active": true, "in_stock": true }
  ],
  "is_complete": true,
  "contents_known": true
}
```

- **`quantity`** is an integer.
  - A twin or triple multipack says it on its one row: `G45BK-2PK` gives `G45BK` × 2. The number comes from the SKU's `-NPK`.
  - A colour pack is 1 per colour.
  - `pack_savings_vs_singles.cartridge_count` counts distinct SKUs, so it says 1 for a twin. Read `quantity` instead.
- **`page_yield`** is an integer number of pages, or `null` when the cartridge has no published yield. It is never estimated.
  - It is parsed from the stored text: "up to 550" gives 550, "250 ISO/IEC 24711" gives 250, and "1,600" gives 1600.
  - Ink measured in ml returns `null`, and so does any product type whose yield is not pages (labels, paper, ribbons). That follows the Merchant Center rule.
- **The rows are now what is in the box.** Until now the list was the product SERIES, so a pack showed cartridges it does not hold: C02KCMY listed Light Cyan and Light Magenta, and G712KCMY listed two black volumes. 62 packs did this.
  - A colour pack now lists exactly one cartridge per colour of the pack, in K → C → M → Y order.
  - A cartridge counts only when its yield tier matches the pack's (an XL single never fills a standard pack). Ink volume must match too, when both names state one.
  - When a colour has no cartridge, or two that nothing tells apart, the list is empty and `contents_known` is `false`. We do not guess.
  - A pack whose colour code gives no colour list to check against (Photo, Black/Colour, a supplier "Value Pack" code not in the box table) is also `contents_known: false`, never its series siblings.
- **New `contents_known`:** whether the list is the full contents.
- **`is_complete` keeps its meaning:** Add to Cart is allowed (contract F3: on `false` you grey the button out). It is computed exactly as before, for every pack, including the five boxes mapped by hand. We checked those five on production: old and new are both `true`. No pack's button changes.

**Also on product responses:** `page_yield_pages` (integer or `null`) now sits beside the text `page_yield` on every product row that carries it. It uses the same parser, so you never need to parse the text.

### Ask 2: packs that listed nothing but said complete

Measured on production, 874 active packs:

| | Before | After |
|---|---|---|
| Empty list with `is_complete: true` and nothing to say why | 46 | **0** |
| Contents listed (`contents_known: true`) | 828, 62 of them with cartridges the pack does not hold | **820**, each one exactly the box |
| `contents_known: false` | n/a | 54 |

- **5 supplier boxes are now listed.** Their SKUs (`…VP`) cannot be read by our pack rules, so each is mapped by hand, on the strength of the supplier's own part number:

  | Pack | Contents |
  |---|---|
  | GPG640VPVP | PG640XL + CL641XL. The part number is `PG640XLCL641XL`, the XL pair, although the name reads "PG640/CL641" |
  | G804VPVP | 804 Black + 804 Tri-colour |
  | G60BKCLRVP | 60 Black + 60 Tri-colour (HP CN067AA) |
  | GPGI650XLVPVP | PGI650XL Black × 2 (part number `PGI650XLBK-TWIN`) |
  | GPGI670XLVPVP | PGI670XL Black × 2 (part number `PGI670XLBK-TWIN`) |

- **GPG645VPVP** stays `contents_known: false`. Its colour cartridge, the standard CL646, is not in our catalogue, so we cannot list it. The same applies to the rest of the 41: paper, labels and one-colour boxes. All stay **buyable** (`is_complete: true`), because they are sold on their own stock.
- **13 colour packs** have a colour we cannot pin to one cartridge:
  - **Ambiguous or missing:** G712KCMY, CLC77XLKCMY, G932XLCMYK, GCT20065CMY / KCMY, GCT20348KCMY, GLC67CMY and GNPG034CMY.
  - **Only another yield tier on file:** G410KCMY is a standard pack whose resolved singles are the 410XL ones. CCF21KCMY and CCF38KCMY are standard packs whose resolved black is the XL 131X / 312X.
  - **Tier reads differently on each side:** GC5240HCMY / KCMY. The pack and its singles are both high-yield, but the names spell it differently.
  - We would rather show nothing than the wrong cartridge or yield.

### Ask 3: blank single yields

Filled on production on 16 Oct, each value from the manufacturer's own NZ/AU site:

| SKU | Pages | Source |
|---|---|---|
| GLC432BBK (LC432BK), GLC432C, GLC432M, GLC432Y | 550 | brother.co.nz / brother.com.au: "Prints up to 550 pages" |
| GLC432XLBK | 3,000 | brother.co.nz: "Prints up to 3,000 pages" |
| GLC432XLC, GLC432XLM, GLC432XLY | 1,500 | brother.co.nz / brother.com.au: "approx. 1,500 pages" |

- **Compatible rows** take their genuine counterpart's published yield, and **49** rows were filled this way, including CLC432XL × 4 and C273XL × 5 (T273 XL: Black 500, C/M/Y 650, Photo Black 400). The rule now also knows Epson's `G273HY…` genuine XL SKUs, which filled Epson 200/212/220/252 XL compatibles too.
- **Pinned:** every filled value is pinned, so the nightly import, whose feed has no yield for these rows, cannot blank it again.
- **Stored as text:** the column stays text; the API gives you the integer (`page_yield` on constituent rows, `page_yield_pages` on products).
- **Product names did not change.** Adding "(3,000 pages)" to a name moves its URL, so that stays a separate step.
- **Not every cartridge has a yield.** About 700 pack constituents still have no published yield, mostly compatibles whose genuine counterpart has none in the feed either. Those rows show `page_yield: null`, as you asked.

---

## Loyalty points pay the whole order (ERR-345)

File A §8. Live since 23:18 UTC 16 Oct.

**Owner decision (16 Oct):** a customer can spend as many points as they have, up to the whole order **including shipping**. An order paid entirely by points is placed at **$0**, with no card or PayPal step.

### Ask 1: `max_redeemable_points` covers the whole order

The cart's `loyalty` block now caps points at the **order total**: goods + shipping − volume/contract discount. Promo coupons are already mutually exclusive with points, so a coupon never stacks.

One rule keeps every order payable. Card and PayPal cannot charge less than $0.50, and a $0 order goes through the points path. So a redemption is valid in two cases only:
- it pays the order **exactly** (the order becomes $0); or
- it leaves **at least $0.50** to pay by card.

A redemption that leaves 1c to 49c is refused, because nothing can charge that amount.

| Field | Meaning |
|---|---|
| `max_redeemable_points` | What the Max button should send. When the balance covers the whole order, it **is** the full cover. Otherwise it is the most that still leaves $0.50. |
| `full_cover_points` | **New.** Points that make the order exactly $0, shipping included. |
| `max_partial_points` | **New.** The most points that still leave $0.50 for the card. |
| `shipping_estimated` | **New.** `true` when the full cover includes a shipping fee. The cart does not know the address yet, so it prices shipping for a North Island urban address. Checkout re-quotes for the real address, and a rural or South Island address can cost more; then the points no longer cover the order, and placing it answers `POINTS_TOTAL_NOT_ZERO`. When `true`, say "shipping estimated" beside the $0 total. `false` when shipping is free, which is exact for every address. |

- **Rounding:** points are whole points, 1 point = 1 cent at the live rate of 100 per dollar. Max is not rounded to 100: it is the exact cent figure, or the order would not reach $0. The live `redemption_increment` is 1. If an admin ever raises it, partial redemptions follow it, but the exact full cover never does.
- **If the cart changes after points are applied,** the cart response clamps the applied points (`stale_notice`, as before). A clamp lands on the full cover or the partial cap, never between the two.

### Ask 2: `POST /api/cart/loyalty` validates against the same total

Same rule, same numbers. The error codes:

| Code | Status | When |
|---|---|---|
| `EXCEEDS_ORDER_TOTAL` | 400 | More points than the order total ("That's more than your order total."). **Replaces `EXCEEDS_CART_SUBTOTAL`, which is no longer sent.** |
| `LEAVES_UNPAYABLE_BALANCE` | 400 | **New.** The points would leave 1c–49c. The message names both valid choices, e.g. "Use 4500 points to pay the whole order, or up to 4450 and pay the rest by card (at least $0.50)." |
| `EXCEEDS_AVAILABLE_BALANCE` | 409 | More points than the balance (unchanged). |
| `CONFLICTS_WITH_COUPON` | 409 | A coupon is applied (unchanged). |
| `BELOW_MIN_POINTS`, `NOT_MULTIPLE_OF_100`, `TEST_CART_NO_DISCOUNTS` | 400 | Unchanged. |

Both 400s carry `details: { max_redeemable_points, max_partial_points, full_cover_points, max_redeemable_dollars, order_total }`, so the page can offer the two valid amounts.

### Ask 3: free shipping is judged before points

Confirmed; nothing needed changing. The free-shipping threshold is tested on the **list goods subtotal incl. GST**, before the volume discount, any coupon or any points. Applying points can therefore never add a shipping charge.
- **Cart:** `src/routes/cart.js:603` (`subtotal >= FREE_SHIPPING_THRESHOLD`, where `subtotal` is Σ retail price × qty).
- **Checkout:** `src/routes/orders.js:1199` passes the list goods total to `calculateShipping`, which tests it at `src/services/shippingService.js:191`.

### Ask 4: $0 orders, `payment_method: "points"` on `POST /api/orders`

Same endpoint, same body, same auth, same idempotency. Only `payment_method` changes:

```
POST /api/orders
Authorization: Bearer <token>        (required — a guest has no points)
{ "items": [...], "shipping_address": {...}, "payment_method": "points", ... }
```

The order is placed only when **both** are true on the server: points are applied to the cart, and the server's own total, after shipping and points, is **exactly $0**. Your `summary.total` is a display figure; the server recomputes it.

**Success: 201.** The order is already `paid`. There is no `client_secret` and no PayPal step:

```json
{ "ok": true, "data": {
  "order_id": "…", "order_number": "2026101612",
  "status": "paid", "payment_method": "points", "payment_required": false,
  "total_amount": 0, "points_redeemed": 4500,
  "subtotal": 39.13, "gst_amount": 0, "shipping_cost": 5, "shipping_fee": 5, "shipping_tier": "…",
  "items": [...], "shipping_address": {...}, "created_at": "…",
  "google_customer_reviews": {...}
} }
```

Go straight to the confirmation page.

**What happens behind it:**
- The order, its lines and the stock decrement go through the same single transaction as every order.
- The points are deducted, and the order moves `pending → paid`.
- It runs **the same post-payment work as a card payment:** order email/invoice, cart cleared, supplier and admin notices, loyalty earn.

**A retry never places a second order.**
- **Double-click (same request still in flight):** the second request gets 409 `DUPLICATE_REQUEST`.
- **Retry after success:** the points are already spent and the cart is cleared, so the retry gets `POINTS_NOT_APPLIED`. If the first response was lost, check the customer's orders before placing again.

**An earlier card/PayPal attempt for the same cart.** The shopper may have started a card payment, then applied points. That earlier order is released, with its stock and any points it held returned, but **only when it is provably dead**. If its card payment went through or is still processing, or it cannot be cancelled, the points order is refused with 409 `PENDING_PAYMENT_IN_PROGRESS` (`details.order_number`). Two live orders never exist for one cart.

**Refunds.** An admin refund of a points-paid order makes no Stripe call (there is no payment to refund). The customer gets the points back.

| Code | Status | When |
|---|---|---|
| `POINTS_REQUIRE_ACCOUNT` | 401 | Sent without a signed-in user. |
| `POINTS_NOT_APPLIED` | 400 | No points are applied to the cart. A $0 total from anything else is not a points order. |
| `POINTS_TOTAL_NOT_ZERO` | 409 | The server total is above $0: the cart changed, or shipping for the real address costs more than the cart's estimate (see `shipping_estimated`). `details: { total, points_applied }`. Re-read the cart and offer card/PayPal for the rest. |
| `INSUFFICIENT_POINTS` | 409 | The balance changed between the cart and the order (unchanged code). |
| `POINTS_ORDER_FAILED` | 500 | The order could not be completed. It has been cancelled, and the points are back on the cart. |
| `PENDING_PAYMENT_IN_PROGRESS` | 409 | An earlier card/PayPal attempt for this cart is paid, still processing, or could not be cancelled. Wait, then check the customer's orders. |
| `DUPLICATE_REQUEST` | 409 | The same order request is already being processed (unchanged). |
| `POINTS_PAYMENT_REQUIRED` | 400 | A `stripe` or `paypal` order whose total is $0 because points cover it. Resend with `payment_method: "points"`. |

- **Wallet buttons:** hide them when `summary.total === 0`. A $0 order cannot go through Stripe.
- **Ads and analytics:** a $0 order is **not** sent to GA4 as a purchase and **not** uploaded to Google Ads as a conversion. No money changed hands.

### Ask 5: does the points-paid part of an order earn points?

No, and that has not changed. Points are earned on **what the customer paid for goods**: `order total − shipping`, where the order total is already net of the points.
- **Part-points order:** a $45 order ($40 goods, $5 shipping) with $20 in points totals $25, and earns on $25 − $5 = **$20** (20 points).
- **Points cover some shipping too:** the earn base would go below zero, so it is 0. Cash is treated as paying shipping first.
- **$0 points order:** earns **nothing**, including the 500-point second-order bonus.

A $0 order still counts as an order. So if a customer's second order is paid entirely by points, a later third order does not get the second-order bonus either.

---

## Admin Pricing page (ERR-336)

15 Oct §3 and File A §3. Live since 05:39 UTC 15 Oct (commits `822c208`, `bada3e5`). The `pricing_rules` table is applied. No rules exist yet, so no price has moved: a full-catalogue reprice dry run with zero rules changes 0 of 3,136 prices.

**Important: before 15 Oct, `PUT /api/admin/products/:id {manual_retail_price}` saved nothing.** The validator removed the field, and the route answered 200 with the old price. Your "Set exact price (locked)" and "Clear manual price" buttons therefore never changed a row, and any "Set exact price" run before 15 Oct changed nothing. The PUT accepts the field now (ask 7), and `POST /api/admin/pricing/bulk` replaces the per-product loop.

### Your File A names differ from the ones we built

We built the names in your 15 Oct file:

| File A says | Use |
|---|---|
| `min_price` / `max_price` | `price_min` / `price_max` (incl GST); also `cost_min` / `cost_max` (ex GST, owner only) |
| `action: set_exact` / `adjust_amount` | `set` / `adjust_abs` (also `adjust_pct`, `set_margin`, `clear_manual`) |
| `price_source: manual \| rule:<id> \| ladder` | `price_source: manual \| filter_rule \| brand_rule \| catalogue \| default \| pack \| ribbon`, plus `price_rule_id` |

The validator rejects an unknown parameter name with a 400 (`strictQuery`), so a wrong name fails loudly; it is never silently dropped.

### Your question: is `margin_pct` stale?

No. `products.margin_pct` is a generated column, so Postgres recomputes it whenever the price or cost changes. It is your formula **minus the 2.65% card fee**:

`margin_pct = (price_ex_gst − cost − card fee ex GST) / price_ex_gst` = gross margin − 2.65 points, exactly.

| SKU | Your formula | − 2.65 | `margin_pct` returned |
|---|---|---|---|
| C02BK | 37.7% | 35.05% | 35.1% |
| G-OKI-720-RIB-BK | 22.2% | 19.55% | 19.5% |
| G745MBK | 13.05% | 10.40% | 10.4% |

- **New field `gross_margin_pct`** (owner only) is exactly your formula, `(price_ex_gst − cost) / price_ex_gst`. Show it in the "Gross margin" column and drop the caveat.
- `sort=margin_pct` ranks rows exactly as gross margin would, because the two always differ by the same 2.65 points.

### 1. List: where each price comes from

Every `GET /api/admin/products` row now has:

| Field | Who sees it | Meaning |
|---|---|---|
| `has_manual_price` | every admin | `true` when the row is locked: it has a `manual_retail_price`, **or** an older price lock with no manual price (153 singles today). No reprice or rule moves either kind. |
| `manual_retail_price` | owner only | The locked price, or `null`. Other roles do not get the key at all. |
| `price_source` | every admin | `manual` · `filter_rule` · `brand_rule` · `catalogue` · `default`, plus **`pack`** and **`ribbon`** for rows the engine never prices (packs follow their singles, ribbons have their own ladder). |
| `price_rule_id` | every admin | The rule's id when `price_source` is `filter_rule`, else `null`. |

`price_source` names what the engine prices the row **by**. The shelf price can still sit higher than the rule price when the no-decrease ratchet holds it (ask 5).

### 2. List: new filter params

- `cost_min`, `cost_max`: ex GST. **Owner only.** A `stock_manager` request that sends either gets 403, because a cost filter reveals cost.
- `price_min`, `price_max`: incl GST.
- `has_manual=true|false`: same definition as `has_manual_price` above.
- `ids_only=true`: returns `{ ids: [...], total }` for the whole filtered set, in one call, up to 10,000 ids. It cannot express `stock_status=low_stock` (a column-to-column test) and returns 400 `UNSUPPORTED_FILTER` for it.
- **`pagination.total` is already sent** on every list response, in `data.pagination.total` and in `meta.total`. It is the size of the filtered set, not the page. If the page cannot see it, check which key it reads.

### 3. `POST /api/admin/pricing/bulk`

Owner only. Defaults: **`dry_run: true`** and **`lock: true`**. `confirm: true` is required whenever `dry_run` is false; otherwise the call returns 400 `CONFIRM_REQUIRED`.

- **`target`:** either `{ product_ids: [...] }` (1 to 2,000 ids) or `{ filter: {...} }`. The filter takes exactly the keys of the list, and `brand` takes a slug or an id.
  - **The filter must narrow the catalogue.** A filter with nothing but `is_active`, or with an empty `search`, would select every product, so it is refused with a 400. Send at least one other key.
- **Packs are never priced.** They are left out of every action, and the response says so (ask 8).
- **Caps:** a locked write covers at most **2,000 rows per call**. A larger target returns 400 `TARGET_TOO_LARGE`; narrow the filter, or save the change as a rule.
- **Not one transaction:** a bulk write is one UPDATE per row, and the response lists every row's outcome (`updated`, `unchanged`, `failed[]`). A failure part-way leaves the earlier rows written, and the response names them. Each row's price is its own fact, and nothing else (stock, orders) moves with it. Every write records one audit row with the full plan.

**The backend does every calculation.** All margins are gross margin on the ex-GST sell price.

| `action` | `lock: true` (a manual price) | `lock: false` |
|---|---|---|
| `set` | The typed price, exactly as typed: no ending and no margin floor. A price below cost after the card fee is refused for that row (`PRICE_BELOW_COST`). | 400 `RULE_NEEDS_MARGIN` |
| `adjust_pct` / `adjust_abs` | Applied to the current shelf price, then rounded **up** to .49 / .79 / .99 (ribbons .95 / .99), then floored. | 400 `RULE_NEEDS_MARGIN` |
| `set_margin` | `cost / (1 − m) × 1.15`, rounded up to an ending, then floored. A row with no cost fails with `NO_COST`. | Saves a **rule** for `target.filter` (ask 4). |
| `clear_manual` | Removes the lock and reprices the row now (ask 7). `lock` makes no difference. | — |

- **Floors:** a calculated price is never below the minimum retail ($5.49 compatible, $5.99 genuine) or below 2% net after the card fee. A floored row is still written, at the floored price, and counted in `blocked_by_floor`. A refused `set` is counted there too.
- **What a lock writes:** `manual_retail_price` and `retail_price` with the same value, plus the freeze flag. It also removes the nightly competitive-price audit's tag, so that audit stops treating the row as its own.
- **Why unlocked `set` and `adjust_*` are refused:** a rule stores one margin for a whole filter. "Add 5%" has no single margin across a filter, because the ladder gives every row its own multiplier. To move a filtered set without locking it, send `set_margin`.
- **Where a rule comes from:** an unlocked `set_margin` must target a filter, not ids (400 `RULE_NEEDS_FILTER`). The filter may use only `brand`, `source`, `product_type`, `category`, `cost_min` and `cost_max`. Any other key returns 400 `RULE_FILTER_UNSUPPORTED`, with `details.unsupported` listing the keys. `allow_decrease`, `priority` and `notes` may be sent alongside.

Dry-run response:

```json
{ "dry_run": true, "affected": 41, "unchanged": 3, "blocked_by_floor": 0, "blocked_by_no_decrease": 0,
  "sample": [{ "id": "…", "sku": "CTN2445BK", "old_retail": 56.49, "new_retail": 48.49, "margin_before": 47.07, "margin_after": 38.34 }],
  "failed": [{ "id": "…", "sku": "…", "code": "PRICE_BELOW_COST", "message": "…" }],
  "packs": { "excluded": 2, "repriced": false, "action_required": "…" } }
```

- `sample` holds up to 200 rows. `margin_before` and `margin_after` use your gross formula. `packs` is `null` when the target held no packs.
- A write returns `{ dry_run: false, updated, unchanged, failed: [{id, sku, code, message}], blocked_by_floor, sample, packs }`.
- Failure codes: `NOT_FOUND`, `PRICE_BELOW_COST`, `NO_COST`, `NO_PRICE`, `INVALID_PRICE`, `WRITE_FAILED`.
- A rule (unlocked `set_margin`) returns the rule shape from ask 4, with `job_id` in place of `updated`.
- Every write records one admin audit-log row: `PRICING_BULK`, or `PRICING_RULE_CREATE` for a rule.

### 4. Filter rules: `GET | POST /api/admin/pricing/rules`, `PATCH | DELETE /api/admin/pricing/rules/:ruleId`

Owner only. The shape:

```json
{ "filter": { "brand": "brother", "source": "compatible", "product_type": "toner_cartridge", "category": null,
              "cost_band": { "min": null, "max": null } },
  "margin_pct": 38, "allow_decrease": false, "priority": 0, "notes": "…", "confirm": true }
```

- **`filter`:** `brand` (or `brand_id`) takes a slug or an id. `category` is the stored value (`CON-INK`, `CON-LASER`, …). `cost_band` is ex GST, and both ends are included.
- **Stored values:** each rule stores `multiplier = 1 / (1 − margin_pct/100)`. A margin outside **4.77–80%** returns 400 `MARGIN_OUT_OF_BOUNDS` (the multiplier bounds 1.05–5).
- **Refusals:**
  - A filter with no keys returns 400 `EMPTY_RULE_FILTER`; a catalogue-wide margin is the tier ladder.
  - An unknown brand returns 400 `UNKNOWN_BRAND`; an unknown category returns 400 `UNKNOWN_CATEGORY`.
  - A second active rule with exactly the same filter returns 409 `DUPLICATE_RULE`.
- **Precedence:** manual price > the matching rule with the most filter keys set > brand ladder > catalogue band > code default. Tie-break as you suggested: higher `priority`, then the newest rule. `cost_band` counts as one key.
- **What a rule replaces:** the ladder multiplier **and** the global offset, because the rule *is* the margin the owner typed. Prices still get an ending and the floors. A genuine item of $100 or more also keeps its free-shipping floor; such rows show up in `blocked_by_floor`.
- **No competitor cap:** a rule-priced row skips the automatic competitor cap. Rows with no rule keep it.
- **Where rules apply:** the reprice, the nightly import, the simulator and the price audits all price a rule's rows from the rule. A rule saved today still holds after tonight's import.
- **No separate approval step. The preview is the gate:**
  - `POST` or `PATCH` without `confirm: true` writes nothing. It returns `{ applied: false, rule, affected, unchanged, locked, blocked_by_floor, blocked_by_no_decrease, sample, packs }`.
  - With `confirm: true` it saves the rule and queues a background reprice of the rule's rows. It returns 201 (`PATCH`: 200) with `{ applied: true, rule, …, job_id }`. Poll `GET /api/admin/pricing/reprice-jobs/:job_id`.
  - `locked` counts rows a rule will never move, because they carry a manual price. For example, 31 of the 68 Brother compatible toners are locked today.
- **`PATCH`:** send only the fields you change. `is_active: false` switches a rule off without deleting it. If the filter changes, both the old and the new set of rows are repriced.
- **`DELETE`:** the rule's rows return to the next matching rule, or to the ladder. The no-decrease ratchet decides whether prices come down (ask 5).
- **`GET`:** returns `{ rules: [...], count }`, newest first, each with `brand: { slug, name }`.

### 5. Allowing price decreases

- **On a rule:** `allow_decrease: true` lifts the no-decrease ratchet for the rows that rule prices, and only for rows without a manual price.
- **Rules may lower prices; the tier ladder may not.** The ratchet is lifted row by row, never for a whole job. A row priced by the ladder keeps the ratchet in every case below.
- **On a job:** `POST /api/admin/pricing/reprice-jobs` takes `{ allow_decrease: true, scope: { brand, source, product_type, category, cost_band } }`.
  - It lowers only the rows in `scope` that **a filter rule prices**. A ladder-priced row in the same scope keeps its price.
  - **`scope` is required** with `allow_decrease`. A catalogue-wide request returns 400 `SCOPE_REQUIRED_FOR_DECREASE`.
  - Without `allow_decrease`, `scope` just narrows the reprice.
- **After a rule is edited or deleted,** a row the rule **used to price** may come down only if that rule allowed decreases. The check runs against the rule as it was before the change; a row the old rule never priced is never lowered. Such a row comes down to its new rule or ladder price, never to "1% under the cheapest rival".
- **Simulate** reports `blocked_by_no_decrease` per row and in total, and honours each rule's flag.

### 6. Simulate filter rules

`POST /api/admin/pricing/simulate` takes two more inputs:
- `proposed_rules: [...]`: up to 20, in the rule shape above without `confirm`, checked by the same validator as the rules endpoint. They are added **on top of** the live rules.
- `scope.filter`: the list's own filter keys.

The response has the same shape as before, with these additions:
- `rule_priced_skus`;
- `sample[].price_rule_id`;
- `no_decrease_ratchet.blocked_skus`, which now leaves out rows whose rule allows decreases;
- **new since 16 Oct, for your confirm dialog:** `aggregate.largest_increase` and `aggregate.largest_decrease`. Each is `{ sku, current_retail, new_retail, delta_retail, change_pct }`, or `null` when nothing moves that way. They are table prices before the no-decrease ratchet, like `total_skus_with_increase` / `_decrease` beside them; `aggregate.delivered` has the after-ratchet figures.

A rule-priced row is computed with the real pricing function, so its preview matches the shelf exactly.

### 7. Clearing a manual price

A clear reprices the row **at once, without the ratchet**. Two ways:
- `PUT /api/admin/products/:id` or `PUT /api/admin/products/by-sku/:sku` with `{ "manual_retail_price": null }`;
- the bulk action `clear_manual`.

**The PUT's `null` acts only on a row that has a `manual_retail_price`.** On any other row it is ignored, so an edit form can send back `null` for every unlocked product without unlocking anything. That includes a row whose only lock is an older freeze (`has_manual_price: true` with `manual_retail_price: null`): clear those with the bulk `clear_manual`.

What happens to the row:
- The lock comes off, along with the older freeze flag and the competitive-audit tag.
- `retail_price` becomes the rule price, or the ladder price when no rule matches. The competitor cap is not applied.
- The PUT response's `retail_price` is that new price, so the page can show it straight away.
- The nightly reprice then holds the price there.
- A pack or ribbon keeps its shelf price, because the engine does not price those.

The same PUT also **sets** a lock: `{ "manual_retail_price": 29.99 }` makes 29.99 the shelf price and freezes it.
- Both directions are owner only; a `stock_manager` gets 403.
- Sending `retail_price` in the same body returns 400 `CONFLICTING_PRICE_FIELDS`: a manual price *is* the shelf price.

You no longer need to offer `POST /pricing/reprice-jobs` after a clear.

### 8. Packs

Bulk actions and rules **never** reprice packs. Every response that touched any carries:

```json
"packs": { "repriced": false, "action_required": "…" }
```

You do not need to act on it. Pack prices are derived from their singles (singles × (1 − source discount)), and the nightly import re-anchors every pack after the singles move, as it does after the nightly competitive-price audit. So a pack follows its singles within a day. The owner can re-anchor at once from the backend.

---

## Net-margin sort (ERR-311)

15 Oct §4 and File A §5. Live since 20:10 UTC 12 Oct (commit `c61aaca`).

1. `GET /api/admin/products` accepts `sort=net_margin_incl_fixed_pct` and `sort=profit_incl_fixed_ex_gst`, with `order=asc` and `order=desc`. They rank by the same `computeUnitMarginInclFixed` that fills the two cells (card fee and $0.30 included). Your example sorts ascending as C-DYM-28MM-LBL-WH (3.8%), G745MBK (10.3%), GCART069HKCMY (10.6%), and a test pins it.
2. **Rows with no cost or no price sort last**, whichever the direction. They are never excluded. Equal values keep a stable order, so paging never repeats or skips a row.

Owner only, like the other cost sorts. `pagination.total` is the size of the filtered set. Checked live on 15 Oct: ascending starts at the $0.50 admin test row, then GCF46CMY at 2.38%.

You can map the two columns to these keys and remove the tooltip note.

---

## Quote PDF (ERR-316)

15 Oct §5 and File A §6. Live since 20:10 UTC 12 Oct (commit `c61aaca`).

- **Q1, the description:** the PDF prints the product's stored name once. For G71180MLBK that name **is** "HP Genuine 711 80mlBK Ink Cartridge 711 80ml Black": the compact genuine grammar, with the cartridge volume inside the model code. `GET /api/cart` returns the same string. 89 HP DesignJet products are named this way. Renaming them changes 89 names, URLs and Shopping titles, and that is the owner's decision. The PDF needs no change either way.
- **Q2, the date:** the quote is dated, and numbered, in `Pacific/Auckland`. A quote made at 00:33 NZDT on 13 October prints "13 October 2026" and is numbered `Q-261013-…`.
- **Q3, the layout:** built as briefed: header band with brand mark and QUOTE, From / Prepared for (only the lines supplied), the line table, an 80mm totals block, Terms, and a footer on every page.
  - **Line amounts:** lines show the list price and `line_total`, with the volume price as a note under the line. So the Amount column adds up to the Subtotal, and the volume discount is taken once in the totals.
  - **Two items left out on purpose:**
    - **"Valid until":** the owner decided on 16 Oct to keep it out. Prices are not held for a quote; the Terms say the cart total at checkout is what is charged.
    - **Direct-credit block:** checkout takes only card, PayPal and Net 30.
- The filename and the CORS-exposed `Content-Disposition` are unchanged.

**A real quote rendered on 15 Oct** (G71180MLBK + CLC3313KCMY, 00:33 NZDT):
- dated "13 October 2026", number `Q-261013-…`;
- one description per line;
- Subtotal $256.99, volume −$3.60, Total $253.39, GST $33.05;
- no points line on a guest quote.

Your verification steps still apply: one description per line, an NZ date, and figures equal to `GET /api/cart`. There is no "Valid until" date to check.

---

## Confirmations and notes

15 Oct §6 and File A §7.

1. **`evidence.spend` units:** there is no `spend` key. The only writer files `evidence.flagged_groups[].cost_14d`, in **NZD dollars** ex GST, converted from Google's micros and rounded to cents. Printing it as dollars is correct.
2. **`GET /api/cart` `items[].product.stock_quantity`** is a contract, pinned by two tests in `__tests__/cart-stock-limit.test.js`: the response carries it, and every full cart-items product SELECT projects it.
3. **12pm in emails (ERR-319):** no email template has the cutoff typed in.
   - Order-confirmation, shipping and invoice emails do not mention the cutoff at all.
   - The three that do (subscription reminder, win-back, cart recovery) read it from `getTrustSignals()`, which returns `12:00` / "12pm" on production.
4. **Wallet orders carry no reminder consent.** Understood; that is expected.
