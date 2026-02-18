# InkCartridges.co.nz - E-commerce Website

New Zealand's trusted source for printing supplies.

---

## Project Overview

This is the frontend codebase for inkcartridges.co.nz, an e-commerce website selling:
- Ink cartridges (genuine & compatible)
- Toner cartridges
- Printers
- Drums
- Ink bottles
- Fax & printer accessories

The site is designed for home users, SMEs, and enterprise clients (B2B).

---

## Project Structure

```
/inkcartridges
│
├── /html                    # HTML pages
│   ├── index.html           # Homepage
│   ├── shop.html            # All products / shop page
│   ├── cart.html            # Shopping cart
│   ├── checkout.html        # Checkout process
│   ├── search.html          # Search results
│   ├── about.html           # About us
│   ├── contact.html         # Contact page
│   ├── faq.html             # FAQs
│   ├── returns.html         # Returns & refunds policy
│   ├── privacy.html         # Privacy policy
│   ├── terms.html           # Terms & conditions
│   ├── business.html        # Business accounts
│   ├── order-confirmation.html  # Order success page
│   ├── 404.html             # Error page
│   │
│   ├── /category            # Category pages
│   │   └── ink-cartridges.html  # Template for all categories
│   │
│   ├── /product             # Product pages
│   │   └── sample-product.html  # Template for product pages
│   │
│   ├── /account             # Account pages
│   │   ├── login.html       # Login / Register
│   │   └── index.html       # Account dashboard
│   │
│   ├── /business            # Business pages
│   │   └── apply.html       # (To be created) Application form
│   │
│   └── /admin               # Admin pages
│       └── index.html       # Admin dashboard placeholder
│
├── /css                     # Stylesheets
│   ├── base.css             # Reset, variables, typography, utilities
│   ├── layout.css           # Grid, header, footer, page layouts
│   ├── components.css       # Buttons, forms, cards, tables, etc.
│   └── pages.css            # Page-specific styles
│
├── /js                      # JavaScript
│   ├── utils.js             # Utility functions
│   ├── main.js              # Global functionality
│   ├── cart.js              # Cart functionality
│   ├── filters.js           # Product filtering
│   └── search.js            # Search functionality
│
├── /assets                  # Static assets
│   ├── /images              # Product images, banners, etc.
│   └── /icons               # Icons, favicon
│
└── README.md                # This file
```

---

## File Descriptions

### CSS Files

| File | Purpose |
|------|---------|
| `base.css` | CSS variables (colours, typography, spacing), reset/normalize, base typography, utility classes |
| `layout.css` | Container system, header structure, footer structure, navigation, responsive grid layouts |
| `components.css` | Reusable UI components: buttons, forms, cards, badges, tables, tabs, pagination |
| `pages.css` | Page-specific styles for homepage, category, product, cart, checkout, account, etc. |

### JS Files

| File | Purpose |
|------|---------|
| `utils.js` | Helper functions: DOM utilities, formatters, validators, storage, debounce/throttle |
| `main.js` | Global initialization: navigation, dropdowns, year update, toast notifications |
| `cart.js` | Shopping cart: add/remove items, quantities, totals, localStorage persistence |
| `filters.js` | Product filtering: filter state, URL sync, filter UI updates |
| `search.js` | Search: autocomplete, suggestions, keyboard navigation |

---

## Build Status

### PART 1: Website Shell & Page Structure ✅
- [x] Page list and URL structure defined
- [x] Navigation hierarchy established
- [x] All HTML page shells created
- [x] Folder structure organized
- [x] Placeholder CSS structure created
- [x] Placeholder JS structure created

### PART 2: Branding, Colour Scheme & UI Style
- [ ] Primary/secondary/accent colours
- [ ] Font pairings
- [ ] Button styles
- [ ] Spacing philosophy
- [ ] CSS variables finalized

### PART 3: Customer-Facing Pages
- [ ] Homepage (hero, trust signals, categories)
- [ ] Category pages (filters, grid)
- [ ] Product pages (gallery, compatibility, tabs)
- [ ] Cart page
- [ ] Checkout page
- [ ] Account pages
- [ ] Search results
- [ ] Informational pages

### FINAL PART: Admin Dashboard
- [ ] Dashboard UI design
- [ ] Key metrics display
- [ ] Tables and charts
- [ ] API integration placeholders

---

## Development Notes

### Code Conventions
- **HTML**: Semantic, accessible (ARIA labels, skip links)
- **CSS**: BEM-style class naming, CSS custom properties
- **JS**: Vanilla JavaScript, no framework dependencies

### Content Placeholders
Content wrapped in `[square brackets]` indicates placeholder text that needs to be replaced with actual content.

### Backend Integration
This is a frontend-only codebase. Backend API integration will be handled separately. Current code includes placeholder functions ready for API connection.

### Browser Support
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers

---

## Next Steps

1. **Await approval** for Part 1 (page structure)
2. Proceed to **Part 2** (branding & UI style)
3. Build pages **one at a time** in Part 3
4. Complete **admin dashboard** last

---

## Contact

For questions about this codebase:
- Development queries: [developer contact]
- Business queries: [business contact]

---

*Last updated: Part 1 completion*
