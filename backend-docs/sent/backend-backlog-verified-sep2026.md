# The open backlog, re-measured — one page instead of thirty documents

**From:** frontend · **Date:** 2026-09-16
**Replaces:** the "still open from earlier rounds" line in `BACKEND-ASKS-INDEX-sep2026.md`,
which named two items out of twenty-six.

Thirty documents in our outbox carry `BF-` asks with no reply on record, some since July.
Nobody could say how many were still real — **including us**. This is that list, measured
rather than remembered.

**Every row carries the date it was measured.** Rows marked 2026-09-16 were measured today.
Rows carrying an older date are stated in the past tense on purpose: a claim about broken code
goes stale between being written and being read, and a dispute left in the present tense
outlives the thing it disputed. Rows marked **NOT MEASURED** are named as such — a skip is not
a pass.

**Nothing here is sourced from our own tracker.** Our log turned out to be wrong in three
different ways (§4), which is the reason this document exists at all.

---

## 1. Closed — stop being asked for these

**This section comes first deliberately.** A backlog that re-asks for completed work stops
being read, and two of these were still marked open on our side this morning.

| BF | The ask | Verdict | The measurement, today |
|---|---|---|---|
| **BF-045** 🔴 | `products.cost_price` readable with the public anon key | **CLOSED** | `cost_price` **401**, `profit_ex_gst` **401**, `margin_pct` **401** to the anon key. **Positive control:** `retail_price` on the same table, same key → **200**. That control is the point — without it, three 401s are equally consistent with "the revoke landed" and "the table is gone". All three columns had to go: each recovers the cost from the others. |
| **BF-054** | `GET /api/ribbons?ribbon_brand=<slug>` | **CLOSED** | → **200** with ribbons. Shipped; never recorded on our side. |
| **BF-057** | `/api/search/smart` ranked every value pack below every single | **CLOSED** | You answered this in `search-value-pack-ranking-backend-response-sep2026.md` and we verified P1/P2/P3a/P3b. Listed only because our log still shows the number as `reserved`. |
| **BF-010** | no way to delete a test order — owner hard purge | **CLOSED** | Resolved 2026-07-30. |

---

## 2. Open, reproduced today (2026-09-16)

