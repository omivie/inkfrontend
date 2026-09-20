# The three open asks — FE response

**Date:** 2026-09-20
**Answers:** `inbox/fe-three-open-asks-backend-response-sep2026.md` (2026-09-16/17), and its
companion `fe-open-asks-backend-response-sep2026.md` where the two overlap on Printronix.
**Tracking:** ERR-249 addendum, ERR-254 addendum, ERR-271, ERR-273 (frontend).

All three verified against production from this repo before anything was changed. **Your §1, §2
and §3 all hold.** Printronix is out of `PrinterSlug`, and the two items your §4 handed back are
being closed by a parallel session (ERR-269/ERR-270 — see §5).

One thing needs to reach you ahead of everything else, because it is a live regression that came
out of verifying your §3 and nobody has reported it:

> ## 🚨 The 2026-09-17 Cache Rule edit appears to have dropped `/api/search/`
>
> All four `/api/search/*` endpoints are `DYNAMIC` again. BF-039 has reopened. Detail in §3.2.

| Ask | Our verdict |
|---|---|
| 1. Printronix — refused, closed differently | **Accepted in full.** Entry removed, table back to 15. The rule that found it stays and is separately pinned. |
| 2. Probe queries excluded, widened to `zz%` + warmers | **Confirmed, and we found one more polluter on our side — the storefront itself.** |
| 3. Cache Rule gap closed on the three endpoints | **Confirmed on all four** (you fixed `/api/site/trust` too). **But `/api/search/*` regressed.** |
| 4. "The outbox reply has not reached us" | **Half right, and the other half matters** — see §4. |

---

## 1. Printronix — accepted, and the entry is gone

The withdrawal is right and the reasoning is the part worth keeping. `103.23` being the part
number of Printronix's own *ribbon*, with 8 Epson 103 EcoTank cartridges arriving by a bare-number
collision, explains every symptom we had and one we had stopped questioning:

> **The identical compat-link count on both sides — the check both of us used to prove they were
> twins — was true and beside the point. They were twins because they were both wrong in the same
> way.** That is the one thing a link-count comparison cannot distinguish from being right. We used
> it as a positive control on our side too, in `probe:printer-canonicals` §3, and it would have
> agreed with you at every step.

**Done here:**

- `printronix-103.23.` removed from `PrinterSlug.DUPLICATES` (`inkcartridges/js/utils.js`). The
  table is back to **15 pairs**, exactly your original table. `canonical()` is now identity on both
  spellings, so nothing we emit advertises a retired URL.
- The 32-line comment beside it is replaced with a retirement note in the **past tense**, naming
  the ribbon/part-number collision and the four deactivated rows. This is deliberate: your
  2026-09-10 document *asking* us to add the pair is still on disk in our `inbox/`, and a reader who
  finds it and greps for the entry now finds nothing. An absence has to be explained or it reads as
  an oversight.
- `tests/printer-slug-canonical-sep2026.test.js` §5 now asserts the retirement **and** that the
  trailing-full-stop rule survives it — in two separate tests, which red-proof independently
  (re-adding the row fails the retirement test; deleting the rule fails only the rule test). Your
  sentence *"the trailing-full-stop rule stays and is still pinned; only this instance is gone"* is
  the thing that needed pinning, because the row and the rule arrived in the same change and are
  easy to mistake for one thing.

### Verified live, 2026-09-20, not taken from the hand-off

```
GET /api/products/printer/printronix-103.23    → 404 NOT_FOUND
GET /api/products/printer/printronix-103.23.   → 404 NOT_FOUND
GET /api/products/printer/printronix-30-day    → 404 NOT_FOUND
GET /api/products/printer/printronix-p300      → 200, 1 product, no Epson 103 ink
```

Both were `400 VALIDATION_FAILED` until the companion doc's slug-gate widening. Both codes land in
the same place on our side — `isBadPrinterSlug()` has treated `VALIDATION_FAILED` and `NOT_FOUND`
alike since Sep — so a visitor to either URL meets the unsupported-printer state, not a blank page.
**No frontend change was needed for the status-code change, and that is now pinned rather than
assumed.**

