# Look-alike duplicate rows — FE response (Sep 2026)

**Replies to:** `lookalike-duplicate-rows-FE-handoff-aug2026.md` (backend `d618b23`)
**Measured:** 2026-09-01, live production, 4,086 active rows
**FE side:** ERR-195 · `npm run probe:lookalike` · `tests/lookalike-duplicate-rows-sep2026.test.js`

---

## TL;DR

The §3 hazard checks you asked for both came back **clean** — nothing on the frontend
persists a SKU string, and no shipped code hardcodes an affected SKU.

The §1 purge turned out **not to be needed**: the paths listed are not edge-cached at all.
Measured below.

But §7 does not hold. **The reported page still had two indistinguishable cards on it
this morning**, and the duplicate had simply moved from the two blacks to the two CMY
3-packs. We deactivated one row to clear the customer-facing symptom; the rest of §4a/§4b
is still open and is listed below with reproduction commands for each.

| | Claim | Measured |
|---|---|---|
| §1 | `s-maxage=86400` pins stale SPA HTML for 24h | **No.** `max-age=0, must-revalidate`, `cf-cache-status: DYNAMIC` |
| §2 | "the importer is guarded so it cannot recur" | **Recurred.** A duplicate row was created at 14:26 on repair day |
| §3 | FE may persist SKUs — please check | **Clean.** Nothing persists a SKU as identity |
| §4a | 3 renames redirected, 1 deliberately not | **1 of 3** redirected; `CBCI6KCMY` still resolves to itself |
| §4b | 5 packs deactivated, all with redirects | **0 of 5** redirect; 2 of 5 still appear in `/api/products` |
| §7 | identical-name / shared-slug scans return zero | **Each returned one group** |

Everything below is reproducible with public URLs and no credentials.

---

## 1. The reported page still had the reported bug

`/shop?brand=canon&category=ink&code=CI3`, 2026-09-01 morning:

```
CBCI3CMY  $14.99  CMY  value_pack  BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack
CBCI6CMY  $14.99  CMY  value_pack  BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack
```

Byte-identical **name, slug, colour, price and pack type**. Two different `id`s, both
active, both purchasable, both rendering as cards on the page the customer complained
about. This is the same defect, one family over.

```bash
curl -s "https://ink-backend-zaeq.onrender.com/api/shop?brand=canon&category=ink&code=CI3&limit=200"
```

### The importer guard did not hold

`CBCI6CMY` — the row §4a says was *renamed away* — has:

```
id          aa6ccefc-f848-47a2-9bc2-f436010f7a87
created_at  2026-08-31T14:26:23.840668Z     ← inside the repair window
meta_title  null
pack_savings_vs_singles  (absent — it resolves ZERO constituents)
```

`CBCI3CMY` is the original (`created_at 2026-03-11`), has its `meta_title`, and resolves
its constituents. So the shape is: the original was renamed onto `CBCI3CMY`, and then a
fresh `CBCI6CMY` was minted from the feed — carrying the *new* name, because the family
harmoniser gave it the same one. The "re-anchored so they resolve against their
constituents again" fix in §4a landed on the surviving row and the new row got none of it.

**This is the highest-value thing to fix.** Everything else here is cleanup; this one
regenerates nightly.

### What we did about it

Deactivated `CBCI6CMY` (`PUT /api/admin/products/aa6ccefc-… {"is_active": false}`).
`CBCI3CMY` untouched. The reported page now returns 10 rows with exactly one CMY 3-pack.

The backend recorded this as `manual_overrides: {"is_active": true}`, which we read as the
importer being told to leave it alone — please confirm that is what that flag means,
because it is the only thing standing between this and a nightly recurrence.

**We did not merge, delete, or touch any other row.** Which of two look-alike rows is
*correct* needs the supplier feed, so it is yours; the storefront never merges rows on a
guess.

---

## 2. A finding you can use: a live row beats its own `sku_redirects` entry

§3 explains that you deliberately did not write `CBCI3BK → CBCI6BK` because "the backend
consults `sku_redirects` before it tries a direct SKU match, so such a row would 301 every
request for the live `CBCI3BK` product onto the wrong cartridge."

We observed the opposite precedence, by accident:

```
BEFORE deactivating CBCI6CMY:  GET /api/products/CBCI6CMY → 200, sku=CBCI6CMY,
                                    canonical_url ending /CBCI6CMY
AFTER  deactivating CBCI6CMY:  GET /api/products/CBCI6CMY → 301 → /api/products/CBCI3CMY
```

Nothing changed but `is_active`. So either the direct match wins over the redirect, or a
redirect is only consulted for an inactive row. Either way the redirect row for
`CBCI6CMY` **already existed** and was being shadowed.

Two consequences:

1. **The five §4b SKUs returning `200` with themselves are not deactivated.** They are
   live rows shadowing their own redirects — which also explains why `CBCI3BK-2` (a real
   deletion) 301s correctly while the others do not.
