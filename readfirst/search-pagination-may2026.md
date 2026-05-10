# Search Results Pagination — May 2026

**Status:** Shipped — 2026-05-10
**Spec for:** `inkcartridges/js/shop-page.js` (`loadSearchResults`,
`renderSearchPagination`), `inkcartridges/css/search.css` (`.search-pagination`).
**Pinned by:** `tests/search-pagination.test.js` (21 tests).

## What this fixes

Searching for a broad term — `compat`, `compatible`, `ink`, `toner` — surfaced
only the first 100 products, with no way to reach the rest. The backend
returned `{ total: 633, total_pages: 7, has_next: true }` on
`/api/search/smart?q=compat`, but the storefront never read the pagination
envelope and never wired a pager, so cards 101–633 were unreachable from the
UI. Customers looking for a specific compatible cartridge under a broad search
term hit a dead end.

The fix: page-based pagination across every `/search?q=…` API path, with a
pager rendered beneath the genuine + compatible grids.

## Contract

- Page size is **100** (`SEARCH_PAGE_SIZE` in `loadSearchResults`). Backend
  Joi caps `limit` at 100 on every search endpoint, so this is the largest
  per-request slice we can ask for.
- Page state lives on `state.page` (1-indexed). The URL carries it as
  `?q=…&page=N` — written by `updateURL` only when the level is
  `search-results` and `page > 1`, parsed back by `parseURLState` with a
  positive-integer guard (default 1).
- Every search branch in `loadSearchResults` threads `page` + `limit` into
  its API call:
  - free-text → `API.smartSearch(q, { limit: SEARCH_PAGE_SIZE, page, include })`
  - typeDetect (single-word `ribbon`/`toner`/`ink`) →
    `API.getProducts({ ...productParams, limit: SEARCH_PAGE_SIZE, page })`
  - sourceKeyword (`genuine`/`compatible`) →
    `API.getProducts({ source, limit: SEARCH_PAGE_SIZE, page })`
  - empty-result fallback → `API.getProducts({ search: q, limit: SEARCH_PAGE_SIZE, page })`
- Pagination metadata is normalised to one shape (matches smart-search):
  `{ total, page, limit, total_pages, has_next, has_prev }`. `/api/products`
  ships it on the top-level `meta` key; `/api/search/smart` ships it on
  `data.pagination`. Both are mapped into the same `pagination` local.
- Ribbons stay on a one-shot `getRibbons({ limit: 200 })` — the table is
  small (typewriter ribbons + label tapes) and the merge happens client-side.
- `renderSearchPagination(pagination)` paints `<nav id="search-pagination"
  class="pagination search-pagination">` into `#level-products` (so it gets
  cleared by `hideAllLevels` on navigation). Hides itself when
  `total_pages <= 1` or `pagination` is null.
- Click handler: updates `state.page`, calls `updateURL` (pushState),
  bumps `navigationVersion`, scrolls the top of the results into view, and
  re-runs `loadSearchResults`. Browser back/forward fire `popstate` →
  `parseURLState` → reload.

## Why we kept the brand-narrowing heuristic on paginated pages

`loadSearchResults` runs a "≥40% of results from one brand → narrow to that
brand" filter on free-text searches. This still runs after pagination,
which means the visible card count on a given page may be less than the
backend's 100 (e.g. ~55 cards on page 1 of `compat` because Canon dominates
the result set). That's a pre-existing UX choice and out of scope for this
fix — the pager surfaces all 7 pages, which was the load-bearing problem.
A future cleanup can move brand-narrowing server-side via
`smart.intent.matched_brand_slug` (see `backend-passover.md`, "Search —
thin-frontend contract", task 1).

## Out-of-bounds pages

If a user manually edits the URL to a page beyond `total_pages`, the
backend returns 400 (validation: `page must be ≤ N`) or 500. The frontend
falls into the zero-results recovery rails (the existing
`renderZeroResultsRecovery` panel), which gives the customer a way back —
recovery suggestions, "Did you mean…?", clear-search chip.

We do not auto-redirect to page 1 because:
- the recovery rails already serve the customer
- backend caps `page` at 50 anyway, so the only way to hit OOB is a
  hand-typed URL or a stale bookmark

## Cache key

`/css/search.css` query string bumped from `v=white-cards-may2026` to
`v=search-pagination-may2026` across all 29 HTML pages so returning visitors
pull the new pager styles instead of an unstyled `.pagination__btn` grid.
