# Related Products / `series_codes` — frontend response + backend asks (Jul 2026)

**From:** frontend (`matcha/FEINK`)
**Re:** `related-products-series-codes-fe-notes-jul2026.md`
**Date:** 2026-07-30 · FE work logged as ERR-134

---

## 1. Your fix is confirmed working — thank you

Verified against the live API and the live site rather than assumed:

| Check | Result |
|---|---|
| `GET /api/products/G786XLC` | `series_codes: ["786"]`, `yield_tier: "XL"` ✅ |
| Detail ⇄ list parity, **138-SKU stratified sample** (every brand × category × source + 16 forced edge cases) | **100% identical**, 0 mismatches on either field, 0 errors ✅ |
| Live Epson 786XL Cyan PDP | Related Products renders the exact 786 family — Black/Magenta/Yellow singles + CMY and KCMY packs ✅ |
| Whole catalogue (3,910 products enumerated from `/api/shop`) | **2,931 of 3,801** non-ribbon PDPs resolve a family; **767** hide correctly as genuine singletons ✅ |

`series_codes` is absent only on ribbons, which is correct — ribbons are owner-curated by design
(ERR-085/086) and must stay that way.

Your "no frontend change required" was right **for the reported bug**. We did make changes, but for
things the note didn't cover — two of which your deploy caused, and neither of which would have
raised an error anywhere. Details below, in case they're useful context.

---

## 2. Your open question: `GET /api/products/:sku/related`

**Recommendation: retire it.** We measured it rather than guessing.

`GET /api/products/G786XLC/related` returns 6 ranked rows, but each row carries only:

```
brand, color, color_hex, image_url, in_stock, name,
retail_price, sku, slug, source, stock_quantity, stock_status
```

Missing, relative to what the PDP card renderer and the family grouping need:

- `series_codes` — the grouping key (`ProductSort.familyKey`)
- `yield_tier` — the row-break key
- `pack_type` — pack ordering and the value-pack rules
- `canonical_url` — link integrity
- `compare_price`, `gst_amount`, `price_includes_gst`, `original_price`, `discount_amount` — the price block
- `average_rating`, `review_count` — the rating badge
- `image_srcset`, `image_thumbnail_url` — responsive images

It also **crosses families**: the 786 page's response included `G788XXLC`, a different series. The
PDP's contract is "the rest of *this* family", so that row would be wrong on the page even if the
payload were complete.

Switching to it would mean a second fan-out to re-fetch every missing field, which is strictly worse
than the single `/api/shop?brand=&category=&code=` call we already make. **No action wanted — safe to
delete.** If it's ever revived, the above is the shape it would need.

---

## 3. BF-027 — `detectYieldTier` misses the trailing-`H` high-yield convention

**Impact: cosmetic but customer-visible.** Grouping puts standard and high-yield cartridges of the
same model code on the same row, so a 1,000-page and a 3,000-page item sit side by side with nothing
distinguishing the row.

`yield_tier` is now present on 3,910/3,910 products — thank you, that's a real improvement. It
disagrees with our name-based detector on 27; on 11 of those **your value is stronger and we keep
it**. The remaining **16** are `STD` where the product name *and its own page count* say high yield:

| SKU | Name | Backend | Should be |
|---|---|---|---|
| `G708HC` | Lexmark 708H Cyan (3,000 pages) | STD | XL |
| `G708HM` | Lexmark 708H Magenta (3,000 pages) | STD | XL |
| `G808HC` | Lexmark 808H Cyan (3,000 pages) | STD | XL |
| `G808HM` | Lexmark 808H Magenta (3,000 pages) | STD | XL |
| `GC236HCMY` | Lexmark 236H CMY 3-Pack (2,300 pages) | STD | XL |
| `GC236HKCMY` | Lexmark 236H KCMY 4-Pack (2,300 pages) | STD | XL |
| `GC333HCMY` | Lexmark 333H CMY 3-Pack (2,500 pages) | STD | XL |
| `GC333HKCMY` | Lexmark 333H KCMY 4-Pack (2,500 pages) | STD | XL |
| `GC333HY0Y` | Lexmark C333HY0 Yellow (2,500 pages) | STD | XL |
| `GCART069HC` | Canon CART069H Cyan | STD | XL |
| `GCART069HM` | Canon CART069H Magenta | STD | XL |
| `GCART069HCMY` | Canon CART069H Value Pack CMY 3-Pack | STD | XL |
| `GCART069HKCMY` | Canon CART069H Value Pack KCMY 4-Pack | STD | XL |
| `GCART069HKBK` | Canon CART069HK Black | STD | XL |
| `GCART055HCMY` | Canon CART055 CMY 3-Pack (5,900 pages) | STD | XL |
| `GPG660XLHYBK` | Canon PG660XLHY Black | STD | XL |

