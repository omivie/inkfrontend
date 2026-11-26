# SEO Phase 2, P1 (FE-1 … FE-4b): one-file bundle

Everything for P1 in one file: where the patches come from, how to get them out of this file, the full handoff
(`fe-handoff-preview.md`), the cover message (`fe-handoff-message.md`), `SHA256SUMS`, and all six patches.

**Source:** the backend repo `github.com/jackon-jn/ink_backend`, branch `main`, commit `06a9d19`, folder
`docs/seo/phase2-nov2026/`. On the owner's Mac that is
`~/Desktop/Projects.nosync/ink_backend/docs/seo/phase2-nov2026/`.

**About `90798b4a`:** it is a **frontend** (`inkfrontend`) commit: the tip you get after applying the six patches to
frontend `main` at `064879a5`. It is not in the backend repo, and you will not find it anywhere until the patches are
applied. Commit SHAs change with `git am` (new committer and date). The tree SHA does not:
`4ef169c76c334ed680e1bb37079bef07e8e919cc` means you have exactly the tested code.

## 0. Get the patches out of this file

Run this in the folder that holds this file. It writes `fe-patches/0001…0006-*.patch` and `fe-patches/SHA256SUMS`
byte for byte, then checks them:

```bash
mkdir -p fe-patches && awk '/^~~~~(diff|text) file=/{f=substr($0, index($0,"=")+1); next} /^~~~~$/{f=""; next} f{print > ("fe-patches/" f)}' fe-p1-bundle.md
(cd fe-patches && shasum -a 256 -c SHA256SUMS)   # all 6 must say OK
```

Then follow §2 of the handoff below (the `fe-patches/` paths there match).

---

<!-- ===== fe-handoff-preview.md (verbatim) ===== -->

# Frontend SEO Phase 2: patches for a Vercel Preview

**For:** frontend developer, `omivie/inkfrontend`. **Status:** DRAFT. Not yet sent; the owner approves before it goes out.
**Prepared:** 2026-11-24. Nothing has been pushed, deployed or merged.
**Scope: Vercel Preview only.** Do not merge to `main` or promote to production. Production and each release
stage in §6 need the owner's separate approval. When the Preview is done, send back what §8 lists.

## 1. What you are getting

Six `git format-patch` files that take the frontend from `main` at **064879a5** to a tested tip at **90798b4a**.
They change what every visitor and crawler gets in the **initial HTML** (head, H1, 404 status, JSON-LD), and they
make visible listing content match what Googlebot already sees. There are no backend changes and no new dependencies.

| # | File | Commit (on 064879a5) | What it does | Files |
|---|---|---|---|---|
| 0001 | `0001-feat-seo-FE-1-correct-head-H1-in-the-initial-HTML-fo.patch` | dcf8abbbc6c9f64434bac28831f7a93b7bc00fdf | FE-1: `middleware.js` puts the correct title, meta description, canonical and H1 (from the API prerender) into the initial HTML for **every** user agent, not only bots | middleware.js + tests |
| 0002 | `0002-feat-seo-FE-2-real-404-noindex-for-nonexistent-print.patch` | 2ad75965abff5a2211e8b84257e8a042b854b77c | FE-2: an unknown printer or product URL returns **404 + `X-Robots-Tag: noindex`**. Today it returns the shell with 200 (a soft 404) | middleware.js + tests |
| 0003 | `0003-feat-seo-FE-3-visible-content-parity-on-listing-page.patch` | 17ca19c7bdebbe784799913483c63ada2c4cac2a | FE-3: category and brand pages show visitors the intro, product list and FAQ that the bot HTML already carries | shop.html, seo-meta.js, pages.css + tests |
| 0004 | `0004-feat-seo-FE-4-prerender-JSON-LD-in-the-initial-HTML-.patch` | 1c98c994e1e9201845df26722d554b68dbb88d5b | FE-4: Product / BreadcrumbList / FAQPage JSON-LD in the initial HTML for all user agents | middleware.js + tests |
| 0005 | `0005-fix-seo-FE-4b-home-FAQPage-JSON-LD-mirrors-the-visib.patch` | d643c0e6fd3dbb4016c5a8d6095bb56deb943940 | FE-4b: the home FAQPage JSON-LD is rewritten to match the **visible** home FAQ word for word. **The visible FAQ text does not change.** | index.html, html/index.html + parity test |
| 0006 | `0006-feat-seo-FE-3b-visible-content-parity-on-ribbons.patch` | 90798b4a1a0371598e4d120b746961f55e1963e6 | FE-3b: the same content parity for `/ribbons` | ribbons.html, seo-meta.js + tests |

Total: 18 files, +1,401 / −115. SHA-256 for each file is in `fe-patches/SHA256SUMS`.

About 0005: live home today has FAQPage JSON-LD answers that are not on the visible page. One of them is a
dispatch claim ("Auckland metro orders placed before 12pm … dispatched the same day") that is still waiting for
approval. 0005 removes those answers and mirrors the five visible Q&As. It adds no new claim.

## 2. Apply (on a preview branch, never on `main`)

```bash
git fetch origin && git checkout -b seo-phase2-preview 064879a50945cae357f682570629e19a3287c1cc
(cd fe-patches && shasum -a 256 -c SHA256SUMS)          # all 6 must say OK
git am --3way fe-patches/000[1-6]-*.patch                # applies in order 0001..0006
git rev-parse HEAD^{tree}                                # must be 4ef169c76c334ed680e1bb37079bef07e8e919cc (commit SHAs will differ; the tree must not)
node --test tests/*.test.js                              # expect: fail 0
git push -u origin seo-phase2-preview                    # Vercel builds a Preview deployment
```
If `origin/main` has moved past 064879a5, rebase the branch after `git am` and rerun the tests. Report any conflict
instead of resolving it in `middleware.js` by hand.

## 3. Checks already run (local, not on Vercel)

Tested commit **90798b4a**. Local harness: static files plus `middleware.js` at 127.0.0.1:4173, reading the live
API prerender. Playwright: Googlebot raw (G), Chrome raw (V0), Chrome rendered 1366×900 (V1), iPhone rendered
390×844 (M1), against live www (before).

- `node --test tests/*.test.js`: **7,468 tests, 7,445 pass, 0 fail, 23 skipped**. The base 064879a5 has 7,409 / 7,386 / 0 / 23, so the skips predate this work.
- `git am` of all six onto 064879a5 reproduces 90798b4a exactly (0-line diff).
- Render diff over 14 URLs: **88 PASS**, 1 KNOWN, 3 expected FAIL (§4). Full table: `render-verify-report.md`.
- The FAQ parity test (`tests/home-faq-parity-nov2026.test.js`) fails 0/2 without 0005 and passes 2/2 with it.
- Not-found URLs: the only response of 400 or above is the document itself (404, `noindex`, `X-Head-Inject: not-found`). No asset or API request fails.
- Prices: printer `hp-1000cxi` and product `GCART069HKBK` show the database retail price ($172.49 / $328.79; $288.79).
  The edge-cached category prerender showed 48/48 JSON-LD prices equal to the database.

**Not tested** (needs a real Vercel Preview): Vercel edge runtime behaviour, real TTFB, and Vercel response headers.

## 4. Expected differences (do not treat these as regressions)

| Page | What you will see | Why |
|---|---|---|
| Home `/` | Head is injected but H1 is not (`X-Head-Inject: ok-partial-no-h1`) | By design. The static home H1 is already correct. |
| Printer `/shop?brand=hp&printer_slug=hp-1000cxi` | Rendered words ≈ 84% of the bot HTML (392 vs 465) | Same as live today (392). Not changed by these patches. |
| Printer page price count | Bot HTML 3 prices, rendered page 6 | Rendered page also shows the quantity-tier prices ("2+ price $169.04 ea · down to $158.69"). Same as live. |
| Not-found printer/product | DevTools console: "Failed to load resource: … 404" | This is the document's own 404 status. Expected. |
| Unknown brand `/shop?brand=zzbrand` | Still 200, indexable, `X-Head-Inject: miss-status-404` | Unchanged from live. Handled by FE-2b later (§7). |

## 5. Preview checklist

Replace `$P` with the preview URL. Run every row for both user agents: Googlebot
(`Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`) and a normal Chrome UA. Also do a
rendered pass on desktop and on mobile (390 px wide).

| URL | Status | Title / canonical / H1 (raw HTML, both UAs, must match each other) | Other |
|---|---|---|---|
| `$P/ink-cartridges` | 200 | "Ink Cartridges NZ \| InkCartridges.co.nz" / `/ink-cartridges` / "Ink Cartridges NZ — Genuine & …" | `X-Head-Inject: ok`; rendered ≈2,000 words and 60 prices on desktop and mobile |
| `$P/ribbons` | 200 | as bot HTML | rendered words within 15% of the bot HTML |
| `$P/shop?brand=brother` | 200 | bot H1 "Brother NZ — …" also in the Chrome raw HTML | canonical is the brand URL, not `/shop` |
| `$P/shop?brand=hp&printer_slug=hp-1000cxi` | 200 | as bot HTML | see §4 |
| `$P/products/canon-genuine-cart069hkbk-toner-cartridge-cart069hk-black/GCART069HKBK` | 200 | product title, self canonical | one Product JSON-LD in the raw HTML; price = API `retail_price` |
| `$P/shop?brand=hp&printer_slug=zz-not-a-printer` | **404** | — | `X-Robots-Tag: noindex`, `X-Head-Inject: not-found` |
| `$P/products/zz-nope/ZZNOPE999` | **404** | — | same as above |
| `$P/` | 200 | unchanged | see the 0005 check below |

### Patch 0005 check (home page, both UAs, raw HTML and rendered)
1. The visible FAQ text is the same as on live www today. 0005 must not change it.
2. The FAQPage JSON-LD has **exactly 5** `Question` entries. Their names and answers are byte-identical to the five
   visible Q&As:
   - genuine vs compatible;
   - finding the right cartridge;
   - delivery time;
   - returns policy;
   - consumer rights.
3. The JSON-LD has **0** matches for "Auckland metro", "same day" and "dispatched the same day". The 0005 diff also
   removes "How fast is delivery?", "What if my cartridge doesn't work?", "Do you have a minimum order?" and
   "Are compatible ink cartridges as good as genuine?".
4. There is exactly one FAQPage block, and the Rich Results Test on `$P/` reports no FAQ errors.

For every page: at most one canonical, no duplicated top-level JSON-LD type, no horizontal scroll at 390 px,
no new console errors besides the 404 above, and cart, search and checkout still work. Example:
`curl -sI -A Googlebot "$P/products/zz-nope/ZZNOPE999" | grep -iE '^(HTTP|x-robots|x-head)'`.

### Price refresh test (Preview only; production caches stay untouched)
The middleware reads the prerender from `https://api.inkcartridges.co.nz` (Cloudflare-cached,
`s-maxage=86400`). It falls back to the plain shell after 1.5 s. Prices change at the daily import (14:00 UTC).
1. Before 14:00 UTC: note `retail_price` from `https://api.inkcartridges.co.nz/api/products/GCART069HKBK`, the
   JSON-LD price in `$P/products/…/GCART069HKBK`, and the `cf-cache-status` and `age` headers of
   `https://api.inkcartridges.co.nz/api/prerender/product/GCART069HKBK`.
2. After about 15:30 UTC: repeat. Pass = the JSON-LD price equals the API price, and `age` is less than the
   time since the import.
3. If `age` is larger, the import did not purge the edge. Stop and report it. Do **not** purge it yourself.

## 6. Staged release (each stage needs the owner's go-ahead)

Ship in three stages **at least 48 h apart**. Never deploy between 13:55 and 15:30 UTC: the daily import purges
caches then, so measurements are noisy and cold-cache misses look like regressions.

| Stage | Patches | Watch especially |
|---|---|---|
| A | 0001–0002 (head/H1, real 404) | `X-Head-Inject` miss rate, TTFB, valid URLs wrongly 404 |
| B (+48 h) | 0003–0004 (listing content, JSON-LD) | layout on mobile, duplicate JSON-LD, Rich Results Test |
| C (+48 h) | 0005–0006 (home FAQ JSON-LD, /ribbons) | FAQ parity on home, /ribbons content |

**Before each stage:** Preview checklist green; tests 0 fail; Vercel shows the previous production deployment
(note its ID for rollback); not inside 13:55–15:30 UTC.
**After each stage (at 1 h, 24 h, 48 h):** rerun the §5 curl rows on www; Search Console URL Inspection
(live test) on one category, one product and one not-found URL; check the Vercel logs for 5xx and middleware errors.

**Rollback triggers (any one):**
- 5xx or middleware errors above the pre-release baseline;
- a URL that exists returns 404, or any page has `noindex` that should not;
- canonical points to `/shop` or to another page on any listing or product URL;
- `X-Head-Inject: miss-*` on more than 5% of listing/product requests;
- p75 TTFB up by more than 300 ms;
- cart, search or checkout broken;
- a JSON-LD price that differs from the visible price.

**Rollback:**
1. Vercel → Deployments → previous production deployment → **Instant Rollback** (seconds; no rebuild).
2. Then on `main`: `git revert --no-edit <newest sha> … <oldest sha>` for that stage's commits (newest first),
   run the tests and push, so the next deploy does not bring the change back.
3. Tell the owner which trigger fired, with the URL and response headers.

## 7. Not in this stack

- **FE-2b (unknown brand → 404 + noindex).** Separate work, separate approval. Acceptance:
  - `/shop?brand=zz-not-a-brand` → **404**, `X-Robots-Tag: noindex`, for Googlebot and Chrome.
  - `/shop?brand=okin` → **200, indexable, products listed**. The Okin brand row is `is_active = false` but has
    19 active products. "Brand inactive" must **not** mean 404. Decide "unknown" by whether the brand resolves to
    any active product, not by the `is_active` flag.
  - `/shop?brand=brother` and `/shop?brand=canon&category=toner` are unchanged.
- **FE-5 (one HTML for every user agent; retire UA-based routing).** Later. It depends on stages A–C being stable.
- Home FAQ **copy** changes (dispatch time, returns window, refund timing, compatible guarantee) are owner
  decisions. This stack does not change visible copy.

## 8. What to send back

1. The Preview URL and the exact commit SHA it was built from. Also the tree SHA (`git rev-parse HEAD^{tree}`):
   it must be `4ef169c76c334ed680e1bb37079bef07e8e919cc`, or explain why it differs, for example after a rebase.
2. The `node --test` summary line.
3. The §5 table, one PASS/FAIL per row per UA, with the curl headers for the two 404 rows.
4. **Visitor vs Googlebot:** for each §5 URL, show that the raw-HTML title, canonical, H1 and JSON-LD types match
   between the two UAs. List any difference.
5. **Price refresh after cache revalidation:** both readings from the §5 price test (API price, JSON-LD price,
   `cf-cache-status`, `age`), with UTC times.
6. **Real 404s:** both not-found URLs return status 404 with `X-Robots-Tag: noindex`, for both UAs. Also give the
   status of one valid printer URL and one valid product URL, to show that neither of them returns 404.
7. The 0005 check results above.
8. Any conflict, failed check or unexpected console error, with the URL.

---

<!-- ===== fe-handoff-message.md (verbatim) ===== -->

# Cover message (fe-handoff-message.md)

Subject: SEO Phase 2 – six frontend patches for a Vercel Preview (Preview only)

Hi,

Attached are six frontend SEO patches for a **Vercel Preview only**. Please do not merge to `main` or deploy to
production. Production, and each of the three release stages, will need my separate approval.

**Attachments**
- `fe-handoff-preview.md`: apply steps, checks, expected differences, release plan
- `0001`–`0006` `*.patch` (`git format-patch`)
- `SHA256SUMS` (run `shasum -a 256 -c SHA256SUMS` first; all six must say OK)

**Base and tip**
- Expected base: `064879a5` (064879a50945cae357f682570629e19a3287c1cc) on `inkfrontend` main
- Tested tip: `90798b4a` (90798b4a1a0371598e4d120b746961f55e1963e6); tree `4ef169c76c334ed680e1bb37079bef07e8e919cc`
- Apply them on a new branch from the base with `git am --3way`, then push that branch so Vercel builds a Preview.
  If `main` has moved, rebase and tell me about any conflict rather than resolving it by hand in `middleware.js`.

**Please verify on the Preview** (details are in §5 and §8 of the doc):
1. **Price refresh after cache revalidation:** take a reading before 14:00 UTC and another after about 15:30 UTC.
   The JSON-LD price must equal the API price, and the edge `age` must be newer than the import. Do not purge any cache.
2. **Real 404s:** the two not-found URLs return 404 with `X-Robots-Tag: noindex`, for both Googlebot and Chrome.
   Valid printer and product URLs still return 200.
3. **Visitor vs Googlebot output:** title, canonical, H1 and JSON-LD types in the raw HTML match for both user agents
   on every checklist URL.
4. **Patch 0005 (home page):**
   - the visible FAQ is unchanged;
   - the FAQPage JSON-LD has exactly the five visible questions, word for word;
   - the JSON-LD no longer contains the same-day dispatch claim ("Auckland metro … dispatched the same day").

**Please send back**
- the Preview URL;
- the exact commit SHA (and tree SHA) you tested;
- the test summary;
- PASS/FAIL for each checklist row, with the headers for the 404 rows;
- anything that failed.

**Not in this release:**
- FE-2b (unknown brand → 404) and FE-5 (one HTML for all user agents);
- any change to the visible homepage FAQ text.

Thanks.

---

# SHA256SUMS

