# Storefront handoff, 26 Oct 2026: checkout fixes, privacy copy, what changed on the backend

**For:** the storefront (FE) developer. **From:** backend. **Backend deploy:** live on `api.inkcartridges.co.nz` since 26 Oct 2026, 04:45 NZDT (commit `aebb5b4`).

Every item below is also in `docs/storefront/FE-MASTER-CHECKLIST-oct2026.md` with the same number; this file is the short version to work from. Nothing here needs a backend change first: the backend side of each item is already live.

## Do these first

| # | Priority | What | Size |
|---|---|---|---|
| 51 | **P0** | A refused Pay press must not add the cart again (it charged a customer for 9 cartridges instead of 3) | small |
| 50 | **P0** | Privacy page: two approved additions (phone calls, Google Customer Reviews). The owner's customer calls wait for this. | copy only |
| 52 | P1 | Checkout: re-quote shipping when the postcode changes; number pad for postcodes | small |
| 53 | P2 | Payment form: do not ask Afterpay buyers for name and email twice | small |
| 54 | P2 | Show the Afterpay mark wherever accepted payments are listed | copy/asset |
| 55 | P2 | Cart drawer: hide the Google Customer Reviews badge while the drawer is open | one CSS rule |
| 56 | P2 | Cart: the pack-swap chip says what it compares and never drops units | small |
| 57 | P3 | PayPal return and cancel pages (or tell us to stop sending the URLs) | small |
| 58 | P3 | "Subtotal (1 items)" plural | one line |
| 49 | P1 (admin, owner only) | Invoice / quick-order line badges: below web price, thin margin | medium |

Please tell us when each one is live, especially **51** and **50**.

## Backend changes now live that you may notice (no FE work unless an item says so)

- **Public holidays.** `delivery_estimate.same_day_eligible` (cart and product page) is now `false` all day on NZ public holidays, as it already was at weekends; `cutoff_remaining_seconds` is `0`. The shipping email's delivery dates and the order pages' `estimated_delivery` / `estimated_delivery_date` now count NZ business days (weekends and public holidays skipped), as an NZ calendar date. Example: an order shipped on Friday 23 Oct was promised "2026-10-26" (Labour Day); it is now Tuesday 27 to Thursday 29.
- **Safety net for item 51.** `POST /api/orders` now lowers each cart line it names to the quantity in the order request (it never raises, adds or deletes a line). That stops a refused press from inflating the next order, but item 51 is still needed: the extra units still land in the cart for a moment and in the cart analytics.
- **Repeat orders.** A customer placing the same order a third time (same cart, same address) used to get `409 DUPLICATE_ORDER` ("Order already exists") forever. That is fixed. Only the buyer's own `pending` order is ever replayed (`is_duplicate: true` with a `client_secret`); every other earlier order gets a fresh order. `409 DUPLICATE_REQUEST` ("Order already being processed") still means a second press while the first is in flight, and no longer sticks for 5 minutes after an early refusal (out of stock, product not found).
- **Order rate limit.** Still 10 order attempts per 15 minutes per IP address, for guests and members alike.
- **Free-shipping suggestions** (`free_shipping_unlock.suggested_products` on the cart): now only products that fit the cart. First the rest of a model already in the cart (its other colours and its own CMY/KCMY packs), then singles that share a printer with a cart line. **They can now include value packs** (`pack_type: "value_pack"`); render them like any product chip.
- **"You may also need" / related** (`GET /api/products/:sku/related`): in-stock items first, then the ones that share the most printers with the product. Same response shape.
- **Abandoned-cart email.** Its button now opens `/cart` (it pointed at `/cart/`, which www serves as a 404 page). If you prefer, also redirect `/cart/` to `/cart` on www.
- **Refunds.** A full refund made in the Stripe Dashboard now moves a shipped order to `refunded` (it stayed `shipped`). Order pages may now show `status: "refunded"` on a shipped order.
- **Also live from the 20 Oct asks** (details in `docs/storefront/backend-asks-20oct-backend-response-oct2026.md`): `/receipt-rolls` is the receipt category's landing path; `/api/products` and `/api/shop` accept every category alias; `matched_printer.exact` on smart search; the printer bot page lists products in item 46's order; grid `add_to_cart:<uuid>` clicks resolve to the product.

## The items

