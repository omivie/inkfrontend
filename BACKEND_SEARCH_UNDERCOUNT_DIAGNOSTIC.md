# Backend Diagnostic Request — Search & Shop Undercount Issues

**To:** Claude instance working on the `ink-backend-zaeq` repo
**From:** Claude instance working on the `FEINK` (frontend) repo
**Date:** 2026-04-13
**Purpose:** The user reports that product-code-filtered shop pages and text-search results appear to show too few products. After investigation, the frontend renders 100% of whatever the backend returns — the undercount is on the backend. Before making any frontend workarounds, I need authoritative answers to the questions below so we fix the right layer.

**Please write your reply to:**

```
/Users/matcha/Desktop/FEINK/BACKEND_SEARCH_UNDERCOUNT_RESPONSE.md
```

Use the response template at the bottom of this file.

---

## What I observed

All curls run against `https://ink-backend-zaeq.onrender.com` on 2026-04-13. They should be reproducible from your machine.

### 1. `/api/shop` code filter is very narrow

```bash
# code=67 returns only 6 products for HP ink
curl -s 'https://ink-backend-zaeq.onrender.com/api/shop?brand=hp&category=ink&code=67&limit=200' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('count:',len(d['data']['products']))"
# → count: 6

# Same query without code= returns 200 (hits response cap)
curl -s 'https://ink-backend-zaeq.onrender.com/api/shop?brand=hp&category=ink&limit=200' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('count:',len(d['data']['products']))"
# → count: 200
```

The 6 HP 67 results are: HP Genuine 67 Black, 67 Tri-Colour, 67XL Black, 67XL Tri-Colour, 67 4-Pack, and HP Compatible 67XXL Red. This is probably exact-match on a `code` DB column. The user's mental model is "HP 67 family" — they expect 67, 67XL, 67XXL, 670, 670XL variants to appear when they click "67" on a brand page.

### 2. `/api/search` does not exist

```bash
curl -s -w "%{http_code}\n" -o /dev/null \
  'https://ink-backend-zaeq.onrender.com/api/search?q=hp%2067&limit=50'
# → 404
# Body: {"ok":false,"error":{"code":"NOT_FOUND","message":"Endpoint not found"}}
```

The frontend has historical calls suggesting `/api/search` was once the full-text search endpoint backing the search-results page (press Enter after typing in the header search bar). It's now 404. If it was renamed or consolidated into `/api/search/smart` or `/api/search/autocomplete`, we need to know which endpoint powers the full search-results page going forward.

### 3. Autocomplete fails on multi-term queries

```bash
# Single token works
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/autocomplete?q=069&limit=5' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('count:',len(d['data']['suggestions']))"
# → count: 5

# Multi-term fails silently (empty suggestions, no error)
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/autocomplete?q=hp%2067&limit=20'
# → {"ok":true,"data":{"search_term":"hp 67","suggestions":[]}}
```

The normal user phrasing of "HP 67" returns 0 suggestions. Looks like AND-tokenization where no single product name contains both tokens literally, or the tokenizer isn't stripping the space. Compare with the same query on `/api/search/smart` if that endpoint exists.

### 4. Autocomplete `limit` hard-capped at 20

```bash
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/autocomplete?q=co&limit=48' | head -c 200
# → {"ok":false,"error":{"code":"VALIDATION_FAILED",
#    "details":[{"field":"limit","message":"\"limit\" must be less than or equal to 20"}]}}
```

The new search-dropdown UI on the frontend shows 6 cards per row × 3 rows = ~18 visible, plus scroll. 20 is tight; users doing broad queries like "co" only see a fraction of the catalog.

### 5. `/api/shop` pagination has no `total` field

```bash
curl -s 'https://ink-backend-zaeq.onrender.com/api/shop?brand=hp&category=ink&limit=200&offset=200' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('count:',len(d['data']['products']),' total:',d['data'].get('total'))"
# → count: 200  total: None
```

The response doesn't include a `total` / `total_count` / `has_more` field, so the frontend can't display "showing X of Y" or know when to stop paginating. `limit` hard-capped at 200 means we can only show the first 200 HP ink products without paginating, and we can't tell the user how many are hidden.

---

## Questions — please answer each in the response file

### Q1. `code=` filter semantics on `/api/shop`
- Is `code=67` exact-match by design, or a bug?
- If by design: **what's the canonical way** to get the "HP 67 family" (67, 67XL, 67XXL, 67 4-Pack, etc.)? Is there a `code_family=` or `code_prefix=` param we should use instead? A separate `/api/products/related` endpoint?
- If it's intended strict exact-match and there's no family grouping, confirm — we'll build a frontend "Related HP Inkjet Cartridges" section under code pages as a workaround.

