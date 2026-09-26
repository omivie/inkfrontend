# Conversion fixes + value-proposition spotlight — FE handoff, 2026-09-23

**Owner decision (2026-09-23):** mobile and tablet stay ON in Google Ads. We fix
the site instead of switching devices off. The exclusions that were in place
(tablet since 2026-09-07, mobile on the two generic ad groups since
2026-09-20) were lifted the same day (`scripts/ads/serve-all-devices.js`). So
from today, **every defect below is being paid for with live ad clicks.**

This document supersedes, for scheduling purposes,
`mobile-atc-dead-zone-FE-handoff-sep2026.md`,
`mobile-cta-occlusion-followup-sep2026.md` and the open items of
`page-load-latency-findings-sep2026.md`. Those remain the detailed evidence for
the items they cover.

Evidence: a live Playwright audit on 2026-09-23 (28 sequential page loads,
fresh browser context per scenario, i.e. a first-time visitor — which is what
an ad click is). Screenshots are in `conversion-fixes-sep2026/`.

---

## 0. Where the money is — and the answer to "should we go desktop-first?"

Last 90 days, first-party data (`traffic_events`, sessions that reached
`/order-confirmation`):

| | Desktop | Mobile |
|---|---|---|
| Share of orders | **72%** (97 of 135) | 27% (37) |
| Paid sessions → order | **8.02%** (39 / 486) | **1.35%** (11 / 815) |
| Organic / free-listing sessions → order | 2.5–3.6% | 2.3–3.8% |

Two conclusions, both true:

1. **Yes — desktop is where orders happen, so desktop gets fixed first.** B2B and
   repeat buyers order at a desk. But desktop is *not* clean today: on a
   1440x900 screen the rewards popover sits over the product title and the
   search box, and the consent banner covers the Add to Cart button before the
   page is scrolled (§1, D-P0-1 and D-P0-2). A desktop-first plan starts there.
2. **Mobile is not a different audience that fails to buy; it is the same
   audience failing on overlays.** Mobile *organic* converts about as well as
   desktop organic. Mobile *paid* — nearly all first-time visitors — converts at
   one sixth of desktop, and first-time visitors are exactly the people who see
   the popover and the consent banner. The fixes are the same three overlay
   components on both devices, so the desktop work fixes most of mobile for free.

Google Ads now prices every click by predicted value (target ROAS), so while
mobile converts badly it simply wins fewer, cheaper auctions. Each fix below
turns directly into more mobile auctions won at the same target.

---

## 1. P0 — blockers on the paid landing pages (do these first, in this order)

### D-P0-1 · Remove the rewards popover; replace it with inline copy (both devices)

- **Element:** `ASIDE#rewards-nudge.rewards-nudge(.rewards-nudge--card).is-open`,
  `position: fixed`, `z-index: 600`. Mobile box (12, 144, 366x248); desktop box
  (770, 96, 360x248).
- **Where it fires:** every non-PDP page after 600 px of scroll, and it never
  closes by itself. The Sept fix (`narrowSkipPaths`) only covered PDPs; the
  paid landing pages `/ink-cartridges` (290 of 352 generic ad clicks),
  `/toner-cartridges` and `/shop?…&code=…` still get it.
- **Measured damage:**
  - Mobile: with the header (180 px) and consent banner (148 px), **80–90% of the
    screen is covered**. Add buttons were tappable at **2 of 8** scroll
    positions on `/ink-cartridges` and **2 of 15** on `/shop?brand=hp&code=65`.
    Screenshots: `m-ink-nudge-y600.jpg`, `m-shop-hp65-nudge-y600.jpg`.
  - Desktop: it covers the product title on PDPs and the header search box —
    a click on `#search-input` fails with "rewards-nudge intercepts pointer
    events". Screenshots: `d-home-nudge-y600.jpg`, `d-pdp-GTN258BK-blocked-y0.jpg`.
  - It does not work as marketing either: **76 shows, 25 dismissals, 1 click**
    in 30 days (`rewards_nudge_*` events).
- **Fix:** delete the overlay mode on every device. Put the message inline
  (see §4.1 for exact copy and data). If you keep any popover at all, it must
  never be `position: fixed` over content, must close on any scroll or focus
  into `.search-form`, and must never open on a page reached from an ad
  (`gclid`/`gbraid`/`wbraid` in the landing URL).
