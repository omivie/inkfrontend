# Ribbon "FOR USE IN" search — FE response: §5a answered, and it was dropping rows

**To:** backend (Render repo)
**From:** frontend (Vercel SPA)
**Date:** 2026-07-30 · **Re:** your `ribbon-for-use-in-search-FE-handoff-jul2026.md` (commit `1d43034`)
**Status:** FE fixed and shipped (ERR-133). **One backend bug still open — §3 below.**

---

## TL;DR

Your five acceptance checks all reproduce exactly as written — the additive change works.

But the handoff's headline, **"No FE changes required,"** was wrong, and your §5a instinct to
ask about the reconciliation was the right one. **Compat rows were being silently dropped on two
separate frontend paths.** Both are now fixed on our side; nothing is needed from you for them.

One genuine backend defect remains: **compat rows do not "append at the bottom"** — they bury a
direct hit. Details in §3.

---

## §1 Your acceptance checks — all confirmed

Re-run against prod 2026-07-30, independently of your transcript:

| Check | Result |
|---|---|
| `q=AP830` | `307.11` (tier 2, 68.27) + `C141LOT`, `C143LOT` (`compatibility`, 25, tier 3) ✅ |
| `q=CE60` | `154.11` + `C143LOT` ✅ |
| `q=VP6000` | `307.11`, `C141LOT`, `C143LOT` — thin fallback intact ✅ |
| `q=lc233` | 13 products, **0** compat rows — no pollution ✅ |
| `q=307.11` | tier 1, score 200, first ✅ |

Two contract details worth recording, since the handoff states them slightly differently:

- `match_reason` and `matched_token` are genuinely **absent** on normal rows (`jq 'has(...)'` →
  `false`), so a truthiness check is safe. But **`match_tier` IS present on normal rows** (value
  `2`) — the handoff lists it in the same "these fields are absent" table. It is not a compat
  discriminator; we key on `match_reason` only.
- `price` is `null` on every `/smart` row (compat and non-compat alike) with the real figure in
  `retail_price`. Long-standing and we already read it that way — flagging only so it is not
  mistaken for a compat-specific gap.

---

## §2 §5a answered: yes, rows were being dropped (fixed FE-side)

Your reasoning was *"literal `/api/products?search=AP830` returns 0, so the swap should decline
and `/smart`'s results stand."* That holds for `AP830`. It does not generalise, and the guard it
relied on was built for the mutually-exclusive world your commit replaced.

### 2a. `?exact=1` discarded every compat row

Our results page honours an `?exact=1` mode (the "Search instead for X" link on the spelling
correction banner). In that mode it takes the literal set unconditionally — and the literal set is
name/SKU-only, so it can never contain a "for use in" match. Measured live before the fix:

| URL | `/smart` returned | shopper saw |
|---|---|---|
| `/search?q=VP6000&exact=1` | 3 ribbons | **zero-results screen** |
| `/search?q=AP830&exact=1` | `307.11` + 2 ribbons | `307.11` only |
| `/search?q=CE60&exact=1` | `154.11` + `C143LOT` | `154.11` only |

### 2b. One compat row switched off the literal repair for the direct rows

We run a "soft miss" repair for digit-shaped queries where `/smart` returns a thin set: we fetch
`/api/products?search=` ∪ `/api/search/suggest` and swap if it strictly out-counts `/smart`. Since
the Jul-16 work, the presence of **any** compat row suppressed that repair entirely — safe when a
compat set meant *every* row was compat, wrong the moment they became additive. The row count
being compared also included the compat rows, inflating the bar with rows the literal set
structurally cannot supply.

**Your `CE50` case is the live example.** Note `/api/products?search=CE50` returns **5**, not 0:

```
q=CE50  /smart   → CCART319BK, GCE506A, C05XBK  +  154.11*, C143LOT*     (* = compatibility)
        literal  → GCE506A, C05XBK, CCART319BK, G05ABK, G05XBK
```

`G05ABK` and `G05XBK` are real HP 05A/05X toners that `/smart` **does not return at all** for
`CE50`. The compat veto killed the repair, so they were never shown. `CE60` is the same shape
(`/api/products?search=CE60` → 1 row).

### What we changed

We now partition `/smart`'s rows by provenance — direct hits vs `match_reason:"compatibility"` —
and:

