# Backend response to the FE verification round

**Date:** 2026-09-10 · **From:** backend · **Re:** `printer-canonicals-backend-brief-sep2026.md`,
the ten-item index, and the four analytics-dashboard asks

Everything below is measured against production today, not restated from a
prior doc. Where a number of yours differs from ours, the difference is
explained rather than averaged.

**Shipped in this change:** §1–§7 below. **Held, needs a decision from you:**
§8 (ERR-232 grant) and §9 (migration 132), both for sequencing reasons stated
in place.

---

## §1 — 🔴 ERR-232 is not a regression, and re-running migration 163 would not fix it

You asked us to re-run migration 163. We measured the ACL and the function
bodies first, and the picture is different from the previous three recurrences.

```
                            SECURITY DEFINER   anon EXEC   authenticated EXEC   service_role EXEC
analytics_kpi_summary              yes            no             no                  yes
analytics_revenue_series           yes            no             no                  yes
analytics_refunds_series           yes            no             no                  yes
analytics_top_products             yes            no             no                  yes
analytics_customer_stats           yes            no             no                  yes
analytics_brand_breakdown          yes            no             no                  yes
get_suppliers                      yes            no             no                  yes
```

The `42501` is real and the grant is genuinely absent — but it was **revoked on
purpose on 2026-09-07**, after a plain customer account read the live P&L
(`revenue 24189.36 / gross_profit 5124.29 / aov 167.98 / total_customers 135`)
straight from PostgREST with the anon key plus its own JWT. Migration 163 does
not restore the grant; it only allowlists the event trigger that re-grants on
`CREATE`/`ALTER`. Migration **164** is the one that grants.

**What changed since, and why we are now willing to re-grant.** All six now open
with a gate that fails *closed*:

```sql
IF NOT (public.is_owner() OR auth.role() = 'service_role') THEN RETURN NULL; END IF;
```

We executed each one with `request.jwt.claims` set to (a) an ordinary customer
uid + `role: authenticated` and (b) `role: anon`. Every one returned `NULL` — no
data. At the time of the 2026-09-07 leak the guard read
`auth.uid() IS NOT NULL AND NOT is_owner()`, which *skips itself* when uid is
null, so an anon caller fell straight through. The bodies were hardened
afterwards; the ACL was never put back.

So the grant is safe **only while that gate is in the body**, and a `DROP +
CREATE` that loses it re-opens the P&L to every logged-in customer *and* the
mig-163 trigger will re-grant it automatically. That is now written into the
migration as a post-condition to re-run after any redeploy of these functions.

**Two live bugs found while measuring — both fixed in the same migration:**

1. **`analytics_brand_breakdown` is dark from the backend too.** It is the one
   of the six whose guard has no `OR auth.role() = 'service_role'` clause.
   `service_role` has no `auth.uid()`, so `is_owner()` is false and the function
   returns `NULL` — and a NULL is not an RPC error, so our wrapper serves
   `{ok: true, data: null}` with a **200**. Nobody noticed because we have no
   REST route for it; you call it directly.
2. **`get_suppliers` still carries the old fail-open guard** and returns the
   supplier list to an *anon* caller. Only the revoked ACL has been holding it
   shut. It is brought in line with its six siblings **before** being granted.

### What we shipped instead of the grant

On reflection — and after a second pair of eyes made the same point — granting
`authenticated` is about six times wider than the need, and every previous round
of ERR-010/029/035 was closed exactly that way. That is why there has been a
fourth. So the grant is split out and held, and the two things that were genuinely
broken shipped on their own:

**✅ Migration 173 (applied)** repairs both gates. No grants; nothing gains
access, and `get_suppliers` strictly loses an anonymous path it should never
have had. Verified live:

```
                              service_role   ordinary customer   anon
analytics_brand_breakdown       data           null              null     (was null to service_role too)
get_suppliers                   data           null              null     (was DATA to anon)
```

**✅ `GET /api/admin/analytics/brand-breakdown` (new)** — it was the only one of
the six without a server-side route, and that is the sole reason the dashboard
had to call any of them directly. Verified against the live database after
migration 173, not before: before it, a green route test would have been
indistinguishable from the bug.

