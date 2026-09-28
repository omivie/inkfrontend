# Backend move + page speed — FE reply, 2026-09-28

**From:** frontend · **Answers:** `inbox/fe-handoff-page-speed-and-backend-move-sep2026.md` (2026-09-28)
**FE record:** ERR-292 in `errors.md`
**New asks:** BF-080, BF-081, BF-082, BF-083 (§3 below)

Thank you for this handoff, and for checking the live site after the move. Before we built on any
claim, we measured it. `npm run probe:backend-move` is READ-ONLY. It checks every claim below
against the live API and prints where one does not hold. `tests/backend-move-sep2026.test.js` pins
the code side. Every new test was run against the previous code and fails there, except the ones
labelled PRESERVED.

---

## 1. The seven items

| # | Item | Status | Measured |
|---|---|---|---|
| 0 | **Vercel → `ink-backend-sg`** | **Live since commit `eae0781`.** Items 1–6 went live in `13595a7` (with ERR-292's log entry in `6aef5f40`). It covers `middleware.js`, every Render-bound rewrite in `vercel.json` (sitemaps, the three feeds, robots, llms, `/p`, `/html/p`, `/shop`, `/html/shop`, `/product-by-name`), CSP `connect-src`, and the four non-production fallbacks. It also covers ~40 probe defaults. | Before the switch, all 15 rewrite paths returned the same bytes on both hosts. The one exception is `google-promotions.xml`, which differs only in its generation timestamps. After the deploy, `www…/sitemap.xml`, `/robots.txt` and `/feeds/google-shopping.xml` return 200. Googlebot-UA fetches of `/`, `/shop?brand=hp` and a product page return the prerendered HTML. **From our side, the old host can go.** The `GET /` pinger is the owner's; they are repointing it to `https://api.inkcartridges.co.nz/health`. |
| 1 | **Search: stop chaining** | **Built, but not as asked (see §2.1).** | For a query with a digit, or an exact search, `/products?search=` and `/search/suggest` now start together with `/search/smart`. |
| 2 | **PDP gallery from the product response** | **Built.** The gallery renders as soon as `/api/products/:sku` returns. The hero image is also preloaded from `pdp-prefetch.js` (in `<head>`) the moment the prefetched response lands. | Local run, first visit, 390×664: the first image request starts **11 ms after the product response** (the handoff measured 1.4 s). The hero is downloaded **exactly once**: the preload and the `<img>` use the same URL. For-use-in no longer gates the gallery. |
| 2a | Direct Supabase reads on the PDP | **Non-ribbon: all four removed.** Ribbons: two kept (§2.2). | `probe:backend-move` §O: **19/19** active override products carry their override as `series_codes` on `/api/products/:sku`, and are listed under every override code by `/api/shop?brand&category&code`. |
| 2b | `/reviews/summary` | **Kept.** It carries the per-star breakdown. `review_count`/`average_rating` can draw the headline, but not the bars. | — |
| 3 | **Brand page: schema + prerender** | **Built.** We removed the `/api/ribbons?printer_brand=&limit=1` call **entirely**, and the schema now starts before the level loads. | That count fed a ribbons tile that **never renders**: the brand page filters `ribbons` out (they are reached from the nav only). We took out one request, not only its wait. `/api/prerender/brand` is fetched by `SeoMeta.reconcile` after the level renders. It no longer waits for ribbons, because nothing does. |
| 4 | **`site_settings` → `/api/site/lock`** | **Live since commit `eae0781`.** It fails open on every failure (network, non-2xx, `ok:false`, no `data`), as before. | `/api/site/lock` equals `site_settings.site_locked`. Note: a lock or unlock now takes up to 60 s to reach shoppers (`s-maxage=60`). |
| 4 | **`ribbon_brands` → `/api/site/nav`** | **Built.** `ribbon_brands: null` or absent falls back to the direct read and logs a warning. `[]` is treated as an answer. | 63/63 rows identical to the direct read, in the same order. The mega-nav already calls `/api/site/nav` on every page through the same deduplicated cache entry, so this read now costs **no** request. |
| 4 | supabase-js on every page | **Stays.** | `auth.js` needs it on every page: the header login state, the cart and API tokens all go through it. Removing these two reads does not free it. |
| 5 | **GCR badge** | **Built.** `platform.js` loads only after the `load` event, when the browser is next idle (5 s ceiling) or on the first scroll, tap or key. On `/order-confirmation` it loads at once. | We also fixed a bug: the confirmation page called `gapi.surveyoptin.render` directly, which skipped the consent gate. When its data arrived after `platform.js` had loaded, it never rendered at all. It now goes through the one gated renderer. |
| 6 | **Skip `GET /api/cart`** | **Built.** The call is skipped only with no login, no `ink_guest_session_id`, no local lines and no pending removal. | Local lines without a session (a failed first add) still take the read-then-re-push path. The first add still creates the session, because the server mints it. |

## 2. Where the handoff did not hold

1. **§1: "every search makes three requests" is not true.**
   - `/products?search=` and `/suggest` run only when `/smart` misses, or when it autocorrects a query and none of its rows match what was typed (`hardMiss`/`softMiss`/`hijack`/exact).
   - On those paths they are the literal-match repair: q=511 became "Lexmark MX 511", and q=650 missed PGI650 (ERR-133/144/264). Dropping them would bring those bugs back.
   - Most searches already make one request.
   - We start both early on digit and exact queries, and discard them when no repair fires. That costs two extra reads per digit search, one of which is an extra `/suggest` analytics row. The owner accepted this cost.
   - **BF-083** proposes the permanent fix.
2. **§2 ribbons: `GET /api/ribbons/:sku` does not carry `description_html` or `related_product_skus`.**
   - It was missing on 8 of 8 sampled ribbons, and the ribbon PDP reads that endpoint. Example: 72200.01 has a 142-character description.
   - So the ribbon PDP keeps its direct Supabase enrich. **BF-080.**
3. **§2 ribbons: override-aware `series_codes` still gives a ribbon with NO override its derived codes.**
   - Examples: 691.01 gets `LZ24`, 72200.01 gets `DIN2103`. 6 of 8 sampled ribbons were like this.
   - The owner's rule (ERR-086) is that a ribbon carries only the codes the owner assigned. So for ribbon rows only, we still read `product_codes` to learn whether an override exists. **BF-081.**
4. **§2: the handoff does not mention cross-type tags (`product_codes.chip_category`).**
   - Example: a drum ticked into the TN155 toner chip. `/api/shop?category=toner&code=TN155` cannot return a drum.
   - There are 0 such rows today, but the admin can create one at any time.
   - We keep that recovery, gated on the brand's `product_code_visitors` summary, so today's data makes no per-code read. **BF-082.**
5. **Row count:** `product_codes` has **33** rows over 20 products, one of them inactive. The handoff says 32. The difference is the inactive product.

## 3. New asks

- **BF-080: add `description_html` and `related_product_skus` to `GET /api/ribbons/:sku`**, the same fields as `/api/products/:sku`. Then the ribbon PDP drops its last direct Supabase read.
- **BF-081: apply the ribbon rule to `series_codes`.** A ribbon row (`printer_ribbon`, `typewriter_ribbon`, `correction_tape`) with no `product_codes` override should carry `series_codes: []`, not the derived codes. This applies on `/api/products/:sku`, `/api/products`, `/api/shop` and `/api/ribbons/:sku`. Then the storefront stops reading `product_codes` altogether.
- **BF-082: honour `chip_category` in `/api/shop?brand&category&code`.** It should include products of another type that are tagged into this category's chip, and `series` should count them. Then the last `product_code_visitors` / `product_codes` reads go.
- **BF-083: return the literal-match set with `/search/smart` when it would be needed.** One option is `include=literal`, returning the `/products?search=` rows and the suggest shortlist whenever `/smart` corrected the query or returned fewer than 50 direct rows. Then a digit search is one request, with nothing wasted when the repair does not fire.

## 4. Measured on production after the deploy

`npm run probe:backend-move -- --browser`, 2026-09-28: **53/53**.

| Page | What we measured |
|---|---|
| PDP `C02BK` | The product arrives 815→1352 ms, and the first image starts at **1353 ms**, 1 ms later (your waterfall: 2.74 s → 4.16 s). The hero is downloaded once. There is no `/api/cart` call and no `site_settings`/`ribbon_brands` read. `platform.js` starts at 1686 ms (DCL 1470 ms). LCP 1116 ms on one load (yours: 4.70 s). |
| `/shop?brand=brother` | There is no `/api/ribbons` call. `/api/schema/collection` starts at 748 ms, together with `/api/shop` (748→857 ms). LCP 888 ms. |
| Search, digit query | `/products?search=` and `/suggest` start at 760 ms, together with `/smart` (761→1156 ms). |

These are single loads without CPU throttling, and your API is faster since the move. So the LCP figures show the direction of the change; they do not measure the frontend change on its own. The search load used a zero-result `zzprobe_` term (so it is excluded from analytics), so its LCP is not comparable to your `tn2450`.

One direct read remains on a non-ribbon PDP: `product_code_visitors`, which is the cross-type summary. BF-082 removes it.

## 5. How to check

```sh
npm run probe:backend-move                       # §H hosts, §L lock, §N nav, §O every override row, §R ribbons
npm run probe:backend-move -- --browser          # + §W first-visit waterfall on the live site
node --test tests/backend-move-sep2026.test.js
```
