# Backend Passover

A running list of items the frontend needs from the backend. Each section is self-contained and can be tackled independently. Sections are listed newest-first; mark them resolved by adding a `**Status:** Done — <date>` line at the top of the section once shipped.

---

## Printer-detail empty state — verified, redirect on bad slug shipped

**From:** Frontend (Vieland)
**Added:** 2026-05-03
**Status:** Done — 2026-05-03 (frontend side). Backend sitemap cleanup still recommended (see below).

**Backend asked:** verify the printer-detail route's empty-state handling so retired/invalid slugs redirect to `/shop` or render a clean "printer not found" — not an empty product grid. If they're already in the sitemap, regenerate it; if there's a prerender script, drop them.

### What we found

There is **no printer-detail page or prerender script in the storefront repo** to drop:

- `inkcartridges/scripts/` only contains `stamp-versions.js` (cache-busting). The brand SSG was removed in `b56542b` (May URL consolidation); no equivalent ever existed for printers.
- `/printers/:slug` already 301-redirects to `/shop?printer=:slug` via `vercel.json`.
- `?printer=` (no `brand`/`printer_slug`) is rewritten to the backend's own `/shop` SSR per the new vercel.json rewrite block, so legacy crawler slugs hit you, not us. `?printer_slug=` stays on the SPA.

### What we changed

`shop-page.js` `loadPrinterProducts` was surfacing 404 NOT_FOUND from `GET /api/products/printer/:slug` as **"Failed to load products. Please try again."** — a network-error-style message that looked broken on retry. It also surfaced 400 VALIDATION_FAILED (slug fails your `^[a-z0-9_-]+$` regex, e.g. `acroprint-$100works` once URL-decoded) the same way.

Both paths now redirect to `/shop` cleanly:

```js
const isPrinterNotFound = (err) => /printer (?:model )?not found|NOT_FOUND/i.test(err?.message || '');
const isBadPrinterSlug = (resp) => resp?.ok === false && (resp.code === 'NOT_FOUND' || resp.code === 'VALIDATION_FAILED');
// inside loadPrinterProducts:
//   - thrown 404 in the inner try → window.location.replace('/shop')
//   - { ok:false, code:'VALIDATION_FAILED' } from API → window.location.replace('/shop')
//   - thrown 404 in the outer catch (after retry) → window.location.replace('/shop')
// Existing "No compatible products found for this printer." stays for the
// case where the slug *is* valid but has zero linked products — that's a
// real, non-broken empty state.
```

The retry on first-call failure is preserved for cold-start / 5xx, but the inner catch now short-circuits on NOT_FOUND so we don't waste 800 ms retrying a slug that will never resolve.

### What we'd like the backend to do

1. **Sitemap cleanup.** `https://www.inkcartridges.co.nz/sitemap-printers.xml` currently emits **4,479** `<url>` entries. A non-trivial fraction look like artefacts: `printer_slug=24delivers`, `30-day`, `acroprint-%24100works` (URL-encoded `$`, which then 400s your own validator), etc. Even with the redirect we just shipped, every one of these is a wasted Google crawl request that 404s through to a redirect. Regenerate from the live `printer_models` table with a join on `product_compatibility` (only emit slugs that have ≥1 compatible product) and drop anything whose slug doesn't pass the validation regex you already enforce on the API.
2. **Confirm `/api/products/printer/:slug` is the canonical endpoint** for this lookup. We're calling it from `js/api.js` `getProductsByPrinter`. There's also `/api/printers/:slug/products` (used by `loadPrinterModelProducts` strategy 1). If one of these is the preferred long-term shape, tell us and we'll consolidate.

No frontend action remaining — once the sitemap is regenerated, ping and we'll spot-check via Google Search Console.

---

## Search — thin-frontend contract (intent, recovery, ribbons-in-smart, by-brand grouped printers)

**From:** Frontend (Vieland)
**Added:** 2026-05-03
**Related doc:** `readfirst/SEARCH_AUDIT.md` in this repo (full audit + before/after).
**Frontend status:** Frontend has been refactored to be a thin caller — it deletes ~700 lines of dead/duplicate logic and uses backend-provided fields when present, with small shims for the not-yet-backend-supported pieces. Once you ship the items below, we'll delete the shims (they're tagged with `// TODO(backend-search-passover)` in the source).

### TL;DR — five tasks