**So all seven are now reachable through `requireAdmin` + service_role:**

| RPC | endpoint |
|---|---|
| `analytics_kpi_summary` | `GET /api/admin/analytics/kpi-summary` |
| `analytics_revenue_series` | `GET /api/admin/analytics/revenue-series` |
| `analytics_refunds_series` | `GET /api/admin/analytics/refunds-series` |
| `analytics_customer_stats` | `GET /api/admin/analytics/customer-stats` |
| `analytics_top_products` | `GET /api/admin/analytics/top-products-rpc` |
| `analytics_brand_breakdown` | `GET /api/admin/analytics/brand-breakdown` ← new |
| `get_suppliers` | `GET /api/admin/analytics/suppliers` |

**Our ask: point the dashboard at those seven and let us never apply 172.** The
browser then never needs EXECUTE on a `SECURITY DEFINER` function, and this
class of incident has nothing left to recur over. It is a change of the same
size as the one that already moved the PDP off `products.compatible_devices_html`.

`sql/migrations/172_analytics_rpc_execute_for_authenticated.sql` still exists if
you would rather not make that change — but it is defensible only because of the
fail-closed gate, that safety lives in the function BODY rather than the ACL, and
mig 163's event trigger re-grants these six automatically on any CREATE/ALTER. A
future redeploy that drops the gate would re-open the P&L with no migration diff
to show for it.

---

## §2 — 🟢 `for-use-in`: green light received, dual-write removed, migration held one deploy

Thank you for the row-by-row comparison — that is exactly the evidence the
migration's own prerequisites ask for.

Our pre-flight agrees and adds a little:

```
products.compatible_devices_html non-empty rows       94   (you measured 91)
product_compat_devices rows                           94
rows in the column but NOT in the private table        0   ← the migration's own gate
dependent views                                        0
dependent indexes                                      1   (the trgm index, dropped with the column)
```

**Shipped now:** the transitional dual-write in `PUT /admin/products/:id` is
gone (`src/routes/admin.js`). Nothing in the backend writes that column any
more, and no `products` SELECT names it.

**Migration 132 is APPLIED** (2026-09-10, after the deploy). The order was
load-bearing — prerequisite #3 is that the build with the dual-write removed
must be *live* first, or the `DROP COLUMN` lands under a build still writing to
it and **every admin product save 400s** — so we waited for the deploy and
confirmed it by preflight against the production API rather than assuming it.

Post-conditions, verified live:

```
products.compatible_devices_html                              gone
product_compat_devices rows                                   94   (all lists preserved)
stale indexes                                                  0
GET /api/products/10966.01/for-use-in                         200, renders the list
/rest/v1/products?select=sku,compatible_devices_html (anon)   400  <- the dump this closes
/rest/v1/product_compat_devices (anon)                        401
```

That 400 is the whole point of the exercise: the bulk dump that previously
returned every list to anyone holding the publishable key is now a schema error.

### On your rate-limit note — taken, and hardened

You are right that a walker hits `forUseInLimiter` (40/min/IP) and that a 429
body has no `for_use_in_html` key, so `resp.data.for_use_in_html ?? null` scores
a **refusal** as an **absence**. That is a silent false negative and it nearly
cost you a data-loss alarm.

The limit stays (the endpoint is the anti-scrape surface), but the refusal is
now as loud as HTTP allows: **429 + `ok:false` + `error.code: RATE_LIMITED` + a
`Retry-After` header**, and the error body carries an explicit hint that a
missing key must not be read as "no data". Any walker should check the status,
never just the key.

---

## §3 — §7 duplicate printer URLs: your 15 are right, and we can now show why our 21 was not

Both halves you asked for are shipped: the prerenderer emits the winner's
canonical for both twins, and `sitemap-printers.xml` lists winners only.

### Why 21, and why 15 was the safer answer

Your grouping rule and ours were the same — *same brand, slugs identical after
stripping every non-alphanumeric character*. Run against `printer_models`
directly it yields **21 groups**. You saw 15 because five of the extra six
differ by a trailing `+`, which `encodeURIComponent` writes into the sitemap as
`%2B`; normalising the URL string rather than the slug leaves `…k32b`, so those
five never grouped for you.

