# Errors Log — InkCartridges.co.nz

Log every error encountered here. Before editing a file, scan for known issues. When a familiar error reappears, apply the known fix immediately.

---

## ERR-034 — `/shop?category=ink` (no brand) stuck on "server may be warming up" forever (2026-05-21)

**Symptom:** Any category-only deep link — `/shop?category=ink`, `/shop?category=toner`,
the `/ink-cartridges` landing — rendered the alarm-state card *"We couldn't load
products. The server may be warming up — please try again."* permanently. The
"Try again" button never recovered. Surfaced by `mobile-parity-audit-may2026.md`
§S0.3 (mobile users hit it most via deep links); reproducible at both desktop
and mobile.

**Root cause (storefront):** `shop-page.js parseURLState()` set `level='codes'`
whenever `category` was present — *even with no brand*. `loadProductCodes()` then
called the chip endpoint, which **requires** a `brand` (it 422s on
`/api/products/series?category=ink`). The terminal catch painted the warming-up
error, and Try-again re-ran the same brand-less call. The chip grid is meaningless
without a brand anyway.

**Fix:** split the level logic — `category && brand → codes` (drilldown),
`category` alone → `brands` (a **brand picker**: heading "Choose a brand to see
ink cartridges", ribbon section hidden). Tile click drills into the chips via
`navigateTo('codes', { brand, category })`. The `'codes'` case in `navigateTo`
now honours an explicitly-passed `data.brand` (`data.brand || this.state.brand`)
— previously it read only `this.state.brand`, which was null at the picker, so
the brand would have been dropped a second time. Verified live: no error, 10
tiles, click → `/shop?brand=hp&category=ink`.

**Rule:** never call a brand-required endpoint (`/api/products/series`, the chip
grid) without a brand. Category-without-brand is a *brand-selection* state, not a
load failure. When adding a `navigateTo` destination that can be reached with a
brand the caller supplies (vs. one already in state), read `data.<field> ||
this.state.<field>`.

**Pinned by:** `tests/mobile-parity-may2026.test.js` (S0.3 group).

**Process gotcha (recorded so I don't chase ghosts again):** running the full
suite via `node --test tests/*.test.js` is **non-deterministic** — ~32 phantom
failures appear and the failing set *changes between runs* because test files
share a single process and pollute globals (`window`/`document`/module state).
The authoritative signal is **per-file**: loop `for f in tests/*.test.js; do
node --test "$f"; done`. Run that way, the whole suite is green. Don't trust a
red from the glob run without confirming it reproduces in isolation.

---

## ERR-033 — Search "magnifier click doesn't navigate" — reported, NOT reproducible (2026-05-21)

**Reported (backend handoff `search-enter-key-may2026.md`, "Magnifier icon click —
companion regression", 2026-05-20):** clicking the magnifying-glass icon does not
navigate to `/search?q=`. Four hypotheses offered (preventDefault-without-nav,
stale `action="/shop"`, disabled flicker, overlay intercept).

**Verified live (Playwright on prod + DOM hit-testing) — the magnifier WORKS in
every scenario:** homepage + `/search` results page, desktop (1280) + mobile (390),
dropdown open + closed, real coordinate clicks. Each hypothesis disproven:
- **H1** false — `main.js` submit handler calls `preventDefault()` **then**
  `window.location.href = `/search?q=${encodeURIComponent(query)}``.
- **H2** false — `/shop` **and** `/search` both rewrite to `/html/shop` in
  `vercel.json`, and `shop-page.js` reads `?q=` to render the search-results level
  regardless of path. Confirmed live: `/shop?q=tn%202350` renders the **identical**
  "Search Results for…" view as `/search?q=tn%202350`. So the old `action="/shop"`
  was never a hard bug.
- **H3** false — `disabled` only no-ops for `q.length < 2` (the documented MIN_LEN
  guard); valid queries enable + submit fine.
- **H4** false — expanded form is `z-index:10`, the dimming overlay `z-index:5`;
  `document.elementFromPoint()` at the magnifier centre returns the button's `<svg>`.

**What was actually missing:** a regression guard. The Enter path was pinned
(`search-enter-key-may2026`), but **nothing** pinned the magnifier-click path — the
exact asymmetry the handoff feared (someone could move navigation onto
`input.keydown` only; Enter keeps working, magnifier silently dies). The magnifier
is a `<button type="submit">`; clicking it fires the form's `submit` event — the
SAME event Enter triggers — so one `searchForm.addEventListener('submit', …)` drives
both affordances.

**Change shipped (defense-in-depth, not a bug fix):** aligned every keyword search
form's `action="/shop"` → `action="/search"` (24 forms across `html/` + the root
`index.html`/`404.html` served copies; the Ink Finder `ink-finder__cartridge-form`
stays `action="/shop"` — it posts brand/printer params, not `q`). Now the no-JS /
pre-hydration native-submit fallback lands on the canonical `/search?q=` too, not
just the JS path. Navbar parity preserved (all forms changed identically → still one
header hash).

**Rule:** the magnifier and Enter must route to the same `/search?q=` URL; keep the
navigation handler on the FORM's `submit` event, never input-keydown-only. Keep the
search form's no-JS fallback honest: `method="GET"` + input `name="q"` + a q-routing
`action` (`/search`).

**Pinned by:** `tests/search-magnifier-click-may2026.test.js` (8 tests).

---

## ERR-032 — Favourited item, but `/account/favourites` shows the empty state (2026-05-21)

**Symptom:** User clicks the heart on a product (POST `/api/user/favourites` →
201, row genuinely stored), then visits `/account/favourites` and sees
"You haven't saved any favourites yet." Backend dev's handoff
(`favourites-bug-frontend-fix-may2026.md`) blamed the storefront: "the page
never calls the API, or calls it without the `Authorization` header."

**That diagnosis was wrong.** Verified live (Playwright + curl with a real JWT):
- The page **does** call `GET /api/user/favourites`, **with** a valid
  `Authorization: Bearer <jwt>` header.
- The endpoint returns **HTTP 500 `{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to fetch favourites"}}`** in **every** state — zero rows, one row, after delete.
- Same token: POST → 201, DELETE → 200, `check/:id` → 200. Only the **list**
  handler 500s. So it's a systemic backend crash, not data- or user-specific.
- The dev verified the DB row + RLS via SQL but never called the live GET — which throws.

**True root cause (backend, separate repo on Render):** `GET /api/user/favourites`
list handler crashes unconditionally. **Frontend cannot fix this** — must be
fixed in the backend repo (likely the products JOIN / row serialization in the
list query; the no-join `check` endpoint works).

**Frontend defect this exposed (FIXED here):** `api.js` resolves a 500 as a
`{ ok:false, code:'INTERNAL_ERROR', status:500, request_id }` envelope (it does
NOT throw on 5xx). The old `Favourites.loadFromServer()` only populated `items`
inside `if (response.ok && response.data)`, hit no catch, left `items` empty,
and `renderFavouritesPage()` showed the empty state. **A backend outage thus
masqueraded as "no favourites" and stayed invisible for a week.**

**Fix (`js/favourites.js`, `js/favourites-page.js`):**
- `loadFromServer` now records `loadError = { message, requestId }` on any
  non-ok response (or throw) — never silently empties the list.
- `renderFavouritesPage` shows a real error+retry pane (with the 8-char
  request-id for Render-log correlation) **before** the `items.length === 0`
  empty-state check.
- Loads de-duped through a shared `_loadPromise`; `ensureLoaded()` short-circuits
  when already loaded; `reload()` backs the "Try again" button.
- `favourites-page.js` is authoritative: `await Favourites.ensureLoaded()` then
  render, instead of racing the global `init()` double-render.

**Rule:** A failed load is **not** an empty list. Any list/detail surface that
fetches user data must distinguish failure (error+retry, surface the request-id)
from a genuine empty result. Never let `api.js`'s resolved `{ ok:false }` 5xx
envelope fall through into an empty/"none found" UI.

**Pinned by:** `tests/favourites-load-error-state.test.js` (9 tests).

---

## ERR-031 — Search dropdown shows bare `<img alt>` text for a tile `/search` renders fine (2026-05-21)

**Symptom:** `/search?q=915xl` (full results page) rendered all six HP 915XL
tiles with photos, but the typeahead dropdown for the same query showed the
bare `<img alt>` text fallback for `HP Genuine 915XLM … Magenta` (and similar
single-row regressions on other queries). Same product row, same backend
`image_url`. Backend proven innocent — identical, reachable URL on both surfaces
(per `search-dropdown-routing.md` "Image rendering parity", 2026-05-20).

**Root cause (storefront, two-part):** `src` and `srcset` both route through
`/api/images/optimize`. When that endpoint transiently fails for ONE tile
(429 / cold-cache timeout / one bad conversion) the optimized URL 4xx/5xx's
while the file itself is fine. The `/search` results grid (`shop-page.js:3145`)
recovered because it carried `data-raw-src` (direct Supabase URL) AND bound an
error handler that retried it. The dropdown did **neither**:
1. `Products.getProductImageHTML` — the shared renderer the dropdown uses —
   emitted no `data-raw-src`.
2. `search.js renderResults` never called `Products.bindImageFallbacks` — it
   was the **only** card surface in the repo that skipped it (shop, filters,
   cart, favourites, landing, checkout, PDP rail, payment all bind it).

**Fix:** unify the fallback strategy across both renderers.
- `products.js getProductImageHTML` now computes `rawImageUrl` via
  `storageUrlRaw()` and appends `data-raw-src` to both the placeholder and
  color-block `<img>` branches (mirrors `shop-page.js`).
- `search.js renderResults` now calls `Products.bindImageFallbacks(state.list)`.

The shared `bindImageFallbacks` handler is the single ladder: error → retry
raw (strip srcset) → placeholder/color-block. Because the fix lives in the
*shared* renderer, every surface using `Products.renderCard` gains the raw
retry, not just the dropdown.

**Rule:** any surface that renders `Products.renderCard` output MUST also call
`Products.bindImageFallbacks(container)` after insertion — otherwise a single
optimize-endpoint hiccup paints alt text with no recovery. Keep `getProductImageHTML`
and the `shop-page.js` results grid in lockstep on `data-raw-src`.

**Pinned by:** `tests/search-dropdown-image-parity.test.js` (15 tests). Routing
half of the same spec is pinned by `tests/search-dropdown-routing.test.js`.

---

## ERR-030 — Sign-in lands on `/account/` → 404 Page Not Found (2026-05-21)

**Symptom:** After signing in on `/account/login`, the browser navigated to
`inkcartridges.co.nz/account/#` and rendered the 404 page. Same for Google OAuth
return and the admin-gate bounce.

**Root cause:** On Vercel (`cleanUrls: true` + the `/account/:path*` rewrite),
the trailing-slash `/account/` resolves to the directory `/html/account/` and
returns **404**. The slash-less `/account` serves `/html/account/index.html` → 200.

```
curl -L https://inkcartridges.co.nz/account/   → 404
curl -L https://inkcartridges.co.nz/account     → 200
curl -L https://inkcartridges.co.nz/account/login → 200   # sub-paths fine
```

Code redirected to the broken trailing-slash form in several places:
- `js/security.js` — `safeRedirect(url, fallback = '/account/')` (post-login default)
- `js/auth.js` — Google OAuth `redirectTo: ${origin}/account/`
- `js/admin/auth.js` ×3 — admin-gate failure bounces
- `html/account/personal-details.html` ×2 — breadcrumb links

**Fix:** Drop the trailing slash everywhere (`/account/` → `/account`, matching the
nav header which already used `/account`). Added a scoped Vercel safety-net redirect
`{ "source": "/account/", "destination": "/account", "permanent": true }` for
bookmarked/external trailing-slash hits.

**Rule:** Internal links/redirects to the account home must be slash-less `/account`;
never `/account/`. Sub-paths (`/account/login`, `/account/orders`, …) are unaffected.

**Pinned by:** `tests/account-trailing-slash-redirect.test.js` (5 tests).
