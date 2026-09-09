# `/api/search/smart` ranks every value pack below every single — backend brief (Sep 2026)

**From:** frontend (`matcha/FEINK`)
**To:** backend dev + backend CLI agent (`ink-backend-zaeq`)
**Date:** 2026-09-06 · FE investigation logged as ERR-222 · backend fault filed as **BF-057**
**Endpoint:** `GET /api/search/smart`

---

## 1. Summary

**The endpoint recommends a product it ranks 239th out of 367.**

A customer types `lc` in the header search box. The dropdown shows:

> **Did you mean LC3333KCMY Compatible Ink Cartridge for Brother LC3333 KCMY 4-Pack?**

…and then a result row containing only the four singles — LC3333 **BK, C, M, Y**. The 4-pack it
just recommended is not there. Neither is the CMY 3-pack.

Both come from the same response envelope: `data.did_you_mean` names `LC3333KCMY`, while
`data.products[]` does not contain it. The frontend cannot reconcile that, because the row is
~200 ranks past the window it requests.

The cause is not relevance scoring. For `q=lc`, the response places **all 238 singles first
(ranks 1–238), then all 129 value packs (ranks 239–367)** — a hard partition with no interleaving.
`relevance_score` and `match_tier` are ignored across that boundary.

This is systemic, not an LC quirk: `q=tn` shows the same partition (212 rows, 66 packs, first pack
at rank 147).

**Customer impact:** every multi-pack in the catalogue is invisible in typeahead for any query
broad enough to return more than 40 rows — which is every query while the customer is still typing.
Multi-packs are our highest-value SKUs.

---

## 2. Reproduce it in 30 seconds

```bash
curl -s "https://ink-backend-zaeq.onrender.com/api/search/smart?q=lc&limit=40" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; \
print('did_you_mean:', d['did_you_mean']); \
print('pack_types on page 1:', {p['pack_type'] for p in d['products']})"
```

Expected output today:

```
did_you_mean: LC3333KCMY Compatible Ink Cartridge for Brother LC3333 KCMY 4-Pack
pack_types on page 1: {'single'}
```

Full partition table (Node 18+, no dependencies):

```js
const B = 'https://ink-backend-zaeq.onrender.com/api/search/smart';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function allRows(q) {
  const out = [];
  for (let pg = 1; pg <= 15; pg++) {
    const r = await fetch(`${B}?q=${encodeURIComponent(q)}&limit=40&page=${pg}`);
    const j = await r.json();
    // ⚠️ RATE LIMITING RETURNS HTTP 200 with {ok:false, error:{code:"RATE_LIMITED"}}.
    // A naive script reads that as "no results" and reports a false all-clear.
    if (!j.data) throw new Error(`q=${q} page=${pg}: ${JSON.stringify(j).slice(0, 120)}`);
    j.data.products.forEach(p => out.push(p));
    if (!j.data.pagination.has_next) break;
    await wait(1200);
  }
  return out;
}

(async () => {
  for (const q of ['lc', 'tn', 'lc3333']) {
    const rows = await allRows(q);
    const isPack = r => r.pack_type !== 'single';
    const firstPack = rows.findIndex(isPack);
    const lastSingle = rows.map(isPack).lastIndexOf(false);
    console.log(
      q.padEnd(8),
      'rows', String(rows.length).padStart(4),
      'packs', String(rows.filter(isPack).length).padStart(4),
      '| first pack at rank', String(firstPack + 1).padStart(4),
      '| ALL SINGLES BEFORE ALL PACKS:', firstPack > lastSingle ? 'YES' : 'no',
      '| packs in top 40:', rows.slice(0, 40).filter(isPack).length
    );
    await wait(3000);
  }
})();
```

Output on 2026-09-06:

```
lc       rows  367 packs  129 | first pack at rank  239 | ALL SINGLES BEFORE ALL PACKS: YES | packs in top 40: 0
tn       rows  212 packs   66 | first pack at rank  147 | ALL SINGLES BEFORE ALL PACKS: YES | packs in top 40: 0
lc3333   rows   12 packs    4 | first pack at rank    9 | ALL SINGLES BEFORE ALL PACKS: YES | packs in top 40: 4
```

---

## 3. The measurements

### 3a. `q=lc` — the partition, and the score inversion that proves it is not relevance

| Rank | SKU | `pack_type` | `relevance_score` | `match_tier` |
|---:|---|---|---:|---:|
| 1 | `CLC3333BK` | single | 85.48 | 3 |
| 2 | `CLC3333C` | single | 83.87 | 3 |
| … | *(236 more singles)* | single | 85.5 → 65.0 | 3 |
| **238** | `GLC536XXLY` | **single** | **65.00** | **3** |
| **239** | `CLC3333KCMY` | **value_pack** | **210.00** | **2** |
| 240 | *(128 more packs)* | value_pack | — | 3 |

