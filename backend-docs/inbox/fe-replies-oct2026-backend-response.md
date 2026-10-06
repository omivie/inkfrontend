# Backend response to the FE replies (6 October 2026)

**Answers** the eight FE replies of 29 Sep – 5 Oct 2026: `fe-master-checklist-FE-reply-oct2026.md`, `ad-clicks-to-orders-FE-reply-oct2026.md`, `backend-audit-FE-reply-oct2026.md`, `cro-search-quote-points-FE-reply-oct2026.md`, `paid-traffic-conversion-FE-reply-oct2026.md`, `business-apply-FE-reply-sep2026.md`, `round2-backend-response-FE-reply-sep2026.md`, `turnaround-fixes-FE-reply-sep2026.md`.

**Live check:** www as deployed on 6 Oct (~23:15 UTC 5 Oct), first-time visitor, consent banner open. Results are in `FE-MASTER-CHECKLIST-oct2026.md`, "Status after the live check of the FE deploy (6 Oct, afternoon)".

**Backend changes:** live after the deploy of this commit. Each has a test.

---

## Asks answered

### BF-094: `display_name` on listing and finder rows (built)

- `GET /api/shop` / `GET /api/products` listing rows: every `compatible_printers[]` entry now carries `display_name` beside `full_name` and `slug` (`attachPrinterSummaries`).
- `GET /api/printers/search`: every row now carries `display_name`.
- Both use the same `printerDisplayName()` as every other printer row, so you can delete your mirror of the name rule.

### BF-095: business apply (built, except the credit reference)

1. **`can_apply`** is now present on every `/api/business/status` answer. The approved branch was the only one missing it; it is `false` there. `personal` → `true`, `rejected` → `true`, `pending` → `false`, suspended/closed → `false`.
2. **Rate limit:** the 5-a-day limiter on `POST /api/business/apply` and `/reapply` now runs AFTER sign-in. It counts per signed-in user, and an unauthenticated request is refused with 401 without spending anything. Several applicants on one office connection no longer share 5.
3. **409 codes:** `ALREADY_APPROVED` and `APPLICATION_PENDING`, on both routes.
4. **`POST /api/business/credit-reference`: do not build the step yet.** It takes `multipart/form-data` with one field, `file` (PDF, JPEG or PNG, at most 5 MB), and returns `{ url }`. But it stores the file in a private bucket and returns a public URL, which does not open. No file has ever been uploaded. We will fix it if the owner wants a trade-references step.

### BF-096: `/api/printers/search` ignores separators (built)

- New column `printer_models.search_key` (migration 199, applied): the full name upper-cased with every non-alphanumeric removed. The route builds the same key from the query and matches it as a substring, beside the old typed-text match.
- `Brother MFC-J5930DW`, `MFC J5930DW` and `MFCJ5930DW` all find the printer. So do `Epson XP-2100`, `HLL 3210CDW`, `DCP-J1050DW` and `Fuji Xerox Docuprint CM305 df`. Each of your failing examples matched exactly one active printer by this key before we shipped.
- You can delete `finderSpellings` and its second request.
- **Your b1934f3 question:** that commit changed `src/utils/searchVariants.js`, which `/api/search/smart` uses. It never touched `/api/printers/search`. BF-096 covers that one now.

### BF-097: /genuine-vs-compatible (you were right)

Our handoff was wrong. The backend does build this page (`GET /api/prerender/static/genuine-vs-compatible` returns 200), but your middleware never sends bots to it, so nobody is served it. Googlebot and browsers both get your static page, so there is nothing to mirror. Keep your banned-phrase test.

### BF-098: `code=288XL`

Keep it as it is. `code=288XL` is an exact tier filter, and ad landing pages rely on that. Your two-request merge is correct. A one-request alternative: ask for `code=288` alone (it returns both tiers with `yield_tier`) and sort XL first yourself.

### BF-099: withdrawing cart-reminder consent (built)

