# Public volume pricing — frontend response (Aug 2026)

**From:** frontend · **Date:** 2026-08-09 · **Re:** `public-volume-pricing-backend-response-aug2026.md`
**Tracking:** ERR-149, ERR-150 (FE) · BF-032…BF-038 (backend)
**Status: frontend is live-ready against your deploy. All three of your asks answered below.**

Thank you — this landed clean and it landed richer than the brief asked for. Two things you shipped
that we did not request turned out to matter most: `items[].quantity_breaks` on the cart, and
`limited_by_volume_pricing` on the coupon. Both are now rendered.

Independently verified against production today, signed out, in a real browser:

```
PDP  /products/…/CLC133CMY   → "BUY MORE, SAVE MORE"  3+ $21.82 · 4+ $21.59 · 7+ $20.92 · 8+ $20.47
                               #product-price still 22.49, content="22.49"
cart 3 × CLC133CMY (guest)   → "Volume discount  −$2.01"   (matches volume_discount.discount_amount)
                               line nudge: "Add 1 more to reach 4+ — $21.59 each, saving $3.60"
network                      → ZERO requests to /api/business/* while signed out
```

`npm run sweep:b2b` now runs **credential-free**, reading every ladder off the anonymous catalog walk:
3,967 SKUs, 0 requests to the pricing endpoint, six bands, 0.5%–10%. Record re-committed.

---

## What we need from you (everything else below is FYI)

| # | Ask | Why |
|---|---|---|
| **1** | **Add `source` to the cart line's `product` object** | Without it the cart badges compatible cartridges as **GENUINE**. Compliance-sensitive; one field; `/api/products` already returns it. Details in §(b). |
| **2** | ~~**Check why the catalog API sends `cache-control: private, no-store`**~~ — **WITHDRAWN 2026-08-12 (ERR-159): our probe was a HEAD request. Real GETs were edge-cached all along.** See §(a). | ~~Nothing is edge-cached…~~ |
| **3** | *(no action, just confirmation)* | You are clear to **drop `b2b_discount` / `summary.b2b_discount`** whenever you like. Please **keep `/api/business/pricing`** for now. |

Nothing here blocks the volume-pricing rollout — it is live and correct. Ask 1 is a pre-existing
mislabel we found while verifying; ask 2 is a performance regression we can't see the cause of from
outside.

---

## Your ask 1 — cutover to `volume_discount`: **done, drop the alias whenever you like**

Every read prefers `volume_discount` and falls back to `b2b_discount` only if the first is absent:

| Site | What it reads |
|---|---|
| `cart.js` `computeDiscountBreakdown` | `summary.volume_discount` object *or* number, then the alias |
| `cart.js` `_parseServerCart` | top-level `volume_discount`, folded into the summary |
| `payment-page.js` | top-level `volume_discount` off the cart response |
| `order-totals.js` `normalise` | `volume_discount` in object and number form, then the alias |
| `scripts/sweep-business-pricing.mjs` | `volume_discount` + `summary.volume_discount` |

We kept the fallback deliberately rather than hard-switching: it means your alias removal needs no
coordination with a frontend deploy, and a rollback on your side cannot dark the discount row. Tests
assert **both** spellings resolve, so the fallback can't rot unnoticed either. **You are clear to drop
`b2b_discount` and `summary.b2b_discount` whenever it suits.**

**One request: please do NOT retire `/api/business/pricing` yet.** It is still our compatibility path
— an approved business account on any surface that has not yet ingested a ladder falls through to it.
Every grid and the PDP now feed the public ladder, so in practice it should be answering almost
nothing; we would rather watch that go to zero than remove the safety net first. We will tell you when
it can go.

## Your ask 2 — BF-036 copy: **changed. The rule stays, for now.**

The block is retained; only the wording moved. Both surfaces now read:

> **Promo codes aren't available on business accounts.** Your loyalty points still work.

Your point about the stale "because" was right, and it was actually true **twice** over. The copy had
already been changed once this week, from *"business accounts get automatic volume pricing"* (false
once everyone got it) to *"can't be combined with your business account pricing"*. Your BF-035 clamp
retired that second rationale too — combining is no longer the hazard for anyone. So the copy now
states the rule flatly and says what survives it, and a test fails on `/combin|because|automatic
volume pricing/i` so a well-meaning future edit cannot reintroduce an explanation we can't stand
behind.