**That accident saved a page.** The six we could see and you could not are:

```
epson-300                 vs epson-300+                  ← LQ-300 and LQ-300+ are different printers
epson-1600k3              vs epson-1600k3+
epson-1900k2              vs epson-1900k2+
hp-color-laserjet-m880z   vs hp-color-laserjet-m880z+    ← M880z and M880z+ are different SKUs
hp-colour-laserjet-m880z  vs hp-colour-laserjet-m880z+
printronix-103.23         vs printronix-103.23.          ← a genuine duplicate you could not see
```

The `+` is part of the model name. Canonicalising those five is your
`brother-dcp-130c` / `brother-dcp-135c` objection with a different character:
it does not consolidate a duplicate, it deletes a working page.

### The rule we shipped

**Two slugs are the same machine when they differ only in SEPARATORS** — hyphen,
underscore, space — **plus a trailing full stop**, which is a data-entry
artefact. `+` is preserved.

That rule, run live, produces **16 groups**: your 15 exactly, plus the
Printronix pair. Every one has identical compat-link counts on both sides,
which is the check that they really are twins:

```
✓ brother-hl-l3230cdw            ← brother-hll-3230cdw              (11 links each)
✓ epson-ecotank-et-2850          ← epson-ec-otank-et-2850           (13)
✓ fuji-xerox-apeosport-vii-c3321 ← fuji-xerox-apeosport---vii-c3321 (5)
✓ fuji-xerox-apeosport-vii-c4421 ← fuji-xerox-apeosport---vii-c4421 (5)
✓ fuji-xerox-docuprint-c1190-fs  ← fuji-xerox-docuprint-c1190fs     (3)
✓ fuji-xerox-docuprint-cm505-da  ← fuji-xerox-docuprint-cm505da     (13)
✓ hp-laserjet-enterprise-m651    ← hp-laser-jet-enterprise-m651     (6)
✓ hp-smart-tank-300/400/6000/7000/7300/7600 ← hp-smarttank-…        (4 each)
✓ oki-mc362dn                    ← oki-mc-362dn                     (14)
✓ oki-ml182                      ← oki-ml-182                       (3)
✓ printronix-103.23              ← printronix-103.23.               (8)   ← the 16th
```

**Please add the Printronix pair to `PrinterSlug` on your side** so the internal
links and the SPA canonical agree with the prerender and the sitemap.

One caveat on that pair specifically: **neither Printronix slug can be
sitemapped at all** — the sitemap's slug-shape gate rejects the `.`, so both
have always been excluded. Verified after the change: 15 of the 16 winners are
in the sitemap, 0 losers remain, and the Printronix pair is prerender-only. Its
real fix is renaming the slug (a `slug_redirects` hop), which we can do on
request; the canonical is doing what it can in the meantime.

### Winners are your table, kept as a curated map

We use your winners verbatim, because no mechanical rule reproduces them: HP
writes "Smart Tank" (the *more*-hyphenated slug wins) while OKI writes
"MC362dn" (the *less*-hyphenated one does). Both directions are pinned in
`__tests__/printer-canonical.test.js` precisely so nobody later "simplifies" the
table into a heuristic.

Group **discovery** is live from `printer_models`, not from the table — so a
17th pair from the feed is picked up automatically, gets a deterministic winner
(one URL advertised, never two) and is flagged for a human to confirm the
spelling. `npm run audit:printer-canonicals` is the mirror of your
`probe:printer-canonicals`; it also prints the five refusals above so the
refusal stays visible rather than looking like an oversight.

### What changed on the wire

- `/api/prerender/printer/:brand/:slug` — `<link rel="canonical">`, `og:url`,
  `hreflang`, the CollectionPage `url`, the BreadcrumbList leaf and the FAQPage
  `@id` all name the **winner**, on both twins.
- **The related-printers list is canonicalised too, and the twin is dropped from
  it.** The winner's page was linking to its own duplicate under "Other HP
  Smart Tank Printers" — the same machine listed as a related one, which is both
  wrong content and an internal link to the URL we had just told Google not to
  index. Verified after the change: requesting either twin of the HP and OKI
  pairs yields **zero** references to the loser URL anywhere in the served HTML.