2. **The §3 reasoning may be safe to revisit.** If a live row wins, a
   `CBCI3BK → CBCI6BK` redirect would have been inert rather than harmful. We are *not*
   asking you to add it — your current state is correct either way — only flagging that
   the stated reason does not match the observed behaviour. Please adjudicate; we only
   have the one observation.

---

## 3. Redirect manifest — measured, one line per §4a/§4b claim

`npm run probe:lookalike` checks every one of these on each run.

| SKU | §4a/§4b says | Measured (2026-09-01, after our deactivation) |
|---|---|---|
| `CBCI3BK-2` → `CBCI3BK` | redirect | ✅ 301 |
| `CBCI6CMY` → `CBCI3CMY` | redirect | ✅ 301 — **but only after we deactivated it** |
| `CBCI6KCMY` → `CBCI3KCMY` | redirect | ❌ 200, `sku=CBCI6KCMY`, canonical → itself |
| `CT073CMY` → `C73NCMY` | deactivated + redirect | ❌ 200, canonical → itself |
| `CT081CMY` → `C81NCMY` | deactivated + redirect | ❌ 200, canonical → itself |
| `CT081KCMY` → `C81NKCMY` | deactivated + redirect | ❌ 200, canonical → itself |
| `CIS365CMY` → `CCLT406SCMY` | deactivated + redirect | ❌ 200, canonical → itself |
| `CIS365KCMY` → `CCLT406SKCMY` | deactivated + redirect | ❌ 200, canonical → itself |
| `CBCI3BK` | deliberately NOT redirected | ✅ 200, live, no redirect — correct |

A row returning `200` with `canonical_url` pointing at **itself** is a self-canonicalising
duplicate: Google keeps both URLs indexed and splits their signals, which is the outcome
the redirects were meant to prevent.

### `CBCI6KCMY` is a second live look-alike pair

§4a lists this as a rename, but both SKUs exist as separate active rows:

```
CBCI3KCMY  $20.49  KCMY  BCI3KCMY Compatible Ink Cartridge for Canon BCI3 BCI6 KCMY 4-Pack
CBCI6KCMY  $20.49  KCMY  BCI6KCMY Compatible Ink Cartridge for Canon BCI6 KCMY 4-Pack
```

Same price, same colour, same pack — the names differ by one token. Our detector correctly
leaves these alone (a shopper *can* read the difference), so we have not touched them. But
if these are one cartridge, this is the same defect as the CMY pair, one row short of
being invisible.

---

## 4. `/api/products` and `/api/shop` disagree about two rows

`CT081CMY` and `CT081KCMY` are returned by `/api/products` — which
`probe-catalogue-pathway.mjs` documents as active-only — but do **not** appear on
`/api/shop?brand=epson&category=ink&code=81N`, which lists their claimed survivors
`C81NCMY` / `C81NKCMY` instead.

So each is either an active product no shopper can reach, or an inactive one leaking into
a public list. **The frontend reads both endpoints** (`/api/products` backs the search
soft-miss union, ERR-045), so the two answers have to agree or a superseded row can surface
in search while being absent from the grid.

---

## 5. §1 — the purge is not needed, and here is the measurement

Every path in your §1 list, fetched with GET (never HEAD — a HEAD probe made us report a
fake cache regression once, ERR-159):

```
/                                          cache-control: public, max-age=0, must-revalidate   cf-cache-status: DYNAMIC
/shop                                      cache-control: public, max-age=0, must-revalidate   cf-cache-status: DYNAMIC
/shop?brand=canon&category=ink&code=CI3     cache-control: public, max-age=0, must-revalidate   cf-cache-status: DYNAMIC
/products/<slug>/CBCI3CMY                  cache-control: public, max-age=0, must-revalidate   cf-cache-status: DYNAMIC
/ink-cartridges                            cache-control: public, max-age=0, must-revalidate   cf-cache-status: DYNAMIC
/toner-cartridges                          cache-control: public, max-age=0, must-revalidate   cf-cache-status: DYNAMIC
```

There is no `s-maxage=86400` on any of them and Cloudflare is not storing them. There was
nothing to purge, and no shopper was ever going to see a stale card for 24h — the SPA
shell carries **no product names at all**; it fetches them from the API at runtime.

The one surface that *is* cached is the bot prerender:

```
GET /products/<slug>/CBCI3CMY   (Googlebot UA)
  x-prerendered: true
  cache-control: public, s-maxage=3600, max-age=3600, stale-while-revalidate=86400
```

`s-maxage` is **3600, not 86400** — one hour of freshness, with up to 24h of
stale-while-revalidate. It had already picked up our deactivation when we checked minutes
later, so it self-heals.

