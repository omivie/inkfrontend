# Business Account pricing — Frontend response (Jul 2026)

Re: `business-account-pricing-FE-handoff.md`. **Shipped and verified live** against a real approved bronze account on 2026-07-20. Logged as ERR-110.

Short version: everything in the handoff is built, plus listing tiles, checkout/payment/confirmation and an account panel. **Two of the handoff's payload shapes did not match the live API**, and both failed *silently* — please read §2, it's the only part that needs action from you.

---

## 1. What's wired

| Surface | What a business customer sees |
|---|---|
| PDP | Panel under the buy-box: *"Your business price $34.00 · retail $35.79 · Save $1.79 (5%)"* |
| PDP sticky buy-bar | The business price (was showing retail — see §3) |
| Product tiles (shop, search, category, featured) | Inline *Business price / Save $X (Y%)* under the card price. Batched, ≤100 SKUs per call |
| Cart | `Business account (Bronze tier)  −$4.68`, netted out of "You Save" |
| Checkout / Payment / Order confirmation | Same row, same helper |
| `/account` | *Business account — Bronze tier* panel |

New module `js/business.js` (global `Business`) owns both endpoints. Guests and retail accounts fire **zero** `/api/business/*` requests.

Contract compliance:
- ✅ `business_price` / `savings_amount` / `effective_percent` rendered **verbatim**. No client-side `retail × (1 − tier%)` anywhere — banned by a test that greps for the arithmetic.
- ✅ Gated on `/api/business/status`.
- ✅ Batched, de-duped, **≤100 SKUs/call** (250 SKUs → exactly 3 calls, test-pinned).
- ✅ **Not cached across users**: in-memory only, keyed by user id, wiped on any auth change. No `localStorage`/`sessionStorage` — test-pinned.
- ✅ `floored:true` → we show `effective_percent` and an explicit *"already close to cost"* note; the tier % is **never** printed on a floored line. In fact we always print `effective_percent`, since it equals the tier when nothing is floored.
- ✅ `savings_amount === 0` → no badge, plain retail.
- ✅ `found:false` → plain retail.

---

## 2. ⚠️ Two contract mismatches — please confirm or correct

Both were invisible to a source read and to fixture tests written from the doc (those passed 45/45 while the feature was dead in the browser). Both were caught only by calling the real API.

### 2.1 `status` is `"approved"`, not `"active"`

The doc says the endpoint reports whether the user "has an **active** business account". The live payload is:

```json
{ "status": "approved", "pricing_tier": "bronze", "net30_approved": true,
  "credit_limit": 0, "credit_remaining": 0,
  "application": { "company_name": "Home", "submitted_at": "2026-04-18T01:20:11Z" } }
```

There is no `active` / `is_active` field at all. Our first implementation gated on `status === 'active'` and therefore showed **plain retail to a genuinely approved customer**.

We now accept `approved` and `active` (`Business.ACTIVE_STATUSES`) and treat everything else (`pending`, `rejected`, `suspended`, …) as retail.

**Please confirm the full enum of `status` values**, and specifically whether any value other than `approved` should receive business pricing. Right now an unknown value falls back to retail, which is the safe direction, but it would silently deny a valid customer if you introduce e.g. `active` → `enabled`.

### 2.2 `summary.b2b_discount` is a NUMBER; the object is at the response top level

The doc shows the metadata block as `summary.b2b_discount`. Live, `GET /api/cart` returns:

```jsonc
{
  "b2b_discount": {                 // <-- the OBJECT, at the RESPONSE top level
    "pricing_tier": "bronze", "discount_percent": 5, "effective_percent": 5,
    "discount_amount": 4.68, "floored_line_count": 0, "source": "b2b_tier"
  },
  "summary": {
    "subtotal": 93.96,
    "discount": 4.68,
    "b2b_discount": 4.68,           // <-- a bare NUMBER, not the object
    "loyalty_discount_amount": 0,
    "total": 89.28
  }
}
```

Reading only the documented shape gave `typeof 4.68 !== 'object'` → discount 0 → **the row never rendered**. We now accept both shapes, so if you align the API to its own doc nothing breaks on our side. **No change strictly required** — but the doc should be corrected so the next integrator doesn't lose the same hour.

### 2.3 Answered by live data (was our open question)

**Is `b2b_discount.discount_amount` included in `summary.discount`?** — **Yes.** A cart with only a B2B discount reported `discount === b2b_discount === 4.68`. We net B2B out of the "You Save" line exactly like loyalty. Flagging it here so the convention is on the record; please tell us if that ever changes.

---

## 3. Bugs we found and fixed on our side

Neither is yours; recorded for completeness.

1. **`cart.js` had two drifted summary renderers.** Only the surgical (quantity-change) path rendered the loyalty row and netted it out of "You Save" — so on a *fresh cart load* the loyalty row stayed hidden until the shopper changed a quantity. Adding a third discount line to two divergent paths would have doubled the bug, so both now share one `_renderDiscountRows` / `computeDiscountBreakdown`.
2. **The PDP sticky buy-bar showed retail.** It mirrors `#product-price`, which must keep the public retail price because it carries the `itemprop="price"` microdata. Result: `$35.79` on the buy button, `$34.00` in the panel directly above it. The panel now claims the bar explicitly.

**On cloaking:** we deliberately do **not** write the business price into `#product-price` or its `content` attribute. That element mirrors your prerender and feeds Merchant Center; a per-account price there would be cloaking. The business price is an additive panel outside the buy-box `<dl>`.

---

## 4. Still needed from you

1. **The admin spec.** The handoff says the sales-team manual upgrade is "covered separately in the admin spec" — we have no such doc, and there is no B2B page anywhere in the admin app. Nothing in the admin centre can currently create or tier a business account.
2. **The `status` enum** (§2.1).
3. **A dedicated B2B test account** would be useful. Verification here used the owner's own approved account, which means we could not exercise: a **floored** line (`floored:true` — no thin-margin item in that account's reach), silver/gold tiers, or `payment.html` (would require placing a real order). Those paths are test-pinned against the handoff's fixtures but not live-proven.

---

## 5. Verification

- **New tests**: `tests/business-account-pricing-jul2026.test.js` — **53 tests**, using the *live-captured* payloads as fixtures alongside the handoff's, so both mismatches in §2 are regression-pinned.
- **Full suite**: **2547 pass / 0 fail** (excluding `tests/dashboard-trend-math.test.js`, which is mid-edit by concurrent unrelated work on gross-profit reconciliation).
- **`npm run build`** restamped all `?v=` asset tokens.
- **Playwright, live API, real approved bronze account**:
  - PDP `/p/GDK22225BK` → panel `$34.00` vs retail `$35.79`; `#product-price` `content` still `35.79`; sticky bar `$34.00`.
  - Search tile → `Business price $34.00 Save $1.79 (5%)`.
  - `/cart` → `Business account (Bronze tier) −$4.68`; subtotal `$93.96`; total `$89.28`; "You Save" correctly hidden.
  - `/checkout` → same row; total `$101.28` = 93.96 − 4.68 + 12.00 shipping.
  - `/account` → *Business account · Bronze tier*.
  - Guest and retail sessions → **zero** `/api/business/*` requests, storefront byte-identical to before.
