# Per-Card Source Chip Removal — May 2026

**Date:** 2026-05-10
**Status:** Shipped
**Pinned by:** `tests/category-page-contract-may2026.test.js` (rev 2)
**Supersedes:** `category-page-contract-may2026.md` §1 (the original chip rule)

## What changed

Every list-view product card used to ship a top-left chip — yellow `COMPATIBLE`
or blue `GENUINE` — driven by `product.source`. That chip is now retired from
list-view cards.

**Before:**

```
┌──────────────┐
│ [COMPATIBLE] │   ← per-card chip (REMOVED)
│              │
│   <image>    │
│              │
└──────────────┘
LC39BK Compatible Ink Cartridge for Brother LC39 Black
```

**After:**

```
┌──────────────┐
│              │
│              │
│   <image>    │
│              │
└──────────────┘
LC39BK Compatible Ink Cartridge for Brother LC39 Black
```

## Why

The chip was pure redundancy:

1. The **section heading** above each grid already declares source — every
   shop / search / brand page renders a `[COMPATIBLE] Brother Compatible
   Inkjet Cartridges` or `[GENUINE] Brother Original Inkjet Cartridges`
   heading above the cards. That heading badge is **kept**.
2. The **product name itself** declares source — every compatible product is
   named `<CODE> Compatible Ink Cartridge for …` and every genuine is
   `Brother Genuine LC39 …`. That name is what the user reads first on the
   card.

A third repetition on the card image was visual noise that crowded the
thumbnail with no information gain.

## Surfaces touched

### Removed the per-card chip

| File | Function | Change |
|---|---|---|
| `inkcartridges/js/products.js` | `Products.renderCard` | Drop `sourceBadgeHTML`; chip-stack now hosts only fits-printer + save-discount. |
| `inkcartridges/js/shop-page.js` | `Shop.createProductCard` | Drop `sourceBadgeHTML`; chip-stack now hosts only fits-printer. |
| `inkcartridges/js/landing.js` | featured-products grid | Drop `chipStackHTML` entirely (no other chips on this surface). |
| `inkcartridges/js/ribbons-page.js` | `createRibbonCard` | Drop `sourceChipHTML` entirely (single-source list). |
| `inkcartridges/js/api.js` | `getSourceBadge` helper | Deleted — no callers. |
| `inkcartridges/css/components.css` | `.product-card__badge--compatible/--genuine` rules | Deleted — no usages. |

### Preserved (intentionally)

| Surface | Element | Reason |
|---|---|---|
| Shop / PDP related-products **section heading** | `.badge.badge-compatible` / `.badge.badge-genuine` | Section heading is the contract reference: "we already say whether it is a genuine or compatible **as headings**." |
| Cart line items | `.source-badge--compatible/--genuine` | Different element, no heading present in cart view. |
| Checkout line items | `.source-badge--compatible/--genuine` | Same — different surface, no heading. |
| Favourites line items | `.source-badge--compatible/--genuine` | Same — line-item layout. |
| Order detail line items | `.source-badge--compatible/--genuine` | Same. |

### Preserved chip-stack

`.product-card__chip-stack` is still load-bearing — it hosts the
`Fits Your Printer` chip (when /smart matched the user's printer) and the
`Save $X` discount chip on `Products.renderCard`. CSS geometry rules
(`position: absolute; top-left; flex column`) survive unchanged.

## Acceptance

Visual: open `/shop?brand=brother&category=ink&code=LC39`. The two section
headings (`COMPATIBLE Brother Compatible Inkjet Cartridges`,
`GENUINE Brother Original Inkjet Cartridges`) keep their chips; every product
card is chip-free in the top-left of the image. Value Pack / Multipack
ribbons in the top-right and `Save $X` discount badges still render.

Tests: `node --test tests/category-page-contract-may2026.test.js` — 18 tests:
- §1 helper deleted, classes deleted, no list-view renderer references them
- §1 chip-stack still appears for fits-printer / discount
- §1 PDP section heading badge preserved
- §1 cart/checkout/favourites/order-detail `.source-badge` preserved
- §2 / §3 unchanged from the original spec

## Why we kept the test file under the same name

`category-page-contract-may2026.test.js` still pins §2 (For Use In PDP-only)
and §3 (honest Did you mean banner). Renaming would lose that traceability;
§1 simply got **inverted** rather than dropped.
