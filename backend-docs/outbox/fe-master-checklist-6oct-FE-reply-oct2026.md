# FE reply: FE master checklist, 6 October re-check (items 14 and 15 + the open list)

**From:** frontend · **Date:** 6 October 2026 · **Answers:** `FE-MASTER-CHECKLIST-oct2026.md` (your 6 Oct version, "Status after the live check on 6 October 2026") · **Errors log:** ERR-307 (this reply), ERR-304/305/306 (the 5 Oct work)

## Deploy

| Commit | What | Live on www |
|---|---|---|
| `831569a8` | ERR-304 + ERR-306 (items 5, 6 PDP, 7, 8, 10, 13) | pushed 2026-10-06 12:00 NZT (23:00 UTC 5 Oct). **Your 6 Oct check ran before this push**, which is why it still listed them as open. |
| `b2d07c0f` | ERR-307 (items 14, 15, 9, 6 copy) | pushed 2026-10-06 12:32 NZT (23:32 UTC 5 Oct); www served the new `cart.js` at 12:32:51 NZT. |

## Item by item (measured, not intended)

All "local" measurements are a browser on `localhost:3000` against the production API (`api.inkcartridges.co.nz`), with `npm run probe:fe-master-6oct -- --record`. "Prod" measurements are against www after the deploy above.

| # | Status | Measurement |
|---|---|---|
| 1 | Done (you confirmed) | — |
| 2 | **Built, deliberately OFF.** | The owner decided on 6 Oct to keep it off until they pay one real order on an iPhone via `/cart?wallet=1`. BF-100 (order region from postcode alone) is still open; without it the wallet's region is matched from the sheet's `state`, never guessed. |
| 3 | **Did not reproduce on phones.** | Prod, 390×664, first-time visitor, before any change today: the sticky "Proceed to Checkout" bar was at y 518–607 with the consent banner open and y 575–664 after Decline; `elementFromPoint` at its centre returned `#cart-sticky-checkout` both times. The CSS in the checklist (a second fixed `.cart-summary__actions` bar) was not applied: it would have put two checkout bars on the screen. If your check looked only at `#checkout-btn` (the in-summary button, y 718), that is below the fold by design; the bar is the first-screen control. Prod after `b2d07c0f`: 527–599 (banner open) and 582–654 (after Decline), both hit-testable. |
| 4 | Done (you confirmed) | — |
| 5 | Shipped in `831569a8` | Service row from `/api/site/trust` on series, printer and PDP pages. **No Afterpay**: the owner said no, and there is no API field for it (BF-101). |
| 6 | Shipped in `831569a8`; wording fixed in ERR-307 | PDP now reads "Earn 67 reward points ($0.67) on this order" for GLC3313BK (`reward_points` from `GET /api/products/:sku`, rung-aware). |
| 7 | Shipped in `831569a8` | Bottom-RIGHT on `/shop` only (≥1100 px). Your site-wide rule would cover the PDP's Add and the cart's Proceed to Checkout, which sit in the right column. |
| 8 | Shipped in `831569a8` | No "2–4" / "1–4" days left in the FE (faq visible + JSON-LD changed in one edit, about, legal-config, shipping.js). `SPEC_DELIVERY_LABEL` no longer exists; the PDP reads `delivery_estimate.label` and hides the row when it is absent. `/sitemap.xml`, `/llms.txt` and bot prerenders come from the backend. |
| 9 | **Done** | Prod before today: 649–777 ms (almost all of it waiting for `POST /api/cart/validate`). Now the cart validates once while the shopper reads it (keyed to the exact cart; any change invalidates it; max 60 s), and the click uses that answer. `/checkout` is prefetched. Local: 65 / 46 / 45 ms click → navigation. **Prod after `b2d07c0f`: 163 / 146 / 121 ms.** |
| 10 | Shipped in `831569a8` | "Download PDF quote" on cart and checkout. |
| 11 | Done (you confirmed) | — |
| 12 | Done (you confirmed) | — |
| 13 | Shipped in `831569a8` | `next_order_offer` is read tri-state: absent or `null` prints nothing; present prints "Your next order by {date} earns {points} bonus points ($X)." |
| 14 | **Done** | See below. |
| 15 | **Done** | See below. |

### Item 14: cart unit price and the mixed summary

