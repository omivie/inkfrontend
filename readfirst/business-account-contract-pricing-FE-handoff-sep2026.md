# FE hand-off — Custom pricing per business account (contract pricing)

**Date:** 2026-09-06 · **Backend:** live on `main`, migration **165** applied to
production Supabase · **Audience:** admin FE dev (+ one storefront note in §8)

---

## 1. What this is

An admin opens **one** business account, searches the catalogue **inside that
account**, and sets that account's own price for a product. The price applies to
that account and nothing else. Every change is recorded with the **previous price
alongside the new one**, so the panel can show "was $134.49 → now $104.90"
without deriving anything.

The important guarantee, because it is what makes this safe to ship: **no
catalogue row is ever written.** The price lives in its own table keyed on
(business account × product). Every other customer, the Google feed, the sitemap
and Merchant Center are untouched by definition, not by convention.

This sits *beside* the existing global volume ladder (Business → Volume
discounts), which stays exactly as it is. At checkout the account pays whichever
of the two is cheaper — see §7.

---

## 2. Auth & envelope

- **super_admin only.** Hide the whole surface for `order_manager` /
  `stock_manager` (they get 403).
- Send the admin's existing session JWT: `Authorization: Bearer <token>` —
  identical to every other `/api/admin/*` call.
- Standard envelope: `{ ok: true, data: {…}, meta?: {…} }` /
  `{ ok: false, error: { code, message, details? } }`.
- Base URL: the same API origin the admin app already uses.
- Rate limits: **60/min** for reads, **20/min** for writes, per admin.

> These responses include `cost_price` and margin figures. That matches the
> existing policy on `GET /admin/products` (cost + profit are owner-level), but
> it is one more reason the surface must stay super_admin-gated in the UI.

---

## 3. Suggested UX

```
Business account  ▸  Jackson                            [ Custom pricing ]
─────────────────────────────────────────────────────────────────────────
 Search this account's pricing…            [ TN253            ] 🔍

 PRODUCT                          LIST      THIS ACCOUNT   MARGIN   LAST CHANGE
 GTN2530BK  Brother TN2530 Black  $134.49   $104.90  -22%   6.7%    $114.32 → $104.90
                                                                     6 Sep · you   [History] [Edit] [Remove]
 …
                                                          [ + Add a product ]
```

1. **Account picker** — `GET /admin/business/accounts` (§4.1). Each row carries
   `custom_price_count`, so the list can badge "3 custom prices".
2. **Pricing tab** — `GET …/custom-prices` (§4.3) fills the table above.
3. **Add a product** — type-ahead against `GET …/product-search` (§4.4). Every
   hit already tells you the list price, whether this account already has a
   price, and the two guard-rail figures (`break_even_price`, `floor_price`) so
   the price input can warn *while the operator types*, with no round trip.
4. **Save** — `PUT …/custom-prices/:productId` (§4.5). The response contains the
   fully-shaped row, so splice it into the table rather than refetching.
5. **History** — `GET …/price-history` (§4.6), account-wide or `?product_id=` for
   one row's drawer.
6. **Remove** — `DELETE …/custom-prices/:productId` (§4.7).

---

## 4. The endpoints

### 4.1 `GET /api/admin/business/accounts`

The account picker. **This endpoint is new** — there was previously no way to
list business accounts at all (only create and patch), which is why the pricing
tab had nothing to hang off.

Query: `search` (company name, optional) · `status` (`active|suspended|closed`,
optional) · `page` (1) · `limit` (25, max 100).

```jsonc
{
  "ok": true,
  "data": {
    "accounts": [{
      "id": "4a182f95-…",              // ← the account id every other call needs
      "user_id": "c4324303-…",         // cross-reference /admin/customers
      "company_name": "Jackson",
      "status": "active",
      "credit_limit": 0,
      "credit_used": 0,
      "net30_approved": false,
      "ap_email": "junjackson0915@gmail.com",
      "contact_name": "Jackson Jun",
      "contact_email": "junjackson0915@gmail.com",
      "contact_phone": null,
      "custom_price_count": 3,          // ← badge this
      "created_at": "2026-09-01T06:02:03.754656+00:00",
      "updated_at": "2026-09-01T06:02:03.754656+00:00"
    }]
  },
  "meta": { "page": 1, "limit": 25, "total": 2, "total_pages": 1 }
}
```

### 4.2 `GET /api/admin/business/accounts/:id`

The same object under `data.account`, for the pricing tab's header. **404** on an
unknown id (never a silent empty response).

### 4.3 `GET /api/admin/business/accounts/:id/custom-prices`

