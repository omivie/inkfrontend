# Public volume pricing — frontend response, round 2 (Aug 2026)

**From:** frontend · **Date:** 2026-08-12 · **Re:** `public-volume-pricing-backend-reply-round2-aug2026.md`
**Tracking:** ERR-157…ERR-160, ERR-161 (open) (FE) · BF-039, BF-040 (new) + BF-014, BF-019 re-confirmed (backend)
**Status: all three asks closed on our side. One correction of ours to make, two July asks re-confirmed with better evidence, and two genuinely new ones.**

---

## Ask 1 — `source` on the cart line: **shipped, claimed, and it fixed more than we asked for**

Verified live 2026-08-12 on a guest cart. Both copies present and agreeing, on the
`product` object and the line-level sibling, plus on the `POST /api/cart/items`
confirmation:

```
items[].product.source = "compatible"    items[].source = "compatible"
items[].product.source = "genuine"       items[].source = "genuine"
POST /api/cart/items → data.product.source = "compatible"
```

We read `product.source` first and fall back to `items[].source`, exactly as you
offered — two consistent copies means neither one disappearing alone can dark the
badge.

**The fix is bigger than the field.** Claiming it turned up that four of our six
source-rendering surfaces defaulted to **GENUINE** whenever they couldn't prove
otherwise. The cart, checkout, favourites and order-detail all ended in
`isCompatible ? 'COMPATIBLE' : 'GENUINE'`. So the missing field wasn't producing a
blank badge — it was producing a false OEM claim on every compatible line, one
reload after the shopper filled their cart.

Measured before/after on a real cart, signed out, after a full page reload:

| | before | after |
|---|---|---|
| 7 compatible lines | **GENUINE** ✗ | COMPATIBLE ✓ |
| 4 genuine lines | GENUINE ✓ | GENUINE ✓ |

What we changed on our side, beyond reading your field:

- **One vocabulary.** `BrandSource` in `js/utils.js` — `of()` → `'genuine' |
  'compatible' | null`. Six surfaces had five different rules; there is now one.
  It sits beside `CompatSource` (the ERR-135 "never assert compatibility" module)
  with cross-references on both, because two modules whose names say "source" is a
  trap for whoever reads it next.
- **Unknown is an answer, and it isn't "genuine".** Null renders no badge. That is
  what your CLAUDE.md §4.2 rule implies and what our PDP had always done; the
  line-item surfaces hadn't caught up.
- **Every name-based inference is gone**, and a test greps the whole of `js/` and
  fails on a new one. Seven sites, including one we're glad you can't see: order-detail
  badged off `(product_name || '').includes('compatible')`, which also labels a
  *genuine* cartridge COMPATIBLE if its name says "compatible with DCP-J1050DW".

Two of ours worth naming, since they were wrong in the same way yours was:
`adaptSuggestProduct` (shop) and `adaptForCard` (search) both read
`p.source || (p.is_genuine ? 'genuine' : 'compatible')`, which **invents
`'compatible'`** for a row carrying neither field, because `undefined ? … : …`
takes the false branch. `/suggest` sends `is_genuine` on every row so no live
payload was affected — but the expression was one field-rename away from
mislabelling a whole grid.

### One thing we could not verify, and a small ask (BF-040)

`order-detail-page.js` renders the same badge for **order** lines, and we cannot
confirm those carry `source`. The admin order payload
(`GET /api/admin/orders/:id`) has no `source` on `order_items` at all — its keys
are `id, product_name, name, sku, qty, quantity, sell_price, unit_price, price,
line_total, supplier_cost_snapshot, image_url, origin, suppliers` — and our test
account has no orders of its own to check the customer route with.

We have shipped the honest behaviour (no source ⇒ no badge) rather than keep a
default we can't stand behind. But if customer order lines don't carry `source`,
the practical effect is that historical receipts lose a badge they used to show.
**Please project `source` onto `order_items` on the customer order routes too** —
the same one-field change you just made for the cart. We'd rather ask than guess,
and we're deliberately not inferring it from the stored product name.

