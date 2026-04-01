# Backend SEO Handoff — Frontend Changes Deployed

Frontend SEO fixes from the audit are complete. Below is everything the backend needs to update to stay in sync.

---

## 1. Sitemap Updates

### Homepage URL changed
The homepage now serves at `/` instead of `/html/index`.

- **Old:** `https://www.inkcartridges.co.nz/html/index`
- **New:** `https://www.inkcartridges.co.nz/`

Update the sitemap entry accordingly.

### New pages to add to sitemap

| URL | Page Type | Priority |
|-----|-----------|----------|
| `https://www.inkcartridges.co.nz/ink-cartridges` | Category landing | High |
| `https://www.inkcartridges.co.nz/toner-cartridges` | Category landing | High |
| `https://www.inkcartridges.co.nz/genuine-vs-compatible` | Guide/article | Medium |
| `https://www.inkcartridges.co.nz/brands/hp` | Brand landing | High |
| `https://www.inkcartridges.co.nz/brands/canon` | Brand landing | High |
| `https://www.inkcartridges.co.nz/brands/epson` | Brand landing | Medium |
| `https://www.inkcartridges.co.nz/brands/brother` | Brand landing | Medium |

Suggested `<changefreq>` for brand/category pages: `weekly`
Suggested `<changefreq>` for the guide page: `monthly`

---

## 2. SearchAction Parameter Alignment

The frontend WebSite JSON-LD schema (on the homepage) now uses `?search=` instead of `?q=` to match the backend's `/api/schema/site` endpoint:

```json
"target": "https://www.inkcartridges.co.nz/html/shop?search={search_term_string}"
```

The shop page JS handles **both** `?search=` and `?q=` params (line 264 of `shop-page.js`), so either works. But for consistency, both frontend and backend now use `?search=`.

No backend change needed here — just confirming alignment.

---

## 3. Homepage Redirects (Frontend-side, FYI)

These 301 redirects are configured in the frontend's `vercel.json`:

```
/html/index     -> /    (301)
/html/index.html -> /   (301)
/html            -> /   (301)
```

The backend's existing redirect for `/html/product/?sku=X` -> `/products/{slug}/{sku}` is still needed and working.

---

## 4. Product API — `slug` field usage

The frontend now uses `product.slug` from API responses to build SEO-friendly links:

```
/products/{slug}/{sku}
```

This is working correctly. All internal product links use this format when `slug` is available, with a fallback to `/html/product/?sku=X` (which the backend 301-redirects).

**Confirm:** The `slug` field is returned on all product endpoints:
- `GET /api/products` (list)
- `GET /api/products/:sku` (detail)
- `GET /api/products/search` (search results)

---

## 5. Category Pages — API Expectations

The new category landing pages (`/ink-cartridges`, `/toner-cartridges`) fetch products using:

```js
API.getProducts({ category: 'ink', limit: 40 })
API.getProducts({ category: 'toner', limit: 40 })
```

**Confirm:** The `/api/products` endpoint supports `?category=ink` and `?category=toner` as filter params.

---

## 6. Brand Pages — API Expectations

The brand landing pages (`/brands/hp`, `/brands/canon`, etc.) fetch products using:

```js
API.getProducts({ brand: '{slug}', limit: 40 })
```

They also support category sub-filtering (ink, toner, drum) on the client side.

**Confirm:** The `/api/products` endpoint supports `?brand=hp` (etc.) as a filter param.

---

## 7. No Other Backend Changes Needed

These items from the original audit are already done or handled frontend-side:

- [C2] www vs non-www canonical — fixed in frontend JS/HTML
- [C3] Homepage at `/` — frontend file move + Vercel redirects
- [C4] Product title from SKU — frontend JS handles this
- [C5] BreadcrumbList JSON-LD — already correct in frontend
- [C6] Organization schema phone — already correct
- [W1] Shop filter page titles — frontend JS handles dynamically
- [W2] FAQPage schema — already on homepage
- [W3] Preconnect for ds.co.nz — added to shop + product pages
- [W7] Homepage title length — shortened to 63 chars

---

## Summary of What Backend Needs To Do

1. **Update sitemap:** Change homepage entry from `/html/index` to `/`
2. **Add to sitemap:** 7 new page URLs (see table above)
3. **Verify:** `slug` field is on all product API responses (list, detail, search)
4. **Verify:** `?category=ink` and `?category=toner` filters work on `/api/products`
5. **Verify:** `?brand=hp` (etc.) filter works on `/api/products`
