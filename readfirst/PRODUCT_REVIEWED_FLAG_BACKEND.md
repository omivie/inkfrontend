# Backend: Product "Reviewed" Flag — Handoff

## Goal

The admin **All Products** table (`/html/admin#products`) needs a small per-product "Reviewed" checkbox so the shop owner can tick off products once they've audited the details (name, images, SKU, pricing, compatibility, etc.). The frontend already ships a working version backed by **`localStorage`** — meaning the checkmark is only visible on the one browser that set it.

We now want the flag to **persist in the database** so it syncs across devices and across admin accounts. This is shared state: if Vieland marks a product as reviewed, Jackson should see the same tick on his laptop.

---

## Scope — what to build

1. **DB migration** — add three columns to `products`:
   - `reviewed` (boolean, default false)
   - `reviewed_at` (timestamptz, nullable)
   - `reviewed_by_email` (text, nullable) — audit trail
2. **New endpoint** — `PUT /api/admin/products/:productId/reviewed` — toggles the flag for one product.
3. **Include `reviewed` in existing product GET responses** so the table can render the correct initial state without an extra round-trip.
4. **(Optional)** allow filtering the product list by reviewed state (`?reviewed=true|false`) — useful for "show me what I haven't reviewed yet".

Everything else (UI, localStorage → API swap) is handled on the frontend after this ships.

---

## 1. Database migration

Target table: **`products`** (the existing products table — not a new one).

```sql
-- migrations/YYYYMMDD_product_reviewed.sql

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS reviewed          BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ   NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by_email TEXT          NULL;

-- Partial index: the typical query is "find unreviewed products", so only index where false.
CREATE INDEX IF NOT EXISTS idx_products_unreviewed
  ON products (id)
  WHERE reviewed = FALSE;
```

**Notes**

- No backfill needed — `DEFAULT FALSE` sets every existing row to unreviewed, which matches the current frontend behaviour (nothing is ticked until an admin clicks it).
- Keep this column outside any existing RLS policies that gate product reads — both admins already have full read/write on `products` via their existing admin role, so no new RLS needed.
- `reviewed_by_email` is a plain text audit field (not an FK to `auth.users`). That keeps it resilient if an admin account is renamed/removed and matches how we already store `created_by_email` on `planner_tasks` / `planner_notes`.

---

## 2. Endpoint: toggle reviewed

### `PUT /api/admin/products/:productId/reviewed`

Follows the exact same pattern as the existing `PUT /api/admin/products/:productId/import-lock` route — toggle the current boolean, stamp `reviewed_at` / `reviewed_by_email` when setting to true, clear them when setting to false.

**Request**

- URL param: `:productId` (uuid).
- No body required — this is a pure toggle.
- Must require an authenticated admin session (reuse whatever middleware `import-lock` uses).

**Behaviour**

```
currentReviewed = SELECT reviewed FROM products WHERE id = :productId
nextReviewed    = NOT currentReviewed

if nextReviewed:
  UPDATE products
  SET reviewed = TRUE,
      reviewed_at = now(),
      reviewed_by_email = <admin email from auth context>
  WHERE id = :productId
else:
  UPDATE products
  SET reviewed = FALSE,
      reviewed_at = NULL,
      reviewed_by_email = NULL
  WHERE id = :productId
```

**Response** (200 OK)

Match the existing success envelope used across `/api/admin/*` routes:

```json
{
  "ok": true,
  "data": {
    "id": "a1b2c3d4-...",
    "reviewed": true,
    "reviewed_at": "2026-04-24T22:31:07.123Z",
    "reviewed_by_email": "junjackson0915@gmail.com"
  }
}
```

**Error cases**

- `404` if the product id doesn't exist → `{ "ok": false, "error": "Product not found" }`
- `401` if not an authenticated admin → `{ "ok": false, "error": "Unauthorized" }`
- `500` on unexpected DB error → `{ "ok": false, "error": "..." }`

---

## 3. Include `reviewed` in existing GET responses

Two product-list endpoints need to start returning the new fields so the UI can paint the correct initial state:

### a. `GET /api/admin/products` (list)

