# Backend Request: Raise `/api/search/suggest` `limit` cap from 10 → 24

## Summary
The frontend search dropdown now renders a 6-column × 4-row grid (24 products) plus a "View all results" button that links to `/html/shop.html?search=<q>`. The frontend sends `limit=24` to `GET /api/search/suggest`, but the backend's Joi validator still caps `limit` at 10, so every query errors out with `VALIDATION_FAILED` and the dropdown shows "Search is temporarily unavailable."

## Repro

```bash
curl -s "https://ink-backend-zaeq.onrender.com/api/search/suggest?q=co&limit=24"
```

Current response:
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      { "field": "limit", "message": "\"limit\" must be less than or equal to 10" }
    ]
  }
}
```

Expected: `200 OK` with up to 24 `suggestions`.

## What needs to change

Raise the `limit` maximum on the `/api/search/suggest` endpoint validator from **10 → 24**.

Likely locations (search the backend repo):
- Joi schema for the suggest route — look for `limit` with `.max(10)` or `.default(10)`
- Route file likely named something like `routes/search.js`, `routes/suggest.js`, or `controllers/search*.js`
- Grep suggestions: `grep -rn "suggest" src/ routes/ controllers/` and `grep -rn "limit.*max(10)" src/`

Change:
```js
limit: Joi.number().integer().min(1).max(10).default(10)
// →
limit: Joi.number().integer().min(1).max(24).default(10)
```

Keep the default at 10 for backwards compatibility with any other caller. Only the cap needs to rise.

## Also verify

1. The underlying query/DB call actually honors the requested limit (no hard-coded `LIMIT 10` in SQL). If there is, bump that too or pass the validated `limit` through.
2. The response payload shape is unchanged. Frontend expects:
   ```json
   {
     "ok": true,
     "data": {
       "suggestions": [ /* up to 24 product objects */ ],
       "matched_printer": { "name": "...", "slug": "..." } | null,
       "did_you_mean": "string" | null
     }
   }
   ```
   Each suggestion object needs at minimum: `id`, `sku`, `slug`, `name`, `price` (or `retail_price`), `brand`, and image fields. (See current 10-result response for exact shape.)
3. Performance — 24 rows instead of 10 should be negligible, but confirm the query uses the existing index on the search columns. If a full-text / trigram index is in play, no action needed.

## Context: frontend change already shipped

File: `inkcartridges/js/search.js`
```js
const LIMIT = 24; // was 10
```

The dropdown now renders 24 cards in a 6×4 grid plus a "View all results for '<q>' →" button. The button links to `/html/shop.html?search=<q>`, which is a separate full results page (not affected by this change).

## Endpoint reference

- URL: `GET /api/search/suggest`
- Query params: `q` (string, required, min 2 chars), `limit` (integer, optional)
- Deployed at: `https://ink-backend-zaeq.onrender.com`
- Consumer: `inkcartridges/js/search.js` (fetches on debounced typeahead input)

## Done when

```bash
curl -s "https://ink-backend-zaeq.onrender.com/api/search/suggest?q=hp&limit=24" | jq '.ok, (.data.suggestions | length)'
```
returns:
```
true
24   # (or fewer if fewer matches exist)
```

and the frontend search dropdown on https://inkcartridges.co.nz loads without the "Search is temporarily unavailable" banner.