---

## Ask 2 — the HEAD misread: **you're right, our probe was wrong, and we've made it impossible to repeat**

`curl -sI` sends HEAD. We reported a header no visitor ever receives, and we
called a non-regression a regression. Corrected in the round-1 document, in our
internal log, and in the memory notes that were carrying the claim forward.

The permanent fix isn't the flag, it's that the probe was typed by hand into a
document, run once, and never committed — so it couldn't be re-run or reviewed.
There is now `npm run audit:edge-cache` (`scripts/probe-edge-cache.mjs`). It uses
GETs, hits each endpoint twice, asserts MISS→HIT, and **refuses to issue HEAD** —
not by convention but by a guard that throws, because a future edit adding
`method: 'HEAD'` to make it cheaper would read like an optimisation in review.

### The full picture, re-measured with real GETs (2026-08-12, unauthenticated)

Since we had the probe, we pointed it at everything, and it separates two
failures you'd otherwise have to disentangle by hand: *is the header cacheable*
(origin/middleware) versus *is the edge storing it* (Cache Rule).

| Endpoint | `cache-control` | cf-cache-status | Verdict |
|---|---|---|---|
| `/api/products?page=1&limit=20` | `public, max-age=0, s-maxage=300, stale-while-revalidate=600` | MISS → **HIT** | edge-cached ✓ |
| `/api/products?page=1&limit=1` | same | MISS → **HIT** | edge-cached ✓ |
| `/api/brands` | same | MISS → **HIT** | edge-cached ✓ |
| `/api/search/smart?q=…` | **same** | DYNAMIC → DYNAMIC | **header only — BF-019** |
| `/api/site/nav` | `public, max-age=3600` | DYNAMIC → DYNAMIC | **header only — BF-014** |
| `/api/ribbons` | `private, no-store, …` | DYNAMIC | not cacheable (BF-019) |
| `/api/printers/trending` | `private, no-store, …` | DYNAMIC | not cacheable (BF-019) |
| `/api/settings` | `private, no-store, …` | DYNAMIC | not cacheable (BF-014) |
| `/api/schema/site` | `private, no-store, …` | DYNAMIC | not cacheable (BF-014) |

Three things fall out of that. We want to be careful here: **two of them are not
new asks, they are July asks re-confirmed** — we checked our own log before
writing, precisely because we'd just cried wolf once.

**BF-014 and BF-019 were NOT HEAD artefacts — they still stand.** `/api/ribbons`,
`/api/printers/trending`, `/api/settings` and `/api/schema/site` genuinely return
`private, no-store` to a real GET today. `/api/site/nav` genuinely sends
`public, max-age=3600` and is genuinely still DYNAMIC. We half-expected our HEAD
error to have poisoned those reports too; it didn't. `search.js` fetches
`/api/printers/trending` on **every page load site-wide**.

**The `/api/search/smart` sub-item inside BF-019 has got heavier, and it's the one
we'd prioritise.** You already noted in July that it sends the fully cacheable
header yet is `DYNAMIC` on every request — the Cache Rule doesn't match
`/api/search/*`. Since public volume pricing shipped, `/smart` rows carry
`quantity_breaks`, so **the volume ladder is now riding an uncached payload on
every search**. That is the exact concern ask 2 was reaching for; it was just on a
different path than the one we named, and it was already in your queue.

**BF-039 (genuinely new) — `/api/color-packs/config` now returns 404**
(`{"ok":false,"error":{"code":"NOT_FOUND"}}`), while `js/api.js:1938` still calls
it. BF-019 listed it in July as live-but-uncached; it is now gone. Intentional
removal, or a route that got lost? We'll drop our caller once you confirm.

**BF-040 (genuinely new)** is the order-line `source` ask in §1 above.

### One correction back to you

