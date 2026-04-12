# Backend Search Upgrade — `/api/search/smart`

**Context:** The InkCartridges frontend search bar (`js/search.js` in the frontend repo) is being upgraded to match across every meaningful product field and rank results with client-side scoring + KCMY family grouping. The frontend now fires **three parallel sources** on every keystroke (≥2 chars):

1. `GET /api/search/smart?q=...&limit=100` — you own this
2. Supabase `products.description` + `compatible_devices_html` `ilike` fallback
3. Supabase `printer_models` → `product_compatibility` → `products` join

The frontend merges, dedupes by SKU/id, scores across name/SKU/description/brand/compat, groups by product family, and orders each family by KCMY (K → C → M → Y → multipacks) with HY tiers. Backend sorting is **not** required — we only need the backend to return a richer, more relevant candidate pool.

This spec describes the target behavior for `/api/search/smart` so it can be the strongest of the three sources and eventually supersede the Supabase-direct calls.

---

## Current behavior (gap we're closing)

- Effectively searches only `name` and `sku`.
- Description, `compatible_devices_html`, printer/typewriter model names, `for_use_in`, and related-product references are not indexed.
- No relevance score returned; results appear arbitrarily ordered within ties.

---

## Target fields to match against

Per product row, the following should all contribute to matches:

| Field | Source | Weight (suggested) |
|---|---|---|
| `products.sku` / `product_code` | direct | **Highest** (exact > prefix > substring) |
| `products.name` | direct | High (word-start > substring) |
| `products.description` | direct | Medium |
| `products.compatible_devices_html` | direct (ribbons) | Medium |
| `brands.name` | join on `products.brand_id` | Low |
| `printer_models.full_name` / `model_name` | join via `product_compatibility` | Medium |
| `typewriter_models.*` (if table exists) | join equivalent | Medium |
| `for_use_in` / `related_products` text | wherever stored (check schema) | Medium |

If a field doesn't exist on the current schema, skip it — don't invent columns. If a join table has a different name, use what's actually there.

---

## Suggested implementation (Postgres)

Pick whichever you prefer; both are fine:

### Option A — `tsvector` + GIN (best relevance for word-tokenized English)

```sql
-- Materialized search doc per product
ALTER TABLE products
  ADD COLUMN search_doc tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(sku, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(compatible_devices_html, '')), 'C')
  ) STORED;

CREATE INDEX products_search_doc_idx ON products USING GIN (search_doc);
```

Then the query uses `search_doc @@ plainto_tsquery(...)` with `ts_rank_cd(search_doc, ...)` as the relevance score. Join compatibility tables separately and `UNION` / merge IDs.

### Option B — `pg_trgm` (best for fuzzy + typo-tolerant + SKU fragments like "069")

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm ON products USING GIN (name gin_trgm_ops);
CREATE INDEX products_sku_trgm  ON products USING GIN (sku  gin_trgm_ops);
CREATE INDEX products_desc_trgm ON products USING GIN (description gin_trgm_ops);
```

Use `similarity()` and `%` operator. Particularly strong for short alphanumeric SKU fragments (the user's `069` example).

**Recommendation:** use both — `pg_trgm` for SKU/name fuzzy, `tsvector` for description/compat full-text. Combine scores in SQL.

---

## Endpoint contract

**Request** (additive — existing callers keep working):

```
GET /api/search/smart?q=<query>&limit=100&include=compat,description
```

- `q` — user query (required)
- `limit` — default 20, cap at 100
- `include` — comma-separated optional expansions:
  - `compat` → also match on printer-model compatibility
  - `description` → also match on description + compatible_devices_html

If `include` is omitted, default to `compat,description` so the endpoint does the best thing by default.

**Response** (unchanged shape, additive fields):

```json
{
  "products": [
    {
      "id": 123,
      "sku": "CART069BK",
      "name": "Canon Genuine CART069BK Toner Cartridge Black",
      "color": "Black",
      "color_hex": ["#000000"],
      "retail_price": 276.99,
      "image_url": "...",
      "image_path": "...",
      "in_stock": true,
      "stock_count": 4,
      "source": "genuine",
      "brand": { "name": "Canon", "slug": "canon" },
      "category": { "name": "Toner", "slug": "toner" },
      "description": "...",
      "compatible_devices_html": "...",

      "relevance_score": 182.4,
      "match_fields": ["sku", "name"]
    }
  ],
  "pagination": { "total": 14 }
}
```

**New optional fields:**
- `relevance_score` — numeric; higher is better. Frontend reads this and merges with its own scoring.
- `match_fields` — string array of which fields hit (`sku | name | description | compatible | printer_model | typewriter_model | brand | related`). Used by the frontend to weight merges.

**Must preserve** (the frontend reads these today):
`id`, `sku`, `name`, `color`, `color_hex`, `retail_price`, `image_url`, `image_path`, `in_stock`, `stock_count`, `source`, `brand` (nested `{name, slug}`), `category`.

Do **not** sort by color/family — the frontend handles KCMY grouping. Return purely by `relevance_score DESC`.

---

## Ranking rules (suggested priorities)

1. SKU exact match (case-insensitive) → score boost ~200
2. SKU prefix match → ~120
3. SKU substring → ~80
4. Name word-start match → ~60
5. Name substring → ~35
6. Description/compat substring → ~15–25
7. Printer-model / compatibility hit → ~25
8. Brand substring → ~10
9. In-stock bonus → +5

Tokenize the query on whitespace and hyphens; each token contributes independently so multi-word queries like `canon 069 magenta` reward all three tokens.

---

## Test cases

Return ≥1 product for each and put the most relevant one first:

| Query | Must include |
|---|---|
| `069` | All Canon `CART069*` variants |
| `canon 069 magenta` | Canon CART069M* at top |
| `pg-40` | Canon PG-40 cartridge |
| `label tape 12mm` | Dymo 12mm label products (via description) |
| `typewriter ribbon` | Ribbon products (via compatible_devices_html / product type) |
| `mp280` | Canon MP280 compatible cartridges (via printer_models) |
| `tz-231` | Brother TZ-231 label tape |
| `genuine` / `compatible` | Already handled via `source` filter — keep working |

---

## Rollout

1. Add/migrate indexes (tsvector + trigram).
2. Update the `/api/search/smart` handler to join compat + description + brand and compute `relevance_score`.
3. Return `relevance_score` + `match_fields` on every row.
4. Bump endpoint with the new `include` param. Default to `compat,description`.
5. Frontend will pick up the richer data immediately — no frontend change needed for this backend upgrade (but the frontend's own Supabase-direct calls will fall away naturally once the API is strong enough).

## Out of scope for backend

- KCMY color ordering (frontend)
- Family grouping of cartridge variants (frontend)
- Debouncing / caching of keystrokes (frontend)
- Autocomplete UI (frontend)
