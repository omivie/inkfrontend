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

## Status after the live check on 6 October 2026

Checked in a fresh browser session (first-time visitor, consent banner open) at 1366×768, 1366×599 and 390×664, plus the live JS.

**Done:** 1 (no authorize tick), 4 (cart "Estimated total" includes shipping; checkout shows a single estimate), 11 (address search asks for 8; region label), 12 (`/cart?add=` filled CLI681XXLC ×2 + CLI681XXLBK ×1, cleaned the URL, no double on reload), the cart half of 6 ("Points to be earned: 89 points"), and the desktop half of 3 (Proceed to Checkout on the first screen, Continue Shopping is a text link).

**Code shipped, needs a real-device test:** 2 (`cart-wallet.js` mounts the Express Checkout Element on the cart; Apple Pay cannot render in a test browser) and 13 (the sign-up box is in `order-confirmation-page.js`, but nothing reads `next_order_offer` yet).

**Still open:**
- **3, phones:** at 390×664 "Proceed to Checkout" sits at 718 px, below the screen, with no sticky bar after the banner is answered.
- **5:** no service row next to Add to Cart on the PDP, and none under the H1 on series pages.
- **6, PDP:** no "Earn N reward points" near the price.
- **7:** the consent card is still bottom-LEFT (left 16 px) and covers the first series card's Add at 1366×599 (`elementFromPoint` misses it).
- **8:** `/shipping` still shows South Island "2–4 working days" (`js/legal-config.js` line 149). `/faq` changed the visible answer but NOT its FAQPage JSON-LD, which still says 2–4: the two must match word for word (Google treats a mismatch as cloaking), so this is now worse than before. `SPEC_DELIVERY_LABEL = '1–4 business days NZ-wide'` is still in `js/product-detail-page.js`.
- **9:** the click reaches `/checkout` in 1.29 s (was 3.0 s; target under 1 s).
- **10:** no "Download PDF quote" in the cart or on checkout.
- **13:** show `next_order_offer` from `GET /api/orders/:orderNumber` when present.
- **14 (new, owner report 6 Oct):** the cart's unit price stays at retail when a volume rung is reached, and the summary mixes two quantities for about 1.5 s after each + or −.
- **15 (new, P0, 6 Oct):** checkout lets an email the backend has already rejected through to Pay, where the order is refused and Pay appears to do nothing. It nearly lost a $486.81 order.

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

### 14. P1: cart unit price follows the quantity (volume price)

**Owner report (6 Oct):** GLC3313BK in the cart. At quantity 3 the price should read $66.14, and it stays at $67.49.

**What is wrong (two separate problems, `js/cart.js`):**

