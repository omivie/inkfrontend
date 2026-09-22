# Backend correspondence — status index

Audited **2026-09-09**, re-audited **2026-09-12**. One row per document. `sent/` is evidence-backed; `outbox/` means
*no reply on record*, which is **not** the same as undelivered — see `README.md`.

Do not re-derive this audit. If you deliver something, move the file and change its row.

**THE COUNTS IN THE HEADINGS BELOW GO STALE WITHIN THE HOUR.** Six Claude sessions work this repo at
once and each may file a document, so a number typed here is a snapshot, not a fact. Recount before
quoting one:

```sh
for d in inbox sent outbox; do printf '%-7s %s\n' $d "$(ls backend-docs/$d/*.md | wc -l)"; done
```

Counts last set 2026-09-20. On that date the header read 36 while the directory held 39, and a
scripted edit that assumed 9 rows in one table silently did nothing because a peer had already made
it 10 — ***a count maintained by hand, in a file several sessions write, is a number that goes wrong
between two reads.*** The rows are the record; the totals are a convenience.

**A row records the OUTCOME, not just the location.** Where our document *disputes* the
incoming one it answers, the row says so — an "answered" row that hides a contradiction is
how someone ends up implementing a fix we already measured as a no-op.

**And it records the TENSE.** A row can go stale between being written and being read: the
code a dispute rests on gets fixed, and the dispute — still phrased in the present — outlives
the thing it disputed. A reader who then greps for the broken line finds nothing and concludes
the row was wrong, when it was simply *finished*. So date a claim, or write it in the past
tense and name the fix. This is not hypothetical: it happened to the one dispute recorded
below, within a day of it being filed.

---

## `sent/` — proven received (19)

The backend read these. Evidence is a backend-authored document that postdates ours and
either names it or cites a `BF-`/`ERR-` number that originates in it.

| Doc | Written | Evidence |
|---|---|---|
| `public-volume-pricing-backend-brief-aug2026.md` | 2026-08-08 | named in `public-volume-pricing-backend-response-aug2026.md` |
| `public-volume-pricing-FE-response-aug2026.md` | 2026-08-09 | named in `public-volume-pricing-backend-reply-round2-aug2026.md` |
| `catalogue-pathway-backend-brief-aug2026.md` | 2026-08-30 | named in `search-value-pack-ranking-backend-response-sep2026.md`; ERR-187 in `catalogue-pathway-FE-actions-aug2026.md` |
| `search-value-pack-ranking-backend-brief-sep2026.md` | 2026-09-06 | named + BF-057 in `search-value-pack-ranking-backend-response-sep2026.md` |
| `add-to-cart-tracking-FE-response-sep2026.md` | 2026-09-06 | BF-060 **originates here**; cited in `fe-verification-and-remaining-gaps-sep2026.md` (09-08) and `FE-open-items-checklist-sep2026.md` (09-09) |
| `data-tracking-capture-FE-response-aug2026.md` | 2026-09-01 | ERR-194 cited in both 09-08 and 09-09 incoming docs |
| `gst-basis-backend-brief-jul2026.md` | 2026-07-29 | **moderate only** — ERR-113 in `order-profit-net-of-discount-aug2026.md`; ERR-113 sits in the ambiguous-numbering range, so this is weaker than the six above |

### The 2026-09-09/10 batch — all eight proven received on 2026-09-12

`inbox/fe-verification-round-backend-response-sep2026.md` is the delivery record for
every one of these. It answers them **section by section**, cites their ERR numbers,
and ships code against them. Two of these rows previously read "never delivered";
they were wrong, and this is what that looked like from the inside — *no delivery
record exists ⇒ UNANSWERED, not undelivered.*

| Doc | Written | Evidence |
|---|---|---|
| `BACKEND-ASKS-INDEX-sep2026.md` | 2026-09-09 | its 🔴 item 0 (ERR-232) is answered at length in §1; item 1 (the mig-132 green light) in §2 |
| `printer-canonicals-backend-brief-sep2026.md` | 2026-09-09 | named in §3; our 15-pair table used **verbatim** as their curated map. **Closed 2026-09-20, and our table is 15 again**: they added a 16th pair (`printronix-103.23.`), we adopted it, and on 2026-09-16 they WITHDREW it — neither row was a printer. See `inbox/fe-three-open-asks-backend-response-sep2026.md` §1. *Their 2026-09-10 document still asks for that pair; do not act on it.* |
| `fe-backend-asks-sep2026.md` | 2026-09-09 | §7 answers BF-021; §8 answers the ERR-237 `?sid=` question |
| `analytics-dashboards-FE-response-sep2026.md` | 2026-09-03 | **the "evidence it was NOT read" row is superseded** — §4 concedes the 80-char truncation point and §5 ships all four asks |
| `security-hardening-round2-FE-response-sep2026.md` | 2026-09-09 | §1's ACL table and migration 173 answer it directly |
| `admin-only-test-product-backend-brief-sep2026.md` | 2026-09-09 | answered by `inbox/admin-only-test-product-FE-handoff-sep2026.md` (see ERR-246) |
| `supplier-freight-backend-brief-sep2026.md` | 2026-09-09 | answered by `inbox/supplier-freight-backend-response-sep2026.md` + `inbox/supplier-freight-FE-handoff-sep2026.md`, both 2026-09-10. **All three asks delivered.** Implemented 2026-09-12 (ERR-255); replied in `outbox/supplier-freight-FE-response-sep2026.md`, which **declines their §6** |
| `mobile-ux-and-remaining-gaps-FE-response-sep2026.md` | 2026-09-09 | delivered with the batch; **its dispute stands unaddressed** — see below |

### The 2026-09-20 round — three more proven received

`inbox/fe-three-open-asks-backend-response-sep2026.md` and its companion
`inbox/fe-open-asks-backend-response-sep2026.md` are the delivery record. They answer these
section by section and ship code against them.

