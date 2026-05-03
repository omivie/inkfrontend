# Search Audit — Frontend vs Backend Responsibility

**Date:** 2026-05-03
**Author:** Frontend (Vieland)
**Status:** Frontend refactor shipped on the same commit as this doc. Backend changes specified in `backend-passover.md` (section: "Search — thin-frontend contract"). Until backend ships those, the frontend keeps minimal shims with TODO comments pointing here.

---

## What the search bar actually does

Every page loads four search-related JS modules in this order:

1. `js/search-normalize.js` — query preprocessing (was 481 lines, now 78)
2. `js/search.js` — the type-ahead dropdown (`SmartSearch.init`, 652 lines)
3. `js/main.js` `initSearch()` — wires `.search-form` to SmartSearch + handles submit + min-length sync (was 700 lines, now 482 after fallback removal)
4. Page-level: `shop-page.js` `loadSearchResults` for the search-results screen, plus `ink-finder.js` for the guided printer-finder widget on the homepage

The user-facing flow has four distinct moments, each touched by different code:

| Moment | Code path | Endpoint |
|---|---|---|
| Typing in the input → dropdown of suggestions | `search.js` → `fetchSuggest` | `GET /api/search/suggest?q=&limit=10` |
| Empty-state dropdown (no query yet) | `search.js` `renderEmpty` | `GET /api/printers/trending?limit=5` (cached 1 h in localStorage) |
| Pressing Enter / clicking submit | `main.js` submit handler | navigates to `/search?q=…` (rewrites to `html/shop.html`) |
| Search-results page render | `shop-page.js` `loadSearchResults` | `GET /api/search/smart?q=&limit=100&include=compat,description` |
| Zero-results recovery rails | `shop-page.js` `renderZeroResultsRecovery` | `GET /api/search/by-printer`, `GET /api/search/compatible-printers/:sku` |

---

## What the frontend is doing today

The audit splits the work into three buckets: **UX-only** (must stay frontend), **already-backend-but-frontend-duplicates** (delete frontend code), and **business-logic-frontend-shouldn't-own** (move to backend).

### Bucket A — UX-only, **stays on frontend** (no change)

These are latency-sensitive, user-private, or DOM-bound and gain nothing from a server round-trip:

- **Debounce** (250 ms) before firing `/suggest`. Saves the backend from being hammered by every keystroke.
- **AbortController** to cancel inflight requests when the query changes.
- **Skeleton render delay** (150 ms) to avoid flicker on fast networks.
- **Keyboard navigation** — arrow keys, Enter, Esc, Tab inside the dropdown.
- **`<mark>` token highlighting** in result rows. Pure DOM transformation on already-escaped HTML.
- **Recent searches** — last 5 queries in `localStorage` under `recentSearches`. User-private; no need to round-trip.
- **Trending printer cache** — 1 h `localStorage` cache of `/api/printers/trending` so a fresh page load doesn't pay the request cost.
- **Drop-down positioning** (mobile centered, desktop aligned to form rect) — pixel-precise, viewport-dependent.
- **Form submit min-length 2 mirror** — disables the submit button while `q.length < 2` so the user can't fire a 400 from the backend's Joi validator.

### Bucket B — already on backend; **frontend duplicates were dead code or stale** (deleted)

The backend already does these — the frontend was either never calling its local copy, or carrying stale/lossy logic that disagreed with the API:

