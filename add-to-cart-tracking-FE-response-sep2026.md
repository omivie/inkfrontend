# FE response — Add-to-cart tracking (Sep 2026)

**From:** frontend (`matcha/FEINK`) · **To:** backend dev (`ink-backend-zaeq`)
**Date:** 2026-09-06 · **Tracking:** ERR-223
**Source:** `add-to-cart-tracking-FE-handoff-sep2026.md`
(archived with corrections at `readfirst/add-to-cart-tracking-FE-handoff-sep2026.md`)

**Status: §1 is shipped and verified firing. §2 needed no code for search — it
shipped five days ago — and the half that was genuinely missing is done. §3 is
correct, but one sentence in it was false, and if we had not fixed the cause your
new server-side row would have made `add_to_cart` *less* trustworthy, not more.**

Everything below was measured against production on 2026-09-06 and is re-measured
on demand by `npm run probe:add-to-cart` (read-only by default; the mode is
printed before any work; `--write` adds one item to a throwaway guest cart and
removes it in a `finally`, verifying the removal).

Read §1 and §5 if you read nothing else. §1 is the sentence in your §3 that was
wrong. §5 is the four things only you can fix.

---

## 0. What shipped

| Hand-off | What the frontend does now | Verified |
|---|---|---|
| §1 Google Ads tag | fires `gtag('event','conversion')` with the real label on a confirmed add | **live browser: the ping left and Google answered 200** |
| §2 search ids | already shipped 2026-09-01 as `?sid=`/`?vid=` — **no change needed** | probe §2 |
| §2 cart POST id | `POST /api/cart/items?sid=&vid=` so your server row is not `session_id: null` | live: `201`, params on the wire |
| §3 double-count | **the two id spaces collapsed** — beacon and server row now agree | live browser |
| §3 `remove_from_cart` | **do not build it yet** — see BF-059 | probe §6 |

`npm test` — **5,582 tests, 0 failing**, including 47 new assertions across two
new files. `npm run probe:add-to-cart --write` — 15 passed, 0 failed, 2 noted.

---

## 1. Your §3 says the overlap is harmless. It was not, and here is why

> "Both rows are written; readers that count DISTINCT `session_id` are
> unaffected by the overlap."

That sentence was false when it was written, and your own table is the reason it
looked true:

| Table | Rows (30d) | With `session_id` |
|---|---|---|
| `traffic_events` | 8,217 | 100% |
| `cart_analytics_events` | 409 | 100% |

Both 100% — **in two different id spaces.** `traffic_events.session_id` is the
`ts_…` id minted by `js/traffic-tracker.js`. `cart_analytics_events.session_id`
was a `cs_…` id that `js/cart-analytics.js` minted for itself, in its own
`sessionStorage` key, related to nothing.

So the moment `POST /api/cart/items` started writing its own row, the same
add produced **two rows with two unrelated ids** — the beacon's `cs_X` and your
server row's `ts_Y`. A reader counting DISTINCT `session_id` sees **two sessions
for one add**. And because `cart_viewed` is beacon-only and stays pure `cs_`,
`add_to_cart` would have become the only rung of the funnel mixing id spaces —
the exact rung the whole investigation is about. Your funnel would have gone from
impossible-low to impossible-high, and both are unusable.

**The trap worth naming: a populated column that joins to nothing is worse than
a null one.** A null is visibly missing and gets fixed. A populated one looks
like working data and gets reported. That column was 100% populated for its
entire history and had never once been joinable.

**Fixed.** `cart-analytics.js` now asks `TrafficTracker.getIds()` and sends the
shared `ts_…` id, so the beacon row and your server row describe the same
session and DISTINCT collapses them correctly. Verified in a real browser:

```
window.TrafficTracker.getIds().session_id  ->  ts_mtpk4j50_62ircbix
window.CartAnalytics.currentSessionId()    ->  ts_mtpk4j50_62ircbix
```

Two details you should know rather than discover:

- **There is a discontinuity at the ship date.** Rows before 2026-09-06 carry
  `cs_…`, rows after carry `ts_…`. Any session-level trend that crosses that
  boundary has a step in it. Nothing is lost — the old rows are as joinable as
  they ever were, which is to say not at all — but do not read the step as a
  behaviour change.
