# Make compatibility ("FOR USE IN") text searchable — search misses machines a product lists as compatible

**To:** backend dev (Render repo, `https://ink-backend-zaeq.onrender.com`)
**From:** frontend (Vercel SPA)
**Date:** 2026-07-16 · **Re:** `/api/search/smart` does not index product compatibility data
**Status:** 🟢 **CLOSED — backend shipped, FE shipped 2026-07-16.** See the resolution block directly below; the original brief follows for the record.

---

## ✅ RESOLUTION (2026-07-16) — done on both sides

**Backend** (their `compat-search-backend-response-jul2026.md`): `/api/search/smart` now injects
compatibility matches as a **zero-strong-match fallback** — when a model-shaped query finds no strong
name/SKU hit, it `ILIKE`s `compatible_devices_html` (raw + alphanumeric-collapsed, so `VP-6000` /
`vp 6000` also hit) and returns those rows at `relevance_score:25`, `match_tier:3` (below all direct
tiers). Each carries `match_reason:"compatibility"` + `matched_token:"<query>"`. The structured
`compatible_printers[]` path was already folded into `search_vector` at weight D, so `AP830`/`AP8100`
already worked — the real gap was only the free-text blob where `VP6000` lived.

Verified live: `GET /api/search/smart?q=VP6000` → `307.11`, `C141LOT`, `C143LOT`.

**Frontend** (this repo, 2026-07-16 — logged as ERR-083):

1. **Robustness — compat matches can never be reconciled away.** Our results-page reconciliation
   (`shop-page.js` `loadSearchResults`) swaps a thin `/smart` set for the literal `/api/products` +
   `/suggest` union on digit queries (`softMiss`) or autocorrected queries (`hijack`). `VP6000` is
   digit-shaped and its compat rows don't literally match name/SKU, so left unguarded they'd be
   swapped for a name/SKU-only union that can't contain them. New pure helper
   `hasCompatibilityMatch(products)` now gates **both** `softMiss` and `hijack` — a compat set is a
   deliberate backend hit, not a miss. (This also answers your §5a check: confirmed compat matches
   survive reconciliation for `VP6000`/`AP830`, and a direct query still ranks direct matches first.)
2. **"Fits &lt;model&gt;" badge.** `createProductCard` renders a teal
   `product-card__badge--compat-match` chip (mirroring the existing `_fitsPrinter` "Fits Your Printer"
   chip) for any row with `match_reason:"compatibility"` — text `Fits VP6000`, tooltip
   `Compatible with VP6000`. `matched_token` escaped (`escapeHtml` text / `escapeAttr` title). **Your
   optional nice-to-have is now live UI.**

Pinned by `tests/compat-search-badge-jul2026.test.js` (10 tests); full suite green (2307 pass).
Nothing further owed on either side.

---

Shared vars used in the repro commands below:

```bash
API=https://ink-backend-zaeq.onrender.com
```

---

## TL;DR

A customer searching **`VP6000`** gets **"No results"**, even though the **Canon AP800 Compatible
Typewriter Ribbon (SKU `307.11`)** explicitly lists **VP6000** in its "FOR USE IN:" block. VP6000 is
a typewriter that takes that ribbon — the customer told us exactly what machine they own and we
returned nothing. That's a lost sale on a high-intent query.

**The ask:** index each product's **compatibility text** (the machines it's "for use in") into the
search matcher, primarily **`/api/search/smart`**. Rank compatibility-only matches **below** direct
name/SKU/code matches so relevance isn't diluted.

This is 100% backend. See §5 for why the frontend can't and shouldn't be patched.

---

## 1. Repro

```bash
# Today: zero results for a machine that IS listed on a product's compatibility block
curl -s "$API/api/search/smart?q=VP6000&limit=40" | jq '.data.products | length'
# → 0

# Expected after fix: ≥1, including SKU 307.11 (Canon AP800 Compatible Typewriter Ribbon)
curl -s "$API/api/search/smart?q=VP6000&limit=40" \
  | jq '.data.products[] | {sku, name}'
# → should include { "sku": "307.11", "name": "Canon AP800 Compatible Typewriter Ribbon" }
```

For context, `307.11`'s compatibility block reads (verbatim from the PDP):

> **FOR USE IN:** Canon AP740 / AP780 / AP800 / AP800III / AP810 / AP810III / AP830 / AP830III /
> AP850 / ;AP850III / AP8000 AP8100 / AP8300 / AP8500 / **VP6000** typewriters

Every one of those model tokens (AP740, AP780, …, **VP6000**) should be a hit for this product.
Today none of them are — searching `AP830` or `AP8100` also returns nothing, for the same reason.

---

## 2. Root cause: compatibility text is never indexed

Search currently matches on **name + SKU (+ series/codes)** only. The compatibility list lives in
separate fields that the search matcher doesn't read:

- **`products.compatible_devices_html`** — an admin-authored **free-text HTML blob**. This is the
  **primary** source for **typewriter / printer ribbons**, and it is where `VP6000` physically sits
  for `307.11`. Example content: `"Canon AP740 / AP780 / AP800 / … / VP6000 typewriters"`.
- **Structured `compatible_printers[]`** (`model_name`, `full_name`) and
  **`compatible_printers_grouped[]`** (`{ brand, printers[] }`) — used mainly for **ink/toner** (and
  some ribbons), sourced from the `product_compatibility` → `printer_models` join.

These are display-only on our side. Neither is part of any search index today, so a query that
appears **only** in a compatibility list matches nothing.

---

## 3. What to index (scope: ALL compatibility fields)

Please index **both** shapes, so every product with a compatibility list becomes searchable in one
pass — not just this one ribbon:

