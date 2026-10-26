# Backend reply to "Frontend asks — 20 October 2026" (+ 24/25 Oct additions)

**From:** backend · **Date:** 25 October 2026 (NZDT)

Every section of your file (`backend-asks-2026-10-20.md`) is answered below, in the same order. The two specs you asked for under §5.4 (items 41 and 32) are attached at the end as Appendix A and Appendix B, so this is the only file you need.

**Contents:** §1 low-ticket pricing · §2 kpi-summary timezone (ERR-367) · §3 `/receipt-rolls` (ERR-368) · §4 receipt-roll follow-ups · §5 checklist items 46, 37, 43, 26b, 22, 41, 32, 27a · Appendix A: how-to guides plan (item 41) · Appendix B: mobile speed spec (item 32)

**What you need to do:** nothing for §1–§4. For §5: item 37 can redirect on `matched_printer.exact` once we confirm the deploy is live; build items 41 and 32 from the appendices.

**Status:** code ships with the next deploy (after the Monday 00:05 NZDT push); price changes and pack re-anchors were written to the live catalogue on 25 Oct and are already visible.

---

## §1 Low-ticket products

### What we chose, and why

**Option (a): a minimum dollar profit per unit, $2.50 ex GST after the card fee.** It is measured exactly like the admin list's `profit_incl_fixed_ex_gst`: price ex GST − cost − card fee of a one-unit order (2.65% + $0.30, GST on the fee reclaimed).