~~~~text file=SHA256SUMS
a4c99ef3f8ab6783f59156c6add7608daa57e5737208e4eb1d2a5f666f80b3a1  0001-feat-seo-FE-1-correct-head-H1-in-the-initial-HTML-fo.patch
867fbb81ed5b422d5565ed1f3528b0e22cc862194d90c39b5ac95efe49f6d5b0  0002-feat-seo-FE-2-real-404-noindex-for-nonexistent-print.patch
01e7f15f72be49a0d5c985d7708e928306d5f7e01845cccf2ffcf4a09fa41326  0003-feat-seo-FE-3-visible-content-parity-on-listing-page.patch
3850815fb9f8156e584304f80672a989f14dcf70cfad408586aac0ef697669d8  0004-feat-seo-FE-4-prerender-JSON-LD-in-the-initial-HTML-.patch
e90192433810fcd0b1b0cacffab8959eeab536eeca4bf71e13fb23a2b527018f  0005-fix-seo-FE-4b-home-FAQPage-JSON-LD-mirrors-the-visib.patch
f4192cc6e75b6851a58b5ca12b27099e1fc31837d6e2e16fcdd6d271794f7eaa  0006-feat-seo-FE-3b-visible-content-parity-on-ribbons.patch
~~~~

# The six patches

## 0001-feat-seo-FE-1-correct-head-H1-in-the-initial-HTML-fo.patch

~~~~diff file=0001-feat-seo-FE-1-correct-head-H1-in-the-initial-HTML-fo.patch
From dcf8abbbc6c9f64434bac28831f7a93b7bc00fdf Mon Sep 17 00:00:00 2001
From: SEO prep <seo-prep@localhost>
Date: Tue, 24 Nov 2026 17:25:11 +1300
Subject: [PATCH 1/6] feat(seo): FE-1 correct head + H1 in the initial HTML for
 ALL user agents

Humans and uncatalogued crawlers got the static shell (generic title, /shop
canonical, generic H1) until JS ran. For a non-bot GET on a prerender-routed
URL the middleware now fetches the shell (loop-guard header x-ic-shell) and the
cached prerender (api.inkcartridges.co.nz, 1500 ms, redirect manual) in
parallel and writes title, description, canonical (one only), robots and H1
into the shell. Fail-open and loud: X-Head-Inject: ok | ok-partial-* | miss-*.

Routing table moved verbatim into pure routePrerender(); bot behaviour is
byte-identical. Pins that asserted "humans never fetch" now assert "humans
never touch the Render origin".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 inkcartridges/middleware.js               | 315 ++++++++++++++++++----
 tests/chip-prerender-sep2026.test.js      |   4 +-
 tests/conversion-fixes-sep2026.test.js    |   7 +-
 tests/middleware-slug-hop-oct2026.test.js |   4 +-
 tests/receipt-rolls-oct2026.test.js       |   4 +-
 tests/seo-initial-html-nov2026.test.js    | 256 ++++++++++++++++++
 tests/turnaround-fixes-sep2026.test.js    |   5 +-
 7 files changed, 526 insertions(+), 69 deletions(-)
 create mode 100644 tests/seo-initial-html-nov2026.test.js

diff --git a/inkcartridges/middleware.js b/inkcartridges/middleware.js
index c719d2f2..0720fb0e 100644
--- a/inkcartridges/middleware.js
+++ b/inkcartridges/middleware.js
@@ -12,6 +12,19 @@ const PRERENDER_RETRY_AFTER_S = 120;
 // no wait unless it is the slower of the two; past this it is skipped.
 const SLUG_HOP_TIMEOUT_MS = 2500;
 
+// FE-1 (Nov 2026) — humans and non-listed crawlers get the SAME head + H1 in the
+// initial HTML that a bot gets from the prerender. The prerender is read from the
+// Cloudflare-cached API host (measured HIT, 55-75 ms), not the Render origin the
+// bot path uses (200-800 ms): a human must not wait on a cold origin, and past
+// the budget below the page is simply the untouched shell (fail-open, loudly: see
+// X-Head-Inject).
+const HEAD_PRERENDER_HOST = 'https://api.inkcartridges.co.nz';
+const HEAD_PRERENDER_TIMEOUT_MS = 1500;
+const SHELL_FETCH_TIMEOUT_MS = 5000;
+// Request header on the middleware's own shell fetch; the middleware returns at
+// once when it sees it, so the fetch reaches the static file (no recursion).
+const SHELL_GUARD_HEADER = 'x-ic-shell';
+
 // `adsbot-google` and `storebot-google` are intentionally listed even though
 // `googlebot` is already present — the AdsBot ("AdsBot-Google", "AdsBot-Google-
 // Mobile") and StoreBot ("Storebot-Google") user-agents do NOT contain the
@@ -85,68 +98,117 @@ const CATEGORY_ALIASES = {
  */
 const NON_WEB_PATH = /^\/(?:sql|scripts)\/|^\/(?:serve\.json|vercel\.json|middleware\.js)$/;
 
-export default async function middleware(request) {
-  const url = new URL(request.url);
-  const path = url.pathname;
+// <head-inject> — PURE string helpers; no I/O, no imports. tests/seo-initial-html-nov2026.test.js
+// slices this block out of the source and evaluates it, so keep it self-contained.
+// Values are copied through VERBATIM: the prerender already emits escaped HTML
+// (`&amp;`), so nothing here escapes or unescapes (no double-escaping).
+const RE_TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
+const RE_H1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
+const RE_CANONICAL_G = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/gi;
+const RE_CONTENT_ATTR = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
+const RE_HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
+const metaTagRe = (name, flags = 'i') => new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*>`, flags);
 
-  // Deny non-web files FIRST — before the admin gate, the category normaliser
-  // and the bot prerender. Nothing below can be reached from these paths (the
-  // matcher entries are disjoint), and putting the check anywhere else would
-  // make that a matter of reading 200 lines carefully rather than one.
-  if (NON_WEB_PATH.test(path)) {
-    return new Response('Not Found', {
-      status: 404,
-      headers: {
-        'Content-Type': 'text/plain; charset=utf-8',
-        'Cache-Control': 'public, max-age=0, must-revalidate',
-        'X-Content-Type-Options': 'nosniff',
-        'X-Robots-Tag': 'noindex, nofollow',
-      },
-    });
-  }
+function attrValue(tag, re) {
+  const m = re.exec(tag || '');
+  if (!m) return null;
+  const v = m[1] !== undefined ? m[1] : m[2];
+  return v === undefined || v === '' ? null : v;
+}
 
-  // Gate admin routes — redirect to login if no auth cookie
-  if (path === '/admin' || path.startsWith('/admin/')) {
-    const cookie = request.headers.get('cookie') || '';
-    if (!/__ink_auth=1/.test(cookie)) {
-      const loginUrl = new URL('/account/login', request.url);
-      loginUrl.searchParams.set('redirect', path + url.search);
-      return Response.redirect(loginUrl.toString(), 302);
-    }
-  }
+/** Replace (or add) one attribute on a single tag string. Function replacers: a `$&` in a value is literal. */
+function setTagAttr(tag, attr, value) {
+  const safe = value.replace(/"/g, '&quot;');
+  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i');
+  if (re.test(tag)) return tag.replace(re, () => `${attr}="${safe}"`);
+  return tag.replace(/\s*\/?>$/, (end) => ` ${attr}="${safe}"${end}`);
+}
 
-  // /shop ?category 301 normalization — ALL user agents, before the bot gate
-  // (IA reorg, Jul 2026). Mirrors the backend's redirect rules exactly:
-  // canonical slugs pass through, ribbons→ribbon / ink-cartridges→ink are
-  // aliased, everything else (consumable, cartridge, unknowns) is stripped.
-  // vercel.json redirects cannot strip a single query param (untouched params
-  // pass through, which would loop), so the edge middleware is the only FE
-  // layer that can express this. Loop-safe: redirects only when the
-  // normalized value differs from the raw one, and the target always carries
-  // a canonical-or-absent category.
-  if (path === '/shop' && url.searchParams.has('category')) {
-    const raw = url.searchParams.get('category');
-    let next;
-    if (CATEGORY_CANONICAL.has(raw)) next = raw;
-    else if (CATEGORY_ALIASES[raw]) next = CATEGORY_ALIASES[raw];
-    else next = null;
-    if (next !== raw) {
-      url.searchParams.delete('category'); // also collapses duplicated params
-      // A bare receipt alias goes straight to the roll landing, the category's
-      // canonical since the backend set its landingPath (reply 2026-10-25 §3):
-      // one hop, not alias -> /shop?category=receipt -> /receipt-rolls.
-      if (next === 'receipt' && [...url.searchParams.keys()].length === 0) {
-        url.pathname = '/receipt-rolls';
-        return Response.redirect(url.toString(), 301);
-      }
-      if (next) url.searchParams.set('category', next);
-      return Response.redirect(url.toString(), 301);
-    }
+/**
+ * Pull title, description, canonical, robots and the first H1's TEXT out of a
+ * prerender page. Every value is raw escaped HTML text or null.
+ */
+function extractPrerenderHead(html) {
+  const out = { title: null, description: null, canonical: null, robots: null, h1: null };
+  if (typeof html !== 'string' || !html) return out;
+  const t = RE_TITLE.exec(html);
+  if (t) out.title = t[1].trim() || null;
+  const d = metaTagRe('description').exec(html);
+  if (d) out.description = attrValue(d[0], RE_CONTENT_ATTR);
+  const r = metaTagRe('robots').exec(html);
+  if (r) out.robots = attrValue(r[0], RE_CONTENT_ATTR);
+  const c = new RegExp(RE_CANONICAL_G.source, 'i').exec(html);
+  if (c) out.canonical = attrValue(c[0], RE_HREF_ATTR);
+  const h = RE_H1.exec(html);
+  if (h) out.h1 = h[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null;
+  return out;
+}
+
+/**
+ * Write a prerender head into a static shell. Head fields apply to the part of
+ * the shell BEFORE </head>; the H1 to the part after it. The shell's own tag is
+ * edited in place (ids and other attributes survive: js/seo-meta.js and
+ * shop-page.js look the elements up by id/selector); a duplicate canonical is
+ * removed so exactly ONE remains.
+ * @returns {{html: string, applied: string[], missing: string[]}} `missing`
+ *   names every field the prerender lacked or the shell had no slot for.
+ */
+function injectHead(shell, head) {
+  const lower = shell.toLowerCase();
+  const cut = lower.indexOf('</head>');
+  if (cut < 0) return { html: shell, applied: [], missing: ['shell-head'] };
+  let headHtml = shell.slice(0, cut);
+  let body = shell.slice(cut);
+  const applied = [];
+  const missing = [];
+
+  if (head.title && RE_TITLE.test(headHtml)) {
+    headHtml = headHtml.replace(RE_TITLE, (m) => m.replace(/(<title\b[^>]*>)[\s\S]*?(<\/title>)/i, (_x, a, b) => `${a}${head.title}${b}`));
+    applied.push('title');
+  } else if (head.title) {
+    headHtml += `<title>${head.title}</title>\n`;
+    applied.push('title');
+  } else missing.push('title');
+
+  if (head.description) {
+    const re = metaTagRe('description');
+    if (re.test(headHtml)) headHtml = headHtml.replace(re, (m) => setTagAttr(m, 'content', head.description));
+    else headHtml += `<meta name="description" content="${head.description.replace(/"/g, '&quot;')}">\n`;
+    applied.push('description');
+  } else missing.push('description');
+
+  if (head.canonical) {
+    let seen = 0;
+    headHtml = headHtml.replace(RE_CANONICAL_G, (m) => (seen++ === 0 ? setTagAttr(m, 'href', head.canonical) : ''));
+    if (seen === 0) headHtml += `<link rel="canonical" href="${head.canonical.replace(/"/g, '&quot;')}">\n`;
+    applied.push('canonical');
+  } else missing.push('canonical');
+
+  // robots is optional: no prerender robots ⇒ the shell's own stands (not a miss).
+  if (head.robots) {
+    const re = metaTagRe('robots');
+    if (re.test(headHtml)) headHtml = headHtml.replace(re, (m) => setTagAttr(m, 'content', head.robots));
+    else headHtml += `<meta name="robots" content="${head.robots.replace(/"/g, '&quot;')}">\n`;
+    applied.push('robots');
   }
 
-  const ua = request.headers.get('user-agent') || '';
-  if (!BOT_PATTERN.test(ua)) return;
+  if (head.h1 && RE_H1.test(body)) {
+    body = body.replace(/(<h1\b[^>]*>)[\s\S]*?(<\/h1>)/i, (_m, a, b) => `${a}${head.h1}${b}`);
+    applied.push('h1');
+  } else missing.push('h1');
+
+  return { html: headHtml + body, applied, missing };
+}
+// </head-inject>
 
+/**
+ * Which backend prerender serves this URL, if any? PURE (no I/O): the routing table
+ * that used to sit inline in middleware(), moved verbatim so the human head-inject
+ * path and the bot path share ONE computation.
+ * @returns {{prerenderPath: string|null, slugHopFor: {path:string, sku:string}|null}}
+ */
+function routePrerender(url) {
+  const path = url.pathname;
   let prerenderPath = null;
   let slugHopFor = null;
 
@@ -310,6 +372,85 @@ export default async function middleware(request) {
     }
   }
 
+  // (literal kept: source-order pins in ai-search-readiness / seo-meta-rewrite slice up to it)
+  if (!prerenderPath) return { prerenderPath: null, slugHopFor: null };
+  return { prerenderPath, slugHopFor };
+}
+
+export default async function middleware(request) {
+  const url = new URL(request.url);
+  const path = url.pathname;
+
+  // Deny non-web files FIRST — before the admin gate, the category normaliser
+  // and the bot prerender. Nothing below can be reached from these paths (the
+  // matcher entries are disjoint), and putting the check anywhere else would
+  // make that a matter of reading 200 lines carefully rather than one.
+  if (NON_WEB_PATH.test(path)) {
+    return new Response('Not Found', {
+      status: 404,
+      headers: {
+        'Content-Type': 'text/plain; charset=utf-8',
+        'Cache-Control': 'public, max-age=0, must-revalidate',
+        'X-Content-Type-Options': 'nosniff',
+        'X-Robots-Tag': 'noindex, nofollow',
+      },
+    });
+  }
+
+  // Gate admin routes — redirect to login if no auth cookie
+  if (path === '/admin' || path.startsWith('/admin/')) {
+    const cookie = request.headers.get('cookie') || '';
+    if (!/__ink_auth=1/.test(cookie)) {
+      const loginUrl = new URL('/account/login', request.url);
+      loginUrl.searchParams.set('redirect', path + url.search);
+      return Response.redirect(loginUrl.toString(), 302);
+    }
+  }
+
+  // /shop ?category 301 normalization — ALL user agents, before the bot gate
+  // (IA reorg, Jul 2026). Mirrors the backend's redirect rules exactly:
+  // canonical slugs pass through, ribbons→ribbon / ink-cartridges→ink are
+  // aliased, everything else (consumable, cartridge, unknowns) is stripped.
+  // vercel.json redirects cannot strip a single query param (untouched params
+  // pass through, which would loop), so the edge middleware is the only FE
+  // layer that can express this. Loop-safe: redirects only when the
+  // normalized value differs from the raw one, and the target always carries
+  // a canonical-or-absent category.
+  if (path === '/shop' && url.searchParams.has('category')) {
+    const raw = url.searchParams.get('category');
+    let next;
+    if (CATEGORY_CANONICAL.has(raw)) next = raw;
+    else if (CATEGORY_ALIASES[raw]) next = CATEGORY_ALIASES[raw];
+    else next = null;
+    if (next !== raw) {
+      url.searchParams.delete('category'); // also collapses duplicated params
+      // A bare receipt alias goes straight to the roll landing, the category's
+      // canonical since the backend set its landingPath (reply 2026-10-25 §3):
+      // one hop, not alias -> /shop?category=receipt -> /receipt-rolls.
+      if (next === 'receipt' && [...url.searchParams.keys()].length === 0) {
+        url.pathname = '/receipt-rolls';
+        return Response.redirect(url.toString(), 301);
+      }
+      if (next) url.searchParams.set('category', next);
+      return Response.redirect(url.toString(), 301);
+    }
+  }
+
+  // Loop guard for the human head-inject self-fetch (FE-1): the shell request
+  // carries this header and must reach the static file untouched. Placed AFTER
+  // the denylist, admin gate and ?category normaliser so none of them can be skipped.
+  if (request.headers.get('x-ic-shell')) return;
+
+  const ua = request.headers.get('user-agent') || '';
+  const { prerenderPath, slugHopFor } = routePrerender(url);
+
+  // Everyone who is not a listed bot (humans, uncatalogued crawlers) gets the
+  // static shell with the prerender's head + H1 written in (FE-1).
+  if (!BOT_PATTERN.test(ua)) {
+    if (!prerenderPath || (request.method || 'GET') !== 'GET') return;
+    return injectedShell(url, prerenderPath);
+  }
+
   if (!prerenderPath) return;
 
   // Started before the prerender and awaited after it: see slugHop().
@@ -394,6 +535,68 @@ export default async function middleware(request) {
   }
 }
 
