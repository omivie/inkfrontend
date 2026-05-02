# Backend Passover — April 2026 API Changes

**To:** backend dev
**From:** storefront
**Re:** §11 Open Questions in `api-changes-april-2026.md`
**Date:** 2026-05-02

---

## TL;DR

Storefront has shipped the additive parts of the April release (product fields, cart summary, coupon preview, cross-sell, returning-guest banner, collection JSON-LD on shop pages, recovery-coupon URL auto-apply, friendly Joi messages). All of that consumes endpoints/fields you've already deployed — no further coordination needed there.

This file answers your §11 questions so you can ship the code-side changes you flagged.

---

## Answers to §11 Open Questions

### Q1. Canonical URL split — **YES, ship the 301**

Confirmed: `/products/:slug/:sku` is the canonical URL for **every** active product. The storefront product card now reads `product.canonical_url` directly (replacing client-side construction).

**Action for you:** add the 301 in `src/routes/redirects.js`:
- From: `/html/product?sku=:sku`
- To: `/products/:slug/:sku` (look up the slug from the SKU)

**Edge cases to handle:**
- Unknown SKU → 404, not a redirect to a non-existent slug page.
- SKU that has no slug yet (rare; should be backfilled) → keep serving `/html/product?sku=` rather than 301-ing to a broken URL.

The legacy `/html/product?sku=` URL is still rendered as a fallback in `inkcartridges/js/products.js` for products without a slug. The 301 will collapse those for the indexed/canonical case.

---

### Q2. Brand-categories sitemap path — **NO, skip**

Storefront has no path-based `/brands/:slug/:category` route. Shop is query-string driven: `/html/shop?brand=hp&category=ink`. Building the path-based route is a larger overhaul that isn't planned right now.

**Action for you:** keep the sitemap on `/html/shop?brand=:slug&category=:cat` (or whichever query form you currently emit). No change required.

We may revisit this when/if we modernize shop URLs — will flag it then.

---

### Q3. Printer landing pages — **YES, planned. We'll mint the route.**

This is the only §11 item with material SEO upside ("Brother MFC-J870 ink" is a head term we don't currently own).

**Plan on storefront side:**
- Mint `/printers/:brandSlug/:printerSlug` as a real route.
- Build a printer landing page that fetches `/api/printers/:slug/products` (or equivalent) and renders compatible cartridges.
- Embed `CollectionPage` + `BreadcrumbList` JSON-LD via the `/api/schema/printer/:printerSlug` endpoint we wired up.
- Add `API.getPrinterSchema(slug)` is already in `inkcartridges/js/api.js`, ready to use.

**Action for you (deferred until we ship the route):**
- Swap sitemap entries from `/html/shop?brand=:slug&printer_slug=:slug` to `/printers/:brand/:printer`.
- Confirm the existing `/api/schema/printer/:slug` validates against the slug we'll use (regex `^[a-z0-9][a-z0-9_-]*$` per your doc — should be fine).

We'll send a follow-up message once the storefront route is live so you can swap.

---

### Q4. Static pages — **PARTIAL: only `/html/shop` resolves. Others 404.**

I checked the storefront repo. Current state:

| Sitemap path | Resolves? | Notes |
|---|---|---|
| `/html/shop` (or `/html/shop.html`) | ✅ yes | live and indexable |
| `/html/contact` | ❌ 404 | page was removed in commit `ac40fcd` ("remove footer support pages pending recreation") |
| `/html/privacy` | ❌ 404 | same — pending recreation |
| `/html/terms` | ❌ 404 | same — pending recreation |
| `/html/about` (if emitted) | ❌ 404 | not present in repo |

**Action for you:** **drop `/html/contact`, `/html/privacy`, `/html/terms` (and any `/html/about`) from the sitemap until we recreate them.** Currently wasting Googlebot crawl budget on 404s.

Storefront-side TODO (not urgent, but tracking): rebuild contact/privacy/terms pages. Once they're back, we'll ping you to re-add them to the sitemap.

Index page (`/`), shop, ribbons, brand/category, product, and printer pages are all live and should remain.

---

### Q5. Coupon error UX — **YES, preview-only actionable detail is fine**

Confirmed. Storefront now calls `POST /api/cart/coupon/preview` on debounced input/blur (600ms) so the user sees actionable failure reasons (`minimum_order_required`, `account_too_new`, `already_used`, etc.) **before** they click Apply.

The Apply button (`POST /api/cart/coupon`) keeping the generic "Coupon could not be applied" message for non-MOV failures is fine — it's only hit in the edge case where a user bypasses the live preview.

No code change required from your side for Q5.

---

## What's already shipped on storefront (FYI, no action required)

For full picture — these consume your already-live endpoints/fields. If any of them break in your monitoring, the regression is most likely on our side, but flag us:

| Surface | Backend signal consumed | Storefront file |
|---|---|---|
| Product card | `original_price`, `discount_percent`, `gst_amount`, `canonical_url` | `js/products.js` |
| PDP | `canonical_url`, `original_price`, `discount_percent`, `gst_amount`, `waitlist_available` | `js/product-detail-page.js` |
| Cart summary | `summary.free_shipping_message`, `qualifies_for_free_shipping`, `free_shipping_threshold` | `js/cart.js` |
| Cart | `stamp_card.message` (chip rendering) | `js/cart.js` |
| Cart page | `?coupon=RECOVER…` URL auto-apply, then strip param | `js/cart-page.js` |
| Coupon input | `POST /api/cart/coupon/preview` (debounced) | `js/checkout-page.js` |
| Add-to-cart modal | `frequently_bought_together` + `_url` lazy fallback | `js/cart.js` |
| Guest checkout | `customer_status: 'returning'` + `welcome_message` banner | `js/checkout-page.js` |
| Brand/category page `<head>` | `/api/schema/collection?brand=&category=` JSON-LD | `js/shop-page.js` |
| Validation errors | `details[0].message` (newsletter, coupon Apply) surfaced verbatim | `js/landing.js`, `js/checkout-page.js` |

**Not yet wired** (deferred pending §11 answers above):
- Printer schema embed (`/api/schema/printer/:slug`) — pending Q3 route mint.

**Not consumed (don't need to be):**
- We don't parse `offers.price` client-side, so the `AggregateOffer` change in JSON-LD requires no storefront work.
- We don't override `priceValidUntil` client-side, so your new derivation lands without conflict.

---

## Ops note (you or your ops contact)

- **`PUBLIC_BASE_URL` env var** — set this on staging / preview environments so JSON-LD + sitemap absolute URLs reflect the actual host. Prod is unaffected (falls back to hardcoded `https://www.inkcartridges.co.nz`).

---

## Open follow-ups to message us about

- Once the 301 from Q1 ships, drop us a note so we can verify in Search Console.
- We'll ping you when the `/printers/:brand/:printer` route from Q3 is live.
- We'll ping you when contact / privacy / terms pages from Q4 are recreated.
