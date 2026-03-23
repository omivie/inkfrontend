# Backend: Ribbon Compatibility — Bug Report & Requirements

## Status

| Endpoint | Status |
|---|---|
| `POST /api/admin/compatibility/bulk-upsert` | **BROKEN** — returns error (see below) |
| `internal_notes` limit increase to 10,000 | ✅ Done |
| All other compatibility endpoints | ✅ Working |

---

## Bug: `POST /api/admin/compatibility/bulk-upsert` fails

### What happens
Every call to this endpoint returns an error. The frontend receives:
```
"Failed to bulk upsert compatibility"
```

### Request being sent
```json
POST /api/admin/compatibility/bulk-upsert
Authorization: Bearer <admin JWT>
Content-Type: application/json

{
  "sku": "154-11",
  "models": [
    "Brother CE25",
    "Brother CE30",
    "Casio CW110",
    ...
  ]
}
```

### What to check in backend logs
1. Is the route registered correctly? (`/api/admin/compatibility/bulk-upsert`)
2. Is the request body being parsed? (`models` is an array, `sku` is a string)
3. Is there a DB error? (constraint violation, missing table, transaction rollback)
4. Is the admin auth middleware blocking it?

### Expected behaviour
For each name in `models`:
1. Look up existing printer by name (case-insensitive)
2. If not found → INSERT into `printers` table
3. Bulk INSERT all printer IDs into compatibility junction table for `sku`
4. Use `ON CONFLICT DO NOTHING` (idempotent)

### Expected response
```json
{
  "ok": true,
  "data": {
    "sku": "154-11",
    "total": 128,
    "created": 95,
    "already_existed": 33,
    "linked": 128,
    "already_linked": 0
  }
}
```

### Error response format the frontend expects
If something goes wrong, return:
```json
{
  "ok": false,
  "error": {
    "message": "descriptive error here",
    "details": "optional extra info"
  }
}
```

---

## Also needed: Bulk search endpoint (rate limiting issue)

The "Find Printers" step makes one GET request per model (up to 128 requests).
This triggers rate limiting: `"Too many requests. Please wait a moment."`

### New endpoint: `GET /api/printers/search/bulk`

**Request:**
```
POST /api/printers/search/bulk
Body: { "queries": ["Brother CE25", "Brother CE30", ...] }
```

**Backend logic:**
- For each query, search `printers` table by name (case-insensitive LIKE or full-text)
- Return best match per query (or null if not found)

**Response:**
```json
{
  "ok": true,
  "data": {
    "results": [
      { "query": "Brother CE25", "printer": { "id": "uuid", "name": "Brother CE25", "full_name": "Brother CE25" } },
      { "query": "Brother CE30", "printer": null }
    ]
  }
}
```

This is lower priority than fixing bulk-upsert — the frontend works around it with batched requests + delays.

---

## Rate limiting

Admin endpoints (`/api/admin/*`) should be exempt from or have a much higher rate limit than public endpoints. Currently the rate limiter blocks bulk admin operations.

Please ensure `/api/admin/*` routes use a separate, more permissive rate limit (e.g. 500 req/min per user vs 60 req/min for public).
