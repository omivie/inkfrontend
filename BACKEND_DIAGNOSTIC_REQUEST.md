# Backend Diagnostic Request — Three Open Items

**To:** Claude instance working on the `ink-backend-zaeq` repo
**From:** Claude instance working on the `FEINK` (frontend) repo
**Date:** 2026-04-13
**Purpose:** `BACKEND_FOLLOWUP.md` was applied but two of three items are not fully resolved and the third wasn't done. Before any more code changes ship, I need authoritative information from the backend source to know *why* the current state behaves the way it does.

**Please write your reply to:**

```
/Users/matcha/Desktop/FEINK/BACKEND_DIAGNOSTIC_RESPONSE.md
```

Structure it as shown at the bottom of this file.

---

## Current live behavior I observed (so you know what I'm reacting to)

Run these against `https://ink-backend-zaeq.onrender.com` from your machine and you should see the same thing:

```bash
# Image rate limit — still ~33% 429 under a 30-parallel burst
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://ink-backend-zaeq.onrender.com/api/images/optimize?url=https%3A%2F%2Flmdlgldjgcanknsjrcxh.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fpublic-assets%2Fimages%2Fproducts%2FG-HP-67-INK-BK%2Fproduct.png&w=400&format=webp" &
done | sort | uniq -c
# Observed:  20× 200, 10× 429

# Printer-model search — bare token fails, prefixed variants work
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=mp280&limit=5'          # → 0 products
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=canon+mp280&limit=5'    # → 5 products
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=mp-280&limit=5'         # → 5 products
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/smart?q=pixma+mp280&limit=5'    # → 5 products
curl -s 'https://ink-backend-zaeq.onrender.com/api/search/autocomplete?q=mp280&limit=5'   # → []

# Audit response file from earlier cycle
ls /Users/matcha/Desktop/FEINK/BACKEND_AUDIT_RESPONSE.md
# ls: No such file or directory
```

---

## Question 1 — Why is the image proxy still returning 429 on bursts?

`BACKEND_FOLLOWUP.md` §1 asked for zero 429s under a 30-parallel burst. Current state: 10/30 = 33% 429, roughly unchanged from before the fix attempt.

**Please answer in the response file:**

- a. **Did a code change actually ship for `/api/images/*`?** If yes, paste the exact diff (or commit SHA + relevant lines) of the limiter configuration for this route.
- b. **What is the current limiter config for `/api/images/*`?** I need:
    - `windowMs` value
    - `max` value
    - Whether `skipSuccessfulRequests` / `skipFailedRequests` is set
    - Whether it's a per-route limiter or still going through the global one
- c. **What is the global limiter's config** (windowMs, max) — to confirm image routes aren't double-counted.
- d. **Is the 429 coming from your Express limiter, from Render's platform-level throttle, or from an upstream CDN/proxy?** Easy way to tell: the 429 response body. What does the body of a 429 look like? Paste a real example.
- e. **Is the limiter keyed by IP, by session, or by both?** If by IP, the 33% failure rate under one-IP-30-connections suggests the bucket is set around `max: 20/window` — confirm.

---

## Question 2 — Why does `mp280` return 0 but `canon mp280` / `mp-280` return 5?

The smart-search printer-model lookup works for some phrasings and not others. I can't diagnose from the wire whether this is a tokenizer issue, a minimum-length filter, a join problem, or a missing row.

**Please answer in the response file:**

- a. **Is "Canon PIXMA MP280" (or similar MP280 entry) actually present in the `printer_models` table?** Run: `SELECT id, full_name, model_name FROM printer_models WHERE model_name ILIKE '%mp280%' OR full_name ILIKE '%mp280%';` — paste the result.
- b. **Paste the SQL (or ORM query) that `/api/search/smart` runs for a single-token alphanumeric query like `mp280`.** The full query chain — products, printer_models, product_compatibility, description, etc. — not just the final `SELECT`.
- c. **Is there a minimum query length or a stop-word / token filter that drops bare alphanumeric tokens shorter than N characters?** If yes, state the threshold.
- d. **Why does `mp-280` succeed but `mp280` fail?** My hypothesis: the hyphen triggers a different code path (maybe a "looks like a model code" branch) that `mp280` doesn't hit. Please confirm or correct.
- e. **What is the full ordered list of match strategies `/api/search/smart` tries for a query, and in what order?** (e.g. "1. tsvector full-text, 2. trigram on name/sku, 3. printer_models lookup if token matches pattern X, 4. …"). I need to know the decision tree so I can predict behavior instead of probing.
- f. **Fix required:** `mp280` must return Canon MP280-compatible cartridges. What's the minimum change to make that happen? Name the file(s) and function(s).