- `sitemap-printers.xml` — the loser is dropped, but **only when its winner is
  actually in the sitemap**. Dropping a loser whose winner has no compat links
  would retire the page rather than consolidate it.
- Nothing else moves: the loser slug keeps working and keeps returning the same
  products. Only the URL we *advertise* changed.

Measured after the change: `sitemap-printers.xml` went 4,133 → **4,118** URLs
(15 losers dropped; the 16th pair was already shape-excluded), 0 losers remain,
and every winner that can be sitemapped is.

### §8, the purge

Agreed, no-op. Your `cf-cache-status: DYNAMIC` measurement matches ours; there
is nothing pinned to purge, so the canonical change is visible on deploy.

---

## §4 — `meta.coverage.clicks`: you were right, and the fix is not a corrected constant

Our note advertised an 80-character truncation. You raised it to 200 on
2026-09-03 (ERR-204), so we were reporting a defect you had already fixed, and
it cost you a round trip. Measured today:

```
product-link clicks BEFORE 2026-09-03 : 744 total, 489 resolved (65.7%), 481 clipped at exactly 80
product-link clicks SINCE  2026-09-03 : 179 total, 179 resolved (100%),  longest element 104 chars
```

So: 100% resolution since the fix, and nothing is anywhere near the 200 ceiling.

Rather than correcting the number, the note is now **measured over the range you
requested** — it reports the actual resolved/total for that window and says
`Complete.` or `Partial.` accordingly. It still explains that ranges reaching
back before 2026-09-03 under-count, because they genuinely do. A note that
cannot go stale is the fix; a corrected constant would only defer this.

---

## §5 — the four analytics-dashboard asks, all four shipped

**1. The limiter advertised 30 and 429'd at 21 with `limit: 20`.** Both numbers
were real and neither belonged to the endpoint you called. `adminAnalytics.js`
applies its own 20/min limiter with a router-level `router.use()`, which fires
on the **path prefix** `/api/admin/analytics` — so every catalogue and
acquisition request was spending a token in a router that does not own the
route, then falling through to the 30/min limiter that does. The two specific
routers are now mounted **before** it, so a matched request never reaches that
prefix. You get the advertised 30.

**2. `offshore_bounce_views_excluded` missing from `/catalog/brands`.** The RPC
never returned it (the products one has carried it since mig 162), so the route
had nothing to emit — the scraper filter was silent on exactly the board where a
scraper first showed up. Added in migration 170. It counts brand-hub pageviews
as well as product pageviews, so it is legitimately **larger** than the products
figure over the same range: 136 vs 71 over the last 60 days.

**3. `paid_*` emitting `0` rather than `null` on `/acquisition/search-terms`.**
Fixed, and symmetrically: `paid_*` is null while Google Ads is unconnected,
`organic_*` is null while Search Console is unconnected, and a connected feed
reporting a genuine zero still reports `0`. `total_clicks` stays a real number —
it is first-party. `meta.sources` was already telling the reader which feeds
were live; the row values now agree with it.

**4. Four decoy params on `/catalog/products`.** `product_type`, `sort`,
`offset` and `search` were accepted and dropped by `validate()`'s
`stripUnknown`, so the endpoint answered page 1 with a 200 however you paged it.
All four now reach SQL (migration 170):

- `offset` — 0…100000, paged in SQL. `meta.limit`, `meta.offset` and
  `meta.has_more` are echoed so a pager can stop.
- `sort` — `engagement` (default) | `views` | `clicks` | `units_sold` |
  `revenue`. Allowlisted in a `CASE`, never dynamic SQL. Every branch keeps the
  same deterministic tie-break, so a paged walk can neither repeat nor skip a
  row.
- `search` — matches SKU or name, `%` and `_` escaped to literals.
- `product_type` — a **real `products.product_type`** value (`toner_cartridge`,
  not `toner`). A category slug now 400s with the accepted list rather than
  returning a silent empty leaderboard.

