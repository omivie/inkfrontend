# More ad clicks into orders — FE reply (Oct 2026)

**Answers:** `inbox/ad-clicks-to-orders-FE-handoff-oct2026.md` (2 Oct 2026). It also closes the open items of
`inbox/paid-traffic-conversion-FE-handoff-oct2026.md` (1 Oct) and `inbox/ad-visitor-dropoff-FE-handoff-oct2026.md` (2 Oct).
**FE refs:** ERR-302 (§0, §4, §6 footer, §7) and ERR-301 (§1, §2, §3, §5, §6 product page, §8). Two FE sessions split the
work by file.
**New asks:** BF-098 (§5), BF-099 (§4).
**Measured:** 2026-10-02, against production for API claims and against `localhost:3000` (same backend) for the pages.
**Re-check:** `npm run probe:ad-clicks` (READ-ONLY). Add `PROBE_BASE=https://www.inkcartridges.co.nz` once the deploy is live.

---

## §0 Deploy — why nothing was live

Your reading was right, and the cause was ours. Local `main` was **5 commits ahead of `origin/main`**: ERR-295 to ERR-299
were committed but never pushed. Vercel was serving the last push correctly.

**Deployed:** pushed `e0a76a13` at **2026-10-02 04:01:41 UTC** (live by 04:02 UTC), then hotfix `abfca574` at **04:05:46 UTC** (live 04:06 UTC). See §9.

## §4 Guest cart reminder — switched on, and now on /cart too

- **Why no guest had ever opted in.** The box existed only on **checkout**, behind `Config.DARK_FEATURES.guestCartEmail = false`,
  and it had never been shown. The owner approved switching it on on 2 October.
- **/cart now shows it** under "Proceed to Checkout", for guests only: an **unticked** box labelled
  "Email me a copy of my cart if I don't finish", with its own email field. Checkout shows the same box under its order email field.
  Both pages run the same code.
- **Call.** It sends `POST /api/cart/guest-contact` with `X-Guest-Session` and `{ guest_session_id, email, consent: true }`,
  only after the shopper has ticked the box and entered a valid address, and once per address. The body id and the header
  come from the same stored value, so `GUEST_SESSION_MISMATCH` cannot happen unless the store changes between the two reads.
- **UEMA.** Nothing is sent while the box is unticked. If the browser restores a tick from an earlier visit, we clear it when
  the page loads, because a restored tick is not consent.
- **Outcome is shown.** On success the shopper sees "We'll email a copy of this cart to {email} if you don't finish. Every email
  has an unsubscribe link." On any failure (thrown 400, `RATE_LIMITED`) they see "We couldn't save that just now. Your cart is
  unaffected." and can try again. The cart and checkout are never blocked.
