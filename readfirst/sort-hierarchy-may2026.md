# Catalog Sort Hierarchy — May 2026 (Frontend Mirror)

**Status:** active contract
**Layer:** storefront frontend (vanilla JS) — `inkcartridges/js/utils.js` ProductSort
**Spec date:** 2026-05-10
**Backend mirror:** `src/utils/productSort.js` (separate repo)
**Pinned by:** `tests/sort-hierarchy-may2026.test.js`,
              `tests/color-display-order.test.js`,
              `tests/code-yield-grouping-may2026.test.js`
**Supersedes:** `readfirst/color-display-order-may2026.md` (the legacy 8-tier model)

---

## TL;DR

Every product list rendered to a customer is sorted into the canonical
22-position colour rank table **before** the cards hit the DOM:

```
Within a single (yieldTier, seriesBase) group:

  0   Black            (K)            ─┐
  1   Cyan             (C)             │ standard singles
  2   Magenta          (M)             │
  3   Yellow           (Y)            ─┘
  4   Photo Black      (PB)           ─┐
  5   Matte Black      (MB)            │
  6   Light Cyan       (LC)            │
  6.5 Photo Cyan       (PC)            │
  7   Light Magenta    (LM)            │
  7.5 Photo Magenta    (PM)            │ specialty singles
  8   Vivid Light Magenta (VLM)        │
  9   Grey                             │
  10  Violet                           │
  11  Tri-Colour (single cartridge)    │
  12  Red                              │
  13  Blue                              │
  14  Green                             │
  15  Orange                            │
  16  White                             │
  17  Black/Red (legacy)              ─┘
  19  Unknown single
  20  CMY 3-Pack                      ─┐ packs
  21  KCMY 4-Pack / CMYK / BCMY       ─┘
```

The pass is a **stable** sort by `(familyKey, yieldTier, colorOrder, packRank)`
— products with the same key keep their incoming relative order, so the
backend's `seriesBase`/`yieldTier` grouping inside a rank is preserved.

---

## Sort key tuple

```
(accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)
```

| Key            | Source                              | Description |
|----------------|-------------------------------------|---|
| `accessoryTier` | `ProductSort.accessoryTier(p)`     | Cartridges first (0); drums (1); paper / maintenance (2); printers / everything else (3). |
| `yieldTier`     | `ProductSort.yieldTier(p)`         | Std (0) → XL/HY (1) → XXL/SHY/XLL (2). HY ≡ XL. |
| `seriesBase`    | `ProductSort.seriesBase(p)` (alias for `familyKey`) | Alphanumeric MPN family with yield + colour suffixes stripped (`TN645`, `LC3317`, `BCI6`, `975A`). |
| `colorOrder`    | `ProductSort.colorOrder(p)`        | The 22-position table. Pack-name regex first to defend against mislabeled feed rows. |
| `packRank`      | `ProductSort.packRank(p)`          | single (0) < value_pack (1) < multipack (2). Tiebreaker. |
| `name`          | lexicographic                       | Final guard against unstable input. |

---

## Why singles always rank below packs

Customers shopping a series want to evaluate every individual cartridge first,
then decide whether the bundle is worthwhile. The pre-May 2026 frontend
collapsed every specialty colour into the parent tier (Photo Black → K, Light
Cyan → C, Photo Cyan → C), which inverted the intended hierarchy on Epson 46S,
Canon CLI42, and any printer with photo / matte / light variants — packs at
rank 4–5 ended up sandwiched between standards (0–3) and specialty (6).

The new table promotes packs to 20/21, leaving 4–17 for specialty singles so
the row reads cleanly:

```
Standards (K, C, M, Y) → specialty singles (PB, MB, LC, …) → packs (CMY, KCMY)
```

---

## Pack-name fallback for mislabeled feed rows