- **Where it applies:** the compatible ladder (`default` / `catalogue` / `brand_rule` price sources) and the ribbon tier (`ribbon`). It is in the pricing formula itself (`src/utils/pricing.js`, `MIN_UNIT_PROFIT_EX_GST`). So the nightly import, the reprice engine, the simulator and the nightly competitive audit's floor all use it, and it follows supplier cost.
- **Where it does not apply, on purpose:**
  - **Genuine.** Low-cost genuine rows are compared with the big retailers' own prices. PB Tech sells HP 9RR53A at about $5.09; we are already at $5.99. The floor would have taken it to $7.79.
  - **Receipt rolls.** They are already 25–35% above PB Tech for the same Okin parts.
  - **Packs** (invariant 5), **pricing-rule rows** (the rule is the owner's price) and **manual prices**.
- **It never takes us above a rival we know about.** The engine's market cap runs after it. So the Epson 81N / 73N / 103 compatibles went from $6.99 to $7.49, which is still under TonerDirect's $7.60–$8.28. They did not go to the $7.79 the floor alone would ask for.
- **The floor only matters under about $4 cost.** It changes no price above that.

**Why not (b) alone:** the ribbons are 13 of the 54 rows. The other 41 rows (mostly cheap compatible ink) have the same problem.

**Why not (c), a small-order fee:** the owner's standing rule (5 Oct) is "small-order shipping fees: do not change". A fee would also touch every small basket: 13 of 174 web orders in the last 120 days were under $25, while only **4** had less than $3 gross. In the last 365 days the 54 low-profit SKUs sold in 4 orders. So this is a small problem, and a checkout change is the wrong size of fix for it.

**On $2.50:** at $3.00 the formula would raise rows we have no market data for by 21–30% (Canon BCI3 colours to $6.79, HP photo paper to $7.79, the rolls). At $2.50 every change is +7% to +18%, except two ribbons whose .95 ending forces a $1–2 step. A one-unit order of the ribbon in 2026101404 now nets about $2.48 instead of $1.61.

### Before / after (dry run first, then applied on 25 Oct 08:47 UTC)

Dry run: the engine over the whole catalogue (3,150 singles), old code vs new. **Old code: 0 changes. New code: exactly the 22 rows below.** Rollback: `audit_artifacts/min-unit-profit-floor-2026-10-25T0847-applied.json`.

**Then 7 of the 22 went back to their old price (09:10 UTC).** The ad-claims audit found that two live ads became false. "Buy Ink Cartridges From $5.49" is backed by CBCI3 C/M/Y, and "Ink for Epson 73N From $6.99" by the four 73N singles. Ad copy cannot change during the ads freeze, so those 7 rows are back at $5.49 / $6.99 as manual pins (claim holds); the owner can lift them when the ads change. They are marked **held** below. After the hold the audit reports 0 false claims.

Compatible ladder (engine path, market cap applied):

| SKU | Old | New | New gross $ ex GST | Unit profit after card fee | Cheapest rival |
|---|---|---|---|---|---|
| C81NBK, C81NC, C81NM, C81NY, C81NLC, C81NLM | 6.99 | 7.49 | 3.29 | 2.44 → 2.86 | TonerDirect 7.76 |
| C73NBK | 6.99 | **held at 6.99** | — | — | TonerDirect 8.28 |
| C73NC, C73NM, C73NY | 6.99 | **held at 6.99** | — | — | 7.60 |
| C103BK, C103C, C103M, C103Y | 6.99 | 7.49 | 3.29 | 2.44 → 2.86 | TonerDirect 7.60 |
| C200XLBK, C200XLC, C200XLY | 6.99 | 7.49 | 3.26 | 2.41 → 2.83 | none scraped |
| CBCI3C, CBCI3M, CBCI3Y | 5.49 | **held at 5.49** | — | — | none scraped |
| CBCI3BK | 5.99 | 6.49 | 2.91 | 2.08 → 2.50 | Discount Office 10.73 (a TonerInk "BK/Colour" listing at 4.98 is a different product) |
| CLC37Y | 5.99 | 6.49 | 2.91 | 2.08 → 2.50 | none scraped |

Ribbon tier (unpinned rows only):

| SKU | Old | New | New gross $ | Unit profit after card fee |
|---|---|---|---|---|
| 637.01 | 6.95 | 8.95 | 3.73 | 1.57 → 3.27 |
| 651.01 | 7.95 | 8.95 | 3.18 | 1.87 → 2.72 |
| 621.01 | 7.95 | 8.95 | 3.18 | 1.87 → 2.72 |
| 659.01 | 7.95 | 8.95 | 3.28 | 1.97 → 2.82 |
| 690.01 | 7.95 | 8.95 | 3.38 | 2.07 → 2.92 |
| G-CAN-MPRIBBON-RIB-BKRD | 7.95 | 8.95 | 3.62 | 2.31 → 3.16 |
| C174LOT | 9.95 | 10.95 | 3.82 | 2.46 → 3.31 |

Packs that follow those singles (re-anchored by `repair-pack-prices.js`, invariant 5):

| Pack | Old | New |
|---|---|---|
| CBCI6KCMY | 20.99 | 23.79, back to 20.99 with the BCI3 hold |
| C200XLKCMY | 26.99 | 28.49 |
| C200XLCMY | 20.49 | 21.49 |
| CIB3757CMY | 18.49 | 18.99 |

**Net count: 22 singles raised (15 ladder + 7 ribbons), 7 held at their old price, 3 packs raised.**

### Manual rows the rule would have changed (not touched; the owner decides)

Compatible, `manual` price source:

| SKU | Pin | Now | Rule would set | Unit profit | Cheapest rival | Our recommendation |
|---|---|---|---|---|---|---|
| CT0491BK, CT0492C, CT0493M, CT0494Y, CT0495LC, CT0496LM | owner | 5.79 | 5.99 | 2.46 → 2.63 | 6.26 | Yes: still under the rival |
| CBCI6BK | owner | 5.99 | 6.49 | 2.35 → 2.77 | TonerDirect 6.96 | Yes: still under TonerDirect |
| CCLI526GY | competitive audit | 5.79 | 7.49 | 1.42 → 2.86 | 5.99 | No: 25% over the rival |
| CGI690C, CGI690M | competitive audit | 10.79 | 11.49 | 1.92 → 2.52 | 10.99 | No: over the rival |
| C273XLPBK | competitive audit | 11.79 | 12.49 | 2.13 → 2.72 | 11.99 | No: over the rival |
| CT522BK | competitive audit | 13.79 | 13.99 | 2.46 → 2.63 | 13.99 | Owner's call (= the rival) |

Ribbons, `manual` (legacy freeze); no rival prices are scraped for any ribbon:

| SKU | Now | Rule would set | Unit profit |
|---|---|---|---|
| C-OKI-720-RIB-BK | 6.95 | 7.95 | 1.88 → 2.73 |
| 657.01, 657.02 | 6.95 | 7.95 | 2.12 → 2.97 |
| 691.01 | 7.95 | 8.95 | 1.97 → 2.82 |
| C-OKI-IO182-RIB-BK | 7.95 | 8.95 | 2.26 → 3.11 |
| C314LOT | 8.94 | 9.95 | 2.11 → 2.96 |
| 72680.01, 72680.02 | 8.95 | 9.95 | 2.32 → 3.16 |
| 72554.09 | 8.95 | 9.95 | 2.42 → 3.26 |
| 10966.01 | 11.99 | 12.95 | 2.07 → 2.83 |

The competitive-audit pins are the nightly price-match cuts (owner rule of 14 Oct: beat the cheapest rival, 25% gross floor). From now on, the nightly audit also never cuts a compatible single below the $2.50 floor. It does not raise its existing pins.

Not covered by the rule, and left as they are: G9RR53A, G9RR55A, GPRINKBBK (genuine), GPC302RF (genuine, manual), CTR57X50P4 (receipt roll), ADMIN-INK-001 (the test row).

### What the admin Pricing page can show

- **One new field:** `GET /api/admin/pricing/tier-multipliers` returns `min_unit_profit: { ex_gst: 2.5, applies_to, measured_as }`. Print it beside the ladder, e.g. "Minimum $2.50 profit per unit after the card fee (compatible and ribbons)". It is fixed in code and not editable.
- `profit_incl_fixed_ex_gst` on the product list is the same measure, so a row under $2.50 there is either manual, genuine, a roll, a pack or rule-priced.
- No new `price_source` value: a row lifted by the floor still reads `default` / `ribbon`.

### Side note: `supplier: "unknown"` on 651.01

This is expected, and it is not a freight error. 104 live rows carry `supplier: "unknown"`, 94 of them ribbons and correction tapes added outside the two feed importers. Freight attribution does not read that column. It uses the sale-time snapshot, then genuine ⇒ DSNZ, then `order_fulfillment`, then the compatible default (Augmento). Augmento is the only live compatible supplier, so `supplier_basis: "default"` names the right supplier. We left the column alone: the import sweep keys on `supplier`, and these rows are in neither feed.

---

## §2 kpi-summary vs dashboard-bundle timezone (ERR-367)

**Fixed: both now read `date_from` / `date_to` as Pacific/Auckland calendar days.**

- The seven dashboard date-range RPCs compared `created_at >= date_from::date`. Postgres casts a date to a timestamp in the session timezone, and that is UTC on Supabase. They now run with `SET timezone = 'Pacific/Auckland'` (migration 212): `analytics_kpi_summary`, `revenue_series`, `refunds_series`, `brand_breakdown`, `top_products`, `customer_stats` and `fulfillment_sla`.
- The supplier-freight pass that kpi-summary adds on top (`kpiPeriodWindows`) moved to NZ days in the same deploy.
- Measured with your example (`2026-03-14`..`2026-10-19`): kpi-summary had 226 orders and $34,630.55 revenue. With NZ bounds it has 225 orders and $34,597.56. The difference is order 2026102001, $32.99, exactly as you found.
- The migration is applied when the code deploys, so the RPC and its JS mirror switch together.
- `previous` is the same number of NZ days, ending the NZ day before `date_from`.

---

## §3 `/receipt-rolls` landing path (ERR-368)

**Done.**

- The receipt category's `landingPath` is `/receipt-rolls`. `GET /api/site/nav` now returns `path: "/receipt-rolls", landing: true`.
- `/receipt-rolls` is in `sitemap.xml`, `llms.txt` links it, and the category prerender's canonical and breadcrumb use it.
- The backend's own bot middleware maps `/receipt-rolls` to `/api/prerender/category/receipt`.
- `/shop?category=receipt` keeps working.

## §4 Follow-ups

1. **The aliases are meant for the API too.** The handoff was right about the taxonomy and wrong about the validator. `/api/products` and `/api/shop` checked `category` against a hand-kept list that predated the aliases, so they returned 422. The validator now accepts every slug and alias the taxonomy knows (case-insensitive): `receipt-rolls`, `receipt-roll`, `receipt_roll`, `photo_paper`, `label-tape`, `ribbons`, `drum-units`…. Your 301 can stay.
2. **No Okin links on the roll product prerender.**
   - The breadcrumb (visible and BreadcrumbList JSON-LD) is now Home › Shop › Receipt Rolls (`/receipt-rolls`) › product.
   - "More from Okin / See all Okin products" is replaced by "See all receipt rolls →".
   - The "Related Okin Products" heading is plain text, not a link, and stays.
3. **The bot footer** now lists Ink Cartridges · Toner Cartridges · Drum Units · Printer Ribbons · Receipt Rolls.

---

## §5 FE-MASTER-CHECKLIST (22 Oct)

1. **Item 46: done on the bot page.** `/api/prerender/printer/…` lists Compatible above Genuine. Within each source: in stock first, then cartridges (ink/toner) before drums before other parts (belt, fuser, waste, maintenance, paper), then cheapest. Ties keep our catalogue order.
   - This is your `printer_fit` sort, with one difference: the part tier is read from `product_type`, not the name. Your name regex agrees with it on every type in the catalogue.
   - Out-of-stock cards still say "Contact Us" (genuine) / "Out of Stock" (compatible), as before.
2. **Item 37: `matched_printer.exact` ships with this deploy.**
   - `exact: true` only when the query, with shopping words removed (printer, ink, toner, cartridge(s), refill(s), for), equals one printer's full name or model name, ignoring separators.
   - "brother mfc-j4340dw" now matches and returns `brother-mfc-j4340dw` with `exact: true`; it used to lead with the `-xl` row.
   - Refused (`exact: false`): "canon g7060" (only the GX7060 exists), "brother mfc-j4340", "canon 540", and "epson 300", which names both Epson 300 and Epson 300+, two different printers.
   - "canon ts5360" is not exact either: our row is "Canon PIXMA TS 5360", so the query has to include "pixma".
   - **`exact_product` has been live since 13 Oct.** It is set only when the query names one in-stock product by the ads rule (code and tier, plus colour, source or pack words where the family needs them). Examples: "canon pg645" → GPG645BK, "epson 288xl black" → G288HYBK. It is never set for a printer query, which is why your printer test saw neither field. "brother lc233 black" returns null because genuine and compatible both match.
3. **Item 43:**
   - No backend report or funnel counts `traffic_events.element = 'add_to_cart'` exactly. The funnel reads `cart_analytics_events.event_type` (server-side cart events). Nothing needs a prefix switch.
   - A grid Add `click` with element `add_to_cart:<uuid>` is now resolved on ingest to `link_product_id` / `link_product_sku`, so the catalogue-engagement board counts it against the product.
   - `grid_ready` and `client_error` are arriving (15 real `grid_ready` rows since 24 Oct).
   - The two probe rows (`/__fe_probe`, session `fe-probe-enum-20261024`) are still in the table. The owner will remove them.
4. **Not done items:**
   - **26b: withdrawn.** Keep the DELIVERY and RETURNS rows. With the service row gone (ERR-329) they are the only delivery and returns facts on the PDP. The checklist is updated.
   - **22:** thanks, marked done.
   - **41 and 32:** both specs are attached at the end of this file: Appendix A (`docs/seo/guides-content-plan-oct2026.md`, item 41) and Appendix B (`docs/storefront/mobile-speed-FE-handoff-oct2026.md`, item 32).
5. **Measured differences:** all noted. **27a:** the checklist now says `data.warranty.compatible_label` on `/api/site/trust`. 24, 25 and 26a: your versions stand.


---

# Appendix A — How-to guides content plan (checklist item 41)

Source: backend repo `docs/seo/guides-content-plan-oct2026.md`, verbatim.

## How-to guides: content plan (Oct 2026)

Status: plan only. No guide page exists yet, and this plan changes no robots, sitemap or canonical.
Owner of the pages: the storefront (FE). The content pages on www are hand-authored static HTML and
there is no bake pipeline (CLAUDE.md §12.4), so the FE writes and hosts every guide below.
Backend role: demand data, product links, and the facts the copy must read from the API.

### 1. Why guides

Google Search Console, 90 days to 2026-10-12, New Zealand: 354 clicks from 49,212 impressions,
CTR 0.72%, average position 20.7. The best-selling families rank at positions 20 to 40 for their own
codes, and almost every click comes from printer pages and product pages.

The site has no page that answers a how-to question. In the same 90 days, 284 how-to style queries
("ink refill", "what ink cartridge for hp deskjet 3520", "how ...", "replace", "reset") reached the
site 539 times and took 0 clicks, mostly at position 40 or lower.

A guide earns its keep in three ways:

1. It ranks for the how-to query itself.
2. It links to printer pages and product pages that carry real product demand (listed per guide).
   These links pass relevance to pages that now sit on page 2.
3. It gives AI answer engines a page to cite (CLAUDE.md §9.2).

### 2. How the demand was measured

- Source: Google Ads Keyword Planner `generateKeywordHistoricalMetrics` (read-only), New Zealand
  (`geoTargetConstants/2554`), English (`languageConstants/1000`), Google Search. Run on 2026-10-15.
  Figures are Google's average monthly searches over the last 12 months. Google rounds them into
  buckets (10, 20, 30, 40, 50, 70, 90, 110, 140 ...).
- Close variants share one 12-month series. For example, "how to change ink in hp printer", "how to
  put ink in a hp printer" and "how to install ink cartridge in hp printer" show the identical series
  (30, 40, 30, 50, 50, 40, 50, 50, 40, 30, 40, 30). That is one cluster of 40 searches a month, not
  120. Every total below adds DISTINCT clusters only.
- A flat "10 every month" series cannot be told apart from another flat series, so those were merged.
  Small totals are therefore floors.
- NZ volumes are small. The largest how-to cluster we stock products for is 70 searches a month. Most of a
  guide's value is the links it carries to pages with product demand.

### 3. Ranked plan (by NZ how-to demand)

| # | Guide | Head query (searches/month) | All how-to clusters (searches/month) | Product demand the guide links to |
|---|---|---|---|---|
| 1 | Replace the toner in a Brother laser printer | how to replace toner in brother printer (30) | 120, 7 clusters | tn2445 70, tn258xl 50, tn1070 50, brother dcp l3560cdw toner 70, brother mfc l2713dw toner 40 |
| 2 | Replace the drum unit on a Brother printer | brother printer replace drum (70) | 90, 3 clusters | dr1070 20, dr2415 10, dr2315 10, dr233cl 10 |
| 3 | Blank pages, streaks or faded print: clean the print head | how to clean print head (20) | 80, 5 clusters | printer pages; HP DesignJet print heads |
| 4 | Change the ink cartridge in an HP printer | how to change ink in hp printer (40) | 70, 4 clusters | hp deskjet 2820e ink 210, hp 67 ink 140, hp 65 ink 90, hp 63 ink 70, hp 955xl 70 |
| 5 | Change the ink cartridges in a Canon PIXMA (PG-645 / CL-646) | how to change ink in canon printer (40) | 70, 3 clusters | pg 645 70, canon pg 645 50, canon 645 40, canon mg2560 ink 20, canon ts3160 ink 20 |
| 6 | How long does a cartridge last? Page yield and XL explained | how long does toner last (20) | 50, 4 clusters | XL and standard pairs below |
| 7 | Refill an Epson EcoTank (522 and 502 bottles) | epson ecotank refill (10) | 40, 4 clusters | epson 522 ink 50, epson 502 ink 40, epson 522 30 |
| 8 | Brother printer says "Cannot Detect Ink" | cannot detect ink brother (10) | 40, 4 clusters | lc431 ink 70, brother dcp j1050dw ink 50, lc431xl 40, lc3317 40, brother mfc j1010dw ink 40 |
| 9 | What ink does my printer use? | what ink does my printer use (10) | 30, 3 clusters | printer search, regional code aliases |

Suggested URLs use one folder, `/guides/<slug>`. The slugs are given per guide below.

#### 1. Replace the toner in a Brother laser printer (and clear "Replace Toner")

- URL: `/guides/replace-brother-toner`
- Target queries (searches/month): how to replace toner in brother printer 30; replace toner brother /
  brother change toner / brother printer cartridge replacement 30; brother printer toner replacement /
  brother toner cartridge replacement 20; brother toner reset / brother printer toner reset 10; model
  variants (brother mfc l2750dw toner replacement, brother hl l2375dw toner replacement, brother mfc
  l3750cdw toner reset) 10 each.
- Outline:
  1. Find your model and the toner code it takes, with a table by printer:
     - TN-2445: HL-L2375DW, MFC-L2713DW, MFC-L2750DW, MFC-L2770DW, HL-L2310D.
     - TN-258XL: HL-L3240CDW, HL-L3280CDW, DCP-L3520CDW, DCP-L3560CDW, MFC-L3755CDW, MFC-L3760CDW,
       HL-L8240CDW, MFC-L8390CDW.
     - TN-2345: HL-L2300D, HL-L2340DW, HL-L2365DW, MFC-L2700DW, MFC-L2720DW, MFC-L2740DW.
     - TN-1070: HL-1110, HL-1210W, MFC-1810.
  2. Mono printers: open the front cover, lift out the drum and toner assembly, release the toner from
     the drum, fit the new toner until it clicks, and clean the corona wire.
  3. Colour printers: each colour has its own slot and label. Match the colour, then refit.
  4. "Replace Toner" still shows after a new cartridge. Link to Brother's support steps for the model.
     Do not publish a generic button sequence; they differ per model.
  5. Drum or toner? Link to guide 2.
  6. Genuine or compatible: link to `/genuine-vs-compatible`. Read the guarantee and returns facts
     from `GET /api/site/trust`.
- Products: CTN2445BK, GTN2445BK; CTN258XLBK, CTN258XLC, CTN258XLM, CTN258XLY, CTN258XLCMY,
  CTN258XLKCMY, GTN258XLBK, GTN258XLC, GTN258XLM, GTN258XLY, GTN258XLCMY, GTN258XLKCMY; CTN2345BK,
  GTN2345BK; CTN1070BK, GTN1070BK. CTN2445BK, CTN258XLBK and the TN258XL packs are among the
  most-ordered SKUs (paid orders, last 180 days).

#### 2. Replace the drum unit on a Brother printer (and reset "Drum End Soon")

- URL: `/guides/replace-brother-drum-unit`
- Target queries: brother printer replace drum / replace drum brother printer / change drum in brother
  printer 70 (12-month range 30 to 90); how to replace drum on brother printer / brother drum reset /
  brother drum end soon / drum end soon brother printer 10; brother replace drum 10. Part codes:
  dr1070 20, dr2415 10, brother dr2415 10, dr2315 10, dr233cl 10.
- Outline:
  1. Drum or toner: what each part does and how long each lasts (page yields from our product data).
  2. Signs: "Drum End Soon", "Replace Drum", faint pages, marks that repeat down the page.
  3. Which drum fits:
     - DR-2415: the TN-2445 printers in guide 1.
     - DR-2315: the TN-2345 printers.
     - DR-1070: the TN-1070 printers.
     - DR-233CL: HL-L3230CDW, MFC-L3770CDW, DCP-L3551CDW.
     - DR-2530: HL-L2445DW, HL-L2460DW, MFC-L2880DW and the rest of that range.
  4. Steps: lift out the assembly, move the toner to the new drum, refit, reset the drum counter.
     Link to Brother's per-model reset steps.
- Products: CDR2415BK, GDR2415BK; CDR2315BK, GDR2315BK; CDR1070BK, GDR1070BK; CDR233CLBK, CDR233CLC,
  CDR233CLM, CDR233CLY, CDR233CLCMY, CDR233CLKCMY, GDR233CLBK, GDR233CLVP; CDR2530BK, GDR2530BK.
- Gap: the catalogue links no drum unit to the TN-258XL printers. Confirm the correct drum before the
  guide names one.

#### 3. Blank pages, streaks or faded print: clean the print head

- URL: `/guides/printer-blank-pages-streaks-print-head-cleaning`
- Target queries: how to clean print head 20; epson print head cleaning 20; printer printing blank
  pages 20; printer streaks 10; canon print head cleaning / hp print head cleaning / printer faded
  print / printer not printing black / printer not printing colour 10.
- Outline:
  1. Run a nozzle check.
  2. Run the head clean for each brand (Epson, Canon, HP, Brother), from the printer menu or the
     maker's app.
  3. When the cartridge is the cause: protective tape still on, cartridge empty, wrong code. Link to
     printer search.
  4. When to stop cleaning: repeated cleans use ink.
  5. HP DesignJet print heads, for the wide-format readers.
- Products: printer pages through search; HP print heads G70PHGY, G70PHLC, G70PHLGY, G70PHMBK,
  G70PHBLGR, G70PHMY, G72PHC, G72PHGY, G72PHY, G11PHC, G746PH.
- Data note: HP's 72 heads are two-colour parts (C9383A Magenta/Cyan, C9384A Matte Black/Yellow,
  C9380A Grey/Photo Black), but G72PHC, G72PHY and G72PHGY each store one colour, and their titles
  name only that colour. Check the colour column of every head against HP's part number before the
  guide names one.