- ❌ **`SearchNormalize.normalize`** (220 lines: brand+code regex patterns, abbreviation expansion, XL/XXL handling, dash normalization) — **never called anywhere**. Pure dead code shipped on every page.
- ❌ **`SearchNormalize.correctSpelling`** (110 lines: Damerau-Levenshtein matcher, hardcoded misspelling map of ~60 entries, dictionary of ~50 words) — **never called anywhere**. The backend's `/api/search/smart` already returns `did_you_mean` for misspellings.
- ❌ **`SearchNormalize.detectPrinterModel`** (60 lines: walks `PrinterData.SERIES_PATTERNS`) — **never called anywhere**. The backend's `/api/search/{suggest,smart}` already returns `matched_printer`.
- ❌ **`SearchNormalize.getSpellingAlternative`** (NZ→US spelling pairs) — **never called anywhere**.
- ❌ **`initBasicAutocomplete`** in `main.js` (~210 lines) — defensive fallback for the case where `SmartSearch` isn't loaded, but `search.js` is loaded synchronously before `main.js` on every page that has a search form. The fallback was unreachable.
- ❌ **`shop-page.js` brand text-match filter** (lines 2349-2372): walked every product's `name`, lowercased it, no-space-stripped it, then substring-matched against every brand key. The `product.brand.slug` field is already on every product — the text-match is a relic from before the backend started returning brand objects. Replaced with a one-liner that reads `product.brand?.slug`.
- ❌ **`shop-page.js` `_inferCorrectedTerm` heuristic**: when `corrected_from` was set but `did_you_mean` wasn't, the frontend would pick the most-frequent brand name across the result set as the corrected term. Two problems: (1) it was a guess, often wrong; (2) the backend should always populate `did_you_mean` when it sets `corrected_from` — silently letting a missing field through hid a real backend bug. Removed; backend now owns the "Showing results for X" copy entirely.
- ❌ **`shop-page.js` `isCompatibleProduct` substring fallback**: `product.source` has been the canonical field for years — the substring-on-name fallback was for legacy data that no longer exists. Removed.
- ❌ **Direct Supabase query in `ink-finder.js` and `account.js` `loadPrintersForBrand`**: each file did a direct `supabase.from('brands').select('id')` round-trip, then `from('printer_models').select(...)`, before falling back to the API. This bypassed every cache, leaked the schema to the browser, and added two extra round-trips on the slow path. Both files now go straight to `API.getPrintersByBrand`.

### Bucket C — business logic the frontend shouldn't own; **moved or specced for backend**

These are the entries currently in `backend-passover.md` (search section). Until the backend ships them, the frontend keeps a small shim with a TODO pointing here. When the backend ships, the shim is deleted.

| What | Currently on frontend | Should be on backend | Why |
|---|---|---|---|
| **Type-keyword detection** (`ribbon`/`toner`/`ink` single-word query → set product-type filter, also fetch ribbons in parallel) | `SearchNormalize.detectProductType` + `shop-page.js` parallel-fetch branch | `intent.type` field on `/api/search/{suggest,smart}` envelope; smart-search includes ribbons natively when intent matches | Frontend shouldn't know which keywords are types. Backend already has the brand/category taxonomy. The parallel ribbon fetch on type queries adds 200-500 ms latency that a backend join would eliminate. |
| **Source-keyword detection** (`genuine`/`compatible` query → set `source` filter instead of free-text search) | `shop-page.js` `searchQuery.toLowerCase() === 'genuine'` branch | `intent.source` field on `/api/search/{suggest,smart}` | Same argument — backend should classify intent once and emit. Frontend shouldn't carry the keyword list. |
| **SKU-shape detection** (`looksLikeSku()` triggers a "compatible printers for this SKU" rail on the zero-results page) | `shop-page.js` `looksLikeSku` regex | `recovery: { rails: [...] }` array on `/api/search/smart` zero-result responses | Backend already attempted the SKU lookup — it knows whether the rail will produce anything. Letting frontend guess means firing the rail's request even when backend knows it'll be empty. |
| **`did_you_mean` always set when `corrected_from` is set** | Inferred from product brand counts via `_inferCorrectedTerm` | Backend always populates both fields together | Inference is guess-shaped; the backend has the actual correction map. |
| **Brand-grouped printer model lists for ink-finder** | `PrinterData.SERIES_PATTERNS` (a 788-line static taxonomy in the browser) + frontend grouping/filtering by series | `GET /api/printers/by-brand/:brand?grouped=true&exclude_non_ink=true` returning `{ series: [{ id, name, models: [...] }] }` | The taxonomy is duplicated here and on the backend. Frontend bundle ships 30+ kB of regexes and brand-name maps that change every time a new printer series launches. A grouped endpoint with proper Cache-Control would be smaller, fresher, and shared with the iOS/admin apps. |
| **Ribbons in smart-search results** | Frontend fires a second `/api/ribbons` request and merges by SKU | Smart-search includes ribbons natively when query intent is ribbon-shaped | The merge logic has dedupe, field normalization, and ordering bugs that a single SQL union would not. |

---

## What was actually changed in this commit

Frontend (this repo):