+/**
+ * FE-1 — the static shell with the prerender's <title>, description, canonical,
+ * robots and H1 written into the initial HTML. Both fetches run in parallel.
+ *
+ * FAIL-OPEN, LOUDLY: any error, timeout, non-200 or parse miss serves the shell
+ * exactly as today and says why in `X-Head-Inject: miss-<reason>`; success is
+ * `ok`, or `ok-partial-<fields>` when the prerender/shell lacked a field. If even
+ * the shell fetch fails we return undefined and the platform serves the file.
+ * Shell headers are copied (static asset, no per-user data); length/encoding are
+ * dropped because the body is re-built.
+ */
+async function injectedShell(url, prerenderPath) {
+  const shellP = fetch(url.toString(), {
+    headers: { [SHELL_GUARD_HEADER]: '1', 'Accept': 'text/html' },
+    redirect: 'manual',
+    signal: AbortSignal.timeout(SHELL_FETCH_TIMEOUT_MS),
+  });
+  const preP = fetch(`${HEAD_PRERENDER_HOST}${prerenderPath}`, {
+    headers: { 'Accept': 'text/html' },
+    redirect: 'manual',
+    signal: AbortSignal.timeout(HEAD_PRERENDER_TIMEOUT_MS),
+  });
+  const [shellRes, preRes] = await Promise.allSettled([shellP, preP]);
+  if (shellRes.status !== 'fulfilled' || shellRes.value.status !== 200) return;
+  const shell = shellRes.value;
+  const shellHtml = await shell.text();
+
+  let reason = 'ok';
+  let html = shellHtml;
+  if (preRes.status !== 'fulfilled') {
+    reason = preRes.reason && preRes.reason.name === 'TimeoutError' ? 'miss-timeout' : 'miss-fetch-error';
+  } else if (preRes.value.status !== 200) {
+    reason = `miss-status-${preRes.value.status}`;
+  } else {
+    try {
+      const head = extractPrerenderHead(await preRes.value.text());
+      // Home: the hero H1 is styled markup (a highlight span); swapping it for the
+      // prerender's plain text would visibly change the hero. Head fields only.
+      if (url.pathname === '/') head.h1 = null;
+      if (!head.title || !head.canonical) reason = 'miss-parse';
+      else {
+        const r = injectHead(shellHtml, head);
+        if (r.applied.length === 0) reason = 'miss-no-slot';
+        else {
+          html = r.html;
+          if (r.missing.length) reason = `ok-partial-no-${r.missing.join('-')}`;
+        }
+      }
+    } catch {
+      reason = 'miss-exception';
+    }
+  }
+
+  const headers = new Headers(shell.headers);
+  headers.delete('content-length');
+  headers.delete('content-encoding');
+  headers.delete('transfer-encoding');
+  if (!headers.get('content-type')) headers.set('Content-Type', 'text/html; charset=utf-8');
+  headers.set('X-Head-Inject', reason);
+  return new Response(html, { status: 200, headers });
+}
+
 /**
  * ERR-365 — does this /products/<slug>/<SKU> address have a newer one?
  * (backend response 2026-10-17, "Pack names" ask 2.) The backend's
diff --git a/tests/chip-prerender-sep2026.test.js b/tests/chip-prerender-sep2026.test.js
index 1969523c..b8a89b44 100644
--- a/tests/chip-prerender-sep2026.test.js
+++ b/tests/chip-prerender-sep2026.test.js
@@ -152,10 +152,10 @@ test('§1 ONLY code+category are forwarded — tracking params must not fragment
         `${BACKEND}/api/prerender/brand/brother?code=LC73`);
 });
 
-test('§1 a non-bot gets no prerender fetch at all', async () => {
+test('§1 a non-bot never reaches the Render origin (FE-1: it reads the cached API host for the head)', async () => {
     assert.equal(
         await prerenderFetchFor(`${SITE}/shop?brand=brother&code=LC73`, { ua: 'Mozilla/5.0 (Macintosh)' }),
-        null);
+        'https://api.inkcartridges.co.nz/api/prerender/brand/brother?code=LC73');
 });
 
 test('§1 printer hub still wins over brand and forwards nothing', async () => {
diff --git a/tests/conversion-fixes-sep2026.test.js b/tests/conversion-fixes-sep2026.test.js
index 8e6d17f1..0d6b5ef5 100644
--- a/tests/conversion-fixes-sep2026.test.js
+++ b/tests/conversion-fixes-sep2026.test.js
@@ -117,10 +117,9 @@ test('§1 /shop with any param does NOT get the whole-shop prerender', async ()
     }
 });
 
-test('§1 humans never reach the prerender (control)', async () => {
-    const { res, calls } = await run(`${SITE}/shop`, html200(), HUMAN);
-    assert.equal(res, undefined);
-    assert.equal(calls.length, 0);
+test('§1 humans never reach the Render prerender origin (control; FE-1 reads the cached API host)', async () => {
+    const { calls } = await run(`${SITE}/shop`, html200(), HUMAN);
+    assert.ok(calls.every((c) => !c.target.startsWith('https://ink-backend-sg.onrender.com')), 'no Render origin call');
 });
 
 // ─────────────────────────────────────────────────────────────────────────────
diff --git a/tests/middleware-slug-hop-oct2026.test.js b/tests/middleware-slug-hop-oct2026.test.js
index 66a9a2de..2c3092f3 100644
--- a/tests/middleware-slug-hop-oct2026.test.js
+++ b/tests/middleware-slug-hop-oct2026.test.js
@@ -89,8 +89,8 @@ test('a 301 to ANOTHER SKU, to itself, to a foreign host, or a non-301 is never
 
 test('shoppers never pay for the lookup (bots only)', async () => {
     const { res, seen } = await run(OLD, () => redirect(`https://www.inkcartridges.co.nz${NEW}`), HUMAN);
-    assert.equal(res, undefined, 'falls through to the SPA');
-    assert.deepEqual(seen, []);
+    assert.notEqual(res && res.status, 301, 'no slug redirect for a shopper');
+    assert.ok(seen.every((u) => !u.startsWith(BACKEND)), 'no Render origin call (FE-1 reads the cached API host)');
 });
 
 test('only /products/<slug>/<SKU> asks; /p/<sku> and /html/product do not', async () => {
diff --git a/tests/receipt-rolls-oct2026.test.js b/tests/receipt-rolls-oct2026.test.js
index a7dc6263..e1a2130e 100644
--- a/tests/receipt-rolls-oct2026.test.js
+++ b/tests/receipt-rolls-oct2026.test.js
@@ -171,7 +171,7 @@ async function run(url, ua) {
 /** What a SHOPPER's document request gets: 'pass' (200 from the SPA) or the 301 target. */
 async function edgeFor(search) {
     const { res } = await run(`${SITE}/shop${search}`, HUMAN);
-    if (!res) return 'pass';
+    if (!res || res.status === 200) return 'pass';
     assert.equal(res.status, 301, `unexpected status for ${search}`);
     return res.headers.get('location');
 }
@@ -214,7 +214,7 @@ test('§1 the okin arm does not capture narrower shapes, and other brands are un
         `${BACKEND}/api/prerender/brand/okin?code=X&category=receipt`);
     assert.equal((await run(`${SITE}/shop?brand=brother&category=toner`, GOOGLEBOT)).fetched,
         `${BACKEND}/api/prerender/brand/brother?category=toner`);
