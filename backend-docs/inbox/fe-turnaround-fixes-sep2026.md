# Storefront fixes from the 28 Sep 2026 turnaround review

**From:** backend · **For:** FE developer · **Date:** 2026-09-28

These come from a scripted first-time-visitor walk of the live site (desktop 1440×900 and an iPhone 13-sized screen, cleared storage, no order placed), a light SEO check, and order/search data. The backend half of each item has shipped. It is listed so you know what the API now returns. Items are in priority order within each group.

Evidence screenshots from the walk (take them from the backend repo owner if you need them): `03-desktop-find-hl-l2350dw-results.png`, `04-desktop-pdp-tn2345.png`, `05-desktop-after-add-to-cart.png`, `07-desktop-checkout-first-screen.png`, `10-mobile-search-results-canon540.png`, `12-mobile-pdp-first-view.png`, `16-desktop-business.png`, `18-mobile-checkout-first-view.png`.

---

## Status after the 28 Sep re-check (live site, headless desktop + iPhone 13)

**Done — thank you:** #1 `/review` page live · #2 desktop Add to Cart visible and not under the banner · #3 popular / colour-set rows gone · #4 printer URL canonical is the printer URL · #5 `/cart?add=` adds the SKU and cleans the URL (backend flag `GUEST_CART_ADD_LINKS=true` still has to be set on Render) · #16 `/bulk-pricing` states the 3+ rule.

**Still open:** #9 "Fits Brother Brother …" and "Model: IBTN2345" on the PDP · #10 `/business` has no Apply button · P2 cart "Total" excludes shipping · P2 mobile fixed bars still 252 of 664 px · P2 smallest card text 9.92 px · Vercel apex redirect still 307 (make it 308).

**New P0 — Search Console "Soft 404" (7,750 URLs).** Of 930 sampled URLs: 250 `/html/…` (already 308, will clear), 465 `/shop?search=…` / `/shop?q=…` result pages, 121 old-site slugs, 59 `/products/…`. To Googlebot, `/shop?search=black` returns the SPA shell with `<meta name="robots" content="index, follow">` and the generic shop title, which Google reads as an empty page.
- **Fix 1:** any `/shop` URL carrying `search` or `q` must emit `<meta name="robots" content="noindex, follow">` (shell and SPA). Internal search results should not be indexed; this moves them out of Soft 404.
- **Fix 2:** the old-site slug redirect rule keeps only the slug's tail, e.g. `/fuji-xerox-ct201304-toner-cartridge-cyan` → `/shop?search=cyan` and `/brother-lc73-inkjet-cartridge-black-lc73bk` → `/shop?search=black-lc73bk`. Keep the part number instead (`ct201304`, `lc73bk`), or ask us for a resolver endpoint that returns the product URL for a legacy slug.
Validation was started in Search Console on 28 Sep; once Fix 1 ships we restart it.

## P0 — costs orders every day

### 1. `/review` page is still inactive

Review-request emails have gone out since 17 Sep and link to `/review?token=…`. On 28 Sep the page still said "isn't active yet". We have 4 reviews in total, against 528–6,741 at the competitors. Backend: `GET|POST /api/reviews/by-token` (contract in `docs/storefront/fe-replies-round-backend-response-sep2026.md`).

**Done when:** a token from a real review email loads the product, takes a 1–5 rating and text, and posts.

### 2. Add to Cart hides under the cookie banner on the desktop product page

On `/products/…/CTN2345BK` at 1440×900 the button sits at y 878–926. The consent banner covers y 839–900. `document.elementFromPoint` at the button returns `consent-banner`, so a first-time visitor sees no buy button without scrolling.

**Fix:** move the price + quantity + Add block above the "Buy more, save more" ladder, or pad the page bottom by the banner's height while it is shown.
**Done when:** on a cleared-storage visit at 1440×900 and 1366×768, `elementFromPoint` at the centre of Add to Cart returns the button.

### 3. Ship the removal of the "Popular right now" and "Full colour sets" rows