| Doc | Written | Evidence |
|---|---|---|
| `fe-backend-asks-action-list-FE-response-sep2026.md` | 2026-09-12 | its "Two asks back" (the Printronix rename and the `/api/site/nav` Cache Rule gap) are §1 and §3 of the incoming doc; its `zzprobe%` ask is §2, **answered and widened to `zz%`** |
| `backend-backlog-verified-sep2026.md` | 2026-09-16 | the incoming doc answers three of its re-measured `BF-` asks by number |
| `fe-verification-round-FE-response-sep2026.md` | 2026-09-12 | **BF-062 originates here**, and `inbox/fe-open-asks-backend-response-sep2026.md` §1 answers it by number — confirming the ask, correcting the route we named, and shipping the fix. Moved by the session that owns that round |
| `fe-verification-results-two-fixes-sep15-2026.md` | 2026-09-15 | **the incoming §4 quotes BOTH of its items by name.** ⚠️ This document had never been in this repo — it sat in a downloads folder, so it was absent from this index, absent from every bundle, and its two items sat open for five days with neither side tracking them. *An outbox document with no reply is not a stale document; a document that was never filed is not a delivered one.* Filed 2026-09-20 |

**Still disputed, and NOT resolved by their reply.** Our mobile-UX response
contradicted two of the three fixes in `inbox/fe-verification-and-remaining-gaps-sep2026.md`.
The verification round does not mention it. The dispute is therefore still open
and the inbox document still must not be implemented as written — the reasoning
is in the note further down this file, in the past tense, naming the code that
replaced it (ERR-235).

---

## 📬 ANSWERED — the 2026-09-10 round came back (2026-09-12)

**The seven "never delivered" documents below were read.** Three backend documents arrived on
2026-09-10 and are now in `inbox/`:

| Incoming | Answers | Our reply |
|---|---|---|
| `fe-backend-asks-action-list-sep2026.md` | the six FE asks, as an action list | `outbox/fe-backend-asks-action-list-FE-response-sep2026.md` |
| `fe-backend-asks-backend-response-sep2026.md` | the full reasoning behind the action list | (same reply — it is one round) |
| `fe-verification-round-backend-response-sep2026.md` | printer canonicals, analytics, ERR-232 | (same reply, plus ERR-247/249) |

**⚠️ THE TWO INCOMING DOCUMENTS CONTRADICT EACH OTHER, AND THE WRONG ONE LOOKS SAFE.**
`fe-verification-round-backend-response-sep2026.md` §6 says *"You can drop your client-side
mapping whenever suits"* for `/api/products/popular`. `fe-backend-asks-action-list-sep2026.md`
§4 says the opposite and is right: `consumable` is now **accepted** and resolves to **no
filter**, so dropping the map puts ink and toner on a drums shelf with a 200 and no error.
Measured 2026-09-12 by reading `product_type` on the returned rows. The action list is the
later document and supersedes. **Do not implement §6 of the verification-round document.**

Three further statements in the incoming round did not survive measurement, and the reply
carries all three with their evidence: the detail read-back path is `data.order.delivery_type`
and not `data.delivery_type`; the search rate limits are per endpoint (30/30/120/120) and not
one 30/min limiter across the prefix; and `delivery_type` being *live* is not it being
*populated* (null on 166 of 167).

---

## `outbox/` — written, no reply on record (1 file on disk; 42 deleted 2026-09-21)

> **🚨 2026-09-21: all 42 `.md` files were deleted from `backend-docs/outbox/` and the deletion was
> committed on the owner's instruction.** It stayed empty until 2026-09-22, when
> `mobile-atc-dead-zone-FE-response-sep2026.md` was filed — so the directory now holds **one** file and
> **41 of the 42 rows below have no document on disk**. Recover any of them from `1ded3f8`, below.
>
> **The rows below are unchanged and remain the record.** None of these documents was answered, filed
> to `sent/`, or withdrawn — the emptying was not an archival move, and 0 of the 42 names appear in
> `sent/`. Every open ask and every BF number recorded below is still open. Do not read the empty
> directory as "nothing outstanding": `outbox/` means *no reply on record*, which is **not** the same
> as undelivered, and it is now also not the same as *no document*.
>
> **Recover any one of them** — the last commit that held all 42 is `1ded3f8`:
>
> ```sh
> git show 1ded3f8:backend-docs/outbox/<filename>            # read one
> git checkout 1ded3f8 -- backend-docs/outbox/               # restore all 42
> ```

### ⏳ Never delivered — written after the last incoming doc (12)

The 2026-09-09/10 batch that used to sit here was **all delivered and answered** —
those eight rows moved to `sent/` on 2026-09-12. What remains is the reply to the
document that proved it, plus the backlog below.