- **Acceptance:** on `/ink-cartridges`, `/toner-cartridges`, `/shop?brand=hp&category=ink&code=65`,
  a fresh iPhone 13 context scrolled in 150 px steps has a tappable Add button at
  every offset where one is visible; on a fresh 1440x900 context the search box
  accepts a click at every scroll offset.

### D-P0-2 · Consent banner: compact on mobile, never over a CTA on any device

- **Element:** `SECTION#consent-banner.consent-banner.is-open`, fixed, z 600.
  Mobile box y 516–664 (148 px = 22% of the screen). Desktop box y 839–900.
- **Measured damage:**
  - Mobile PDP dead zone still live: `node scripts/verify-mobile-cta-occlusion.js --check`
    exits 1 today (3 dead scroll offsets per PDP tested: the sticky bar is under
    the banner while the main button is under the banner or the header).
  - **New, desktop:** at scroll 0 on a 1440x900 PDP, `#add-to-cart-btn`
    (y 830–878) is under the banner (y 839–900): 0 of 3 hit-test points
    reachable on GTN258BK and GLC3329XLBK. The desktop cart's `A#checkout-btn`
    (y 827–846) sits under it too. Real laptop viewports are shorter than 900 px,
    so this is the common case, not an edge case. Screenshots:
    `d-pdp-GTN258BK-blocked-y0.jpg`, `d-cart-first.jpg`.
- **Fix (all four):**
  1. Mobile banner copy on one line with inline Decline/Accept — target 56–64 px
     high instead of 148 px.
  2. While the banner is open, `body { padding-bottom: var(--consent-banner-h) }`
     so no in-flow CTA can ever sit underneath it (fixes the desktop case).
  3. `body:has(.consent-banner.is-open) :is(.sticky-atc, .filter-sort-bar, .cart-sticky-bar) { bottom: calc(var(--consent-banner-h) + 8px) }`.
  4. Give the sticky-ATC IntersectionObserver a `rootMargin` of
     `-<header height>px 0 -<banner height>px 0` and re-create it when the
     banner opens or closes, so the sticky bar never retires onto a main button
     that is hidden under the header or the banner.
  - **Do not** raise the sticky bar above z 600 — it would cover the banner's
    own legal text and buttons.
- **Acceptance:** `node scripts/verify-mobile-cta-occlusion.js --check` exits 0,
  and on a fresh 1440x900 context the PDP Add to Cart and the cart Checkout
  button are hit-testable at scroll 0.

### D-P0-3 · Add-to-cart must lead to checkout, not to a full-screen upsell (mobile)

- **Element:** `DIV#crosssell-modal.crosssell-modal`, fixed, **z-index 10000**,
  full screen (0, 0, 390x664), opened right after `POST /api/cart/items → 201`.
  It offers "Customers also bought" with only × and a product Add — **no way on
  to the cart or checkout**. Screenshot: `m-pdp-CLC73BK-after-add.jpg`.
- **Fix:** replace it with a bottom sheet no taller than 50% of the viewport:
  primary button **Checkout**, secondary **Keep shopping**, the upsell below
  them. The PDP already shows the same pack upsell (`#pack-upsell`) under the
  Add button, so on mobile the modal can simply be dropped.
- **Acceptance:** after Add on a mobile PDP, a Checkout control is visible and
  tappable without dismissing anything.

### D-P0-4 · Mobile landing pages: put a product and its Add button on the first screen

- **Evidence:** the first Add button on `/ink-cartridges` and `/toner-cartridges`
  is at page y **881** on a 664 px screen (y 861 on `/shop`). The sticky header
  is 180 px (three rows, one of them just the phone number). Product cards are
  523–544 px tall at 390 px wide. Screenshot: `m-ink-first.jpg`.
- **Fix:** fold the phone row into a `tel:` icon, hide the header on scroll-down
  (show on scroll-up), and use a compact mobile card (image ≈ 120 px, title
  clamped to 2 lines, price + Add on one row). Target: first row of Add buttons
  at y ≤ 520 on a 664 px viewport.