- **Done-when.** One real opt-in was made on production at **2026-10-02 ~04:10 UTC**, for `junjackson0915@gmail.com` (the owner's address), on a guest cart holding `CLC73BK`. The page reported `sent`. Please confirm the row
  in `guest_sessions.contact_consent_at`.

### BF-099 — withdrawing consent before the first email

If a shopper ticks the box, the address is saved, and then they untick it, we have no call to withdraw it. Today the page tells them
honestly: "Your address is already saved for this cart. Every reminder email has an unsubscribe link."

**Ask:** would you accept `{ guest_session_id, email, consent: false }` on the same route to clear `contact_consent_at`? If you add
it, we will send it on untick. No change on our side is needed until you do.

## §6 "See our reviews on Google" — footer done (product page: see the ERR-301 section)

- The footer on every page now shows a plain "See our reviews on Google" link. It opens in a new tab with `rel="noopener noreferrer"`.
  It shows no stars and no count.
- **Source.** `GET /api/site/trust` → `organization.google_reviews_url`, through the same session-cached read the footer already
  makes for the trust stats, so there is no new request.
- **Validation.** The href is used only if it is `https:` and its host is `google.com`, `www.`, `maps.` or `search.google.com`, or
  `google.co.nz`. Anything else, or no value, means no link at all. Your current value passes.
- **Measured locally:** the link is shown, and its href is byte-identical to the API value.

## §7 Remarketing audiences — the cause, and the fix

**Cause.** Product viewers, Shopping cart abandoners and Past buyers fill from the event **names** `view_item`, `add_to_cart` and
`purchase` carrying `items`. The Ads account received none of them:

- our GA4 `view_item` and `add_to_cart` are scoped to the GA4 property, deliberately;
- the Ads add-to-cart and purchase were labelled `conversion` events. A conversion is not a remarketing event.

The tag itself loaded on every page, which is why "All visitors" filled.

**Fix.** Each event is now also sent to the Ads tag (`send_to: 'AW-18032498762'`, no conversion label), with
`items: [{ id: <SKU>, google_business_vertical: 'retail' }]`:

| Event | When | Guard |
|---|---|---|
| `view_item` | product page | once per SKU per page load; never for the admin test product |
| `add_to_cart` | after `POST /api/cart/items` returns 2xx | the same guard as the add-to-cart conversion, which is unchanged |
| `purchase` | order confirmation | inside the purchase conversion's three guards (paid, once per page, once per order number); the purchase conversion now carries `items` too |

- **`id` is `product.sku` exactly as the API returns it.** We trim whitespace and never change case. We could not read the Merchant
  Center feed ourselves (no public URL), so the "`<g:id>` = `product.sku`" equality rests on your statement. If any feed row uses
  a different form, tell us.
- **Consent.** Same handling as the existing Ads calls (Consent Mode declares only `analytics_storage`, ERR-227). No new gate.
- **Measured locally** on `/p/GGI690KCMY`: one Ads-scoped `view_item` with `id: "GGI690KCMY"`. The Google tag transmitted it to Ads
  (4 outgoing requests carrying `view_item` and the SKU; the probe aborts them so it never joins an audience).
  **Negative control:** a `/shop` listing sent none (0 of 8 gtag calls).
- **Please check one thing in the Ads account.** If any conversion action is defined on the event *name* `purchase` (rather than the
  `W1laCPGzpJQcEMqwyJZD` label), it would now double-count purchases. We saw none in the code paths we own, but the account settings
  are yours.

## §5 BF-098 — `code=288XL` and "keep the whole family" contradict the live API

Measured on production: `/api/shop?brand=epson&category=ink&code=288XL&limit=200` returns **only the 7 XL rows**
(G288HYBK/C/M/Y, G288BXLCMY, G288HYCMY, G288HYKCMY). `code=288` returns 13 rows, each with `yield_tier` STD or XL.
So a request that "carries `code=288XL` unchanged" cannot also "keep the whole family". See the ERR-301 section for what the
page does now.

**Ask:** should `code=288XL` return the whole 288 family with XL first? If yes, the page can drop its second request.

`pack=value_pack` works as you said (`code=564`: 4 rows with it, 16 without).

## ERR-301 items (§1, §2, §3, §5, §6 product page, §8)

**Measured before anything changed** on production, 2 Oct 2026, as a first-time visitor in a READ-ONLY browser (analytics requests aborted). **Measured after** locally with `npm run probe:ad-visitor-dropoff`. That probe checks four sizes, three products, two negative controls, and is paced to stay under the 100 requests / 60 s limiter. We re-run it against production after the push (§9).

### §1 P0 — Add to Cart on the first screen: done

- **Before:** Add sat at **y 703**, price at y 438, on GGI690KCMY at 1366×599. At 1366×768 two fixed elements covered it:
  - **`#google-reviews-badge` at 643–707.** This is the "empty fixed 64px element" from 1 Oct. It is Google's reviews badge. Its contents are a cross-origin iframe, which is why it looks empty. Our own CSS was lifting it so that it sat on top of the consent bar.
  - **The consent bar at 707–768.**
- **The buy box now reads in this order:**
  1. Price, Availability
  2. quantity + **Add to Cart**
  3. the fit line (§2)
  4. "3+ from $X each"
  5. Delivery, Returns, the dispatch countdown, pack savings, cost per page
- **The rows' copy is unchanged.** The four prerender-mirrored rows keep their copy and their document order. They are split across two `<dl>`s so the button can sit between them, and the Offer microdata stays on Price + Availability.
- **The consent banner** is now a 360px card in the bottom-**left** corner, from 1100px wide. The product page's buy box sits right of x 380 at those widths, so the card cannot cover it. The badge keeps the bottom-right corner, and nothing is raised over the banner's text, as you asked. Below 1100px it is still the full-width bar.
- **After:** Add is at **y 464–538** at every size we checked: 1280×551, 1366×599, 1536×695, 1366×768, plus 1280×720 and 1440×900. That holds for a genuine pack (GGI690KCMY), a genuine single (GLC3329XLBK) and a compatible drum (CDR1070BK). It is fully inside the viewport, and no fixed element overlaps it. `elementFromPoint` returns the button at its centre and at all four corners. CLS is ≤ 0.015.
- **Your literal check doesn't fit a corner card.** `#add-to-cart-btn.bottom ≤ .consent-banner.top` assumes a full-width bar. With a corner card at x 16–376 and the button at x 822–1119, the check compares two boxes that never share a column, so it can come out false with nothing covering the button. Please verify with your second condition instead (`elementFromPoint` at the button's centre returns the button). The same applies to the 1 Oct wording, "fully above the top edge of every fixed element": the Google badge sits in the bottom-**right** corner (x ≥ 1280) and never shares the button's columns either. Our probe prints both literal numbers, `Add.bottom ≤ min(banner.top, badge.top)`, at every size and labelled as information, so your re-run will show you the same figures.

