# Canonical Color Display Order — May 2026

**Status:** active contract
**Layer:** storefront frontend (vanilla JS)
**Spec date:** 2026-05-06
**Pinned by:** `tests/color-display-order.test.js`

---

## TL;DR

Every product list rendered to a customer is sorted into the canonical
colour tier order **before** the cards hit the DOM:

```
K  →  C  →  M  →  Y  →  CMY  →  KCMY  →  specialty  →  unknown
0     1     2     3     4       5       6             7
```

The pass is a **stable** sort by colour tier — products with the same
tier keep their incoming relative order, so the backend's
`seriesBase`/`yieldTier` grouping inside a tier is preserved.

---

## Why this exists (override on top of api-changes-may2026.md §1)

The May 2026 catalog overhaul made the backend authoritative for the
full sort key `(accessoryTier, yieldTier, seriesBase, colorOrder,
packRank, name)`. The frontend was supposed to render in API order.

In production, several `/api/shop?brand=&category=&code=` responses
arrive with multipacks interleaved between Black and the C/M/Y singles.
Live evidence captured 2026-05-06:

```
GET /api/shop?brand=hp&category=ink&code=975  →  compatible group:
  C-HP-975-INK-BK         Black
  COMP-PACK-HP-975-CMY    CMY     ← packs sneak in front of Cyan
  COMP-PACK-HP-975-KCMY   KCMY
  C-HP-975-INK-CY         Cyan
  C-HP-975-INK-MG         Magenta
  C-HP-975-INK-YL         Yellow
```

The customer-facing convention every NZ ink retailer uses is K → C → M
→ Y → multipacks. We pin that on the storefront so it never depends on
which `/api/shop` codepath the request takes (single-brand-code, smart
search drilldown, by-printer fallback, etc.).

`ProductSort.byColor` is a **secondary** stable pass — it does NOT
override `seriesBase`/`yieldTier`. Within the K tier on the HP 975
genuine grid you still see `975A-Black, 975X-Black` (std yield first,
then HY) because stable sort preserves that order from the backend.

---

## Public API (`inkcartridges/js/utils.js`)

`ProductSort` is exported globally as `window.ProductSort` and via
CommonJS for tests.

```js
ProductSort.byColor(products) → newArray
```

- Stable sort by `colorTier`.
- Returns a **new** array; never mutates the input.
- Edge-cases: `null`, `undefined`, non-array → `[]`. Single-item array → shallow-copied.

```js
ProductSort.colorTier(product) → 0..7
```

Resolution priority for the tier:

1. `product.color` (canonical backend field — `'Black'`, `'Cyan'`, `'CMY'`, `'KCMY'`, `'Photo Black'`, …)
2. `ProductColors.detectFromName(product.name)` — fallback for legacy rows missing `color`.

Pack override: a row with `pack_type === 'value_pack' || 'multipack'`
whose `color` resolves to a single colour name (`'Black'`, `'Cyan'`,
`'Magenta'`, `'Yellow'`) is promoted into the multi-tier (CMY/KCMY).
This stops a mis-labelled pack from sneaking into the singles bucket.

```js
ProductSort.TIERS  →  { K: 0, C: 1, M: 2, Y: 3, CMY: 4, KCMY: 5, SPECIALTY: 6, UNKNOWN: 7 }
ProductSort.COLOR_ORDER  →  ['black', 'photo black', 'matte black', 'cyan', 'light cyan', 'magenta', 'light magenta', 'yellow', 'cmy', 'tri-color', 'tri-colour', 'color', 'colour', 'kcmy', 'cmyk', 'bcmy', '4-pack', '4 pack', 'red', 'blue', 'green', 'gray', 'grey', 'light gray', 'light grey']
```

---

## Surfaces wired to the override

| Surface | File | Call site |
| --- | --- | --- |
| Shop grid (compatible + genuine sections, brand+category+code, search-drilldown, printer-fallback) | `js/shop-page.js` | `renderProducts(products, …)` — `const sortedProducts = ProductSort.byColor(products)` |
| PDP related products (per source group) | `js/product-detail-page.js` | `renderRelatedProducts(info)` — `const sortByColor = …; compatibles = sortByColor(…); genuines = sortByColor(…)` |
| Generic product grid (`Products.renderCards`) — used by PDP "bought together", `Products.loadIntoContainer`, etc. | `js/products.js` | `renderCards(products)` — `const ordered = ProductSort.byColor(products)` |

### Surfaces deliberately NOT wired

| Surface | Reason |
| --- | --- |
| Smart-search dropdown (autocomplete) | Relevance ranking dominates; cross-brand/cross-family rows wouldn't make sense by colour. Path: `js/search.js renderResults` calling `Products.renderCard` directly in a `.map`, bypassing `renderCards`. |
| Homepage featured carousel | Mixed-brand "Featured" row of 4 cards; colour order would scramble the curated mix. Path: `js/landing.js loadFeaturedProducts`. |
| Favourites grid | User-curated; preserve add-order so the customer can find what they just favourited. Path: `js/favourites.js renderFavouritesPage`. |
| Cart / checkout / order detail line items | Preserve cart-add order — customer expectation is "what I added, in the order I added it." |

---

## Verification

```bash
node --test tests/color-display-order.test.js     # 19 unit tests, ~30 ms
node --test tests/api-changes-may2026.test.js     # 17 contract tests (§1 updated to allow byColor)
npm test                                          # full suite, 430 pass / 7 LIVE_E2E skipped
```

Live smoke test (browser, 2026-05-06):

- `/shop?brand=hp&category=ink&code=975` — compatible group renders **Black, Cyan, Magenta, Yellow, CMY 3-Pack, KCMY 4-Pack**; genuine group renders **975A-Black, 975X-Black, 975A-Cyan, 975X-Cyan, … 975X-Yellow** (stable sort preserves yield order inside each colour tier).
- `/shop?brand=brother&category=ink&code=LC3317` — both compatible and genuine groups render K, C, M, Y, CMY, KCMY; specialty Photo Value Pack lands at the end (TIER_UNKNOWN sink because `'photo'` isn't a singles colour).
- PDP `/products/.../G-HP-975A-INK-BK` — related-products both groups render in canonical order.

---

## How to extend

If a new colour appears in supplier feeds (e.g. `'Light Light Black'`,
`'Photo Gray'`, `'Orange'`), add it to `COLOR_ORDER` in `utils.js` —
position determines the within-tier sort order, but the **tier** is
decided by `colorTier`. Update `colorTier` if the new colour belongs in
K/C/M/Y/CMY/KCMY rather than specialty.

When adding the entry, also add a unit-test row to
`tests/color-display-order.test.js` so the contract stays pinned.

---

## Why a stable sort (not a multi-key comparator)

A multi-key `(colorTier, yieldTier, seriesBase, name)` comparator would
work, but it would replicate the backend's hierarchy on the frontend —
which is exactly what `api-changes-may2026.md §1` told us not to do.
Stable sort sidesteps the problem: we only assert one key (colour tier)
and inherit the rest from the API response. If the backend's per-tier
ordering changes (e.g. a future "Photo Value Pack" promotion), the
frontend follows automatically.

ECMAScript guarantees `Array.prototype.sort` is stable since 2019, so
`products.slice().sort((a, b) => colorTier(a) - colorTier(b))` is a
single-pass implementation with no decorate-sort-undecorate ceremony.
