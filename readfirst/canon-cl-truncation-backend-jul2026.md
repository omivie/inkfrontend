# Backend: `series_codes` extractor truncates Canon's 3-digit `CL` codes

**Status:** open (backend) · **Raised:** 2026-07-14 · **Frontend:** mitigated, no coordination needed to deploy
**Severity:** customer-visible — 4 product-code chips on `/shop` ship only half their products, and 4 more chips merge unrelated series.
**Storefront ticket:** ERR-061

---

## 1. Summary

The `series_codes` extractor **caps the bare `CL` prefix at two digits**. `CL511` and `CL513` both come out as `CL51`; `CL641` and `CL646` both come out as `CL64`; `CL586` → `CL58`; `CL661` → `CL66`.

`CLI` codes are unaffected (`CLI521`, `CLI8`, `CLI651` all survive intact), so the defect is specific to the bare-`CL` branch of the extractor.

Two customer-visible symptoms follow from that one bug.

### Symptom A — pair chips deliver only their black half

`/api/shop` **labels** a chip with the merged pair (`PG510/CL511`) but **files** each product under that product's own extracted `series_codes`. Those two things are produced by different code paths, and here they disagree: the colour cartridges were extracted as `CL51`, so they never land under the pair.

Nothing errors. The chip just quietly under-delivers.

### Symptom B — the truncated code becomes a chip that merges unrelated series

Because `CL511` and `CL513` collapse to the same string, the `CL51` chip contains **both** series. Same for `CL64` (= CL641 + CL646).

---

## 2. Reproduction (live, verified 2026-07-14)

```bash
BASE=https://ink-backend-zaeq.onrender.com/api

# The pair chip promises PG510 AND CL511 — returns only the PG510 blacks.
curl -sG "$BASE/shop" --data-urlencode brand=canon --data-urlencode category=ink \
                      --data-urlencode "code=PG510/CL511"
#   → 2 products: GPG510BK, CPG510BK   (both series_codes: ["PG510"])

# The colour half is unreachable — the code does not exist server-side.
curl -sG "$BASE/shop" --data-urlencode brand=canon --data-urlencode category=ink \
                      --data-urlencode "code=CL511"
#   → 0 products

# ...because it was filed under the truncated code, together with CL513.
curl -sG "$BASE/shop" --data-urlencode brand=canon --data-urlencode category=ink \
                      --data-urlencode "code=CL51"
#   → 3 products: GCL511, CCL511CLR  (should be CL511)
#                 CCL513CLR          (should be CL513 — different series!)
```

---

## 3. Blast radius

I audited **all 27 brands × 6 categories** against the live API. There are 18 merged pair chips in the catalogue: **14 are healthy, 4 are broken.** All 4 are Canon ink, all missing the colour half.

### Broken pair chips

| Chip | Chip count | Products returned | Missing half |
|---|---|---|---|
| `PG510/CL511` | 2 | 2 (black only) | **CL511** |
| `PG512/CL513` | 1 | 1 (black only) | **CL513** |
| `PG640/CL641` | 6 | 6 (black + 2-packs) | **CL641** |
| `PG645/CL646` | 3 | 3 (black only) | **CL646** |

### Junk / merged chips created by the truncation

| Chip | n | What's actually inside |
|---|---|---|
| `CL51` | 3 | `GCL511`, `CCL511CLR` (→ CL511) + `CCL513CLR` (→ **CL513**) — two series merged |
| `CL64` | 8 | `GCL641`, `CCL641XLCLR`, `GCL641XL` (→ CL641) + `GCL646`, `CCL646XLRD`, `GCL646XL` (→ **CL646**) — two series merged, plus the 2 twin-packs |
| `CL58` | 2 | `GCL586`, `GCL586XL` — coherent, but **mislabelled** (should read CL586) |
| `CL66` | 3 | `GCL661`, `CCL661XLRD`, `GCL661XL` — coherent, but **mislabelled** (should read CL661) |

`CL58` / `CL66` are cosmetic-only (each tile is internally consistent), but the same fix cures them.

### Healthy — do not regress these