| Doc | Carries |
|---|---|
| `mobile-atc-dead-zone-FE-response-sep2026.md` | **2026-09-22. ANSWERS both mobile-CTA handoffs. THEIR DIAGNOSIS WAS RIGHT AND THE DEFECT WAS WIDER THAN THEIR SWEEP FOUND; three artefacts they cite do not exist in this tree and one of their two asks was already shipped.** The sticky bar retired on `isIntersecting` of `.product-info__actions` at `threshold: 0` — **not the 60% they assumed, and it watched the CONTAINER, not the button**, which on mobile is a two-row grid so its top edge enters ~56px early. **Occlusion turned out to have two edges**: with their banner inset in place a dead window remained at scrollY 1200 with `elementFromPoint` returning `div.logo-block` — `.site-header` is sticky at the *same* `--z-sticky` (200) the bar uses. Before: dead windows **587-785** and **1187-1427**; after: **117 offsets, all tappable**, with our old per-control check green in the same run that found them. **`scripts/verify-mobile-cta-occlusion.js` has never existed in any branch** and its quoted `networkidle` timeout cannot come from here (ours are all `domcontentloaded`, the only two live `networkidle` gotos use 45000ms not 60000ms); `scripts/ads/pause-mobile-until-checkout-fixed.js` is also absent; `--check` was already the only mode, now accepted as a documented alias with unknown flags **refused**. **Their §2 shipped in September as ERR-238 in a better shape** (body class, measured height, no `:has()`, covers three bars). **Two more defects the sweep surfaced**: a hidden bar still ate the tap (0.3s `transform`, and the ERR-238 lift leaves the RESTING hidden bar on screen at y 515-582) — now `pointer-events: none`; and their §1 category blocker was mostly **our own rewards nudge**, covering a card Add button at **32 of 92 offsets on `/ink-cartridges`** while our own probe asserts the nudge must be there — ERR-276's fix was a list of routes, so it decayed to the route nobody listed. The card is now **in flow, not an overlay**, at zero CLS. **Corrects the 826px figure**: it is a scroll-0 reading and splits **410px chrome / 471px card**, so no chrome trim reaches a 664px fold — the two levers that would are commercial and were left with the owner. **Corrects the viewport for BOTH sides**: `devices['iPhone 13'].viewport` is **390x664**, not 390x844; the 180px gap is larger than the consent banner, and **eight of our own probes** had the same error. **ONE ASK BACK, no BF number**: since the UET tag went in, any browser-driven tooling that loads PDPs against production fires `view_item` into a live ad account. FE ref **ERR-280**. **Status: committed, NOT yet deployed** — the ad-group exclusion lifts once they re-run the probe against production themselves |
| `fe-open-asks-verification-sep2026.md` | **2026-09-20. ONE ask, in §4: `GET /api/admin/suppliers` returns `email: null` for every supplier although their §4 describes a `supplier_contacts` join for exactly that field** (measured: 2 suppliers, 2 contact rows, null on both). Everything before it is verification of their 16 Sep reply to our four open asks, and **two corrections to claims in it that we would have built on**: the promised `compatible_devices_html` response echo **does not exist**, so anything relying on it reads every successful write as a silent strip; and *"a re-fetch cannot carry it"* is **false** — `GET /api/admin/products/:id` carries the field, byte-identical to the public `/for-use-in` on 3/3 products with real lists. **BF-062 is closed**: their wrong-route catch was right, verified by `npm run probe:product-write -- --write` (21/0) on a throwaway product the probe creates and deletes. Also confirms their partial-PUT fix and their printer-slug widening, accepts the Printronix withdrawal, and names which of their 13 still-malformed slugs carry live links. Carries **BF-067**. §6 lists what we fixed on OUR side (including a first version of our own editor that could not edit an unpublished product) so the two halves are not conflated |
| `stripe-wallets-FE-response-sep2026.md` | **2026-09-20. ANSWERS their wallets handoff, and DISPUTES its diagnosis while shipping its fix in full.** Their seven CSP entries are in, applied as a verified addition (7 added / 0 removed, diffed directive-by-directive against the header live that day; `vercel.json` was byte-identical to production first, so there was no drift to reconcile). **But the CSP was not what suppressed Apple Pay and Google Pay.** Measured before deploying anything, same browser / same origin / same unfixed policy, one variable changed: production's exact Express Checkout options reported `klarna, link` (`applePay:false, googlePay:false`); adding `paymentMethods:{applePay:'always',googlePay:'always'}` reported `applePay, googlePay, klarna, link`. We passed **no `paymentMethods` option at all**, and Stripe renders Apple Pay on non-Safari desktop and Google Pay on Safari + every iOS browser **only** at `'always'`. Kept permanently as §3b of `probe:stripe-wallets`, so the attribution is reproducible. **Also corrects two claims in their brief**: (1) the row was never dead — `link: true` on the unfixed site, and Link is 46 of their own 173 charges, so a row reported as having "never produced a single payment" was carrying 27% of revenue; (2) their verification step **cannot run** — every wallet log goes through `DebugLog`, hard-gated on localhost, so on production it is a no-op and a tester would read an empty console. Replaced with an opt-in `?wallet-debug=1` channel. **Flags the item with the most money attached, which is not a wallet item**: `frame-src` was missing `https://hooks.stripe.com`, where **3-D Secure challenges render** — any card needing a 3DS step has had nowhere to draw it for as long as the header existed, on the main path, unmeasurable from our side. **NO BACKEND CHANGE REQUESTED. Carries no BF number.** The one question asked, if cheap: how many PaymentIntents since March entered `requires_action` with a 3DS redirect and never reached `succeeded`. FE ref **ERR-268** |
| `mobile-cta-occlusion-FE-response-sep2026.md` | **2026-09-20. ANSWERS their mobile-CTA/SEO/CWV handoff. P0 SHIPPED AND MEASURED; DISPUTES THREE OF ITS SEVEN ASKS, two of which would have shipped as fixes that changed nothing or broke something.** (1) **Their §1.2/§1.3 are already fixed and their own numbers prove it** — they reported the consent banner covering `#sticky-atc`, but `.sticky-atc` carries `transform: translateY(100%)` until `.is-visible`, and with ERR-238's 148px lift applied *and the bar hidden* its box lands at y 516-583, which is what they measured to the pixel; with no lift it would have been off-screen at 664-731. Their run had scrolled the main CTA *into* view, which is exactly when `product-detail-page.js:3127` removes `.is-visible`. **A control that is correctly hidden is not a control that is blocked.** Same artefact explains their "clicking Accept unblocks the button": `releaseSpace()` drops 148px of body padding, the page reflows, and the button slides out from under the NUDGE — a scroll shift, not causality, and it nearly buried the real blocker one row above it in their own table. (2) **The homepage count is 926+, not 930+, it is THEIRS, and it understates** — zero hits for "930" in our tree; `/` as a browser is already count-free, `/` as Googlebot and `…/api/prerender/home` are byte-identical. 926+ against ~3,270 live ink+toner is an under-claim, so it is not the misrepresentation risk described. (3) **§6a points one level below the cause** — reserving `.shop-section-card`'s height cannot work, because under their own throttling DOMContentLoaded lands at ~5s and any JS-applied reservation IS the shift. **P0 fixed**: the rewards nudge is a `fixed` z-600 full-width card below 768px pinned under the header from `scrollY>=600`, and it owns a constant viewport band the in-flow buy button travels through — `blocked -> aside#rewards-nudge` before, `reachable` after, same viewport/SKU/scroll, on real WebKit in 11ms. Gated on all FOUR PDP URL spellings (their suggested regex would have missed three, and been dead on `npx serve`); desktop asserted unchanged; the ask MOVED to a new `cart:item-added` moment rather than deleted. **CLS 0.679/0.674/0.607/0.089 -> 0.007/0.007/0.001/0.001** on their Pixel-5 profile, `/ribbons` being a POOR route missing from their table; two structural causes, neither the one asked for. **Duplicate JSON-LD confirmed and fixed** (7 rendered `ld+json` nodes -> 4; their prerender was always clean, so it only ever affected the rendered DOM). **`G-YJXTSGLM28` removed** on owner confirmation — wire-verified 3 gtag bundles -> 2. **THREE ASKS BACK, no BF number**: own the homepage count (or expose the source figure so we can assert `claimed <= actual`); reverse the ads-side mobile stop-loss the day this deploys; re-measure the 7-day mobile `checkout_started -> completed` rate. §2 and §4 of their doc were done in parallel by other sessions (ERR-270, ERR-269). FE ref **ERR-276**. **Status: committed, NOT yet deployed** |
| `fe-verification-two-fixes-FE-response-sep2026.md` | **2026-09-20. ANSWERS their Sep-15 verification round; both items they found not-live are FIXED, and the doc corrects their diagnosis twice.** (1) Their prescription was `NextResponse.rewrite(...)` — **we are not on Next.js**; `middleware.js` is Vercel Edge Middleware that fetches and returns the body. Shape right, API wrong. (2) **It was not "one line in middleware.js", and a one-line fix would have been undone on Google's render pass**: `js/seo-meta.js` mirrors that routing and `SeoMeta.reconcile()` does an *authoritative parity overwrite* of `<title>`/`<meta description>`, so an edge-only fix serves the crawler the LC73 title and then overwrites it with the generic one. Three files, not one. The same overwrite was already replacing the code-specific title on every HUMAN load of a `?code=` URL — a live defect nobody had reported. **We VERIFIED their safety claim rather than trusting it** (junk code, `<script>`, unknown category and utm all collapse the canonical to `/shop?brand=…`) **and still declined `url.search`**: every distinct URL is its own `s-maxage=3600` edge entry AND its own origin fetch, so tracking params would fragment the CDN and multiply their load for byte-identical content. Forwards `code`+`category` only. **Corrects a measurement a parallel session read backwards**: their brand prerender is **resolution, not precedence** — `?category=toner&code=LC73` and `?category=ink&code=LC73` both serve LC73 and drop the category from the canonical, while `?code=TN2330` **alone** falls back to the BARE BRAND, which is the tell that TN2330 simply is not a code that endpoint resolves. One unresolved sample reads exactly like "category beats code". Records two consequences relied upon: **they collapse the yield suffix themselves** (`LC73XL`→LC73) so we added no edge copy, and the printer/category prerenders ignore `?code=` so those arms forward nothing. Our `shop-page.js` canonical now matches theirs exactly (drops `category` once `code` is set — it differed, which was ERR-242's duplicate-canonical shape from our side). **Fix 2 `/cart?add=SKU:QTY` implemented to spec and verified end-to-end against production** with a guest add (`201`, read back, removed, verified gone); quantity is validated not clamped, duplicates sum then cap, and **partial delivery is stated by name** ("Added 2 of 3 — we couldn't add C73NM.") rather than reported as success. **ONE QUESTION BACK, to avoid shipping dead code**: confirm the exact `?reorder=loaded\|unavailable\|invalid\|guest` vocabulary and the URL that emits it — we implemented all four but could not find the endpoint. **ONE FIX ASKED OF THEM, no BF number**: `POST /api/cart/items` **ignores a client-supplied `X-Guest-Session` and mints its own**, returned in the response header; correct behaviour, undocumented, and it cost us real time — our first probe added a line under an invented id, read an empty cart back, and reported a clean rollback of a line it had never been able to see. FE refs **ERR-269** and **ERR-270**. **Status: committed, NOT yet deployed** — `probe:chip-prerender` is RED against production by design until it ships |
| `duplicate-pack-retirement-FE-response-sep2026.md` | **2026-09-20. ANSWERS their duplicate-pack retirement handoff, and this one we CONFIRM rather than dispute** — every claim in it verified live (17/17 SKUs 301 to the documented survivor; one CMY + one KCMY on `code=81N`; headers exactly as stated so **no purge**; §3's Brother `LC3-Pack` names/slugs already re-derived; no retired SKU hardcoded in shipped JS). **The load-bearing claim was measured in a BROWSER, not curl**: every catalogue GET we make is preflighted (`Content-Type: application/json` on a bodyless GET is not CORS-safelisted), so curl's 301→200 proves nothing about a preflighted cross-origin redirect — measured in-page with a positive control (survivor, `redirected:false`) and a negative one (bogus SKU 404s, does not redirect). **Their §4 warning about name-based dedup found a real defect one layer over from where they pointed**: our `/search` union treated a shared normalized NAME as identity, so two rows with **different known SKUs** collapsed to one card — latent today (0 collisions across 4,066 rows) but the generator has re-minted twins 4×. Fixed with a SKU veto. **Reports that the sidecar argument we used to decline their Sep retirement request is now dead**: both cards it recovered (`CT081KCMY`, `CT073CMY`) are on their list of 17, and scan 7 measures 0 recovered across 7 chips — we kept the fallback (ERR-158) but the number is now printed by `probe:lookalike` instead of asserted in a comment. **Records the owner's merchandising decision on their §5** (all three pairs stay as two cards; none share a series code so they never co-appear in a drilldown) so it stops being re-reported each sweep. **Three items back, no BF number**: `CBCI6KCMY` still does not redirect though the Aug handoff claimed it does (caught only by extending the manifest to all 17) and still renders on `?code=CI6`; `/api/products/:sku/bought-together` 404s on the live PDP and fires **twice**; `/api/admin/catalog/shop?limit=1` 400s. **Re-raises `/api/products/by-slug/` 500ing for every slug** — their `catalogue-500-outage-sep2026.md` §1 item from 09-17, **still live**, now blocking verification of their own §3. FE ref **ERR-277** |
| `three-open-asks-FE-response-sep2026.md` | **2026-09-20. ANSWERS `inbox/fe-three-open-asks-backend-response-sep2026.md`, accepts all three verdicts, and carries a LIVE REGRESSION their own fix appears to have caused.** Their §1/§2/§3 were each re-measured from this repo before anything changed, and all three hold. **§1 Printronix accepted in full** — the entry is out of `PrinterSlug` and the table is back to our original 15; both slugs verified `404 NOT_FOUND` (they were `400 VALIDATION_FAILED` until the companion doc's slug-gate widening) and we checked the thing a 40-link deletion actually risks: 6/6 Epson 103 cartridges keep ≥12 EcoTank printers with 0 Printronix links, so nothing was orphaned. **Their twin-test observation is the keeper**: identical compat-link counts on both sides was TRUE and beside the point — they were twins because both were wrong the same way, which is the one thing that check cannot distinguish from being right. **The five `+` refusals are now VINDICATED by their gate change** — all five serve products (up to 11), so canonicalising them would have deleted five working pages. **🚨 §3.2 carries the reopening of BF-039**: the whole `/api/search/*` family (`smart`, `suggest`, `popular`, `by-part`) is `DYNAMIC` again, measured against `/api/products` MISS→HIT and `/api/site/nav` HIT as controls in the same minute, origin header still `s-maxage=300` — so it is the RULE, not the origin. **Suspect: the 2026-09-17 edit that closed BF-014/BF-019 dropped the `/api/search/` clause from the same expression** (3 endpoints gained caching, 2 lost it, and their write-up re-verified only the 3 they added). Explicitly asks that **BF-064 not be closed as non-reproducible** while search is DYNAMIC. **Corrects their §4**: "nothing has reached us" is true of a BUNDLE and false of delivery — their own §4 quotes both items from a document that had never been in this repo at all. **Discloses one polluter of ours they could never have filtered** (`js/landing.js` searched the literal `ink cartridge` on a page every visitor loads — inert, but unfilterable by their `zz%` rule for the same reason `test` is) and one they still cannot (`TEST-ADMIN-001`, where the SKU *is* the measurement). **Also corrects a measurement of OUR OWN that we nearly sent**: their brand prerender is resolution, not precedence. FE refs **ERR-249 addendum, ERR-254 addendum, ERR-271, ERR-273** |
| `image-audit-restore-legacy-sep2026.md` | 2026-09-17. Was missing from this index entirely until 2026-09-20 — an outbox document nobody had a row for, which is the failure mode this file exists to prevent. FE ref ERR-265 |
| `search-edge-cache-stock-staleness-backend-brief-sep2026.md` | **2026-09-16. A stock write stays invisible to the storefront for up to 15 minutes**, and the surfaces go stale INDEPENDENTLY. Reported to us as a rendering bug — a search card read "Contact Us For Stock Enquiries" while the PDP for the same SKU read "In Stock · Only 1 left" at the same instant. It is neither: all three endpoints return `in_stock:true, stock_quantity:1` and the card evaluates that row to Add to Cart. `s-maxage=300, stale-while-revalidate=600` + `cf-cache-status: HIT` with a live `age` is the whole mechanism, and `/api/products/:sku` vs `/api/search/smart` are separate keys with separate ages. Carries **BF-064** (extend the existing admin price/stock purge to the search keyspace, or `Cache-Tag: product:<sku>` — search keys are unbounded, so purge-by-URL does not scale; explicitly asks NOT to remove the cache, which is what fixed the /shop 504s). **A measured delta against the July brief**, whose `:190-196` recorded `/api/search/smart` as `DYNAMIC` on every request and asked whether the rule was meant to cover it — it now HITs, which is how stock-bearing search payloads came inside the window. Also records the trap that cost us an hour: the **Render origin answers `DYNAMIC` forever**, so measuring it clears the cache of suspicion falsely; only `api.inkcartridges.co.nz` shows the real behaviour. Closes with what we fixed on OUR side (ERR-263) so the two are not conflated later, and confirms the three-endpoint stock-field asymmetry |
| `catalogue-500-outage-sep2026.md` | **2026-09-17. TWO LIVE ISSUES plus the 10-minute catalogue outage they came from.** **§1** `/api/products/by-slug/:slug` **still 500s for every slug — including a nonexistent one, which should 404**, so the handler throws before the lookup; the sibling `/api/products/NOSUCHSKU` 404s correctly as the control. It is the cheapest LIVE reproduction of the outage, and the PDP survives it only via its `/api/products/:sku` fallback. **§2 the origin sends `cache-control: public, s-maxage=300, stale-while-revalidate=600` on 500s and 404s identically to 200s**, so Cloudflare stores and replays the errors (`MISS→HIT→HIT`, same `x-request-id`, measured) — a cached 5xx is served **5 min guaranteed, up to 15**, which is why a ~10-min origin fault became ~25 min of user-visible failure *and kept serving after recovery*. Ask: `no-store` on the error path; the 404 caching is left as their call. **§3** the outage itself — every route in the `/api/products`+`/api/shop` family 500'd including `?limit=1` **with no parameters**, while `/api/search/*`, `/api/brands` and `/api/products/counts` stayed 200; routing and Joi were fine (`?sort=relevance` still 400'd correctly). Carries **BF-065** and four `x-request-id`s. Also asks whether `/api/admin/catalog/*` shares the products handler — the mirror is token-bearing and **never edge-cached**, so a granted admin is the only visitor who cannot ride an origin wobble out on a cached body (a signed-out visitor saw 19 correct cards on `/search?q=273h` while the admin who reported it saw a total failure). Closes with what we fixed on OUR side (ERR-264) so the two are not conflated, and notes that shopper impact in their logs looks like *no-results* events, not error events. **No backend change requested for the frontend half** |
| `catalogue-rate-limit-admin-mirror-sep2026.md` | **2026-09-17. ONE ASK: exempt authenticated staff from the origin rate limiter, or give them their own ceiling.** The measurement behind it: the limiter is **100 requests / 60s, per IP, SHARED ACROSS EVERY ENDPOINT** — a read of `/api/products` decrements the counter for `/api/shop`, same `x-ratelimit-reset` (measured, both directions). A burst of 15 returned **14 x 429**, `retry-after: 27`, body `{"ok":false,"error":{"code":"RATE_LIMITED"}}`. **`/api/admin/catalog/*` is served `private, no-store, no-cache` (`cf-cache-status: DYNAMIC`) while the shopper's `/api/shop` is `s-maxage=300, swr=600`** — so three edge HITs left `x-ratelimit-remaining` pinned at 98 while three forced MISSes walked it 93 -> 92 -> 91. **The budget is therefore spent almost entirely by the visitors the CDN cannot shield: our own staff**, at 3-4 origin reads per code-drilldown page load, so ~25 page views in a minute exhausts it. Picks up the open question BF-065 left about the admin mirror and answers half of it from the client side. Carries **BF-066**. Also flags, without asking for a change, that **a 429 body is `{ok:false,...}` — the same envelope shape as a success** and indistinguishable from a legitimate empty response unless the caller reads `code`, and that `code` is the only reliable discriminator because our `request()` stamps `status` on the 5xx envelope alone. Closes with what we fixed on OUR side (ERR-266) so the two are not conflated. **No backend change requested for the frontend half**, and §5 names what we could not measure rather than dropping it |
| `supplier-freight-FE-response-sep2026.md` | answers BOTH 2026-09-10 supplier-freight documents. **Confirms their whole model** and re-measures it (the `shipping_absorbed` ⊆ `supplier_freight` containment, 115 order-samples, 0 counter-examples). **DECLINES their §6** — the Stripe-fee ÷1.15 reconciles to the cent but proves what the backend does, not what Stripe charges; the owner ruled to check a real payout first, so the ~$0.48/order divergence is documented rather than closed. Carries **two data asks**: one order where THEIR goods cost is the more complete one (ours understates a live column), and one where `goods_cost_ex_gst` is `0` on a populated line — harmless on `always_billed`, a wrong billing decision the day it lands on Augmento. **§8 addendum 2026-09-12** (commit `0e9ab7a`): the two AGGREGATE surfaces — the P&L had no freight row at all, so $502.64 sat between Opex and Net and the table did not foot to its own bottom line — plus a re-run at 60 orders (`58 (0 estimated)`), which found a SECOND instance of the empty-`suppliers[]` case, and one piece of feedback: `supplier_freight` and `supplier_freight_incl_gst` differ by 15% and only by a suffix |
| `ga4-ecommerce-events-FE-response-sep2026.md` | answers `inbox/ga4-ecommerce-events-FE-handoff-sep2026.md`. **All four events shipped** (we took the optional `add_shipping_info`), no browser `purchase`. **DISPUTES three of their numbers, with measurements**: their `add_to_cart` "value = line total" is BF-060/ERR-223 verbatim ($290.97 for one $96.99 cartridge) so it sends price x `quantity_added`; `item_category: product_type` is **not obtainable** at the add-to-cart site (0 of 9 callers pass it, no cart line stores it) so the dimension is omitted rather than guessed, and `brand` is dropped when it would be the literal `'Unknown'`; and `begin_checkout` value is the GOODS subtotal, because `getTotal()` at that moment carries the ERR-235 urban shipping guess. **Their `USE_ID_HEADERS` ask was already live five days before they wrote it** — pinned true by a test, and confirmed by their own 09-12 doc, so their two documents disagree about the same flag. Carries **three asks back**: what `G-YJXTSGLM28` is (configured in `gtag.js`, referenced nowhere else in the repo, deliberately sent nothing); whether `GET /api/cart` can return `items: []` **alongside a summary** for a session that has a cart — we hit that state and it made a real hit report `value=0`. **First written up as a localhost artefact and production disproved that within the hour**: the predictor is whether the add was server-confirmed, not the host. It also surfaced a cart-loading defect we are reporting rather than fixing here — after a refused add the checkout page adopts the empty server cart with `pricingState:'ok'` and shows the shopper an **empty cart**, because `cart.js`'s keep-local-items guard was missing from `loadFromServer()` — **corrected 2026-09-16**: four of the five `_parseServerCart` sites were already guarded and exactly one read path was not, and the mechanism is a LOOP through the ERR-210 revalidation rather than a plain missing guard. **Fixed under ERR-259**, and the doc carries an addendum saying so. The production probe re-run is now 34/0/0 with nothing unexercised); and whether they will add `product_type` to the add-to-cart response's `product` object, which is the one-field fix for the gap above |

**Read this before touching `/api/products/popular` mappings.** Their §6 invites us
to drop the client-side category map. `consumable` means **"Drums & Supplies"** to
us and **"all consumable types"** to them; taking the invitation swaps the shelf
contents with a 200 and no error anywhere. Measured 2026-09-12. The map stays.

**Disputed, and still unresolved as of 2026-09-12** — `sent/mobile-ux-and-remaining-gaps-FE-response-sep2026.md`
contradicted two of the three fixes `inbox/fe-verification-and-remaining-gaps-sep2026.md`
proposes. It was delivered with the 09-09/10 batch and the backend's verification round
does not mention it, so the dispute stands. Do not implement that inbox document as written:

- Its `<input value="urban" checked>` **would have been a no-op when it was written** — at that
  point `init()` un-checked every `delivery_type` radio on load (`forEach(r => r.checked = false)`),
  to defeat autofill, so the attribute was true in the file and false in the browser. **A source
  grep would have certified it as shipped.** Fixed since, by ERR-235, and not by adding the
  attribute: `_normaliseDeliveryType()` (`checkout-page.js:778`) sets the default in the one place
  that also owns the clearing. Grepping for `r.checked = false` today finds nothing — *that is the
  fix, not a contradiction*.
- Its stated failure mechanism **does not exist**: the checkout form carries `novalidate`
  (`checkout.html:97`) and `reportValidity()` is called nowhere in `checkout-page.js`, so there is
  no HTML5 validation bubble to be rendered off-screen. The observation ("nothing visibly happens")
  is right, the cause is not — a custom gate runs instead, and it is visible.

Verified in this repo on 2026-09-09 and re-verified 2026-09-10, not taken from the response
document. The response document was itself re-tensed in `e9d1ddc` after the first of these two
claims went stale between its writing and its filing — it now carries the past tense and points
at the code that exists.

### No reply on record (29)

Available to the backend in this repo; nothing on record says they read it. **Every one of
these still held at least one open ask when audited** — verified against live code for the
three oldest, spot-checked for the rest.

| Doc | Written | Note |
|---|---|---|
| `orders-supplier-origin-backend-brief.md` | 2026-07-24 | **still live**: `suppliers[]` shipped, `origin` did not — `sourcing.js:18` still renders the em-dash fallback |
| `page-copy-editor-backend-brief.md` | 2026-07-27 | **still live**: endpoint 404s; `page-copy.js:926` still shows "Publishing is not available" |
| `catalog-edge-caching-backend-brief-jul2026.md` | 2026-07-28 | **still live**: BF-011…BF-020, none marked resolved |
| `related-products-backend-brief-jul2026.md` | 2026-07-30 | BF-027, BF-028 |
| `order-hard-purge-contract-jul2026.md` | 2026-07-30 | BF-010 resolved; **BF-024 still open** |
| `ribbon-compat-search-FE-response-jul2026.md` | 2026-07-30 | BF-019 |
| `business-account-volume-pricing-FE-response-jul2026.md` | 2026-07-31 | |
| `business-centre-FE-response-aug2026.md` | 2026-08-03 | §1 declared blocked on the backend |
| `tri-colour-catalogue-BACKEND-tasks-aug2026.md` | 2026-08-03 | §3 is eleven data defects addressed to the backend CLI agent |
| `ribbon-typeahead-FE-response-aug2026.md` | 2026-08-04 | BF-031 + three July asks |
| `business-one-click-upgrade-FE-response-aug2026.md` | 2026-08-09 | **BF-021** — `PATCH` missing from CORS, re-raised ever since |
| `public-volume-pricing-FE-response-round2-aug2026.md` | 2026-08-12 | BF-014, BF-019, BF-039, BF-040 |
| `maintenance-box-FE-response-aug2026.md` | 2026-08-14 | BF-041, BF-042 |
| `invoice-quote-shipping-volume-discount-FE-response-aug2026.md` | 2026-08-17 | BF-043 |
| `order-profit-net-of-discount-FE-response-aug2026.md` | 2026-08-17 | BF-044 |
| `catalogue-pathway-FE-response-aug2026.md` | 2026-08-31 | asks for `catalogue-pathway-backend-response-aug2026.md`, never delivered |
| `supplier-price-comparison-FE-response-aug2026.md` | 2026-08-31 | §5 blocks a feature the backend asked for |
| `lookalike-duplicate-rows-FE-response-sep2026.md` | 2026-09-01 | |
| `order-number-format-change-FE-response-sep2026.md` | 2026-09-01 | |
| `ribbon-brand-pages-FE-response-aug2026.md` | 2026-09-01 | |
| `orders-invoice-sent-column-FE-response-sep2026.md` | 2026-09-01 | |
| `shipping-information-FE-response-sep2026.md` | 2026-09-01 | |
| `security-hardening-FE-response-sep2026.md` | 2026-09-03 | |
| `orders-tracking-requested-column-FE-response-sep2026.md` | 2026-09-09 | pinned by `tests/orders-tracking-requested-column-sep2026.test.js` |
| `admin-products-fallback-FE-response-sep2026.md` | 2026-09-06 | BF-044 phase 2 |
| `business-account-contract-pricing-FE-response-sep2026.md` | 2026-09-06 | |
| `lexmark-chip-grouping-FE-response-sep2026.md` | 2026-09-06 | |
| `order-pathway-3-step-backend-brief-sep2026.md` | 2026-09-06 | ERR-213 — the stepper labels live on the backend |
| `search-value-pack-ranking-FE-response-sep2026.md` | 2026-09-07 | answers their response; one action declined with the measurement |

---

## `inbox/` — from the backend (15)

| Doc | Note |
|---|---|
| `mobile-atc-dead-zone-FE-handoff-sep2026.md` | **2026-09-21. The best-diagnosed handoff we have had: its scroll sweep is what made this findable at all**, and sampling across offsets rather than at one is now how `probe:mobile-cta` works. Its mechanism is correct; two details are not — the visibility test was `threshold: 0`, not 0.6, and it watched the container rather than the button, so the dead zone was wider than its table. Its `--check` command names a file that has never existed here. Answered by `outbox/mobile-atc-dead-zone-FE-response-sep2026.md`. FE ref **ERR-280** |
| `mobile-cta-occlusion-followup-sep2026.md` | 2026-09-21. Follow-up to the ERR-276 round. **Its §2 was already fixed** (ERR-238, and in a better shape than the `:has()` rule it asks for). **Its §1 is real but misattributed** — the larger blocker on `/ink-cartridges` was our own rewards nudge, not the consent banner. **Its 826px figure is a scroll-0 reading and is mostly card, not chrome.** Its report that our verification script always fails names a script that does not exist in this repo. Answered by the same outbox document |
| `stripe-wallets-not-rendering-FE-handoff-sep2026.md` | 2026-09. Apple Pay / Google Pay had taken 0 of 173 live charges. **Its Stripe-side verification is sound and saved us a day** — `payment_method_domains`, the PMC, and the `Permissions-Policy` reading all check out, and we re-verified the last of those independently. **Its diagnosis is wrong and its verification step cannot run** — see the outbox reply before acting on any of it. Its CSP header is correct and is shipped |
| `order-profit-net-of-discount-aug2026.md` | backend-authored (`**From:** backend`), was sitting at the repo root; **byte-identical** to the `~/Downloads` copy |
| `fe-verification-and-remaining-gaps-sep2026.md` | 2026-09-08. **Two of its three fixes are disputed** — see the outbox note above before implementing any of it |
| `FE-open-items-checklist-sep2026.md` | 2026-09-09. Answered by `outbox/printer-canonicals-backend-brief-sep2026.md`; four of its nine items were already shipped when it was written |
| `admin-only-test-product-FE-handoff-sep2026.md` | 2026-09-09. Answers `outbox/admin-only-test-product-backend-brief-sep2026.md`. A **design reply, not a delivery** — nothing in it had shipped when it was filed, verified 2026-09-12. Answered by `outbox/admin-only-test-product-FE-response-sep2026.md`; **its §2 recommendation was declined on a measurement** |
| `security-hardening-sep2026-round2-FE-handoff.md` | 2026-09-08. Answered by `sent/security-hardening-round2-FE-response-sep2026.md`. **This is the document that proves the backend dev can read this repo** — it cites `tests/security-hardening-sep2026.test.js:234` |
| `fe-verification-round-backend-response-sep2026.md` | 2026-09-10. **The delivery record for the whole 09-09/10 batch** — answers eight of our documents section by section. Ships their §1–§7; holds the `authenticated` grant (migration 172) and asks us never to apply it. Answered by `outbox/fe-verification-round-FE-response-sep2026.md`. Six of its seven sections were verified against production and hold; the two corrections are recorded there | **⚠️ ITS §3 ASK IS WITHDRAWN.** It asks us to add the Printronix pair to `PrinterSlug`; the backend retired both rows on 2026-09-16 (neither was a printer — `103.23` is the part number of their own ribbon) and withdrew the request. The entry is out and the table is back to 15. The trailing-full-stop RULE stays and is separately pinned — only the instance is gone. ERR-249 addendum.
| `fe-backend-asks-action-list-sep2026.md` | 2026-09-10. The six FE asks returned as an action list. Answered by `outbox/fe-backend-asks-action-list-FE-response-sep2026.md` — all six done, **three of their statements disputed with measurements** |
| `fe-backend-asks-backend-response-sep2026.md` | 2026-09-10. The reasoning behind the action list above; one round, one reply. **Its §6 invitation to drop our `/api/products/popular` category map must not be taken** — `consumable` means "Drums & Supplies" to us and "all consumable types" to them, so accepting it swaps the shelf contents with a 200 and no error |
| `supplier-freight-FE-handoff-sep2026.md` | 2026-09-10. The wiring checklist for `supplier_freight`. **Its §1 is the load-bearing part** — delete the FE estimator BEFORE reading the new field, because running both double-charges. Implemented 2026-09-12 (ERR-255). **Its §6 was declined**; everything else shipped |
| `supplier-freight-backend-response-sep2026.md` | 2026-09-10. The reasoning and measurements behind the checklist above, and the delivery record for `sent/supplier-freight-backend-brief-sep2026.md`. **Every measurable claim in it was re-verified against the live API and held** — the `delivery_type_basis` and `supplier_basis` spreads reproduce exactly. Two corrections are in our reply: its §2 envelope sample shows the wrong `supplier_basis` for `2026090902`, and its §6 reconciliation proves what the BACKEND does, not what Stripe charges |

| `fe-three-open-asks-backend-response-sep2026.md` | 2026-09-16/17. The three open asks answered. **Two done on their side, one REFUSED and closed a different way** — the Printronix `slug_redirects` rename is withdrawn because neither row was a printer. Answered by `outbox/three-open-asks-FE-response-sep2026.md`; all three verdicts accepted, and §3's own fix appears to have regressed `/api/search/*` (BF-039 reopened). Its §4 claim that "nothing has reached us" is about a BUNDLE, not about delivery — the same §4 quotes a document of ours by name |
| `fe-open-asks-backend-response-sep2026.md` | 2026-09-16. The companion round, answering all four open asks from `sent/fe-verification-round-FE-response-sep2026.md`: BF-062, partial-PUT defaulting, the printer slug gate, the empty `suppliers` table. **Three were real and are fixed; one was already true.** Its most useful content is a correction — **BF-062 was misattributed to the wrong route**: by-id had written the machine list since 6 Aug, while `by-sku` was stripping 27 of 30 fields through `stripUnknown`. **Its §3 is the authoritative account of the printer slug gate**: it now admits `.` and `+`, unblocking 20 of 33 active printer rows that had been 400ing — including the five `+` pairs we refused to canonicalise, vindicating that refusal. Verified end to end (ERR-272), and **two of its own claims are wrong**: the response echo it describes does not exist, and a re-fetch CAN carry the machine list. Answered by `outbox/fe-open-asks-verification-sep2026.md` |

The historical inbox is `readfirst/` at the repo root — frozen, test-pinned, not moved.

---

## Deliberately left at the repo root

| File | Why |
|---|---|
| `errors.md` | pinned by `tests/err-numbering-jul2026.test.js:38` |
| `ADMIN_CENTRE_AUDIT.md` | internal documentation, not correspondence |