#### 4. Change the ink cartridge in an HP printer

- URL: `/guides/change-hp-ink-cartridge`
- Target queries: how to change ink in hp printer / how to put ink in a hp printer / how to install
  ink cartridge in hp printer / how to replace ink in hp printer / how to put ink cartridge in hp
  printer 40; how to install hp ink cartridge / how to replace ink cartridge hp 10; how to change hp
  ink cartridge 10; how to put ink in hp printer deskjet 2700 10.
- Outline:
  1. Generic steps: printer on, open the access door, wait for the carriage, push to release, remove
     the tape, insert until it clicks, close, align.
  2. "Cartridge problem" / "incompatible" / "not recognised": remove the tape, reseat, clean the
     contacts, check the code. For a compatible cartridge that is not recognised, point to our
     returns (facts from `/api/site/trust`). Make no claim about what HP firmware will or will not
     accept.
  3. One short section per printer family, each linking to its printer page:
     - HP 67 / 67XL: DeskJet 1200, 2700 and 2800e (DeskJet 2820e), DeskJet Plus 4100, ENVY 6000,
       ENVY Pro 6400. "hp deskjet 2820e ink" alone is 210 searches a month, and the 2820e printer
       page already ranks about 9th for it.
     - HP 65 / 65XL: DeskJet 2600 and 3700, ENVY 5000.
     - HP 63 / 63XL: DeskJet 2130 and 3630, ENVY 4520, OfficeJet 3830 and 4650.
     - HP 955XL: OfficeJet Pro 7720, 7730, 7740, 8210, 8710, 8720, 8730, 8740.
