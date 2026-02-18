# Backend TODO — Account Dashboard Redesign

Data requirements for the new account dashboard. These fields are consumed by `account.js` methods `loadQuickReorder()`, `loadOrderStatus()`, and `loadDashboardPrinters()`.

---

## 1. Orders endpoint (`GET /api/orders`)

The dashboard fetches the 5 most recent orders to populate both the **Quick Reorder** and **Order Status** cards.

### Currently returned (working)
- `order_number`, `status`, `total`, `created_at`

### Needed additions
| Field | Type | Used by | Notes |
|---|---|---|---|
| `items[]` | array | Quick Reorder card | Array of line items in each order. Without this, the reorder card falls back to showing the order number instead of a product name. |
| `items[].product_name` | string | Quick Reorder card | Display name of the product |
| `items[].product_slug` | string | Quick Reorder card | Used to build the "Buy Again" link to the product page |
| `items[].image_url` | string | Quick Reorder card | Product thumbnail (48x48). Falls back to SVG icon if missing. |
| `estimated_delivery` | ISO date string | Order Status card | Shown as "Estimated delivery: 21 Feb". Falls back to order date if missing. |
| `tracking_url` | string | Order Status card | External tracking link (e.g. NZ Post). Falls back to order detail page if missing. |

### Graceful degradation
The frontend handles all missing fields gracefully:
- No `items[]` → shows "Order #123" and "Shop Again" instead of product details
- No `estimated_delivery` → shows "Ordered: 15 Feb 2026" or "Your order is on its way!" (if shipped)
- No `tracking_url` → links to internal order detail page

---

## 2. User Printers endpoint (`GET /api/user/printers`)

The dashboard shows up to 3 saved printers with "Order Ink" buttons.

### Currently returned (working)
- `id`, `brand`, `model`, `nickname`

### No additional fields needed
The current response is sufficient for the dashboard. Each printer card shows brand, model, and links to the shop page filtered by brand+model.

---

## Priority

1. **`items[]` in orders response** — highest impact; enables the 1-click reorder feature
2. **`tracking_url`** — medium; enables direct tracking from dashboard
3. **`estimated_delivery`** — low; cosmetic improvement, good fallback exists