Canon ink: `PG40/CL41`, `PGI5/CLI8`, `PGI520/CLI521`, `PGI525/CLI526`, `PGI650/CLI651`, `PGI670/CLI671`, `PGI680/CLI681`.
Canon toner: `TG35/GPR23`, `TG45/GPR30`, `TG51/GPR35`, `TG54/GPR38`, `TG56/GPR42`, `TG61/GPR48`, `TG65/GPR51`.

---

## 4. The fix

Allow **three** digits on the bare `CL` prefix in the extractor (`CL\d{2}` → `CL\d{2,3}`), so `CL511`, `CL513`, `CL586`, `CL641`, `CL646`, `CL661` extract in full.

Because the pair chips are built by grouping on the extracted code, fixing the extraction is sufficient — `CL511` will then match the `CL511` half of `PG510/CL511` on its own, and the `CL51` / `CL64` chips disappear because nothing extracts to them any more.

### ⚠️ Two traps — a blanket "always take 3 digits" will BREAK things that work today

**1. `CL38` and `CL41` are genuine two-digit Canon codes.**
`CL-38` (SKU `GCL38`) and `CL-41` (the colour half of the healthy `PG40/CL41` pair) must keep extracting as-is. Greedily consuming a third digit would corrupt them.

**2. `CLI65` is a real code and is NOT a truncation of `CLI651`.**
Canon `CLI-65` (PIXMA PRO-200) has 10 genuine SKUs — `GCLI65BK`, `GCLI65C`, `GCLI65M`, `GCLI65Y`, `GCLI65GY`, `GCLI65LGY`, `GCLI65PC`, `GCLI65PM`, `GCLI65CMY`, `GCLI65KCMY` — and is a **different product line** from `CLI-651`. A greedy matcher must not merge them or steal SKUs between them.

The safe rule is to extract the longest code the **SKU/part number actually contains**, not to assume a fixed digit width.

---

## 5. Acceptance criteria

After the fix, all of these should hold:

```bash
BASE=https://ink-backend-zaeq.onrender.com/api
S() { curl -sG "$BASE/shop" --data-urlencode brand=canon --data-urlencode category=ink \
        --data-urlencode "code=$1" --data-urlencode limit=200; }
```

| Check | Expected |
|---|---|
| `?code=PG510/CL511` | **4** products — `GPG510BK`, `CPG510BK`, `GCL511`, `CCL511CLR` |
| `?code=PG512/CL513` | **2** products — includes `CCL513CLR` |
| `?code=PG640/CL641` | includes `GCL641`, `GCL641XL`, `CCL641XLCLR` |
| `?code=PG645/CL646` | includes `GCL646`, `GCL646XL`, `CCL646XLRD` |
| chip list for `?brand=canon&category=ink` | `CL51` and `CL64` are **gone**; `CL58`→`CL586`, `CL66`→`CL661` |
| `?code=CL38`, `?code=PG40/CL41` | **unchanged** (2-digit codes intact) |
| `?code=CLI65` | still **10** products, none of them CLI651 |
| `?code=PGI650/CLI651` | still **25** products, none of them CLI65 |
| every other brand's chip list | byte-identical to today |

---

## 6. Deploy coordination: none required

The storefront currently ships a **repair layer** that re-homes these products client-side, so the shop is correct for customers today. It is deliberately **self-disabling**:

- it only treats a chip as truncated when that chip is a strict digit-prefix of a half of one of **your own** pair labels (so it can't invent corrections you didn't imply); and
- it only rewrites a product's code when the SKU **strictly extends** the code you sent (`CL51` → `CL511`), never when they already agree.

The moment the backend emits `CL511`, the frontend detects nothing and rewrites nothing — the layer becomes a no-op automatically.

**So: ship the backend fix whenever you like.** There is no deploy race, no flag to flip, and no frontend change required afterwards. We'll delete the (now-dead) repair layer at our leisure.

---

## 7. Minor, likely unrelated — chip count vs. grid disagree by one

Two healthy pair chips report a count that doesn't match the number of products they return:

| Chip | `count` in the chip list | Products actually returned |
|---|---|---|
| `PGI670/CLI671` | 24 | 23 |
| `PGI680/CLI681` | 29 | 28 |

Probably a separate counting quirk (an inactive product counted but not returned?), but worth a look while you're in this code.