-    assert.equal((await run(`${SITE}/receipt-rolls`, HUMAN)).fetched, null, 'humans get the SPA');
+    assert.ok(!String((await run(`${SITE}/receipt-rolls`, HUMAN)).fetched).startsWith(BACKEND), 'humans never hit the Render origin');
 });
 
 test('§1 /receipt-rolls is routed: middleware matcher + vercel rewrite to the shop SPA', async () => {
diff --git a/tests/seo-initial-html-nov2026.test.js b/tests/seo-initial-html-nov2026.test.js
new file mode 100644
index 00000000..8fbe3dc8
--- /dev/null
+++ b/tests/seo-initial-html-nov2026.test.js
@@ -0,0 +1,256 @@
+/**
+ * FE-1 / FE-2 (Nov 2026) — the initial HTML every user agent receives.
+ *
+ * FE-1: a NON-bot GET on a prerender-routed URL gets the static shell with the
+ * prerender's <title>, description, canonical, robots and H1 written in. Both
+ * fetches are stubbed here; the shell is the REAL file from disk. Bots are
+ * pinned to behave exactly as before (same Render URL, same headers).
+ *
+ * Run: node --test tests/seo-initial-html-nov2026.test.js
+ */
+'use strict';
+
+const test = require('node:test');
+const assert = require('node:assert/strict');
+const fs = require('node:fs');
+const os = require('node:os');
+const path = require('node:path');
+
+const ROOT = path.join(__dirname, '..', 'inkcartridges');
+const SRC = fs.readFileSync(path.join(ROOT, 'middleware.js'), 'utf8');
+const SHOP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'shop.html'), 'utf8');
+const PDP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'product', 'index.html'), 'utf8');
+const SITE = 'https://www.inkcartridges.co.nz';
+const API = 'https://api.inkcartridges.co.nz';
+const RENDER = 'https://ink-backend-sg.onrender.com';
+const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
+const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
+
+// ── loaders ──────────────────────────────────────────────────────────────────
+let tmp = null;
+let mw = null;
+async function middleware() {
+    if (mw) return mw;
+    tmp = path.join(os.tmpdir(), `ic-mw-headinject-${process.pid}-${Date.now()}.mjs`);
+    fs.writeFileSync(tmp, SRC);
+    mw = (await import(`file://${tmp}`)).default;
+    return mw;
+}
+test.after(() => { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); });
+
+// The pure helpers sit between two markers and import nothing: evaluate just that block.
+const block = SRC.slice(SRC.indexOf('// <head-inject>'), SRC.indexOf('// </head-inject>'));
+const { extractPrerenderHead, injectHead } = new Function(`${block}\nreturn { extractPrerenderHead, injectHead };`)();
+
+const prerenderPage = ({ title, description, canonical, h1, robots = 'index, follow, max-image-preview:large' }) =>
+    `<!DOCTYPE html><html><head><title>${title}</title>`
+    + (description ? `<meta name="description" content="${description}">` : '')
+    + (canonical ? `<link rel="canonical" href="${canonical}">` : '')
+    + (robots ? `<meta name="robots" content="${robots}">` : '')
+    + `</head><body>${h1 ? `<h1>${h1}</h1>` : ''}<p>body</p></body></html>`;
+
+// ── unit: extractor / injector ───────────────────────────────────────────────
+test('extract: entity-escaped values come through verbatim (no unescape)', () => {
+    const h = extractPrerenderHead(prerenderPage({
+        title: 'Canon &amp; HP Ink | InkCartridges.co.nz', description: 'Save &quot;now&quot; $5 &amp; more',
+        canonical: `${SITE}/shop?brand=hp&amp;code=1`, h1: 'Ink <em>NZ</em> &mdash; Genuine &amp; Compatible',
+    }));
+    assert.equal(h.title, 'Canon &amp; HP Ink | InkCartridges.co.nz');
+    assert.equal(h.description, 'Save &quot;now&quot; $5 &amp; more');
+    assert.equal(h.canonical, `${SITE}/shop?brand=hp&amp;code=1`);
+    assert.equal(h.h1, 'Ink NZ &mdash; Genuine &amp; Compatible', 'tags stripped from the h1, entities kept');
+    assert.equal(h.robots, 'index, follow, max-image-preview:large');
+});
+
+test('extract: missing parts are null, garbage in is safe', () => {
+    assert.deepEqual(extractPrerenderHead(prerenderPage({ title: 'T', canonical: 'https://x/', robots: '' })),
+        { title: 'T', description: null, canonical: 'https://x/', robots: null, h1: null });
+    for (const bad of [null, undefined, '', 42]) assert.equal(extractPrerenderHead(bad).title, null);
+});
+
+const HEAD = { title: 'A &amp; B | Shop', description: 'Costs $1 &amp; $&', canonical: 'https://www.inkcartridges.co.nz/x', robots: null, h1: 'H &amp; 1' };
+
+test('inject: shell title/description/canonical/h1 are replaced in place, escapes not doubled, `$` literal', () => {
+    const r = injectHead(SHOP_SHELL, HEAD);
+    assert.deepEqual(r.missing, []);
+    assert.match(r.html, /<title>A &amp; B \| Shop<\/title>/);
+    assert.ok(r.html.includes('<meta id="meta-description" name="description" content="Costs $1 &amp; $&">'), 'id kept, value verbatim');
+    assert.equal((r.html.match(/rel="canonical"/g) || []).length, 1);
+    assert.match(r.html, /<link id="canonical-url" rel="canonical" href="https:\/\/www\.inkcartridges\.co\.nz\/x">/);
+    assert.match(r.html, /<h1 class="drilldown-title" id="drilldown-title">H &amp; 1<\/h1>/);
+    assert.ok(!r.html.includes('&amp;amp;'));
+    assert.ok(!r.html.includes('Shop Ink Cartridges & Toner NZ | InkCartridges'), 'old title gone');
+});
+
+test('inject: PDP shell (empty canonical href, skeleton h1, title id) is filled', () => {
+    const r = injectHead(PDP_SHELL, HEAD);
+    assert.deepEqual(r.missing, []);
+    assert.match(r.html, /<title id="page-title">A &amp; B \| Shop<\/title>/);
+    assert.match(r.html, /<link rel="canonical" id="canonical-url" href="https:\/\/www\.inkcartridges\.co\.nz\/x">/);
+    assert.match(r.html, /id="product-title">H &amp; 1<\/h1>/);
+});
+
+test('inject: a DUPLICATE canonical in the shell collapses to exactly one', () => {
+    const shell = '<html><head><title>t</title><link rel="canonical" href="a"><link rel="canonical" href="b"></head><body><h1>x</h1></body></html>';
+    const r = injectHead(shell, HEAD);
+    assert.equal((r.html.match(/rel="canonical"/g) || []).length, 1);
+    assert.ok(r.html.includes('href="https://www.inkcartridges.co.nz/x"') && !r.html.includes('href="b"'));
+});
+
+test('inject: no shell canonical/description slot ⇒ one is ADDED; no h1 in prerender ⇒ reported missing, shell h1 kept', () => {
+    const shell = '<html><head><title>t</title></head><body><h1>keep me</h1></body></html>';
+    const r = injectHead(shell, { ...HEAD, h1: null });
+    assert.equal((r.html.match(/rel="canonical"/g) || []).length, 1);
+    assert.match(r.html, /<meta name="description" content="Costs \$1 &amp; \$&">/);
+    assert.deepEqual(r.missing, ['h1']);
+    assert.match(r.html, /<h1>keep me<\/h1>/);
+});
+
+test('inject: robots from the prerender replaces the shell robots; absent ⇒ shell robots untouched', () => {
+    assert.match(injectHead(PDP_SHELL, { ...HEAD, robots: 'noindex' }).html, /<meta name="robots" content="noindex">/);
+    assert.match(injectHead(PDP_SHELL, HEAD).html, /name="robots" content="index, follow, max-image-preview:large"/);
+});
+
+test('inject: a shell with no </head> is reported, not mangled', () => {
+    const r = injectHead('<html><body>x</body></html>', HEAD);
+    assert.equal(r.html, '<html><body>x</body></html>');
+    assert.deepEqual(r.missing, ['shell-head']);
+});
+
+// ── integration: the middleware with fetch stubbed ───────────────────────────
+const req = (p, ua = HUMAN, extra = {}) => ({
+    url: `${SITE}${p}`,
+    method: 'GET',
+    headers: { get: (n) => { const k = String(n).toLowerCase(); return k === 'user-agent' ? ua : (extra[k] ?? null); } },
+});
+
+/**
+ * `prerender(url)` plays api.inkcartridges.co.nz / the Render origin; the www host
+ * plays the deployment and serves the real shell files, requiring the loop guard.
+ */
+async function run(p, { ua = HUMAN, prerender } = {}) {
+    const m = await middleware();
+    const calls = [];
+    const original = globalThis.fetch;
+    globalThis.fetch = async (target, init = {}) => {
+        const u = String(target);
+        calls.push({ url: u, init });
+        if (u.startsWith(SITE)) {
+            assert.equal(init.headers['x-ic-shell'], '1', 'self-fetch must carry the loop guard');
+            const pdp = /^\/(products|product|p)\//.test(new URL(u).pathname) || /html\/product/.test(u);
+            return new Response(pdp ? PDP_SHELL : SHOP_SHELL, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', 'Content-Length': '1', 'Content-Encoding': 'br' } });
+        }
+        return prerender(u, init);
+    };
+    try { return { res: await m(req(p, ua)), calls }; } finally { globalThis.fetch = original; }
+}
+const ok = (o) => () => new Response(prerenderPage(o), { status: 200, headers: { 'Content-Type': 'text/html' } });
+
+const CASES = [
+    ['/ink-cartridges', { title: 'Ink Cartridges NZ | InkCartridges.co.nz', description: 'Ink &amp; more', canonical: `${SITE}/ink-cartridges`, h1: 'Ink Cartridges NZ — Genuine &amp; Compatible' }, '/api/prerender/category/ink'],
+    ['/shop?brand=brother', { title: 'Brother Ink &amp; Toner NZ', description: 'Brother', canonical: `${SITE}/shop?brand=brother`, h1: 'Brother Ink &amp; Toner NZ' }, '/api/prerender/brand/brother'],
+    ['/shop?brand=canon&code=PG645', { title: 'Canon PG645 Ink NZ', description: 'PG645 desc', canonical: `${SITE}/shop?brand=canon&amp;code=PG645`, h1: 'Canon PG645 Ink Cartridges' }, '/api/prerender/brand/canon?code=PG645'],
+    ['/shop?brand=hp&printer_slug=hp-officejet-pro-9010', { title: 'HP OfficeJet Pro 9010 Ink NZ', description: 'HP 9010', canonical: `${SITE}/shop?brand=hp&amp;printer_slug=hp-officejet-pro-9010`, h1: 'HP OfficeJet Pro 9010 Ink' }, '/api/prerender/printer/hp/hp-officejet-pro-9010'],
+    ['/products/some-slug/SKU1', { title: 'SKU1 Ink | InkCartridges.co.nz', description: 'SKU1 desc', canonical: `${SITE}/products/some-slug/SKU1`, h1: 'SKU1 Compatible Cartridge' }, '/api/prerender/product/SKU1'],
+];
+
+for (const [p, page, want] of CASES) {
+    test(`human ${p}: head + h1 injected from the cached API host; exactly one canonical`, async () => {
+        const { res, calls } = await run(p, { prerender: ok(page) });
+        assert.equal(res.status, 200);
+        assert.equal(res.headers.get('x-head-inject'), 'ok');
+        const html = await res.text();
+        assert.ok(html.includes(`<title>${page.title}</title>`) || html.includes(`>${page.title}</title>`), 'title');
+        assert.ok(html.includes(`content="${page.description}"`), 'description');
+        assert.ok(html.includes(`href="${page.canonical}"`), 'canonical');
+        assert.equal((html.match(/rel="canonical"/g) || []).length, 1, 'one canonical');
+        assert.ok(html.includes(`>${page.h1}</h1>`), 'h1');
+        assert.ok(calls.some((c) => c.url === `${API}${want}`), `fetched ${API}${want}`);
+        assert.ok(calls.every((c) => !c.url.startsWith(RENDER)), 'never the Render origin');
+        const pre = calls.find((c) => c.url.startsWith(API));
+        assert.equal(pre.init.redirect, 'manual');
+        assert.ok(pre.init.signal, 'timeout signal');
+        assert.equal(res.headers.get('content-length'), null);
+        assert.equal(res.headers.get('content-encoding'), null);
+        assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
+    });
+}
+
+test('human: prerender timeout / 500 / 404 / garbage ⇒ the untouched shell + a miss header', async () => {
+    const shell = (p) => (/^\/products/.test(p) ? PDP_SHELL : SHOP_SHELL);
+    const cases = [
+        ['timeout', () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'miss-timeout'],
+        ['network', () => { throw new Error('boom'); }, 'miss-fetch-error'],
+        ['500', () => new Response('x', { status: 500 }), 'miss-status-500'],
+        ['404', () => new Response('x', { status: 404 }), 'miss-status-404'],
+        ['301', () => new Response(null, { status: 301, headers: { Location: '/x' } }), 'miss-status-301'],
+        ['garbage', () => new Response('<html>no head</html>', { status: 200 }), 'miss-parse'],
+    ];
+    for (const p of ['/ink-cartridges', '/products/x/SKU1']) {
+        for (const [name, prerender, header] of cases) {
+            const { res } = await run(p, { prerender });
+            assert.equal(res.status, 200, `${p} ${name}`);
+            assert.equal(res.headers.get('x-head-inject'), header, `${p} ${name}`);
+            assert.equal(await res.text(), shell(p), `${p} ${name}: shell byte-identical`);
+        }
+    }
+});
+
+test('human: unrouted paths and non-GET fall through exactly as before (undefined, no fetch)', async () => {
+    for (const p of ['/shop?brand=hp&category=ink&q=zz', '/products', '/shop?q=abc']) {
+        const { res, calls } = await run(p, { prerender: ok(CASES[0][1]) });
+        if (res === undefined) assert.equal(calls.length, 0, p);
+    }
+    const m = await middleware();
+    assert.equal(await m({ ...req('/ink-cartridges'), method: 'POST' }), undefined);
+});
+
+test('loop guard: a request carrying x-ic-shell returns undefined immediately, never fetches', async () => {
+    const m = await middleware();
+    const original = globalThis.fetch;
+    let n = 0;
+    globalThis.fetch = async () => { n++; return new Response('x'); };
+    try {
+        assert.equal(await m(req('/ink-cartridges', HUMAN, { 'x-ic-shell': '1' })), undefined);
+        assert.equal(await m(req('/ink-cartridges', GOOGLEBOT, { 'x-ic-shell': '1' })), undefined);
+    } finally { globalThis.fetch = original; }
+    assert.equal(n, 0);
+});
+
+test('guard does not open the denylist or the admin gate', async () => {
+    const m = await middleware();
+    assert.equal((await m(req('/sql/x.sql', HUMAN, { 'x-ic-shell': '1' }))).status, 404);
+    assert.equal((await m(req('/admin/x', HUMAN, { 'x-ic-shell': '1' }))).status, 302);
+    assert.equal((await m(req('/shop?category=junk', HUMAN, { 'x-ic-shell': '1' }))).status, 301);
+});
+
+test('bot on a valid page: unchanged — Render origin, same headers, prerender body, no shell fetch', async () => {
+    const { res, calls } = await run('/shop?brand=canon&code=PG645', { ua: GOOGLEBOT, prerender: ok(CASES[2][1]) });
+    assert.equal(calls.length, 1);
+    assert.equal(calls[0].url, `${RENDER}/api/prerender/brand/canon?code=PG645`);
+    assert.equal(calls[0].init.headers['User-Agent'], GOOGLEBOT);
+    assert.equal(res.status, 200);
+    assert.equal(res.headers.get('x-prerendered'), 'true');
+    assert.equal(res.headers.get('x-head-inject'), null);
+    assert.equal(res.headers.get('cache-control'), 'public, s-maxage=3600, max-age=3600, stale-while-revalidate=86400');
+    assert.match(await res.text(), /Canon PG645 Ink Cartridges/);
+});
+
+test('client parity: seo-meta.js reconcile() only SETS the prerender values (idempotent over the injected ones)', () => {
+    const seo = fs.readFileSync(path.join(ROOT, 'js', 'seo-meta.js'), 'utf8');
+    const rec = seo.slice(seo.indexOf('async reconcile('), seo.indexOf('h1For(prerenderPath)'));
+    assert.ok(/_setTitle\(head\.title\)/.test(rec) && /_setDescription\(head\.description\)/.test(rec));
+    assert.ok(!/appendChild|insertAdjacent|createElement\('link'\)/.test(rec), 'reconcile never adds a second tag');
+    const set = seo.slice(seo.indexOf('_setH1(text'), seo.indexOf('// ── public entry point'));
+    assert.match(set, /el\.textContent = text/);
+});
+
+test('human /: head fields injected, but the styled hero H1 is left untouched', async () => {
+    const page = { title: 'Ink Cartridges NZ | Home', description: 'Home desc', canonical: `${SITE}/`, h1: 'Plain prerender H1' };
+    const { res } = await run('/', { prerender: ok(page) });
+    assert.equal(res.status, 200);
+    const html = await res.text();
+    assert.ok(html.includes(`content="${page.description}"`), 'description');
+    assert.ok(!html.includes(page.h1), 'prerender H1 must not replace the hero');
+    assert.match(res.headers.get('x-head-inject'), /^ok/);
+});
diff --git a/tests/turnaround-fixes-sep2026.test.js b/tests/turnaround-fixes-sep2026.test.js
index 26df6f4b..bce92313 100644
--- a/tests/turnaround-fixes-sep2026.test.js
+++ b/tests/turnaround-fixes-sep2026.test.js
@@ -128,9 +128,8 @@ test('§1 a 404 is an ANSWER, not an outage — still falls through to the SPA',
 test('§1 negative controls: a 200 still renders as 200; a human never reaches the prerender', async () => {
     const ok = await runMw(PRINTER_URL, () => new Response('<html>stub</html>', { status: 200 }));
     assert.equal(ok.res.status, 200);
-    const human = await runMw(PRINTER_URL, () => { throw new Error('must not fetch'); }, HUMAN);
-    assert.equal(human.res, undefined);
-    assert.equal(human.calls.length, 0);
+    const human = await runMw(PRINTER_URL, () => new Response('<html></html>', { status: 200 }), HUMAN);
+    assert.ok(human.calls.every((c) => !String(c.target || c).startsWith('https://ink-backend-sg.onrender.com')), 'no Render origin call');
 });
 
 // ═════════════════════════════════════════════════════════════════════════════
-- 
2.50.1 (Apple Git-155)

~~~~

## 0002-feat-seo-FE-2-real-404-noindex-for-nonexistent-print.patch

~~~~diff file=0002-feat-seo-FE-2-real-404-noindex-for-nonexistent-print.patch
From 2ad75965abff5a2211e8b84257e8a042b854b77c Mon Sep 17 00:00:00 2001
From: SEO prep <seo-prep@localhost>
Date: Tue, 24 Nov 2026 17:26:50 +1300
Subject: [PATCH 2/6] feat(seo): FE-2 real 404 + noindex for nonexistent
 printer/product URLs

A prerender 404 on a printer (/shop?brand&printer_slug) or product
(/products, /product, /p, /html/product?sku) path now answers HTTP 404 for ALL
user agents: body is the shell with robots=noindex, plus X-Robots-Tag: noindex.
Previously the SPA fallthrough was an indexable 200 (soft 404).

Brand/category/series 404s keep the fallthrough. 5xx and timeouts are never
turned into a 404 (503 for bots, plain shell for humans).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 inkcartridges/middleware.js            | 61 ++++++++++++++++++++++
 tests/seo-initial-html-nov2026.test.js | 71 +++++++++++++++++++++++++-
 tests/turnaround-fixes-sep2026.test.js |  8 +--
 3 files changed, 136 insertions(+), 4 deletions(-)

diff --git a/inkcartridges/middleware.js b/inkcartridges/middleware.js
index 0720fb0e..310f78ec 100644
--- a/inkcartridges/middleware.js
+++ b/inkcartridges/middleware.js
@@ -199,6 +199,17 @@ function injectHead(shell, head) {
 
   return { html: headHtml + body, applied, missing };
 }
+
+/** FE-2: the shell with robots forced to noindex (replaced in place, or added). */
+function noindexShell(shell) {
+  const cut = shell.toLowerCase().indexOf('</head>');
+  if (cut < 0) return shell;
+  let headHtml = shell.slice(0, cut);
+  const re = metaTagRe('robots');
+  if (re.test(headHtml)) headHtml = headHtml.replace(re, (m) => setTagAttr(m, 'content', 'noindex'));
+  else headHtml += '<meta name="robots" content="noindex">\n';
+  return headHtml + shell.slice(cut);
+}
 // </head-inject>
 
 /**
@@ -504,6 +515,13 @@ export default async function middleware(request) {
     // (ERR-296). A 4xx is an answer — a printer or product that does not exist —
     // and still falls through to the SPA, which renders its own not-found state.
     if (response.status >= 500) return prerenderUnavailable();
+    // FE-2: a printer or product the backend does not know is a real 404 for the
+    // crawler too — the SPA fallthrough was an indexable 200 (soft 404). Brand,
+    // category and series 404s keep the fallthrough (a brand 404 can be legitimate:
+    // ERR-368 receipt comment above).
+    if (response.status === 404 && isEntityPrerender(prerenderPath)) {
+      return notFoundResponse(await fetchShellHtml(url));
+    }
     if (!response.ok) return;
 
     // Headers are BUILT, never copied from upstream. The backend's prerender
@@ -535,6 +553,43 @@ export default async function middleware(request) {
   }
 }
 
+/** Printer and product prerenders: the only two where a backend 404 means "no such page". */
+function isEntityPrerender(prerenderPath) {
+  return /^\/api\/prerender\/(?:printer|product|product-by-slug)\//.test(prerenderPath);
+}
+
+/** The static shell via the loop-guarded self-fetch, or null (bot 404 path). */
+async function fetchShellHtml(url) {
+  try {
+    const res = await fetch(url.toString(), {
+      headers: { [SHELL_GUARD_HEADER]: '1', 'Accept': 'text/html' },
+      redirect: 'manual',
+      signal: AbortSignal.timeout(SHELL_FETCH_TIMEOUT_MS),
+    });
+    return res.status === 200 ? await res.text() : null;
+  } catch {
+    return null;
+  }
+}
+
+/**
+ * FE-2 — HTTP 404 for a printer/product URL that does not exist. The body is the
+ * shell (so a shopper still gets the SPA's not-found UI) with robots=noindex, plus
+ * the header form. No shell ⇒ a minimal noindex page: the status is what matters.
+ */
+function notFoundResponse(shellHtml) {
+  return new Response(shellHtml ? noindexShell(shellHtml)
+    : '<!DOCTYPE html><html lang="en-NZ"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>Page not found | InkCartridges.co.nz</title></head><body><h1>Page not found</h1></body></html>', {
+    status: 404,
+    headers: {
+      'Content-Type': 'text/html; charset=utf-8',
+      'Cache-Control': 'public, max-age=0, must-revalidate',
+      'X-Robots-Tag': 'noindex',
+      'X-Head-Inject': 'not-found',
+    },
+  });
+}
+
 /**
  * FE-1 — the static shell with the prerender's <title>, description, canonical,
  * robots and H1 written into the initial HTML. Both fetches run in parallel.
@@ -558,6 +613,12 @@ async function injectedShell(url, prerenderPath) {
     signal: AbortSignal.timeout(HEAD_PRERENDER_TIMEOUT_MS),
   });
   const [shellRes, preRes] = await Promise.allSettled([shellP, preP]);
+  // FE-2: the backend says this printer/product does not exist ⇒ a real 404.
+  // Only a 404 does this: a 5xx / timeout stays a miss (never a transient-as-404).
+  if (preRes.status === 'fulfilled' && preRes.value.status === 404 && isEntityPrerender(prerenderPath)) {
+    const ok = shellRes.status === 'fulfilled' && shellRes.value.status === 200;
+    return notFoundResponse(ok ? await shellRes.value.text() : null);
+  }
   if (shellRes.status !== 'fulfilled' || shellRes.value.status !== 200) return;
   const shell = shellRes.value;
   const shellHtml = await shell.text();
diff --git a/tests/seo-initial-html-nov2026.test.js b/tests/seo-initial-html-nov2026.test.js
index 8fbe3dc8..99032ca6 100644
--- a/tests/seo-initial-html-nov2026.test.js
+++ b/tests/seo-initial-html-nov2026.test.js
@@ -182,7 +182,6 @@ test('human: prerender timeout / 500 / 404 / garbage ⇒ the untouched shell + a
         ['timeout', () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'miss-timeout'],
         ['network', () => { throw new Error('boom'); }, 'miss-fetch-error'],
         ['500', () => new Response('x', { status: 500 }), 'miss-status-500'],
-        ['404', () => new Response('x', { status: 404 }), 'miss-status-404'],
         ['301', () => new Response(null, { status: 301, headers: { Location: '/x' } }), 'miss-status-301'],
         ['garbage', () => new Response('<html>no head</html>', { status: 200 }), 'miss-parse'],
     ];
@@ -196,6 +195,76 @@ test('human: prerender timeout / 500 / 404 / garbage ⇒ the untouched shell + a
     }
 });
 
+test('human: a category 404 is NOT a not-found (only printer/product are) — shell + miss header', async () => {
+    const { res } = await run('/ink-cartridges', { prerender: () => new Response('x', { status: 404 }) });
+    assert.equal(res.status, 200);
+    assert.equal(res.headers.get('x-head-inject'), 'miss-status-404');
+});
+
+// ── FE-2: no indexable 200 for a nonexistent printer / product ───────────────
+const NF = [
+    ['/shop?brand=hp&printer_slug=zz-not-a-printer', '/api/prerender/printer/hp/zz-not-a-printer', SHOP_SHELL],
+    ['/products/zz/NOSUCHSKU', '/api/prerender/product/NOSUCHSKU', PDP_SHELL],
+    ['/product/zz-not-a-slug', '/api/prerender/product-by-slug/zz-not-a-slug', PDP_SHELL],
+    ['/p/NOSUCHSKU', '/api/prerender/product/NOSUCHSKU', null],
+    ['/html/product?sku=NOSUCHSKU', '/api/prerender/product/NOSUCHSKU', PDP_SHELL],
+];
+for (const [ua, who] of [[HUMAN, 'human'], [GOOGLEBOT, 'bot']]) {
+    for (const [p, pre, shell] of NF) {
+        test(`${who} ${p}: backend 404 ⇒ HTTP 404 + noindex (body + header)`, async () => {
+            const { res, calls } = await run(p, { ua, prerender: () => new Response('nf', { status: 404 }) });
+            assert.equal(res.status, 404);
+            assert.equal(res.headers.get('x-robots-tag'), 'noindex');
+            const html = await res.text();
+            assert.match(html, /<meta name="robots" content="noindex">/);
+            assert.equal((html.match(/name="robots"/g) || []).length, 1, 'one robots tag');
+            assert.ok(!/content="index/.test(html), 'no indexable robots left');
+            if (shell && /\/shop|product/.test(p)) assert.ok(html.includes('<body'), 'body is the shell (SPA not-found UI)');
+            const host = who === 'bot' ? RENDER : API;
+            assert.ok(calls.some((c) => c.url === `${host}${pre}`));
+        });
+    }
+}
+
+test('5xx / timeout on a printer or product is NEVER a 404: 503 for bots, the plain shell for humans', async () => {
+    for (const p of [NF[0][0], NF[1][0]]) {
+        for (const prerender of [() => new Response('x', { status: 503 }), () => { throw new Error('boom'); }]) {
+            const bot = await run(p, { ua: GOOGLEBOT, prerender });
+            assert.equal(bot.res.status, 503, p);
+            const human = await run(p, { prerender });
+            assert.equal(human.res.status, 200, p);
+            assert.match(human.res.headers.get('x-head-inject'), /^miss-/);
+            assert.equal(human.res.headers.get('x-robots-tag'), null);
+        }
+    }
+});
+
+test('unknown BRAND keeps today\'s fallthrough: bot → undefined, human → shell 200 (never a 404)', async () => {
+    const bot = await run('/shop?brand=okin&category=receipt&code=X', { ua: GOOGLEBOT, prerender: () => new Response('nf', { status: 404 }) });
+    assert.equal(bot.res, undefined);
+    const human = await run('/shop?brand=zz-nobrand', { prerender: () => new Response('nf', { status: 404 }) });
+    assert.equal(human.res.status, 200);
+    assert.equal(human.res.headers.get('x-head-inject'), 'miss-status-404');
+});
+
+test('bot 404 with the shell unreachable still answers 404 + noindex (status is what matters)', async () => {
+    const m = await middleware();
+    const original = globalThis.fetch;
+    globalThis.fetch = async (t) => (String(t).startsWith(SITE) ? Promise.reject(new Error('down')) : new Response('nf', { status: 404 }));
+    try {
+        const res = await m(req(NF[0][0], GOOGLEBOT));
+        assert.equal(res.status, 404);
+        assert.equal(res.headers.get('x-robots-tag'), 'noindex');
+        assert.match(await res.text(), /noindex/);
+    } finally { globalThis.fetch = original; }
+});
+
+test('noindexShell: replaces the shell robots in place, adds one when absent', () => {
+    const f = new Function(`${block}\nreturn noindexShell;`)();
+    assert.equal(f('<head><meta name="robots" content="index, follow"></head>'), '<head><meta name="robots" content="noindex"></head>');
+    assert.equal(f('<head><title>t</title></head>'), '<head><title>t</title><meta name="robots" content="noindex">\n</head>');
+});
+
 test('human: unrouted paths and non-GET fall through exactly as before (undefined, no fetch)', async () => {
     for (const p of ['/shop?brand=hp&category=ink&q=zz', '/products', '/shop?q=abc']) {
         const { res, calls } = await run(p, { prerender: ok(CASES[0][1]) });
diff --git a/tests/turnaround-fixes-sep2026.test.js b/tests/turnaround-fixes-sep2026.test.js
index bce92313..f8935aea 100644
--- a/tests/turnaround-fixes-sep2026.test.js
+++ b/tests/turnaround-fixes-sep2026.test.js
@@ -120,9 +120,11 @@ test('§1 a backend 5xx and a network error both answer 503', async () => {
     assert503(res, 'network error on a PDP');
 });
 
-test('§1 a 404 is an ANSWER, not an outage — still falls through to the SPA', async () => {
-    const { res } = await runMw(PRINTER_URL, () => new Response('nope', { status: 404 }));
-    assert.equal(res, undefined);
+test('§1 a 404 is an ANSWER, not an outage — never 503. FE-2: a printer/product 404 is a real 404 (tests/seo-initial-html-nov2026.test.js); a brand 404 still falls through to the SPA', async () => {
+    const printer = await runMw(PRINTER_URL, () => new Response('nope', { status: 404 }));
+    assert.equal(printer.res.status, 404);
+    const brand = await runMw(`${SITE}/shop?brand=zz-nobrand`, () => new Response('nope', { status: 404 }));
+    assert.equal(brand.res, undefined);
 });
 
 test('§1 negative controls: a 200 still renders as 200; a human never reaches the prerender', async () => {
-- 
2.50.1 (Apple Git-155)

~~~~

## 0003-feat-seo-FE-3-visible-content-parity-on-listing-page.patch

~~~~diff file=0003-feat-seo-FE-3-visible-content-parity-on-listing-page.patch
From 17ca19c7bdebbe784799913483c63ada2c4cac2a Mon Sep 17 00:00:00 2001
From: =?UTF-8?q?=EC=A0=84=EB=B3=91=ED=97=8C?=
 <jackson@jeonbyeongheon-ui-MacBookAir.local>
Date: Tue, 24 Nov 2026 17:54:30 +1300
Subject: [PATCH 3/6] feat(seo): FE-3 visible content parity on listing pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 inkcartridges/css/pages.css                   |  17 ++
 inkcartridges/html/shop.html                  |   5 +
 inkcartridges/js/seo-meta.js                  | 269 ++++++++++++++++--
 ...r-replies-backend-response-sep2026.test.js |   2 +-
 tests/seo-content-parity-nov2026.test.js      | 122 ++++++++
 tests/seo-meta-rewrite-may2026.test.js        |   4 +-
 6 files changed, 395 insertions(+), 24 deletions(-)
 create mode 100644 tests/seo-content-parity-nov2026.test.js

diff --git a/inkcartridges/css/pages.css b/inkcartridges/css/pages.css
index 3ebb12d1..c9552ec5 100644
--- a/inkcartridges/css/pages.css
+++ b/inkcartridges/css/pages.css
@@ -7780,6 +7780,23 @@ a.account-review-card__product:focus-visible {
 }
 .ribbons-faq .faq-list { margin: 0; }
 
+/* FE-3: listing-page mirror of the prerender body (SeoMeta._renderMirror). */
+.seo-mirror { padding-top: var(--spacing-xl, 32px); padding-bottom: var(--spacing-xl, 32px); }
+.seo-mirror__intro { max-width: 72ch; margin: 0 0 var(--spacing-4, 16px); font-size: var(--font-size-sm); line-height: 1.6; color: var(--color-text); }
+.seo-mirror__section { margin: 0 0 var(--spacing-xl, 32px); }
+.seo-mirror__title { font-size: var(--font-size-xl); margin: 0 0 var(--spacing-md, 16px); color: var(--color-text-heading); }
+.seo-mirror__subtitle { font-size: var(--font-size-base); margin: var(--spacing-md, 16px) 0 var(--spacing-2, 8px); color: var(--color-text-heading); }
+.seo-mirror__section p, .seo-mirror__section li { max-width: 72ch; font-size: var(--font-size-sm); line-height: 1.6; color: var(--color-text); overflow-wrap: anywhere; }
+.seo-mirror__section ul { padding-left: 1.25em; margin: 0 0 var(--spacing-3, 12px); }
+.seo-mirror__section .seo-mirror__products { list-style: none; padding: 0; margin: 0 0 var(--spacing-3, 12px); display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--spacing-3, 12px); }
+.seo-mirror__products .seo-mirror__card { max-width: none; }
+.seo-mirror__card > a, .seo-mirror__card > div { display: block; height: 100%; padding: var(--spacing-3, 12px); border: 1px solid var(--steel-200); border-radius: var(--radius-lg, 8px); color: inherit; text-decoration: none; }
+.seo-mirror__card > a:hover { border-color: var(--steel-400, var(--steel-200)); }
+.seo-mirror__name { font-size: var(--font-size-sm); margin: 0 0 var(--spacing-2, 8px); color: var(--color-text-heading); }
+.seo-mirror__card p { margin: 0 0 var(--spacing-1, 4px); }
+.seo-mirror__faq .faq-list { margin: 0; }
+@media (max-width: 480px) { .seo-mirror__products { grid-template-columns: 1fr; } }
+
 
 /* ── Shop Section Cards ── */
 .shop-section-card {
diff --git a/inkcartridges/html/shop.html b/inkcartridges/html/shop.html
index 788db7b7..54fefcc9 100644
--- a/inkcartridges/html/shop.html
+++ b/inkcartridges/html/shop.html
@@ -483,6 +483,11 @@
             </div>
         </div>
 
+        <!-- FE-3 (visible content parity): the prerender's intro, text sections,
+             product list and FAQ, written as TEXT by SeoMeta._renderMirror on
+             category / brand pages. data-mirror = prerender | static | error. -->
+        <section class="container seo-mirror" id="seo-mirror" data-mirror="static" aria-label="About these products" hidden></section>
+
         <section class="container">
             <div class="need-help" data-track="support_impression" data-track-location="shop_page">
                 <svg class="need-help__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
diff --git a/inkcartridges/js/seo-meta.js b/inkcartridges/js/seo-meta.js
index c7c9adfe..e1a5eb91 100644
--- a/inkcartridges/js/seo-meta.js
+++ b/inkcartridges/js/seo-meta.js
@@ -64,7 +64,7 @@ const SeoMeta = {
 
     // v2 (ERR-294): a cached head now carries the prerender's <h1> too; a v1
     // entry has none and would leave the printer H1 on its fallback for an hour.
-    PRERENDER_CACHE_PREFIX: 'ic_seo_pr_v3:',  // v3: heads carry intro + faq (ERR-377)
+    PRERENDER_CACHE_PREFIX: 'ic_seo_pr_v4:',  // v3: heads carry intro + faq (ERR-377); v4: + content (FE-3 visible parity)
     PRERENDER_TTL_MS: 60 * 60 * 1000, // 1h listings (products use API seo, not this)
 
     _seq: 0,            // bumped on every render() — guards against stale async applies
@@ -154,7 +154,7 @@ const SeoMeta = {
      * (handoff 2 Nov, item 62, ERR-377).
      */
     extractHead(html) {
-        if (typeof html !== 'string' || !html) return { title: null, description: null, h1: null, intro: null, faq: null };
+        if (typeof html !== 'string' || !html) return { title: null, description: null, h1: null, intro: null, faq: null, content: null };
         const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
         // meta name="description" — attribute order independent
         let desc = null;
@@ -177,9 +177,112 @@ const SeoMeta = {
             h1: h1 || null,
             intro: intro || null,
             faq: this.extractFaq(html),
+            content: this.extractContent(html),
         };
     },
 
+    // ── FE-3: visible content parity (listing pages) ─────────────────────────
+    // Same-site hosts a prerender link may point at; anything else is dropped to text.
+    SITE_HOSTS: ['www.inkcartridges.co.nz', 'inkcartridges.co.nz'],
+
+    /** Same-origin PATH (+query) for a prerender href, or null. PURE. */
+    safePath(href) {
+        if (typeof href !== 'string' || !href) return null;
+        try {
+            const u = new URL(this.decodeEntities(href).trim(), 'https://www.inkcartridges.co.nz');
+            if (u.protocol !== 'https:' || !this.SITE_HOSTS.includes(u.hostname)) return null;
+            return u.pathname + u.search;
+        } catch { return null; }
+    },
+
+    _plain(h) {
+        return this.decodeEntities(String(h).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
+    },
+
+    /** Inline HTML -> [{ t } | { t, href }] (text + same-origin links only). PURE. */
+    _segments(inner) {
+        const out = [];
+        const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
+        let last = 0, m;
+        const pushText = (raw) => {
+            const t = this.decodeEntities(raw.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ');
+            if (t.trim()) out.push({ t });
+        };
+        while ((m = re.exec(inner)) !== null) {
+            pushText(inner.slice(last, m.index));
+            const hM = /\bhref\s*=\s*"([^"]*)"/i.exec(m[1]);
+            const t = this._plain(m[2]);
+            const href = hM ? this.safePath(hM[1]) : null;
+            if (t) out.push(href ? { t, href } : { t });
+            last = m.index + m[0].length;
+        }
+        pushText(inner.slice(last));
+        return out;
+    },
+
+    /**
+     * Everything under the intro that a bot reads in <main>, as plain data:
+     *   sections: [{ h2, linkList, blocks:[{k:'h3',t}|{k:'p',s}|{k:'ul',items:[segs]}] }]
+     *   products: { h2, items:[{ href, name, lines }], more:[segs] } | null
+     *   faqTitle: the FAQ section's h2 (the FAQ itself is the JSON-LD, extractFaq)
+     * `linkList` = a section that is only a list of links (brand / category
+     * tiles), which the SPA already shows as its drilldown. PURE; no DOM.
+     */
+    extractContent(html) {
+        const empty = { sections: [], products: null, faqTitle: null };
+        if (typeof html !== 'string') return empty;
+        const mainM = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
+        if (!mainM) return empty;
+        const out = { sections: [], products: null, faqTitle: null };
+        const secRe = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
+        let sm;
+        while ((sm = secRe.exec(mainM[1])) !== null) {
+            const attrs = sm[1], body = sm[2];
+            const h2M = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(body);
+            const h2 = h2M ? this._plain(h2M[1]) : '';
+            if (/\bclass\s*=\s*"[^"]*\bfaq\b/i.test(attrs)) { out.faqTitle = h2 || null; continue; }
+            if (/class\s*=\s*"product-card"/i.test(body)) {
+                const items = [];
+                const cardRe = /<li\s+class="product-card"[^>]*>([\s\S]*?)<\/li>/gi;
+                let cm;
+                while ((cm = cardRe.exec(body)) !== null) {
+                    const hM = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/i.exec(cm[1]);
+                    const nM = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(cm[1]);
+                    const name = nM ? this._plain(nM[1]) : '';
+                    if (!name) continue;
+                    const lines = [];
+                    const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
+                    let pm;
+                    while ((pm = pRe.exec(cm[1])) !== null) { const t = this._plain(pm[1]); if (t) lines.push(t); }
+                    items.push({ href: hM ? this.safePath(hM[1]) : null, name, lines });
+                }
+                const tail = body.slice(body.lastIndexOf('</ul>') + 5);
+                const moreM = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(tail);
+                out.products = { h2, items, more: moreM ? this._segments(moreM[1]) : [] };
+                continue;
+            }
+            const blocks = [];
+            const tagRe = /<(h3|p|ul|nav)\b[^>]*>([\s\S]*?)<\/\1>/gi;
+            let tm;
+            while ((tm = tagRe.exec(body)) !== null) {
+                if (tm[1] === 'h3') { const t = this._plain(tm[2]); if (t) blocks.push({ k: 'h3', t }); }
+                else if (tm[1] === 'p') { const s = this._segments(tm[2]); if (s.length) blocks.push({ k: 'p', s }); }
+                else if (tm[1] === 'ul') {
+                    const items = [...tm[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => this._segments(x[1])).filter((s) => s.length);
+                    if (items.length) blocks.push({ k: 'ul', items });
+                } else {
+                    const items = [...tm[2].matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((x) => this._segments(x[0])).filter((s) => s.length);
+                    if (items.length) blocks.push({ k: 'ul', items });
+                }
+            }
+            if (!h2 && !blocks.length) continue;
+            const linkList = blocks.length === 1 && blocks[0].k === 'ul'
+                && blocks[0].items.every((it) => it.length === 1 && it[0].href);
+            out.sections.push({ h2, linkList: !!linkList, blocks });
+        }
+        return out;
+    },
+
     /** [{ q, a }] from the first FAQPage JSON-LD block, or null. PURE. */
     extractFaq(html) {
         const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
@@ -669,19 +772,24 @@ const SeoMeta = {
      * whichever of the two runs last prints the prerender's words.
      */
     async reconcile(prerenderPath, seq, surface) {
+        if (!this.MIRROR_SURFACES.includes(surface) || !prerenderPath) this._clearMirror();
         if (!prerenderPath) return false;
+        const mirrors = this.MIRROR_SURFACES.includes(surface);
         let head = this._readPrerenderCache(prerenderPath);
         if (!head) {
             if (typeof fetch !== 'function') return false;
             try {
                 // Public prerender read — cookies explicitly omitted (ERR-124).
             const res = await fetch(this._apiUrl(prerenderPath), { headers: { 'Accept': 'text/html' }, credentials: 'omit' });
-                if (!res.ok) return false;
+                if (!res.ok) throw new Error(`prerender HTTP ${res.status}`);
                 const html = await res.text();
                 head = this.extractHead(html);
-                if (!head || (!head.title && !head.description)) return false;
+                if (!head || (!head.title && !head.description)) throw new Error('prerender had no head');
                 this._writePrerenderCache(prerenderPath, head);
-            } catch {
+            } catch (err) {
+                // LOUD, not silent: the static page stays, but the mirror says why.
+                if (mirrors && seq === this._seq) this._setMirrorState('error');
+                if (typeof DebugLog !== 'undefined') DebugLog.warn('[SeoMeta] prerender mirror failed:', prerenderPath, err && err.message);
                 return false;
             }
         }
@@ -704,6 +812,7 @@ const SeoMeta = {
             this._h1 = { path: prerenderPath, h1: head.h1 };
             this._setH1(head.h1, false);
         }
+        if (mirrors) this._renderMirror(head, prerenderPath);
         // /ribbons (handoff 2 Nov, item 62, ERR-377): visible h1, intro and FAQ
         // are the prerender's, so the stock counts in them never go stale.
         if (surface === 'category-ribbons') {
@@ -738,25 +847,143 @@ const SeoMeta = {
         }
         const list = document.getElementById('ribbons-faq-list');
         if (list) {
-            if (Array.isArray(head.faq) && head.faq.length) {
-                list.textContent = '';
-                for (const { q, a } of head.faq) {
-                    const item = document.createElement('details');
-                    item.className = 'faq-item';
-                    const sum = document.createElement('summary');
-                    sum.className = 'faq-question';
-                    sum.textContent = q;
-                    const body = document.createElement('div');
-                    body.className = 'faq-answer';
-                    const p = document.createElement('p');
-                    p.textContent = a;
-                    body.appendChild(p);
-                    item.append(sum, body);
-                    list.appendChild(item);
+            const has = this._renderFaq(list, head.faq);
+            list.dataset.mirror = has ? 'prerender' : 'static';
+        }
+    },
+
+    /** Fill `list` with <details class="faq-item"> from [{q,a}] as TEXT. Returns true when written. */
+    _renderFaq(list, faq) {
+        if (!Array.isArray(faq) || !faq.length) return false;
+        list.textContent = '';
+        for (const { q, a } of faq) {
+            const item = document.createElement('details');
+            item.className = 'faq-item';
+            const sum = document.createElement('summary');
+            sum.className = 'faq-question';
+            sum.textContent = q;
+            const body = document.createElement('div');
+            body.className = 'faq-answer';
+            const p = document.createElement('p');
+            p.textContent = a;
+            body.appendChild(p);
+            item.append(sum, body);
+            list.appendChild(item);
+        }
+        return true;
+    },
+
+    // ── FE-3: visible mirror of the prerender body on listing pages ──────────
+    MIRROR_SURFACES: ['category-ink', 'category-toner', 'category-receipt', 'brand'],
+
+    _mirrorEl() { return (typeof document === 'undefined' || typeof document.getElementById !== 'function') ? null : document.getElementById('seo-mirror'); },
+
+    _setMirrorState(state) {
+        const el = this._mirrorEl();
+        if (el) el.dataset.mirror = state;
+    },
+
+    _clearMirror() {
+        const el = this._mirrorEl();
+        if (!el) return;
+        el.textContent = '';
+        el.hidden = true;
+        el.dataset.mirror = 'static';
+    },
+
+    _appendSegments(parent, segs) {
+        for (const g of segs) {
+            if (g.href) {
+                const a = document.createElement('a');
+                a.href = g.href;
+                a.textContent = g.t;
+                parent.appendChild(a);
+            } else {
+                parent.appendChild(document.createTextNode(g.t));
+            }
+        }
+    },
+
+    /**
+     * Render intro + text sections + product list + FAQ from the prerender head
+     * into #seo-mirror (TEXT nodes only; links are same-origin paths). Skips
+     * (recorded in data-skipped): link-list sections the drilldown already shows
+     * (brand/category tiles on a page with no ?category), and the product list
+     * where the SPA already lists products (receipt rolls, ?code= pages, or any
+     * page whose #level-products is showing).
+     */
+    _renderMirror(head, prerenderPath) {
+        const el = this._mirrorEl();
+        if (!el) return;
+        const c = head && head.content;
+        if (!c || (!head.intro && !(c.sections && c.sections.length) && !c.products && !head.faq)) {
+            this._clearMirror();
+            this._setMirrorState('static');
+            return;
+        }
+        const path = String(prerenderPath || '');
+        const tilesShown = /\/category\/(ink|toner)$/.test(path) || /\/brand\/[^/?]+$/.test(path);
+        const lp = document.getElementById('level-products');
+        const listShown = /\/category\/receipt$/.test(path) || /[?&]code=/.test(path) || (lp && !lp.hidden);
+        const skipped = [];
+        const frag = document.createDocumentFragment();
+        const h = (tag, text, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; n.textContent = text; return n; };
+        if (head.intro) frag.appendChild(h('p', head.intro, 'seo-mirror__intro'));
+        for (const sec of c.sections || []) {
+            if (sec.linkList && tilesShown) { skipped.push('tiles'); continue; }
+            const box = document.createElement('section');
+            box.className = 'seo-mirror__section';
+            if (sec.h2) box.appendChild(h('h2', sec.h2, 'seo-mirror__title'));
+            for (const b of sec.blocks) {
+                if (b.k === 'h3') box.appendChild(h('h3', b.t, 'seo-mirror__subtitle'));
+                else if (b.k === 'p') { const p = document.createElement('p'); this._appendSegments(p, b.s); box.appendChild(p); }
+                else {
+                    const ul = document.createElement('ul');
+                    for (const it of b.items) { const li = document.createElement('li'); this._appendSegments(li, it); ul.appendChild(li); }
+                    box.appendChild(ul);
+                }
+            }
+            frag.appendChild(box);
+        }
+        if (c.products && c.products.items.length) {
+            if (listShown) skipped.push('products');
+            else {
+                const box = document.createElement('section');
+                box.className = 'seo-mirror__section';
+                if (c.products.h2) box.appendChild(h('h2', c.products.h2, 'seo-mirror__title'));
+                const ul = document.createElement('ul');
+                ul.className = 'seo-mirror__products';
+                for (const it of c.products.items) {
+                    const li = document.createElement('li');
+                    li.className = 'seo-mirror__card';
+                    const host = it.href ? document.createElement('a') : document.createElement('div');
+                    if (it.href) host.href = it.href;
+                    host.appendChild(h('h3', it.name, 'seo-mirror__name'));
+                    for (const line of it.lines) host.appendChild(h('p', line));
+                    li.appendChild(host);
+                    ul.appendChild(li);
                 }
+                box.appendChild(ul);
+                if (c.products.more && c.products.more.length) { const p = document.createElement('p'); this._appendSegments(p, c.products.more); box.appendChild(p); }
+                frag.appendChild(box);
             }
-            list.dataset.mirror = (Array.isArray(head.faq) && head.faq.length) ? 'prerender' : 'static';
         }
+        if (Array.isArray(head.faq) && head.faq.length) {
+            const box = document.createElement('section');
+            box.className = 'seo-mirror__section seo-mirror__faq';
+            box.appendChild(h('h2', c.faqTitle || 'Frequently asked questions', 'seo-mirror__title'));
+            const list = document.createElement('div');
+            list.className = 'faq-list';
+            this._renderFaq(list, head.faq);
+            box.appendChild(list);
+            frag.appendChild(box);
+        }
+        el.textContent = '';
+        el.appendChild(frag);
+        el.hidden = !el.firstChild;
+        el.dataset.mirror = el.firstChild ? 'prerender' : 'static';
+        if (skipped.length) el.dataset.skipped = [...new Set(skipped)].join(',');
+        else delete el.dataset.skipped;
     },
 
     _setH1(text, reveal = true) {
diff --git a/tests/four-replies-backend-response-sep2026.test.js b/tests/four-replies-backend-response-sep2026.test.js
index 3551578c..2a4633dd 100644
--- a/tests/four-replies-backend-response-sep2026.test.js
+++ b/tests/four-replies-backend-response-sep2026.test.js
@@ -289,7 +289,7 @@ test('§E reconcile on the PRINTER surface writes the visible H1; any other surf
     assert.deepEqual(title.classList.removed, ['visually-hidden']);
     assert.equal(S.h1For(path), 'Brother HL-L2375DW Toner NZ', 'shop-page reads the same answer');
     assert.equal(S.h1For('/api/prerender/printer/x/y'), null);
-    assert.match(S.PRERENDER_CACHE_PREFIX, /_v3:$/, 'v1 heads carry no h1, v2 no intro/faq (ERR-377) — bumped');
+    assert.match(S.PRERENDER_CACHE_PREFIX, /_v4:$/, 'v1 heads carry no h1, v2 no intro/faq (ERR-377), v3 no content (FE-3) — bumped');
 });
 
 test('§E updateTitle prints the mirrored H1 on a printer hub, the printer name until it lands', () => {
diff --git a/tests/seo-content-parity-nov2026.test.js b/tests/seo-content-parity-nov2026.test.js
new file mode 100644
index 00000000..008f80f6
--- /dev/null
+++ b/tests/seo-content-parity-nov2026.test.js
@@ -0,0 +1,122 @@
+/**
+ * FE-3 (Nov 2026) — visible content parity on listing pages.
+ * Pins: pure extraction over a fixture prerender, FAQ byte-parity with the
+ * FAQPage JSON-LD, no innerHTML of prerender content, route coverage.
+ */
+const test = require('node:test');
+const assert = require('node:assert/strict');
+const fs = require('node:fs');
+const path = require('node:path');
+const SeoMeta = require('../inkcartridges/js/seo-meta.js');
+
+const ROOT = path.join(__dirname, '..', 'inkcartridges');
+const SRC = fs.readFileSync(path.join(ROOT, 'js/seo-meta.js'), 'utf8');
+
+const FAQ = [
+    { q: 'What size roll do I need?', a: 'Width x diameter — it\'s printed in the cover. We\'ll match it & help.' },
+    { q: 'Is shipping free?', a: 'Yes — orders over $100 ship free anywhere in New Zealand.' },
+];
+const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) };
+const FIXTURE = `<html><head><title>Ink Cartridges NZ</title>
+<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
+<main>
+<h1>Ink Cartridges NZ &mdash; Genuine &amp; Compatible</h1>
+<p>Browse 1453 ink cartridges. Free NZ shipping.</p>
+<section><h2>Shop Ink Cartridges by Brand</h2><ul>
+<li><a href="https://www.inkcartridges.co.nz/shop?brand=hp&amp;category=ink"><strong>HP Ink Cartridges</strong> (400)</a></li>
+<li><a href="https://www.inkcartridges.co.nz/shop?brand=canon&amp;category=ink"><strong>Canon Ink Cartridges</strong> (381)</a></li></ul></section>
+<section><h2>Genuine vs Compatible</h2>
+<p>We stock both. <a href="https://www.inkcartridges.co.nz/genuine-vs-compatible">Learn more</a> or <a href="https://evil.example/x">bad</a> <a href="javascript:alert(1)">worse</a>.</p>
+<ul><li><strong>Genuine:</strong> 1032 products</li></ul></section>
+<section><h2>All Ink Cartridges</h2><ul>
+<li class="product-card"><a href="https://www.inkcartridges.co.nz/products/b-one/GONE"><img src="x.webp" alt="a"><h3>Brother One &amp; Two</h3><p>Genuine Brother</p><p><strong>$8.49</strong> incl. GST</p><p>In Stock</p></a></li>
+<li class="product-card"><a href="https://www.inkcartridges.co.nz/products/c-two/CTWO"><h3>Canon Two</h3><p><strong>$12.00</strong> incl. GST</p></a></li>
+</ul><p><a href="https://www.inkcartridges.co.nz/shop?category=ink">View all 1453 ink cartridges</a></p></section>
+<section class="faq"><h2 id="faq-heading">Frequently asked questions</h2><h3>${FAQ[0].q}</h3><p>${FAQ[0].a.replace(/'/g, '&#39;')}</p></section>
+</main></body></html>`;
+
+test('extractContent: sections, link-list flag, text-only segments, link allow-list', () => {
+    const c = SeoMeta.extractContent(FIXTURE);
+    assert.deepEqual(c.sections.map((s) => s.h2), ['Shop Ink Cartridges by Brand', 'Genuine vs Compatible']);
+    assert.equal(c.sections[0].linkList, true);
+    assert.equal(c.sections[1].linkList, false);
+    const p = c.sections[1].blocks[0].s;
+    assert.deepEqual(p.filter((x) => x.href).map((x) => x.href), ['/genuine-vs-compatible']);
+    assert.ok(p.some((x) => x.t === 'bad' && !x.href), 'foreign host drops to text');
+    assert.ok(p.some((x) => x.t === 'worse' && !x.href), 'javascript: drops to text');
+    assert.equal(c.faqTitle, 'Frequently asked questions');
+});
+
+test('extractContent: products keep order, name, price lines and same-origin path', () => {
+    const { products } = SeoMeta.extractContent(FIXTURE);
+    assert.equal(products.h2, 'All Ink Cartridges');
+    assert.deepEqual(products.items.map((i) => i.name), ['Brother One & Two', 'Canon Two']);
+    assert.deepEqual(products.items[0].lines, ['Genuine Brother', '$8.49 incl. GST', 'In Stock']);
+    assert.equal(products.items[0].href, '/products/b-one/GONE');
+    assert.equal(products.more[0].href, '/shop?category=ink');
+});
+
+test('extractContent: empty / non-prerender input never throws', () => {
+    for (const x of [null, undefined, '', '<html></html>', 42]) {
+        const c = SeoMeta.extractContent(x);
+        assert.deepEqual(c, { sections: [], products: null, faqTitle: null });
+    }
+});
+
+test('FAQ text is byte-identical to the FAQPage JSON-LD answers (inv 11)', () => {
+    const head = SeoMeta.extractHead(FIXTURE);
+    assert.deepEqual(head.faq, FAQ);
+    assert.equal(JSON.stringify(head.faq), JSON.stringify(FAQ));
+    assert.ok(head.content.sections.every((s) => !/Frequently/.test(s.h2)), 'FAQ is not duplicated from the visible HTML');
+});
+
+test('safePath: same-origin only', () => {
+    assert.equal(SeoMeta.safePath('https://www.inkcartridges.co.nz/a?b=1&amp;c=2#h'), '/a?b=1&c=2');
+    assert.equal(SeoMeta.safePath('/relative'), '/relative');
+    for (const bad of ['https://evil.example/', 'http://www.inkcartridges.co.nz/', 'javascript:alert(1)', '//evil.example/x', '', null]) {
+        assert.equal(SeoMeta.safePath(bad), null, String(bad));
+    }
+});
+
+test('no innerHTML / insertAdjacentHTML / outerHTML / document.write anywhere in the mirror code', () => {
+    const a = SRC.indexOf('FE-3: visible mirror of the prerender body');
+    const b = SRC.indexOf('    _setH1(text');
+    assert.ok(a > 0 && b > a);
+    assert.doesNotMatch(SRC.slice(a, b), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
+    assert.doesNotMatch(SRC, /\.innerHTML\s*=/);
+});
+
+test('mirror is loud on failure, never display:none, cache bumped to v4', () => {
+    assert.match(SRC, /_setMirrorState\('error'\)/);
+    assert.match(SRC, /ic_seo_pr_v4:/);
+    assert.doesNotMatch(SRC, /ic_seo_pr_v3:/);
+    const css = fs.readFileSync(path.join(ROOT, 'css/pages.css'), 'utf8');
+    const block = css.slice(css.indexOf('FE-3: listing-page mirror'), css.indexOf('/* ── Shop Section Cards'));
+    assert.ok(block.length > 100);
+    assert.doesNotMatch(block, /display:\s*none/);
+});
+
+test('route coverage: each listing surface gets a prerender path and mirrors', () => {
+    const cases = [
+        ['/ink-cartridges', '', '/api/prerender/category/ink', 'category-ink'],
+        ['/toner-cartridges', '', '/api/prerender/category/toner', 'category-toner'],
+        ['/receipt-rolls', '', '/api/prerender/category/receipt', 'category-receipt'],
+        ['/shop', '?brand=brother', '/api/prerender/brand/brother', 'brand'],
+        ['/shop', '?brand=canon&category=toner', '/api/prerender/brand/canon?category=toner', 'brand'],
+        ['/shop', '?brand=canon&code=PG645', '/api/prerender/brand/canon?code=PG645', 'brand'],
+    ];
+    for (const [pathname, search, pr, surface] of cases) {
+        const loc = { pathname, search };
+        assert.equal(SeoMeta.prerenderPathForLocation(loc), pr);
+        assert.equal(SeoMeta.surfaceForLocation(loc), surface);
+        assert.ok(SeoMeta.MIRROR_SURFACES.includes(surface), surface);
+    }
+    // printer pages are already at parity: left alone
+    assert.ok(!SeoMeta.MIRROR_SURFACES.includes('printer'));
+    assert.ok(!SeoMeta.MIRROR_SURFACES.includes('category-ribbons'));
+});
+
+test('shop.html carries the mirror container, hidden + static until populated', () => {
+    const html = fs.readFileSync(path.join(ROOT, 'html/shop.html'), 'utf8');
+    assert.match(html, /<section[^>]*id="seo-mirror"[^>]*data-mirror="static"[^>]*hidden/);
+});
diff --git a/tests/seo-meta-rewrite-may2026.test.js b/tests/seo-meta-rewrite-may2026.test.js
index 1e668539..6ab42a3e 100644
--- a/tests/seo-meta-rewrite-may2026.test.js
+++ b/tests/seo-meta-rewrite-may2026.test.js
@@ -206,9 +206,9 @@ test('§4 extractHead is attribute-order independent and tolerant of single quot
 test('§4 extractHead returns nulls for empty / missing tags', () => {
     // h1 since ERR-294 (the printer hub mirrors the prerender's visible heading).
     // intro + faq since ERR-377 (/ribbons mirrors the prerender's intro and FAQ).
-    const none = { title: null, description: null, h1: null, intro: null, faq: null };
+    const none = { title: null, description: null, h1: null, intro: null, faq: null, content: null };
     sameShape(SeoMeta.extractHead(''), none);
-    sameShape(SeoMeta.extractHead('<html></html>'), none);
+    sameShape(SeoMeta.extractHead('<html></html>'), { ...none, content: { sections: [], products: null, faqTitle: null } });
 });
 
 // ─────────────────────────────────────────────────────────────────────────────
-- 
2.50.1 (Apple Git-155)

~~~~

## 0004-feat-seo-FE-4-prerender-JSON-LD-in-the-initial-HTML-.patch

~~~~diff file=0004-feat-seo-FE-4-prerender-JSON-LD-in-the-initial-HTML-.patch
From 1c98c994e1e9201845df26722d554b68dbb88d5b Mon Sep 17 00:00:00 2001
From: =?UTF-8?q?=EC=A0=84=EB=B3=91=ED=97=8C?=
 <jackson@jeonbyeongheon-ui-MacBookAir.local>
Date: Tue, 24 Nov 2026 17:45:09 +1300
Subject: [PATCH 4/6] feat(seo): FE-4 prerender JSON-LD in the initial HTML for
 all user agents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 inkcartridges/middleware.js             |  83 +++++++++++-
 tests/seo-jsonld-parity-nov2026.test.js | 170 ++++++++++++++++++++++++
 2 files changed, 252 insertions(+), 1 deletion(-)
 create mode 100644 tests/seo-jsonld-parity-nov2026.test.js

diff --git a/inkcartridges/middleware.js b/inkcartridges/middleware.js
index 310f78ec..e4c9c7da 100644
--- a/inkcartridges/middleware.js
+++ b/inkcartridges/middleware.js
@@ -200,6 +200,80 @@ function injectHead(shell, head) {
   return { html: headHtml + body, applied, missing };
 }
 
+// FE-4: JSON-LD parity. The prerender's blocks are copied byte-for-byte into the
+// shell's <head> so a visitor and a crawler read the same structured data.
+const RE_LD_G = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
+// ids the client code already upserts by id (footer.js site-jsonld-*, schema.js
+// collection-/printer-jsonld-*, shop-page.js #shop-schema): reusing them means a
+// later runtime write REPLACES the injected block instead of adding a second one.
+const LD_SITE_IDS = { organization: 'site-jsonld-organization', website: 'site-jsonld-website', localbusiness: 'site-jsonld-localbusiness' };
+
+function ldType(body) {
+  try {
+    const t = JSON.parse(body)['@type'];
+    return Array.isArray(t) ? t.join(',') : (typeof t === 'string' ? t : null);
+  } catch { return undefined; } // undefined = does not parse
+}
+
+/** FAQPage only where the visible page shows the same Q&A (category, brand, product). */
+function ldFaqAllowed(prerenderPath) {
+  return /^\/api\/prerender\/(category|brand|product|product-by-slug)\//.test(prerenderPath);
+}
+
+function ldIdFor(type, prerenderPath) {
+  const k = type.toLowerCase();
+  if (LD_SITE_IDS[k]) return LD_SITE_IDS[k];
+  const scope = /^\/api\/prerender\/printer\//.test(prerenderPath) ? 'printer' : /\/product/.test(prerenderPath) ? 'product' : 'collection';
+  if (k === 'collectionpage') return `${scope}-jsonld-collection-page`;
+  if (k === 'breadcrumblist') return `${scope}-jsonld-breadcrumbs`;
+  return `${scope}-jsonld-${k.replace(/[^a-z0-9]+/g, '-')}`;
+}
+
+/**
+ * Copy the prerender's ld+json blocks into the shell head. One block per @type:
+ * a shell block of an injected type is replaced in place (its id survives), the
+ * rest stay. A block that does not JSON.parse is skipped and counted.
+ * @returns {{html: string, injected: string[], skipped: number}}
+ */
+function injectLdJson(shell, prerenderHtml, prerenderPath) {
+  const cut = shell.toLowerCase().indexOf('</head>');
+  if (cut < 0 || typeof prerenderHtml !== 'string') return { html: shell, injected: [], skipped: 0 };
+  const blocks = [];
+  let skipped = 0;
+  const seenTypes = new Set();
+  for (const m of prerenderHtml.matchAll(RE_LD_G)) {
+    const type = ldType(m[1]);
+    if (type === undefined) { skipped++; continue; }
+    if (!type) continue;
+    if (type === 'FAQPage' && !ldFaqAllowed(prerenderPath)) continue;
+    blocks.push({ type, body: m[1], first: !seenTypes.has(type) });
+    seenTypes.add(type);
+  }
+  if (!blocks.length) return { html: shell, injected: [], skipped };
+  let head = shell.slice(0, cut);
+  const shellIds = {};
+  const done = new Set();
+  const make = (b, id) => `<script type="application/ld+json"${id ? ` id="${id}"` : ''}>${b.body}</script>`;
+  // Replace the first shell block of each injected type with ALL prerender blocks
+  // of that type; drop the other shell blocks of that type.
+  head = head.replace(RE_LD_G, (whole, body) => {
+    const t = ldType(body);
+    if (!t || !seenTypes.has(t)) return whole;
+    const idm = /\bid\s*=\s*["']([^"']*)["']/i.exec(whole.slice(0, whole.indexOf('>')));
+    if (done.has(t)) return '';
+    done.add(t);
+    shellIds[t] = idm ? idm[1] : null;
+    return blocks.filter((b) => b.type === t).map((b, i) => make(b, i === 0 ? (shellIds[t] || ldIdFor(t, prerenderPath)) : null)).join('\n');
+  });
+  const added = [];
+  for (const t of seenTypes) {
+    if (done.has(t)) continue;
+    blocks.filter((b) => b.type === t).forEach((b, i) => added.push(make(b, i === 0 ? ldIdFor(t, prerenderPath) : null)));
+  }
+  if (added.length) head += `${added.join('\n')}\n`;
+  return { html: head + shell.slice(cut), injected: blocks.map((b) => b.type), skipped };
+}
+
 /** FE-2: the shell with robots forced to noindex (replaced in place, or added). */
 function noindexShell(shell) {
   const cut = shell.toLowerCase().indexOf('</head>');
@@ -631,7 +705,8 @@ async function injectedShell(url, prerenderPath) {
     reason = `miss-status-${preRes.value.status}`;
   } else {
     try {
-      const head = extractPrerenderHead(await preRes.value.text());
+      const preHtml = await preRes.value.text();
+      const head = extractPrerenderHead(preHtml);
       // Home: the hero H1 is styled markup (a highlight span); swapping it for the
       // prerender's plain text would visibly change the hero. Head fields only.
       if (url.pathname === '/') head.h1 = null;
@@ -642,6 +717,12 @@ async function injectedShell(url, prerenderPath) {
         else {
           html = r.html;
           if (r.missing.length) reason = `ok-partial-no-${r.missing.join('-')}`;
+          // FE-4: JSON-LD. Never fatal: a failure here keeps the head/H1 result.
+          try {
+            const ld = injectLdJson(html, preHtml, prerenderPath);
+            html = ld.html;
+            if (ld.skipped) reason += `-ldjson-skip-${ld.skipped}`;
+          } catch { reason += '-ldjson-error'; }
         }
       }
     } catch {
diff --git a/tests/seo-jsonld-parity-nov2026.test.js b/tests/seo-jsonld-parity-nov2026.test.js
new file mode 100644
index 00000000..d28546ac
--- /dev/null
+++ b/tests/seo-jsonld-parity-nov2026.test.js
@@ -0,0 +1,170 @@
+/**
+ * FE-4 (Nov 2026) — JSON-LD parity: the human path copies the prerender's
+ * ld+json blocks byte-for-byte into the shell head, one block per @type.
+ *
+ * Run: node --test tests/seo-jsonld-parity-nov2026.test.js
+ */
+'use strict';
+
+const test = require('node:test');
+const assert = require('node:assert/strict');
+const fs = require('node:fs');
+const os = require('node:os');
+const path = require('node:path');
+
+const ROOT = path.join(__dirname, '..', 'inkcartridges');
+const SRC = fs.readFileSync(path.join(ROOT, 'middleware.js'), 'utf8');
+const HOME_SHELL = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
+const SHOP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'shop.html'), 'utf8');
+const PDP_SHELL = fs.readFileSync(path.join(ROOT, 'html', 'product', 'index.html'), 'utf8');
+const SITE = 'https://www.inkcartridges.co.nz';
+const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
+const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
+
+const block = SRC.slice(SRC.indexOf('// <head-inject>'), SRC.indexOf('// </head-inject>'));
+const { injectLdJson } = new Function(`${block}\nreturn { injectLdJson };`)();
+
+let tmp = null;
+let mw = null;
+async function middleware() {
+    if (mw) return mw;
+    tmp = path.join(os.tmpdir(), `ic-mw-ldjson-${process.pid}-${Date.now()}.mjs`);
+    fs.writeFileSync(tmp, SRC);
+    mw = (await import(`file://${tmp}`)).default;
+    return mw;
+}
+test.after(() => { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); });
+
+// Byte-exact bodies, with odd whitespace on purpose: a re-serialise would change them.
+const body = (o, pad = '\n  ') => `${pad}${JSON.stringify(o, null, 1).replace(/\n/g, pad)}${pad}`;
+const LD = {
+    Organization: { '@context': 'https://schema.org', '@type': 'Organization', name: 'PRE-ORG' },
+    WebSite: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'PRE-SITE' },
+    LocalBusiness: { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'PRE-LB' },
+    CollectionPage: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'PRE-CP' },
+    BreadcrumbList: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] },
+    FAQPage: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] },
+    Product: { '@context': 'https://schema.org', '@type': 'Product', name: 'PRE-P', offers: { price: '34.99' } },
+    ProductGroup: { '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'PRE-PG' },
+};
+const bodies = Object.fromEntries(Object.entries(LD).map(([k, v], i) => [k, body(v, i % 2 ? '\n    ' : '\n  ')]));
+const tag = (t, extra = '') => `<script type="application/ld+json"${extra}>${bodies[t]}</script>`;
+const page = (types, extra = '') => `<!DOCTYPE html><html><head><title>T</title><link rel="canonical" href="${SITE}/x"></head><body><h1>H</h1>${types.map((t) => tag(t)).join('\n')}${extra}</body></html>`;
+// ld blocks of a final document, as [{type,id,body}] — head only.
+const ldOf = (html) => [...html.slice(0, html.toLowerCase().indexOf('</head>')).matchAll(/<script\b([^>]*)type="application\/ld\+json"([^>]*)>([\s\S]*?)<\/script>/g)]
+    .map((m) => ({ type: JSON.parse(m[3])['@type'], id: (/id="([^"]*)"/.exec(m[1] + m[2]) || [])[1], body: m[3] }));
+const typesOf = (html) => ldOf(html).map((b) => b.type).sort();
+
+const req = (p, ua = HUMAN) => ({
+    url: `${SITE}${p}`,
+    method: 'GET',
+    headers: { get: (n) => (String(n).toLowerCase() === 'user-agent' ? ua : null) },
+});
+async function run(p, prerenderBody, { ua = HUMAN, status = 200 } = {}) {
+    const m = await middleware();
+    const original = globalThis.fetch;
+    globalThis.fetch = async (target) => {
+        const u = String(target);
+        if (u.startsWith(SITE)) {
+            const pathname = new URL(u).pathname;
+            const shell = pathname === '/' ? HOME_SHELL : /^\/(products|product|p)\//.test(pathname) ? PDP_SHELL : SHOP_SHELL;
+            return new Response(shell, { status: 200, headers: { 'Content-Type': 'text/html' } });
+        }
+        return new Response(prerenderBody, { status, headers: { 'Content-Type': 'text/html' } });
+    };
+    try { return await m(req(p, ua)); } finally { globalThis.fetch = original; }
+}
+const ALL_SITE = ['Organization', 'WebSite', 'LocalBusiness'];
+
+test('copy: blocks are byte-identical to the prerender, ids reuse the runtime-upserted ids', () => {
+    const r = injectLdJson('<html><head><title>x</title></head><body></body></html>', page([...ALL_SITE, 'CollectionPage', 'BreadcrumbList']), '/api/prerender/category/ink');
+    const got = ldOf(r.html);
+    assert.equal(got.length, 5);
+    for (const g of got) assert.equal(g.body, bodies[g.type], `${g.type} verbatim`);
+    assert.deepEqual(Object.fromEntries(got.map((g) => [g.type, g.id])), {
+        Organization: 'site-jsonld-organization', WebSite: 'site-jsonld-website', LocalBusiness: 'site-jsonld-localbusiness',
+        CollectionPage: 'collection-jsonld-collection-page', BreadcrumbList: 'collection-jsonld-breadcrumbs',
+    });
+    assert.equal(r.skipped, 0);
+});
+
+test('dedupe: the real home shell keeps ONE block per type; its own id survives, unmatched FAQPage stays', () => {
+    assert.equal(typesOf(HOME_SHELL).filter((t) => t === 'Organization').length, 1);
+    const r = injectLdJson(HOME_SHELL, page([...ALL_SITE, 'CollectionPage']), '/api/prerender/home');
+    const got = ldOf(r.html);
+    for (const t of [...ALL_SITE, 'CollectionPage', 'FAQPage']) assert.equal(got.filter((g) => g.type === t).length, 1, t);
+    assert.equal(got.find((g) => g.type === 'Organization').body, bodies.Organization, 'shell org replaced');
+    assert.ok(got.find((g) => g.type === 'FAQPage').body.includes('Question'), 'the shell FAQPage (its own visible FAQ) is kept');
+});
+
+test('dedupe: shop shell #shop-schema CollectionPage is replaced in place (id kept); no second CollectionPage', () => {
+    const r = injectLdJson(SHOP_SHELL, page(['CollectionPage', 'BreadcrumbList']), '/api/prerender/brand/brother');
+    const cps = ldOf(r.html).filter((g) => g.type === 'CollectionPage');
+    assert.equal(cps.length, 1);
+    assert.equal(cps[0].id, 'shop-schema');
+    assert.equal(cps[0].body, bodies.CollectionPage);
+});
+
+test('filter: FAQPage only on category/brand/product routes; never printer or home', () => {
+    const pre = page(['CollectionPage', 'FAQPage']);
+    const has = (p) => ldOf(injectLdJson(SHOP_SHELL, pre, p).html).some((g) => g.type === 'FAQPage');
+    for (const p of ['/api/prerender/category/ink', '/api/prerender/brand/brother?code=LC73', '/api/prerender/product/SKU1']) assert.ok(has(p), p);
+    for (const p of ['/api/prerender/printer/amano/amano-bx3000', '/api/prerender/home']) assert.ok(!has(p), p);
+});
+
+test('bad block: a non-parsing block is skipped and counted; the good ones still go in', () => {
+    const bad = '<script type="application/ld+json">{ not json </script>';
+    const r = injectLdJson('<html><head></head></html>', page(['Organization'], bad), '/api/prerender/category/ink');
+    assert.equal(r.skipped, 1);
+    assert.deepEqual(typesOf(r.html), ['Organization']);
+});
+
+test('no </head> or no blocks: shell returned untouched', () => {
+    assert.equal(injectLdJson('<html>no head', page(['Organization']), '/x').html, '<html>no head');
+    const s = '<html><head><title>a</title></head></html>';
+    assert.equal(injectLdJson(s, '<html></html>', '/x').html, s);
+});
+
+test('middleware: product page gets Product+ProductGroup+Breadcrumb+FAQ once each, header ok', async () => {
+    const res = await run('/products/some-slug/SKU1', page([...ALL_SITE, 'ProductGroup', 'Product', 'BreadcrumbList', 'FAQPage']));
+    assert.equal(res.headers.get('x-head-inject'), 'ok-partial-no-description');
+    const html = await res.text();
+    assert.deepEqual(typesOf(html), ['BreadcrumbList', 'FAQPage', 'LocalBusiness', 'Organization', 'Product', 'ProductGroup', 'WebSite']);
+    assert.equal(ldOf(html).find((g) => g.type === 'Product').body, bodies.Product);
+});
+
+test('middleware: printer page drops FAQPage; bad block reported in X-Head-Inject', async () => {
+    const pre = page(['CollectionPage', 'BreadcrumbList', 'FAQPage'], '<script type="application/ld+json">{oops</script>');
+    const res = await run('/shop?brand=hp&printer_slug=hp-x', pre);
+    assert.match(res.headers.get('x-head-inject'), /-ldjson-skip-1$/);
+    const html = await res.text();
+    assert.deepEqual(typesOf(html), ['BreadcrumbList', 'CollectionPage']);
+    assert.ok(ldOf(html).some((g) => g.id === 'printer-jsonld-breadcrumbs'));
+});
+
+test('middleware: miss behaviour unchanged (500 prerender => untouched shell + miss header)', async () => {
+    const res = await run('/ink-cartridges', 'boom', { status: 500 });
+    assert.equal(res.headers.get('x-head-inject'), 'miss-status-500');
+    assert.equal(await res.text(), SHOP_SHELL);
+});
+
+test('bot path unchanged: Googlebot gets the prerender body itself, no shell, no X-Head-Inject', async () => {
+    const m = await middleware();
+    const original = globalThis.fetch;
+    const urls = [];
+    globalThis.fetch = async (u) => { urls.push(String(u)); return new Response('PRERENDER-BODY', { status: 200, headers: { 'Content-Type': 'text/html' } }); };
+    try {
+        const res = await m(req('/ink-cartridges', GOOGLEBOT));
+        assert.equal(await res.text(), 'PRERENDER-BODY');
+        assert.equal(res.headers.get('x-head-inject'), null);
+        assert.ok(urls.every((u) => !u.startsWith(SITE)), 'no shell fetch');
+    } finally { globalThis.fetch = original; }
+});
+
+test('pin: client code upserts these ids, so injected blocks are replaced, never doubled', () => {
+    const footer = fs.readFileSync(path.join(ROOT, 'js', 'footer.js'), 'utf8');
+    const schema = fs.readFileSync(path.join(ROOT, 'js', 'schema.js'), 'utf8');
+    for (const id of ['site-jsonld-organization', 'site-jsonld-website', 'site-jsonld-localbusiness']) assert.ok(footer.includes(id), id);
+    for (const id of ['collection-jsonld-collection-page', 'collection-jsonld-breadcrumbs', 'printer-jsonld-collection-page', 'printer-jsonld-breadcrumbs']) assert.ok(schema.includes(id), id);
+    // Known gap (shop-page.js, FE-3's file): #shop-schema AND collection-jsonld-collection-page can coexist after JS.
+});
-- 
2.50.1 (Apple Git-155)

~~~~

## 0005-fix-seo-FE-4b-home-FAQPage-JSON-LD-mirrors-the-visib.patch

~~~~diff file=0005-fix-seo-FE-4b-home-FAQPage-JSON-LD-mirrors-the-visib.patch
From d643c0e6fd3dbb4016c5a8d6095bb56deb943940 Mon Sep 17 00:00:00 2001
From: =?UTF-8?q?=EC=A0=84=EB=B3=91=ED=97=8C?=
 <jackson@jeonbyeongheon-ui-MacBookAir.local>
Date: Tue, 24 Nov 2026 19:10:10 +1300
Subject: [PATCH 5/6] fix(seo): FE-4b home FAQPage JSON-LD mirrors the visible
 FAQ

The static FAQPage listed 5 Q&A; 4 appeared nowhere on the page (markup
for content visitors cannot see). The markup is now generated from the
visible FAQ, byte-identical, in both home shells. The visible FAQ copy
is unchanged: no new policy wording ships in this patch. Dropped from
the markup: "minimum order" (its flat-rate claim contradicts the
checkout-calculated rate), a duplicate genuine-vs-compatible Q, and a
"30-day returns policy" limit on faulty goods that the published
/returns and /faq pages contradict (CGA rights have no 30-day window).

Test: tests/home-faq-parity-nov2026.test.js (fails on the old shells).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 inkcartridges/html/index.html         | 20 ++++++++++----------
 inkcartridges/index.html              | 20 ++++++++++----------
 tests/home-faq-parity-nov2026.test.js | 25 +++++++++++++++++++++++++
 3 files changed, 45 insertions(+), 20 deletions(-)
 create mode 100644 tests/home-faq-parity-nov2026.test.js

diff --git a/inkcartridges/html/index.html b/inkcartridges/html/index.html
index b74de19d..0f7e227e 100644
--- a/inkcartridges/html/index.html
+++ b/inkcartridges/html/index.html
@@ -104,42 +104,42 @@
         "mainEntity": [
             {
                 "@type": "Question",
-                "name": "Are compatible ink cartridges as good as genuine?",
+                "name": "What's the difference between genuine and compatible cartridges?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "Our compatible cartridges are designed to work as direct replacements for genuine cartridges and are covered by our returns policy and the NZ Consumer Guarantees Act."
+                    "text": "Genuine (OEM) cartridges are made by the printer manufacturer (e.g. HP, Canon, Brother). Compatible cartridges are made by third-party manufacturers. They're designed to work in your printer and are covered by our returns policy."
                 }
             },
             {
                 "@type": "Question",
-                "name": "How does choosing a compatible cartridge affect my consumer rights?",
+                "name": "How do I find the right cartridge for my printer?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected by your choice of cartridge. The CGA gives you protection for goods that are not of acceptable quality or fit for purpose, regardless of whether you use a genuine or a compatible cartridge."
+                    "text": "Use our \"Find Your Ink Fast\" tool above — select your printer brand, series, and model, and we'll show you every compatible cartridge. Alternatively, you can search by the cartridge code printed on your current cartridge. If you're still unsure, contact us and we'll help you find the right ink."
                 }
             },
             {
                 "@type": "Question",
-                "name": "How fast is delivery?",
+                "name": "How long does delivery take?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "We deliver NZ-wide. Auckland metro orders placed before 12pm on a business day are dispatched the same day. North Island and South Island deliveries usually take 1–3 business days."
+                    "text": "Most NZ addresses receive their order within 1–3 business days. Rural deliveries may take an extra day. Shipping is free on orders over $100 — for smaller orders, rates are calculated at checkout based on your location."
                 }
             },
             {
                 "@type": "Question",
-                "name": "What if my cartridge doesn't work?",
+                "name": "What is your returns policy?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "Contact us. Faulty or incorrectly supplied cartridges are replaced or refunded under our 30-day returns policy and your protections under the New Zealand Consumer Guarantees Act 1993."
+                    "text": "If a product is faulty or doesn't work as expected, we'll replace it at no cost. Simply contact our support team to arrange a return."
                 }
             },
             {
                 "@type": "Question",
-                "name": "Do you have a minimum order?",
+                "name": "How does choosing a compatible cartridge affect my consumer rights?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "No minimum order. Free shipping on orders over $100. A flat shipping rate applies to smaller orders."
+                    "text": "Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected by your choice of cartridge. The CGA protects you against goods that are not of acceptable quality or fit for purpose, regardless of whether the cartridge is genuine or compatible."
                 }
             }
         ]
diff --git a/inkcartridges/index.html b/inkcartridges/index.html
index b014015b..dc1ebd9a 100644
--- a/inkcartridges/index.html
+++ b/inkcartridges/index.html
@@ -142,42 +142,42 @@
         "mainEntity": [
             {
                 "@type": "Question",
-                "name": "Are compatible ink cartridges as good as genuine?",
+                "name": "What's the difference between genuine and compatible cartridges?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "Our compatible cartridges are designed to work as direct replacements for genuine cartridges and are covered by our returns policy and the NZ Consumer Guarantees Act."
+                    "text": "Genuine (OEM) cartridges are made by the printer manufacturer (e.g. HP, Canon, Brother). Compatible cartridges are made by third-party manufacturers. They're designed to work in your printer and are covered by our returns policy."
                 }
             },
             {
                 "@type": "Question",
-                "name": "How does choosing a compatible cartridge affect my consumer rights?",
+                "name": "How do I find the right cartridge for my printer?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected by your choice of cartridge. The CGA gives you protection for goods that are not of acceptable quality or fit for purpose, regardless of whether you use a genuine or a compatible cartridge."
+                    "text": "Use our \"Find Your Ink Fast\" tool above — select your printer brand, series, and model, and we'll show you every compatible cartridge. Alternatively, you can search by the cartridge code printed on your current cartridge. If you're still unsure, contact us and we'll help you find the right ink."
                 }
             },
             {
                 "@type": "Question",
-                "name": "How fast is delivery?",
+                "name": "How long does delivery take?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "We deliver NZ-wide. Auckland metro orders placed before 12pm on a business day are dispatched the same day. North Island and South Island deliveries usually take 1–3 business days."
+                    "text": "Most NZ addresses receive their order within 1–3 business days. Rural deliveries may take an extra day. Shipping is free on orders over $100 — for smaller orders, rates are calculated at checkout based on your location."
                 }
             },
             {
                 "@type": "Question",
-                "name": "What if my cartridge doesn't work?",
+                "name": "What is your returns policy?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "Contact us. Faulty or incorrectly supplied cartridges are replaced or refunded under our 30-day returns policy and your protections under the New Zealand Consumer Guarantees Act 1993."
+                    "text": "If a product is faulty or doesn't work as expected, we'll replace it at no cost. Simply contact our support team to arrange a return."
                 }
             },
             {
                 "@type": "Question",
-                "name": "Do you have a minimum order?",
+                "name": "How does choosing a compatible cartridge affect my consumer rights?",
                 "acceptedAnswer": {
                     "@type": "Answer",
-                    "text": "No minimum order. Free shipping on orders over $100. A flat shipping rate applies to smaller orders."
+                    "text": "Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected by your choice of cartridge. The CGA protects you against goods that are not of acceptable quality or fit for purpose, regardless of whether the cartridge is genuine or compatible."
                 }
             }
         ]
