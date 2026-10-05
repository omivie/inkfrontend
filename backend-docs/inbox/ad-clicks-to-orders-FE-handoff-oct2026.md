# More ad clicks into orders: storefront checklist (2 Oct 2026)

This is the one list to work from. It supersedes the order of work in `paid-traffic-conversion-FE-handoff-oct2026.md` (1 Oct) and `ad-visitor-dropoff-FE-handoff-oct2026.md` (2 Oct). Those two files keep the full measurements and screenshots; the items below point back to them.

Everything here was checked on the live site on 2 October 2026 around 01:15 UTC, as a first-time visitor (no cookies, consent banner open) at laptop sizes.

## Why this matters

From 29 September to 2 October, Google Ads brought **54 tracked visits and 0 orders**.

- 29 of the 54 visitors (54%) saw one page and left without clicking anything.
- 2 added something to the cart. Neither has checked out yet.
- Once a visitor reaches the cart, the funnel works: 69% of carts reach checkout and 81% of checkouts complete.

The same series page converts **13% of paid visitors on mobile and under 4% on desktop**. The products, prices and copy are identical. Only the layout differs: on a laptop the price and the Add button are below the first screen.

**Target:** 1 in 10 paid visitors buys. We reached 9.4% on generic searches in July and August. That would roughly double orders for the same ad spend.

## 0. First: deploy what is already built

The owner was told the 1 Oct and 2 Oct fixes have been done. **None of them is live yet.** The pages on www are still served from the build of 1 October, 20:00–20:16 UTC. Vercel reports `x-vercel-cache: HIT` with an age of about 5 hours, and a new deployment would have replaced that copy.

| Item | Live result on 2 Oct, 01:15 UTC |
|---|---|
| Product page Add to Cart (1280×551, 1366×599, 1536×695, 1366×768) | Still at 664–712 px, below the fold or under the consent banner. **Fail** at all four sizes. |
| Series page `code=288` at 1366×599 | H1 still "Shop Ink Cartridges & Toner NZ". First price at 619 px, first Add at 763 px, banner starts at 538 px. **Fail.** |
| `code=288XL` | The page still calls `/api/shop?…&code=288`. Standard 288 lists first. **Fail.** |
| `pack=value_pack` | Still dropped. The page calls `/api/shop?brand=hp&category=ink&limit=200&code=564`. **Fail.** |
| Requests to the old `onrender.com` backend | None. **Pass.** |
| HP Envy 6130e printer page | Renders, lists HP 68 Black and Tri-Colour. **Pass.** |

**Please push and deploy to production, then tell the backend the deploy time.** We re-run the same check within the hour.

## 1. P0 — Product page: Add to Cart on the first screen

Full spec: `paid-traffic-conversion-FE-handoff-oct2026.md` §1.

- Put the quantity selector and Add to Cart directly under the price and stock line.
- Move delivery, returns, the dispatch countdown and the "3+ from $X each" line below the button.
- Stop the consent banner covering the buy box, for example with a one-line bar or a corner card. Do not raise any element above the banner, because the banner's legal text must stay visible.

**Done when:** at 1280×551, 1366×599 and 1536×695 with the consent banner open, `#add-to-cart-btn.getBoundingClientRect().bottom` is no lower than the top of `.consent-banner`, and `document.elementFromPoint()` at the button's centre returns the button.

## 2. P1 — Fit reassurance directly under Add to Cart (new)

"Will this fit my printer?" is the main doubt for an ink buyer. The page already shows the line, but too far down to help. At 1366×599 "Not sure it fits? 30-day returns on unopened items" sits at **985 px**, 320 px below the Add button.

- When you restructure the buy box in item 1, place `compatibility_promise.label` as one line **directly under the Add to Cart button**.
- Put `compatibility_promise.how_to_check` under it as small link text. Link it to the printer search.
- The page already renders this text, so this is a move, not new work. Its source is `trust_signals.compatibility_promise` (`label`, `how_to_check`, `description`), returned with every cart response (`GET /api/cart`). Do not hard-code the text: the return days come from the backend's settings.
- Do not reword it into "guaranteed fit" or "fits your printer". Compatibility data has known errors, and that claim is not allowed in our copy.

**Done when:** at 1366×599 the fit line is visible on the first screen, directly below the button.

## 3. P1 — Series page: price and Add on the first screen

