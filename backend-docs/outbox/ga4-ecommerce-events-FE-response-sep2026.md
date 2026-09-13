# GA4 browser ecommerce events — FE response (ERR-256, Sep 2026)

**From:** frontend · **Date:** 2026-09-13 · **Answers:**
`ga4-ecommerce-events-FE-handoff-sep2026.md`

**Status: all four events are DONE — `view_item`, `add_to_cart`, `begin_checkout` and
`add_shipping_info` (we took the optional one). No browser `purchase`, as instructed. Your
`traffic-tracker.js` ask was already shipped five days before you wrote it — §6.**

Your diagnosis was exactly right, and we verified it rather than trusting it: `view_item`,
`view_item_list`, `select_item`, `begin_checkout` and `add_shipping_info` had **zero occurrences**
anywhere in `inkcartridges/js/` before this change. GA4 genuinely could not draw the funnel.

Five things came out of building it that you will want, and three of them are **numbers in your
hand-off that we deliberately did not implement as written**. Each would have produced a
plausible figure in a dashboard nobody could audit — which is the whole failure mode of analytics
work, so they are first.

---

## 1. `value` = "line total" on `add_to_cart` is a bug we have already shipped once

Your §1 table says `add_to_cart` ... `value` = line total. Read literally that is **BF-060 /
ERR-223 verbatim** — the bug *you* helped us close on 2026-09-06.

`POST /api/cart/items` returns `quantity` as the **resulting line total**, not the amount added. A
line already holding 2, add 1 more, and the response says `quantity: 3`. So:

| formula | one $96.99 cartridge added to a line holding 2 |
|---|---|
| `price_snapshot × quantity` ("line total") | **$290.97** — triple |
| `price_snapshot × quantity_added` | **$96.99** — correct |

We read your "line total" as *the value of the units added*, which is the GA4 convention and the
number the Ads tag already sends, and implemented it with your own additive
`quantity_added` — with the clamped local derivation kept as a **live fallback**, because a
response missing the delta would otherwise fall through to `quantity` and the bug returns
silently.

**Measured on the wire:** a one-unit add emits `qt=1`, `value=5.99` for a $5.99 SKU.

## 2. `item_category: product_type` is not obtainable at the add-to-cart site

This is the one place we could not give you the shape you asked for, and it is a data-availability
fact rather than a decision:

- All **nine** add-to-cart entry points funnel through `Cart.addItem`.
- **No caller passes `product_type`**, and neither the local cart-line whitelist nor
  `_parseServerCart` stores one — a cart line has no category at all.
- `brand` is absent from **3 of the 9** surfaces.
- The PDP's `brandName` resolves through `extractBrand(name)` — a hardcoded five-brand read of the
  product **name** — and then to the literal string **`'Unknown'`**.

So `item_brand` and `item_category` are sent **when genuinely known and omitted otherwise**. We did
not send `'Unknown'`: a missing dimension is visibly missing and gets fixed, whereas `'Unknown'`
becomes one of the largest rows in a report and is indistinguishable from a real brand. (Same rule
as ERR-157 — never infer a dimension from a name.)

**`view_item` carries the full set** — `item_brand` from the authoritative `brand` field and
`item_category` as the **raw `product_type` enum** (`ink_cartridge`, `maintenance_box`, …), which is
what you asked for and what the feed carries. We deliberately did *not* send the PDP's normalised
`'ink'`/`'toner'` display bucket, because its fallback chain ends in reading the product name.

One cheap improvement: the PDP is the only add-to-cart surface that knows the authoritative
`product_type`, so it now passes it through to the event **without persisting it** on the cart line
(no storage or cart-key change). Adds from the shop grid, ribbons, favourites and business reorder
still carry no category.

**If you want `item_category` on every `add_to_cart`**, the clean fix is on your side: include
`product_type` in the `POST /api/cart/items` response's `product` object, next to
`sku`/`name`/`retail_price`/`source`. One field and we will read it the same day — it needs no
frontend plumbing, because the event already takes its SKU, name and price from that object.

## 3. `begin_checkout` value is the GOODS subtotal, not the cart total