diff --git a/tests/home-faq-parity-nov2026.test.js b/tests/home-faq-parity-nov2026.test.js
new file mode 100644
index 00000000..e244f09c
--- /dev/null
+++ b/tests/home-faq-parity-nov2026.test.js
@@ -0,0 +1,25 @@
+'use strict';
+/* FE-4b (Nov 2026): the home FAQPage JSON-LD must describe exactly the FAQ a
+ * visitor sees. Before this, 4 of its 5 Q&A appeared nowhere on the page. */
+const test = require('node:test');
+const assert = require('node:assert');
+const fs = require('fs');
+const path = require('path');
+
+const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
+
+for (const rel of ['inkcartridges/index.html', 'inkcartridges/html/index.html']) {
+    test(`${rel}: FAQPage Q&A are byte-identical to the visible FAQ, same order`, () => {
+        const html = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
+        const list = html.slice(html.indexOf('class="faq-list"'));
+        const visible = [...list.slice(0, list.indexOf('</section>'))
+            .matchAll(/<summary class="faq-question">([\s\S]*?)<\/summary>\s*<div class="faq-answer">\s*<p>([\s\S]*?)<\/p>/g)]
+            .map((m) => [decode(m[1]), decode(m[2])]);
+        const faq = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
+            .map((m) => JSON.parse(m[1])).filter((d) => d['@type'] === 'FAQPage');
+        assert.equal(faq.length, 1);
+        const marked = faq[0].mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
+        assert.ok(visible.length > 0);
+        assert.deepEqual(marked, visible);
+    });
+}
-- 
2.50.1 (Apple Git-155)