Full spec: `paid-traffic-conversion-FE-handoff-oct2026.md` §2.

- Use a compact desktop card, with the price and Add button within about 250 px of the top of the card.
- Make the H1 name the code, for example "Epson 288 and 288XL Ink Cartridges". The browser title is already correct.

**Done when:** at 1366×599, the price and Add button of the first row of cards are fully above the consent banner.

## 4. P1 — Turn on the guest cart reminder tick box (new)

The backend has been live since 27 September, but **no guest has ever opted in**: `guest_sessions` holds 0 consents. The box is not being shown. 88% of our orders are guest checkouts, so most people who leave a full cart cannot be reminded.

- Show an **unticked** box on the cart page, labelled "Email me a copy of my cart if I don't finish", with an email field. It must be unticked by default: this is express consent under the Unsolicited Electronic Messages Act.
- When the visitor ticks it and enters an email, call:

```
POST /api/cart/guest-contact
X-Guest-Session: <the guest session id>
{ "guest_session_id": "<the same id>", "email": "<address>", "consent": true }
```

- `guest_session_id` must equal the `X-Guest-Session` header. Otherwise the API answers `400 GUEST_SESSION_MISMATCH`.
- Every reminder carries an unsubscribe link, and the backend checks suppressions before each send. The storefront does not need to handle either.

**Done when:** a test guest who ticks the box appears in `guest_sessions.contact_consent_at`.

## 5. P2 — Keep the ad's intent in the URL

Full spec: `paid-traffic-conversion-FE-handoff-oct2026.md` §3.

- For `code=288XL`, keep the whole family but list the requested tier (XL, XXL, HY) first.
- Pass `pack=value_pack` through to `/api/shop`. The API already supports it.

**Done when:** the network request carries `code=288XL` and `pack=value_pack` unchanged, and the first card matches the requested tier or pack.

## 6. P2 — "See our reviews on Google" link

Full spec: `google-reviews-link-FE-handoff-sep2026.md`. **Not live yet:** no product page has a link to Google reviews, footer included.

- Add a plain "See our reviews on Google" link in the footer and in the trust block by the buy box. It opens in a new tab.
- URL: `GET /api/site/trust` → `organization.google_reviews_url`.
- Do not show a star rating or a review count.

## 7. P3 — Product data for remarketing (new)

The add-to-cart tag now records correctly (35 in the last 30 days). Thank you.

But Google Ads' **"Product viewers", "Shopping cart abandoners" and "Past buyers" audiences are all at 0**. Without them we cannot show an ad to someone who looked at a cartridge and left, which is usually the cheapest order an ad can buy. The general "All visitors" audience works (about 2,300 people), so the tag itself loads.

Send product data with these Google Ads events, through the same consent handling as the existing gtag calls:

- `view_item` on every product page;
- `add_to_cart` (already firing; keep it);
- `purchase` on the order confirmation (the existing purchase event, with `items` added).

Each event carries:

```js
items: [{ id: product.sku, google_business_vertical: 'retail' }]
```

`id` must be the SKU **exactly as it appears in our Merchant Center feed** (`<g:id>` is `product.sku`, for example `GGI690KCMY`). A different form will not match the feed and the audiences stay empty.

**Done when:** within a few days, the "Product viewers (Retail)" audience in Google Ads is above 0.

## 8. Found walking the whole funnel as an ad customer (2 Oct, new)

On 2 October we walked the full path a paid visitor takes: Epson 502 ad → series page → Add → cart → checkout → address → payment. We did it twice, on a 1366×768 laptop and on an iPhone 13 (390×664), as a first-time guest. Order creation and payment were blocked on our side, so no order was placed. Every step works: no errors, the NZ Post address lookup fills city, region and postcode, and Stripe offers card, Klarna and PayPal. The items below are friction, not breakage.

### 8.1 P0 — "Proceed to Checkout" freezes for 8–9 seconds

Clicking the button runs a Cloudflare Turnstile challenge before anything happens. We measured 8.0 s on the laptop and 9.4 s on the iPhone between the click and `/api/cart/validate` (which itself answers in 0.35 s). The button gives no feedback in that time, so a shopper sees a dead button. A real browser may solve the challenge faster than our test browser, but it still takes seconds.

The backend does not need the token at this step. Turnstile is checked only when a guest **places the order** (`POST /api/orders`).