`POST /api/cart/guest-contact` now accepts `{ guest_session_id, consent: false }` (email optional). It clears `contact_email` and `contact_consent_at` for that session, so no reminder is sent. As with opting in, the body's session must equal `X-Guest-Session` (400 `GUEST_SESSION_MISMATCH` otherwise). Send it on untick.

The real opt-in you made is recorded: `guest_sessions.contact_consent_at` = 2026-10-02 04:10 UTC. There are 2 consents in total.

### BF-100: wallet orders without a region (no change needed)

1. **Yes, send the postcode alone.** `shipping_address.region` is optional. The shipping zone comes from `postal_code` first, in `POST /api/orders` exactly as in `/api/shipping/options`. The order is stored with `shipping_region` empty. `city` and a 4-digit `postal_code` are still required.
2. **Omitting `delivery_type`:** the order is priced at the URBAN rate for the postcode's zone, and `orders.delivery_type` stays NULL ("not stated"). `estimated_shipping` is read for logging only; the backend always prices shipping itself. Ask `/api/shipping/options` without `delivery_type` and the sheet shows the same urban figure the order will charge. A rural wallet address therefore pays the urban rate. That is accepted.

### BF-101: three facts for the service row (two built, one not)

1. **Payment methods: not built.** The owner chose to leave Afterpay off the row (5 Oct). For the record: Stripe does offer `afterpay_clearpay`, `klarna` and `link` on the payment step today (a live PaymentIntent on 6 Oct listed `card, afterpay_clearpay, klarna, link`). If the owner wants it on the row, ask and we will add a field.
2. **`tax_invoice`** on `GET /api/site/trust`: `{ emailed_with_every_order: true, label: "GST tax invoice emailed with every order" }`. It is `false` / `null` when no GST number is configured. Read it instead of `organization.gst_number`.
3. **`shipping_promise.delivery_label`** (plus `min_days`, `max_days`) on `GET /api/site/trust`: "1–3 business days NZ-wide", 1, 3. They come from the same source as a product's `delivery_estimate.label`. You can add "· most of NZ in 1–3 business days" on series and printer pages.

### Guest-session cap

Each IP can start 10 new guest carts per hour. A session starts on the first add-to-cart only. The window opens at the first new session and is stored in the database, so it holds across instances. Only a NEW cart counts; a shopper who already has a session is never limited by it.

In the last 30 days the cap was reached twice. Every IP-hour with 6 or more new sessions was test traffic: emulated iPhone OS 15 (Playwright's device profile), curl, and your office. No change. Keep reusing one session per probe run.

### GA4 and Ads tags on `/admin` (your question)

Please skip both on `/admin`. Admin pageviews have no analytic value. Staff visits currently join the Ads "All visitors" list, which feeds the Display remarketing campaign and our 3-day "recent visitors" exclusion. Losing the admin pageview history in GA4 is fine.

### Ads `purchase` double count (your question)

No action. The account has one primary purchase conversion (the webpage tag with its label). "Shopping Cart" is a codeless, secondary action and is not counted in conversions. No conversion action is defined on the event name `purchase`.

---

## Still open on the FE side

From the live check (detail in the checklist):
- **6, PDP:** "Earn 58 reward points ($0.58) on this order" renders, but at y 1183 on 1366×599 (price at y 418, Add at y 497). Your reply says it shares the free-shipping line above Add; live, it sits about 765 px below the price. It should be near the price.
- **14:** the cart unit price still shows retail once a volume rung applies, and `updateQuantity` still re-reads `GET /api/cart` instead of adopting `PUT`'s `data.cart`. Item 14 was added on 6 Oct, after your reply.
- **15:** checkout still lets `test@gmail.con` through to Pay. Item 15 was added on 6 Oct, after your reply. It is P0: it nearly lost a $486.81 order that morning.
- **2 and 13:** built. They need the owner's real test (Apple Pay with `/cart?wallet=1` on an iPhone; one real guest order for the account box).
