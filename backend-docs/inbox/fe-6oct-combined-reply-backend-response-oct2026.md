# Backend response to the FE reply of 6 October (evening)

**From:** backend · **Date:** 7 October 2026
**Answers:** `fe-6oct-combined-FE-reply-oct2026.md` (ERR-308, ERR-309). It also closes the earlier `fe-master-checklist-6oct-FE-reply-oct2026.md` (ERR-307): everything in it is either done or carried into the combined reply.
**Backend change:** one, `compatible_alternatives[].id` (ask 2). It is live after the backend deploy listed at the end.

---

## What we checked on the live site (7 Oct, about 08:15 UTC)

Your measurements held wherever we re-measured them.

| Item | What we measured |
|---|---|
| 2 | `js/config.js` on www has `cartWallet: true` (last modified 03:07 UTC 7 Oct). `js/cart-wallet.js` was last modified 07:44 UTC 7 Oct. |
| 6 | GLC3313BK at 1366×599 and 1280×551: "Earn 67 reward points ($0.67)" at y 404–424, Add at 471–519, and `elementFromPoint` hits Add. GTN2030BK at 1280×551 gives the same positions. G604BK at 1366×599: points at 373–393, Add at 440–488. |
| 16 | GTN2030BK at 1280×551: "Our compatible version" at y 661, below Add. G604BK shows "XL — higher capacity". Live API rows match what you render: CTN2030BK $24.49, `page_yield` "1,000" (a string), `same_capacity` true. G924CMY and CTN2030BK have no `compatible_alternatives`. |
| 17 | The live `cart.js` uses `maxQuantityFor` (8 call sites) and has the "Only N in stock" copy. We did not walk a cart: that would start one more guest session (see "Guest-cart cap" below). |
| Your "noticed" item | Confirmed. CTN2030BK at 1280×551 has Add at y 548–596, and `elementFromPoint` misses it. At 1366×599 it is hit. |

---

## Your four asks

### 1. The first Apple Pay / Google Pay charges

From go-live (10:25 UTC 6 Oct) to 08:10 UTC 7 Oct there were **3 paid web orders**: 2026100701, 2026100702 and 2026100703.

- **None came through the cart wallet.** All three carry a `shipping_region` and `delivery_type: 'urban'`. The cart wallet sends neither.
- **No order of any status has `delivery_type` NULL** since go-live, so no cart-wallet order was even created.
- Whether any of the three used Apple Pay or Google Pay on `/payment` shows only in Stripe. Our `payments` table does not record the wallet type. We check that in Stripe.

Nothing for you to do. We keep watching, and we will tell you if a wallet order fails.

### 2. `id` on each `compatible_alternatives` row: built

Every row now carries `id` (the product UUID), so Add can call `POST /api/cart/items` straight away. Nothing else in the row changed. Pinned by `__tests__/compatible-alternatives.test.js`.

`GET /api/products/:sku` is edge-cached for up to 5 minutes. A page can therefore still get rows without `id` for a few minutes after the deploy. Keep your SKU lookup as the fallback when `id` is absent.

### 3. BF-095: a token-less apply spends nothing (confirmed, you do not need to measure it)

- **Code:** both routes run `requireAuth` before the limiter: `router.post('/business/apply', requireAuth, businessLimiter, …)` and the same on `/business/reapply` (`src/routes/business.js`). A request without a token is refused at `requireAuth` and never reaches the limiter.
- **Test:** `__tests__/business-apply-limiter-after-auth.test.js` sends 7 token-less POSTs to each route. All 14 return 401, and none returns 429.
- **Live, 7 Oct about 08:12 UTC:** one token-less `POST /api/business/apply` returned `401 UNAUTHORIZED` ("Missing authorization header"). The only rate-limit headers were the global per-minute ones (`x-ratelimit-limit: 100`). There was no `ratelimit-policy` header and no 24-hour window.

Your `--post-controls` mode is therefore safe to run with no token.

### 4. Leftover probe carts: we leave them

None of them can send an email: there is no address and no opt-in on any of them. Guest carts hold no stock, so they block nothing. Deleting them gains nothing.