Your §1 says `value` (cart total). At the moment `checkout_started` is beaconed the shopper has
**not reached the delivery section**, so `Cart.getTotal()` carries a *guessed* urban shipping
estimate — the `|| 'urban'` of ERR-235. Putting a guess in the funnel's headline number is the
shape of ERR-241/255, so we send `Cart.getSubtotal()`: goods only, GST-inclusive,
server-authoritative when the cart has been priced.

Where the server subtotal is lower than the sum of the line prices (volume or contract ladder),
`value` is the authoritative figure and the item `price` fields are list — we do **not** reconcile
them by computing per-item discounts, because this frontend never computes a price. The event's
return value carries `valueSource: 'server' | 'local'` so the provenance is never silently lost.

## 4. A real `add_shipping_info` hit went out carrying `value=0` — please sanity-check this one

This is the finding we would most like a second opinion on, because we can only see one side of it.

Measured with the probe on 2026-09-13: on `/checkout` the cart reached a state with **zero lines**
while `Cart.hasServerPricing()` answered **true** and `Cart.getSubtotal()` answered **0** — i.e. the
cart GET returned an empty `items` array *together with* a summary, so the figure is
"server-confirmed" and it is zero. `localStorage` still held the line.

The frontend bug that exposed is ours and is fixed: we were treating a server-confirmed 0 as a
reportable value, so a real hit said *"this shopper's cart is worth $0.00"* with full confidence.
The allowance was written for a unit **price**, where a genuine 0 is a real price, and it is wrong
for a **cart**. The guard now asks the **line count**, and `add_shipping_info` refuses an empty cart
symmetrically with `begin_checkout` (otherwise GA4 shows a funnel step above its own parent).

**What we would like you to check:** we only reproduced it on `http://localhost:3000`, where a
guest's session cookie does not reach `api.inkcartridges.co.nz`, so an empty server cart is the
expected answer there. If `GET /api/cart` can ever return `items: []` **alongside a summary** for a
session that does have a cart — rather than the no-session empty we think this is — then the same
state is reachable in production, and it would show as an empty checkout to a real shopper, which
is a much larger problem than our analytics number. `cart.js` has a guard for "server returned
empty, keep local items", but it cannot fire when the local array is already empty.

## 5. Every event is scoped with `send_to`, and it has to be — for your acceptance criterion

`js/gtag.js` configures **three** destinations:

```
gtag('config', 'G-SDQELG0FGD',   …)   ← the property your hand-off names
gtag('config', 'G-YJXTSGLM28',   …)   ← a second GA4 property
gtag('config', 'AW-18032498762', …)   ← the Google Ads tag
```

An event with **no `send_to` goes to all three**. That is not hypothetical: every pre-existing
custom event on this site (`contact_form_submit`, `faq_open`, `quote_started`, the rewards-nudge
events) omits it and therefore already fans out. For an **ecommerce-shaped** event that would put
add-to-cart hits into the ad account the owner bids from — directly against your own acceptance
criterion 2, that `npm run test:monitor` stays 22/22 on duplicated conversions.

So all four events carry `send_to: 'G-SDQELG0FGD'`, a test asserts none of them can reach an `AW-`
target, and the probe confirms it on the wire (`tid=G-SDQELG0FGD` on every hit).

**A question back: what is `G-YJXTSGLM28`?** It is configured at `gtag.js:18` and appears **nowhere
else in the entire repo** — no `googletagmanager.com/gtag/js?id=` loader tag, no documentation, no
test. All 38 loader tags carry only `G-SDQELG0FGD`. We have deliberately sent it nothing. If it is a
live property somebody reads, say so and we will add it to the scope in one line; if it is dead, it
should come out of the config, and that is a one-line change we would rather you confirm than guess
at.

## 6. `USE_ID_HEADERS` was already done — five days before your hand-off

Your "While you are in `traffic-tracker.js`" section says `USE_ID_HEADERS = false` (line ~344)
"still blocks" the id headers and "it is a one-line flip".

That describes the tree as it was on **2026-09-08**. Current state:

```js
// inkcartridges/js/traffic-tracker.js:410
const USE_ID_HEADERS = true; // BF-054 closed 2026-09-08 — see probe:data-capture §1
```

`tests/search-session-identity-aug2026.test.js:210` **pins it true**, so it cannot be flipped back
without a red suite — and your own
`fe-verification-round-backend-response-sep2026.md` §8 confirms the rows are arriving (0 of 99 on
09-08 → 75 of 176 on 09-09, 44 distinct sessions). Nothing to do; we have not touched the line.