- Products: G67BK, G67XLBK, G67CLR, G67XLCLR, G67VPVP; G65CLR, G65XLBK, G65XLCLR, C65XLBK, C65XLCLR;
  G63XLCLR, C63XLBK, C63XLCLR; G955XLBK, G955XLC, G955XLM, G955XLY, G955XLCMY, G955XLKCMY, C955XLBK,
  C955XLC, C955XLM, C955XLY, C955XLCMY, C955XLKCMY. C955XLKCMY and G63XLCLR are among the
  most-ordered SKUs.
- Caution: the catalogue's HP 63 and HP 65 printer lists are a known union (CLAUDE.md §8). Take the
  63-versus-65 printer split from HP's own data, not from our printer pages.

#### 5. Change the ink cartridges in a Canon PIXMA (PG-645 / CL-646)

- URL: `/guides/change-canon-pixma-ink-cartridge`
- Target queries: how to change ink in canon printer / canon printer how to change ink / canon printer
  how to change ink cartridge 40; canon pixma printer how to change ink / how to replace ink cartridge
  canon pixma 20; how to change ink cartridge canon 10.
- Outline:
  1. Open the cover and wait for the cartridge holder to stop.
  2. Release the empty cartridge and check the slot label (black or colour).
  3. Insert the new cartridge until it clicks.
  4. Regional codes: Canon FINE cartridges are region-locked (CLAUDE.md §7.5). A PG-645 printer
     takes PG-645, not PG-245 or PG-545. Link to the search alias note.
  5. Standard or XL (yields from our product data).
