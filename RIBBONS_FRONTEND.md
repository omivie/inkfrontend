# Ribbons — Frontend Reference

## Overview

The backend serves typewriter & printer ribbons via `/api/ribbons` endpoints. There are **122 active ribbon products** with **3760 compatibility links** to **2654 device models** across **36+ device brands**.

Ribbons have two types of brand filtering:

- **Product brand** — the manufacturer of the ribbon itself (e.g., Brother, Canon, Nakajima)
- **Device brand** — the typewriter/printer brand the ribbon is compatible with (e.g., Olivetti, Olympia, Smith Corona)

The nav bar should show **device brands** (what typewriter/printer do you have?) so customers can find compatible ribbons.

### Product Types

| Type | Count | Description |
|------|-------|-------------|
| `printer_ribbon` | 89 | Ribbons for dot-matrix printers, POS systems, receipt printers |
| `typewriter_ribbon` | 24 | Ribbons for typewriters |
| `correction_tape` | 6 | Correction/lift-off tape for typewriters |
| `universal_ribbon` | 3 | Group 24 ribbons that fit both printers and typewriters |

All four types are returned by all endpoints — no client-side filtering needed. If you build separate "Printer Ribbons" vs "Typewriter Ribbons" sections, `universal_ribbon` products should appear in **both**.

### Key Distinction: Two Kinds of "Brand"

- **Ribbon brand** (`brand` param) — the manufacturer of the ribbon consumable (e.g., Brother, Epson, OKI). Data from `/api/ribbons/brands`.
- **Device brand** (`printer_brand` param) — the brand of the printer/typewriter the ribbon fits (e.g., Olivetti, IBM, Casio). Data from `/api/ribbons/device-brands`. Includes both modern printer brands and legacy typewriter brands in one flat list.

**Never hardcode brand or model lists.** Always fetch from the API — they are the source of truth and update automatically.

---

## API Reference

Base URL: `/api` | All public endpoints (no auth) | Rate limit: 60 req/min | Response envelope: `{ ok, data, meta? }` on success, `{ ok: false, error: { code, message } }` on failure.

---

### GET /api/ribbons — List ribbons with filters

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | integer (min 1) | `1` | Page number |
| `limit` | integer (1-200) | `20` | Items per page |
| `search` | string (max 200) | — | Search by SKU or name (case-insensitive partial match) |
| `brand` | string (max 100) | — | Filter by ribbon product brand (case-insensitive exact match) |
| `color` | string (max 50) | — | Filter by color (case-insensitive partial match) |
| `printer_brand` | string (max 100) | — | Filter by compatible device brand (e.g., `Olivetti`, `Epson`) |
| `printer_model` | string (max 200) | — | Filter by compatible device model (case-insensitive partial match) |
| `device_brand` | string | — | Alias for `printer_brand` |
| `device_model` | string | — | Alias for `printer_model` |
| `sort` | `price_asc` \| `price_desc` \| `name` | `name` | Sort order |

**Response:**
```json
{
  "ok": true,
  "data": {
    "ribbons": [
      {
        "id": "uuid",
        "sku": "153.11",
        "name": "Brother AX 10 Typewriter Ribbon Black",
        "brand": "Brother",
        "color": "Black",
        "sale_price": 21.95,
        "stock_quantity": 100,
        "is_active": true,
        "image_path": "/images/ribbons/153.11.webp",
        "created_at": "2026-03-15T...",
        "updated_at": "2026-03-25T..."
      }
    ]
  },
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 122,
    "total_pages": 7,
    "has_next": true,
    "has_prev": false
  }
}
```

**Examples:**
```
GET /api/ribbons?printer_brand=Olivetti&sort=price_asc&limit=10
GET /api/ribbons?device_brand=epson&page=2
GET /api/ribbons?search=black&brand=Epson
```

---

### GET /api/ribbons/:sku — Single ribbon with compatibility

