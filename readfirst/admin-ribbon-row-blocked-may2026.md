# Admin product PUT 500s on legacy `source='ribbon'` rows — backend handoff

**Status:** discovered 2026-05-11. Frontend mitigations shipped same day. Backend
fix outstanding.

## Symptom

Admin opens any of the 34 legacy ribbon products (printer_ribbon /
typewriter_ribbon with `source = 'ribbon'`), edits the price (or any field),
clicks **Save Changes**. Toast: `Save failed: Failed to update product`.

User-reported example: `/admin#products` → "Amano Compatible 78000.02 FN
Black/Red Printer Ribbon" (id `93560715-6603-46b6-b5c0-72f5711f1b8e`,
sku `78000.02`). Retail price field changed from $31.99 to $31.98 → save
fails. Refresh shows the row unchanged.

## Reproduction (live backend, admin token)

```bash
TOKEN='<paste sb-…-auth-token.access_token from localStorage>'

# Happy path — non-ribbon row updates fine, returns 200
curl -X PUT "https://ink-backend-zaeq.onrender.com/api/admin/products/eaa9ebef-7486-425a-a83f-311e9bbd9893" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"retail_price":7.99,"cost_price":3.0}'
# → 200 {"ok":true,"data":{...,"retail_price":7.99,...}}

# Failure path — any ribbon row, any payload, returns 500
curl -X PUT "https://ink-backend-zaeq.onrender.com/api/admin/products/93560715-6603-46b6-b5c0-72f5711f1b8e" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"retail_price":31.98,"cost_price":19.8}'
# → 500 {"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to update product"}}
```

The 500 is **payload-independent**. Tried (all 500):

| Payload | Result |
|---|---|
| `{retail_price:31.98, cost_price:19.8}` | 500 INTERNAL_ERROR |
| `{retail_price:31.98}` | 500 INTERNAL_ERROR |
| `{is_active:true}` | 500 INTERNAL_ERROR |
| `{name:"unchanged"}` | 500 INTERNAL_ERROR |
| `{stock_quantity:100}` | 500 INTERNAL_ERROR |
| `{source:"compatible", retail_price:31.98}` | 500 INTERNAL_ERROR |
| `{}` | 400 VALIDATION_FAILED ("must have at least 1 key") — Joi runs first |

Other admin endpoints touching the same row also fail:

| Endpoint | Result |
|---|---|
| `PUT /api/admin/products/:id` | 500 INTERNAL_ERROR |
| `PUT /api/admin/products/:id/overrides` | 500 INTERNAL_ERROR ("Failed to update overrides") |
| `PUT /api/admin/products/:id/reviewed` | 500 INTERNAL_ERROR ("Failed to toggle reviewed flag") |
| `PUT /api/admin/products/:id/import-lock` | 400 BAD_REQUEST ("Ribbons cannot be import-locked. They are protected from feed imports by product_type guards in genuine.js, compatible.js, feedHelpers.js, cron/job…") |
| `PUT /api/admin/products/by-sku/:sku` | 500 INTERNAL_ERROR |
| `PUT /api/admin/ribbons/:id` (the dedicated ribbon route) | 500 INTERNAL_ERROR ("Failed to update ribbon") |

So the row is essentially write-locked from every admin path.

## Affected rows

Census across the live admin catalogue (4003 rows total, 2026-05-11):

| `source` value | row count | PUT works? |
|---|---:|---|
| `genuine` | 3104 | ✅ |
| `compatible` | 865 | ✅ |
| `ribbon` | **34** | ❌ — every PUT returns 500 |

Joi enum on `PUT /api/admin/products/:id` is `[genuine, compatible]` (returns
VALIDATION_FAILED for `source='ribbon'` in the payload). But the SQL UPDATE
path itself also fails for these rows even when the payload omits `source`,
which means there is something in the controller's own SELECT/JOIN/UPDATE
chain that breaks before/after Joi.

## Likely backend root cause

Hypotheses (in order of likelihood):

1. **Trigger / RLS function references a column that doesn't exist on the
   ribbon view, or a CHECK constraint rejects `source='ribbon'`.** A pre/post
   UPDATE trigger that recomputes `manual_overrides`, `profit_ex_gst`, or
   refreshes a materialised view probably breaks because ribbons live in a
   different table (`ribbons` per the `/api/admin/ribbons` endpoint) and the
   join produces NULLs the trigger can't handle.
2. **The PUT controller does `.select().single()` after UPDATE and the
   resulting row fails enum validation on the way back out** (re-serialised
   through the same Joi schema that rejected `source='ribbon'` on input).
3. **The `manual_overrides` JSONB merge** the controller does for the
   "did the admin override this field?" badge logic chokes on a
   field-name set that diverges from what the products table has for a
   ribbon row.

