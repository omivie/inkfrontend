# AI search readiness — frontend wiring (May 2026)

**Backend handoff:** `ai-search-readiness-may2026.md` (commit `64618e9 feat(seo): AI search bot citation readiness`).
**Pinned by:** `tests/ai-search-readiness-may2026.test.js` (21 tests).

The backend ships rich prerender HTML (with `dateModified`, a visible
cloaking-safe `<section class="faq">`, and a `<p class="page-updated">`
footer) so ChatGPT / Perplexity / Google AI Overviews / Claude / Gemini cite
inkcartridges.co.nz as a source. This file documents the storefront-side
wiring required to make that reach the bots, why each piece exists, and how
the contract is locked.

---

## What changed in the frontend

### 1. `inkcartridges/middleware.js` — BOT_PATTERN extended

`BOT_PATTERN` gained 12 AI-search UAs (case-insensitive):

- **OpenAI**: `gptbot`, `chatgpt-user`, `oai-searchbot`
- **Perplexity**: `perplexitybot`, `perplexity-user`
- **Anthropic**: `claudebot`, `anthropic-ai`, `claude-web`
- **Google AI Overviews / Gemini**: `google-extended`
- **Apple Intelligence**: `applebot-extended`
- **Meta AI**: `meta-externalagent`
- **Amazon AI**: `amazonbot`

**Why:** The backend `robots.txt` and `botPrerender` allow these UAs and route
them to the rich prerender HTML. Vercel is the first hop on the customer
domain — if `BOT_PATTERN` doesn't recognise them here, requests fall through
to the SPA shell and the backend's prerender (and therefore the AI-citation
signals) are never reached.

**Not added** (deliberate, by handoff §FYI): `ccbot`, `bytespider`. The
backend `robots.txt` blocks both as low-value scrapers; the FE matches by
simply not routing them to the prerender. Tests pin this absence so a future
"add every AI bot" refactor can't accidentally allow them.

### 2. `inkcartridges/middleware.js` — `/shop?brand=<slug>` branch

The `/shop` branch now resolves to:

| Query                                    | Prerender route                            |
|------------------------------------------|--------------------------------------------|
| `?brand=<X>&printer_slug=<Y>` (or alias `?printer=`) | `/api/prerender/printer/<Y>` |
| `?brand=<X>` alone                       | `/api/prerender/brand/<X>`                 |
| `?printer_slug=<Y>` without brand        | _(no prerender — falls through to SPA)_    |
| bare `/shop`                             | _(no prerender — falls through to SPA)_    |

**Why the printer-and-brand pair wins:** the printer hub is the narrower,
more useful intent. A bot landing on
`/shop?brand=brother&printer_slug=mfc-j5330dw` should see "compatible
cartridges for that model", not "all 200 Brother products".

**Why bare `?printer_slug=` doesn't route:** post-May-2026 canonical URLs
ALWAYS carry both `brand` and `printer_slug`. The backend's slug_redirects
layer canonicalises legacy bare-printer_slug bookmarks to the branded form
on subsequent crawls. Gating on both keeps the prerender/canonical contract
honest.

### 3. `inkcartridges/vercel.json` — `/llms.txt` rewrite

```json
{ "source": "/llms.txt", "destination": "https://ink-backend-zaeq.onrender.com/llms.txt" }
```