~~~~

## 0006-feat-seo-FE-3b-visible-content-parity-on-ribbons.patch

~~~~diff file=0006-feat-seo-FE-3b-visible-content-parity-on-ribbons.patch
From 90798b4a1a0371598e4d120b746961f55e1963e6 Mon Sep 17 00:00:00 2001
From: =?UTF-8?q?=EC=A0=84=EB=B3=91=ED=97=8C?=
 <jackson@jeonbyeongheon-ui-MacBookAir.local>
Date: Tue, 24 Nov 2026 18:20:39 +1300
Subject: [PATCH 6/6] feat(seo): FE-3b visible content parity on /ribbons

Googlebot's /ribbons page carries a ribbon-buying guide and a 60-item
product list; visitors saw neither (467 words / 0 prices vs 1643 / 60).
/ribbons now joins the FE-3 mirror, which writes the guide and product
list as TEXT into #seo-mirror. The brand picker (the page's own
drilldown) and "Other Categories" link list are skipped, and the intro
and FAQ stay with the existing _setRibbonsCopy, so nothing is shown
twice.

Tests: seo-content-parity-nov2026 (fake-DOM render of the ribbons
mirror + the container pin); both fail without this change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
---
 inkcartridges/html/ribbons.html          |  5 +++
 inkcartridges/js/seo-meta.js             | 11 +++---
 tests/seo-content-parity-nov2026.test.js | 44 +++++++++++++++++++++++-
 3 files changed, 55 insertions(+), 5 deletions(-)