| Param | Type | Description |
|---|---|---|
| `sku` | string (max 50, required) | Product SKU (case-insensitive) |

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "sku": "153.11",
    "name": "Brother AX 10 Typewriter Ribbon Black",
    "brand": "Brother",
    "color": "Black",
    "sale_price": 21.95,
    "stock_quantity": 100,
    "is_active": true,
    "image_path": "/images/ribbons/153.11.webp",
    "in_stock": true,
    "compatible_devices": [
      { "brand": "Brother", "model": "AX 10", "match_type": "exact", "confidence": 70 },
      { "brand": "Brother", "model": "All Models", "match_type": "brand", "confidence": 90 },
      { "brand": "Olivetti", "model": "All Models", "match_type": "brand", "confidence": 90 },
      { "brand": "Olympia", "model": "All Models", "match_type": "brand", "confidence": 90 }
    ]
  }
}
```

Returns 404 if SKU not found.

---

### GET /api/ribbons/device-brands — Device brands for nav/filter

No parameters. Returns all device brands that have compatible ribbons.

**Response:**
```json
{
  "ok": true,
  "data": {
    "device_brands": [
      { "value": "amano", "label": "Amano", "count": 3 },
      { "value": "brother", "label": "Brother", "count": 12 },
      { "value": "canon", "label": "Canon", "count": 7 },
      { "value": "casio", "label": "Casio", "count": 2 },
      { "value": "citizen", "label": "Citizen", "count": 8 },
      { "value": "daro", "label": "Daro", "count": 7 },
      { "value": "epson", "label": "Epson", "count": 41 },
      { "value": "facit", "label": "Facit", "count": 8 },
      { "value": "fujitsu", "label": "Fujitsu", "count": 3 },
      { "value": "hermes", "label": "Hermes", "count": 7 },
      { "value": "ibm", "label": "IBM", "count": 4 },
      { "value": "imperial", "label": "Imperial", "count": 4 },
      { "value": "nakajima", "label": "Nakajima", "count": 2 },
      { "value": "ncr", "label": "NCR", "count": 1 },
      { "value": "nec", "label": "NEC", "count": 2 },
      { "value": "oki", "label": "OKI", "count": 9 },
      { "value": "olivetti", "label": "Olivetti", "count": 14 },
      { "value": "olympia", "label": "Olympia", "count": 13 },
      { "value": "optima", "label": "Optima", "count": 1 },
      { "value": "panasonic", "label": "Panasonic", "count": 9 },
      { "value": "printronix", "label": "Printronix", "count": 1 },
      { "value": "remington", "label": "Remington", "count": 3 },
      { "value": "remstar", "label": "Remstar", "count": 2 },
      { "value": "royal", "label": "Royal", "count": 7 },
      { "value": "samsung", "label": "Samsung", "count": 6 },
      { "value": "sears", "label": "Sears", "count": 3 },
      { "value": "seiko", "label": "Seiko", "count": 3 },
      { "value": "seikosha", "label": "Seikosha", "count": 2 },
      { "value": "sharp", "label": "Sharp", "count": 6 },
      { "value": "silver reed", "label": "Silver Reed", "count": 7 },
      { "value": "smith corona", "label": "Smith Corona", "count": 6 },
      { "value": "star", "label": "Star", "count": 9 },
      { "value": "swintec", "label": "Swintec", "count": 4 },
      { "value": "triumph-adler", "label": "Triumph-Adler", "count": 13 },
      { "value": "underwood", "label": "Underwood", "count": 2 },
      { "value": "universal", "label": "Universal", "count": 3 }
    ]
  }
}
```

Use `label` for display, `value` for the filter query param, `count` for ribbon count badges.

---

### GET /api/ribbons/device-models — Device models (drill-down)

| Param | Type | Description |
|---|---|---|
| `printer_brand` or `device_brand` | string (max 100) | Filter by device brand (case-insensitive) |

**Response:**
```json
{
  "ok": true,
  "data": {
    "device_models": [
      { "value": "all-models", "label": "All Models", "brand": "Olivetti", "count": 15 },
      { "value": "et-121", "label": "ET 121", "brand": "Olivetti", "count": 1 },
      { "value": "etp55", "label": "ETP55", "brand": "Olivetti", "count": 1 }
    ]
  }
}
```

`count` = number of ribbon products compatible with that model. `value` is lowercased for filter keys.

---

### GET /api/ribbons/brands — Ribbon product brands

No parameters. Returns ribbon manufacturer brands (not device brands).

**Response:**
```json
{
  "ok": true,
  "data": {
    "brands": ["Amano", "Brother", "Canon", "Citizen", "Epson", "Fujitsu", "IBM", "Nakajima", "NCR", "NEC", "OKI", "Olivetti", "Olympia", "Panasonic", "Printronix", "Seiko", "Seikosha", "Sharp", "Star", "Triumph-Adler", "Universal"]
  }
}
```

---

### GET /api/ribbons/models — Compatible model names

| Param | Type | Description |
|---|---|---|
| `brand` | string (max 100) | Filter by ribbon product brand (not device brand) |

Returns a simple sorted string array of compatible model names.

**Response:**
```json
{
  "ok": true,
  "data": {
    "models": ["ERC-09", "ET-121", "FX-80", "LQ-300", "ML-182"]
  }
}
```

---

## Admin Endpoints

All require `requireAdmin` middleware (super_admin or stock_manager role). Rate limit: 30 req/min per admin.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/ribbons` | List all ribbons (includes inactive, cost_price, margin) |
| `GET` | `/api/admin/ribbons/:ribbonId` | Detail with compatibility (by product ID, not SKU) |
| `PUT` | `/api/admin/ribbons/:ribbonId` | Update ribbon (name, color, sale_price, stock, is_active) |
| `POST` | `/api/admin/ribbons` | Create new ribbon |
| `DELETE` | `/api/admin/ribbons/:ribbonId` | Soft delete (sets is_active=false) |