The owner asked for this on 28 Sep (`docs/storefront/remove-popular-and-colour-set-rows-FE-sep2026.md`). On 28 Sep `/ink-cartridges` still showed "Popular ink cartridges right now", and the `/shop` DOM still had both headings. Keep the PDP pack suggestion, the cart "Switch to the set" and `/value-packs`.

### 4. Printer URLs: stop the SPA shell pointing Google at `/shop`

About 68% of printer URLs are flagged "Soft 404" in Search Console. For a normal browser, `/shop?brand=brother&printer_slug=brother-hl-l2375dw` returns the generic shell. It has title "Shop Ink Cartridges & Toner NZ" and `<link rel="canonical" href="https://www.inkcartridges.co.nz/shop">`. The bot prerender is right: it is self-canonical and carries prices. Its first response took 3.6 s, though, and any miss or timeout shows Google thousands of identical pages canonicalised to `/shop`.

**Fix:**
- When `printer_slug` is present, the shell must not emit a `/shop` canonical. Emit none, or the printer URL.
- In `middleware.js`, when the prerender fetch for a bot times out or errors, answer **503 with `Retry-After`**, never the shell.

**Done when:** `curl` of a printer URL with a normal UA shows no `/shop` canonical, and a forced prerender timeout returns 503 to a Googlebot UA.

### 5. One-click reorder for guests: `/cart?add=`

On 15 Sep, 113 reorder emails produced **0 orders**. Guests, who are most of our customers, got a button to `/shop` and had to find their cartridge again. Members already have a signed `/api/reorder/load/:orderId`. Guests need a storefront URL that fills their cart.

**Contract:**
```
GET /cart?add=SKU:QTY,SKU:QTY[&utm_source=…&utm_medium=…&utm_campaign=…]
```
- Up to 12 lines, qty 1–20.
- SKU pattern `^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$`. Ribbon SKUs contain dots, e.g. `81051.02`.
- For each line, `POST /api/cart/items` with the guest session (create one if absent). Skip unknown or inactive SKUs silently. Then drop the `add` param from the URL (keep the `utm_*`) and show `/cart`.
- If every SKU was unknown, show the cart with a one-line note and a search box.

The backend emits these links only when env `GUEST_CART_ADD_LINKS=true`. **Tell us when this is live and we will switch it on.** Until then guest emails link to the product page of the item they bought (shipped).

---

## P1 — finding the right cartridge

### 6. Search: new fields to render

`/api/search/smart` changed (shipped):
- **Printer match first.** "canon 540" now finds the Canon PIXMA MP 540 printer and leads with its cartridges. `data.matched_printer` is set as before.
- **Model codes inside multi-word queries.** "canon pg640" returns all five PG640 products (it returned 2). A ribbon or label tape no longer outranks a code match.
- **Regional alias, as a suggestion only.** When the query's code is one we don't stock under that name, and no printer matched, the response carries:
  ```json
  "alias_suggestion": {
    "from": "PG-540",
    "to": ["PG-640"],
    "note": "PG-540 is the UK/EU code. NZ printers use PG-640. Check the code on your old cartridge before you order.",
    "search_query": "canon pg640"
  },
  "alias_results": [ /* up to 24 products, same shape as products[], each with via_alias: true, match_reason: "regional_alias", matched_token: "PG-640" */ ]
  ```
  `alias_results` are **never** in `products`, `total` or pagination.

**Render:** show the `note` as a banner above `alias_results`, with a "Search PG-640" link built from `search_query`. Canon ink is region-locked, so never present alias rows as a match for the shopper's printer.

### 7. Printer finder: say plainly when we can't match a printer

The finder on `/ink-cartridges` says "No printer found" for HL-L2350DW (an Australian/US model Brother NZ never sold). Its Find button then opens `/shop?q=Brother+HL-L2350DW`, which lists TN2345/DR2315 as if they fit. They don't, and nothing warns the buyer. The homepage promises "No guessing, no wrong orders".