- Printers: PIXMA MG2460, MG2560, MG2960, MG2965, MG3060, MX496, TS3160, TS3165, TS3465, TS3560,
  TS3660, TR4560.
- Products: GPG645BK, GPG645XLBK, CPG645XLBK, GCL646, GCL646XL, CCL646XLRD, GPG645VPVP.
- Data note: CCL646XLRD is a tri-colour cartridge named and slugged "Red". Fix it before the guide
  links to it (see the tri-colour mislabel audit, CLAUDE.md §1.4).

#### 6. How long does a cartridge last? Page yield and XL explained

- URL: `/guides/page-yield-how-long-cartridges-last`
- Target queries: how long does toner last 20; how long do ink cartridges last 10; page yield 10;
  toner vs ink 10.
- Outline:
  1. What a page yield is: the ISO/IEC test standards (19752 mono toner, 19798 colour toner, 24711
     inkjet) and why real pages vary.
  2. Toner versus ink.
  3. Standard versus XL, with pairs from our own data:
     - HP 67: 120 pages; 67XL: 240 pages.
     - Brother LC431: 200 pages; LC431XL: 500 pages.
     - Canon PG-645: 180 pages; PG-645XL: 400 pages.
  4. Signs a cartridge is nearly empty.
- Do not print a cost-per-page figure. The owner removed them from every page on 2026-09-29.

#### 7. Refill an Epson EcoTank (522 and 502 bottles)

- URL: `/guides/refill-epson-ecotank`
- Target queries: epson ecotank refill 10; how to fill epson ecotank 10; how to refill epson ecotank
  10; epson ink bottle refill 10.
- Outline:
  1. Which bottle fits:
     - 522: ET-1110, ET-1810, ET-2710, ET-2720, ET-2810, ET-2811, ET-2820, ET-4700, ET-4800.
     - 502 (T502): ET-2700, ET-2750, ET-2850, ET-3700, ET-4750, ET-4850.
  2. Steps: open the tank cover, open one tank, seat the keyed bottle, let it fill to the line, close.
  3. First fill versus top-up. Keep the bottle upright.
- Products: G522BK, G522C, G522M, G522Y, G522CMY, G522KCMY, CT522BK, CT522C, CT522M, CT522Y, CT522CMY,
  CT522KCMY; GT502BK, GT502C, GT502M, GT502Y, GT502CMY, GT502KCMY. GT502KCMY is among the
  most-ordered SKUs.

#### 8. Brother printer says "Cannot Detect Ink"