Filters apply **before** ranking, so `total_products_engaged` is the count of the
filtered set and the pager divides by the right number.

---

## §6 — `/api/products/popular`: aliases accepted

`consumable` and `label_tape` both 400'd at the Joi validator even though
`normalizeCategorySlug()` understood them perfectly well — a hand-kept enum that
had drifted from the taxonomy. The accepted set is now **derived** from the
taxonomy, so it cannot drift again. Now accepted:

| you send | resolves to |
|---|---|
| `consumable`, `cartridge` | all consumable types (documented retirement) |
| `label_tape`, `label-tape` | `label` → `['label_tape']` |
| `photo_paper`, `photo-paper` | `paper` → `['photo_paper']` |
| `ink-cartridges`, `toner-cartridges`, `drum-units` | `ink` / `toner` / `drums` |

Still rejected, on purpose: `printer`, `laser`, `inkjet`. Those filter on the
`category` column rather than `product_type` and have their own routes; a
consumables row must keep refusing them.

You can drop your client-side mapping whenever suits.

---

## §7 — BF-021: `PATCH` was missing, and it was hiding more than the quick-order modal

Confirmed and fixed. `Access-Control-Allow-Methods` is now
`GET, POST, PUT, PATCH, DELETE, OPTIONS`.

Worth knowing: this was not one endpoint. **Three** live PATCH routes have been
unreachable from any browser for as long as they have existed —

```
PATCH /api/admin/quick-orders/:id/outcome     ← your BF-021
PATCH /api/admin/invoices/:id/status
PATCH /api/admin/business/accounts/:id
```

Same failure shape as the `X-Session-Id` header sitting right below it in
`server.js` — which you fixed on 2026-09-08 and which is why the `methods` line
was the *only* half still broken. A method absent from that list is one the
**browser** refuses to send, the preflight still answers 204 without echoing it,
and every curl and server-side test passes while the real UI is dead. Twice now,
so it is no longer left to memory: `__tests__/cors-analytics-identity-headers.test.js`
scans every `router.<verb>(` under `src/routes/` and fails until `methods`
carries it.

(Noted separately that `quick_orders` is empty in production — the CORS half was
still worth fixing, but there is nothing to exercise it against yet.)

---

## §8 — ERR-237, and the one item we are not taking

**ERR-237 — answered, and the six months of nothing had TWO independent causes.**

Yes, rows carry a `session_id` now, and the switch-on is clean:

```
2026-09-05   141 rows    0 with session_id
2026-09-06   233          0
2026-09-07   312          0
2026-09-08    99          0     ← the Access-Control-Allow-Headers deploy lands (393ae6c)
2026-09-09   176         75     (44 distinct sessions)
2026-09-10    23         15
```

**Transport: the `X-Session-Id` header, exclusively.** `?sid=` has never
delivered a single row and could not have — that half was broken
*independently* of CORS. `readVisitorIdentity()` reads
`header → ?sid → body.session_id`, but `validate(smartSearchSchema, 'query')`
runs first with `stripUnknown`, and the schema never listed `sid`/`vid`, so both
keys were deleted from `req.query` before the handler ever looked. Two separate
faults, one on each transport, presenting as one symptom. The query-param path
is fixed in this round too (schemas now list them), so `?sid=` will work from
the next deploy — but everything you are seeing today arrived by header.

**The 21-pair table you asked us to send** — superseded. The six you could not
see are enumerated in §3 above with the reason five of them must stay
un-merged, so there is no list left to send.

---

## Verification

```
npm test                                   # 398 suites / 6080 tests
npm run audit:printer-canonicals           # 16 groups, all curated, 5 refusals shown
npx jest __tests__/printer-canonical.test.js
npx jest __tests__/catalog-engagement-analytics.test.js
npx jest __tests__/acquisition-search-terms-null-vs-zero.test.js
```

Migrations applied: **170** (catalogue pagination + brand offshore key), **171** (order `delivery_type`), **132** (legacy column dropped), **173** (analytics gate repair).
Migration written and deliberately NOT applied: **172** (the `authenticated`
grant). We are recommending it never be applied — see §1.
