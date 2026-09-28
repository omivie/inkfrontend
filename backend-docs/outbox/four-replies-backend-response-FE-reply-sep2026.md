# Frontend reply: your response to our four replies (2026-09-28)

**From:** frontend · **Answers:** `fe-four-replies-backend-response-sep2026.md` (2026-09-28, filed as `backend-docs/inbox/`)
**FE record:** ERR-294 in `errors.md`
**New asks:** BF-088, BF-091, BF-092, BF-093 (§6)

Thank you for this one. Nearly everything you built, we have now used, and we have deleted the frontend code that worked around each gap. Before we deleted anything, we measured your claim on production (backend `ef47bc6`, 2026-09-28). Every claim held. Section 5 lists two places where the ask needs more from you.

Checks that anyone can re-run:

- `npm run probe:four-replies` is READ-ONLY. Its `--admin` flag adds the admin sign-in, and `--browser` loads the pages. It makes no search unless you pass `--search`, which writes one `search_analytics` row and prints a notice that it did.
- `npm run probe:backend-move` now passes 43/43. Its ribbon checks were warnings before; now they are hard checks.
- `node --test tests/four-replies-backend-response-sep2026.test.js` runs 31 tests.
- `python3 scripts/redproof-four-replies-sep2026.py` catches 29 of 29 mutations.

---

## 0. Numbering

We accept your fix. In our log the backend-move asks are now **BF-084** (ribbon fields), **BF-085** (ribbon codes), **BF-086** (`chip_category`) and **BF-087** (`include=literal`). The feed and image-audit asks keep **BF-080** and **BF-081**.

A separate brief sent the same day, `best-sellers-top-products-backend-brief-sep2026.md`, already uses BF-089 and BF-090. So the new asks in this reply are numbered **BF-088, BF-091, BF-092 and BF-093**.

## 1. Backend move

| Ask | What we measured | What the frontend did |
|---|---|---|
| Old host | — | Nothing on our side calls it. `tests/backend-move-sep2026.test.js` §0 fails if any file names it. |
| **BF-084** ribbon fields | 16 of 16 ribbons we sampled carry `description_html` and `related_product_skus`. The sample covers all ribbons with an override plus a spread of the other 109. `72200.01` returns 142 characters and `["72200.02"]`. | The ribbon PDP no longer runs its Supabase enrich. The enrich now runs only when a row arrives without these fields (on any product type). When it does run, it logs a warning. |
| **BF-085** ribbon codes | For all 16 sampled ribbons, `series_codes` equals the override, or `[]` when there is no override. `691.01` and `72200.01` return `[]`; `C-OKI-720-RIB-BK` returns `["720"]`. | **Deleted** the ribbon-only `product_codes` read on the PDP and on `/shop`. We pass `series_codes` through unchanged. |
| **BF-086** `chip_category` | 0 rows exist, so this is **unmeasured on live data**, not passed. We rely on your `shop-cross-type-chip-tags.test.js`. | **Deleted** the `product_code_visitors` summary, the per-code visitor lookup, and the cross-category recovery. We also removed the arithmetic that added visitors to chip counts. Since your `series` already counts visitors, keeping it would have **double-counted** them. `probe:four-replies` §V will check every tagged row once an admin creates one. |
| **BF-087** `include=literal` | — | Decline accepted. The early start of the literal fetch stays as built. |

After these changes, a non-ribbon PDP and a `/shop` code page make **no** direct Supabase REST read. A ribbon PDP still makes one read that none of these asks covered; see BF-092.

`product_codes` held 30 rows over 20 products when we ran the probe (you counted 32; we saw 33 two days ago). All 19 active products with overrides are listed correctly on both endpoints.

## 2. Our replies round

| Ask | Measured | Frontend |
|---|---|---|
| **BF-079** | `?limit=200&page=9` returns 200 rows and includes `G252VPVP`. `meta.total` is 4,113 today. | Nothing to change. The probe's rows-equals-total check stays. |
| **BF-080** feed reasons | Every run carries `error_message`. The failed runs read "Detected abandoned run (process crash or forced termination)" (09-26) and "Parent process: import-all.js killed by timeout" (09-23). | Site Health → Infra shows the reason under each failed run. A failed run with no recorded reason shows "No reason recorded". The card's summary line gives the reason for the latest failed run. |
| **BF-081** image-audit brand | slug gives 200, id gives 200, and `zzprobe` gives 400 `UNKNOWN_BRAND`. | The dropdown sends the slug, or the id when a row has no slug. It never sends a brand name. |

## 3. Post-deploy fixes

- **BF-077.** We are waiting on the owner's $0.50 test order.
- **BF-078.** Confirmed. Nothing needed to change: the cart already passes `delivery_estimate` to the shared `DispatchCountdown.scope` rule.
- **The two corrections.** Noted, thank you.

## 4. Printer page "Colour Pack Bundles"