**Why:** [llmstxt.org](https://llmstxt.org) defines `/llms.txt` at the root
of the customer domain. Agents look for it via the same convention as
`/robots.txt` — a same-host root-relative GET. Without the rewrite,
`https://www.inkcartridges.co.nz/llms.txt` returns 404 and agents never
discover the JSON catalog the backend exposes.

### 4. `inkcartridges/js/shop-page.js` — SPA `dateModified` parity

Both client-side CollectionPage emitters now carry `dateModified`. The new
helper `_collectionDateModified()`:

1. Walks `allProducts` / `products` / `state.products`, takes
   `MAX(Date.parse(p.updated_at))`.
2. Falls back to `new Date().toISOString()` when no product carries an
   `updated_at` (initial render before fetch, or a fully synthetic page).

Backend handoff §6 ranked this lower priority ("most AI engines read the
prerender, not the SPA DOM"). It still matters because Gemini live and Bing
live agents re-render the SPA — without `dateModified` in the DOM, those two
surfaces would disagree with the prerender and AI engines may weight neither
well.

---

## What did NOT change

### Backend already owns it (no FE action)

- `robots.txt` allow blocks for the 12 AI UAs + blocks for CCBot/Bytespider.
- `botPrerender` middleware routing on Render for the same 12 UAs.
- `/api/` rate-limit skip-regex for the 12 UAs.
- `buildProductJsonLd` / `buildCollectionPageJsonLd` `dateModified` emission.
- Visible `<section class="faq">` blocks (string-identical to FAQPage
  JSON-LD `acceptedAnswer.text` — cloaking-safe).
- `<p class="page-updated"><time datetime>` footers.
- `/llms.txt` Express route at the root (we just proxy it).
- `/api/products/by-slug/{slug}` (now a stable external agent contract —
  do not reshape without a deprecation cycle).

### Product detail page — zero client-side JSON-LD (locked elsewhere)

The marketing-audit-may2026 invariant already deletes every static
`<script type="application/ld+json">` from `html/product/index.html` and
`updateProductSchema` in `product-detail-page.js`. The backend prerender is
the single source for `Product` / `BreadcrumbList` / `FAQPage` JSON-LD.

This file re-asserts the invariant in §9 of the test so an AI-search
refactor can't accidentally undo it.

---

## What the **owner** still has to do (cannot be code)

These two items live in the Cloudflare dashboard, not the repo. **Both are
blockers** — without them the backend signals are cosmetic.

### A. Turn OFF "Block AI Scrapers and Crawlers"

Cloudflare dash → **Security → Bots → AI Audit / Bot Management** for
`inkcartridges.co.nz`. Confirm the toggle is OFF before deploy. If it stays
ON, Cloudflare strips AI bots at the edge before any of this code runs.

### B. Purge Cloudflare cache after deploying

Purge these paths so cached SPA-shell HTML doesn't keep serving for the
full s-maxage window (`age: 2711` observed on `/shop?brand=brother` during
the May-19 audit):

```
/
/shop
/brand/*
/products/*
/ink-cartridges
/toner-cartridges
/ribbons
/llms.txt
```

The Vercel middleware responses ship `Cache-Control: public, s-maxage=3600,
max-age=3600, stale-while-revalidate=86400` — so even without a purge, the
*next* crawler hit after the s-maxage window triggers a background refresh.
But the purge cuts that lag from 1h to immediate.

---

## Verification

```bash
# 1. /llms.txt now served on the customer domain
curl -sI https://www.inkcartridges.co.nz/llms.txt | head -3

# 2. Each AI bot UA reaches the rich prerender HTML
for ua in "GPTBot/1.0" "PerplexityBot/1.0" "ClaudeBot/1.0" \
          "ChatGPT-User/1.0" "OAI-SearchBot/1.0" "Perplexity-User/1.0" \
          "anthropic-ai" "Claude-Web" "Google-Extended" \
          "Applebot-Extended" "meta-externalagent" "Amazonbot"; do
  printf "%-22s " "$ua"
  curl -s -A "$ua" -o /tmp/r.html -D - "https://www.inkcartridges.co.nz/shop?brand=brother" \
    | grep -i '^x-prerendered' || echo "X-Prerendered missing — bot fell through to SPA"
done

# 3. CCBot/Bytespider are NOT routed (regression guard)
for ua in "CCBot/2.0" "Bytespider/1.0"; do
  curl -sI -A "$ua" "https://www.inkcartridges.co.nz/shop?brand=brother" \
    | grep -i 'x-prerendered' && echo "FAIL: $ua should fall through to SPA"
done

# 4. Visible FAQ + page-updated + dateModified all present
curl -s -A 'PerplexityBot/1.0' "https://www.inkcartridges.co.nz/shop?brand=brother" \
  | grep -oE '"dateModified":"[^"]+"|class="faq"|class="page-updated"' | sort -u

# 5. Schema validity — paste the brand-hub URL into:
#    https://validator.schema.org
#    https://search.google.com/test/rich-results
#    Confirm FAQPage rich result still validates AFTER visible HTML is added.
#    (This is the cloaking-safety check — Google drops the FAQ rich result
#    if the visible Q/A doesn't match acceptedAnswer.text byte-for-byte.)
```

Steps 1-4 are scripted and rerun-safe; step 5 is a one-time post-deploy check.

---

## Lagging metric

Re-query in ChatGPT, Perplexity, and Google with AI Overviews 3-4 weeks
post-deploy:

- "best compatible Brother LC73 ink NZ"
- "what ink does Canon PIXMA TS3360 use"
- "compatible vs genuine ink cartridges NZ"
- "cheapest HP 65XL black NZ"

Log whether `inkcartridges.co.nz` appears as a cited source. Check monthly.

---

## Files touched

| File                                                | Change                                                          |
|-----------------------------------------------------|-----------------------------------------------------------------|
| `inkcartridges/middleware.js`                       | BOT_PATTERN +12 AI UAs; /shop branch gains brand prerender wiring |
| `inkcartridges/vercel.json`                         | new `/llms.txt` rewrite                                         |
| `inkcartridges/js/shop-page.js`                     | CollectionPage JSON-LD gains `dateModified` via new `_collectionDateModified()` helper |
| `tests/ai-search-readiness-may2026.test.js`         | 21-test contract pin                                            |
| `readfirst/ai-search-readiness-may2026.md`          | this document                                                   |
