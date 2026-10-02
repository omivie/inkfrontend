# More ad clicks into orders — FE reply (Oct 2026)

**Answers:** `inbox/ad-clicks-to-orders-FE-handoff-oct2026.md` (2 Oct 2026). It also closes the open items of
`inbox/paid-traffic-conversion-FE-handoff-oct2026.md` (1 Oct) and `inbox/ad-visitor-dropoff-FE-handoff-oct2026.md` (2 Oct).
**FE refs:** ERR-302 (§0, §4, §6 footer, §7) and ERR-301 (§1, §2, §3, §5, §6 product page, §8). Two FE sessions split the
work by file.
**New asks:** BF-098 (§5), BF-099 (§4).
**Measured:** 2026-10-02, against production for API claims and against `localhost:3000` (same backend) for the pages.
**Re-check:** `npm run probe:ad-clicks` (READ-ONLY). Add `PROBE_BASE=https://www.inkcartridges.co.nz` once the deploy is live.

---

## §0 Deploy — why nothing was live

Your reading was right, and the cause was ours. Local `main` was **5 commits ahead of `origin/main`**: ERR-295 to ERR-299
were committed but never pushed. Vercel was serving the last push correctly.

This round ships everything in one push. **Deploy time:** _filled in after the push (see §9)._

## §4 Guest cart reminder — switched on, and now on /cart too

- **Why no guest had ever opted in.** The box existed only on **checkout**, behind `Config.DARK_FEATURES.guestCartEmail = false`,
  and it had never been shown. The owner approved switching it on on 2 October.
- **/cart now shows it** under "Proceed to Checkout", for guests only: an **unticked** box labelled
  "Email me a copy of my cart if I don't finish", with its own email field. Checkout shows the same box under its order email field.
  Both pages run the same code.
- **Call.** It sends `POST /api/cart/guest-contact` with `X-Guest-Session` and `{ guest_session_id, email, consent: true }`,
  only after the shopper has ticked the box and entered a valid address, and once per address. The body id and the header
  come from the same stored value, so `GUEST_SESSION_MISMATCH` cannot happen unless the store changes between the two reads.
- **UEMA.** Nothing is sent while the box is unticked. If the browser restores a tick from an earlier visit, we clear it when
  the page loads, because a restored tick is not consent.
- **Outcome is shown.** On success the shopper sees "We'll email a copy of this cart to {email} if you don't finish. Every email
  has an unsubscribe link." On any failure (thrown 400, `RATE_LIMITED`) they see "We couldn't save that just now. Your cart is
  unaffected." and can try again. The cart and checkout are never blocked.
- **Done-when.** _One real opt-in, made after the deploy with an address the owner controls; result in §9._ Please confirm the row
  in `guest_sessions.contact_consent_at`.

### BF-099 — withdrawing consent before the first email

If a shopper ticks the box, the address is saved, and then they untick it, we have no call to withdraw it. Today the page tells them
honestly: "Your address is already saved for this cart. Every reminder email has an unsubscribe link."

**Ask:** would you accept `{ guest_session_id, email, consent: false }` on the same route to clear `contact_consent_at`? If you add
it, we will send it on untick. No change on our side is needed until you do.

## §6 "See our reviews on Google" — footer done (product page: see the ERR-301 section)

- The footer on every page now shows a plain "See our reviews on Google" link. It opens in a new tab with `rel="noopener noreferrer"`.
  It shows no stars and no count.
- **Source.** `GET /api/site/trust` → `organization.google_reviews_url`, through the same session-cached read the footer already
  makes for the trust stats, so there is no new request.
- **Validation.** The href is used only if it is `https:` and its host is `google.com`, `www.`, `maps.` or `search.google.com`, or
  `google.co.nz`. Anything else, or no value, means no link at all. Your current value passes.
- **Measured locally:** the link is shown, and its href is byte-identical to the API value.

## §7 Remarketing audiences — the cause, and the fix

**Cause.** Product viewers, Shopping cart abandoners and Past buyers fill from the event **names** `view_item`, `add_to_cart` and
`purchase` carrying `items`. The Ads account received none of them:

- our GA4 `view_item` and `add_to_cart` are scoped to the GA4 property, deliberately;
- the Ads add-to-cart and purchase were labelled `conversion` events. A conversion is not a remarketing event.

The tag itself loaded on every page, which is why "All visitors" filled.

**Fix.** Each event is now also sent to the Ads tag (`send_to: 'AW-18032498762'`, no conversion label), with
`items: [{ id: <SKU>, google_business_vertical: 'retail' }]`:

| Event | When | Guard |
|---|---|---|
| `view_item` | product page | once per SKU per page load; never for the admin test product |
| `add_to_cart` | after `POST /api/cart/items` returns 2xx | the same guard as the add-to-cart conversion, which is unchanged |
| `purchase` | order confirmation | inside the purchase conversion's three guards (paid, once per page, once per order number); the purchase conversion now carries `items` too |

- **`id` is `product.sku` exactly as the API returns it.** We trim whitespace and never change case. We could not read the Merchant
  Center feed ourselves (no public URL), so the "`<g:id>` = `product.sku`" equality rests on your statement. If any feed row uses
  a different form, tell us.
- **Consent.** Same handling as the existing Ads calls (Consent Mode declares only `analytics_storage`, ERR-227). No new gate.
- **Measured locally** on `/p/GGI690KCMY`: one Ads-scoped `view_item` with `id: "GGI690KCMY"`. The Google tag transmitted it to Ads
  (4 outgoing requests carrying `view_item` and the SKU; the probe aborts them so it never joins an audience).
  **Negative control:** a `/shop` listing sent none (0 of 8 gtag calls).
- **Please check one thing in the Ads account.** If any conversion action is defined on the event *name* `purchase` (rather than the
  `W1laCPGzpJQcEMqwyJZD` label), it would now double-count purchases. We saw none in the code paths we own, but the account settings
  are yours.

## §5 BF-098 — `code=288XL` and "keep the whole family" contradict the live API

Measured on production: `/api/shop?brand=epson&category=ink&code=288XL&limit=200` returns **only the 7 XL rows**
(G288HYBK/C/M/Y, G288BXLCMY, G288HYCMY, G288HYKCMY). `code=288` returns 13 rows, each with `yield_tier` STD or XL.
So a request that "carries `code=288XL` unchanged" cannot also "keep the whole family". See the ERR-301 section for what the
page does now.

**Ask:** should `code=288XL` return the whole 288 family with XL first? If yes, the page can drop its second request.

`pack=value_pack` works as you said (`code=564`: 4 rows with it, 16 without).

## ERR-301 items (§1, §2, §3, §5, §6 product page, §8)

_Placeholder: the peer session that built these replaces this line with its measured results._

## §9 After the deploy

_Filled in after the push: deploy time, `probe:ad-clicks` against production, the real opt-in result._

## Not done, on purpose

- No price claims, no star ratings, no "guaranteed fit" wording.
- No page-speed work.