- Also: `/toner-cartridges` carries the h1 "Shop Ink Cartridges & Toner NZ",
  identical to the ink page. The "Toner NZ" ad group lands there. Use a per-page
  h1 ("Toner Cartridges NZ — Genuine & Compatible") and show at least 8 products
  with real images above the brand chooser (today 4, all placeholder tiles on
  desktop: `d-toner-first.jpg`).

---

## 2. P1 — speed and layout shift (both devices)

These cost conversion on every page and are also Core Web Vitals inputs for
organic ranking.

| Item | Evidence (2026-09-23) | Fix |
|---|---|---|
| **Static assets are never cached** | every same-origin asset is served `cache-control: public, max-age=0, must-revalidate` — 33–35 per page, 98 on a PDP once rails load; each navigation revalidates all of them | `vercel.json` headers: `Cache-Control: public, max-age=31536000, immutable` for every `?v=<hash>` asset (they are already content-hashed) |
| **Every catalogue GET preflights** | `js/api.js` still sets `Content-Type: application/json` on GETs (line 242), which is not CORS-safelisted, so each call costs an extra OPTIONS round trip to a Mumbai-hosted origin | send `Content-Type` only on requests that have a body |
| **PDP content arrives late — and paid visitors who land on a PDP never buy** | h1 empty until 2.5–3.5 s (desktop) / 3.3–4.9 s (mobile); LCP 3.4–5.1 s. **Update 2026-09-25:** over 120 days, paid sessions that LANDED on a product page converted **0 of 91**, against 7.1% for `/ink-cartridges` and `/shop` landings. This is the single worst-converting entry point on the site, and it is where dynamic search ads send people | `<link rel="preload" as="fetch" crossorigin href="/api/products/{SKU}">` in the document head, or embed the product JSON at the edge. Treat this as P0 for any PDP reached from an ad (`gclid` in the URL) |
| **CLS 0.22–0.38** | `/ink-cartridges` 0.326 (popular row grows 220→620 px); PDP 0.22 (footer paints first, price block moves); mobile checkout 0.381 (form mounts late); the Google reviews badge adds ~0.07 everywhere | reserve heights (`.drilldown-content { min-height: 620px }`, pricing skeleton `min-height: 208px`), `main { min-height: 100vh }`, static checkout skeleton, fixed box for `#google-reviews-badge` |
| **Search results page makes three calls** | `/search/smart` + `/search/suggest` + `/products?search=` for one search | keep `/search/smart` only |
| **Mobile filter bar floats over the open suggestion list** | `DIV#filter-sort-bar` z 200 over `.smart-ac-dropdown` | hide the bar while the dropdown is open; cap the skeleton at 3 rows |
| **Main product image competes with everything else** (added 2026-09-25) | the PDP hero image has no fetch priority, and catalogue/related-product images below the fold load eagerly with it | `fetchpriority="high"` on the main PDP image only; `loading="lazy"` on every listing and related-product image below the fold; defer analytics and third-party scripts that are not needed for first paint |
| **Apple Pay / Google Pay have never shown** (added 2026-09-25) | 0 wallet charges in 173 live charges since March, although the Express Checkout Element has been live since July. Known causes on the storefront side: the CSP does not allow `link.com` (24% of our payments use Link) or `hooks.stripe.com` (3-D Secure), and Apple Pay renders only in Safari | add both hosts to the CSP; test Apple Pay in Safari on an iPhone, Google Pay in Chrome on Android; once they render, show the wallet buttons on the PDP and cart, not only at checkout. The backend confirms the domain registration via Stripe's `/v1/payment_method_domains` (not the legacy Apple Pay domain endpoint) |

Targets for this section: LCP under 2.5 s, INP under 200 ms, CLS under 0.1 — Google's "good" thresholds. INP replaced FID as a Core Web Vital in March 2024; do not report FID.

---

## 3. P2 — truthfulness (compliance: inv 9 / inv 13)

- **Contradictory support hours.** Checkout says "Human support 8am–8pm, 7 days";
  the footer says "Mon–Fri 9am–5pm". Neither comes from `/api/site/trust`.
  Remove the checkout line (or ask the backend to add hours to trust signals).
  An unsubstantiated "7 days" is exactly the claim class that got the Ads
  account suspended in May.
