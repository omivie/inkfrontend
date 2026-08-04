# Errors Log — InkCartridges.co.nz

Log every error encountered here. Before editing a file, scan for known issues. When a familiar error reappears, apply the known fix immediately.

## Numbering — read before allocating an ERR number

There are **two** error logs, and they are one log with two audiences:

| File | Audience | Committed? |
|---|---|---|
| `errors.md` (this file) | narrative postmortems, for humans | **yes** |
| `.claude/memory/errors.md` | compact agent-facing index | **no** — `.claude/` is gitignored, local only |

**ERR-113 … ERR-123 are AMBIGUOUS.** The two files were numbered independently through that
range, so the same number means different incidents depending on which file you read:

- `ERR-119` = "dashboard reload had no visible signal" (memory) vs "order line-items table
  invisible" (here).
- `ERR-120` = "bulk delete offered on orders the backend refuses" (memory) vs "no admin surface
  for page copy" (here).
- `ERR-113`–`ERR-118` exist only here; `ERR-121`–`ERR-123` exist only in memory.

**Never cite a number in that range without naming the file.** History is deliberately NOT
renumbered: source comments reference ERR numbers directly (`js/account.js`, `js/legal-config.js`,
`js/cart.js`, several tests), and renumbering would silently rot every one of them.

**One further historical collision, also not renumbered: `ERR-035` is used twice in this file**,
for two unrelated incidents on the same day — the admin analytics `42501 permission denied for
function` grant outage (line ~1437) and clean-URL 404s in local dev (line ~1702). Cite it by
description, not by number alone. It is left as-is for the same reason as the fork above.

**From ERR-124 onward there is ONE shared allocator.** A new entry takes the next number unused
in *both* files and is written to *both* under the same number and the same title. ERR-124 and
ERR-125 are transitional (124 is in both with different wording; 125 was written to the memory log
only), so automated enforcement starts at **ERR-126**, the first pair authored together.

`tests/err-numbering-jul2026.test.js` enforces what it portably can: no reuse of a number from
ERR-126 onward, that this preamble still exists, and — only when the local memory log is present,
since `.claude/` is gitignored and absent in a fresh clone — that ERR-126+ appears in both files
describing the same incident.

---

## ERR-144 — `/api/search/suggest` was never our dropdown, it was our results-page control set, so widening it silently deleted the "Fits &lt;model&gt;" chip (2026-08-04)

**The claim.** `ribbon-for-use-in-typeahead-FE-handoff-aug2026.md` (backend `99d798b`): the ribbon
"FOR USE IN" blob (`compatible_devices_html`) is now searchable on `/api/search/suggest` **and**
`/api/search/autocomplete`, so a customer typing their time-clock model finally sees the ribbon in the
search-bar dropdown, not just after pressing Enter. "Response contracts are **unchanged**. Nothing to
build." Second consecutive handoff on this feature to say no FE changes were required; second one to
be wrong, in a completely different way.

**Everything it asserts about the backend is true.** Re-run independently against prod 2026-08-04:
`TCX-11`, `ET-3300`, `TR910`, `NS-5100`, `EX-9000`, `TS-4000i`, `PIX-200`, `PIX-4000` all return
`36000.01`/`36000.02` from `/suggest`; `/autocomplete` agrees in its lean shape; `lc233` stays
ribbon-free; the bare-numeric gate holds; and the ranking claim survives a probe the handoff didn't
run — `/suggest?q=CE50&limit=1` returns `GCE506A` alone, so blob rows really do only fill leftover
slots. The defect was never in the endpoint.

### Finding 1 — our dropdown does not call `/suggest`, and three of our own comments said it did

`search.js` has had `const ENDPOINT = '/api/search/smart'` since Jun 2026 — `/suggest` caps at 24 and
the dropdown shows 40 cards. So the customer-facing gap the handoff set out to close **was already
closed on 2026-07-30**, by `/smart`'s blob search plus the ERR-133 frontend work. What survived was
the prose: the file header said "backed by GET /api/search/suggest", the fetcher was still named
`fetchSuggest()` while calling `/smart`, and `api.js` described `searchSuggest` as "the literal
substring search **the dropdown uses**". Anyone scoping a change by reading our source got three
independent confirmations of a false premise. **A stale comment is not a cosmetic defect when it is
load-bearing for someone else's planning.**

### Finding 2 — `/suggest` is this app's literal-match CONTROL SET, and widening it deleted the chip

`API.searchSuggest` has exactly one caller: `shop-page.js loadSearchResults`, where it forms half the
literal union (`/api/products?search=` ∪ `/suggest`) that decides whether `/smart`'s set should be
replaced (`softMiss` / `hijack` / `exactMode`). ERR-133's whole design rested on a property that
`99d798b` falsified — stated verbatim in the code and in the test file:

> the literal union matches on name/SKU only, so it can NEVER contain a "for use in" match

It can now. And because the typeahead payloads deliberately omit `match_reason`/`matched_token`, those
rows arrive **indistinguishable from direct hits**. Four consequences, all at once:

1. **The chip died.** `mergeLiteralResults` prefers the literal copy (richer fields);
   `rowsNotAlreadyIn(compatRows, mergedUsed)` then sees the row as already supplied and re-appends
   nothing; the rendered row carries no `match_reason`, so `createProductCard`'s
   `match_reason === 'compatibility' && matched_token` test fails and the teal "Fits &lt;model&gt;"
   chip vanishes. This is ERR-133 Defect 3 — "the dropdown showed compat ribbons with no explanation"
   — reopened through a door that did not exist when it was fixed.
2. **The swap bar inverted.** `mergedUsed.length > directCount` excluded compat rows from the
   right-hand side but counted them on the left. Mirror image of the original CE50 bug.
3. **Ordering broke.** `compatLast` keys on `match_reason`, so untagged rows sorted among real hits.
4. **The pager gate went trivially true** (`preservedCompat.length === 0`), which could restore a
   pager over a curated page whose rows `fallback.meta.total` never counted — the ERR-113 cross-field
   contradiction.

**Measured — the shipped helpers, live payloads, before vs after** (`lost` = compat rows reaching the
page with no `matched_token`):

| query | compat | before (`HEAD`) | after |
|---|---|---|---|
| AP830 / AP8100 | 2 / 2 | swap, 2 lost / 2 lost | no swap, 0 / 0 |
| VP6000 / AP1000 | 3 / 3 | swap, 3 lost / 3 lost | no swap, 0 / 0 |
| CE60 / AX220 / SP1000 / GX6750 | 1 each | swap, 1 lost each | no swap, 0 |
| TR910 | 2 | swap, 2 lost | no swap, 0 |
| **CE50** | 2 | swap, **2 lost** | **swap, 0 lost** |
| XR20 / TCX-11 / ET-3300 / lc233 | 1/2/2/0 | no swap, 0 lost | no swap, 0 lost |
| | | **18 chips lost** | **0** |

`CE50` is the one to read twice: it *should* swap (the literal set really does carry `G05ABK` +
`G05XBK`, which `/smart` missed) and after the fix it still does, with both ribbons keeping their
chips. The repair and the provenance stopped being in tension.

