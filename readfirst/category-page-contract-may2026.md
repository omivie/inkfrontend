# Storefront Category & Search Page Contract — May 2026

Frontend implementation spec, paired with the backend changes shipped in the May 2026 catalog health sweep. Backend already emits the signals; this doc captures the rendering rules the FEINK repo must implement.

## 1. Per-card "COMPATIBLE" / "GENUINE" chip

**Rule:** every product card in a list view (catalog, printer products, search) MUST display a small chip at the top-left identifying source.

- `product.source === 'compatible'` → yellow `COMPATIBLE` chip.
- `product.source === 'genuine'` → blue `GENUINE` chip.

**Where it must appear:**
- `/shop` (any filter combination)
- `/search` (smart, by-printer, by-part)
- `/products/printer/:printerSlug` (printer product list)
- `/printers/:brandSlug/:printerSlug` (printer detail page product grid)
- Brand pages and category pages

**Where it does NOT appear:** the product detail page (PDP) — the source is already implicit from the page heading copy ("HP Genuine 72…", "Compatible Ink Cartridge Replacement for…").

**Existing chip placement:** the section header (e.g. "Epson Compatible Inkjet Cartridges") already gets a chip rendered above it. Keep that. Per-card chips are additive — they ride on every individual tile so that cross-source mixed search results stay scannable.

**Backend signal:** `source: 'compatible' | 'genuine'` is on every product row from every catalog endpoint. Confirmed in `src/utils/storage.js` `sanitizeProductForApi` and `src/routes/products.js` `enrichProductForApi`.

**Acceptance:**
- Open `/search?q=bci6`. Every card on the page has either a yellow COMPATIBLE or blue GENUINE chip at the top-left, regardless of whether the card has an image or a fallback colour swatch.
- Open `/shop?brand=epson&category=ink&code=200`. Every Epson 200 single shows a yellow COMPATIBLE chip.
- Open `/shop?q=Brother MFC-615W`. Each card carries the source chip; the FITS YOUR PRINTER chip stacks above or beside the source chip without overlapping.

## 2. "For Use In" — PDP only, never on list pages

**Rule:** the aggregated "For Use In: Epson XP100, Epson XP200, …" block MUST be hidden on every list page. It belongs ONLY on the product detail page.

**Where it must NOT appear:**
- `/shop?…` (any filter, including `?code=`)
- `/search?q=…` (any query)
- `/products/printer/:slug` (despite the printer context)
- `/printers/:brand/:slug`

**Where it MUST appear:** PDP only — `/products/:slug/:sku`.

**Backend reality:** none of the catalog list endpoints (`/api/shop`, `/api/products/printer/:slug`, `/api/printers/:slug/products`, `/api/search/smart`, `/api/search/by-printer`, `/api/search/by-part`) emit a top-level `compatible_printers[]` array. The list pages currently building this block are aggregating per-product data client-side. The fix is purely FE — strip the aggregation.

**Acceptance:**
- Open `/shop?brand=epson&category=ink&code=200`. The "For Use In: …" block under the FREE SHIPPING banner is GONE.
- Open `/products/epson-genuine-200-ink-cartridge-cyan/G-EPS-200-INK-CY`. The "For Use In: …" block IS present.
- Open `/search?q=Brother MFC-615W`. The "For Use In:" block is GONE; the printer-context "FITS YOUR PRINTER" chips remain on each card.

## 3. Honest "Did you mean X?" banner

**Rule:** when the API response carries `did_you_mean: <string>`, render the banner as `"Did you mean <string>?"` with the suggestion as a clickable link to `/search?q=<encoded>`.

**Stop rendering:** "Showing similar results. Search instead for `<query>`" — that copy was misleading because the original query was never asked for again. The honest framing is "we think you meant X, click to switch."

**Backend signal:** `did_you_mean` is now populated in two places:
1. Zero-result fallback (existing behavior).
2. Weak-result fallback (May 2026, F1) — fires when the score floor leaves only 1-2 results but the raw RPC found ≥5. The FE branch can be the same.

**Acceptance:**
- `/search?q=tn645z` → `did_you_mean: "TN645"` → banner reads "Did you mean **TN645**?"
- `/search?q=645` → backend's bare-numeric ILIKE fallback returns the full TN645 lineup; `did_you_mean` may be null, banner not shown.

## 4. Out-of-scope (handled elsewhere)

- **Sort order spec** — see `sort-hierarchy-spec.md` (sibling doc shipped same day).
- **Ink Finder UX** — see `ink-finder-may2026.md` (sibling doc shipped same day).
- **Pack savings badge** — already shipped April 2026; see `value-pack-and-product-url-contract.md` §5.1.

## Migration checklist (FEINK repo)

- [ ] Add `<SourceChip source={product.source} />` to the card component and render on every list page.
- [ ] Remove the page-level `compatible_printers` aggregation from category/search/printer-list views.
- [ ] Update banner copy: replace "Showing similar results. Search instead for X" with "Did you mean X?".
- [ ] Update playwright `tests/e2e/01-catalog-page.spec.js` (or equivalent) to assert per-card chip presence.