1. Add `intent` field to `/api/search/suggest` and `/api/search/smart` response envelopes.
2. Always populate `did_you_mean` whenever `corrected_from` is set (no more frontend inference).
3. Add `recovery` field to `/api/search/smart` zero-result responses.
4. Include ribbons in `/api/search/smart` results when intent is ribbon-shaped (or always; see options below).
5. Add `GET /api/printers/by-brand/:brand?grouped=true&exclude_non_ink=true` so the ink-finder and printers-tab don't have to ship a 788-line printer-series taxonomy in the browser.

The current frontend works with the existing API. Each task below is independently shippable — frontend's shim for any not-yet-shipped task keeps the surface working, and reads the new field when it arrives.

---

### Task 1 — `intent` field on `/suggest` and `/smart`

**Goal:** Stop the frontend from carrying its own keyword-detection rules. Backend already has the brand/category taxonomy, so it should classify the query once and emit the result.

**Add to the `data` envelope of both `/api/search/suggest` and `/api/search/smart`:**

```jsonc
{
  "ok": true,
  "data": {
    // ... existing fields (suggestions, products, total, matched_printer, did_you_mean, ...) ...
    "intent": {
      "type":              "ribbon" | "cartridge" | "consumable" | "printer" | "label_tape" | null,
      "category":          "ink" | "toner" | "laser" | "inkjet" | "consumable" | null,
      "source":            "genuine" | "compatible" | null,
      "matched_brand_slug": "brother" | "canon" | "epson" | ... | null
    }
  }
}
```

**Detection rules (so we agree on the contract):**

- `intent.type = "ribbon"` when the query is a single token equal to `ribbon` or `ribbons` (case-insensitive). Should also fire for `typewriter ribbon`, `dot matrix ribbon`, etc. — basically any query where `ribbon` is the *kind* of thing being searched.
- `intent.category = "toner"` for `toner`/`toners`/`laser toner`/etc. `ink` for `ink`/`inks`/`inkjet`/etc.
- `intent.source = "genuine"` for queries that are exactly `genuine` (or `original`/`oem`). `compatible` for `compatible`/`generic`/`aftermarket`.
- `intent.matched_brand_slug` should be set whenever the query unambiguously starts with or contains a brand name. Used by frontend to show a "Showing only Brother results" affordance.
- `null` for everything else. Don't guess — empty intent is fine.

**Why this matters:** The frontend currently runs `SearchNormalize.detectProductType` for `intent.type`, a hand-rolled `searchQuery.toLowerCase() === 'genuine'` branch for `intent.source`, and a string-matching loop over every product in the result set for `intent.matched_brand_slug`. All three are duplicating logic the backend already runs to filter the SQL. Just emit it.

**Frontend will use it like this** (already shipped):

```js
// js/shop-page.js loadSearchResults
const intent = smartData?.intent;
const detectedType = intent?.type || (SearchNormalize?.detectProductType(searchQuery)?.keyword || null);
// ... same for source and matched_brand_slug
```

---

### Task 2 — Always populate `did_you_mean` when `corrected_from` is set

**Goal:** Remove the frontend's `_inferCorrectedTerm` heuristic, which was guessing the corrected term by counting brand frequencies in the result set. (Yes, really.)

**Current behavior we've seen:** `/api/search/smart?q=brotehr` returns `corrected_from: "brotehr"` but no `did_you_mean`. Frontend then renders "Showing similar results" without telling the user *what* it corrected to.

**Fix:** whenever the smart-search pipeline auto-applied a correction (i.e., `corrected_from` is set), the corrected term must be set as `did_you_mean`. They are two halves of the same statement: "we corrected '<corrected_from>' to '<did_you_mean>' before searching."

```jsonc
// Before
{ "corrected_from": "brotehr",  "did_you_mean": null      }

// After
{ "corrected_from": "brotehr",  "did_you_mean": "brother" }
```

**Frontend will use it like this** (already shipped — the heuristic is deleted):

```js
const correctedTo = didYouMean; // never inferred anymore
```

---

### Task 3 — `recovery` field on zero-result `/smart` responses

**Goal:** Backend tells frontend which zero-result rails to render, instead of frontend probing endpoints based on regex heuristics.

**Add to the `data` envelope of `/api/search/smart` whenever `total === 0`:**

```jsonc
{
  "ok": true,
  "data": {
    "products": [],
    "total": 0,
    // ... other fields ...
    "recovery": {
      "rails": [
        { "kind": "compat-printers", "sku": "CN-664-BK" },        // emit when query looks like a SKU AND has at least one compatible printer in the DB
        { "kind": "by-printer",       "query": "Brother MFC-J480DW", "count": 12 },  // emit when query plausibly names a printer; count is number of products that would be returned by /by-printer
        { "kind": "popular" }                                      // always emit as the safety net
      ]
    }
  }
}
```

