# FE reply, 6 October 2026: the FE master checklist (afternoon re-issue) and your answer to our eight replies

**From:** frontend · **Date:** 6 October 2026 (late evening NZT)
**Answers:** two documents of yours, in one place:
- `FE-MASTER-CHECKLIST-oct2026.md`, the version with "Status after the live check of the FE deploy (6 Oct, afternoon)" and items 16 and 17. See Part A (errors log ERR-309).
- `fe-replies-oct2026-backend-response.md`, your answer to our eight replies. See Part B (errors log ERR-308).

Every claim below was measured. Before any change we checked the production API (GETs only). After the change we checked a browser on `localhost:3000` against that API. Production re-runs after the deploys are in "Production measurements".

## What we need from you

1. **Watch the first Apple Pay / Google Pay charges in Stripe**, as you offered. The cart wallet is ON for every shopper since 23:25 NZDT on 6 Oct. There has never been a wallet charge on any page, so the first ones are new ground. Orders from it may omit `shipping_address.region` (see BF-100 below).
2. **Add an `id` to each `compatible_alternatives` row (optional).** Without it, every Add on an alternative first calls `GET /api/products/:sku` to resolve the SKU. Nothing breaks without it.
3. **Confirm the BF-095 limiter order (question).** You say a token-less `POST /api/business/apply` (or `/reapply`) is refused with 401 and spends nothing. We have not measured this, and we never POST `/apply` to test it: before your change, two curls and one probe run locked the owner's office out for a day. Can you confirm it from the code or the logs? If you would rather we measure it, our probe's `--post-controls` mode reports any `ratelimit-policy` with `w=86400` on that 401 as a failure.
4. **One abandoned guest cart holds GDK11203WH ×1.** It came from one of our checks, which hit your per-IP limiter (429) before its cleanup ran. It has no email and no opt-in, so no reminder can go out. Ignore it or purge it.

## Deploy

| Commit | What | Live on www |
|---|---|---|
| `b2d07c0f` | ERR-307: checklist items 14 and 15 | pushed 2026-10-06 12:32 NZT (23:32 UTC 5 Oct). **Both of your 6 Oct checks list 14 and 15 as open; both were already live.** Your checks ran on the earlier deploy. |
| `38eb74f3` | ERR-308: Part B | pushed 23:17:10 NZDT (10:17 UTC); www served the new `service-row.js` at 23:17:26 |
| `aeac442b` | ERR-309: checklist items 2, 6, 16, 17 | pushed 23:25:02 NZDT (10:25 UTC); www served the new `cart.js` at 23:25:17 |
| `85f92ea8` | ERR-309: the cart wallet now mounts on a cart filled after page load | pushed 23:38:39 NZDT (10:38 UTC); served 23:39:00 |

---

## Part A: FE master checklist, afternoon re-issue

| # | Status | Measurement |
|---|---|---|
| 2 | **ON.** | `DARK_FEATURES.cartWallet: true`, as the owner decided on 6 Oct. Every shopper on `/cart` gets the Express Checkout Element; `?wallet=1` is no longer needed. The address rules follow your BF-100 answer (Part B). **Fixed after go-live:** the wallet decided once, at page load, so a cart filled after load (your `/cart?add=` reorder links) never showed it. It now follows every settled cart total: it mounts once the cart is priced, and the sheet opens on the current total. |
| 6 | **Done.** | **Your measurement held.** Cause: a desktop layout rule from 28 Sep (`.product-info > #product-value-lines { order: 2 }`, ≥1100 px) sent the points line to the bottom of the buy column. The line now sits **inside the price row**. GLC3313BK at 1366×599 and 1280×551: price y 392, points y 404–424, Add 471–519 (unchanged), and Add is hit-testable. The wording is "Earn 67 reward points ($0.67)", your item's own words. "… on this order" made the line wrap under the price and pushed Add down 24 px at 1280×551 (measured), so we dropped it. |
| 14 | Done in `b2d07c0f` | Both price cells show the rung price, and `updateQuantity` adopts the PUT's `data.cart` with no follow-up GET. GLC3313BK 1→3: the first qty-3 frame shows $67.49 struck through and $66.14, then settles at $198.42 with −$4.05. 0 mixed frames. |
| 15 | Done in `b2d07c0f` | Your `VALIDATION_FAILED` on `email` stops "Continue to payment" and shows your message under the field. Network errors, 429 and 5xx let the shopper through. `/payment` has a second check beside Pay. `test@gmail.con` is caught. |
| 13 | Needs the owner's real guest order | — |
| 16 | **Done.** | "Our compatible version" sits under Add and the fit line, above Delivery/Returns. It shows only on a genuine product with `compatible_alternatives` (at most 3). Each card has the name, the price, "N pages" when `page_yield` is present, a "View" link to `/products/{slug}/{sku}`, and Add. Your warranty line (`trust_signals.warranty.compatible_label`) follows the cards. When `same_capacity` is false, the tier is compared with the genuine row's `yield_tier`: "XL — higher capacity" or "Standard — lower capacity". When either tier is unknown we print only "XL capacity", never a guessed direction. No savings, percentages or OEM marks. **GTN2030BK** shows CTN2030BK at $24.49 with "1,000 pages", below Add. **G604BK** shows C604XLBK, "XL — higher capacity". **G924CMY** and **CTN2030BK** show no box. |
| 17 | **Done.** | Every cart cap is now the line's stock (capped at 100; unknown stock keeps 100; stock 0 caps at 1). The stock comes from `items[].product.stock_quantity`. The deep link, the `/shop` and product cards, the PDP and the alternatives also hand it to the cart at add time. The PDP quantity box and the card steppers cap at stock too. Reaching the cap shows "Only 8 in stock — that is the most you can order." A refusal (`STOCK_INSUFFICIENT` with `details.available`, or the older thrown `BAD_REQUEST` with the same detail) shows the same message and records the stock on the line. It no longer says "Network error", and neither does a 429. GDK11203WH (stock 8): 12 clicks of + stop at 8 with + disabled; typing 28 becomes 8; no PUT answered 400. |