**The fix.** `reattachCompatProvenance(rows, compatRows)` (js/shop-page.js) re-labels a literal row
from `/smart`'s OWN row — same product, same query, same request cycle. Nothing is derived, matched or
inferred locally, which is what keeps it on the right side of ERR-135: **a compat row may be
RE-labelled, never labelled.** Identity goes through the existing `productIdentityKeys` (no fourth
notion of "same product"). Pure, order-preserving, non-mutating, idempotent. Wired in after the digit
on-topic filter and before the swap decision; the bar became `mergedSplit.direct.length > directCount`
(direct on both sides); the pager gate became "is any compat row on this page". `rowsNotAlreadyIn`
stays — the two mechanisms cover different rows (re-attach for rows the union supplied, re-append for
rows it didn't) and dropping either loses chips on a different corpus.

**Two source-pin tests had frozen the bug in place** — `product-surface-consistency-may2026` and
`ribbon-compat-search-additive-jul2026` §3 both pinned the literal string `mergedUsed.length >
directCount`. Re-pinned to the invariant (direct-vs-direct, whatever its expression) plus an explicit
`doesNotMatch` on the old form. ERR-053's lesson, hit again: **pin the invariant, not the line, when
the line embodies behaviour.**

**Fixed alongside (found while tracing the dropdown, unrelated to the handoff).**
(a) *Arrow-key + Enter opened the wrong product.* `state.results` held the raw API array while cards
were painted after the compatible/genuine partition **and** `byCodeThenColor` — reordered on
essentially every query. `setActive(i)` highlighted DOM card `i` while Enter navigated to
`state.results[i]`. Silent, because nothing is filtered out so the *count* stayed right and only the
identity was wrong; a customer could land on and buy the wrong cartridge. `renderResults` now records
the painted order as it emits each card. (b) *A dead highlight selector.* `[data-sku-text]` matched
zero elements on every render — `Products.renderCard` exposes the SKU only as a `data-sku` attribute
and the card has no SKU text node at all. Removed rather than faked: adding a visible SKU line would
change every product card site-wide, and product names already embed their code so a SKU-shaped query
highlights inside the title.

**Verified.** 37 new tests (`tests/ribbon-typeahead-compat-aug2026.test.js`); full suite 3617/0 vs a
3580/0 baseline at `c34cd56`. New live audit `npm run audit:typeahead` — 43 checks green against prod,
7 backend findings baselined. Real browser (isolated Chromium, local dev + prod API):
`/search?q=AP830`, `q=VP6000`, `q=CE50`, `q=AP830&exact=1` render the chip with the correct token,
compat rows below direct hits **within each section** (`compatLast` is per-section — Compatible was
`CCART319BK → C05XBK → C143LOT* → 154.11*`, Genuine was `G05ABK → G05XBK → GCE506A`); `q=lc233`
untouched; dropdown `TCX-11` shows both Amano ribbons chipped and visible (the scoped
`.smart-ac__grid` CSS exception still works), and 3×ArrowDown + Enter lands on the highlighted card.

**Watch out for.** `/api/search/autocomplete` has **zero** consumers in this repo — the backend
widened it too, and it reaches no code here. `/suggest` caps at **24**, enforced with a hard
`400 Validation failed` (not a silent truncation), and `API.searchSuggest` swallows that into `[]` —
so a caller that raises its limit sees "no suggestions" and never learns why. Our own first
measurement of this got it wrong by parsing an error envelope as "0 rows", which is precisely the
absence-as-zero mistake the fail-soft rule exists to prevent; the audit now asserts the 400 explicitly.

**Backend asks.** BF-031 — emit `match_reason`/`matched_token` on `/suggest` + `/autocomplete`, which
retires the FE workaround entirely (the frontend cannot label these rows itself; ERR-135 forbids it).
Still open from July and re-measured today: compat rows still bury a direct hit (`q=AP1000`:
`G45BK` → three tier-3 rows → `G45BK-2PK`), query normalisation is still separator-sensitive
(`TCX 11` and `TCX-11` return disjoint sets), and the 19 empty-`compatible_devices_html` SKUs are
still unlisted. All written up in `ribbon-typeahead-FE-response-aug2026.md`; the first two are
baselined **two-sided** in the audit, so if the backend fixes them the audit FAILS and tells us to
delete the workaround.

**Lesson.** When a backend widens what an endpoint may return, every consumer that relied on the
endpoint's *narrowness* breaks silently — and those consumers are invisible to the endpoint's author,
because the breakage is not in the payload but in the **role** the payload plays. Search for consumers
by role, not by name: `/suggest` was our control set, not our typeahead, and the word "suggest" in
three of our own comments is what hid that from everyone, us included. A handoff that widens a
contract should say so as a contract delta — "this endpoint may now return rows that do not match on
name or SKU" — separately from the feature it enables.

---

## ERR-143 — A tri-colour handoff asked us to verify a swatch the storefront is forbidden to paint, and the one real defect was a yield regex nobody was looking at (2026-08-03)

**The claim.** `tricolour-catalogue-corrections-FE-handoff-aug2026.md`: six products had their
`color` corrected; "**Nothing to code.** Purge caches for the affected pages and eyeball the
swatches." Three action items: purge caches, verify the CMY 3-stripe renders for all 6 SKUs, and
spot-check `G804CLR` shows "the GENUINE tile fallback".

**Two of the three describe states the code exists to prevent.** All six SKUs are *genuine*, and the
storefront deliberately never paints a colour tile on a genuine row — the genuine-no-colour-tile
invariant, enforced across seven render surfaces, because a striped tile is the visual language of a
**compatible** cartridge and painting one on a genuine product misrepresents the brand. So there is
no swatch to verify and there must not be. There is also no "GENUINE tile" artefact: `image_url =
NULL` on a genuine row yields the neutral `placeholder-product.svg`. And there is no colour facet on
the storefront at all (`filters.js` gates on `.shop-layout`, which no page renders), so the handoff's
"colour-facet filtering now shows Tri-Colour" had no surface to be true on.

**The flip itself was inert.** `ProductColors.map` has always mapped `'colour'` and `'tri-colour'` to
the byte-identical gradient and `COLOR_RANK` ranked both 11. Five of the six rows changed nothing but
a text label. Verified by executing the shipped `utils.js`, not by reading it.

**The one real FE defect was in neither list.** `familyKey` PRIORITY-0 carried its own yield grammar,
`/^([A-Z]+\d+)(XXL|XL|HY|H)([A-Z]*)$/` — a second, subtly different vocabulary from
`SeriesCodes.YIELD_SUFFIX` (`[A-Z]*\d+`), 500 lines below it **in the same file**, whose own comment
says it "covers 200/604/812 (Epson bare-numeric)". `[A-Z]+` required a letter before the digits, so
bare-numeric codes never collapsed: `804XL` stayed `804XL` while `LC133XL` became `LC133`. Latent
today only because the backend currently ships pre-collapsed `series_codes`; `api.js`'s
`_enrichSeriesCodes` fallback emits the uncollapsed form.

**The obvious fix was a regression, and only a measurement caught it.** Widening `[A-Z]+` to
`[A-Z]*` looks like a one-character typo repair. Replayed over all **1,350** distinct `series_codes`
live that day, it collapses **zero** codes correctly and **mangles three** — `34217HR → 34217R`,
`64017HR → 64017R`, `64080HW → 64080W`, all real Lexmark SKUs — because the `H` branch starts eating
letters out of a bare-numeric body. Delegating to `SeriesCodes.collapseYieldSuffix` was **zero-diff
across all 1,350** while fixing the bare-numeric class. Both directions are now pinned by name.

**The invariant itself had a hole, on the one path nobody had tested.** All three card renderers
emitted a hidden `product-card__color-block` beside any image, gated on the colour alone and never on
source, with `data-fallback="color-block"` — and the image `error` handler reveals it. So a *genuine*
product whose image 404'd swapped itself for a striped compatible-style tile. Every existing test
covered `image_url: null`; none covered *"the image failed to load"*, and the optimizer proxy
rate-limits under load, so this was live rather than theoretical. Now gated on source in
`products.js`, `shop-page.js` and `product-detail-page.js`, with a test asserting all three.

**Three private colour maps had quietly forked the vocabulary.** `shop-page.js` `loadColorPacks`,
`admin/pages/cc2-packs.js` `COLOR_DOT`, and `order-detail-page.js` `getColorPlaceholder` each carried
their own colour→hex table; all three were PascalCase-keyed or name-derived and blind to
`Tri-Colour`, and one interpolated a `color_hex` **array** straight into CSS
(`background:#a,#b` — invalid, paints nothing). Same shape as ERR-075 / ERR-129 / ERR-135. A dead
`isValuePack()` with zero call sites was deleted too: it classified `color === 'colour'` and any name
containing `' pack'` as a pack, so it would have relabelled all 35 live tri-colour SINGLES the day
anyone wired it up.

**Eleven backend data defects, found by sweeping rather than reading.** The handoff fixed 5 of 13
mislabelled rows. Also: `GPG510CLR-2PK` is the *exact* flattening the handoff says it **rejected** for
PG640 — already shipped, a 2-pack stored as `pack_type: "single"`; `GPG640VPVP` and `GPG640CLR-2PK`
are byte-identical product names at **$121.99 vs $93.99**; a fuser kit is tagged `Colour` with
`series_codes: ["220V"]` (a voltage parsed as a product code); and `/api/products` serves 3,969 rows
while `meta.total` claims 3,976. All in `tri-colour-catalogue-BACKEND-tasks-aug2026.md`.

**The fix is a machine, not a memory.** `npm run audit:colours` sweeps the catalogue against the
shipped vocabulary and fails on new drift. Its baseline record also fails when a recorded finding
**stops** tripping — a record that can only go green-to-red rots exactly the way ERR-140's literals
did.

**Lessons.**
1. *When two near-identical regexes exist, delete one — do not tune it.* And run the candidate over
   the whole live key space before believing a one-character diff.
2. A handoff that says "nothing to code" is a claim about our code, made by someone who cannot see
   it. Verifying it is cheap; the two things it got wrong were both invariants we had deliberately
   built and it had no way to know about.
3. Eyeballing six rows finds six rows. Sweeping 3,969 found eleven defects, including two the handoff
   believed it had prevented.

---

## ERR-142 — An invoice can never reach a customer's Business Centre, because no client can name the account (2026-08-03)

**The claim.** `business-centre-backend-response-aug2026.md` §A2: invoices will be empty "until an
operator opens the admin invoice editor and sets the contact-picker link on that customer's
invoices". Rendered as a reassurance — not a bug, just an unperformed step.

**That step does not exist, and could not be performed.** `grep -rn "business_account_id\|po_number"
inkcartridges/js/admin/` returns **zero matches**. `buildPayload()` never sent either field, and the
"Fill details from" picker (`loadFromContact`/`loadFromCustomer`) copies a contact's text and throws
its `id` away — it is a copier, not a linker. So every invoice the admin tool has ever written
carries `business_account_id = NULL`.

**Building the picker did not fix it, because the id is not obtainable.** Verified against
production with the live approved account:

| Attempt | Result |
|---|---|
| `business_account_id` = `business_applications.id` | `500` — `violates foreign key constraint standalone_invoices_business_account_id_fkey` |
| `business_account_id` = `user_id` | `500` — same FK violation |
| `GET /api/admin/business-accounts` | `404` |
| `GET /api/admin/business/accounts` | `404` |
| `/api/business/status`, `/account/summary`, `/admin/business-applications` (list + detail) | `200`, and **none of them carries the account id** |

`business_accounts` is a table distinct from `business_applications`, and **nothing exposes its
primary key**. The one value that puts an invoice on a portal is unreachable from every client we
have. This is a backend gap, not a frontend omission, and no amount of admin UI can close it.

**A second bug fell out of testing the first.** `POST /api/admin/invoices` is **not atomic**: a
payload whose `business_account_id` fails the FK returns `500 INTERNAL_ERROR` *after* inserting the
invoice row. Two orphans (`3269`, `3270`) were created by two failed calls and had to be deleted by
hand. A create that reports failure and leaves a numbered tax document behind is worse than either
outcome on its own.

**What shipped anyway, and why it is not a workaround.** `business_account_id` and `po_number` are
now in the draft model, `draftFromInvoice()` and `buildPayload()`. That is worth doing on its own
merits: `setStatusViaFullUpdate()` rehydrates a record by walking `Object.keys(payload)` and
`documentDrift()` diffs the same key set, so **a field absent from the payload is invisible to
both**. While `business_account_id` was missing, the first flick of the Paid toggle on a
server-linked invoice would have silently dropped the link and removed the invoice from the
customer's portal, with no symptom anywhere. The editor also now states the link in words — "Linked
to Acme Ltd" or "**Not linked** — this invoice will not appear on any customer's Business Centre" —
because an unlinked invoice has no other visible symptom, which is exactly the diagnosis problem
the backend brief §7 flagged as a follow-on.

**The one backend ask**, in `business-centre-FE-response-aug2026.md`: expose `business_accounts.id`
(a `GET /api/admin/business-accounts` list, or the id on the existing applications payload). The
picker is built and fails soft-and-loud until that lands; it needs no further frontend work.

---

## ERR-141 — Verifying one backend note found six ways the Business Centre stated things it did not know (2026-08-03)

**The trigger.** `business-centre-backend-response-aug2026.md` said "Nothing for you to build" —
all six endpoints live. Every endpoint was live, and the shapes matched. Verifying it anyway, with
a real token against production, turned up six defects. Five were already there; one was *created*
by the note.

**1. The note made existing copy false.** §B/§1: waived shipping is **omitted** from
`other_savings` — the backend can't reconstruct it and leaves it out rather than guessing. The
chart legend still read "Coupons, loyalty **& shipping**", and the tile sub-line "Plus $X from
coupons, loyalty **and shipping**". The page was naming a saving the data no longer contained. Now
"Coupons & loyalty".

**2. Two loaders fought over the same three tiles.** `saved` and `spend` come from
`/analytics/series`; `outstanding` comes from `/account/summary`. They run under `allSettled`, and
`loadSummary()`'s failure path wrote `'—' / 'Unavailable just now'` into **all three**. Whichever
call lost the race won the tile: a summary 500 arriving after a good series response replaced two
correct lifetime figures with "Unavailable". Each loader now owns only its own tiles, on failure
as well as success.

**3. Absence was rendered as a confident zero.** `Number(d.overdue_invoice_count) || 0` maps `null`
to `0`, so an unreported count printed "**Nothing outstanding**" — a claim manufactured out of
missing data, and a direct contradiction whenever `outstanding_balance` was itself rendering `—`.
Guarded on `Number.isFinite` (ERR-063/068/073/075/076 family, again).

**4. A brand-new account was shown a chart.** Verified live: an account with no orders gets twelve
buckets of **real `0`s**, not nulls. `.filter(p => p.v !== null)` keeps every one, so `SavingsChart`
drew a flat line pinned to the axis and `#savings-empty` never appeared. A flat line at zero looks
like a measurement. `coverage.orders_counted === 0` is the backend saying it measured and found
nothing, and that is the empty state's job. An account that *has* ordered but saved nothing keeps
its flat line — that one is a genuine result.

**5. The invoice list silently capped at 50.** `?limit=50`, everything rendered, no pager, and
`pagination` returned and ignored. A customer with 128 invoices saw 50 and no indication there were
more. Now paged at 20 with "Showing 20 of 128" and Load more — a cap that announces itself is not a
cap.

**6. A substituted document arrived in silence.** `BusinessInvoicePdf.download()` already returned
`{ok:true, source:'generated'}` when it fell back to a local re-render, and `wirePdf()` showed a
note **only** when `!out.ok`. So the one case the whole narrow-fallback design exists to make
honest — you are getting a reproduction, not the file we emailed — was the case that said nothing
on screen. The PDF was stamped internally; the page was not. Now stated in the UI.

**Also consumed while in there** (built, shipped, and never surfaced): `po_number`,
`amount_outstanding` on part-paid rows, a derived Overdue badge (the summary tile counted overdue
invoices while nothing in the list marked which), the `overdue`/`void` server filters, today's
price on reorder tiles via the live pricing path, and the entire §4 detail payload — `bill_to`,
`lines`, `payment_terms`, `notes`, `emailed_at` — which was being fetched only by the PDF fallback
and displayed nowhere.

**§A1 needed no change, and that is worth recording.** The note is right that the wire format is
`{ok:false, error:{code,…}}`, but `js/api.js:329-331` normalises it — `errorCode = data.error.code
?? data.code` — and hands callers a **flat** `{ok:false, error:<message string>, code:<CODE>}`.
Following the note into `res.error.code` would read `.code` off a *string*, get `undefined`, and
send every error down the wrong branch. Pinned in §7 so the next reader of that note doesn't
"fix" it.

---

## ERR-140 — The B2B matrix was re-banded and every one of the 74 tests pinning it stayed green (2026-08-02)

**The handoff.** `business-volume-discount-range-update-aug2026.md`: the backend re-seeded the
volume-discount matrix (migration 127, backend commit `a9bff6d`). Top discount **18% → 10%**,
break quantities **3/5/10/20 → 3/4/7/8** (under $100) and **2/3/6/7** ($100–$499.99), and the
single `$100+` band **split into three** at $300 and $500. Mechanism unchanged: per-line
`price band × quantity` ceiling, floor-clamped to a 5% net margin.

**The handoff contradicts itself, and only the sweep could settle it.** Its prose says the $100+
bands are `2/3/6/7`; its own matrix table says the **$500+** band is `2/3/5/6`. The table is
right — verified across all 709 SKUs in that band. Nothing in this repo was typed from that
document; every number below came off the wire.

**The frontend needed no change, and that is the problem.** Every rung, price and percent on the
storefront is rendered verbatim from `GET /api/business/pricing`. A sweep of every HTML, JS, CSS,
meta and JSON-LD file found **zero** hardcoded business-pricing numbers, so the handoff's entire
"static copy" table — "change 18% to 10%", "change the break quantities" — had **nothing to act
on**. Running the real `describeLadder()` over all 4,015 live payloads: 4,002 ladders rendered, 13
correct retail fallbacks, 21 non-improving rungs collapsed, percent range 0.5%–10%, **zero
warnings**. The shipped code absorbed a complete re-band perfectly.

**What rotted instead was the frontend's RECORDED KNOWLEDGE of the matrix.** ERR-139 left 74 tests
whose fixtures were inline literals captured live on 2026-07-31 — `3:6,5:10,10:14,20:18` and the
rest. After the re-seed every one of those numbers was false, and **all 74 tests stayed green**,
because an inline literal asserted against itself. Being data-driven made the storefront immune to
the re-band and made its test suite silently obsolete. A suite that cannot fail when the world
changes is not protecting anything.

**The six live bands** (full 4,015-SKU sweep, 2026-08-02, real approved account). Half-open
`[min, max)` on the GST-inclusive unit price:

| Ladder (`qty:discount_percent`) | Retail range | SKUs |
|---|---|---|
| `3:4,4:5,7:8,8:10`   | $5.49 – $19.99     | 312 |
| `3:3,4:4,7:7,8:9`    | $20.49 – $49.99    | 811 |
| `3:2,4:3,7:6,8:8`    | $50.49 – $99.99    | 618 |
| `2:2,3:3,6:6,7:8`    | $100.49 – $299.99  | 1100 |
| `2:1,3:2,6:5,7:7`    | $300.49 – $497.49  | 452 |
| `2:0.5,3:1,5:3,6:5`  | $500.49 – $7654.49 | 709 |

(709 + 13 SKUs that floor away to no ladder = 722 carrying that signature; 4,002 + 13 = 4,015.)

**Four things the handoff does not mention, all found by sweeping rather than reading:**

1. **The entry rung is now 2+ in the three $100+ bands** — 2,261 of 4,015 SKUs. `business.js`
   asserted in prose that "the entry rung is 3+ across every live band", and so did this log and
   the project memory. Qty 1 is still full retail everywhere, which is the claim the UI actually
   depends on, but the stated *reason* was wrong and would have been inherited. The
   `minQuantity < 2` guard in `describeLadder()` went from decorative to **load-bearing**:
   tightening it to `< 3` would now delete the entry rung of over half the catalog.
2. **13 SKUs floor all the way to nothing** — all four rungs priced AT retail, `effective_percent:
   0`, `savings_amount: 0`. Every rung is dropped, `describeLadder()` returns null, the product
   renders plain retail with no B2B surface. Correct, silent, and previously impossible — the
   shallowest rung used to be 3%.
3. **Fractional percents are live** — `0.5%` across 722 SKUs. `formatPercent(0.5)` → `"0.5%"`
   already worked; nothing pinned it, and a `Math.round` tidy-up would have printed `0%` or `1%`.
   It did **not** work below `0.05%`: `Math.round(pct * 10) / 10` yields `0`, and the PDP chip
   prefixes `&minus;`, so the chip would have read **"−0%" beside a genuinely discounted price**.
   Unreachable while the shallowest rung was 3%; reachable the moment the entry rung became 0.5%
   and the loss floor clamps a thin-margin unit below it. Now returns `"<0.1%"` — deliberately
   not `""`, because an empty string is falsy and the chip's ternary would drop the badge
   entirely, which is absence-read-as-zero all over again. No live SKU hits it today; the guard
   is one supplier price change from mattering, and it costs three lines.
4. **Flooring is UP, not down: 39 SKUs (was 8), 21 rungs collapsed.** The new bands put the
   deepest two rungs a single unit apart (6→7, 7→8), so the collapse rule does more work than
   before, and a duplicate rung now asks the customer to buy *one* more unit for nothing.

Also: the 42 rungs where `effective_percent < discount_percent` but `floored:false` are
**cent-rounding** (9.937% → 9.9%), not flooring. Recorded so the next person doesn't chase it.

**The fix — a live oracle, not more literals.** `scripts/sweep-business-pricing.mjs`
(`npm run sweep:b2b`, `npm run sweep:b2b:check`) sweeps the whole catalog against production,
normalises every item through the **real shipped `describeLadder()`** rather than a
reimplementation, and writes `tests/fixtures/business-pricing-sweep.json`. The suite keeps its
readable inline band literals — a literal is what makes a re-band show up in `git diff` — and
**cross-checks them against the swept record**, so the readable copy cannot drift from the true
one. `--check` fails on drift without writing. A re-band is now a failing command and a visible
diff, not a discovery six weeks later.

**NOT under `inkcartridges/`.** Vercel serves that tree as the site root —
`https://www.inkcartridges.co.nz/scripts/fit-audit.js` returns **200** right now. A sweep script
living there would have published a full per-account price list for the catalog.

**A record can lie too.** Mid-task a sweep record appeared claiming a `8:12` top rung (12%) while
its own derived `top_percent` field said 10 and the live API said 10 — i.e. the JSON had been
edited after the script wrote it. A hand-edited record is indistinguishable from a genuine re-band
unless something checks. So the suite now also asserts the record is **self-consistent**:
`entry_quantity` / `top_quantity` / `top_percent` are derived from the `ladder` string by the
sweep, so in a real capture they agree by construction, and the band counts must add up to
`totals.answered`. Both guards were verified to FAIL on the tampered record and pass on a fresh one.

**Copy: nothing changed, deliberately.** The handoff asks for "Save up to 10%". The site has never
advertised a business-pricing percentage and still doesn't. Only 312 of 4,015 SKUs can reach 10%,
and only at qty 8+; 722 top out at 5% and 13 get 0% — a headline number would contradict the live
PDP ladder on 92% of the catalog, which is the cloaking/parity risk the handoff's own last section
warns about. Existing tests already assert no `%` appears on the account panel; that stance holds.

**The discovery gap — and the link that led to a login form.** Every B2B surface on the site
renders only for a signed-in **approved** account: PDP ladders, card overlays, cart nudges, the
account panel. So a prospective business customer had no way to learn that volume pricing exists
at all. `/business` is the answer, but it shipped with two holes: **nothing linked to it** (an
orphan page), and `business-page.js` redirected unauthenticated visitors to
`/account/login?redirect=/business` — a sign-in form that explains nothing. Both fixed: the footer
Help column now carries "Business & Bulk Pricing" (the label is deliberately not the retired
"Business Accounts" — under a volume model there is no account-level rate to advertise), and a
guest now gets the `#business-denied` explainer, which is not account-specific and already
carried the real `/quote` intake. An **already-approved customer who is simply signed out** gets a
"Sign in to see your prices" link injected for guests only — until now the site showed them plain
retail everywhere and explained nothing.

**Four test walkers were skipping any directory named `business`** —
`navbar-parity`, `mobile-parity`, `mobile-ux-audit`, `admin-header-link`, plus a dead
`inkcartridges/business` root in `search-enter-key`. Fossils of `html/business/{index,apply}.html`,
deleted in `68ab525` (2026-04-22, "remove all B2B functionality site-wide"). A new page could
have opted out of byte-identical-header parity and the mobile audits **by living in a folder**.
All five removed; `html/business.html` is flat and now genuinely walked (69 assertions, green).
`legal-pages` §7 was rewritten in the same pass: it claimed those pages "never existed" and that a
business CTA "implied a product surface we don't actually run" — both false, and the second is the
premise that would have blocked this work. It now guards what actually matters (no
`/business/apply`, no `?subject=Business` alias, no application `<form>`, both rewrites present,
footer link present).

- **Verified**: B2B suite **84 tests** (was 74), all fixtures re-captured live; repo suite
  **3,473 tests, 0 failing** (baseline before this work: 3,437/0); sweep re-run clean (6 bands /
  4,015 answered / 0 unanswered); `--check` proven to exit **1** on a tampered record and **0** on
  a matching one. **21/21 live browser checks** against production data in an isolated Chromium,
  signed in as a real approved account: PDP ladder renders `2+ $108.77 / 3+ $107.66 / 6+ $104.33 /
  7+ $102.11` matching the API verbatim, entry rung 2+ on a $100+ SKU, qty 1 says "standard",
  qty 2 quotes the business price, `#product-price` microdata still public retail (110.99),
  cart row "Business account — Home = −$3.92" equal to the swept `discount_amount`, per-line
  nudges, coupon field disabled with its reason, no `−0%` anywhere, no page errors; and as a
  guest: no ladder, no login bounce, explainer + sign-in route, account body hidden.
- **Backend note**: `/api/products` `meta.total` says **4022** while its 21 pages serve **4015**
  rows — no null SKUs, no duplicates. The sweep records the shortfall rather than silently
  reconciling it, and hard-fails if it ever exceeds 1%. Worth a backend look.
- **Trap, again**: a second Claude session was editing this repo concurrently on the same handoff —
  it authored the sweep script, added `droppedAtOrAboveRetail` and the `formatPercent` `<0.1%`
  floor to `business.js`, and later a header "Business" shortcut. Two of its changes broke
  assertions in the B2B suite that pinned *syntax* rather than *behaviour* (an arrow-expression
  regex on the `onAuthStateChange` callback, and a blanket `sessionStorage` ban). Both were the
  tests' fault, not the code's. Same lesson as ERR-139's ERR-138 collision: **check `git status`
  and both logs before assuming you are alone in the repo.**
- **Lesson**: being data-driven moves the rot from the code to the record. Any number a codebase
  writes down about a system it does not control needs a machine that can re-derive it and a test
  that fails when the two disagree — otherwise "no code change needed" quietly means "no way left
  to notice". See [[project_business_account_pricing_jul2026]].

---

## ERR-139 — Business pricing had been dark on every page for days, and the failure looked exactly like success (2026-07-31)

**Trigger:** a backend handoff, `business-account-pricing-FE-handoff (1).md`, describing v2 of B2B
pricing: the flat bronze/silver/gold account tiers are gone, replaced by a per-line **volume**
discount whose percentage is a function of the product's price band multiplied by the line quantity.
Buy more of an item to save more; cheaper items discount deeper. Still floor-clamped so no line ever
sells below a 5% net margin.

**It read as a feature request. It was a live outage.** Before writing anything, the two endpoints
were probed against production with a real approved business account. `/api/business/pricing` no
longer returns `business_price`, `savings_amount`, `effective_percent` or `floored` at the top level
of an item — every one of those moved inside a new `quantity_breaks[]` array. `js/business.js`
still read them from the top level, got `undefined`, and returned `null`.

And `null`, by this module's own deliberate contract, means *"this customer has no business
discount — render standard retail."* So the PDP price panel and every product-card overlay simply
stopped existing, on every page, for every business customer, with a clean console and no error
anywhere. `pricing_tier` had vanished from `/api/business/status` too, which killed the account
dashboard's tier line and degraded the cart's row label to a bare "Business account".

Nothing was broken in the sense anyone would notice. The absence of a discount and the absence of an
answer render identically, which is precisely the failure mode
`business.js`'s own header comment warns about. It happened to `business.js`.

**The hazard the handoff does not mention: flooring produces duplicate rungs.** A sweep of all 1,197
catalog SKUs found 8 where the loss floor bites, and on those the ladder flattens:

- `GDR2025BK` — 3+ $186.04 · 5+ $182.20 · **10+ $180.79 · 20+ $180.79**
- `GTN2530XLBK-2PK` — 3+ $274.50 · **5+, 10+ and 20+ all $271.49**

Rendering that verbatim tells a customer to buy ten more units for nothing. `describeLadder()` now
**collapses any rung that is not strictly cheaper than the one before it** — four rungs become three
and two respectively — and reports how many it dropped, so a test asserts the collapse rather than
inferring it. Every rung the frontend renders is a real, distinct improvement.

**The consequence that reshaped the UI: at quantity 1 a business account pays full retail.** The
entry rung is 3+ in all four live bands, so "the business price of a SKU" is no longer a thing that
exists — there is only the price *at a quantity*. v1's PDP wrote a single business price into the
sticky buy-bar and locked it; under v2 that is a price the checkout refuses to honour on the qty-1
purchase the button is offering. The bar now tracks `#qty-input`: the applicable rung's unit price
when one applies, and retail below the entry rung, because retail is genuinely what gets charged.
`#product-price` and its `itemprop="price"` microdata are still untouched — a per-account price
there would be cloaking and would poison the Merchant Center feed.

The ladder itself renders as a row of tappable break chips above the quantity selector, the active
chip resolved against the live quantity, a status line reading *"At 4 you pay $33.24 each — saving
$7.00. Add 1 more → $32.19 each."*, and a tap on any chip writing that quantity into the box through
its own clamp.

**Four live price bands, every one of them starting at 3+:**

| band | ladder | SKUs |
|---|---|---|
| under $20 | 3:6, 5:10, 10:14, 20:18 | 113 |
| $20–$50 | 3:5, 5:8, 10:11, 20:14 | 358 |
| $51–$99 | 3:4, 5:6, 10:9, 20:12 | 206 |
| $100+ | 3:3, 5:5, 10:7, 20:10 | 520 |

The handoff's TL;DR says *"Buy 5+ … Buy 10+"* and its worked example uses a ladder that matches no
live band at all. Rendering the API's numbers verbatim — rather than the document's — is the whole
discipline here.

**The coupon path was worse than unhandled.** Business accounts cannot combine a promo code with
volume pricing, and the backend enforces it with a plain `400 B2B_COUPON_EXCLUDED`. But `api.js`
only returns a structured envelope for a whitelisted set of error codes; everything else **throws**.
So the cart landed in its generic catch and told the customer *"Couldn't apply that coupon right
now. Please try again."* — about a code that can never work — and then attached a "try SAVE10
instead" suggestion nudge for a code that also cannot be combined, spending one of a strictly
limited attempt budget against an endpoint that locks out. Three lies in one message.

`B2B_COUPON_EXCLUDED` now gets its own envelope branch in `api.js`. The cart and checkout both
recognise the exclusion on all three channels the backend answers on — preview (`200
{valid:false, reason:'b2b_volume_pricing'}`), apply-response, and apply-throw — and route it to plain
inline feedback, never to the suggestion renderer. The field is disabled up front with the reason
stated, so a trade customer never spends an attempt learning a rule we already knew, and the
`?coupon=` recovery-email path no longer re-opens and prefills a form that cannot submit. Loyalty
points are untouched: only coupons are excluded.

**Two more things the payload will not tell you, learned by reading it.** `b2b_discount.effective_percent`
is the realised rate across the *whole cart* — 0.7% on a live cart whose one qualifying line was
discounted 5% — so it is never presented as the customer's rate; the row names the company instead,
and the floored note says "across your cart". And cart lines carry **no** per-line B2B figure at all:
`price_snapshot` and `line_total` stay at retail, and the discount surfaces only as one cart-level
amount. That is why the "add 1 more to reach 5+" nudges need a second `/api/business/pricing` call,
and why a `b2b_unit_price` on cart lines is now a written backend ask.

**Verified** against the live API and pinned by a **consistency gate**: summing
`offerAtQuantity(ladder, qty).savings × qty` across the live cart's lines reproduces the server's own
`b2b_discount.discount_amount` to the cent — `$1.22 × 4 = $4.88`. If the frontend's reading of the
ladder ever diverges from what the server actually charges, the suite fails rather than the customer
finding out. The B2B contract file grew from 53 tests to **74**, every fixture captured live rather
than copied from the handoff. Repo suite 3,373 passing in scope. `npm run build` restamped.

Four grids were also found painting product cards and never decorating them — `filters.js`,
`ribbons-page.js`, `favourites.js` and `landing.js`. Favourites is the one that mattered: for a trade
account it is the reorder list, the single surface most likely to be bought in tens.

**Lesson:** a fail-soft path and a backend schema change are a silent-failure machine. When "no data"
and "no entitlement" render identically, the day the shape changes the feature dies with a clean
console — so the shape you do *not* recognise has to be loud even when the outcome is the same as a
shape you do. `describeLadder()` now warns by name when it sees the retired v1 payload, and
`getPricing()` warns when `source` is anything but `"volume"`. Neither changes what the customer
sees; both turn the next model change from an outage into a five-minute diagnosis.

---

## ERR-138 — A handoff said the invoice PAID backend was "shipped & live"; the route answered curl and was still unreachable from the browser (2026-07-31)

**Trigger:** the backend dev handed over `invoice-paid-slider-FE-patch-jul2026.md`, opening with the
operator report "Paid slider in invoices not working" and a table assigning it to the **frontend** —
*"Backend: shipped & live — no further backend change needed for the slider."* It supplied a
ready-to-paste React handler for a codebase that has no React.

**What was actually true.** Both halves of that framing were wrong, and both were checkable in about
ninety seconds.

1. **There was no frontend bug to fix.** ERR-131 had already rewired the toggle the previous day, to
   the letter of the patch: `PATCH /:id/status`, `{status:'paid'|'unpaid'}`, `void` excluded from a
   frozen `INVOICE_STATUSES`, the row repainted from `data.invoice.status` rather than the checkbox,
   revert-on-error, per-code copy. 42 tests pinned it. The patch prescribed, line for line, code that
   was already in `main`.

2. **The backend change the patch said wasn't needed was the only thing that was.** Re-probed warm,
   three times, against both hosts and both origins:

   ```
   OPTIONS /api/admin/invoices/:id/status   (Access-Control-Request-Method: PATCH)
     → 204, Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS      ← no PATCH
   PATCH  /api/admin/invoices/:id/status  → 401   (route live, browser can't reach it)
   PUT    /api/admin/invoices/:id/status  → 404   (no alternate verb)
   POST   /api/admin/invoices/:id/status  → 404
   PUT    /api/admin/invoices/:id         → 401   (live AND on the allow-list)
   ```

   `X-HTTP-Method-Override` is not in `Access-Control-Allow-Headers`, so a POST carrying it fails the
   preflight too. **BF-021, open since 2026-07-30, was still open** — still a one-line backend change.
   The slider had never once reached the server.

**The measurement trap, and how it nearly repeated.** An early sweep, fired while the Render instance
was cold, returned `404 Endpoint not found` for `GET /api/admin/invoices`, `POST /api/admin/invoices`
and `GET /:id/emails` — routes the admin page demonstrably uses. Taken at face value that reads as
"the invoice API doesn't exist", which would have been a spectacular and completely fictitious bug
report. Warm re-probes returned `401` for every one. **A single probe against a cold serverless host
is not a measurement.** Probe warm, probe repeatedly, and distrust a result that contradicts a
feature you can watch working.

**Fix.** Ship the flip through a route the browser is actually allowed to use, without ever pretending
PATCH is fine. `setStatusWithFallback()` tries `PATCH /:id/status` first; **only** on a bare transport
failure (`isNetworkFailure`, i.e. no status and no code) does it fall back to
`setStatusViaFullUpdate()`, which reuses the editor's own `getInvoice → draftFromInvoice →
buildPayload → PUT /api/admin/invoices/:id` round-trip — the identical request the drawer's Save has
always made. PATCH stays the preferred call, so **the fallback retires itself the day BF-021 lands,
with no code change.**

A coded rejection (`CONFLICT`/`NOT_FOUND`/`RATE_LIMITED`/`VALIDATION_FAILED`) is rethrown untouched:
the server already answered, and re-asking through a heavier write route is trying to talk it out of
that answer.

**The traps this had to avoid.** An invoice is a legal document, and the fallback rewrites the whole
record to change one field. Four guards abort the flip rather than write a mangled one:

- **Renumbering.** `buildPayload` sends `invoice_number: d.invoice_number || null`, and **null tells
  the backend to assign the next number in series.** A round-trip that dropped the number would
  silently renumber an invoice the customer already holds. Missing number ⇒ refuse.
- **Un-voiding.** PATCH 409s on a void invoice because voiding also cancelled its shadow order; PUT
  holds no such opinion. The void check re-reads the **server's** copy, not the clicked row.
- **Blanking.** If the server had line items and the record→draft mapping yields none, refuse rather
  than PUT an empty invoice.
- **Absence read as emptiness.** `getInvoice()` fails soft to `null`; treating that as "an invoice
  with no fields" would PUT a fresh draft over a real record. Eighth in the family
  (ERR-063/068/073/075/076/127/131).

**And the guard the tests did not think of — caught by the live gate, on the very first real flip.**
36 passing tests, every one of them green, and invoice **#3267** still came back changed in a way
nothing had asserted: `payment_due` moved from `null` to `2026-08-20`. `buildPayload` is an *editor*
payload — it fills gaps the way an operator editing the form would want them filled — so
`effectiveDueDate()` obligingly derived a due date from `payment_due_pref: '20'`. Flicking a switch
gave an invoice that had **already been emailed to a customer** a payment due date it never had.
`order_date` and `issue_date` have the same shape of default.

The fix is a change of principle, not a patch: **the server's record wins for every field it
stores**, and only `status` comes from the draft. `buildPayload` is kept for the *shape* — key names,
line mapping, the deliberate omission of server-owned send history — never for its values. On top of
that, `documentDrift()` re-derives the comparison from the payload's own keys and **refuses the write**
if any stored field would change, so a field added to `buildPayload` in future is checked even though
the pin loop knows nothing about it.

Getting that comparison right needed the live data too. The naive version — `JSON.stringify(a) !==
JSON.stringify(b)` — called *four* fields changed on a real invoice: `seller`, `customer` and
`footer` come back with different **key order**, and each line carries a server-computed
`line_total_excl_gst` the payload correctly omits. That version would have refused every toggle on
every invoice. The rule it became: **you can only contradict a value you were given** — walk the
server's record, compare only fields the payload also carries.

**And the degraded path is loud.** A fallback nobody can see makes BF-021 permanent — so the route
used is in the **return value** (`via: 'patch' | 'put-fallback'`), every use is logged naming BF-021,
and the operator is told once per session. Not once per click: a nag gets trained away.

**The third recurrence of the reassuring lie.** ERR-131's real damage was not the wrong URL — it was
the toast reading *"Mark-paid isn't available yet (backend endpoint pending)"*, which made a broken
feature look like an unbuilt one and stopped anyone looking for a month. Probing found **eight more
live instances of that same sentence**, every one over a route that answers `401`:

| Screen | Copy | Route (probed 2026-07-31) |
|---|---|---|
| Invoices | "Delete isn't available yet (backend endpoint pending)" | `DELETE /invoices/:id` → 401 |
| Invoices | "Void failed (backend pending)" | `POST /:id/void` → 401 |
| Invoices | "Email failed (backend pending)" | `POST /:id/email` → 401 |
| Invoices | "…the invoicing backend may not be live yet" | `POST`/`PUT /invoices` → 401 |
| Quick orders | "Delete isn't available yet (backend endpoint pending)" | `DELETE /quick-orders/:id` → 401 |
| Quick orders | "…the quick-order backend may not be live yet" | `POST`/`PUT /quick-orders` → 401 |
| Quick orders | "couldn't save the contact (backend pending)" | `POST /contacts` → 401 |
| Contacts ×2 | "…the contacts backend may not be live yet" | `POST`/`DELETE /contacts` → 401 |
| Customers | "…the invoicing backend may not be live yet" | `PUT /customers/:id/invoicing` → 401 |

All rewritten to say what actually happened — a `NOT_FOUND` on delete now means *this record is gone,
refresh* — and a repo-wide scan now fails the suite if the phrasing returns. Comments are stripped
before the scan, so the postmortem and the code notes can still quote the copy they retired.

Separately, `saveInvoice()` surfaced only the `details.unresolved` shape and swallowed everything
else behind that "may not be live yet" line; it now surfaces `error.message`, `error.details.reason`
and per-field `details[]`, and when the server truly says nothing it **says that** instead of
inventing a cause.

**Also fixed:** `.inv-paid input` is `opacity: 0`, so the toggle had **no visible keyboard focus** at
all — Tab landed on it and Space worked, invisibly. The ring is now painted on the slider the
operator can actually see, with a light-deck contrast override.

**Verified:** 41 tests (`admin-invoice-paid-fallback-jul2026.test.js`) plus 2 updated in
`admin-invoice-status-email-log-jul2026.test.js`. The round-trip is run **for real** — the actual
`draftFromInvoice` → `buildPayload` chain in a `vm`, not a mock of it — because a mocked payload
builder would happily "preserve" a number the real one drops. Driven live in headless Chromium as
the owner against invoice #3267: the PATCH rejecting with `TypeError: Failed to fetch` (BF-021 in a
real browser), then `GET` 200 + `PUT` 200; the record re-fetched and diffed field by field, **before
the fix** showing `payment_due` silently invented, and **after** showing only `status` and the
server's own `updated_at` — `invoice_number` 3267, line items, `$150.79` total and `emailed_at` all
intact. Flipped back to unpaid and re-diffed: **byte-identical to the pristine record.** Stubbing the
transport so PATCH resolves fires **zero** GET/PUT, proving the fallback retires itself. Keyboard Tab
lands on the toggle with a real `solid 2px` ring. Full suite green.

**Lesson.** ERR-131 closed on *"curl proves a route exists; only a browser proves it is reachable."*
That exact lesson was then re-learned four weeks later — not because it was forgotten, but because a
confident handoff document was believed **again**. A doc records an intention. The only thing that
records an API is a probe, warm and repeated, from the origin that will actually make the call.

---

## ERR-137 — "Printer Models" scrolled the ink finder to a spot the header then covered (2026-07-31)

**Trigger:** two owner screenshots of the same page. In one, clicking **PRINTER MODELS** landed on the
finder with the "Find ink for your printer" title, the subtitle and half the tab row hidden behind the
pinned site header. In the other, the identical journey landed perfectly. Same code path both times.

**Two correct behaviours that never consulted each other.** `js/main.js` centred
`.ink-finder__wrapper` in the **full viewport** — `wrapperTop - (innerHeight - height) / 2` — and the
same math was duplicated verbatim at both entry points, the `?scroll=ink-finder` nav deep link and the
`#ink-finder-heading` hero CTA. Independently, `js/landing.js` runs an IntersectionObserver that adds
`.site-header--sticky` (`css/pages.css` → `position: sticky; top: 0`) the moment `.hero` leaves the
viewport — which is exactly what that scroll causes. The desktop header is ~155–200px of contact,
logo and nav rows, and its base rule is `position: relative`, so nothing reserves the space.

Whether the bug appeared depended on whether the centred position happened to fall past the hero's
bottom edge. The good screenshot stopped a few pixels short of the threshold; the bad one crossed it.
**The intermittency was the signature of a knife-edge between two modules**, not a race in either one.

Mobile was worse and not intermittent at all: below 1100px the header is `position: sticky` at *every*
scroll position, so the centred card sat under it always — measured at 102px card-top against a 167px
header.

**The subtle part: whether to reserve the header's height depends on where you land, and where you
land depends on whether you reserve.** The fix solves for the self-consistent answer of three:

- `bare` — centre in the full viewport. Valid when it lands *above* the pin threshold, i.e. the hero
  is still on screen and the header is not pinned there. This is the common desktop case.
- `reserved` — centre in the space below a measured header. Valid when the destination is in pinned
  territory either way (mobile sticky, or a card far enough down the page).
- `edge` — `heroBottom - 8`, used when neither is consistent: reserving would land us *short* of the
  threshold, where the header isn't pinned, cropping the card's bottom for chrome that never appears.

Skipping the reservation only ever happens where the header is provably unpinned, so no branch can
leave the title under the chrome. The header height is **measured** (`getBoundingClientRect().height`),
never hardcoded and never read from `--header-h` — a stale mobile-only 56px token that no JS writes
and that describes nothing about the desktop header.

**The target also moves after the scroll begins:** the header only pins partway down, the mobile
header collapses (`.site-header--scrolled` shrinks the document), and `#trust-stats` can un-hide from
`/api/site/trust`. So a settle pass re-measures on `scrollend` — with a 900ms timeout because Safari
has no such event — and nudges if the target drifted more than 8px. It cancels on `wheel`,
`touchstart` or `keydown`, and when the page settles more than 200px from where it aimed, so it can
never fight a user who has taken over the viewport.

**Where the code lives.** The geometry went into `js/landing.js`, next to the observer that causes the
pin and on exactly the two pages that have the finder (`index.html`, `html/index.html`), published as
`window.InkFinderScroll`. `main.js` keeps a thin `scrollToInkFinder()` that delegates and falls back to
`scrollIntoView` if landing.js is absent. That placement also matters mechanically: the naive inline
version pushed `main.js` from 747 to 824 lines and tripped the 750-line budget in
`tests/search-thin-frontend.test.js` — a tripwire against re-growing deleted search logic, which is
not something to raise for an unrelated feature.

**Verified** in bundled Chromium against a local serve. At 1512×1080, the owner's window size: 243px
of air above and below, the whole card visible, header unpinned, URL back to a clean `/` with no hash.
At 1400×900: 152/154. At 390×844 mobile: card top at 185px against a 167px sticky header, where the
old math put it at 102px — buried. At 1400×620: lands 8px short of the pin threshold with the title,
tabs and brand grid visible rather than cropped for a header that never appears. The hero CTA and the
nav link now land byte-identically. `tests/ink-finder-scroll-offset-jul2026.test.js` (19 tests)
executes the real functions lifted out of `landing.js` against stubbed geometry — including a sweep of
74 viewport heights × pinned/unpinned asserting the "title is never under the chrome" invariant — and
pins the contracts. Full suite 3,354 passing, 0 failing. `npm run build` restamped both files.

Two repo hygiene guards caught my own debris on the way: the suite fails on ad-hoc screenshots at the
repo root and on a `.playwright-mcp/` directory. Browser artifacts have to be cleaned up before
claiming green.

**Lesson:** a scroll target and a sticky header are one layout decision pretending to be two. When one
module decides where the viewport lands and another decides what covers it, neither is wrong in
isolation and the bug presents as intermittent. Put the compensating geometry next to the thing that
causes the overlap — and when a value depends on a state that depends on that value, don't guess the
state, solve for the consistent one.

---

## ERR-134 — Related Products: the backend fix landed, but a failed family fetch still looked exactly like "no siblings", and only `series_codes[0]` was ever tried (2026-07-30)

**Trigger:** the backend dev shipped `series_codes` and `yield_tier` on `GET /api/products/:sku` and
handed over `related-products-series-codes-fe-notes-jul2026.md`, headlined **"No frontend change
required. This is a heads-up + verification note."** The reported symptom was the Epson 786XL Cyan
PDP rendering no Related Products section at all.

**The headline claim was true.** Measured before touching any code: `/api/products/G786XLC` returns
`series_codes:["786"]` and `yield_tier:"XL"`; a 138-SKU stratified sample covering every brand ×
category × source, plus sixteen forced edge cases, showed detail-vs-list parity at **100%** with zero
mismatches on either field; and the live 786XL Cyan PDP renders its full 786 family. Across the whole
catalogue — 3,910 products enumerated from `/api/shop` — **2,931 of 3,801 non-ribbon PDPs resolve
their family**, and **767 hide correctly** because they genuinely have no sibling. The reported bug
was fixed and needed nothing from us.

Verifying it turned up three other defects, two of them **caused by the fields arriving**.

**What was wrong (1) — a failed fetch was indistinguishable from an empty family.**
`renderRelatedProducts` did `if (res.ok && res.data?.products)` and then
`if (related.length === 0) return;`. A rate-limited, cold or offline read produced a page with no
Related Products section at all — pixel-identical to a mono toner that really has no relatives. This
was proven live by accident: the catalogue-enumeration script written to *verify* the handoff
consumed the API rate limit, and the 786XL PDP came back with sixteen HTTP 429s and the section
simply gone. A bare `catch (e) { /* optional */ }` swallowed every throw on top of that, with no log.
The silent case is common and correct — 767 PDPs are in it — which is precisely why the failing case
had to stop looking the same.

**What was wrong (2) — only the first series code was ever tried.** `series_codes` is a list, and for
a product spanning several models the first entry is not always the one carrying the family.
Confirmed against the live API: `CB412DNBK-2` carries `['B412','B432','B512','3K']`, and
`?code=B412` returns 1 product (itself) while `?code=B432` returns 3. `CB401BK`: `B401` → 1,
`MB451` → 3. `C45ABK`: `45` → 1, `42` → 2. Three product pages lost their entire Related Products
section to a dead first code.

**What was wrong (3) — the new `yield_tier` field made the frontend detector dead code, and the
detector was the more accurate of the two.** ERR-045 recorded `yield_tier` as `null` on every live
endpoint, which is why a frontend detector exists at all. It is now present on **3,910 of 3,910**
products, and `yieldTier()` returned it unconditionally. It agrees with the detector on 3,883 — but
on **16** it says `STD` over a name and a page count that plainly say high yield: Lexmark `708H` Cyan
at 3,000 pages against the plain `708` Cyan's 1,000, plus `808H`, `236H`, `333H` and `C333HY0`; Canon
`CART069H`, `CART069HK`, `CART055H` and `PG660XLHY`. Those sixteen silently collapsed into the
standard-yield row the moment the backend began populating the field — a regression caused by data,
not by a code change, and one nothing would ever have raised an error about. The detector already
caught all sixteen: its `\d{2,}h\b` and `CART\d{3,}H` rules were written for exactly these.

**What was wrong (4) — category vocabulary gaps.** `normalizeProductType` had no case for
`fax_film` or `fax_film_refill` (7 products, all filed under `?category=drums`), so the chain fell
through to `normalizeCategory('CON-LASER')`, which returned `null` — it tested for ink, toner, drum
and ribbon but not `laser`, the category code every toner arrives with — and then to
`detectCategory()`, which answers `'default'`, for which `apiCategoryMap` has no key. The whole
Related Products branch was skipped. The `CON-LASER` half is masked today only because
`product_type` is always present and is checked first.

**Fix.** `familyCodeCandidates(seriesCodes, extractedCode)` is a pure helper on the existing
`window._pdpRelatedHelpers` (the ERR-084 precedent); the family fetch now loops it and stops at the
first code that yields a sibling. `series_codes[0]` stays first, so the 2,931 pages that resolve on
the first candidate send a byte-identical URL and keep their edge-cache entry — this is a fallback,
never a re-ordering. A `fetchFailed` flag records an unhealthy response and breaks the loop, because
hammering the next candidate against a backend that is down only multiplies failures; the
empty-result guard renders the error state only when that flag is set, so genuine singletons still
hide silently. The error pane reuses the shop page's `.drilldown-error` markup verbatim — the same
component to a shopper, and no new CSS. The empty catch became `DebugLog.warn` plus the same error
state. `yieldTier` now returns `Math.max(backendTier, detected)`. And `fax_film`/`fax_film_refill`
map to `drum`, with `normalizeCategory` learning `laser` → `toner`.

**A standing instruction reversed, deliberately.** `utils.js` carried the note *"Lexmark bare-letter
yields stay STD — backend follow-up; do not work around here."* That was the right call while the
detector was the only signal and could be wrong with nothing to check it against. With two signals we
can cross-check, and move only in the direction that both the product name and the printed page count
point. The merge is one-directional — it can only raise a tier, so a correct backend value always
survives — and self-disabling, going inert the moment `detectYieldTier` learns the trailing-`H`
convention. Measured across the full catalogue before shipping: **16 raised, 0 lowered.**

**The trap this had to avoid — and did not, at first.** The first catalogue enumeration ended
pagination on `if (page.length < limit) break`. But `/api/shop?limit=100` returns 99, 98, 99, 32 — so
it stopped after page one and measured 1,908 products instead of 3,910. That produced a confident and
completely wrong finding: "607 product pages are broken." Only an empty page ends pagination. What
exposed it was spot-checking a single supposedly-broken SKU against the live API — `TN2030` returns 2
products, not 1. A scary aggregate deserves a live spot-check before it is believed, let alone
reported.

**Verified:** new `tests/pdp-related-products-resolution-jul2026.test.js` (22 tests) plus three
yield-merge tests in `code-yield-grouping-may2026.test.js`. All eight fixes were mutation-tested
individually — reverted, confirmed red, restored — including a `min`-instead-of-`max` mutant to prove
the yield merge is genuinely one-directional. `tests/dense-pack-rollout-may2026.test.js` §2 was
re-pinned to the `code:` property rather than one particular spelling of its value; its `limit ≥ 200`
invariant is unchanged. Full suite **3,351 tests, 0 failures** (18 pre-existing skips).
`npm run build` restamped 963 asset refs. Live in bundled Chromium against a local serve and the real
API: the 786XL family is intact; `CB412DNBK-2` now lists `GB432BK` and `GB432HYBK` where it showed
nothing; Lexmark `?code=708` puts all three 3,000-page `708H` items on one row, where previously two
of them merged into the 1,000-page row and `708HY` stood alone; the `GTN2130BK` singleton still hides
with no error box; a routed 429 shows the retry pane and Retry recovers the full family in place;
`/ribbon/307.11` is unchanged and still makes zero `/api/shop?…code=` calls (the ERR-085 guard); and
`GPC201` now fires `category=drums&code=PC201` where it previously fired nothing at all.

**Still open (backend):** BF-027, `detectYieldTier` misses the trailing-`H` high-yield convention —
the 16 SKUs are listed in `related-products-backend-brief-jul2026.md`. BF-028, the `product_type`
vocabulary carries `fax_film`/`fax_film_refill` with no documented category mapping. Their own open
question is answered there too: **retire `GET /api/products/:sku/related`.** Measured, its payload
omits `series_codes`, `yield_tier`, `pack_type`, `canonical_url`, `compare_price`, and the GST and
review fields — everything the card renderer and the family grouping need — and it crosses families,
returning a `788XXL` row on the 786 page.

**Rule:** a backend note can be right about the bug and wrong about the blast radius. Populating a
field that was previously `null` silently changes every downstream consumer that treated it as
authoritative, and nothing errors. Where two signals exist for the same fact, prefer a one-directional
merge over "the newer one always wins" — it keeps the correct value in both directions and dies on its
own once the upstream is fixed. And an absent section is a claim: *nothing relates to this product*.
Never let a failed read make that claim.

**Pinned by:** `tests/pdp-related-products-resolution-jul2026.test.js`,
`tests/code-yield-grouping-may2026.test.js`.

---

## ERR-136 — "Remove an item, refresh straight away, it's back": the backend fixed its latency, but the frontend could still lose a delete with no latency at all (2026-07-30)

**Trigger:** customers reported that, signed in, removing a cart item and refreshing immediately left
the item in the cart — but waiting a few seconds before refreshing made the removal stick. The cart
also felt slow. The backend dev handed over `cart-remove-latency-fix-jul2026.md` with the backend half
already fixed and deployed, plus three recommended frontend follow-ups.

**What was wrong on the backend (already fixed).** Every cart request ran `optionalAuth`, which made a
network round-trip to Supabase Auth (`auth.getUser`) *before* the delete SQL was even issued. That made
`DELETE /api/cart/items/:productId` slow enough that an immediate page refresh **aborted the in-flight
request before it committed**, so the follow-up `GET /api/cart` still returned the item. Cart routes now
verify the access token locally against the project's JWKS (ES256 + WebCrypto), taking authenticated
cart calls from roughly seconds to tens of milliseconds.

**What the audit found.** The handoff's diagnosis was correct but incomplete, and the frontend had *two*
independent defects, only one of which is a race.

Verified against the live API before any code was written: `DELETE /api/cart/items/:id` returns
`{message, removed: 1, guest_session_id}`, and repeating the same delete returns `{message, removed: 0}`
**still with `ok: true`**. A genuine no-op is therefore indistinguishable from a success unless the
frontend reads the count — and `data.removed` was read nowhere in the codebase. Measured guest latency
from New Zealand: POST ~1.2s, DELETE ~0.44s, GET ~0.47s, so the race window is real rather than
theoretical.

The first defect was the race. `Cart.removeItem()` wrote the optimistic removal to `localStorage`
*before* the server confirmed, and its in-flight guard was an in-memory `Set` that dies with the JS
context. After a reload the mirror said "gone", the guard was empty, and `GET /api/cart` re-adopted the
row — exactly the reported symptom.

The second defect needed no latency at all. The guest branch of `loadCart()` re-pushes the localStorage
mirror back to the server, one `addToCart` per row, as resilience against cross-origin cookie loss. A
stale mirror could therefore resurrect a removed row **into** the server cart. Fixing only the race
would have left that in place.

**What shipped.** Three mechanisms, none of them redundant:

- a **journal** in `localStorage` records the intent *before* the request leaves, so it survives an
  unload, a tab crash, or being offline;
- a **filter** subtracts unconfirmed removals from every paint and every re-push, because between the
  journal write and the confirmation both localStorage *and* the server still hold the row;
- an **epoch guard** stops a `GET` issued before a mutation from being adopted after it.

`keepalive: true` on the DELETE is a fourth, purely latency-side measure. It is deliberately *not*
load-bearing: `API.request()` awaits `getToken()` — which may sit inside `Auth.refreshSession()` —
before `fetch` is ever called, so an unload during a token refresh loses the request *before dispatch*,
where `keepalive` has nothing to protect. Only the journal covers that.

**The trap this had to avoid.** The first design had only the journal and the filter, and it would have
turned a deterministic bug into a flaky one. Replay and the load-time `GET` run concurrently; if replay
confirms and drops the journal entry before an earlier in-flight `GET` resolves, that response still
carries the item, the journal is now empty so the filter *correctly* no longer matches, and
`this.items = parsed.items` puts the row straight back and re-saves it. Filtering cannot fix this,
because by then the filter is right to be empty. Hence the epoch guard.

Two further traps. `removed: 0` on a *fresh* delete is not a terminal answer — it can also mean the
request resolved against a different cart (rotated guest session, expired token), which the count alone
cannot distinguish, so it forces a verifying `GET` instead of a silent success. And a *replayed*
`removed: 0` is the correct idempotent outcome, so treating zero as an error uniformly would raise a
scary message on a perfectly good result.

Identity had to be recorded per record. A removal belongs to one cart: a different user id is dropped
rather than replayed, being signed out *defers* rather than drops (which is why `SIGNED_OUT` clears the
cart mirror but must not purge the journal, or the row reappears at the next sign-in), and a rotated
guest session is dropped quietly because that cart is unreachable from this browser — without a token
the request sends `credentials: 'omit'`, so the backend's httpOnly guest cookie never rides along. The
tempting alternative, re-sending the retired session id via a header override, was rejected as actively
unsafe: the API writes any `X-Guest-Session` *response* header back into storage, so a replay could
resurrect a session that checkout had deliberately retired.

**Also repaired in the same code paths.** The in-flight guard was honoured in only one of four places
that adopt a server cart. A double-click fired two DELETEs, and because a re-render rebuilds the item
list via `innerHTML` between the two clicks, the second could land on a *different* row's button — so
both an id guard and a pre-await button disable were needed. Whole-array rollback snapshots in
`removeItem` and `addItem` meant that rolling back one removal after another had succeeded resurrected
the *other* item; rollback is now surgical. A debounced quantity change followed by an immediate reload
was silently lost, now flushed on `pagehide` and `visibilitychange` (not `beforeunload`, which prompts
the shopper and which Chrome ignores without a prior gesture). `clear()` dropped the mirror before the
server confirmed. Neither cart-item path percent-encoded its id, which the journal would have replayed
into a *persistent* malformed request. `updateQuantity` clamped to 99 while six other sites used 100.
`clearCart()` discarded the guest session id even when the delete had failed, orphaning a populated
cart. And `updateCartCount()` selected a class present in zero of the 29 storefront headers, so it — and
the cold-paint helper that depends on it — had never once updated the cart badge.

**How it was verified.** A new 48-test suite executes the pure decision core for real rather than
pattern-matching it, and was **mutation-tested with nine deliberate regressions**; each broke exactly
the section that claims to guard it, so no section is vacuous. Signed in as the owner against the live
backend, 22 of 23 browser checks passed, covering the reported bug, a journalled intent whose DELETE was
never dispatched, offline deferral and replay, one DELETE per double-click, a silent `removed: 0`, and
the quantity flush. First paint measured 95ms without a journal and 89ms with one — the journal read
costs nothing.

The single most useful finding came from the browser, not the tests. Routing the quantity cap through
`this.MAX_QUANTITY` inside `this.items.map(function(item){…})` threw on every render, because the
callback is unbound in strict mode, so the cart page painted **zero line items** — while all 47 static
assertions still passed, since the constant *was* referenced exactly as required, just from the wrong
receiver. The callback already closed over `self` for precisely this reason.

**Lesson.** A "the backend was slow" handoff is not automatically a latency-only bug: measure it, then
go looking for the version of the same symptom that needs no latency at all. When a fix has several
interlocking mechanisms, write down why each one exists — the next reader's instinct is to delete one as
redundant, and here that would quietly convert a fixed bug into a flaky one. And a static assertion can
be satisfied by code that throws, so any change to a render path deserves a real browser.

**Backend ask (BF-025).** The handoff cites `checkout-stale-cart-bug-jul2026.md` twice as prior
guidance. That document has never existed in this repo and was never received — searched the working
tree, all of `git log --all`, and both error logs, with zero hits. It should be sent, since this change
was asked to follow guidance nobody here can read.

---

## ERR-135 — A cartridge that didn't fit: the backend fixed its data, and the frontend was still inventing compatibility of its own (2026-07-30)

**Trigger:** a customer bought a cartridge that didn't fit their printer. The backend dev removed the
bad `product_compatibility` rows for three Brother printers (commits `8fa43a0`, `7edb38e`) and handed
over `compat-wrong-family-fix-FE-handoff-jul2026.md`, which said **"FE code change required: ❌ None
— this is a data-only fix"** and asked for one Cloudflare cache purge.

Both halves of that note were wrong. Verifying it against the live API found the requested action
unnecessary and the un-requested one urgent.

**The purge was a no-op.** Cloudflare does front the document host (`server: cloudflare`), but the
printer prerender responses come back `cf-cache-status: DYNAMIC` — never cached — and the HTML was
already clean: zero occurrences of `LC531`/`LC536` across all three printer pages, measured as
Googlebot. This repo also has no purge capability whatsoever: no token, no zone ID, no script, no npm
script. The static layer is deliberately `max-age=0, must-revalidate` + `CDN-Cache-Control: no-cache`
(`vercel.json`) precisely so a deploy never needs one, and `tests/dense-pack-rollout-may2026.test.js`
already pins that intent. Nothing to purge; nothing here that could.

**"No FE change required" was false.** The frontend had its own wrong-family generator — live,
customer-reachable, and fed by data that never touched `product_compatibility` at all.
`/shop?printer_model=<free text>` is emitted by `js/account.js` for any saved printer without a slug.
It ran a five-strategy ladder whose last two rungs invented compatibility outright:

- **Strategy 4** called `getProducts({ search: <BRAND NAME> })` and merged up to 100 results.
  Measured live: `?search=Brother&limit=100` returns **100 products across 71 distinct series
  families** — label tapes (DK-11201), drum units (DR-2425), photo paper (BP71GA4), typewriter
  ribbons. Every one of them was rendered under the heading *"Compatible Products for &lt;the
  customer's printer&gt;"*.
- **Strategy 5** looked the printer up in a hardcoded printer→code table and ran
  `ilike('name', '%<code>%')` per code. Measured live against the anon key: `%200%` matched **141
  products**, because "(9,200 pages)" contains "200"; `%85A%` returned `CB435A` where the table meant
  `CE285A`. The table was stale on top of being unbounded — it had no entry for any printer in the
  incident, and several of its mappings were simply wrong.

The trigger condition was confirmed: Strategy 3 only accepts `/smart` results when the payload
carries `matched_printer`, and for an unrecognised model `/smart` returns `matched_printer: null`.
So any typo'd or unknown saved printer fell straight through to Strategy 4.

**What the audit found.** Three more instances of the same shape:

1. **The PDP borrowed a stranger's printers.** With no compatibility rows of its own, it picked a
   "sibling" with the same unbounded `ilike('name','%code%')` — `%LC37%` returns `CIB3757CMY`, a
   different family — and printed *that* product's printers as this one's "For Use In".
2. **Printer models were being minted as cartridge codes.** `_enrichSeriesCodes`'s "for &lt;Brand&gt;
   …" pattern and `familyKey`'s last-match-wins name scrape both read the tail of a compatible
   cartridge's name — which is exactly where the *devices it fits* are listed — so
   `…for Brother DCP-J1050DW` yielded `DCPJ1050DW` as a series code, keying a family on a printer.
3. **A citation to nowhere.** `middleware.js` claimed its bare-`printer_slug` prerender gate was
   "Pinned by tests/printer-url-canonical-may2026.test.js" — a file that has never existed in this
   repo. The gate sat unpinned while advertising the opposite.

**The trap.** The obvious fix is to make the substring matcher smarter. That is what the codebase had
already done — twice correctly (shop-page's `queryCodeMatch`, the PDP's related-products filter) and
twice incorrectly (the two `ilike`s). **Four implementations of one rule is why the broken pair
survived.** And even the "correct" pair disagreed: the PDP's had the boundary rule but not the
yield-prose rule, so a short numeric code still matched its own page count.

The second trap was scope. Deleting the bad rungs leaves `?printer_model=` with nothing to render —
and an empty page is a dead end for a customer who merely typo'd their printer.

**Fix.** One rule, stated once, in `js/utils.js`:

> **THE FRONTEND NEVER ASSERTS COMPATIBILITY.** Only `product_compatibility`, reached through the
> backend, may put a product under a "fits your printer" heading. Everything else is a SEARCH RESULT
> and must be labelled one.

This is the same rule as *the frontend never computes prices*, and both failures had the same shape:
the FE deriving an answer the backend owns, then presenting the derivation as fact.

`CompatSource` (`js/utils.js`, on `window` so the earlier-loading `api.js`/`shop-page.js` can read it
without a temporal-dead-zone throw) is now the single vocabulary: `printerKey` (separator-insensitive
printer identity), `isPrinterModelToken`, and one whole-token matcher carrying **both** rules —
boundaries, and rejecting `<code> page(s)`. All four call sites delegate to it.

`?printer_model=` stopped being a second compatibility path and became a router: resolve the free
text to a real printer, then `location.replace` to the canonical `?brand=&printer_slug=` hub; failing
that, to `/search?q=`, where results are labelled as search results and `/smart`'s existing
did-you-mean banner recovers the typo. It renders no product grid at all, so it cannot mislabel one.
The hardcoded table, both wrong-family strategies, and the direct Supabase printer lookup are gone.

Resolution is separator-insensitive because it had to be: `printer_models` holds
`Brother DCP J1050DW` (spaces) beside `Brother DCP-J1260W` (dash), so every previous raw-string
lookup missed a printer that was sitting right there in the table. The five backend spellings are
probed **concurrently** — serially this left an unresolvable model on a blank page for ~6 s.

**The guard was swept, not guessed.** `isPrinterModelToken` was run against all **977 distinct
`series_codes` in the live catalogue**, which caught five collisions that would otherwise have
shipped: OKI Microline ribbons are *named for the printer* (`ML182`, `ML590`, `ML720`), Fuji Xerox
sells `IX105`/`IX305`/`IX315`/`IX405` toner, ribbon codes start `TD`, Sharp sells `MX-23` and Ricoh
`MP 2014H`, and OKI ships a toner whose code is literally `332DN`. Each cost a prefix or suffix from
the pattern. Final sweep: zero false positives, every incident shape still detected.

**Verified.** `tests/compat-wrong-family-jul2026.test.js` (41 — 31 static + 10 live behind
`LIVE_API=1`); full suite 3307/0. Playwright against the real backend:
`?printer_model=Brother DCP-J1050DW` → canonical hub, 12 products, **all LC431, zero LC531**;
`brother dcpj1050dw` (no separators) → same hub; `Brother MFC-J9999DW` → `/search?q=`, no
compatibility heading; **`Epson XP-200` → `/search?q=` showing only Epson 200 products, none of the
141 `%200%` collisions**. Two-way check on the PDPs: `CLC431XLBK` lists DCP J1050DW; the un-linked
`CLC531XLBK` ($38.49) and `GLC536XLBK` ($130.79) still sell and list only their own printers.

**Reported back to the backend dev** (BF-029, BF-030 — not FE work): the handoff's own verification steps cannot pass
as written — `dcpj1050dw`, `dcpj4120dw`, `mfcj4620dw` (unseparated, i.e. how customers type)
return **zero** products from `/api/search/smart`, with a `did_you_mean` and facets that contradict
the empty result set. `/api/printers/search` is separator-intolerant the same way, and
`printer_models.full_name` is internally inconsistent about separators.

**Lesson.** A handoff that says "no frontend changes required" is a claim about the frontend made by
someone who was not looking at it. Verify the claim, then audit the same failure *class* on your own
side — the backend's bad rows were one instance of "something asserted compatibility it could not
prove", and the frontend had four more.

---

## ERR-133 — A backend handoff said "No FE changes required" while two frontend paths silently deleted the rows it had just shipped (2026-07-30)

**Trigger:** the backend dev handed over `ribbon-for-use-in-search-FE-handoff-jul2026.md`
(commit `1d43034`). It made a product's admin-authored `compatible_devices_html` — the
"FOR USE IN" machine list on ~90 ribbon / typewriter / correction-tape rows — searchable on
**every** printer-shaped query, and made those matches **additive**: they now appear alongside
any cartridges or toners that also match, instead of being suppressed whenever those existed.
The note's headline was **"No FE changes required."** It asked us to sanity-check exactly one
thing (its §5a): do the compat rows survive the results page's literal-search reconciliation?

**All five of its acceptance checks reproduced exactly.** The backend work was right. The
premise about our side was not, and §5a turned out to be the right question asked with the
wrong expected answer — rows were being dropped on two independent paths.

**Root cause.** The Jul-16 guard from ERR-083 protected compat rows by *suppressing* the
reconciliation whenever any row carried `match_reason:"compatibility"`:

```js
const hasCompatMatch = hasCompatibilityMatch(products);
const softMiss = queryHasDigits && … && !hasCompatMatch;
const hijack   = smartCorrected && … && !hasCompatMatch;
```

That is only sound while a compat set is **mutually exclusive** with direct hits — which it was,
because the blob search ran solely as a last-resort fallback. Then "any compat row" implied
"every row is compat", and switching the repair off cost nothing. Commit `1d43034` deleted that
implication without touching a line of frontend code. A guard phrased as *"switch the repair OFF
when X is present"* silently changes meaning the moment X becomes additive.

**Defect 1 — `?exact=1` discarded every compat row.** Exact mode ("Search instead for X" on the
spelling-correction banner) takes the literal set unconditionally:

```js
const shouldUseFallback = exactMode ? true : …;
if (shouldUseFallback) { products = mergedUsed; smartData = null; }
```

The literal union (`/api/products?search=` ∪ `/api/search/suggest`) matches on name and SKU only,
so it **structurally cannot** contain a "for use in" match. The Jul-16 guard never covered exact
mode at all. Measured live: **`/search?q=VP6000&exact=1` rendered a zero-results screen over
three perfectly good ribbons**; `AP830` and `CE60` lost theirs the same way. Reachable by
clicking, not just by hand-typed URL. ERR-083 reintroduced through a door built after it.

**Defect 2 — one ribbon switched off the repair for the cartridges beside it.** With the veto
live, the digit-noise repair never fired for any query carrying a compat row — and `smartCount`,
which counts compat rows, was the bar the literal set had to beat, inflated with rows that set
can never supply. Live:

```
q=CE50   /smart  → CCART319BK, GCE506A, C05XBK  +  154.11*, C143LOT*    (* = compatibility)
         literal → GCE506A, C05XBK, CCART319BK, G05ABK, G05XBK
```

`G05ABK` and `G05XBK` are real HP 05A / 05X toners that `/smart` does not return at all for
`CE50`. **Both were withheld from the shopper.** The handoff generalised from `AP830`, where
`/api/products?search=` returns zero rows so the swap declines on its own; `CE50` and `CE60`
have non-empty literal sets and behave the opposite way.

**Fix.** `partitionCompatRows(products)` → `{ direct, compat }` — stable, pure, and never
comparing two rows' `relevance_score`. The repair is judged against `directCount`, and compat
rows are **carried across every swap** rather than protected by cancelling the swap:

```js
const preservedCompat = rowsNotAlreadyIn(compatRows, mergedUsed);
products = mergedUsed.concat(preservedCompat);
```

Preservation is strictly stronger than suppression — the repair still runs *and* the ribbons
survive — and it covers exact mode, which the veto never did. `hasCompatibilityMatch` remains as
a predicate but is no longer a gate. De-duplication was extracted into one vocabulary,
`productIdentityKeys` (id → upper-cased sku → normalized name), now shared with
`mergeLiteralResults` so the two cannot drift apart.

**Defect 3 — the dropdown showed the ribbons with no explanation.** `search.js` calls `/smart`
too, so the typeahead receives the same compat rows, but it renders through
`Products.renderCard`, which had no compat branch — and `search.css` blanket-hid every
`.product-card__badge` inside `.smart-ac__grid` regardless. Typing `AP830` listed two correction
tapes with nothing saying why. Added the badge byte-for-byte identical to the results-page card,
plus a deliberately **scoped** CSS exception that re-shows only `--compat-match` at a smaller
scale. ERR-125 is the precedent: these two card renderers are duplicated rather than shared, and
the divergence always bites whichever surface ships the feature second.

**Defect 4 — backend, still open.** The handoff states compat rows "append at the bottom" and
"never displace or bury direct results". They do:

```
q=AP1000   G45BK      tier 2  score 131.93
           155.11     tier 3  score 25
           156.11     tier 3  score 25
           C143LOT    tier 3  score 25
           G45BK-2PK  tier 2  score 131.93   ← buried
```

The 2-pack variant of the top hit sits below three score-25 typewriter ribbons.

**The first fix for this was wrong, and the browser is what caught it.** A stable partition was
applied to the flat `/smart` array — direct rows, then compat rows — and 33 unit tests agreed it
worked. Driving the real page proved it was a **measurable no-op**: `loadSearchResults`
re-partitions the set by `product.source` into the Compatible and Genuine grids, renders
Compatible first unconditionally, and re-sorts each grid with `byCodeThenColor`. API order never
reaches the DOM, so nothing imposed upstream of that survives. The reorder moved into
`renderProducts`, after the sort and before `rowBreakIndices` (so the yield-group break lines are
computed against the final order), where it delivers a narrower but real guarantee: within either
grid, a compat row always trails the direct hits. It returns the original array untouched when
there are no compat rows, so every other surface funnelling through `renderProducts` is provably
unaffected.

Consequence worth recording: **the backend's ordering defect has no user-visible effect on this
storefront**, because we never consumed its ordering. It is still reported in
`ribbon-compat-search-FE-response-jul2026.md` §3 for other consumers, downgraded to low priority,
along with two smaller asks — `matched_token` echoes spaced queries raw (`q=ap 830` → `"ap 830"`)
while upper-casing compact ones, and we need the SKU list for the 19 ribbons whose
`compatible_devices_html` is empty.

**Pagination.** Appending compat rows makes the page a composite that the literal set's
`fallback.meta` never counted, so adopting its `total` / `total_pages` would put the three
figures into contradiction — the cross-field disagreement ERR-113 exists to prevent. Measured:
every query that yields compat rows has a literal set of ≤5 rows (`total_pages ≤ 1`), so the
pager is already hidden in all reachable cases. Gating on `preservedCompat.length === 0` keeps it
fully functional whenever nothing was appended.

**Verified.** `tests/ribbon-compat-search-additive-jul2026.test.js` — 33 tests across the
primitive, the dedup vocabulary, the reconciliation wiring, end-to-end fixtures curl'd live on
2026-07-30, the ordering pass, and dropdown/results badge parity. Every one of the six code
changes was mutation-tested individually: revert it, confirm the suite goes red, restore. The
three superseded pins in `compat-search-badge-jul2026.test.js` were rewritten to the new
invariant rather than deleted, with the history left legible in the section header.

**Two hazards this surfaced.** Fixed-width source windows (`slice(idx, idx + 3000)`) in
`product-surface-consistency` and `search-results-parity` failed on this change for reasons
having nothing to do with their invariants — the ERR-124 hazard, now converted to balanced-brace
scans. And `assert/strict`'s `deepEqual` compares prototypes, so an array built by a literal
*inside* a `vm` context fails against a test-realm literal despite identical contents: use
`Array.from(rows, …)`, never `rows.map(…)`, on anything a sandbox hands back.

**Lesson.** A guard written as "suppress the repair when X is present" encodes an assumption
about X's *exclusivity*, not merely its presence — and it ages silently the moment X becomes
additive, because nothing about it looks wrong. The durable shape is **partition, repair the part
that needs repairing, preserve the rest**. And verify a handoff's claims about code you own: "No
FE changes required" was wrong here, and the single item it did flag for checking, it flagged
with the wrong expected answer.

---

## ERR-132 — The admin API wrapper threw the backend's error CODE away, so prose was the only thing left to branch on (2026-07-30)

**Trigger:** the backend dev handed over `order-delete-not-deletable-fix-jul2026.md`. The owner
still could not delete ~20 paid/shipped/completed test orders from `/admin#orders` — the bulk bar
marked every non-`cancelled` selection "N not deletable" and never sent it.

**The surface bug (expected, and small).** That gate was a hardcoded `DELETABLE_STATUSES =
['cancelled']` in `js/admin/pages/orders.js`, correct while the only door was the cancelled-only
`DELETE /api/admin/orders/:id`, and stale from the moment the owner-only hard purge shipped
(`POST /api/admin/orders/purge`, requested as BF-010). The backend now returns an authoritative
per-row, per-caller signal — `deletable` / `delete_method` / `delete_blocked_reason` — and the
frontend simply had to read it instead of re-deriving the rule.

**The real defect, found while implementing it.** `AdminAPI.deleteOrder` did:

```js
if (resp && resp.ok === false) throw new Error(resp.error || 'Delete failed');
```

`js/api.js` `request()` **does** attach `e.code` on its throw path (line ~426), and for
401/403/404/429/5xx it does not throw at all — it *returns* an `{ok:false, code}` envelope so
callers can render targeted UI. Every AdminAPI method that unwrapped one rebuilt it as a bare
`Error`, dropping the code on the floor. **35 call sites** did this. Because the code never
survived the wrapper, the conclusion drawn — and written down — was that `js/api.js` doesn't
provide one:

- `.claude/memory/backend-fixes.md` BF-010: *"`js/api.js` attaches no `err.code` on the generic
  throw path, so prose-matching is currently the only way to branch (cf. ERR-077)."*
- `tests/admin-order-delete-gating.test.js`: the same claim, in the comment justifying a test.
- `~/Downloads/order-hard-purge-request-jul2026.md` §5 asked the backend for a machine-readable
  code that the frontend was already being sent and then discarding.

That is the ERR-077 trap reproduced one layer up, and it had hardened into documentation. It
mattered here specifically: the purge endpoint returns **200 with a `failed[]` array**, and a
403 arrives as a resolved envelope rather than a rejection — neither can be handled by reading
English.

**Fix.**

- New ONE vocabulary `js/admin/utils/order-deletability.js` — pure, DOM-free, no imports, unit-
  tested directly. It owns the two doors, the block reasons, the copy, the confirm wording and the
  purge-response normalisation. `DELETABLE_STATUSES` is gone; it survives only as
  `LEGACY_DELETABLE_STATUSES`, the fallback for rows carrying no contract fields — and that
  fallback can **never** yield a purge, because the frontend must not infer a role.
- One module-level `errorFromEnvelope(resp, fallback)` in `js/admin/api.js`, used at all 35 sites.
  Same message everywhere, so no caller behaviour moved; there is now a `.code` to branch on. It
  also handles the seven sites whose `resp.error` is a `{code, message}` object rather than a
  string — those would have produced `new Error([object Object])` had the message ever been absent.
- `AdminAPI.purgeOrders(ids)`: dedupes, chunks at 25 sequentially, treats a 200-with-`failed[]` as
  the documented success shape, and throws **only when nothing was accomplished** — once a chunk
  has returned, a later failure degrades into `failed[]` rather than discarding the record of what
  was already irreversibly purged.
- `bulkDelete` groups the selection by door, names both counts before the click (`Purge 9 · Delete
  3` — never one number hiding a hard purge), and reports outcomes in five distinct buckets. The
  fifth is the point: **`unaccounted`** — an id the purge response mentioned in neither `deleted`
  nor `failed`. It is neither a success nor a failure, and after an irreversible operation, calling
  it either one is the most dangerous lie available (the ERR-074 shape).
- The order-detail modal resolves its right with `resolveDeleteRight(fullOrder, listRow, order)`.
  The contract is only promised on the **list** endpoint — and this was **measured, not assumed**:
  `GET /api/admin/orders/:id` returns all three fields as `undefined` while the same order's list
  row carries them. Gating on the detail payload alone would therefore have legacy-resolved every
  `paid`/`shipped` order to blocked and the owner would have found no delete button at all — the
  whole feature silently deleted, with no error anywhere. Logged as BF-024 Q3.
- A blocked order now keeps a **disabled** button carrying its reason instead of no button:
  "linked to an invoice / quick order" is the one refusal an owner will actually meet, and hiding
  the control left that fact nowhere to be stated on the surface showing that order.
- `_seenOrders` now caches a role-dependent *permission*, so it is evicted for every attempted id
  (refusals included — a refusal is newer information than the cached contract), on a status
  change, and on tab destroy.
- A page of rows arriving with no contract fields logs one `DebugLog.warn`. A backend rollback
  would otherwise revert this whole surface in silence.

**Verified:** `tests/admin-order-delete-gating.test.js` rewritten to 66 tests — the four contract
rows verbatim, byte-exact copy, the loud-unknown battery, the legacy fallback proven never to yield
a purge, purge-response normalisation including `deleted`-as-a-count and both-lists conflicts, and
the source invariants. Endpoint deployment confirmed by probe (`POST /api/admin/orders/purge`
returns `401 UNAUTHORIZED` unauthenticated where a bogus sibling path returns `404 NOT_FOUND`) and
then **driven live in the admin as the owner**: 20/20 rows carry the contract, 18 offer `purge`
(15 non-`cancelled`), 2 are blocked `invoice_link`; the bulk bar reads
`20 selected · 18 purge · 2 blocked` / `Purge 18`; the confirm dialog carries all four warnings and
fires **zero requests** on Cancel; a `shipped` order's modal button reads **Purge**, an
invoice-linked one is **disabled** with the reason and its fix in the tooltip.
Cache-bust `APP_VERSION 2026.07.30-order-hard-purge` + `npm run build`. Contract and the five open
backend questions recorded in `order-hard-purge-contract-jul2026.md` (BF-024) — the handoff's
referenced `docs/admin/order-hard-purge-backend-response-jul2026.md` was never delivered.

**Lesson.** A wrapper that discards a field is indistinguishable, from the outside, from a backend
that never sent it — and the wrong conclusion gets written into the docs, the tests and the next
handoff, where it licenses exactly the fragile pattern it was supposed to prevent. Before asking a
backend for something, check your own layer isn't already throwing it away. And when a rule moves
from the client to the server, delete the client's copy rather than leaving it as a "fallback"
that can still take the privileged path.

## ERR-131 — The Invoices PAID slider called a route that was never built, and the SENT column read three field names the backend never shipped (2026-07-30)

**Trigger:** the backend dev handed over `invoice-paid-toggle-and-email-log-FE-handoff-jul2026.md`,
opening with two operator reports: "PAID slider did nothing" and "SENT column always showed —".

**What was wrong.** Two independent failures, one shared cause: the frontend was addressing an API
that had been *agreed* rather than *observed*.

1. **The PAID toggle POSTed to a 404.** `AdminAPI.markInvoicePaid()` called
   `POST /api/admin/invoices/:id/paid`. That route never existed. Probed live before writing a line
   of code:

   ```
   POST  /api/admin/invoices/<id>/paid   → {"ok":false,"error":{"code":"NOT_FOUND",…}}
   PATCH /api/admin/invoices/<id>/status → {"ok":false,"error":{"code":"UNAUTHORIZED",…}}
   ```

   (401 = the route is there and wants a token; 404 = it isn't.) Every flip landed in the
   `NOT_FOUND` branch, sprang the checkbox back, and toasted *"Mark-paid isn't available yet
   (backend endpoint pending)"* — which reads as a known-pending feature rather than a wrong URL.
   **That reassuring message is why it sat broken for a month.** A fail-soft that names a plausible
   innocent cause is worse than a raw error: it stops anyone looking.

2. **The SENT column read field names that were never shipped.** `sentInfo()` looked for
   `last_emailed_at` / `last_emailed_to` / `email_count`, the names written into the Jul-10 handoff.
   The backend shipped `emailed_at` + `email_count` and **no recipient field**. Nothing matched, so
   every row silently fell through to the per-browser `localStorage` backstop — invisible to a
   second operator, empty on a fresh browser, and indistinguishable from "never emailed".

**What the audit found.** A third defect, and it is the one that would have shipped broken:

**The backend forbids PATCH at the CORS layer.** The new route is PATCH-only, and the API answers a
PATCH preflight with `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS` — **no PATCH** —
from the production origin as well as localhost. So the browser kills the request before it is
sent. Confirmed there is no frontend way around it: `POST`/`PUT` on `/status` both 404, and
`X-HTTP-Method-Override` is not honoured. PATCH had never been used against this API before (the
HTTP client didn't even have a `patch()` helper), which is exactly why the gap went unnoticed.
Tracked as **BF-021**; it is a one-line change on the backend.

**The trap this had to avoid.** Two of them:

- **Coercing an unknown count to a fact.** A legacy invoice comes back with a real `emailed_at` and
  `email_count: 0`, because the send predates the log table. The old code read `num(x) || 1`, which
  would have printed "sent 1 times" as though it were known. 0 here means *unknown*, so the count
  phrase is suppressed instead of invented.
- **Rendering a failed read as "never emailed".** `listInvoiceEmails()` returns `null` on failure
  and `{count:0, emails:[]}` when the server genuinely has nothing. Collapsing those two prints
  "this invoice hasn't been emailed yet" over a backend hiccup — which is precisely how an operator
  double-sends an invoice. They are separate branches with separate copy, and a test asserts the
  error branch can never contain the empty-state sentence. Seventh incident in the
  absence-as-zero family (ERR-063/068/073/075/076/127).

**Fix.** `js/api.js` gained the missing `patch()` verb. `markInvoicePaid()` was **deleted** — a dead
route must not survive as a second way to do the thing — and replaced by `setInvoiceStatus()`
(`PATCH /:id/status`, with a frozen `INVOICE_STATUSES` list that excludes `void`, because voiding
also cancels the shadow order and must stay on `POST /:id/void`). `sentInfo()` reads `emailed_at`
with the old name kept as an alias. The SENT cell became a `<button>` — which also keeps the editor
shut on click for free, since DataTable's row-click guard already skips
`closest('button, a, input')` — opening a send-history modal built on the existing `Modal`
component (an anchored popover inside the table's scroll container would have been clipped, ERR-107).
The toggle now repaints the row from `data.invoice.status` rather than from the checkbox, and
reloads instead when an active status filter no longer matches. A blocked preflight surfaces as
copy naming the actual suspect instead of a bare `Failed to fetch`.

**Verified:** 42 new tests plus 20 updated (`admin-invoice-status-email-log-jul2026.test.js`,
`admin-invoice-sent-indicator.test.js`); full suite **3139 pass / 0 fail**. Five mutations
(count-0 coerced back to 1, read-error branch removed, cell reverted to a `<span>`, `void` admitted
to the status list, `null` collapsed to an empty result) each turn the suite red. Driven live in
headless Chromium signed in as the owner: SENT now renders real server dates on every row (all five
were "—" before), the history modal loads over a real 200, blocking the read shows the error branch
with a retry and never claims never-sent, and hostile `recipient_email` / `subject` values render as
inert text with no `alert()` and no injected node. The toggle's success path was proven by stubbing
only the transport — including the case where the server disagrees with the click, where the
server's status wins.

**Lesson.** A handoff document records an intention; only a probe records an API. Both halves of
this failed the same way — a field name and a route path, each taken on trust from a doc, each
wrong, each failing silently for a month. Curl the endpoint before wiring it, and again before
believing it works from a browser: a route that answers curl can still be unreachable from the page.

---

## ERR-129 — Admin money columns never said whether they were GST-inclusive; Price and Cost sat two columns apart on opposite bases (2026-07-29)

**Trigger:** owner screenshot of `/admin#products` — "add a small incl. gst or excl. gst wherever
there is a price/cost/number amount… just so we know whether the prices or costs incl or excl GST
when I look at them."

**What was wrong.** NZ GST is 15%, and the admin shows money on both sides of it in **adjacent
columns** with nothing on screen to distinguish them. On the Products list `retail_price` is
GST-inclusive and `cost_price` is GST-exclusive — `$11.49` and `$5.41` two columns apart, on
different bases, and the only way to know was to read `js/admin/utils/profitability.js`. The same
ambiguity ran through Orders (Total incl. / line Price excl.), Invoices, Expenses and the
Dashboard KPIs. This is a tax-return-grade ambiguity, not a cosmetic one.

**What the audit found.** Two things worse than the missing labels:

1. **Four spellings of the basis were already live** — `(excl. GST)`, `(incl GST)`, `(ex GST)`,
   `(ex-GST)`/`Ex-GST` — because each page that bothered to state it invented its own wording.
   Four spellings is how a fifth gets added.
2. **~25 money fields have no provable basis at all.** All of Price Monitor, Customers
   `total_spent`, the Finance top KPI strip, the Dashboard's margin-by-brand/category charts,
   refunds, promotions, coupons — pure backend passthrough, no GST arithmetic anywhere in the
   frontend, no field name asserting it, no note recording it. And two are actively *contradicted*
   between our own files: `pnl.revenue` is asserted ex-GST by `utils/expense-math.js` and proven
   incl-GST by `pages/financial-health.js` (which shows the arithmetic), and Stripe fees carry
   three mutually incompatible conventions (ERR-114, still unsettled).

**The trap this had to avoid.** The obvious move — label everything from the most plausible
reading — is the one that does real damage. A *wrong* GST basis on an admin money figure is worse
than no basis, because it is how a wrong GST return gets filed. So the rule is: **a blank sub-line
is a deliberate signal meaning "nobody has proven this"**, and `tests/admin-gst-basis-labels.test.js`
§5 fails the build if a future PR quietly labels one of the unknowns from a guess.

**Fix.** One vocabulary module, `js/admin/utils/gst-basis.js`, exporting seven frozen strings
(`incl. GST`, `excl. GST`, `excl. GST base`, `net of GST`, `GST-netted (mixed basis)`,
`excl. GST when claimable`, `GST amount`) plus a `gstSub()` helper for hand-written headers.
`components/table.js` gained one column property, `col.gst`, rendered as a muted second line —
that single edit covers all ~27 DataTable pages. `col.label` is HTML-escaped, which is precisely
why a new property was needed rather than markup in the label. Everywhere the basis was already
stated inline, the inline text was **removed in the same commit** as the sub-line was added, or the
header would print it twice.

Profit says **"net of GST"**, never "excl. GST": order and invoice profit is GST-*neutral* — ex-GST
on the revenue side and the cost side, so GST passes through and nets to zero. "excl. GST" would
imply a further 15% is still to come off.

`gst-basis-backend-brief-jul2026.md` is the register of every blank, what the backend must confirm
per field, and the response-field naming (`<field>_incl_gst` / `<field>_excl_gst`, or a sibling
`gst_basis` enum map) that would let us fill them without another round trip. A payload-level
"everything here is incl. GST" flag is explicitly rejected — the Finance P&L already proves one
payload mixes bases row by row.

**Verified:** 19 new tests pass; measured in headless Chromium against the real `admin.css` that
the sub-line drops to its own line, neutralises the header's uppercase + 0.06em tracking, keeps
`font-weight:400` against the light theme's `700` rule, and does **not** clip inside the shipped
`.col-w-price` (80px) / `.col-w-pct` (90px) widths. Header rows grow ~11px.

---

## ERR-128 — The cart's "Proceed to Checkout" sat ~900px down a sticky sidebar that was too tall to ever stick (2026-07-29)

**Trigger:** owner screenshots of `/cart` — "the proceed to checkout button is way too far down…
is everything in the order summary sidebar necessary?"

**What was wrong.** `.cart-summary` had grown by accretion. Every conversion feature shipped since
May 2026 — free-shipping nudge and progress bar, free-ship unlock upsell, delivery promise,
same-day dispatch countdown, saved-until, loyalty earn chip, loyalty redeem widget, coupon
disclosure, trust chips — appended itself **above** the checkout button, because at the time each
one was written that was simply the end of the list. Nobody ever owned the question *"what must a
buyer see before the button?"*, so the answer defaulted to *everything*. Measured on a 4-item
cart: the CTA sat **618px** into an **811px** aside, below the fold at 1440×900.

**The second-order effect is the interesting part.** `.cart-summary` carries
`position: sticky; top: var(--spacing-lg)`, which had been **inert since the day it was written**.
A sticky element taller than its scrollport is scrolled fully into view before it can ever pin. So
the mechanism intended to keep the button reachable and the reason the button was unreachable were
the same fact — the sidebar was too tall. No amount of CSS debugging on the sticky rule would have
found it; the fix was to make the box shorter.

**Two content defects the reorder surfaced:**

1. **The sidebar contradicted itself about shipping.** `Shipping: Calculated at checkout` rendered
   four lines above a green `Your order qualifies for free shipping`. The reason nobody had
   reconciled them: **nothing ever wrote `#cart-shipping`**. No JS assigned it, no test referenced
   it, and `#cart-shipping-tier` beside it was equally inert — both had been dead markup since the
   page was built, so the "Calculated at checkout" text was a hardcoded string that no code owned.

2. **Coupon and loyalty points each took a full block to offer two discounts the server rejects in
   combination.** `renderCartLoyaltyControl` already disabled each when the other was applied —
   the mutual exclusivity was known, just not expressed in the layout.

**Fix.** The CTA and the SSL reassurance line moved to directly under the Total and the
free-shipping state; everything promotional was demoted below them. Coupon and points merged into
one `<details id="cart-discount">` — deliberately a **shared wrapper** with the inner markup moved
byte-for-byte, so `initCouponForm` and `initLoyaltyControl` (which resolve by id only) needed no
rewiring at all. `#cart-shipping` now reads "Free", gated **strictly** on
`serverSummary.qualifies_for_free_shipping === true`, and that gate also suppresses the duplicate
banner; the local `Shipping.getSpendMore` fallback is a frontend threshold calculation and is
**never** allowed to write the money row — unknown shipping stays "Calculated at checkout" and is
never shown as free (DEC-006). GST dropped from a full row to a caption under the Total, which
incidentally revived `#cart-gst`: two lines in `cart.js` had been writing to an element that did
not exist. Result: CTA at **325px**, above the fold, and the sticky pins for the first time.

**`syncDiscountAccordion()` — auto-open is correctness, not polish.** A closed `<details>` does not
render its contents, so with the drawer shut `#cart-loyalty-feedback` (`role="status"
aria-live="polite"`) would never announce *"Points applied to this order."* and the "Remove points"
button would be unreachable. It therefore opens itself whenever a code or points are actually
applied — behind a one-shot `dataset.autoOpened` latch, because the renderer runs on every cart
mutation and would otherwise re-open the drawer in the face of a shopper who just collapsed it.
The coupon-lock notice is owned via a `dataset.lockNotice` marker so that removing the points
clears it again **without** clobbering a preview/apply result showing in the same element.

**Verified.** Ten guard suites run per-file (mobile-parity, loyalty-points, mobile-ux-audit,
business-account-pricing, traffic-conversion, merchant-center-readiness, text-fit,
google-ads-compliance, asset-cache-tokens, console-debuglog-audit) all green; full suite 3077 pass.
Playwright: the shipping row across `serverSummary` null / `{}` / not-qualifying / qualifying; the
latch across apply → collapse → remove → re-apply; and `checkout.html`'s `.cart-loyalty` card
chrome confirmed byte-identical, since the flattening override is scoped to `.cart-discount`, a
class no other page ships.

**Lessons.**

- A sticky sidebar is a **height budget**, not a decoration. If nobody owns what goes above the
  CTA, every new feature goes there, and the sticky quietly stops working long before anyone
  notices the button moved.
- When two elements state contradictory things, check whether either is written by any code at all
  before trying to reconcile them. Here one of them was dead markup.
- When taking a "did I break this?" measurement, let the layout settle first. A
  `getBoundingClientRect` read racing a viewport resize reported a phantom 52px mobile overflow;
  re-measuring after the reflow showed the element matched the pre-change build exactly. The
  comparison method was sound — serving the `git show HEAD:` copies of the four touched files on a
  second port — but a single racy sample nearly turned it into a false positive.

---

## ERR-127 — Three customer money surfaces each had their own arithmetic; one printed the TOTAL as the SUBTOTAL, another read unknown shipping as free (2026-07-28)

**Trigger:** a backend handoff asked us to add a loyalty points line to "the customer-facing
downloadable invoice PDF". Verifying that ask found there was no such PDF — and, on the way,
found that the pages it would have been generated from did not agree with each other.

**What was actually wrong, three separate defects:**

1. **`/account/order-detail` printed the total under the "Subtotal" label.**
   `order-detail-page.js:139` was `const subtotal = order.subtotal || order.total;`. Whenever the
   payload omitted `subtotal`, the page rendered the **total** as the subtotal. The page also had
   **no discount row of any kind** and a hardcoded `<dt>GST (15%)</dt><dd>Included</dd>`, so on any
   order with a loyalty redemption the three visible figures did not add up — Subtotal + Shipping
   ≠ Total, with nothing on screen to explain the gap.

2. **`/order-confirmation` read unknown shipping as free.**
   `renderTotals` did `order.shippingCost || order.shipping_cost || 0`, then estimated points as
   `floor(total − shipping)`. An order whose shipping we couldn't read estimated off the **full
   total** and overstated the points by the shipping amount. Same file also invented a subtotal
   from line items (`order.subtotal || order.items?.reduce(...)`) and a total from
   `subtotal + shippingCost` — a total that ignores every discount.

3. **The earn rule lived in the client at all.** Reimplementing a backend pricing rule in JS is a
   DEC-004 violation on its face; doing it with `|| 0` fallbacks is how it became wrong.

**Root cause.** Three surfaces, three private copies of "how do you read an order's money". No
shared helper existed, so each grew its own fallbacks, and the fallbacks all made the same
mistake: **collapsing UNKNOWN into 0**. This is the sixth incident in that family
(ERR-063/068/073/075/076).

**Fix.** One module, `js/order-totals.js`, is now the only place an order's money is read:

- `normalise(order)` — `null` means NOT REPORTED, `0` means REPORTED AS ZERO, and nothing collapses
  one into the other. Accepts both the raw API row and the camelCase sessionStorage snapshot.
- `rows(t)` — the ordered, labelled row list. Row order, labels and visibility exist **once**.
  Unknown subtotal/total render an em-dash; unknown shipping renders an em-dash (not "FREE");
  unreported GST fail-softs to "Included" (not `$0.00`); loyalty/B2B/coupon rows are omitted
  entirely below $0.01.
- The points estimate now collapses to **nothing** when either input is unknown, and carries a
  written caveat rather than a bare `≈`.
- `footing` cross-checks that the rows add up (the ERR-113 consistency-gate habit). The customer
  always sees the backend's figures verbatim; a mismatch is logged, never silently rendered.

`/order-confirmation`, `/account/order-detail` and the new receipt PDF all render from the same
`rows()` array, so they are now structurally incapable of disagreeing (DEC-006).

**The premise correction.** There was no customer-facing PDF. jsPDF loaded only on `/admin`; the
only builder was `buildInvoiceDoc()`, the operator's B2B tax invoice. Customers had no receipt at
all. Built `js/order-receipt.js` — lazy-loaded jsPDF, downloadable from both order surfaces.

**Two bugs in the admin builder deliberately not copied:** it walks a y cursor with no bound check
against A4's 841.89 pt (long orders write the totals off the page), and it never calls `setPage()`
after `autoTable`, so a multi-page items table gets its totals drawn on page 1. Both are still
present in `js/admin/pages/invoices.js` — **not fixed here**, logged as a follow-up.

**Verified:** `tests/order-totals-jul2026.test.js` (39) and `tests/order-receipt-jul2026.test.js`
(41) — the latter drives the real builder against a recording fake jsPDF and asserts nothing is
drawn past the page box at any table-end position, that the doc is re-anchored after `autoTable`,
and that every string reaching the PDF is cp1252-safe. Full suite 3078 pass / 0 fail.

**Lesson.** When the same concept is rendered on N surfaces, the drift is not a question of
discipline — each copy will independently grow the *same* convenient fallback, and `|| 0` is
always the convenient one. The fix is not "be careful", it is one function returning one row list
that every surface walks. And when a handoff describes something you own, verify it exists before
planning around it: two of the three premises here were wrong.

---

## ERR-126 — An expired password-reset link rendered NOTHING: the page called `Security.escapeHtml` without loading `security.js` (2026-07-28)

**Symptom.** Open `/account/reset-password` from an expired or malformed reset email link. Expected
"Reset Link Invalid" with a "Request a New Link" button. Actual: the unchanged password form, no
message, no explanation — and a `ReferenceError` in the console.

**Root cause.** `html/account/reset-password.html` loaded neither `/js/security.js` nor
`/js/utils.js`, but `js/reset-password-page.js` calls `Security.escapeHtml(message)` to build that
very message (`:30`) and `DebugLog.error(...)` in all three catch blocks (`:55`, `:63`, `:170`).
So the **only** code path that reports a bad link was the one path guaranteed to throw.

The happy path never touched either global, which is exactly why this survived: every successful
password reset worked perfectly. Only users already having a bad day hit it.

**Second instance, same shape.** `html/account/verify-email.html` loads `auth.js` without
`utils.js`, and `auth.js` calls `DebugLog` from its `accountSync`/`init` **catch** blocks — so a
sync failure there threw a second `ReferenceError` that swallowed the first.

**Fix.** Added `security.js` + `utils.js` to both pages, in the canonical prefix order every other
account page uses.

**Deliberately NOT done: adding `auth.js` to the reset page.** The obvious "every session page
should load auth.js" tidy-up would have been a regression. `Auth.init()` creates a Supabase client
with `detectSessionInUrl`, which would race this page for the recovery tokens in the URL hash and
could consume them before the handler reads them — breaking password reset outright. The account
sync it would trigger is unnecessary anyway: a password reset is for an **existing** account, and
the user's next navigation fires the sync regardless. The reason is documented in the HTML and
pinned by a test, so it does not get "fixed" later.

**Fix is a test, not a list.** `tests/session-page-globals-jul2026.test.js` reads each page's own
script tags, reads those scripts, works out which globals they reference **unguarded**
(`typeof X !== 'undefined'` counts as an optional dependency and is skipped), and asserts the
defining module is on the page. Derived, never an allowlist — an allowlist that forgets a file is
what let banned copy ship twice (ERR-063).

Reverting the fix makes it name the bug exactly: *"reset-password.html: loads
reset-password-page.js, which uses `Security` unguarded, but never loads security.js"*.

**One thing the test does NOT assert: script ORDER.** The first version did, and reported ~40
pages. All false: `defer` order only matters for references that execute at load time, and nearly
every reference here sits in a function that runs on `DOMContentLoaded` or later. A test that
cries wolf is a test people learn to skip, so ordering is asserted only in the two specific cases
where it was verified to matter.

**Verified:** `tests/session-page-globals-jul2026.test.js` (8), including a sanity assertion that
the page sweep found 30+ pages so the derivation cannot silently collapse to zero.

**Lesson.** A missing dependency that only the error path touches is invisible to every happy-path
test and every manual check — the feature works right up until it needs to tell you it didn't.
Grep for what a file *uses*, not for what it *is*.

---

## ERR-124 — Backend said "no FE changes required" for the new edge cache; verifying it found a bearer token that does NOT bust the cache key, and four duplicate cache keys of our own (2026-07-28)

**Handed over:** `catalog-edge-caching-fe-notes-jul2026.md` — Cloudflare now edge-caches catalog GETs;
TL;DR *"Response shapes are unchanged — no FE code changes required."* Rather than take that on trust,
every claim was measured against the live API. The caching is real and excellent (`cf-cache-status: HIT`,
**44 ms cached vs 205 ms uncached**). Three of the note's claims are wrong, and we had real defects the
note assumed we didn't.

**The finding that mattered.** The note says logged-in users bypass the edge "by design". Measured:

- `Authorization: Bearer <token>` → **`cf-cache-status: HIT`**. The token does **not** change the cache key.
- `Cookie: sb-*` → `MISS`. The cookie bypass works — but supabase-js here stores the session in
  **localStorage**, and `api.inkcartridges.co.nz` sends **no `Set-Cookie` at all**, so no cookie ever rides
  along. **Nothing was bypassing.**

Meanwhile `api.js:206` attached `Authorization` to *every* request whenever a session existed. So every
logged-in visitor's catalog reads were served from — and eligible to be written into — the **shared
anonymous cache entry**. A token that changes the response but not the key is the classic cache-poisoning
shape. `product-detail-page.js` made it concrete: it deliberately `await`ed the session so a token would
ride on `/api/products/:sku` "for admin-gated products", i.e. we knew that response varies by identity.

**Root cause (ours), four ways the cache key was being fragmented:**
- `_productsForCode()` appended `brand,category,code,limit`; `getShopData()` appended `…limit` **before**
  `code`. Identical question, two URLs, two edge entries — on the codes-drilldown hot path (shop-page
  drilldown + PDP related products). **Actively duplicating a key we had just warmed.**
- Three separate `/api/products` serializers with three different param orders.
- Four `new URLSearchParams(obj)` sites inheriting the *caller's object literal key order*.
- `getProducts()` had dead code: `if (filters.limit) params.append('limit', filters.limit || Config.ITEMS_PER_PAGE)` — the guard makes the fallback unreachable, quietly implying "no limit" and `limit=20` are one request. At the edge they are two keys.

**Fix.** (1) ONE canonical serializer — `API.catalogQuery`/`catalogEndpoint` driven by
`CATALOG_PARAM_ORDER`. Its leading seven keys deliberately reproduce `getShopData`'s historical order so
the storefront's hottest URLs kept the edge entries they already held — the deploy did not cold-start the
catalog. Params outside the list are **preserved**, sorted, after the known ones: silently dropping
`include_unavailable` would give a wrong-but-plausible result set (the ERR-075 failure mode), which is far
worse than one extra cache key. (2) An explicit `{ anonymous: true }` contract on `request()`: no token, no
cookies, no `X-Guest-Session`, no 401 refresh-retry, and an anonymous response may never seed a
guest-session id — a shared cached response carrying `X-Guest-Session` would hand **every** visitor the
same guest cart. (3) `credentials` now comes from that explicit intent, never from sniffing the
Authorization header; the old inference welded the two knobs together so neither could be changed alone.

**Deliberate trade:** admins lose in-storefront preview of admin-gated products until the backend ships an
uncached `/api/admin/products/:sku` (BF-013). Leaking an unpublished product into a public cache entry is
the worse outcome. The PDP's `await Auth.readyPromise` went with it — pure latency on every product page.

**Also fixed:** `cart.js` cross-sell fetch sent `credentials: 'include'` unconditionally on a public
catalog read (the one FE fetch that could bypass the edge for *every* visitor); `getBrands()` had no client
cache at all despite eight admin controllers calling it — now SWR, 5 min.

**Two traps hit while building this.** A comment containing the literal `/api/products/*` opened a fake
block comment for `stripComments()` in two existing tests (`/*` … next `*/` ate the whole file, so every
assertion silently passed against an empty string). And fixed-width `slice(start, start + 700)` windows in
source-scanning tests turn vacuous the moment a method grows a doc comment — replaced with a
`methodBody()` helper that slices to the real method close.

**Verified:** `node --check` clean on all three modules. New `tests/catalog-edge-cache-jul2026.test.js`
(25) — mutation-tested: reverting the param order, re-attaching the token, and hand-rolling
`_productsForCode`'s query each fail 3/1/2 tests respectively, so the suite is not decoration. Two existing
tests updated to pin the *new, stronger* contract rather than the mechanism they used to pin
(`api-subdomain-cutover-may2026`, `product-surface-consistency-may2026`). Full suite **2880 pass / 1 fail**,
the single failure being a stray `products-sourcing-columns.png` left at repo root by concurrent work in
another session, not this change.

**Backend (PENDING):** `catalog-edge-caching-backend-brief-jul2026.md` — BF-011 make `Authorization` a
cache-rule bypass condition (or `Vary: Authorization`); BF-012 confirm whether `/api/products/:sku` and
`/api/shop` vary by identity (admin-gated products, B2B pricing) — if yes, BF-011 is a correctness bug;
BF-013 uncached admin preview endpoint; BF-014 `/api/site/*` is documented as cached but returns
`max-age=3600` with no `s-maxage` and is `DYNAMIC` on every repeat; BF-018 `/api/schema/*` asks for
`s-maxage=3600` but the rule doesn't match it, and **404s are cached 5 min + 10 min SWR** so a
newly-published SKU can stay a hard 404 for 15 minutes.

**Follow-up audit, same day — the first sweep missed three classes.** Asked "anything else needed?", so the
codebase was re-audited rather than declared done. It found: (1) `AdminAPI.getBrands()` calling
`window.API.get('/api/brands')` directly instead of the now-anonymous `API.getBrands()` — eight admin
controllers were sending a token to an edge-cached endpoint and each paying a full round-trip; (2) **fifteen**
more public reads still on the authenticated path (all seven ribbon helpers, `searchPrinters`, `smartSearch`,
`searchSuggest`, `getPrintersByBrand`, `getCompatiblePrinters`, `searchByPrinter`, `searchByPart`,
`getCompatibility`, `getColorPackConfig`) — none currently cached (`private, no-store`), so latent rather than
live; (3) seven bare `fetch()` calls that were anonymous only by accident of `fetch()`'s `same-origin` default
against a cross-origin API — correct today by configuration, not by statement, and invisible to a reader.
All converted; `credentials` is now stated on every API fetch in the codebase.

**And one genuine hole, the worst finding of the whole engagement:** `GET /api/products/:sku/waitlist/status`
returns **per-user** state but sits under the `/api/products/` prefix Cloudflare's Cache Rule matches. Verified
live — it returns `public, max-age=0, s-maxage=300, stale-while-revalidate=600` and a repeat request is
`cf-cache-status: HIT` (the 401 itself was cached). With a bearer token not changing the cache key, one
signed-in shopper's waitlist state can be stored in the shared entry and served to everyone for 5 minutes.
**Not exploitable through our frontend** — the waitlist UI was retired for the "Contact us" OOS CTA and
`waitlistStatus()` has zero callers. The wrapper is deliberately NOT deleted (concurrent work in
`tests/traffic-conversion-jul2026.test.js` §3 requires the waitlist wrappers stay mounted so cached bundles
can't 404); instead it is marked **DO NOT CALL** with the measurement inline, and §9 fails the build if
anything starts calling it. Raised as **BF-020**. The general lesson for the backend: a path-prefix cache rule
over a resource tree that mixes public and per-user sub-paths will eventually cache the wrong one — `/reviews`
and `/jsonld` are fine, `/waitlist/status` is not.

**Deliberately left dormant, not deleted:** the PDP's inactive-test-product gate
(`product-detail-page.js`, `_isTestProduct && !active && !isCachedSuperAdmin`). Its positive case is now
unreachable — the anonymous read means the backend never returns such a product — but removing it would
silently ship unlisted products to shoppers the moment admin preview returns via BF-013. It now carries a
comment saying exactly that.

**Follow-up verified:** 6 new tests (§9) covering the direct-`API.get` scan, the admin delegation, all fifteen
converted helpers, the waitlist hazard, explicit credentials on every bare API fetch, and the dormant gate —
mutation-tested at 2/1/1 failures. Two existing tests updated: `search-results-parity-may2026` (stub moved
from `API.get` to `API.getPublic`) and the waitlist assertion reconciled with concurrent work rather than
overridden. Full suite **3076 pass / 0 fail**. Live browser, signed in: eleven newly-converted public reads
all send no `Authorization`, while `/api/cart`, `/api/user/reviews` and `/api/user/favourites` still do.
Also raised **BF-019** (public catalog endpoints marked `private, no-store` — `/api/ribbons`,
`/api/printers/trending`, `/api/color-packs/config` — free latency the backend can claim).

**Third pass — the split-module finding.** Asked a second time whether anything remained. The catalog-cache
work itself was confirmed complete (an audit of all fifteen converted helpers returned a clean bill of health:
no admin surface depends on authenticated-only visibility; admin ribbon CRUD goes through `/api/admin/ribbons`
+ Supabase RLS, never `API.getRibbons`; the five admin callers of `searchPrinters`/`getCompatiblePrinters` are
cosmetic or self-heal via the existing 409-duplicate path). But checking exposed a pre-existing hazard on an
axis nothing tested: **a module's identity in the browser is its URL**, so `./api.js` and `./api.js?v=token`
are two DIFFERENT modules — both fetched, both evaluated, exports not identical. Three modules were split that
way: `admin/api.js` (app.js tokened vs pages/planner.js bare), `components/table.js` (ONE of 28 importers
tokened), `components/rich-text-editor.js` (one of two).

**Correction to the instinct this started from.** The first read was "my admin/api.js change won't reach cached
clients". That is wrong, and worth recording so nobody re-derives it: `vercel.json` serves `/js/(.*)` with
`Cache-Control: public, max-age=0, must-revalidate` (confirmed live), so browsers revalidate every module on
every load and pick up changes with or without a query string. The tokens were never load-bearing for busting —
they were only forking modules. Impact was therefore duplicate bytes and parse time, not staleness and not a
correctness bug (`table.js` has no module state beyond an `esc` helper, and nothing does `instanceof DataTable`).
It is fixed anyway because it turns into a correctness bug the day someone adds shared state.

**Fix:** the three stray tokens are gone; every static ES import is now bare and each module resolves to one
URL. `APP_VERSION` still versions the dynamic `./pages/*.js` imports — that mechanism is systematic (one
constant, not per-call-site literals) and is deliberately kept. A new **§4** in
`tests/asset-cache-tokens.test.js` pins both halves: every local static import resolves to exactly one URL
repo-wide, and the dynamic page import still goes through `APP_VERSION`.

**Six older tests had to be re-pointed**, and this is the interesting part: each asserted that these static
imports *must carry* a `?v=` token — i.e. they were pinning the very convention that was creating the split.
They are the same anti-pattern `asset-cache-tokens.test.js` was written to retire (its docblock: nine files
each pinned a moving token to their own era's literal, all nine went red, "a test that cannot ever be green is
worse than no test"). Each is now re-pointed at the invariant ("imported under one URL") instead of the
mechanism, with their still-valid `APP_VERSION` assertions left intact.

**Verified:** §4 mutation-tested — re-adding any one of the three tokens fails it, and deleting the dynamic
`APP_VERSION` import fails it. Full suite **3078 pass / 0 fail**. Live admin console in bundled Chromium: no
module is requested under more than one URL, and `admin/api.js` resolves to a single `/js/admin/api.js`.

**Lesson:** a handover note saying "no changes required on your side" is a hypothesis, not a result. Ten
minutes of `curl` against the live edge disproved three of its claims — including one that made every
signed-in visitor share the anonymous cache. When someone hands you a performance change, measure the
thing they said you don't need to measure.

---

## ERR-120 — No admin surface for page copy; the safe rebuild, and the two traps it had to walk around (2026-07-27)

**Asked:** "do we have a place in the admin center where I can change what is on the pages such as
the about us page or the policy page?" **Answer was no** — and deliberately so: the legal-content
CMS was deleted end-to-end on 2026-07-14 (ERR-065 → ERR-069) and is pinned deleted by 21 tests.
Editing a sentence meant hand-editing HTML.

**Why it was buildable after all.** `inkcartridges/middleware.js`'s bot matcher covers only `/`,
`/shop`, `/ribbons`, `/ink-cartridges`, `/toner-cartridges` and product routes. **None of the seven
content pages is prerendered** — bots and humans receive the identical static file. The thing that
killed the old CMS was never "an editor"; it was editing at **render time**, which produced two
documents from one URL (served HTML ≠ rendered DOM = cloaking).

**The design rule, and the whole feature in one line:** the editor rewrites
`inkcartridges/html/<doc>.html` **in git, at author time**, then opens a PR. It is a GUI over a git
commit, not a CMS. There is still exactly one artifact, so `curl`, a browser and AdsBot cannot
disagree. `js/legal-page.js` is not touched, imported or extended — the storefront runtime gains
nothing and keeps its zero-network-I/O property.

**Trap 1 — contentEditable is lossy against this markup, in two ways that would have shipped.**
- `RichTextEditor.sanitizeHTML()` strips **every** `class` attribute and unwraps attribute-less
  `<span>`s. Pointed at `returns#snapshot` it destroys `div.policy-callout` outright.
- `innerHTML` decodes `&rsquo;`/`&sect;`/`&ndash;` to literal characters. That one is worse than it
  looks: `tests/genuine-vs-compatible-warranty.test.js` normalises `&rsquo;` before matching its
  two legally-vetted sentences, so writing a literal `’` renders identically and turns CI **red**.

  Fix: a DOM-free block model (`js/admin/utils/page-copy-model.js`) is the ONLY thing that writes
  markup. Text is **decoded on parse and re-encoded on serialize**, so the two input paths — file
  (`&rsquo;`) and contentEditable (`’`) — converge on identical bytes. `editor.innerHTML` is parsed
  INTO the model and discarded; it never reaches a file. Watch `\s` in any collapse: it matches
  U+00A0 in JavaScript, so a careless `.replace(/\s+/g,' ')` silently eats every deliberate NBSP.

**Trap 2 — a first edit would have reflowed its whole section.** The editor writes by serializing
the model, and the hand-authored files were not in that canonical form. The owner's first save
would have produced an unreviewable diff, indistinguishable from a mangling bug. Fix: one
deliberate pure-formatting pass (`scripts/canonicalise-page-copy.mjs`, editable regions only —
locked ones stay byte-exact). Verified text-preserving: **rendered text, `data-legal-bind` count,
`<script ?v=>` lines, `<h2>`s and ids all identical to HEAD across all 7 files**, full suite
2784/0. Real edits now diff to one line.

**Guards are the point, not the WYSIWYG** (`js/admin/utils/page-copy-guards.js`, run client-side
for feedback and — per `page-copy-editor-backend-brief.md` — server-side as the authority):
tag/attr allowlist (this writes into a shipped page = stored-XSS with a permanent payload),
`data-legal-bind` multiset equality (inventing a key is as fatal as deleting one — §5 of the
retired-CMS suite asserts `legal-page.js` implements every key in the HTML), business facts banned
as plain prose outside their binding, `LegalConfig.BANNED_CLAIM_PATTERNS` on entity-decoded
whitespace-collapsed text, and `requiredPhrases` for sentences CI pins. **Every failure is a hard
reject naming the node, never a silent strip** — a silent sanitise is ERR-069's "Saved. Live on
next page-load." in a different costume. A missing config → `GUARD_UNAVAILABLE`, refuse the save;
an absent list must never read as "no violations found" (ERR-063/068/075).

**Fail closed, both directions.** The manifest (`page-copy-regions.js`) is an authoring **gate**,
so an unlisted section is read-only and a test goes red until someone decides — the opposite of
ERR-063's `FILES_TO_SCAN`, which was a **scanner** allowlist and failed open. The parser returns
`null` for anything it cannot classify; the region renders read-only with an explanation rather
than being "parsed as best we can" and written back.

**Naming, to stay clear of the 21 retired-CMS assertions:** module is `pages/page-copy.js` (never
`legal-content.js`); a top-level `Content` nav group, not a Settings tab with `id:'legal'`;
`ROUTE_REDIRECTS['legal-content']` left byte-identical at `'settings'` (it is an equality
assertion — repointing it at the new page turns that suite red); the retired table name appears
nowhere, code, comment or brief.

**Pinned by** `tests/page-copy-editor-jul2026.test.js` (40 tests: canonical form, idempotence,
splice fidelity, every guard, manifest integrity, retired-CMS avoidance).
**Backend is PENDING** — `page-copy-editor-backend-brief.md`. Until it ships, the frontend probes,
gets a 404, says **"Publishing is not available"** in those words, and offers Copy diff / Download.

---

## ERR-119 — Order line-items table INVISIBLE on every order: scroll wrapper collapsed to height 0 in the modal's column flex (2026-07-24)

**Reported ("where did the products go?" ×3).** The order-detail modal showed NO line-items table —
meta → Financial Breakdown → Dates, with a blank gap where products belong.

**TRUE root cause (self-inflicted; corrected from an earlier wrong call).** The Supplier/Origin
columns work added a horizontal-scroll wrapper `.admin-order-items-scroll { overflow-x:auto }`
around the `<table>`. That wrapper is a flex item inside `#om-content`
(`.admin-product-modal__scroll`, a `display:flex; flex-direction:column` container). Per the CSS
Flexbox spec, a flex item whose `overflow` ≠ `visible` gets an **automatic min-height of 0**. The
modal content is a touch taller than the viewport (scrollHeight 717 > clientHeight 697), so
flex-shrink drove the wrapper to **height:0**, and `overflow-x:auto` then **clipped** the 107px
table → products painted nowhere. This affected EVERY order, not just one. Confirmed live via
`getComputedStyle`: wrapper `height 0px`, table `height 107px`, `visibility:visible`.

**Why I missed it twice.** I "verified" with DOM-only checks (`hasTable:true`, row count) and a
screenshot that was cut off before the items area — never actually looked at the rendered table.
DOM presence ≠ visibility. My first two explanations ("transient backend deploy") were wrong.

**Fix (one line, `css/admin.css`).** `.admin-order-items-scroll { overflow-x:auto; max-width:100%;
flex-shrink:0; }` — `flex-shrink:0` stops the wrapper collapsing while keeping horizontal scroll for
the wide (up to 8-col owner) table. **Verified VISUALLY** on a clean stylesheet-only load (no inline
hacks): wrapper 131px, table renders with Supplier "Augmento" + Origin "Assembled" for order
`20260724000003`. Bumped `APP_VERSION`; `npm run build` restamped the admin.css `?v=` token — user
must hard-reload (an open SPA session keeps the old CSS).

**Kept from the earlier pass (still valid, separate concern).** `buildOrderModalContent` now takes
`{ detailLoadFailed }` from `openOrderModal` (`detailLoadFailed = !fullOrder`, + a `Toast.error`), and
the empty branch splits on `expectedCount = o.items_count ?? o.item_count ?? o.order_items?.length`:
`detailLoadFailed || expectedCount>0` → LOUD red `.admin-empty` warning; else quiet "— No items".
This is defensive-only — it did NOT cause or fix the invisibility (for real orders `items` exist, so
the table rendered and was then clipped). Backend HAS shipped `origin` + `suppliers` + top-level
`supplier_fulfillment`.

**Lesson.** For a "can't see X" bug, verify the RENDERED pixels (screenshot + computed height/box),
never just DOM presence. And suspect your own most-recent CSS before blaming a backend deploy.

---

## ERR-118 — Absorbed courier cost missing from order profit → take-home over-reported on free-shipping orders (2026-07-24)

**Reported (backend hand-off).** On a free-shipping order (subtotal ≥ $100) the customer pays **$0
shipping** but we still pay the courier. That absorbed cost was **missing from the owner order
modal's profit math**, so take-home over-reported. Worked example order `20260723000001` (genuine
Kyocera toner, free ship, North Island): reported **$30.49 / 25.3%**, but ~$12 courier was absorbed
and never subtracted → true **$20.06 / 16.6%**.

**Backend change.** `GET /api/admin/orders/:id` now returns owner-only
`order.shipping_absorbed` = `{ applies, zone, delivery_type, amount_incl_gst, gst_component,
amount_ex_gst }` (the real zone/weight courier rate from `shipping_rates`; `{ applies:false }`
otherwise; absent for non-owners; same gating as `supplier_fulfillment`).

**Fix (FE, `js/admin/utils/profitability.js` + `js/admin/pages/orders.js`).** Treat the courier line
exactly like the supplier/Stripe lines — shown incl-GST, GST netted at the IRD line, so the cash
waterfall still foots:
- New internal `absorbedShippingParts(opts, gstRate)` parses `opts.absorbedShipping`. **Anchor on
  `amount_incl_gst`**; use `gst_component` (derive `incl × 3/23` if absent); **derive `exGst = incl −
  gst`** (NOT the backend's `amount_ex_gst`) so the waterfall foots exactly despite backend rounding.
- `computeOrderProfit` subtracts `exGst` (defaults 0 → invoiced sales & dashboard aggregates
  unchanged, as the doc scopes). `computeLineProfits` needs no logic change: its derived order-level
  fee (`rev − cost − totalProfit`) now includes the courier cost and is **allocated across lines by
  revenue share** (same as the fixed $0.30 Stripe fee) — so the per-line Profit column/foot and the
  waterfall take-home stay equal (margin-consistency gate, ERR-113). Renamed local `orderStripeFee` →
  `orderLevelFee`.
- `computeProfitBreakdown` subtracts `inclGst` as a new **Courier absorbed (free shipping)** outflow,
  reduces `gstRemittedToIrd` by the courier GST, exposes `absorbedShipping{Applies,InclGst,Gst,ExGst,
  Zone,DeliveryType}`. `orders.js` adds `absorbedShipping: o.shipping_absorbed` to **both** `feeOpts`
  branches, renders the row (guarded on `absorbedShippingApplies`) between "Paid to Stripe" and "GST
  remitted to IRD", with a "Actual courier rate for {zone}, urban assumed" tooltip.

**LOUD-by-absence.** `applies!==true` or a non-positive `amount_incl_gst` → contribution is $0 and
nothing renders: a missing field never invents a cost, a present one is never silently dropped.

**Out of scope (per hand-off).** Dashboard / Financial Health / P&L aggregates still ignore absorbed
shipping. Rural accuracy would need `delivery_type` persisted at checkout (not currently stored).

**Tests.** `tests/profitability.test.js` extended (doc worked example foots $30.49→$20.06,
IRD $4.57→$3.00; applies:false / absent = no-op; derived GST; per-line allocation ratio).
New `tests/order-profit-absorbed-shipping-jul2026.test.js` pins the render wiring. Updated the
exact-shape `feeOpts` pin in `tests/admin-invoice-orders.test.js` for the new `absorbedShipping` arg.

---

## ERR-117 — Performance overview: Orders line rendered BELOW the zero baseline; +taller +traffic (2026-07-24)

**Reported.** On the Dashboard "Performance overview" the yellow **Orders** line dipped *below the
$0 gridline* even though orders can never be negative. User also wanted the chart **taller with more
$ increments**, and a **Traffic** overlay (sessions + pageviews) added to the same chart.

**Cause (the below-zero symptom).** The chart is Chart.js with a dual axis. The money axis (`y`)
deliberately auto-scales *below zero* so a loss dips under the baseline, putting its `0` ~10% up
from the plot bottom. The Orders axis (`y1`) was clamped `min:0`, pinning orders-`0` to the very
bottom. Chart.js maps each axis independently, so the two zeros landed at **different pixels** — low
order counts sat beneath the money-`0` gridline and *read as negative*. It was never negative data;
it was two misaligned baselines.

**Fix — one shared below-zero fraction for every count axis** (`drawPerformanceOverview`,
`js/admin/pages/dashboard.js`):
- Compute the money domain explicitly (`moneyMin ≤ 0`, `moneyMax`, nice-rounded) instead of leaving
  it to Chart.js — losses still dip (moneyMin is the real negative floor), but now the number is
  known. `zeroFrac = moneyMin / moneyMax` (≤ 0).
- Each COUNT axis gets `min = axisMax * zeroFrac`, so orders-`0` / traffic-`0` land on the **exact
  pixel row** of the money-`0` gridline. Counts (always ≥ 0) can never render below it.
- Negative ticks the alignment introduces are blanked: `callback: v => v < 0 ? '' : Math.round(v)`
  — the axis never prints a negative order count. `y1` must NOT go back to a hard `min:0`.

**Taller + finer increments.** New CSS modifier `.admin-chart-box--xtall` (460px) for this chart
ONLY — do NOT bump `.admin-chart-box--tall` (340px, shared by 5 charts). Money `stepSize` via a
`niceDown(range/12)` helper → ~$500 steps instead of Chart.js's ~$1k (rounding *down* never
overshoots to fewer lines the way rounding up does).

**Traffic overlay (user: both sessions + pageviews, hidden scale).** New
`AdminAPI.getTrafficTimeseries(from,to)` → `/api/admin/analytics/traffic/timeseries` (keys on
`from`/`to`, NOT the `date_from`/`date_to` analyticsQuery emits). Fetched in the parallel load
(index 12) with a wide fallback range (`from||'2000-01-01'`, `to||today`) so the all-time view still
returns; parsed via the shared `normalizeSeries()`. Daily rows re-bucketed to the chart's grain with
the existing `indexFor()`. Two **dashed violet** lines (`#7C3AED`/`#A78BFA`) on a **hidden** `y2`
scale (no third number column), same `zeroFrac` alignment; tooltip shows integer counts.
**Fail-soft LOUD:** no usable data → both lines omitted (never a misleading zero) + card note
"Traffic data isn't available for this range."

**Palette note.** Adding traffic makes 7 series. The dataviz validator's two FAILs
(red↔magenta normal-vision ΔE 12.8; green/yellow lightness) are **pre-existing** on the 5 original
series — the two violets are NOT the worst adjacent pair, and dashing is their secondary encoding.

`payload.sTraffic` is new → **`DASH_CACHE_SCHEMA` bumped 1→2** (ERR-116) so old-shape localStorage
blobs are ignored. `APP_VERSION` → `2026.07.24-perf-overview-traffic`; api.js import token →
`traffic-timeseries-jul2026`; `npm run build` restamped `?v=`. Pinned by 4 new tests in
**tests/dashboard-profit-recovery.test.js** (axis alignment, negative-tick blanking, traffic overlay,
traffic fetch/parse).

---

## ERR-116 — Dashboard still spun on a full page refresh (in-memory cache only) (2026-07-24)

**Reported** right after ERR-115: a hard refresh showed the centered spinner on a blank page.
**Cause.** The stale-while-revalidate cache `_payloadCache` (`js/admin/pages/dashboard.js`) is an
**in-memory `Map`** — empty after any full page load — so the cold-load branch painted
`dashboardSkeleton()`. The SWR only helped *in-app* navigation.

**Fix (user chose: show last data, persisted across sessions).** Write the last-rendered payload
through to **localStorage** and seed the Map from it once per module life, so the existing warm-cache
render path fires on a refresh — instant full-colour repaint, then revalidate. Mirrors AdminAPI's
account-keyed, fail-soft localStorage caches (`api.js` ui-prefs / code-universe):

- `DASH_CACHE_SCHEMA = 1` — **bump when the `payload` object shape changes**, else an old-shape blob
  is ignored (not fed to `render()`).
- Key `admin_dash_cache:${Auth.user.id||'anon'}` — account-scoped (one admin's financials don't leak
  into another's session on a shared browser); reads still gated to `isOwner`.
- Read/write wrapped in `try/catch` (private mode / quota) → degrades to the spinner, never throws.
- **Single entry** (the last view) — a refresh keeps the same URL/filters so its key always matches;
  bounds storage size (payload carries up to 1000 expense rows + 18 chart series).
- Seeded repaint wrapped in `try/catch`: a bad blob clears storage + falls back to the spinner
  (no white-screen) even if `DASH_CACHE_SCHEMA` wasn't bumped.

First-EVER load (nothing persisted) still shows the spinner — the `dashboardSkeleton()` branch and the
`_loadSeq` race-guard are untouched, so `tests/admin-skeleton-load-may2026.test.js` stays green.
`APP_VERSION` bumped to `2026.07.24-dash-coldload-persist` (versions the dynamic page import) +
`npm run build` restamped `?v=`. Pinned by **tests/dashboard-coldload-persist-jul2026.test.js** (6).

---

## ERR-115 — Admin Dashboard / Website Traffic reloaded in "feint" colours; user wanted full colour (2026-07-24)

**Reported** with a screenshot of the Dashboard rendered washed-out during a warm-cache/filter reload:
"use the normal colours and then load the data whenever it loads … rather than a feint version."

**Cause.** The single rule `.admin-page--reloading > *:not(.admin-page-header)` in `css/admin.css`
dimmed the whole body during a re-load (`opacity: .55` + `filter: saturate(.85)`) so users would
"perceive activity." It fires on two paths in `js/admin/pages/dashboard.js` — the stale-while-revalidate
warm-cache paint (line ~956) and the filter-change reload (line ~960) — and on the shared
`website-traffic.js`. Cold first load was never faint (it's the `.admin-loader` spinner).

**Fix.** CSS-only. Deleted the dimming block; kept `.admin-page--reloading { position: relative; }`
as a no-op hook, and removed the now-pointless `.admin-page--reloading … { transition: none; }` line
from the `prefers-reduced-motion` block (kept `.admin-skel { animation: none; }`). The JS toggles and
the `_loadSeq` race-guard are untouched, so stale-while-revalidate still paints cached data instantly
and swaps in fresh values — just at **full colour** now. Applies to both admin pages (shared class).

**Cache token** `admin.css?v=` restamped by `npm run build` (`3ea9e52b` → `e40bdf63`). Pinning test
`tests/admin-skeleton-load-may2026.test.js` stays green (15/15) — it only asserts the class + JS
toggles exist and that reduced-motion disables `.admin-skel`, all preserved.

---

## ERR-114 — Backend and frontend disagree by 15% on whether Stripe's 2.65% is GST-inclusive (2026-07-22) — OPEN, BACKEND

**Found by** reverse-engineering the pinned live `kpi-summary` payload while auditing whether
invoiced sales were being charged a card fee. **The carve-out is fine** — that part of the audit
came back clean:

```
revenue 8342.15 · orders 63 · invoice_revenue 1268.48 · invoice_orders 3 · stripe_fees 178.65

naive (all orders)                 0.0265 × 8342.15 + 0.30 × 63   = 239.97
carved (card orders only)          0.0265 × 7073.67 + 0.30 × 60   = 205.45
carved × 20/23                                                     = 178.6541
backend stripe_fees                                                = 178.65   ← exact to 0.4c
```

So the backend formula is `(2.65% × card revenue + $0.30 × card orders) × 20/23`. Invoiced
(bank-transfer) sales ARE excluded — no defect there.

**The defect.** That trailing `× 20/23` means the backend treats Stripe's `2.65% + $0.30` as
**GST-INCLUSIVE** and strips GST out to express the fee ex-GST. `utils/profitability.js` treats the
identical rate as **ex-GST** and adds GST *on top* (`computeProfitBreakdown.stripeFeeGst`). Both
cannot be right, and they differ by exactly 15% — **$26.80 all-time** on the payload above.

**Consequence.** The order modal's take-home profit and the dashboard's Net Profit are computed on
two different fee conventions. Whichever is correct, one of them is wrong on every card sale.

**To settle it:** read one Stripe NZ invoice/statement. If Stripe's published 2.65% is quoted
exclusive of GST (and GST is added as a separate line), `profitability.js` is right and the backend
is understating fees / overstating net profit by 15%. If it is GST-inclusive, the backend is right
and `profitability.js` over-deducts.

**Pinned by** `tests/dashboard-net-series-jul2026.test.js` §10c (3 tests: the carve-out holds, the
backend formula is exact, and the FE/BE divergence is exactly 1.15×). Those tests document the
divergence rather than assert a winner — update them when it is settled, do not "fix" one side blind.

**Related:** `deriveStripe` in `utils/trend-math.js` has NO carve-out at all. It has zero production
callers (tests only) and is now marked ⚠️ UNWIRED — do not re-wire it without adding one.

---

## ERR-113 — Net Margin tile contradicted the Net Profit tile beside it by ~100× (2026-07-22)

**Symptom.** `#dashboard?period=all`, live: Revenue $7,728.48 · Net Profit **−$19.67** · Net Margin
**−29.3%**. But `−19.67 / (7728.48 × 20/23) = −0.29%`. Two tiles in the same strip, 40px apart,
disagreeing by two orders of magnitude. Gross Margin (21.1%) was correct.

**Cause.** `renderKpiStrip` rendered `cur.net_margin` **verbatim** whenever the backend shipped it
(`dashboard.js`), so the backend's figure went to screen without ever being checked against the
profit and revenue the very next tile displays. The FE's own `marginOf()` fallback would have
produced −0.3%; it was never reached. The bad value is backend-side (ERR-111's remediation made
`margin_proxy` authoritative for gross, and net inherited the same blind trust).

**Fix (frontend).** New `checkMarginConsistency(label, backendPct, derivedPct)` next to
`checkNetDrift`. The backend figure is still **preferred** — but only once it agrees with
`profit / (revenue × 20/23)`. Tolerance is **relative** (`max(0.5pp, 5% of derived)`) so a 100×
scale error and an ERR-111-style basis error both trip while ordinary rounding does not. On a trip:
render the **derived** figure — internal consistency across the strip beats deference to a number
that disagrees with its own inputs — and emit a LOUD `.admin-dash-note--alert` naming both values
and flagging a ~100× ratio as a scale bug. Applied to Gross Margin too, where it is currently silent
and serves as a regression detector.

**Rule.** "Prefer the backend" ≠ "render the backend blindly". Any backend figure that is
*derivable* from two other figures already on screen must be cross-checked against them, and the
disagreement surfaced — never silently resolved. Same discipline as `checkNetDrift`.

**Still open (backend):** the source of the ~100× `net_margin`, and the **$30.80** net-profit drift
the dashboard's own banner reports (Σ per-bucket net −$50.47 vs tile −$19.67, tolerance ~$0.60).
Both are backend self-inconsistencies; the frontend now reports them loudly but cannot fix them.

**Pinned by** `tests/dashboard-net-series-jul2026.test.js` §10b (7 tests).

---

## ERR-111 — Profit tiles were over-stated by the revenue GST; two FE helpers silently changed meaning when the backend changed basis (2026-07-20)

**Symptom.** Backend shipped a P0 fix (migration 118 + `b356b48`) and asked the frontend to follow
through. Verifying it surfaced that the owner's historical Gross/Net Profit tiles had been
**inflated**: `period=all` gross `$2,679 → $1,591`, net `$1,272 → $340.86`.

**Cause (backend, already fixed).** `kpi-summary` subtracted an **ex-GST COGS from GST-INCLUSIVE
revenue**, booking the 15% GST collected on revenue as profit, and left Stripe fees out of the
comparison. Not ERR-068 — invoice COGS was never zeroed.

**Cause (frontend, found only by verifying).** The migration changed a **basis**, not a value, so
two helpers that invert that basis silently changed meaning while their names kept asserting the old
one:

1. `kpiCogsInclGst` computed `revenue_ex − gross_profit` and called it incl-GST. Post-118 that
   expression yields the **ex-GST** cogs — a 15% understatement of real supplier cash (~$849
   all-time) on every cost line. Proof is pure arithmetic on the backend's own numbers:
   `rev_INCL − cogs = 2679.31` reproduces the pre-fix gross exactly and `rev_EX − cogs = 1591.20`
   reproduces the live one, so `cogs` is the same ex-GST figure on both sides.
2. The margin tiles divided ex-GST profit by GST-inclusive revenue → **19.07%**, while the backend's
   own `margin_proxy` said **21.9%**. The frontend never read `margin_proxy` at all.

**Fix.** Deleted the ERR-106 proration (`buildReconciledNetSeries`) and plotted the backend's real
`net_profit_series`, which reconciles by construction post-118. Split the COGS helper into
`kpiCogsExGst` (profit basis) and `kpiCogsInclGst` (cash basis, `×1.15`) — now true inverses of
`reconciledGrossProfitInclGst`, which they were not before. Backend per-bucket `operating_expenses`
became primary over the client-side `/expenses` bucketing (which read $1,375.76 vs the backend's
$1,071.69); the client path survives as a **differently-labelled**, disclosed fallback. Margins
prefer `margin_proxy`. The drift guard was kept (not retired as the backend suggested), had its
null-as-zero false-alarm fixed, gained a bucket-scaled tolerance, and now renders a **visible**
on-card alert instead of a console warning nobody reads.

**Pinned by** `tests/dashboard-net-series-jul2026.test.js` (44), plus updates to
`dashboard-trend-math.test.js`, `dashboard-profit-recovery.test.js`, `admin-cogs-honesty.test.js`.
Full suite 2683/0.

**Lesson.** When a backend changes a *basis* rather than a value, grep for the **inverse
operations**, not just the field name — every helper that inverts the basis changes meaning while
its docblock keeps asserting the old one. The contradiction here had been sitting in a *passing*
test comment (`kpiCogsInclGst … recovers cost_EX`) for six weeks. Also: verify a handoff before
coding — two of the four endpoints it named either lacked the field or didn't exist, while the two
genuinely broken things weren't mentioned at all.

---

## FEATURE — Review Flywheel frontend (one-click rating landing + My Reviews) (2026-07-19)

**What:** implemented the three FE action items from `review-flywheel-FE-handoff-jul2026.md`. The
post-purchase email now embeds one-click star ratings; the backend records an **approved** review and
302-redirects the customer to a storefront URL with `?rated=N`.
- **§1.1** PDP + `/account/reviews` welcome a one-click rater: `?rated=N` (1–5) → "Thanks for your
  N-star rating!" toast, scroll to reviews, then `history.replaceState` strips the param (idempotent —
  the canonical-URL rewrite otherwise preserves the query string and would re-toast on refresh/Back).
- **§1.2** PDP hero rating badge (`#product-rating-badge`) populated from
  `average_rating`/`review_count`, gated **exactly** like the product card (`avg && review_count > 0`).
  Display-only; **no client-side aggregateRating JSON-LD** (backend prerender owns structured data).
- **§1.3** already-rated guard: `setupReviewForm()` is now **async** and calls
  `API.getUserReviews()`; if a review exists for the product it renders a "You rated this N★"
  acknowledgement instead of the write form — so `POST /api/reviews` never fires its **409**. One-click
  ratings are approved-with-no-text and `PUT /api/reviews/:id` edits only pending rows, so there is
  genuinely nothing to append a comment to — treating the product as already-rated is the honest UX.
- New `/account/reviews` page (fallback redirect target) + `js/account-reviews-page.js`; fails **loud**
  (error panel + retry) rather than rendering an empty list as a healthy zero. `serve.json` rewrite
  added (local dev — vercel's `/account/:path*` catch-all already covers prod). "My Reviews" added to
  every account sidebar + a dashboard card.

**Two test-contract gotchas hit and satisfied (note for the next account page):**
1. **Canonical-URL §4** (`polished-slugs-may2026.test.js`): any JS building `/products/${slug}/${sku}`
   MUST also reference `canonical_url` first. Fixed `productHref()` to prefer `review.canonical_url`.
2. **Header parity** (`ia-reorg-jul2026.test.js §1`): pins the exact count of pages shipping the shared
   header (`assert.equal(PAGES_WITH_NAV.length, N)`). Adding `reviews.html` bumped 28→29 — update that
   number when adding any full page. The byte-identical-header hash assertion still held (cloned header).

**Skipped (owner decision):** the handoff's optional §3 footer/nav category links (Label Tape / Photo
Paper). `footer-redesign-jul2026.test.js §3` pins the human footer to the exact four categories the
backend prerender shows Googlebot; adding two more without the bot footer matching is reverse cloaking
— the class of issue behind the ad suspensions. Deferred until the prerender footer is confirmed.

**Pinned by:** `tests/review-flywheel-fe-jul2026.test.js` (new, 12 tests). Suite green (2567/0);
one intermittent cross-file failure (`admin-cogs-honesty` chart-mapper) belongs to an **unrelated
uncommitted admin dashboard WIP** in the tree, not this change — left untouched.

---

## ERR-078 — Live misrepresentation: a 12-month compatible-cartridge "replacement warranty" the business never offered (2026-07-15)

**Symptom:** the storefront claimed every compatible cartridge carried a **12-month replacement
warranty** — on `/about`, `/returns`, `/faq`, `/genuine-vs-compatible`, and the compatible-PDP
disclaimer. The business does **not** offer this. It is a misrepresentation, the same class of
issue behind the May/Jul 2026 Google Ads suspensions. Backend dev flagged it
(`FE-ACTION-REQUIRED-warranty-claim-removal-jul2026.md`) after retiring it on the backend
(`trustSignals.js` + `prerender.js`).

**Cause:** the claim was **not API-driven** — the storefront never read
`trust_signals.warranty.compatible_months`/`compatible_label` (zero hits). It came from a **local
constant** (`legal-config.js` `compatibleWarrantyMonths: 12`) feeding a `compatible-warranty`
`data-legal-bind`, **plus hardcoded prose** in five pages that didn't use the binding at all. So the
number had two independent sources — flipping the constant would have missed the prose, exactly the
single-surface trap that shipped the OEM-warranty claim past two "fixed" reports (ERR-063/065-069).

**Fix (the true policy):** compatibles are covered by the **30-day satisfaction guarantee**
(`guarantee.days = 30`) + the returns policy + statutory **CGA-1993** rights. Genuine cartridges
still carry the **original manufacturer warranty** (unchanged, still true). Retired the constant +
binding at the source; rewrote all prose to the 30-day framing; the compatible-PDP panel now mirrors
the backend prerender verbatim (parity, not cloaking — the trailing sentence briefly removed
2026-07-15 was restored as the 30-day + CGA wording). `npm run build` restamped cache tokens.

**Deploy:** shipped **FE-first** (owner call; the hand-off permits it). The backend prerender was
NOT yet live at commit time (verified: live `/api/site/trust` still returned `compatible_months: 12`,
every bot page still showed "12-month"). This opens a short, *safe*-direction divergence window
(humans see the truer 30-day claim; bots still see 12-month) until the backend deploys. **Owed:** a
bot-vs-browser parity spot-check on `/returns`, `/about`, `/genuine-vs-compatible` + a compatible PDP
once the backend is live.

**Pinned by:** `tests/warranty-claim-removal-jul2026.test.js` (new — per-page + site-wide walk +
PDP-panel + source-level constant/binding guards). Also updated:
`google-ads-compliance-may2026.test.js`, `genuine-vs-compatible-warranty.test.js`,
`reappeal-disclaimers-jul2026.test.js`, `legal-pages.test.js`. Suite green (2251/0).

---

## ERR-073 — A test pinned the *implementation* of a compliance rule, not the rule (2026-07-14)

**Symptom:** the owner asked to delete the footer's single-line legal row
(`.footer-legal-nav` — Terms · Privacy · Returns · Shipping · Genuine vs Compatible · About · FAQ ·
Contact). Three separate places said not to: a `do not remove again` comment in `js/footer.js`, a
`KEPT here on the owner's explicit call` comment in `tests/footer-redesign-jul2026.test.js`, and a
test asserting the row exists by class name.

**Cause:** the row was restored earlier the same day (ERR-066 era) for a real reason — an ads
reviewer must be able to reach every compliance surface from the footer — but the guard I wrote
asserted **the row**, not **the reason**. Those are not the same claim. Every one of the eight hrefs
is *already* in the Help + Company columns of the same footer, so the reason was satisfied with or
without the row; the row was duplication. A guard pinned to one implementation of an invariant
blocks a legitimate change and, worse, teaches you to distrust the guard.

Same failure shape as ERR-067 (a cache-token test pinned to a literal, which could only ever go red).
A test that says "this exact markup exists" is a snapshot. A test that says "a user can reach
`/privacy` from the footer" is an invariant.

**Fix:** removed the row from `js/footer.js`, its dead rules from `css/layout.css`, and rewrote both
guards to assert the invariant instead — the footer column grid must carry **all eight** policy
hrefs (`tests/legal-pages.test.js` §2), and the duplicate row must not return
(`tests/footer-redesign-jul2026.test.js` §3). Deleting a policy link from a column now goes red even
though the row is gone. Bumped the `?v=` tokens for `footer.js` (`d7f4ba89`) and `layout.css`
(`4a20d4a1`) across all 34 pages, since both files' content changed. Verified headless: zero
`.footer-legal-nav` nodes rendered, all eight hrefs still present in the footer, none duplicated.

**Rule:** when you guard a compliance decision, assert the user-visible outcome ("every policy page
is reachable from the footer"), never the markup that happens to deliver it today. If you catch
yourself writing `do not remove again` next to a class name, you are pinning a snapshot.

---

## ERR-069 — Retiring a feature's READ path while leaving its WRITE path live (2026-07-14)

**Symptom:** the backend retired the legal-content CMS and asked the frontend for one surgical
change — strip the dead override fetch out of `js/legal-page.js`. Doing exactly and only that
would have left `js/admin/pages/legal-content.js` (881 lines) mounted at Settings → Legal
Content, still `upsert`-ing into `legal_content_overrides` and still telling the owner
**"Saved. Live on next page-load."**

That sentence has never been true (ERR-065), and once the read path is deleted it can never
*become* true. The half-retirement would have preserved the exact silent-vanish trap ERR-065
was about, and left a live write path into a table the backend is about to drop.

**Cause (the general one):** a feature is a loop — writer → store → reader → surface. A handoff
naturally describes the half the author can see. The reader was the half that was *visible* to
the backend (it's the part that greps), so that's the half the handoff named. Nobody was lying;
the write path was simply out of frame.

**Fix:** retire all four corners at once.
- reader: the override fetch/apply path in `js/legal-page.js` (the file now performs **zero**
  network I/O — that is the invariant, not merely "this one table is unreachable")
- writer: `js/admin/pages/legal-content.js`, deleted, along with the inline
  `CREATE TABLE legal_content_overrides` DDL it carried
- route: the Settings tab in `settings.js`. The legacy `#legal-content` hash was deliberately
  **kept** as a redirect — pointed at the bare `settings` hub, not the deleted `?tab=legal` —
  so an old bookmark lands somewhere sane instead of "Error Loading Page"
- spec: the stale doc references, and the now-false `legal-config.js` comment claiming
  `BANNED_CLAIM_PATTERNS` still feeds a CMS guard

`LegalConfig.BANNED_CLAIM_PATTERNS` itself **stays** — the CMS guard was only one of its
consumers; the compliance source sweep still imports it. Deleting it as "CMS collateral" would
have silently disarmed the banned-copy sweep. That is the ERR-063 failure mode wearing a
cleanup costume.

**Guard:** `tests/legal-cms-retired-jul2026.test.js` (21 tests) replaces the 25-test
`legal-content-cms.test.js`, which asserted the CMS *existed*. It runs the backend's own
acceptance grep in CI (must be 0 — **including comments**, so the file may not even *name* the
mechanism), asserts zero network I/O, asserts the writer/tab/route are gone, sweeps the WHOLE
tree for the table name (never an allowlist — ERR-063), and pins the half we KEPT so a future
cleanup can't take the `data-legal-bind` trust signals down with it.

**Verified in the rendered DOM, not by curl** (the ERR-065 lesson): all 8 legal pages in
Chromium — zero reads of the retired table, `window.LegalContent` gone, all 8–22 `data-legal-bind`
values still resolving, TOC building, FAQ accordions toggling, policy copy intact, no uncaught
exceptions. Admin: Settings now shows `["Notifications","Shipping Rates","Site Lock"]`, and
`#legal-content` redirects to `#settings` without an error screen.

**Also caught, and NOT acted on:** the handoff offered an optional "byte-parity" nicety —
add `NZ Company Number 1853414` to the SPA footer line, because *"the backend's own footer line
additionally includes"* it. Fetched live under a Googlebot UA: **zero** occurrences in the
served footer of `/terms`, `/about`, `/privacy`, `/returns`. The only occurrence anywhere is in
the `/terms` **body**, which is our own static HTML. Adding it to `disambiguationLine()` would
have made our footer assert something the backend's footer does not — *creating* the bot/browser
divergence we are trying to eliminate, and touching 33 hardcoded `<noscript>` footers, `404.html`
and 4 compliance pins to do it, mid-appeal. Flagged back to the backend instead.

**Lessons:**
1. When you kill a feature, kill the **writer, the reader, the route, and the spec**. A UI that
   still reports success into a store nothing reads is worse than the bug you were fixing.
2. A "remove X" handoff describes the half the author can see. Grep for the *other* half before
   you call it done.
3. Do not act on a claim about a surface you can fetch. Fetch it.

---

## ERR-066 — The footer's Google-Ads "Business Transparency" line was silently dropped (2026-07-14)

**Symptom:** the rendered footer, sitewide, was missing the legal-entity line —
*"InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST
94-509-459)"* — plus the single-line legal nav and the "No card surcharges" line.
`legal-config.js` itself documents that sentence as **required by Google Ads "Business
Transparency", surfaced on every page the trading name appears prominently.**

**Cause:** the 2026-07-02 IA reorg rebuilt `footer.js` and dropped `.footer-legal-nav`,
the disambiguation line, and the surcharge line. `TRUST.disambig` was still *computed* at
`footer.js:33` and never rendered. `.footer-legal-nav` was deleted from the CSS entirely.

**Why nobody caught it:** three tests DID pin these surfaces
(`legal-pages` §2 ×2, `google-ads-compliance` "footer.js renders the disambiguation line
element") — and all three had been **red since the reorg**, indistinguishable from the 16
other red tests. Confirmed live in Chromium *before* the fix: `hasDisambiguation: false`.
The static `<noscript>` footer still carried the line, so a `curl` looked fine — only a
JS-rendering browser (i.e. AdsBot) saw it missing.

**Fix:** restored all three in `js/footer.js` (`.footer-legal-nav`, `.footer-legal-line`
with `data-legal-bind="disambiguation"`, "No card surcharges") + `css/layout.css`.
Verified rendered on live production under an AdsBot UA.

**Lesson:** "verified rendered on Jul 12" checked the trademark disclaimer and stopped.
When auditing compliance surfaces, enumerate them from `legal-config.js` — don't spot-check.

---

## ERR-067 — Pinning a cache-busting token to a literal makes a test that can only ever break (2026-07-14)

**Symptom:** 19 tests red at HEAD. Nine of them were cache-token pins, each asserting a
shared token still equalled *its own release's literal*:

    retail-wording      →  footer.js must be v=retail-may2026
    newsletter-jun2026  →  footer.js must be v=newsletter-copy-fix-jun2026
    ia-reorg-jul2026    →  footer.js must be v=ia-reorg-jul2026

**Cause:** the token is `md5(file contents)[:8]` — a value whose entire purpose is to
change. Pinning it asserts it has *stopped* changing. Every new feature that touches the
file invalidates every older pin, so they are mutually contradictory and permanently red.
Their comments had degenerated into changelogs ("…then stock-enquiry bumped it; then
mobile-parity bumped it; then buybox bumped it…") — the code was documenting its own
unmaintainability.

**Fix — `tests/asset-cache-tokens.test.js`,** asserting what actually protects users:
1. **Consistency** — an asset resolves to ONE token across every page. *This is the real
   bug*: it immediately caught `admin.css` bumped on `admin/index.html` while
   `customers/orders/products.html` were left behind, i.e. 3 of 4 admin pages serving
   stale CSS. No era-literal ever caught that.
2. **Coverage** — every local js/css ref is versioned at all.
3. **Freshness** — a **staged** asset change must also bump its token. Caught this very
   branch shipping `legal-page.js` (the new CMS guard) without a bump — it would have been
   invisible to every returning visitor. *Unstaged* edits are ignored on purpose: nagging
   about work-in-progress is what makes a suite permanently red, and that numbness is the
   disease (ERR-063), not the cure.

**Bump recipe:** `md5(content)[:8]` — e.g.
`python3 -c "import hashlib;print(hashlib.md5(open('inkcartridges/js/footer.js','rb').read()).hexdigest()[:8])"`
then update every `?v=` for that asset.

**Lesson:** a test that cannot be green is worse than no test. It launders real failures
(ERR-066 hid in that noise for 12 days) into expected background. If the suite is red,
that is the emergency.

---

## ERR-063 — A compliance guard that scans a hand-maintained file list is not a guard (2026-07-14)

**Symptom:** the banned Google-Ads claim *"Using a quality compatible cartridge **does not
void** your printer's warranty… a manufacturer **cannot refuse to honour**…"* was reported
**fixed twice** (Jul 7, Jul 12) and was **still live** on `/genuine-vs-compatible` on Jul 13.
The test suite was green each time.

**Root cause — two independent blind spots, one shared shape:**
1. `tests/google-ads-compliance-may2026.test.js` banned `/won['’]?t void/` but **not
   `does not void`** — the phrase that was actually shipped.
2. That same suite's `FILES_TO_SCAN` was a **hand-written allowlist of ~40 paths**, and
   `html/genuine-vs-compatible.html` **was never on it**. The page had never once been scanned.
3. `tests/reappeal-disclaimers-jul2026.test.js:98` had the *correct* assertion
   (`doesNotMatch(/does not void your/i)`) but pointed it at **`js/product-detail-page.js`
   only** — not at either HTML file that contained the phrase.

A second, identical claim was also live in `html/index.html`'s FAQ. Nobody found it, because
nothing was looking.

**Fix (all three, or it comes back):**
- `FILES_TO_SCAN` is now **auto-discovered** by walking `inkcartridges/**/*.html` (excluding
  `html/admin/**`). **Never reintroduce an allowlist.** A new page is covered the moment it
  exists, not the moment someone remembers to register it.
- Banned phrases live in **one** place — `LegalConfig.BANNED_CLAIM_PATTERNS`
  (`js/legal-config.js`) — consumed by both the test suite and the browser runtime guard, so
  they cannot drift.
- Patterns are **assertion-shaped** (`does not void`, `refuse to honou?r`, `cannot require you
  to use`…), never a bare `warranty`/`void` — the admin invoice **"Void"** status and
  `landing.js`'s `void content.offsetHeight` are legitimate and must not trip.

**Gotcha:** `legal-config.js` now *contains* the forbidden phrases (as regex literals), so it
matched its own sweep. `stripComments()` strips the `BANNED_CLAIM_PATTERNS:[…]` array literal
before scanning.

**Pinned by:** `tests/genuine-vs-compatible-warranty.test.js` — including §3 "the patterns
actually catch the copy that shipped" and §3 "the patterns do NOT ban legitimate warranty
language", so the guard can neither rot nor be over-broadened into deletion.

---

## ERR-064 — The retired 09 813 3882 landline was still printing on customer invoices (2026-07-14)

**Symptom:** `tests/google-ads-compliance-may2026.test.js` was **already red at HEAD** —
forbidden pattern `/09[ -]?813[ -]?3?882?/` matched `js/legal-config.js`. This is why nobody
noticed ERR-063: **the compliance suite was never green, so its output was noise.**

**Cause:** `LegalConfig.invoice.phone` was hardcoded to `09 813 3882` — the *retired* landline,
listed in `FORBIDDEN` alongside the old `inkandtoner@windowslive.com` address (both long
removed elsewhere). It printed on every customer invoice while the storefront advertised
`027 474 0115`.

**Fix:** `invoice.phone` → `027 474 0115` (matches `phoneDisplay`). Owner confirmed the landline
is dead.

**Lesson:** a permanently-red test is worse than no test — it launders real failures into
expected noise. If the suite is red, that is the emergency, before anything else.

---

## ERR-065 — The legal-content CMS has never worked: `const Config` is not `window.Config` (2026-07-14)

**Symptom:** 5 rows exist in Supabase `legal_content_overrides` (About hero/story/brands, Terms
stock/returns). **None has ever rendered on the live site.** Admin edits vanish silently.

**Cause:** `js/config.js` declares `const Config = {…}` at top level. A top-level `const` creates
a *script global* but — unlike `var` — is **NOT a property of `window`**. `js/legal-page.js`
`getSupabaseConfig()` tests `typeof window.Config !== 'undefined' && window.Config.SUPABASE_URL`
→ always false → returns `null` → `fetchOverrides()` short-circuits to `Promise.resolve([])`.
Bare `Config.SUPABASE_URL` works; `window.Config` is `undefined`. Verified in-browser.

**DO NOT "just fix" this.** Making overrides apply would render SPA copy the **backend
prerender does not serve** → bot HTML ≠ browser HTML on `/terms` + `/about` → that is
**cloaking**, the exact charge being appealed. Repairing it requires backend prerender parity
first.

**RESOLVED 2026-07-14 — by RETIREMENT, not repair.** The owner chose to kill the CMS rather
than fix the binding. The backend purged all 5 override rows; the frontend deleted the read
path (`legal-page.js`) *and* the write path (the admin editor). Legal copy now has exactly one
source per page: the page's HTML, plus `legal-config.js` for the facts. The interim
banned-claim runtime guard (`rejectIfBanned`) went with it — there are no overrides left to
screen, and a removed mechanism beats a guarded one. Full write-up: **ERR-069**.

Runtime proof of this diagnosis, captured during the retirement: rendering `/terms` at the
pre-retirement commit in Chromium produced **zero** requests to `legal_content_overrides` while
`window.LegalContent` was present — i.e. the CMS surface existed and the fetch never fired,
exactly as the `window.Config` analysis predicted.

**Wider lesson:** a `curl`-based compliance check cannot see SPA-injected copy. Any "prove it's
fixed" grep must be run against the **rendered DOM**, not just the served HTML — AdsBot executes
JavaScript.

---

## ERR-068 — Backend started returning `null` COGS; the frontend rendered it as `$0.00` (2026-07-14)

**Symptom (LIVE, on the owner's screen):** after the backend shipped the invoiced-
sales integration it began honouring COGS honesty — `cogs` / `gross_profit` /
`net_profit` come back as **`null`** (not `0`) for any period containing an
un-costed sale. The Finance P&L promptly rendered **"Cost of Goods Sold $0.00 /
Gross Profit $0.00 / Net Profit $0.00"** and the profit chart drew a flat line
along the axis. The Dashboard KPI tiles were fine (they were already null-honest);
everything else was not.

**Root cause:** the same coercion family as ERR-061, on the read side.
`Number(null) === 0`, `null || 0 === 0`, and `financial-health.js`'s local
`num(v, d = 0)` returns `0` for null. Eight sites fabricated a zero:

| Site | Effect |
|---|---|
| `financial-health.js` `fmt()` | `$0.00` for an unknown COGS |
| `financial-health.js` `change()` | `0%` ("profit was flat") / `+∞` |
| `financial-health.js` `renderProfitChart()` | line plotted down to the axis |
| `dashboard.js` `drawRanked()` ×3 (data, sort, tooltip) | $0 bars; unknown SKUs sorted as the *worst* |
| `dashboard.js` `drawRevenueProfit()` | a $0 profit bar beside a healthy revenue bar |
| `dashboard.js` `drawPerformanceOverview()` | `Number(net ?? gross ?? 0)` — the `??` chain *looks* null-safe but terminates in `0` |
| `dashboard.js` `drawSeries()` | latent, same shape |
| **`dashboard.js` low-margin ALERT** | **the worst one — see below** |

**The dangerous one.** `computeLowMarginAlert` did
`pct: Number(b.margin_pct)` → `.filter(b => Number.isFinite(b.pct) && b.pct < 10)`.
`Number(null)` is `0`, and `Number.isFinite(0)` is `true`, and `0 < 10` — so every
brand with an *unknown* margin was reported as a **critical "0.0% — reprice or
drop"** recommendation. Not a cosmetic bug: an actionable instruction to drop a
brand, built on a number that does not exist.

**Fix:** `numOrNull()` in `dashboard.js` (null/''/NaN → `null`, real `0` → `0`) and
a `known()` guard in `financial-health.js`. Unknown renders `—`; charts push `null`,
which Chart.js draws as a **gap** (`spanGaps` defaults `false`). A cumulative
running total *carries the gap forward* — a total past an unknown bucket is itself
unknowable, so it must not silently treat the gap as `+0`.

**Rule:** unknown is not zero, on the way **out** (ERR-061) *or* the way **in**.
Anything COGS-derived — `cogs`, `gross_profit`, `net_profit`, `*_margin_pct` — is
nullable by contract. Never `Number(x)`, never `x || 0`, never `?? 0`. And never
let a *derived alert* fire on a null: a fabricated 0 that reaches a recommendation
is worse than one that reaches a chart.

**Pinned by:** `tests/admin-cogs-honesty.test.js` (12 tests, incl. a sanity check
that the naive filter really *did* flag an unknown-margin brand at 0.0%).

---

## ERR-061 — Cost of $0 vs cost UNKNOWN: `Number('')` is `0`, which reports a 100% margin (2026-07-12)

**Symptom (designed out, not observed):** while adding an internal supplier-cost
field to invoices, the obvious wiring — `_draft.lines[i][field] = t.value` then
`num(l.supplierCost)` — silently turns an **empty** cost box into **`$0`**. A $0
cost is not "unknown", it is "free", and it reports a **100% margin**. Every
un-costed invoice line would have masqueraded as pure profit, and the Dashboard's
Gross Profit would have been inflated by the entire invoiced channel.

**Root cause:** `Number('') === 0` and `Number(null) === 0`. The generic line
handler stringifies (`t.value`), so a cleared number input arrives as `''`.

**Fix:** every read of a supplier cost goes through `costOrNull()` in
`js/admin/utils/invoice-math.js` — `'' → null`, `0 → 0`, `'abc' → null`,
`-1 → null`. `null` means UNKNOWN and **poisons the whole invoice's profit to
`null`**, which the UI renders as `—  (N lines missing a cost)`. A deliberate
typed `0` is honoured as a known zero. `profitability.js:computeLineProfits`
already made this distinction ("Number(null) is 0, which would lie") — the same
rule now holds end to end.

**Rule:** In this codebase an absent cost is **`null`, never `0`**. That applies
to the frontend, to `buildPayload` (which sends `null` so the backend snapshots
`products.cost_price` itself), and to the backend's own P&L — a period containing
an un-costed line must return `cogs`/`gross_profit`/`net_profit` as `null`, not
`0`. Same family as ERR-028 (COGS honesty) and ERR-039.

**Pinned by:** `tests/admin-invoice-cost-math.test.js` (`costOrNull('')` is `null`
but `costOrNull(0)` is `0`; one un-costed line ⇒ `computeInvoiceProfit === null`).

---

## ERR-062 — `stripEsm` test harness silently fails on `export async function` (2026-07-12)

**Symptom:** `tests/admin-invoice-overlay.test.js` died with `SyntaxError:
Unexpected token 'export'` inside `vm.runInContext`, even though the same harness
works for every other util module.

**Root cause:** the shared `stripEsm()` helper (copied across the admin util test
files) matches `export\s+(const|let|var|function|class)`. `invoice-overlay.js`
exports `export **async** function fetchCountableInvoices()`. The `async` keyword
sits between `export` and `function`, so the pattern doesn't match, the `export`
is left in the source, and the vm — which has no module semantics — rejects it.

**Fix:** allow the modifier, and re-emit it:
```js
src.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
  (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
```
Also strip `import … from '…'` lines when the module under test has dependencies,
and load the dependency's source into the **same** vm context first (see
`tests/admin-invoice-cost-math.test.js`, which concatenates `profitability.js`
then `invoice-math.js`).

**Rule:** when sandboxing a new admin util, check its export forms first. The
sibling gotcha is already logged: values built inside the vm realm carry that
realm's prototypes, so `assert.deepEqual` fails with "same structure but not
reference-equal" — round-trip through `JSON.parse(JSON.stringify(x))` first.

---

## ERR-057 — Merchant audit LIVE pass reports 946/3004 feed "issues" — mostly auditor false-positives, not feed regressions (2026-07-07)

**Symptom:** `node scripts/audit-merchant-center-readiness.mjs` prints
`946/3004 feed items have at least one issue`: **901** "compatible title should START with a
non-OEM term", **830** "duplicated brand token HP HP / OKI OKI / Epson Epson", **43** implausible
yields, **3** ribbon page-yields — even though the backend shipped the feed remediation (a6f78ff)
and its own 6-check table reports 0. NOT stale cache: the fresh cache-busted www feed
(`x-vercel-cache: MISS`) reproduces the identical 946. The auditor and the shipped feed disagree.

**Classification (verified per-SKU against the live feed):**
1. **830 "duplicated brand token" = auditor FALSE POSITIVE.** The check runs on `title + " " + desc`.
   Real items are fine — e.g. `C02BK`: title *"02 Black Compatible Ink Cartridge **for HP**"*,
   desc *"**HP** Compatible Ink Cartridge…"*, `<g:brand>Office Consumables Ltd`. The "HP HP" only
   exists at the title→description **join**; no field actually duplicates the brand. Fix belongs in
   OUR script (check fields separately, or anchor the token check), not the feed.
2. **901 "title should START with a non-OEM term" = rule-strictness disagreement.** Shipped titles
   `{code} {color} Compatible {type} for {OEM}` are MC-compliant (labelled Compatible, seller
   brand). The auditor's `COMPATIBLE_LEADS` regex insists the title *begin* with
   Compatible/Third-party/Generic — MC does not require the prefix.
3. **Non-page-rated products carrying a "N pages" yield = REAL defect (backend), ~125 items.** Not
   just the 3 ribbons + 43 the auditor's min/max caught — gating on **product_type** (regex
   `ribbon|label tape|photo paper|correction tape`) finds **122** more: label tapes (Dymo `S07*`/
   `ZDY*`, Brother `TZE*`/`DK*`) with fabricated "12–1,564 pages", photo paper "N pages each". Many
   sit *inside* the plausible 15–60000 range so a value-based check misses them — catch by type.
   Root cause: feed builder emits the yield token without gating on category. Fix backend-side.
4. **~15 high-capacity drums/fusers/waste-toner (65k–300k pages) = auditor FALSE POSITIVE.** The
   auditor's `MAX_PLAUSIBLE_YIELD=60000` is too low for those categories (e.g. fuser 300k, drum
   200k are correct). One genuinely corrupt: `G126ABK-2` "HP … 14 pages — Genuine Drum Unit". FE
   should make the plausibility cap category-aware.

**Rule:** STATIC pass is the blocking gate (exit 0 = release-ready); LIVE pass never fails the build
and is advisory. Two live rules (dup-brand via title+desc concat; compatible-title-START) and the
flat yield cap are stricter/blunter than GMC and over-report — confirm per-SKU, don't treat as
regressions. Genuinely actionable backend item = strip the page-yield token from non-page-rated
product types (~125 SKUs). Full dump + defect SKU list saved to scratchpad
`mc-audit-full.json` / `defect-skus.txt`; handoff at `~/Downloads/backend-tasks-jul2026.md`.

## ERR-056 — Product Codes save fails: "new row violates row-level security policy for table product_codes" (2026-07-06)

**Symptom:** In the admin product drawer → **Product Codes** tab, toggling a second code and clicking
**Save Changes** shows "Product updated" but then an error toast: *Product saved, but codes didn't:
new row violates row-level security policy for table "product_codes"*. Codes never persist.

**Root cause (NOT a frontend bug — verified live with Playwright as the owner):** `AdminAPI.setProductCodes`
(`js/admin/api.js:1447`) writes codes **directly** to Supabase from the browser using the admin's
authenticated session (delete-then-insert), the same working pattern as `product_ribbon_brands`.
The session is valid, non-expired, **role=`authenticated`**; SELECT works; the table exists with RLS on.
A probe INSERT returned Postgres **`42501`** and blocked *before* the CHECK constraint (fired even on a
lowercase value that violates `code = upper(code)`) — proving there is **no INSERT policy granting
`authenticated` write** on the live table. i.e. `inkcartridges/sql/product_codes.sql` (which defines
`product_codes_insert_auth` / `_delete_auth` + grants) was **never fully applied** to live project
`lmdlgldjgcanknsjrcxh` — only the table + `enable row level security` exist.

**Fix:**
1. **DB (the actual fix):** run `inkcartridges/sql/product_codes.sql` in Supabase → SQL Editor (idempotent;
   `drop policy if exists` + `create policy`, no data touched). Takes effect immediately, no deploy.
   The frontend cannot run DDL — only the anon key + a site-user `authenticated` JWT are available; no
   service-role key or connection string exists in this repo.
2. **Frontend hardening (this repo):** `describeCodesWriteError(err)` in `js/admin/pages/products.js`
   maps `42501` / `/row-level security|permission denied/` to a plain-English, actionable toast
   ("…the database is missing write permission for the product_codes table. Apply
   inkcartridges/sql/product_codes.sql in Supabase…"). Wired into both `setProductCodes` failure surfaces
   — the Save handler (~line 3260) and the brand-wide rename/delete via `applyBrandCodeChange` (~line 2135).
   Verified: the friendly message renders end-to-end while the DB is still unpatched.

**Rule:** These junction tables (`product_codes`, `product_ribbon_brands`) are written by direct
**authenticated** Supabase inserts from the browser — their `.sql` migration (RLS policies + grants for
`authenticated`) MUST be applied to live, or every admin write 42501s. A `42501` from an authenticated
admin = missing/incomplete RLS policy on live, not a session problem.

**RESOLVED (2026-07-07):** Backend applied the policies to live via migration
`104_product_codes_admin_write_policies.sql` (documented in `Downloads/product-codes-admin-editing.md`) —
same `to authenticated` INSERT/DELETE policies + grants as `inkcartridges/sql/product_codes.sql`. Admin
code writes now persist. Frontend follow-up: `describeCodesWriteError` no longer tells the admin to run
the SQL (stale advice) — a `42501` now maps to *"you don't have permission… make sure you're signed in as
an admin,"* and `23514` (check) / `23503` (FK) / `23505` (duplicate → no-op) are mapped per the backend's
error table. `setProductCodes` now swallows `23505` as a no-op. Cache-bust: `APP_VERSION`
`2026.07.07-product-codes-rls` + `api.js?v=product-codes-rls-jul2026`. New assertions in
`tests/product-codes.test.js` (40 pass).

---

## ERR-051 — Admin Invoices: status leaked onto customer invoice; need inline paid/unpaid (2026-06-28)

**Symptom (request, not a crash):** The invoice "Status" (draft/unpaid/paid/void) printed on the
**customer-facing** invoice (live preview + PDF header). The operator doesn't want customers to see
it, and wanted to track paid/unpaid from the list directly.

**Fix (frontend, this repo):**
- **Removed Status from the customer doc** — `invoiceMeta()` (the single source for both the HTML
  preview and the jsPDF header) no longer pushes a Status row. Header is now Invoice No / Date /
  GST No only. (`pages/invoices.js`)
- **List column** — replaced the read-only Status badge with an inline **Paid** toggle
  (`.inv-paid` switch). Voided rows show a muted "Void" label (no toggle), mirroring how the Void
  row-action already hides itself for void rows.
- **Filter** — dropdown is now All / Paid / Unpaid / Void (Draft dropped).
- **Editor** — status select reduced to Unpaid / Paid (labelled "internal — not shown to the
  customer"); **Draft retired** from `STATUS_META` everywhere. Void stays driven by the row-action.
- **Toggle wiring** — `AdminAPI.markInvoicePaid(id, paid)` → `POST /api/admin/invoices/:id/paid`,
  optimistic flip + fail-soft (reverts on error). Backend route is **pending** — a 404 surfaces as
  `err.code 'NOT_FOUND'` (via the ERR-050 `invoiceError` top-level-code lift) → toast "Mark-paid
  isn't available yet (backend endpoint pending)."; no crash.

**Click-vs-row-open gotcha:** DataTable's per-row click handler opens the editor unless the click
target matches `closest('button, a, input')`. The `.admin-toggle` component's input is zero-size,
so clicks land on the slider `<span>` → would open the editor. The `.inv-paid` toggle puts the
`<input>` as a full-size, opacity-0 top layer (`z-index:2`), so the click target is always an
`<input>` → row-open guard ignores it. (`css/admin.css`)

**Backend dependency:** `POST /api/admin/invoices/:id/paid` (owner-only, `{ paid:bool }` →
`status='paid'|'unpaid'`). Contract in `readfirst/invoice-mark-paid-backend-handoff-jun2026.md`.
Until it ships, the toggle fails soft.

---

## ERR-050 — Admin Invoices: "can't delete invoices" — trash icon only voided; no delete existed (2026-06-28)

**Symptom:** Operator clicking the trash icon on `/admin#invoices` couldn't get rid of
test invoices — they kept showing in the list (most already `Void`).

**Root cause:** The trash icon was wired to **Void**, not delete
(`data-row-action="void"` → `POST /api/admin/invoices/:id/void`). Voiding *worked* (route
is live; probe returns 401 unauthed, not 404) but voided invoices are kept for records and
stay in the list, so it read as "delete is broken." Re-voiding an already-void row did
nothing visible. There was **no delete capability at all** — `DELETE /api/admin/invoices/:id`
(and `POST .../delete`, `POST .../destroy`) all return 404 on the backend.

**Fix (frontend, this repo):**
- Added a distinct **Delete** row action (trash icon, `data-row-action="delete"`) →
  `AdminAPI.deleteInvoice(id)` → `window.API.delete('/api/admin/invoices/:id')`, with a
  destructive confirm modal and list reload on success. (`pages/invoices.js`, `api.js`)
- Re-iconed **Void** to a new `ban` slash-circle glyph (`app.js` icon map) and hid the
  Void button on rows already `void` (kills the no-op re-void confusion).
- `invoiceError` now also carries the top-level envelope `code` (string-error 404s expose
  `code:'NOT_FOUND'` at top level), so the delete catch shows a friendly "Delete isn't
  available yet (backend endpoint pending)." while the backend route is missing — fail-soft,
  no crash, row stays.

**Backend dependency:** permanent removal needs the new `DELETE /api/admin/invoices/:id`
endpoint (owner-only hard delete, line items cascade, drop stored `invoices/<id>.pdf`).
Contract handed off in `readfirst/invoice-delete-backend-handoff-jun2026.md`. Until it
ships, Delete fails soft.

---

## ERR-045 — Admin SPA: async page load resolves AFTER `destroy()`, throws on a nulled module ref (2026-06-25)

**Symptom:** Spurious red toast on the Dashboard — "Failed to load segments: Cannot
read properties of null (reading 'setData')". The Segments page wasn't even visible.

**Root cause:** `pages/segments.js` `loadData()` guards `if (!_table) return` only
*before* `await AdminAPI.getSegments()`. Navigating away during the in-flight request
runs the page's `destroy()`, which sets the module-level `_table = null`. When the
request resolves, execution resumes at `_table.setData(rows)` → null deref. Classic
"async function outlives the component it touches" race. The router already solves the
same problem for itself with a `_navToken` re-check after its awaits (`app.js:246/286`);
page controllers must do the equivalent internally.

**Fix:** Re-check the page-liveness ref AFTER every `await` (and at the top of the
`catch`), then silently `return`. Pattern to apply in any `*-page.js`/`pages/*.js`
controller whose `destroy()` nulls a module ref used after an await:
```js
const data = await AdminAPI.getX();
if (!_table) return;        // page destroyed mid-await → bail, don't paint/throw
```

---

## ERR-044 — Per-page `pages.css` cache token broke the shared three-card-CSS rollout-token invariant (2026-06-24)

**Symptom:** Added loyalty styles to `css/pages.css` and bumped only the 5 touched
pages' `pages.css?v=` to a new token. The full test suite then failed
`tests/product-card-title-clamp.test.js` → "all HTML pages cache-bust the three
card CSS files to v=…", plus (after a naive site-wide bump) two shop.html token
tests in `search-pagination.test.js` and `shipping-bar-inline-may2026.test.js`.

**Root cause:** `components.css`, `pages.css`, and `search.css` share **ONE**
rollout token that must be **identical on every `.html` page** under `inkcartridges/`.
It is pinned three ways: `CARD_CSS_TOKEN` in product-card-title-clamp.test.js (walks
ALL html), and per-file shop.html assertions in search-pagination + shipping-bar tests.
A per-page or single-file token bump violates the invariant.

**Fix:** When ANY of those three CSS files changes, advance the shared token across
**all** html for **all three** files at once, and update the **three** test constants:
```
find inkcartridges -name '*.html' -not -path '*/node_modules/*' -print0 | while IFS= read -r -d '' f; do
  sed -i '' -E 's#/css/(components|pages|search)\.css\?v=[a-zA-Z0-9-]+#/css/\1.css?v=NEWTOKEN#g' "$f"; done
```
then update `CARD_CSS_TOKEN` (product-card-title-clamp), the shop.html `pages.css`
regex (shipping-bar-inline-may2026 §6), and the shop.html `search.css` regex
(search-pagination). Production HTML is content-hash re-stamped by
`scripts/stamp-versions.js` at build, so the literal token value is only a
test/dev contract — keep it consistent, don't fragment it per page.

---

## ERR-043 — `git stash pop` silently popped an UNRELATED old stash and shredded 51 files with conflict markers (2026-06-21)

**Symptom:** Ran `git stash; <test>; git stash pop` to A/B a change against a
clean tree. `git stash` printed **"No local changes to save"** (the tree was
already clean — an external commit `80f71c4` had just captured the WIP), so the
following `git stash pop` popped a **pre-existing** `stash@{0}` ("navbar-parity:
pre-commit stash of unrelated WIP"). It 3-way-merged that stale WIP onto HEAD,
producing `CONFLICT` markers in **51 files** (47 HTML + css + main.js + shop-page.js
+ 2 tests) and depositing 2 banned untracked `readfirst/*.md` specs.

**Root cause:** `git stash pop` with **no argument** operates on `stash@{0}`,
whatever it is. It is NOT paired to the `git stash` you just ran — if your stash
saved nothing, pop still fires on an older entry. The repo keeps a long-lived
`stash@{0}` of unrelated WIP, so a no-op `git stash` followed by `git stash pop`
is a loaded gun.

**Fix / recovery:** In a stash-pop conflict, `--ours` = your pre-pop tree (here
HEAD, which already held my edits), `--theirs` = the stash. Resolve to ours and
clear the merge, keeping the stash entry intact (no data loss):
```
git diff --name-only --diff-filter=U | while read f; do git checkout --ours -- "$f"; git add -- "$f"; done
```
Then delete any banned untracked files the pop deposited (see no-ghost-files.test.js)
and re-verify with `git status` + the full test suite.

**Rule:** NEVER use bare `git stash` / `git stash pop` to snapshot around a test
run in this repo — there is a permanent unrelated `stash@{0}`. To A/B against a
clean tree use `git stash push -m "tmp" -- <specific files>` then
`git stash pop stash@{0}` **by explicit ref** only after confirming the message,
or far simpler: `git show HEAD:<file>` / `git diff` to compare without touching the
tree. Always read `git stash`'s output — "No local changes to save" means the
following pop will hit something you did not put there.

---

## ERR-042 — Recent-search chip filled the box but Enter + magnifier did nothing (2026-06-21)

**Symptom:** Clicking a **RECENT SEARCHES** chip in the header dropdown populated
`#search-input`, but then pressing **Enter** OR clicking the magnifier did
nothing — no navigation. Distinct from ERR (May search-enter-key) where only
Enter broke; here **both** died, and **only** on the chip path.

**Root cause:** `js/search.js` recent-chip handler set `state.input.value = q`
**without dispatching an `input` event**. `js/main.js` `syncSubmitState()` (which
re-enables the submit button once the box has ≥2 chars) is driven by the `input`
event, so it never ran and the submit button kept its empty-box `disabled` state.
A disabled `<button type="submit">` is a no-op for BOTH Enter (HTML implicit
submission clicks the form's default submit button) AND a direct magnifier click.

**Fix (two layers):**
1. **search.js (primary):** recent-search chip now navigates straight to
   `/search?q=${encodeURIComponent(q)}` — the routing-contract destination
   (`tests/search-dropdown-routing.test.js`), same as Enter / "View all results",
   and consistent with how trending-printer chips already navigate. No box to be
   dead.
2. **main.js (defense-in-depth):** `syncSubmitState` is now also wired to `focus`
   and `change`, not just `input`, so any programmatic `value =` (autofill,
   bfcache, future fills) can never strand a stale-disabled submit button.

**Rule:** A programmatic `input.value = …` does NOT fire `input`. If any state
(a disabled submit, a validity flag, a counter) is driven off the `input` event,
either dispatch `new Event('input', {bubbles:true})` after the assignment OR
re-sync that state on `focus`/`change` too. Prefer navigating re-run affordances
(recent searches) straight to the results route over leaving a filled box that
depends on the submit button being enabled.

**Pinned by:** `tests/search-recent-chip-no-submit-jun2026.test.js` (19 tests —
real `onListClick` + real `initSearch`/`syncSubmitState` driven through a fake DOM).

---

## ERR-041 — Card-CSS cache-bust token was inconsistent across the 3 shared files; bumping it breaks token tests in 3 files (2026-06-21)

**Symptom:** During the loading-state rework I edited `css/pages.css`. The
"3 card CSS files share ONE rollout token" convention was already violated at
HEAD: `pages.css?v=faq-toggle-jun2026` while `components.css` / `search.css`
were still `buybox-may2026`. That left `tests/product-card-title-clamp.test.js`
("all HTML pages cache-bust … to v=buybox-may2026"), `tests/shipping-bar-inline-may2026.test.js`
(§6) and others RED before I touched anything.

**Root cause:** Multiple test files independently hardcode the expected `?v=`
token for `components.css`/`pages.css`/`search.css`. When ANY of the three CSS
files changes you must (a) set ALL THREE to the same new token across every HTML
file, and (b) update EVERY test that pins the old token — they don't read from a
single constant.

**Fix:** New shared token `loading-spinner-jun2026` stamped on all three files in
every `*.html` (perl one-liner over `find … -name '*.html'`), and the constant
bumped in **three** test files:
- `tests/product-card-title-clamp.test.js` (`CARD_CSS_TOKEN`)
- `tests/search-pagination.test.js` (search.css assertion)
- `tests/shipping-bar-inline-may2026.test.js` (§6 pages.css assertion)

**How to apply next time:** grep `tests/` for `buybox-may2026` (or the current
token) AND for `(pages|search|components)\.css` assertions before committing any
card-CSS change. Deployed HTML is content-hash stamped by `scripts/stamp-versions.js`
at build; the committed manual `?v=` token only needs to be internally consistent
+ match the tests.

**Pre-existing, NOT fixed here (out of scope, unrelated to loading states):**
5 red tests in `legal-pages.test.js` (§2 footer Policies column, §2 copyright
surcharge wording, §9 pages.css legal hooks) and `tracking-request-may2026.test.js`
(/track-order footer link, footer disambiguation line). These were red at HEAD.

---

## ERR-040 — Landing page edits must target `inkcartridges/index.html` (ROOT), not `inkcartridges/html/index.html` (2026-06-21)

**Symptom:** Redesigned the "Find ink for your printer" Ink Finder and applied
the whole HTML rewrite to `inkcartridges/html/index.html` — but nothing changed
on the live landing page, and the pinning test (`tests/ink-finder-may2026.test.js`,
which reads `inkcartridges/index.html`) didn't see my markup.

**Cause:** There are **two** index.html files and they are NOT the same page:
- `inkcartridges/index.html` — the **ROOT / canonical landing page**. `npx serve
  inkcartridges` serves it at `/`, the screenshot URL `localhost:3000` is it, and
  every test reads it. Heading: *"Find ink for your printer"*.
- `inkcartridges/html/index.html` — an **unreferenced legacy duplicate** (older
  heading *"Find Your Ink Fast"*, old finder markup). Nothing routes to it (no
  vercel rewrite, zero inbound links — `grep -rIn "html/index.html"` is empty).

**Fix / rule:** For the landing page, edit `inkcartridges/index.html` (root). All
other pages live under `inkcartridges/html/` (shop.html, account/, etc.) — only
the landing is special-cased at the package root. When `serve inkcartridges`
serves `/`, it resolves to the root index, so that is the source of truth.

**Also (cache tokens):** the working tree was mid a `faq-toggle-jun2026` pages.css
rollout (the "three card CSS" shared token, pinned by
`tests/product-card-title-clamp.test.js` to `buybox-may2026` — that test + footer
`.footer-legal-nav` + shop.html token tests were already RED from that WIP, not
from finder work). When you touch pages.css on the landing, match the in-flight
rollout token rather than minting a new one, so you don't fragment the shared key.

**Pinned by:** `tests/ink-finder-may2026.test.js` (rewritten to the cascade
contract, 26 tests) + `tests/ink-finder-grouped.test.js` (unchanged, still green).

---

## ERR-037 — Admin Dashboard analytics: route through backend HTTP wrappers, not direct Supabase RPC (permanent ERR-010 fix, 2026-06-04)

**Symptom:** Recurring — the dashboard's New Customers / Returning % (and at
other times Revenue / Gross Profit / Orders) intermittently show "—" or trip the
yellow *"Live analytics service is unavailable"* banner. Live-diagnosed
2026-06-04: minted an admin JWT and probed the direct Supabase RPCs —
`analytics_customer_stats` → **403 `42501 permission denied for function`**,
while `analytics_kpi_summary` / `_revenue_series` / `_refunds_series` /
`_top_products` were 200 *that minute*. This is the ERR-010 / ERR-029 / ERR-035
family: the RPCs' `GRANT EXECUTE TO authenticated` is dropped by backend
redeploys, one function at a time, unpredictably.

**Root cause:** the frontend called the Postgres RPCs **directly** from the
browser (`AdminAPI.getDashboardKPIs` etc. → `rpc('analytics_*')` →
`SUPABASE_URL/rest/v1/rpc/...`). Any dropped grant 403s and the tile goes dark.
The grant churn is a backend/DB problem the frontend cannot stop — but it does
NOT have to depend on those grants.

**Fix (frontend, permanent):** the backend now exposes a service-role HTTP
wrapper for every analytics read under `/api/admin/analytics/*` (spec:
`Downloads/analytics-api-spec.md`). Those wrappers hold their own grants
(immune to the `authenticated`-role GRANT being dropped) and fall back to a
JS-computed equivalent server-side (`data.fallback = true`). Rewired the five
RPC-backed getters to hit **HTTP first, direct RPC only as a secondary
fallback** (covers the inverse outage — backend down, grant healthy):
- `getDashboardKPIs`   → `GET /kpi-summary`   (live shape `{current,previous}` == old RPC; `normalizeKpiSummary` also tolerates the spec-doc metric-keyed shape)
- `getRevenueSeries`   → `GET /revenue-series`
- `getRefundAnalytics` → `GET /refunds-series`
- `getTopProducts`     → `GET /top-products-rpc` (unwraps `{products}` → array)
- `getCustomerStats`   → RPC first (only source of *returning %*); when its grant
  is dropped, reconstruct **New Customers** from the always-on
  `GET /summary/customers` (`new_customers_30d`). Returning % has no fallback
  source so it honestly stays "—" instead of lying.

Also fixed a latent refund bug surfaced en route: `analytics_refunds_series`
keys the daily refund total as **`total_amount`**, but the dashboard read
`r.amount || r.total || r.value` (none match) → every refund summed to $0 and
Refund-Rate read 0%. Added `trend-math.refundAmount(row)` (reads `total_amount`
first) and routed all four refund-sum sites through it. And `window.API.get`
now forwards a 2nd `options` arg so `{ signal }` aborts actually work.

**Verified live 2026-06-04** by running the rewired `AdminAPI` against prod:
KPIs $933.81/9 orders/$332.78 GP via HTTP; CustomerStats `new_customers: 2`
via the summary fallback (RPC was 403); refunds-series exposes `total_amount`;
top-products returns a 10-item array.

**Rule:** never call `analytics_*` Supabase RPCs directly from the browser —
go through `/api/admin/analytics/*`. The direct RPC is a *fallback*, never the
primary. `data.fallback === true` from the HTTP wrapper means the numbers are
valid (server reconstructed them) — do NOT raise the "unavailable" banner for it.

**Pinned by:** `tests/admin-analytics-wiring.test.js` (23 tests).

---

## ERR-035 — Admin Dashboard live analytics dark again: `42501 permission denied for function` (2026-05-22)

**Symptom:** Admin Dashboard shows the yellow *"Live analytics service is
unavailable — Revenue, Orders and Avg Order Value below are reconstructed from
order records. Gross Profit, Gross Margin, New Customers, Returning % and Refund
Rate need the analytics service…"* banner. KPI strip: Revenue $1,691.83, Orders
35, AOV $48.34 (reconstructed), but Gross Profit / New Customers / Returning % /
Refund Rate / Gross Margin all "—". Trends shows "Net excl. COGS" not Profit.
This is the order-feed self-heal ([[project_dashboard_kpi_self_heal_may2026]])
doing its job — the dashboard is NOT broken; the analytics RPCs are.

**Root cause (backend DB grant — NOT frontend):** third recurrence of the
ERR-010 / ERR-029 family. Diagnosed live: minted an `authenticated` JWT
(`POST /auth/v1/token?grant_type=password` with the anon key) and curled the
RPCs with their real named params (`date_from`, `date_to`, `brand_filter`, …):

```
analytics_kpi_summary   → 403 {"code":"42501","message":"permission denied for function analytics_kpi_summary"}
analytics_revenue_series→ 403 42501
analytics_customer_stats→ 403 42501
get_suppliers           → 403 42501   (collateral — confirms it's all of public)
```

The functions still EXIST (correct params give 42501, not PGRST202 404 — calling
with empty `{}` *does* give a 404 signature-mismatch, which is a red herring; you
must send the real named params to see the true 42501). A backend migration had
again revoked / dropped-and-recreated public functions without re-granting
EXECUTE to `authenticated`.

**Fix (permanent, this time it can't recur):** `inkcartridges/sql/analytics_function_grants.sql`
— idempotent migration that (1) `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
TO authenticated, service_role` to restore data now, (2) `ALTER DEFAULT
PRIVILEGES` for the standard creating roles, and (3) installs an **event trigger**
`trg_grant_execute_on_public_functions` that re-grants EXECUTE on any function
the instant it is CREATEd/ALTERed in `public`. The event trigger is the durable
part: a future DROP+CREATE migration (which discards the ACL) is now healed in
the same transaction, before any client can hit a 42501. Ends the recurrence.
Applied to live project `lmdlgldjgcanknsjrcxh`; re-probed the RPCs → 200.

**Rule:** when the dashboard shows the self-heal banner, do NOT touch the
frontend — the self-heal is correct and the missing KPIs (New Customers, etc.)
*cannot be honestly reconstructed* from the order feed, so faking them is wrong.
Diagnose with the JWT+curl recipe; the answer is always a DB grant. Apply
`sql/analytics_function_grants.sql` — the event trigger means you only ever apply
it once. **Probe gotcha:** an empty-`{}` RPC call returns 404 PGRST202 even when
the real problem is 42501 — always send the function's real named params.

**Pinned by:** `tests/analytics-function-grants.test.js`.

---

## ERR-034 — `/shop?category=ink` (no brand) stuck on "server may be warming up" forever (2026-05-21)

**Symptom:** Any category-only deep link — `/shop?category=ink`, `/shop?category=toner`,
the `/ink-cartridges` landing — rendered the alarm-state card *"We couldn't load
products. The server may be warming up — please try again."* permanently. The
"Try again" button never recovered. Surfaced by `mobile-parity-audit-may2026.md`
§S0.3 (mobile users hit it most via deep links); reproducible at both desktop
and mobile.

**Root cause (storefront):** `shop-page.js parseURLState()` set `level='codes'`
whenever `category` was present — *even with no brand*. `loadProductCodes()` then
called the chip endpoint, which **requires** a `brand` (it 422s on
`/api/products/series?category=ink`). The terminal catch painted the warming-up
error, and Try-again re-ran the same brand-less call. The chip grid is meaningless
without a brand anyway.

**Fix:** split the level logic — `category && brand → codes` (drilldown),
`category` alone → `brands` (a **brand picker**: heading "Choose a brand to see
ink cartridges", ribbon section hidden). Tile click drills into the chips via
`navigateTo('codes', { brand, category })`. The `'codes'` case in `navigateTo`
now honours an explicitly-passed `data.brand` (`data.brand || this.state.brand`)
— previously it read only `this.state.brand`, which was null at the picker, so
the brand would have been dropped a second time. Verified live: no error, 10
tiles, click → `/shop?brand=hp&category=ink`.

**Rule:** never call a brand-required endpoint (`/api/products/series`, the chip
grid) without a brand. Category-without-brand is a *brand-selection* state, not a
load failure. When adding a `navigateTo` destination that can be reached with a
brand the caller supplies (vs. one already in state), read `data.<field> ||
this.state.<field>`.

**Pinned by:** `tests/mobile-parity-may2026.test.js` (S0.3 group).

**Process gotcha (recorded so I don't chase ghosts again):** running the full
suite via `node --test tests/*.test.js` is **non-deterministic** — ~32 phantom
failures appear and the failing set *changes between runs* because test files
share a single process and pollute globals (`window`/`document`/module state).
The authoritative signal is **per-file**: loop `for f in tests/*.test.js; do
node --test "$f"; done`. Run that way, the whole suite is green. Don't trust a
red from the glob run without confirming it reproduces in isolation.

---

## ERR-033 — Search "magnifier click doesn't navigate" — reported, NOT reproducible (2026-05-21)

**Reported (backend handoff `search-enter-key-may2026.md`, "Magnifier icon click —
companion regression", 2026-05-20):** clicking the magnifying-glass icon does not
navigate to `/search?q=`. Four hypotheses offered (preventDefault-without-nav,
stale `action="/shop"`, disabled flicker, overlay intercept).

**Verified live (Playwright on prod + DOM hit-testing) — the magnifier WORKS in
every scenario:** homepage + `/search` results page, desktop (1280) + mobile (390),
dropdown open + closed, real coordinate clicks. Each hypothesis disproven:
- **H1** false — `main.js` submit handler calls `preventDefault()` **then**
  `window.location.href = `/search?q=${encodeURIComponent(query)}``.
- **H2** false — `/shop` **and** `/search` both rewrite to `/html/shop` in
  `vercel.json`, and `shop-page.js` reads `?q=` to render the search-results level
  regardless of path. Confirmed live: `/shop?q=tn%202350` renders the **identical**
  "Search Results for…" view as `/search?q=tn%202350`. So the old `action="/shop"`
  was never a hard bug.
- **H3** false — `disabled` only no-ops for `q.length < 2` (the documented MIN_LEN
  guard); valid queries enable + submit fine.
- **H4** false — expanded form is `z-index:10`, the dimming overlay `z-index:5`;
  `document.elementFromPoint()` at the magnifier centre returns the button's `<svg>`.

**What was actually missing:** a regression guard. The Enter path was pinned
(`search-enter-key-may2026`), but **nothing** pinned the magnifier-click path — the
exact asymmetry the handoff feared (someone could move navigation onto
`input.keydown` only; Enter keeps working, magnifier silently dies). The magnifier
is a `<button type="submit">`; clicking it fires the form's `submit` event — the
SAME event Enter triggers — so one `searchForm.addEventListener('submit', …)` drives
both affordances.

**Change shipped (defense-in-depth, not a bug fix):** aligned every keyword search
form's `action="/shop"` → `action="/search"` (24 forms across `html/` + the root
`index.html`/`404.html` served copies; the Ink Finder `ink-finder__cartridge-form`
stays `action="/shop"` — it posts brand/printer params, not `q`). Now the no-JS /
pre-hydration native-submit fallback lands on the canonical `/search?q=` too, not
just the JS path. Navbar parity preserved (all forms changed identically → still one
header hash).

**Rule:** the magnifier and Enter must route to the same `/search?q=` URL; keep the
navigation handler on the FORM's `submit` event, never input-keydown-only. Keep the
search form's no-JS fallback honest: `method="GET"` + input `name="q"` + a q-routing
`action` (`/search`).

**Pinned by:** `tests/search-magnifier-click-may2026.test.js` (8 tests).

---

## ERR-032 — Favourited item, but `/account/favourites` shows the empty state (2026-05-21)

**Symptom:** User clicks the heart on a product (POST `/api/user/favourites` →
201, row genuinely stored), then visits `/account/favourites` and sees
"You haven't saved any favourites yet." Backend dev's handoff
(`favourites-bug-frontend-fix-may2026.md`) blamed the storefront: "the page
never calls the API, or calls it without the `Authorization` header."

**That diagnosis was wrong.** Verified live (Playwright + curl with a real JWT):
- The page **does** call `GET /api/user/favourites`, **with** a valid
  `Authorization: Bearer <jwt>` header.
- The endpoint returns **HTTP 500 `{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to fetch favourites"}}`** in **every** state — zero rows, one row, after delete.
- Same token: POST → 201, DELETE → 200, `check/:id` → 200. Only the **list**
  handler 500s. So it's a systemic backend crash, not data- or user-specific.
- The dev verified the DB row + RLS via SQL but never called the live GET — which throws.

**True root cause (backend, separate repo on Render):** `GET /api/user/favourites`
list handler crashes unconditionally. **Frontend cannot fix this** — must be
fixed in the backend repo (likely the products JOIN / row serialization in the
list query; the no-join `check` endpoint works).

**Frontend defect this exposed (FIXED here):** `api.js` resolves a 500 as a
`{ ok:false, code:'INTERNAL_ERROR', status:500, request_id }` envelope (it does
NOT throw on 5xx). The old `Favourites.loadFromServer()` only populated `items`
inside `if (response.ok && response.data)`, hit no catch, left `items` empty,
and `renderFavouritesPage()` showed the empty state. **A backend outage thus
masqueraded as "no favourites" and stayed invisible for a week.**

**Fix (`js/favourites.js`, `js/favourites-page.js`):**
- `loadFromServer` now records `loadError = { message, requestId }` on any
  non-ok response (or throw) — never silently empties the list.
- `renderFavouritesPage` shows a real error+retry pane (with the 8-char
  request-id for Render-log correlation) **before** the `items.length === 0`
  empty-state check.
- Loads de-duped through a shared `_loadPromise`; `ensureLoaded()` short-circuits
  when already loaded; `reload()` backs the "Try again" button.
- `favourites-page.js` is authoritative: `await Favourites.ensureLoaded()` then
  render, instead of racing the global `init()` double-render.

**Rule:** A failed load is **not** an empty list. Any list/detail surface that
fetches user data must distinguish failure (error+retry, surface the request-id)
from a genuine empty result. Never let `api.js`'s resolved `{ ok:false }` 5xx
envelope fall through into an empty/"none found" UI.

**Pinned by:** `tests/favourites-load-error-state.test.js` (9 tests).

---

## ERR-031 — Search dropdown shows bare `<img alt>` text for a tile `/search` renders fine (2026-05-21)

**Symptom:** `/search?q=915xl` (full results page) rendered all six HP 915XL
tiles with photos, but the typeahead dropdown for the same query showed the
bare `<img alt>` text fallback for `HP Genuine 915XLM … Magenta` (and similar
single-row regressions on other queries). Same product row, same backend
`image_url`. Backend proven innocent — identical, reachable URL on both surfaces
(per `search-dropdown-routing.md` "Image rendering parity", 2026-05-20).

**Root cause (storefront, two-part):** `src` and `srcset` both route through
`/api/images/optimize`. When that endpoint transiently fails for ONE tile
(429 / cold-cache timeout / one bad conversion) the optimized URL 4xx/5xx's
while the file itself is fine. The `/search` results grid (`shop-page.js:3145`)
recovered because it carried `data-raw-src` (direct Supabase URL) AND bound an
error handler that retried it. The dropdown did **neither**:
1. `Products.getProductImageHTML` — the shared renderer the dropdown uses —
   emitted no `data-raw-src`.
2. `search.js renderResults` never called `Products.bindImageFallbacks` — it
   was the **only** card surface in the repo that skipped it (shop, filters,
   cart, favourites, landing, checkout, PDP rail, payment all bind it).

**Fix:** unify the fallback strategy across both renderers.
- `products.js getProductImageHTML` now computes `rawImageUrl` via
  `storageUrlRaw()` and appends `data-raw-src` to both the placeholder and
  color-block `<img>` branches (mirrors `shop-page.js`).
- `search.js renderResults` now calls `Products.bindImageFallbacks(state.list)`.

The shared `bindImageFallbacks` handler is the single ladder: error → retry
raw (strip srcset) → placeholder/color-block. Because the fix lives in the
*shared* renderer, every surface using `Products.renderCard` gains the raw
retry, not just the dropdown.

**Rule:** any surface that renders `Products.renderCard` output MUST also call
`Products.bindImageFallbacks(container)` after insertion — otherwise a single
optimize-endpoint hiccup paints alt text with no recovery. Keep `getProductImageHTML`
and the `shop-page.js` results grid in lockstep on `data-raw-src`.

**Pinned by:** `tests/search-dropdown-image-parity.test.js` (15 tests). Routing
half of the same spec is pinned by `tests/search-dropdown-routing.test.js`.

---

## ERR-030 — Sign-in lands on `/account/` → 404 Page Not Found (2026-05-21)

**Symptom:** After signing in on `/account/login`, the browser navigated to
`inkcartridges.co.nz/account/#` and rendered the 404 page. Same for Google OAuth
return and the admin-gate bounce.

**Root cause:** On Vercel (`cleanUrls: true` + the `/account/:path*` rewrite),
the trailing-slash `/account/` resolves to the directory `/html/account/` and
returns **404**. The slash-less `/account` serves `/html/account/index.html` → 200.

```
curl -L https://inkcartridges.co.nz/account/   → 404
curl -L https://inkcartridges.co.nz/account     → 200
curl -L https://inkcartridges.co.nz/account/login → 200   # sub-paths fine
```

Code redirected to the broken trailing-slash form in several places:
- `js/security.js` — `safeRedirect(url, fallback = '/account/')` (post-login default)
- `js/auth.js` — Google OAuth `redirectTo: ${origin}/account/`
- `js/admin/auth.js` ×3 — admin-gate failure bounces
- `html/account/personal-details.html` ×2 — breadcrumb links

**Fix:** Drop the trailing slash everywhere (`/account/` → `/account`, matching the
nav header which already used `/account`). Added a scoped Vercel safety-net redirect
`{ "source": "/account/", "destination": "/account", "permanent": true }` for
bookmarked/external trailing-slash hits.

**Rule:** Internal links/redirects to the account home must be slash-less `/account`;
never `/account/`. Sub-paths (`/account/login`, `/account/orders`, …) are unaffected.

**Pinned by:** `tests/account-trailing-slash-redirect.test.js` (5 tests).

---

## ERR-035 — New public clean-URL route 404s in local dev despite vercel.json (2026-05-22)

**Symptom:** While building the request-based tracking feature, the new public
page `/track-order` returned "Page Not Found" under `npx serve` even though the
file existed at `inkcartridges/html/track-order.html` and the `vercel.json`
rewrite `{ "source": "/track-order", "destination": "/html/track-order" }` was
added.

**Root cause (two parts):**
1. **`serve.json` is a separate rewrite table from `vercel.json`.** Production
   uses `vercel.json`; local `npx serve` uses `inkcartridges/serve.json`. A new
   clean URL needs an entry in **both**. The fix added
   `{ "source": "track-order", "destination": "/html/track-order.html" }` to
   `serve.json` (note: no leading slash on `source`, `.html` on `destination` —
   that's the serve.json convention, distinct from vercel.json's).
2. **`serve` loads its config once at startup.** Editing `serve.json` while the
   server is running has no effect — you must restart the `serve` process.

**Rule:** When adding a customer-facing clean URL, update `vercel.json`
(`/foo` → `/html/foo`) AND `serve.json` (`foo` → `/html/foo.html`), then restart
any running dev server. Pinned indirectly by
`tests/tracking-request-may2026.test.js` (asserts the vercel.json rewrite).

**Note (not an error):** The tracking-request backend endpoints
(`POST /api/orders/track-request`, `GET/POST/PUT /api/admin/tracking-requests…`)
are **not yet implemented** — the frontend ships ahead of them and degrades
gracefully (admin list shows "all caught up", customer submit shows a retry
message). Full backend contract is in `tracking-request-backend-spec.md`.

---

## ERR-036 — Admin Products SKU/Brand columns "too much white space" (2026-05-22)

**Symptom:** On `/admin#products` the SKU and Brand columns showed a short value
(e.g. `G981YC`, an `HP` badge) floating in a wide column with a large empty gap
to the right. Reported as the columns needing to be "compacted."

**Root cause:** The `col-w-*` widths were only *hints*. The DataTable renders
`<table class="admin-table">` which is `width:100%` with the default
`table-layout:auto`. When the visible columns don't fill the container, the
browser distributes the surplus by **stretching every column proportionally** —
and `max-width` on a `<td>` is ignored in that mode (verified live: a 120px SKU
rendered ~140px, a 90px Brand ~105px, ballooning further on wide viewports). The
"white space" was that stretch, not over-generous widths.

**Fix:** Added `.admin-table--colsized { table-layout: fixed }` (opt-in via a
new `DataTable` `config.tableClass`, passed by the products page). Under fixed
layout the `col-w-*` widths are honoured to the pixel; **Name is the sole
`width:auto` column** so it absorbs all surplus (its title text uses the room).
SKU 120→96px, Brand 90→88px, and the brand badge is `white-space:normal` so the
rare long ribbon brand (Fuji Xerox, Triumph-adler) wraps instead of clipping.
Live-verified: SKU exactly 96px / Brand exactly 88px at 1202px AND 1900px
viewports, zero clipping across 100 rows + injected worst-case brand names.

**Rule:** A `width:100%` + `table-layout:auto` table stretches all columns and
ignores per-cell `max-width`. To make `col-w-*` widths real, the table needs
`table-layout:fixed` **and** exactly one `width:auto` column to absorb surplus —
every other column must carry an explicit width (incl. `cell-select` 40px,
`cell-image` 60px). Don't try to fix column slack by shrinking the fixed widths
alone; under auto-layout they'll just stretch again.

**Pinned by:** `tests/admin-products-column-compact.test.js` (9 tests).

## ERR-038 — Tracking-request frontend built ahead of backend; backend shipped a different (simpler) contract (2026-06-05)

**Symptom:** The customer + admin tracking-request UI was built in May 2026
against a *speculative* spec (`tracking-request-backend-spec.md`) before the
backend existed. When the backend dev delivered (`tracking-request-api.md`), the
real endpoints diverged from what the frontend assumed — so the admin "Tracking
Requests" page would have called endpoints that 404.

**Divergences (assumed → actual):**
- Admin list pagination: `data.pagination.total` → **flat `data.total`** (no
  pagination object; `?status=` only, no page/limit/search). The nav badge read
  `data.pagination.total` and would always have shown 0.
- Fulfilment: `POST …/:id/fulfill` (inline carrier+tracking modal) → **no such
  endpoint**. Fulfilment is now **automatic** — setting a tracking number on the
  order via `PUT /api/admin/orders/:id` flips any pending request to `fulfilled`
  and emails the customer. The admin page must *route to the order*, not fulfil
  inline.
- Dismiss: `PUT …/:id {status:'dismissed'}` → **no endpoint, no `dismissed`
  status**. Statuses are only `pending | fulfilled`.
- Request row: flat `carrier`/`tracking_number`/`note` → **nested
  `order:{status,tracking_number,carrier}`**; no `note`.
- Table: `tracking_requests` → **`order_tracking_requests`** (migration 083),
  one-pending-per-order partial unique index.
- Validation code: doc said `VALIDATION_ERROR`; **live backend returns
  `VALIDATION_FAILED`** with a `details[]` array (verified by curl). `api.js`
  already has a `VALIDATION_FAILED` branch that returns a structured envelope
  (doesn't throw), so the customer page reads `response.code` not a thrown error.

**Fix:** Reconciled the frontend to the *verified live* backend:
- `admin/api.js` — `getTrackingRequests({status})` (status-only), count reads
  flat `data.total`; **deleted** `fulfillTrackingRequest`/`dismissTrackingRequest`.
- `admin/pages/tracking-requests.js` — rewritten as a read-and-route surface:
  reads nested `order`, pending rows get "Open order to add tracking" →
  `#orders?focus=<order_number>`; no fulfil modal, no dismiss.
- `admin/pages/orders.js` — new `#orders?focus=<order_number>` deep-link
  (`getHashParam` + `focusOnOrder`) seeds the search and auto-opens the order
  drawer. **Live-verified**: deep-link filtered to the exact order and opened
  its drawer.
- `track-order-page.js` — signed-in users always send a valid email
  (`effectiveEmail` falls back to `Auth.user.email`); friendly `VALIDATION_FAILED`
  copy.
- `sql/tracking_requests.sql` → renamed `sql/order_tracking_requests.sql`,
  schema rewritten to match migration 083. Obsolete `tracking-request-backend-spec.md`
  deleted.

**Rule:** When a backend handoff doc arrives, **verify it against the live API
before trusting it** — both the FE's old spec AND the new doc can be wrong (the
new doc said `VALIDATION_ERROR`; the server says `VALIDATION_FAILED`). curl the
public endpoints; auth + curl the admin ones. Frontend built ahead of a backend
is a *hypothesis*, not a contract — reconcile on delivery.

**Pinned by:** `tests/tracking-request-may2026.test.js` (20 tests, rewritten).

---

## ERR-039 — Dashboard profit miscalculated: (a) GST double-counted in expenses, (b) gross_profit used cost-INCL, (c) COGS smeared by revenue, (d) KPI cost basis ≠ snapshots (2026-06-05)

**Symptom:** User spotted the Revenue & Expenses chart showing **2 Jun expenses
$269.69** when one order that day (Brother TN645CMY, INV-2026-0017) had a
**supplier cost of $350.90 incl-GST** on its own — i.e. the day's *total* expense
bar was *below* a single order's cost, which is impossible.

**Root cause (two layered bugs, both verified live via Playwright + the admin API):**
1. **Per-day shape.** The bulk `GET /api/admin/orders` list **omits
   `supplier_cost_snapshot`** (its line items carry only price/qty; the snapshot
   lives only on the *detail* endpoint `/api/admin/orders/:id`). So
   `bucketCogsFromOrders` resolved $0 cost per order and `buildTrendSeries` fell
   all the way back to smearing the window-total COGS *proportional to revenue*.
   For a low-margin genuine SKU (87.6% cost-to-revenue vs the 46.7% window
   average) that under-booked 2 Jun's COGS to ~$200 → expenses $269.69 to the
   cent.
2. **Headline total.** Reconstructing real cost from the snapshots (40/40 orders)
   gave **~$1,517 incl-GST COGS**, but `analytics_kpi_summary`'s `gross_profit`
   implied **$1,032.50 COGS** — the RPC's cost basis runs **~$480 lower** than
   what was actually paid to suppliers, so profit was overstated.
3. **GST double-count (the bug the user caught on the follow-up).** `trend-math`'s
   expense GST line was `deriveGst(revenue) = revenue × 3/23` = **gross OUTPUT
   GST**, added on top of an **incl-GST** COGS + Stripe. That double-counts the
   input-tax credits already inside the incl-GST cost lines, inflating expenses by
   `(cogs+stripe) × 3/23` and crushing profit toward zero. It violated the project's
   own GST-NEUTRAL rule (profitability.js, 2026-05-17). It also defined gross_profit
   as `rev_ex − cost_INCL` (e.g. Brother 348.25 − 350.90 = **−$2.65**, a negative
   gross profit on a profitable order) instead of the canonical `rev_ex − cost_EX`
   (= +$43.12). This is why 2 Jun's reconciled bar ($426.85) still nearly touched
   its revenue ($428.44).

**Fix (frontend — `pages/dashboard.js` + `utils/trend-math.js`):**
- `enrichOrdersWithSupplierCost` back-fills each in-window order's real cost from
  the detail endpoint and stamps `cost_total_excl_gst` (which `orderCostInclGst`
  reads). Rate-limit-hardened: **concurrency 2** trickle, 3 retries w/ backoff on
  429, capped 200, **sessionStorage** cache (snapshots immutable → fetch once per
  session; warm reloads reconcile instantly, no flash).
- **GST-NEUTRAL expense model** (now matches profitability.js / each order's detail
  modal exactly): `deriveNetGstRemitted(rev, cogs, stripe) = (rev − cogs − stripe) ×
  3/23` is the **NET** GST remitted to IRD (= `computeProfitBreakdown.gstRemittedToIrd`),
  replacing the gross-output GST in `assembleBucketExpense`. `reconciledGrossProfitInclGst`
  now subtracts cost_**EX** (`cogsIncl/1.15`). Net = `revenue − (cogs_incl + opex +
  stripe_incl + gst_net)` collapses to `rev_ex − cost_ex − stripe_ex` = Σ
  `computeOrderProfit`. GST nets to zero.
- `reconcileProfitFromSnapshots` pins both `_reconciledCogsInclGst` (chart COGS, used
  directly) and the canonical `_reconciledGrossProfit`; `resolveKpiCurrent` applies
  the override so Gross Profit, Net Profit, Gross Margin, Trends + the forecast's
  `netMargin` all read the same true figure. `costCoverage` gate ≥ 0.6; honest
  "✓ reconciled" / "provisional" label on the strip.
- **Live result (GST-neutral):** 2 Jun $269.69 → **$378.47** expenses / **+$49.97
  profit** (below revenue $428.44 — the user's complaint resolved); window GST line
  $288.41 gross → **$85.88 net**; Net Profit **$572.55** = `(rev−cogs−stripe)/1.15`;
  Gross Profit **$644.29** = `rev_ex − cost_ex`; Gross Margin **28.7%**. The Brother
  order's detail modal is unchanged at take-home **$32.21**, and the chart now agrees
  with it. Cache token `2026.06.05-gst-neutral-reconcile-4`.

**Rule:** The dashboard P&L is **GST-NEUTRAL** — profitability.js is the single
source of truth (`net = rev_ex − cost_ex − stripe_ex`; the GST you pay supplier +
Stripe is reclaimed). The chart's expense GST line is the **NET remitted**, never
the gross output GST, and COGS being incl-GST means you must NOT also expense the
full output GST. Cross-validate any new P&L surface against `computeProfitBreakdown`.
Separately: the bulk `/orders` list is **not** a cost source (detail endpoint only),
and `analytics_kpi_summary.gross_profit` disagrees with the locked snapshots.

**Durable fix is backend (frontend is a rate-limited best-effort workaround):**
ship `supplier_cost_snapshot` (or `cost_total_excl_gst`) on the `/orders` **list**
response, AND correct `analytics_kpi_summary` to value `gross_profit` from the
snapshots (GST-neutral). Either removes the per-session detail fan-out entirely.

**Pinned by:** `tests/dashboard-trend-math.test.js` (110 tests — `deriveNetGstRemitted`,
canonical `reconciledGrossProfitInclGst`, `extrapolateWindowCogsInclGst`, `costCoverage`,
`residualCogsAfterExact`, and **3 cross-validation tests** that assert the bucket math
equals `profitability.js` `computeOrderProfit`/`computeProfitBreakdown` and the modal's
$32.21 / $4.83 net GST).
