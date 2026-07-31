# Business Account volume pricing (v2) — frontend response

**Date:** 2026-07-31 · **Handoff:** `readfirst/business-account-pricing-v2-FE-handoff-jul2026.md`
· **Log:** ERR-139 · **Tests:** `tests/business-account-pricing-jul2026.test.js` (74)

Everything in the handoff is implemented. This document records what we found when we verified it
against production, which is not identical to what the document says, plus two things the payload
cannot tell you and one backend ask.

Verification method: the two endpoints were called live with a real approved business account, and
`/api/business/pricing` was swept across **all 1,197 catalog SKUs** (12 calls, 100 SKUs each). All
1,197 were answered; 0 returned `found:false`; 0 returned an empty `quantity_breaks`; 8 contained a
floored rung.

---

## 1. The frontend was already broken, silently, before this handoff arrived

This is the most important thing in this document.

v1 read `business_price`, `savings_amount`, `effective_percent` and `floored` from the **top level**
of a pricing item. v2 moved all four inside `quantity_breaks[]`. `Number(undefined)` is `NaN`, the
guard returned `null`, and `null` means *"this customer has no business discount — show retail"*.

So the PDP price panel and every product-card overlay **stopped rendering entirely for every
business customer, on every page, with no error**. `pricing_tier` disappearing from
`/api/business/status` killed the account-dashboard panel line and the cart row's label at the same
time.

Nothing logged. Nothing 500'd. The outage was indistinguishable from a customer simply not having a
discount.

**Ask:** when a field moves or a model changes, please say so explicitly in the handoff's "what
changed" section at the field level — *"`business_price` → `quantity_breaks[].business_price`"* —
rather than only describing the new model. The frontend now warns loudly when it sees the retired
shape or an unexpected `data.source`, so the next one is a five-minute diagnosis rather than a
silent regression, but the diff is cheaper than the detector.

---

## 2. Where the document and the live API disagree

### 2a. The entry rung is **3+**, not 5+

The TL;DR says *"render a quantity-break table per SKU: 'Buy 5+ $X · Buy 10+ $Y · …'"*. Every live
band starts at **3**. All four bands are `3 / 5 / 10 / 20`.

### 2b. The worked example matches no live band

The response sample uses `GTN251BK` at `$34.99` with `5 / 8 / 11 / 14`. Live, a $34.99 item is in
the `$20–$50` band and gets exactly `5 / 8 / 11 / 14` at quantities `3 / 5 / 10 / 20` — the
percentages are right, the quantities in the prose are not. Minor, but the FE table was built from
the live sweep rather than the sample.

### 2c. The four live bands (2026-07-31)

| retail range | ladder (`qty:%`) | SKUs |
|---|---|---|
| $5.49 – $19.99 | 3:6, 5:10, 10:14, 20:18 | 113 |
| $20.49 – $49.99 | 3:5, 5:8, 10:11, 20:14 | 358 |
| $50.79 – $98.99 | 3:4, 5:6, 10:9, 20:12 | 206 |
| $100.79 – $2968.99 | 3:3, 5:5, 10:7, 20:10 | 520 |

These are recorded in the test file so a re-band shows up as a visible diff rather than a surprise.

### 2d. `summary.b2b_discount` is still a NUMBER

Unchanged from v1 and still contrary to the document. Live:

```
summary.b2b_discount   ->  4.88                    (a NUMBER — the amount)
response.b2b_discount  ->  { company_name, effective_percent, discount_amount,
                             floored_line_count, source: 'volume' }   (the OBJECT)
```

The FE accepts both shapes at the boundary, so moving the object into `summary` later would be a
no-op for us. `summary.discount` **includes** the b2b amount (both were `4.88`), so it is netted out
of the generic "You Save" row exactly like loyalty.

---

## 3. The hazard the handoff does not mention: flooring emits duplicate rungs

When the loss floor bites, the ladder flattens and consecutive rungs come back at an identical
price, identical `savings_amount` and identical `effective_percent` — while `discount_percent` keeps
climbing toward a ceiling that is never reached:

```
GDR2025BK        3+ $186.04 | 5+ $182.20 | 10+ $180.79 | 20+ $180.79
GTN2530XLBK-2PK  3+ $274.50 | 5+ $271.49 | 10+ $271.49 | 20+ $271.49
```

Rendered verbatim, that advertises "Buy 20+" as a better deal that saves exactly the same money — it
tells a customer to buy ten more units for $0.

**What the FE does:** `describeLadder()` **collapses any rung that is not strictly cheaper than the
one before it**. `GDR2025BK` renders 3 chips, `GTN2530XLBK-2PK` renders 2. The customer is never
nudged toward a break that buys them nothing, and `offerAtQuantity()` still resolves a quantity of
25 to the 10+ price, which is what the chip advertises and what checkout charges.

8 of 1,197 SKUs are affected today. It is rare, not theoretical.

