> ## ⚠️ CORRECTED COPY — read this box before you implement anything below
>
> Archived into `readfirst/` on 2026-09-06 as the hand-off ERR-223 was built
> from. **The body below is the original, unaltered**, so the record of what was
> asked stays intact. Three of its instructions are wrong, and each one was
> measured against production rather than reasoned about. Full detail and the
> evidence: `add-to-cart-tracking-FE-response-sep2026.md`.
>
> **1. §1's `value: unitPrice * quantity` is WRONG, and it overcharges.**
> `data.quantity` in the add-to-cart response is the **resulting cart-line
> total, not the amount added**. A line already holding 2, plus one more,
> answers `quantity: 3` — so this formula reported **$290.97 for a
> one-cartridge add**. Triple value, into the account the owner bids real money
> from, on every add to something already in the cart. Derive the delta from the
> line's prior quantity, capped at what was requested. Every unit test passes
> either way: one add to an *empty* line is indistinguishable from a delta, so
> only a second add to the same line exposes it.
>
> **2. §2's `headers['X-Session-Id']` is UNSHIPPABLE and would take the site
> down.** The header is not on `Access-Control-Allow-Headers` (BF-054 → BF-058).
> The preflight answers **204 regardless of which headers are requested** — it
> does not echo them — so `curl` reads it as a pass while a *browser* fails the
> preflight and **never sends the request**. Placed where §2 says to place it —
> the shared fetch wrapper, every `/api/` call — that is search, catalogue,
> cart, checkout and payment down simultaneously on the first deploy. Use
> `?sid=`/`?vid=`, which this frontend has sent since 2026-09-01. §2's "0 rows
> in 30 days" table is a window that **predates that fix by 25 of its 30 days**.
>
> **3. §3's "readers that count DISTINCT `session_id` are unaffected by the
> overlap" was FALSE when written.** `traffic_events` carried `ts_…` ids and
> `cart_analytics_events` carried `cs_…` ids minted separately by
> `cart-analytics.js` — both columns 100% populated, in different alphabets. The
> server-written row and the beacon row described one add as **two sessions**.
> Fixed by collapsing onto the shared id; the sentence is true now, and was not
> before.
>
> **Also: do NOT build §3's optional `remove_from_cart` step yet.**
> `DELETE /api/cart/items/:id` answers `ok:true` / "Item removed from cart" /
> **`removed: 0`** and leaves the line in the cart (BF-059, reproduced twice).
> Instrumenting it would record removals that did not happen.
>
> The correct label for §1, which the hand-off leaves as a placeholder, is
> `AW-18032498762/e3c8CI2D3dwcEMqwyJZD` (action 7710654861, kept SECONDARY).

---

# Add-to-cart tracking — FE hand-off (Sep 2026)

Two independent defects found while auditing Google Ads. **Neither can be fixed from the
backend** — both live in the storefront. Backend-side work is already done and deployed-ready
(`src/utils/cartEventLog.js`).

Context: the Google Ads account is running at ~2.2× break-even CPC, and **mobile converts at
1.65% against desktop's 10.53%** over 90 days. We cannot tell whether mobile shoppers bounce,
fail to add to cart, or abandon at checkout — because the add-to-cart rung of the funnel is the
one that isn't measured. That is what these two fixes unblock.

---

## 1. The Google Ads add-to-cart tag has NEVER fired

`Shopping Cart` conversion action — id `7710654861`, type `WEBPAGE_CODELESS`, category
`ADD_TO_CART`, status ENABLED. `metrics.conversion_last_conversion_date` is **empty**: not once,
across 771 ad clicks in 30 days and ~6 months of the tag existing.

**Why:** it is a *codeless* action — Google's automatic event detection, which scrapes the page
for cart-like interactions. That does not work on this SPA; there is no full page load on
add-to-cart for it to observe.

**Fix — fire an explicit event.** Wherever the cart add succeeds, after
`POST /api/cart/items` returns 2xx:

```js
// Google Ads add-to-cart. Fire only on a successful API response — never
// optimistically on click, or a failed add (out of stock, inactive pack)
// records a conversion that did not happen.
gtag('event', 'add_to_cart', {
  send_to: 'AW-XXXXXXXXX/YYYYYYYYYYYYYYY',   // Shopping Cart action's conversion label
  currency: 'NZD',
  value: unitPrice * quantity,
  items: [{
    id: product.sku,
    google_business_vertical: 'retail',
    quantity
  }]
});
```

