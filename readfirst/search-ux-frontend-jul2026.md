# Search UX — Frontend spec (Jul 2026) — implementation notes

Source spec: `search-ux-frontend-spec-jul2026.md` (from the backend dev). Every
signal already ships on `GET /api/search/smart`; this was purely a rendering
pass on the storefront search-results surface.

**Surface:** the search-results page is the shop page at
`level === 'search-results'` — `inkcartridges/html/shop.html`, controller
`inkcartridges/js/shop-page.js::loadSearchResults`. Styles in
`inkcartridges/css/search.css`. Pinned by
`tests/search-match-reason-labelling-jul2026.test.js` (+ updates to
`category-page-contract-may2026`, `search-results-parity-may2026`,
`compat-search-badge-jul2026`, `product-surface-consistency-may2026`).

## What the spec asked for, and where it landed

| § | Signal | Status | Where |
|---|---|---|---|
| §1 | `match_reason:"compatibility"` → per-card "Fits X" chip | **already shipped** (ERR-083) | `createProductCard` `compatMatchBadge` |
| §1 | `match_reason:"fuzzy"` → "Showing results similar to 'X'" banner | **NEW** | `renderSearchBanners` (`.search-similar-banner`) |
| §1 | `match_reason:"semantic"` → "Best matches" header (all) / "Suggested" chip (some) | **NEW** | `renderSearchBanners` (`.search-best-matches`) + `createProductCard` `suggestedBadge`; row tagging in `loadSearchResults` |
| §2 | `did_you_mean` alone → "Did you mean X?" | **already shipped** | `renderSearchBanners` (`.search-did-you-mean`) |
| §2 | `corrected_from` → "Showing results for X. Search instead for Y." | **NEW (honest variant)** | `renderSearchBanners` (`.search-correction-banner`) + exact-mode |
| §3 | zero-result `recovery.rails[]` | **already shipped** | `renderZeroResultsRecovery` |
| §4 | `matched_printer` drill-in | **already shipped** | `renderSearchBanners` printer hero |
| §5 | `intent.matched_brand_slug` / `category` / `source` | **NEW (chip row)** | `renderSearchBanners` (`.search-intent-chips`) |
| §6 | series/yield grouping + `Save $X.XX (Y%)` savings | **already shipped** | `ProductSort.byCodeThenColor` + `createProductCard` savings pill |
| §7 | autocomplete `/suggest` (suggestions/matched_printer/did_you_mean/recent) | **already shipped** | `js/search.js` |
| §8/§9 | skeleton, no-layout-shift, mobile sticky/bottom-sheet | **already shipped** | `showLoading` + `filter-sort-sheet` |

## The one deliberate deviation — §2 "Search instead" is NON-looping

The spec's literal §2 ("Search instead for Y" → re-run the raw query) would have
re-introduced the exact misleading UX retired in
`tests/category-page-contract-may2026.test.js §3`: for a genuine typo
("cannon" → "canon"), re-running `/search?q=cannon` just makes `/smart`
auto-correct straight back to "canon" — a silent loop. (Note the reconciliation
in `loadSearchResults` already handles cases like `q=511` *without* any banner,
by swapping to literal results and nulling `smartData`; so the correction banner
only ever surfaces for the surviving genuine-typo case, which is precisely the
looping one.)

**Resolution (chosen by the owner):** the correction banner ships, but the
"Search instead" link re-runs the raw query in **exact mode**
(`/search?q=<original>&exact=1`). `exact=1` is read in `parseURLState`
(`state.exact`) and consumed in `loadSearchResults`: it forces the literal
path and prefers it unconditionally, so the raw query yields honest literal
results — or, when there are none, the honest zero-result recovery screen —
instead of a re-correction loop. `updateURL` preserves `exact` across
pagination; a fresh header search clears it.

## Rendering rules (spec §1)

- Raw `match_reason` enum values are **never** shown.
- **All** rows share `semantic` → one `.search-best-matches` section notice.
  **Some** rows `semantic` → per-card "Suggested" chips (`_suggestedChip` tagged
  in `loadSearchResults`, consumed by `createProductCard`).
- Any `fuzzy` row → one `.search-similar-banner` with the first row's
  `matched_token`.
- Chip stack now carries up to three badges: fits-printer (blue) / compat (teal)
  / suggested (indigo). All dynamic strings escaped via `Security.escapeHtml`
  / `escapeAttr`.

## Scope note

The autocomplete **dropdown** (`js/search.js`) was left unchanged — §1's
semantic/fuzzy labelling is specced for the results grid, and the dropdown was
already redesigned (§7). Kept out to limit blast radius.
