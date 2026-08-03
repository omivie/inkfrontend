# Tri-colour catalogue — backend tasks + FE response (Aug 2026)

**From:** frontend (inkcartridges.co.nz storefront)
**Re:** `tricolour-catalogue-corrections-FE-handoff-aug2026.md`
**Date:** 2026-08-03
**FE status:** verified and shipped. See §1 for the three asks, §2 for what actually changed,
§3 for eleven data defects the handoff missed.

> **For the backend CLI agent:** §3 is the work. Each task states the SKU, the exact stored values
> as of the sweep, the exact target values, the reason, and an acceptance check. Do not infer intent
> from the prose — the tables are authoritative. Verify every change by re-running
> `npm run audit:colours` from the frontend repo (§5); the affected entries must move from *known*
> to *RESOLVED*.

---

## 1. The three asks, answered

### 1.1 "Purge cache / CDN for the affected surfaces" — no frontend action exists

There is no frontend cache to purge for a data change:

| mechanism | lifetime | invalidated by |
|---|---|---|
| `ShopPage.cache` | in-memory, per page load | any reload |
| `API._swrCache` | 60 s in-memory | elapsed time |
| `-codes-v9` chip keys | in-memory | a **schema** bump, not a data change |
| asset `?v=` tokens | per deploy | `npm run build` (md5 of file bytes) |

The only durable layer is the **Cloudflare edge cache** in front of `/api/*`, which is yours. If
these rows are not showing, purge there. Nothing in the storefront pins product data across a reload.

### 1.2 "Verify the tri-colour swatch renders for all 6 SKUs" — this cannot happen, by design

> *"the CMY 3-stripe swatch must be driven off `color === "Tri-Colour"` (via the existing
> `PACK_COLORS['Tri-Colour']` path), not off `color_hex`."*

**All six SKUs are genuine, and the storefront never paints a colour tile on a genuine product.**

This is the *genuine-no-colour-tile invariant*, enforced on seven render surfaces
(`products.js`, `product-detail-page.js`, `cart.js`, `checkout-page.js`, `favourites.js`,
`order-confirmation-page.js`, `order-detail-page.js`) and pinned by
`tests/genuine-no-color-tile.test.js`. The reason: a striped colour tile is the visual language of a
**compatible** cartridge. Painting one on a genuine product makes a genuine cartridge look
third-party — a brand-misrepresentation risk we already had to answer for in the Merchant Center
audit. Genuine rows without an image fall through to the neutral placeholder instead.

So there is no swatch to verify on any of the six, and there must not be. A genuine row's colour
appears as **text** (the spec row, the card subtitle), never as a tile.

Two corrections to the underlying model:

- **There is no `PACK_COLORS` map.** The vocabulary is `ProductColors` in `inkcartridges/js/utils.js`.
- **`color_hex` is not ignored** — `getProductStyle()` prefers it and renders a multi-hex array as a
  striped gradient. `color` is the fallback. That ordering is deliberate and unchanged.

We have pinned this for your exact SKU, so the next handoff gets an answer instead of an argument:
`tests/genuine-no-color-tile.test.js` → *"runtime: genuine Tri-Colour single with image_url=NULL
(G804CLR) gets the placeholder, NOT a CMY tile"*.

**Verifying your ask found a real hole in that invariant, and fixed it.** All three card renderers
emitted, for any product with an image and a known colour:

```html
<img data-fallback="color-block">
<div class="product-card__color-block" style="<gradient>; display: none;">
```

gated on the colour alone, never on source — and the image `error` handler reveals that hidden div.
So a **genuine** product whose image failed to load swapped itself for a striped compatible-style
tile. Every existing test covered `image_url: null`; none covered *"the image 404s"*, which is a live
path because the optimizer proxy (`api.inkcartridges.co.nz/api/images/optimize`) rate-limits under
load. Genuine rows now fall back to the neutral placeholder. Your five Canon SKUs each carried one of
these hidden tiles.

### 1.3 "Spot-check `G804CLR` renders as a single with the GENUINE tile fallback"

Renders correctly as a single: no pack ribbon, no `pack_savings_vs_singles`, no per-cartridge line.
`pack_type: "single"` is honoured by every pack-UI gate.

