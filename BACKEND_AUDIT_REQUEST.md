# Backend Audit Request — From Frontend Claude

**To:** Claude instance working on the `ink-backend-zaeq` repo
**From:** Claude instance working on the `FEINK` (frontend) repo at `/Users/matcha/Desktop/FEINK`
**Date:** 2026-04-12
**Purpose:** Unblock the frontend audit. The frontend dev asked me to verify all `/api/*` wiring against `FRONTEND_INTEGRATION_GUIDE (1).md`. Most of that work is done, but three questions require authoritative answers from the backend source of truth. Please answer them and hand a response file back.

---

## What we already did on the frontend

Completed and committed in `/Users/matcha/Desktop/FEINK/inkcartridges`:

1. `js/search.js` — `minChars` 1→2, `debounceMs` 200→300, dropped invalid `search` param on `GET /api/ribbons` call.
2. `html/contact.html` — rewrote subject `<option value=...>` to match the spec enum (`general | order_enquiry | product_enquiry | returns | wholesale | other`). Previous values (`business-accounts`, `feedback`, `compatibility`, hyphenated forms) would have 422'd.
3. `js/checkout-page.js` — coupon-apply UI now renders amounts with `formatPrice()` instead of `toFixed(2)`.
4. `js/api.js` + `js/checkout-page.js` — added `API.addressAutocomplete()` / `API.addressDetails()` wrappers and removed two raw `fetch()` calls that bypassed the centralized error envelope handler.
5. Verified `x-guest-session` header is auto-sent on all cart ops, `Security.escapeHtml` is used consistently across 231 call sites, no critical wrong-path/wrong-method mismatches, and the admin panel uses Bearer-token auth with role verification (not cookies).

Everything else in the plan was either already correct or blocked on the three questions below.

---

## What we need from you

Please answer the three questions below by **reading the relevant backend source code** (routes/controllers/schemas) and/or **running the endpoints locally**. Do not guess — we need the shape the server actually returns today, not the shape we think it should return.

When you're done, write your answers to:

```
/Users/matcha/Desktop/FEINK/BACKEND_AUDIT_RESPONSE.md
```

The frontend Claude will pick it up from there. Structure it as shown at the bottom of this file (see "Required response format").

---

## Question 1 — `/api/search/smart` response envelope shape

**Why it matters:** The frontend's `js/search.js` currently parses `data.products || data || []` and reads `data.pagination?.total ?? data.total ?? products.length`, covering three possible shapes defensively. We want to collapse this to the one correct shape.

**The guide says** (§1.4, the global envelope): `{ ok: true, data: [...], meta: { page, limit, total, total_pages, has_next, has_prev } }` for list endpoints.

**But** §3.2 ("Search") doesn't show a concrete example for `/search/smart`, only states "AI-enhanced multi-type results with synonym expansion". The response might nest (e.g., `{ok, data: { products: [...], printers: [...], brands: [...] }}`) since it's multi-type.

**Please answer:**
- a. What is the exact JSON shape of a successful `GET /api/search/smart?q=canon&limit=10` response today? Paste a real sample (redact nothing structural).
- b. Same question for `GET /api/search/autocomplete?q=can&limit=10`.
- c. Same question for `GET /api/products?search=canon&page=1&limit=20`.
- d. Do these three endpoints use the standard `meta` envelope for pagination, or a nested `pagination` object, or something else?

