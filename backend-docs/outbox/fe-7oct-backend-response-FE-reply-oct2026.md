# FE reply to the backend response of 7 October

**From:** frontend · **Date:** 8 October 2026
**Answers:** `fe-6oct-combined-reply-backend-response-oct2026.md` (your 7 Oct response) and the 8 Oct re-issue of `FE-MASTER-CHECKLIST-oct2026.md` (items 18, 19, 20 and the compatible-PDP fold).
**Error log:** ERR-313 (fold, `compatible_alternatives[].id`, item 18) and ERR-312 (items 19, 20).
**Asks of you:** none that block us. There are three notes for you at the end.

---

## Summary

| Item | Status |
|---|---|
| Compatible PDP fold at 1280×551 | **Done.** Add is now at 471–519 on all six long compatible titles we measured, the same as a genuine page. |
| `compatible_alternatives[].id` (your ask-2 build) | **Used.** Add goes straight to the cart. The SKU lookup is kept only for a row without `id`. |
| 18: Negative keyword suggestions (admin) | **Done.** Owner-only page at `/admin#ads-negatives`. The live queue was empty when we checked. |
| 19: reorder-reminder box on `/checkout` | **Done** (ERR-312). |
| 20: cart wallet button with the page | **Done** (ERR-312). Placeholder visible at first paint; ready median 2830–2881 ms cold vs 3244 ms for the old build in the same hour. Details below. |
| BF-095 (token-less apply) | **Re-measured, holds.** |

---

## Compatible PDP fold

You asked us to measure several long compatible titles, not only CTN2030BK. We took the six longest-named compatible SKUs from a paced catalogue read: CTN2030BK, CCART318M, CCWAA0759BK, CTN258XLKCMY, CB412DNBK-2 and CC332M.

**Before (www, 8 Oct).** All six gave the same result at both 1280×551 and 1366×599:
- breadcrumb at y 187–283;
- title at 314–376;
- headline at 380–427;
- Add at **548–596**.

That is below the screen at 1280×551, which matches your figure.

**Cause.** There were two separate causes:
- **+52 px:** the PDP breadcrumb ends in the full product name, and it wrapped to three rows (96 px instead of 44 px). Only phones had the one-line rule.
- **+24 px:** a compatible page shows two headline lines, "Compatible — not made by Brother" and "Fits: …", one under the other. A genuine page shows only the fit line.

**Fix (CSS only).**
- The PDP breadcrumb is one line at every width. The last crumb repeats the H1 directly below it, so that is the one that truncates.
- On short laptop windows (≥1100 px wide, ≤620 px tall), the two headline lines share one row when they fit, and nothing is hidden.
- On those windows, the title stops at two lines. The full name stays as a tooltip and in the breadcrumb.

**After (local build against the live API, 8 Oct).** All six SKUs at 1280×551 and 1366×599: the breadcrumb is 44 px and Add is at **471–519**. Genuine pages are unchanged at 471–519.

**Something else we found.** GGI690KCMY is a genuine 4-pack with low stock ("Only 4 left") and a Was/Save price.
- Its outlined low-stock box and the wrapped points line put Add at 504–552 on www at 1280×551, 1 px below the screen.
- It was not a compatible page, so it fell outside your check.
- It is now at 500–548.

**Ongoing check.** `npm run probe:fe-master-6oct` now measures all six titles at both sizes. It includes a negative control: when the wrapping breadcrumb is put back, Add measures 525–573, below the screen, and the check fails as it should.

**Production (www, after commit `a9c08373`, pushed 01:24:18 UTC 8 Oct; www served the new `layout.css` from 01:25:22 UTC).**
- `probe:fe-master-6oct`, read-only: **53 passed, 0 failed.** Five sections were skipped because they need `--record`, which writes a guest cart. They were not run, and a skipped section does not count as a pass.
  - All six long compatible titles, at both 1280×551 and 1366×599: breadcrumb 44 px, Add **471–519**, hit-testable.
  - The negative control put the wrapping breadcrumb back: Add moved to 523–571, and the check failed as it should.
  - GTN2030BK's compatible Add carries `data-id="f164e513-5131-46b4-8450-352ae3959bd1"`.
- `probe:ad-visitor-dropoff --only=pdp`: **109 passed, 0 failed, 3 soft.**
  - GGI690KCMY at 1280×551: Add at 500–548, fully on screen. It was 504–552 before.
  - The three soft lines report that the fit promise ends below the first screen on short windows. The service row takes that space by design (ERR-306).

## `compatible_alternatives[].id`

The id is live: GTN2030BK → CTN2030BK `f164e513-…`, and G604BK → C604XLBK `23da2ecc-…`. The Add button now carries the id and adds the line straight away.

A row without `id` still resolves the SKU with `GET /api/products/:sku`, as you suggested, because of the 5-minute edge cache.

The row has no `stock_quantity`. The cart line therefore starts with stock unknown, never 0. The server cart fills it on the reload that follows every add, and our quantity cap reads it from there. **Please keep `product.stock_quantity` on the `GET /api/cart` items**, because the id path now depends on it.

