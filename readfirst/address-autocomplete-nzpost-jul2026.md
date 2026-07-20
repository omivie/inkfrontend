# Checkout Address Autocomplete — NZ Post (FE integration)

**Status:** ✅ Backend live & verified (2026-07-18). ✅ **Frontend integrated & verified (2026-07-20)** — see FE notes below.
**Owner (backend):** `src/routes/address.js`, `src/services/nzPostAddressService.js`.
**Owner (frontend):** `inkcartridges/js/address-autocomplete.js` (single shared engine), `js/api.js` (`nzpostSuggest`/`nzpostDetails`).

> **FE status (2026-07-20).** Every requirement below is implemented and pinned by
> `tests/address-autocomplete-shared-jul2026.test.js`: 300ms debounce, 3-char minimum,
> discrete-field mapping (`postcode`, not `postal_code`), non-blocking empty `region`,
> graceful manual-entry fallback, no client-side credentials. Google is fully retired
> (no endpoint, field, or CSP entry survives). Consumers: checkout shipping + billing
> blocks (`js/checkout-page.js`) and the account addresses modal (`js/account.js`).
>
> **FE additions beyond the spec:**
> - Session cache per query (repeat queries cost zero requests), a 5xx circuit breaker,
>   and a `RATE_LIMITED` backoff shared across all attached inputs — all to protect the
>   30 req/min/IP budget, which is shared with account writes (ERR-096).
> - `{ noRetry: true }` on both calls so api.js's retry ladder can't amplify a burst.
> - **ERR-109:** filling the address line dispatches a bubbling `input` event that used
>   to re-enter the module's own listener and fire an extra `/suggest` per selection.
>   Guarded by `_selfFill`. Do not remove — see the regression test.
> - Empty results (`ok:true`, `data:[]`) show a soft *"No matching addresses"* hint
>   rather than the spec's "unavailable" copy: the service is healthy, so the stronger
>   message would cry wolf. Real failures still get the full fallback message.
> - Full combobox a11y (`aria-expanded`/`aria-activedescendant`/`aria-selected`).
>
> **Not wired:** `/quote` collects delivery suburb/city/postcode but has no street-address
> field. Adding one would introduce a `delivery_address` key to `POST /api/contact` —
> needs a backend decision first.

## What changed & why

Checkout showed *"Address suggestions are unavailable right now — please type your address manually."* because the address provider was down. Autocomplete now runs on **NZ Post Address Checker** (previously Google Places, which was disabled). The FE must call the **`/api/address/nzpost/*`** endpoints below and map the response fields to the checkout form.

- **Base URL:** `https://api.inkcartridges.co.nz`
- **Auth:** none on the FE — the backend holds the credentials.
- **Envelope:** every response is `{"ok":true,"data":…}` on success, or `{"ok":false,"error":{"code","message"}}` on failure.

---

## 1. Suggestions (as the user types)

```
GET /api/address/nzpost/suggest?q=<text>&max=5
```

| Param | Required | Notes |
|---|---|---|
| `q` | yes | User's partial input. Send after **3+ characters**. |
| `max` | no | 1–24, default `5`. |

**Live response:**
```json
{
  "ok": true,
  "data": [
    { "dpid": 1464938, "full_address": "131 Tiverton Road, New Windsor, Auckland 0600" }
  ]
}
```

Render each `full_address` in the dropdown; keep its `dpid` for step 2.

---

## 2. Full address (after the user picks a suggestion)

```
GET /api/address/nzpost/details?dpid=<dpid>
```

**Live response:**
```json
{
  "ok": true,
  "data": {
    "dpid": "1464938",
    "full_address": "131 Tiverton Road, New Windsor, New Windsor, Auckland, 0600",
    "address_line1": "131 Tiverton Road",
    "address_line2": "New Windsor",
    "suburb": "New Windsor",
    "city": "Auckland",
    "region": "",
    "postcode": "0600"
  }
}
```

Returns `404 {"ok":false,…}` if the `dpid` isn't found.

### Map to the checkout form

| Checkout field | Response field |
|---|---|
| ADDRESS | `address_line1` |
| APARTMENT, SUITE, ETC. | `address_line2` |
| CITY | `city` |
| REGION | `region` |
| POSTCODE | `postcode` |

---

## UX flow

1. User types in **ADDRESS** → debounced `GET /suggest?q=…` (≥3 chars).
2. Show dropdown of `data[].full_address`, each carrying its `dpid`.
3. On select → `GET /details?dpid=…` → populate CITY / REGION / POSTCODE (+ ADDRESS if you want to normalise it).
4. On any failure/empty result → keep the existing *"Address suggestions are unavailable…"* manual-entry fallback.

---

## Gotchas (read these)

- **`region` is usually `""`.** NZ Post's dataset has no region field, so leave the **REGION** dropdown for the user to select; **do not block submit** waiting for it.
- **Debounce is required.** The endpoint is rate-limited **30 requests/min per IP**. Debounce ~250–300 ms and don't fire below 3 characters. Do **not** call per keystroke.
- **Keep the graceful fallback.** If a call returns `ok:false` or an empty `data` array, show the manual-entry message rather than an error. This is the intended degraded state.
- **Cosmetic:** the *details* `full_address` can repeat the suburb (`…New Windsor, New Windsor…`). Fill the form from the **discrete fields** (`address_line1` / `city` / `postcode`) and use the **suggest** `full_address` (clean) for the dropdown label.
- **No API keys in the frontend.** Never embed NZ Post credentials client-side.

---

## Migrating from the old Google endpoints

If the checkout currently calls Google, switch endpoints and rename fields:

| Old (Google) | New (NZ Post) |
|---|---|
| `GET /api/address/autocomplete?q=` | `GET /api/address/nzpost/suggest?q=` |
| `GET /api/address/details?place_id=` | `GET /api/address/nzpost/details?dpid=` |
| suggest field `place_id` | `dpid` |
| suggest field `description` | `full_address` |
| details field `postal_code` | `postcode` |

---

## Quick test (no auth needed)

```bash
curl "https://api.inkcartridges.co.nz/api/address/nzpost/suggest?q=131+Tiverton+Auckland"
# → {"ok":true,"data":[{"dpid":1464938,"full_address":"131 Tiverton Road, New Windsor, Auckland 0600"}]}

curl "https://api.inkcartridges.co.nz/api/address/nzpost/details?dpid=1464938"
# → {"ok":true,"data":{"address_line1":"131 Tiverton Road","city":"Auckland","postcode":"0600",...}}
```
