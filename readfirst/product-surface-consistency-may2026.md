# Product Surface Consistency — May 2026

**Status:** Shipped — 2026-05-11
**Spec for:** `inkcartridges/js/api.js` (`getShopData` sidecar),
`inkcartridges/js/shop-page.js` (`loadSearchResults` soft-miss + brand-narrowing).
**Pinned by:** `tests/product-surface-consistency-may2026.test.js` (10 tests),
`tests/compatible-products-recovery.test.js` (20 updated tests),
`scripts/verify_pgi650.mjs` (live multi-surface Playwright check).

## What this fixes

The customer reported three storefront paths to the **same** Canon PGI650 family
returning three different product sets:

| Path                                                       | Showed                                  | Should show                                            |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| `/search?q=compat`                                         | KCMY pack only, no CPGI650BK individual | KCMY pack + black single                               |
| `/search?q=650`                                            | Zero PGI650 — only Epson 273XL/302/410  | PGI650 family front-and-center                         |
| `/shop?brand=canon&category=ink&code=PGI650` chip drilldown | CPGI650BK only — no KCMY pack          | Black + KCMY pack + every genuine                      |

## Root causes

### Bug #1 — chip drilldown drops every compatible value-pack

The compat-recovery sidecar (`api.js` `getShopData`) was firing against
`/api/shop?source=compatible`. The backend's `/api/shop` endpoint silently
filters out **every `pack_type=value_pack` row** when `source=compatible`:

| Brand+category filter        | `/api/shop` returns | `/api/products` returns | Diff (value-packs)                                          |
| ---------------------------- | ------------------- | ----------------------- | ----------------------------------------------------------- |
| `canon&category=ink&source=compatible` | 99      | 106                     | CPGI650KCMY, CCLI671KCMY, CPGI670KCMY, CCLI681KCMY, CPGI520KCMY, CPGI525KCMY, CPGI5KCMY |

So the sidecar could not see the pack — it could not merge it back into the
chip drilldown. The customer's "pack should appear here" intuition was
correct; the storefront was hiding it.

**Fix:** sidecar now fetches `/api/products?brand=X&category=Y&source=compatible&limit=200`.
`/api/products` keeps every `pack_type=value_pack` row. Same
`{ data: { products: [...] } }` shape, so the merge code is unchanged.
`_enrichSeriesCodes` derives `PGI650`/`CLI651` from the multipack's name so
the merge still scopes to the right code.

This also affects an underlying catalog inconsistency: every Canon compatible
ships with `category: "CON-INK"` (the supplier's prefix taxonomy), not
`"ink"`. The /api/shop endpoint's filter normalises both — but its joined
view drops `pack_type=value_pack`. /api/products doesn't. Backend follow-up
to standardise category casing tracked in `readfirst/catalog-defects-may2026.md`.

### Bug #2 — `/search?q=650` returns nothing relevant

`/api/search/smart?q=650` returned 15 cartridges, every one having
"(650 pages)" in its yield copy — Epson 273XL, 302, 410, HP 937E. Zero
Canon PGI650, even though `/api/products?search=650` finds 50 with PGI650
ranked alongside the Epsons.

The earlier fallback only fired on a **hard miss** (zero results). With 15
off-topic hits, the fallback did nothing and the customer hit a dead end.

**Fix:** `loadSearchResults` now distinguishes hard miss from soft miss:

- **Hard miss** — `products.length === 0 && !smartData.matched_printer` →
  fall back to `/api/products?search=q`, take whatever it gives.
- **Soft miss** — query contains digits AND smart returned 1–49 results AND
  smart has neither `matched_printer` nor `did_you_mean` → fire the same
  `/api/products` fallback in parallel; **only swap in if the fallback
  count strictly beats smart's count**. This avoids regressing high-quality
  smart matches.

### Bug #3 — first-product brand narrowing fired on the soft-miss swap

`loadSearchResults` runs a "≥40% of results from one brand → narrow to that
brand" filter as a relevance shim until backend ships
`smart.intent.matched_brand_slug`. The fallback to "first product's brand"
only makes sense when smart's relevance ranking is trustworthy.

When the soft-miss swap fires, `smartData = null` (we replaced it with the
substring-match products), so product order is unranked — just whichever row
the database returned first. For `q=650`, that's `G273CY` (Epson). The 36
Epson "650 pages" rows then dominate the 50-product set, narrowing past the
40% threshold and **dropping every Canon PGI650 row**.

**Fix:** the first-product brand-narrowing fallback is gated on `smartData`
being non-null. When the soft-miss swap fired, brand-narrowing only fires
if the backend explicitly identified a brand — which the soft-miss path
doesn't have. The user types a series number; we hand back every match for
that number, not the dominant brand's subset.

## What we did not fix

The customer mentioned the catalog has only the CPGI650**KCMY** pack — no
individual compatible CPGI650**CY**/**MG**/**YL** singles. That is a real
**catalog gap** — the supplier ships only a multipack for compatibles in
this series. Two options for the supplier follow-up:

1. Source individual compatible C/M/Y for PGI650 from a new supplier.
2. Synthesise virtual children of the multipack (1/4 of the price each)
   so the customer can buy a single colour. Same approach already used for
   other multipack-only families (`docs/catalog/multipack-virtual-children.md`).

Decision out of scope for this fix — tracked in
`readfirst/catalog-defects-may2026.md` "Compatible singles for pack-only
families".

## Cross-surface invariant

The Playwright sweep at `scripts/verify_pgi650.mjs` walks every surface for
six products (Canon PGI650, HP 02, Canon CLI671XL, Brother LC133,
Epson 73N, plus a `/search?q=650` short-query check) and asserts each
expected SKU appears via search, chip drilldown, and PDP load. **12/12
green** as of 2026-05-11.

Run with the dev server up:
```sh
npx serve inkcartridges -l 3000 &
node scripts/verify_pgi650.mjs
```
