# Cart Frontend Integration Guide

This document describes how to integrate the cart system, including guest cart support and cart merge on sign-in.

## Overview

The cart system supports both guest (unauthenticated) and authenticated users:

- **Guest users**: Cart stored in database, linked via `guest_cart_id` httpOnly cookie
- **Authenticated users**: Cart stored in database, linked via user ID
- **On sign-in**: Guest cart automatically merges into user cart

## Cookie Management

The backend sets an httpOnly cookie `guest_cart_id` for guest sessions:

```
Cookie name: guest_cart_id
httpOnly: true
secure: true (production only)
sameSite: lax
maxAge: 72 hours
path: /
```

**Important**: Your frontend must include credentials in all cart requests:

```javascript
// Fetch example
fetch('/api/cart', {
  credentials: 'include'  // Required for cookies
});

// Axios example
axios.get('/api/cart', {
  withCredentials: true  // Required for cookies
});
```

---

## API Endpoints

### GET /api/cart
Get current cart (works for both guest and authenticated users).

**Headers**:
- Optional: `Authorization: Bearer <token>` (for authenticated users)

**Response**:
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "cart-item-uuid",
        "quantity": 2,
        "product": {
          "id": "product-uuid",
          "sku": "INK-001",
          "name": "Black Ink Cartridge",
          "retail_price": 29.99,
          "stock_quantity": 50,
          "color": "Black",
          "image_url": "https://...",
          "brand": { "name": "HP", "slug": "hp" }
        },
        "price_snapshot": 29.99,
        "line_total": 59.98,
        "in_stock": true,
        "created_at": "2024-01-15T10:00:00Z",
        "updated_at": "2024-01-15T10:00:00Z"
      }
    ],
    "coupon": null,
    "summary": {
      "item_count": 2,
      "unique_items": 1,
      "subtotal": 59.98,
      "discount": 0,
      "total": 59.98
    },
    "is_guest": true
  }
}
```

---

### GET /api/cart/count
Quick endpoint for cart badge (minimal data transfer).

**Response**:
```json
{
  "success": true,
  "data": {
    "count": 3,
    "unique_items": 2
  }
}
```

---

### POST /api/cart/items
Add item to cart.

**Request Body**:
```json
{
  "product_id": "product-uuid",
  "quantity": 1
}
```

**Response** (201 Created for new item, 200 for quantity update):
```json
{
  "success": true,
  "message": "Added to cart",
  "data": {
    "id": "cart-item-uuid",
    "product_id": "product-uuid",
    "quantity": 1,
    "price_snapshot": 29.99,
    "product": {
      "sku": "INK-001",
      "name": "Black Ink Cartridge",
      "retail_price": 29.99
    }
  }
}
```

**Error Response** (insufficient stock):
```json
{
  "success": false,
  "error": "Insufficient stock",
  "available": 5
}
```

---

### PUT /api/cart/items/:productId
Update item quantity.

**Request Body**:
```json
{
  "quantity": 3
}
```

**Response**:
```json
{
  "success": true,
  "message": "Cart updated",
  "data": {
    "id": "cart-item-uuid",
    "product_id": "product-uuid",
    "quantity": 3
  }
}
```

---

### DELETE /api/cart/items/:productId
Remove item from cart.

**Response**:
```json
{
  "success": true,
  "message": "Item removed from cart"
}
```

---

### DELETE /api/cart
Clear entire cart.

**Response**:
```json
{
  "success": true,
  "message": "Cart cleared"
}
```

---

### POST /api/cart/merge
**Important**: Call this immediately after user signs in to merge guest cart.

**Headers**:
- Required: `Authorization: Bearer <token>`

**Response**:
```json
{
  "success": true,
  "message": "Cart merged successfully",
  "data": {
    "merged_count": 2,
    "added_count": 1,
    "total_items": 3
  }
}
```

- `merged_count`: Items that existed in both carts (quantities added)
- `added_count`: New items transferred from guest cart
- `total_items`: Total items now in user cart

---

### POST /api/cart/validate
Validate cart before checkout (authenticated only).

**Headers**:
- Required: `Authorization: Bearer <token>`

**Response**:
```json
{
  "success": true,
  "data": {
    "is_valid": true,
    "valid_items": [
      {
        "product_id": "uuid",
        "sku": "INK-001",
        "name": "Black Ink Cartridge",
        "quantity": 2,
        "unit_price": 29.99,
        "price_snapshot": 29.99,
        "price_changed": false,
        "line_total": 59.98
      }
    ],
    "summary": {
      "valid_item_count": 1,
      "issue_count": 0,
      "subtotal": 59.98
    }
  }
}
```

**Response with issues**:
```json
{
  "success": true,
  "data": {
    "is_valid": false,
    "valid_items": [...],
    "issues": [
      {
        "cart_item_id": "uuid",
        "sku": "INK-002",
        "name": "Color Cartridge",
        "issue": "Insufficient stock",
        "requested": 10,
        "available": 3
      }
    ],
    "summary": {
      "valid_item_count": 1,
      "issue_count": 1,
      "subtotal": 59.98
    }
  }
}
```

---

## Coupon Endpoints (Authenticated Only)

### POST /api/cart/coupon
Apply a coupon code.

**Request Body**:
```json
{
  "code": "SAVE10"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Coupon applied!",
  "data": {
    "code": "SAVE10",
    "description": "10% off your order",
    "discount_type": "percentage",
    "discount_value": 10,
    "discount_amount": 5.99,
    "subtotal": 59.98,
    "new_total": 53.99
  }
}
```

### GET /api/cart/coupon
Get currently applied coupon.

### DELETE /api/cart/coupon
Remove applied coupon.

---

## Frontend Implementation Guide

### 1. Cart State Management (React Example)

```typescript
interface CartState {
  items: CartItem[];
  coupon: Coupon | null;
  summary: {
    item_count: number;
    unique_items: number;
    subtotal: number;
    discount: number;
    total: number;
  };
  is_guest: boolean;
  loading: boolean;
}

