# Measurement Plan
**InkCartridges.co.nz | February 2026**

---

## Analytics Architecture

```
User Action
    ↓
[data-track] attribute  OR  Analytics.track() call
    ↓
analytics.js → Analytics.track(event, props)
    ↓
    ├── window.dataLayer.push()   → GTM → GA4 / other tools
    ├── CartAnalytics.track()     → Backend API (cart/checkout events)
    └── Analytics._log[]          → Console debug (Analytics._log)
```

**Implementation**: `/js/analytics.js` loaded on all 29 customer-facing pages.

---

## Event Taxonomy

All events use **snake_case** naming. Properties are camelCase in HTML (`data-track-ctaName`) but converted to snake_case in the payload (`cta_name`).

### Automatically Tracked Events

| Event | Trigger | Properties | Source |
|---|---|---|---|
| `page_view` | Every page load | `page_path`, `page_title`, `referrer` | `Analytics.init()` |
| `search` | Search form submit | `query` | `bindSearchTracking()` |
| `contact_click` | Phone/email link click | `type` (phone\|email), `value` | `bindContactTracking()` |
| `email_capture` | Newsletter form submit | `location` | `bindEmailCapture()` |

### Declarative Click Events (via `data-track` attributes)

| Event | Element | Properties | Page |
|---|---|---|---|
| `cta_click` | Hero "Find My Cartridge" | `cta`, `location=hero` | Homepage |
| `cta_click` | Hero "Shop Best Sellers" | `cta`, `location=hero` | Homepage |
| `add_to_cart` | Product ATC button | `location=product_page` | Product |
| `cta_click` | "Proceed to Checkout" | `cta`, `location=cart_summary` | Cart |
| `cta_click` | "Track Order" | `cta`, `location=post_purchase` | Order Confirmation |
| `cta_click` | "Create Account" | `cta`, `location=post_purchase` | Order Confirmation |
| `cta_click` | "Save My Printer" | `cta`, `location=post_purchase` | Order Confirmation |

### Backend-Tracked Events (via CartAnalytics)

| Event | Trigger | Properties |
|---|---|---|
| `cart_add` | Item added to cart | `product_id`, `quantity`, `price` |
| `cart_remove` | Item removed from cart | `product_id` |
| `cart_update` | Quantity changed | `product_id`, `quantity` |
| `checkout_start` | Checkout page load | `cart_total`, `item_count` |
| `payment_start` | Payment page load | `order_total` |

---

## Key Funnels

### Primary Purchase Funnel

```
page_view (Homepage)
    → cta_click (hero CTA) OR search
    → page_view (Shop / Product)
    → add_to_cart
    → page_view (Cart)
    → cta_click (Proceed to Checkout)
    → page_view (Checkout)
    → page_view (Payment)
    → page_view (Order Confirmation)  ← CONVERSION
```

### Support Engagement Funnel

```
page_view (any page)
    → contact_click (phone or email)
    OR
    → page_view (FAQ)
    → page_view (Contact)
```

### Post-Purchase Retention Funnel

```
page_view (Order Confirmation)
    → cta_click (Create Account)        ← guest→account conversion
    → cta_click (Save My Printer)       ← reorder intent
```

---

## Key KPIs

| KPI | Definition | Target |
|---|---|---|
| **Conversion Rate** | Order confirmations / Homepage page views | > 2% |
| **Add-to-Cart Rate** | `add_to_cart` events / Product page views | > 8% |
| **Cart-to-Checkout Rate** | Checkout page views / Cart page views | > 60% |
| **Checkout Completion** | Order confirmations / Checkout page views | > 40% |
| **Search-to-Purchase** | Orders with prior `search` event / Total orders | Track baseline |
| **Contact Rate** | `contact_click` events / Total sessions | Track baseline |
| **Guest→Account** | Post-purchase account creates / Guest orders | > 15% |
| **Ink Finder Usage** | Ink finder form submissions / Homepage views | > 20% |

---

## A/B Test Targets

Stable `data-testid` attributes are placed on key conversion elements for experimentation tools (Optimizely, VWO, Google Optimize, etc.):

| Selector | Element | Test Ideas |
|---|---|---|
| `[data-testid="hero-cta"]` | Hero CTA container | Button text, color, layout |
| `[data-testid="hero-cta-primary"]` | Primary hero button | "Find My Cartridge" vs "Search by Printer" |
| `[data-testid="hero-cta-secondary"]` | Secondary hero button | "Shop Best Sellers" vs "Browse All" |
| `[data-testid="trust-bar"]` | Trust bar section | Icon order, text variants, show/hide |
| `[data-testid="product-add-to-cart"]` | Product ATC button | Button text, urgency copy, size |
| `[data-testid="cart-checkout-btn"]` | Cart checkout button | "Proceed to Checkout" vs "Complete Order" |

---

## GTM Setup Guide

When GTM is configured, add container snippet and these triggers:

1. **GA4 Configuration tag** — fires on all pages
2. **Custom Event triggers** — one per event in the taxonomy above
3. **GA4 Event tags** — map each trigger to a GA4 event with matching parameters
4. **Conversion tags** — mark `page_view` on Order Confirmation as conversion

The `dataLayer.push()` calls from `analytics.js` will automatically feed GTM.

---

## Debugging

Open browser console on any page:

```js
// View all tracked events this session
Analytics._log

// Manually fire a test event
Analytics.track('test_event', { foo: 'bar' })

// Check dataLayer (if GTM installed)
window.dataLayer
```
