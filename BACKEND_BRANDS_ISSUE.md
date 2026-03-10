# Backend Issue: /api/brands returning incomplete brand list

## Problem
The admin product edit brand dropdown only shows ~9 brands, but there are 20+ active brands in the database (Amano, Citizen, Fujitsu, IBM, Panasonic, Star, etc. are all missing).

## Root Cause
The frontend is **not** hardcoding brands. It dynamically fetches from `GET /api/brands` and renders whatever the API returns. The issue is on the backend — the endpoint is returning a filtered/incomplete subset.

## Frontend Code (for reference)
- **Admin products page**: `inkcartridges/js/admin/pages/products.js`
  - Line 1170: `const brandsData = await AdminAPI.getBrands();`
  - Line 1171: `_brands = brandsData && Array.isArray(brandsData) ? brandsData : [];`
  - Line 303-313: `buildBrandSelect()` renders all returned brands into the dropdown
- **API call**: `inkcartridges/js/admin/api.js`
  - Line 377-384: `getBrands()` calls `window.API.get('/api/brands')` and returns `resp.data`

## Backend Endpoint
- `GET https://ink-backend-zaeq.onrender.com/api/brands`
- Check if the query is filtering by `active = true` or has a `LIMIT` clause
- Should return all brands that have at least one active product, or all brands in the brands table

## Expected Behavior
The endpoint should return all brands available in the database (20+), not just a subset of ~9.
