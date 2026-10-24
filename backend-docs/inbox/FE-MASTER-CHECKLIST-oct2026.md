# FE checklist: what to build next (updated 22 October 2026)

**This is the one file to work from.** It has every open item with its full spec, the status of every item so far, the backend changes you need to know about, and the copy rules. The backend side of every item is already live on `api.inkcartridges.co.nz`.

Screenshots for items 22–32 are in the repo folder `docs/storefront/ad-landing-cro-oct2026-09/`. Ask for them if you do not have repo access. The file names are quoted in each item.

**Goal (owner):** a shopper who clicks an ad lands on the exact product they searched for, and gets from there to a paid order with no friction.

### 22 October audit: what to ship first

The owner approved a four-week plan on 22 Oct after a full audit of ads, site, SEO and competitors. The site converts non-ad visitors well (6.2% of sessions since 5 Oct; Stripe 40 of 40), so the FE work that matters most is the work that helps paid and printer-page visitors find a product they can buy. In order:

- **Week 1:** item 37 (printer finder first on brand pages: paid visitors who type their printer buy 8.3% of the time, those who only browse the brand grid 2.9%); item 35 (privacy page names the ad tags; compliance); items 43 and 33 (the `grid_ready`, grid `add_to_cart` and `client_error` beacons, without which the 17 Nov landing-test read is blind).
- **Week 2:** item 38 (one-click "Remind me": 2 of 223 orders have reminder consent today); item 45 (GA4 `G-YJXTSGLM28`); item 34 (`gbraid` / `wbraid` on orders); item 46 below (printer pages).
- **Weeks 2–3:** item 32 fix 1 (no first-screen fade-ins), item 25, item 23, and checkout "Continue" scrolling to the field that blocks it.

### Item 46 (P1, new 22 Oct): printer pages sell what fits

Printer pages are where printer searches, and most of the growth in free Google clicks, now land, and they convert about 1.3% against 4.2% for other landings. On the printer page (`/shop?brand=…&printer_slug=…`):

1. List in-stock compatible cartridges first (cheapest first), then genuine. Where two compatibles replace the same OEM part, show the cheaper one first.
2. Every card carries its price and an Add to cart button.
3. Tell us when it ships: the backend bot prerender (`/api/prerender/printer/…`) must list the products in the same order, because the page bots see and the page people see must match.

---

## Start here: the order of work

1. **Item 38 (P1, small, owner 15 Oct: repeat customers):** a one-click "Remind me" button on the order confirmation page. Item 19's checkout box works, but 0 of 20 paid orders since 7 October ticked it, and a first-time buyer can only get a reorder reminder after saying yes.
2. **Item 37 (P0, owner 13 Oct):** "Find your printer" first on every brand and category page, and site search goes straight to the printer or product the shopper named. Do this first.
   **Item 35 (P1, small, compliance):** the privacy page must disclose the Google Ads and Microsoft Advertising tags. Do this first: it is copy only.
   **Item 33 (P1, small):** report the shop drilldown's error state. An ad visitor hit it on 10 October and nothing recorded why.
   **Item 34 (P1, small):** send the iPhone click ID (`gbraid` / `wbraid`) with the order. The backend accepts it now.
   **Item 45 (P1, one line, owner 17 Oct):** send the site's GA4 data to `G-YJXTSGLM28`, the property the owner can open and the one that already receives every purchase.
3. **Items 22–27 (P1):** make ad landings convert. **Item 32 fixes 1–2 (P1, small):** the first screen is invisible until the entrance animations finish.
4. **Item 16 (remaining part) and item 20.**
5. **Items 28–31 and the rest of 32 (P2).**
6. **Item 18** (admin page).
7. **Item 13:** built. It needs one real guest order from the owner, and FE work only if that order shows a problem.

## Status of every item (live check of 9 October)

| Item | What | Status |
|---|---|---|
| 1 | Remove the "I authorize this payment" tick | Done |
| 2 | Apple Pay / Google Pay from the cart | Done (`cartWallet: true`) |
| 3 | Cart: Proceed to Checkout on the first screen | Done |
| 4 | One shipping figure, inside the total | Done |
| 5 | Service row next to Add to Cart | Done |
| 6 | Reward points next to the price | Done |
| 7 | Consent card off the first series card | Partly done. The card still covers the 5th and 6th first-row Adds at 1366×768. **Replaced by item 24.** |
| 8 | Delivery times, South Island 1–3 business days | Done (holds) |
| 9 | Proceed to Checkout in under 1 second | Done (113 ms desktop) |
| 10 | "Download PDF quote" | Done |
| 11 | Polish (address search, region label) | Done |
| 12 | `/cart?add=` fills the cart | Done |
| 13 | One-step account on the order confirmation page | Built; needs one real guest order (owner) |
| 14 | Cart unit price follows the volume price | Done (FE measured 7 Oct) |
| 15 | Catch a bad email at checkout, not at Pay | Done (FE measured 7 Oct) |
| 16 | Our compatible version on genuine product pages | Live. **Open: the page-yield line** (see item 16 below) |
| 17 | Cart quantity stops at stock | Done (FE measured 7 Oct) |
| 18 | Admin: "Negative keyword suggestions" page | **Open** |
| 19 | Reorder-reminder box on `/checkout` | Done (checked in code 15 Oct: card and PayPal both send `reminder_consent: true`). 0 of 20 orders ticked it, so item 38 asks again after payment |
| 20 | Cart wallet button appears with the page | Live on mobile; timing not measurable without a real wallet. **Open** |
| 21 | Series page honours `&source=` | Done |
| 22–32 | Ad-landing CRO | **Open** (full specs below; 32 re-specified 18 Oct, fixes 1–2 now P1) |
| 33 | Shop drilldown error state sends `client_error` | **New, open** (12 Oct) |
| 34 | Checkout sends `gbraid` / `wbraid` beside `gclid` | **New, open** (12 Oct); backend live |
| 35 | Privacy page discloses the Google Ads + Microsoft Advertising tags | **New, open** (13 Oct); backend prerender done |
| 36 | Series pages: Google rates their landing experience below average | **New, open** (13 Oct) |
| 37 | "Find your printer" first on brand/category pages; search goes straight to the exact printer/product | **New, open, P0** (13 Oct) |
| 38 | Order confirmation page: one-click "Remind me when it's time to reorder" | **New, open, P1** (15 Oct); backend live |
| 39 | Admin: Retention panel (do customers come back?) | **New, open** (15 Oct); backend live |
| 40 | Reorder reminders for signed-in customers (product page + account page) | **New, open, P2** (15 Oct); backend live once deployed |
| 41 | How-to guides (`/guides/...`) | **New, open, P2** (15 Oct); content plan ready |
| 42 | SEO housekeeping: permanent apex redirect, noindex private and search pages, printer-page description | **New, open, P2** (15 Oct) |
| 43 | Tracking: `grid_ready`, Add on listing grids, session id on cart requests, test browsers skip the beacon | **New, open, P1** (17 Oct) |
| 44 | Regression check: series/product pages, 27 vs 29 Sep builds | **New, open, P1** (17 Oct) |
| 45 | GA4: configure `G-YJXTSGLM28` instead of `G-SDQELG0FGD` (one property for visits and purchases, owned by the owner) | **New, open, P1** (17 Oct); no backend change |
| 46 | Printer pages: in-stock compatibles first, price and Add on every card | **New, open, P1** (22 Oct); backend prerender follows the FE order |
| 47 | Checkout email hint misses two-slip typos (`gial.com`) | **New, open, P1, small** (22 Oct); no backend change |

---

## Why this matters now

- Since 9 October, Google Ads bids on **profit only**: it pays for a click only what the order behind that click keeps. More orders from ads now have to come from the **page converting better**, not from higher bids.
- Search ad clicks convert at **5.8%**. Ads break even at about **12.4%**. **54%** of ad visitors leave after one page.
- Ad buyers are almost all first-time customers (71 of 77). Most decide in one sitting: 59 of 71 order within an hour of the click. Orders cluster just above the **$100 free-shipping line** (median $111). Baskets of **$200+** keep $53 each; no order under $100 kept more than $26.
- Ad clicks land on:
  - `/ink-cartridges` and `/toner-cartridges`;
  - series pages `/shop?brand=…&category=…&code=…`, including `&source=compatible|genuine` and `&pack=value_pack`;
  - printer pages and product pages.

  On 9 October the cartridge-code searches were switched back on: HP 63, 955 and 564, Brother TN2530 and 72 more families. These were the best-converting searches in September, and they land on **series pages**, so those pages now carry more of the paid traffic.

## What changed on the backend on 16 October

Nothing here needs FE work unless it says so.

1. **Order email:** one reminder ask only ("Remind me when it's time to reorder"). The "Reorder on a schedule" block is gone; old emails' links still work.
2. **"Remind me" after an unsubscribe:** pressing it switches the customer's reorder reminders back on, and tells them plainly when something else (a bounced address, an unsubscribe from all our emails) still stops reminders. **FE:** item 38 shows the matching line (new response fields).
3. **Reorder links in emails** now open a short confirm page before anything goes in the cart, so an email scanner cannot fill a cart. **FE:** item 40, point 4.
4. **Product titles:** "High Yield" / "High Capacity" now come from the part number only. Standard toners and drums no longer carry them (154 titles changed). No FE change.

