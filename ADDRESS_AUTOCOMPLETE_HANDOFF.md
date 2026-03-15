# Address Autocomplete — Frontend Integration Guide

Two new public endpoints proxy Google Places to keep the API key server-side and restrict results to NZ only.

---

## Endpoints

### `GET /api/address/autocomplete`

Returns up to 5 address suggestions as the user types.

**Query params**

| Param | Type   | Required | Notes              |
|-------|--------|----------|--------------------|
| `q`   | string | yes      | Min 1, max 200 chars |

**Example request**
```
GET /api/address/autocomplete?q=131+tiver
```

**Example response**
```json
{
  "ok": true,
  "data": [
    {
      "place_id": "ChIJxxxxxxxxxxxxxxxx",
      "description": "131 Tiverton Road, Avondale, Auckland 1026, New Zealand"
    },
    {
      "place_id": "ChIJyyyyyyyyyyyyyyyy",
      "description": "131 Tiverton Avenue, Palmerston North 4410, New Zealand"
    }
  ]
}
```

---

### `GET /api/address/details`

Resolves a `place_id` into structured address fields that map directly to the checkout address form.

**Query params**

| Param      | Type   | Required | Notes               |
|------------|--------|----------|---------------------|
| `place_id` | string | yes      | From autocomplete response |

**Example request**
```
GET /api/address/details?place_id=ChIJxxxxxxxxxxxxxxxx
```

**Example response**
```json
{
  "ok": true,
  "data": {
    "address_line1": "131 Tiverton Road",
    "address_line2": "",
    "city": "Avondale",
    "region": "Auckland",
    "postal_code": "1026"
  }
}
```

**Unit/subpremise example** — if the place has a unit number, `address_line1` is formatted as `unit/number street`:
```json
{
  "address_line1": "2/131 Tiverton Road"
}
```

**Field → form field mapping**

| API field       | Form field         |
|-----------------|--------------------|
| `address_line1` | Street address     |
| `address_line2` | Apartment/unit (pre-filled or blank) |
| `city`          | City/suburb        |
| `region`        | Region/province    |
| `postal_code`   | Postcode (4-digit NZ) |

---

## Rate Limiting

Both endpoints are limited to **30 requests per minute per IP**. On limit breach the API returns:

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please slow down."
  }
}
```

Debounce autocomplete calls to at least **300ms** to stay well within this limit.

---

## Error Responses

All errors follow the standard `{ ok: false, error: { code, message } }` shape.

| Status | Code            | When                                     |
|--------|-----------------|------------------------------------------|
| 400    | `BAD_REQUEST`   | Missing/invalid `q` or `place_id` param |
| 429    | `RATE_LIMITED`  | Over 30 req/min/IP                       |
| 500    | `INTERNAL_ERROR`| Server-side issue (API key missing, etc.) |
| 502    | (no code)       | Google Places returned an error          |

---

## Suggested UX Flow

```
User types in address field
  → debounce 300ms
  → GET /api/address/autocomplete?q=<input>
  → show dropdown list of `description` values

User selects a suggestion
  → GET /api/address/details?place_id=<selected place_id>
  → auto-fill form fields from response
  → allow manual edit of any field
```

### React example (pseudo-code)

```tsx
const [query, setQuery] = useState('');
const [suggestions, setSuggestions] = useState([]);

// Debounced autocomplete
useEffect(() => {
  if (query.length < 2) return setSuggestions([]);
  const timer = setTimeout(async () => {
    const res = await fetch(`/api/address/autocomplete?q=${encodeURIComponent(query)}`);
    const { ok, data } = await res.json();
    if (ok) setSuggestions(data);
  }, 300);
  return () => clearTimeout(timer);
}, [query]);

// On suggestion select
async function handleSelect(placeId) {
  const res = await fetch(`/api/address/details?place_id=${encodeURIComponent(placeId)}`);
  const { ok, data } = await res.json();
  if (ok) {
    setFormField('address_line1', data.address_line1);
    setFormField('address_line2', data.address_line2);
    setFormField('city', data.city);
    setFormField('region', data.region);
    setFormField('postal_code', data.postal_code);
    setSuggestions([]);
  }
}
```

---

## Notes

- Results are restricted to **New Zealand only** — no config needed on the frontend.
- `country` defaults to `NZ` in the address schema; no need to pass it.
- Both endpoints are **public** — no auth token required.
- `address_line2` is always returned as an empty string if not applicable; safe to use directly.