One small thing while we were in there: the deactivated `…/CBCI6CMY` URL now prerenders as
the **Canon brand page** — `HTTP 200`, `<title>Canon NZ — …`, `canonical → /shop?brand=canon`,
`robots: index, follow`. The canonical consolidates correctly, so this is not urgent, but a
dead product URL answering `200 index,follow` is a soft-404. A 301 to the survivor would be
tidier, and you already have the `sku_redirects` row for it.

---

## 6. §3 — both hazard checks, done

**No hardcoded affected SKU in shipped code.** Every occurrence repo-wide is a test
fixture (`canon-bci-to-ci-rename-may2026`, `search-results-parity-may2026`,
`compatible-products-recovery`), and each pairs `CBCI3BK` with the name
`BCI3BK … for Canon BCI3 Black` — which is what `CBCI3BK` now *is*. The fixtures were
written against the correct pairing all along and are now true rather than aspirational.

**Nothing client-side persists a product by SKU string.** We audited every
`localStorage` / `sessionStorage` writer on the storefront:

| Store | Keyed on | Verdict |
|---|---|---|
| `inkcartridges_cart` (guest cart) | `product_id`; re-pushed via `API.addToCart(item.id, …)` | safe — `sku` is a display snapshot the server response overwrites |
| `inkcartridges_cart_pending_ops` | `product_id` + composite line key | safe |
| Favourites (guest) | **in-memory only**, synced by `product_id` | safe |
| `quote_draft` | `sessionStorage`, form fields | safe |
| `ic_seo_pr_v1:` prerender cache | `sessionStorage`, 1h TTL, keyed by path | safe |
| `lastOrder`, `checkoutData` | historical snapshots, read-path only | safe — correctly frozen |

Your server-side list (`user_favourites`, `promotions.product_skus`, `cart_items`,
`order_items`) matches what we see from this side.

---

## 7. What the frontend now does about this class of defect (ERR-195)

Independent of any single row. When two cards in the same grid would render
**indistinguishably** — same cleaned title, price, colour and pack type — the storefront
prints the SKU on those cards, and only those cards.

- **It never hides a row.** Deciding two database rows are the same product is an identity
  assertion the frontend cannot make; the row we hid would be the one the customer wanted.
  Both stay, and the shopper gets the one fact that separates them.
- **It is rare by construction.** Across all 4,086 active rows it marked exactly 2. If it
  ever marks many, the signal is worth having.
- **The key is what is rendered**, via the shipped `ProductName.clean` — the display
  de-doubler can create a collision the raw `name` column does not have.

`npm run probe:lookalike` re-runs your three §7 scans plus the rendered-card scan, the
redirect manifest above, and the endpoint-disagreement check, against live production.
Read-only, no credentials, no `--record`, exits non-zero on a finding.

**Today it exits 1, on the items in §3 and §4 of this document.** When those are closed it
goes green, and that green run is the evidence for "there are no look-alike duplicate rows",
which nothing else currently produces.

---

## 8. Your §6 backlog — two items are not FE-neutral

**§6.1 (Canon BCI printer compatibility is a union blob) — agreed, and it is now worse.**
Splitting the rows made it customer-visible: the BCI-6 black now shows on S400/i550 pages
that take the BCI-3e, as its own distinct product rather than hidden inside a merged row.
The frontend renders backend compatibility verbatim and deliberately never asserts
compatibility itself (ERR-135), so we cannot mitigate this one. Ranking it your top
follow-up matches what we see.

**§6.4 (9 `DC*` rows marked `source='genuine'` reading "Dymo Genuine ZDY99019…") — please
raise the priority.** The storefront's brand-source vocabulary is tri-state and takes
`source` from the backend as authoritative: known-genuine paints a GENUINE badge,
known-compatible paints COMPATIBLE, unknown paints **nothing**. It deliberately never
infers source from a name (ERR-157), so it cannot detect that "ZDY" is third-party — it
just prints GENUINE. Those 9 rows are being badged as genuine on the storefront right now.
Alongside the Merchant Center misrepresentation risk, that is a consumer-facing accuracy
claim, and setting `source` correctly (or to unknown) fixes it everywhere at once.

**§6.2 and §6.3** — no FE impact, agreed, nothing needed from us.

---

## 9. One more, minor: `CDR233CLKCMY` missed the §4c grammar

```
CDR233CLCMY   DR233CLCMY Compatible Drum Unit for Brother DR233CL CMY 3-Pack
CDR233CLKCMY  DR233CL    Compatible Drum Unit for Brother DR233CL 4-Pack     ← no KCMY token
```

Its siblings all got the compact `<code><colour>` lead token; this one got the bare series
code. Not customer-breaking — the "4-Pack" still distinguishes it — but it is off the
grammar the other 20 rows now follow.

Otherwise §4c looks good from here: all 21 renamed drums scan clean, and the two split
Canon blacks (`CBCI3BK` $5.99 / `CBCI6BK` $5.49) are correctly distinct on both the `CI3`
and `CI6` chips. Nice fix — that was the harder half.