1. **`compatible_devices_html`** (free-text; ribbons)
   - **Strip HTML tags first** — it's a prose/HTML blob, not clean tokens.
   - **Tokenise** on whitespace **and** separators (`/`, `,`, `;`, `-`). The real data is messy:
     note the stray `;AP850III` and the missing slash in `AP8000 AP8100` in the example above — a
     naive "split on ` / `" will merge or drop tokens. Split on any run of non-alphanumeric chars.
   - Drop noise words (`typewriters`, `printers`, the brand if you like) — optional; indexing them
     is harmless.

2. **Structured `compatible_printers[]` / `compatible_printers_grouped[]`** (ink/toner + some ribbons)
   - Index `model_name` and `full_name` per entry.

You own the schema — confirm whether these are columns, generated columns, or joins on your side and
index accordingly. On the FE they only ever appear as response fields.

**Suggestion:** a denormalised, tag-stripped `compat_search_text` column (or a tsvector / search
doc) built from both sources, refreshed on product write, is likely the cleanest index target and
avoids parsing HTML at query time.

---

## 4. Matching + ranking requirements

**Matching**
- Case-insensitive.
- Tokenised so `VP6000`, `vp 6000`, and `VP-6000` all hit the same product (mirror however you
  already normalise `name`/`sku`).
- Consistent with the substring/token behaviour of the current name/SKU matcher — don't make compat
  matching *stricter* than name matching or it'll feel inconsistent.

**Ranking (confirmed decision):** a compatibility-only hit must rank **below** any product that
matches on `name` / `sku` / `series_codes`. Suggested tiers:

1. SKU / code exact match
2. Name match
3. **Compatibility match** ← new, lowest

This keeps a broad machine family (e.g. someone searching a common model) from burying exact product
matches.

**Optional nice-to-have (not required):** return a per-result reason, e.g.
`match_reason: "compatibility"` (and ideally the matched token, `"VP6000"`), so the FE can later
label results *"Compatible with VP6000."* We won't block on this and won't build UI for it yet — but
if it's cheap to emit, it future-proofs a nice UX touch.

---

## 5. Frontend status — nothing to change, and here's why it can't be fixed on our side

Confirmed by tracing the search code paths:

- Both search surfaces send the **raw query** to your endpoints. Dropdown typeahead →
  `GET /api/search/smart?q=…&limit=40` (`inkcartridges/js/search.js:143`). Full results page →
  `GET /api/search/smart?q=…&limit=100&page=N&include=compat,description`
  (`inkcartridges/js/shop-page.js:2718` → `api.js:1853`). Fallbacks are `/api/search/suggest` and
  `/api/products?search=` — also your text-match endpoints.
- The FE can only **narrow / reorder / union** what your endpoints return — it can **never widen**
  matching. Every client-side matcher (`productMatchesQuery` `shop-page.js:29`, `queryCodeMatch`
  `shop-page.js:117`, `mergeLiteralResults` `shop-page.js:45`) reads **only** `name`, `sku`, and
  `series_codes`. None inspect compatibility data, and there's no code path that re-scans the
  catalogue. So a compat-only match is unreachable client-side by construction.

Fixing `/api/search/smart` fixes **both** the dropdown and the results page at once (both call it).

### 5a. One FE heads-up to verify after you ship (likely fine as-is)

Our results page has a reconciliation layer that, for **digit-bearing** queries, can treat a small
`/smart` result set as a "soft miss" and try to swap in literal `/api/products?search=` results
(`shop-page.js:2790-2848`). `VP6000` has digits, so this path *will* trigger. **But** it only swaps
when the literal fallback **out-counts** `/smart` — and since `/api/products?search=VP6000` returns
0 rows (VP6000 isn't in any name/sku), the swap is declined and your `/smart` compat results stand.

So we expect it to Just Work. Still, please ping us when this ships so we can confirm end-to-end that
compat matches survive reconciliation for a few queries (`VP6000`, `AP830`, plus a common ink-model
term). If they don't, it's a tiny FE tweak on our side (trust `/smart`'s ordering when a result set
has no literal match) — but we don't want to make that change speculatively before your side exists.

---

## 6. Acceptance checks

- [ ] `curl "$API/api/search/smart?q=VP6000&limit=40"` returns `307.11` among `.data.products`.
- [ ] `q=AP830`, `q=AP8100` (other tokens in the same block) also return `307.11`.
- [ ] A direct query — `q=307.11`, `q=AP800`, `q=<a real ink SKU>` — still ranks the **exact**
      product **first** (compat matches did not reorder direct hits above them).
- [ ] A broad/common model term doesn't bury exact SKU matches (ranking tiers in §4 hold).
- [ ] Ink/toner example: a printer model that appears only in a cartridge's `compatible_printers`
      now returns that cartridge.
- [ ] Dropdown typeahead for `VP6000` shows the ribbon (same endpoint, so this should follow for
      free).

---

## 7. Summary

| | |
|---|---|
| **Problem** | Compatibility text (machines a product is "for use in") isn't indexed; searching a compatible machine returns nothing. |
| **Where the data is** | `products.compatible_devices_html` (free-text; ribbons) + structured `compatible_printers[]` / `_grouped[]` (ink/toner). |
| **Fix owner** | **Backend only.** FE can't reach compat data by design. |
| **Change** | Index both compat sources into `/api/search/smart` (and ideally `/suggest`, `/api/products?search=`); rank compat matches below name/SKU/code. |
| **FE work** | None to ship. One post-deploy verification (§5a); tiny tweak only if compat matches get dropped by reconciliation. |
