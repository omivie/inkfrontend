# Backend Fix: Guest Cart Sessions Broken (Cross-Origin Cookie Failure)

## The Problem

Guest checkout is broken. When a guest user clicks "Pay" on the payment page, the backend returns "Cart is empty" even though the user has items in their cart.

**Root cause**: The backend uses httpOnly cookies to track guest sessions (`guest_session_id`). The frontend site is on `inkcartridges.co.nz` and the backend API is on `ink-backend-zaeq.onrender.com`. Because these are different domains, the session cookie is a **third-party cookie** — blocked by Chrome incognito, Safari, Firefox strict mode, and increasingly all browsers by default.

**Database proof**: Every single guest cart item in the last month has a unique `guest_session_id` — 19 items, 19 different sessions. The cookie is never reused. Each API request creates a brand new session, so the backend can never find existing cart items.

**What happens**:
1. `POST /api/cart/items` — adds item, sets session cookie in response → browser silently discards cookie (third-party)
2. `GET /api/cart` — no cookie sent, backend creates NEW session → returns empty cart
3. `POST /api/cart/validate` — same, returns "Cart is empty"
4. The frontend masks this with localStorage fallback, so the UI looks correct
5. But payment fails because the backend thinks the cart is empty

## The Fix

Replace the httpOnly cookie mechanism with a **header-based session token** that the frontend stores in localStorage. Cookies remain as a secondary fallback for browsers that do support them.

### 1. Return `guest_session_id` in all cart API response bodies

Every cart-related endpoint response should include the `guest_session_id` in the JSON body so the frontend can capture and store it:

```json
{
  "ok": true,
  "data": {
    "guest_session_id": "e2ac04a2-b2b3-4bca-8dfd-5947b28497f3",
    "items": [...],
    "summary": {...}
  }
}
```

This applies to all cart endpoints:
- `GET /api/cart` — return `guest_session_id` in response body
- `POST /api/cart/items` — return `guest_session_id` in response body
- `PUT /api/cart/items/:id` — return `guest_session_id` in response body
- `DELETE /api/cart/items/:id` — return `guest_session_id` in response body
- `POST /api/cart/validate` — return `guest_session_id` in response body
- `POST /api/cart/merge` — return `guest_session_id` in response body
- `GET /api/cart/count` — return `guest_session_id` in response body
- `DELETE /api/cart` — return `guest_session_id` in response body
- `POST /api/orders` — read `guest_session_id` (see below)

### 2. Accept `X-Guest-Session` header as session identifier

In the middleware that resolves the guest session, add a fallback:

```
Priority order for identifying the guest session:
1. Authenticated user (Bearer token → user_id) — no guest session needed
2. X-Guest-Session header (new — sent by frontend from localStorage)
3. Existing httpOnly cookie (keep as fallback)
4. Create new session (last resort)
```

**Pseudocode for the middleware**:

```javascript
function resolveGuestSession(req, res, next) {
  // Authenticated users don't need guest sessions
  if (req.userId) return next();

  // Try header first (works cross-origin, no cookie needed)
  let sessionId = req.headers['x-guest-session'];

  // Fallback to cookie
  if (!sessionId) {
    sessionId = req.cookies?.guest_session_id;
  }

  // Validate the session ID exists in the database
  if (sessionId) {
    const exists = await db.query(
      'SELECT 1 FROM cart_items WHERE guest_session_id = $1 LIMIT 1',
      [sessionId]
    );
    if (exists.rows.length > 0) {
      req.guestSessionId = sessionId;
      // Still set the cookie as secondary mechanism
      setGuestCookie(res, sessionId);
      return next();
    }
  }

  // No valid session found — create new one
  const newSessionId = uuidv4();
  req.guestSessionId = newSessionId;
  setGuestCookie(res, newSessionId);
  next();
}
```

### 3. Add `X-Guest-Session` to CORS `Access-Control-Allow-Headers`

The CORS configuration must allow the new header:

```javascript
app.use(cors({
  origin: ['https://inkcartridges.co.nz', 'http://localhost:3000'],
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Guest-Session'  // ADD THIS
  ],
  exposedHeaders: [
    'X-Guest-Session'  // ADD THIS — so frontend can read it
  ]
}));
```

### 4. Also expose the session ID via response header

As a belt-and-suspenders approach, set the session ID as a response header too:

```javascript
// In the guest session middleware, after resolving/creating session:
res.setHeader('X-Guest-Session', req.guestSessionId);
```

### 5. Ensure `POST /api/orders` reads the guest session

The order creation endpoint needs to find the guest's cart items. Ensure it uses the same resolution logic (header → cookie → reject):

```javascript
// In the create order handler:
const guestSessionId = req.guestSessionId; // Set by middleware
const cartItems = await db.query(
  'SELECT ci.*, p.* FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.guest_session_id = $1',
  [guestSessionId]
);
if (cartItems.rows.length === 0) {
  return res.status(400).json({ ok: false, error: { code: 'CART_EMPTY', message: 'Cart is empty' } });
}
```

## Database Schema (for reference)

The `cart_items` table:

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default uuid_generate_v4() |
| user_id | uuid | nullable, for authenticated users |
| product_id | uuid | NOT NULL, FK to products |
| quantity | integer | NOT NULL, default 1 |
| guest_session_id | uuid | nullable, for guest users |
| price_snapshot | numeric | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

## Cart API Endpoints (for reference)

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/cart | Get cart items + summary |
| POST | /api/cart/items | Add item (body: `{product_id, quantity}`) |
| PUT | /api/cart/items/:productId | Update quantity (body: `{quantity}`) |
| DELETE | /api/cart/items/:productId | Remove item |
| DELETE | /api/cart | Clear cart |
| GET | /api/cart/count | Get item count |
| POST | /api/cart/validate | Validate cart before payment |
| POST | /api/cart/merge | Merge guest cart into user cart |
| POST | /api/orders | Create order (reads cart server-side) |

## What the Frontend Will Do (after backend is deployed)

Once the backend returns `guest_session_id` in response bodies and accepts `X-Guest-Session` header, I will update the frontend (`api.js`) to:

1. Capture `guest_session_id` from any cart API response and store it in localStorage
2. Send `X-Guest-Session: <stored-id>` header with every API request
3. This is a small change (~10 lines in `api.js`'s `request()` method)

## Testing

After implementing:
1. Open Chrome incognito
2. Add any product to cart
3. Verify `GET /api/cart` returns the same items (not empty)
4. Go through checkout → payment → click Pay
5. Verify no "Cart is empty" error
6. Also verify regular (non-incognito) still works
7. Also verify authenticated user checkout still works (should be unaffected)

## Cleanup (optional, after fix is confirmed working)

Consider cleaning up orphaned guest cart items — there are many single-item sessions that were never completed due to this bug:

```sql
-- Preview orphaned guest sessions (single-use sessions older than 7 days)
SELECT guest_session_id, COUNT(*), MAX(created_at)
FROM cart_items
WHERE guest_session_id IS NOT NULL
  AND created_at < NOW() - INTERVAL '7 days'
GROUP BY guest_session_id;

-- Delete them
DELETE FROM cart_items
WHERE guest_session_id IS NOT NULL
  AND created_at < NOW() - INTERVAL '7 days';
```