One correction: **there is no "GENUINE tile".** That artefact does not exist. `image_url = NULL` on a
genuine row yields the neutral `/assets/images/placeholder-product.svg` — a grey outline reading
"No Image". Which is the real issue: **`G804CLR` is live, purchasable, and has no photograph.** See
task 3.5.

---

## 2. What the colour flip actually changed: nothing visual

`ProductColors.map` has always mapped `'colour'` and `'tri-colour'` to the **byte-identical**
gradient, and `COLOR_RANK` has always ranked both **11**:

```
getStyle('Colour')     → background: linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%,
                                     #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%);
getStyle('Tri-Colour') → (identical)
colorOrder({color:'Colour'}) === colorOrder({color:'Tri-Colour'}) === 11
```

So for the five Canon singles the change is a **text label only** — no swatch change, no sort change,
no position change. That is a good outcome: the correction was right, and it was safe.

It is still worth doing, for the reason §3.1 makes concrete: `"Colour"` names no cartridge count,
and a human reading it cannot tell a one-body tri-colour from a three-cartridge pack.

**Also:** the handoff says the change affects "colour-facet filtering". There is no colour facet on
the storefront — `filters.js` gates on `.shop-layout`, which no page renders. Nothing to check there.

---

## 3. Eleven data defects the handoff missed

Found by sweeping all 3,969 live products through `/api/products`, not by reading the handoff.
Ordered by customer impact.

### 3.1 — P1 · Two identical products, two prices

| SKU | color | pack_type | price | series_codes | name |
|---|---|---|---|---|---|
| `GPG640VPVP` | `Value Pack` | `value_pack` | **$121.99** | `["PG640","CL641"]` | Canon Genuine PG640/CL641 Ink Cartridge 2-Pack |
| `GPG640CLR-2PK` | `null` | `value_pack` | **$93.99** | `["PG640","CL641"]` | Canon Genuine PG640/CL641 Ink Cartridge 2-Pack |

The names are **byte-identical**. Same pack type, same series codes, both imageless. A customer
browsing Canon PG640 sees two indistinguishable cards priced $28.00 apart and has no way to tell
which is correct — the cheaper one reads as a trap and the dearer one as a rip-off. This outranks
everything else in the handoff.

**Task.** Decide which row is canonical. Deactivate or merge the other. If both must exist they need
names that state the difference. Also set `color` on whichever survives — `null` excludes it from the
admin Packs filter, so it is invisible in the view an operator would use to find it.

**Acceptance:** no two active products share a `(brand, name)` with differing `retail_price`.
Audit check `L8-duplicate-name-price-fork` reports RESOLVED.

### 3.2 — P1 · `GPG510CLR-2PK` — the flattening you rejected for PG640 already shipped for PG510

The handoff, §3:

> *"A supplier feed tried to flatten this genuine 2-pack (PG-640 black + CL-641 tri-colour) into a
> single tri-colour cartridge; that was rejected."*

Good catch. The identical flattening is **already live on its PG510 sibling**:

| field | current | should be |
|---|---|---|
| sku | `GPG510CLR-2PK` | — |
| name | `Canon Genuine PG510/CL511CLR Ink Cartridge PG510/CL511 Tri-Colour (244 pages)` | a 2-pack name, e.g. `Canon Genuine PG510/CL511 Ink Cartridge 2-Pack` |
| `color` | `Tri-Colour` | `Value Pack` (or `Black/Colour`) |
| `pack_type` | **`single`** | **`value_pack`** |
| `series_codes` | `["PG510","CL511"]` | unchanged — correctly a pair |
| `image_url` | `NULL` | a pack image |

A two-cartridge pack is being sold as one tri-colour cartridge. It gets **no** pack ribbon, **no**
savings badge, **no** constituent breakdown, and its `(244 pages)` yield describes only the colour
half. The `series_codes` pair already contradicts `pack_type: "single"` — that disagreement is
machine-detectable and is now audit check `L4-pack-sku-stored-single`.

**Acceptance:** `pack_type = "value_pack"`; no SKU matching `/(-\d+PK|VP|VPVP)$/` has
`pack_type = "single"`. Check `L4` reports RESOLVED.

### 3.3 — P2 · Eight more rows still say `"Colour"` — the handoff fixed 5 of 13

The five Canon singles in the handoff were corrected. These were not:

| SKU | color | pack_type | price | name | target |
|---|---|---|---|---|---|
| `GCL586` | `Colour` | single | $55.49 | Canon Genuine CL586 Ink Cartridge Fine Colour | `Tri-Colour` |
| `GCL586XL` | `Colour` | single | $72.99 | Canon Genuine CL586XL Ink Cartridge Fine Colour | `Tri-Colour` |
| `GCL646` | `Colour` | single | $55.49 | Canon Genuine CL646 Ink Cartridge Colour (180 pages) | `Tri-Colour` |
| `GCL646XL` | `Colour` | single | $72.99 | Canon Genuine CL646XL Ink Cartridge Colour (400 pages) | `Tri-Colour` |
| `GCL661` | `Colour` | single | $55.49 | Canon Genuine CL661 Ink Cartridge Colour (180 pages) | `Tri-Colour` |
| `GCL661XL` | `Colour` | single | $72.99 | Canon Genuine CL661XL Ink Cartridge HY Colour (300 pages) | `Tri-Colour` |
| `GCLI36C` | `Colour` | single | $53.79 | Canon Genuine CLI36C Ink Cartridge Colour (109 pages) | `Tri-Colour` |
| `G68` | `Colour` | single | $55.99 | HP Genuine 68 Ink Cartridge Colour (7FP20TA) (120 pages) | `Tri-Colour` |

These are the same Canon `CL`-prefixed tri-colour family the handoff corrected — `CL586` / `CL646` /
`CL661` are one-body C/M/Y cartridges exactly like `CL511` and `CL641`. **Please confirm each against
the OEM spec before writing**; we are asserting the pattern, not the part number.

Plus one pack, which needs a different value:

| SKU | color | pack_type | name | target |
|---|---|---|---|---|
| `GBCI16VP` | `Colour` | `value_pack` | Canon Genuine BCI16 Ink Cartridge Colour 2-Pack | `Value Pack` — it is a 2-pack, not a tri-colour single |

**Acceptance:** no active ink/toner row has `color` matching `/^colou?r$/i`. Checks `L1`/`L3` RESOLVED.

### 3.4 — P2 · Two products that are not colour products at all

| SKU | color | price | name | problem |
|---|---|---|---|---|
| `GCE506A` | `Colour` | $543.79 | HP Genuine 220V LaserJet Fuser Kit 220V | A **fuser kit** — a heat roller. It contains no ink or toner and has no colour. |
| `GCE980A` | `Colour` | $85.79 | HP Genuine CE980A Toner Cartridge Colour | Needs the actual colour, or `KCMY` if it is a set. `"Colour"` says nothing usable. |

`GCE506A` also has `series_codes: ["220V"]` — a **voltage rating parsed as a product code**. That
will match any code-based lookup for "220V" and should be corrected or cleared.

**Acceptance:** no product whose name contains fuser / transfer belt / waste toner / maintenance kit
carries a `color`. Check `L5` RESOLVED.

### 3.5 — P3 · Four live tri-colour products with no photograph