// Cart context/store
const CartContext = createContext<CartState>(initialState);

function CartProvider({ children }) {
  const [cart, setCart] = useState<CartState>(initialState);
  const { user } = useAuth();

  // Fetch cart on mount and when auth changes
  useEffect(() => {
    fetchCart();
  }, [user]);

  const fetchCart = async () => {
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch('/api/cart', {
      credentials: 'include',  // Important for guest cookies
      headers
    });

    const data = await response.json();
    if (data.success) {
      setCart({ ...data.data, loading: false });
    }
  };

  // ... other methods
}
```

### 2. Sign-In Flow with Cart Merge

```typescript
async function handleSignIn(email: string, password: string) {
  // 1. Authenticate with Supabase
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw error;

  // 2. Immediately merge guest cart
  const mergeResponse = await fetch('/api/cart/merge', {
    method: 'POST',
    credentials: 'include',  // Include guest cookie
    headers: {
      'Authorization': `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json'
    }
  });

  const mergeResult = await mergeResponse.json();

  if (mergeResult.success && mergeResult.data.merged_count > 0) {
    // Optionally show toast: "Your cart items have been saved to your account"
    toast.success(`${mergeResult.data.total_items} items in your cart`);
  }

  // 3. Refresh cart to get merged state
  await refreshCart();
}
```

### 3. Cart Header Badge Component

```tsx
function CartBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const fetchCount = async () => {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/cart/count', {
        credentials: 'include',
        headers
      });

      const data = await response.json();
      if (data.success) {
        setCount(data.data.count);
      }
    };

    fetchCount();

    // Re-fetch on cart updates (use your event system)
    window.addEventListener('cart-updated', fetchCount);
    return () => window.removeEventListener('cart-updated', fetchCount);
  }, []);

  if (count === 0) return <CartIcon />;

  return (
    <div className="relative">
      <CartIcon />
      <span className="absolute -top-2 -right-2 bg-red-500 text-white
                       rounded-full w-5 h-5 text-xs flex items-center justify-center">
        {count > 99 ? '99+' : count}
      </span>
    </div>
  );
}
```

### 4. Add to Cart Button

```tsx
function AddToCartButton({ productId, stock }: { productId: string; stock: number }) {
  const [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState(1);

  const handleAddToCart = async () => {
    setLoading(true);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      const token = getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/cart/items', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ product_id: productId, quantity })
      });

      const data = await response.json();

      if (data.success) {
        toast.success(data.message);
        window.dispatchEvent(new Event('cart-updated'));
      } else {
        if (data.available !== undefined) {
          toast.error(`Only ${data.available} available in stock`);
        } else {
          toast.error(data.error);
        }
      }
    } catch (error) {
      toast.error('Failed to add to cart');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleAddToCart}
      disabled={loading || stock === 0}
      className="btn btn-primary"
    >
      {loading ? 'Adding...' : stock === 0 ? 'Out of Stock' : 'Add to Cart'}
    </button>
  );
}
```

### 5. Checkout Flow

```typescript
async function proceedToCheckout() {
  const token = getAuthToken();

  // Guest users must sign in first
  if (!token) {
    // Store intent in sessionStorage
    sessionStorage.setItem('checkout_intent', 'true');

    // Redirect to login with return URL
    router.push('/login?redirect=/checkout');
    return;
  }

  // Validate cart before proceeding
  const response = await fetch('/api/cart/validate', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();

  if (!data.success) {
    toast.error('Please sign in to checkout');
    return;
  }

  if (!data.data.is_valid) {
    // Show issues to user
    const issues = data.data.issues;
    issues.forEach(issue => {
      toast.error(`${issue.name}: ${issue.issue}`);
    });
    return;
  }

  // Check for price changes
  const priceChanges = data.data.valid_items.filter(item => item.price_changed);
  if (priceChanges.length > 0) {
    const confirmed = await confirmPriceChanges(priceChanges);
    if (!confirmed) return;
  }

  // Proceed to checkout
  router.push('/checkout');
}
```

---

## Price Snapshots

When items are added to cart, the current price is captured as `price_snapshot`. This allows:

1. **Price change detection**: Compare `price_snapshot` to current `retail_price`
2. **Customer trust**: Show original price they added at
3. **Analytics**: Track price sensitivity

```tsx
function CartItem({ item }) {
  const priceChanged = item.price_snapshot !== item.product.retail_price;

  return (
    <div className="cart-item">
      <span className="name">{item.product.name}</span>

      {priceChanged && (
        <div className="price-change-notice">
          <span className="old-price line-through">
            ${item.price_snapshot.toFixed(2)}
          </span>
          <span className="new-price text-green-600">
            ${item.product.retail_price.toFixed(2)}
          </span>
          <span className="badge">Price dropped!</span>
        </div>
      )}

      <span className="line-total">
        ${item.line_total.toFixed(2)}
      </span>
    </div>
  );
}
```

---

## Error Handling

```typescript
// Common error codes and handling
function handleCartError(response: any) {
  if (!response.success) {
    switch (response.error) {
      case 'Product not found':
        return 'This product is no longer available';

      case 'Product is not available':
        return 'This product has been discontinued';

      case 'Insufficient stock':
        return `Only ${response.available} items available`;

      case 'Authentication required for checkout':
        return 'Please sign in to complete your purchase';

      case 'Invalid coupon code':
        return 'This coupon code is not valid';

      default:
        return response.error || 'An error occurred';
    }
  }
}
```

---

## Best Practices

1. **Always include credentials**: Set `credentials: 'include'` on all cart requests
2. **Call merge immediately**: Call `/api/cart/merge` right after successful sign-in
3. **Use cart/count for badges**: More efficient than fetching full cart
4. **Validate before checkout**: Always call `/api/cart/validate` before payment
5. **Handle stock issues gracefully**: Show available quantity and suggest adjustment
6. **Show price changes**: Alert users to price changes since they added items

---

## CORS Configuration

Ensure your frontend origin is listed in `ALLOWED_ORIGINS`:

```env
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

The backend has `credentials: true` enabled for CORS, which is required for cookie handling.
