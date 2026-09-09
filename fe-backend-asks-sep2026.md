# Backend asks from the FE verification round (2026-09-09)

Written after shipping ERR-235 (checkout delivery area), ERR-236 (popular products on the ad
landing pages) and ERR-237 (`X-Session-Id`). Everything below was measured against production
today, not inferred. Ordered by what costs you the most money if it stays as it is.

Thank you for `Access-Control-Allow-Headers` — it landed exactly as described and it was a one-line
change on our side because of it.

---

## 1. `delivery_type` is not stored on the order, and we now send a real one

**This is the one that matters most, and it is new information.**

We just shipped rural detection at checkout. An address containing an `RD n` token now selects
Rural, tells the shopper it did so, and quotes them the rural rate — $14 instead of $7 in Auckland,
$20/$30 elsewhere. `payment-page.js` has always put `delivery_type` in the order-create payload.

**It does not come back out.** Measured on order `2026090902`, both endpoints, signed in as admin:

```
GET /api/admin/orders?limit=3        → delivery_type: key ABSENT
GET /api/admin/orders/:id            → "delivery_type" appears NOWHERE in the payload
                                       (regex over the whole JSON: no match, and no "rural" either)

what IS there: shipping_tier "free", delivery_zone "south-island", shipping_fee 0,
               shipping_address_line1/2, shipping_city, shipping_region, shipping_postal_code
```

This confirms the note already in our `errors.md`: *"Rural accuracy would need `delivery_type`
persisted at checkout (not currently stored)."* It is still true, and it now costs more than it did
this morning, because the value we send is finally a real one rather than an unconditional
`'urban'`.

**What it breaks today:**

- **Fulfilment cannot tell a rural order from an urban one.** The courier can, and charges us
  accordingly. Nothing in the order record explains the difference.
- **`delivery_zone` is not a substitute.** It answers *which island*, not *urban or rural*. The two
  rural tiers within one zone are 1.7–2x the urban ones.
- **Our profitability code reads a field that never exists.** `admin/utils/profitability.js:337`
  computes `absorbedShippingDeliveryType: … a.delivery_type ?? null`, which resolves to `null` on
  every order. That is the shape we call ERR-167 internally: when the fallback is the only branch
  that ever runs, the guard is the bug. We will leave it alone rather than delete it, because it
  becomes correct the moment you persist the column.

**Ask:** persist `delivery_type` (`'urban' | 'rural'`) on `orders` from the create payload we
already send, and return it on both the list and detail admin endpoints. Your validator already
accepts and defaults it (`Joi.string().valid('urban','rural').default('urban')`), so this is
storage and read-back, not new validation.

**Please do not backfill it as `'urban'`.** Every historical order was submitted by a form that
could not express the difference, so `'urban'` there is not a fact, it is a guess that will look
like data forever. `NULL` on old rows is the honest value and lets us tell "we did not ask" from
"they said urban".

---

## 2. Does `search_analytics` finally have a `session_id`? — the only thing that closes ERR-237

You reported 915 rows over five days with zero `session_id`. Both transports now run:

- `X-Session-Id` / `X-Visitor-Id` headers on `/api/search/smart` and `/api/search/suggest`.
  Verified on the wire in a real browser: **1 search request carrying the header, 0 of 11
  edge-cached catalogue GETs carrying it** — so identity is on the search call and nowhere it could
  fragment a shared cache entry.
- `?sid=` / `?vid=` query params, unchanged, still on the same two endpoints.

**We deliberately kept the params.** They were the only transport for six months and produced zero
session ids, which means either the backend does not read them on that route **or
`search_analytics` is written by something other than `/api/search/smart`**. Dropping a transport
to adopt an unconfirmed one would be trading a measured unknown for a hope.

**Three questions, and question (c) is the one we cannot answer from here:**

- (a) Are rows now landing with a `session_id`?
- (b) Which transport delivered it — header or param?
- (c) **What actually writes `search_analytics`?** If it is not `/api/search/smart`, then neither
  transport was ever going to reach it and we have both been looking at the wrong endpoint.

Tell us (b) and we will drop the redundant transport in the same day. Until then we carry both, and
the params remain safe only while `/api/search/smart` answers `cf-cache-status: DYNAMIC` — our
`probe:data-capture` §2 fails the moment that changes.