- URL: `/guides/brother-cannot-detect-ink`
- Target queries: cannot detect ink brother 10; brother ink not detected 10; brother printer cannot
  detect ink 10; brother printer ink not recognised 10.
- Outline:
  1. Remove the orange protective part and any tape.
  2. Reseat the cartridge until it locks.
  3. Check the code. In our catalogue LC431XL is linked to the DCP-J1050DW, DCP-J1140DW and
     MFC-J1010DW, while the standard LC431 is linked to the DCP-J1140DW and MFC-J1010DW only. Check the
     DCP-J1050DW against Brother's list before the guide says which codes it takes.
  4. When a compatible cartridge is the cause, point to returns (facts from `/api/site/trust`).
- Products: CLC431XLBK, CLC431XLC, CLC431XLM, CLC431XLY, CLC431XLCMY, CLC431XLKCMY, GLC431BK, GLC431C,
  GLC431M, GLC431Y, GLC431CMY, GLC431KCMY, GLC431XL* (6 rows); CLC3317BK, CLC3317C, CLC3317M,
  CLC3317Y, CLC3317CMY, CLC3317KCMY, GLC3317* (7 rows); CLC73*, GLC73*. CLC431XLKCMY, CLC3317KCMY
  and CLC73BK are among the most-ordered SKUs.

#### 9. What ink does my printer use?

- URL: `/guides/what-ink-does-my-printer-use`
- Target queries: what ink does my printer use 10; which ink cartridge do i need 10; how to find
  printer model number 10.
- Outline:
  1. Where the model number is printed, by brand.
  2. Search by printer on our site.
  3. Read the code on the old cartridge.
  4. Regional codes that differ (`src/utils/regionalCodeAliases.js`: Canon PG-540 / PG-640, Brother
     TN-2450 / TN-2445).
  5. Genuine or compatible.

### 4. Measured, not recommended now

- Cartridge recycling: ink cartridge recycling 50, recycle ink cartridges near me 50, toner cartridge
  recycling 30 (130 a month, 3 clusters). This is the largest how-to demand measured. It is local
  "where can I drop it off" intent, no product links from it, and it needs verified NZ programme facts.
  Build it only if the business runs or joins a take-back scheme.
- Refilling cartridges: how to refill ink cartridge 20, and "ink refill" queries already reach the home
  page at position 40 or lower. We sell no refill kits. Guide 7 covers the refillable printers we supply.
- Genuine versus compatible: `/genuine-vs-compatible` already exists (328 impressions in 90 days,
  position 25, 0 clicks). Measured demand is close to nothing (genuine vs compatible ink 0, are
  compatible ink cartridges good 10). Improve the existing page instead of adding one.
- Warranty questions ("will compatible ink void my warranty"): do not write. CLAUDE.md inv 13 bans
  OEM-warranty-impact claims.

### 5. Copy rules

- inv 13: no "Save up to N%", "Lowest price", "Best in NZ", "Guaranteed ..." or warranty-impact claims.
  Never write "tested for <model>". A compatible cartridge is "compatible with" the printer, never
  presented as the maker's product. Scan every guide with the shared banned-phrase list
  (`src/utils/complianceClaims.js`).
- inv 9: returns days, guarantee days, the dispatch cutoff and the free-shipping threshold come from
  `GET /api/site/trust` and `GET /api/site/value-props`. Never type them into the page.
- No prices or "from $" in guide copy. Prices move nightly; link to the product page instead.
- Printer-to-cartridge tables come from our printer pages (`/api/printers/:slug/products`) and are
  checked against the maker's own list before publishing (the HP 63 / 65 caution in guide 4).
- Reset and installation steps follow the maker's manual for the model. Link to the maker's support
  page instead of writing a generic button sequence.
- Do not repeat these live claims until the owner confirms them. The business drop-ships through its
  suppliers (CLAUDE.md §1.4, `audit-competitive-pricing.js`).
  - `/genuine-vs-compatible` (backend `buildStaticPages`): "We test our compatible range for print
    quality, page yield, and chip compatibility" and "from our New Zealand warehouse".
  - `/about`: "We ship NZ-wide from our warehouse".
- A guide that carries FAQPage JSON-LD must show the same questions and answers on the page,
  byte for byte (inv 11).

### 6. Build notes

- FE builds each guide as static HTML (CLAUDE.md §12.4). Any later copy change is made by hand.
- Crawlers: `/api/prerender/*` serves only the pages in `buildStaticPages()`. A guide the FE serves as
  full HTML needs no backend prerender. If a guide is added to `buildStaticPages()`, both copies must be
  kept identical by hand.
- Sitemap: guides are not in `sitemap-static.xml` (`STATIC_PAGES`, `src/routes/seo.js`). Adding them
  is a one-line backend change per guide, once the page is live.
- Structured data: Article plus BreadcrumbList. Google retired HowTo rich results in 2023 and limits FAQ
  rich results to government and health sites, so write the steps as a plain numbered list. FAQPage
  JSON-LD is optional; AI answer engines still read it.
- Internal links: each guide links to the printer pages and products listed above. Each of those
  printer pages links back to the guide (FE).
- Measure: Search Console with a page filter on `/guides/`. Check after 90 days whether each guide's
  head query sits in the top 10.


---

# Appendix B — Mobile speed spec (checklist item 32)

Source: backend repo `docs/storefront/mobile-speed-FE-handoff-oct2026.md`, verbatim. The screenshots it names are in the backend repo folder `docs/storefront/ad-landing-cro-oct2026-09/`; ask us for them.

## Mobile speed: show the first screen at once

**For:** storefront developer · **Priority:** P1 for fixes 1 and 2 (both small), P2 for the rest · **Raised:** 18 October 2026 · **Backend:** nothing to wait for

This is item 32 in `FE-MASTER-CHECKLIST-oct2026.md`, and this file is the full spec. It replaces the 18 Oct notes in that item. Two of those notes were wrong:
- (e) The Google Merchant badge is already deferred in `footer.js`.
- (f) The home hero is not hidden by its own CSS. The whole page is, by the body and main fade-ins described in fix 1.

### Why

Mobile converts at half the desktop rate, and the ads land on series pages and product pages.