- **A session now means what it means everywhere else**: the traffic tracker's
  30-minute sliding window, not "until the next order". `cart-analytics.js` used
  to reset its id on `checkout_completed`, so two orders minutes apart were two
  sessions. They are now correctly one, consistent with `traffic_events`.

The `cs_…` id still exists as a **named last resort** for the cases where
`window.TrafficTracker` deliberately does not exist — DNT, and any `/admin` path
— and where it suppresses the `anon`/`ts_fallback` collision sentinels. Those
events still need an id because you require one, so they get an honest
unjoinable one rather than a shared lie.

---

## 2. §2 as written would have taken the site down, and it was already solved

> "Fix — one line in the shared fetch wrapper. Send the same session id … as a
> header, on every `/api/` call."

**We cannot, and this is the second hand-off in five weeks to ask for it.** It is
BF-054, raised on 2026-08-31 and still open. Re-measured today:

```
OPTIONS /api/cart/items
  Access-Control-Request-Method: POST
  Access-Control-Request-Headers: x-session-id,x-visitor-id,content-type
    -> 204
    access-control-allow-headers: Content-Type, Authorization, X-Requested-With,
                                  X-Request-Id, X-Guest-Session, X-Attribution-Source
```

Neither id header is on that list.

**The part that makes this genuinely dangerous is that it looks fine from
`curl`.** Your endpoint answers **204 regardless of what is asked for** — it does
not echo the requested headers, so the status carries no information about
whether they are permitted. A browser does the comparison itself, fails the
preflight, and **never sends the request at all**. It does not degrade.

Your §2 says to put it in the *shared fetch wrapper*, on *every* `/api/` call.
Following that instruction would not have cost us an analytics column — it would
have taken down **search, the catalogue, the cart, checkout and payment**
simultaneously, for every customer, on the first deploy. `probe:add-to-cart` §1
now asserts the header is still absent, precisely so nobody turns it on early.

**And the search half of your §2 needed no work: it shipped on 2026-09-01.**
Your own document lists the fallback we used — "falling back to `?sid`/`?vid`
then body" — and that is what `/api/search/smart`, `/suggest` and the
`/api/search/click` beacon have been sending for five days. Your "0 rows, zero"
figure is a **30-day window of which 25 days predate the fix**. Please re-measure
`search_analytics` over 2026-09-01 onwards before concluding anything about it;
if it is still zero after that date, that is a real finding and we want to know,
because the params are demonstrably on the wire.

What genuinely *was* missing is the half your §2 mentions almost in passing:
`POST /api/cart/items` carried no id, so the row your §3 writes landed with
`session_id: null`. That is now `POST /api/cart/items?sid=…&vid=…` — a query
param, not a header, and free here because a POST is never edge-cached.

---

## 3. §1 — the Google Ads tag, and the three things the snippet got wrong

Shipped in `js/gtag.js` as `window.AdsConversions.addToCart()`, called from the
one confirmed-success branch of `Cart.addItem`. It lives in `gtag.js` rather than
a new file because `gtag.js` is already on 38 of 43 pages — a measured strict
superset of the 33 that load `cart.js` — and a new file would have needed 33 new
`<script>` tags. That is exactly how ERR-194 happened, when `cart-analytics.js`
sat on three pages behind a `typeof` guard that was an off-switch everywhere
that mattered. A test now asserts the enrolment instead of a convention.

**The label your brief left as `AW-XXXXXXXXX/YYYYYYYYYYYYYYY`** is
`AW-18032498762/e3c8CI2D3dwcEMqwyJZD` (action 7710654861), under the tag id
already configured site-wide. It stays `primary_for_goal: false` and excluded
from `conversions`, as you asked. We used the event name **`conversion`**, not
`add_to_cart` — that is the form Google's own generated snippet for this action
uses, and `send_to` plus the label is what routes the hit.

**Verified in a real browser, which is the only thing that can settle it:**

```
GET https://www.googleadservices.com/pagead/conversion/18032498762/
      ?…&label=e3c8CI2D3dwcEMqwyJZD&value=193.98&currency_code=NZD   -> 200
```

The tag that had not fired once in six months fired, and Google accepted it.

### 3a. `data.quantity` is the LINE TOTAL, not the amount added