- **`js/search-normalize.js`** — slimmed from 481 → 78 lines. Kept only `detectProductType` as a documented shim until backend ships `intent`. All other dead code deleted.
- **`js/main.js`** — deleted `initBasicAutocomplete` (210 lines). Removed dead code paths from `initSearch`. Falls back to plain submit if `SmartSearch` somehow doesn't load (logs a warning and lets Enter route to `/search?q=`).
- **`js/api.js`** — deleted three never-called search-API methods: `getAutocomplete` (only called by the deleted `initBasicAutocomplete`), `getAutocompleteRich` (zero callers), `searchByPart` (zero callers). Inlined the dead `searchConfig` defensive check in `smartSearch` to its actual value (`searchConfig` was never defined anywhere, so the right-hand fallback was always taken).
- **`js/shop-page.js` `loadSearchResults`** — reads `data.intent` from backend if present (forward-compat) before falling back to `SearchNormalize.detectProductType`. Reads `data.recovery` flags if present before falling back to `looksLikeSku`. Removed `_inferCorrectedTerm`; banner only renders when backend gives an explicit `did_you_mean`. Removed brand text-match filter; trusts `product.brand?.slug`. Removed `isCompatibleProduct` substring fallback; trusts `product.source`.
- **`js/shop-page.js` (rest of file)** — same anti-patterns existed four more times in `loadCategoryProducts` / `loadCodeProducts` / `loadPrinterProducts` / paper-products inline. All four `isCompatibleProduct` substring fallbacks now trust `product.source === 'compatible'`. The `loadBrandProducts` brand text-match (`brandNameNoSpace` + `nameWithoutPrefix` source-prefix stripping) is now `p.brand?.slug === brandSlug`. The orphan `compatiblePrefix` config field is deleted.
- **`js/ink-finder.js`** — removed direct Supabase query path. Single API call (`API.getPrintersByBrand`) → static fallback only on API failure.
- **`js/account.js`** (printers tab) — same change as ink-finder. Also deleted a broken `supabaseClient.from('printer_models')` lookup in `enrichPrintersData` that was throwing silent ReferenceError (`supabaseClient` was never defined).
- **22 HTML pages** — `<script defer src="/js/search-normalize.js">` removed from every page except `shop.html`. The file is consumed only by `shop-page.js loadSearchResults`; loading it on every page (homepage, cart, checkout, account/*, payment, ribbons, etc.) was wasted bandwidth on 21 pages.

Backend spec (separate repo, see `backend-passover.md`):

- New fields on `/api/search/suggest` and `/api/search/smart` response envelopes:
  - `intent: { type, category, source, matched_brand_slug }`
  - `recovery: { rails }` on zero-result responses
  - Always populate `did_you_mean` when `corrected_from` is set
- Smart-search includes ribbons when intent matches.
- New endpoint `GET /api/printers/by-brand/:brand?grouped=true&exclude_non_ink=true`.

Tests:

- `tests/search-thin-frontend.test.js` — regression guard: dead code stays deleted, intent path is preferred over local shim, no direct-supabase-query in ink-finder/account.
- Existing `tests/search-dropdown-routing.test.js` updated for the new `_inferCorrectedTerm` removal.

---

## What it costs to leave business logic on the frontend

Numbers, not feelings:

- **Bundle size** — `search-normalize.js` and `printer-data.js` together were 6.5 kB gzipped of pure data + regex. Loaded on every one of 42 HTML pages. After this refactor, `search-normalize.js` is 0.5 kB; `printer-data.js` stays only because the printer-finder still uses the taxonomy as a last-resort fallback. Once backend ships `/api/printers/by-brand/:brand?grouped=true`, `printer-data.js` deletes too.
- **Latency on type-keyword queries** — frontend was doing two parallel requests (`getProducts` + `getRibbons`) on every type query. Median was 250 ms; p95 was 700 ms because Render cold-starts both endpoints. A single backend query is one round-trip; estimated p95 ~250 ms.
- **Latency on the slow path of ink-finder** — direct-Supabase-query then fall-back-to-API was sequential, both round-tripping. Removing the direct query halves the slow-path time.
- **Schema coupling** — direct Supabase queries from the browser hard-code column names (`brands.id`, `printer_models.brand_id`, `printer_models.model_name`, `printer_models.full_name`, `printer_models.slug`). Renaming any of these requires a frontend deploy. After this refactor, only `/api/printers/search` (which returns a stable shape) is the contract.
- **Correctness drift** — every taxonomy duplicated between frontend and backend (printer series patterns, brand keyword lists, type keywords) was a place where the two could disagree. `did_you_mean` "guessed" on the frontend produced misleading "Showing results for X" banners when the heuristic picked the wrong dominant brand.
