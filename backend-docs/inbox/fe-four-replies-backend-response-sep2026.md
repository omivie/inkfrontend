# Backend response to the FE's four replies of 28 Sep 2026

**From:** backend · **For:** FE developer · **Date:** 2026-09-28
**Answers:** `backend-move-FE-reply-sep2026.md`, `fe-replies-round-FE-reply-sep2026.md`, `post-deploy-fixes-FE-reply-sep2026.md`, `remove-popular-rows-FE-reply-sep2026.md`
**Backend build measured:** `ef47bc6` on `api.inkcartridges.co.nz` (contains `c1cabaf`, which carries every change below). All measurements taken on production on 2026-09-28 between 06:30 and 06:50 UTC.

Thank you for measuring every claim before building on it. Every ask is answered below: built, declined with a reason, or waiting on the owner.

---

## 0. Two ask numbers were used twice

Your two replies both assign **BF-080** and **BF-081**, to different asks:

| Number | In `fe-replies-round` reply | In `backend-move` reply |
|---|---|---|
| BF-080 | the genuine feed failed with `errors: 0` | `description_html` + `related_product_skus` on `/api/ribbons/:sku` |
| BF-081 | image-audit `brand` accepts a slug only | ribbon `series_codes` rule |

Below they are written as **BF-080 (feed)**, **BF-080 (ribbon fields)**, **BF-081 (image audit)** and **BF-081 (ribbon codes)**. We suggest renumbering the backend-move asks BF-084 to BF-087 in your log (BF-080 to BF-083 in that reply, in order), so each number means one thing.

---

## 1. Backend move + page speed

| Ask | Status | Measured on production |
|---|---|---|
| **Old host can go** | **Agreed. It will be suspended once it has had no real traffic for 24 hours, not before 2026-09-29 03:45 UTC.** | Render request logs for `ink-backend-zaeq`: the last request that was not the `GET /` pinger was `GET /llms.txt` at **03:45:29 UTC**. Since then only the pinger has called it. The owner is repointing the pinger to `https://api.inkcartridges.co.nz/health`. The old service will be suspended, not deleted, so it can come back if something we have not seen still calls it. |
| **BF-080 (ribbon fields)** | **Built.** | `GET /api/ribbons/72200.01` now returns `description_html` (142 characters) and `related_product_skus: ["72200.02"]`, the same fields as `/api/products/:sku`. |
| **BF-081 (ribbon codes)** | **Built.** A ribbon row (`printer_ribbon`, `typewriter_ribbon`, `correction_tape`) carries only its `product_codes` override, else `series_codes: []`. | `72200.01` and `691.01` return `[]` on both `/api/ribbons/:sku` and `/api/products/:sku`. The override ribbon `C-OKI-720-RIB-BK` returns `["720"]`. The same rule applies on `/api/products` and `/api/shop`. It applies to the emitted field only. Chip maps, `?code=` filtering and `sitemap-series.xml` still derive codes, because they key live, sitemapped family URLs. |
| **BF-082** (`chip_category`) | **Built.** `/api/shop?brand&category&code` adds products of another type that are tagged into this category's chip, and counts them in `series`. | There are 0 such rows today, so nothing changes on the live site until an admin tags one. The behaviour is pinned by `__tests__/shop-cross-type-chip-tags.test.js`. You can drop the `product_code_visitors` / `product_codes` reads. |
| **BF-083** (`include=literal` on `/search/smart`) | **Declined.** | See below. |
| Row count | Noted. | `product_codes` now holds **32** rows over 20 products, 1 of them inactive. |

**Why BF-083 is declined.** The literal-match rows are needed only when `/smart` misses or corrects the query. Returning them inside `/smart` means either every digit search pays for two extra queries on the server, or `/smart` has to guess in advance whether the repair will fire, and that guess is the logic that already lives in your client. Your parallel prefetch costs no wall-clock time, and the owner has accepted the two extra reads. On analytics: every `search_analytics` row carries its `endpoint`. The zero-result audit reads `endpoint = 'smart'` only, so your extra `/suggest` row does not reach it. The admin search overview counts all endpoints, and already counted typeahead calls, so one more row per digit search does not change what it measures. If that ever matters, we filter the overview on our side. Nothing changes for you.

## 2. Your response to our four replies

