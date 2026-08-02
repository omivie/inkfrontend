# Business volume-discount — range update (Aug 2026)

**FE dev hand-off.** The B2B volume-discount matrix was re-seeded on **2026-08-02**
(backend commit `a9bff6d`, migration 127). The **mechanism is unchanged** — per-line
`price band × quantity` ceiling, floor-clamped to a 5% net margin, served by
`GET /api/business/pricing` and reflected in the cart `b2b_discount` block. Only the
**numbers** changed. This supersedes the sample figures in
[`business-account-pricing-FE-handoff.md`](./business-account-pricing-FE-handoff.md).

## The one-line change

- **Top discount dropped from 18% → 10%.** Old range ≈ 3–18%; new range is **0.5%–10%**.
- **Break quantities changed.** Old breaks were at **3 / 5 / 10 / 20**. New breaks are
  **3 / 4 / 7 / 8** (bands under $100) and **2 / 3 / 6 / 7** (bands $100+).
- There are now **6 price bands** (was 4): the $100+ band was split into $100–$299.99,
  $300–$499.99, and $500+.

## What needs NO change (data-driven — auto-updates)

The live surfaces read the numbers from the API, so **no code change** is needed there:
- **PDP quantity-break table** — rendered from `GET /api/business/pricing` →
  `items[].quantity_breaks[]`. It already shows the new rungs/prices.
- **Cart `b2b_discount`** — `discount_amount` / `effective_percent` are computed
  server-side and already correct.

⚠️ Do **not** re-introduce hardcoded numbers to "fix" these — they're already right.

## What DOES need changing (static copy only)

Search the storefront for any **hardcoded** business/trade/bulk-pricing copy and update it:

| If the copy says (old) | Change to (new) |
|---|---|
| "Save up to **18%**" / "volume discounts up to 18%" / "up to 18% off" | "Save up to **10%**" |
| A range like "**3–18%**" | "up to **10%**" (recommended — avoid advertising the 0.5% floor rung) |
| "Buy **5, 10, or 20**+ to save…" / any fixed break quantities | Prefer **no fixed numbers** ("buy more to save more"); if numbers are shown, use **3 / 4 / 7 / 8** |
| Any **hardcoded tier/price table** | Replace with the live matrix below — or better, drive it from `GET /api/business/pricing` |
| Any leftover **bronze / silver / gold** or `pricing_tier` wording | Remove (already retired in the volume-discount migration) |

Typical places to check: the **business/trade account landing page**, homepage/nav
promos for business accounts, the business-application page, PDP static blurbs that
mention a "%", and **meta titles/descriptions** for those pages.

## The live matrix (for reference / any static table)

Bands are half-open `[min, max)` on the **unit price** (GST-inclusive). "Deepest
qualifying rung wins" — e.g. a $15 item at qty 6 gets the qty-4 rung (5%). The lower
three bands give **0% below qty 3**; the upper three start discounting at **qty 2**.

| Unit price band | qty → % | qty → % | qty → % | qty → % |
|---|---|---|---|---|
| under $20 ($0–$19.99) | 3 → 4% | 4 → 5% | 7 → 8% | 8 → 10% |
| $20 – $49.99 | 3 → 3% | 4 → 4% | 7 → 7% | 8 → 9% |
| $50 – $99.99 | 3 → 2% | 4 → 3% | 7 → 6% | 8 → 8% |
| $100 – $299.99 | 2 → 2% | 3 → 3% | 6 → 6% | 7 → 8% |
| $300 – $499.99 | 2 → 1% | 3 → 2% | 6 → 5% | 7 → 7% |
| $500+ | 2 → 0.5% | 3 → 1% | 5 → 3% | 6 → 5% |

## Unchanged (still true — don't touch)

- **Never sell at a loss:** each % is a *ceiling*; thin items are auto-reduced
  (`floored:true`) so every unit still nets ≥ 5% after fees. The displayed price
  (from the API) is always the charged price — **never recompute client-side**.
- **Coupons stay mutually exclusive** with B2B volume pricing (`B2B_COUPON_EXCLUDED`).
- Business pricing is still gated on `GET /api/business/status` and must not be cached
  across users.

## Cloaking / parity note

If any of these business-pricing pages are **hand-authored static HTML** served by
Vercel (not baked from the backend), the visible copy must match anything structured
(JSON-LD, meta) on the same page — update both together, per the storefront parity rule.
No superlatives ("lowest price", "guaranteed") — keep it to the factual "up to 10%".