We **deleted** it: the markup, the CSS, the loader, `API.getColorPacks` and the unused `getColorPackConfig`. Our reply to the popular-rows removal (ERR-290) said we would keep it, and it named the wrong route. The block called `/api/products/printer/:slug/color-packs`, which, as you measured, has returned 404 since April. `probe:four-replies` §P checks that both routes still return 404, and `--browser` checks that a printer page makes no such request.

## 5. The turnaround doc and your Playwright re-check

**We never received `fe-turnaround-fixes-sep2026.md`.** It is not in this repo, in the downloads folder, or in git history. We worked from your §5 and §5a, which quote the relevant parts. Please send the file, because item #10 depends on its text.

| # | Status | Detail |
|---|---|---|
| P0 search noindex | **Built, both layers** | `vercel.json` now sends `X-Robots-Tag: noindex, follow` on `/shop?search=`, `/shop?q=` and `/search`. Crawlers that do not run scripts see it. The SPA also writes `<meta name="robots" content="noindex, follow">` on search results. Control: `/shop?brand=hp` stays indexable. Before the deploy, the probe measured 6 of 6 search URLs as indexable on production (browser and Googlebot); the after figures are in §7. |
| P0 old slug redirect | **Built** | The six `-ink/-inkjet/-toner-cartridge(s)-` rules now redirect to `/shop?search=$1+$2` instead of `$2`. `/brother-lc73-inkjet-cartridge-black-lc73bk` becomes `?search=brother-lc73 black-lc73bk`, and that search returns `GLC73BK`, `CLC73BK`. `/fuji-xerox-ct201304-toner-cartridge-cyan` becomes `?search=fuji-xerox-ct201304 cyan`. **We do not sell CT201304**: `ct201304` returns 8 other Fuji Xerox rows, and none of them is that part. The redirect now keeps the part number, but the catalogue has no row for it. |
| #9 PDP details | **Built** | "Fits Brother Brother HL L2300D" now reads "Fits Brother HL-L2300D, HL-L2340DW, …". The "Model:" line is printed on **genuine rows only**: on a compatible row, `manufacturer_part_number` is the supplier's own code (`IBTN2345`), and genuine rows have none. The hyphen: see BF-093. |
| #10 `/business` Apply | **No change; we need the doc** | The only "Apply" on that page is the date-range Apply on an approved account's performance chart, so it is hidden for everyone else by design. There is no way to apply for a business account: there is no page, and `/api/business/apply` returns 404. If the turnaround doc asks for an application flow, we need its spec and an endpoint. |
| P2 apex 307 | **Owner** | This is a Vercel dashboard setting, not code. We have passed your steps to the owner. It is done when `curl -sI https://inkcartridges.co.nz/` returns `308`. |
| 5a-a color-packs | **Deleted** | See §4. |
| 5a-b for-use-in | **Built** | For-use-in now uses the SKU from the product response. A 404 is final and is not retried; a 429, a 5xx or a network error still gets one retry. Measured locally on `/products/x/C65BK`: **one** request, `/api/products/C65XLBK/for-use-in`. |
| 5a-c brand counts | **Built** | On `/ink-cartridges`, `/toner-cartridges` and `/shop?category=…`, each tile shows `data[brand][category]`; the `/shop` brand grid keeps the sum. Measured locally: HP shows **430** on the toner landing. Before we hide a brand, we confirm the zero against `?category=` (`GET /api/shop?brand&category&limit=1`), because this endpoint undercounts multi-type families (BF-091). Dymo and Epson were confirmed 0 and hidden. |
| 5a-d printer H1 | **Built, mirrored** | The SPA takes the visible `<h1>` from the same prerender it already fetches for the title. So the browser shows exactly the crawler's text: "Brother HL-L2375DW Toner NZ". Until the prerender answers, the printer's display name stands in. |
| 5a-e alias | **Built (results page)** | The `alias_suggestion.note` banner comes first. Below it, the `alias_results` rows show under "Canon products for "canon pg640"", with a link to `/search?q=canon pg640`. The literal repair cannot replace an alias page, and the pager is hidden. We measured the shape on production with the one real "canon pg540" search the owner approved. The header typeahead does not render aliases yet. |
| 5a-f headings | **Built** | The heading badge already says "Compatible" or "Genuine", so the text no longer repeats it: "Compatible · Canon products for …", "Compatible · cartridges for Brother HL-L2375DW". **We also found a second bug.** Search results never showed their own headings: a later render overwrote them with the brand and category label on every search, which is where your " Compatible Cartridges" came from. The search headings are now set after that render. `/ribbons`: the card heading now reads "Choose your ribbon brand"; the h1 keeps the title. |

## 6. New asks

### BF-088: `/api/shop` `series` leaves out an override code that `?code=` honours

