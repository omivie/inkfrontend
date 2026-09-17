# Search + catalog edge cache goes stale on a stock write (Sep 2026)

**Re:** `catalog-edge-caching-backend-brief-jul2026.md` (still unanswered — this is a
follow-up measurement, not a re-send)
**From:** frontend · **Date:** 2026-09-16 · **Tracking:** ERR-263 (FE), BF-064 (backend)

---

## The report

An admin added stock to `G273HYKCMY` (Epson 273HY KCMY 4-Pack). Seconds later the
**search-results card** still read "Contact Us For Stock Enquiries" with a Contact-us
button, while the **PDP for the same SKU** read "In Stock · Only 1 left · Add to Cart".

We investigated the frontend first. **It is not a frontend bug and the payloads were not
wrong.** Measured against the host the browser actually calls:

```bash
B=https://api.inkcartridges.co.nz
curl -s -H "Origin: https://www.inkcartridges.co.nz" "$B/api/products/G273HYKCMY"
curl -s -H "Origin: https://www.inkcartridges.co.nz" "$B/api/search/smart?q=273h&limit=20"
curl -s -H "Origin: https://www.inkcartridges.co.nz" "$B/api/products?search=273h&limit=20"
```

| Endpoint | `in_stock` | `stock_quantity` | `stock_status` |
|---|---|---|---|
| `/api/products/:sku` | `true` | `1` | `in_stock` |
| `/api/search/smart` | `true` | `1` | absent |
| `/api/products?search=` | `true` | `1` | absent |

All three agree, and the card renderer evaluates that row to **Add to Cart**. The shopper
was served an older copy of the response.

---

## BF-064 — a stock write stays invisible for up to 15 minutes

All three endpoints return:

```
cache-control: public, max-age=0, s-maxage=300, stale-while-revalidate=600
```

and they are genuinely served from the edge:

```bash
for i in 1 2 3; do
  curl -s -D - -o /dev/null -H "Origin: https://www.inkcartridges.co.nz" \
    "$B/api/search/smart?q=273h&limit=20" | grep -iE '^(cf-cache-status|age)'
done
# cf-cache-status: HIT   age: 76
# cf-cache-status: HIT   age: 76
# cf-cache-status: HIT   age: 76

curl -s -D - -o /dev/null … "$B/api/products?search=273h&limit=20" | grep -i cf-cache-status
# cf-cache-status: REVALIDATED      (then HIT, age: 0)
```

So after an admin changes stock, the storefront keeps selling the old answer for
**5 minutes guaranteed, and up to 15 minutes** into the `stale-while-revalidate` tail —
for **every visitor**, not just the admin who made the change.

**And the surfaces go stale independently.** `/api/products/:sku` and `/api/search/smart`
are separate cache keys with separate `age`s, which is exactly how a PDP can be correct
while the search card next to it is wrong, at the same instant. That is the symptom that
was reported to us as a rendering bug.

Worth stating plainly, because it cost us an hour: **checking the Render origin directly
tells you nothing.** `ink-backend-zaeq.onrender.com` answers `cf-cache-status: DYNAMIC`
on every request, so the cache looks absent. Only `api.inkcartridges.co.nz` — the host
`js/config.js:19-21` points production at — shows the real behaviour.

### A delta against the July brief

`catalog-edge-caching-backend-brief-jul2026.md:190-196` recorded that `/api/search/smart`
returned the edge-cached header shape but was **`DYNAMIC` on every request**, and asked
whether the rule was meant to cover it. **It now HITs with an `age`.** The Cache Rule has
since been extended to cover search — which is a performance win we are glad to have, but
it brought the stock-bearing search payloads inside the 15-minute window for the first
time.

### Asks

1. **Extend the existing admin price/stock purge to the search key space.** The July brief
   (`:142`) refers to an "admin price/stock purge", so something already purges on write.
   Whatever it covers, it is not clearing `/api/search/smart` or `/api/products?search=`.
2. **Tell us what that purge covers today.** We can observe its effect from outside but
   not its implementation, and we would rather not guess in our own docs.
3. **If purge-by-URL is impractical** (search keys are unbounded — every `q=` is its own
   entry), emit `Cache-Tag: product:<sku>` (plus a broad `catalog` tag) on every
   stock-bearing response and purge by tag on write. That is the only approach that scales
   to a keyspace you cannot enumerate.
4. **Failing both**, drop `stale-while-revalidate` on the stock-bearing routes and cut
   `s-maxage` to ~30 s. The 10-minute stale tail is the larger half of the window and buys
   the least.

**Please do not simply remove the cache.** `js/config.js:11-18` records that this edge path
is what fixed the `/shop` 504s and the long skeleton-loader hangs. A 5-minute cache with a
purge on write is the outcome we want; an uncached catalog is a regression.

---

## Not an ask — what we fixed on our side (ERR-263)

The investigation turned up a real frontend problem underneath the caching one, now fixed,
recorded here so the two are not confused in a later audit.

The stock **pill** and the stock **button** were computed by two different expressions with
inverted precedence — `getStockStatus()` read `stock_status → in_stock → quantity`, while
the card CTA (duplicated byte-identically in `products.js` and `shop-page.js`) read
`in_stock → stock_status → quantity`. Combined with the field asymmetry below, the card
never evaluated `stock_status` at all and the PDP never evaluated `in_stock`.

**The asymmetry, measured — no action needed, just confirming we have it right:**

| Endpoint | `stock_status` | `in_stock` | `stock_quantity` |
|---|---|---|---|
| `/api/products/:sku` | ✅ | ✅ | ✅ |
| `/api/products`, `/api/search/smart` | ❌ | ✅ | ✅ |
| `/api/search/suggest` | ❌ | ❌ | ✅ |

Everything now derives from one function. Two consequences you may care about:

- We treat **`in_stock: false` as authoritative and never override it** with a positive
  `stock_quantity`. If those two can ever legitimately disagree on your side, tell us —
  we currently resolve the conflict toward *not selling*.
- We treat **absence of all three fields as a third state**, not as zero: such a row stays
  buyable and is logged, rather than silently losing its buy button. This matters most for
  `/api/search/suggest`, which carries `stock_quantity` alone — if that field is ever
  dropped from the suggest payload, please tell us rather than letting us infer it.