To confirm: enable verbose logging on the PUT handler, hit the failing row,
read the stderr stack trace from Render. Render `x-request-id` is included
in the toast that admins now see (frontend mitigation §B below) so support
can grep stderr without timestamps.

## Required backend fix

### Bonus: CORS expose `x-request-id`

The Render proxy sets `x-request-id` on every response, but the
`Access-Control-Expose-Headers` middleware currently only allows
`X-Guest-Session`. As a result the frontend cannot read the request id from
cross-origin responses (`response.headers.get('x-request-id')` returns
`null`), so neither the legacy-row toast nor the generic 500 toast can
include the ref the spec promised. Trivial fix:

```js
// in the backend's CORS middleware
res.header('Access-Control-Expose-Headers', 'X-Guest-Session, X-Request-Id');
```

Once that ships, every admin error toast in the app will surface the
8-char ref automatically — no frontend redeploy needed (the threading
already exists in `api.js::request()` and in
`AdminAPI.updateProduct`/`mapError`, gated by `if (resp.request_id)`).

### Main: ribbon-row write path

Either:

**Option A — preferred:** repair the ribbons UPDATE path so legacy rows can
be edited from the admin Products tab. The Products tab is the canonical
admin surface (per memory: *Admin Ribbons tab removed — May 2026*). This
likely requires:
- Loosening the Joi enum on PUT `/api/admin/products/:id` to allow
  `source ∈ {genuine, compatible, ribbon}` (or migrating the 34 ribbon rows
  to `source='compatible'` since they're all third-party-manufactured
  compatibles by name — "Amano Compatible …", etc.).
- Fixing whatever trigger/constraint/view chokes after the UPDATE.

**Option B — fallback:** ship a one-shot SQL migration that flips the 34
rows from `source='ribbon'` to `source='compatible'`. Audit names — every
row tested has "Compatible" in the product name. The downstream impact on
storefront facets is minimal: `/shop?source=ribbon` is not a route, ribbons
are surfaced via `product_type=printer_ribbon` (the `category=CON-RIBBON`
filter still works because that's a separate column).

```sql
-- Inspect first
SELECT id, sku, name, source, product_type, category
FROM products
WHERE source = 'ribbon';

-- Migrate (review names in the SELECT before running)
UPDATE products
SET source = 'compatible', updated_at = NOW()
WHERE source = 'ribbon'
  AND name ILIKE '%compatible%';
```

Option B unblocks admin saves immediately without a code deploy.

## Frontend mitigations (shipped 2026-05-11)

These don't fix the underlying bug — the row is still un-saveable until the
backend is repaired or the rows are migrated — but they prevent silent data
corruption and give admins a clear signal:

**A. `buildSelect` preserves legacy values** — the
`<select id="edit-source">` only had options `[genuine, compatible,
remanufactured]`. Opening a ribbon product caused the browser to silently
auto-select the first option (`genuine`) because none matched
`source='ribbon'`. Saving would have written `source='genuine'` over the
row — corrupting data the moment the backend bug is fixed. `buildSelect`
in `inkcartridges/js/admin/pages/products.js` now appends unknown values
as a `(legacy)` option pre-selected, mirroring `buildColorSelect`.

**B. Save toast surfaces `request_id`** —
`AdminAPI.updateProduct` in `inkcartridges/js/admin/api.js` now appends the
8-char Render `x-request-id` to the thrown error message so admin reports
of "save failed at 9:01am" can be grepped against Render stderr.

**C. Pre-flight banner inside the modal** — when the product's `source` is
not in `{genuine, compatible}` the edit modal now shows an orange banner
above the tab panels: *"Legacy source = 'ribbon' — backend currently rejects
writes for this row. Saves will fail until either the backend ribbon route
is repaired or this row is migrated to compatible."* with a link to this
file. Admins stop wasting clicks.

**D. Specific toast for the 500-on-legacy-row case** — the catch in the
Save handler now detects `e.code === 'INTERNAL_ERROR'` (or status 500) on a
legacy-source row and shows the banner-style message instead of the
unhelpful `Save failed: Failed to update product`.

## Verification once backend is fixed

1. Run the live PUT in this doc and expect 200.
2. From admin UI: open SKU `78000.02`, change Retail Price → Save. Expect
   green "Product updated" toast. Reload row. Expect $31.98.
3. Repeat for one row from each affected `source` bucket if the migration
   was Option B (all 34 should now be `compatible`).
4. Delete the orange banner code (search products.js for
   `admin-product-modal__legacy-banner`) and the special-case toast
   (search for `admin-ribbon-row-blocked-may2026.md`). Keep the
   `buildSelect` (legacy) preservation — it's a permanent safety net for
   any future legacy enum drift.
5. Confirm `tests/admin-product-save-may2026.test.js` still passes (the
   buildSelect contract test is permanent; the banner-content test should
   be deleted alongside the banner code).

## Pinned by

`tests/admin-product-save-may2026.test.js`
