# Backend Task: Super Admin Test Product & Free Shipping

## Context

The frontend now supports two admin-testing features that need backend validation:

1. **Test products** — SKUs prefixed with `TEST-` (or flagged `admin_only: true`) are hidden from non-admins on the frontend. The backend must also enforce this.
2. **Admin-free shipping** — Super admins can select `delivery_type: "admin-free"` at checkout, which the frontend sends as `$0 shipping`. The backend must verify the user is a super admin before accepting it.

**The frontend never computes prices.** All totals come from the backend. The frontend changes are purely UI gating — the backend is the source of truth.

---

## Required Changes

### 1. Create a test product

Create a product (or provide an admin UI / seed script) with:

- **SKU**: must start with `TEST-` (e.g. `TEST-INK-001`)
- **Price**: `$0.00` (or `$0.01` if Stripe requires non-zero)
- **Name**: something like "Admin Test Cartridge"
- **Stock**: set to a high number or unlimited
- **Optional**: set an `admin_only: true` flag on the product record

If this needs to be done manually (e.g. direct DB insert or admin dashboard), **tell the backend dev**:

> Create a product with SKU `TEST-INK-001`, price $0.00, name "Admin Test Cartridge", and high stock. The frontend uses the `TEST-` SKU prefix to gate visibility to super admins only.

---

### 2. Gate test product access in the API

In the **`GET /api/products/:sku`** endpoint (or equivalent):

- If the product SKU starts with `TEST-` or has `admin_only = true`:
  - Check if the requesting user is authenticated and has a super admin role (`superadmin` or `owner`)
  - If not, return `404 Not Found` (not `403` — don't leak that the product exists)
- If the user is a super admin, return the product normally

Pseudocode:
```
if product.sku starts with "TEST-" or product.admin_only == true:
    user = get_authenticated_user(request)
    if not user or user.role not in ["superadmin", "owner"]:
        return 404 "Product not found"
```

Also apply this filter to **`GET /api/products`** (listing endpoints) — exclude `TEST-` / `admin_only` products from results unless the requester is a super admin.

---

### 3. Accept `delivery_type: "admin-free"` in order creation

In the **`POST /api/orders`** endpoint:

When `delivery_type` is `"admin-free"`:

1. **Verify the user is a super admin** (role is `superadmin` or `owner`)
2. If verified: set shipping fee to `$0.00` and proceed
3. If not verified: reject with `403 Forbidden` or fall back to standard shipping calculation

Pseudocode:
```
if order.delivery_type == "admin-free":
    user = get_authenticated_user(request)
    if not user or user.role not in ["superadmin", "owner"]:
        return 403 "Admin-free shipping requires super admin access"
    shipping_fee = 0
    shipping_tier = "admin-free"
    shipping_reason = "Admin test — free shipping"
else:
    # existing shipping calculation
```

**Do not** trust the frontend-supplied shipping amount. Always compute/validate server-side.

---

### 4. Include `role` in the admin verification response

The frontend caches the admin role from `GET /api/admin/verify` (or whatever `API.verifyAdmin()` calls). The response must include the `role` field:

```json
{
  "is_admin": true,
  "role": "superadmin"
}
```

If this is already returned, no change needed. If not, add `role` to the response payload. The frontend reads `response.data.role` and checks for `"superadmin"` or `"owner"`.

---

## Summary of endpoints to modify

| Endpoint | Change |
|---|---|
| `GET /api/products/:sku` | Return 404 for `TEST-`/`admin_only` products if requester is not super admin |
| `GET /api/products` | Exclude `TEST-`/`admin_only` products from listings for non-super-admins |
| `POST /api/orders` | Accept `delivery_type: "admin-free"`, verify super admin role, set shipping to $0 |
| `GET /api/admin/verify` | Ensure `role` field is included in response (if not already) |

## Testing

1. **As super admin**: `GET /api/products/TEST-INK-001` returns the product
2. **As regular user**: `GET /api/products/TEST-INK-001` returns 404
3. **As super admin**: `POST /api/orders` with `delivery_type: "admin-free"` succeeds with $0 shipping
4. **As regular user**: `POST /api/orders` with `delivery_type: "admin-free"` returns 403
5. **Product listing**: `TEST-` products don't appear in search/browse for non-admins