**Rules:**

- `compat-printers` rail — emit when the backend's SKU lookup returns ≥1 compatible printer. Skip otherwise; don't make the frontend fire a request that will be empty.
- `by-printer` rail — emit when `/api/search/by-printer?q=<query>` would return ≥1 product. The `count` field lets us decide whether to render the rail at all.
- `popular` rail — always emit; static set, frontend renders it.

**Why:** Frontend currently uses `looksLikeSku()` (a regex: contains a letter, contains a digit, ≥4 chars, no spaces) to decide whether to fire the compat-printers request. Then we fire it and discover whether it returns anything. The backend already knows. Telling us upfront removes a request from the slow path of every empty-results page.

**Frontend will use it like this** (already shipped):

```js
const rails = smartData?.recovery?.rails;
if (rails) {
    // explicit list — render exactly what backend says
} else {
    // legacy: the looksLikeSku() heuristic + parallel /by-printer + /compat-printers requests
}
```

---

### Task 4 — Include ribbons in `/smart` when intent is ribbon-shaped

**Goal:** Stop the frontend from firing a second `/api/ribbons` request and merging by SKU.

**Current frontend (now-trimmed but still active until you ship):** when `SearchNormalize.detectProductType(query)` returns `{ keyword: 'ribbon', fetchRibbons: true }`, frontend fires `getProducts({ type: 'ribbon' })` AND `getRibbons()` in parallel, then dedupes by SKU and normalizes ribbon fields to match the product schema (`image_path → image_url`, `sale_price → retail_price`, etc.).

**Backend fix (two acceptable shapes):**

**Option A — preferred:** when `/api/search/smart` is called with a ribbon-intent query (or `category=ribbon` filter), include ribbons inline in `data.products`, with the same field names as cartridges. The frontend already handles the merged shape because that's what it constructs locally today.

**Option B — minimal:** add a `data.ribbons` array on the same response. Frontend will merge them client-side (we already have the code for that).

Either way, kill the separate `/api/ribbons` request from the search-results path.

**Frontend will use it like this** (will ship once you do):

```js
// option A — just trust products[] to include ribbons
const products = smartData.products;

// option B — merge by SKU
const products = mergeBySku(smartData.products, smartData.ribbons);
```

---

### Task 5 — `GET /api/printers/by-brand/:brand?grouped=true&exclude_non_ink=true`

**Goal:** Stop shipping the 788-line printer-series taxonomy (`js/printer-data.js`) to the browser. Frontend should request grouped printer data ready to render.

**Current state:** `ink-finder.js` and `account.js`'s "register a printer" flow both load printers for a brand, then group them client-side using `PrinterData.SERIES_PATTERNS` (a list of `{ prefix, name }` regex patterns per brand), filter out non-ink devices using `PrinterData.NON_INK_*` keyword/regex maps, and dedupe variant suffixes. The grouping rules are duplicated in this codebase and yours.

**Proposed endpoint:**

```
GET /api/printers/by-brand/:brand?grouped=true&exclude_non_ink=true
```

**Response:**

```jsonc
{
  "ok": true,
  "data": {
    "brand": {
      "slug": "brother",
      "name": "Brother"
    },
    "series": [
      {
        "id": "dcp-series-digital-copier",
        "name": "DCP Series (Digital Copier)",
        "models": [
          { "id": 12345, "slug": "brother-dcp-150c", "name": "DCP-150C", "full_name": "Brother DCP-150C" },
          { "id": 12346, "slug": "brother-dcp-330c", "name": "DCP-330C", "full_name": "Brother DCP-330C" },
          ...
        ]
      },
      {
        "id": "mfc-series-multi-function",
        "name": "MFC Series (Multi-Function)",
        "models": [...]
      },
      ...
    ]
  }
}
```

**Query params:**

- `brand` (path): brand slug. Required.
- `grouped` (query, default `false`): when `true`, group models into series. When `false`, return a flat `models: [...]` array (matches existing `/api/printers/search` shape, for back-compat).
- `exclude_non_ink` (query, default `false`): when `true`, omit label-makers, scanners, dot-matrix, etc. The current frontend filter list lives in `printer-data.js` `NON_INK_SERIES_KEYWORDS` / `NON_INK_MODEL_PREFIXES` / `NON_INK_MODEL_REGEX`. We're happy to email you the list, or you can use whatever taxonomy you already have.
- Cache-Control: `public, max-age=86400` is fine — printer model lists change a few times a year.