This account's live prices. Query: `search` (SKU or name) · `page` · `limit` (25).

```jsonc
{
  "ok": true,
  "data": {
    "account": { "id": "4a182f95-…", "company_name": "Jackson", "status": "active" },
    "items": [{
      "product_id": "f8ea54b2-…",
      "sku": "GTN2530BK",
      "name": "Brother Genuine TN2530BK Toner Cartridge TN2530 Black (1,200 pages)",
      "slug": "brother-genuine-tn2530bk-…",
      "image_url": "images/products/…webp",   // same relative form as /admin/products
      "brand": "Brother",
      "source": "genuine",
      "is_active": true,                       // the PRODUCT's status
      "stock_quantity": 22,

      "list_price": 134.49,                    // GST-incl, what everyone else pays
      "contract_price": 104.90,                // GST-incl, what THIS account pays
      "discount_amount": 29.59,
      "discount_percent": 22,

      "cost_price": 82.69,                     // super_admin only
      "net_margin_percent": 6.7,               // at the contract price, after Stripe %
      "below_cost": false,
      "below_floor": false,                    // under the automatic-discount floor
      "above_list": false,

      "notes": "Renegotiated Sep 2026",
      "created_at": "…", "updated_at": "…",

      "last_change": { /* one history row — see §4.6 */ }
    }]
  },
  "meta": { "page": 1, "limit": 25, "total": 1, "total_pages": 1 }
}
```

`last_change` is embedded so the table's "was → now" column needs **no second
call per row**.

### 4.4 `GET /api/admin/business/accounts/:id/product-search`

Catalogue search scoped to the account. Query: `q` (or `search`) · `only_priced`
(bool, default false) · `page` · `limit` (20, max 50). Active products only.

```jsonc
{
  "ok": true,
  "data": {
    "account": { "id": "4a182f95-…", "company_name": "Jackson" },
    "query": "TN253",
    "items": [{
      "product_id": "f8ea54b2-…",
      "sku": "GTN2530BK",
      "name": "Brother Genuine TN2530BK Toner Cartridge TN2530 Black (1,200 pages)",
      "slug": "…", "image_url": "…", "brand": "Brother",
      "source": "genuine", "product_type": "toner_cartridge", "stock_quantity": 22,

      "list_price": 134.49,
      "cost_price": 82.69,
      "break_even_price": 97.68,     // below this we LOSE money → the save is refused
      "floor_price": 102.99,         // lowest the automatic ladder would ever go

      "has_contract_price": false,   // ← "Already priced" chip
      "contract_price": null,
      "discount_amount": null,
      "discount_percent": null,
      "net_margin_percent": null,
      "last_change": null
    }]
  },
  "meta": { "page": 1, "limit": 20, "total": 5, "total_pages": 1 }
}
```

**Use `break_even_price` and `floor_price` for live input validation** — colour
the field amber below `floor_price`, red below `break_even_price` — so the
operator sees the problem before they press Save.

### 4.5 `PUT /api/admin/business/accounts/:id/custom-prices/:productId`

Idempotent create-or-update.

```jsonc
// request
{
  "custom_price": 104.90,               // REQUIRED. GST-INCLUSIVE. > 0, ≤ 100000, 2 dp
  "notes": "Renegotiated Sep 2026",     // optional, ≤ 1000 chars
  "acknowledge_below_cost": false       // optional — see §5
}
```

```jsonc
// 200
{
  "ok": true,
  "data": {
    "action": "updated",                // "set" | "updated" | "reactivated"
    "previous_price": 114.32,           // null on a first "set"
    "item": { /* the §4.3 row, incl. last_change — splice it straight in */ },
    "evaluation": {
      "list_price": 134.49,
      "contract_price": 104.90,
      "discount_amount": 29.59,
      "discount_percent": 22,
      "net_margin_percent": 6.7,
      "break_even_price": 97.68,
      "floor_price": 102.99,
      "below_cost": false,
      "below_floor": false,
      "above_list": false,
      "cost_known": true,
      "warnings": []                    // human-readable strings — show them as-is
    }
  }
}
```

> **`custom_price` is GST-INCLUSIVE**, the same basis as the price on the
> storefront and as `products.retail_price`. Do not send an ex-GST figure.

### 4.6 `GET /api/admin/business/accounts/:id/price-history`

The audit trail. Query: `product_id` (optional — narrows to one product) ·
`page` · `limit` (50, max 100). Newest first.

