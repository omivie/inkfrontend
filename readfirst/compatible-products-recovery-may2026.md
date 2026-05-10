# Compatible-products recovery — May 2026

**Status:** shipped 2026-05-10 · pinned by `tests/compatible-products-recovery.test.js` (16 tests)

## What broke

Visiting `/shop?brand=hp&category=ink&code=02` (or any other code-filtered list view where the catalog has compatible products) returned **only genuines** — no compatibles ever rendered. The codes drilldown chips for `/shop?brand=hp&category=ink` were missing entries entirely (HP "02" didn't exist as a chip; HP "564" undercounted by ~7).

Customer-visible: the storefront looked like InkCartridges stocks no compatible cartridges. Brother LC67 was the original report — empty compatible header — but the bug spans every brand whose compatibles ship with empty `series_codes`.

## Root cause

The backend's `/api/shop?code=X` filter matches `series_codes` array contains. For the "all products in brand+category" path the backend's series-code extractor populates `series_codes` for genuines (it reads `manufacturer_part_number`) but emits an empty array for compatibles. `?code=X` therefore drops every compatible regardless of whether its name/SKU clearly references that code.

Two distinct storefront symptoms flow from the same root:

| Surface | Bug |
|---|---|
| Codes drilldown chips (`/shop?brand=X&category=Y`) | compatible-only series codes (HP 02, Epson 73N) never appear; mixed-source codes undercount |
| Code-filtered grid (`/shop?...&code=X`) | compatible siblings are missing on the page |

The `?source=compatible` path on the same endpoint **does** ship populated `series_codes` (different join), which the FE recovery exploits.

## Frontend fix

`api.js` `getShopData(params)` fires the sidecar fetch **in parallel** with the primary fetch when the request is eligible for recovery (Promise.all both, await once):

- Eligibility: `params.brand && params.category && params.source !== 'genuine' && !params.search`.
- Sidecar URL: `/api/shop?brand=…&category=…&source=compatible&limit=200`. SWR-cached, so across the codes drilldown + the code-filter grid the customer pays for it once per brand+category per session.
- Each sidecar product is run through `_enrichSeriesCodes(product)` — backend-populated values pass through (with casing normalized); empty arrays fall through to derivation from name / SKU.

Parallelism matters: the first iteration of this fix awaited primary then awaited sidecar, doubling cold-start latency. On 2026-05-10 a Render cold start surfaced as a "Failed to load products" empty state on the codes drilldown. Parallel + a try/catch around the merge brought worst-case latency from ~7s back down to ~700ms (Promise.all bounds wall time at `max(primary, sidecar)`) and ensures any merge anomaly returns the unmerged primary instead of throwing.

After enrichment the merge runs in one of two modes:

- **Code-filtered request** (`params.code` set): missing compatibles whose enriched `series_codes` include the requested code are appended to `primary.data.products`. `meta.total` is bumped. Existing rows (matched by `id || sku`) are not duplicated.
- **Drilldown request** (no `params.code`): compatible series counts are merged into `primary.data.series`. New chips for compatible-only codes appear; mixed-source counts add together. The merged array is sorted numeric-aware.

Failure modes — all handled without surfacing to the caller:

| Path | Behaviour |
|---|---|
| Primary throws (5xx/network) | Propagates — `loadProductCodes`/`loadProductsByCode` already have legacy fallback that depends on this. |
| Sidecar throws | Caught by `.catch(() => null)` on the sidecar promise; primary returned unchanged. |
| Sidecar returns `ok:false` envelope | Eligibility check sees missing `data.products`; returns primary unchanged. |
| Merge logic throws (malformed shape) | Caught by `try/catch` around the merge block; primary returned unmerged + `DebugLog.warn`. |

## Series-code derivation — `_enrichSeriesCodes(product)`

Three patterns, applied in order, results unioned:

1. **SKU body** — `^C([A-Z0-9-]+)$`, then strip a trailing colour/pack suffix. The leading `C` is the catalog's compatible-prefix convention.
2. **Leading word of the name** — same suffix strip. Catches `200XLBK Compatible Ink Cartridge for Epson 200XL …` → `200XL`.
3. **`for <Brand> <CODE>[ <CODE2> …]`** — captures the body between `for <Brand>` and the first colour word, pack token, paren, or end of string. Multi-printer compatibles like `for Canon BCI3 BCI6` yield both codes. Tokens are kept only when they contain a digit (filters out brand words).

Recognised colour suffixes (longest first to prevent over-stripping): `KCMY · CMYK · CMY · PBK · PCY · PMG · PYL · CLR · BK · CY · MG · YL · LC · LM · RD · GN · BL · VT · GR · WH · OR · PK`.

Recognised stop tokens (for pattern 3): colour words, `XL VALUE`, `<n>-PACK`, `VALUE PACK`, `MULTI-PACK`, paren.

## Verification matrix

| URL | Before | After |
|---|---|---|
| `/shop?brand=hp&category=ink` | 47 chips | **63 chips** (HP 02, 15, 22, 27, 28, 56, 57, 74, 75, 92, 93, 95, 98 etc. now visible) |
| `/shop?brand=hp&category=ink&code=02` | 0 products | **8 compatibles** |
| `/shop?brand=hp&category=ink&code=564` | 7 genuines, 0 compatibles | **7 + 7** |
| `/shop?brand=brother&category=ink&code=LC67` | 6 genuines, 0 compatibles | **6 + 6** (Brother LC38/LC67 multi-printer compatibles) |
| `/shop?brand=hp&category=ink&source=genuine` | works | **unchanged** (sidecar skipped) |

## What stays as backend work

The frontend recovery doesn't replace the backend gap — it papers over it for storefront browsing. The series-code extractor for compatibles still needs to run server-side so:

- `/api/search/smart?q=02` returns HP 02 compatibles (search uses the same broken filter)
- Sitemap / structured data carry compatible series codes
- Admin filters by code don't undercount

See `readfirst/catalog-defects-may2026.md` §6 — the backend handoff for series-code backfill.

## Related contracts

- `js/utils.js` `familyKey(product)` — already prefers `series_codes` when present (May 2026 catalog overhaul). Recovered codes flow through the existing sort/group infra unchanged.
- `js/shop-page.js` `loadProductsByCode` and `loadProductCodes` — both call `getShopData` and benefit transparently. No FE changes outside `api.js`.
- `tests/api-changes-may2026.test.js` and `tests/category-page-contract-may2026.test.js` — unaffected; this fix is additive.
