# FE verification — what landed, what didn't (2026-09-08)

Verified against **production**, not against the diff. Three of the four hand-off
items are done and one of them is genuinely excellent work. Two gaps remain, and
one of them is costing money every day.

---

## ✅ Done — verified live

### 1. Google Ads add-to-cart conversion (`add-to-cart-tracking` §1)

**It fired for the first time in the account's history**: `Shopping Cart`
(action `7710654861`) recorded **2 conversions on 2026-09-07**. Before that,
`conversion_last_conversion_date` was empty across ~6 months and 771 ad clicks.

The implementation in `/js/gtag.js` is better than the hand-off asked for:

- It uses the server's `quantity_added`, so the BF-060 triple-value bug is closed.
- It keeps the client-side derivation as a **live fallback**, clamped to the
  requested quantity — so a response missing the delta errs in the *safe*
  direction, never the expensive one.
- It checks the TYPE of `price_snapshot` before coercing, so a missing price fires
  a conversion with **no value** rather than a confident `$0.00`.
- Putting it in `gtag.js` (38 of 43 pages, HEAD script) rather than a new file
  correctly avoids the ERR-194 enrolment trap.

The event name is `'conversion'` rather than `'add_to_cart'` — that is right. What
routes the hit is `send_to` + label, and both labels were verified byte-identical
against the account's own generated snippets on 2026-09-08.

### 2. Mobile checkout layout

Verified fixed on production: email input moved **1,621px → 542px**, desktop
unchanged at 329px, `body.scrollWidth` 406 → 379.

Behaviourally confirmed too — mobile shoppers now **reach** checkout:

| | before | 2026-09-07 | 2026-09-08 |
|---|---|---|---|
| mobile `checkout_started` | ~0 | **5** | **2** |

### 3. Consent banner

`consent-banner.js` correctly touches **only** `analytics_storage` and leaves
`ad_storage` alone. Under Consent Mode an unmentioned type is granted, so Google
Ads conversion tracking is unaffected. Checked explicitly while diagnosing a
conversion gap — the reasoning in the file header is correct.

---

## ❌ Gap 1 — mobile still cannot COMPLETE a checkout

Mobile now reaches checkout and stops dead:

```
2026-09-07   mobile checkout_started 5   ->  checkout_completed 0
2026-09-08   mobile checkout_started 2   ->  checkout_completed 0
             desktop, same window: 18 started -> 2 completed
```

Seven starts, zero completions. On its own too small to prove anything — but it
matches the prior **0 of 36 over 120 days**, and there is a concrete mechanism.

### The suspect, verified in the live DOM

```html
<input type="radio" name="delivery_type" value="urban" class="..." required>
<input type="radio" name="delivery_type" value="rural" class="..." required>
```

**Neither is `checked`.** Both are `required`. The form cannot submit until the
shopper picks one, and HTML5 constraint validation on an unchecked radio group
reports against an element that may be off-screen — the shopper taps Continue and
nothing visibly happens. This is exactly the dead end hit while testing on a
390x844 viewport.

### Why defaulting is safe

The backend already treats this as optional with the same default:

```js
// src/validators/schemas.js
delivery_type: Joi.string().valid('urban', 'rural').default('urban')
```

The FE's hard `required` is **stricter than the API needs, for no gain**.

**Suggested fix — pre-select Urban:**

```html
<input type="radio" name="delivery_type" value="urban" ... checked>
```

Rural stays an explicit choice. If you would rather not default a price-affecting
field (rural is $14 vs $7 in Auckland), the alternative is to keep it required but
guarantee the validation message is **scrolled into view and visible** on tap.
Either closes the dead end; defaulting is the smaller change.

> **This is the single highest-value fix outstanding.** Mobile is ~64% of the
> market and is currently **excluded from all Google Ads campaigns at -100%**
> precisely because it cannot convert. It gets switched back on the day a mobile
> purchase completes.

---

## ❌ Gap 2 — ad landing pages still show no products

`/ink-cartridges` on production, after full render:

```
h1        "Shop Ink Cartridges & Toner NZ"
h2        "Choose a brand to see ink cartridges"
prices    0
```

`buy ink cartridges` is **53% of all Google Ads spend** and lands here.

**The backend half has been live and is verified working** — re-checked
2026-09-08, all three categories return 200 with real products:

```
GET /api/products/popular?category=ink&limit=4
  CLC531XLBK   $33.49   CCLI521KCMY  $25.99
  C564BK       $12.49   CLC431XLKCMY $139.49

GET /api/products/popular?category=toner&limit=4
  CTN2445BK    $46.99   CTN258XLBK   $67.49
  CTN1070BK    $24.49   GTK5494BK    $150.79

GET /api/products/popular?category=ribbons&limit=4   -> 4 products
```

Rows are shaped through the standard §7.1 pipeline — same fields as `/api/shop`,
`quantity_breaks` included, `cost_price` stripped — so the existing card component
should drop straight in. Render it **above** the brand chooser and leave the brand
grid underneath.

Verify with:

```js
(document.body.innerText.match(/\$\d+\.\d{2}/g) || []).length   // want > 0
```

---

## 🔧 Now unblocked — `X-Session-Id` (backend fixed today)

You were right, and the note in `api.js` was accurate:

> *"the header is still absent from `Access-Control-Allow-Headers` (BF-054) ... a
> BROWSER refuses to send the request at all"*

That was a **backend** bug and it is now fixed (commit `393ae6c`).
`Access-Control-Allow-Headers` now includes `X-Session-Id` and `X-Visitor-Id`,
pinned by `__tests__/cors-analytics-identity-headers.test.js`.

The `?sid=` workaround on cart POSTs is doing its job — server-side `add_to_cart`
rows are landing with session ids. But **search is still 100% anonymous**:

| | rows (5d) | with `session_id` |
|---|---|---|
| `search_analytics` | 915 | **0** |

Since you deliberately (and correctly) would not put `?sid=` on edge-cached
catalog GETs, the header was the only route — and it now works. Adding it in the
shared fetch wrapper covers every search endpoint at once:

```js
headers['X-Session-Id'] = sessionId;   // same id the traffic beacon mints
headers['X-Visitor-Id'] = visitorId;
```

Constraints unchanged (`ID_RE`): `[A-Za-z0-9_.:-]`, 1-128 chars, rejected whole if
malformed. Deploy the backend before shipping this.

---

## Priority

1. **`delivery_type` default** — unblocks mobile, which unblocks ~64% of the ad market.
2. **Popular row on the three landing pages** — endpoint is live and waiting.
3. **`X-Session-Id` header** — now possible; ends six months of anonymous search data.