**Noticed, not in the checklist:** on the compatible PDP CTN2030BK at 1280×551, Add sits at y 548–596, below the 551 px screen. It was the same on www before our deploy. The first-screen rule holds at 1366×599 and above, and on the genuine pages measured here. Taller compatible titles push the buy box down. Tell us if you want it handled before the next re-check.

---

## Part B: your answer to our eight replies

| Ask | Your answer | What we measured | What we did |
|---|---|---|---|
| **BF-094** `display_name` on listing and finder rows | Built | We sampled every printer surface: `/api/shop` listing `compatible_printers[]` 40/40, `/api/printers/search?q=L2375` 2/2, `/api/products?search=LC3317` rows, PDP 5/5 + `top_models` 5/5, `by-brand/brother` 565/565, and both printer-hub `printer` objects. 47 sampled names equal your prerender `<h1>`. | **Deleted our name mirror** (119 calibrated words plus the Brother hyphen rule). We print `display_name` as given. A row without it prints its raw `full_name`, and our console logs one warning naming BF-094. |
| **BF-095** business apply | Built, credit reference not | `probe:business-apply -- --admin` checks `can_apply` on every branch, now as a hard check rather than a soft warning. | `APPLICATION_PENDING` shows "we have your application" and `ALREADY_APPROVED` opens the account view, both taken **from the code itself**. Before, we re-read status, and a failed re-read left a pending applicant looking at "try again in a minute". The rate-limit message now says "from your account today" (it said "from this connection"). **Credit-reference step: not built**, as you asked. See question 3 above. |
| **BF-096** separator-tolerant search | Built | `Brother MFC-J5930DW`, `MFC J5930DW` and `MFCJ5930DW` return the same single printer, and so does `HLL 3210CDW`. `Brother DCP-J1050DW` with `brand=brother` returns 1. `Brother HL-L2350DW` returns 0, so our no-match control still holds. | `finderSpellings` and its second request are gone, as is the five-spelling fan-out in our printer-model resolver. Each is now one request. **Found on the way:** a failed lookup used to show "We couldn't match that printer"; it now says the lookup isn't answering. |
| **BF-097** /genuine-vs-compatible | We were right | — | No change. The banned-phrase test stays. |
| **BF-098** `code=288XL` | Keep it | — | No change. We keep the two-request merge. |
| **BF-099** withdraw consent | Built | — | Unticking after a send now POSTs `{ guest_session_id, consent: false }` (no email) to `/api/cart/guest-contact`. The session id comes from the same store as `X-Guest-Session`. Success shows "We won't email you about this cart". Failure says a reminder may still be sent, and the next event retries. Unticking when nothing was sent makes no call. Events go out one at a time, in order, so a fast tick then untick reaches you as opt-in then withdrawal, never the reverse. |
| **BF-100** wallet without a region | No change needed | — | The Apple/Google Pay sheet no longer refuses an address whose `state` matches no region. The order omits `shipping_address.region`; we never send `''` and never guess. We still require `city` and a **4-digit** `postal_code`, checked when the address changes and again at confirm. `delivery_type` stays omitted, so the order is at the urban rate with `delivery_type` NULL, as you described. The sheet's figure comes from `/api/shipping/options` without `delivery_type`, so it matches what is charged. |
| **BF-101** service-row facts | Two of three built | `tax_invoice` = `{ emailed_with_every_order: true, label }`; `shipping_promise.delivery_label` = "1–3 business days NZ-wide", min 1, max 3. | The GST-invoice fact now reads `tax_invoice` (literal `true` plus your label) instead of `organization.gst_number`. Series and printer pages read "Auckland metro orders by 2pm ship same day · most of NZ in 1–3 business days". **Payment methods:** the owner keeps Afterpay off the row; no field needed. |
| Guest-session cap | No change | — | Noted: the probes keep reusing one session per run. |
| GA4 + Ads on `/admin` | Skip both | — | The admin page no longer loads the Google tag, `gtag.js` or the cookie banner, and `gtag.js` skips both `config` calls on any `/admin` path. Signed in as the owner, `/admin` made 0 requests to Google, Bing or our `gtag.js`, and had no `dataLayer`. A signed-out visit redirects to `/account/login`, a storefront page that still loads them, as it should. |
| Ads `purchase` double count | No action | — | Noted. |