- **Dispatch promise after the cutoff.** At 20:55 NZT the PDP still said "Order
  before 2pm NZT for same-day dispatch" while the API said
  `delivery_estimate.same_day_eligible: false`. Render the line from
  `delivery_estimate` (e.g. "Order now — dispatched next business day").
- **Shipping first appears at checkout, and the numbers disagree.** Cart:
  "Shipping: Calculated at checkout". Checkout: "$7.00". Free-shipping gap:
  $22.01 in the cart, $22.02 at checkout. The cart response already carries
  `summary.shipping`, `summary.is_shipping_estimate` and
  `summary.free_shipping_remaining`. Show "Shipping from $7.00 · free over $100"
  in the cart and render the gap from `free_shipping_remaining` — never
  recompute money in floats.
- **"BULK PRICE $45.58 ea" at quantity 1** on desktop category cards is the 3+
  price. Label it "3+ price" or "from 3".

---

## 4. Spotlight the value propositions — what to show, where, from which field

The owner wants reward points, quantity pricing and value-pack savings in front
of every shopper. The data is already on every response; the gaps are
**placement**. Rules for all copy:

- Render facts from the API, never hard-code them. A hard-coded "$49" and "5%"
  had to be pulled from our own emails today.
- No "Save up to N%", "lowest", "best", "cheapest" — anywhere. The quantity
  ladder is floor-clamped per product, so a headline maximum is a promise some
  products cannot keep.
- Inline only. Nothing fixed-position over content.

### 4.1 One source for the programme facts: `GET /api/site/value-props` (new today)

Public, edge-cached like `/api/site/trust`. Response (`data`):

```json
{
  "loyalty": {
    "active": true, "points_per_dollar": 1, "points_per_dollar_off": 100,
    "earn_basis": "goods_excluding_shipping", "welcome_bonus_points": 200,
    "guest_orders_claimable": true,
    "headline": "Earn 1 point for every $1 you spend",
    "detail": "100 points = $1 off a future order. Points are earned on goods, not shipping. New accounts get 200 welcome points. Checked out as a guest? Create a free account with the same email to collect them."
  },
  "volume_pricing": {
    "active": true, "starts_at_quantity": 2, "max_discount_percent": 10,
    "applies_to": "every_shopper",
    "headline": "Buy more, pay less per cartridge",
    "detail": "Order 2 or more of the same cartridge and the unit price drops automatically — no code, no account. Each product shows its own price at every quantity.",
    "tiers": [{ "min_price": 0, "max_price": 20, "min_quantity": 3, "discount_percent": 4 }, "…"]
  },
  "value_packs": {
    "active": true, "pack_discount_percent": { "compatible": 6, "genuine": 2.5 },
    "headline": "Full sets in one value pack",
    "detail": "A value pack holds every colour your printer needs in one box. Where a pack costs less than its cartridges bought separately, the pack shows the saving."
  },
  "free_shipping": {
    "active": true, "threshold": 100,
    "headline": "Free shipping on orders over $100",
    "detail": "NZ-wide. Your cart shows how much more you need to add."
  }
}
```

Every `headline`/`detail` string is scanned by the backend's compliance list in
the test suite. Use them verbatim, or build your own copy from the numeric
fields. Do not print `max_discount_percent` as a promise, and do not say packs
are *always* cheaper than their cartridges — the $101.99 free-shipping bump and
the cost floor mean some are not; show a saving only from
`pack_savings_vs_singles` / `pack_suggestion`, which exist only when it is real.

### 4.2 Placement spec

