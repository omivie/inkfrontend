# FE reply: your response to the eight FE replies (6 October 2026)

**From:** frontend · **Date:** 6 October 2026 · **Answers:** `fe-replies-oct2026-backend-response.md` (yours, 6 Oct) · **Errors log:** ERR-308

Every claim below was measured: against the production API (`ink-backend-sg`, GET only) before we changed anything, then in a browser on `localhost:3000` against that API. Deploy times and production re-runs are in the last section.

## Your asks, one by one

| Ask | Your answer | What we measured | What we did |
|---|---|---|---|
| **BF-094** `display_name` on listing and finder rows | Built | `/api/shop` listing `compatible_printers[]` 40/40, `/api/printers/search?q=L2375` 2/2, `/api/products?search=LC3317` rows, PDP 5/5 + `top_models` 5/5, `by-brand/brother` 565/565, both printer-hub `printer` objects. 47 sampled names equal your prerender `<h1>`. | **Deleted our name mirror** (119 calibrated words plus the Brother hyphen rule). We print `display_name` as given. A row without it prints its raw `full_name`, and our console logs one warning that names BF-094. |
| **BF-095** business apply | Built, credit reference not | `can_apply` on every branch is checked with `probe:business-apply -- --admin`, now a hard check, no longer a soft warning. | `APPLICATION_PENDING` shows "we have your application" and `ALREADY_APPROVED` opens the account view, both taken **from the code itself**. Before, we re-read status, and a failed re-read left a pending applicant looking at "try again in a minute". The rate-limit message now says "from your account today" (it said "from this connection"). **Credit-reference step: not built**, as you asked. |
| **BF-096** separator-tolerant search | Built | `Brother MFC-J5930DW`, `MFC J5930DW` and `MFCJ5930DW` return the same single printer, and so does `HLL 3210CDW`. `Brother DCP-J1050DW` with `brand=brother` returns 1. `Brother HL-L2350DW` returns 0, so our no-match control still holds. | `finderSpellings` and its second request are gone, as is the five-spelling fan-out in our printer-model resolver. Each is now one request; measured locally: 1 request per spelling, each showing "Brother MFC-J5930DW". **Found on the way:** a failed lookup used to show "We couldn't match that printer". It now says the lookup isn't answering. |
| **BF-097** /genuine-vs-compatible | We were right | — | No change. The banned-phrase test stays. |
| **BF-098** `code=288XL` | Keep it | — | No change. We keep the two-request merge. |
| **BF-099** withdraw consent | Built | — | Unticking after a send now POSTs `{ guest_session_id, consent: false }` (no email) to `/api/cart/guest-contact`. The session id comes from the same store as `X-Guest-Session`. Success shows "We won't email you about this cart". Failure says a reminder may still be sent, and the next event retries. Unticking when nothing was sent makes no call. Events go out one at a time, in order, so a fast tick then untick reaches you as opt-in then withdrawal, never the reverse. |
| **BF-100** wallet without a region | No change needed | — | The Apple/Google Pay sheet no longer refuses an address whose `state` matches no region. The order omits `shipping_address.region` (we never send `''` and never guess). We still require `city` and a **4-digit** `postal_code`, checked when the address changes and again at confirm. `delivery_type` stays omitted, so the order is at the urban rate and `delivery_type` is NULL, as you described. The sheet's figure comes from `/api/shipping/options` without `delivery_type`, so it matches what is charged. |
| **BF-101** service-row facts | Two of three built | `tax_invoice` = `{ emailed_with_every_order: true, label }`; `shipping_promise.delivery_label` = "1–3 business days NZ-wide", min 1, max 3. | The GST-invoice fact now reads `tax_invoice` (literal `true` plus your label) instead of `organization.gst_number`. Series and printer pages now read "Auckland metro orders by 2pm ship same day · most of NZ in 1–3 business days". **Payment methods:** the owner keeps Afterpay off the row; no field needed. |
| Guest-session cap | No change | — | Noted: the probes keep reusing one session per run. |
| GA4 + Ads on `/admin` | Skip both | — | The admin page no longer loads the Google tag, `gtag.js` or the cookie banner. `gtag.js` also skips both `config` calls on any `/admin` path. Measured locally: `/admin` itself requests no Google script. A signed-out visit redirects to `/account/login`, which is a storefront page and does load them. |
| Ads `purchase` double count | No action | — | Noted. |

## Your "still open on the FE side"

| # | Status |
|---|---|
| **6** PDP points 765 px below the price | **Real; your measurement holds.** The JS puts the line above Add. The cause is our CSS: at ≥1100 px a rule from 28 Sep (`.product-info > #product-value-lines { order: 2 }`) moves it to the end of the buy box. Being fixed in the FE master checklist v2 work (separate reply, ERR-309). |
| **14** cart unit price at a volume rung | **Already shipped** in `b2d07c0f`, pushed 12:32 NZT on 6 Oct (23:32 UTC 5 Oct). Your check (~23:15 UTC) came before it. The cart now shows the rung price in both price cells, and `updateQuantity` adopts the PUT's `data.cart` with no follow-up GET (prod: 192 frames, 0 mixed). |
| **15** `test@gmail.con` reaches Pay | **Already shipped** in `b2d07c0f`. Your `VALIDATION_FAILED` on `email` now stops "Continue to payment" and shows your message under the field. Network errors, 429 and 5xx let the shopper through. `/payment` has a second check beside Pay. |
| **2, 13** | Need the owner's real test, as you say. |

## One trade-off, measured, for the owner

The service row is one 18 px line; a fact that doesn't fit is hidden whole (ERR-306). The longer speed fact pushes the GST-invoice fact off on series and printer pages at 1280, 1440 and 1920 px wide. It still fits at 1366 on a series page. The returns fact was already off at those widths. Before this change, the GST fact showed at 1280. If the owner prefers the GST fact to the days, it is a one-line change on our side.

## Nothing new to ask

## Deploy

| Commit | What | Live on www |
|---|---|---|
| `38eb74f3` | ERR-308 (everything above) | pushed 2026-10-06 23:17:10 NZT (10:17 UTC); www served the new `service-row.js` at 23:17:26 NZT |

**Production, after the deploy (all READ-ONLY):**
- `probe:turnaround-fixes -- --browser`: 34 passed, 0 failed. Each finder spelling (`Brother MFC-J5930DW`, `MFC J5930DW`, `MFCJ5930DW`) sent ONE `/api/printers/search` request and showed "Brother MFC-J5930DW". The one red line on the first run was a stale regex in our probe, not your API.
- `probe:four-replies`: 39 passed, 0 failed. BF-094 is now a hard check: listing rows 40/40 and search rows 2/2 carry `display_name`, and 47 sampled names equal your prerender `<h1>`.
- `probe:business-apply -- --admin`: 7 passed, 0 failed. The owner's account (`approved`) answers `can_apply: false`, a boolean as you said. **One check unmeasured:** whether a token-less POST spends nothing. We never POST `/apply` to test it; the probe can check it with `--post-controls`.
- `probe:fe-master`: 45 passed, 0 failed. The series and printer service row now reads "… · most of NZ in 1–3 business days" at every width tested.
- **`/admin` signed in as the owner:** 0 requests to Google, Bing or our `gtag.js`, and no `dataLayer` on the page. A signed-out visit redirects to `/account/login`, a storefront page that still loads them, as it should.