This is the one that would have cost real money, and no unit test could have
caught it. Your example response shows `"quantity": 2` next to
`"price_snapshot": 44.49`, which reads as "2 were added". It is not — it is the
**resulting quantity of the cart line**. Measured in the browser:

```
line already holds 2 · shopper adds 1 · response says quantity: 3
  -> naive value = 96.99 x 3 = $290.97 reported for a ONE-cartridge add
```

Triple the true value, into the account the owner bids from, silently, on every
add to something already in the cart. We now derive the delta from the line's
prior quantity, capped at what was requested (a stale-low local cart must never
*inflate* a conversion) while still honouring a genuine stock clamp downward.
Re-verified live: line 3 → 4, and Google receives `quantity: 1, value: 96.99`.

**If `quantity` is meant to be the delta, this is a backend bug — please say
which it is.** We have assumed line-total because that is what production does.

### 3b. `Number(null)` is `0`

Our first cut wrote `Number(confirmed.price_snapshot)` and range-checked after.
`Number(null)` and `Number('')` are both `0`, so a missing price would have
reported a confident **$0.00** conversion. That is the ERR-219/ERR-068
absence-as-zero shape aimed at an ad platform. The type is now checked before any
coercion; a genuine `0` still reports as `0`, and an absent price fires the
conversion **without a `value`** rather than inventing one — the add really
happened, but we will not tell Google what it was worth when we do not know.

### 3c. Which branch fires

`Cart.addItem` has four exits and they are not interchangeable:

| branch | your `cart_analytics_events` beacon | Google Ads |
|---|---|---|
| server confirmed (2xx) | yes | **yes** |
| server rejected (line rolled back) | no | no |
| transport failure (item kept locally) | yes | **no** — no 2xx |
| non-core / cross-sell (never POSTs) | yes | **no** — no 2xx |

The internal funnel counts an add the shopper can see; Google Ads counts only an
add you confirmed. Verified live: a rejected add (bogus product id → 404) fires
**zero** conversions.

---

## 4. Found while verifying, fixed, and not in your brief

**The cold-cache cross-sell fetch has been dead in production.** You return
`frequently_bought_together_url: "/api/products/<sku>/bought-together"` — a
root-relative path. The storefront fetched it as-is, which resolves against the
storefront origin, and nothing proxies `/api/` there:

```
https://www.inkcartridges.co.nz/api/products/GLC3333BK/bought-together  -> 404
https://api.inkcartridges.co.nz/api/products/GLC3333BK/bought-together  -> 200
```

It failed silently — the failure path is a bare `return` and the caller is
`.catch(() => {})` — so the "Customers also bought" modal simply never appeared
on a cold cache and nothing was logged anywhere. Now resolved against the API
host; an absolute URL from you is still passed through untouched. No backend
change needed, but you may want to know that returning an absolute URL would
make this class of bug impossible for every future consumer.

---

## 5. What only you can fix

### BF-058 — put the id headers on `Access-Control-Allow-Headers`
`X-Session-Id`, `X-Visitor-Id`. This is BF-054 restated because a second hand-off
has now specified a transport that cannot be used. Headers survive an edge-cache
hit and query params do not, so this is not cosmetic: `/api/search/smart` answers
`cache-control: s-maxage=300` and is only saved from fragmenting by currently
answering `cf-cache-status: DYNAMIC`. The day it is added to the Cloudflare Cache
Rule, `?sid=` shatters the shared entry one visitor at a time. **When you add the
headers we flip one constant** — `USE_ID_HEADERS` in `js/traffic-tracker.js` —
and `probe:add-to-cart` §1 turns from a pass into a note telling us to do it.

### BF-059 — `DELETE /api/cart/items/:id` reports success and removes nothing
Reproduced twice on fresh guest sessions:

```
POST   /api/cart/items {product_id, quantity:1}   -> 201, item id d1105fb3-…
DELETE /api/cart/items/d1105fb3-…                 -> 200
       {"ok":true,"data":{"message":"Item removed from cart","removed":0}}
GET    /api/cart                                  -> the line is still there
DELETE /api/cart                                  -> {"removed":1}   (works)
```

