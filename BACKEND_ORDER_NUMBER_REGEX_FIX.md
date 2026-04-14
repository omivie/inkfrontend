# Backend fix: `/api/orders/:orderNumber` regex rejects legacy order numbers

## Symptom
Viewing an existing order from the account Order History page shows "Order not found".

Example: order `ORD-MMM0292I-8Z3B` appears correctly in `GET /api/orders` but `GET /api/orders/ORD-MMM0292I-8Z3B` returns:

```json
{"ok":false,"error":{"code":"VALIDATION_FAILED","message":"Validation failed",
 "details":[{"field":"orderNumber","message":"Order number must match format ORD--"}]}}
```

## Cause
The route validator for `/api/orders/:orderNumber` uses a stricter alphabet than the ID generator that created older orders. Empirically:

- `ORD-MMLY0Y96-7F36` — passes validation (→ 401 auth)
- `ORD-MMM0292I-8Z3B` — fails validation
- `ORD-MMMMMMMM-MMMM` — fails validation

The regex appears to be Crockford-base32-style (excludes `I`, `L`, `O`, `U`), but rows stored in the DB were generated with a broader alphabet that includes `I`. Related endpoints (`/api/orders` list, `/api/orders/track/:orderNumber`, `/api/orders/:orderNumber/cancel`) do not reject these IDs, only the detail GET.

## Fix
Loosen the `orderNumber` param validator on `GET /api/orders/:orderNumber` (and any other route using the same validator) to match the alphabet actually used by the order-number generator. Minimum safe regex:

```
/^ORD-[A-Z0-9]{8}-[A-Z0-9]{4}$/
```

Keep it consistent with the generator so future changes don't regress.

## Frontend workaround (already shipped)
`inkcartridges/js/order-detail-page.js` now falls back to `GET /api/orders` and finds the order by `order_number` when the detail endpoint 4xx's. Remove the fallback once the regex is relaxed.