---

## 3. Please keep the two id headers in the allow-list — search now depends on them

Not a request for work, a request for a note in whatever you keep.

`X-Session-Id` on a GET makes it non-simple, so the browser preflights it. If those headers ever
leave `Access-Control-Allow-Headers`, **a browser does not degrade — it fails the preflight and
never sends the search at all.** That is not a lost analytics column, that is site search down for
every customer.

Our `probe:data-capture` §1 is now a hard check in both directions and will catch it, but it is a
probe someone has to run. Measured today on all three origins (apex, `www`, `localhost:3000`) with
a negative control: a bogus header name is *not* echoed back, so the allow-list is a real static
list and not a preflight agreeing with whatever it is asked.

---

## 4. `/api/search/smart` takes about 3 seconds

Measured repeatedly against `api.inkcartridges.co.nz`, warm, small result sets:

```
GET /api/search/smart?q=tn244x&limit=8   →  3.08s, 3.25s, 2.77s   (HTTP 200)
OPTIONS (the new preflight)              →  0.31s, 0.27s, 0.27s   (HTTP 204)
```

The preflight is ~9% on top of a number that is already the problem. This is the highest-volume
surface on the site — it backs the header typeahead on every page — and 3s is long enough that a
shopper types past it. We are not asking for anything specific here; we would just rather you knew
the baseline, because if it comes down, the preflight stops mattering at all.

(For contrast, on the same host: `/api/products/popular?category=ink&limit=4` and
`/api/shipping/options` both answer comfortably under a second.)

---

## 5. `/api/products/popular` — two category names

Measured, all with `&limit=4`:

| category | result |
|---|---|
| `ink`, `toner`, `ribbons`, `drums`, `paper` | 200, real rows |
| `consumable` | **400** |
| `label_tape` | **400** |
| `bogus` (control) | 400 |

`consumable` and `label_tape` are *our own internal category ids*, so passing our state straight
through 400s on those landings. We now translate with a one-line map (`consumable → drums`) and a
category absent from the map asks for nothing rather than firing a request we know will fail.

- Please confirm **`drums` is the right backend name** for the family we call `consumable` (drums,
  maintenance boxes, waste toner) — we inferred it from the 200 and want it stated.
- Is **`label_tape`** intended to have no popular route, or is it an omission? If it gains one, we
  add a single map line.

---

## 6. Still open from earlier rounds

- **BF-021 — `PATCH` is not in `Access-Control-Allow-Methods`.** Re-measured today:
  `GET,POST,PUT,DELETE,OPTIONS`. `PATCH /api/admin/quick-orders/:id/outcome` is therefore
  unreachable from a browser, and the quick-order outcome modal is built, correct and dead. The
  page shows a loud blocked state rather than pretending. One method on the allow-list retires it.
- **`quick_orders` is empty in production** (0 rows), so that modal has never had anything to act
  on. Worth knowing before you spend time on the CORS side of it.

---

## What we shipped, so you can re-run your own checks

| | before | now (measured on production) |
|---|---|---|
| `/ink-cartridges`, `/toner-cartridges`, `/ribbons` prices | 0, 0, 0 | **16, 12, 12** |
| checkout `delivery_type` checked on load | none | **exactly one, urban** |
| delivery area prices shown to the shopper | none | **Urban $7.00 / Rural $14.00**, both from your quote |
| `X-Session-Id` on `/api/search/smart` | absent (CORS) | **sent, 200** |

Reproduce with `npm run probe:landing-popular` (32 assertions),
`npm run probe:checkout-delivery` (16), and `npm run probe:data-capture` (§1 CORS, §2 edge cache).
All three are read-only and default to production.

One correction to the hand-off for the record, in case it informs the next one: the suggested fix
for the delivery gate — adding `checked` to the markup — could not have worked. `checkout-page.js`
un-checked the group as the first statement of `init()`, so the attribute was true in the file and
false in the browser. And the stated mechanism, HTML5 constraint validation reporting off-screen,
could not occur: the form carries `novalidate` and `reportValidity()` is called nowhere in it. The
gate was three hand-rolled JS checks. Both were only visible by measuring the live page rather than
reading the diff — which is exactly the standard your own file set, and it was the right call.