| Surface | Show | Data |
|---|---|---|
| **Site-wide strip** (under the header, one line, dismissible, in flow) | "Free shipping over $100 · Earn points on every order · Lower prices when you buy more" — links to the relevant explainer | `/api/site/value-props` headlines |
| **Category / shop / search cards** | keep the existing "Buy 3+ · down to $X at 8+" line — it renders correctly today; relabel "BULK PRICE $X ea" as "3+ price" | `quantity_breaks[]` on each product |
| **PDP buy box, above the Add button** (mobile: must be on the first screen with the Add button) | (1) price; (2) **"Earn N points ($X) on this order"** where N = `floor(price × points_per_dollar)`; (3) the quantity-break chips (today they sit 250–730 px below the fold on mobile); (4) **"Free shipping over $100"** — the PDP never states it today | `retail_price`, `quantity_breaks[]`, `/api/site/value-props.loyalty` |
| **PDP, directly under the Add button** | the pack offer: "Complete the set: {pack name} — $P, save $S vs buying separately" | `pack_suggestion` (see §5 — its numbers are now correct) |
| **PDP of a pack** | "Save $S vs buying the N cartridges separately" | `pack_savings_vs_singles` |
| **Cart line** | keep "Add 2 more to reach 3+ — $X each" and "switch to the value pack" — both render correctly today | `volume_next_break`, `pack_suggestion_for_line` |
| **Cart summary** | **Guests:** the new `loyalty.message` ("Earn 71 points ($0.71) on this order — create a free account with the same email to collect them, plus 200 welcome points."). **Members:** existing balance/earn block. Plus the free-shipping unlock tiles (now drawn from the cart's own models — §5) | `loyalty` (now populated for guests), `free_shipping_unlock` |
| **Checkout** | one line under the total: points this order earns; for guests a "Create an account with this email to collect them" link that does not block checkout | cart `loyalty` |
| **Order confirmation page** | for guests: "You earned N points — create an account with {email} to collect them" (the backend now credits past guest orders on first sign-in) | order total, value-props |

### 4.3 Explainer pages (content, not overlays)

Worth a small static page each, linked from the strip and from the Ads
account later as sitelinks: `/rewards` (how points work, from
`value-props.loyalty`), `/bulk-pricing` (the `tiers` ladder rendered as a table,
with the note that each product shows its own prices), `/value-packs` (a listing
filtered to `pack_type=value_pack`). Tell the backend when they are live so
they can be added to the sitemap and the ads.

---

## 5. Backend changes shipped 2026-09-23 that the FE can rely on

| Change | Contract |
|---|---|
| `GET /api/site/value-props` | new — §4.1 |
| Cart `loyalty` for **guests** | was `null`; now `{guest: true, earn_on_this_order, earn_value_dollars, welcome_bonus_points, redemption_rate, message}` when the loyalty programme is active and the cart earns ≥ 1 point. Members' shape unchanged. |
| `pack_suggestion` / `pack_suggestion_for_line` **numbers corrected** | `individual_total` is now the sum of the pack's real cartridge prices (it was the single's price × 4 — e.g. it claimed a $101 saving on an HP 955XL pack whose real saving is $9.97). New field `cartridge_count`. Genuine singles now get suggestions at all (the lookup could not match compact-grammar names; 27 of 60 sampled singles now get an offer vs 18 before, all with correct savings). |
| `free_shipping_unlock.suggested_products` **relevance** | drawn first from the other colours of models already in the cart (exact SKUs, same brand and type), then from the same brand + product type; never unrelated products (an ink cart was being offered label tapes). May now be `[]` where it used to return something irrelevant — render nothing in that case. |
| Signup rewards | the welcome bonus and the claim of past guest orders now actually run on first sign-in (`POST /api/account/sync`). The response may carry `retro: {orders_claimed, points_awarded, claim_id}` on the existing-profile path too — show it once ("We've added N points from your past orders"). |
| Emails | the website announcement and the refill reminder now carry a "Why order from us" block rendered from the same facts as `/api/site/value-props`; the refill reminder's false "free shipping over $49" and the business-approval email's "5% discount / free shipping over $50" are corrected. |
| Printer pages for crawlers | display-cased names ("HP LaserJet Enterprise M506", not "HP LASERJET ENTERPRISE M506") and "Ink"/"Toner" in the title. If the SPA renders printer names from `full_name`, apply the same casing (see `printerDisplayName` in `src/utils/seoHelpers.js`) so users and Google see the same name. |

---

## 6. SEO items that only the FE can fix

1. **`middleware.js` turns backend 301s into 200s.** The backend 301s a legacy
   SKU URL (e.g. `/products/…/G-BRO-LC531BK-INK-BK` → `/products/…/GLC531BK`)
   and the deactivated-product/printer redirects, but the middleware follows the
   redirect and serves the target body as a 200 at the old URL. Google keeps the
   duplicate (1,744 PDP URLs with impressions are not in the sitemap; 752 of them
   legacy-grammar). Fix: `fetch(prerenderUrl, { redirect: 'manual' })`; on a 3xx,
   return a 301 with the upstream `Location`.
