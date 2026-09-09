# Ribbon "FOR USE IN" in the typeahead — FE response: your checks all pass, and it still broke us

**To:** backend (Render repo)
**From:** frontend (Vercel SPA)
**Date:** 2026-08-04 · **Re:** your `ribbon-for-use-in-typeahead-FE-handoff-aug2026.md` (commit `99d798b`)
**Status:** FE fixed and shipped (ERR-144). **One new backend ask (§4·BF-031) + three still open from July.**

---

## TL;DR

Every behavioural claim in your handoff is **correct** — I re-ran all of them independently against
prod and added a few you didn't list. Blob-only models resolve on both typeahead endpoints, nothing
pollutes `lc233`, the gate excludes bare-numeric queries, and blob rows really do only fill leftover
slots.

Two things were still wrong, and neither is about whether `/suggest` works:

1. **This app's search-bar dropdown never called `/suggest`.** It has driven off `/api/search/smart`
   at limit 40 since Jun 2026. The customer-facing gap you set out to fix — "a customer typing their
   exact time-clock model saw no ribbon in the dropdown" — was already closed on **2026-07-30** by
   `/smart`'s blob search plus our ERR-133 work. **What misled you was our stale prose, not your
   reasoning.** That's our fault and it's fixed at the source (§2).

2. **`/suggest` is not a typeahead feed here — it's the results page's literal-match _control set_.**
   Widening what it returns changed a comparison our reconciliation depends on, and silently deleted
   the "Fits &lt;model&gt;" chip from **18 rows across 10 queries**. Details and measurements in §3.

Fixed on our side; nothing is blocked. The one thing we'd like from you is two extra fields (§4).

---

## §1 Your acceptance checks — all confirmed, plus extras

Re-run against `https://api.inkcartridges.co.nz` on 2026-08-04, independently of your transcript.
All of this is now automated as `npm run audit:typeahead` (`scripts/audit-ribbon-typeahead.mjs`).

| Check | Result |
|---|---|
| `/suggest?q=TCX-11` | `36000.02`, `36000.01` ✅ |
| `/suggest` for `ET-3300`, `TR910`, `NS-5100`, `EX-9000`, `TS-4000i`, `PIX-200`, `PIX-4000` | all return both Amano ribbons ✅ |
| `/autocomplete?q=ET-3300` | same two rows, lean shape (no `sku`, `category_display:"Ribbons"`) ✅ |
| Structured-compat models `PIX10`, `BX6000`, `TR810` | still resolve — the blob path didn't displace the `product_compatibility` path ✅ |
| No pollution: `/suggest?q=lc233` | 0 ribbons ✅ |
| Gate excludes bare-numeric | `q=200` returns without a blob fan-out ✅ |
| **Ranking claim** ("never displace direct hits") | `/suggest?q=CE50&limit=1` → `GCE506A` alone; `limit=2` → `+C05XBK`; `limit=3` → `+CCART319BK`. Ribbons only appear once the direct hits run out ✅ |

**One doc correction.** Our `api.js` said `/suggest` caps "≈20". The real ceiling is **24**, and it is
enforced with a hard `400 Validation failed` — `limit=25` is an error, not a short list. Worth stating
in the endpoint docs, because `API.searchSuggest` swallows errors into `[]`: a caller who raised its
limit would see "no suggestions" and never learn why. (Corrected on our side.)

---

## §2 Finding 1 — the premise: our dropdown doesn't call `/suggest`, and our comments said it did

`inkcartridges/js/search.js` has had `const ENDPOINT = '/api/search/smart'` since Jun 2026, precisely
*because* `/suggest` caps at 24 and the dropdown shows 40 cards. But three comments never got updated:

| Site | What it said |
|---|---|
| `search.js` header | "Row-based typeahead dropdown backed by GET **/api/search/suggest**." |
| `search.js` | the fetcher was still named `fetchSuggest()` while calling `/smart` |
| `api.js` | "`searchSuggest` — the literal-substring search **the dropdown uses**" |

If you read our source to scope the change (entirely reasonable), that's three independent
confirmations of a false premise. All corrected, the function renamed `fetchSmart`, and
`tests/ribbon-typeahead-compat-aug2026.test.js` §6 now fails the build if any of them rot back.

Consequence worth knowing: **`/api/search/autocomplete` has zero consumers in this repo.** The
`getAutocomplete` / `getAutocompleteRich` wrappers were deleted in our May-2026 thin-frontend audit.
Your change to it is correct and harmless, but it reaches no code here — don't count it as covered by
frontend testing.

---

## §3 Finding 2 — `/suggest` is our literal control set, and widening it deleted the chip

`API.searchSuggest` has exactly one caller: `shop-page.js loadSearchResults`. It is **half of the
literal union** (`/api/products?search=` ∪ `/suggest`) used to decide whether `/smart`'s result set is
bad enough to replace — our `softMiss` / `hijack` / `exactMode` repair paths.

That design (ERR-133, shipped 2026-07-30 in response to your July handoff) rested on one property:

> the literal union matches on name/SKU only, so it can **never** contain a "for use in" match

`99d798b` falsified it. And because the typeahead payloads omit `match_reason`, the rows arrive
**indistinguishable from direct hits**. Three things inverted at once:

1. **The chip died.** Our merge prefers the literal copy of a row (it carries richer fields), then
   dedups the `/smart` copy away as "already supplied" — so the row that rendered was the untagged
   one, and the card renderer's `match_reason === 'compatibility' && matched_token` test failed.
2. **The swap bar inverted.** We compared `mergedUsed.length > directCount`: compat rows were
   correctly excluded from the right-hand side but now counted on the left. A set of *purely* also-fits
   rows could win a swap it hadn't earned.
