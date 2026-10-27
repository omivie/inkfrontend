# Frontend asks — 26 October 2026

**From:** frontend · **Date:** 26 October 2026, §5 added 28 October (NZDT) · **Answers:** your reply of 25 October (`inbox/backend-response-2026-10-25.md`) and your handoff of 26 October (`inbox/fe-handoff-26oct2026.md`)

**Your reply, measured.** Every claim held on the live API after your deploy (backend commit `aa2d157`). `npm run probe:backend-25oct` (read-only) gives 43/43:
- §1 the 18 prices in your tables, the 7 held rows and the 4 packs; `min_unit_profit` on tier-multipliers (now printed on the admin Pricing page from your sentence, not ours).
- §2 kpi-summary on NZ days: 225 orders / $34,597.56 for your example.
- §3/§4 `/receipt-rolls` in nav, sitemap, llms.txt and the prerender; the aliases 200; the roll prerender breadcrumb and bot footer.
- §5 item 46 (all compatible cards above the first genuine) and item 37 (`matched_printer.exact` on all six cases, `exact_product` on both).

What we built from it: ERR-373 (floor line, `/receipt-rolls` adopted as the canonical landing, bare aliases now 301 in one hop), ERR-374 (item 32 fixes 2–6) and ERR-375 (item 41, the nine guides). Four asks follow, then §5: your 26 Oct handoff (items 49–58), all built (ERR-376), with one question.

---

## §1 Guides into the sitemap and llms.txt (item 41)

The ten pages are live once this deploys, as full static HTML (no prerender needed, as your plan says):

```
/guides
/guides/replace-brother-toner
/guides/replace-brother-drum-unit
/guides/printer-blank-pages-streaks-print-head-cleaning
/guides/change-hp-ink-cartridge
/guides/change-canon-pixma-ink-cartridge
/guides/page-yield-how-long-cartridges-last
/guides/refill-epson-ecotank
/guides/brother-cannot-detect-ink
/guides/what-ink-does-my-printer-use
```

**Ask:** add them to `sitemap-static.xml` (`STATIC_PAGES`) and link `/guides` from `llms.txt`. The footer links `/guides` on every page; printer and series pages link the guide for what they list.

## §2 Catalogue defects found while checking the guides against the makers

We checked every printer ⇄ cartridge pairing in your plan against the maker's NZ (or AU) pages before publishing. These are data problems on your side. The guides avoid them until they are fixed:

1. **DR-258CL is not in the catalogue.** Brother NZ specifies DR258CL-4PK for all six TN-258 printers (HL-L3240CDW, DCP-L3560CDW, MFC-L3755CDW, MFC-L3760CDW, HL-L8240CDW, MFC-L8390CDW). The guide names it and says to ask us.
2. **HP 72 / 70 print heads store one colour, but HP sells two-colour parts:** G72PHC (C9383A Magenta/Cyan), G72PHY (C9384A Matte Black/Yellow), G72PHGY (C9380A Gray/Photo Black), G70PHMBK (C9404A Matte Black/Cyan), G70PHLC (C9405A Light Magenta/Light Cyan), G70PHLGY (C9407A Photo Black/Light Gray), G70PHGY (C9410A Gloss Enhancer/Gray). G70PHMY and G70PHBLGR are correct. The DesignJet T1708 is linked to HP 72 heads; it takes HP 727.
3. **CCL646XLRD:** display name, colour and slug are Tri-Colour now, but the raw name still says "CL646XLRD", the SKU keeps RD and the yield is empty.
4. **GCL646XLCLR says 400 pages;** Canon NZ says CL-646XL is 300.
5. **Printer links that the makers do not support:** LC431 and LC431XL linked to the DCP-J1140DW (an EU model that takes LC421); the standard LC431 SKUs are NOT linked to the DCP-J1050DW (Brother NZ lists both LC431 and LC431XL for it); MFC-J6730DW linked to LC3317; DCP-J525W / J725DW / J925DW and MFC-J432W linked to LC73 (not on Brother NZ's lists).
6. **HP 63 / 65 union** (your plan's caution, measured): 35 printer rows sit on both lists. The 65 SKUs link the ENVY 4520 (a 63 printer); the 63 SKUs link the ENVY 5020/5030 and DeskJet 2620/3720 (65 printers). The 67XL SKUs are not linked to the DeskJet 2300, 2820e or Plus 4100, which HP lists for 67XL.
7. **C63XLCLR** slug contains `f6u61aa`, the standard HP 63 tri-colour part number, not the 63XL one.
8. **Missing NZ EcoTank models:** 522 — ET-1910, 2910, 2920, 4900; 502 — ET-2950, 3800, 3900, 3950, 4950.
9. **Printer rows with typos / duplicates:** `hll-3210cw` (there is no `brother-hl-l3210cw`, so the guide names the HL-L3210CW without a link), `epson-ec-otank-et-2850`, `dcp-l355cdw`, `dpc-1510`, `hp-deskjet-27002700e`.
10. **Empty yields:** CTN1070BK, GTN258XLC, the CT522 SKUs, C63XLCLR, CCL646XLRD.
11. **SKUs in your plan that do not exist:** GCL646, GCL646XL, CLC73CMY, CLC73KCMY (real: GCL646CLR, GCL646XLCLR, CLC77CMY, CLC40KCMY). GDR233CLVP now 301s to GDR233CLCMY.

`npm run probe:guides` (read-only) re-checks every product, printer and maker link on the guides; it is at 0 findings today.

## §3 CBCI6KCMY is still live

`npm run probe:lookalike` on 2026-10-26: CBCI6KCMY returns 200 (no redirect to CBCI3KCMY) and still renders on the `CI6` chip, although the September retirement said CBCI3KCMY superseded it. Your 25 Oct reply re-anchored it (to 23.79, then back to 20.99), so it is clearly live on your side. **Ask:** is it a product, or should it 301 like CBCI6CMY → CBCI3CMY does?

## §4 Item 32: what shipped, what did not, and a re-run

Shipped (ERR-374): no h1 repaint on the paid landings; PDP related products wait for the viewport or the hero image; **the compat sidecar is deleted** (`probe:lookalike --sidecar-all`: 0 rows recovered over 1,153 chips, 0 compatible rows with empty `series_codes` — your BF-102 held catalogue-wide); fonts self-hosted, Google Fonts and JetBrains Mono gone; `gtag.js` deferred (`first-paint.js` is now the one blocking script, on shop.html only); every `transition: all` named; supabase-js only for signed-in visitors or on demand; search.js runs on first use; WebP hero with a phone crop and preload; logos through the optimiser with sizes; the contrast list, the inert sticky bar and the sized PDP image.

**Not done, by the owner's decision:** minifying CSS/JS and splitting `pages.css`. The storefront has no build step and the owner wants to keep it that way.

**Our live numbers** (`lighthouse@12.6.0`, default mobile, median of 3, 26 Oct): series `code=288` perf 67 / LCP 9.17 s / CLS 0.003; home 65 / 9.10 s / 0; `/ink-cartridges` 67 / 8.64 s / 0; desktop `/ink-cartridges` 99, CLS 0.005. GLC233BK measured CLS 0.307 on the first deploy. Self-hosted fonts let the skeleton paint, which exposed the volume ladder landing above the Add row. Fixed in the follow-up deploy: 0.03 locally. LCP is still above 4 s on the series page and the product page. The levers left are minify (declined) and the product JSON edge cache, which is yours: we measured 0.9 s on a cold read.

**Ask:** you offered to re-run your Lighthouse set once a deploy is live — please run the pages in your tables plus the series page and GLC233BK. We will run the same command and put both sets of numbers side by side.

---

## §5 Your handoff of 26 Oct (items 49–58): what is built, and one question

Copied to `inbox/fe-handoff-26oct2026.md`. **All ten items are live on www since 28 Oct 2026** (frontend commit `95b3b1de`, ERR-376), **including 51 and 50.** `npm run probe:handoff-26oct` (read-only, plus one invoice quote that saves nothing) measured each one on the live site after the deploy: **21/21**.

- **51 (P0).** STEP 0.5 is deleted, with no replacement. On /checkout the order's lines are the summary's lines (`Cart.items`), not a re-read of the server cart. Every order POST (card, wallet, points, PayPal and its retry) goes through one function. That function sends the Turnstile token held at that moment and resets it after every answer: success, refusal, the email refusal and a thrown 400. PayPal now builds its body with the same function as the card path. The hand-copied twin is gone.
- **50 (P0).** The www `/privacy` page carries the paragraph byte for byte, with straight apostrophes. It goes in §3 "Why we collect it": www has no "How We Use It" heading. The page lists third parties in a table, not a list, so the Google Customer Reviews item is a table row. The row reads "Google Customer Reviews" followed by your sentence, so its text is your item byte for byte. The probe compares both against `/api/prerender/static/privacy`. **Live and measured: the owner's calls can start.**
- **52.** The fee is re-quoted when the postcode changes (debounced, once 4 digits are in) and again before every Pay press (card and PayPal). The urban/rural price labels now send `postal_code`. Measured locally against the live API: 1010 gave $7.00, then typing 9016 gave $22.00. Both postcode inputs have `inputmode="numeric"` and stay `type="text"`.
- **53.** The Element uses `fields.billingDetails` name/email/phone `'never'`, and confirm sends all three. Measured with the live key and no payment placed: the Afterpay panel shows no Email or Full name field, and Pay is enabled. With the old code, the same page showed both fields and Pay stayed disabled. **We could not run a test-mode payment** (the storefront has only the live key). Please run your check.
- **54.** An Afterpay mark sits after Klarna in the footer and on /cart, naming the method only. It is also in the legal pages' payment-method list.
- **55.** The rule you gave is in. With the drawer open at 1366 and 390 wide, `elementFromPoint` at the right end of Checkout returns the button.
- **56.** The chip reads "4-cartridge set $31.99 — $2.27 less than the 4 singles", built from `cartridge_count`, `pack_price` and `savings_amount`. We wrote "cartridge", not your example's "colour", because `cartridge_count` counts cartridges (a pack with two blacks is not five colours). Without `cartridge_count` or `pack_price` it reads "Value pack — $2.27 less than buying the singles". It shows only on a line of 1. If the line has grown by the time of the swap, the swap takes one single off instead of the whole line.
- **57.** We built it, so please keep sending the URLs. www redirects (307) `/checkout/paypal-return` to `/checkout?paypal=return`, with PayPal's `token` and `PayerID` kept, and `/checkout/paypal-cancel` to `/checkout?paypal=cancelled`. The order number and PayPal order id are saved in sessionStorage before `createOrder` returns. A return captures only when the token matches the saved order; otherwise it tells the buyer not to pay again and to check their email or call.
- **58.** The label is fixed ("1 item"). `/cart/` now redirects permanently (308, measured) to `/cart`, so old abandoned-cart emails land on the cart too.
- **Your "no FE work" list, checked.** Value packs in `free_shipping_unlock.suggested_products` render like any chip (no filter on `pack_type`). One gap was ours: the account and order pages styled an unknown status as "pending", so a shipped order you refund would have shown a pending badge. `refunded` now reads "Refunded" with the ended-order badge (live with this section). Public holidays, the order safety net, repeat orders, related products and the abandoned-cart link needed nothing from us.
- **49.** Both editors send `cost_source` on every line, and `supplier_cost_excl_gst` when the cost is known (a typed 0 counts; a blank box is never sent as 0). Editing the cost re-quotes. The badges are owner-only and advisory, and the level of 20 is one named constant. Your contract, measured live: a $0.50 GLC233BK line gave `below_web_price: true`, `gross_margin_pct: -8674`; a manual cost with none typed gave `null`. Quick Order still calls `/api/admin/invoices/quote`, which it has shared on purpose since the two endpoints agreed to the cent (`contract-pricing-quote-sep2026.test.js`). Its lines carry both fields.

**Ask (52):** does the 201 from `POST /api/orders` for a card order carry `total_amount` and `shipping_cost`, as the points order does? Pay now compares `total_amount` with the total on screen before it confirms. When the field is absent, the check reports `'unverified'` and Pay confirms anyway. Please also say whether an `is_duplicate` replay carries it.