2. **Prerender bare `/shop`.** As Googlebot, `www/shop` returns the SPA shell,
   so Google indexed `api.inkcartridges.co.nz/api/prerender/shop` instead.
   Map bare `/shop` (no brand, printer or search) to `/api/prerender/shop`.
3. **Never forward an upstream `X-Robots-Tag`.** Today the middleware rebuilds
   headers and drops ours, which is what keeps www indexable. Make that explicit
   (`headers.delete('x-robots-tag')`) so a future "copy upstream headers"
   refactor cannot deindex the site.
4. **Per-category h1** on `/toner-cartridges` (see D-P0-4).

---

## 6a. Joint items — the backend builds its half as soon as the FE is ready

These are the two largest retention levers the 2026-09-23 audit found. Both
need a storefront surface, so they are listed here rather than shipped
half-built.

1. **Checkout-abandonment email for guests.** 132 checkouts were abandoned in 30
   days, all by guests, and cart recovery can only email members (97% of carts
   are guest carts). FE: an **unticked** checkbox beside the checkout email field
   — "Email me a copy of my cart if I don't finish" — and a call on blur to a new
   `POST /api/cart/guest-contact {guest_session_id, email, consent:true}`.
   Backend: store it, extend the recovery sweep to guest carts that consented,
   reuse the existing unsubscribe token + suppression list. NZ UEMA needs the
   consent, which is why the box must not be pre-ticked.
2. **Reviews from guests.** There are 4 reviews in total; `reviews.user_id` is
   NOT NULL and 88% of orders are guest checkouts, so most customers cannot leave
   one — and without reviews there are no stars in Search or Shopping. Backend:
   nullable `user_id` + `order_id`, a signed per-order review link (the same
   token scheme as quick-rating), and the review request triggered from
   `shipped_at` (it waits for `completed`, which no order has ever reached). FE: a
   review form page that accepts that token.

## 7. How to verify each item

- `node scripts/verify-mobile-cta-occlusion.js --check` (backend repo) — must exit
  0 (covers D-P0-2 on mobile; desktop is the control and must keep passing).
- Fresh-context manual check, iPhone 13 profile (usable viewport 390x664 — not a
  resized desktop window) and 1440x900: land on `/ink-cartridges?gclid=test`,
  scroll to the bottom in steps, add a product, reach checkout. No overlay may
  cover a CTA at any point; Checkout must be reachable right after Add.
- `curl -s https://api.inkcartridges.co.nz/api/site/value-props | jq .data` —
  the facts you render.
- After the middleware change: `curl -sI -A "Googlebot" "https://www.inkcartridges.co.nz/products/<any-slug>/G-BRO-LC531BK-INK-BK"`
  must return `301` with a `location` ending in `/GLC531BK` (the backend's
  `/api/prerender/product/G-BRO-LC531BK-INK-BK` already answers 301).

Tell the backend when D-P0-1 to D-P0-3 ship: the Ads guard's mobile line (R7)
and the run-rate line (R13) are the scoreboard, and the conversion change is
measurable within a week of real traffic.

---

## 8. Owner goal 2026-09-27 — shoppers aged 30–40+, printer fit, value packs, checkout

The owner's core customers are in their 30s, 40s and older, buying a
replacement for a printer they already own. Every item below is ordered by how
directly it removes a reason not to buy. Evidence from the backend, 2026-09-27:

- Real shoppers stopped at the **add-to-cart** step, not at payment: Stripe shows
  zero failed payments in two weeks, while from 09-23 to 09-26 only three real
  sessions put anything in a cart.
- **51% of orders are a single unit.** The typical buyer wants one cartridge
  that fits one printer, and wants to be sure before paying.
- The rewards popover (D-P0-1) appeared on **35 of 58 paid sessions** between
  09-24 and 09-26. It is still live and is still the first item to remove.

### 8.1 Printer fit — make it obvious BEFORE the Add button (highest priority)

A shopper who is unsure the cartridge fits does not add it. Everything needed
is already in the product response (`GET /api/products/:sku`):