**Why:** the taxonomy in `printer-data.js` was first written when there was no API for printer models. The API now exists (`/api/printers/search?q=*&brand=…`), but it returns a flat list, so frontend keeps the grouping rules. Moving the grouping server-side means: (a) one source of truth for series patterns; (b) a smaller frontend bundle; (c) the iOS app and admin tooling get the same grouping for free.

**Frontend will use it like this** (will ship once you do):

```js
// js/ink-finder.js loadPrintersForBrand
const r = await API.getPrintersByBrandGrouped(brandSlug, { excludeNonInk: true });
return r.ok ? r.data.series : [];  // already in our render shape
```

After ship, `printer-data.js` (788 lines) deletes from the bundle.

---

### How to verify all five tasks once shipped

```bash
# Task 1 — intent on /suggest and /smart
curl -s "https://ink-backend-zaeq.onrender.com/api/search/suggest?q=ribbon&limit=5" | jq '.data.intent'
# Expect: { "type": "ribbon", "category": null, "source": null, "matched_brand_slug": null }

curl -s "https://ink-backend-zaeq.onrender.com/api/search/smart?q=brother%20toner&limit=5" | jq '.data.intent'
# Expect: { "type": null, "category": "toner", "source": null, "matched_brand_slug": "brother" }

# Task 2 — did_you_mean populated when corrected_from set
curl -s "https://ink-backend-zaeq.onrender.com/api/search/smart?q=brotehr" | jq '{corrected_from, did_you_mean}'
# Expect: { "corrected_from": "brotehr", "did_you_mean": "brother" }

# Task 3 — recovery rails on zero-result responses
curl -s "https://ink-backend-zaeq.onrender.com/api/search/smart?q=zzzzzqqqq&limit=5" | jq '.data.recovery'
# Expect: { "rails": [{ "kind": "popular" }] }   (no SKU/printer match → just popular)

curl -s "https://ink-backend-zaeq.onrender.com/api/search/smart?q=LC-3317XL-BK-FAKE&limit=5" | jq '.data.recovery'
# Expect: rails includes { "kind": "compat-printers", "sku": "..." } if SKU lookup hits

# Task 4 — ribbons in smart-search
curl -s "https://ink-backend-zaeq.onrender.com/api/search/smart?q=ribbon&limit=20" | jq '.data.products | map(select(.product_type == "ribbon")) | length'
# Expect: > 0

# Task 5 — by-brand grouped
curl -s "https://ink-backend-zaeq.onrender.com/api/printers/by-brand/brother?grouped=true&exclude_non_ink=true" | jq '.data.series | length, (.data.series[0] | {id, name, model_count: (.models | length)})'
# Expect: 5+ series, each with non-empty models[]
```

After each task ships, ping Vieland; we'll delete the matching shim and re-stamp the cache busters.

---

## Brand landing pages — wire deploy hook + add sitemap entries

**From:** Frontend (Vieland)
**Added:** 2026-05-02
**Frontend status:** Shipped in commit `91f78c1` on `main`. `inkcartridges/scripts/build-brand-pages.js` runs in Vercel's `buildCommand` and pre-renders `/brand/<slug>` for every brand returned by your `/api/landing-pages/index` endpoint, then Vercel serves them straight from the CDN. We need two things from you to make this fully production-grade.

### TL;DR — two tasks

1. **Call a Vercel deploy hook from the `refresh-brand-category-counts` cron** so brand pages auto-refresh after each daily import. Without this, the static HTML only refreshes when someone pushes a commit.
2. **Add the 27 `/brand/<slug>` URLs to `sitemap.xml`** so Google can discover and crawl the new landing pages. Without this, discovery happens slowly via internal links only.

### Background — what got built on storefront

- New script `inkcartridges/scripts/build-brand-pages.js` fetches `/api/landing-pages/index` (your MV-backed endpoint), then for each brand fetches `/api/brand-hubs/:slug`, and writes a fully-rendered `inkcartridges/brand/<slug>/index.html` per brand.
- Vercel runs the script as part of `npm run build` (chained before `stamp-versions.js`). So every deploy regenerates the brand pages with fresh data from your MV.
- Build behaviour:
  - Index endpoint failure → build **fails** (deploy aborts; previous deploy stays live).
  - Per-brand-hub failure → that brand is **skipped** with a warning; rest deploy normally.