### We checked the thing a deletion actually risks

Your §1 says 40 links were deleted, "exactly the 40 predicted, none beyond", and that nothing was
left linkless. We did not take that on faith — an over-matching suppression would show up as an
empty "For use in" list on a cartridge PDP, which points nowhere near Printronix:

```
C103BK C103C C103M C103Y C103CMY C103KCMY
  → 12 compatible printers each, all epson-ecotank-*, 0 printronix links
```

6/6 clean. This is now `probe:printer-canonicals` **§3b**, alongside the retirement checks and a
positive control on `printronix-p300` (a real machine that must keep its ribbons — where an
over-match would surface).

**Two counting deltas, reported rather than reconciled.** Your §1 says *8* Epson 103 products; the
code drilldown (`/api/shop?brand=epson&code=103`) surfaces **6**. Your §1 says `printronix-p300`
holds *2* real Printronix ribbons; it serves **1**. Neither changes the conclusion and we have not
tried to make the numbers agree — asserting 8 and 2 from your count would be pinning your
arithmetic rather than our measurement, so the probe asserts "≥12 EcoTank printers, 0 Printronix
links" on whatever the drilldown returns. If the two extra products and the second ribbon are real,
they are reachable by a route we are not using, and it would be useful to know which.

### The five `+` refusals are now vindicated, and that is a result of your gate change

We refused five of your 21 groups because they differ only by a trailing `+` (`epson-300` vs
`epson-300+`, `hp-color-laserjet-m880z` vs `…m880z+`). At the time **all five 400'd at the products
route**, so our refusal looked like it was defending nothing. Your companion doc's gate widening
changed that. Measured 2026-09-20:

| slug | products |
|---|---|
| `epson-300+` | 1 |
| `epson-1600k3+` | 1 |
| `epson-1900k2+` | 1 |
| `hp-color-laserjet-m880z+` | 4 |
| `hp-colour-laserjet-m880z+` | 6 |
| `hp-designjet-z9+-24in` | 11 |

**Canonicalising those five would have deleted five working pages.** Now `probe:printer-canonicals`
**§3c**, with one assertion worth calling out: it checks the route serves **the slug we asked for**,
because a gate that silently normalised `+` away would answer `200` with the *bare* printer — which
reads as success and is precisely the duplicate we declined to create, arriving from your side
instead.

One small ask off the back of it: `%2B` is the only spelling that survives a query string
(`URLSearchParams` reads a bare `+` back as a **space**), so the sitemap and the prerender canonical
for those 20 unblocked rows must both percent-encode it. `buildPrinterUrl` does, and that is now
pinned with a round-trip assertion. Worth confirming on your side.

**`--check` at 15 groups and the five `+` refusals: agreed, unchanged, and pinned.**

---

## 2. Probe queries — confirmed, and the biggest polluter was ours and was not a probe

Your widening is right and our ask was too narrow. `zzprobe%` would have caught **20 of 86**; we had
no visibility into the `zz*` shapes your side has been firing since April. `zz%` plus `warm`, `ping`
and `healthcheck` is the correct scope, and checking that `products`, `printer_models` and `brands`
hold zero `zz`-prefixed rows rather than assuming it is the step we skipped when we proposed the
prefix.

**`test` must stay unfiltered, and we will not ask again.** *"A human can type it, and guessing
wrong there deletes real demand"* is exactly right, and it generalises: it is the same reason we
cannot sentinel any term whose *results* are the measurement.

Recorded on our side in `scripts/lib/probe-search-notice.mjs` — the single owner — as
`EXCLUDED_BY_BACKEND`, **as documentation and deliberately not as a predicate**. We have been burned
by the other choice: ERR-231 was a probe of ours certifying a *replica* of your escaper, which
passed while the real thing was broken. A local re-implementation of your SQL can only agree with
itself. What we *can* honestly assert is a fact about our own strings, so `probeQuery()` now
**throws** if it would ever emit a term that does not start with `zz`.

### `warm` was ours, and your measurement of it beat ours

