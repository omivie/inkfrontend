# Backend Follow-up — Three Remaining Items

**Verified on:** 2026-04-13 via live `curl` + Playwright against `https://ink-backend-zaeq.onrender.com`.

Three prior handoffs (`BACKEND_IMAGE_PROXY_FIX.md`, `BACKEND_SEARCH_SPEC.md`, `BACKEND_AUDIT_REQUEST.md`) have mostly been implemented. These three items remain open.

---

## 1. Image proxy rate limit still too aggressive

**File:** `BACKEND_IMAGE_PROXY_FIX.md` §"Fix 2 — Exempt image routes from the aggressive rate limiter"

**Current behavior:**

```bash
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://ink-backend-zaeq.onrender.com/api/images/optimize?url=https%3A%2F%2Flmdlgldjgcanknsjrcxh.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fpublic-assets%2Fimages%2Fproducts%2FG-HP-67-INK-BK%2Fproduct.png&w=400&format=webp" &
done | sort | uniq -c
```

Returns: `19× 200, 11× 429` — about 37% rate-limited.

**Target:** zero 429s on a 30-parallel burst. A real search-result grid fires 20–30 image requests simultaneously; browsers silently retry so cards eventually fill, but users see a slow/flickery fill.

**What to change:** Raise the image-route limiter's `max` substantially (e.g. 600/min/IP) or exempt `/api/images/*` entirely from the global limiter. Code snippets are in `BACKEND_IMAGE_PROXY_FIX.md` §Fix 2.

**Verification after fix:** the burst command above must return all 200s (or a mix of 200 + 304). No 429s.

---

## 2. Printer-model search returns empty in `/api/search/smart`

**File:** `BACKEND_SEARCH_SPEC.md` — required test case `mp280 → Canon MP280 compatible cartridges`

**Current behavior:**

```bash
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=mp280&limit=3'
# { "ok": true, "data": { "products": [], "total": 0 } }
```

Zero results. Other test cases (`069`, `canon 069 magenta`, `label tape 12mm`) all return correctly, and some rows already include `"printer_model"` in `match_fields`, which suggests the match-field label exists but the actual `printer_models` / `product_compatibility` join isn't wired into the smart-search query.

**What to change:** the smart-search SQL must also search `printer_models.full_name` / `printer_models.model_name` and join `product_compatibility` → `products` when a query token matches a printer model name. Weight this `printer_model` match around +25 per the spec. See `BACKEND_SEARCH_SPEC.md` §Target fields to match against and §Ranking rules.

**Verification after fix:** these three queries must each return ≥1 product:

```bash
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=mp280&limit=5' | jq '.data.products | length'
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=tz-231&limit=5' | jq '.data.products | length'
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=typewriter+ribbon&limit=5' | jq '.data.products | length'
```

All three must be `> 0`. For `mp280`, the top result should be a Canon MP280-compatible ink cartridge (e.g. PG-40 / CL-41 family).

---

## 3. `BACKEND_AUDIT_RESPONSE.md` was never written

**File:** `BACKEND_AUDIT_REQUEST.md` §"Required response format"

The audit request explicitly instructed you to write answers to `/Users/matcha/Desktop/FEINK/BACKEND_AUDIT_RESPONSE.md`. That file does not exist yet.

**What to do:** open `BACKEND_AUDIT_REQUEST.md`, read Questions 1–3 (search envelope, reviews path, cart coupon response shape) plus the optional Bonus section, and write authoritative answers into the response file at the path above, following the structure shown at the bottom of the request.

Spot-check results the frontend already verified via HTTP (do not treat these as a substitute — they don't cover response shape, only status codes):

- `GET /api/products/:id/reviews` → 200 (frontend path works)
- `GET /api/ribbons?search=abc` → 200 (param accepted)
- `POST /api/cart/validate` → 400 with empty body (route registered, shape unknown)

The frontend still needs authoritative paste-in samples of real JSON responses for:
- `GET /api/search/smart?q=canon&limit=10`
- `GET /api/search/autocomplete?q=can&limit=10`
- `GET /api/products?search=canon&page=1&limit=20`
- `GET /api/products/:id/reviews`
- `POST /api/cart/coupon` with `{"code": "SAVE10"}`
- `DELETE /api/cart/coupon`

Without these, the frontend audit can't close out defensive parsing branches.

---

## Priority

1. **P0** — #1 (image rate limit) and #2 (printer-model search). Both degrade user-facing search UX right now.
2. **P1** — #3 (audit response). Unblocks frontend cleanup but isn't user-visible.