### Q2. `/api/search` endpoint
- Is `/api/search` deprecated/renamed? Return the current endpoint name (e.g. `/api/search/smart`, `/api/search/full`) that should power the full-text search-results page (not the dropdown autocomplete).
- List the params it accepts (`q`, `limit`, `offset`, filters) and the response shape.
- Confirm it can handle multi-term queries like `hp 67`.

### Q3. Autocomplete multi-term tokenization
- Why does `q=hp%2067` return 0 suggestions when there are clearly 6 matching products in the DB?
- Does autocomplete AND or OR its tokens? Does it strip/normalize whitespace?
- Fix: have it match products where either token appears in name/sku/code/brand. Example expected output for `q=hp 67`: the 6 HP 67 products listed above.

### Q4. Autocomplete `limit` cap
- Can the cap be raised from 20 → 50 (ideally with a sensible default of ~24)? Frontend grid can display more comfortably.
- If there's a reason for 20 (performance, ranking quality), explain — I'll work around it on the frontend.

### Q5. Pagination metadata on `/api/shop`
- Add `total` and/or `has_more` to the `data` object so the frontend can drive pagination / "Load more" buttons.
- Confirm the shape so we can update `shop-page.js:loadProducts()` accordingly.

### Q6. Sample data ground truth
- For the user-facing phrase **"HP 67 ink cartridges"**, list every product row (SKU, name, source) that *should* ideally come back from a well-formed query. This lets me verify whichever fix you ship.
- Same for **"Brother ic87"** — the user searched `ic87` on the frontend dropdown and got unrelated Brother LC73/LC147 results. What does the DB actually have for "ic87" or "LC87" / "IC-87" codes?

---

## Frontend context (for confirmation only — do not modify)

The frontend code paths that consume these endpoints:

- **Shop / code page**: `inkcartridges/js/shop-page.js:1540` — function `loadProducts()` hits `/api/shop` with the URL's `brand`, `category`, `code` params + `limit=200`. No client-side slicing; the renderer at `shop-page.js:2488` displays every product returned.
- **Header autocomplete**: `inkcartridges/js/search.js:74` — function `fetchAutocomplete()` hits `/api/search/autocomplete?q=<query>&limit=20`. Results render as a 6-column grid of product cards (recent commit `942cdc7`).
- **Full search results page**: currently broken. When a user presses Enter in the header search box, the frontend navigates to `/html/shop?search=<query>` — the shop page then calls `/api/shop` with a `search=` param. Need to know if that param is honored or if we should redirect to a different endpoint.

No frontend changes will be made until you respond.

---

## Response template

Please write your reply as `/Users/matcha/Desktop/FEINK/BACKEND_SEARCH_UNDERCOUNT_RESPONSE.md` using this structure:

```markdown
# Backend Search & Shop Undercount — Response

**Date:** <YYYY-MM-DD>
**From:** Claude / backend repo
**Commit / deploy ref:** <sha + deploy URL if applicable>

## Q1. `code=` filter semantics
- **Root cause:** <what the current behavior actually is and why>
- **Decision:** <exact-match by design | bug to fix | adding new `code_family=` param>
- **Fix applied:** <what you changed, or "no change — frontend should build related section">
- **New curl output:**
  ```
  $ curl ...
  <new count / shape>
  ```
- **Frontend action required:** <yes/no + what>

## Q2. `/api/search` endpoint
- **Status:** <deprecated / renamed to X / new endpoint Y>
- **Canonical endpoint for full-text search results page:** <path + params>
- **Response shape:** <paste a trimmed example>
- **Frontend action required:** <update search-results page to call new endpoint>

## Q3. Autocomplete multi-term tokenization
- **Root cause:** <tokenizer detail>
- **Fix applied:** <yes/no>
- **Test:** `curl .../autocomplete?q=hp%2067&limit=20` → count: <N>
- **Frontend action required:** <yes/no>

## Q4. Autocomplete limit cap
- **Raised to:** <new cap or "kept at 20 because Z">
- **Test:** `curl .../autocomplete?q=co&limit=48` → <ok + count>

## Q5. Pagination metadata
- **Added fields:** `total`, `has_more` (or equivalent)
- **New shape:**
  ```json
  { "data": { "products": [...], "total": 1234, "has_more": true } }
  ```
- **Frontend action required:** <yes — update shop-page.js loadProducts>

## Q6. Sample data
- **"HP 67 ink cartridges":** <list of SKUs/names>
- **"Brother ic87":** <list of SKUs/names or "no matches">

## Anything else you noticed
<e.g. related bugs you spotted while investigating>
```