`ok:true` and "Item removed from cart" next to `removed:0` is a success message
for a no-op. **This is why your §3 optional next step — mirroring server-side
logging onto `remove_from_cart` at this endpoint — must not be built yet.** You
would be recording removals that did not happen, on the rung directly below the
one we just repaired. The storefront survives it only because `Cart.removeItem`
has three mechanisms and does not treat `removed: 0` as terminal (ERR-136).

### Confirm whether `cart_analytics_events` stores `visitor_id`
We now send it alongside `session_id`. The endpoint answers **200** rather than
rejecting it, but whether the column is written cannot be seen from outside your
database, so we are reporting it as **unknown, not as working**. A visitor id is
what joins a cart across sessions to one person. If you do not store it, say so
and we will stop sending it.

### BF-060 — §1 of your hand-off still tells the next reader to send `price_snapshot * quantity`
The doc in your repo (`docs/storefront/add-to-cart-tracking-FE-handoff-sep2026.md`)
is unchanged, and we cannot edit it. Anyone who implements it as written ships
the triple-value bug in §3a. **It is correct for the only case anyone tests by
hand** — an add to an empty line, where the total *is* the delta — so it passes
review and passes unit tests, and the number only goes wrong once it is in Google
Ads. Please correct §1 and state in the response contract that `quantity` is the
resulting line total. We have archived a corrected copy at
`readfirst/add-to-cart-tracking-FE-handoff-sep2026.md` on our side, with your
original text left intact and the corrections in a banner above it.

### Confirm whether `quantity` in the add-to-cart response is the line total
See §3a. We have assumed line-total from production behaviour. **If it is meant
to be the delta, this is a backend bug rather than a doc bug** — tell us and we
will delete our derivation instead of maintaining it.

---

## 6. Not fixed, deliberately, and you should know about it

**Google Ads and GA4 run consent-denied for every visitor.** `js/gtag.js` sets
`analytics_storage` from `localStorage['cookie_consent']`, and **nothing in this
codebase ever writes that key** — there is no consent banner anywhere. Every
conversion ping carries `gcs=G1-0`.

This is a real defect and it is being reported rather than quietly fixed, because
a consent UI has legal and copy surface (NZ Privacy Act, the existing privacy
page) and does not belong inside an analytics change decided by a developer. The
site owner has the decision.

Two things that matter for interpreting your data in the meantime:

- **It does not suppress the pings.** Our verification fired with
  `analytics_storage: denied` and Google answered 200. Consent-denied loses
  cookies, not cookieless conversion pings. So it does **not** explain any gap in
  received requests.
- **It does weaken attribution**, which leans on modelling — and the account was
  moved to Target CPA on the strength of measured CPA.

**Separately, and resolved: the live Purchase conversion was reported as possibly
dead. It is not.** Action 7558732273's
`conversion_last_received_request_date_time` is frozen at 2026-09-03 16:11 while
real paid orders landed on 09-04 and 09-05, which reads as a broken tag. We
loaded the real confirmation page in a browser rather than reasoning about it:

```
GET …/pagead/conversion/18032498762/?…&label=W1laCPGzpJQcEMqwyJZD
      &oid=PROBE-PURCHASE-TAG-1&value=123.45&currency_code=NZD   -> 200
```

It fires, `transaction_id` is populated, Google accepts it. That proves the
page's conversion machinery works; it does **not** prove that a real order
*reaches* that page with its order in `sessionStorage`, which is the remaining
candidate and a separate investigation. The likeliest explanation for two orders
in three days is simply no ad interaction to attribute. We mention it because it
is worth more than everything else in this document: **an add-to-cart funnel is a
diagnostic; the purchase tag is the money** — which is why it was measured rather
than assumed, in both directions.

---

## 7. Verify it yourself

```bash
npm run probe:add-to-cart            # read-only: CORS, ?sid= transport, labels
npm run probe:add-to-cart -- --write # + the real add-to-cart response shape
npm test                             # 5,582 tests
```

`tests/ads-add-to-cart-conversion-sep2026.test.js` (31) and
`tests/cart-analytics-session-identity-sep2026.test.js` (14). Mutation-checked:
sourcing the value from `retail_price`, restoring `Number(null)`, moving the tag
onto the transport-failure branch, or reverting the shared session id each turn
the expected tests red and nothing else.
