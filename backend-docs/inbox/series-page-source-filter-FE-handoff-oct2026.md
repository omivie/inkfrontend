# Series page: honour `&source=` on ad landing pages

**For:** storefront developer · **Priority:** P1 · **Raised:** 8 October 2026 · **Backend:** live, nothing to wait for

Listed as item 21 in `FE-MASTER-CHECKLIST-oct2026.md`. This file is the full spec.

## Why

On 8 October the owner asked for Search ads to concentrate on the products we can win. The main Search campaign now has dedicated ad groups:

- **"Winners - …"**: product families where we are at or under the lowest comparable NZ price, in stock.
- **"Exclusive - …"**: our own value packs, and niche items no other NZ shop sells.

When we are cheaper on only one version of a family (only the compatible, or only the genuine), the ad lands on the series page with a `source` filter, so the shopper sees the version we are cheaper on. Examples of live ad landing pages:

- `/shop?brand=brother&code=LC3319XL&source=compatible`
- `/shop?brand=brother&code=LC531&source=compatible`
- `/shop?brand=canon&code=PGI2600&source=genuine`
- `/shop?brand=canon&code=PFI1000&source=genuine`
- `/shop?brand=oki&code=C610&source=genuine`

## What happens today (measured 8 Oct)

The series page ignores `source`. `/shop?brand=brother&code=LC3319XL&source=compatible` requests:

1. `/api/shop?brand=brother&limit=200&code=LC3319XL`
2. `/api/shop?brand=brother&limit=200&code=LC3319`

Neither request carries `source`, so the page shows all 12 products. The genuine versions, which we are dearer on, sit beside the compatible ones the ad was bought for.

## Backend (live)

`/api/shop` already filters on `source=genuine|compatible`. `/api/shop?brand=brother&code=LC3319XL&source=compatible&limit=50` returns the 6 compatible products: 4 singles plus the CMY and KCMY packs.

## What to build

1. On the series page (`/shop?brand=…&code=…`), read `source` from the URL. When it is `genuine` or `compatible`, add it to every `/api/shop` request the page makes, including the fallback request without the yield tier (`code=LC3319`). Ignore any other value.
2. Show the filter as a removable chip ("Compatible only ×" / "Genuine only ×"). Removing it drops `source` from the URL with `history.replaceState` and reloads the grid. If the brand page already has a chip for `&source=`, reuse it.
3. The canonical link stays `/shop?brand=…&code=…` without `source`, so search engines do not see two pages.
4. `&pack=value_pack` already works on this page. Keep it: the "Exclusive - Value Packs" ads land on `/shop?brand=…&code=…&pack=value_pack`.

## Done when

- `/shop?brand=brother&code=LC3319XL&source=compatible` lists only the 6 compatible products, with the chip showing.
- Removing the chip shows all 12.
- The canonical link on the filtered page has no `source`.
- `/shop?brand=hp&code=965&pack=value_pack` still lists only the 4 value packs.

## Not to do

- No price comparisons, "lowest price", "cheapest" or "best" wording anywhere on the page (invariant 13). The filter chip names the product type only.

**When you deploy:** tell the backend the deploy time, and we re-check the five landing pages above the same day.