| Ask | Status | Measured on production |
|---|---|---|
| **BF-079** (`/api/products` dropped two packs at `limit` ≥ 100) | **Fixed.** | `?limit=200&page=9` returns 200 rows and includes `G252VPVP`. `?limit=200&page=13` returns 200 rows and includes `G728300MLCMY`. `meta.total` is 4,114 on both. Your guess was right: the page-local pack dedup ran after `range()`. It read "Epson Genuine 252 … HY 4-Pack" as a standard pack, and "300ml" as a model code, so each pack collided with a cheaper pack on the same page. Pack identity is now the yield tier plus the ink volume, and a volume is never a model code. Replayed over all 871 active packs, the false drops went from 3 to 0. Your `rows ≠ meta.total` probe should now pass. |
| **BF-080 (feed)** | **Fixed.** A failed run now records why, in `import_runs.error_message`, and `/admin/supplier/import-status` returns it on every run. | **09-23:** the genuine step hit its own 45-minute timeout. Runs take 27–41 minutes and are getting longer, so the limit is now 60 minutes. **09-26:** a deploy restarted the server during the run and killed it. The next night's sweep found it and marked it failed, so its `finished_at` is when the failure was DETECTED. That is the 24-hour "duration" you saw. Our push gate now refuses pushes between 13:55 and 15:30 UTC, the import window. The two old rows carry the older generic texts ("Parent process: import-all.js killed by timeout" and "Detected abandoned run …"). Future failures state the step and its limit. |
| **BF-081 (image audit)** | **Fixed.** `brand` on `/image-audit/list` and `/image-audit/stats` accepts a slug or an id. Any other value is `400 UNKNOWN_BRAND`, never a 404. | This is the same resolver as `/api/admin/products` (`src/utils/brandFilter.js`). Pinned by `__tests__/adminImageAuditExtensions.test.js`. |
| (a)–(k), Dymo, owner decisions, BF-064/068/069, ERR-283 | Acknowledged. | Nothing more is needed from either side. |

## 3. Post-deploy fixes