On 18 Oct, Lighthouse 12.6 (default mobile settings) scored mobile performance 58–60, with LCP between 11.8 s and 15.0 s. Total blocking time was only 50–90 ms, so the phone is not busy running script. The page is waiting. Most of that wait comes from the site's own entrance animations, and the rest from below-the-fold requests and unminified files sharing a slow connection with the first screen.

### What we measured

**Lighthouse, default mobile** (simulated slow 4G, Moto G Power):

| Page | Performance | FCP | LCP | LCP element | Where the LCP time goes |
|---|---|---|---|---|---|
| `/` | 58 | 4.0 s | 15.0 s | `section.hero` (background image) | load delay 5.4 s, render delay 6.2 s |
| `/ink-cartridges` | 60 | 4.0 s | 11.8 s | `h1#drilldown-title` | render delay 11.3 s (96%) |
| `/products/…/GLC432XLBK` | 59 | 4.4 s | 14.2 s | `#product-image img` | load delay 7.0 s, load 3.2 s, render delay 3.5 s |

**First visible frame with no throttling at all** (same tool with `--throttling-method=provided`, and the observed timeline of the runs above):

| Page | DOMContentLoaded | First visible frame |
|---|---|---|
| `/` | 1.41 s | 3.16 s |
| `/ink-cartridges` | 1.08 s | 1.56 s |
| GLC432XLBK (run 1 / run 2) | 1.11 s / 0.59 s | 2.41 s / 3.14 s |

Every render-blocking file had arrived by 0.55 s in run 2. The filmstrips show a white screen until those times:
- `ad-landing-cro-oct2026-09/item32-filmstrip-home.jpg`
- `ad-landing-cro-oct2026-09/item32-filmstrip-category.jpg`
- `ad-landing-cro-oct2026-09/item32-filmstrip-pdp.jpg`

Each page transfers 1.9–2.0 MB in 94–111 requests. JavaScript accounts for 1.3–1.4 MB of that: 460–570 KB is ours (1.3–1.7 MB before compression, unminified), and the rest is third-party.

### Fix 1 (P1, small): no entrance animation on the first screen

**What happens now**
- `css/modern-effects.css` ("SMOOTH PAGE TRANSITIONS") gives `body` the rule `animation: pageLoad 0.4s` and `main` the rule `animation: slideUp 0.5s`. Both start at `opacity: 0`. An animation starts on the page's first frame, so anything that delays that frame delays the fade as well.
- `js/modern-effects.js` `initScrollAnimations()` adds `.will-animate` (`opacity: 0; transform: translateY(30px)`) to every `section`, `.product-card`, `.feature-card` and so on, except the hero and anything holding a search form. An element appears only when one of these marks it `.in-view`: the IntersectionObserver, the next `requestAnimationFrame`, or the 2 s safety net. A 0.6 s transition then runs. On the product page the buy box is `section.product-detail`, so it goes through this too.

**Evidence**
- In the product-page trace with no throttling (run 2):
  - The main thread laid out the page at 0.41 s and painted at 1.35 s.
  - The first visible frame came at 3.14 s, straight after a `transitionend` event.
  - DOMContentLoaded was at 0.59 s. Adding the 2 s safety net and the 0.6 s transition gives 3.19 s.
- Playwright, iPhone 13, no throttling, product page:

  | Time | `body` opacity |
  |---|---|
  | 0.40 s | 0 |
  | 0.50 s | 0.26 |
  | 0.60 s | 0.59 |
  | 0.90 s | 1 |

  `main` reached 1 at 1.0 s, and FCP was 0.84 s. So even on a fast phone with a fast connection, the first half-second of painted content cannot be seen.

**What to change**
1. Delete the `body { animation: pageLoad … }` and `main { animation: slideUp … }` rules.
2. In `initScrollAnimations()`, do not add `.will-animate` to an element that is already on screen when the function runs. In the same loop, before adding the class, test `el.getBoundingClientRect().top < window.innerHeight`. Elements below the fold keep the reveal, safety net included.
3. Keep the existing exemptions and resting state:
   - the `.hero` exemption;
   - the `.search-form` exemption (ERR-217);
   - `transform: none` as the resting state (ERR-239).

This also fixes (d) from the old item: the `/ink-cartridges` CLS came from `.drilldown-content.will-animate`.

**Done when:** in a DevTools Performance recording (mobile emulation, no throttling), the first frame that shows anything shows the header and the h1. `getComputedStyle(document.body).opacity` must be `1` in that frame.

### Fix 2 (P1, small): ship the final h1 on `/ink-cartridges` and `/toner-cartridges`

**What happens now:** the HTML h1 says "Shop Ink Cartridges & Toner NZ". Later, `shop-page.js` `updateTitle()` replaces it with `landingH1()`: "Ink Cartridges NZ — Genuine & Compatible". Changing the text paints a new LCP candidate, so the LCP becomes the moment `shop-page.js` runs. That is why 11.3 s of the 11.8 s LCP is render delay.

**What to change**
- The HTML served for these two paths should carry the `landingH1()` text in the h1 from the start. That is the same text the prerendered page has, so the page shoppers see and the page Google sees stay identical.
- Both routes are rewrites onto the shop page. Either emit two HTML files at build time, or point the Vercel rewrites at two copies.
- Do not use an inline script: the CSP has no `'unsafe-inline'`, and the site has no inline scripts today.
- In `updateTitle()`, write `textContent` only when the new text differs from what is already there.

**The general rule:** replacing a first-screen heading after load moves the LCP to the moment of the replacement. This applies to series and printer pages too.

### Fix 3 (P2): the product image competes with below-the-fold requests

`pdp-prefetch.js` already starts the product read in `<head>` and preloads the hero image with `fetchpriority="high"`. Keep it.

In the 18 Oct run, the image request started at 1.49 s, the moment the product JSON arrived. Within the same 15 ms the page also started these requests:

| Request | Size (uncompressed) |
|---|---|
| `/api/shop?brand=brother&category=ink&limit=200&code=LC432` (related products) | 53 KB |
| `/api/products?brand=brother&category=ink&source=compatible&limit=200` (the compat-recovery sidecar in `API.getShopData`, `api.js`) | 361 KB |
| `/api/products/GLC432XLBK/for-use-in`, `/bought-together`, `/reviews`, `/reviews/summary` | about 1 KB each |

