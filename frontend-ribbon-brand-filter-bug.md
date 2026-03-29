# Frontend Bug: Ribbon Brand Filter Only Showing 2 of 6 Results

## Summary

When filtering ribbons by printer brand (e.g., `?printer_brand=brother`), the frontend only displays 2 ribbons instead of the 6 that the backend API returns. The backend fix has been deployed and verified — this is a frontend-only issue.

## Backend API Response (Verified Working)

**Endpoint:** `GET /api/ribbons?printer_brand=brother&page=1&limit=50`

**Production URL:** `https://ink-backend-zaeq.onrender.com/api/ribbons?printer_brand=brother&page=1&limit=50`

The API correctly returns 6 ribbons:

| # | SKU | Name | Brand |
|---|-----|------|-------|
| 1 | C-BRO-AX10-TRB-BK | Brother AX 10 Typewriter Ribbon Black | Brother |
| 2 | C-BRO-200-TRB | Brother EM100/200/CE60 Typewriter Ribbon | Brother |
| 3 | C-UNI-GROUP1-TRB-BK | Group 1 Typewriter Ribbon Black | Universal |
| 4 | C-UNI-GROUP1-TRB-BKRD | Group 1 Typewriter Ribbon Black/Red | Universal |
| 5 | C-UNI-GROUP24-RIB-BKRD | Group 24 Printer Ribbon Black/Red | Universal |
| 6 | C-UNI-GROUP24-RIB | Group 24 Printer Ribbon Purple | Universal |

The API response includes `"total": 6` in the pagination metadata.

## What Changed on the Backend

The `printer_brand` filter on the ribbons endpoint was returning incomplete results due to two bugs:

1. **Compatibility data was missing** — ribbon-to-printer compatibility links were not being created with correct brand associations. This has been fixed and 1,728 compatibility links now exist in the database.

2. **PostgREST URL length limit** — the `.in()` filter was receiving 795+ UUIDs (from all product types, not just ribbons), exceeding the URL limit. The query now intersects with ribbon product IDs to keep the filter small.

Both fixes are deployed. The API response is correct.

## Likely Frontend Causes to Investigate

### 1. Client-side brand filtering
Check if the frontend is filtering the API results client-side by the ribbon's own `brand` field. The 4 missing ribbons have `brand: "Universal"`, not `brand: "Brother"`. The `printer_brand` filter means "ribbons compatible with Brother printers", not "ribbons manufactured by Brother". If the frontend filters `ribbon.brand === selectedBrand`, it would exclude the Universal ribbons.

**Where to look:** The component that renders the ribbon list after fetching from the API. Check for any `.filter()` calls on the response data that compare the ribbon's `brand` property against the selected printer brand.

### 2. Response caching
The frontend may be caching a stale response from before the backend fix. Check:
- Service worker cache
- SWR/React Query/TanStack Query cache
- Browser HTTP cache (the API returns `Cache-Control` headers)
- Any CDN or edge caching (Cloudflare is in the chain)

### 3. API proxy routing
The frontend is on Vercel. Direct requests to `https://www.inkcartridges.co.nz/api/ribbons?printer_brand=brother` return a Vercel 404, which means the frontend calls the Render backend directly from the browser (not via a Vercel proxy). Verify the frontend is using the correct API base URL and that CORS isn't silently dropping responses.

## How to Verify

1. Open browser DevTools > Network tab
2. Navigate to `https://inkcartridges.co.nz/html/ribbons?printer_brand=brother`
3. Find the XHR/fetch request to the ribbons API
4. Check the **Response** tab — it should contain 6 ribbons with `"total": 6`
5. If the response has 6 but only 2 render, the issue is client-side filtering
6. If the response has 2, check the request URL and headers for caching issues

## API Response Shape

```json
{
  "ok": true,
  "data": {
    "ribbons": [
      {
        "id": "uuid",
        "sku": "C-BRO-AX10-TRB-BK",
        "name": "Brother AX 10 Typewriter Ribbon Black",
        "brand": "Brother",
        "color": "Black",
        "sale_price": 21.95,
        "stock_quantity": 100,
        "is_active": true,
        "image_path": "images/ribbons/153-11/main-v1774514729350.png",
        "created_at": "...",
        "updated_at": "..."
      }
    ]
  },
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 6,
    "total_pages": 1,
    "has_next": false,
    "has_prev": false
  }
}
```

## Key Distinction

- `printer_brand` query param = filter by **compatible printer brand** (via `product_compatibility` junction table)
- `brand` query param = filter by **ribbon manufacturer brand** (on the `products` table directly)
- The ribbon's `brand` field in the response is the **manufacturer** (e.g., "Universal"), NOT the compatible printer brand

The 4 missing ribbons are Universal-brand ribbons that are **compatible with Brother printers/typewriters**. They should display when `printer_brand=brother` is selected.
