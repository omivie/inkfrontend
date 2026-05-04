# Search response enrichment (May 2026)

**Status:** shipped (commit `0e4c25f`, backend `main`).
**Scope:** `/api/search/smart`, `/api/search/by-printer`, `/api/search/by-part`.
**Breaking?** No. Purely additive — every existing field still emits, with the same type and meaning.

## Read-also (only if scope demands it)

This doc is sufficient on its own to adopt the new fields on the search results grid. **Read these too** if your scope includes:

- **Typeahead dropdown UI** (the one that opens as you type) → `docs/storefront/search-dropdown-routing.md`. It pins the load-bearing three-handler rule (printer drill-in row vs product cards vs "View all results" footer) plus the form-submit invariant. Get this wrong and dropdown clicks land on the wrong page.
- **Cart preview, free-shipping nudge, AggregateOffer JSON-LD** (April 2026 wave) → `docs/storefront/api-changes-april-2026.md`. Verify your storefront has adopted those before layering this on top.
- **Product detail page canonical URL parity** → `docs/storefront/value-pack-and-product-url-contract.md`. Same `canonical_url` format as this doc; pinned for the detail-page side.

## What changed

Each product object in the response now carries the same enrichment fields that `/api/products/:sku` already returned. Search cards no longer need a second roundtrip to render discount badges, GST trust copy, or waitlist CTAs.

| Field | Type | Meaning |
|---|---|---|
| `price_includes_gst` | `true` | Constant — every `retail_price` in the system is GST-inclusive (15% NZ). |
| `gst_amount` | number | The GST portion of `retail_price`, rounded to 2dp. |
| `canonical_url` | string | Absolute URL: `https://www.inkcartridges.co.nz/products/<slug>/<SKU>`. Use directly instead of constructing locally. |
| `waitlist_available` | boolean | `true` when `stock_quantity <= 0`. Drives "Notify me when in stock" CTA. |
| `original_price` | number | **Only when `compare_price > retail_price`.** The compare-at price for the "Was $X" line. |
| `discount_amount` | number | **Only when discount.** `compare_price - retail_price`, rounded to 2dp. |
| `discount_percent` | integer | **Only when discount.** Rounded percent off compare. |

## What this unlocks

- "Was $X — Save $Y (Z% off)" badge on search cards (read `original_price` + `discount_percent`)
- "Price includes GST" trust copy below price (read `price_includes_gst`)
- "Notify me when in stock" CTA on OOS cards (read `waitlist_available`)
- Use `canonical_url` directly instead of `/products/${slug}/${encodeURIComponent(sku)}` — eliminates URL drift between the search card link and the detail page canonical, which prevents prerender misses and SEO link-equity leakage.

## Caveats

1. **`/api/search/suggest` is NOT enriched.** The typeahead dropdown payload stays minimal by design (id, name, price, stock, image, category). If you need full enrichment on a typeahead row, fall through to `/search/smart` with the same query.

2. **`/by-printer` and `/by-part` RPC path is best-effort.** When the SQL function (`search_cartridges_by_printer`, `search_products_by_part`) succeeds, we trust whatever columns it returns. If the RPC doesn't include `slug` or `compare_price`, then `canonical_url` and the savings fields are absent for those rows. The fallback path (when the RPC errors) always returns them. Treat all enrichment fields as optional when consuming these two endpoints.

3. **`/search/smart` silently drops broken packs.** Packs whose constituent SKUs are missing from the catalog are filtered before sending. `pagination.total` reflects the pre-filter pool, so a page may show fewer cards than the total suggests. Don't surface this to the user — it's the correct behaviour. The daily 2pm-UTC `detectStalePacks` cron sweeps the catalog; this guard handles the gap between a constituent going inactive and the next cron run.

## TypeScript shape

```ts
// Search-card product as returned by /api/search/smart, /by-printer, /by-part
type SearchProduct = {
  id: string;
  sku: string;
  slug: string | null;
  name: string;
  color: string | null;
  color_hex: string | null;        // null on genuine source (sanitize invariant)
  retail_price: number;            // GST-inclusive
  image_url: string | null;        // resolved, absolute URL
  in_stock: boolean;               // stock_quantity > 0
  stock_quantity: number;
  source: 'genuine' | 'compatible';
  pack_type: 'single' | 'value_pack' | 'multipack' | null;
  brand: { name: string; slug: string | null };
  category: { name: string; slug: string } | null;
  // Search-only:
  relevance_score?: number;
  match_tier?: number;
  description?: string;            // only when ?include=description

  // ── New (May 2026) ────────────────────────────────────────
  price_includes_gst: true;
  gst_amount: number;              // GST portion of retail_price (2dp)
  waitlist_available: boolean;     // true when stock_quantity <= 0
  canonical_url?: string;          // absolute; absent if slug or sku missing
  original_price?: number;         // only when compare_price > retail_price
  discount_amount?: number;        // only when compare_price > retail_price
  discount_percent?: number;       // only when compare_price > retail_price
};

type SearchSmartResponse = {
  ok: true;
  data: {
    products: SearchProduct[];
    facets: unknown | null;
    total: number;                 // pre-filter pool size — see broken-pack caveat
    pagination: {
      total: number;
      page: number;
      limit: number;
      total_pages: number;
      has_next: boolean;
      has_prev: boolean;
    };
    matched_printer?: {
      name: string;
      slug: string;                // printer slug — used in /shop?printer_slug=...
      brand_name: string | null;
      brand_slug: string | null;
    };
    did_you_mean?: string;
    corrected_from?: string;
    popular_fallback?: SearchProduct[];
    popular_fallback_message?: string;
  };
};
```

