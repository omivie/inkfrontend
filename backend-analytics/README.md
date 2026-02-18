# Cart Analytics Backend

This folder contains the backend code for cart abandonment tracking.

## Setup Instructions

### 1. Run the Database Migration

Copy the contents of `cart_events_migration.sql` and run it in your **Supabase SQL Editor**:

1. Go to your Supabase dashboard
2. Navigate to **SQL Editor**
3. Paste the entire contents of `cart_events_migration.sql`
4. Click **Run**

This creates:
- `cart_events` table - stores all cart analytics events
- `cart_analytics_summary` view - aggregated daily statistics
- `abandoned_carts` view - sessions with abandoned carts
- `get_cart_analytics()` function - returns analytics for a date range

### 2. Add Routes to Your Express Backend

In your main Express server file (e.g., `server.js` or `index.js`), add:

```javascript
// Import the analytics routes
const analyticsRoutes = require('./routes/analytics-routes');

// Add the routes (before your other routes)
app.use('/api/analytics', analyticsRoutes);
```

### 3. Update the Routes File

Copy `analytics-routes.js` to your backend's routes folder and update the supabase client reference:

```javascript
// At the top of analytics-routes.js, make sure req.supabase is available
// This depends on your middleware setup. Common patterns:

// Option A: If you have supabase middleware
router.use((req, res, next) => {
    req.supabase = supabase; // Your supabase client
    next();
});

// Option B: Import directly
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);
// Then replace req.supabase with supabase throughout
```

### 4. Configure CORS (if needed)

Make sure your CORS settings allow the cart-event endpoint to receive POST requests:

```javascript
app.use(cors({
    origin: ['https://inkcartridges.co.nz', 'http://localhost:3000'],
    credentials: true
}));
```

## API Endpoints

### POST /api/analytics/cart-event
Receives cart events from the frontend. No authentication required (for anonymous tracking).

**Request body:**
```json
{
    "session_id": "cs_abc123",
    "user_id": "uuid-or-null",
    "event_type": "add_to_cart",
    "product_id": "product-uuid",
    "product_sku": "ABC123",
    "product_name": "Ink Cartridge",
    "product_price": 29.99,
    "quantity": 1,
    "cart_value": 29.99
}
```

**Event types:**
- `cart_viewed` - User viewed cart page
- `add_to_cart` - Item added to cart
- `remove_from_cart` - Item removed from cart
- `update_quantity` - Cart quantity changed
- `checkout_started` - User started checkout
- `payment_started` - User reached payment page
- `order_completed` - Order successfully placed
- `potential_abandonment` - User left during checkout

### GET /api/analytics/cart-summary
Returns aggregated cart analytics. **Admin only.**

**Query params:**
- `period` - 7d, 30d, 90d, 1y (default: 30d)
- `start_date` - ISO date string
- `end_date` - ISO date string

**Response:**
```json
{
    "success": true,
    "data": {
        "add_to_cart": 150,
        "checkout_started": 80,
        "payment_started": 60,
        "order_completed": 45,
        "potential_abandonment": 35,
        "sessions": 200
    }
}
```

### GET /api/analytics/abandoned-carts
Returns list of abandoned cart sessions. **Admin only.**

**Query params:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20, max: 100)
- `min_value` - Minimum cart value filter

### GET /api/analytics/cart-funnel
Returns conversion funnel data. **Admin only.**

**Query params:**
- `days` - Number of days to analyze (default: 30)

### DELETE /api/analytics/cart-events
Cleans up old analytics data. **Admin only.**

**Query params:**
- `days_to_keep` - Keep events from last N days (default: 90)

## Frontend Integration

The frontend code has already been set up in:
- `/js/cart-analytics.js` - Main tracking module
- `/js/cart.js` - Updated with tracking calls
- `checkout.html` - Tracks checkout started
- `payment.html` - Tracks payment started and order completed
- `cart.html` - Tracks cart page views

## Testing

1. Add items to cart - check console for "Cart Analytics Event: add_to_cart"
2. Go to cart page - check for "cart_viewed" event
3. Start checkout - check for "checkout_started" event
4. Go to payment - check for "payment_started" event
5. Complete order - check for "order_completed" event

Check your Supabase `cart_events` table to verify events are being stored.

## Admin Dashboard

The marketing page (`/admin/marketing.html`) has been updated to:
- Fetch real analytics data from `/api/analytics/cart-summary`
- Display actual cart abandonment rates
- Show conversion funnel with real numbers

## Future Enhancements

Consider adding:
- Email recovery for abandoned carts
- Real-time abandonment alerts
- A/B testing integration
- Customer segmentation by behavior
