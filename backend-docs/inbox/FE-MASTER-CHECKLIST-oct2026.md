# FE master checklist: finish and verify (October 2026)

**This is the one file to work from.** It replaces the October storefront handoffs, which are kept for history only:

- `ad-clicks-to-orders-FE-handoff-oct2026.md`
- `ad-visitor-dropoff-FE-handoff-oct2026.md`
- `paid-traffic-conversion-FE-handoff-oct2026.md`
- `conversion-patch-ready-to-paste-oct2026.md`
- `cro-search-quote-points-FE-handoff-oct2026.md`
- `backend-audit-fe-handoff-oct2026.md`
- `google-reviews-link-FE-handoff-sep2026.md`
- `fe-recheck-open-items-oct2026.md`

Everything needed is copied in below, so you should not need to open them.

**Goal (owner):** a shopper who clicks an ad lands on the exact product they searched for, and gets from there to a paid order with no friction. We do not win on price, so we win on service, speed and an effortless checkout.

**State on 5 October 2026** (live check of the www build of 4 Oct, 19:20 UTC): most of the earlier work is live; Part 2 lists what to keep working. Part 1 is what is left. The backend side of every item is already live on `api.inkcartridges.co.nz`.

**When you deploy:** tell the backend the deploy time. We re-run the checks in Part 4 the same day.

---

## Part 1: open work, in order

### 1. P0: remove the "I authorize this payment" tick

Pay stays disabled until it is ticked. Pressing Pay is the authorisation, and Stripe does not need the tick.

- Remove the `#payment-authorization` box.
- In `payment-page.js` `updatePayButton()` (~line 870), change `canPay = this.paymentElementReady && this.paymentAuthorized && turnstileOk` to drop `this.paymentAuthorized`.
- In `handlePayment()` (~line 889), remove the early return that shows "Please authorize the payment before proceeding."
- Also delete the reset in `hideAuthorizationBox()`.

**Done when:** "Pay $X NZD" enables as soon as the card details are complete.

### 2. P0: Apple Pay / Google Pay from the cart

Today the wallet button appears only on the payment step, after the shopper has typed their name, email, phone and address. Stripe already has `www.inkcartridges.co.nz` registered and active for Apple Pay, Google Pay and Link (checked 5 Oct), and the payment page already mounts the Express Checkout Element (`initExpressCheckout`).

- Mount the Express Checkout Element on the **cart** (and under Add to Cart on the PDP if it fits).
- Configure it with `emailRequired`, `phoneNumberRequired` and `shippingAddressRequired`.
- On `shippingaddresschange`, call `POST /api/shipping/options` so the sheet shows the real fee. Shipping fees are unchanged (owner).
- On confirm, build the same `POST /api/orders` payload checkout builds, from the wallet's contact details and address.
- Guest orders still need the Turnstile token. Run Turnstile invisibly before enabling the button.

**Done when:** on an iPhone with Apple Pay, cart → paid order takes no typing.

### 3. P1: cart, Proceed to Checkout on the first screen

- At 1366×768, "Proceed to Checkout" starts at 829 px, below the fold.
- On an iPhone 13 (390×664) it sits at 883 px, with no sticky bar even after the consent banner is answered.
- "Continue Shopping" is the loudest button on the page.

Paste at the end of the site stylesheet:

```css
@media (min-width: 769px) {
  /* Cart: checkout button directly under the totals */
  .cart-summary { display: flex; flex-direction: column; }
  .cart-summary > * { order: 3; }
  .cart-summary__heading { order: 0; }
  .cart-summary__totals { order: 1; }
  .cart-summary__actions { order: 2; margin: 12px 0 4px; }
}

/* Cart: "Continue Shopping" becomes a text link, not the loudest button */
.cart-actions .btn--secondary { background: none; border: 0; box-shadow: none; color: inherit; text-decoration: underline; padding-left: 0; padding-right: 0; }

@media (max-width: 768px) {
  /* Cart on phones: checkout button fixed to the bottom once the consent
     banner has been answered (it never covers the banner's own text) */
  body:not(:has(#consent-banner.is-open)) .cart-summary__actions { position: fixed; left: 0; right: 0; bottom: 0; z-index: 900; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: #fff; box-shadow: 0 -2px 10px rgba(0,0,0,.12); }
  body:not(:has(#consent-banner.is-open)) .cart-page,
  body:not(:has(#consent-banner.is-open)) main { padding-bottom: 76px; }
}
```

**Done when:** at 1366×768 and 390×664, `document.elementFromPoint()` at the centre of "Proceed to Checkout" returns the button without scrolling, and "Continue Shopping" renders as a text link.