```jsonc
{
  "ok": true,
  "data": {
    "account": { "id": "4a182f95-…", "company_name": "Jackson" },
    "product_id": "f8ea54b2-…",     // echoes the filter, null when account-wide
    "items": [{
      "id": "285bfa02-…",
      "product_id": "f8ea54b2-…",
      "sku": "GTN2530BK",                       // SNAPSHOT — see the note below
      "name": "Brother Genuine TN2530BK …",     // SNAPSHOT
      "action": "updated",                      // set | updated | reactivated | removed
      "previous_price": 114.32,                 // ← the two figures to show side by side
      "new_price": 104.90,
      "change_amount": -9.42,                   // signed; negative = the price went DOWN
      "change_percent": -8.2,
      "list_price_at_change": 134.49,
      "discount_percent_at_change": 22,
      "changed_by": "c4324303-…",
      "changed_by_email": "junjackson0915@gmail.com",
      "notes": "Renegotiated Sep 2026",
      "created_at": "2026-09-06T02:15:54.179300+00:00"
    }]
  },
  "meta": { "page": 1, "limit": 50, "total": 3, "total_pages": 1 }
}
```

Reading the nulls correctly matters:

| action | `previous_price` | `new_price` | `change_amount` |
|---|---|---|---|
| `set` (first time) | `null` | the price | `null` |
| `updated` | the old price | the new price | signed delta |
| `reactivated` (re-added after removal) | `null` | the price | `null` |
| `removed` | the withdrawn price | `null` | `null` |

`sku` and `name` are **snapshots taken at the time of the change** and the row
has no foreign key to `products` — so a later SKU rename, or deleting the
product entirely, cannot rewrite history. Render the history row's own `sku`,
not the current product's.

### 4.7 `DELETE /api/admin/business/accounts/:id/custom-prices/:productId`

Optional body `{ "notes": "Contract ended" }`. Removes the account's price; the
account immediately reverts to list + the ordinary volume ladder.

```jsonc
{
  "ok": true,
  "data": {
    "action": "removed",
    "product_id": "f8ea54b2-…",
    "previous_price": 104.90,      // what was withdrawn
    "list_price": 134.49,
    "last_change": { /* the 'removed' history row */ }
  }
}
```

**404** if the account has no price for that product (so a double-click on
Remove is safe and reports honestly rather than pretending to succeed).

---

## 5. The one thing the backend refuses

Only **below cost** is refused. Everything else is allowed and merely flagged,
because a thin negotiated line is a commercial decision the operator owns.

```jsonc
// 409
{
  "ok": false,
  "error": {
    "code": "PRICE_BELOW_COST",
    "message": "This price is below cost — it would lose money on every unit. Break-even is $97.68. Re-send with acknowledge_below_cost: true to set it anyway.",
    "details": {
      "evaluation": { /* the full §4.5 evaluation block, below_cost: true */ },
      "requires": "acknowledge_below_cost"
    }
  }
}
```

**Suggested handling:** on 409 with `PRICE_BELOW_COST`, show a confirm dialog
using `error.message` plus `details.evaluation.net_margin_percent`, and on
confirm re-send the identical body with `acknowledge_below_cost: true`. The
refused request changes nothing — the stored price is untouched.

Other error codes:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `custom_price` ≤ 0, > 100000, or a non-UUID path param |
| 400 | `BAD_REQUEST` | product has no list price to price against |
| 401 / 403 | — | not signed in / not `super_admin` |
| 404 | `NOT_FOUND` | unknown account, unknown product, or (on DELETE) no price set |
| 409 | `PRICE_BELOW_COST` | see above |
| 429 | `RATE_LIMITED` | 60/min reads, 20/min writes |

Flags worth surfacing even on a **successful** save (`data.evaluation`):

- `below_floor: true` — profitable, but deeper than the automatic ladder would
  ever go. Show the warning; don't block.
- `above_list: true` — the price is *above* the current list price. Allowed, but
  the account is charged the **list** price until list rises above it. The
  warning string says so.
- `cost_known: false` — the product has no supplier cost, so no margin could be
  checked. `net_margin_percent`, `break_even_price` and `floor_price` are all
  `null`; show "margin unknown" rather than "0%".

---

## 6. Operator pricing assist — invoices and quick orders

Both operator editors can now autofill a contract customer's own price. They
share one line-pricing path on purpose: a quick order converts straight into an
invoice, so separate paths would change the numbers at the bridge.

Both are **advisory** — nothing is written, and the operator's typed price stays
authoritative at save time.

### 6.1 Naming the customer

Both endpoints accept **either** identifier, and resolve the account server-side:

| Field | Use when |
|---|---|
| `customer_id` | you have the customer (the quick-order form already carries it) — **preferred**, no lookup needed |
| `business_account_id` | you already picked an account |

**Only an ACTIVE account prices a quote.** A suspended or closed account is still
resolved and reported so you can explain the list pricing instead of leaving the
operator guessing.

Both responses carry the same account envelope:

```jsonc
{
  "business_account_id": "4a182f95-…",
  "business_account_name": "Jackson",
  "business_account_status": "active",     // "suspended" | "closed" | null
  "contract_prices_consulted": true,       // this account's prices were IN EFFECT
  "contract_priced_line_count": 1          // how many lines actually took one
}
```

> Read those last two carefully: `contract_prices_consulted` does **not** mean a
> line got a contract price. An active account with no negotiated price on any
> quoted line is `true` / `0`. **Badge off `contract_priced_line_count`; explain
> off `business_account_status`.**

### 6.2 `POST /api/admin/quick-orders/quote` (new)

super_admin · **60/min** (it fires as the operator types, so it has its own
limiter rather than sharing the 30/min read one). Post the editor's current
draft; only `product_code` and `quantity` are read, so you can send lines
verbatim.

```jsonc
// request
{ "customer_id": "c4324303-…", "line_items": [{ "product_code": "CLC73BK", "quantity": 8 }] }
```

```jsonc
// data.lines[] — a resolved line (verbatim from a real response)
{
  "position": 0,
  "input_code": "CLC73BK",          // what was typed
  "product_code": "CLC73BK",        // canonical SKU it resolved to
  "resolved": true,
  "name": "Compatible LC73 Black Ink",
  "source": "compatible",
  "is_active": true,
  "quantity": 8,
  "retail_incl_gst": 15.49,
  "contract": { "unit_incl_gst": 9.99, "unit_excl_gst": 8.69,
                "per_unit_saving_excl_gst": 4.78, "line_saving_excl_gst": 38.24 },
  "volume": null,
  "unit_price_excl_gst": 8.69,      // ← THE AUTOFILL FIGURE, already resolved
  "list_unit_excl_gst": 13.47,      // ← struck-through "was"
  "volume_discount_percent": null,  // mig-140 display keys — LADDER ONLY
  "volume_saving_excl_gst": null,
  "volume_quantity": null
}
```

> There is deliberately **one** price key to autofill. The invoice quote's
> qty-1 `unit_excl_gst` is *not* carried on a quick-order line — two same-shaped
> price fields, one qty-1 and one final, is the pair that gets picked wrong.
> The negotiated qty-1 price is still reachable at `contract.unit_excl_gst`.
> An unresolved line carries neither price key at all.

Three things worth knowing:

- **`unit_price_excl_gst` is pre-resolved.** It already picks between the
  contract price and a deeper quantity rung — drop it straight into the line. (The
  invoice quote makes you choose between two fields; this one does not.)
- **A contract price never fills the three `volume_*` keys.** Those describe the
  ladder; a negotiated price is not a volume discount, and mislabelling it would
  carry across the QO → invoice bridge. The contract price is already reflected
  in `unit_price_excl_gst`, and the change itself is auditable in the price
  history (§4.6), so nothing is lost.
- **Unresolved codes return `{ resolved: false, reason: "code_not_found" }`,
  not a 400** — the operator is mid-typing. The hard SKU check stays at save.

### 6.3 `POST /api/admin/invoices/quote` (extended)

Unchanged except that it now also accepts `customer_id` (previously
`business_account_id` only), returns the §6.1 envelope, and each line gains
`contract: {…} | null`. `unit_excl_gst` (the qty-1 autofill) becomes the contract
price ex-GST when one applies; the `volume` block is returned only when a quantity
break beats it, and its saving is then measured against the contract price.

**Send neither identifier and nothing changes** — every existing quote behaves
exactly as before.

---

## 7. How the price is actually charged

Worth knowing so the UI can explain itself, and so nobody re-implements it.

- The account is charged **`min(contract price, volume-ladder price, list)`**.
  A contract customer therefore never pays more than a guest buying the same
  quantity, and never above list.
- Normally the contract price wins (the public ladder tops out around 10%).
  Where a big-quantity rung goes deeper, the rung wins — that is deliberate.
- A contract price **outranks the 5% net-margin floor** that clamps the automatic
  ladder, and applies even when the product has no recorded cost. An operator
  typing a price is explicit intent; the guard rails live in the admin API
  (§5), not in the charge path.
- Mechanically the contract saving rides the **existing volume-discount line** —
  it is inside `summary.volume_discount` and therefore inside `summary.discount`
  and `summary.total`. **No new total arithmetic.**