**Fix:** when `/api/printers/search` returns `[]`, show "We couldn't match that printer. Check the code printed on your old cartridge, or send us a photo." Link to `/quote`, give the phone number, and offer a cartridge-code search. If you still show text results, put a banner above them: "These match your words, not your printer. Check the code on your old cartridge."

### 8. Add-to-cart pop-up ("Customers also bought")

It shows a 686 px black "COMPATIBLE" placeholder and pushes the name and price out of view. **Cap the image at ~120 px.**

Backend (shipped): `/api/products/:sku/bought-together` now returns only co-purchases that share a printer with the product. It returned TN2445 for a TN2345 buyer before. It may now return `[]` more often, so hide the block when empty.

### 9. Product page details

- **"Model: IBTN2345"** is the supplier's part number, and a buyer reads "model" as their printer. For compatible products hide it, or label it "Supplier code".
- **"Fits Brother Brother HL L2300D"**: `compatible_printers[]` names already start with the brand. Don't prefix it again.
- **Printer names:** the backend now shows Brother models with the OEM hyphen ("HL-L2375DW", which is how people search). Mirror the rule in the storefront copy of `printerDisplayName`. It applies to HL/MFC/DCP/FAX/PT/QL/ADS followed by a letter and a model code. Leave already-hyphenated names alone.
- **Printer page H1** (prerender) is now "Brother HL-L2375DW Toner NZ", using ink / toner / ink & toner from what the page lists. Match it in the SPA for parity.

---

## P1 — business buyers

Customers on company email domains are 29% of customers and **54% of revenue**, with an average order of $235 against $109. Only 2 business accounts exist, and `/business` is a locked door.

### 10. Make `/business` an open page with a way in

Today it says "This area is for approved business accounts" and offers only "Request a business quote" and "Sign in".

**Build:**
- Terms: monthly invoice / Net 30 for approved accounts, GST tax invoices, PO number on orders.
- The volume ladder, from `GET /api/site/value-props`: `volume_pricing`.
- A link to `/quote`.
- A named contact with a phone number.
- An **Apply** button: sign in or sign up, then the application form, which posts to `POST /api/business/apply` (existing, login required). Required fields: `company_name`, `contact_name`, `contact_email`. Optional: `nzbn` (13 digits), `contact_phone`, `estimated_monthly_spend`, `industry`, `business_type`, `ap_email`, `billing_address`, `shipping_address`. Trade references go through `POST /api/business/credit-reference`.

Don't claim "lowest price" or "best in NZ" (Google Ads compliance). Suggested line: "Every printer in your office on one account. The right cartridge for each machine on file, invoiced monthly, and dispatched the same day when you order by 2pm on a weekday."

### 11. Offer the account on the order confirmation

`GET /api/orders/:orderNumber` now returns `business_account_offer: boolean` (shipped). It is `true` when the buyer's email is on a company domain and a signed-in buyer has no business account. When `true`, show one card on the confirmation page: "Buying for a business? Open an account: monthly invoice, saved printers, one place to reorder." Link it to `/business`.

### 12. Ex-GST prices for business accounts

For a signed-in user with an active business account, show ex-GST beside incl-GST on product and cart lines (`price / 1.15`, rounded to cents). Competitors (Printzone) do this.

### 13. Link the quote form everywhere a bulk buyer looks

`/quote` is our best business surface (photo, pasted list, NZBN, PO, ordering frequency, reply within one business day). Link it from `/bulk-pricing`, `/business` and the PDP quantity ladder ("Buying for several printers? Get a quote").

---

## P1 — returning customers

### 14. "Save your printer" on the order confirmation

A guest has already given us their email and address, so only a password is missing. Offer a one-field account creation on the confirmation page. The backend already attaches the guest's past orders and points on sign-up with the same email (`POST /account/sync`). Say so: "Create a password to save your printer and keep your points."

### 15. Sign-in page copy

It promises only "track orders, and checkout faster". Add the welcome points and "points from your past guest orders are added when you sign up with the same email". Read the numbers from `GET /api/site/value-props`; don't hard-code them.

