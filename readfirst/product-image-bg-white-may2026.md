# Product-Image Background — Pure White (May 2026)

**Status:** active contract
**Layer:** storefront frontend (vanilla CSS)
**Spec date:** 2026-05-06
**Pinned by:** `tests/product-image-bg-white.test.js`

---

## TL;DR

Every region of the storefront that paints behind a cartridge photo is
locked to **pure white (`#FFFFFF`)** through a single CSS variable:

```css
/* base.css */
--product-image-bg: var(--white-primary);
```

That variable is then referenced by every product-image rule across
the codebase. To change the colour for the whole site, edit one line.

---

## Why this exists

Cartridge photos are shipped as transparent-PNG / white-background
JPEGs from suppliers. Before this fix the image surfaces were painted
in the page's neutral grey tokens:

| Token | Hex | Where it leaked in |
| --- | --- | --- |
| `--off-white` | `#F9F9F9` | `components.css .product-card__image-wrapper` |
| `--steel-50` / `--color-background-alt` | `#F8FAFC` | shop card override, dashboard fav, gallery, cart, etc. |
| `#f7fafc` | literal | smart-AC dropdown skeleton card |

The result: every product card looked like a small white tile inside a
slightly grey frame — exactly the "white box within a gray background"
the May 2026 ticket called out from the search-results screenshot.

Painting the same surface white removes the seam: the cartridge box
sits flush against the page so the photo, not the chrome, carries the
visual weight.

---

## Surfaces wired to the contract

| Surface | File | Selector |
| --- | --- | --- |
| Shop / search / related grid card image | `components.css` | `.product-card__image-wrapper` |
| Shop-page card override (search/shop/printer pages) | `pages.css` | `.product-card__image-wrapper` |
| Smart-AC dropdown skeleton card | `search.css` | `.smart-ac__grid .product-card--skeleton .product-card__image-wrapper` |
| Favourites grid card image | `components.css` | `.favourite-item__image` |
| Dashboard favourites card image | `pages.css` | `.dash-fav-card__image` |
| Legacy product-box image | `pages.css` | `.product-box__image` |
| Cart line-item image | `pages.css` | `.cart-item__image` |
| Checkout summary line-item image | `pages.css` | `.checkout-summary__item-image` |
| Order detail line-item image | `pages.css` | `.order-item__image` |
| PDP gallery main image (default) | `pages.css` | `.product-gallery__main` |
| PDP gallery main image (scoped layout) | `pages.css` | `.product-detail__layout .product-gallery__main` |
| PDP gallery thumbnail | `pages.css` | `.product-gallery__thumb` |

Each rule reads `background[-color]: var(--product-image-bg);` — no
literal colours, no hard-coded fallbacks.

---

## How to extend

If a new surface is added that paints behind a product photo (a future
"recently viewed" rail, a comparison-table cell, a quick-look modal
hero, …), set its background to `var(--product-image-bg)` and add an
entry to the `SURFACES` table in
`tests/product-image-bg-white.test.js`. The contract auto-enforces.

To change the colour for every surface at once (e.g. seasonal warm
white, dark mode), edit `--product-image-bg` in `base.css` only.

---

## Cache invalidation

The CSS bundle was tagged `?v=white-cards-may2026` on `base.css`,
`components.css`, `pages.css`, and `search.css` so returning visitors
pick up the change immediately rather than waiting for the prior
cache-bust string (`?v=3line2026`) to expire.

---

## Verification

```bash
node --test tests/product-image-bg-white.test.js   # 14 contract tests, ~40 ms
npm test                                           # full suite, 465 pass / 7 LIVE_E2E skipped
```

Live smoke test (browser, 2026-05-06):

- `/search?q=tn150` — Brother TN150 Black/Cyan/Magenta cards render
  with the cartridge box flush to the page; no grey tile inside the
  card frame.
- `/shop?brand=hp&category=ink` — same.
- `/cart`, `/checkout`, `/account/orders/<id>`, `/account/favourites`
  — every line-item image sits on a white tile.
- `/products/.../G-BRO-TN150-TNR-BK` — gallery main image and thumb
  rail both render on white.