- Internal links updated: `inkcartridges/html/brands/index.html` and `inkcartridges/js/mega-nav.js` now point at `/brand/<slug>` so users can discover the hubs.
- This supersedes Q2 in `backend-passover.md` for the **singular** `/brand/<slug>` path (the plural `/brands/:slug/:category` answer in Q2 still stands — we didn't build path-based brand-category routes).

### Task 1 — Vercel deploy hook for `refresh-brand-category-counts` cron

The full step-by-step is in `inkcartridges/scripts/README-deploy-hook.md` in the storefront repo. Short version:

**Setup (Vieland will create the hook URL and pass it to you):**

1. Vieland creates the hook in Vercel (Settings → Git → Deploy Hooks → Create Hook, name `refresh-brand-pages`, branch `main`) and gives you the resulting URL.
2. You store it in your backend env as `VERCEL_DEPLOY_HOOK_URL` (do not commit; treat it like an API key — anyone with the URL can trigger a deploy).

**Code change inside `refresh-brand-category-counts`:**

After the materialized-view refresh succeeds, fire-and-forget POST to the hook. Don't block the cron on the response — Vercel returns immediately and the build runs async on their side.

```js
// after the MV refresh succeeds
if (process.env.VERCEL_DEPLOY_HOOK_URL) {
  try {
    await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: 'POST' });
    logger.info('[refresh-brand-category-counts] Vercel deploy hook fired');
  } catch (err) {
    // Non-fatal — next push or the 03:00 fallback will catch it up.
    logger.warn('[refresh-brand-category-counts] deploy hook failed', err.message);
  }
}
```

**Cadence:** Your existing cron already runs after the 14:00 UTC import chain plus a 03:00 UTC fallback. Hooking the deploy onto the success path of the primary 14:00 run is enough; the 03:00 fallback is a safety net for the MV, not the deploy. If you also fire the hook from the fallback, we'll get a redundant deploy at 03:00 — that's harmless but unnecessary; either is fine.

**Failure mode if you skip this:** brand pages keep working but show stale data until the next git push to `main`. Not catastrophic, but defeats the purpose of a daily-refreshing landing-page system.

### Task 2 — Add brand pages to sitemap

The 27 `/brand/<slug>` URLs are not currently in `sitemap.xml` (the sitemap is rewritten to your backend per `vercel.json`). Add them so Google indexes them quickly.

**Implementation suggestion:** the same materialized view (`brand_category_counts`) that backs `/api/landing-pages/index` already has the slug list. Emit one `<url>` entry per distinct `brand_slug` where the brand has at least one active product (matches what `/api/landing-pages/index` returns):

```xml
<url>
  <loc>https://www.inkcartridges.co.nz/brand/{slug}</loc>
  <changefreq>daily</changefreq>
  <priority>0.7</priority>
  <lastmod>{date the MV was last refreshed}</lastmod>
</url>
```

`<lastmod>` should reflect when the MV last refreshed — i.e., when the brand's product/price data may have changed. If that's hard to compute per-row, using the cron's last-run timestamp for all brand entries is fine.

**Sanity check after deploy:**

```bash
curl -s https://www.inkcartridges.co.nz/sitemap.xml | grep -c '/brand/'
# should output 27 (or whatever brand count is current)
```

**Reminder for later:** when the 27 brands change (new brand added, old brand discontinued), the sitemap should reflect that automatically because it's driven by the MV. Just confirm your sitemap generator queries the MV (or the same source) and isn't a hardcoded list.

### How to verify everything is wired

1. After both tasks ship, run the cron manually (or wait for the 14:00 UTC trigger).
2. In Vercel's Deployments view, confirm a new deploy started at the cron time with commit message "Deploy Hook" or similar.
3. Once deploy is live (~1–2 min), curl one of the brand pages and confirm fresh data:
   ```bash
   curl -s https://www.inkcartridges.co.nz/brand/hp | grep -o 'Total products</div>' | head
   curl -s https://www.inkcartridges.co.nz/brand/hp | grep -B1 'Total products' | grep brand-hub-stat__value
   ```
   The number in the stats card should match the live count from `/api/brand-hubs/hp`.
4. Sitemap check: `curl -s https://www.inkcartridges.co.nz/sitemap.xml | grep '/brand/' | head` — should list all current brands.

If either fails, ping Vieland.

---

## Genuine Image Audit — verify rollout + confirm status endpoint

**From:** Frontend (Vieland)
**Added:** 2026-05-02
**Related spec:** `~/Downloads/genuine-image-audit-api.md` (the doc Vieland gave you a few days ago)
**Frontend status:** New admin surface is built and merged at `#genuine-image-audit` (file: `inkcartridges/js/admin/pages/genuine-image-audit.js`). It calls every endpoint in your spec. We need to confirm two things on the backend before the page is usable in production.

### TL;DR — two tasks

1. **Confirm the rollout steps from §"Rollout" of your spec have actually been run in prod.** Without these the page renders but every product card shows "Not checked" — so the entire surface is dead on arrival.
2. **Confirm `PUT /api/admin/image-audit/:productId/status` exists and accepts `{ status: 'checked_clean' }`.** Your spec references this endpoint in §"Recommended UI > Card footer" but does not document its request/response shape in §1–6, so we want to be sure it's actually implemented and matches what the frontend is calling.

---

### Task 1 — Verify production rollout

Walk through the four steps from §"Rollout" of `genuine-image-audit-api.md` and confirm each one is done in **production** (not just staging / local).

| # | Step | How to verify |
|---|---|---|
| 1 | Migration `049_genuine_image_vision.sql` applied | `\d products` in prod psql — confirm columns `image_vision_verdict`, `image_vision_score`, `image_vision_reasons`, `image_vision_checked_at`, `image_audit_status`, `legacy_image_url` exist. Also check `pending_product_changes` table exists if it didn't already. |
| 2 | `ANTHROPIC_API_KEY` set in Render env | Render dashboard → service → Environment. Should be a key starting with `sk-ant-`. Without this, every refetch will fail at the Vision step with an auth error. |
| 3 | `node scripts/audit-genuine-images.js --apply` has been run against prod | Run this SQL: `SELECT COUNT(*) FROM products WHERE source = 'genuine' AND pack_type = 'single' AND image_vision_checked_at IS NOT NULL;` — should be in the low thousands (matches the count of active genuine singles). If it returns 0, the script hasn't been run. Cost budget per the spec: ~$10 in Anthropic spend, ~30–60 min wall time. |
| 4 | Stats endpoint returns non-zero verdicts | `curl -H "Authorization: Bearer <super-admin-token>" "https://ink-backend-zaeq.onrender.com/api/admin/image-audit/stats?source=genuine&pack=singles_only&exclude_ribbons=true"` — `data.vision.*` should have non-zero counts. If everything is 0, step 3 wasn't run. |

If any of the four are missing, do them. **Step 3 is the most likely gap** — the migration usually ships with the deploy but the audit script has to be triggered manually.

### Task 2 — Confirm `PUT /:id/status` endpoint

The frontend's "✓ Mark verified" button calls:

```
PUT /api/admin/image-audit/:productId/status
Authorization: Bearer <super-admin-token>
Content-Type: application/json

{ "status": "checked_clean" }
```

Expected response (matches the standard backend envelope used everywhere else):

```jsonc
{
  "ok": true,
  "data": {
    "id": "uuid",
    "image_audit_status": "checked_clean"
  }
}
```

**What we need from you:**

- **If the endpoint exists** at exactly that path and accepts that body — reply "confirmed" and we're done.
- **If it exists at a different path** (e.g. you implemented it as `POST /:id/mark-status` or rolled it into `verify-with-vision`) — tell us the actual path/shape and we'll update `AdminAPI.setImageAuditStatus` in `inkcartridges/js/admin/api.js` to match.
- **If it doesn't exist yet** — please add it. Auth: `super_admin`. Accepted `status` values: `pending`, `checked_clean`, `replaced` (matches the `image_audit_status` column enum from migration 049). Should also stamp an `image_audit_status_changed_at` timestamp + `image_audit_status_changed_by_email` for audit trail if those columns exist; if they don't, just set the status.

### How to test once both tasks are done

1. Deploy / verify backend is live.
2. Log into admin as super-admin → click **Genuine Audit** in the sidebar.
3. KPI cards at the top should show non-zero values for "Verified", "Bad", "Pending review".
4. Cards in the grid should show colored verdict badges (green/amber/red), not the grey "Not checked".
5. Click ✓ on any card → toast says "<SKU> marked verified", card status pill updates to CLEAN.
6. Click ↻ on any genuine-single card → spinner ~5–15s, then either "staged for review" (success) or a reason toast (e.g. "all_candidates_rejected").
7. Open Pending Changes → the refetched product appears as a queued change.

If any of those steps fail, ping Vieland with the network tab response and we'll iterate.

---

<!-- Add new sections above this line. Keep newest-first. -->
