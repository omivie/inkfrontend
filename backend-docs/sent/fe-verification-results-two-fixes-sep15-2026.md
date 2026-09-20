# FE verification results — 2 items not live (2026-09-15)

We verified the full batch on **production** today. Three of five work — thank
you, the GA4 wiring in particular is exactly right. Two items are not working
on the live site. Both were verified against production with cache-busters, so
this is not stale-cache noise.

## Confirmed working — no action needed

| Item | How we verified |
|---|---|
| GA4 `view_item` | Fires on PDP load with `{item_id, item_name, item_brand, item_category, price, quantity, value, currency:"NZD"}` |
| GA4 `add_to_cart` | Fires on the add-to-cart click, same payload shape |
| GA4 `begin_checkout` | Fires on checkout entry with the full cart contents and total |
| No browser `purchase` event | Correct — the server Measurement Protocol owns purchase; do not add one |
| Checkout scroll-to-first-invalid | Submitting with an empty required field focuses it and shows "This field is required" |

---

## Fix 1 — middleware drops the query string (BLOCKS the chip-page SEO win)

**Symptom:** bot requests to `/shop?brand=<slug>&code=<code>` (and
`&category=<cat>`) still render the *generic brand page*. The backend is live
and ready — hitting it directly returns the code-specific page:

```bash
# backend, working today:
curl -s "https://api.inkcartridges.co.nz/api/prerender/brand/brother?code=LC73" | grep "<title>"
# → <title>Brother LC73 Ink Cartridges NZ | InkCartridges.co.nz</title>

# www, broken today:
curl -s -A "Googlebot" "https://www.inkcartridges.co.nz/shop?brand=brother&code=LC73" | grep "<title>"
# → <title>Brother NZ — Fast NZ Delivery | InkCartridges.co.nz</title>   ← generic
```

**Likely cause:** either the middleware change didn't reach production, or the
rewrite builds the prerender URL without the query string. The fix is one
line in the `/shop?brand=` branch of `middleware.js` — append the original
query string when proxying:

```js
// before (drops ?code / ?category):
return NextResponse.rewrite(`${API}/api/prerender/brand/${brand}`);

// after:
const qs = request.nextUrl.search; // includes brand=, harmless duplicates ok
return NextResponse.rewrite(`${API}/api/prerender/brand/${brand}${qs}`);
```

The backend ignores parameters it doesn't know, so forwarding the whole
`search` string is safe.

**Acceptance check (run after deploy):**

```bash
curl -s -A "Googlebot" "https://www.inkcartridges.co.nz/shop?brand=brother&code=LC73" | grep "<title>"
# must contain: Brother LC73 Ink Cartridges NZ

curl -s -A "Googlebot" "https://www.inkcartridges.co.nz/shop?brand=brother&category=toner" | grep "<title>"
# must contain: Brother Toner Cartridges NZ
```

---

## Fix 2 — `/cart?add=SKU:QTY` does nothing (blocks guest one-click reorder)

**Symptom:** `https://www.inkcartridges.co.nz/cart?add=C73NM:1` shows the cart
unchanged and the `?add=` parameter stays in the URL.

**Spec (from the Sep-15 addendum in the GA4 handoff doc):**

- Format: `/cart?add=SKU:QTY,SKU:QTY` — SKUs uppercase, QTY 1–20, max 12 entries.
- On cart-page load, add each entry through the **normal add-to-cart call**
  under the visitor's own session (guest or authed — same code path as the
  add-to-cart button).
- Then strip the param with `history.replaceState` so a refresh doesn't
  double-add.
- Optional nicety: toast off `?reorder=loaded|unavailable|invalid|guest`
  (our redirects already emit these).

**Acceptance check:** open `/cart?add=C73NM:1` in a fresh incognito window →
the cart shows 1× C73NM and the address bar shows plain `/cart`. Refresh →
still exactly 1× C73NM.

---

## What ships on our side the moment these land

1. **Chip/code pages added to the sitemap** — the SEO payoff Fix 1 unlocks.
2. **Guest reorder-email links switch from `/shop` to `/cart?add=…`** — one-click
   reorder for the ~99 guest recipients of every reorder/refill email
   (account holders already have it via the signed backend link).

Ping us when deployed and we'll re-run the verification above.
