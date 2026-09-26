# Conversion fixes + value props — FE reply, 2026-09-27

**From:** frontend · **Answers:** `inbox/conversion-fixes-and-value-props-FE-handoff-sep2026.md` (2026-09-23, §8 added 2026-09-27)
**FE records:** ERR-287 (SEO redirects), ERR-288 (truthfulness), ERR-289 (overlays, first screen, CLS) in `errors.md`
**New asks:** BF-071 … BF-076 (§4 below)

Everything in the handoff that the FE owns is built. Each number below was measured in a fresh
Playwright context (analytics requests aborted, no cart writes), on `npx serve` at localhost:3000
against the live API, before (HEAD `12e5733`) and after. Nothing is deployed until the owner says
push; the numbers will be re-taken on production after deploy.

Verification the FE now carries:
`node --test tests/conversion-fixes-sep2026.test.js` (43 tests; `python3 scripts/redproof-conversion-fixes.py` reports 24 of 24 mutations caught) ·
`npm run probe:conversion-fixes` (48 passed, 0 failed) · `npm run probe:mobile-cta` (13/0) · `npm run probe:consent-banner` (19/0).

---

## 1. P0 items

| Item | Before (measured) | After (measured) | What changed |
|---|---|---|---|
| **D-P0-1 rewards popover** | popover on every non-PDP page on desktop; in-flow card on phones (ERR-280) | **gone on every device.** No `#rewards-nudge` in the DOM on any page, before or after scrolling | `js/rewards-nudge.js`, its CSS and its `<script>` tag on 30 pages are deleted. The same facts are now shown inline (§3). Tests fail if the file or its CSS comes back. |
| **D-P0-2 consent banner, phone** | 148 px (22% of a 390x664 screen) | **57 px** | Below 768 px it is one row: "We use analytics cookies. Privacy policy" with Decline and Accept beside it (both still 44 px). The full wording shows at ≥769 px and on /privacy. |
| D-P0-2 fixes 2–4 (body padding, lifting the bottom bars, sticky-ATC `rootMargin`) | — | already shipped | ERR-238 and ERR-280 shipped all three on 09-21/22. The variable is `--consent-banner-height`, not `--consent-banner-h`. The sticky-ATC observer measures the rendered header and banner boxes and rebuilds whenever either changes. |
| D-P0-2 desktop PDP Add at scroll 0 (1440x900) | y 830–878, under the bar that starts at y 839 | **genuine: y 769–817, clear of the bar** | On wide screens, the printer-fit and points lines and the colour/yield specs now render *below* Add and the pack card. The ladder box is tighter, and the breadcrumb padding is 6 px instead of 16. |
| D-P0-2, **compatible** PDP on desktop | y 859 | **y 867, still 28 px under the bar** | The Google Ads compliance panel sits above Add on compatible products. We did not move it without the owner's call. Open item, FE-side. |
| **D-P0-3 cross-sell modal** | full screen, z 10000, no way to checkout | **never opens below 768 px.** On desktop: **Checkout** (primary), Keep shopping, View cart, then the upsell | After Add, the PDP's inline confirmation now has a **Checkout** button (48 px) as its only filled button. View cart is a text link. |
| **D-P0-4 phone header** | 180 px, three rows | **128 px, one row + search** | The phone number is a `tel:` icon in the top row. The header hides on scroll-down and comes back on scroll-up. It never hides while search has focus or the menu is open. |
| D-P0-4 phone card | 471–525 px, two per row | **243 px, list layout** | Image on the left, a 2-line title, colour and stock on one line, price with GST on one line, the bulk line on one line, stepper and Add on one row. Every field that was on the card is still there. |
| **D-P0-4 first Add button, 390x664** | `/ink-cartridges` y **881** · `/toner-cartridges` **881** · `/shop?brand=hp&code=65` **861** | **571 · 571 · 505** | Target was ≤ 520. The code page meets it. The two landing pages miss by 51 px because §8.1 put the "Enter your printer model" box first (106 px). We chose to keep the box. At scroll 0 the first Add is clear of the consent bar. |
| D-P0-4 toner h1 | both pages: "Shop Ink Cartridges & Toner NZ" | "Ink Cartridges NZ — Genuine & Compatible" / "Toner Cartridges NZ — Genuine & Compatible" | See BF-071: your prerender h1s differ. |
| D-P0-4 "8 products with real images" | 4, image-less rows included | **8, image rows only** | One `/api/products/popular?limit=24` call now fills both the 8-card shelf and a new "Full colour sets" rail (packs only). There is no second request. |