### §2 P1 — Fit reassurance directly under Add to Cart: done

- **Directly under the button:** `trust_signals.compatibility_promise.label`, one line, verbatim from the product response. It was **moved** out of the fit section, not copied.
- **Under it:** `how_to_check`, as small link text to the printer finder (`/?scroll=ink-finder`, the same target as the "Printer Models" menu item).
- **Copy:** none of it is hard-coded, and there is no "guaranteed fit" or "fits your printer" wording. A test checks both.
- **At 1366×599 and 1280×551:** the line sits at y 520–551, right under the button and still on the first screen. At 551 tall that is the last row of pixels, so there is no margin left at that size.
- **Also there (§6, product-page half):** a plain "See our reviews on Google" link to `trust_signals.organization.google_reviews_url`, which opens in a new tab. No stars and no count. The URL goes through the same https + Google-host check as the footer link.

### §3 P1 — Series page: price and Add on the first screen

- **The H1 now names the code.** It mirrors your prerender's own h1, "Epson 288 / 288XL Ink Cartridges". Until that loads, it reads "Epson 288 Ink Cartridges". The visible label beside the breadcrumb prints the same words, so what a shopper reads is what Google indexes.
- **Compact card.** It applies only on laptop-shaped windows: at least 1100px wide and at most 800px tall. Phones and tall windows are unchanged.
  - shorter image
  - a 3-line title (2 lines at 620px tall or less)
  - price and "Incl. GST" on one line
  - the volume rung on one line
  - the "Fits" line moved below the button
- **Before → after**, `code=288` at 1366×599:

  | | Before | After |
  |---|---|---|
  | first price | y 635 | **y 441** |
  | first Add | y 763 | **y 495–531** |
  | Add, measured from the card top | — | **218px** (your target is about 250) |

  At 1366×768 and 1536×695 it is 247px.
- **One honest limit.** The consent card in the bottom-left corner covers the lower part of grid columns 1–2 until the visitor answers it:
  - 1366×599: columns 1–2 under the card
  - 1280×551: columns 1–2 under the card
  - 1536×695: column 1 under the card
  - 1366×768: no column under the card
  
  Every other first-row card has its price and Add fully on screen and clear. The owner chose the corner card because it keeps the product page's buy box completely clear. A full-width bar would cover every column on this page instead.

### §5 P2 — Keep the ad's intent in the URL: done (see BF-098 above)

- **`code=288XL`:** the page sends **`code=288XL` unchanged, first**, plus `code=288` alongside it. That keeps both of your done-when lines: the request carries 288XL, and the whole family is still listed.
  - The XL tier sorts first within the family, and colour order is kept.
  - The address bar keeps `288XL`. The canonical stays `code=288`.
  - Measured: first card "Epson Genuine 288XL Ink Cartridge Black (500 pages)".
  - XXL works the same way. "HY" is not a suffix the code collapses today, so there is nothing to keep for it.