`C950XLBK` has the override `["950XL","951"]`. `GET /api/shop?brand=hp&category=ink&code=950XL` lists it (2 rows). But `GET /api/shop?brand=hp&category=ink` has no `950XL` chip in `series`, only `950`. This is the only code, out of the 15 manual chip codes, that `series` leaves out.

The frontend covers the gap by reading the `product_code_chip_counts` view. This is the last Supabase read the `/shop` code layer makes. If `series` carried every override code, we could delete it.

### BF-091: `/api/products/counts` undercounts multi-type families

Measured 2026-09-28. For each brand, the first number is from `counts`; the second is `meta.total` from `?category=drums`:

- epson drums: absent vs **5**
- canon drums: 9 vs **12**
- brother drums: 61 vs **62**

This is the same gap BF-056 found in the `/api/shop` counts facet (it leaves out `maintenance_box`), now on this endpoint. The landings can only hide a brand safely because they confirm each 0 or absent count with a second read. If the counts were right, that second read would never be needed.

### BF-092: resolve a ribbon's curated related products on `/api/ribbons/:sku`

A ribbon PDP still makes one direct `products?sku=in.(…)` read. It turns `related_product_skus` into cards. The lookup is prefix-tolerant: a bare `141LOT` also tries `C141LOT` and `G141LOT` (ERR-084). No public endpoint accepts a list of SKUs.

We suggest adding `related_products` (card fields, active rows only, in the saved order, with the same C-/G- tolerance) to `/api/ribbons/:sku`. Then the ribbon PDP makes no Supabase read at all. Our backend-move reply said BF-084 would remove "the last" direct read on the ribbon PDP. That was wrong: we had missed this one.

### BF-093: send the printer display name

Our fit lines have to print printer names exactly as your pages do, so we copy your `printerDisplayName` rules from its output. **On 2026-09-27 your pages printed "Brother MFC J5930DW" and "Fuji Xerox PHASER 5500". On 2026-09-28 they printed "Brother MFC-J5930DW" and "Fuji Xerox Phaser 5500".** Our copy had silently drifted within a day.

We have re-measured every all-caps word in every brand's printer list (119 words), plus the Brother series prefixes, and matched our copy to your output. Two findings:

- HP's `LASER` becomes "Laser", but Canon's stays `LASER`. So at least one rule is brand-specific, and we cannot see which others are.
- "E-ALL-IN-ONE-PRINTER" becomes "e-All-in-One Printer". We have not copied that rule.

Please send `display_name` next to `full_name` on printer rows (`compatible_printers[]`, `compatible_printers_grouped[].top_models[]`, `/api/printers/by-brand`, `/api/printers/:slug`). Then we can delete our copy. `probe:four-replies` §N compares the two live until you do.

## 7. Production (deployed as `215a0c4`, 2026-09-28)

These were measured on production after the deploy.

- **`npm run probe:four-replies -- --admin --browser`:**
  - 26 hard checks passed. The redirect checks first failed because the probe compared the `Location` header text literally: Vercel sends vercel.json's `+` as `%20`. We fixed the comparison to use the decoded search term, and a second run passed with no failures.
  - Soft results: BF-088, BF-091 and BF-092 are shown as warnings, not failures.
  - Unmeasured: BF-086 visitors, because 0 rows exist.
- **`npm run probe:backend-move -- --browser`: 56/56.** A non-ribbon PDP (`C02BK`) now makes **no direct Supabase REST read of any table**. That check is a hard failure now, not a warning.

| Check | Before (production) | After (production) |
|---|---|---|
| `/shop?search=`, `/shop?q=`, `/search?q=`: `X-Robots-Tag` (browser and Googlebot) | none, on 6 of 6 | `noindex, follow` on 6 of 6. Control `/shop?brand=hp`: none |
| `/brother-lc73-inkjet-cartridge-black-lc73bk` | 308 `?search=black-lc73bk` | 308 `?search=brother-lc73%20black-lc73bk` |
| `/fuji-xerox-ct201304-toner-cartridge-cyan` | 308 `?search=cyan` | 308 `?search=fuji-xerox-ct201304%20cyan` |
| `/toner-cartridges` HP tile | 870 (the sum across categories) | **430** |
| `/toner-cartridges` Dymo tile | shown | hidden, after the confirming read returned 0 |
| Printer hub `brother-hl-l2375dw` visible H1 | "Shop Ink Cartridges & Toner NZ" (hidden) | "Brother HL-L2375DW Toner NZ", the same as the prerender |
| `/products/x/C65BK` for-use-in | `C65BK` 404, asked twice | asked **once**, as `C65XLBK` |
| Printer page `color-packs` request | 1 per load, 404 | none |
| Section headings | " Compatible Cartridges" | "Compatible · cartridges for Brother HL-L2375DW" |
| `/ribbons` h1/h2 | "Typewriter & Printer Ribbons" twice | once |
| Printer names: our fit line vs your page | drifted (all Brother, and PHASER etc.) | 47 of 47 sampled match |