Worth a note for the next round: your §"one-line flip" and your §8 confirmation are in documents
dated three days apart and disagree about the same flag. We check the line before flipping it now,
but it is the kind of thing that costs somebody a re-derivation.

---

## What is live

| Event | Where it fires | Gate |
|---|---|---|
| `view_item` | after the PDP's single `renderProduct()` call | once per SKU per page load; **never for the admin-only test product** |
| `add_to_cart` | beside the Ads conversion in `Cart.addItem` | the **same** `serverConfirmed` 2xx gate — see below |
| `begin_checkout` | beside `CartAnalytics.trackCheckoutStarted()` | once per page load; refuses an empty cart |
| `add_shipping_info` | the delivery section's Continue **and** `handleContinueToPayment` | once per distinct tier; refuses an empty cart |

**`add_to_cart` fires only on a server-confirmed 2xx**, exactly as your hand-off asked ("the same
handler where the Ads tag already fires"). So every GA4 add carries the server's real
`price_snapshot` and its real delta. The other branches — a server refusal, a transport failure with
the item still in the cart, a non-core cross-sell add — are still recorded by the first-party
`cart_analytics_events` beacon, which is what lets one dataset audit the other precisely *because*
they do not share a gate. The branch table in `cart.js` now carries all three trackers as columns.

**`add_shipping_info` needed two emitters.** `_expandAccordionSection` collapses other sections
**without validating**, so a shopper who reaches Payment by clicking a later heading skips the
delivery section's Continue handler entirely and would never emit the step. The second emitter is at
`handleContinueToPayment`, where the delivery area is definitively captured. It dedupes on the tier,
so the two callers cannot double-count, and a genuine urban → rural correction still re-fires rather
than reporting a stale tier.

**The tier is never invented.** Three quote sites read `...:checked')?.value || 'urban'`, which is
how the page once quoted a rate nobody had chosen (ERR-235). Ours reads `|| null` and **omits**
`shipping_tier` when nothing is checked, matching what `handleContinueToPayment` records.

**Consent is not gated by us**, per your §Implementation notes. Measured in both directions:
`gcs=G1-0` before Accept (the hit leaves and Google models it) and `gcs=G1-1` after accepting
through the real banner.

**Nothing about the Ads tags changed**, and the Ads/GA4 numbers cannot drift: the delta reader and
the price reader were **lifted into shared helpers** that both tag families call, so they are the
same code rather than two implementations that agree today. A parity test pins it, with a positive
control showing what the wrong formula would have said.

## Verification

```
npm test                                            # 6088 tests, 0 fail (+75 new)
node --test tests/ga4-ecommerce-events-sep2026.test.js
node --test tests/ads-add-to-cart-conversion-sep2026.test.js   # 35/35, unchanged — the live-money gate
npm run probe:ga4-events                            # measures the WIRE, not the source
PROBE_BASE=http://localhost:3000 npm run probe:ga4-events
```

Seven deliberate mutations of `gtag.js` were run against the suite — GST divide, unscoped event,
line-total value, `'Unknown'` allowed through, tier defaulting to urban, `getTotal()` for the value,
and a browser `purchase` — and all seven reddened.

`probe:ga4-events` is read-only, uses no `ctx.route()`, and decodes and **prints** GA4's
`en`/`tid`/`pr1`/`gcs` parameters so the output is a measurement rather than a boolean. Note that
repeated runs exhaust the `POST /api/cart/items` rate limit and answer **429**, after which
`add_to_cart` correctly does not fire; the probe reports that as NOT EXERCISED with the status
attached rather than as a failure.

## Still yours to confirm

1. **Your acceptance criterion 2** — `npm run test:monitor` staying 22/22. We cannot run it; the
   `send_to` scoping in §5 is what protects it.
2. **DebugView on a phone** (criterion 1) — we have the four events on the wire with `items[]`
   populated, but the property-side view is yours.
3. **§4** — whether `GET /api/cart` can return `items: []` with a summary for a session that has a
   cart.
4. **§5** — what `G-YJXTSGLM28` is.
5. **§2** — whether you will add `product_type` to the add-to-cart response's `product` object.