**The response already carries everything you need** — no extra request:

```jsonc
{ "ok": true, "data": {
  "message": "Added to cart",
  "product_id": "…", "quantity": 2, "price_snapshot": 44.49,
  "product": { "sku": "GTN251BK", "name": "…", "retail_price": 44.49, "source": "genuine" }
}}
```

Use `price_snapshot` (what the shopper is actually being charged) rather than `retail_price`, and
note both are **GST-inclusive** — do not divide by 1.15 for the ad platform, it wants the
shopper-facing price.

Then in Google Ads, switch the `Shopping Cart` action from automatic/codeless detection to the
tag-based event so it stops waiting for a scrape that never comes.

⚠️ Keep it **secondary** (`primary_for_goal: false`, excluded from `conversions`). It is a funnel
diagnostic, not a conversion to bid on. Promoting it to primary would make Smart Bidding optimise
toward add-to-carts instead of purchases.

---

## 2. `X-Session-Id` is never sent — the Aug 2026 identity plumbing is inert

`src/utils/analyticsIdentity.js` (tracking plan G2) reads `X-Session-Id` / `X-Visitor-Id` headers,
falling back to `?sid`/`?vid` then body. The backend has been reading them since August. It is
receiving nothing:

| Table | Rows (30d) | With `session_id` |
|---|---|---|
| `traffic_events` | 8,217 | **100%** (beacon sends it in the body) |
| `cart_analytics_events` | 409 | **100%** (beacon sends it in the body) |
| **`search_analytics`** | **3,901** | **0 — zero rows** |

So every search is anonymous and cannot be joined to the session that produced it. This is why
`computeSearchTopConverting()` still ships `orders: null, conversion_pct: null`.

**Fix — one line in the shared fetch wrapper.** Send the same session id the `traffic_events`
beacon already mints, as a header, on every `/api/` call:

```js
headers['X-Session-Id'] = sessionId;   // same value the traffic beacon sends
headers['X-Visitor-Id'] = visitorId;   // optional but preferred
```

Constraints (enforced server-side, `ID_RE`): opaque ids only — `[A-Za-z0-9_.:-]`, 1–128 chars.
A malformed id is **rejected whole**, not truncated, because a mangled id groups with nothing and
looks like real data. Do not invent a second id scheme; reuse the beacon's.

**This also completes the backend work in §3.** Without the header, the server-side cart event
lands with `session_id: null`.

---

## 3. Already done backend-side (no FE work needed)

`POST /api/cart/items` now records its own `add_to_cart` row in `cart_analytics_events`
(`src/utils/cartEventLog.js`, pinned by `__tests__/cart-event-log.test.js`). The beacon is a
second network request that can be blocked, dropped on an SPA route change, or lost when the tab
backgrounds mid-tap — all more common on mobile, which is precisely the population under
investigation. The live funnel shows the damage:

```
cart_viewed        123 sessions
add_to_cart         31 sessions   <-- impossible
checkout_started    80 sessions
```

You cannot start a checkout you never added to. The API request that writes the cart row cannot be
blocked, so recording it there removes the dependency.

Notes for whoever reads this data:

- Server rows are marked `metadata.origin = 'server'`. They deliberately do **not** set
  `metadata.source` — that key is already the PAGE name in
  `/admin/analytics/page-revenue` and defaults to `product_page`, so a server row would have
  inflated that bucket. `page-revenue` skips them; page attribution stays beacon-only.
- **Keep the beacon.** It carries page context the API cannot know. Both rows are written; readers
  that count DISTINCT `session_id` are unaffected by the overlap.
- Device is derivable from the row's `user_agent` even while §2 is outstanding — enough to answer
  "do mobile shoppers add to cart at all?" without the session join.

---

## Priority

1. **§2, the header** — one line, unblocks §3's join and six months of anonymous search data.
2. **§1, the gtag event** — restores the Google Ads funnel view.
3. Optional: mirror the same server-side treatment onto `remove_from_cart` (`DELETE /cart/items/:id`)
   once §1 and §2 land, so both product-level rungs are equally trustworthy.