**Optional backend improvement:** suppressing non-improving rungs server-side would make the API
self-consistent for every consumer, not just this one. The FE handles it either way.

---

## 4. Two things the payload cannot tell you (and what we did instead)

### 4a. `b2b_discount.effective_percent` is a whole-cart figure, not a rate

Live: a cart of 6 lines where exactly one line (`CTN1070BK` × 4) reached its entry rung and got 5%
reported `effective_percent: 0.7` — the realised rate across the entire subtotal, including the five
lines that got nothing.

Shown next to the words "Business account", that reads as *the customer's discount rate*, and it
would be wrong on every mixed cart. The FE therefore labels the row with `company_name` and never a
percentage, and where the floored explainer does quote the figure it is worded explicitly as "across
your cart".

### 4b. Cart lines carry no per-line B2B figure — **this is the one real backend ask**

`GET /api/cart` line items carry `price_snapshot` and `line_total` at **retail**; the discount
appears only as a single cart-level `b2b_discount.discount_amount`. There is no
`b2b_unit_price`, no `b2b_line_savings`, and no indication of which lines qualified.

Since the whole point of a volume scheme is *"add one more and save more"*, the cart has to make a
second `GET /api/business/pricing` call for its own SKUs and re-derive each line's rung to render
the nudge. That works — and we proved it agrees with you to the cent (§5) — but it is an avoidable
round-trip on the highest-intent page on the site.

**Ask:** add to each cart line —

```json
{
  "b2b_unit_price": 23.27,
  "b2b_line_savings": 4.88,
  "b2b_break_quantity": 3,
  "b2b_next_break": { "min_quantity": 5, "business_price": 22.53, "savings_amount": 1.96 }
}
```

`b2b_next_break` is the valuable half: it is the only field that turns "you saved $4.88" into "add 1
more and save $9.80", and it is the one thing the frontend cannot obtain without a second call.

---

## 5. Consistency gate — the FE's reading agrees with your arithmetic

The live cart reported `b2b_discount.discount_amount: 4.88`. Only one line qualified:
`CTN1070BK` × 4, whose 3+ rung has `savings_amount: 1.22`. `1.22 × 4 = 4.88`, exactly.

That identity is now a **test**: summing `offerAtQuantity(ladder, qty).savings × qty` over the cart's
lines must equal the server's `discount_amount`. If our reading of the ladder ever diverges from
what you actually charge, the suite fails rather than the customer finding out at checkout.

---

## 6. Coupon exclusion — implemented, plus one thing that made it worse than unhandled

Both channels behave exactly as documented and both are handled:

- `POST /api/cart/coupon/preview` → `200 { valid:false, reason:"b2b_volume_pricing", message }`
- `POST /api/cart/coupon` → `400 B2B_COUPON_EXCLUDED`

Worth knowing why it needed care: our `api.js` only returns a structured envelope for a whitelist of
error codes, and a plain 400 **throws**. The exclusion therefore fell into the cart's generic catch,
which said *"Couldn't apply that coupon right now. Please try again."* — about a code that can never
work — and attached a "try this code instead" suggestion for a code that also cannot be combined,
spending one of the customer's limited attempts against an endpoint that locks out.

Now: `B2B_COUPON_EXCLUDED` has its own envelope branch; the exclusion is recognised on preview,
apply-response **and** apply-throw; it never reaches the suggestion renderer; the field is disabled
up front with the reason stated so no attempt is spent at all; and the `?coupon=` recovery-email path
no longer re-opens a form that cannot submit. **Loyalty points are untouched** — only coupons are
excluded, per §3 of the handoff.

---

## 7. What shipped

| Surface | Behaviour |
|---|---|
| PDP | Tappable break chips above the quantity selector; active chip resolved against `#qty-input`; live "at this quantity you pay X" line; tapping a chip sets the quantity; floored SKUs show only non-duplicate rungs plus an explainer |
| PDP sticky buy-bar | Quantity-reactive: the applicable rung's unit price, or **retail** below the entry rung |
| `#product-price` microdata | **Untouched** — still public retail, still the Merchant Center source |
| Product cards | "Business bulk price · $33.24 ea · Buy 3+ · down to $30.09 at 20+" on shop, filters, ribbons, favourites and the landing strip |
| Cart | Row labelled with `company_name`; per-line "add N more to reach 5+" nudges; coupon field disabled with its reason |
| Checkout / payment / confirmation | Same shared discount breakdown; same company label |
| Account dashboard | Company name, Net 30 and credit limit — an absent limit renders nothing, never $0 |
| Everywhere | Zero references to `pricing_tier`, `tier_percent` or bronze/silver/gold |

Never computed client-side: any price. `business_price`, `savings_amount` and `effective_percent`
are rendered verbatim; `discount_percent` (the ceiling) is not read by any render path at all, since
on a floored rung it is not what the customer gets.