- Navigate to `/checkout` immediately on click.
- Run Turnstile invisibly in the background, either from when the payment page loads or earlier, and attach the token to `POST /api/orders`.
- Tokens expire after 300 seconds. Refresh the token if the shopper takes longer than that.
- If the token is still pending when they press Pay, show a spinner on the Pay button.

**Done when:** the click on "Proceed to Checkout" reaches `/checkout` in under 1 second.

### 8.2 P1 — Cart: the button that leads away is the one you see

At 1366×768, "Proceed to Checkout" starts at 798 px, below the fold. The most prominent thing on the first screen is the magenta "Continue Shopping" button, which takes the shopper away from the cart. On the iPhone, the checkout button is at 851 px on a 664 px screen.

- Put "Proceed to Checkout" at the top of the order summary. On mobile, make it sticky at the bottom of the screen.
- Make "Continue Shopping" a plain text link.

**Done when:** "Proceed to Checkout" is on the first screen at 1366×768 and 390×664.

### 8.3 P1 — One shipping number, included in the total

The same order shows shipping three ways. The cart says "From $7.00 · free over $100" and a Total that leaves shipping out ($48.99). Checkout first renders "North Island Shipping (est.) $12.00", then changes it to $7.00 once the estimate loads.

- On the cart, show the urban estimate ($7.00) and an "Estimated total" that includes it. A total that grows at checkout is a common reason to abandon a cart. Today's Epson 502 shopper opened the cart twice and left.
- On checkout, don't render a placeholder price before the estimate arrives. Show "Calculating…" instead.

### 8.4 P2 — Two required ticks before paying

The details step requires "I agree to the Terms & Conditions and Privacy Policy". The payment step then keeps "Pay $55.99 NZD" disabled until "I authorize this payment" is also ticked, and that button is below the fold at 1366×768.

- Remove "I authorize this payment". Pressing Pay already authorises the payment, and Stripe does not need the extra tick.
- For the terms, ask the owner whether a line next to the Pay button ("By placing this order you agree to our Terms and Privacy Policy") can replace the tick box.

### 8.5 P3 — Polish

- The payment summary shows the region's internal value: "Auckland, auckland 0627". Show its label instead.
- Typing "1 Queen Street" lists Masterton, Levin, Feilding, Northcote and Pahiatua before Auckland's main Queen Street. Consider asking `/api/address/nzpost/suggest` for 8 suggestions instead of 5.

### Fixed on the backend the same day (no storefront work)

Listing cards read "Fits Epson EC OTANK ET 2850, Epson ECO TANK ET 2700 +9". The card's "Fits …" line took the first two printer rows alphabetically, and the feeds' all-caps typo rows sort first. Migration 195 now:

- shows the manufacturer's spelling when a printer has several spellings;
- never shows the same machine twice;
- counts each printer once in "+N".

The Epson 502 cards now read "Fits Epson EcoTank ET-2850, …". The field shape (`compatible_printers`, `compatible_printers_count`) is unchanged.

## 9. Small items (from `ad-visitor-dropoff-FE-handoff-oct2026.md`)

- Use the "GENUINE" brand tile for genuine singles with no `image_url`, as genuine packs already do. None showed on the 288 page today, but 552 genuine images are still waiting for review.
- Search the storefront code and the Vercel environment variables for `ink-backend-zaeq` and `onrender.com`, and remove any leftover reference.

## How we will verify

After you tell us a deploy is live, the backend re-runs the live check at 1280×551, 1366×599, 1536×695 and 1366×768, first-time visitor, consent banner open:

1. Product page: Add to Cart above the banner and clickable; fit line directly under it.
2. Series page `code=288`: first-row price and Add above the banner; H1 names the code.
3. `code=288XL` and `pack=value_pack` reach `/api/shop` unchanged.
4. Cart page shows the unticked reminder box, and "Proceed to Checkout" is on the first screen.
5. "Proceed to Checkout" reaches `/checkout` in under 1 second.
6. A Google reviews link exists on the product page and in the footer.

We then compare paid visitors who add to cart before and after the deploy, and report back after a week.

## Not asked

- No price claims, "lowest price" copy or star ratings (our copy rules forbid unsubstantiated claims).
- No "guaranteed fit" wording.
- No page-speed work for this problem. The buy box appears in 0.6 s on a first visit. The problem is where it is, not when.