A sweep in 150 px steps down all three pages on the phone found an Add button reachable wherever one was on screen. It found **0 dead offsets**. The negative control (a synthetic full-screen overlay) correctly produced 11.

## 2. P1 — speed and layout shift

| Item | Status |
|---|---|
| Static assets never cached | **Stale on your side.** Already fixed by ERR-282 (09-25): `vercel.json` serves `immutable` for 8-hex `?v=` tokens on `/js` and `/css`. |
| Catalogue GETs preflight | **Stale.** Already fixed by ERR-282: bodyless GETs send no `Content-Type`. |
| PDP content arrives late | **Built.** A new synchronous head script, `js/pdp-prefetch.js`, starts `GET /api/products/{sku}` before any deferred script runs. `API.getProduct` uses that response once, and only for the same path on the public route. A failed early fetch is retried rather than trusted. `fetchpriority="high"` is on the PDP hero, and the first row of the shop grid loads eagerly. We did not use `<link rel=preload>`: the head is static, so it cannot know the SKU without inline script, and the CSP forbids inline script (ERR-230). |
| CLS | Table below. The fixes: `main.site-main { min-height: 100vh }`, a fixed box for `#google-reviews-badge`, reserved heights for the PDP price block (208 px), title and Genuine/Compatible pill, and a single-line phone breadcrumb (it used to wrap to three lines when the product name arrived). |
| Search makes three calls | **Not a defect.** `/products?search=` and `/search/suggest` fire only on a hard or soft miss (`shop-page.js`, the recovery fallback). A normal search is one `/search/smart` call. Removing the fallback would change what shoppers see on a miss, so it stays. |
| Filter bar over the suggestions | Fixed: `body.smart-ac-open` hides `#filter-sort-bar`. The dropdown skeleton is capped at 6 cards (3 rows). |
| Apple Pay / Google Pay | **Stale on your side.** The live CSP (checked 2026-09-27) already allows `https://link.com`, `https://*.link.com` and `https://hooks.stripe.com`. `payment-page.js` has passed `paymentMethods: {applePay:'always', googlePay:'always'}` since ERR-268 (09-20), and `'always'` was the actual cause. **Owner decision: wallets stay on /payment only.** A cart-level wallet flow is out of scope. See BF-076. |

CLS before → after. Both runs used HEAD vs the working tree on the same machine, with an 8 s window. "After" is the range over 2–4 runs:

| Page | Phone | Desktop |
|---|---|---|
| `/ink-cartridges` | 0.002 → 0–0.024 | 0.053 → 0.008–0.009 |
| PDP `GTN258BK` (genuine) | 0.153 → 0.028–0.033 | 0.275 → 0.021–0.076 |
| PDP `CLC73BK` (compatible) | 0.152 → 0.019 | 0.307 → 0.084 |
| `/cart` (empty) | 0 → 0.003 | 0.053 → 0.008 |

Every figure is now under Google's 0.1 "good" line. What remains on the desktop PDP is the price
block settling when the product arrives.

Your 0.326 on `/ink-cartridges` matches the pre-fix desktop state we measured (0.43–0.48 on the old
local run).

## 3. Truthfulness and value props

- **Support hours.** The owner confirmed **Mon–Fri 9am–5pm**. "8am–8pm, 7 days" is removed from checkout, payment and 9 account pages. A test now fails if any storefront file says 8am, 8pm or 7 days.
- **Dispatch line.** It now follows `delivery_estimate.same_day_eligible`:
  - `true`: "Order before 2pm NZT for same-day dispatch (Auckland metro)". The scope comes from your own `promise` text.
  - `false`: "Ships next business day".
  - absent: no clause at all.
  - Your product prerender carries no same-day line, so crawlers and shoppers agree.