Ten more product images followed between 2.3 s and 2.6 s. On a phone connection all of these share bandwidth with the hero image: the simulation gives a 32 KB image 3.2 s of load time.

**What to change**
- Start the related-products block, and its images, when it comes within about 600 px of the viewport (IntersectionObserver) or after the hero image's `load` event, whichever happens first.
- **The sidecar:**
  - Your 20 Sep re-measure found that it recovers nothing on the pairs measured. The code comment keeps it as a guard against a backend `series_codes` regression.
  - Since 15 Oct (BF-102), the backend builds the `?code=` listing from the same codes it emits as `series_codes`. A replay over every brand and category found 0 mismatches across 1,215 chips, and a backend test now pins that.
  - Run `npm run probe:lookalike` across the catalogue. If it recovers 0 rows, delete the sidecar.
  - If you keep it, skip it for the product page's related-products call. That call is not the chip drilldown the sidecar was written for.

In this run the product JSON itself took 0.92 s. A warm edge serves it in about 40 ms. Edge caching is the backend's job, not yours.

### Fix 4 (P2): fewer bytes before the first screen

- **Fonts.** The Google Fonts stylesheet blocks rendering; Lighthouse estimates about 1 s.
  - Self-host the two files the first screen uses: Inter (47 KB) and Plus Jakarta Sans (27 KB). Each family is one variable file, so the weight lists add no bytes.
  - Declare them with `@font-face { font-display: swap }` in `base.css`, and preload each with `<link rel="preload" as="font" type="font/woff2" crossorigin>`.
  - Then remove the Google Fonts `<link>` and its two preconnects.
  - JetBrains Mono (31 KB) loads on category and product pages for the SKU line and the breadcrumb. Use the system stack instead: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- **CSS.** Six stylesheets (173 KB) block rendering.
  - `pages.css` is 82 KB, and 74–77 KB of it is unused on each page measured.
  - Minify all CSS: Lighthouse estimates 73–77 KB saved.
  - Split `pages.css` by page type (home, shop, product, account and checkout), so each page loads only its own rules.
- **`js/gtag.js`** (24 KB, unminified) blocks the parser in `<head>`. Add `defer`, and keep `gtag('consent', 'default', …)` as the first command in the file so it still runs before any `config`. Do this together with item 45, which changes the GA4 id in the same file.
- **Minify the 27 first-party JS files.** Lighthouse estimates 260–330 KiB saved per page. The `?v=` hashes already make the year-long `immutable` cache safe.
- **Load on demand:**
  - `supabase-js` (43 KB from jsDelivr, 35 KB of it unused): load it only when the visitor signs in or opens the account.
  - `search.js` (25 KB): load it the first time the search box gets focus.
- **`transition: all`** appears in at least 76 rules: 32 in `components.css`, 26 in `pages.css`, 11 in `layout.css` and 7 in `modern-effects.css`. On load these start a `scrollbar-color` transition on every button, link, input and product card; a product-page load fired dozens of `scrollbar-color` `transitionend` events in its first 1.2 s. In each rule, name only the properties that actually change (for example `background-color, color, box-shadow, transform`).

### Fix 5 (P2): images

- **Home hero.** `hero-background.jpg` (134 KB) is a CSS background in `pages.css`, so the browser finds it only after `pages.css` has arrived; it was requested at 1.34 s.
  - Convert it to WebP or AVIF: Lighthouse estimates 81 KB saved.
  - Give phones a smaller file with `image-set()` or a media query.
  - Preload it in the home `<head>` with `fetchpriority="high"`, using the same URL the CSS uses.
- **Brand logos on `/ink-cartridges`** load at full size from Supabase. Lighthouse estimates 168 KB saved by sizing them.

  | Logo | Size |
  |---|---|
  | `hp.png` | 66 KB |
  | `brother.png` | 35 KB |
  | `epson.png` | 28 KB |
  | `canon.png` | 26 KB |
  | `fuji-xerox.png` | 21 KB |

  - Request them through `/api/images/optimize?url=…&w=<2 × display width>&format=webp`, as product images already are.
  - Give every logo `<img>` a `width` and a `height`.
  - Lazy-load the logos below the first screen (Dymo, Lexmark, Samsung).

### Fix 6 (P2): accessibility (Lighthouse 90–94)

- **Contrast fails** on:
  - `.ink-finder__subtitle`, `.ink-finder__tab` and `.ink-finder__help`;
  - `.footer-column__heading`;
  - the consent banner's link and Accept button;
  - the product page's breadcrumb and printer links.
- **Hidden but focusable:** the product page has focusable elements inside `[aria-hidden="true"]`.
- **Unsized images:** brand logos (`/assets/brands/*`) and the product image have no `width` and `height`.
- **Tap sizes:** item 31 is still open.

### Already done: no action

- **Google Merchant badge and survey.** `footer.js` loads `platform.js` after `load` plus `requestIdleCallback` (5 s cap), or on the first scroll, tap or key press. The survey loads only on the order confirmation page, and only with consent. Its roughly 430 KB still downloads on every page, but after load. Leave it.
- **Best practices score of 79.** It comes from third-party cookies set by the Bing UET, Google Ads and Merchant tags. Leave those tags as they are.
- **`pdp-prefetch.js`.** Keep it as it is (see fix 3).

### Done when

- The fix 1 check passes on `/`, `/ink-cartridges`, a series page and a product page.
- With Lighthouse default mobile settings (median of 3 runs), the series page `/shop?brand=epson&category=ink&code=288` and GLC233BK have LCP under 4.0 s and CLS under 0.1.
- A cold desktop load of `/ink-cartridges` has CLS under 0.05.

**How to measure:**

```
npx -y lighthouse@12.6.0 <url> --chrome-flags="--headless=new" --only-categories=performance --output=json --output-path=lh.json
```

Add `--throttling-method=provided` to see real timings without simulation. The first visible frame is `audits.metrics.details.items[0].observedFirstPaint`. Tell us when a deploy is live, and we will re-run the pages in the tables above plus the series page.

### Do not

- Add an inline `<script>`: the CSP refuses it.
- Change the wording of an h1: it must stay identical to the prerendered page.
- Remove the Google Ads, Microsoft Advertising, GA4 or Merchant tags.
- Drop the `.hero` and `.search-form` exemptions or the `transform: none` resting state in `modern-effects`.