diff --git a/inkcartridges/html/ribbons.html b/inkcartridges/html/ribbons.html
index f6c15180..799bf1ac 100644
--- a/inkcartridges/html/ribbons.html
+++ b/inkcartridges/html/ribbons.html
@@ -309,6 +309,11 @@
             </div>
         </div>
 
+        <!-- FE-3b (visible content parity): the prerender's ribbon guide and
+             product list, written as TEXT by SeoMeta._renderMirror. Intro + FAQ
+             stay in #ribbons-intro / #ribbons-faq-list. -->
+        <section class="container seo-mirror" id="seo-mirror" data-mirror="static" aria-label="About these ribbons" hidden></section>
+
         <section class="container ribbons-faq" id="ribbons-faq" aria-labelledby="ribbons-faq-heading">
             <h2 id="ribbons-faq-heading" class="ribbons-faq__title">Frequently asked questions</h2>
             <div class="faq-list" id="ribbons-faq-list">
diff --git a/inkcartridges/js/seo-meta.js b/inkcartridges/js/seo-meta.js
index e1a5eb91..cb19a887 100644
--- a/inkcartridges/js/seo-meta.js
+++ b/inkcartridges/js/seo-meta.js
@@ -874,7 +874,7 @@ const SeoMeta = {
     },
 
     // ── FE-3: visible mirror of the prerender body on listing pages ──────────