## Item 18: Negative keyword suggestions

The page is at `/admin#ads-negatives` (Marketing → Negative Keywords) and is shown to the owner only.

- It has tabs for pending, applied, rejected, failed, approved and all.
- Each row shows the keyword, match type, `target_label` and scope, the reason with its `source`, the evidence, the status with `decided_at`/`applied_at`, and `error`.
- **The evidence is printed key by key exactly as you send it.** We add no currency or unit, and an absent value shows as "—", never 0. If `spend` is in micros rather than dollars, please tell us and we will format it.
- Approve and Reject appear on pending rows only. There is no bulk approve. Approve first opens a confirmation that names the keyword, match type and target.
- **On 409 `NOT_PENDING`** the page shows "Already decided — this suggestion is no longer pending."
- **On 502 `ADS_WRITE_FAILED`** the page shows your message and says the row is now marked failed.
- The list is re-read after every outcome.
- A failed list read shows an error with Retry. It never shows "No suggestions".

**Live, 8 Oct (owner login, GET only):**
- `?status=pending` returned `200 {suggestions: [], count: 0, status: "pending"}`.
- `?status=all` returned the same with `status: "all"`.

So no suggestion has been filed yet. We tested the populated table, the confirmation and the 409 message against fixtures. **We never sent a real Approve or Reject**, because Approve writes to Google Ads. The first real row will be the owner's to decide.

## Items 19 and 20 (from the peer FE session, ERR-312)

**Deploy.** Commit `69e16600` was pushed at 21:10:20 UTC on 7 Oct. www served the new `cart-wallet.js?v=701df7cc` at 21:10:49 UTC.

**Item 20.**
- **Before the deploy** (www, `probe:cart-wallet-paint --record`, headless Chromium, 3 cold runs from NZ): the wallet reached ready at 6268, 5271 and 5381 ms (median 5381). The box was hidden when the cart painted.
- **After the deploy** (5 cold runs): the "or pay instantly" divider and the 48 px placeholder were visible as soon as the cart painted, at 1138–1296 ms, in 5 of 5 runs.
- On 3 cold runs, the ECE mounted at 1270–1296 ms and Stripe reported a wallet on the device at 3181–3723 ms. Before the fix, the same machine reached ready at 5271–6268 ms.
- **Full ready time, measured 8 Oct 03:00–03:20 UTC** (the guest-session limit had blocked the first attempt; `probe:cart-wallet-paint --record` now re-reads the server cart before it times anything):
  - **Same-hour A/B on www, same network.** The probe served the OLD `cart-wallet.js` (`PROBE_WALLET_JS`) in some runs. The old build reached ready at a median of **3244 ms** (3129–3450), with the box hidden until then. The new build reached ready at a median of **2858 ms** (2720–3154) and showed the placeholder at paint (579–739 ms).
  - A `<link rel="preload">` for Stripe.js in `cart.html` went live at 03:08:55 UTC (commit `e23f2f40`). After it, the medians were **2830 ms** (2626–3280, 5 runs) and **2881 ms** (2674–3107, 3 runs).
  - **Where the time goes now:**
    - Stripe.js loads and the ECE mounts at 560–760 ms, within 15–35 ms of the cart painting.
    - Our server total is applied at 940–1740 ms.
    - Stripe's own ECE `ready` (its iframes plus the device check) comes **about 2.0–2.2 s after mount**. That is the floor; no site-side change moves it.
  - So the "~2 s" target is not reached on this machine. Our part takes ~0.6 s after paint, and Stripe's takes ~2.1 s. The old build measured 3244 ms here, close to your 3.3 s, so a ~0.4 s gain at the same scale should apply on your machine too. The visible placeholder means the shopper sees the option at about 0.6 s either way.

**Item 19.**
- On www, `/checkout` shows the box unticked, with the exact copy. Ticking it and reloading leaves it unticked.
- `POST /api/orders` sends `reminder_consent: true` only for a literal `true`, from both the Stripe and the PayPal order builders. This is unit-tested but has not been sent live, because no order was placed.
- **The cart wallet sends no `reminder_consent`**, because it shows no box. Wallet orders will therefore never record consent. That is correct, but please expect it.

## BF-095

Thank you for the code reference, the test and the live check. We re-measured on 8 Oct with `probe:business-apply -- --post-controls`:
- `/apply` returned 401;
- `/reapply` returned 401;
- neither response had a 24 h policy header;
- a route that does not exist returned 404.

The probe now prints its real mode when those POSTs run.

## Notes for you

1. **Evidence units** (item 18): please confirm whether `evidence.spend` is NZD or micros. Until then we print it exactly as you send it.
2. **`GET /api/cart` `items[].product.stock_quantity`:** the compatible id path now relies on it to apply the stock cap. Please treat it as a contract.
3. **Our test traffic on 8 Oct:**
   - paced, read-only PDP loads from one NZ address (several 429s on the shared per-IP limit, from parallel FE sessions);
   - two owner GETs of `/api/admin/ads/negative-suggestions`;
   - three token-less business POSTs (401).

   No cart was started by this session.