On the substance: **the owner has decided to keep the exclusion for now.** Not because of floor risk —
you've removed that — but as a commercial choice about whether trade-volume orders should also draw on
campaign budgets. Recorded as a deliberate deferral, not an oversight. If it is retired later it is a
one-line change on each side.

## Your ask 3 — things we'd shape differently

Nothing about the pricing contract. Two findings that are adjacent to it, both of which may predate
your deploy — reporting with evidence rather than as regressions.

### (a) ~~The catalog API is not being edge-cached at all~~

> **CORRECTED 2026-08-12 (ERR-159). This section was wrong, and the mistake was ours.**
>
> The probe below is `curl -sI`, which sends **HEAD**. The origin's cache-header
> middleware only marked GET as cacheable, so every other method got the hard
> `private, no-store` treatment. We measured a method no visitor uses.
>
> Real GETs were edge-cached the whole time, then and now:
> `/api/products?page=1&limit=20` → `public, max-age=0, s-maxage=300,
> stale-while-revalidate=600`, MISS then **HIT**. Re-measured 2026-08-12.
>
> `npm run audit:edge-cache` now performs this measurement, with GETs, and
> refuses to issue HEAD at all. The full corrected picture — including two Cache
> Rule gaps this section missed — is in
> `public-volume-pricing-FE-response-round2-aug2026.md`.
>
> The "silver lining" paragraph at the end of this section is also wrong: there
> IS a stale window, up to 5 minutes at the edge.

Measured today, unauthenticated, on both hostnames:

```
curl -sI https://api.inkcartridges.co.nz/api/products?page=1&limit=20
→ cache-control: private, no-store, no-cache, must-revalidate, proxy-revalidate
→ cf-cache-status: DYNAMIC
```

`no-store` means Cloudflare cannot hold it, so BF-038's "the existing Cache Rules cover it" is true of
the *rule* but not of the observed behaviour — nothing is being cached. Jul 2026 measured this same
path at `public, max-age=60, s-maxage=300, stale-while-revalidate=300` and **44 ms cached vs 205 ms
uncached** (`catalog-edge-caching-backend-brief-jul2026.md`, ERR-124). If that regressed, the volume
ladder is now riding an uncached payload on every catalog request from every visitor, which is the
opposite of the reason we asked you to embed it.

Silver lining worth stating: it also means there is **no stale-entry window** for the ladder, so no
purge is needed. We are not asking for one.

### (b) Cart line items omit `product.source`, so the cart badges compatibles as GENUINE

Not a pricing bug, found while verifying the cart. The catalog carries it and the cart does not:

```
GET /api/products/CLC133CMY   → source: "compatible"
GET /api/cart items[].product → id, sku, name, retail_price, stock_quantity, color,
                                 image_url, image_thumbnail_url, image_srcset, brand
                                 ↑ no `source`
```

Our `_isCompatible` reads `product_source` first, then falls back to a leading-word `/^compatible\b/`
test on the name for legacy rows. This product is named *"LC133CMY Compatible Ink Cartridge for
Brother…"* — the word is there but not leading — so the fallback misses and the cart line renders a
**GENUINE** badge on a compatible cartridge.

We are deliberately **not** patching this client-side. Genuine-vs-compatible is the one axis where
this frontend is not allowed to infer (Merchant Center, and the OEM-warranty claim rules in
ERR-063/078), and a name-regex guess is exactly the wrong instrument. **Please add `source` to the
cart line's product object** — one field, and it matches what `/api/products` already returns.

---

## What changed on our side, for your reference

- **ERR-150** — our cart nudge was reading `quantity_breaks` off a parser whose item map is a
  whitelist, so the field was being discarded before it reached the consumer and the nudge had never
  rendered. Your per-line `quantity_breaks` is what made the fix trivial; thank you for shipping it
  unasked.
- **ERR-149** (yesterday) — the discount row is ungated and its label fell back to "Business account".
  Fixed before your deploy, so no guest ever saw it.
- The coupon clamp is surfaced in three places: inline at the moment a code is applied (both cart and
  checkout), as a note under the cart summary, and inside the applied-coupon pill on checkout. Your
  `message` is rendered verbatim wherever you send one, with our own fallback when you don't.
