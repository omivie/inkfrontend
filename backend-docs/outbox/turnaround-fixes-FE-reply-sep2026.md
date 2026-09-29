# Reply: storefront fixes from the 28 Sep turnaround review

**From:** frontend · **For:** backend developer · **Date:** 2026-09-29
**Answers:** `fe-turnaround-fixes-sep2026.md` (backend, 2026-09-28; received 2026-09-29 with the round-2 reply)
**Frontend log:** ERR-296 (`/business` Apply, item #10, is ERR-297 and has its own reply: `business-apply-FE-reply-sep2026.md`)

Thank you for sending it. Every item was checked against our code and the live API before anything was built. Half of the list had already shipped in ERR-290/293/294, so it was not rebuilt. The rest is built, tested and described below. There is one new ask (**BF-096**) and one thing you can switch on now.

---

## 1. Search Console: you can restart validation now

Both fixes in your "New P0 — Soft 404" section were already live before your doc arrived. They shipped in ERR-294 (`215a0c4`, deployed 2026-09-28):

- **Fix 1.** Any `/shop` URL with `search` or `q`, and every `/search` URL, sends `X-Robots-Tag: noindex, follow` from `vercel.json` (for crawlers that run no script) and sets `<meta name="robots" content="noindex, follow">` in the SPA. Measured on production: 6/6 (browser and Googlebot). The control `/shop?brand=hp` stays indexable.
- **Fix 2.** Old-site slugs keep the part number: `/fuji-xerox-ct201304-toner-cartridge-cyan` → `/shop?search=fuji-xerox-ct201304+cyan`.

New in this round, for the printer pages (item #4): see §3.

## 2. Switch on `GUEST_CART_ADD_LINKS`

`/cart?add=SKU:QTY,…` has been live on the storefront since ERR-269, and your own re-check confirmed it. Please set `GUEST_CART_ADD_LINKS=true` on Render. Account holders now use the same path: the new "Buy again" button (item #18) sends an order's lines to `/cart?add=`. So the reorder emails and the account page share one reorder route. Unknown SKUs, the 12-line cap and the 1–20 quantity clamp are reported to the shopper in one place.

## 3. What was built

| # | What you asked | What we did |
|---|---|---|
| 4 | Bot prerender timeout/error → 503 with `Retry-After`, never the shell | `middleware.js`: the fetch now has an 8s timeout (your cold prerender measured 3.6s). A timeout, a network error or a **5xx** answers **503**, `Retry-After: 120`, `Cache-Control: no-store`. A **4xx** still falls through to the SPA, because a printer or product that does not exist is an answer, not an outage. The SPA already emitted the printer canonical (`shop-page.js` builds it with `printer_slug`). |
| 6 | Alias banner + "Search PG-640" link | The link now reads "Search PG-640". The header typeahead also shows the note and the link; before, it showed "No results" for `canon pg540`. |
| 7 | Say plainly when the finder can't match a printer | The empty state reads "We couldn't match that printer. Check the code printed on your old cartridge and search for that instead, or send us a photo." It links `/quote` and our phone number. The Find button now submits `&from=finder`. When that search returns rows but no `matched_printer`, a banner above the results says "These match your words, not your printer. Check the code on your old cartridge before you order." A search typed into the normal search box makes no printer claim, so it gets no banner. |
| 8 | Cap the add-to-cart pop-up image at ~120px; hide when empty | Capped at 120px. The cause: the grid is `auto-fit`, so a single suggestion stretched its card, and its square image, across the 760px panel (686px). It already hid on `[]`. |
| 9 | ADS in the Brother hyphen rule | Added. No ADS printer is in the catalogue today (measured with `/api/printers/search?q=ADS`). The other three bullets shipped in ERR-294. |
| 11 | `business_account_offer` card on the confirmation page | Shown only when the field is `true`. If the key is absent (an older payload, or the offline copy of the order) we read it as unknown, never as "no". |
| 12 | Ex-GST beside incl-GST for active business accounts | Shown under the product page price and every cart line price, as `price / 1.15` rounded to the cent, only when `/api/business/status` says the account is active. The product page's microdata price stays GST-inclusive. |
| 13 | Link `/quote` from `/bulk-pricing`, `/business`, the ladder | `/bulk-pricing` and the product page ladder ("Buying for several printers? Get a quote") now link it. `/business` is in ERR-297. |
| 14 | One-field account creation on the confirmation page | A password field and the register form's own terms box, using the order's email. The copy is "Create a password to save your printer and keep your points." Supabase answers an already-registered email with a fake success (`identities: []`). We read that as "an account with this email already exists", not as "check your inbox". |
| 15 | Sign-in copy with the welcome points and guest points, from value-props | Sign-in and register both show `loyalty.headline` and `loyalty.detail`. The line is hidden until the fetch succeeds. No number is written in our markup. |
| 16 | `/bulk-pricing` "3+" rule | Already rendered from your `detail` (ERR-289). No change. |
| 17 | Brand filter on `/value-packs` | Brand chips from `/api/brands` (`show_on_shop`, in `sort_order`) filter `pack=value_pack&brand=<slug>`. Measured: every row for `canon` (124) and `kyocera` (67) is that brand. A brand with no packs says so in words. |
| 18 | "Buy again" for signed-in customers | A button on every order row, on the order detail page and in the account menu. It reads `GET /api/orders/:orderNumber` and opens `/cart?add=` (see §2). |
| P2 | Cart "Total" leaves out shipping | Relabelled "Total before shipping" (and "Before shipping" on the phone bar). We do not add prices on the frontend. |
| P2 | Coupons for guests | On the cart and at checkout, the field and the Apply button are hidden for guests. Guests see "Have a code? Create a free account to use it", linking to sign-up. Before this, a guest could type a code on the cart page and use up one of their attempts. |
| P2 | Mobile fixed bars; toast over the sticky bar | The header already hid while scrolling down. Filter & Sort now follows the same signal (`.site-header--hidden`): it leaves on a downward scroll and comes back on an upward one. Toasts on phones now appear at the top of the screen. |
| P2 | Card text ≥ 12px | Measured in the browser: the smallest text on a card is now 12px at 1440 and 390 wide. Before: 9.92px ("3+ PRICE", "Save $x", "Free Shipping"), 10px (pack ribbon) and 11px (stock, colour). |
| P2 | Don't block the checkout transition on Turnstile | The token is fetched early: when the cart page is idle, and when the shopper hovers over, focuses or touches Checkout. The click waits **at most 1.5s** for it; before, it could wait up to 8s. Cart validation still runs, because price-change acknowledgement lives on the cart page. We have no real-user timing data, so we cannot tell you how often the old 8s wait happened in the field. |
| P2 | Cart LCP 3.6s / logo font | Google Fonts now load from a `<link>` in every page head instead of an `@import` in `base.css`. Measured on `/cart` (iPhone 13, throttled, 3 runs): the font CSS starts at about 160ms instead of 870ms, but first paint improved by only about 80ms. The import chain was real, but it was not the bottleneck. On desktop, LCP is the logo repainting when Inter arrives (0.7–0.9s in both builds). **We are not claiming this as an LCP fix.** |
| P2 | Apex 307 → one permanent redirect | This is a Vercel **domain** setting, so we cannot change it from the repo. The owner will change it. `/html` and `/html/*` already return 308. |

## 4. New ask — BF-096: `/api/printers/search` is separator-intolerant

We found this while building #7. Measured on 2026-09-29:

| query | result |
|---|---|
| `Brother MFC-J5930DW` (the finder's own placeholder) | `[]` |
| `Brother MFC J5930DW` | the printer |
| `Epson XP-2100` | `[]` |
| `Epson XP 2100` | the printer |
| `Brother HL-L2375DW` | `[]` |
| `HLL-3210CDW` (stored with a hyphen) | the printer |
| `HLL 3210CDW` | `[]` |

Your own item #9 says the hyphenated form "is how people search". The storefront now sends both spellings at once and merges the results. That doubles the finder's requests for any query containing a hyphen, and it only helps our finder.

**Ask:** normalise separators on both sides of the match (query and stored name: `-`, space, and none). Then `MFC-J5930DW`, `MFC J5930DW` and `MFCJ5930DW` would all find the printer. When that is live, we will delete the second request (`finderSpellings` in `shop-page.js`).

## 5. Something we did wrong

Before we read your round-2 note that `/api/business/apply` is limited to 5 requests per IP per 24 hours, counted before auth, we sent one unauthenticated `POST` to `/api/business/apply` and one to `/api/business/credit-reference`, to check whether the routes existed (both returned 401). That request used up part of the office IP's quota. Our probes never POST to those routes now. We also no longer treat a CORS preflight as evidence that a route exists, because it returns 204 for any path.

## 6. How it is checked

- `tests/turnaround-fixes-sep2026.test.js`: 36 tests. The middleware is imported and run against stubbed backends (timeout, 5xx, network error, 404, 200, a human user agent).
- `scripts/redproof-turnaround-fixes-sep2026.py`: 42 of 42 mutations make the suite fail.
- `npm run probe:turnaround-fixes -- --browser`: read-only, GET requests only. To test the finder banner without writing a `search_analytics` row, the probe answers the one search it needs with your measured `/smart` shape, and prints that it did so.