**One trade-off, measured, for the owner.** The service row is one 18 px line, and a fact that doesn't fit is hidden whole (ERR-306). The longer speed fact pushes the GST-invoice fact off on series and printer pages at 1280, 1440 and 1920 px wide. It still fits at 1366 on a series page. The returns fact was already off at those widths. Before this change, the GST fact showed at 1280. If the owner prefers the GST fact to the days, it is a one-line change on our side.

---

## What changes on your side

**New or changed request patterns:**
- **`GET /api/printers/search`: at most half as many requests.** The printer finder used to send two concurrent requests for a query with a hyphen; it now sends one per (debounced) keystroke. The `/shop?printer_model=` resolver used to send up to five concurrent spellings; it now sends one, with `brand` when known.
- **`POST /api/cart/guest-contact` with `{ guest_session_id, consent: false }`** (no email) is new. It is sent only when a shopper unticks the box after an accepted opt-in. Opt-in and withdrawal are sent one at a time, in click order.
- **`POST /api/orders` from the cart wallet** may omit `shipping_address.region`, when the wallet's `state` matches none of the 16 regions. Expect `shipping_region` empty and `delivery_type` NULL on those orders. `postal_code` is always 4 digits.
- **`GET /api/products/:sku`: one per click on a compatible alternative's Add** (until rows carry `id`, ask 2).
- **Far fewer `400`s from `PUT /api/cart/items/:productId`.** We now send the clamped quantity: `updateQuantity` used to send the raw number even when it clamped locally. A remaining stock 400 means the stock fell after the cart loaded.
- **Admin no longer reaches GA4 or Google Ads**, as you asked. Expect admin pageviews to stop in GA4 and the Ads "All visitors" list to lose staff visits from 23:17 NZDT on 6 Oct. Microsoft UET was already off there (ERR-303).

**Contracts the storefront depends on.** Please tell us before changing any of these.

*No FE fallback; a change shows to shoppers:*
- **`display_name` on every printer row**: listing `compatible_printers[]`, `/api/printers/search`, PDP `compatible_printers[]` and `top_models[]`, `by-brand`, and the printer-hub `printer` object. A row without it prints the raw `full_name` (for example "Brother MFC J5930DW").
- **`/api/printers/search` matching any separator spelling (BF-096).** We ask once. If matching went back to typed text only, "MFC-J5930DW" would show "We couldn't match that printer" again.
- **`can_apply` boolean on every `/api/business/status` branch, and the exact 409 codes `APPLICATION_PENDING` and `ALREADY_APPROVED`.** Any other 409 falls back to re-reading status.
- **`tax_invoice.emailed_with_every_order === true` plus `tax_invoice.label`** decides the GST-invoice fact; the label is printed verbatim. **`shipping_promise.delivery_label`** supplies the days on series and printer pages; " NZ-wide" is cut from its end.
- **`/api/cart/guest-contact` accepting `consent: false` without an email**, and still answering `ok: true`.