The clearest single case: `G708C` is "708 Cyan (1,000 pages)" → `STD`, and `G708HC` is
"708H Cyan (3,000 pages)" → also `STD`. Note `G708HYY` ("708HY Yellow") *is* correctly `XL`, so the
`HY` form is handled and only the bare trailing `H` is missed.

**Ask:** extend `detectYieldTier` to treat a trailing `H` after the model digits (`708H`, `236H`,
`CART069H`, and the `…HK` colour-suffixed forms) as high yield, the same way `HY` already is.

**What we did meanwhile:** `ProductSort.yieldTier()` now returns `max(backend, FE detection)` instead
of trusting the backend unconditionally. It is one-directional — it can only *raise* a tier, so all
11 cases where your value is stronger are untouched — and it goes inert automatically once
`detectYieldTier` agrees. Nothing to undo on your side when you ship the fix.

**Also worth knowing:** before this deploy, `yield_tier` was `null` on every endpoint, so our
detector was doing all the work and these 16 were tiered correctly. Populating the field is what
silently regressed them, because our code treated a present value as authoritative. Not a criticism
of the change — just the kind of thing that has no error to catch it.

---

## 4. BF-028 — `product_type` vocabulary: `fax_film` / `fax_film_refill`

Low impact, quick to close. Seven products carry `product_type: "fax_film"` or `"fax_film_refill"`:

`GPC201`, `GPC301`, `GPC302RF`, `GPC402RF`, `GPC501` (Brother), `GFX3BK`, `GFX12BK` (Canon).

They're served under `/api/shop?category=drums`, but nothing documents that mapping, and their
`category` field is `CON-LASER` — which for the two Canon ones combines with a name reading "Toner
Cartridge" to point at three different answers. We've hardcoded `fax_film`/`fax_film_refill` → drums
from the measured behaviour.

**Ask:** confirm that mapping is intended and stable, and ideally publish the full `product_type` →
shop-category table so we stop inferring it. All seven are single-product families today, so nothing
is visibly broken either way.

---

## 5. FYI — one thing on our side worth flagging

`/api/products/:sku` and `/api/shop` are rate-limited (HTTP 429 with
`{"ok":false,"error":{"code":"RATE_LIMITED"}}`). We hit it from a single machine doing paced
sequential catalogue reads for this verification — roughly 2 requests/second was enough.

That's reasonable protection and we're not asking for it to be raised. Flagging it because until
today a 429 on the family fetch **silently deleted the entire Related Products section** — it was
indistinguishable from "this product has no relatives". That's now a visible error with a Retry
button. If you ever see support reports of related products "missing" on a busy day, that was why.

Also: `/api/shop?limit=100` returns 99, 98, 99, 32 rows across pages — fewer than the requested limit
on non-final pages. Not a bug for us (we page until an empty response), but worth knowing that
`rows < limit` is **not** a reliable end-of-pagination signal for any other consumer.

---

## Summary

| Item | Owner | Status |
|---|---|---|
| `series_codes` + `yield_tier` on `/api/products/:sku` | backend | ✅ done, verified |
| Related Products on the 786XL PDP | — | ✅ fixed by the above |
| BF-027 `detectYieldTier` trailing-`H` (16 SKUs) | backend | 🔲 open — FE has a self-disabling workaround |
| BF-028 `product_type` → category mapping for fax films | backend | 🔲 open — FE hardcoded from measurement |
| Retire `GET /api/products/:sku/related` | backend | 🔲 recommended, no FE dependency |
| Multi-code family fallback, loud fetch failures, category vocabulary | frontend | ✅ shipped (ERR-134) |