1. **The unit price cell never shows the volume price.** `.cart-item__price` and `.cart-item__price-mobile` always render `item.price`, which is retail. The surgical update (~line 2783) repaints `.cart-item__price-mobile` but never `.cart-item__price`. Even after the server re-prices the line, the shopper sees $67.49 in the price column. The $66.14 appears only as small text ("$66.14 each · volume price") under the line total.
2. **For about 1.5 s after each + or −, the cart shows a mix of old and new figures.** `updateQuantity` sends `PUT /api/cart/items/:id`, then `GET /api/cart`. Each takes about 0.7 s (Render log of the owner's session, 5 Oct 19:57 UTC). Until the GET lands, `lineTotalFigures()` correctly drops the stale server figures, so the line shows retail × qty. But the summary keeps the previous quantity's server rows next to the new local subtotal. The owner's two screenshots were both taken inside this window:
   - qty 1 shown with "Volume discount −$4.05", "Shipping Free", "Total $63.44", "198 points" (all from qty 3);
   - qty 3 shown with "Shipping (est.) $7.00 · free over $100" on a $202.47 subtotal, "Incl. GST $9.72", "Add $32.51 more…" and "67 points" (all from qty 1).

**The backend is correct.** After the GET, a guest replay of the same cart showed ~~$202.47~~ $198.42, "$66.14 each", volume discount −$4.05, free shipping, total $198.42.

**Backend change (live after the 6 Oct deploy):** `PUT /api/cart/items/:productId` now returns the whole re-priced cart as `data.cart`, the same shape as `GET /api/cart` `data`, beside its old keys (`message`, `id`, `product_id`, `quantity`). In `updateQuantity`, adopt `response.data.cart` through the same path `loadFromServer` uses (`_parseServerCart`, the pending-removal filter, the empty-cart guard) and skip the follow-up `GET /api/cart`. Epoch guard: take `_beginSnapshot()` right after the local `_mutationEpoch++`, and adopt the PUT's cart only if the epoch is unchanged when it returns. If the shopper clicked again meanwhile, drop it: the later PUT's own `cart` describes the newer quantity. Only when `data.cart` is missing (the backend omits it if its re-read fails) fall back to `loadFromServer()`. This halves the wait (one ~0.7 s request instead of two).

**Fix:**
- **Unit price = the line's rung price.** Each cart line already carries `quantity_breaks` (built by the server for this line, contract price included). Find the highest rung with `min_quantity <= quantity`; its `business_price` is the unit price, otherwise use `item.price`. When `volume_figures.quantity === item.quantity`, use `volume_figures.unit_price` instead. This is a lookup of server figures, not FE price maths. Show it in BOTH `.cart-item__price` and `.cart-item__price-mobile`, with retail struck through beside it when lower (for example ~~$67.49~~ $66.14, and the ex-GST figure from the same number). Repaint both cells in the surgical path as well as the full render.
- **Line total while the change is in flight:** rung price × quantity, from the same lookup, instead of retail × quantity.
- **Summary while `pricingState === PRICING.PENDING`:** do not show the previous quantity's server-only rows (volume discount, shipping, total, GST, points, the free-shipping message) beside the new subtotal. Either show "Updating…" in those rows until the GET lands, or hide them. Never show a mix of two quantities.

**Done when:** on `/cart` with GLC3313BK, pressing + from 1 to 3 shows ~~$67.49~~ $66.14 in the price column at once. The line total reads $198.42. The summary goes straight from the qty-1 figures to: volume discount −$4.05, shipping Free, total $198.42, never through a mixed state. Pressing − back to 1 shows $67.49 and no volume discount row.

### 15. P0: catch a bad email on the checkout page, not at Pay

**Owner report (6 Oct):** order 2026100602 ($486.81). The shopper pressed Pay twice and nothing happened. They had to work out for themselves that the email was the problem, go back to checkout and retype it. We nearly lost the order.

**What happened** (Render log, 5 Oct, UTC):
- **20:20:03** The shopper typed their email on `/checkout`. `POST /api/checkout/guest-prefill` and `POST /api/cart/guest-contact` both answered `400 VALIDATION_FAILED` on the `email` field. The page ignored both answers and let "Continue to payment" through.
- **20:21:40 and 20:22:13** Pay now → `POST /api/orders` → `400 VALIDATION_FAILED`, field `guest_email`, "Please enter a valid email address so we can send your receipt". No order was created and Stripe was never called.
- **20:22:29** The shopper went back to `/checkout`, retyped the email (accepted at 20:22:59), re-entered the address, and paid at 20:24:58.

**Why the browser accepted it:** the backend checks the email with Joi `.email()`, which also requires a real top-level domain. So `name@gmail.con` and `name@gmail` are refused, while `<input type="email">` and a simple `x@y.z` pattern accept them. We do not log email addresses, so the exact typo is unknown. Keep the backend as the judge; do not copy its rules into the FE.

**The backend's answer** (same shape on all three endpoints):

```json
{ "ok": false, "error": { "code": "VALIDATION_FAILED", "message": "Validation failed",
  "details": [{ "field": "email", "message": "Please enter a valid email address" }] } }
```

On `POST /api/orders` the field is `guest_email`.

**Fix:**
- **Check on blur and on "Continue to payment".** The page already sends `POST /api/checkout/guest-prefill { email }` when the field is filled. Treat its `400` with `error.code === 'VALIDATION_FAILED'` as "this email is invalid": show `error.details[0].message` under the email field, mark the field invalid (`aria-invalid="true"`, message linked with `aria-describedby`), focus it, and keep "Continue to payment" disabled until a later check passes.
- **Fail open on anything else.** A `429` (the endpoint allows 5 a minute per IP), a `5xx` or a network error must NOT block checkout. `POST /api/orders` still checks the email.
- **Typo hint (recommended):** when the domain is one letter off a common one, offer a one-tap fix under the field, for example "Did you mean name@gmail.com?". Domains: `gmail.com`, `hotmail.com`, `outlook.com`, `yahoo.com`, `icloud.com`, `xtra.co.nz`. Typical misses: `.con`, `.cmo`, `.comm`, `gmial`, `gmai`, `hotmial`, `xtra.co`.
- **Backstop on `/payment`.** If `POST /api/orders` still returns `400` with a `guest_email` detail, show that message next to the Pay button with a "Change email" link back to the checkout email field. Never a generic error, and never a Pay button that silently does nothing.

**Done when:** on `/checkout` as a guest, typing `test@gmail.con` and leaving the field shows "Please enter a valid email address" under it and "Continue to payment" stays disabled. Correcting it to `test@gmail.com` clears the message and enables the button. Over the next week, Render logs show no `validation_failed` on `/orders` for `guest_email`.

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
12. A mistyped email (`test@gmail.con`) is caught under the email field on `/checkout`, and "Continue to payment" stays disabled until it is fixed (15).
13. Everything in Part 2 still holds.
