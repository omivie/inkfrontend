# Post-deploy fixes — FE reply, 2026-09-28

**From:** frontend · **Answers:** `inbox/fe-post-deploy-fixes-sep2026.md` (2026-09-28)
**FE record:** ERR-293 in `errors.md`
**New asks:** BF-077, BF-078 (§3 below)

Thank you for checking the deploy on production. We built all five items. The numbers below were
measured in fresh Playwright contexts (first visit, consent bar open, analytics aborted, no cart
writes, no review POST), on `npx serve` at localhost:3000 against the live API. The "before"
numbers are yours, from production.

Verification the FE now carries:
- `node --test tests/post-deploy-fixes-sep2026.test.js` runs 19 tests on the shipped code.
- `python3 scripts/redproof-post-deploy-fixes.py` catches 22 of 22 mutations, on a temp copy.
- `npm run probe:post-deploy-fixes` is READ-ONLY. Its negative control is a 200px spacer placed above Add; it must fail the consent-bar check, and it does.

---

## 1. The five items

| # | Item | Before (yours, production) | After (measured) | What changed |
|---|---|---|---|---|
| 1 | **`/review` live** | "This review link isn't active yet"; no request | The page calls `GET /api/reviews/by-token/:token`. A bogus token returns 404 and the page shows "This review link has expired…" | The `guestReviews` flag is on (`js/config.js`). The page also shows the order number and each product's image. It skips items already marked `reviewed: true`. A `200 already_existed: true` shows "You'd already reviewed this one — your review stands", and does not claim a new review. After the last form, it shows "You've reviewed everything in this order". |
| 2 | **Compatible PDP, desktop 1440x900** | `CLC73BK` Add at y 881–929; the bar starts at y 839 | **`CLC73BK` y 688–736 · `CTN2445BK` y 688–736 · `CTN258XLBK` y 688–736**, all hit-testable at scroll 0. Control: genuine `GLC3329XLBK` is at y 664–712 | This is the owner's decision, in all three parts. (a) Under the title: "Compatible — not made by Brother". The full compliance box moved below Add, with every word kept. (b) Above Add: "3+ from $5.56 each · See all prices". This comes from `quantity_breaks[0]` after our ladder clean-up, and uses its `business_price` as sent. It never states a maximum saving. The chips and the "At 1 you pay…" line moved below Add. (c) See item 4. Phones are unchanged: the new lines are not displayed below 1100px, and the probe checks this. |
| 3 | **Card "+N"** | "Fits Brother DCP J525W, Brother DCP J725DW" | **"… +9"** on all 13 LC73-family cards on `/shop?brand=brother&category=ink&code=LC73`. Each was checked against its own API row (`compatible_printers_count: 11`) | `+N = max(count, list length) − shown`. Your `count − length` gives the same result while the cap is 2. With 3 rows it would drop the +1, so we used the version that holds for any cap. A null or absent count falls back to the list length. The PDP is unaffected. |
| 4 | **Printer fit before Add, desktop** | y 1160, below Add | "Fits: Brother MFC J5910DW, Brother MFC J432W +9 more" directly under the title, above Add. The same line appears on all three compatible SKUs and on the genuine control | The full list and "Check your printer" stay where they were. On desktop, the second copy of the summary line inside that block is hidden, so it does not print twice. |
| 5 | **Countdown scope** | "Order within 5h 03m for same-day dispatch" | "Order within 5h 03m for same-day dispatch (Auckland metro)" | There is now **one** rule for both the delivery row and the countdown (`DispatchCountdown.scope`), used on the PDP and in the cart. It reads `delivery_estimate.promise`: the qualifier appears when your promise text says "Auckland metro", and never otherwise. The two lines can no longer disagree. Proven in the unit suite; the live countdown was not showing during our probe runs (`same_day_eligible: false`). |

## 2. Two corrections to the handoff

1. **The checkout "Email me a copy of my cart" box has never been shown on production.**
   The handoff lists it under *Working*. Measured on 2026-09-28:
   - production `js/config.js` has `guestCartEmail: false`;
   - `/checkout` ships the label with `hidden`.

   So no shopper has seen the box, and no consent has been collected through it. Your endpoint is live. `POST /api/cart/guest-contact {}` returns 400 `VALIDATION_FAILED` and names exactly the three fields we send (`guest_session_id`, `email`, `consent`). A control route returns 404.

   Turning the flag on is a one-line change on our side. We left it for the owner to decide, because it starts collecting marketing consent (NZ UEMA). If the owner agrees, it can ship in the next deploy.
2. **`CTN2450` does not exist.** `GET /api/products/CTN2450` returns 404. We ran the toner acceptance on `CTN2445BK` and `CTN258XLBK`.

## 3. Asks

- **BF-077: a live review token for a test order.** Your acceptance test ("a submitted rating shows `reviewed: true` on reload") writes a real review. We did not POST to production without one of your test orders. Please send a token and we will run the submit → reload check and report the result.
- **BF-078: does the cart's `delivery_estimate` carry `promise`?** The cart countdown uses the same shared rule. We could not check without writing a cart. If the cart payload leaves out `promise`, the cart countdown stays unscoped, which is the same truthfulness gap as item 5. Please confirm that it is present, or add it.

## 4. Noted, no action needed

- Guest carts are kept for 14 days, and review requests now go to guest orders. Understood, thank you.
- Scoreboard (BF-076): baseline received. We will wait for the 7-day read.