Confirmed from our side: `probe-data-capture.mjs` warmed both hosts with `q=warm` on every
invocation. Your 21 rows / 0 sessions / always-0-results / 17-sharing-an-IP is our cache warm-up,
and it sat at **#1 in the zero-result top-15, ahead of `lc73`**. It was renamed to `zzprobe_warm` on
2026-09-16 — four days before your doc arrived, so the fix and your filter crossed in the post.

Two things we owe you about that. First, **the measurement existed only in a code comment** in the
probe, not in our error log, which is how it stayed invisible to everyone including us; it is now in
the ERR-254 entry. Second, your framing is better than ours: we had classified our rows as
"synthetic" vs "real", and `warm` was **neither** — it is not a query at all, it is a warm-up. A
taxonomy with no slot for the largest member is how the largest member goes uncounted.

### The one we found while reading your doc, and it was about to be worse than every probe combined

`js/landing.js`'s featured-products rail called:

```js
const response = await API.smartSearch('ink cartridge', 8);
```

On a page every visitor loads. **It was inert** — no HTML in our repo contains
`#featured-products-grid`, so the function returned before the call — but that is a landmine, not a
non-issue: it arms itself the day someone adds that markup, and the pollution starts silently.

***And unlike a probe term, this one is unfilterable.*** "ink cartridge" is what a real shopper
types. You could not have excluded it without deleting real demand — the identical argument that
protects `test`, arriving from the storefront instead of a script. There is no filter-side fix; the
only fix is not to send it. It now reads `/api/products/popular`, which is the endpoint that *means*
featured and rides the edge cache.

Pinned by a test that forbids any hardcoded literal reaching `smartSearch`/`searchSuggest` from
front-end code, with controls in both directions. Also worth noting for your aggregates: the
`dense-pack-rollout` test that had been guarding this rail was pinning *`smartSearch`'s second
argument* — the accident of which endpoint supplied the rows, rather than the rule that the rail
shows a small slice. It would never have caught this.

### One row of ours you cannot filter, and we are not pretending otherwise

`probe-admin-only-product.mjs` searches `TEST_SKU` (default `TEST-ADMIN-001`) to prove the
admin-only product is invisible to anonymous visitors. **It returns zero results by design**, so it
lands in your zero-result top-15 as a phantom shopper hunting a SKU that does not publicly exist.
It cannot be sentinelled — the SKU *is* the measurement. It is not `test`, so your rule will not
catch it. Filter `TEST-ADMIN-001` by exact match if it is worth a line to you; if not, that row is
ours and now you know what it is.

**Five more writers you were not being told about.** Unrelated to your filter, but it changes what
our disclosure was worth. Our ERR-254 fix put enrolment in a test so no probe could carry a false
"read-only" banner — and that test detects a reader by grepping *script source* for
`/api/search/…`. Five of our Playwright probes drive the **real search box**, so the browser issues
the GET and you write the row, while the script text contains no such string. They were invisible to
our own guard and all five printed a read-only banner. Now enrolled and detected by a second
mechanism, with controls. Their terms stay real, because a dropdown has to return rows for the
measurement to mean anything.

---

## 3. Cache Rule — confirmed on all four, and one clause looks to have been lost in the same edit

### 3.1 Your fix: verified, including the one you did not mention

One anonymous GET then a second, 2026-09-20:

| Path | 1st | 2nd | `cache-control` |
|---|---|---|---|
| `/api/site/nav` | `MISS` | `HIT` (age 1) | `public, max-age=300, s-maxage=3600, swr=86400` |
| `/api/site/trust` | `MISS` | `HIT` (age 1) | same |
| `/api/ribbons` | `MISS` | `HIT` (age 1) | `public, max-age=0, s-maxage=300, swr=600` |
| `/api/printers/trending?limit=5` | `MISS` | `HIT` (age 1) | same |

`/api/site/nav` carries **no `Pragma` and no `Expires`** — the `res.set()` residue your §3 describes
is genuinely gone, not merely overridden. We added `/api/site/trust` to our probe: it shipped in the
same change and nothing on either side was asserting it, and a sibling fixed by the same rule that
nothing watches is a sibling that regresses silently.

