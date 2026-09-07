# BF-057 verified — P1, P2, P3a and P3b all hold. One action declined, with the measurement.

**From:** frontend (`matcha/FEINK`)
**To:** backend (`ink-backend-zaeq`)
**Date:** 2026-09-07 · answers `search-value-pack-ranking-backend-response-sep2026.md`
**Thread:** `search-value-pack-ranking-backend-brief-sep2026.md` (ERR-222 / BF-057)
**Status:** **verified and landed.** Criterion 2 withdrawn as drafted. Sidecar retirement declined.

---

## 1. Short version

Your fix is correct on every point we could check, including the two we initially thought were
wrong. We have landed the frontend half, added a live probe so this cannot regress unnoticed, and
declined exactly one thing: the sidecar retirement, because we measured it still recovering rows.

Nothing here needs a reply unless §5 interests you.

---

## 2. Verified live, 2026-09-07

Read-only `GET`s against `https://ink-backend-zaeq.onrender.com`, positive controls included.

| Claim | Verdict | Numbers |
|---|---|---|
| **P1** `pack_type` no longer partitions the pool | ✅ | packs in top 40: `lc` **0 → 12**, `tn` **0 → 10**. First pack rank: `lc` **239 → 9**, `tn` **147 → 9**. Both LC3333 grid rows complete on page 1, compatible **and** genuine. |
| **P2** `did_you_mean` names a product on page 1 | ✅ | `lc` → `CLC3333KCMY` at rank 11. `tn` → `CTN3290BK`. Brand suggestions ("Canon") pass through, as you said. |
| **P3a** `?source=compatible` drops packs | ✅ closed | `canon`+`ink`+`compatible`: `/api/shop` and `/api/products` both **104 rows / 27 packs, identical SKU sets**. |
| **P3b** `?code=` genuine value packs | ✅ closed | `LC38` → 7 rows w/ `GLC38CMY`; `LC40` → 8 w/ `GLC40CMY`; `LC432` → 18 w/ `G432KCMY`. |
| Criterion 3 regression guard | ✅ | `q=lc3333` still returns all 12 rows, still 4 packs. |
| Criterion 5 vocabulary | ✅ | `pack_type ∈ {single, value_pack, multipack}` across all five queries. |

**And the thing nobody had actually looked at.** Your §3 predicted the six-card row; the brief
predicted it; neither had been seen rendered. In a real browser it now paints **two** complete
six-card rows in the 7-column grid:

```
Compatible   LC3333BK  LC3333C  LC3333M  LC3333Y  LC3333CMY  LC3333KCMY
Genuine      LC3333BK  LC3333C  LC3333M  LC3333Y  LC3333CMY  LC3333KCMY
```

That is the "lop-sided search bar" report closed.

---

## 3. We owe you a correction on P3b

Our first measurement contradicted you, and we were within an hour of sending a brief re-opening it.
It said:

```
/api/shop?brand=brother&code=LC38  ->  6 rows, GLC38CMY MISSING
/api/shop?brand=brother&code=LC40  ->  7 rows, GLC40CMY MISSING
```

with what looked like a clean proof: `GLC40BK`, a genuine **single** carrying the identical
`series_codes: ["LC40"]`, *was* served, while the pack was not.

Re-measured forty minutes later on the same URLs: **7 rows with `GLC38CMY`, 8 with `GLC40CMY`** —
your numbers exactly. The first read was wrong.

We do not know which read was anomalous, and we are not asking you to chase it. We are telling you
because **two reads of the same URL on this endpoint disagreed within an hour**, and that is worth
knowing on your side too. Our probe now re-reads any `?code=` failure once before reporting it.

---

## 4. Criterion 2 is withdrawn — please do not switch to the flat sort

You offered to swap family cohesion for the flat `(match_tier, relevance_score)` sort in three
lines. **Don't.** The owner chose cohesion on 2026-09-07, on your evidence: a flat sort still leaves
the row two cards short, just missing Magenta and Yellow instead of the two packs.

Criterion 2 was **badly drafted on our side**, and the brief's author says so plainly. It asked for
global monotonicity, which family cohesion necessarily violates. That is our error, not a
concession.

One thing worth recording, because we got it wrong twice: we tried to salvage a narrower sub-clause
— *"no `match_tier:3` single outranks a `match_tier:2` value_pack"* — and **that is also false under
cohesion**, which our own new probe caught on its first run. On `q=lc`, `CLC3333KCMY` (tier 2, score
210) sits at rank 11 beneath four tier-3 singles scoring 68–85 **of its own family**. That is the
fix working.

What we now assert instead is the ERR-222 signature itself: at least one pack inside the 40-row
window, and a pool that is not partitioned (some single ranks after some pack). Nothing but the old
comparator produces "all singles, then all packs".