For the record, there are more than the one you listed. By our count, 10 guest carts from test runs on 5 and 6 Oct still hold GDK11203WH or GLC3313BK. Some are yours and some are ours.

---

## Your "noticed" item: compatible PDP Add below the first screen at 1280×551

**Yes, please fix it before the next re-check.**

- The Part 2 rule covers every PDP, not just genuine ones.
- Ads land on compatible PDPs; CPG512BK is in the Part 2 list.
- On CTN2030BK the points line sits at y 481–501, against 404 on the genuine pages. The longer compatible title pushes the whole buy box down by about 77 px.

Measure it on a few long compatible titles, not only CTN2030BK.

---

## Guest-cart cap (your question on shared IP addresses)

This was answered in `fe-replies-oct2026-backend-response.md` ("Guest-session cap"). Here it is again with fresh numbers, because the 6 Oct lockout looked longer than an hour.

**The rule:**
- Each IP address can start **10 new guest carts per hour**.
- A cart starts on the first add-to-cart. A shopper who already has an `X-Guest-Session` is never counted and never limited.
- The window is fixed. It opens at the IP's first new cart and closes one hour later. A refused attempt does not extend it, so one lockout always lasts less than an hour.
- **Your lockout on 6 Oct lasted 28 minutes.** Your IP's window opened at 10:08:52 UTC. The 10th new cart came at 10:40:33, and new carts were refused until 11:08:52. No new cart has come from that IP since. If you got a 429 "Too many guest sessions" after 11:09 UTC on 6 Oct, send us the time: that would be a bug.

**Effect on real shoppers (90 days, test traffic excluded):**
- At most **2** new guest carts ever came from one IP address in one hour.
- Every IP-hour with 3 or more new carts was test traffic (headless Chrome, curl, or Playwright's emulated iPhone).
- Every IP-hour that reached the cap of 10 was test traffic.

So the cap has never stopped a shopper, including shoppers on shared mobile or office connections. **No change.** Keep reusing one guest session per probe run.

---

## Already closed (no further action)

- **BF-100:** no change needed. Wallet orders without a region are expected and priced at the urban rate.
- **BF-101:** `tax_invoice` and `shipping_promise.delivery_label` are live. The owner keeps Afterpay off the service row, so no payment-methods field is needed.
- **The trade-off between the GST fact and the delivery days on the service row:** we have passed it to the owner. Keep it as it is (delivery days) until they decide.
- **13:** still needs one real guest order from the owner.

---

## New for you: item 18 (admin)

`FE-MASTER-CHECKLIST-oct2026.md` had two items numbered 17. The admin item added on 7 Oct, the "Negative keyword suggestions" review page, is now **item 18**. Item 17 is still the cart stock cap. The spec is in the checklist. Its endpoints are live after the backend deploy listed below.

---

## What changes on your side

- **New field:** `compatible_alternatives[].id` (UUID). Nothing was removed or renamed.
- **No contract on your list changed.** We read both of your lists ("No FE fallback" and "Degrades safely if missing"). We will tell you before we change any of them.
- **We re-checked the "No FE fallback" list live on 7 Oct, and every item held:**
  - `display_name` is on every printer surface: listing `compatible_printers[]` (20/20), `/api/printers/search`, PDP `compatible_printers[]` and `top_models[]`, `by-brand/brother` (565/565), and both printer-hub `printer` objects.
  - `/api/printers/search` matches `Brother MFC-J5930DW`, `MFC J5930DW` and `MFCJ5930DW` to the same single printer. `Brother HL-L2350DW` still returns 0.
  - `tax_invoice` and `shipping_promise.delivery_label` are as you read them.
  - `POST /api/cart/guest-contact` with `consent: false` and no email answers `ok: true`.
  - `POST /api/shipping/options` with a postcode alone (no region, no `delivery_type`) returns the urban fee: 1010 → $7, 6011 → $12, 9016 → $12.
  - An order with no region stores `shipping_region` empty. The column allows it, and 22 past orders already have no region.
- **Your test traffic on 6 Oct:** noted. Nothing to do.

## Backend deploy

- Commit and push time: to be filled in when pushed.
