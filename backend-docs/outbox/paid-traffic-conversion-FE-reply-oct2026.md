# FE reply: paid-traffic conversion (1 Oct): where each item landed, and one tracking leak fixed

**From:** FE developer · **For:** backend · **Date:** 2026-10-02
**Answers:** `paid-traffic-conversion-FE-handoff-oct2026.md` (1 Oct)
**FE record:** ERR-303 (this reply). §1 is ERR-301 and §2 is ERR-302, both answered in `ad-clicks-to-orders-FE-reply-oct2026.md`.

Your 2 Oct `ad-clicks-to-orders` checklist replaces this file as the work order, so this is a short pointer reply.

## §1 Add to Cart under the consent banner at 1366 × 768 → ERR-301

We reproduced it live before the fix (first visit, banner open, `CDR1070BK`):

| Element | Box at 1366 × 768 |
|---|---|
| Add to Cart | y 688–736 |
| "Empty fixed div" | `#google-reviews-badge` (Google's iframe, no text of its own), x 1270–1356, y 643–707. We had lifted it above the bar (ERR-233). |
| Consent banner | y 707–768 |
| `elementFromPoint` at the centre of Add | `consent-banner` |

ERR-301 moves Add directly under the price, turns the desktop banner into a bottom-left corner card, and stops lifting the badge.

Your acceptance line here is: "fully above the top edge of **every** fixed element" at 1366 × 768 and 1280 × 720. We cannot meet it literally with a corner card, which can start above Add's bottom edge without covering it. The owner accepted two conditions: no overlap with the card or the badge, and `elementFromPoint` returning the button. `probe:ad-visitor-dropoff` also prints your stricter vertical form as a separate line at six viewports, including 1280 × 720. That way your re-run and ours read the same numbers.

## §2 See our reviews on Google → ERR-302

The link is in the footer and in the PDP trust block. The URL comes from `/api/site/trust`. It is accepted only when it is https on a Google host. If it is absent, the link is hidden. It shows no stars and no count.

## §3 Microsoft UET tag → already live (ERR-278/279), plus one leak fixed (ERR-303)

- The tag `97269770` is on every storefront page. `bat.bing.com` is in both `script-src` and `connect-src`.
- The purchase event fires on order confirmation with `revenue_value` set to the order total including GST, currency NZD, and `transaction_id` set to the order number. It is inside the same three guards as the Google Ads purchase: payment succeeded, once per page load, once per order number.
- **Fixed today.** The admin dashboard loads the same script, and the UET loader had no admin check. Every staff visit to the dashboard was a Microsoft Ads pageview. It now skips `/admin*`. This is tested, including a mutation test, and was checked in a browser.

No owner action is needed for §3. The tag ID was already supplied.

## One question for you

The Google Analytics and Google Ads config lines also run on the admin dashboard. GA4 reports and the Ads "All visitors" audience therefore include staff visits.
- Does GA4 already exclude this traffic with an internal-traffic filter?
- Is the Ads "All visitors" list used for anything that staff visits would distort?

If the answer to both is no, we will skip those lines on `/admin` as well. We have not changed them yet, because doing so removes admin pageviews from GA4 history.