- **Cart shipping.** The line now reads "From $7.00 · free over $100", taken from `summary.shipping`, `is_shipping_estimate` and the cart's own `free_shipping_threshold`. A `0` that is not `qualifies_for_free_shipping` still says "Calculated at checkout". The gap comes only from `free_shipping_remaining`.
- **"BULK PRICE $X ea" → "3+ price $X ea".** The label uses the entry rung's own quantity, so a $100+ product says "2+ price".
- **`/api/site/value-props` is the only source** for programme facts. `ValueProps` in `utils.js` shows nothing for an inactive programme or a failed read, never a remembered number. If the read fails, the `free_shipping.headline` spans on checkout and payment hide their whole row rather than keep the literal "$100".
- **Placement (§4.2):**
  - A site-wide strip under the header on all 34 header pages: "Free shipping over $100 · Earn points on every order · Lower prices when you buy more · Full sets in value packs". Each fact links to its page. It is in flow and can be dismissed, and its height is reserved so filling it moves nothing.
  - PDP: "Earn N points ($X) on this order", updated for the quantity and ladder rung, in integer cents. Free shipping headline. "Questions? Call 027 474 0115 · NZ company since 2008" from `trust_signals`.
  - Pack card: "Buy the full set … Saves $S vs buying the N separately", using `cartridge_count` exactly as returned.
  - Cart: the guest `loyalty.message` word for word, plus a "Create a free account" link.
  - Checkout: an "Earn N points" line, and for guests a new-tab link to create an account.
  - Payment: `pricing_footer_note` beside Pay Now.
  - Order confirmation: for guests, "You earned N points on this order — create a free account with {email} to collect them. New accounts also get 200 welcome points."
- **§8.1 printer fit.**
  - PDP: a "Fits: A, B +N more" line with a "Check your printer" filter over the product's own `compatible_printers`.
  - The `compatibility_promise` label is shown, with its description and `how_to_check` one tap away.
  - Nothing says "guaranteed to fit"; a test bans that phrase and "zero risk".
  - Printer names use `PrinterName.display()`, calibrated against **your prerender h1s** (15 measured pairs pinned in the test).
- **Explainer pages** are live at `/rewards`, `/bulk-pricing` (the tier ladder, each band's own breaks, never a maximum) and `/value-packs` (`GET /api/products?pack=value_pack`). The markup holds no numbers; everything comes from the API.

## 4. Asks

- **BF-071 — prerender h1 parity for the paid landings.**
  - `/api/prerender/category/ink` has the h1 "Ink Cartridges NZ — Buy Online at InkCartridges.co.nz", and toner is the same pattern.
  - The SPA h1 is now "Ink Cartridges NZ — Genuine & Compatible" (your suggested wording).
  - Please align your two h1s to ours, or tell us which wording you want and we will match it.
- **BF-072 — `compatible_printers` on listing rows.**
  - Cards now render "Fits Brother MFC J5930DW, MFC J6935DW +12" from `compatible_printers`.
  - `/api/shop`, `/api/products` and `/api/products/popular` do not return that field today, so the line shows nothing.
  - The first two `full_name`s plus a count is enough. When the field appears, the line lights up with no FE change.
- **BF-073 — sitemap and sitelinks.**
  - `/rewards`, `/bulk-pricing` and `/value-packs` are ready.
  - `/review` is `noindex` and must stay out of the sitemap.
- **BF-074 — the two §6a contracts.** Both FE halves are built and **dark** (`Config.DARK_FEATURES`, both `false`).
  - `POST /api/cart/guest-contact {guest_session_id, email, consent:true}` → `{ok}`.
    - It fires on email blur or on ticking the box, once per email, and only when the shopper ticked the **unticked-by-default** box "Email me a copy of my cart if I don't finish".
    - The guest session is the `X-Guest-Session` id.
  - `GET /api/reviews/by-token/:token` → `{order_number, items:[{sku,name,image_url,reviewed}]}`.
  - `POST /api/reviews/by-token {token, sku, rating 1–5, title, body}` → `{ok}`.
    - The page is `/review?token=…`; the link in your email should point there.
  - Tell us when each is live and we flip its flag in the same commit that records your note.
- **BF-075 — printer name dictionary.**
  - Your `printerDisplayName` fixes LASERJET, OFFICEJET, DESKJET, PAGEWIDE, DESK, COLOR, PRO and ENTERPRISE. We mirror exactly that.
  - It leaves PHASER, DOCUPRINT, STYLUS, EXPRESSION, ALL-IN-ONE and PLUS in capitals. For example, `/api/prerender/printer/fuji-xerox/fuji-xerox-docuprint-cp225w` renders "Fuji Xerox DOCUPRINT CP 225W".
  - If you extend the list, send it and we will match. The two must stay identical.
- **BF-076 — the scoreboard.** After deploy, please send:
  - Ads guard R7 (mobile) and R13 (run-rate).
  - Wallet charges by type since 2026-09-20.
  - `rewards_nudge_*` events going to zero, which confirms the old popover is gone from live traffic.

Not an ask, for the record: `scripts/verify-mobile-cta-occlusion.js` exists only in your repo. Ours is
`npm run probe:mobile-cta`, and it is green.