### 4. P1: one shipping figure, inside the total

- The cart shows "Total before shipping $24.99", with shipping as "From $7.00 · free over $100".
- Checkout then shows "North Island Shipping (est.) $12.00" and changes it to "$7.00" about 4 s later. The first figure comes from the local fallback `Shipping.calculate(...)` in `checkout-page.js` `updateShippingInfo()`.

**Fix:**
- On the cart, show the urban estimate and an "Estimated total" that includes it.
- On checkout, show "Calculating…" until the estimate arrives.

**Done when:** the cart total includes shipping, and checkout never shows a figure that then changes.

### 5. P1: service row next to Add to Cart

The ads now lead with service, so the page has to show it. Add a compact row next to the price and Add to Cart on the PDP, and under the H1 on series (`/shop?brand=…&code=…`) and printer pages:

- **Speed:** "Auckland orders by 2pm ship same day · most of NZ in 1–3 business days", from `delivery_estimate` / `trust_signals.shipping_promise`. Never an unscoped "same-day dispatch".
- **People:** "Questions? Call 027 474 0115 or email support@inkcartridges.co.nz", with a `tel:` link on mobile. Use `contact` from `GET /api/site/trust` (added 5 Oct; it is also in every `trust_signals` block).
- **Paperwork:** "GST tax invoice emailed with every order".
- **Safety net:** "30-day returns on unopened items" (`trust_signals.returns` / `compatibility_promise`).
- **Payment:** "Pay later with Afterpay".

Read every fact from `GET /api/site/trust` and `GET /api/site/value-props`; never hard-code one.

**Done when:** at 1366×599 and 390×664 the row is visible on the first screen next to Add to Cart on a PDP, and under the H1 on a series page.

### 6. P1: reward points next to the price

- `GET /api/products/:sku` returns `reward_points: { points, points_per_dollar, multiplier, redemption_rate }` for one unit. C43XBK returns 228 points.
- For a quantity rung, the points are `floor(business_price × min_quantity) × points_per_dollar × multiplier`.
- The cart already receives `loyalty.earn_on_this_order` for members and guests. For a guest (`loyalty.guest === true`), `loyalty.message` explains how to collect the points.

**Done when:** the PDP shows "Earn N reward points" near the price, and the cart summary shows "Points to be earned: N points".

### 7. P1: consent card off the first series card

The corner consent card sits bottom-**left** (left 16 px, 360 px wide). On a series page it covers the first card's price and Add at 1280×551, 1366×599, 1536×695 and 1920×911. Ads land on series pages, and the first cards sit on the left. Move it bottom-right:

```css
@media (min-width: 769px) {
  #consent-banner.consent-banner { left: auto; right: 16px; bottom: 16px; }
}
```

**Done when:** at those sizes, `elementFromPoint` at the first card's Add returns the button with the banner open.

### 8. P1: delivery times, South Island is now 1–3 business days

Owner decision, 5 Oct: everywhere outside Auckland is 1–3 business days, and Auckland stays 1–2. The backend already says so everywhere. The storefront still says otherwise in four places:

- `/faq`: the FAQPage JSON-LD answer to "How fast do you ship within New Zealand?" and the visible `<li>South Island: 2–4 working days.</li>`. **Change both in one edit**, because Google checks the visible answer matches the JSON-LD.
- `js/legal-config.js` (~line 149): shipping table `eta: '2–4 working days'` → `'1–3 working days'`.
- `js/shipping.js` (~line 69): `'south-island': '2–4 business days'` → `'1–3 business days'`.
- `js/product-detail-page.js` (~line 1110): `SPEC_DELIVERY_LABEL = '1–4 business days NZ-wide'` → read `delivery_estimate.label` instead (it now returns "1–3 business days NZ-wide").

**Done when:** no page shows "2–4" or "1–4" business/working days.

### 9. P2: Proceed to Checkout in under 1 second

`cart.js` caps the Turnstile wait at 1.5 s (`TURNSTILE_CLICK_WAIT_MS`). In our run `/api/cart/validate` fired at 1,543 ms and `/checkout` loaded at 3.0 s. `/api/cart/validate` does not check the token (`cartLimiter` + `fastOptionalAuth` only). Navigate first, and get the token on the payment page, where `POST /api/orders` needs it.

**Done when:** the click reaches `/checkout` in under 1 second.

### 10. P2: "Download PDF quote" in the cart drawer and on checkout

`GET /api/cart/quote.pdf` returns the current cart as a branded quote for purchase approval: seller details, GST number, lines, quantity discount, shipping, and total incl. GST.