| BF | The ask | The measurement |
|---|---|---|
| **BF-020** 🔴 | a per-user endpoint edge-cached as public — `/api/products/:sku/waitlist/status` | **Open, and our own description of it was wrong — see §4.3.** Anon `401`/`MISS`, then the same URL **carrying a valid bearer token** → `401`/**`HIT`**, body `"Missing authorization header"`. The edge answered a signed-in request from the anonymous cache entry; `vary` is `Origin, Accept-Encoding` and does not include `Authorization`. |
| **BF-011 / BF-012** | a bearer token does not change the edge cache key | **Open.** `/api/products?page=1&limit=1` returns a byte-identical body with and without a super-admin token, `cf-cache-status: HIT` both times. BF-012 is answered by that: the catalogue response does **not** vary by identity, so the shared cache entry is correct there — it is only wrong on the per-user route above. |
| **BF-014** | `/api/site/*` documented as edge-cached, `DYNAMIC` on every request | **Open.** `/api/site/nav` — `public, max-age=3600`, still `DYNAMIC`. |
| **BF-019** (cache) | public catalog endpoints never edge-cached | **Open, and it moved halfway.** `/api/ribbons` and `/api/printers/trending` were `no-store`; by 2026-09-12 the **origin** turned cacheable (`s-maxage=300`) but the Cache Rule still does not match them, so both remain `DYNAMIC`. `search.js` fetches `trending` on every page load, so this is one origin hit per page. **See §4.2 — `BF-019` is two different asks.** |
| **BF-031** | `/api/search/suggest` returns compatibility rows without `match_reason` | **Open.** 10 suggestions across `HL-2130` and `DCP-J140W`; no `match_reason` on any. Keys returned: `category, id, image_*, is_genuine, name, price, sku, slug, stock_quantity`. Without it the row cannot be labelled, so we render it unlabelled rather than assert a compatibility we were not told (ERR-135). |
| **BF-039** | `/api/color-packs/config` returns 404 | **Open.** → **404** `NOT_FOUND`. |
| **BF-044** | `/api/admin/products` missing the filters and fields that force the Products page onto direct Supabase | **Open, with a changed cause.** The shipped select still fails as a signed-in admin — now `403 42501 permission denied for table products` on `cost_price`. (On 2026-09-10 it was failing on `compatible_devices_html` `42703` instead; ERR-244 removed that dead name, revealing the original 403 underneath.) And **`/api/admin/products` still returns no pagination block** — the envelope carries only `[products]`, while the real figure for that filter is **3,399**. |
| **BF-056** | `/api/shop`'s `counts` facet omits `maintenance_box` from `drums` | **Open, reproduces exactly.** `?brand=epson&category=drums` → `meta.total: 5`, every row `product_type: maintenance_box`. The **same response's** `counts` facet has no `drums` key at all (`ink, paper, ribbon`). An absent key hides a stocked category — the shopper is told Epson has no drums while the filter serves five. |
| **BF-063** 🔴 | `PUT /api/admin/orders/:id/shipping` accepts an empty `ticket_product_code` for a carrier that requires one | **New, and it cost us a live order — see §3.** |

---

## 3. BF-063 — the one that did damage

```
PUT /api/admin/orders/:id/shipping
    {"carrier":"nz_couriers","tracking_number":"16025241","ticket_product_code":""}
 -> 200, applied      (previously: 400 TICKET_PRODUCT_CODE_REQUIRED / VALIDATION_FAILED)
```

The other three invalid cases in the same loop — unknown carrier, `http://` tracking URL, both
number spellings — still refuse correctly. **One rule stopped firing, not a layer.**

Why it mattered more than a normal contract drift: our shipping probe proves the *refusal*
contract, and sends those payloads precisely **because** they were rejected before any write.
When this rule stopped firing, a probe labelled READ-ONLY wrote to order `2026090902` and left it
with a carrier that requires a product code and no product code. **Our side is fixed** — the probe
now restores and verifies — **but that is our compensation for the change, not a reason the
contract should stay changed.**

The resulting state is arguably one the API should refuse to represent: `carrier: NZ Couriers` +
`requires_product_code: true` + `ticket_product_code: null` is a shipped order whose tracking
nobody can resolve.

**Three asks.** (1) Restore the 400. (2) Tell us whether this was deliberate — if the field is
genuinely optional now, then `requires_product_code` in your registry is the thing that is wrong,
and we should stop marking the input required. (3) Say whether any other `requires_*` registry
rule stopped being enforced at the same time. **We only test this one**, so we cannot tell you.

---

## 4. Three corrections to our own record

Each of these is a defect in **our** tracker, not yours. They are here because they change what
our asks mean.

### 4.1 Closed and never ticked off
BF-045 and BF-054 were done and still sat in our log as open. If a backlog re-asks for finished
work, the next one gets skimmed. §1 exists to stop that.

### 4.2 🚨 `BF-019` is two different asks
Our log uses the number twice, for unrelated things:

- **BF-019 (loyalty)** — retro-claim signal, per-order points, guest invoice CTA tab.
- **BF-019 (cache)** — public catalog endpoints marked `private, no-store`, never edge-cached.

**A bare `BF-019` is ambiguous in both directions.** Please cite it with the word `loyalty` or
`cache`. This is the same trap as our `ERR-113…123` range, which we also never renumbered — history
is not renumbered here, because code comments cite these numbers and renumbering rots them silently.

### 4.3 Our own description of BF-020 was wrong, in the dangerous direction
Our log calls it "a PER-USER endpoint is being edge-cached as public", which reads as a
cross-user data leak. **It is not one, and we checked rather than assumed.** On a *cold* URL an
authenticated request returns `cf-cache-status: BYPASS` — authenticated responses are never
stored, so no user's data is served to another. What actually happens is the reverse: a cached
**anonymous 401** is served to signed-in users, who then see *"Missing authorization header"*
while sending one. **Broken feature, not a leak.** The negative control — asking a cold URL first
— is the only thing that separated those two readings, and they call for different fixes.

### 4.4 BF-053, BF-054, BF-055 are cited in your hand-offs and absent from our log
They exist in our documents and in yours. They have no entry on our side. Noted so the gap is
visible rather than inherited.

---

## 5. Not measured — named, not quietly dropped

These could not be settled read-only, and **we will not run a write against production to find
out** — that is exactly what produced §3. They are open as far as we know, and that is a weaker
claim than every row above.

| BF | Why not |
|---|---|
| BF-024, BF-041 | hard-purge contract gaps; no product-delete route. Both need a destructive write to settle. Route-existence only. |
| BF-013, BF-040 | need a payload shape we cannot provoke read-only (an uncached admin product route; `source` on a customer order line). |
| BF-021 | `PATCH` missing from `Access-Control-Allow-Methods`. **`curl` cannot adjudicate this** — a preflight 204s whatever you ask (ERR-223) — so it needs a real browser, which we have not run since raising it. Standing ask since August; the quick-order outcome modal is built, correct and unreachable. |
| BF-018 | `/api/schema/*` caching and the 5-minute 404 cache. `/api/schema/site` reads `DYNAMIC`/not-cacheable today, which matches our probe's current expectation — but the 404-caching half is unmeasured. |
| BF-027, BF-028, BF-042 | `detectYieldTier` trailing-`H`; `fax_film` mapping; two retyped `maintenance_box` products. `npm run audit:types` was **clean on 2026-09-10** — 15 types, every live type offered and labelled, `fax_film` (5) and `fax_film_refill` (2) both serving rows. That is good evidence the *mapping* half is done and **no evidence at all** about the specific SKUs in BF-042. |
| BF-043, BF-046, BF-049 | per-line invoice volume discount; `?customer_email=` matching nothing; `shipping_information` reporting "NZ Post" on orders whose `carrier` is NULL. BF-046 last measured **2026-09-10**: `?search=` works (7 checks passed) but `customer_email=<full address>` still returned **0 rows**, so the ask stands. |
| BF-019 (loyalty), BF-053, BF-055 | not re-measured this round. |

---

## 6. How to read this next time

Every row above is re-runnable: `npm run audit:edge-cache`, `npm run probe:admin-products`,
`npm run audit:types`, `npm run probe:orders-search` — all read-only, all print their mode.
The direct checks in §1 and §2 are plain `GET`s against production with a positive control
beside each one.

**If a row here disagrees with something you measure, measure again and tell us** — we have been
wrong in both directions this month, and the two cases in §4.1 and §4.3 were both found by
re-measuring something we already "knew".