| Ask | Status | Measured on production |
|---|---|---|
| **BF-077** (a live review token for a test order) | **Waiting on the owner.** | There is no test order to issue one for. The owner's only own order is cancelled, and the token route refuses an order that has not been paid (it accepts paid, processing, shipped, delivered and completed). The owner will place one $0.50 order for the admin-only product `TEST-ADMIN-001` through live checkout. It is flagged `is_test_order`, so it stays out of revenue, analytics and ad conversions. We then send you a token for it. |
| **BF-078** (does the cart's `delivery_estimate` carry `promise`?) | **Yes, live.** | `GET /api/cart` returns `delivery_estimate.promise`: "Order by 2pm for same-day dispatch (Auckland metro) — 1–4 business days NZ-wide". The cart line is shorter than the PDP's, but both name "Auckland metro", so your shared `DispatchCountdown.scope` rule scopes the cart countdown too. |
| Correction 1: the "Email me a copy of my cart" box has never been shown | **Confirmed, and now an owner decision.** | 0 rows in `guest_sessions` carry `contact_consent_at`, so no guest has ever consented, and guest cart reminders have sent nothing. The endpoint and the reminder email are live and wait on your flag. We have asked the owner (see §6). |
| Correction 2: `CTN2450` does not exist | **Our error.** | The part is `CTN2445BK`. Thank you for running the check on the right SKUs. |
| Item 2 (desktop Add to Cart) | **Confirmed on production.** | `CTN2345BK` at 1440×900, first visit: Add to Cart sits at y 689–737, and `elementFromPoint` at its centre returns the button. |

## 4. Popular and colour-set rows

| Item | Status | Measured on production |
|---|---|---|
| Endpoints | **Deleted** in `c1cabaf`. | `GET /api/products/popular` → 404. `GET /api/search/popular` → 404. |
| Rows | **Confirmed gone.** | `/ink-cartridges` renders no heading matching "Popular" or "Full colour sets", and makes no `popular` or `pack=value_pack` request. |
| Printer page "Colour Pack Bundles" | **Delete the block and its request.** | The endpoint it calls no longer exists. `GET /api/printers/:slug/color-packs` and `GET /api/products/printer/:slug/color-packs` both return 404; the route was removed on 2026-04-01 (`98ab64e`). That is why it never rendered on the page you measured. The printer's packs already come back in the printer product list. |

## 5. Turnaround doc (`fe-turnaround-fixes-sep2026.md`): still open

Re-measured on production at 06:45 UTC today:

| # | Item | What production does now |
|---|---|---|
| **P0** | `/shop?search=` / `?q=` noindex | `/shop?search=black` still emits `<meta name="robots" content="index, follow">`, to both a browser and Googlebot. This is the main Soft 404 source. |
| **P0** | Old-site slug redirect keeps the part number | `/fuji-xerox-ct201304-toner-cartridge-cyan` → 308 `/shop?search=cyan`; `/brother-lc73-inkjet-cartridge-black-lc73bk` → 308 `/shop?search=black-lc73bk`. |
| 9 | PDP details | `CTN2345BK` shows "Fits Brother Brother HL L2300D, …" and "Model: IBTN2345". The fit line prints "Brother MFC L2740DW", without the Brother hyphen. |
| 10 | `/business` Apply | The page has an "Apply" button in the DOM, but it is not displayed. The only visible actions are "Request a business quote" and "Sign in". |
| P2 | Apex redirect (**yours**, Vercel) | `https://inkcartridges.co.nz/` → **307** to www, and `http://inkcartridges.co.nz/` takes two hops (308 to https apex, then 307). Please change it in Vercel: storefront project → Settings → Domains → `inkcartridges.co.nz` → Edit → redirect to `www.inkcartridges.co.nz` with **308 Permanent**. Done when `curl -sI https://inkcartridges.co.nz/` shows `308` with `location: https://www.inkcartridges.co.nz/`. A 307 tells Google the apex is temporary, so it keeps crawling both hosts. |

Now done: #4, the printer URL shell no longer emits a `/shop` canonical, and `/html` → 308 to `/`.

## 5a. New from our Playwright re-check of the live site (28 Sep, 07:10 UTC)

Two issues were ours, and both are fixed and deployed:
- **"canon pg540" was answered with one unrelated cyan cartridge.** The spelling correction rewrote the query to the nearest product name ("CLI681XXLC … Cyan") before the regional-alias check ran. Now a query with a regional alias code is never auto-corrected. The response carries `alias_suggestion` + `alias_results`, with no `corrected_from` or `did_you_mean`, and `products` is empty (total 0) because the searched code has no rows of its own. So until you render the alias, that search shows your zero-results page.
- **Renamed products kept their old page title.** 27 HP compatible XL products renamed today (for example `C65XLBK`) were still titled "HP 65 …", and 16 Lexmark drum/developer units were titled "Toner Cartridge" (45 rows in all). The stale stored titles are cleared, so `seo.title` is generated from the current name ("HP 65XL Ink Cartridge Black - Compatible").

For the frontend:

| # | Page | What we saw | Ask |
|---|---|---|---|
| a | Printer page | Calls `/api/products/printer/<slug>/color-packs` → 404 on every load. | Remove it (see §4). |
| b | A PDP reached through a redirect (`/products/x/C65BK`) | `for-use-in` is requested with the OLD SKU (`/api/products/C65BK/for-use-in`, `…/G3YP09AACMYK/for-use-in`), gets 404, and requests it again. | Use the SKU from the product response, not the one in the URL. |
| c | `/ink-cartridges`, `/toner-cartridges` | Both show the same brand counts (HP 870), the TOTAL across categories. The toner page lists Dymo 103. | `GET /api/products/counts?brands=` already returns per-category counts (`{"hp":{"ink":400,"toner":430,…},"dymo":{"label":103}}`). Read `data[brand].ink` on the ink page, `.toner` on the toner page, and hide a brand with 0. |
| d | Printer page (browser) | H1 is the generic "Shop Ink Cartridges & Toner NZ". A crawler gets "Brother HL-L2375DW Toner NZ". | Render the printer H1 in the SPA too (turnaround doc #9). A visible page that differs from the crawled one is what Google's cloaking check looks for. |
| e | Search "canon pg540" | No alias banner or alias rows (turnaround doc #6). | Render `alias_suggestion.note` above `alias_results`. |
| f | Section headings | "Compatible Compatible Cartridges" (the eyebrow label is inside the `h2`). `/ribbons` shows "Typewriter & Printer Ribbons" twice. | Cosmetic. |

Confirmed working in the same run: desktop and mobile Add to Cart are clickable with the consent banner showing. "canon 540" leads with CLI521/PGI520. "canon pg640" lists 5 PG640 products. `/cart?add=CTN2345BK:1` fills the cart and drops `add=` from the URL. `/review?token=…` shows the expired message for a bad token. `/value-packs` keeps its heading. `/bulk-pricing` states the 3+ rule. Old SKUs and slugs 301 to the new URLs.

## 6. For the owner (not the FE)

1. Place one $0.50 test order for `TEST-ADMIN-001` so we can issue the BF-077 token.
2. Decide whether to turn on the guest "Email me a copy of my cart" box. It is an unticked box, so any consent it collects is express. Until it is on, guest cart reminders reach nobody.
3. Repoint the `GET /` pinger from `ink-backend-zaeq.onrender.com` to `https://api.inkcartridges.co.nz/health`. After 2026-09-29 03:45 UTC, suspend (do not delete) the old Oregon service.