Add to the SELECT list / column projection:

- `reviewed`
- `reviewed_at`
- `reviewed_by_email`

The frontend will only read `reviewed` today, but returning the other two now is cheap and lets us add a tooltip ("Reviewed by junjackson0915@gmail.com on 24 Apr") without another round-trip later.

### b. `GET /api/admin/products/:productId` (detail)

Same — include the three new columns in the response.

Note: there is also a direct Supabase query path in the frontend (`inkcartridges/js/admin/pages/products.js`, around line 265 — the `selectCols` string). That path is frontend-side and will be updated when the frontend flips over; **no backend change needed for that path**.

---

## 4. (Optional) Filter support

If easy, add a query param to `GET /api/admin/products`:

- `?reviewed=true` → only rows where `reviewed = TRUE`
- `?reviewed=false` → only rows where `reviewed = FALSE`
- omitted → no filter

This unlocks a future "All Images / All Status" style dropdown on the frontend ("All · Reviewed · Unreviewed"). Skip if non-trivial — the frontend ships fine without it.

---

## 5. Testing checklist

Run these after implementing:

```bash
# toggle on (expect reviewed=true, timestamps populated)
curl -X PUT \
  -H "Authorization: Bearer <admin-token>" \
  https://ink-backend-zaeq.onrender.com/api/admin/products/<some-product-id>/reviewed

# toggle off (expect reviewed=false, timestamps null)
curl -X PUT \
  -H "Authorization: Bearer <admin-token>" \
  https://ink-backend-zaeq.onrender.com/api/admin/products/<some-product-id>/reviewed

# list endpoint now includes `reviewed` on every row
curl -H "Authorization: Bearer <admin-token>" \
  "https://ink-backend-zaeq.onrender.com/api/admin/products?limit=3" | jq '.data.products[0] | {id, reviewed, reviewed_at, reviewed_by_email}'
```

Expected:

- Two consecutive toggles on the same product return opposite `reviewed` values.
- `reviewed_at` is an ISO timestamp when `reviewed=true`, and `null` when `reviewed=false`.
- `reviewed_by_email` matches the calling admin's email when on, and is `null` when off.
- The list endpoint returns the three new fields on every product, defaulting to `false` / `null` for rows never touched.
- Hitting the toggle without an admin session returns `401`.
- Hitting the toggle with a bogus uuid returns `404` (not `500`).

---

## 6. After this ships — frontend follow-up (FYI, not backend work)

Once deployed, the frontend will be flipped over in a small follow-up PR:

1. `inkcartridges/js/admin/api.js` — add `AdminAPI.toggleProductReviewed(productId)` (same shape as `toggleImportLock`).
2. `inkcartridges/js/admin/pages/products.js`:
   - Remove the `_reviewedIds` Set + `localStorage` read/write (added around lines 70–80).
   - Change the `reviewed` column renderer to read `r.reviewed` instead of `_reviewedIds.has(String(r.id))`.
   - Change the change-event handler to call `AdminAPI.toggleProductReviewed(id)` and update the row from the response (same pattern as the import-lock handler immediately below it).
   - Add `reviewed, reviewed_at, reviewed_by_email` to the `selectCols` string in the direct Supabase path (~line 265).
3. Optionally migrate any existing `localStorage['admin_reviewed_products']` marks to the DB on first load (one-shot), then delete the key — so nobody loses their in-progress ticks during the transition.

No backend action needed for any of the above — flag this section to whichever Claude picks up the frontend work.

---

## Summary

| Change                                 | Where                      | Status                   |
|----------------------------------------|----------------------------|--------------------------|
| Add `reviewed` / `reviewed_at` / `reviewed_by_email` columns | `products` table | ☐ |
| New `PUT /api/admin/products/:id/reviewed` toggle route | admin products router | ☐ |
| Return new fields from list endpoint | `GET /api/admin/products` | ☐ |
| Return new fields from detail endpoint | `GET /api/admin/products/:id` | ☐ |
| (Optional) `?reviewed=` filter | `GET /api/admin/products` | ☐ |

One small migration, one new route, two response-shape updates. Should be well under an hour end-to-end.