-    MIRROR_SURFACES: ['category-ink', 'category-toner', 'category-receipt', 'brand'],
+    MIRROR_SURFACES: ['category-ink', 'category-toner', 'category-receipt', 'brand', 'category-ribbons'],
 
     _mirrorEl() { return (typeof document === 'undefined' || typeof document.getElementById !== 'function') ? null : document.getElementById('seo-mirror'); },
 
@@ -922,13 +922,16 @@ const SeoMeta = {
             return;
         }
         const path = String(prerenderPath || '');
-        const tilesShown = /\/category\/(ink|toner)$/.test(path) || /\/brand\/[^/?]+$/.test(path);
+        // /ribbons (FE-3b): the brand picker is the page's own drilldown and the
+        // intro + FAQ are already written by _setRibbonsCopy; mirror the rest.
+        const ribbons = /\/category\/ribbons$/.test(path);
+        const tilesShown = ribbons || /\/category\/(ink|toner)$/.test(path) || /\/brand\/[^/?]+$/.test(path);
         const lp = document.getElementById('level-products');
         const listShown = /\/category\/receipt$/.test(path) || /[?&]code=/.test(path) || (lp && !lp.hidden);
         const skipped = [];
         const frag = document.createDocumentFragment();
         const h = (tag, text, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; n.textContent = text; return n; };
-        if (head.intro) frag.appendChild(h('p', head.intro, 'seo-mirror__intro'));
+        if (head.intro && !ribbons) frag.appendChild(h('p', head.intro, 'seo-mirror__intro'));
         for (const sec of c.sections || []) {
             if (sec.linkList && tilesShown) { skipped.push('tiles'); continue; }
             const box = document.createElement('section');
@@ -968,7 +971,7 @@ const SeoMeta = {
                 frag.appendChild(box);
             }
         }
-        if (Array.isArray(head.faq) && head.faq.length) {
+        if (!ribbons && Array.isArray(head.faq) && head.faq.length) {
             const box = document.createElement('section');
             box.className = 'seo-mirror__section seo-mirror__faq';
             box.appendChild(h('h2', c.faqTitle || 'Frequently asked questions', 'seo-mirror__title'));
diff --git a/tests/seo-content-parity-nov2026.test.js b/tests/seo-content-parity-nov2026.test.js
index 008f80f6..7393ff80 100644
--- a/tests/seo-content-parity-nov2026.test.js
+++ b/tests/seo-content-parity-nov2026.test.js
@@ -113,10 +113,52 @@ test('route coverage: each listing surface gets a prerender path and mirrors', (
     }
     // printer pages are already at parity: left alone
     assert.ok(!SeoMeta.MIRROR_SURFACES.includes('printer'));
-    assert.ok(!SeoMeta.MIRROR_SURFACES.includes('category-ribbons'));
+    // /ribbons mirrors guide + products only (FE-3b); see the ribbons test below
+    assert.ok(SeoMeta.MIRROR_SURFACES.includes('category-ribbons'));
 });
 
 test('shop.html carries the mirror container, hidden + static until populated', () => {
     const html = fs.readFileSync(path.join(ROOT, 'html/shop.html'), 'utf8');
     assert.match(html, /<section[^>]*id="seo-mirror"[^>]*data-mirror="static"[^>]*hidden/);
 });
+
+test('FE-3b /ribbons: mirror shows guide + product list, never a second intro, FAQ or brand picker', () => {
+    // Minimal DOM: enough for _renderMirror (createElement, append, textContent).
+    const mk = (tag) => {
+        const n = { tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, className: '', _t: '',
+            appendChild(c) { if (c.isFrag) this.children.push(...c.children); else this.children.push(c); return c; },
+            append(...cs) { cs.forEach((c) => this.appendChild(c)); },
+            get firstChild() { return this.children[0] || null; },
+            get textContent() { return this._t + this.children.map((c) => c.textContent).join(' '); },
+            set textContent(v) { this._t = v; this.children = []; } };
+        return n;
+    };
+    const el = mk('section'); el.hidden = true;
+    const saved = global.document;
+    global.document = {
+        createElement: mk,
+        createDocumentFragment: () => Object.assign(mk('#frag'), { isFrag: true }),
+        createTextNode: (t) => ({ textContent: t }),
+        getElementById: (id) => (id === 'seo-mirror' ? el : null),
+    };
+    try {
+        const html = '<main><section><h2>Shop Printer Ribbons by Brand</h2><ul><li><a href="/ribbons?brand=epson">Epson</a></li></ul></section>'
+            + '<section><h2>How to Choose the Right Ribbon</h2><p>Match the ribbon code on your old ribbon.</p></section>'
+            + '<section><h2>All Printer Ribbons</h2><ul><li class="product-card"><a href="/products/x/Y"><h3>Epson ERC-30 Ribbon</h3></a><p>$9.95 incl. GST</p></li></ul></section></main>';
+        const head = { intro: 'INTRO-TEXT', faq: [{ q: 'FAQ-Q', a: 'FAQ-A' }], content: SeoMeta.extractContent(html) };
+        SeoMeta._renderMirror(head, '/api/prerender/category/ribbons');
+        const text = el.textContent;
+        assert.match(text, /How to Choose the Right Ribbon/);
+        assert.match(text, /Epson ERC-30 Ribbon/);
+        assert.match(text, /\$9\.95 incl\. GST/);
+        assert.doesNotMatch(text, /INTRO-TEXT|FAQ-Q|Shop Printer Ribbons by Brand/);
+        assert.equal(el.hidden, false);
+        assert.equal(el.dataset.mirror, 'prerender');
+    } finally { global.document = saved; }
+});
+
+test('ribbons.html carries the mirror container before its FAQ, hidden + static until populated', () => {
+    const html = fs.readFileSync(path.join(ROOT, 'html/ribbons.html'), 'utf8');
+    assert.match(html, /<section[^>]*id="seo-mirror"[^>]*data-mirror="static"[^>]*hidden/);
+    assert.ok(html.indexOf('id="seo-mirror"') < html.indexOf('id="ribbons-faq"'));
+});
-- 
2.50.1 (Apple Git-155)

~~~~

