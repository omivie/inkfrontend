# Backend Handoff: Markup % + Profit $ alongside Margin %

> **For the backend agent.** The frontend changes for this feature are already merged in the `matcha/FEINK` repo (see `inkcartridges/js/admin/utils/profitability.js` and the updated `pages/products.js` / `pages/margin.js`). Your job is to make the backend API + exports match. The frontend falls back to computing markup client-side when your fields are missing, so no hard cutover — ship when ready.

## Why
The admin UI previously exposed a single "Margin" column. Users misread 85.8% as markup; actually it's margin-of-sale-price. The two metrics are different:

- **Margin %** = profit ÷ sale price (capped at 100%)
- **Markup %** = profit ÷ cost (uncapped — answers "how many times over cost")
- **Profit $** = absolute dollar profit, ex-GST

Frontend now shows all three everywhere margin used to appear. Backend needs to match so CSV/XLSX exports and API consumers stay in sync.

## Environment — Fill These In Before Starting
The frontend repo lives at `matcha/FEINK` (private). The backend is a **separate** repo deployed on Render. When you open this doc in that repo, confirm and replace the TODOs:

- Backend repo: `<TODO: confirm repo name / path>`
- Language / framework: `<TODO: Node+Express? Python+FastAPI? other?>`
- DB client: `<TODO: supabase-js? supabase-py? raw pg?>`
- Production base URL: `https://ink-backend-zaeq.onrender.com` (from `MEMORY.md`)
- Dev base URL: `<TODO: localhost port>`
- Auth scheme for `/api/admin/*` endpoints: `<TODO: Supabase JWT? service-role key? custom admin token?>`
- Deploy: `<TODO: Render auto-deploy from main? manual?>`

Check the repo's `README.md` and existing `/api/admin/margin/*` handler for conventions before adding new fields — match the existing style (param validation, error envelope, response shape).

## Canonical Formulas — Single Source of Truth
NZ GST is 15%. `retail_price` in DB is **GST-inclusive**; `cost_price` is **GST-exclusive** (do not change this convention — frontend assumes it).

Define one shared helper (e.g. `utils/profitability.ts` or `utils/profitability.py`) so no handler hand-rolls the math:

```
const GST_RATE = 0.15;

function computeProfitability(retail_price, cost_price) {
  if (retail_price == null || cost_price == null
      || retail_price <= 0 || cost_price <= 0) {
    return { price_ex_gst: null, profit_ex_gst: null,
             margin_pct: null, markup_pct: null };
  }
  const priceExGst    = retail_price / (1 + GST_RATE);
  const profitDollars = priceExGst - cost_price;
  return {
    price_ex_gst:  round2(priceExGst),
    profit_ex_gst: round2(profitDollars),
    margin_pct:    round2(profitDollars / priceExGst * 100),
    markup_pct:    round2(profitDollars / cost_price  * 100),
  };
}
```

**Precision:** round all four outputs to **2 decimal places** server-side. Keeps CSVs clean and JSON deterministic.

**Null policy:** when cost or retail is missing/zero/negative, return `null` (not `0`, not `"N/A"`). Frontend renders `—` for null.

## Endpoints to Update

### 1. `GET /api/admin/export/products` (CSV + XLSX)
Add three columns alongside the existing `margin_pct`:
- `margin_pct` — already exists, keep unchanged
- `markup_pct` — new
- `profit_ex_gst` — new

Order in CSV header: `... cost_price, margin_pct, markup_pct, profit_ex_gst, ...` (after cost, before non-numeric fields). Frontend calls this via `AdminAPI.exportData('products', format, params)` — no frontend change required; users just see new columns.

### 2. `GET /api/admin/margin/summary`
Current payload shape (read by frontend in `inkcartridges/js/admin/pages/margin.js`):
```json
{
  "ok": true,
  "data": {
    "price_changes_count": 0,
    "underpriced_count": 0,
    "out_of_stock_count": 0,
    "total_active_products": 0,
    "average_margin_by_source": { "genuine": 0, "compatible": 0 },
    "top_profit_products": [
      { "sku": "...", "source": "genuine", "cost_price": 0, "retail_price": 0,
        "profit_ex_gst": 0, "margin_pct": 0 }
    ]
  }
}
```
**Add:**
- `average_markup_by_source: { genuine: number|null, compatible: number|null }`
- `markup_pct` field on every `top_profit_products[]` entry
- Ensure `top_profit_products[]` row shape matches the `/margin/top-profit` endpoint exactly (same keys, same order) — easier to reuse one serializer.

### 3. `GET /api/admin/margin/recommended-prices`
Current item shape: `{ product_id, sku, name, source, current_retail, cost_price, recommended_retail, current_margin_pct, gap }`.
**Add:**
- `current_markup_pct` — computed from `current_retail` + `cost_price`
- `recommended_markup_pct` — computed from `recommended_retail` + `cost_price`

Note: the existing `gap` field is **margin-percentage-point** gap vs the 30% target margin (frontend has been relabeled to "Margin Gap" to reflect this). Do **not** change `gap` semantics.

### 4. `GET /api/admin/margin/price-changes`
Current item shape: `{ sku, name, source, previous_cost, current_cost, change_pct, current_margin_pct, detected_at }`.
**Add:**
- `markup_before` — compute from current `retail_price` + `previous_cost`
- `markup_after`  — compute from current `retail_price` + `current_cost`

If `retail_price` isn't already loaded into this handler, add it to the query. Frontend has a client-side fallback, but server values are more reliable (and the frontend fallback needs `retail_price` in the payload anyway).

### 5. `GET /api/admin/margin/top-profit`
Current item shape: `{ sku, name, source, cost_price, retail_price, profit_ex_gst, margin_pct }`.
**Add:**
- `markup_pct`
- Support `sort_by=markup_pct` query param (in addition to existing `absolute_profit` and `margin_pct`).

## Compatibility Rules (Important)
- **Do not rename** `margin_pct`, `profit_ex_gst`, `current_margin_pct`, or any existing key — frontend reads them.
- All additions are **additive**; old clients continue working.
- Return numeric fields as JSON `number`, not strings.
- `null` for missing — never `0`, `"—"`, `"N/A"`, or empty string.
- Keep the response envelope (`{ ok, data }`) consistent with the existing `/margin/*` endpoints.

## Verification

**Unit-level spot check** — Brother Genuine TN449 Toner Cartridge Black:
- `cost_price = 157`, `retail_price = 1275.99`
- Expected: `price_ex_gst = 1109.56`, `profit_ex_gst = 952.56`, `margin_pct = 85.85`, `markup_pct = 606.73`

**End-to-end:**
1. Hit each of the 5 endpoints above and confirm new keys appear in JSON:
   ```
   curl <TODO: dev base url>/api/admin/margin/summary \
     -H "Authorization: <TODO: auth header>"
   ```
2. Export a products CSV via the admin UI (`/admin/products.html` → Export → CSV). Confirm `margin_pct`, `markup_pct`, `profit_ex_gst` columns present and populated for products with both cost and retail.
3. Open `/admin/margin.html` in the frontend and walk the tabs. Each tab should show a Markup % column populated from backend data (no `—` placeholders except where cost/retail is missing).
4. Confirm a product with `cost_price = 0` or `cost_price = null` returns `null` for all four derived fields — frontend should show `—`.

**Sign-off:** once verified, the client-side fallback in `margin.js` (`deriveMarkupPct`) becomes a no-op but stays in place as a safety net. No need to remove it.