- Optional params: `company`, `attention`, `reference` (≤ 80 chars); `region`, `postal_code`, `delivery_type`.
- `Content-Disposition` is exposed for the file name.
- Errors: `400 CART_EMPTY`; `429` after 10 a minute.
- **Label:** "Download PDF quote". Never "Official": it is a quote, not a tax invoice.

```js
const res = await fetch(`${API}/api/cart/quote.pdf?company=${encodeURIComponent(company)}`, {
  headers: { ...authHeaders(), 'X-Guest-Session': guestSessionId }
});
if (res.ok) {
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'inkcartridges-quote.pdf';
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
```

**Done when:** the button downloads a PDF that matches the cart.

### 11. P3: polish

- The payment summary prints the internal region value, "Auckland, auckland 1010" (`payment-page.js` `displayShippingSummary()`). Show the region label.
- `API.nzpostSuggest` asks for 5 address suggestions; ask for 8.
- Optional: Stripe's Payment Method Messaging element ("or 4 payments of $X with Afterpay") under the price and the cart total.

### 12. P1: `/cart?add=` opens a cart already filled with the customer's last order

**Why:** of 71 customers whose first order came from an ad, 1 has ordered again. The reorder and refill emails send a guest to ONE product page, so a customer who bought four colours has to find and add the other three. One click should land them on a cart that already holds their order. Today `/cart?add=…` loads the cart and drops the parameter; nothing is added (checked 5 Oct).

**Contract** (the backend builds these links in `src/utils/emailLinks.js` `cartAddUrl`):
- `/cart?add=SKU:QTY,SKU:QTY,…` — comma-separated, URL-encoded, at most 12 lines, quantity 1–20.
- SKUs are catalogue SKUs, matching `^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$` (ribbons include a dot, e.g. `81051.02`).
- The link can also carry `utm_source` / `utm_medium` / `utm_campaign`. Keep them for analytics.

**Behaviour:**
- For each line, resolve the SKU with `GET /api/products/:sku` (gives `id`), then `POST /api/cart/items` `{ product_id, quantity }`. This works for guests and for signed-in shoppers.
- ADD to whatever is already in the cart; never empty it first.
- A SKU that is unknown, inactive or out of stock is skipped. Show one line, for example "1 item from your last order is no longer available". Never show an error page.
- When finished, remove `add` from the address bar with `history.replaceState`, so a refresh does not add the items again.

**Done when:** `/cart?add=CCLI681XXLBK:1,CCLI681XXLC:2` opens the cart with those two lines at those quantities, and a refresh does not double them. **Ship this one first:** the backend already sends these links in every guest reorder and refill email (`GUEST_CART_ADD_LINKS=true`, kept on by the owner on 5 Oct), so until it is live those customers land on an empty cart. Tell the backend the deploy time.

### 13. P1: one-step account on the order confirmation page

**Why:** 88% of buyers check out as guests, and a guest earns no points and gets no one-click reorder. Baymard's research: ask for the account AFTER the purchase, on the confirmation page, with a single password field and concrete benefits (https://baymard.com/blog/delayed-account-creation).

**What:**
- On the confirmation page of a GUEST order, show one box: "Save your order and collect your points". It has a single password field, prefilled with nothing, and the email shown read-only (the order's email). One button: "Create my account".
- On submit, call `supabase.auth.signUp({ email: <order email>, password })`. Supabase emails a confirmation link. After the customer confirms and signs in, the existing `POST /api/account/sync` adds the 200 welcome points and claims this order and its points. No new backend call is needed.
- Benefits line, from live data only: "You get {N} points for this order plus 200 welcome points." N = `floor(total − shipping)` (1 point per $1).
- `GET /api/orders/:orderNumber` now returns `next_order_offer` (`{ points, dollars, by, guest }` or `null`). When present, add: "Your next order by {by, as a date} earns {points} bonus points (${dollars})." Never show it when the field is null.
- Do NOT build a one-click "create account" from this page using the backend's signed link. That link is only for the order email, because whoever typed the email at checkout may not own that address.

**Backend already live:** the order-confirmation email and the day-1 email carry a signed one-step link (`/api/orders/:id/create-account?t=…`). It opens a backend page that creates a confirmed account for the order's email.

**Done when:** a guest order's confirmation page shows the box; signing up, confirming and signing in shows the order and its points in the account.

### Not to do

- **PayPal: on hold by the owner.** Leave the PayPal button as it is. Do not apply the old hide rule.
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
12. Everything in Part 2 still holds.
