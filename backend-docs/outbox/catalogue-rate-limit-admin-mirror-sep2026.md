# The origin rate limiter is shared across endpoints, and admins pay for it alone

**From:** frontend · **Date:** 2026-09-17 · **Tracking:** ERR-266 (FE), BF-066 (backend)

> **Start here:** one ask, in §3. Everything before it is the measurement that produced it.
>
> This is **not** a report that the limiter is wrong to exist. It is a report that its budget is
> spent almost entirely by the few visitors who cannot benefit from the CDN — our own staff —
> and that one page load costs three to four of it.
>
> Nothing here is urgent in the way BF-065 §1 is. No customer-facing breakage is outstanding:
> the frontend half is fixed and shipped (§4). We are reporting it because the *frontend* fix
> makes the symptom legible rather than making it stop.

---

## §1 What was reported, and what it actually was

`/shop?brand=brother&category=ink&code=LC431` intermittently showed **"No products found for
this code."** The catalogue was healthy throughout — eight consecutive reads returned 18
products:

```bash
B=https://api.inkcartridges.co.nz
for i in $(seq 1 8); do
  curl -s "$B/api/shop?brand=brother&category=ink&code=LC431&limit=200" \
    | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']['products']))"
done
#   18 18 18 18 18 18 18 18
```

It was only ever reported by a signed-in **admin**, never by a shopper. That turned out to be
the whole shape of it.

---

## §2 The measurement

### 2.1 The limiter is per-IP and **shared across every endpoint**

```bash
curl -sI "$B/api/shop?brand=brother&category=ink&limit=1"   | grep -i ratelimit
#   x-ratelimit-limit: 100
#   x-ratelimit-remaining: 80
#   x-ratelimit-reset: 1789613812

curl -sI "$B/api/products?limit=1"                          | grep -i ratelimit
#   x-ratelimit-limit: 100
#   x-ratelimit-remaining: 76        <-- same counter
#   x-ratelimit-reset: 1789613812    <-- same window
```

A read of `/api/products` decrements the budget for `/api/shop`. The window is **60 seconds**
(`reset - now` measured at 57s), the ceiling **100**.

Exhausting it is easy — 15 concurrent reads of a single URL:

```
429 429 429 200 429 429 429 429 429 429 429 429 429 429 429
```

```
retry-after: 27
{"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests"}}
```

### 2.2 A cached read costs nothing; an admin read always costs

| Route | `cache-control` | `cf-cache-status` | Spends budget? |
|---|---|---|---|
| `/api/shop?…` (shopper) | `public, max-age=0, s-maxage=300, stale-while-revalidate=600` | `MISS` → `HIT`,`HIT`,`HIT` | only on the MISS |
| `/api/admin/catalog/shop?…` (admin) | `private, no-store, no-cache, must-revalidate, proxy-revalidate` | `DYNAMIC` | **every read** |

Measured directly — three edge HITs left `x-ratelimit-remaining` pinned at 98, while three
deliberately-unique URLs (forced MISSes) walked it down 93 → 92 → 91.

So the budget is a shared resource that shoppers almost never draw on and staff draw on
constantly. **The people most likely to be rate-limited off the storefront are the people who
run the shop.** (This is the same asymmetry BF-065 closed with, measured from the other side:
the admin mirror is the one catalogue surface with no cache in front of it.)

### 2.3 One page load is not one request

A single `/shop?…&code=…` load issues **three to four** origin reads — `/api/shop`, a
compat-recovery `/api/products` sidecar, a Supabase `product_codes` lookup, and a fourth
`/api/products` read when the manual-code layer finds an override. At 3–4 apiece, **~25 page
views inside one minute exhausts the budget**, which is an ordinary rate for someone checking
a price list. A NAT'd office shares one budget, so this also reaches our B2B customers — a
detail we have not yet measured and are not claiming.

---

## §3 The ask

**Exempt authenticated staff from the limiter, or give them a separate ceiling.**

`/api/admin/catalog/*` is token-bearing and uncached by design, so it cannot be protected by
the CDN the way the public routes are; the limiter treats it as if it could. Either would do:

1. skip the limiter when the request carries a valid admin/staff token; or
2. keep the limiter but count the admin mirror against its own, higher budget.

**Secondary, lower confidence:** consider whether 100/60s shared across *all* endpoints is the
intended granularity for anonymous traffic too. We have not seen a shopper hit it, because the
edge absorbs them — we mention it only because the sharing is what makes the ceiling reachable
at all, and a cold cache after a purge would put real traffic on the origin all at once. Your
call; we are not asking for a number.

---

## §4 What we fixed on our side, so the two are not conflated later

Filed as **ERR-266**. The 429 was never the bug we could fix — being told "slow down" is a
legitimate answer. The bug was that we rendered it as **"No products found for this code."**

`Shop.loadProducts()` had no failure state at all. It erased thrown failures with
`.catch(() => null)` and discarded resolved `{ok:false}` envelopes with an `if (response.ok)`
test, then reported the resulting empty array as an empty shelf. Both shapes now raise a
retryable error pane, `RATE_LIMITED` gets its own copy telling the shopper to wait rather than
implying we stock nothing, and a partial fan-out is rendered but never cached.

Two notes that may matter to you:

- **A 429 body is `{"ok":false,…}`** — the same envelope shape as a success. At the call site
  it is indistinguishable from a legitimate empty response unless the caller inspects `code`.
  That is our problem to handle and we have; flagging it only because any other consumer of
  this API has the same trap waiting, and it is invisible until the limiter fires.
- **`code` is the only reliable discriminator.** Our `request()` stamps `status` on the 5xx
  envelope alone, so `RATE_LIMITED` arrives with a `code` and no `status` in one path and as a
  thrown error in another. If you ever add `status` to the 429/404/403 envelopes, tell us —
  a guard keyed on its absence would silently invert.

**No backend change is requested for the frontend half.** §3 is the only ask in this document.

---

## §5 What we did not measure

- Whether the limiter is per-IP or per-IP-plus-something. We only ever saw our own IP.
- Whether a NAT'd customer office has actually hit this. Plausible from §2.3, unverified.
- What proportion of the origin's catalogue traffic is admin. You have the logs; we do not.
- Whether `/api/admin/catalog/*` shares the products handler — still open from BF-065.
