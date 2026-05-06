# Code → Yield → Color Grouping — May 2026

**Status:** active contract
**Layer:** storefront frontend (vanilla JS)
**Spec date:** 2026-05-06
**Pinned by:** `tests/code-yield-grouping-may2026.test.js`
**Supersedes:** `readfirst/color-display-order-may2026.md` for the three render
surfaces wired below. The colour-only `ProductSort.byColor` primitive remains
exported for any caller that explicitly wants colour-only without yield-code
grouping.

---

## TL;DR

Every product list rendered to a customer is sorted by

```
familyKey (incoming order)  →  yieldTier (std → XL → XXL)  →  colorTier (K → KCMY)
```

and a row-break element is spliced between every (familyKey, yieldTier) group
so each yield-code physically starts on a new row in the wrapping flex /
CSS-Grid container.

```
row 1  →  TN645    K  C  M  Y  CMY  KCMY
row 2  →  TN645XL  K  C  M  Y  CMY  KCMY
row 3  →  TN645XXL K  C  M  Y  CMY  KCMY
```

---

## Why this exists

The May 2026 catalog overhaul made the backend authoritative for the catalog
sort key `(accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)`
(`api-changes-may2026.md §1`). In practice `/api/shop?brand=&category=&code=`
and `/api/search/smart` responses arrive with **colour-major / yield-minor**
ordering, which renders as:

```
Live evidence — /search?q=tn645, 2026-05-06
  row 1: 645 BK · 645XL BK · 645XXL BK · 645 C · 645XL C · 645XXL C
  row 2: 645 M · 645XL M · 645XXL M · 645 Y · 645XL Y · 645XXL Y
```

This is wrong for ink/toner. The customer-facing convention every NZ retailer
uses is **yield-major / colour-minor**: one row per cartridge code, K→C→M→Y
left-to-right, multi-packs at the end. Pinning that on the storefront makes
the layout independent of which backend codepath served the response.

`color-display-order-may2026.md` shipped a colour-only override to fix the
adjacent symptom (CMY/KCMY packs interleaved between Black and Cyan). This
spec extends that to also force yield grouping and row breaks.

---

## Public API (`inkcartridges/js/utils.js`)

```js
ProductSort.byCodeThenColor(products) → newArray
```

Stable composite sort:

1. **Family rank** — first appearance of each `familyKey` in the input wins.
   This preserves the backend's brand / accessory-tier grouping between
   families; we only impose order *within* a family.
2. **Yield tier** — `yieldTier(p)` ascending: 0 (std) → 1 (XL/HY) → 2 (XXL).
3. **Color tier** — `colorTier(p)` ascending: K → C → M → Y → CMY → KCMY →
   specialty → unknown.

Returns a **new** array; never mutates input. Edge cases (`null`,
`undefined`, non-array) → `[]`.

```js
ProductSort.rowBreakIndices(sortedProducts) → number[]
```

Given an array already sorted by `byCodeThenColor`, returns the indices at
which a row break belongs. A boundary fires when `(familyKey, yieldTier)`
changes from the previous item. The first item is never a boundary.

```js
input  : [TN645·K, TN645·C, TN645·Y, TN645XL·K, TN645XL·C, TN645XXL·K]
output : [3, 5]
```

### Why `familyKey` had to grow up

`familyKey` collapses XL/XXL/HY suffixes onto the base code so all three of
`TN645BK`, `TN645XLBK`, `TN645XXLBK` resolve to `B:BROTHER:TN645`. The
yield tier then disambiguates within a family.

The previous implementation capped the suffix at 3 letters, which silently
failed on `TN645XXLBK` (5-letter suffix) and fell through to the
color-stripped-name fallback. Two structural fixes:

- Suffix length raised to 8 letters (`[A-Z]{0,8}`) so `XXLBK`/`XLMG` parse.
- Yield is stripped from the **left** of the suffix, color from the **right**.
  This avoids the `XLC` ambiguity — `XL+C` (Cyan) is the right parse, not
  `X+LC` (Light Cyan), which the old right-anchored multi-letter color
  stripper got wrong.

A second regex branch handles bare-numeric codes like HP `975A` /
`975X` / `802` — these don't have a leading letter prefix, so the
`(LETTERS)(DIGITS)(SUFFIX)` form misses them.

---

## Surfaces wired