*Degrades safely if missing:*
- **`items[].product.stock_quantity` on each cart line.** If absent, the old cap of 100 applies; it never blocks.
- **`error.code: 'STOCK_INSUFFICIENT'` with `details.available`** on `POST`/`PUT /api/cart/items`. We also still read a thrown error carrying `details.available`.
- **`compatible_alternatives[]`**: `sku`, `slug`, `name`, `retail_price` (a row without a positive price is skipped), `page_yield` (read as a STRING such as "1,000"; a number also works), `yield_tier`, `same_capacity`, `image_url`, `in_stock` (false shows "Out of stock" and no Add). Absent field means no box.
- **The product's own `yield_tier`** (the genuine row's tier, used for higher/lower), and **`trust_signals.warranty.compatible_label`** (absent means the line is omitted).

**Our test traffic in your logs, 6 Oct about 22:30–23:45 NZDT (09:30–10:45 UTC):**
- **Reads:** paced GETs from `probe:four-replies` (brands, `by-brand` per brand, about 47 printer prerenders, `/api/shop`, `/api/products`, `/api/printers/search?q=L2375`).
- **Printer searches:** `/api/printers/search` for `Brother MFC-J5930DW`, `MFC J5930DW`, `MFCJ5930DW` and `Brother HL-L2350DW`, from browsers on `localhost:3000` and on www. These write no `search_analytics` row.
- **Owner sign-ins:** one Supabase password grant plus `GET /api/business/status` from `probe:business-apply -- --admin`, and one browser sign-in to open `/admin` at about 23:18.
- **Probe guest carts:** GLC3313BK and GDK11203WH were added to, re-quantified in and removed from probe guest carts. Each rollback was verified by re-reading the cart, except the one cart in ask 4.
- **Several 429s on `/api/cart*` and `/api/site/*` from one IP:** our probe runs back to back. The probe now pauses 60 s before its stock section.
- **`POST /api/checkout/guest-prefill`, two per run:** a 400 for `test@gmail.con`, then a 200 for `test@gmail.com`.
- **Not sent at all:** no POST to `/api/business/apply`, `/reapply` or `/api/orders`. The consent-withdrawal and wallet-order shapes were tested against stubs, not your API.

## Production measurements

After the deploys, against www:
- **`probe:fe-master-6oct -- --record`: 57 passed, 0 failed, 0 skipped** (23:40 NZDT).
  - **6:** GLC3313BK at 1366×599 and 1280×551: price y 392, points y 404–424, Add 471–519, hit-testable. The negative control (line moved back) measures y 1459 and goes red.
  - **16:** GTN2030BK shows CTN2030BK at $24.49 with "1,000 pages", below Add; Add 471–519 at 1280×551. G604BK shows "XL — higher capacity". G924CMY and CTN2030BK show no box.
  - **17:** GDK11203WH: 12 clicks ⇒ 8 with + disabled and "Only 8 in stock — that is the most you can order."; typing 28 ⇒ 8; PUTs 200/200, no 400.
  - **2:** on a cart filled by `/cart?add=` with no `?wallet=1`, the Express Checkout Element reached `ready`.
  - **14 / 15 / 9 (re-check):** first qty-3 frame "$67.49 $66.14"; 257 frames, 0 mixed; `test@gmail.con` caught; click → `/checkout` in 181 / 86 / 95 ms.
  - Rollback re-read ×0 for both SKUs.
- **`probe:fe-master` (items 5/7/8, READ-ONLY): 45 passed, 0 failed, 0 skipped.** The series and printer service row reads "… · most of NZ in 1–3 business days" at every width tested.
- **`probe:turnaround-fixes -- --browser`: 34 passed, 0 failed.** Each finder spelling sent ONE `/api/printers/search` request and showed "Brother MFC-J5930DW". The one red line on the first run was a stale regex in our probe, not your API.
- **`probe:four-replies`: 39 passed, 0 failed.** BF-094 is a hard check now: listing rows 40/40 and search rows 2/2 carry `display_name`.
- **`probe:business-apply -- --admin`: 7 passed, 0 failed.** The owner's account (`approved`) answers `can_apply: false`, a boolean as you said. One check is unmeasured: whether a token-less POST spends nothing (question 3).

## How to re-run our side

```sh
npm run probe:fe-master-6oct                                   # READ-ONLY: checklist 6, 16
npm run probe:fe-master-6oct -- --record                       # + 14, 15, 3, 9, 17, 2 (own guest cart, verified rollback)
PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:fe-master-6oct -- --record
npm run probe:fe-master                                        # items 5/7/8, READ-ONLY
npm run probe:four-replies                                     # BF-094, READ-ONLY
node --test tests/fe-master-checklist-v2-oct2026.test.js tests/backend-response-6oct-2026.test.js
```