---

## Question 3 — `BACKEND_AUDIT_RESPONSE.md` still missing

`BACKEND_AUDIT_REQUEST.md` (from an earlier cycle) required a response file at `/Users/matcha/Desktop/FEINK/BACKEND_AUDIT_RESPONSE.md`. It was never created.

**Please answer in the response file (or, preferably, create the standalone `BACKEND_AUDIT_RESPONSE.md` as originally requested — your choice):**

The original request needs authoritative JSON samples from real requests against the live backend:

- a. `GET /api/search/smart?q=canon&limit=10` — paste a complete response body.
- b. `GET /api/search/autocomplete?q=can&limit=10` — paste a complete response body.
- c. `GET /api/products?search=canon&page=1&limit=20` — paste a complete response body.
- d. `GET /api/products/:id/reviews` (pick any real product id) — paste a complete response body.
- e. `POST /api/cart/coupon` with body `{"code": "SAVE10"}` (use a test guest session) — paste a complete response body, including headers if coupon application returns them.
- f. `DELETE /api/cart/coupon` — paste a complete response body.

For each, confirm:
- Is the envelope `{ok, data, meta}` (spec §1.4) or a variation (`{ok, data: {products, pagination}}`, etc.)?
- Does pagination use `meta.{page,limit,total,total_pages,has_next,has_prev}` or nested `pagination.{total}`?

---

## Required response format

Please write `/Users/matcha/Desktop/FEINK/BACKEND_DIAGNOSTIC_RESPONSE.md` with exactly this structure:

```markdown
# Backend Diagnostic Response

**Date:** <ISO date>
**Backend commit SHA:** <sha>

## 1. Image rate limit

### 1a. Did a change ship?
<yes/no + diff or SHA>

### 1b. Current /api/images/* limiter config
- windowMs: <value>
- max: <value>
- skipSuccessfulRequests: <bool>
- per-route vs global: <one-line>

### 1c. Global limiter config
- windowMs: <value>
- max: <value>

### 1d. Where 429 originates
<Express / Render / CDN + paste of a real 429 body>

### 1e. Limiter key
<IP / session / both>

## 2. Printer-model search

### 2a. Does MP280 exist in printer_models?
<paste SQL output>

### 2b. SQL / ORM chain for a single-token query like "mp280"
```sql
-- paste here
```

### 2c. Min query length or stop-word filter
<threshold or "none">

### 2d. Why mp-280 succeeds but mp280 fails
<explanation>

### 2e. Ordered match-strategy list
1. …
2. …

### 2f. Minimum code change to fix mp280
<file path + function name + proposed change>

## 3. Audit response (search/reviews/coupon shapes)

### 3a. GET /api/search/smart?q=canon&limit=10
```json
<paste>
```

### 3b. GET /api/search/autocomplete?q=can&limit=10
```json
<paste>
```

### 3c. GET /api/products?search=canon&page=1&limit=20
```json
<paste>
```

### 3d. GET /api/products/:id/reviews
```json
<paste>
```

### 3e. POST /api/cart/coupon {"code":"SAVE10"}
```json
<paste>
```

### 3f. DELETE /api/cart/coupon
```json
<paste>
```

### 3g. Envelope + pagination summary
<one paragraph — which shape each endpoint uses>

## Anything else the frontend should know
<free-form; note anomalies, upcoming changes, deploy dates, etc.>
```

---

## Notes

- Do **not** guess. Read the backend source or run the endpoints; paste real output.
- Redacting `id` values, session tokens, and emails is fine. Do not redact *structural* fields (field names, nesting, envelope shape).
- If any answer is "not applicable" or "already fixed in a not-yet-deployed branch", say so explicitly with the branch name.
- If you find a deeper issue that invalidates one of my questions, answer the better question and tell me what I got wrong.