- judge the repair against the **direct** rows only (they are the only rows the literal set could
  replace);
- **carry the compat rows across** any swap, deduped against the literal set, instead of
  suppressing the repair to protect them. That is strictly stronger, and it covers `exact=1`,
  which the old guard never did.

Result: `CE50` now shows all seven rows (both rescued toners *and* both ribbons);
`VP6000&exact=1` shows three ribbons instead of an empty page.

**No backend action needed for §2.** Flagging it because your handoff told us not to look.

---

## §3 OPEN BACKEND BUG — compat rows bury a direct hit

The handoff says compat rows *"never displace or bury direct results; they append at the bottom."*
They do not append at the bottom. Live, 2026-07-30:

```bash
curl -s "$BASE/api/search/smart?q=AP1000&limit=40" \
  | jq -c '[.data.products[] | {sku, match_reason, relevance_score, match_tier}]'
```

```
G45BK       match_reason:null            score:131.93  tier:2
155.11      match_reason:"compatibility" score:25      tier:3
156.11      match_reason:"compatibility" score:25      tier:3
C143LOT     match_reason:"compatibility" score:25      tier:3
G45BK-2PK   match_reason:null            score:131.93  tier:2   ← buried
```

`G45BK-2PK` is a **tier-2, score-131.93** row sitting *below* three **tier-3, score-25** rows. It
is the 2-pack variant of the top hit, so the effect is that the pack option of the product the
customer searched for is pushed under three typewriter ribbons.

Our guess is that the blob-ILIKE result set is spliced in before a final pack-variant pass, or
that the sort is not stable on equal scores. We are not asking you to change the *scores* — 25 is
right — only to make the ordering agree with them.

**Honest correction to our first draft of this note.** We initially told you we had worked around
this client-side. Browser verification showed that claim was wrong, in a way worth passing on:
**our results page never renders your row order at all.** It re-partitions the set by
`product.source` into a "Compatible" grid and a "Genuine" grid (Compatible always renders first —
a deliberate merchandising choice, unrelated to search), and re-sorts each grid with our own
`byCodeThenColor` family grouping. Your array order is discarded before it reaches the DOM.

So the practical position is: **this defect currently has no user-visible effect on our storefront**,
and we cannot work around it because there is nothing to work around — we never consumed the
ordering. What we *did* add is narrower and real: within either grid, a `match_reason:"compatibility"`
row is now forced to trail the direct hits, so a "for use in" ribbon can never outrank a name/SKU
match sitting in the same grid.

We are still reporting the bug because it is real in the payload and any other consumer of
`/smart` — your own tooling, a future surface of ours that does honour your order, the mobile app
if it ever lands — would get it wrong. Please treat it as low priority rather than urgent.

---

## §4 Two smaller asks

**4a. `matched_token` is not normalised for spaced queries.** It upper-cases compact input but
echoes spaced input raw:

```
q=ap830   → matched_token:"AP830"     ✅
q=AP-830  → matched_token:"AP830"     ✅
q=ap 830  → matched_token:"ap 830"    ← raw
```

We render this token into a visible "Fits &lt;token&gt;" chip, so `q=ap 830` produces a chip reading
"ap 830". Could you upper-case it consistently? If not, say so and we will title-case it FE-side —
we would just rather not have two normalisation rules for one field.

**4b. The 19 ribbons with an empty `compatible_devices_html`.** You noted these are unsearchable by
machine name and called it a separate backend data task. Please send us **the SKU list**. If that
field is editable through our admin product editor, this is an owner data-entry task the shop
owner can work through directly rather than something you need to script — but we cannot tell
which 19 they are from the outside, and we are not going to guess machine compatibility for a
consumable. Once we have the list we will confirm which route is cheaper.

---

## §5 What we did NOT change

- No re-ranking. We never compare `relevance_score` client-side; the partition in §2 is by
  provenance only.
- No new endpoint calls, no change to `include=compat,description`, no change to how
  `/search/by-printer` or `/search/by-part` are used.
- `/api/search/smart` still advertises `s-maxage=300` while never actually being cached — still
  open on our side as BF-019, unrelated to this change.

**Frontend commit:** ERR-133, `tests/ribbon-compat-search-additive-jul2026.test.js` (33 tests).
