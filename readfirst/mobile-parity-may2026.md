# Mobile Parity — Storefront Response (May 2026)

**Re:** `mobile-parity-audit-may2026.md` (backend dev, audited live site 2026-05-20).
**This repo:** vanilla-JS static SPA (no React/Next/Vue — the audit's `useTitle`/JSX
snippets were translated to the real architecture).
**Pinned by:** `tests/mobile-parity-may2026.test.js` (22 tests) + the contract tests
listed per item. Cache key for the touched CSS/JS: **`v=mobile-parity-may2026`**.

Every finding was verified against the actual code before acting — several were
**already shipped** (the audit cited older contracts), and one (**S1.4**) is
**stale and was deliberately NOT actioned**.

---

## Shipped in this pass

| ID | Finding | What we did |
|----|---------|-------------|
| **S0.1** | Header icon-only links: no accessible name, <44px targets | `aria-label` added to Account/Favourites/Cart/Admin links + hamburger across all 25 byte-identical headers; `updateCartCount()` keeps the cart link at `"Cart, N items"`; cart badge `aria-hidden`. CSS: header action items, `.nav-toggle`, nav search button all ≥44×44 on mobile. Verified live @375px: 44×44, label `"Cart, 14 items"`. |
| **S0.6** | Tap-to-call phone hidden on mobile (`display:none`) | `.header-contact` re-shown on mobile as a 44px tap-to-call chip; email hidden. Verified live: tel link 132×44 visible, email hidden. |
| **S0.5** | Footer 2,081px tall on mobile | Footer link columns are now `<details>`/`<summary>` accordions (keyboard-operable). Desktop: all expanded, summary neutered to read as a heading. Mobile: only Contact open. Verified live @375px. |
| **S0.11** | Body 364 vs viewport 375 (scrollbar gutter) | `html { overflow-y: auto }` below 768px (overrides modern-effects.css desktop gutter). Verified: `clientWidth === innerWidth === 375`. |
| **S1.1** | Search dropdown 6→2 cards/row still cramped | Single-column horizontal-thumb list (64px thumb + content) at ≤480px; per-card Add-to-Cart hidden (tap row → PDP). 4-line title clamp kept (title-clamp contract). |
| **S1.2** | Printer drill-in row scrolls away; `vh` keyboard bug | `.smart-ac__top-row--printer` is now `position:sticky; top:0`; mobile dropdown `max-height: 70dvh` (with `70vh` fallback). |
| **S1.5** | Card Add-to-Cart 36px tall | `.product-card__add-btn` + favourites-page buttons → `min-height:44px` / 44×44 at ≤768px. (OOS "Contact us" CTA already had 44px.) |
| **S2.1** | PDP favourite button clipped ~47px past viewport | `.product-info__actions` becomes a `1fr / 48px` grid at ≤480 (qty spans its own row; Add-to-Cart + 48px favourite share row 2). Verified: computed grid `1fr 48px` @375px → favourite confined, cannot overflow. |
| **S2.4** | Breadcrumb last item duplicates the H1 | `#breadcrumb-product` hidden at ≤480 (scoped by id — other pages' breadcrumbs untouched). |
| **S3.1** | Cart "Proceed to Checkout" not sticky | Mobile-only fixed `.cart-sticky-bar` (total + CTA), IntersectionObserver-driven off the real button, safe-area aware. CTA wears `.cart-summary__checkout-btn` so cart.js's validate-then-checkout delegation runs. Verified live. |
| **S3.2** | Coupon endpoints shipped but no input UI | "Have a coupon?" `<details>` + form wired to existing `API.previewCoupon` (idle/blur, surfaces specific reason) + `API.applyCoupon` (submit). `?coupon=` auto-apply already existed. Verified live. |
| **S0.3** | `/shop?category=ink` (no brand) → permanent "warming up" error | Category-only URLs now route to a **brand picker** ("Choose a brand to see ink cartridges") instead of calling the brand-required series endpoint. Picking a brand drills into the chip grid (`navigateTo('codes',{brand,category})`; the codes case now honours an explicit `data.brand`). Verified live: no error, 10 tiles, click → `/shop?brand=hp&category=ink`. |
| **S0.8** | No `env(safe-area-inset-*)` | Sticky bars use `padding-bottom: calc(... + env(safe-area-inset-bottom))`; `viewport-fit=cover` now on cart + PDP + shop so the insets resolve. |
| **S3.6** | Checkout stepper wrap on mobile | Compact stepper kept single-line at ≤480 (`flex-wrap:nowrap`, xs labels). Already collapsed full-width at ≤768. |

## Already shipped before this audit (regression-guarded, not re-done)

- **S0.2** — PDP `<title>` is `"<Brand> <Model> … NZ | InkCartridges.co.nz"` (Genuine-prefixed for OEM). **No** "Save up to 70%/lowest/guaranteed". Guarded.
- **S0.7 / S2.2** — PDP already has the mobile sticky add-to-cart bar (`#sticky-atc`, IntersectionObserver, mobile-only). Guarded.
- **S2.5** — Strikethrough `original_price` + "Save $X (Y%)" already render on PDP and cards (packs omit %).
- **S3.3** — Cart free-shipping progress bar (`#cart-shipping-bar`/`#shipping-bar-fill`) already exists.
- **S3.4** — Stamp-card chip (`#cart-stamp-card-chip`) already renders for logged-in users.
- **P-1** — Lazy-loading / `srcset` / WebP already in place.

## Deliberately NOT actioned (with reasons)

- **S1.4 — re-add per-card COMPATIBLE/GENUINE source chip.** **Rejected.** The chip was *deliberately removed* in `source-chip-removal-may2026` (section headings + the product name already convey source). The audit cited the older `category-page-contract-may2026.md §1`; the removal supersedes it. Regression-guarded so it is *not* reintroduced.
- **S2.6 — "we'll email you when it's back in stock" tooltip.** **Skipped.** Conflicts with `contact-button-may2026` (OOS shows a "Contact us" CTA, pill reads "Contact Us For Stock Enquiries") and `retail-wording-may2026` (waitlist UI was removed). Adding back-in-stock-email copy would reintroduce retired waitlist messaging.

## Out of scope / needs you or a test account

- **S0.4 console errors** — most originate from backend calls (cold start / chip-grid load) and `botPrerender`, not the four `DebugLog` wraps. The S0.3 fix removes the chip-grid-failure errors on `/shop?category=ink`; the rest are a backend/DebugLog item.
- **S0.9 hamburger mega-menu (130 links)** — the nav drawer itself ships only 5 top-level items + two mega-toggles; the 130 links live in the brands/ribbons **mega panels**. A two-step disclosure rework is a larger nav-IA change tracked separately.
- **S0.10 bottom nav** — flagged "decision then defer" by the audit; deferred (would collide with the new sticky bars).
- **S1.3 popular-codes quick-pick** — P2 CRO, deferred.
- **S4.x account/lifecycle surfaces** — behind auth; need a customer test account to audit `/account`, `/account/favourites`, subscriptions, my-printers at 375px.
- **P-2/P-3** — Lighthouse mobile CLS + reduced-motion/Dynamic-Type need a real-device/Lighthouse run.
