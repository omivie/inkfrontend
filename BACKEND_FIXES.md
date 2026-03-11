# Backend Fixes Required

Issues and gaps found during frontend-backend integration audit (2026-03-11).

## Orders

### 1. Address field names need both formats (or migration)
The frontend has been updated to send the spec-compliant field names:
- `first_name`, `last_name` (instead of `recipient_name`)
- `address_line_1`, `address_line_2` (instead of `address_line1`, `address_line2`)

**Action:** Verify the backend `POST /api/orders` endpoint accepts these exact field names. If it currently expects `recipient_name` / `address_line1`, update the Joi schema to match the spec.

### 2. Shipping tier and zone validation
The frontend now sends `shipping_tier` and `shipping_zone` from the checkout shipping options response. Verify the backend:
- Accepts these fields in the order creation payload
- Uses them for shipping cost calculation (not just the generic `delivery_type`)

### 3. Idempotency key format change
The frontend now generates a deterministic SHA-256 hash (hex string, 64 chars) instead of a random UUID. Verify:
- The backend accepts hex string format (not just UUID format)
- The idempotency check works correctly with deterministic keys

## Ribbons

### 4. `/api/ribbons` brand filter
The frontend now uses `GET /api/ribbons?brand=...` with server-side brand filtering. Verify:
- The `brand` query parameter actually filters results server-side
- Pagination (`page`, `limit`) works correctly with the brand filter applied
- Response includes proper `meta` pagination object

## Contact Form

### 5. Turnstile token validation
The frontend now sends `turnstile_token` with `POST /api/contact`. Verify:
- The endpoint validates the Turnstile token server-side
- Requests without a valid token are rejected (when Turnstile is enabled)
- The error response is clear (e.g., `{ ok: false, error: { code: "CAPTCHA_FAILED", message: "..." } }`)

## General

### 6. Consistent error response format
Some endpoints may return errors in inconsistent formats. The spec says:
```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```
But some endpoints return `{ "ok": false, "error": "string message" }`. Audit all endpoints for consistency.

### 7. CORS for Turnstile script
Ensure `challenges.cloudflare.com` is not blocked by CSP headers if Content-Security-Policy is configured.
