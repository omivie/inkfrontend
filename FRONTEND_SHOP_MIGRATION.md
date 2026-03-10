# Frontend Migration: Use Combined `/api/shop` Endpoint

## Why

The shop page currently makes **3 separate API calls** when loading a brand+category page. Each call has ~500-800ms latency (NZ → US server), so the page takes ~2+ seconds to load.

The new `/api/shop` endpoint combines all 3 into **1 call** that runs all DB queries in parallel server-side.

## Before (3 calls)

```js
const [productsRes, seriesRes, countsRes] = await Promise.all([
  fetch(`${API}/api/products?brand=${brand}&category=${category}&page=${page}&limit=20`),
  fetch(`${API}/api/products/series?brand=${brand}&category=${category}`),
  fetch(`${API}/api/products/counts?brand=${brand}`)
]);

const productsData = await productsRes.json();
const seriesData = await seriesRes.json();
const countsData = await countsRes.json();

const products = productsData.data.products;
const pagination = productsData.pagination;
const series = seriesData.data;
const counts = countsData.data;
```

## After (1 call)

```js
const res = await fetch(
  `${API}/api/shop?brand=${brand}&category=${category}&page=${page}&limit=20`
);
const json = await res.json();

const products = json.data.products;   // same shape as before
const series = json.data.series;       // same shape as before
const counts = json.data.counts;       // same shape as before
const pagination = json.pagination;    // same shape as before
```

## Response Shape

```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "...",
        "sku": "...",
        "name": "Brother LC77XL Ink Cartridge Black",
        "brand": { "id": "...", "name": "Brother", "slug": "brother", "logo_path": "..." },
        "retail_price": 29.99,
        "color": "Black",
        "image_url": "...",
        "in_stock": true,
        ...
      }
    ],
    "series": [
      { "code": "LC77", "count": 8 },
      { "code": "LC73", "count": 12 }
    ],
    "counts": {
      "ink": 45,
      "toner": 30,
      "drums": 5
    }
  },
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "total_pages": 3,
    "has_next": true,
    "has_prev": false
  }
}
```

## Supported Query Parameters

| Parameter  | Type   | Default    | Notes                                              |
|------------|--------|------------|----------------------------------------------------|
| `brand`    | string | (required) | Brand slug (e.g. `brother`, `canon`, `fuji-xerox`) |
| `category` | string | optional   | `ink`, `toner`, `printer`, `laser`, `inkjet`, `consumable`, `cartridge` |
| `source`   | string | optional   | `genuine` or `compatible`                          |
| `page`     | int    | 1          | Page number                                        |
| `limit`    | int    | 20         | Results per page (max 200)                         |
| `search`   | string | optional   | Search by name/sku/MPN                             |
| `color`    | string | optional   | Color filter                                       |
| `sort`     | string | `name_asc` | `price_asc`, `price_desc`, `name_asc`, `name_desc` |

## Notes

- The old endpoints (`/api/products`, `/api/products/series`, `/api/products/counts`) still work and are cached — no breaking changes.
- The `/api/shop` response is cached for 60 seconds server-side.
- `brand` is required for this endpoint. For non-brand pages, continue using `/api/products`.