- **`pack=value_pack`:** passed through to `/api/shop`.
  - Measured on `code=564&pack=value_pack`: the request carries it and the first card is a value pack.
  - The page gets a "See all 564 cartridges" link back to the whole family.
  - We skip our compatible-recovery side request for a pack page, because it would have merged the singles back in.

### §8 Small items

- **GENUINE tile — the premise did not hold.** Genuine packs did **not** already have a GENUINE tile. We measured G288CMYK (genuine value pack, `image_url` null) on the 288 page today, and it showed the grey "No Image" box like the singles. So we built the tile new. It applies to every genuine row with no image, single or pack, and also when a genuine photo fails to load.
  - **Content:** brand + "GENUINE" + code, for example "EPSON · GENUINE · 288XL Black". It is text only, never a colour block (that is the compatible tile's language).
  - **Only on proven genuine rows.** It shows only when the row's `source` is genuine. An unknown source keeps the placeholder, and we never infer genuine from a product name.
  - **Every surface:** cards, /shop, search, PDP hero, cart, favourites, checkout, payment, confirmation, order history, ribbons.
  - **Payment bug, also fixed:** the payment summary was pointing image-less lines at `/assets/images/placeholder.png`, a file that never existed.
- **`ink-backend-zaeq` / `onrender.com`: already clean.** No storefront code calls the old host. The only mentions are code comments, the deliberate "old host" constant in the backend-move probe, and the test that **fails** if a live reference ever appears. Every `onrender.com` reference left is `ink-backend-sg`, in Vercel's server-side rewrites and middleware, which is the bypass-Cloudflare case you allowed. The Vercel project config in the repo holds no host. Please check the dashboard's environment variables on your side; we can't read them from here.
- **Printer pages switched on (§4 of ad-visitor-dropoff): render normally.** We checked 9:
  - HP Envy 6130e, 6120e, 6520e and Smart Tank 7005
  - Epson WF-7845
  - Brother HL-3170CDW and DCP-L1630W
  - HP LaserJet P2015n
  - Dymo LabelWriter 450 Duo

  Each had the correct h1, listed its cartridges, and logged no console errors. Example: Envy 6130e lists HP 68 Black and Colour.
- **Is the traffic beacon blocked by uBlock Origin or Brave (§5 of ad-visitor-dropoff)? No.**
  - **How we checked:** we ran `POST /api/analytics/traffic-event` through the same filter engine (`@ghostery/adblocker`) against:
    - uBlock Origin's default lists (uBO filters, privacy, badware, quick-fixes, unbreak, EasyList, EasyPrivacy)
    - Brave's standard lists (EasyList, EasyPrivacy, uBO, brave-specific, brave-unbreak)
  - **Result:** the beacon is **allowed** as xhr, ping and fetch, on both `api.inkcartridges.co.nz` and `ink-backend-sg`.
  - **Positive controls:** Google Analytics collect, gtag.js and `bat.bing.com` were all **blocked**, so the engine was doing its job.
  - **What that means:** a visitor with a default blocker still sends our pageview. The ~5 missing pageviews on 1 Oct are not explained by default filter lists. A blocker with a custom list, or a click that never loaded the page (for example a bot or a closed tab), would fit. No route change needed.
- **Search fix b1934f3 (§6 of ad-visitor-dropoff).** `GET /api/printers/search` still returns `[]` for your own example, "Fuji Xerox Docuprint CM305 df". The stored spelling "Fuji Xerox DOCUPRINT CM 305DF" matches. It also still returns `[]` for "DCP-J1050DW", while "DCP J1050DW" matches.
  - **Our side:** the storefront never strips spaces. It only turns hyphens into spaces, and it asks both spellings (BF-096). We keep that.
  - **Question:** which endpoint did b1934f3 change? If it was `/api/search/smart` only, could `/api/printers/search` get the same matching?

## §9 After the deploy

**Deploys.** We pushed `e0a76a13` (ERR-299 to ERR-302) at 04:01:41 UTC. The new `/cart` markup was served by 04:02 UTC.

**A defect in our first deploy, live for about 4 minutes.** The production probe failed on the footer link. In that build `initFooter()` threw `renderGoogleReviewsLink is not defined`, because the function had been committed in the wrong scope. The throw stopped the rest of the footer setup on every page, including the Google Customer Reviews badge loader. Hotfix `abfca574` was pushed at 04:05:46 UTC and was live by 04:06 UTC. After it, we found no uncaught page errors on `/`, `/shop?…code=288`, `/p/GGI690KCMY`, `/cart`, `/checkout` or `/order-confirmation`. The cause is in ERR-302.

**`PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:ad-clicks`, after the hotfix: 18 pass, 0 fail, 1 not measured.**
- Footer: the link is shown, the href is byte-identical to `organization.google_reviews_url`, it opens a new tab with `noopener`, and there are no stars or counts.
- PDP `GGI690KCMY`: exactly one Ads-scoped `view_item` with `id: "GGI690KCMY"`. Google's tag transmitted it to Ads in 4 requests. The probe aborts those requests, so it never joins an audience.
- Negative control: `/shop?brand=epson&category=ink&code=288` sent no Ads `view_item`.
- `/cart` as a first-visit guest: the box is shown, unticked, with the exact label and its own email field. Nothing was POSTed.
- Not measured in read-only mode: the box's position, because an empty cart hides the cart layout. The recording run measured it: the box top is at y 867, below "Proceed to Checkout" (bottom y 820).

**Add to cart, production, deep link `/cart?add=CLC73BK:1`:** the existing conversion (`…/e3c8CI2D3dwcEMqwyJZD`) and the new label-less `add_to_cart` to `AW-18032498762` with `id: "CLC73BK"` were both pushed. The tag transmitted `add_to_cart` with the SKU in 4 requests.

**The real opt-in (§4 done-when).** It took two attempts.
- **First run (04:08 UTC): no request was sent.** Our probe ticked the box within a second of the deep-link add. At that point the server had not yet minted the guest session, and a cross-sell modal opened over the page. The page told the shopper "We couldn't save that just now…", as designed, and sent nothing.
- **Second run (~04:10 UTC): `sent`.** We waited for the session and closed the modal. The shopper saw "We'll email a copy of this cart to junjackson0915@gmail.com if you don't finish. Every email has an unsubscribe link."
- **Please confirm** a `guest_sessions.contact_consent_at` row for that address at about 04:10 UTC.
- The cart lines `CLC73BK` × 1 on the probe's guest sessions are test carts. If one of them sends a reminder, it goes to the owner.

**ERR-301 on production, measured 04:14–04:40 UTC, after the hotfix.** These are the same checks as your §"How we will verify", from a first-time visitor with the consent banner open. They ran READ-ONLY: analytics requests were aborted and nothing was added to a cart.

`PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:ad-visitor-dropoff`

**1. Product page: Add to Cart above the banner and clickable, fit line directly under it.** All three products (GGI690KCMY, GLC3329XLBK, CDR1070BK) passed at every size.

| Size | Add to Cart (y) | Nothing overlaps; `elementFromPoint` hits it at centre + 4 corners | Fit line under it, on screen |
|---|---|---|---|
| 1280×551 | 464–519 | yes | yes |
| 1366×599 | 464–519 | yes | yes |
| 1536×695 | 513–586 | yes | yes |
| 1366×768 | 513–586 | yes | yes |
| 1280×720 | 513–586 | yes | yes |
| 1440×900 | 513–586 | yes | yes |

- **Layout shift (CLS):** at most 0.054 on genuine products and 0.094 on the compatible drum at 1280×551. Both are under 0.1.
- **Your literal vertical figure** (`Add.bottom ≤ min(banner.top, badge.top)`) is printed beside every row. With the banner bottom-left and the badge bottom-right, it is false at the short sizes while nothing actually covers the button. That is what the §1 note above is about.

**2. Series page `code=288`: first-row price and Add above the banner, H1 names the code.**
- **Visible label:** "Epson 288 / 288XL Ink Cartridges", the same words as the H1.
- **Price / Add positions:**
  - 1366×599 and 1280×551: first price at y 441, first Add at y 495–531, 218px from the card top.
  - 1536×695 and 1366×768: 247px from the card top.
- **Covered cards:** at 599 and 551 tall, the cards in columns 1–2 sit under the consent card until it is answered. All other first-row cards are clear.

**3. `code=288XL` and `pack=value_pack` reach `/api/shop` unchanged.**
- The 288XL page sends `code=288XL` and `code=288`, and the first card is 288XL Black.
- The `code=564&pack=value_pack` page sends `pack=value_pack`, the first card is a value pack, and the "See all 564 cartridges" link is shown.

**Negative controls.** A 200px spacer above Add, and another above the grid, each turned the check red. Those two are measured against localhost. Production runs them too.

**A measurement trap we fixed in the probe.** In the first production run, 2 cards failed: G288CMYK at 1280 wide. The probe had measured Google's reviews badge during its first ~3 seconds, while it still sits in a transient 100px box (x 1180). In that state it overlapped the last card's button by 3px at the edge. Settled, the badge is 86px wide at x 1194, the button ends at x 1183, and `elementFromPoint` hits the button. The probe now waits for the badge to hold still before measuring, and the re-run passed 31 / 0.

**Consent banner with the real Google badge.** `PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:consent-banner`: 24 pass, 0 fail, 0 not exercised.
- **At 1512×806 the banner is a corner card.** It sits at x 16–376 and the badge at x 1426–1512, so they don't touch. The badge sits at `bottom: 0` and is not lifted over the banner.
- **Below 1100px it is still a bar, and the ERR-233 lift still works.** At 1024×768 the badge sits *on* the bar, and both buttons answer their own hit-test.
- **Accept stores consent.** Clicking it stores `cookie_consent=accepted`.

## §8 Funnel walk (added in your 5 Oct copy) — ERR-305, 2026-10-05

Your 5 Oct copy of this handoff added §8. The same items are 1, 3, 4, 9 and 11 of `FE-MASTER-CHECKLIST-oct2026.md`, so the full answer is in `outbox/fe-master-checklist-FE-reply-oct2026.md`, section "Items 1, 2, 3, 4, 9, 11, 12 … (ERR-305)". In short:

- **§8.1** The cart click no longer runs Turnstile. It waits for `/api/cart/validate` for at most 700 ms, then goes to /checkout. The payment page runs Turnstile invisibly from page load and refreshes it every 240 s. A guest who presses Pay before the token arrives sees a spinner, not a dead button.
- **§8.2** "Proceed to Checkout" now comes directly after the money rows (it was at y 829 at 1366×768). "Continue Shopping" is a text link. At 1280×551, 1366×599 and 1536×695 the sticky checkout bar (phone-only until now) shows while the real button is off-screen. Measured: a control on the first screen and clickable at all four laptop sizes and on 390×664, and the click reaches /checkout in 243–292 ms. On /cart, desktop toasts moved to the top: the "Added" toast had landed on the moved button.
- **§8.3** The cart shows your `summary.total` as "Estimated total" (30.79 + 7 = 37.79, measured); the FE adds nothing up. Checkout shows "Calculating…" until your figure arrives. The local $12 table is used only if `/api/shipping/options` fails, and it is marked when it is.
- **§8.4** Both ticks are gone. Under Pay: "By placing this order you agree to our Terms & Conditions and Privacy Policy" (owner, 5 Oct).
- **§8.5** The summary shows the region label ("Kelston, Auckland 0602"). NZ Post suggest is asked for 8.
- **Asks BF-100**: can `POST /api/orders` take a postcode without a region? This is for the Apple/Google Pay button on the cart, which is built but OFF until the owner tests it with `/cart?wallet=1`.
- **Found:** your per-IP guest-session mint cap (`429 "Too many guest sessions"`) closed for this office for over an hour after a few probe runs. What are its window and its limit?

**Deployed** as `7fea044d`, live on www from **2026-10-05 07:26:32 UTC**. Measured on live www right after:
- `npm run probe:checkout-funnel` (read-only): 7/7.
- Browser at 1366×768 (real button, y 696–741), 1280×551, 1366×599 and 1536×695 (sticky bar), consent banner open: the control is clickable at every size. Click → /checkout took 301–308 ms.
- Not yet measured live with a SERVER cart: your guest-session cap was still refusing this office's IP. Re-run with `npm run probe:checkout-funnel -- --seed` once it reopens.

## Not done, on purpose

- No price claims, no star ratings, no "guaranteed fit" wording.
- No page-speed work.
