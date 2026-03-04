# Backend Issues — Frontend-Backend Connection Audit

Identified during a full audit of all frontend API calls against the backend contract (`Frontend (26).md`).
These are issues that require backend changes to resolve.

---

## B1. [HIGH] `is_reviewed` not in product schema or DB

**Frontend behaviour:**
- `AdminAPI.reviewProduct()` sends `PUT /api/admin/products/:id` with `{ is_reviewed: true }`
- `AdminAPI.getUnreviewedProducts()` sends `GET /api/admin/products?is_reviewed=false`

**Contract gap:** `fullProductUpdateSchema` does NOT list `is_reviewed`. `adminProductQuerySchema` does NOT accept `is_reviewed`. The products table schema has no `is_reviewed` column.

**Impact:** The entire product review workflow is broken — marking products as reviewed does nothing, and filtering for unreviewed products returns all products.

**Ask:** Add `is_reviewed` boolean column to `products` table (default `false`), accept it in `fullProductUpdateSchema`, and accept it as a query filter in `adminProductQuerySchema`.

---

## B2. [HIGH] CSV export only supports `orders`/`refunds` — frontend also needs `customers`, `products`, `ribbons`

**Frontend calls:**
- `AdminAPI.exportCSV('orders', ...)` — works
- `AdminAPI.exportCSV('customers', ...)` — returns 400
- `AdminAPI.exportCSV('products', ...)` — returns 400
- `AdminAPI.exportCSV('ribbons', ...)` — returns 400

**Contract:** `adminExportTypeSchema` validates the path param as `orders` or `refunds` only.

**Impact:** Export buttons on Customers, Products, and Ribbons admin pages silently fail.

**Ask:** Add `customers`, `products`, and `ribbons` as valid export types in `adminExportTypeSchema` with corresponding CSV column definitions.

---

## B3. [MEDIUM] Admin products query missing `sort`/`order` support

**Frontend need:** Admin products page needs column sorting (by name, sku, price, stock, created_at).

**Contract:** `adminProductQuerySchema` only accepts `page`, `limit`, `search`, `brand`, `is_active`. No `sort` or `order` params.

**Impact:** Column sorting in admin products list doesn't work. (Frontend has removed the unsupported params for now to avoid silent stripping.)

**Ask:** Add `sort` (enum: `name`, `sku`, `price`, `stock`, `created_at`) and `order` (enum: `asc`, `desc`) to `adminProductQuerySchema`, matching the pattern already used in the customers endpoint.

---

## B4. [MEDIUM] No admin endpoint usage for review moderation (frontend gap)

**Contract:** Backend provides `GET /api/admin/reviews` and `PUT /api/admin/reviews/:reviewId` for moderating user product reviews.

**Frontend status:** No admin page or `AdminAPI` methods exist for review moderation yet.

**Note:** This is a frontend gap — flagged here for backend awareness. The endpoints exist but aren't consumed. We'll add the admin reviews page as a separate task.

---

## B5. [MEDIUM] No admin page for business applications (frontend gap)

**Contract:** Backend provides full CRUD for business applications: `GET /api/admin/business-applications`, `GET /:id`, `PUT /:id`, `GET /stats`.

**Frontend status:** No admin page or `AdminAPI` methods exist for managing business applications.

**Note:** Same as B4 — frontend gap flagged for awareness. Business account applications submitted via the apply page can't be reviewed from the admin UI yet.

---

## B6. [LOW] Extra filter params sent to CSV export are silently stripped

**Frontend sends:** `from`, `to`, `statuses`, `brands`, `suppliers`, `categories` via `FilterState.getParams()`.

**Contract:** `adminExportQuerySchema` only accepts `from`, `to`, `statuses`.

**Impact:** The extra params (`brands`, `suppliers`, `categories`) are stripped by Joi validation — the exported CSV may contain more data than the user filtered for on screen.

**Ask:** If brand/supplier/category filtering is desired in exports, add these to `adminExportQuerySchema`.