`G804CLR` (the handoff's own SKU), `G60CLR`, `G61CLR`, `GPG510CLR-2PK`.

This matters more for tri-colour than for anything else, because of §1.2: a genuine row may not
render a colour swatch, so a missing photo leaves the customer with a blank grey square and a name.
For a black cartridge that is survivable; for the colour cartridge — usually the more expensive
half — it is the product page doing no selling at all.

(Catalogue-wide, 924 coloured ink/toner rows have no image. That is a known backlog and the audit
does not report it; only the tri-colour rows are called out.)

### 3.6 — P2 · `/api/products` serves 7 fewer products than it counts

```
walked every page to has_next=false → collected 3969 products
meta.total                          → 3976
```

Every page was walked to `has_next=false`; no duplicates, no rows missing a SKU. **Seven products are
counted by the API but never served by it**, which means they are unreachable through the public
catalogue reader the storefront uses — invisible on the site and invisible to this audit.

Likely `total` counting rows the page query filters out (inactive? null-category?). Either way the
two numbers must agree, or every consumer that paginates on `total` is wrong.

**Acceptance:** collected row count equals `meta.total`. Check `L0` RESOLVED.

### 3.7 — Standing request · close the colour vocabulary

`products.color` is free text with several writers, so it drifts, and drift is invisible: an
unrecognised colour does not throw, it renders a blank tile and sorts as "unknown" — which looks
exactly like a product that legitimately has no colour.

A full census found **20 distinct stored values** the admin dropdown could not offer, covering ~89
products. The largest was **`Grey` (27 rows)** — production has always used the British spelling
while our dropdown only carried the US `Gray`, so all 27 rendered as "Grey (legacy)" and any save
silently re-spelled them. That is the drift mechanism in miniature.

**We have absorbed all 20 into the frontend vocabulary**, so nothing is broken today. The request is
that new colour values come from a closed list. The agreed list is `ProductColors.OPTIONS` in
`inkcartridges/js/utils.js` (42 entries, reproduced by `npm run audit:colours --json`).

Note `"Colour"` and `"Color"` are deliberately **not** in it. They still render and sort for the rows
that carry them, but they should never be written again — they are the value that created §3.3.

---

## 4. What we changed on the frontend

None of this was required by the handoff; it came out of verifying it.

| change | why |
|---|---|
| `ProductSort.familyKey` now delegates to `SeriesCodes.collapseYieldSuffix` | It carried a second yield grammar that disagreed with the documented one. `[A-Z]+\d+` meant bare-numeric codes never collapsed (`804XL` stayed `804XL` while `LC133XL` → `LC133`), so a payload carrying the XL code forked off its std sibling. |
| Three private colour→hex maps deleted | `shop-page.js`, `admin/pages/cc2-packs.js` and `order-detail-page.js` each had their own; all three were blind to `Tri-Colour`, and one interpolated a `color_hex` **array** into CSS (`background:#a,#b` — invalid, paints nothing). |
| Colour vocabulary extended | 20 live values had no swatch, no rank, or no dropdown entry. |
| `PACK_VALUES` gained `CMYK` + `Black/Colour` | All 5 rows carrying them are `value_pack`; the admin Packs filter was showing them as singles. |
| Dead `isValuePack()` deleted | Zero call sites, and it classified `color === 'colour'` as a pack — it would have relabelled all 35 tri-colour singles the day anyone used it. |
| Colour-block **image-error** fallback gated on source | A genuine product whose image 404'd revealed a hidden striped tile. See §1.2. |
| `ProductName.clean` peels the page-yield tail | Titles read `"…LC133 Black (600 pages) Ink Cartridge"`; now `"…LC133 Ink Cartridge Black (600 pages)"`. 2,373 titles improved. |

> **A note on one-character fixes.** The obvious repair for `familyKey` was widening `[A-Z]+` to
> `[A-Z]*`. Run against all 1,350 distinct live `series_codes`, that widening collapses **zero**
> codes correctly and **mangles three** — `34217HR → 34217R`, `64017HR → 64017R`,
> `64080HW → 64080W`, all real Lexmark SKUs — because the `H` yield branch starts eating letters out
> of a bare-numeric body. Delegating to the existing helper was zero-diff across all 1,350. Worth
> knowing if you carry similar suffix logic backend-side.

---

## 5. How to verify your changes

From the frontend repo:

```bash
npm run audit:colours          # full sweep against production
npm run audit:colours:static   # vocabulary self-consistency only, no network
npm run audit:colours -- --json
```

Findings already reported here are recorded in `tests/fixtures/colour-vocabulary-baseline.json` and
print as **known** — they do not fail the run. Two things do:

- a **new** finding that is not in the baseline → exit 1
- a baseline finding that **stops tripping** → printed as `RESOLVED — remove from baseline`, exit 1

That second rule is deliberate. It means fixing one of these tasks makes the audit go red until the
record is updated, so the record cannot quietly drift out of date the way a static fixture does.
As you land each fix, delete its entry from the baseline in the same change.

---

## 6. Method

Every number here came off the wire on 2026-08-03, not from the handoff. Full anonymous walk of
`GET /api/products?page&limit=200` to `has_next=false`, 3,969 rows collected and reconciled against
`meta.total`; all 1,350 distinct `series_codes` extracted and replayed through the shipped sort code;
every stored `color` value tallied against the shipped `ProductColors`. Nothing was assumed from the
handoff's tables — which is how §3.2 and §3.3 turned up.
