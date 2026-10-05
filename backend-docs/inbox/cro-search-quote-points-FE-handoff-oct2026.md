# Search add-to-cart, PDF quote, reward points — FE handoff (Oct 2026)

Backend work for the CRO brief of 2026-10-04 is live once this commit deploys. The
UI parts sit in the storefront repo. No coupon codes anywhere: the brief asks us to
lead with quantity pricing and reward points instead.

## 1. One-click Add to Cart in the search dropdown

**No new endpoint.** The dropdown already calls `GET /api/search/smart?q=…&limit=40`.
Every row carries what an add needs:

| Field | Use |
|---|---|
| `id` | `POST /api/cart/items` body `{ "product_id": id, "quantity": 1 }` (send `X-Guest-Session` / `Authorization` as the cart page does) |
| `in_stock`, `stock_quantity` | Hide or disable the button when `in_stock` is false |
| `retail_price` | Price shown beside the button |
| `pack_type`, `source` | Badge (`value_pack` = "Value pack"; genuine / compatible from `source`, never from the name) |

`/api/search/suggest` rows also carry `id`, `sku`, `price` and `stock_quantity` if you
use that endpoint instead.

**Query normalisation is now server-side** for `/smart`, `/suggest` and
`/autocomplete`. These all resolve to the same results:

| Typed | Matched as | Before (production, 2026-10-04) |
|---|---|---|
| `604 xl` | `604xl` | `/suggest` and `/autocomplete` returned printer ribbons |
| `604-xl` | `604xl` | `/autocomplete` returned nothing |
| `epson604` | `epson 604` | `/smart` returned the standard 604 only, no XL |
| `hp65 xl` | `hp 65xl` | — |

A glued printer model (`hp1050de`) is deliberately left alone. Do not add your own
query rewriting on top; send what the shopper typed.

## 2. PDF quote ("Download PDF quote")

`GET /api/cart/quote.pdf` returns the CURRENT cart as a branded quote (proforma
invoice) for a buyer's internal approval: seller details, GST number, quote number,
lines, quantity-pricing discount, shipping, total incl. GST, and the GST component.
It reads the same figures as `GET /api/cart`, so it cannot disagree with checkout.

Optional query parameters (all strings, all optional):

| Param | Rule | Effect |
|---|---|---|
| `company`, `attention`, `reference` | ≤ 80 chars | Printed in the quote header (e.g. a PO number) |
| `region`, `postal_code` (4 digits), `delivery_type` (`urban`/`rural`) | as checkout | Exact shipping for that zone instead of the cart's North Island urban estimate |

A plain link cannot send the cart headers, so fetch and save the blob:

```js
const res = await fetch(`${API}/api/cart/quote.pdf?company=${encodeURIComponent(company)}`, {
  headers: { ...authHeaders(), 'X-Guest-Session': guestSessionId }
});
if (res.ok) {
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'inkcartridges-quote.pdf';
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
```

- `Content-Disposition` is now in the CORS exposed headers, so the file name is readable.
- `400 CART_EMPTY` when there is nothing to quote; `429` after 10 downloads a minute.
- **Label it "Download PDF quote"** (or "…for approval"). Avoid "Official": the
  document is a quote, not a tax invoice, and says so. The tax invoice is emailed on
  payment.
- Place it in the cart drawer and on checkout, as the brief asks.

## 3. Reward points

**Product page:** `GET /api/products/:sku` now returns

```json
"reward_points": { "points": 63, "points_per_dollar": 1, "multiplier": 1, "redemption_rate": 100 }
```

for one unit (absent when the programme is off). Show "Earn 63 reward points" near the
price. For a quantity rung in `quantity_breaks[]`, the figure is
`floor(business_price × min_quantity) × points_per_dollar × multiplier`.
`redemption_rate` is points per $1 off.

**Cart summary:** already returned — `loyalty.earn_on_this_order` for members AND
guests. Render "Points to be earned: N points" beside the free-shipping line. For a
guest (`loyalty.guest === true`) the points are collected by creating an account with
the same email; `loyalty.message` already says so in compliant words.

**Quantity table on the PDP:** `quantity_breaks[]` is already on the product response
(qty, unit price, saving per unit). Render it near the price. Do not headline a
maximum percentage: each rung is floor-clamped per line.

## 4. Emails (backend, no FE work)

- **Cart recovery 1h**: now carries the real low-stock note (only when 1-5 are on
  hand) and the dispatch promise from `getTrustSignals()`.
- **Cart recovery 24h**: states the reward points the cart earns (guest wording
  explains collecting them) and up to three "add N more and pay $X each"
  quantity-price breaks. No coupon.
- **Reorder prompts already exist**: refill reminder at 40 days (ink) / 60 days
  (toner, bottles) with a follow-up 7 days later, plus the business reorder email
  timed on each company's own reorder gap. Every one carries the one-click reorder
  button (`buildReorderLink`: signed cart load for members, `/cart?add=` for guests).