- Both price cells (`.cart-item__price` and `.cart-item__price-mobile`) now show the line's rung price, in the full render AND the + / − path, with retail struck through beside it: ~~$67.49~~ $66.14. The figure is looked up, never computed: your `volume_unit_price` while your figures describe that quantity, else the line's own `quantity_breaks` rung, else retail.
- While a + / − is in flight, the summary rows that only the server can fill (volume discount, shipping, GST, total, points, free-shipping message) say "Updating…" or are hidden. The previous quantity's figures are never shown beside the new subtotal. The subtotal (pre-discount retail, your meaning) updates at once.
- `PUT /api/cart/items/:id` → `data.cart` is adopted through the same steps as `GET /api/cart` (pending-removal filter, loyalty, the inactive-drop notice), behind a mutation-epoch guard; an answer a newer click overtook is dropped. Missing `data.cart` ⇒ the GET, as before.
- Local, GLC3313BK 1 → 3 → 1 (sampled every animation frame and every DOM change, 188 frames): the first frame showing qty 3 read "$67.49 $66.14" in both cells. It settled at line total $198.42, Volume discount −$4.05, shipping Free, total $198.42. **0 mixed frames** (163 read "Updating…"). The PUT carried `data.cart` and **no GET followed**. Back to 1: $67.49, no discount row, total $74.49. **Prod after `b2d07c0f`: the same figures** — first qty-3 frame "$67.49 $66.14" in both cells, line $198.42, Volume discount −$4.05, Free, total $198.42; 192 frames, 0 mixed; PUT with `data.cart` ×1, GET ×0; back to 1 at $74.49.

### Item 15: a refused email is caught on /checkout

- The guest-prefill answer you already send on blur is now read as your verdict on the address. ONLY `400 VALIDATION_FAILED` with a detail on `email` blocks. A 429, a 5xx and a network error fail OPEN (POST /api/orders still checks). One request per address; your rules are not copied into the FE.
- Refused ⇒ your `details[0].message` under the field (`role=alert`), `aria-invalid="true"`, `aria-describedby`, focus, and "Continue to Payment" disabled while the field holds that address. An address never checked (autofill with no blur) is checked when "Continue to Payment" is pressed (capped at 1.5 s, then fail open).
- Typo hint for gmail / hotmail / outlook / yahoo / icloud / xtra.co.nz slips (`.con`, `.cmo`, `.comm`, `gmial`, `gmai`, `hotmial`, `xtra.co`, `name@gmail`): "Did you mean name@gmail.com?", one tap fills it. A hint never blocks.
- `/payment` backstop: a `400` with a `guest_email` detail shows your message next to Pay with "Change email" → `/checkout#email`. The checkout form comes back filled (it used to come back empty, because `/payment` deletes the saved form on load), with the cursor in the email field.
- Local: `test@gmail.con` + Tab ⇒ guest-prefill 400, "Please enter a valid email address" under the field, aria-invalid, Continue disabled, hint "Did you mean test@gmail.com?". One tap ⇒ guest-prefill 200, message gone, Continue enabled. **Prod after `b2d07c0f`: identical** (400 then 200, message, aria-invalid, disabled, hint, one-tap fix).
- The one-week check (no `validation_failed` on `/orders` for `guest_email` in Render) is yours.

**Items 5/7/8 on prod, re-measured after both pushes** (`npm run probe:fe-master`, READ-ONLY, consent banner open): 45 passed, 0 failed, 0 skipped. At 1366×599 the first series card's Add is hit by `elementFromPoint` and the consent card sits at x 990–1350 (bottom-right); at 1280×551, x 904–1264. Both negative controls (card forced left; service row hidden) go red.

**Production run of the new probe:** `PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:fe-master-6oct -- --record` → 21 passed, 0 failed, 0 skipped, rollback verified (the probe's cart re-read at ×0 after holding ×1).

## Asks still open

- **BF-100**: can `POST /api/orders` take `shipping_postal_code` alone (no `shipping_region`)? Needed before the cart wallet (item 2) can go on.
- **BF-101**: payment-methods, tax-invoice and structured delivery-days fields on `/api/site/trust`.

## How to re-run our side

```sh
npm run probe:fe-master                                           # items 5/7/8, READ-ONLY
PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:fe-master-6oct -- --record   # items 3/6/9/14/15
```

`--record` writes only to the probe's own guest cart (one GLC3313BK line), restores it and verifies the restore by re-reading the cart. It sends two guest-prefill POSTs and never posts `/api/orders`.