---

## 8. Storefront (one small note)

Only relevant if the storefront wants to badge the contract price. Nothing
breaks if it does nothing.

**Cart** (`GET /api/cart` and every cart mutation response):

- `items[].contract_price` — the account's price, or `null`.
- `items[].price_source` — `"contract"` | `"volume"` | `"list"`.
- `items[].quantity_breaks` — for a contract line these are relative to the
  contract price; rungs that don't beat it are dropped (so an empty array still
  honestly means "buying more doesn't get cheaper"). Contract rungs carry one
  extra key, `savings_vs_base`.
- `volume_discount` gains `contract_discount_amount`, `volume_discount_amount`
  and `contract_line_count`; `source` becomes `"contract"` or
  `"volume+contract"` where relevant. **`discount_amount` keeps its old meaning:
  the total automatic per-line saving.**
- New top-level `contract_pricing: { company_name, line_count, discount_amount }
  | null`. Its `discount_amount` is a **subset** of
  `volume_discount.discount_amount` — never add the two.

**PDP** (`GET /api/business/pricing?skus=…`, B2B users only): each item gains
`your_price`, `price_source`, `contract_price`, `contract_savings_amount`,
`contract_savings_percent`; the envelope gains `company_name` and
`contract_priced_count`.

**Business Centre reorder tiles** (`GET /api/business/reorder-items`, B2B only):
`price` is now **what this account pays** — their contract price when one is set,
else list. It keeps its name and position, so the existing tile renders the right
number with **no FE change required**. Two new keys are additive:
`list_price` (what everyone else pays — use it for a struck-through "was") and
`price_source` (`"contract"` | `"list"`), plus `contract_price`. Quantity is 1 on
a reorder tile, so no volume rung applies; the ladder is applied once the item is
actually added to the cart.

**Public/anonymous catalogue payloads are deliberately unchanged.** Contract
prices never appear on `/products`, `/shop`, `/search/*`, `/ribbons`, prerender
or JSON-LD — those responses are cached without a `Vary`, so one account's
negotiated price appearing there would be served to every shopper. This is
pinned by a test; don't ask for it to be added to a listing endpoint.

---

## 9. Verification already done

- **52-check end-to-end run** against the production database: account list,
  scoped product search, set → update → refuse-below-cost → list → history →
  isolation → remove → re-add-as-`reactivated`, plus a check that the catalogue
  row was never touched and that the other business account resolves **nothing**
  for the same product. All test rows deleted afterwards.
- **24-check cart run** on a real cart: setting a contract price moved
  `summary.volume_discount` by exactly `(list − contract) × qty`, `summary.total`
  fell by exactly that amount, `subtotal` stayed at list, and removing the price
  returned the cart to its ladder-only baseline to the cent.
- **32 unit tests** (`__tests__/business-contract-pricing.test.js`), including
  wiring pins asserting that the two charge paths resolve contract prices per
  account and that the three publicly-cached surfaces never do.
- **8 route tests** for the reorder tiles, covering BOTH the RPC path and the
  no-RPC fallback (the fallback is the one that gets forgotten — it only runs
  when the RPC is missing). Neither live business account has order history
  today, so `/business/reorder-items` returns `[]` in production and could not be
  proved end-to-end; it is pinned at the route level instead.
- **15-check production run of the quick-order quote**: account resolved from
  `customer_id` alone, contract price autofilled ex-GST, the other business
  account quoted list, the invoice quote autofilling the identical figure
  (bridge parity), and no `quick_orders` row written by quoting.
- **48 tests across 3 new suites** for this change set
  (`business-contract-pricing.test.js`, `business-reorder-tiles-contract-price.test.js`,
  `quick-order-quote-contract-pricing.test.js`),
  and the full repo suite green alongside them.
- Security: both tables verified `SET ROLE authenticated`-blocked (read and
  execute), RLS on with zero policies.

---

## 10. Out of scope / not built

- **No bulk import.** One product at a time. A CSV upload would be a natural
  follow-up; say the word.
- **No expiry dates** on a contract price. It stays until removed.
- **No per-account discount %** (e.g. "15% off everything Brother") — this is a
  per-product price only.
- **Quick Orders saving is unchanged** — the quote (§6.2) is advisory; the
  operator's typed `unit_price_excl_gst` is still what gets stored, and
  `computeQuickOrderTotals` still recomputes the money server-side. The endpoint
  only offers the right number.
- The dead `segment_price_lists` table is unrelated and stays dead.