### 50. P0 (owner 24 Oct, wording approved): Privacy page, say we may phone existing customers

**Why:** the owner will phone existing customers: lapsed business customers, and new company buyers to check their order arrived and offer quotes and a business account. Our privacy policy must tell customers how we use their details (Privacy Act 2020), and neither privacy page mentions phone calls. No call that offers anything happens until both pages say it.

**Backend (ships with the 26 Oct deploy):** the prerendered privacy page (`/api/prerender/static/privacy`) carries the paragraph below, straight after the "How We Use It" paragraph.

**Fix:** on the hand-authored www `/privacy` page, add this paragraph in the section that says how we use personal information. Copy it byte for byte, with straight apostrophes: the bot page and the human page must match (www serves its own static HTML for this route).

> We may phone existing customers about their orders, reorders, quotes and account options. If you would rather we didn't, tell us and we won't call again.

**Second addition, Google Customer Reviews (owner approved 24 Oct):** the order-confirmation page renders Google's opt-in survey (footer.js `renderSurveyIfConsented`) and hands Google the buyer's email, order number, delivery country, estimated delivery date and the products' GTINs (`google_customer_reviews` in the order response). Neither privacy page said so. Add this item, byte for byte, to the list of third parties that receive data (after Google Ads and Microsoft Advertising):

> **Google Customer Reviews** (an optional survey Google may offer after an order) — only if you opt in: your email address, order number, delivery country, estimated delivery date and the barcodes of the products you ordered, so Google can send you the survey.

**Owner approval:** the owner approved both on 24 Oct. Deploy them as soon as they are built.

**Done when:** www `/privacy` shows the paragraph and the Google Customer Reviews item exactly as above. Tell us when it is live: the owner's calls start only once both pages carry the paragraph.

### 51. P0 (new 25 Oct): Checkout, a refused Pay press must not add the cart again

**Why:** on 5 Oct a guest added 3 x HP 63XL Black (order 2026100602). Two Pay presses were refused (the email check), and the third press charged them for **9** ($486.81). Every Pay press runs "STEP 0.5" in `payment-page.js` `createStripeOrder`, which calls `API.addToCart(item.id, item.quantity)` for every line. `POST /api/cart/items` ADDS to a line, it does not set it. `payNow()` and the PayPal `onClick` then rebuild `this.cartItems` from `GET /api/cart` before the order is created, so each refused press multiplies the next attempt, and the order key changes with the quantity, so the backend sees a new order. The summary is painted from the local cart, so the shopper never sees the new quantity. Since 13 Oct every web order has a server re-add 1–3 s before it, and one member's abandoned cart now holds 6 instead of 3 (the cart-recovery email quotes that cart).

**Fix:**
1. Delete STEP 0.5. `POST /api/orders` prices the request body; no backend path builds the order from `cart_items` (coupons and points are read from their own tables). If you need a sync, make it SET, never ADD: `PUT /api/cart/items/:productId { quantity }`, and `POST` only when that `PUT` returns 404. Never `POST` after any other failure (a 429 or 500 would re-add the line).
2. The order payload's quantities are the ones the summary shows. Never take them from a re-read of the server cart after a refused or failed press.
3. Turnstile (guests): a token is spent as soon as `POST /api/orders` has checked it, whatever the answer. Call `this.resetTurnstile()` right after every `API.createOrder()` response, success or refusal, in `createStripeOrder` and in the points path. This includes the email-refusal branch that returns `'handled'` without throwing. Today the second press reuses the spent token and is refused again, and each refused press also passed STEP 0.5.

**Done when:**
- On the `super_admin` test product, force one refusal (an invalid email such as `a@b`), fix the email, then pay. The order's quantity equals the cart's.
- `cart_analytics_events` shows no server `add_to_cart` with `metadata.origin = 'server'` in the 5 s before the order.
- As a guest, a Pay press after a refusal is not refused by Turnstile.

### 52. P1 (new 25 Oct): Checkout, re-quote shipping when the postcode changes; number pad for postcodes