## What changed on the backend on 15 October

Nothing here needs FE work unless it says so.

1. **Prices (14 Oct):** 175 single prices were cut to just under the cheapest comparable NZ price, never below a 25% gross margin, and 67 value packs were re-priced to match. No FE change.
2. **Shipping email:** it now carries the same "Remind me when it's time to reorder" button as the order and day-1 emails.
3. **Refill reminder and follow-up emails:** rewritten to one product list at the customer's own price and one reorder button, with a plain subject such as "Running low on Brother LC233?".
4. **Order email:** the scheduled-reorder block no longer says "get this order again automatically" (nothing orders by itself). It now reads "Reorder on a schedule … Nothing is ordered or charged until you check out".
5. **Product page titles and descriptions (search results):** titles now carry the code people search ("HP 62 Ink Cartridge Black", not "HP 62BK …"), titles cut mid-word by an old generator are replaced, and printer-page descriptions name only the sources listed and end on a whole sentence. Built in the backend; nothing to do unless the SPA writes its own printer description (item 42).
6. **New:** items 38 (confirmation page), 39 (admin Retention panel), 40 (reorder reminders), 41 (guides) and 42 (SEO housekeeping) below.

## What changed on the backend on 9 October

Nothing here needs FE work unless it says so.

1. **Cart trust chip:** `trust_signals.shipping_promise.label` now reads "Dispatched same day in Auckland metro (order by 2pm)". It used to read "Same-day dispatch before 2pm", which claimed same-day dispatch everywhere. **FE check:** the text is longer than before, so make sure the cart chip wraps cleanly at 390 px.
2. **Value packs GCART069HCMY and GCART069HKCMY:** their `compare_price` is cleared, so no "Save $X" shows on them any more. The old figure was false: these packs cost more than buying the singles.
3. **Prices:** 247 single prices were put back to their pre-cut levels, and 92 value packs were re-priced to match. No FE change; cached responses expire within 5 minutes.
4. **Day-1 email:** it now asks "Remind me when it's time to reorder", using the same signed link as the order email. The checkout box (item 19) is still the main way a first-time buyer can say yes.
5. **Refill follow-up emails:** these now go only to repeat buyers or to customers who said yes. Before, they reached one-order buyers who never agreed.

## Copy rules for every new piece of text

- **No price comparisons or superlatives:** no "cheapest", "lowest", "best price", "price match", "save vs …", percentages against rivals, rival names, star ratings or review counts (invariant 13; the account was suspended over this in May 2026).
- **Same-day dispatch:** always say **Auckland metro**, and take the cutoff from `GET /api/site/trust` (`shipping_promise`): it has been **12pm (noon) NZT on a business day since 12 October**, not 2pm. Never type the time into the page.
- **Free shipping:** always say **over $100**.
- **Fit and guarantees:** never say "guaranteed fit". The 30-day satisfaction guarantee covers **compatible** products only. Genuine products carry the manufacturer's warranty.
- **Trust facts** (returns, guarantee, dispatch, founded year, GST invoice) come from `GET /api/site/trust`. Never type the numbers into the page.

---

## Open items: full specs

### 16. P1: the remaining part of "our compatible version" on genuine product pages

The box is live on GLC233BK: CLC233BK at $8.99, with View, Add and the guarantee line. The page-yield line from the spec is still missing. `compatible_alternatives[0].page_yield` is "Up to 550"; show it as **"Up to 550 pages"** under the price.

### 18. P2 (admin): "Negative keyword suggestions" review page

**Why (owner, 7 Oct):** nothing may add a negative keyword to Google Ads without the owner approving it first. Automated jobs now FILE suggestions; approving one is what writes it to Google Ads.

**Backend (live, super_admin only):**
- `GET /api/admin/ads/negative-suggestions?status=pending` (`pending` default; also `approved`, `rejected`, `applied`, `failed`, `all`) → `{ suggestions: [...], count, status }`. Each row: `id, created_at, source, scope` (`ad_group` / `campaign` / `shared_set`), `target_label` (e.g. "Search - Consumables NZ / Ink NZ"), `keyword_text, match_type, reason, evidence` (object: spend, conversions, paused groups), `status, decided_at, applied_at, error`.
- `POST /api/admin/ads/negative-suggestions/:id/approve` → writes the negative to Google Ads; `{ status: 'applied' }`. `409 NOT_PENDING` if already decided; `502 ADS_WRITE_FAILED` with Google's reason if Ads refused it (the row is then `failed`).
- `POST /api/admin/ads/negative-suggestions/:id/reject` → `{ status: 'rejected' }`, writes nothing.

**What to build:** an admin page under Ads (or Marketing) listing pending suggestions: keyword, match type, where it would apply (`target_label`), the reason, and the evidence. Approve and Reject buttons per row; a tab for the history (`all`). Show the backend's message on 409/502. No bulk approve for now: the owner wants to decide each one.

**Done when:** a pending suggestion appears on the page; Approve moves it to "applied"; Reject moves it to "rejected"; a second click on a decided row shows "already decided".

### 19. P1: "Email me when it's time to reorder" box on `/checkout`

**Why (owner, 7 Oct):** grow the returning-customer pool. Reorder reminders may only go to customers who said yes (NZ spam law: one purchase is not consent), and 149 of 165 recent customers had one order and were never asked. The order email now asks with a button; the checkout should ask too, because every buyer sees it.

**Backend (live):** `POST /api/orders` accepts `reminder_consent: true`. Only a literal `true` records consent (stored on the order with the time and source `checkout`); `false` or absent records nothing.

**What to build:** one checkbox on `/checkout`, near the email field, **unticked by default** (a pre-ticked box is not consent): "Email me when my cartridges are likely running low, so I can reorder in time." Send `reminder_consent: true` only when ticked. Same for guests and signed-in customers.

**Done when:** placing an order with the box ticked sends `reminder_consent: true` in the `POST /api/orders` body; unticked sends nothing or `false`; the box starts unticked on every visit.

**Still to confirm (9 Oct):** the box is live. Please confirm that a ticked box sends `reminder_consent: true`. No order has recorded consent yet, from either the box or the order email's button.

### 20. P1: the cart's Apple Pay / Google Pay button appears with the page

**Why (owner, 8 Oct):** "The 'Pay instantly' option appears too late when I open the cart."

**Measured 8 Oct** on www `/cart` (one item, guest, Chromium): the page paints at 0.4 s; the wallet button appears at **3.3 s** with an empty browser cache and **2.0 s** with a warm one. `cart-wallet.js` `init()` runs every step one after the other:

| Step | Cold cache |
|---|---|
| DOMContentLoaded, `init()` sets `loading` | 0.55 s |
| `_waitForCartReady()` returns (cart loaded) | ~1.4 s |
| Stripe.js, then `payment-page.js`, loaded | ~1.5 s |
| ECE iframes mounted | ~2.0 s |
| ECE `ready` (Stripe asks the device which wallets it has) | 3.3 s |

The box is `hidden` until `ready`, so the whole wait shows as a button that pops in late. The backend is not the slow part: `/api/cart` answers in 0.3 s warm, 0.75 s cold. The last step (about 1.5 s) is Stripe's own device check and no site can skip it. The first two items below remove the rest of the wait, or hide it.

**What to build:**