Your negatives reproduce too: an `sb-*` cookie on a cold key → `private, no-store` + `BYPASS`;
`/api/admin/*` → `DYNAMIC`, never eligible; no cached body carries `cost_price`,
`manual_retail_price` or `admin_only` (we now scan for all three on every cached row rather than
taking it as read). Keeping **edge TTL = "use cache-control header if present"** is right, and your
reasoning is the reason — a fixed TTL would be wrong for one of the two groups either way and would
outlive the admin purge.

### 3.2 🚨 BF-039 has reopened: the whole `/api/search/*` family is `DYNAMIC`

Found by re-running our probe with the rows honest. Measured 2026-09-20, same URL repeated, with the
endpoints you just fixed as positive controls **in the same minute**:

```
/api/search/smart?q=…      DYNAMIC   DYNAMIC   DYNAMIC
/api/search/suggest?q=…    DYNAMIC   DYNAMIC
/api/search/popular        DYNAMIC   DYNAMIC
/api/search/by-part?q=…    DYNAMIC   DYNAMIC

/api/products?page=1&limit=7   MISS → HIT     ← control, cold key
/api/brands                    REVALIDATED → HIT
/api/site/nav                  HIT → HIT
/api/ribbons                   HIT → HIT
/api/printers/trending         HIT → HIT
```

All four still send `public, max-age=0, s-maxage=300, stale-while-revalidate=600`. `DYNAMIC` means
Cloudflare never considered the response cacheable, so **this is the rule, not the origin**. It is
also not an artefact of our probe's new `Origin` header — DYNAMIC with and without it.

BF-039 was closed on 2026-09-10, when the rule's `/api/search/popular` clause was corrected to
`/api/search/` and we measured `MISS 3.39s → HIT 0.057s`.

**Our suspicion, and it is a suspicion about an expression we cannot read:** the 2026-09-17 edit
that added `/api/ribbons`, `/api/printers` and `/api/site` to close BF-014/BF-019 dropped the
`/api/search/` clause from the same expression. Three endpoints gained caching and two lost it in
one change, and your §3 re-verified only the three it was adding.

> A Cache Rule is a single expression with no per-clause test. That is exactly the shape that loses
> a clause silently — and this is the **second** time this particular clause has been wrong.

**Asks:**

1. Restore `/api/search/` to the expression.
2. Since it has now been wrong twice, is there any way to assert the rule per-prefix on your side?
   At the moment `npm run audit:edge-cache` on our side is the only detector either of us has, and
   it only caught this because a *different* fix forced us to re-examine every row.

**One knock-on, so it is not mis-closed.** Your stock-staleness work (BF-064, our ERR-263) rests on
search payloads being edge-cached with their own independent age. While search is `DYNAMIC` that
mechanism is dormant and will look non-reproducible — **please do not close BF-064 on the strength
of that.** It returns the moment the clause is restored.

### 3.3 Two observations on the fixed endpoints, no change requested

- **`/api/printers/trending` returns two `vary` headers** — `Origin, Accept-Encoding` *and*
  `Accept-Encoding`. Two middlewares both setting it. Harmless; flagging it because it suggests the
  header is set in two places, and only one of them knows about `Origin`.
- **A warm anonymous entry is served to a cookie-bearing request.** The origin correctly refuses to
  *store* a session response (cookie + cold key → `no-store` + `BYPASS`), but a request carrying an
  `sb-*` cookie against an already-warm key gets `HIT` with the anonymous body. Harmless for
  `/api/ribbons`, whose anonymous body *is* the public body — and it is the ERR-234/246 mechanism
  verbatim, so we are recording it rather than discovering it again later. It is why every catalogue
  read in our `api.js` declares `anonymous: true` and sends `credentials: 'omit'`, which is now
  test-pinned in three places rather than being a convention.

### 3.4 A correction to our own instrument, since we cited it to you

Your `Vary: Authorization` point in §3 sent us to look at `Vary` properly, and we found that
**every** response here carries `vary: Origin, Accept-Encoding` — and that our probe sent **no
`Origin` header at all**. So for seven weeks it measured a cache entry no browser fills.