**Why:** the delivery fee is re-quoted when the region, delivery type or a saved or autocompleted address changes, but not when the shopper types or edits the postcode. `POST /api/orders` charges by postcode (the backend's zone lookup prefers it). A shopper can be charged a different fee from the one shown: $7 shown and $12 charged, or $22 for a South Island parcel of 2 kg or more. Separately, `#postcode` and `#billing-postcode` open the full text keyboard on phones, and most paid visitors are on phones.

**Fix:**
1. Add a debounced `input` listener on `#postcode` that calls `updateShippingCost()` once 4 digits are entered, and send `postal_code` with `_refreshDeliveryPrices`' request.
2. In `payNow`, re-quote before building the order payload, so Pay always uses a current fee. If the order response's total differs from the total on screen, update the summary before confirming the payment. Never confirm a figure the shopper has not seen.
3. Add `inputmode="numeric"` to `#postcode` and `#billing-postcode`. Keep `type="text"`, so leading zeros (0600–0999) survive.

**Done when:** with a 2 kg toner in the cart, a 1010 (Auckland) quote followed by typing 9016 (Dunedin) changes the shipping line before Pay; on an iPhone both postcode fields open the number pad.

### 53. P2 (new 25 Oct): Payment form, do not ask Afterpay buyers for their name and email again

**Why:** all three Search campaigns say "Pay Later With Afterpay". On `/checkout` the Stripe Payment Element is created with empty billing details (`PaymentPage.attach(null)`, `payment-page.js` around 632–645), so a shopper who picks Afterpay must type their name and email again inside the Afterpay panel, after typing them in the form above. Pay stays disabled until they do. Afterpay made the only buy-now-pay-later sale since June (14 Oct).

**Fix:** create the element with Stripe's `fields: { billingDetails: { name: 'never', email: 'never', phone: 'never' } }`. Stripe then requires those values in `confirmPayment`'s `payment_method_data.billing_details`, which `payment-page.js` already sends (around 1117–1131). Check in Stripe test mode that Afterpay, card and Link all still confirm.

**Done when:** choosing Afterpay on `/checkout` shows no name or email field inside the Afterpay panel, and a test-mode Afterpay payment completes.

### 54. P2 (new 25 Oct): Show Afterpay wherever the accepted payments are listed

**Why:** the footer's "We accept" row lists Visa, Mastercard, Amex, PayPal, Google Pay, Apple Pay and Klarna, and the cart page names Klarna twice, but Afterpay appears nowhere before the payment step. The ads promise Afterpay, and it is live (Stripe payment method configuration `pmc_1SmAm80gOo8rzNMQdYWvtJFA`: Afterpay and Klarna both on, 25 Oct).

**Fix:** add an Afterpay mark to the footer's "We accept" row (`footer.js`) and to the cart page's payment row. Copy rule: name the method only, with no "interest-free" or instalment claims.

**Done when:** `/cart` and the footer show the Afterpay mark beside Klarna.

### 55. P2 (new 25 Oct): Cart drawer, hide the Google Customer Reviews badge while the drawer is open

**Why:** `#google-reviews-badge` is fixed at the bottom right with `z-index: 2147483647`, above the cart drawer (`z-index: 10000`). It covers about the right 36 px of the drawer's Checkout button, so a tap there opens Google's card instead of checkout. The consent bar had the same problem (ERR-233/238).

**Fix:** one rule in `components.css`: `html.cart-drawer-open #google-reviews-badge { display: none !important; }` (`!important` beats Google's inline styles, as in the ERR-233 rule).

**Done when:** with the drawer open at 390 px and at 1366 px wide, `elementFromPoint` at the right end of the Checkout button returns the button.

### 56. P2 (new 25 Oct): Cart, the pack-swap chip says what it compares and never drops units

**Why:** the chip reads "Save $X — switch to the value pack". `_swapLineForPack` adds one pack and removes the whole single line, so a line of 2 or 3 singles silently loses units. The saving is measured against the four singles, which the chip does not say.

**Fix:** state the basis, e.g. "4-colour set $31.99 — $2.27 less than the 4 singles" (use `pack_suggestion_for_line`'s `individual_total` and `savings_amount`). Show the chip only when the line's quantity is 1, or on swap reduce the single line by 1 instead of removing it. Keep the copy rules: no "save up to", no "best value".

**Done when:** on a cart line of 1 x LC233 Black the chip names the set and the four-singles comparison; on a line of 3 it is hidden (or the swap leaves 2 singles in the cart).

### 57. P3 (new 25 Oct): PayPal return and cancel pages

**Why:** the backend gives PayPal `/checkout/paypal-return` and `/checkout/paypal-cancel` as its return and cancel URLs, and both are 404 pages on www. PayPal uses them only when it leaves the popup flow (in-app browsers, the PayPal app). A buyer who returns that way lands on a 404 page, the order is never captured, and the stale-order sweep cancels it later. PayPal volume is tiny (3 orders in 120 days) and the button is on hold (see "Not to do"), so this is last.

**Fix:** either build the two pages (`/checkout/paypal-return` reads PayPal's `token`, calls the existing `POST /api/orders/:orderNumber/capture-paypal` with the order number saved to `sessionStorage` before `createOrder`, then goes to `/order-confirmation`; `/checkout/paypal-cancel` returns to `/checkout` with a message), or tell us the storefront never needs the redirect path and we will stop sending the URLs.

### 58. P3 (new 25 Oct, optional): "Subtotal (1 items)"

The cart's subtotal label is `Subtotal (<span id="cart-item-count">N</span> items)` and `cart.js` writes only the number, so one unit reads "1 items". Write the whole label where `#cart-item-count` is set (around `cart.js` 3334 and 4759): `${n} item${n === 1 ? '' : 's'}`.

### 49. P1 (admin, owner only; owner plan 24 Oct): warn on invoice and quick-order lines priced under the website or on a thin margin

**Why:** invoices and quick orders are priced by hand, and neither editor shows when a line goes out under what the website charges for the same quantity, or on a thin margin. The quote endpoints now work both out for every line.

**Backend (live once deployed):** every line in the `POST /api/admin/invoices/quote` and `POST /api/admin/quick-orders/quote` responses carries two new fields. Both endpoints stay `super_admin` only, because the margin comes from our cost.
- `gross_margin_pct`: gross margin on the line's unit price ex GST, `(price − cost) / price × 100`, two decimals. `null` when our cost is unknown (never read it as 0).
- `below_web_price`: `true` when the line's unit price is under what the website charges a guest for the same quantity (list price less the public volume discount; contract prices do not count), otherwise `false`. `null` when the line has no product (a description-only line or an unknown code).
- Both are `null` on a line that is not a sale: quantity or price 0 or below (a return, a credit).
- Both judge the price the operator will save: the typed price (`unit_cost_excl_gst` on an invoice line, `unit_price_excl_gst` on a quick-order line) when it is not 0, otherwise the quote's autofill figure. A typed 0 means "not priced yet", as it already does for the goods total.
- The cost is the one the save records: the line's `supplier_cost_excl_gst` when sent (0 counts: warranty or exchange stock), otherwise the product's catalogue cost. When `cost_source` is `'manual'` and no cost is typed, the cost is unknown.

**What to build:**
1. Send each line's typed price, `supplier_cost_excl_gst` and `cost_source` with every quote call (both endpoints accept extra keys), and quote again when any of them changes, not only the code or quantity.
2. In both editors, show a warning badge on a line when `below_web_price` is `true` ("Below web price") or `gross_margin_pct` is under 20 ("Margin 12.5%"). Show both when both apply. `null` shows no badge.
3. Keep the 20 in one named constant: the owner may change the level.

Rules:
- Advisory only. Never block or delay the save, never change the typed price, and never ask for a confirmation. A $0 warranty or exchange line is a legal line.
- Owner only. Other admins never see the badges (the quote endpoints answer them `403`).

**Done when:** on a draft invoice, a line typed under the quote's autofill price shows "Below web price"; a line under 20% margin shows the margin badge; the invoice still saves with either badge showing; the quick-order editor does the same.

## How we will check

After you tell us a deploy is live, we check as a first-time visitor on desktop and on an iPhone-size screen:

1. **51:** on the admin test product, force one refusal (an invalid email such as `a@b`), fix the email, then pay: the order quantity equals the cart quantity. As a guest, a second press after a refusal is not refused by Turnstile.
2. **50:** www `/privacy` carries both additions byte for byte, matching `/api/prerender/static/privacy`.
3. **52:** with a toner in the cart, changing the postcode from 1010 to 9016 changes the shipping line before Pay; the postcode fields open the number pad on an iPhone.
4. **53-58:** as each item's "Done when" says.

Questions: reply to the owner and we will answer the same day.