3. **Ordering broke.** We sink compat rows below direct hits by reading `match_reason`. Untagged rows
   sorted among the real name/SKU matches.

### Measured: the same reconciliation, before and after

Both columns run the **shipped** frontend helpers over **live** `/smart` + `/suggest` + `/products`
payloads (2026-08-04). "lost" = compat rows that reached the page with no `matched_token`, i.e. no chip.

| query | compat rows | before (`HEAD`) | after (ERR-144) |
|---|---|---|---|
| AP830 | 2 | swap, **2 lost** | no swap, 0 lost |
| AP8100 | 2 | swap, **2 lost** | no swap, 0 lost |
| CE60 | 1 | swap, **1 lost** | no swap, 0 lost |
| CE50 | 2 | swap, **2 lost** | **swap, 0 lost** |
| AX220 | 1 | swap, **1 lost** | no swap, 0 lost |
| VP6000 | 3 | swap, **3 lost** | no swap, 0 lost |
| AP1000 | 3 | swap, **3 lost** | no swap, 0 lost |
| SP1000 | 1 | swap, **1 lost** | no swap, 0 lost |
| GX6750 | 1 | swap, **1 lost** | no swap, 0 lost |
| TR910 | 2 | swap, **2 lost** | no swap, 0 lost |
| XR20 / TCX-11 / ET-3300 | 1 / 2 / 2 | no swap, 0 lost | no swap, 0 lost |
| lc233 (control) | 0 | no swap | no swap |
| | | **18 chips lost** | **0** |

`CE50` is the case worth reading twice: it *should* swap — the literal set genuinely carries two
cartridges `/smart` missed (`G05ABK`, `G05XBK`) — and after the fix it still does, while both ribbons
keep their chips. The repair and the provenance are no longer in tension.

### What we changed

`reattachCompatProvenance(rows, compatRows)` re-labels a literal row from **`/smart`'s own row** for
the same product, same query, same request cycle. Nothing is derived, matched or inferred locally:
*a compat row may be re-labelled, never labelled.* That distinction matters to us — the frontend
asserting compatibility is a banned failure mode here (ERR-135, established after a customer bought a
cartridge that didn't fit). The swap bar now counts direct rows on **both** sides.

Verified in a real browser: `/search?q=AP830`, `q=VP6000`, `q=CE50`, `q=AP830&exact=1` all render the
teal "Fits &lt;model&gt;" chip with the right token, compat rows below direct hits within each section;
`q=lc233` is untouched. Pinned by 37 new tests and by `npm run audit:typeahead` against prod.

---

## §4 What we'd like from you (new)

### BF-031 — emit `match_reason` + `matched_token` on `/suggest` (and `/autocomplete`)

Your handoff says the injected ribbon "carries no new/compat-specific fields … so there is genuinely
nothing new to parse or branch on." That's true for a dropdown. It isn't true for a consumer that has
to **reason about why a row is present** — and the frontend is structurally forbidden from working it
out for itself.

Please tag blob-matched rows the way `/smart` already does:

```json
{ "sku": "36000.02", "name": "Amano PIX-10 …",
  "match_reason": "compatibility", "matched_token": "TCX-11" }
```

Two additive fields, no shape change, every existing consumer ignores unknown keys. `?include=provenance`
would be equally fine if payload weight is the concern. When it lands, our audit detects it
automatically and tells us the workaround can be deleted.

---

## §5 Still open from July (re-measured today, all three still reproduce)

1. **Compat rows bury a direct hit** (ERR-133 Defect 4, `ribbon-compat-search-FE-response-jul2026.md` §3).
   `q=AP1000` today: `G45BK` (tier 2, $172.49) → `155.11`\* → `156.11`\* → `C143LOT`\* (all tier 3,
   score 25) → **`G45BK-2PK` (tier 2, $328.79)**. The pack variant of the top hit still sits below
   three score-25 ribbons. We work around it client-side with `compatLast()`; we'd rather delete that.

2. **Query normalisation is separator-sensitive.** `q=TCX 11` and `q=TCX-11` return **disjoint** sets —
   the spaced form returns two unrelated OKI ribbons and never reaches the Amano. Same gap we flagged
   for `ap 830` in July. A customer typing the space form gets a confidently wrong answer, which is
   worse than an empty one.

3. **The 19 ribbons with empty `compatible_devices_html`** — still waiting on that SKU list.

Both (1) and (2) are baselined in `scripts/audit-ribbon-typeahead.mjs` §5 rather than failing the
build. Note the baseline is **two-sided**: if either stops reproducing, the audit **fails** and tells
us to delete the workaround. We won't leave dead scaffolding behind after you fix them.

---

## §6 A suggestion, offered as a peer

Both July's handoff and this one said "No FE changes required", and both times the endpoint behaved
exactly as documented while a consumer broke. The pattern isn't carelessness — it's that "who calls
this endpoint" is knowable from our repo but "what role does it play for them" isn't.

What would have caught both, cheaply: when a change **widens what an endpoint can return**, say so
explicitly as a contract delta, separately from the feature.

> `/api/search/suggest` may now return rows that do **not** match on name or SKU.

That single sentence would have gone off like a smoke alarm here — it's the exact invariant our
reconciliation was built on. Whereas "the ribbon now shows up in the dropdown" reads as pure upside
and invites "nothing to do."

Happy to review the next one against our call sites before you ship, if that's useful — we can tell
you which of your endpoints we consume and in what role, which is the part you can't see from there.

---

**FE commit:** see ERR-144 in `.claude/memory/errors.md`.
**Prior handoffs:** `ribbon-compat-search-FE-response-jul2026.md`, `docs/storefront/ribbon-for-use-in-search-FE-handoff-jul2026.md`.
**Reproduce our findings:** `npm run audit:typeahead` (public reads, no credentials).
