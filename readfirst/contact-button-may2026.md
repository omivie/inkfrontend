# Storefront — replace "Notify me" with "Contact us" button

**For:** storefront / frontend team (FEINK/inkcartridges)
**Backend release:** May 5 2026 — **no backend change required**, this is a frontend-only swap.
**Supersedes:** the "Notify me when in stock" rendering rule in
- `docs/storefront/api-changes-april-2026.md` (TL;DR row, §1 Stock block, §10 checklist)
- `docs/storefront/search-enrichment-may2026.md` (`waitlist_available` table row, §"What to do" bullet, checklist)
- `docs/storefront/value-pack-and-product-url-contract.md` §5.8

The waitlist API stays mounted (`POST /api/products/:sku/waitlist` etc.) so cached bundles don't 404 mid-rollout, but no UI surface should call it anymore.

---

## TL;DR

When a product is out of stock, render a **"Contact us"** link that navigates to `/contact`, styled like the primary "Add to Cart" button. Drop the "Notify me" branch entirely. Also remove the redundant inline "Contact Us" link that currently sits above the price on genuine-OOS cards — the new button covers that affordance.

---

## The new render rule

```jsx
{product.in_stock
  ? <button type="button" className="btn-primary">Add to Cart</button>
  : <a href="/contact"
       className="btn-primary"
       aria-label={`Contact us about ${product.name}`}>
      Contact us
    </a>}
```

| Aspect | Value |
| --- | --- |
| Trigger | `product.in_stock === false` (equivalent to `stock_quantity <= 0`). **Don't** branch on `waitlist_available` — ignore that field. |
| Copy | `Contact us` (sentence case). |
| Href | `/contact` (matches the genuine-OOS prerender link in `src/routes/prerender.js:480`). |
| Element | `<a>` (not `<button>`) so the entire CTA navigates with no JS handler. |
| Class | Same primary-button class as Add to Cart so the card layout is identical to the in-stock state. |
| A11y | Set `aria-label="Contact us about ${product.name}"` so screen readers don't hear identical CTAs across a 24-card grid. Hit target ≥ 44×44px. |

### Also: drop the duplicate inline link

The screenshot showed both a "Contact Us" inline link above the price *and* the bottom button on genuine-OOS cards. With the new button, **remove the inline link** — keep only the button.

---

## Surfaces to update

Every product card / CTA in the app:

| Surface | API source | Notes |
| --- | --- | --- |
| Search dropdown card | `/api/search/suggest` | `stock_quantity` is already in the suggest payload. |
| Search results page | `/api/search/smart` | `in_stock` is in the per-item shape (see search-enrichment-may2026.md). |
| Shop / category card | `/api/shop` | Same shape. |
| Printer page card | `/api/printers/:slug/products` | Same shape. |
| PDP main CTA | `/api/products/:sku` | Single button at the top of the buy box. |

If you have a shared `<ProductCard>` / `<BuyBox>` component, the change is one branch in one file. If "Notify me" is duplicated per surface, search the FE repo for the literal string `Notify me` to find every site.

---

## Backwards compatibility

- `POST /api/products/:sku/waitlist`, `DELETE /api/products/:sku/waitlist`, `GET /api/products/:sku/waitlist/status`, `GET /api/account/waitlist` all stay live — cached older bundles keep working.
- Existing waitlist subscribers in the DB are untouched. Restock notification emails (if/when fired) keep going out to anyone already subscribed.
- `waitlist_available` keeps shipping in API responses — additive payload, no removal needed (just unused).

---

## Verification (run after deploy)

1. **Genuine OOS — search dropdown:** type `lc 37`. The Brother Genuine LC37 Magenta card shows one primary **Contact us** button → `/contact`. No "Notify me" anywhere on the card. No duplicate inline "Contact Us" link above the price.
2. **Genuine OOS — printer page:** open a printer page with a known OOS genuine SKU, same button behavior.
3. **In-stock card (control):** any product with `stock_quantity > 0` still shows **Add to Cart** — no regression.
4. **PDP:** open `/products/brother-genuine-lc37-ink-cartridge-magenta-300-pages/G-BRO-LC37-INK-MG`, main CTA is **Contact us** → `/contact`.
5. **Network panel:** clicking the OOS button does **not** fire a request to `/api/products/:sku/waitlist`. (The endpoint still 200s if hit — verify nothing hits it.)
6. **A11y:** keyboard-tab to the button, hit Enter, lands on `/contact`. Screen reader announces *"Contact us about Brother Genuine LC37 Ink Cartridge Magenta, link"*.

No backend tests change. No `__tests__/` updates required.

---

## CLAUDE.md snippet for the storefront repo

Paste under the existing CTA / product-card section:

> **Out-of-stock CTA (May 2026):** when `product.in_stock === false`, render an `<a href="/contact">Contact us</a>` styled like the Add to Cart button. **Do not** render "Notify me" or call `/api/products/:sku/waitlist` from any UI surface. The waitlist API stays mounted but is unused; `waitlist_available` in API responses is ignored.