Some supplier feeds ship value packs with a literal `color = "Black"` (the
SKU's "primary" colour). `colorOrder()` detects pack-shape names via regex
**before** the colour-field lookup:

| Regex                                              | Rank |
|----------------------------------------------------|------|
| `/\b(?:KCMY\|CMYK\|BCMY)\b\|\b4\s*colou?r\b\|\b4\s*-?\s*pack\b/i` | 21 |
| `/\bCMY\b\|\b3\s*colou?r\b\|\b3\s*-?\s*pack\b/i`   | 20 |

Without the regex, a "Brother Genuine LC3317 KCMY 4-Pack" with `color="Black"`
would inherit `colorOrder=0` and rank ahead of the K single. The 4-token
branch is checked first because "CMY" is a strict subset of "KCMY".

---

## Public API (`inkcartridges/js/utils.js`)

`ProductSort` is exported globally as `window.ProductSort` and via
CommonJS for tests.

```js
ProductSort.colorOrder(product)           // → 0..21 (or 19 for unknown single)
ProductSort.colorTier(product)            // → 0..7  (legacy 8-bucket view)
ProductSort.accessoryTier(product)        // → 0 (cartridge) .. 3 (other)
ProductSort.yieldTier(product)            // → 0 (std) .. 2 (XXL)
ProductSort.seriesBase(product)           // → 'TN645', 'BCI6', '975A', …
ProductSort.packRank(product)             // → 0 (single) .. 2 (multipack)
ProductSort.familyKey(product)            // → 'B:BROTHER:TN645' (brand-scoped)
ProductSort.resolveColorName(product)     // → lowercased canonical colour string

ProductSort.byColor(products)             // stable sort by colorOrder
ProductSort.byCodeThenColor(products)     // stable sort by family → yield → colour
ProductSort.rowBreakIndices(sorted, opts) // boundary indices for row-break splice
ProductSort.sortByCatalogOrder(products)  // full 6-tuple catalog sort
ProductSort.sortByRelevance(products, scoreMap) // score-aware variant for /search

ProductSort.COLOR_RANK                    // frozen { 'black': 0, 'cyan': 1, … }
ProductSort.RANK_UNKNOWN_SINGLE           // 19
ProductSort.PACK_NAME_REGEX_3 / _4        // pack-detection regexes
ProductSort.TIERS                         // { K, C, M, Y, CMY, KCMY, SPECIALTY, UNKNOWN }
ProductSort.COLOR_ORDER                   // legacy index list (deduped, kept for back-compat)
```

All sort helpers return a **new** array; they never mutate the input.
Edge cases (`null`, `undefined`, non-array) → `[]`.

---

## Surfaces wired to the contract

| Surface | File | Call site |
|---|---|---|
| Shop grid (compatible + genuine sections) | `js/shop-page.js` | `renderProducts(products, …)` — `ProductSort.byCodeThenColor(products)` + `rowBreakIndices` splice |
| PDP related products | `js/product-detail-page.js` | `renderRelatedProducts(info)` — `ProductSort.byCodeThenColor` over `compatibles` and `genuines` |
| Generic product grid | `js/products.js` | `Products.renderCards(products)` — `ProductSort.byCodeThenColor` |

### Surfaces deliberately NOT wired

| Surface | Reason |
|---|---|
| Smart-search dropdown | Relevance ranking dominates; cross-family rows wouldn't make sense by colour. |
| Homepage featured carousel | Curated mix; colour order would scramble it. |
| Favourites grid | User-curated; preserve add-order. |
| Cart / checkout / order detail | Preserve cart-add order. |

The backend's `/api/search/smart` endpoint applies `sortByRelevance`
server-side; the FE pass via `ProductSort.sortByRelevance` is a no-op
when the BE got it right and a guard when RPC variance disagrees with
the contract within a family.

---

## Endpoints applying the contract (backend)

`sortByCatalogOrder` is wired into:

- `GET /api/shop`
- `GET /api/products/printer/:printerSlug`
- `GET /api/printers/:printerSlug/products`
- `GET /api/prerender/printer/:brandSlug/:printerSlug`
- `GET /api/prerender/category/:category`
- `GET /api/prerender/brand/:brandSlug`

`sortByRelevance` (score-aware variant) is wired into:

- `GET /api/search/smart`

The frontend mirrors run on these payloads as a defensive secondary pass.

---

## Adding a new colour rank

When a new specialty colour ships (e.g. `'Light Light Black'`, `'Photo Gray'`):

1. Pick a slot in the 4–17 range that matches its visual relationship to
   existing colours. Float ranks (e.g. `4.5`) are fine — they let you slot
   between existing entries without renumbering.
2. Add the entry to `COLOR_RANK` in `inkcartridges/js/utils.js`. Aliases
   (e.g. `'photo gray': 9.6, 'pgy': 9.6`) are encouraged.
3. Add a row to `tests/sort-hierarchy-may2026.test.js` so the rank stays
   pinned.
4. Update this doc's table.
5. Sync the backend's `src/utils/productSort.js` so the FE secondary pass
   stays a no-op on canonical responses.

---

## Verification

```bash
node --test tests/sort-hierarchy-may2026.test.js     # 33 unit tests, ~44 ms
node --test tests/color-display-order.test.js        # 17 contract tests, ~30 ms
node --test tests/code-yield-grouping-may2026.test.js # 27 wiring tests, ~15 ms
node --test tests/*.test.js                          # full suite — 623 pass
```

Live smoke test (browser, post-deploy):

- `/shop?brand=hp&category=ink&code=975` — compatible group renders **Black,
  Cyan, Magenta, Yellow, CMY 3-Pack, KCMY 4-Pack**.
- `/shop?brand=epson&category=ink&code=46S` — **Black → Photo Black → CMY
  3-Pack** (regression guard: pre-May 2026 had the pack ahead of PB).
- `/shop?brand=brother&category=ink&code=LC3317` — **K, C, M, Y, CMY, KCMY**
  with std/XL stacked on consecutive rows.
- PDP `/products/.../G-CAN-BCI6B` — related-products row shows **Black, Cyan,
  Magenta, Yellow, Photo Cyan, Red, KCMY 4-Pack** (specialty singles between
  standards and pack).

---

## Why a stable sort (not a multi-key comparator everywhere)

A multi-key `(accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)`
comparator works for the full catalog sort (`sortByCatalogOrder`), but on the
storefront we usually want to **preserve the API's family-appearance order**
and only assert colour order *within* a family. That's `byCodeThenColor`'s
job: it captures incoming family order via `Map`, then overlays
`(yieldTier, colorOrder, packRank)` inside the family. Stable sort preserves
the rest from the API response.

ECMAScript guarantees `Array.prototype.sort` is stable since 2019, so a
single `.sort()` call by the partial key is sufficient — no
decorate-sort-undecorate ceremony.