Rank 239 beats rank 238 on **both** ranking signals — more than 3× the score, and a strictly
better match tier — and is still placed below it. `relevance_score` is not the sort key across
the single/pack boundary.

Note that `CLC3333KCMY` at rank 239 is the exact product `did_you_mean` recommends.

### 3b. `q=lc3333` — the same partition, with scores that make it unambiguous

Only 12 rows, so the frontend renders all of them and **this query works correctly today**. It is
the cleanest proof of the ordering rule:

| Rank | SKU | `pack_type` | `relevance_score` | `match_tier` | color |
|---:|---|---|---:|---:|---|
| 1 | `GLC3333BK` | single | 196.54 | 2 | Black |
| 2 | `GLC3333C` | single | 196.54 | 2 | Cyan |
| 3 | `GLC3333M` | single | 196.54 | 2 | Magenta |
| 4 | `GLC3333Y` | single | 196.54 | 2 | Yellow |
| 5 | `CLC3333BK` | single | 196.54 | 2 | Black |
| 6 | `CLC3333C` | single | 196.54 | 2 | Cyan |
| 7 | `CLC3333M` | single | 196.54 | 2 | Magenta |
| 8 | `CLC3333Y` | single | 196.54 | 2 | Yellow |
| 9 | `GLC3333CMY` | value_pack | 185.99 | 2 | CMY |
| 10 | `CLC3333CMY` | value_pack | 185.99 | 2 | CMY |
| **11** | **`CLC3333KCMY`** | **value_pack** | **196.54** | **2** | KCMY |
| 12 | `GLC3333KCMY` | value_pack | 185.99 | 2 | KCMY |

`CLC3333KCMY` scores **196.54** — identical to the eight singles ranked above it — and is placed
11th, *below two rows scoring 185.99*. Within the pack block the order is not score-descending
either, so the pack block appears to be sorted by something else entirely and appended.

### 3c. Scope

| Query | Rows | Packs | First pack rank | Packs in top 40 |
|---|---:|---:|---:|---:|
| `lc` | 367 | 129 | 239 | **0** |
| `tn` | 212 | 66 | 147 | **0** |
| `pgi` | 2 | 0 | — | — |
| `cli` | 20 | 0 | — | — |
| `lc3333` | 12 | 4 | 9 | 4 |

---

## 4. Why this reaches the customer

The header typeahead's contract, for reference (`inkcartridges/js/search.js`):

| Constant | Line | Value |
|---|---|---|
| `ENDPOINT` | 37 | `/api/search/smart` |
| `LIMIT` | 42 | **40** |
| request | 174 | `?q=<query>&limit=40` |

**Page 1 only. The dropdown never paginates.** There is no "load more". So a row at rank 239 does
not exist as far as the customer is concerned.

The frontend applies no filtering of its own. `renderResults` (`search.js:415-712`) does
partition → sort → lookalike-mark → row-break insertion; every step is length-preserving, and the
file asserts it at `search.js:564-567`:

```js
// Length is unchanged — the partition and sort never drop a
// row — so `count` in the keyboard handler stays correct either way.
```

There is no `.filter()` on pack type or colour, no dedupe, and no per-group `.slice()` anywhere on
this path.

### The visible symptom

The dropdown lays each product family out on its own row in a 7-column grid. The LC3333 row is
**designed** to be six cards wide:

```
[ BK ] [ C ] [ M ] [ Y ] [ CMY 3-pack ] [ KCMY 4-pack ] [ empty ]
```

It currently paints four and leaves three columns blank. It was first reported to us as "the
search bar looks lop-sided". It is not a layout bug — **the row is two cards short.**

---

## 5. What we need

### P1 — required: stop using `pack_type` as a primary sort partition

Order results by `(match_tier, relevance_score)`. `pack_type` is fine as a **tiebreaker between
rows with equal scores**; it must not partition the result set.

**Minimal acceptable variant**, if reworking the ranker is too large right now: guarantee that
when a family's singles are inside the returned window, that family's packs are too. That alone
fixes the customer-visible bug.

> **You do not need to reorder packs for display.** The frontend already owns that and has since
> May 2026 — see §7. Just include them.

### P2 — `did_you_mean` must not name a product absent from `products[]`

Either return the row it names in page 1, or do not suggest it. A suggestion the customer cannot
click through to a visible card is worse than no suggestion.

### P3 — check whether one shared layer explains all three pack defects

This is the **third** value-pack drop we have measured on this backend. If they share a ranking or
filter layer, fixing it once closes all three:

| Where | Defect | Status |
|---|---|---|
| `/api/shop?source=compatible` | Drops `pack_type=value_pack` rows. 99 rows vs 106 from `/api/products` for PGI650; the 7 missing are KCMY/CMY packs (`CPGI650KCMY`, `CPGI670KCMY`, `CCLI671KCMY`, `CCLI681KCMY`, `CPGI520KCMY`, `CPGI525KCMY`, `CPGI5KCMY`). Verified 2026-05-11. | FE works around it with a `/api/products` sidecar — `inkcartridges/js/api.js`, find it with `grep -n "Sidecar fires against" inkcartridges/js/api.js`, scoped to `getShopData` only |
| `/api/shop?code=…` | Genuine value packs `GLC38CMY`, `GLC40CMY`, `G432KCMY` served by `/api/products` but not here | Open — `catalogue-pathway-backend-brief-aug2026.md:108-109` |
| `/api/search/smart` | **This brief.** Every pack de-ranked below every single | New |

`/api/search/smart` has no sidecar, so the dropdown has nothing to repair itself with.

---

## 6. Acceptance criteria

Each is independently checkable against the live API.

1. `GET /api/search/smart?q=lc&limit=40` page 1 contains **both** `CLC3333KCMY` and `CLC3333CMY`.
2. Across the **full** result set for `q` ∈ {`lc`, `tn`, `hp`, `brother`, `epson`}: no row with a
   worse `(match_tier, relevance_score)` outranks a row with a better one. In particular, no
   `single` with `match_tier: 3` outranks a `value_pack` with `match_tier: 2`.
3. `GET /api/search/smart?q=lc3333` still returns all 12 rows listed in §3b. **Regression guard —
   this query is correct today, do not break it.**
4. When `did_you_mean` is non-null, the product it names is present in `products[]` on page 1.
5. `pack_type` values are unchanged — still exactly `single` / `value_pack` / `multipack`.

---

## 7. Do NOT do these

- **Do not reorder packs for display.** The frontend owns family layout and has since May 2026.
  `ProductSort.colorOrder` (`inkcartridges/js/utils.js`, `grep -n "function colorOrder"`) ranks a CMY 3-pack **20** and a
  KCMY 4-pack **21**, immediately after the singles (0–17), with `packRank` as tiebreaker
  (`utils.js:984-992`). The documented intent (`utils.js:723-728`):

  > Why singles always rank below packs: customers shopping a series want to evaluate every
  > individual cartridge first, then decide whether the bundle is worthwhile.

  `ProductSort.familyKey` (`utils.js:1128`) already maps `CLC3333KCMY` and `CLC3333BK` to the same
  family. Send the rows in any order — they will land in the right place.

- **Do not change `pack_type` values.** `tri-colour-catalogue-BACKEND-tasks-aug2026.md` depends on
  the current vocabulary, and admin pack filters read it directly.

- **Do not propose raising the frontend's `limit`.** 40 is a deliberate constant sized to the
  panel (7 columns × the visible rows). Raising it to reach rank 239 would mean shipping ~10× the
  payload on every keystroke to work around a sort order.

- **Do not treat `q=lc3333` working as evidence the bug is fixed.** It works only because 12 < 40.
  Always verify against a query whose result set exceeds 40 rows.

---

## 8. Reference — where to look on the frontend side

For the backend CLI agent verifying our half without guessing.

> **Line numbers are as of 2026-09-06 and WILL drift** — this is an actively edited repo with
> several agents working in it concurrently, and `js/api.js` already shifted while this brief was
> being written. Each row gives a `grep` anchor; trust the anchor over the number.

| What | File · line (2026-09-06) | Anchor to grep for |
|---|---|---|
| Endpoint + `LIMIT = 40` + request build | `inkcartridges/js/search.js:37,42,174` | `const LIMIT = 40` |
| Response unpack (`products` vs `did_you_mean`) | `inkcartridges/js/search.js:200-207` | `did_you_mean: data.did_you_mean` |
| Render pipeline, length-preserving | `inkcartridges/js/search.js:415-712` | `function renderResults` |
| "Did you mean" row markup | `inkcartridges/js/search.js:487-492` | `smart-ac__top-row--dym` |
| Compatible/Genuine partition | `inkcartridges/js/search.js:513-515` | `isCompatibleProduct` |
| Family sort + row breaks | `inkcartridges/js/utils.js:1317-1356`, `1449-1483` | `function byCodeThenColor`, `function rowBreakIndices` |
| Pack ordering (20 = CMY, 21 = KCMY) | `inkcartridges/js/utils.js:1025-1057` | `function colorOrder` |
| `packRank` tiebreaker | `inkcartridges/js/utils.js:984-992` | `function packRank` |
| `familyKey` — packs share their singles' family | `inkcartridges/js/utils.js:1128-1254` | `function familyKey` |
| Existing `/api/shop` value-pack workaround | `inkcartridges/js/api.js` (drifting) | `Sidecar fires against` |
| 7-column dropdown grid | `inkcartridges/css/search.css:779-796` | `.smart-ac__grid` |

---

## 9. When it lands, tell us

Reply on this file or open a FE-response note. We will re-run §2 and, if P3 is covered, retire the
`getShopData` value-pack sidecar in the same pass.