| Surface | File | Hook |
| --- | --- | --- |
| Shop grid (compatible + genuine, brand+category+code, search drilldown, printer fallback) | `js/shop-page.js` | `renderProducts(products, …)` — `ProductSort.byCodeThenColor(products)` + DOM `appendChild` of `<div class="products-row__break">` at every break index |
| PDP related products (per source × per type group) | `js/product-detail-page.js` | `renderRelatedProducts(info)` — `sortByCodeThenColor(...)`; `buildTypeGrid` splices `.products-row__break` HTML between groups |
| Generic product grid (`Products.renderCards`) — used by PDP "bought together", `Products.loadIntoContainer`, etc. | `js/products.js` | `renderCards(products)` — `ProductSort.byCodeThenColor(products)` + breaker HTML in the `.map(...).join('')` |

### Surfaces deliberately NOT wired

| Surface | Reason |
| --- | --- |
| Smart-search dropdown autocomplete | Relevance ranking dominates; cross-brand/family rows wouldn't make sense by yield-code. |
| Homepage featured carousel | Curated mixed-brand row of 4; row breaks would scramble the curated sequence. |
| Favourites grid | User-curated; preserve add-order. |
| Cart / checkout / order detail line items | Preserve cart-add order. |

---

## Row break — how it actually breaks the row

`<div class="products-row__break" aria-hidden="true"></div>` is a
zero-height, flex-basis:100% element. CSS rules in `inkcartridges/css/pages.css`:

```css
.products-row__break {
    flex-basis: 100%;
    width: 100%;
    height: 0;
    margin: 0;
    padding: 0;
    border: 0;
    pointer-events: none;
}
.product-grid > .products-row__break {
    grid-column: 1 / -1;
}
```

- **Flex container** (`.products-row`): `flex-basis:100%` claims the entire
  row, so the next card wraps to the next line.
- **CSS Grid container** (`.product-grid`): `grid-column: 1 / -1` spans every
  column, so the next card lands in the first cell of the next row.

Zero physical height + no margin/padding means the break is invisible — the
row gap inherited from the container's `gap` is the only visual change.

`aria-hidden="true"` keeps the breaker out of the accessibility tree (screen
readers shouldn't announce it as a content element).

---

## Verification

```bash
node --test tests/code-yield-grouping-may2026.test.js   # 18 tests, ~40 ms
node --test tests/color-display-order.test.js           # 16 tests (3 wiring tests moved here)
node --test tests/api-changes-may2026.test.js           # §1 test now accepts byColor OR byCodeThenColor
npm test                                                # full suite: 480 pass / 7 LIVE_E2E skipped
```

Live smoke (browser, 2026-05-06):

- `/search?q=tn645` — Brother TN645 genuine grid renders **3 rows**: TN645
  std (K, C, M, Y), TN645XL (K, C, M, Y, CMY, KCMY), TN645XXL (K, C, M, Y).
- `/shop?brand=hp&category=ink&code=975` — HP 975A and 975X land on
  separate rows (different bare-numeric codes), packs at the end.
- PDP `/products/.../G-BR-TN645BK` — related products both groups render
  in code-yield rows.

---

## How to extend

- **New yield letter pattern** (e.g. Brother `XXXL`): teach `yieldTier` to
  return 3 for it, and update `familyKey`'s left-anchored yield strip
  (`/^(XXXL|XXL|XL|HY|H)/`).
- **New colour suffix pattern** (e.g. `OR` for Orange): add to the
  multi-letter strip in `familyKey` (`/(BK|CY|MG|YL|PK|MK|LC|LM|GY|OR)$/`)
  AND to `ProductSort.COLOR_ORDER` so `colorTier` can classify it.
- Extend `tests/code-yield-grouping-may2026.test.js` with a fixture that
  exercises the new pattern so the contract stays pinned.

---

## What this spec does NOT do

- **Rebuild the backend's catalog sort.** Family-to-family ordering is
  inherited from the API response (first-occurrence-wins), so brand /
  accessory-tier grouping that the backend cares about still drives which
  family appears first.
- **Forbid `byColor`.** It remains exported as a colour-only primitive for
  callers that explicitly want it. The three surfaces above use the
  composite `byCodeThenColor` instead.
- **Touch search dropdown / favourites / cart / checkout.** Those surfaces
  have ordering contracts of their own — see "Surfaces deliberately NOT
  wired" above.