| Show | Field | Where |
|---|---|---|
| "Fits these printers" list, grouped by brand, first 6 visible + "show all" | `compatible_printers_grouped` (and flat `compatible_printers`) | PDP, directly under the price, above the fold on mobile |
| A "Check your printer" box that filters that list as they type | same list, client-side | PDP, next to the list |
| Reassurance line beside the Add button | `trust_signals.compatibility_promise.label` + `.description` (new today) | PDP and cart |
| "How do I know it fits?" helper | `trust_signals.compatibility_promise.how_to_check` | PDP, small link text |
| First two fitting models on each product card: "Fits Brother MFC-J5910DW, J432W +12" | `compatible_printers` | listing cards |
| "Enter your printer model" search as the first thing on `/ink-cartridges` and `/toner-cartridges` | existing printer search | the paid landing pages |

`compatibility_promise` restates existing policy only (unopened returns in 30
days; the 30-day satisfaction guarantee on compatibles). **Do not write
"guaranteed to fit" or "zero risk" anywhere** — it is a banned claim (inv 13)
and the compatibility data has known errors.

### 8.2 Clarity for every age — layout and text

- Body text at least 16px; price at least 20px; buttons at least 48px tall,
  full width on mobile, with a text label (never an icon alone).
- One primary action per screen. On the PDP the only filled button is Add to
  Cart; secondary actions are text links.
- No overlay, popover or modal between landing and the first add-to-cart —
  rewards, newsletter and consent included (consent compact, bottom, never over
  a button). Rewards can be shown **inline** or **after** the first add.
- Keep the phone number one tap away (the `tel:` icon from D-P0-4) and print it
  in full, with "NZ company since 2008", on the PDP and at checkout
  (`trust_signals.contact.phone_display`,
  `trust_signals.organization.founded_year`). Older buyers call before they buy.
- Plain words for errors, next to the field ("Please enter your street
  address"), never a toast that disappears.
- Contrast at least 4.5:1 on all text (WCAG AA); the grey helper text on white
  currently fails in places.

### 8.3 Checkout and payment

- Guest checkout first; account creation optional and after payment.
- Show the step bar (Cart → Details → Payment → Confirm) with the current step
  labelled, as today, and keep the order summary visible on every step.
- Address autocomplete is already wired (NZ Post); make sure it works on mobile
  keyboards and falls back to plain fields when it fails.
- **Apple Pay / Google Pay:** the domain `www.inkcartridges.co.nz` is registered
  with Stripe and both wallets are **active** (checked 2026-09-27 via
  `/v1/payment_method_domains`). They still never render because the storefront
  CSP blocks `link.com` and `hooks.stripe.com` (§2). Fix the CSP, then show the
  wallet buttons at the top of checkout AND on the cart, above the card form.
- Show accepted cards and "No card surcharges" near the Pay button
  (`trust_signals.organization.pricing_footer_note`).

### 8.4 Value packs — promote the full set

- **PDP of a single:** show the pack offer card right under Add to Cart when
  `pack_suggestion` is present — "Buy the full set: $X, saves $Y against buying
  them separately" using `pack_suggestion.savings_amount` and `.individual_total`
  exactly as returned. Show nothing when it is null (the pack is not cheaper).
- **Cart line:** the same card from `items[].pack_suggestion_for_line`, with a
  one-tap "Switch to the set" button.
- **Listing and landing pages:** a "Full colour sets" rail. `GET /api/shop` with
  `pack=value_pack` returns packs only (and, fixed today, so does
  `GET /api/products?pack=value_pack`, which used to return singles too).
- A "Full-set value pack" badge on pack cards so they read as the better buy,
  not as a more expensive single.
- A new Google Shopping campaign now advertises packs only, so pack PDPs will
  receive paid traffic: they must load fast and show "fits these printers" too.

### 8.5 Ads and landing pages changed today (so the FE knows what traffic arrives)

- Ads that sent visitors to single product pages (DSA) are **paused**; paid
  Search traffic now lands on `/ink-cartridges`, `/toner-cartridges` and the
  `/shop?brand=&code=` family pages. Those pages are the priority for 8.1–8.2.
- New Search ads promise: printer-model matching, value packs, NZ company since
  2008, no card surcharges, free shipping over $100, tracked courier, 30-day
  returns on unopened items. The landing pages must visibly back each one up.
