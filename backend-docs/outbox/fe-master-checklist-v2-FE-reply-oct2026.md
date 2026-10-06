# FE reply: FE master checklist, 6 October afternoon re-issue (items 2, 6, 16, 17)

**From:** frontend · **Date:** 6 October 2026 · **Answers:** `FE-MASTER-CHECKLIST-oct2026.md` (your version with "Status after the live check of the FE deploy (6 Oct, afternoon)" and items 16, 17) · **Errors log:** ERR-309 · **Companion reply:** `fe-replies-6oct-backend-response-FE-reply-oct2026.md` (ERR-308, your answer to our eight replies)

## Deploy

| Commit | What | Live on www |
|---|---|---|
| `b2d07c0f` | ERR-307: items 14 and 15 | pushed 2026-10-06 12:32 NZT. **Your afternoon status lists 14 and 15 as "not started"; both were already live.** Your check ran on the earlier deploy. |
| _filled in at push_ | ERR-309: items 2, 6, 16, 17 | _filled in at push_ |

## Item by item (measured, not intended)

"Local" means a browser on `localhost:3000` against the production API, running `npm run probe:fe-master-6oct -- --record` (56 passed, 0 failed, 0 skipped). "Prod" means www after the deploy above; see the section at the end.

| # | Status | Measurement |
|---|---|---|
| 2 | **ON.** | `DARK_FEATURES.cartWallet: true`, as the owner decided on 6 Oct. Every shopper on `/cart` now gets the Express Checkout Element; `?wallet=1` is no longer needed. Your BF-100 answer shipped in ERR-308: a wallet address whose `state` matches no region is no longer refused. The order goes with `region` omitted and the 4-digit postcode alone, and a postcode that is not 4 digits is refused in the sheet. Please watch the first wallet charges in Stripe, as you offered. |
| 6 | **Done.** | Cause: our desktop layout rule (`order: 2` on the block that held the points line, ≥1100px) sent it to the bottom of the buy column. The line now sits **inside the price row**. Local, GLC3313BK at 1366×599 and 1280×551: price y 392, points y 404–424, Add 471–519 (the same as before the change), and Add is hit-testable. The wording is now "Earn 67 reward points ($0.67)", your item's own words. "… on this order" made the line wrap under the price and pushed Add down 24px at 1280×551 (measured), so we dropped it. |
| 14, 15 | Done in `b2d07c0f` (ERR-307) | Re-measured locally today: GLC3313BK 1→3 shows $67.49 struck through and $66.14 in the first qty-3 frame, then settles at $198.42 with −$4.05. 162 frames, 0 mixed. `test@gmail.con` is caught under the field and Continue is disabled. |
| 16 | **Done.** | "Our compatible version" sits under Add and the fit line, above Delivery/Returns. It shows only on a genuine product with `compatible_alternatives` (at most 3). Each card has the name, the price, "N pages" when `page_yield` is present, a "View" link to `/products/{slug}/{sku}`, and Add. Your warranty line (`trust_signals.warranty.compatible_label`) follows the cards. When `same_capacity` is false, the tier is compared with the genuine row's `yield_tier`: "XL — higher capacity" or "Standard — lower capacity". When either tier is unknown we print "XL capacity" only, never a guessed direction. There are no savings, percentages or OEM marks. Local: **GTN2030BK** shows CTN2030BK at $24.49, "1,000 pages", below Add, and Add is hit-testable at 1366×599 and 1280×551. **G604BK** shows C604XLBK, "XL — higher capacity". **G924CMY** and **CTN2030BK** show no box. |
| 17 | **Done.** | Every cart cap is now the line's stock (capped at 100; unknown stock keeps 100; stock 0 caps at 1). The stock comes from `items[].product.stock_quantity`. The deep link, the `/shop` and product cards, the PDP and the alternatives also hand it to the cart at add time. The PDP quantity box and the card steppers cap at stock too. Reaching the cap shows "Only 8 in stock — that is the most you can order." A refusal (`STOCK_INSUFFICIENT` with `details.available`, or the older thrown `BAD_REQUEST` with the same detail) shows the same message and records the stock on the line. It no longer says "Network error". Local, GDK11203WH (stock 8): 12 clicks of + stop at 8 and + is disabled; typing 28 becomes 8; the server holds ×8; the PUTs answered 200/200/200, with no 400. |

## What changes on your side

**New request patterns:**
- **`GET /api/products/:sku`, one per click on a compatible alternative's Add.** The `compatible_alternatives` rows carry no product `id`, so we resolve the SKU first (the same lookup `/cart?add=` uses). If you add `id` to each row, we can drop this request; that is the only ask in this reply. Nothing else depends on it.
- **Expect far fewer `400`s from `PUT /api/cart/items/:productId`.** We now send the clamped quantity: `updateQuantity` used to send the raw number even when it clamped locally. A remaining stock 400 means the stock fell after the cart was loaded.

**Contracts the storefront now depends on.** Please tell us before you change any of these:
- **Per cart line: `items[].product.stock_quantity`.** A missing value degrades to the old cap of 100; it never blocks.
- **Refusals:** `error.code: 'STOCK_INSUFFICIENT'` with `details.available` on `POST`/`PUT /api/cart/items`. We still read a thrown error that carries `details.available`.
- **`compatible_alternatives[]` fields:** `sku`, `slug`, `name`, `retail_price` (a row without a positive price is skipped), `page_yield` (we read it as a STRING such as "1,000"; a number also works), `yield_tier`, `same_capacity`, `image_url`, `in_stock` (false shows "Out of stock" and no Add button).
- **Product `yield_tier`.** It is the genuine row's tier, used for higher/lower.
- **`trust_signals.warranty.compatible_label`.** When it is absent, the line is omitted.

**Our test traffic in your logs on 6 Oct, roughly 22:30–23:45 NZT:**
- GLC3313BK and GDK11203WH were added to, re-quantified in and removed from probe guest carts. Each rollback was verified by re-reading the cart.
- **One guest cart still holds GDK11203WH ×1.** It came from a one-off shape check that hit your per-IP limiter (429) before its cleanup ran. It is an abandoned guest session with no email and no opt-in. Ignore it or purge it.
- Several 429s on `/api/cart*` and `/api/site/*` from one IP. These were our own probe runs back to back; the probe now pauses 60 s before the stock section.
- Two `POST /api/checkout/guest-prefill` per run: a 400 for `test@gmail.con`, then a 200 for `test@gmail.com`.

None of this reached `POST /api/orders`.

## Noticed, not in this checklist

- **The compatible PDP CTN2030BK at 1280×551:** Add sits at y 548–596, below the 551px screen. It was the same on www before this deploy (548–596). Part 2's first-screen rule holds at 1366×599 and above, and for the genuine pages measured here. Taller compatible titles push the buy box down. Tell us if you want it handled before the next re-check.

## How to re-run our side

```sh
npm run probe:fe-master-6oct                                   # READ-ONLY: §6, §16
npm run probe:fe-master-6oct -- --record                       # + §14 §15 §3 §9 §17 (own guest cart, verified rollback)
PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:fe-master-6oct -- --record
node --test tests/fe-master-checklist-v2-oct2026.test.js
python3 scripts/redproof-fe-master-v2-oct2026.py               # 25/25 mutations must go red
```