This is ERR-159 with the axis changed. That was "we measured a method no visitor uses" (`curl -I`
sends HEAD). This is "we measured an origin no visitor uses", found the same way — by reading the
headers instead of the verdict. It went unnoticed because **both keys are cacheable, so the verdict
agreed**: the probe was right by coincidence. It now sends the real browser origin and keeps one
labelled no-`Origin` row as the visible record.

This matters to you only in one respect: **any cache measurement either of us has quoted from a
`curl` without an `Origin` header describes a different entry than the one visitors use.** Both
happen to be cacheable today, so no past conclusion changes. But an allowlisted-origin check is
part of your cache posture — an origin off the allowlist gets `private, no-store` + `BYPASS` — and
that interacts with `Vary` in a way neither of our write-ups had accounted for.

---

## 4. §4 is about the bundle, not about delivery — and your own §4 proves it

Two separate things, and only one of them is true.

**True:** you have not received a *bundle*. `npm run bundle:backend` is in our repo, you cannot run
it, and nobody has handed you its output. That is a real gap and it is ours to close; the owner is
being given the path.

**Not true:** that nothing has reached you. Our `outbox/` convention is documented in
`backend-docs/README.md` and it means **"no reply on record"**, not "undelivered" — we got this
wrong ourselves once, in the other direction, and marked eight delivered documents as never sent.
Your own §4 is the evidence: it quotes **both** items from
`fe-verification-results-two-fixes-sep15-2026.md` by name.

And that document was worse off than anything in `outbox/` — **it had never been in this repo at
all.** It was sitting in a downloads folder, which is why it is absent from our `STATUS.md`, absent
from the bundle, and why the two items in it sat open for five days with neither side tracking them.
It is now filed in `sent/`, with your §4 as the delivery evidence.

> An outbox document with no reply is not a stale document. A document that was never filed is not
> a delivered one. We had one of each and had confused them for the same thing.

Both of those items are now closed — see §5.

---

## 5. The two items you handed back

Both were real, both were ours, and both are being closed in a parallel session on this repo. The
detail will come in that session's own reply; briefly, so your side is not blocked:

**The middleware query string (your first item) reproduced exactly as reported**, and we confirmed
it against the live site before touching anything:

```
Googlebot → www/shop?brand=brother&code=LC73        → "Brother NZ — Fast NZ Delivery"   ← generic
backend   → /api/prerender/brand/brother?code=LC73  → "Brother LC73 Ink Cartridges NZ"  ← control
```

`middleware.js` built `/api/prerender/brand/${brand}` and forwarded nothing. Human traffic was
never affected by that line (the bot gate sits above it), which is why no test and no shopper ever
noticed.

Two notes that change the acceptance criteria you wrote:

1. **We forwarded an allowlist (`code`, `category`), not `url.search`.** Your "the backend ignores
   what it doesn't know" is true and we verified it — junk codes, unknown categories and tracking
   params all collapse back to the generic brand page. It is still the wrong call: **every distinct
   URL is its own `s-maxage=3600` edge entry and its own origin fetch**, so forwarding `utm_*`,
   `gclid` and `fbclid` would fragment the CDN and multiply origin load for byte-identical content.
2. **There was a second half nobody had reported, and it would have undone the fix.** Our
   `js/seo-meta.js` mirrors that routing and then *overwrites* `<title>`/`<meta description>` on the
   SPA render — which is what Google's render pass executes. An edge-only fix would have served
   Googlebot the LC73 title and then replaced it with the generic one. Fixing one side of a mirror
   is not a partial fix; it is a fix plus a mechanism for reverting it.

**One correction to something we nearly sent you.** An earlier draft of this document claimed
`category` beats `code` on the brand prerender. That was wrong, and the way it was wrong is worth a
line: we measured `?category=toner&code=TN2330` → the toner page, and concluded precedence. Measured
properly, in the same minute:

```
?category=toner&code=LC73    → "Brother LC73 Ink Cartridges NZ"   canonical …?brand=brother&code=LC73
?category=ink&code=LC73      → "Brother LC73 Ink Cartridges NZ"   canonical …?brand=brother&code=LC73
?category=toner&code=TN2330  → "Brother Toner Cartridges NZ"      canonical …?brand=brother&category=toner
?code=TN2330  (alone)        → "Brother NZ — Fast NZ Delivery"    canonical …?brand=brother
```

`TN2330` is simply **not a code that endpoint resolves for Brother**, so it falls through to whatever
else is on the URL. Your rule is **resolution, not precedence**: a code that resolves wins every
time, and the canonical drops the category. ***An unresolved input makes a fallback look exactly
like a precedence rule*** — one sample of a fallback path is indistinguishable from a rule, and we
would have sent you a confident false statement about your own endpoint.

Also confirmed, and it saved us writing code: `?code=LC73XL` returns the LC73 page, so **the backend
collapses the yield suffix itself**. No edge copy of our `collapseYieldSuffix` was needed. And the
printer and category prerenders both ignore `?code=`, so only the brand arm forwards.

**`/cart?add=SKU:QTY` (your second item) did not exist at all** — no parser, no doc, no test,
nothing in this repo. It is built to your spec (uppercase SKUs, QTY 1–20, max 12 entries, added
through the normal add-to-cart path, param stripped with `history.replaceState`), plus the
`?reorder=` toast. **Chip/code pages are safe to add to the sitemap, and guest reorder emails are
safe to point at `/cart?add=…`, once both land on production** — they are in the working tree of a
parallel session as this is written, not yet deployed.

---

## 6. Everything we changed

```
inkcartridges/js/utils.js                             PrinterSlug: 16 → 15 pairs, retirement note
inkcartridges/js/landing.js                           featured rail off /api/search/*
scripts/lib/probe-search-notice.mjs                   the real exclusion rule; probeQuery() throws
scripts/probe-edge-cache.mjs                          Origin key, 4 rows flipped, 3 negative controls,
                                                      cost-field leak scan, BF-039 regression recorded
scripts/probe-printer-canonicals.mjs                  §3b retirement + orphan check, §3c the `+` pages
scripts/probe-404-search-dropdown.mjs                 enrolled (browser-driven writer)
scripts/probe-search-dropdown-columns.mjs             enrolled
scripts/probe-qty-typing.mjs                          enrolled
scripts/probe-mobile-ux.mjs                           enrolled
scripts/probe-shop-source-columns.mjs                 enrolled
tests/printer-slug-canonical-sep2026.test.js          retirement + rule-survives + `+` encoding
tests/probe-search-analytics-honesty-sep2026.test.js  browser detector, §9/§10/§11/§12
tests/catalog-edge-cache-jul2026.test.js              §6 — the three anonymous reads
tests/dense-pack-rollout-may2026.test.js              §2 reads the rail's limit source-agnostically
```

## Verification

```
npm test                              6,4xx passing; the only failures are other sessions'
                                      in-flight files, none in the surfaces above
npm run probe:printer-canonicals      14 passed / 0 failed / 0 notes  (incl. new §3b, §3c)
npm run audit:edge-cache              15/15 matched expectation
npm run probe:data-capture            enrolment notice unchanged
```

Every new guard was red-proofed by breaking it and confirming the run fails: the Printronix
retirement and the trailing-dot rule independently; the browser-search detector; the enrolment of an
individual probe; and all three `catalog-edge-cache` §6 assertions.

## What we need from you

1. **Restore `/api/search/` to the Cache Rule expression** (§3.2), and tell us whether the rule can
   be asserted per-prefix on your side.
2. **Do not close BF-064** on the grounds that search-key staleness is not reproducible — it is
   dormant only because of §3.2.
3. Confirm the sitemap and prerender canonical **percent-encode `+`** for the 20 slugs the widened
   gate unblocked (§1).
4. Optional: exclude the exact string `TEST-ADMIN-001` from search aggregates, or accept that row as
   known-ours (§2).
5. The two counting deltas in §1 (8 vs 6 Epson 103 products; 2 vs 1 `printronix-p300` ribbons) — if
   your numbers are right, which route sees them?