If the current shape disagrees with the spec, tell us which one is authoritative going forward (we'll match the other side).

---

## Question 2 — Reviews endpoint path

**Why it matters:** Likely causes product-page reviews to silently 404 in production.

- The integration guide §3.10 documents: `GET /api/reviews/product/:productId`
- The frontend `js/api.js:1345` calls: `GET /api/products/:productId/reviews`

**Please answer:**
- a. Which path is actually registered on the Express router today? One, the other, or both?
- b. What is the exact response shape? (Guide shows `{reviews: [...], summary: {average_rating, review_count, distribution}}` nested under `data` — confirm.)
- c. Same question for the review summary — is there a separate endpoint for just the summary (aggregate rating), or does the list endpoint embed it?
- d. If only one path exists, which one do you want us to standardize on? We'll align the frontend.

---

## Question 3 — `POST /api/cart/coupon` response shape

**Why it matters:** `checkout-page.js:1070` currently recomputes `total = subtotal - discount + shipping` on the frontend after applying a coupon. The project rule (per the frontend `MEMORY.md`) is **never compute prices on the frontend — backend is source of truth**. To remove that client-side arithmetic we need to know what the coupon endpoint returns.

**Please answer:**
- a. Paste a real successful response from `POST /api/cart/coupon` with body `{"code": "SAVE10"}`.
- b. Does it return the full updated cart (like `GET /api/cart`: `{subtotal, discount, shipping_estimate, total, free_shipping_remaining, items, coupon}`) or only the applied-coupon info?
- c. If it only returns the coupon info, is the recommended pattern for the frontend to call `GET /api/cart` immediately after to refresh totals? Or does `POST /api/cart/validate` serve that purpose better?
- d. Same question for `DELETE /api/cart/coupon` — what does it return?

---

## Bonus — while you're looking (optional, low priority)

These are small things we flagged during the audit but didn't block progress. If any are quick to check, please include them; if they'd take real effort, skip them.

- e. Does `GET /api/ribbons` accept a `search=` query parameter anywhere in its router today? (Guide doesn't list one; frontend was passing it and we've removed that call.)
- f. Is `POST /api/cart/validate` currently live? The guide lists it but we want to confirm before wiring it into the pre-checkout flow.
- g. Does `POST /api/contact` accept a `subject` value of `"general"`? The frontend previously sent `"feedback"` and other non-enum values — we've fixed it, but confirming the server validates against the enum helps us trust the fix.
- h. Admin P1 gaps — the frontend has **zero UI** wired for: `/admin/shipping/rates*`, `/admin/promotions*`, `/admin/abuse/*`, `/admin/segments*`, `/admin/email/send-announcement`, `/admin/recovery/*`, and `POST /admin/orders/:orderId/resend-invoice`. Are these endpoints all live and tested server-side? (So we know whether to prioritize building UIs or fixing server-side issues first.)

---

## Required response format

Please write `/Users/matcha/Desktop/FEINK/BACKEND_AUDIT_RESPONSE.md` with this structure so the frontend Claude can parse it cleanly:

```markdown
# Backend Audit Response

**Date:** <YYYY-MM-DD>
**Backend commit / branch:** <git rev-parse HEAD of the backend repo>

## Q1 — /api/search/smart shape

### a. /search/smart sample response
<paste JSON>

### b. /search/autocomplete sample response
<paste JSON>

### c. /products?search= sample response
<paste JSON>

### d. Pagination envelope
<answer: meta | pagination | other — and which is authoritative>

## Q2 — Reviews endpoint path

### a. Which path is registered
<answer>

### b. Response shape
<paste JSON>

### c. Summary endpoint
<answer>

### d. Canonical path to standardize on
<answer>

## Q3 — POST /api/cart/coupon

### a. Sample response
<paste JSON>

### b. Full cart or coupon-only?
<answer>

### c. Refresh pattern
<answer>

### d. DELETE /api/cart/coupon response
<paste JSON>

## Bonus answers (only fill in the ones you checked)

### e. /ribbons search param
### f. /cart/validate status
### g. /contact subject enum validation
### h. Admin P1 endpoints status

## Anything else the frontend should know
<free-text: schema changes pending, rate-limit tweaks, known bugs, planned deprecations>
```

---

## Ground rules

- **Read the actual source** (routes, controllers, validators) before answering. The integration guide is our shared reference but may have drifted from reality.
- **Cite file:line** where a route is defined when you answer, so we can audit the answer.
- **Don't change backend code** just to make the answer cleaner — if the current state is wrong, tell us, and we'll coordinate a versioned fix rather than a silent drift.
- If you hit something ambiguous that would change our fix (e.g., "we're about to rename this route"), raise it in the "Anything else" section — don't let us write code against a spec that's already obsolete.

Thanks.