> **Note for `/by-printer` + `/by-part`:** these endpoints use `product_id` instead of `id` and may omit `slug`, `compare_price`, `relevance_score`, `match_tier` on the RPC path. Treat `canonical_url`, `original_price`, `discount_*` as optional on those two endpoints regardless of source path. The fallback path (RPC error) returns the full shape.

## Sample response

```bash
curl 'https://www.inkcartridges.co.nz/api/search/smart?q=lc233&limit=2'
```

```json
{
  "ok": true,
  "data": {
    "products": [
      {
        "id": "00000000-0000-0000-0000-000000000001",
        "sku": "G-BRO-LC233-INK-BK",
        "slug": "brother-lc233-black",
        "name": "Brother Genuine LC233 Ink Cartridge Black (550 Pages)",
        "color": "Black",
        "color_hex": null,
        "retail_price": 29.99,
        "image_url": "https://<supabase>/storage/v1/object/public/public-assets/images/products/g-bro-lc233-ink-bk/main.jpg",
        "in_stock": true,
        "stock_quantity": 14,
        "source": "genuine",
        "pack_type": "single",
        "brand": { "name": "Brother", "slug": "brother" },
        "category": { "name": "Ink", "slug": "ink" },
        "relevance_score": 220,
        "match_tier": 1,

        "price_includes_gst": true,
        "gst_amount": 3.91,
        "canonical_url": "https://www.inkcartridges.co.nz/products/brother-lc233-black/G-BRO-LC233-INK-BK",
        "waitlist_available": false
      },
      {
        "id": "00000000-0000-0000-0000-000000000002",
        "sku": "C-BRO-LC233-INK-CY",
        "slug": "brother-lc233-cyan-compatible",
        "name": "Brother Compatible LC233 Ink Cartridge Cyan",
        "color": "Cyan",
        "color_hex": "#00FFFF",
        "retail_price": 14.49,
        "image_url": "https://<supabase>/storage/v1/object/public/public-assets/...",
        "in_stock": true,
        "stock_quantity": 50,
        "source": "compatible",
        "pack_type": "single",
        "brand": { "name": "Brother", "slug": "brother" },
        "category": { "name": "Ink", "slug": "ink" },
        "relevance_score": 180,
        "match_tier": 1,

        "price_includes_gst": true,
        "gst_amount": 1.89,
        "canonical_url": "https://www.inkcartridges.co.nz/products/brother-lc233-cyan-compatible/C-BRO-LC233-INK-CY",
        "waitlist_available": false,
        "original_price": 19.99,
        "discount_amount": 5.50,
        "discount_percent": 28
      }
    ],
    "facets": null,
    "total": 2,
    "pagination": { "total": 2, "page": 1, "limit": 2, "total_pages": 1, "has_next": false, "has_prev": false },
    "matched_printer": null
  }
}
```

## matched_printer (unchanged, but worth pinning)

For queries that look like a printer model (letter+digit OR hyphen), the response also includes:

```json
"matched_printer": {
  "name": "Brother MFC-L2750DW",
  "slug": "brother-mfc-l2750dw",
  "brand_name": "Brother",
  "brand_slug": "brother"
}
```

The storefront builds the drill-in URL as:

```
/shop?brand=${matched_printer.brand_slug}&printer_slug=${matched_printer.slug}
```

Both `brand_slug` and `slug` are required by the prerender middleware — see `search-dropdown-routing.md`. Bare-numeric queries (`200`, `67`) intentionally do NOT emit `matched_printer` — gated by `looksLikePrinterModelQuery` in `src/utils/searchHints.js`.

## Action items for storefront team

- [ ] Read `original_price` + `discount_percent` on search cards; render the "Was $X — Save Y%" badge when present.
- [ ] Render "Price includes GST" line below price.
- [ ] Replace local `/products/${slug}/${encodeURIComponent(sku)}` URL construction with `canonical_url`.
- [ ] Wire `waitlist_available` into the OOS state — show "Notify me" instead of "Out of stock".
- [ ] Treat `canonical_url`, `original_price`, `discount_*` as optional on `/by-printer` + `/by-part` (RPC path may omit them).
- [ ] No change required for the existing flow — old fields all still emit.

## Backend reference

- Code: `src/routes/search.js` (response shapers), `src/utils/packResolver.js` (`findBrokenPackConstituentsBatch`), `src/routes/products.js` (`enrichProductForApi`, exported).
- Contract: `claude.md` "Search response contract" subsection.
- Tests: `__tests__/search-smart-enrichment.test.js`, `__tests__/search-by-printer-by-part-enrichment.test.js`, `__tests__/customer-journey.integration.test.js`, `__tests__/search-smart-pack-guard.test.js`, `__tests__/packResolver-findBrokenBatch.test.js`.