### 16. `/bulk-pricing` copy is wrong

It says "Order 2 or more". The first break is at **3** for items under $100, and at 2 only for items of $100 or more. `GET /api/site/value-props` now returns `volume_pricing.starts_at_quantity: 3` and `volume_pricing.starts_lower_from: { quantity: 2, min_price: 100 }`, plus a `detail` string that states the rule. Render from those.

### 17. `/value-packs` needs a brand filter

It is one flat list. Add brand chips using `/api/products?pack=value_pack&brand=<slug>`.

### 18. Reorder entry point

The header, footer and account area show Account, Favourites and Track Order only; there is no "Buy again". For signed-in customers, add "Buy again" to the account menu. It lists past orders from `GET /api/orders`; the button fetches `GET /api/orders/:orderNumber` and posts each line's product to `POST /api/cart/items`, then opens `/cart`. There is no authed one-call reorder endpoint: `/api/reorder/load/:orderId` needs the signed `t` token that only emails carry. Business accounts can use `GET /api/business/reorder-items`.

---

## P2 — polish

- **Cart "Total" leaves out shipping.** The cart shows "Total $29.49" and checkout then shows $36.49. Label it Subtotal, or show the estimated total with shipping.
- **Coupons for guests.** The backend requires sign-in plus a verified email for coupon codes. This is deliberate, because of coupon abuse and the prefix lock. Replace "Sign in to use coupon codes" beside a pink disabled-looking button with "Have a code? Create a free account to use it", linking to sign-up, and hide the Apply button for guests.
- **Mobile fixed bars take 252 of 664 px** on search results: header 128, Filter & Sort 67, consent banner 57. The first card's Add button sits partly under Filter & Sort. Collapse the header on scroll, or make Filter & Sort a button in the header. The add-to-cart toast (y 554–657) covers the sticky buy bar, so move it to the top.
- **Card text is 9.9–11 px** ("3+ PRICE", "In Stock"). Use at least 12 px; 13–14 px suits the 30–40+ buyers.
- **Checkout transition.** Leaving `/cart` took more than 4 s on desktop and 10 s on mobile in a headless run, while Turnstile calls failed (`401 …/pat`, `ERR_NAME_NOT_RESOLVED brunhild.challenges…`). Headless may be the cause, so check real-user timings first. Don't block navigation on the Turnstile token; get it on the checkout page.
- **Cart LCP 3.6 s** with the logo text as the LCP element. Preload the logo font or use a system fallback with `font-display: swap`.
- **Hosting.** The apex `http://inkcartridges.co.nz` takes two hops, one of them a temporary 307. Make it one permanent redirect to `https://www.` in Vercel. `https://www.inkcartridges.co.nz/html` appears in the web index as a homepage duplicate, so 301 `/html` and `/html/*` to the clean URLs.

---

## Backend changes shipped with this doc (for reference)

| Area | Change |
|---|---|
| Search | printer match first; code matches rank above text matches; `alias_suggestion` + `alias_results` |
| Printer pages (prerender) | FAQ names the real cartridge codes and lowest price; ink/toner wording from what's listed; no "tested for"; "Other printers" = printers sharing a cartridge; Brother hyphen; robots `max-image-preview:large` |
| Category pages | brand counts are real (HP 385, not 19) |
| Sitemap | no duplicate product URLs; product `lastmod` omitted (it only ever showed the import day) |
| Emails | every storefront link carries `utm_source=email&utm_medium=lifecycle\|transactional&utm_campaign=<type>`; reorder buttons go to the product page, or `/cart?add=` once item 5 ships |
| Refill reminders | timed at 40 days for ink and 60 for toner (was 90/120); cross-sell same source and brand only; honest "about N weeks ago" |
| Cross-sell | `bought-together` requires a shared printer |
| Orders | `business_account_offer` on order detail |
| Catalogue | 24 HP compatible XL cartridges renamed from their standard names (e.g. "HP 65" → "HP 65XL"), with 301s for the old URLs |
