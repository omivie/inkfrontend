# Duplicate value packs retired — FE response (Sep 2026)

**Replies to:** `duplicate-pack-retirement-FE-handoff-sep2026.md` (backend `e03daae`, `32ddc4c`, `59f7de2`, `016037d`, `5606377`)
**Measured:** 2026-09-20, live production, 4,066 active rows, plus a real browser on `www.inkcartridges.co.nz`
**FE side:** ERR-277 · `npm run probe:lookalike` · `tests/duplicate-pack-retirement-sep2026.test.js`

---

## TL;DR

**This one was right.** Every claim in the hand-off checks out, including the two that
the Aug 2026 document got wrong. All three of your asks are answered below, and the
answer to "does the FE need to change?" is *no, for the reasons you gave*.

| | Claim | Measured |
|---|---|---|
| §1 | no purge needed; storefront not edge-cached, api `s-maxage=300` | **Confirmed**, byte for byte |
| §2 | all 17 retired SKUs 301 to their survivor | **17/17**, every target correct |
| §2 | `CLC40KCMY` deliberately NOT retired | **Confirmed live** — and now a permanent control (below) |
| §3 | the two Brother `LC3-Pack` names/slugs re-derive at the next import | **Already done** — both read `CMY 3-Pack` / `KCMY 4-Pack` today |
| §4 | remove any client-side dedup hiding these cards | **None existed on the card surfaces** — but see §3 below, you were right to warn |
| §5 | three groups deliberately still two cards | **Decision taken by the owner: leave all three.** Please stop re-reporting them |

Three things we found that you could not have known about, two of which were ours.
**The third is yours, is live right now, and we already reported it three days ago:**
`/api/products/by-slug/` is 500ing for every slug (`catalogue-500-outage-sep2026.md` §1,
2026-09-17, still unfixed). Details in §4 — it now blocks verification of your own §3.

Everything below is reproducible with public URLs and no credentials.

---

## 1. Your ask #1 — the 17 SKUs are not in the SPA

Grepped the whole repo, not just shipped code. **No retired SKU appears in any shipped
frontend file.** There is no curated product list, no promo tile and no featured array
anywhere in the storefront — every "popular products" surface is API-driven.

Three non-shipping references existed and are now handled:

- `scripts/probe-lookalike-rows.mjs` held 5 of the 17 in its redirect manifest. **Extended
  to all 17.** This is now the standing guard against a fifth revert.
- `js/api.js` carried the two SKUs in a load-bearing *comment* — see §2.
- `tests/traffic-conversion-jul2026.test.js` names `GW218CMY` in a provenance comment only;
  the fixture is anonymous numbers and is unaffected.

**There is one frontend surface where a retirement WOULD break something**, and it is worth
your knowing about for the next sweep: `js/business-demo.js` freezes eight real SKUs *and*
their full `/products/<slug>/<SKU>` URLs, because fake ones would 404 the moment "Add to
cart" is clicked. None of your 17 are in it. It is now shape-pinned by a test and its SKUs
are checked by the probe, so a future retirement that touches one of them fails loudly here
rather than silently on a customer's screen.

---

## 2. Your ask #1 had a second-order effect we nearly missed

`getShopData` in `js/api.js` fires a **second** request on every brand+category drilldown
(`/api/products?source=compatible&limit=200`) and merges it into the `/api/shop` result.

When you asked us to retire that sidecar in Sep 2026 we declined, and we declined *with a
measurement*: it was still recovering two cards.

```
epson/81N  /api/shop alone 8 rows -> getShopData 9  (+CT081KCMY)
epson/73N  /api/shop alone 7 rows -> getShopData 8  (+CT073CMY)
```

**Both of those rows are on your list of seventeen.** Re-measured today:

```
epson/ink/81N     /api/shop  8 rows, sidecar recovers 0
epson/ink/73N     /api/shop  7 rows, sidecar recovers 0
canon/ink/PGI650  /api/shop  4 rows, sidecar recovers 0
canon/ink/CLI681  /api/shop 28 rows, sidecar recovers 0
brother/ink/LC432 /api/shop 18 rows, sidecar recovers 0
brother/ink/LC3339 /api/shop 12 rows, sidecar recovers 0
```

So the argument we used to keep it is gone. **We have not removed it**, and we would rather
you knew why than discovered it later: removing a fallback is a behaviour change, not
cleanup, and six chips is not a catalogue-wide proof — the merge is also what covers a
regression in `series_codes`. What changed is that the number is no longer a sentence in a
comment that can quietly rot. `npm run probe:lookalike` scan 7 now prints the yield per chip,
and the comment points at it.

**If you want the sidecar gone, this is the number to argue from, and we will take a
catalogue-wide run of scan 7 as sufficient.** That is a real request, not a brush-off: it is
a second origin request per drilldown, and per ERR-266 the 100-req/60s limiter is shared
per-IP, so it is admins who pay for it.

---

## 3. Your ask #2 — no card dedup existed, but your warning was still correct

**No storefront surface hides look-alike cards.** `ProductIdentity.markLookalikes`
(`js/utils.js`, ERR-195) *marks* look-alike rows by printing the SKU on both and is pinned by
six tests that assert it never removes or reorders a row. That is deliberate: deciding two
database rows are the same product is an assertion of identity we do not think the frontend
can make. So there was nothing to remove.

**But your §4 warning found something anyway.** The `/search` results union — where the
typeahead shortlist is merged with the literal `/api/products?search=` set — treated a shared
*normalized name* as proof of identity. Two rows with **different, known SKUs** collapsed into
one card whenever their titles normalized equal, and which one survived was ordering.

Your example is exactly the shape, and both rows are live:

```
G728130MLCMY   $583.49   HP Genuine 728 130ml CMY 3-Pack
G728300MLCMY  $1158.49   HP Genuine 728 300ml CMY 3-Pack     both on the `728` chip
```

Their names differ today, so it was not firing. We scanned all 4,066 active products: **zero
normalized-name collisions right now.** It was latent — and latent is not the same as safe
when the generator that mints these has re-created duplicate twins four times and reverted
within a day on 09-19.

Fixed: a **SKU conflict now vetoes a name match**. The name key is kept, because `/suggest`
rows can arrive with no `sku` at all and without it the same product renders twice. Two rows
that each name a SKU, and name different ones, are now two cards whatever their titles say.

*No action for you here.* We are reporting it because you asked the right question and it
turned up a real defect one layer over from where you were pointing.

---

## 4. STILL OPEN — `/api/products/by-slug/` is returning 500 for every slug

**Not a new report.** We raised this as §1 of `catalogue-500-outage-sep2026.md` on 2026-09-17,
with the same negative control. **It is still live on 2026-09-20**, three days later, and we
are repeating it here because it now blocks something specific: your §3.

Re-measured today while checking §3's promise that the changing Brother slugs keep resolving.

```
GET /api/products/by-slug/81nkcmy-compatible-ink-cartridge-for-epson-81n-kcmy-4-pack
    -> 500  {"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to fetch product"}}

GET /api/products/by-slug/brother-genuine-lc432cmy-ink-cartridge-lc432-cmy-3-pack
    -> 500   (same)

GET /api/products/by-slug/zzz-no-such-slug-at-all-zzz
    -> 500   (same)      <-- a slug that cannot exist also 500s, instead of 404ing
```

Known-good live slugs and impossible ones fail **identically**, so nothing in the response
distinguishes an outage from a miss.

**Customer impact is real but invisible**, which is why you have had no report. Every legacy
`/product/:slug` URL goes through this endpoint; when it fails, `product-detail-page.js` falls
back to `/api/search/smart` and the shopper still lands on the right product, one round-trip
slower, with a 5xx in the console. Verified end to end in a browser — the page renders fine.

Two consequences worth flagging:

1. **§3 of your hand-off is currently unverifiable.** "A `slug_redirects` hop is written
   automatically, so old URLs keep resolving" may well be true, but there is no way to observe
   it while the resolver 500s for everything. That is the new information since 09-17: the
   outage is no longer only costing a round-trip, it is preventing verification of a claim
   another hand-off depends on.
2. Every legacy slug URL is spending a `/api/search/smart` call it should not need.

We have made our side loud (the fallback now logs which endpoint failed and that it is
carrying the page) and added a probe scan that **carries its negative control** — asking only
"did the good slug resolve?" would have reported a plain failure, and asking only "does a bad
slug fail?" would have reported a pass.

---

## 5. Also found, not ours, not urgent

- **`CBCI6KCMY` still does not redirect.** The Aug 2026 hand-off §4a listed it as redirected to
  `CBCI3KCMY`; today it returns 200 resolving to itself, and `/api/shop?code=CI6` still renders
  it to shoppers. Its two siblings (`CBCI3BK-2`, `CBCI6CMY`) redirect correctly. We only caught
  this because the manifest was extended — it had been sitting behind an unchecked claim.
- **`GET /api/products/:sku/bought-together` 404s** on the live PDP, and fires **twice** per page
  load. Fail-soft, no visible symptom.
- **`GET /api/admin/catalog/shop?limit=1` 400s** on a storefront page load.

---

## 6. Your §5 — the merchandising decision, taken

You asked for a decision rather than a fix, so here it is, from the owner:

> **All three pairs stay as two cards.**

The supporting measurement, so it does not have to be re-litigated next sweep:

```
CLC40KCMY  $18.99   codes=[LC40, LC73]     CLC77KCMY  $21.49  codes=[LC77]
CCE32CMY   $127.99  codes=[CE32]           C128ACMY   $127.99 codes=[128]
   shared series codes in each pair: NONE
```

Because no pair shares a series code, **the two rows never co-appear in a chip drilldown** —
they only coexist in a broad brand+category listing, with distinct names and (for the Brother
pair) distinct prices. A shopper is not being asked to choose blind.

`CLC40KCMY` is now a **permanent must-NOT-redirect control** in our probe manifest, alongside
`CBCI3BK`. That is not only bookkeeping: a manifest of nothing but *expect-redirect* entries
passes just as happily against a backend that 301s everything, so the rows that must stay live
are what make a green run mean anything.

**Please treat all three as closed** unless the merchandising call changes.

---

## 7. One methodological note, because it nearly bit us

Your §2 promise is that "any existing link keeps working". That rests on the SPA *following*
your 301s — and **every catalogue GET we make is preflighted**, because `api.js` sends
`Content-Type: application/json` on a bodyless GET and that value is not CORS-safelisted.

`curl` returns 301 → 200 for all seventeen, which proves nothing about a preflighted
cross-origin redirect in a browser. We measured it in the page instead, on the live origin,
with both controls:

| | `redirected` | resolves to |
|---|---|---|
| `CT081KCMY` (retired) | **true** | `C81NKCMY` |
| `GW213KCMY` (retired) | **true** | `G213AKCMY` |
| `C81NKCMY` (survivor, +ve control) | false | itself |
| `ZZZ_NO_SUCH_SKU` (−ve control) | false | 404, no redirect |

Then end to end: `/p/CT081KCMY` renders the survivor PDP with a self-referencing canonical and
a working Add to cart. **Your redirects are good.** We are recording the method because the
next hand-off that says "verified live" against this endpoint family should say which client
did the verifying.