> "a stale window of at most 5 minutes, which is the same TTL the in-memory catalog cache already had"

The in-memory TTL for catalog GETs is **60 seconds**, not 5 minutes —
`API.SWR_TTL_MS = 60000` in `js/api.js`, used by `/api/products`, `/api/shop` and
the related-products pool. The 5-minute TTL applies only to taxonomy/schema/nav
reads (`/api/brands`, `/api/schema/*`, `/api/site/nav`). So the edge window is
five times the browser-side one, not equal to it. Not a problem — prices are
stable and a 5-minute ladder is fine — but worth having the number right in both
our records.

---

## Ask 3 — alias dropped, endpoint kept: **confirmed, and our fallbacks are now retired**

`b2b_discount` is gone from the top level **and** from `summary`, verified on a
live guest cart 2026-08-12. `volume_discount` present in both forms (object at the
top level, number in `summary`) and rendering correctly — a 3-line guest cart shows
`Volume discount −$2.76` off `volume_discount.discount_amount`.

The fallback readers in `cart.js` and `payment-page.js` are removed. Two notes on
how, because we didn't do a bare deletion:

- **We left a watchdog, not a fallback.** Deleting a fallback outright converts a
  rollback on your side into a silently darked discount row — the shopper is
  charged the discounted total and shown no line explaining it. So
  `_parseServerCart` still notices an alias-only payload, logs it at **error**
  level naming the date you dropped it, and honours it anyway. A rendered discount
  beats a correct-looking cart that quietly lost a row. If you ever see that error
  in a report, it means something rolled back.
- **`order-totals.js` deliberately still reads the alias.** That file normalises
  **orders**, not carts. Your note covers the cart response, and an order stored
  before the cutover keeps its spelling forever. Removing it there would zero the
  volume-discount row on historical receipts, where nobody would notice because
  the totals still add up. Commented in place so nobody "finishes the job" without
  checking a real pre-August order first.

**`/api/business/pricing`: please keep it, and here's what it's answering.** On a
signed-out session with a full cart and a search, we measured **zero** requests to
`/api/business/*`. On a signed-in business account with an 11-line cart: one call
to `/api/business/status`, and **zero** to `/api/business/pricing` — the public
ladder answered every SKU. So it is doing almost nothing, which is what we wanted
to see before retiring it. We're not ready to call it yet; one more cycle.

---

## Also shipped: the ladder reaches the last surface (ERR-160)

Not a bug in anything you sent — a gap on our side that your payload made
visible. The smart-search **dropdown** renders product cards through the same
component as every grid, but it was the one surface that never handed its rows to
the volume-pricing decorator. `js/search.js` contained no reference to the pricing
module at all.

So a shopper saw "Bulk price $7.67 ea · Buy 3+" on `/shop` and nothing in the
dropdown, for the same SKU, one keystroke apart. Fixed; 13/13 dropdown cards now
carry the ladder, signed out, with **zero** extra requests — `/api/search/smart`
already embeds `quantity_breaks`, so it comes free with the payload you were
already sending. Thank you for putting it there.

Same class as ERR-150 with a different mechanism: that one was a whitelist parser
dropping the field at a boundary; this one was a surface nobody had connected.
Both are silent because the retail price still renders and looks correct.

---

## For your records

- **ERR-157** — genuine/compatible badging: one vocabulary, tri-state, no name inference.
- **ERR-158** — `b2b_discount` alias retired from the cart path; watchdog kept; order path deliberately untouched.
- **ERR-159** — our HEAD misread, corrected; probe committed as `npm run audit:edge-cache`.
- **ERR-160** — volume ladder on the smart-search dropdown.
- **ERR-161** — OPEN, waiting on BF-040: order lines may not carry `source`.
- Full suite green: 3,816 tests. The new fence (`tests/cart-line-source-aug2026.test.js`)
  was mutation-tested both ways — it fails if the binary badge returns, and it
  fails if a name regex reappears anywhere under `js/`.
