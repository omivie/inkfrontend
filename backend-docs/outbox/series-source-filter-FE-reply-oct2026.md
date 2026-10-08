# Series page `&source=`: shipped and measured on production

**For:** backend developer · **Answers:** `series-page-source-filter-FE-handoff-oct2026.md` (FE master checklist item 21) · **Written:** 8 October 2026 · **FE error log:** ERR-314

## Deploy time

**Live on www from 2026-10-08 03:07:20 UTC (16:07 NZDT).** Commit `15af9166` was pushed at 03:06:56 UTC. The live page serves `shop-page.js?v=a7245427`. The five landing pages can be re-checked now.

## What shipped

1. **`source` is read and sent.** On `/shop?brand=…&code=…`, a `source` of `genuine` or `compatible` goes on every `/api/shop` request the page makes. That covers the requested code (`LC3319XL`), the family code without the yield tier (`LC3319`), and the reload the page does when a retired code resolves to a new stem. Any other value is ignored and never forwarded, because `/api/shop` answers it with 400 `VALIDATION_FAILED` (measured).
2. **Removable chip.** "Compatible only ×" or "Genuine only ×" sits in the breadcrumb row. Removing it drops `source` from the URL with `history.replaceState` and reloads the grid. The chip names the product type only. There is no price, "lowest", "cheapest" or "best" wording (invariant 13).
3. **Canonical has no `source`.** The link stays `/shop?brand=…&code=…`. The bot prerender at the edge still forwards only `code` and `category`, so crawlers get your code page and your canonical.
4. **`&pack=value_pack` is unchanged.**

## Two things you should know

- **One URL name now.** The page already had this filter under the older name `type=`. It is still read, so old links work, but the page now writes `source=` everywhere it builds a URL (sort, Filter & Sort sheet, search form). Please keep using `source=` in ad final URLs.
- **`?category=<slug>&source=…` is no longer sent the whole-category prerender.** Our edge middleware already skipped the category prerender when a `type=` filter was present. It now skips it for `source=` too, because the page is narrowed and the category prerender would describe a different page. Nothing changes for the ad URLs (they carry `brand`, so they take the brand/code prerender as before).

## Measured on production (www, 8 Oct, after deploy)

`npm run probe:series-source`, run against www: **40 passed, 0 failed, 0 not measured.** It is read-only, opens a fresh browser per page and makes public GETs only.

| Landing page | Requests carry `source` | Cards | All the right type | Chip | Canonical |
|---|---|---|---|---|---|
| brother LC3319XL compatible | yes (LC3319XL and LC3319) | **6** | yes | Compatible only | `/shop?brand=brother&code=LC3319` |
| brother LC531 compatible | yes | 6 | yes | Compatible only | `/shop?brand=brother&code=LC531` |
| canon PGI2600 genuine | yes | 6 | yes | Genuine only | `/shop?brand=canon&code=PGI2600` |
| canon PFI1000 genuine | yes | 13 | yes | Genuine only | `/shop?brand=canon&code=PFI1000` |
| oki C610 genuine | yes | 9 | yes | Genuine only | `/shop?brand=oki&code=C610` |

"All the right type" is checked against your own API rows: the probe maps each card's SKU to the `source` field in the `/api/shop` response the page received. It does not guess from the SKU prefix.

**Your "done when" list, measured:**
- LC3319XL `source=compatible` lists only the 6 compatible products, with the chip showing. ✔
- Removing the chip shows all 12 (both sources). The URL becomes `/shop?brand=brother&code=LC3319XL`, and `history.length` stays at 2 (replaceState). ✔
- The canonical on the filtered page has no `source`. ✔
- `/shop?brand=hp&code=965&pack=value_pack` lists only the 4 value packs (G965CMY, G965KCMY, G965XLCMY, G965XLCMYK). ✔

**Also measured:**
- **First screen.** The chip adds no height. The first card's top is the same with and without `source`: 331 px at 1280x551 and 319 px at 390x664. On phones the first build put the chip on its own row (+36 px); this was found and fixed before deploy.
- **Negative controls.**
  - `source=bogus`: no request carries `source`, no chip, 12 cards.
  - The "every request carries source" check, run on an unfiltered load, comes out red as it should.
- **Your API, re-measured the same day:** LC3319XL and LC3319 with `source=compatible` both return 6 rows; without `source`, 12; HP 965 `pack=value_pack`, 4.

## One observation, no action needed

`/api/shop?brand=hp&code=965&pack=value_pack&source=compatible` returns 0 rows, because all four HP 965 packs are genuine. If an ad ever combined `pack=value_pack` with `source=` on a family whose packs are all the other type, the page would show its empty state. None of the current landing pages do this.

## No asks

Nothing is needed from the backend for this item.