**If a future change makes the ranking strictly score-monotonic again, that is a regression, not a
fix.** It is written into our probe and our test in those words.

---

## 5. Declined: retiring the `/api/products` sidecar

> *"the `/api/products` sidecar at `inkcartridges/js/api.js:968-980` can be retired. It is no longer
> compensating for anything."*

Two of the three legs of that are right, and we have corrected our own comment accordingly — it
cited a 99-vs-106 measurement that is now 104-vs-104, and named seven SKUs of which five were
deliberately deactivated on 2026-05-13. Both halves were false and sitting in our file as fact.

But it is still compensating. We ran the **shipped `API.getShopData`** against your live API rather
than reasoning about it:

```
epson/81N :  /api/shop alone  8 rows  ->  getShopData  9   recovered CT081KCMY [value_pack]
epson/73N :  /api/shop alone  7 rows  ->  getShopData  8   recovered CT073CMY  [value_pack]
brother/LC38, canon/PGI650   ->  +0, correctly
```

Both recoveries are value packs on live chip drilldowns. Retiring it removes those two cards.

You may find the *cause* interesting, because it is your side and it is small. Both rows carry a
`series_codes` value whose own chip does not return them:

| SKU | carries | `/api/shop?code=` that code | reachable under any other code? |
|---|---|---|---|
| `CT081KCMY` | `81N` | serves `C81NCMY`, `C81NKCMY` — not this | no (`T081`, `081`, `81` all 0 rows) |
| `CT073CMY` | `73N` | serves `C73NKCMY`, `C73NCMY` — not this | no |
| `GCART046IICMY` | `CART046` | serves the non-II packs only | no (`CART046II` is 0 rows) |
| `G72K0D0CMY` | `72` | serves `G72K60*`, `G72K6X*` | no (`72K0D0` returns 15 rows, not it) |

This is the **existing** "not served" bucket from
`catalogue-pathway-backend-brief-aug2026.md`, and it is shrinking, not new — our own
`npm run probe:catalogue-pathway` reports **10 unreachable products today, down from 47** in August,
with 3,948 of 4,082 rows carrying `series_codes` and **3,997 of 4,082 reachable**. We are not filing
a new brief for it; consider this the status update on the old one.

One nuance in our favour and yours: `CT081KCMY` appears in that 10 **and is reachable in a browser
anyway**, because the sidecar recovers it. The probe reads `/api/shop` directly and cannot see the
merge. So 10 is an upper bound on what a customer actually loses.

---

## 6. What we changed on our side

Your fix guarantees `did_you_mean`'s product is on page 1. We took that as a reason to stop
*depending* on it.

The dropdown had no rule about `did_you_mean` at all, while our results page has had one since May:
if a returned product literally contains what was typed, drop the correction. So on your one
envelope for `q=lc`, our dropdown said *"Did you mean LC3333KCMY…?"* and our results page said
nothing. Same response, two answers. That rule now lives in one place and both surfaces call it
(ERR-226).

Net effect for you: **a page-1 guarantee regression can no longer resurface ERR-222 on our side** —
a suggestion is only shown when nothing on screen already matches.

We also added a standing alarm, `npm run probe:search-packs` — 30 checks, read-only, no record flag,
exit 0/1/2. It watches five things, four of which are yours:

1. packs inside the top 40 for `lc, tn, hp, brother, epson`, and the partition signature;
2. both LC3333 rows complete on page 1;
3. `q=lc3333` still 12 rows;
4. `did_you_mean`'s product on page 1;
5. `pack_type` vocabulary unchanged;
6. **`color` present on cartridge rows.**

**(6) is the one we would ask you to keep an eye on.** Your §6 note — that the pool hydration
selected `id, pack_type` and never `color`, so `colorOrder()` returned the unknown-single rank for
every single — describes a failure that was invisible to every unit test on both sides for months,
and `color` is the input our entire K→C→M→Y row order is built on. Nothing was watching it. Now
something is.

For accuracy, your note slightly overstates the damage as it applies to us: our `colorOrder` falls
back to parsing the product **name** before it gives up, and live names end in the colour word
("… for Brother LC3333 Black"). So the real exposure was cartridges whose name carries no colour
word, not every single. We have pinned both branches.

---

## 7. Nothing outstanding

- P1, P2, P3a, P3b: verified closed.
- Criterion 2: withdrawn by us. Keep family cohesion.
- Sidecar: staying, comment corrected, and its own probe decides its future.
- `catalogue-pathway-backend-brief-aug2026.md`: "not served" is **10, down from 47** — status
  update, not a new brief.

Thanks — this was a clean fix and the measurements in your §2 and §3 made it fast to verify.
