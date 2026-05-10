# Series-base merge — collapse XL/XXL/XXXL chips on /shop drilldown

**Status:** shipped 2026-05-10

## What customers see

Before: the /shop?brand=epson&category=ink chip grid showed two tiles for
every yield split — `200` next to `200XL`, `212` next to `212XL`, `604` next
to `604XL`, `676` next to `676XL`, etc. — doubling the customer's hunt and
making the grid look noisy and incomplete (the XL chips usually had only
4–7 products under them while the base chip had 14–19).

After: one tile per series. The chip says `604`, `count=24`. Clicking it
shows every product across every yield level in one consolidated grid.

## Why the bug existed

The backend's `extractSeriesCodes` job populates `series_codes` on every
product. For Epson compatibles the canonical extractor runs against the
actual MPN — `C604XLBK` ships with `series_codes: ['604XL']` — so the
sidecar in `api.js::getShopData` (the compat-recovery path from
`catalog-defects-may2026.md` §6) injects `200XL`, `604XL`, `676XL`, etc. as
*new* chips next to the genuine `200`, `604`, `676` chips that the primary
`/api/shop?brand=epson&category=ink` already returned.

For Brother / Canon / HP this never reproduced (live audit 2026-05-10):
those backend `series_codes` already collapse XL into the base. The split
is a 7-chip Epson-only artifact today, but the structural cause —
yield-suffix codes treated as distinct series chips — could regress to any
brand if their compat MPNs ever ship raw.

## The fix

Frontend: every yield variant collapses into the base chip on the chip
drilldown, and the click handler fans out to fetch all yield-variant
product lists in parallel under one tile.

Three pieces:

### 1. `SeriesCodes` namespace (utils.js)

```js
SeriesCodes.collapseYieldSuffix('604XL')   // → '604'
SeriesCodes.collapseYieldSuffix('812XXL')  // → '812'
SeriesCodes.collapseYieldSuffix('T312XL')  // → 'T312'
SeriesCodes.collapseYieldSuffix('LC133XL') // → 'LC133'
SeriesCodes.collapseYieldSuffix('73N')     // → '73N'  (preserved)
SeriesCodes.collapseYieldSuffix('46S')     // → '46S'  (preserved)
SeriesCodes.collapseYieldSuffix('26ML')    // → '26ML' (preserved)

SeriesCodes.collapseChipList([
    { code: '200',   count: 16 },
    { code: '200XL', count: 4 },
    { code: '604',   count: 18 },
    { code: '604XL', count: 6 }
])
// → [
//     { code: '200', count: 20, aliases: ['200', '200XL'] },
//     { code: '604', count: 24, aliases: ['604', '604XL'] }
//   ]
```

The pattern is `^([A-Z]*\d+)(X{1,3}L)$`. Anchored, so partial codes like
SKU bodies (`604XLBK`) do NOT match. Yield-only collapse — N/S/ML
suffixes are preserved because they encode different series, not yield
levels.

### 2. shop-page.js — chip merge + URL collapse

`loadProductCodes` runs every code through `SeriesCodes.collapseChipList`
before caching/render. Cache key bumped to `codes-v7` to invalidate any
v6 in-memory caches still holding split chips after deploy.

`parseURLState` collapses `?code=604XL` deep-links → `state.code = '604'`
so a bookmarked URL lands on the same consolidated chip the navigation
produces.

### 3. shop-page.js — alias fan-out on click

The consolidated chip carries `aliases: ['604', '604XL']`. When the user
clicks `604`, `loadProducts` calls `_codeAliasesFor('604')` and fires one
`API.getShopData({ code: alias })` per alias in parallel, then merges
products by id/sku.

This matters because backend filters strictly: `/api/shop?code=604`
returns products whose `series_codes` array contains the literal string
`'604'`, not `'604XL'`. Without fan-out, the consolidated chip would
silently drop the 12 genuine 604XL products.

## Surfaces touched

- `inkcartridges/js/utils.js` — added `SeriesCodes` namespace,
  `window.SeriesCodes` global, CommonJS export.
- `inkcartridges/js/shop-page.js` —
  - `parseURLState` collapses incoming `?code=`
  - `loadProductCodes` runs `SeriesCodes.collapseChipList(codes)`
  - cache key v6 → v7
  - new `_codeAliasesFor(collapsedCode)` helper
  - `loadProducts` fans out across aliases when fetching
  - read-side cache fallback chain: v7 → v6 → v5 → v4

## Surfaces NOT touched

- `inkcartridges/js/api.js` — `_enrichSeriesCodes` and the compat-recovery
  merge in `getShopData` deliberately keep raw codes. The frontend chip
  layer collapses; the backend filter layer still wants exact matches.
- `inkcartridges/js/ribbons-page.js` — ribbons don't use the series-chip
  drilldown.
- `inkcartridges/js/product-detail-page.js` — PDP related-products uses
  `series_codes[0]` for grouping; XL collapse there is handled by
  `ProductSort.familyKey` (utils.js) which already strips XXL/XL/HY/H.

## Tests

`tests/series-base-merge-may2026.test.js` — 24 tests covering:

- `collapseYieldSuffix` per brand pattern + non-yield suffixes
- `collapseList` array dedupe + order preservation
- `collapseChipList` count summing + alias stamping + per-chip product
  merging
- shop-page.js wiring: cache v7, `collapseChipList` call, URL parser
  collapse, `_codeAliasesFor` defined, fan-out via `Promise.all`

## Live evidence (2026-05-10)

`/api/shop?brand=epson&category=ink` (after compat-recovery merge in
`api.js::getShopData`) returns 52 chips including 7 XL siblings:

```
200      16   ←┐
200XL     4   ←┘ collapse → 200, count=20, aliases=['200','200XL']
212      19   ←┐
212XL     6   ←┘ collapse → 212, count=25, aliases=['212','212XL']
220      15   ←┐
220XL     4   ←┘ collapse → 220, count=19, aliases=['220','220XL']
252      14   ←┐
252XL     4   ←┘ collapse → 252, count=18, aliases=['252','252XL']
273      15   ←┐
273XL     7   ←┘ collapse → 273, count=22, aliases=['273','273XL']
604      18   ←┐
604XL     6   ←┘ collapse → 604, count=24, aliases=['604','604XL']
676       4   ←┐
676XL     4   ←┘ collapse → 676, count=8,  aliases=['676','676XL']
```

Result: 45 chips instead of 52, every consolidated chip count matches the
sum of its yield variants, and clicking any of the 7 affected chips
fetches both yield levels in parallel.

## When to re-evaluate

- If the backend ever ships `HY`/`H` as a high-yield suffix on Brother
  TN codes (today they appear as `XL`/`XXL`), extend `YIELD_SUFFIX` to
  `(X{1,3}L|HY|H)`. A test case is already present for `HY`/`H` to keep
  this regression-visible.
- If a brand introduces a real series ending in `XL` that is NOT a
  yield variant of a base series (no precedent today), collapse
  becomes wrong for that brand. The `aliases` list lets us see this:
  if a chip has a single `XL` alias and no base sibling, the regex
  collapsed it but should not have. Spot-check is possible from the
  v7 cache.