Admin responses include `cost_price`, `margin_percent`, `source`, and `weight_kg` fields not exposed in public endpoints.

---

## Frontend Implementation Guide

### Typical Filter Flow

1. On page load, fetch **`/api/ribbons/device-brands`** and **`/api/ribbons/brands`** in parallel.
2. When user selects a device brand, fetch **`/api/ribbons/device-models?printer_brand=<selected>`** for the model dropdown.
3. Pass all filters to **`/api/ribbons`** (`brand`, `printer_brand`, `printer_model`, `search`, `color`, `sort`, `page`, `limit`).
4. On ribbon click, fetch **`/api/ribbons/:sku`** for detail page with compatibility list.

### Nav Bar Brand Grid

The "TYPEWRITER & PRINTER RIBBONS" dropdown should fetch from `GET /api/ribbons/device-brands` and render dynamically. All 36+ brands appear in one list (typewriter and printer brands mixed). New brands are picked up automatically.

Filter by device brand: `GET /api/ribbons?device_brand={value}`

Examples:
- `GET /api/ribbons?device_brand=olivetti` — Olivetti typewriter ribbons
- `GET /api/ribbons?device_brand=epson` — Epson printer ribbons
- `GET /api/ribbons?device_brand=brother` — Brother typewriter + printer ribbons

### Suggested URL Structure

```
/ribbons                          → All ribbons
/ribbons?device_brand=olivetti    → Olivetti compatible ribbons
/ribbons?device_brand=epson       → Epson compatible ribbons
/ribbon/153.11                    → Single ribbon product page
```

### Product Page — Compatible Devices

Show the `compatible_devices` array as a "Compatible With" section:

```
Compatible With:
  Brother    — AX 10, AX 100, AX 110, ...
  Olivetti   — All Models
  Olympia    — All Models
  Panasonic  — All Models
```

### Image Paths

Pattern: `/images/ribbons/{sku}.webp`

SKUs use dot notation (e.g., `153.11`, `81001.01`) or codes (e.g., `143LOT`, `IERC30`, `E15633`).

### Color Filter Options

Common ribbon colors:
- Black
- Black/Red
- Purple
- Red

### Rate Limiting

All public ribbon endpoints: **60 requests/minute** per IP.
Admin endpoints: **30 requests/minute** per admin user.