1. **Hold the space from the first paint.** While `data-wallet="loading"`, show the "or pay instantly" divider and a 48 px placeholder the size of the button. In `_setState`, hide the box only for `none`, `error` and `off`, not for `loading`. The Stripe button then replaces the placeholder in place, with no jump. With `applePay`/`googlePay: 'always'`, Safari, Chrome and Edge nearly always report a wallet, so the placeholder rarely collapses. If it does, remember that in `localStorage` (wrapped in try/catch) and skip the placeholder on the next visit.
2. **Start Stripe while the cart loads, not after.** Add `<link rel="preconnect" href="https://js.stripe.com">` and `<link rel="preconnect" href="https://b.stripecdn.com">` to the `cart.html` head. In `init()`, start `_load(STRIPE_JS)` **before** `await _waitForCartReady()`. Load `payment-page.js` alongside it without waiting for it: only `_confirm` needs it, so `await` it there.
3. **Optional, saves about 0.8 s more:** mount the ECE before the cart total arrives. Create the Elements group with `STRIPE_MIN_NZD_CENTS` as a provisional amount. `sync()` already calls `elements.update({amount})` when the server total settles. Keep two guards: the box becomes `ready` only when the ECE is ready **and** the server total is eligible (today's `no-server-total` rule), and the `click` handler does not resolve until the amount has come from the server. Every figure the sheet shows must still be the server's.

**Done when:** on `/cart` with one item, the "or pay instantly" area is visible at first paint, and the wallet button is live by about 2 s with an empty cache (3.3 s today). Measure: `MutationObserver` on `#cart-wallet` `data-wallet` against `performance.now()`.

### 22. P1: PDP, the product photo is below the first screen on desktop

**What is wrong:** on GLC233BK at 1366×768, the left half of the first screen is blank. The photo starts at **y 627** (the H1 is at y 290), and that strip is half covered by the consent card (`ad-landing-cro-oct2026-09/d5-pdp-GLC233BK.jpg`, `ad-landing-cro-oct2026-09/pdp_crop.jpg`).

**Cause:** `#product-image.product-gallery__main.product-gallery__main--zoomable` is `position:absolute; top:0; display:flex; align-items:center`. It stretches to the height of `.product-detail__layout` (1297 px), so a 552 px image is centred 370 px down. This most likely hits every PDP with a real (zoomable) photo, so nearly every genuine PDP. The compatible PDP checked (CTN2030BK, "COMPATIBLE" tile) is already top-aligned.

**Fix:**

```css
@media (min-width: 769px) {
  .product-gallery__main--zoomable { align-items: flex-start; }
}
```

Optional: also make `.product-gallery` `position: sticky; top: 16px`, so the photo stays beside the buy box while the shopper scrolls.

**Done when:**
- On GLC233BK at 1366×768 and 1280×551, the image top is within 40 px of the GENUINE badge (y ≈ 255), and at least 300 px of the image is on the first screen.
- The LCP element is the product image, with LCP under 1.5 s on desktop. Today it is 2.64 s, because the image paints late and low.
- CTN2030BK is unchanged.

**Why it matters:** a Shopping click is a click on the product photo. Landing on a page that doesn't show it breaks the match between ad and page. Ad landings on PDPs: 94 sessions in 30 days, 66% left without a click, **0 orders**. 78 of them were genuine PDPs, the pages this bug hits. **Measure:** the share of desktop PDP landings that leave without a click (65% today).

### 23. P1: Cart, put the basket-building prompts on the first screen

**Part a, mobile (under 769 px): line items before the order summary.** In the HTML, the line items come first, but CSS draws the summary first. On 390×664 with one item:
- the Order Summary is at y 459;
- the item card is at **y 1780–2003**, three screens down;
- the item card holds the stepper, "Save $2.87 — switch to the value pack" and "Add 2 more to reach 3+ — $8.63 each, saving $1.08 on this line." (`ad-landing-cro-oct2026-09/mcart.jpg`).

The sticky bar `#cart-sticky-bar` already keeps "Proceed to Checkout" on screen, so the summary no longer has to come first. Remove the mobile rule that reorders `.cart-summary` (an `order` or `grid-area` value) so the items render first. Do not change the sticky bar.

**Part b, all widths: free-shipping progress inside the totals.** Move the free-shipping block (`summary.free_shipping_message` plus the bar) directly under the "Shipping (est.)" row, above "Estimated total". Today it sits under "Download PDF quote" and the cart-email box: y 1203 on desktop, y 1151 on mobile.
- Show the tick icon only when `summary.qualifies_for_free_shipping` is true. Today a ✓ sits beside "Add $91.01 more…", which reads as done.
- The text comes from the backend as it is. Copy rule: free shipping is always "over $100".

**Part c, the cart drawer (mini-cart):** under the drawer's total, show the same `summary.free_shipping_message` whenever `summary.free_shipping_remaining` is above 0, and nothing at 0. Use the backend text as it is: never compute the gap in the page, and no "save" wording. When `free_shipping_unlock` is present (the gap is $25 or less), its filler tiles go under that line. A quantity change repaints the line from the `data.cart` that `PUT /api/cart/items/:productId` already returns.

**Done when:**
- With one CLC233BK at 390×664, the line item, with both prompts, starts above y 700.
- At 1366×768 and 390×664, "Add $91.01 more to qualify for free shipping." and its bar render between "Shipping (est.)" and "Estimated total".
- The cart drawer with one $44.49 cartridge shows "Add $55.51 more to qualify for free shipping."; a quantity change repaints it from the PUT response; at $100 or more the line is gone.
- The sticky checkout bar still passes item 3.

**Why it matters:**
- Mobile ad orders have a median basket of $81.49, against $123.63 on desktop, and 58% of them pay shipping (33% on desktop).
- On mobile today, every prompt that grows the basket sits below the summary.
- Shoppers who get close to $100 top up (3 orders at $80–100 against 17 at $100–120).
- An order moving from under $60 to $60–100 keeps $18.36 instead of $6.08.

**Measure:** median mobile ad-order basket ($81.49) and the share of mobile orders under $100 (58%).

### 24. P1: Desktop consent banner, use the compact bottom bar mobile already has

**What is wrong:** on desktop the banner is a 360×163 card that stays open for 85% of paid visitors. At 1366×768 it covers:
- the 5th and 6th first-row "Add" on series and printer pages (`elementFromPoint` returns `.consent-banner__body-long` and `.consent-banner__btn--decline`; see `ad-landing-cro-oct2026-09/d3-series-lc233.jpg`);
- the first result's Add in the search dropdown (`ad-landing-cro-oct2026-09/d4a-search-dropdown.jpg`);
- half of the cart line's "Add 2 more to reach 3+" prompt (`ad-landing-cro-oct2026-09/d6-cart.jpg`).

It is also the largest thing painted on the first screen: the LCP element on `/ink-cartridges`, series and printer pages is `p.consent-banner__body`.

**Fix:** from 769 px up, render the mobile layout. That is a full-width bar at the bottom, at most 64 px tall, with "We use analytics cookies." + "Privacy policy" + Decline + Accept on one line, and Decline and Accept given equal weight. Sketch (adjust to your markup):

```css
@media (min-width: 769px) {
  #consent-banner.consent-banner { left: 0; right: 0; bottom: 0; width: auto; max-width: none; border-radius: 0;
    display: flex; align-items: center; justify-content: center; gap: 16px; padding: 10px 24px; }
  #consent-banner .consent-banner__body-long { display: none; }
}
```

This replaces the per-page left/right placement from item 7.

**Done when:** at 1366×768, 1366×599 and 1280×551 with the banner open, `elementFromPoint` at the centre of each of these returns the control itself:
- every first-row "Add" on `/shop?brand=brother&category=ink&code=LC233` and on the MFC-J4620DW printer page;
- the cart's "Save $2.87…" pill;
- the PDP's Add to Cart.

The banner is at most 64 px tall.

**Why it matters:** this is part of the first impression for 85% of desktop ad visitors, and 54% of ad sessions see only one page.

### 25. P1: Mobile listing pages, "Filter & Sort" must not cover the first Add

**What is wrong:** `#filter-sort-bar` is fixed at y 540–607 (67 px), directly above the consent bar, on 390×664.
- On the printer page `/shop?brand=brother&printer_slug=brother-mfc-j4620dw`, the first card's **Add (y 528–574) is under it**: `elementFromPoint` returns `#filter-sort-open`.
- On the series page it covers the bottom edge of the first Add.
- It is styled like the main button (same blue, full width), so it competes with Add.
- With the header (128 px), the value strip (32 px), this bar and the consent bar, **43% of the first screen is fixed chrome** (`ad-landing-cro-oct2026-09/mobile_strip.jpg`).

**Fix:** render "Filter & Sort" inline above the first card, as a compact outline button no taller than 40 px. Make it sticky only after the shopper has scrolled past the first row of products, and never place it over an Add.

**Done when:** at 390×664, both with the consent bar open and after it is answered, scroll from 0 to 2000 px in 300 px steps. At each step, every Add in view on the series and printer pages passes `elementFromPoint`, except an Add lying under the consent bar itself. On the printer page, the first card's Add passes at scroll 0.

**Why it matters:** mobile converts at half the desktop rate (3.3% against 6.6%) and loses more visitors after one page (46% against 34%). The first card's Add is the first thing a mobile ad visitor can tap.

### 26. P1: PDP, show the 3+ price next to the price and move the pack offers up

**Part a: the 3+ price on the price row (no extra height).** After "Incl. GST · Earn 60 reward points ($0.60)", add "· 3+ $59.28 each". The figures are `quantity_breaks[0].min_quantity` and `.business_price`, read from the server, not calculated by the FE. "See all prices" jumps to the ladder.
- Series cards already do this ("3+ PRICE $8.63 ea"). The desktop PDP shows "3+ from $59.28 each" only at y 856, below the 768 fold, and the "Buy more, save more" ladder at about y 1210.
- Copy rule: the 3+ price never applies to one unit, and never say "on all orders".

**Part b, desktop only: remove the "DELIVERY" and "RETURNS" rows under the compatible box.** They repeat the service row that sits directly under Add to Cart. "Order within 12h 23m…" then becomes the only extra delivery line, and "Buy the full set" (now at y ~1040) and "Buy more, save more" both move up about 130 px.

**Done when:**
- On GLC233BK at 1366×768, "3+ $59.28 each" is within 30 px (vertically) of "$60.49".
- Add to Cart is still at y 513 ± 5 (and at y 471–519 on CTN2030BK at 1280×551).
- The top of "Buy the full set" moves up at least 100 px.

**Why it matters:** only 4.5% of ad-order lines reach 3+. A shopper can't respond to a price they never see. **Measure:** the share of ad-order lines with quantity ≥ 3 (5 of 112 today).

### 27. P1: Compatible guarantee where the shopper chooses between compatible and genuine

**What to show:** `trust_signals.warranty.compatible_label` ("Compatible cartridges are covered by our 30-day satisfaction guarantee."), read from `GET /api/site/trust`. Never hard-code it (invariant 9). Show it:
- **(a)** as a one-line subtitle under the "COMPATIBLE" column heading on series, printer and brand listing pages, and in the search dropdown's COMPATIBLE column;
- **(b)** on compatible PDPs, directly under the "Not sure it fits?…" line in the buy box. Today it appears only at y 2335 on CTN2030BK. On genuine pages it is already inside the item 16 box.

One line per column, not one on every card: a line under the heading says the same thing as a line on each card, with less clutter. Nothing comparative next to it (no "save", "same quality", percentages or rival names; invariant 13), and never "guaranteed fit".

**Done when:**
- On `/shop?brand=brother&category=ink&code=LC233`, the line is visible above the first compatible card at 1366×768, and under the COMPATIBLE heading at 390×664.
- It also shows in the search dropdown's COMPATIBLE column for "MFC-J4620DW", and in no genuine column.
- On CTN2030BK, it sits within 120 px below the service row.
- The text equals `warranty.compatible_label` from `/api/site/trust` exactly.

**Why it matters:** the owner wants compatible offered first. Compatible has the higher margin, and 10 of the last 13 ad buyers bought compatible only. The series page puts an $8.99 compatible next to a $60.49 genuine with nothing on the compatible side that answers "will it work?". The guarantee is that answer, and it is already in the API. Copy checked with `complianceClaims` (no match).

### 28. P2: Mobile checkout, the form jumps when the page finishes loading

**What is wrong:** on 390×664 under Lighthouse mobile throttling, `.checkout-form-wrapper` moves by roughly 270 px at 6.3 s (estimated from the shift score). Layout shift (CLS) is **0.371**, against 0.03 on desktop. The title, the step bar and the collapsed "Order summary $15.99 NZD" bar appear late and push the form down.

**Fix:** reserve their space from the first paint. Give the collapsed summary bar a fixed-height placeholder, and give the header block a min-height.

**Done when:** CLS on `/checkout` with one cart item, at 390×664 with Lighthouse mobile throttling, is under 0.1.

**Why it matters:** a form that moves while the shopper taps the email field causes mis-taps at the step where the money is.

### 29. P2: After Add, show the next step

**What is wrong:** after an add (tested from the compatible box), the only feedback is the header badge "1" and a text-only toast ("…added to cart"). The toast disappears after a few seconds. At 1366×768 the toast also covered the compatible box's Add button.

**Fix:** after any successful `POST /api/cart/items` (series card, PDP, compatible box or search dropdown):
- show a non-blocking toast with **View cart** and **Checkout**;
- add one line from the cart re-read the page already does: `summary.free_shipping_message`, or "Free shipping unlocked" when `qualifies_for_free_shipping` is true;
- keep it on screen for 6 s, make it dismissible, and never let it cover an Add (bottom-right on desktop; above the sticky bar on mobile).

**Done when:** adding CLC233BK shows both actions and "Add $91.01 more to qualify for free shipping.", and Checkout opens `/checkout`.

**Why it matters:** `link:/cart` is the 8th most clicked element on the site (128 clicks across 80 sessions in 30 days). Shoppers go looking for the cart.

### 30. P2: Checkout, put the reassurance under the total

**What is wrong:** the first checkout screen states none of the facts the cart shows (dispatch, returns, guarantee, tax invoice). On the cart they sit at y 1354–1650.

**Fix:** under "Estimated Total" on `/checkout` and `/payment`, add one compact block built from the cart response:
- `delivery_estimate.promise` ("Order by 2pm for same-day dispatch (Auckland metro) — 1–3 business days NZ-wide");
- `trust_signals.returns.label`;
- `trust_signals.guarantee.label`;
- `trust_signals.tax_invoice.label`.

**Done when:**
- At 1366×768, the block is visible next to the total without scrolling the summary.
- At 390×664, it is inside the expanded summary and repeated once under "Continue".

**Why it matters:** over the last 14 days, 19 desktop shoppers started checkout and 11 finished. Delivery time and returns at the point of paying are classic reasons people abandon.

### 31. P2: Mobile tap targets for the phone and links

**What is wrong:** on every mobile landing there are 4–7 tap targets under 24 px:
- `.service-row__link` phone (81×16) and email (178×16);
- the value-strip links (151×16, 71×16);
- "What's the difference?" (127×15).

**Fix:** give each a tap area at least 44 px tall (padding or `min-height`). Make the phone link `tel:{contact.phone_tel_href}`.

**Done when:** every link and button on the first screen at 390×664 has a hit area of at least 44×44, or at least 24 px with 8 px spacing (WCAG 2.2, 2.5.8).

**Why it matters:** "Questions? Call 027 474 0115" is the service promise the ads now lead with, and on a phone it is a 16 px target.

### 32. P1 (fixes 1–2) / P2 (rest): Mobile speed, show the first screen at once

**Full spec: `docs/storefront/mobile-speed-FE-handoff-oct2026.md`** (18 Oct). It replaces the notes this item carried; two of them were wrong: the Merchant badge is already deferred, and the hero is not hidden by its own CSS.

In short:
- Lighthouse mobile scores 58–60, with LCP 11.8–15.0 s.
- With no throttling at all, the first visible frame still comes at 1.6–3.2 s. The reason: `body` and `main` fade in from opacity 0, and every `<section>` waits for the scroll reveal or its 2 s safety net.

The fixes, in order:
1. No entrance animation on the first screen.
2. Ship the final h1 on `/ink-cartridges` and `/toner-cartridges`.
3. Start product-page related products near the viewport, and retire the compat-recovery sidecar if `probe:lookalike` finds nothing.
4. Fonts, CSS, `gtag.js` `defer`, minify.
5. Images.
6. Accessibility.

**Done when:** with Lighthouse mobile settings, the series page and GLC233BK have LCP under 4.0 s and CLS under 0.1, and a cold desktop load of `/ink-cartridges` has CLS under 0.05. Also, the first visible frame shows the header and the h1.

### 33. P1: Shop drilldown, report the error state when it shows "Retry"

**What we see:** shoppers clicked `#drilldown-retry-btn` 3 times in 5 days, so the drilldown failed to load for them:

| When (UTC) | Page |
|---|---|
| 10 Oct 23:17 | `/shop?brand=hp&printer_slug=hp-deskjet-2820e`, landing from a paid ad click |
| 7 Oct 00:46 | `/search?q=Ax250`, then `/shop?brand=brother&category=ink` (same session) |

The backend calls behind those pages answer 200 today: `/api/shop?brand=hp&printer_slug=hp-deskjet-2820e` in 0.5 s, `/api/shop?brand=brother&category=ink` in 1.0 s and `/api/search/smart?q=Ax250` in 2.7 s. So the failure was either brief or in the browser. Nothing tells us which request failed or why. `traffic_events` holds **zero** `client_error` events ever, so the BF-053 error beacon was never wired.

**Fix:** whenever the drilldown shows its error or Retry state, send one beacon to the existing traffic endpoint:
- `event_type: 'client_error'`;
- `element`: the surface name, then the failing request's method, path and status, or `timeout` / `network` when there is no status. Example: `shop-drilldown GET /api/shop?brand=hp&printer_slug=hp-deskjet-2820e 429`. The field takes up to 512 characters.

Use the same beacon for every other catalogue read that shows an error state (search, PDP, cart).

**Done when:**
- Forcing the request to fail (DevTools: block `/api/shop`) puts one `client_error` row in `traffic_events`.
- That row's `element` names the request and its status.

**Why it matters:** this shopper paid for the click and got an error instead of cartridges. We cannot fix a failure nobody records.

**Update (17 Oct):** all 8 human Retry clicks since 18 September came from **Safari 15.6 and iOS 15.8**. Reproduce on those first. Report the product page's "Try Again" state the same way, and send the `grid_ready` event from item 43 as well.

### 34. P1: Checkout, send the iPhone click ID (`gbraid` / `wbraid`) with the order

**What is wrong:** an ad click from an iPhone can land with `gbraid` or `wbraid` in the URL and **no** `gclid`. Checkout sends only `gclid`, so those orders reach us with no click ID. Google never learns the ad sold something, and our profit numbers count the order as not coming from an ad. In the last 90 days, about 6% of ad landings carried only `gbraid` or `wbraid` (91 of 1,463 click IDs in `traffic_events`), and 0 of 77 orders stored one.

**Backend (live 12 October):** `POST /api/orders` accepts `gbraid` and `wbraid` beside `gclid`: strings, up to 255 characters, trimmed. Before this, the server dropped both fields without an error.

**Fix:**
- Read `gbraid` and `wbraid` from the landing URL wherever `gclid` is read now. Keep them in the same storage, for the same time, as `gclid`.
- Send every one that is present on `POST /api/orders`. When a URL carries `gclid` and `gbraid` together (common), send both. The backend chooses which one Google gets.
- A new ad click **replaces all three**. Do not keep an old `gclid` next to a new `gbraid`, or the order is credited to the old click.

**Done when:** you land on `/shop?brand=hp&gbraid=FE_TEST_1` in a fresh browser and place an order for the admin test product (`TEST-` SKU, $0.50). That order's row then holds `gbraid = 'FE_TEST_1'` and no `gclid`. Test orders are never sent to Google.

**Why it matters:** Google bids on the profit we report for each click. Orders it never hears about make iPhone clicks look worthless, so it bids them down.

### 35. P1: Privacy page, disclose the advertising tags

**What is wrong:** `js/gtag.js` loads the Google Ads tag (`AW-18032498762`) and Microsoft UET (`bat.bing.com`). Both set advertising cookies, with no consent gate (only `analytics_storage` is declared). Google's tag also builds visitor audiences: "All visitors" (about 1,600) and the 3-day exclusion list (220). But `/privacy` names Google only for "Analytics (GA4), Customer Reviews, Tag Manager" (`legal-config.js` `dataProcessors`), and its cookie list names no ad tag. The backend's prerendered privacy page went further and said "We do not use third-party advertising or retargeting cookies". Google's ad policies require this use to be disclosed, and this account was suspended in May 2026.

**Backend (live 13 October, commit `54e6dce`):** the prerendered privacy page now says the sentence below and lists both platforms.

**Fix (owner approved 13 Oct):** use the same words on the human page, so the bot page and the human page match.
- `dataProcessors`, add: `{ name: 'Google Ads / Microsoft Advertising', purpose: 'Advertising measurement: ad-click identifiers, the value of orders that followed an ad click, and cookie-based audiences of site visitors', region: 'United States' }`.
- Cookie list (§6), add a row: category "Advertising", examples "Google Ads tag, Microsoft Advertising (UET) tag".
- Cookies paragraph, add this sentence: "Google Ads and Microsoft Advertising tags set cookies that tell us which ads led to an order, and let those platforms build audiences of our site's visitors, which we can use to decide who sees our ads."

**Done when:** `/privacy` names Google Ads and Microsoft Advertising, and no page says the site uses no advertising cookies.

**Not yet (owner decision):** if the owner switches on enhanced conversions (hashed email and phone sent to Google for ad orders), the privacy page needs more text first. The wording and the steps are in `docs/google-ads/enhanced-conversions-turn-on-oct2026.md`. Do not add it until the owner asks.

### 36. P1: Series pages, Google rates their landing experience below average

**What is wrong:** since 12 October every product search ad lands on a series page (`/shop?brand=…&code=…`). Google's keyword quality data (13 Oct) rates the landing page experience of 107 of the 149 rated keywords landing there as **below average**, and none as above average. 38 of the 41 keywords with Quality Score 1–3 land there. `/ink-cartridges` rates above average on 6 of 6. A low rating raises the price of every click and keeps 1,110 of 2,291 keywords under the first-page bid.

**Fix:** on the series page, at 1280×551 and 390×664:
- the first product card, with its price and Add, is on the first screen (no hero or filter block above it);
- Add works from the grid, without opening the product page;
- the page is interactive in under 2.5 s on mobile (measure LCP and INP; series pages share the listing bundle, so check what loads before the grid).

**Done when:** the first card and its Add are visible without scrolling on both sizes, and mobile LCP is under 2.5 s. We re-read Google's rating around 27 October, since 754 keyword URLs changed on 12 October and Google needs time to re-rate them.

### 37. P0: "Find your printer" first on every brand and category page; search goes straight to the exact match

**Owner (13 Oct):** "make sure the 'Find your printer' search box is placed at the top of generic ink landing pages, and visitors should be directed directly to the exact product page they are looking for as much as possible."

**What we measured (13 Oct):**
- `/ink-cartridges` and `/toner-cartridges` already open with "Enter your printer model": at 390×664 its input sits at y 276–324, right under the H1. Keep it.
- But 25 ad visitors on 13 Oct made 0 add-to-carts. Most clicked a brand on `/ink-cartridges` and landed on `/shop?brand=canon&category=ink`. That page opens on "Select a Product Code" (CI3, CI6, CL38…) with **no printer box**. A shopper knows their printer, not the cartridge code, so they typed the printer into site search (TS5360, Ts9600, G7060, TS9565, MFC-J4340) and left.

**Fix:**
1. **Brand and category pages** (`/shop?brand=X` and `/shop?brand=X&category=Y`, the code-grid level): put the same printer box first, under the H1, before the code grid, on mobile and desktop.
   - Label "Find your {Brand} printer", placeholder from that brand (e.g. "e.g. Canon PIXMA TS5360").
   - Suggestions from `GET /api/printers/search?q=…&brand=X` (brand slug filter, live).
   - Choosing a printer opens `/shop?brand=X&printer_slug=<slug>`: the cartridges that fit it.
2. **Site search goes straight to an exact match.**
   - When `GET /api/search/smart` returns `matched_printer` with `exact: true`, open that printer's page (`/shop?brand=<brand_slug>&printer_slug=<slug>`) instead of the results list.
   - When it returns `exact_product: { sku, slug, url }`, open that product page.
   - Both fields ship from the backend this week; until they exist, change nothing in search.
   - Never redirect on a match without `exact: true`. "Canon G7060" currently suggests the GX7060, a different printer with different ink.

**Update (17 Oct), measured on 2–16 Oct paid sessions:**
- Visitors who TYPED their printer or a search (finder, site search, or reached a printer page) placed 8 orders from 108 sessions. Visitors who only browsed the code grid placed 0 from 114 (counting sessions with more than one page: 7 of 87 vs 0 of 82).
- On `/ink-cartridges` and `/toner-cartridges`, 65 of 137 first clicks were a **brand tile**, which opens the code grid; only 29 were the finder or search.
- **So also:** a brand tile on `/ink-cartridges` and `/toner-cartridges` should open that brand's page with the printer finder at the top, before the code grid.
- Backend (live 17 Oct): `GET /api/printers/search` now finds a printer when the text as a whole matches nothing: a brand typo ("bother mfc-l3770"), shopping words around the model ("Hp 3110 printer cartridges") or a trailing letter stored differently ("Hp m605m" → M605DN). Three of the six printers ad visitors typed returned nothing before.

**Done when:**
- At 390×664 and 1280×551, the printer input on `/shop?brand=canon&category=ink` is fully visible without scrolling.
- Choosing "Canon PIXMA TS5360" opens its printer page.
- Searching "brother mfc-j4340dw" opens the MFC-J4340DW printer page once the backend's `exact` flag is live.

### 38. P1: Order confirmation page, one-click "Remind me when it's time to reorder"

**Why (owner, 15 Oct: "place a strong focus on increasing customer retention"):** a one-time buyer may only get a reorder reminder after saying yes (NZ spam law: one purchase is not consent). The checkout box (item 19) works, but none of the 20 paid orders since 7 October ticked it, and the same button in the order and day-1 emails has never been pressed. Customers who came back placed orders averaging about $341, against about $123 for a first order (90 days). The confirmation page is the one page every buyer reads right after paying.

**Backend (live once deployed):**
- `GET /api/orders/:orderNumber` now returns `reminder_consent_at`: `null`, or the time the buyer said yes (checkout box or an email button).
- `POST /api/orders/:orderNumber/reminder-consent`, no body. It uses the same authority as that GET: the `Authorization: Bearer` token for a signed-in buyer, or the `X-Guest-Session` header the page already sends for a guest. Responses:
  - `200 {ok:true, data:{reminder_consent:true, reminders_resumed, delivery_blocked}}`. It is idempotent: pressing twice keeps the first time.
  - `reminders_resumed: true` means the customer had unsubscribed from reorder reminders and pressing the button switched them back on.
  - `delivery_blocked` is `null`, or why no reminder can reach them: `'bounced'` (emails to the address bounce), `'unsubscribed'` (they unsubscribed from all our emails) or `'recommendations_off'` (a signed-in customer switched off recommendation emails, which reminders follow).
  - `401` (no token or session), `404` (not this buyer's order), `429` (rate limit, with `Retry-After`), `500`.

**What to build:** one card on the confirmation page, shown only when `reminder_consent_at` is `null` and the order is not cancelled. Use the same words as the email button:
- Heading: "Want a reminder before you run out?"
- Text: "We'll email you when these cartridges are likely running low, so you can reorder in time. Unsubscribe from any reminder in one click."
- Button: "Remind me when it's time to reorder". Disable it while the request is in flight.
- After a 200, replace the card with the line that matches the response:
  - `delivery_blocked: null`, `reminders_resumed: false`: "Done — we'll email you before you run out."
  - `delivery_blocked: null`, `reminders_resumed: true`: "Done — reorder reminders are back on. We'll email you before you run out."
  - `'bounced'`: "We've noted your request, but emails to this address have been bouncing, so reminders can't reach you. Contact us at {support email} to update your email address."
  - `'unsubscribed'`: "We've noted your request, but this address is unsubscribed from our emails, so we can't send reminders. To get them, contact us at {support email} and we'll switch emails back on."
  - `'recommendations_off'`: "We've noted your request, but product recommendation emails are switched off in your account, and reorder reminders follow that setting. Turn them back on under email preferences in your account."
  - `{support email}` is `contact.support_email` from `GET /api/site/trust`.
- On an error: "Sorry, that didn't save. Please try again."

Rules:
- Record consent only when the shopper presses the button. Never press it for them, and never show it pre-selected.
- Guests and signed-in buyers get the same card.
- Show no other reminder or subscription offer on this page: one ask only.
- Place it under the order summary, above the account and business-account offers.

**Done when:** pressing the button sends one POST and shows the "Done" line; reloading the page shows no card; an order placed with the checkout box ticked never shows the card.

### 39. P2 (admin, owner only): Retention panel

**Why:** shows whether customers come back, split by how they first arrived. Measured 15 Oct: 4.4% of customers placed a 2nd order within 30 days (5 of 113). Customers who first came from a Google ad repeated less than other web customers (1 of 41 against 3 of 63 at 30 days).

**Endpoint:** `GET /api/admin/analytics/retention`. Call it once when the panel opens. Admins without the owner role get `403`, so hide the panel for them.
- It takes no query parameters. An unknown parameter returns `400`, except the always-ignored keys: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id`, `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `srsltid`, `ttclid`, `dclid`, `_` and `_t`. A cache-buster passes, but it does not bypass the server's 10-minute cache (`meta.cache_ttl_seconds` 600; `meta.generated_at` is when the report was built). Rate limit: 30 per minute.

**Response:**
- `data.cohorts[]`, oldest first: `{cohort:'YYYY-MM', month_complete, all, ad_acquired, other, invoice_or_quick_order}`. `data.totals` has the same four groups.
- Each group carries:
  - `customers`;
  - `second_order_within.{d30,d60,d90,d180}`, each `null` or `{repeat_customers, observed_customers, rate_pct}`;
  - `median_days_to_second_order` (number or `null`) and `customers_with_second_order` (how many customers that median is based on);
  - `revenue_per_customer_incl_gst.{d30,d90,d180}` (NZD, or `null`).
- `meta`: `as_of` (NZ date), `generated_at`, `orders_counted`, `excluded{test_orders, non_positive_total, staff_orders, orders_without_customer}`, `cache_ttl_seconds`, and `definitions` (one string per key).

**Layout:**
- Rows: the cohort months plus a totals row. Columns: customers; 2nd order within 30/60/90/180 days; median days; revenue per customer at 30/90/180 days.
- Above the table, a segment toggle: All / Google Ads (`ad_acquired`) / Other web (`other`) / Invoice & quick order (`invoice_or_quick_order`).
- Beside the toggle, always visible: "Other web is the comparison for Google Ads, but not a clean control: it includes customers from the old order book and ad clicks that arrived without a Google click id."
- Tooltips come from `meta.definitions.<key>`. Never hard-code that copy.
- Show `null` as "—", never 0. A real 0 arrives as `{repeat_customers:0, …}`.
- Show the counts beside every rate ("4 of 43 · 9.3%").
- Grey out and label "small sample":
  - any rate cell with `observed_customers` under 20;
  - any median with `customers_with_second_order` under 20.
- Revenue at dN averages over `second_order_within.dN.observed_customers`, so mute it by that same count.
- `month_complete:false`: put an "in progress" badge on that row.
- Footer: `as_of` and the excluded counts.
- Customers and the counts add up across the three segments to `all`; rates and medians do not, so always read them from the response.
- **Do not show `GET /api/admin/analytics/cohorts` beside this panel.** That older endpoint counts every guest as one customer, uses UTC months and reports 0% for windows that have not ended, so its figures contradict this one.

### 40. P2: Reorder reminders for signed-in customers

**Why:** a customer who buys the same toner every few months can ask for a reminder email that loads their reorder into the cart in one click. Nothing is ordered or charged automatically. Only one reminder has ever been set up (by the owner, as a test), because nothing on the site offers it. The only entry point today is a link in signed-in customers' order emails.

**Backend (done 15 Oct):** the refill, predictive and business reorder emails skip any product a customer's reorder reminder (active or paused) already covers, so nobody gets two emails about one cartridge.

**Name it** "Reorder reminder(s)". Never "Auto-reorder", "Subscribe & Save", "subscription", "save", "%", "never run out", or any price or saving claim.

**API** (Bearer token; JSON). Errors are `{ok:false, error:{code, message, details}}`.
- `GET /api/account/subscriptions`: `200 {ok:true, data:{subscriptions:[{id, items:[{sku, quantity}], interval_days, next_due:'YYYY-MM-DD', status:'active'|'paused'|'cancelled', last_sent_at, source_order_id, created_at, updated_at, email}]}}`, newest first, at most 50. Never show `email`: it is a copy from sign-up, and reminders go to the current account email.
- `POST /api/account/subscriptions` with `{items:[{sku, quantity 1-20}] (1-12 lines), interval_days 14-365 (weeks × 7)}`:
  - `201 {subscription, existing:false, merged:false, rejected_items:[{sku, reason}]}`: a new reminder.
  - `200 {subscription, existing:true, merged:true, rejected_items}`: the items were added to the customer's ACTIVE reminder on the same interval, so one schedule sends one email that loads every item. That reminder's `next_due` is unchanged; read it from the response. A paused reminder is never added to; a new one is made instead.
  - `400 NO_ORDERABLE_ITEMS` with `details.rejected[{sku, reason}]` (`missing_sku`, `duplicate_sku`, `invalid_quantity`, `unknown_or_inactive`, `not_orderable`). Other `400` = validation. `401` when signed out.
- `PATCH /api/account/subscriptions/:id` with any of `{interval_days, status:'active'|'paused'|'cancelled', items, next_due:'YYYY-MM-DD'}` → `200 {subscription}`; `404` if not found. Changing `interval_days` keeps `next_due`: the new interval applies after the next reminder. `items` needs at least one line; to remove the last item, set `status:'cancelled'`.
- Product names and links: `GET /api/products/:sku` (follows SKU renames with a 301).

**1. Product page** (`product_type` `ink_cartridge`, `ink_bottle` or `toner_cartridge`), signed in:
- Under Add to Cart: "Email me a reminder to reorder this every [N] weeks", button "Set reminder".
- Interval options 4 / 6 / 8 / 10 / 12 / 16 / 26 weeks, the same list everywhere. Default: the interval of the customer's existing active reminder, if they have one (so all their cartridges land on one schedule and one email); otherwise 6 weeks for ink cartridges and 8 for toner and ink bottles.
- Quantity comes from the page's quantity selector.
- GET the list once per visit. If an active reminder already has this SKU: "Reminder set: every N weeks. Next email around {next_due}." and a "Manage reminders" link. If only a paused one has it: "Your reminder for this item is paused." and "Manage reminders". Do not offer a second reminder in either case.
- Create a reminder only on an explicit click; never pre-select it. Disable the button while the POST is in flight.
- On `201`: "Reminder set. We'll email you around {next_due}, then every N weeks, with this item ready to add to your cart in one click. Nothing is ordered or charged until you check out. You can pause or change it any time in your account." (Drop the last sentence until the account section is live.)
- On `200` with `merged:true`: "Added to your reorder reminder. We'll email you around {next_due}, then every N weeks, with all its items ready to add to your cart in one click. Nothing is ordered or charged until you check out."
- On `NO_ORDERABLE_ITEMS`: "Reminders aren't available for this item." Other errors: "We couldn't set the reminder just now. Please try again."
- Guests: no reminder control and no email capture. One link, "Sign in to get a reorder reminder for this item.", returning to the same product page after sign-in.

**2. Account page, "Reorder reminders" section** (every reminder except cancelled ones):
- Item names, quantities, "Every N weeks" ("Every N days" when `interval_days` is not a multiple of 7), and for active reminders "Next reminder: {next_due}, then every N weeks."
- "Change how often": PATCH `{interval_days}`, then show `next_due` from the response.
- "Remove item": PATCH `{items: the remaining items}`; for the last item use "Delete reminder".
- "Pause reminders": PATCH `{status:'paused'}`. "Turn reminders back on": PATCH `{status:'active'}`, then "Turned back on. If the next reminder date has passed, we'll send it within a day."
- "Delete reminder": PATCH `{status:'cancelled'}`.
- Paused: "Paused. No reminder emails are sent. We also pause a reminder ourselves when none of its items can be ordered any more."
- Empty: "No reorder reminders yet. You can set one on any ink or toner product page."
- Footnote: "Reminders go to your account email address. Nothing is ordered or charged until you check out."

**3. Fix existing copy now:** the `?subscription=` toasts in `account.js` still say "scheduled reorder", which reads as if an order will be placed. Replace them:
- `created`: "Your reorder reminder is set up. We'll email you every 60 days. Nothing is ordered or charged until you check out."
- `exists`: "You already have a reorder reminder for this order."
- `unavailable`: "Reorder reminders aren't available for this order. Contact us and we'll help."
- `error`: "We couldn't set up your reorder reminder. Please try the link in your email again, or contact us."

**4. The reminder email's reorder link** (and "Load My Reorder" in refill and business emails) first shows a backend confirm page, "Add your reorder to your cart?" (owner, 16 Oct: so an email scanner opening the link cannot fill the cart). The shopper's click fills the ACCOUNT cart and opens `/cart?reorder=loaded` (or `?reorder=unavailable`). When either arrives and the shopper is signed out, show "Sign in to see the items we added to your cart." and return to `/cart` after sign-in, instead of the empty guest cart.

**Done when:** setting a reminder on the black and then the cyan of one cartridge family shows "Added to your reorder reminder" the second time and the account page lists one reminder holding both; pausing and turning it back on work; a guest sees only the sign-in link.

### 41. P2: How-to guides

**Why:** in the 90 days to 12 October, 284 how-to searches ("how to replace toner brother", "what ink does my printer use") reached the site 539 times and brought 0 clicks: the site has no page that answers them. A guide ranks for the question and links to printer and product pages that carry real demand.

**The brief:** `docs/seo/guides-content-plan-oct2026.md` ranks 9 guides by NZ search demand (Keyword Planner, 15 Oct). Each guide has its URL (`/guides/<slug>`), target queries, outline, the live products and printer pages it links to, and the copy rules. Start with guide 1 (replace the toner in a Brother laser printer) and guide 4 (change the ink in an HP printer).

**Rules:** the pages are hand-authored static HTML on www, as `/about` and `/returns` are. Trust facts (returns, guarantee, dispatch, free shipping) come from `/api/site/trust` and `/api/site/value-props`, never typed in. No price comparisons, superlatives or "guaranteed fit" (invariant 13). Tell the backend when a guide goes live, so it can be added to the sitemap.

### 42. P2: SEO housekeeping

1. **Apex redirect:** `https://inkcartridges.co.nz/...` redirects to `www` with a **307** (temporary; still 307 on 18 Oct). Make it a **308 or 301** (permanent) in Vercel. 31 apex URLs have Search Console impressions.
2. **Pages Google indexes that it should not:** `/account/orders` (73 impressions), `/account/favourites`, `/quote`, `/track-order`, 14 site-search URLs (`/shop?search=…` and `/shop?q=…`), and 21 legacy `/html/*` URLs. Serve `<meta name="robots" content="noindex">` on the account, quote, track-order and search pages, and 301 each `/html/*` URL to its current page (or let it 404 if there is none).
3. **Printer-page description, only if the SPA sets its own** (the prerendered page is already done by the backend). Mirror `buildPrinterPageMeta`:
   - Lead sentence: when every listed product is `source:'genuine'`: "N genuine <noun> cartridges for the <Printer>."; all `'compatible'`: "N compatible <noun> cartridges for the <Printer>."; both: "N <noun> cartridges for the <Printer> — genuine & compatible." `<noun>` is the supply noun in lower case ("ink", "toner"), or nothing; "cartridge" when N is 1.
   - Then add these sentences in order, each only if the total stays at or under 155 characters. A sentence that does not fit is skipped and the next one is still tried: "Free shipping over $<threshold>." (the threshold is in `/api/site/value-props`), "Auckland metro orders by <cutoff> NZT dispatch same day." (the cutoff from `/api/site/trust`, written like "12pm"), "<returns days>-day returns." (`/api/site/trust`).
   - Never cut mid-sentence and never add "...".

### 43. P1: Tracking that tells us why ad visitors leave

**Why:** in the last two weeks 182 of 188 paid sessions that never interacted were a single page view, so we cannot tell "left before the products appeared" from "saw the prices and left". The Add buttons on listing grids also send nothing: product pages recorded 365 add-to-cart clicks, listing grids 0.

**What to build:**
1. **`grid_ready`:** when a listing grid (series, printer, brand, category page) shows its first product card, send one beacon to the traffic endpoint with `event_type: 'grid_ready'` and `element` = the milliseconds since navigation start, e.g. `grid_ready 1240`. Same for a product page's main card. The backend accepts `grid_ready` (live 17 Oct, migration 209).
2. **Add on listing grids:** every Add button on a listing grid sends the same `add_to_cart` click the product page sends, with the product id, so `traffic_events` records the add.
3. **Cart requests carry the session:** send `X-Session-Id` on every `POST /api/cart/items` (the cart funnel already reads it), so an add can be tied to the visit.
4. **Test browsers identify themselves:** our own and your QA browsers (HeadlessChrome, emulated iOS devices) set `localStorage.ic_internal = '1'`, and the beacon skips sending when it is set. Today they make up a large share of "checkouts" in the funnel report.

**Done when:** a listing-grid visit records `grid_ready` and, after an Add, an `add_to_cart` click carrying the product id; a QA browser with the flag records nothing.

### 44. P1: Regression check, series and product pages between 27 and 29 September

**What we see:** for visitors who landed on a series page from an ad, product page → Add to cart fell from 6 of 10 to 2 of 15 after the 29 September build. Site-wide, the product-page add rate held (49 of 254 vs 51 of 326), so it may be the sample, but it is cheap to check.

**What to do:** compare the 27 and 29 September builds of the series and product pages (the `yieldTier` change in `utils.js` shipped then) on desktop and mobile: product order, which product the page leads with, and whether the Add button is visible without scrolling. The "Popular right now" and "Full colour sets" rows removed that day stay removed (owner).

### 45. P1: One GA4 property, the one the owner can open

**Why:**
- `js/gtag.js` sends page views and the ecommerce events to `G-SDQELG0FGD`.
- The server sends every paid order's `purchase` event (Measurement Protocol) to `G-YJXTSGLM28`. So no GA4 report can join a visit to its sale.
- The owner's Google login (`junjackson0915@gmail.com`) can open only `G-YJXTSGLM28`: GA4 property 525158196, "InkCartridgesNZ - Production - Web". `G-SDQELG0FGD` sits in a Google account the owner cannot see, so the business cannot open its own browsing data (checked 17 Oct in GA4 and in Tag Manager's "Google tags" list).
- In the 28 days to 16 Oct, `G-YJXTSGLM28` received 30 purchases ($3,458.58) and only 45 page views.
- The 20 Sep change (ERR-276) removed `G-YJXTSGLM28` from `js/gtag.js` as "configured and never fed". It is fed, by the server.

**What to change (`js/gtag.js`):**
1. `gtag('config', 'G-SDQELG0FGD', GTAG_COOKIE_FLAGS)` becomes `gtag('config', 'G-YJXTSGLM28', GTAG_COOKIE_FLAGS)`, and `GA4.PROPERTY` becomes `'G-YJXTSGLM28'`. One GA4 property stays configured, so the one-bundle rule from ERR-276 still holds.
2. Every ecommerce event keeps `send_to: GA4.PROPERTY`, so it follows the change.
3. Leave `AW-18032498762` and its events as they are.
4. Update the tests that pin the old id.
5. Check that checkout sends `ga_client_id` whenever the `_ga` cookie exists. Only 19 of the 61 paid orders in the 30 days to 17 Oct carried one. With analytics consent declined there is no cookie, and a missing id is expected.

**Do not:**
- configure both ids (two GA4 bundles, the ERR-276 cost);
- send a browser `purchase` event: the server already sends it, with the order number as `transaction_id`, and a browser twin would count every sale twice.

**Backend:** nothing to change. The server already sends purchases to `G-YJXTSGLM28` (25 sent since 6 Oct, none failed). The `_ga` cookie is shared by every GA4 property on the domain, so an order that carries `ga_client_id` joins its visit once the browser tag moves; an order without one arrives as a new visitor.

**Done when:**
- a page view on www shows in property 525158196's Realtime report;
- the browser's `collect` requests carry `tid=G-YJXTSGLM28` and never `G-SDQELG0FGD`;
- the next paid order's `purchase` appears in that property;
- within about two days, a GA4 funnel exploration (`view_item` → `add_to_cart` → `purchase`) renders.

The history already in `G-SDQELG0FGD` stays there. If its owner later adds `junjackson0915@gmail.com` as an Administrator, the owner can read it.

### 47. P1 (small, owner 22 Oct): the checkout email hint misses `gial.com`

**Why:** the owner typed `junjackson0915@gial.com` on `/checkout` and no "Did you mean …?" appeared. `CheckoutPage.suggestEmailDomain` (`js/checkout-page.js`, item 15) suggests only when the domain is ONE edit from a known one. `gial.com` is two edits from `gmail.com` (a dropped `m` plus a swapped `ia`), so it returns `null`. The backend cannot catch it either: `gial.com` is a registered domain, so the address passes validation, and a guest's confirmation, tracking and invoice emails all go to it.

**What to change:** replace `suggestEmailDomain` with the version below. Nothing else changes: same signature, same blur trigger, same hint box, still a hint that never blocks.

- Allows TWO slips when the provider's name has 5 or more letters (gmail, yahoo, hotmail, outlook, icloud); keeps ONE for `xtra` and `live`, where two would flag real business domains (`astra.co.nz`, `ultra.co.nz`, `terra.co.nz`).
- Picks the NEAREST provider, not the first one in the list, so `hotmal.co.nz` suggests `hotmail.co.nz`, not `hotmail.com`.
- Adds the NZ providers our customers actually use: `yahoo.co.nz`, `hotmail.co.nz`, `outlook.co.nz`, `live.com`. The list is ordered by how often each appears in our orders and accounts.

```js
suggestEmailDomain(email) {
    // Most-used first: a tie goes to the more common provider.
    const DOMAINS = ['gmail.com', 'xtra.co.nz', 'hotmail.com', 'yahoo.com', 'yahoo.co.nz', 'outlook.com',
        'icloud.com', 'live.com', 'hotmail.co.nz', 'outlook.co.nz'];
    if (typeof email !== 'string') return null;
    const at = email.lastIndexOf('@');
    if (at < 1) return null;
    const local = email.slice(0, at).trim();
    const domain = email.slice(at + 1).trim().toLowerCase();
    if (!local || !domain || DOMAINS.includes(domain)) return null;
    // Optimal string alignment distance (one edit = substitution, insertion,
    // deletion or a swap of two neighbours).
    const osa = (a, b) => {
        const d = [];
        for (let i = 0; i <= a.length; i++) {
            d[i] = [i];
            for (let j = 1; j <= b.length; j++) {
                if (i === 0) { d[i][j] = j; continue; }
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                    d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
                }
            }
        }
        return d[a.length][b.length];
    };
    // Two slips allowed when the provider's name is 5+ letters (gial.com ->
    // gmail.com is a dropped m plus a swap); one for xtra and live, where two
    // would catch real business domains (astra.co.nz, ultra.co.nz).
    let best = null, bestDist = Infinity;
    for (const k of DOMAINS) {
        const max = k.indexOf('.') >= 5 ? 2 : 1;
        const dist = osa(domain, k);
        if (dist <= max && dist < bestDist) { best = k; bestDist = dist; }
    }
    best = best || DOMAINS.find(k => k.startsWith(domain + '.'));
    return best ? local + '@' + best : null;
},
```

**Tests (pin these):**

| Typed | Hint |
|---|---|
| `a@gial.com`, `a@gamil.com`, `a@gmai.co`, `a@gmal.con`, `a@gmail.ocm`, `a@gmail` | `a@gmail.com` |
| `a@hotmal.co.nz` | `a@hotmail.co.nz` |
| `a@yaho.co.nz` | `a@yahoo.co.nz` |
| `a@iclod.com` | `a@icloud.com` |
| `a@xtra.co`, `a@xtra.co.nx`, `a@xrta.co.nz` | `a@xtra.co.nz` |
| `a@liv.com` | `a@live.com` |
| `a@gmail.com`, `a@xtra.co.nz`, `a@yahoo.co.nz`, `a@astra.co.nz`, `a@ultra.co.nz`, `a@terra.co.nz`, `a@gmx.com`, `a@me.com`, `a@yahoo.com.au`, `a@protonmail.com` | none |

**Backend check (22 Oct):** this function was run over every email domain in our orders, accounts and suppression list (92 domains). It hints on exactly one, `gmail.ocm`, which is a real typo on a customer account. No real customer domain gets a false hint.

**Signed-in shoppers:** their order emails go to the account's own address (`req.user.email`), never to the checkout field, so the hint only protects guests. It still shows for everyone.

**Done when:** on `/checkout`, typing `test@gial.com` and leaving the field shows "Did you mean test@gmail.com?", and the tests above pass.

### Not to do

- **PayPal: on hold by the owner.** Leave the PayPal button as it is. Do not apply the old hide rule. (PayPal accepts payments again: orders have been created normally since 6 Oct, 02:15 UTC.)
- No price comparisons, "lowest price", "best", star ratings or review counts (invariant 13). No "guaranteed fit".
- No "dedicated account support" or account manager anywhere (owner, 5 Oct): business questions go to the one support email.
- Shipping fees: unchanged (owner).

---

## Part 2: already live, keep it working

Each item was checked live on 5 Oct.

| Area | What must stay true | How to check |
|---|---|---|
| PDP buy box | Add to Cart visible and clickable on the first screen at 1280×551, 1366×599, 1536×695, 1366×768; the fit line ("Not sure it fits? …") sits directly under it | `elementFromPoint` at the button centre returns the button |
| Series page | compact cards, price + Add on the first screen; H1 names the code ("Epson 288 / 288XL Ink Cartridges") | load `/shop?brand=epson&category=ink&code=288` |
| URL intent | `code=288XL` / `code=65XL` reach `/api/shop` unchanged, and that tier lists first; `pack=value_pack` is forwarded and packs list first | network log on `/shop?brand=hp&code=564&pack=value_pack` |
| Ad landing pages | these render products (ads now land on them): `/shop?brand=canon&code=CLI681&pack=value_pack`, `/shop?brand=hp&code=65XL`, `/shop?brand=canon&printer_slug=canon-pixma-ts6160`, a PDP such as `/products/pg512bk-compatible-ink-cartridge-for-canon-pg512-black/CPG512BK`, and a brand page `/shop?brand=epson&category=ink&source=compatible` | open each once |
| Guest cart reminder | unticked box "Email me a copy of my cart if I don't finish" on cart and checkout; ticking posts `POST /api/cart/guest-contact` (body `guest_session_id` = `X-Guest-Session`) | two real opt-ins recorded by 4 Oct |
| Google reviews | "See our reviews on Google" in the footer and the buy-box trust block, new tab, URL from `organization.google_reviews_url`, no stars | — |
| Remarketing | `view_item`, `add_to_cart`, `purchase` carry `items: [{ id: <SKU>, google_business_vertical: 'retail' }]` | `dataLayer` on a PDP |
| Images | genuine products with no image show the GENUINE tile | `/shop?brand=epson&code=288` |
| Search dropdown | each row has an Add button; the query is sent exactly as typed (the backend normalises "604 xl", "epson604") | type "604 xl" |
| Guest prefill | `POST /api/checkout/guest-prefill` is read for `has_previous_order` / `welcome_message` only | — |
| PDP FAQ | the visible accordion renders from `faqJsonLd` word for word | compare with the API |
| Copy | same-day dispatch always carries "(Auckland metro)"; `?rated=N` shows the thank-you; `og:image` and the Organization logo use API URLs | — |

**Backend changes you may notice (no FE work):**
- "epson 502" no longer lists a ribbon first.
- On a printer search, drums and other wear parts follow the cartridges.
- `delivery_estimate.label` reads "1–3 business days NZ-wide".
- `GET /api/site/trust` gained `contact` (`phone_display`, `phone_tel_href`, `support_email`).

## Part 3: why (one paragraph)

On 5 October a live benchmark found us the dearest seller on most products paid shoppers looked at, often because our supplier cost is above a rival's shelf price. The owner's rules:
- Price at the market middle within a minimum margin.
- Don't chase the cheapest; win on service, speed and experience.
- Products we can't win still show in ads, at a low bid.

The ads now send every product search straight to its own product or code page, and lead with delivery speed, NZ phone/email support, tax invoices and returns. Measured over the last 30 days of NZ ad visits (553 sessions, 18 orders), about 90% of shoppers who start checkout pay. The big loss comes before the cart: 75% of shoppers who land on a product page leave after that one page. So the reasons to buy beside the price (items 5, 6, 8) matter as much as the checkout items (1–4). Item 12 is what brings a first-time ad customer back for a second order. Full background: `docs/admin/owner-direction-win-on-service-oct2026.md`.

## Part 4: how we will verify

After you tell us a deploy is live, we re-run, as a first-time visitor (consent banner open) at 1280×551, 1366×599, 1536×695, 1366×768, 1920×911 and iPhone 13 (390×664):

1. Pay enables without a tick (1).
2. Apple Pay from the cart completes an order with no typing, on a real iPhone (2).
3. "Proceed to Checkout" is on the first screen (3) and reaches `/checkout` in under 1 s (9).
4. The cart total includes shipping; checkout never shows a changing figure (4).
5. The service row shows next to Add to Cart on PDP, series and printer pages (5).
6. Reward points on PDP and cart (6).
7. The first series card's Add is clickable with the banner open (7).
8. No page shows 2–4 / 1–4 delivery days; `/faq` visible text = JSON-LD (8).
9. The PDF quote downloads and matches the cart (10).
10. `/cart?add=SKU:QTY,…` fills the cart once, adding to what is there (12).
11. A guest order's confirmation page offers the one-step account, and `next_order_offer` shows only when present (13).
12. A mistyped email (`test@gmail.con`) is caught under the email field on `/checkout`, and "Continue to payment" stays disabled until it is fixed (15).
13. On `/cart`, + stops at the line's stock and a typed quantity above stock becomes the stock, with no `400` from `PUT /api/cart/items` (17).
14. `/shop?brand=brother&code=LC3319XL&source=compatible` lists only the 6 compatible products, with a removable chip, and its canonical has no `source` (21).
15. Everything in Part 2 still holds.
16. GA4 `collect` requests carry `tid=G-YJXTSGLM28` only, and the next paid order's `purchase` lands in the same property (45).
17. On `/checkout`, `test@gial.com` shows "Did you mean test@gmail.com?" when the field loses focus (47).
