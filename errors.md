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

## ERR-189 — The invoice sign-off was the smallest text on the page, and on an 11-line invoice the bank details were printed off the bottom of it — **RESOLVED** (2026-08-31)

- **Date**: 2026-08-31 · **Context**: The owner read an invoice we had emailed and asked whether we control the size of the one line addressed to the customer — *"Thank you very much for your business and for checking out InkCartridges.co.nz."* — because it was hard to read. We control all of it. `buildInvoiceDoc()` (`js/admin/pages/invoices.js`) renders the document with jsPDF and `syncStoredPdf()` uploads those exact bytes (`POST /api/admin/invoices/:id/pdf`), so the emailed attachment, the `/business` download and the admin Download button are **one file** — the contract `js/business-invoice-pdf.js:5-10` states as *"THE FILE WE SERVE IS THE FILE WE EMAILED."* No backend template, no puppeteer, no print stylesheet is in this path.

- **The reported defect, stated plainly**: the sign-off was `setFontSize(10)` bold against an 11 pt body — **the smallest text on a document where every other line was bigger**. The one sentence written *to* the customer had been set smaller than everything it sat under. Sizes are now up ~15% across the document (body 11→12.5, sign-off 10→**12.5**, Total 14→16, title 24→26) with **every paired leading value moved with them** — the vertical rhythm in that function is hand-tuned `+=` increments, and raising type without raising leading collides the lines.

- **THE ASK WAS TYPOGRAPHY; THE FIND WAS A DOCUMENT THAT SILENTLY DROPPED ITS OWN BANK DETAILS.** `buildInvoiceDoc` walked a monotonically increasing y-cursor with **no bound check against A4's 841.89 pt**. Driving the real function against real jsPDF across 1–60 line items, the pre-change code wrote past the page bottom at **11–14, 31–34 and 51–55 lines** — up to **y = 1004.6 on an 841.89 pt page**, seven separate draws off-page at 14 lines. Those lines are not clipped, they are *absent*: on a 12-line invoice the customer received a tax invoice with **no account number to pay into and no sign-off**, and nothing anywhere said so. The bug is old, the fault was already documented by a sibling file (`js/order-receipt.js:27-37`, "TWO THINGS THE ADMIN BUILDER GETS WRONG"), and it had simply never been carried back. Bigger type would have moved the first failure from 11 lines to fewer, which is why it shipped in the same change rather than after it.

- **Fixed with the pattern already proven next door, not a second one.** `js/order-receipt.js:206-212` already had `ensure(h)`; that is what is used here. The totals stack and the payment block each reserve their **full height in one call**, so a break can never part the Total from the figures it sums, or the account number from the words telling the customer to pay it. Measured after: **clean across 1–60 lines**, nothing drawn past the bottom, payment block always on the last page.

- **One documented fault did NOT reproduce, and the entry says so.** The sibling file also warns that autoTable paginates but leaves the doc's *current page* where it started, so totals get drawn on page 1 underneath a two-page table. Under **jspdf-autotable 3.8.4** that did not happen in any of the 60 measured cases — the pre-change code put its totals on the correct last page every time. `doc.setPage(doc.internal.getNumberOfPages())` is kept as cheap insurance against a version that behaves as documented, but **it fixed nothing measurable here** and should not be credited with the repair. *Inheriting a warning is not the same as reproducing it; say which half you actually saw.*

- **HOW IT WAS PROVEN, BECAUSE THE METHOD IS THE REUSABLE PART.** A transcription of the geometry into a test harness would have measured the transcription. Instead the probe reads `buildInvoiceDoc`'s **source off disk**, evals it in a real browser against the real CDN-pinned jsPDF + autotable, and monkey-patches `doc.text` to record `{page, y, string}` for every draw — so the thing measured is the shipped bytes. Then the **same probe was run against `git show HEAD:…`**, which is what turns "the new code looks fine" into "the old code failed at n=11 and the new one does not". A one-sided measurement of a fix proves the fix is *present*, never that it *changed anything*.

- **Verified**: `npm test` — **4,386 tests, 4,366 pass, 1 fail**, the failure being the pre-existing untracked `.DS_Store` Finder artifact (gitignored, not tracked; already noted under ERR-187/188). New `tests/admin-invoice-font-size-aug2026.test.js` adds 6, pinning **shapes rather than numbers** — the sign-off is never smaller than the body, nothing drops below a 10 pt legibility floor, the HTML preview's base size stays within a ratio band of the PDF body (the operator approves the preview and the customer receives the PDF; the two drifting apart is how a document ships looking unlike its proof), and the reservations exist — plus a **positive control** whose deliberately-broken fixture must fail the sign-off check, without which the file could pass by matching nothing. `admin-invoice-cost-not-on-document.test.js` and `admin-invoice-sku-integrity.test.js` pass **unmodified**; the items table is still four columns. Both documents rendered and read visually, before and after.

- **Lesson**: **raising a font size is a layout change, and a layout with hand-tuned leading and no page bound has a failure mode that prints nothing and reports nothing.** The customer-visible symptom of the old bug was not an ugly invoice — it was an invoice with no way to pay it. When a cosmetic request lands on a hand-positioned document, measure the geometry before and after across the whole input range, not at the one length in front of you.

---

## ERR-188 — A 22-minute backend outage was indistinguishable from losing admin rights — **RESOLVED (frontend)** (2026-08-31)

- **Date**: 2026-08-31 · **Context**: The owner reported losing access to `/admin` and supplied their credentials to investigate. The account was never the problem: signing in returned a valid token every time, and `npm run probe:order-discount` had pulled real admin order data with those exact credentials ~5 minutes before the report. The API backend then returned **502 on every route** — `/api/health`, `/api/products`, `/api/shipping/rates`, `/api/admin/verify`, even a nonsense path — authenticated or not, on both `ink-backend-zaeq.onrender.com` and `api.inkcartridges.co.nz`, from ~23:50 to ~00:12 UTC (11:50 AM – 12:12 PM NZST; the screenshot in the report is timestamped 11:50:41 AM, the first minute of it). One request at 23:59:53 returned a real JSON envelope before dying again. Once it recovered, `GET /api/admin/verify` returned `{"is_admin":true,"role":"super_admin","roles":["super_admin"]}` **16/16 times across both hosts**. The role had never changed.

- **IT WAS RENDER, NOT VERCEL, AND THE HEADERS SAID SO.** Worth writing down because the instinct is to suspect the thing you deployed. Vercel was the only healthy layer: `inkcartridges.co.nz` served **200** with `x-vercel-id: syd1::…` / `x-vercel-cache: HIT` throughout, which is exactly why the site *looked* fine and made this read as an admin-only problem. Both failing hosts carried **zero Vercel headers**: the Render URL returned `x-render-routing: dynamic-paid-error` + `rndr-id` (Render's router reporting no healthy instance), and the custom domain returned Cloudflare's own "Bad gateway" page. `vercel.json` has **no API rewrite** — the two API hosts appear only in the CSP `connect-src`, and the browser calls the API directly via `js/config.js:19-21` — so Vercel is not in the API request path at all. **Read the gateway's own headers before blaming a layer; `x-render-routing` and `x-vercel-id` each name their owner.**

- **THE ACTUAL DEFECT: three causes, one wordless symptom.** `AdminAuth.init()` had four ways to fail and all of them ended in `window.location.href = '/account'` with nothing rendered — not authenticated, verify threw twice, `!resp.data`, and unrecognised role. So "the backend is down", "you were never an admin", and "your role was revoked" were **byte-identical from the operator's seat**. This is the fail-soft-must-be-loud rule applied to authorisation: **absence of a yes is not a no.** The fix splits the outcomes and refuses only on an authoritative negative — a 403, or a 200 that grants nothing. A 502, a timeout, a rate-limit, a 404 on the route itself, or any unreadable error is a NON-ANSWER, and a non-answer now **throws without navigating** so `boot()` can render an "Admin Centre unavailable" panel in place, on `/admin/`, saying in as many words that the role is unchanged.

- **`API.request()` HAS TWO 5xx SHAPES AND ONLY ONE OF THEM THROWS.** This is what made the bug survive a `try/catch` that looked complete. A **non-JSON** 5xx — the Render/Cloudflare HTML gateway page — fails `response.json()` and **throws** (`js/api.js:299-305`). A **JSON** 5xx envelope **returns** `{ok:false, code:'INTERNAL_ERROR', status}` and never throws (`js/api.js:406-414`). The old guard wrapped only the throw, so the returned shape fell straight through to `if (!resp || !resp.data)` and was reported as "not an admin" **with no retry at all**. `AdminAccess.classify(resp, err)` now takes both, so a call site cannot handle one and forget the other. **When a helper has two failure shapes, a caller that only catches is only half-written — grep the return-instead-of-throw branches before trusting a try/catch.**

- **THE SAME BUG, TWICE MORE, ON TWO OTHER SURFACES.** `js/main.js` decided the header Admin link with `res.ok && res.data`, which is false for a JSON 5xx and a 401 as well as for a real refusal — so during the outage it **removed the link and wiped the `ink_admin_header_hint` session key**, and the owner watched their own Admin shortcut disappear. Its `.catch()` was correct and covered only the throwing half. `js/site-guard.js` was worse: `if (!res.ok) return false;` sent a **502 straight to "not an admin"**, returning `false` where the function's own contract reserved `null` for "failed" — which skipped the 4s cold-start retry that function exists for. **A three-state contract enforced at one of its three exits is a two-state contract.**

- **ONE VOCABULARY, BUT NOT AT THE COST OF AN ISOLATION BOUNDARY.** `admin/auth.js` accepted `{superadmin, owner, admin}` after stripping non-letters; `site-guard.js` accepted the literal list `['owner','admin','superadmin','super_admin']`. Two accept-lists for one endpoint, agreeing today only by luck. The map now lives once, as `AdminAccess` in `js/utils.js` (loaded on **every** page that loads `main.js` or `site-guard.js`, and always first — verified across all 37). **`site-guard.js` was deliberately NOT converted to import it**: its header declares it self-contained ("no dependency on auth.js or config.js") so the lockdown guard still works when nothing else has loaded, and coupling it would let a missing script hand an admin the lockdown overlay. Its copy stays inline and a test pins the two to identical answers across every spelling. **Deduplication that breaks a stated isolation guarantee is a regression wearing a refactor's clothes; pin the parity instead.**

- **`window.AdminAccess` is read directly, never behind `?.` with a fallback** (ERR-167): a guard around a global that turns out not to exist is an off switch, and the fallback becomes the only branch that ever runs. Both consumers assert it and say "broken deploy" if it is missing.

- **The retry ladder was too short to span the thing it was for.** One 2s retry cannot cross a Render restart — this outage ran 22 minutes and an ordinary cold start outlives it too. Now 0s / 2s / 5s, and **only while the answer is "no answer"**; a refusal is never retried, because the server has already spoken and retrying only delays a correct redirect. `API.request()` has its own transient-502 ladder underneath, observed composing with this one in the browser.

- **Verified**: `npm test` — **4,380 tests, 4,360 pass, 1 fail**, the failure being a pre-existing untracked `.DS_Store` Finder artifact (gitignored, also noted under ERR-187). `tests/admin-auth-outage-vs-refusal-aug2026.test.js` adds 25, including a **positive control** — `{ok:true, data:null}` must still redirect to `/account` — without which the suite could pass by calling every outcome "unreachable" and silently break the redirect real non-admins need. `tests/admin-business-upgrade-aug2026.test.js`'s "super_admin IS the owner role" was **repointed, not deleted**: it asserted the map lived inline in `admin/auth.js`, so it was aimed at utils.js where the vocabulary now is, plus a new assertion that auth.js still delegates rather than growing a third copy. `tests/search-thin-frontend.test.js`'s main.js ceiling raised 780→790, documented in place per that test's own rule. Driven end-to-end in a real browser as owner: with `**/api/admin/verify` stubbed to a 502 HTML page the URL **stays on `/admin/`**, the panel renders, the shell stays hidden; unstubbing and clicking **Try again** boots the shell with the role label **Owner**.

- **Not fixed here, and not fixable here**: why the Render service dropped. The backend is a separate repo; the runbook handed over is Render → Events for 23:50–00:12 UTC (a deploy at ~23:50, a repeating `Exited`/`Restarting` cycle, or an OOM), Logs for the lines before the first exit, and rollback to the deploy that was live at 23:45 and measured healthy.

- **Lesson**: **an outage and a refusal must never share an exit.** When a gate can fail for reasons it cannot distinguish, the honest default is to say what it does not know and stay put — a redirect is a claim, and "you are not an admin" is the most damaging claim this particular gate can make wrongly. And when the report is "I lost access", **measure the credential before reading any code**: one sign-in and one probe separated the account from the infrastructure in under five minutes, and everything after that was cleanup.

---

## ERR-187 — Every product started life in a blank form, and 122 of them ended up where no customer could reach — **RESOLVED (frontend)** (2026-08-30)

- **Date**: 2026-08-30 · **Context**: The owner asked for a better way to introduce new products: an automatic path (the supplier feed) that should be provably working, and a manual path shaped like the customer's own drill-down — brand → type → code → product, "all of this via the admin centre". The literal design could not be built, and building the honest version turned up 122 live products that no customer can navigate to.

- **Three of the four levels are not records, so a create-hierarchy was never possible.** A brand is a real `brands` row. A category is not stored at all — it is a fixed map over `product_type`, a backend Postgres enum. And a **code is not stored anywhere either**: `_enrichSeriesCodes` (`js/api.js`) derives it from sku/name at query time, with `product_codes` as a pure override layer. So "add a code, then add products into it" has nothing to write, and would have rendered a chip that appears on no page — the ship-it-invisible family (ERR-075/125/163) rebuilt deliberately. **The pathway is therefore a navigator that PRE-FILLS the create form**, and the chip materialises when the first product saves into it. `+ Add Product` no longer opens a blank modal; it opens the walk.

- **The measurement was wrong four times before it was right, and every correction came from checking the live API rather than reasoning.** The probe's first run reported **340 unreachable products**; the true figure is 122. The 218 difference was four distinct false-positive classes, each of which looked completely plausible: (1) **175 Canon products** flagged for carrying `CL41` when the chip is `PG40/CL41` — clicking the pair chip returns both halves, measured; (2) **61 ribbon-brand products** measured against the /shop brand grid, which is not their route — ribbons reach customers through `/ribbons?printer_brand=`, and `/api/shop?brand=adler` returns `ok:false` because there is no `adler` row in `brands` at all; (3) **74 paper products** flagged as codeless when /shop *has no code level for paper* and renders its products directly; (4) **96 compatibles** flagged as codeless because the probe read only the API's `series_codes` — the backend extractor reads `manufacturer_part_number`, which compatibles do not have, so the browser derives their codes instead (`CDR1070BK` → `DR1070`, and brother · drums has had a `DR1070` chip all along). Fixing (4) meant loading the SHIPPED `js/api.js` in a `node:vm` sandbox and calling the real extractor. **A probe carrying its own copy of the derivation certifies a site that does not exist.**

- **"Has a code matching a chip's name" is not "a customer can reach it", and the weaker test hid 27 real failures.** The chip-label membership check passed `GLC38CMY`: it carries `LC38`, and brother · ink has an `LC38` chip. But `GET /api/shop?brand=brother&category=ink&code=LC38` returns six products and that is not one of them. Replacing label-membership with a **diff against the SKUs /shop actually serves** took the finding count from 20 to 47 — several of them genuine value packs (`GLC38CMY`, `GLC40CMY`, `G432KCMY`), the same shape as the `pack_type` drop documented at `js/api.js:934`. **Measure the outcome, not a proxy for it.**

- **The XL collapse was not cosmetic — without it the override trap sprang on the happy path.** The server collapses the yield suffix on the chip LABEL (brother · ink offers `LC3339`, never `LC3339XL`) while the extractor derives the uncollapsed `LC3339XL` from a SKU. Compared raw, every one of LC3339's twelve existing `LC3339XL*` products reads as a MISMATCH — so `needsCodeOverride` returned true for essentially every XL product, and the create flow would have written a `product_codes` row on every single save. A product with any row there has its derived codes ignored **permanently**, and a later import correcting its derivation would never reach it. **Caught by typing a SKU into the form in a real browser, not by any test**; `collapseYield`/`codeMatchesChip` now own the comparison and a bare `===` is banned.

- **A flake reported as a finding is the could-not-look mistake with the sign flipped.** One transient failure on a ~70-request sequential walk turned into "**662 products unreachable**" — one unreadable `oki · toner` page attributed to every product in it. Scopes are now retried once, and anything still unreadable is counted as **unmeasured**, named, and never as broken. A run that finds nothing but could not read everything exits **2**, not 0 — a partial sweep is neither a pass nor a findings list. Real findings still exit 1, so a flake can never bury them. Separately, a `429` mid-walk is the API asking us to wait, not an answer about the catalogue: it now backs off 20s and retries, the same shape `audit:types` uses on the same endpoint.

- **The in-browser check had the inverse bug, and it was worse.** The Browse tab's "Check for unreachable products" first ran the shared facet helper over the admin list and reported **195 of Brother's 200 ink products** as broken. All 195 were fine: `/api/admin/products` does not project `series_codes`, and a genuine SKU derives nothing client-side (the extractor's SKU rule keys on the compatible `C` prefix, so `GLC131BK` yields nothing). It was reading **missing data as missing codes** — absence-as-failure, the mirror of absence-as-zero. It now diffs the admin list against what /shop actually serves and reports **3**, all real. Its stated *reason* was wrong too — "no brand assigned" about a row whose brand was simply not in the projection — so it now claims only what the row positively answers, distinguishing an ABSENT KEY from a null value.

- **What the frontend found and cannot fix.** 4,020 active products, **3,898 reachable**: 75 with no derivable code (mostly Dymo genuine label tape — `G18443BK`, whose SKU the extractor cannot read and whose name has no `for <Brand> <CODE>` phrase), 47 in the catalogue but not served by their own chip. Plus **17 brands that exist and render no tile on /shop**, because `renderBrands()` filters `/api/brands` against a hardcoded `preferredOrder` array with logos in a second hardcoded map — a brand missing from it is invisible with no error anywhere. The Browse tab now names those 17 inline. All of it is handed over in `catalogue-pathway-backend-brief-aug2026.md`, together with the three standing gaps: **there is no `POST /api/admin/brands` at all**, `DELETE /api/admin/products/:id` still 404s "Endpoint not found" (ERR-166/BF-041, open since 2026-08-14, and the bulk Delete button still promises otherwise), and the write payload's `compare_at_price` disagrees with the column `compare_price`.

- **Verified**: `npm test` — **4,343 tests, 4,341 pass**; the two failures are an untracked `.DS_Store` (Finder artifact, not tracked by git) and nothing else. `tests/catalogue-pathway-aug2026.test.js` adds 41. `tests/product-type-vocabulary-aug2026.test.js` was updated in lockstep and STRENGTHENED: the New modal now passes a `typeOptions` narrowed to the category being added to, so the test asserts that narrowing is a `PRODUCT_TYPE_OPTIONS.filter` — never a literal — and that with no pathway context it falls back to the full vocabulary. `npm run audit:types` clean in both directions. `npm run probe:catalogue-pathway` exits 1 with the findings above, and exits 2 with an unreachable `API_BASE`. Walked end-to-end in a real browser as owner: brand grid → Brother → Ink (34 codes) → LC3339 (12 products, matching the live site) → pre-filled create form.

- **Follow-up, same day — two owner requests on the shipped pathway.** (a) **The colour dropdown is now ALPHABETICAL by label.** It was ordered semantically (K → C → M → Y → packs → specialty) to mirror `ProductSort.COLOR_ORDER`, and pinned that way by two tests. With 42 entries that only helps someone who already knows the taxonomy. **The storefront sort is untouched** — `COLOR_ORDER` derives from `COLOR_RANK`, never from `OPTIONS`, and the only other reader (`audit:colours`) tests membership, not order; membership, labels and `PACK_VALUES` were verified byte-identical before and after. The two order tests were rewritten in lockstep: one now pins that CMY/KCMY/Tri-Colour are distinguished by their **labels** (which say how many cartridges you get — the actual ERR-141 safeguard) rather than by adjacency, and a new test pins that the storefront rank still comes from `COLOR_RANK` so this can never quietly become the source of the customer-facing order. Sorted with an uppercase code-unit comparison, **not `localeCompare`** — with options that depends on the runtime's ICU data, and a dropdown whose order changes with the environment is not sorted. (b) **"+ New code" on the Browse tab.** A code cannot be created — it is derived, and one with no products has nothing to store — so the modal says naming it saves nothing by itself and offers the two things that DO make it exist: add its first product (carried into the pre-filled create form, where the existing override write files it), or tag products that already exist (hands off to `#product-codes`, which owns the membership drawer — rebuilding that here would be a second surface writing the same table, the shape that let two normalisers drift apart in ERR-061). Unlike the Product Codes page it does **not** ask for brand and category: the operator is already standing in one, which is the point of having walked there.

- **One test bug worth naming, because it will recur.** The alphabetical assertion failed against a list that was correctly sorted. `ProductColors.OPTIONS` is built inside the test's `vm` realm, so `.map()` returns an array carrying the VM's `Array.prototype` — and `deepStrictEqual` compares prototypes, so two identical string lists fail on realm alone. `Array.from(...)` on both sides fixes it. **A cross-realm deepStrictEqual can fail for a reason that has nothing to do with the values**, and the printed diff looks identical, which is exactly how long it takes to spot.

- **Lesson**: **A hierarchy you can navigate is not a hierarchy you can create.** Where the levels are computed facets rather than records, the only honest UI is one that pre-fills and lets the bottom level materialise the rest. And when building the check that proves it: measure the outcome the user cares about — *is this product served* — never a proxy that correlates with it, because every proxy this task tried (has a code, matches a chip name, derives client-side) was wrong for a different population, and each one looked right until it was run against production.

---

## ERR-186 — The below-zero guard outlived the 500 it was guarding — **RESOLVED** (2026-08-30)

- **Date**: 2026-08-30 · **Context**: The backend dev sent a patch (`invoice-below-zero-guard-FE-remove-guard.patch`) deleting `validateInvoice`'s below-zero total guard, on the grounds that BF-052 was fixed — "migration 139 scoped the underlying `orders.positive_amounts` CHECK to real web orders" — and citing invoice 3276 (`-$41.49`) as live proof. The guard's own comment had set the condition for its removal in advance: *"DO NOT RELAX IT until that 500 is a 201 or a 400 — and when it is, delete the whole block rather than softening the message."* This is that, but only after the 201 was measured here.

- **The cited proof was real and proved the wrong thing.** A read-only `GET /api/admin/invoices` found exactly one negative-total document on production, and it was the one named: invoice **3276**, subtotal `-36.08`, GST `-5.41`, total `-41.49` — the owner's ERR-185 screenshot, stored. That settles that the database will *hold* a below-zero document, so the CHECK constraint really is scoped. But its `created_at` is **2026-08-28**, a day *before* the fix the patch describes, which makes the likeliest history "created positive, later **updated** negative". An UPDATE exercises the constraint; it does not exercise **create** — and create is the whole of what the guard stood in front of, because a credit note written from scratch is a `POST`. **A citation is not a measurement: the row was genuine, and it was evidence for a different claim than the one being made.**

- **So the create path was measured directly, and it passes.** `POST /api/admin/invoices` with the exact refused document (one `1 × -36.08` line, freight 0) returned **201** — not the 500 of two days earlier — and stored it **unfloored**: `subtotal_excl_gst: -36.08`, `gst_amount: -5.41`, `total_incl_gst: -41.49`, `line_total_excl_gst: -36.08`. Then deleted cleanly (`DELETE` → 200 `{deleted:true}`, `GET` → 404), as ERR-183's control did. BF-052 is genuinely closed, and the guard came out. `$0.00` stays legal, as it always was.

- **Note what could NOT be verified, so it is not mistaken for verified.** `sql/migrations/` does not exist in this repo; `positive_amounts`, `139_` and any mention of an `orders` CHECK constraint appear **nowhere** in it. Migration 139 lives in the backend repo and is unverifiable from here. The measured 201 stands in for it — which is the right way round: *the behaviour is the claim, and the migration is only an explanation of it.*

- **The patch was correct in substance and incomplete in bookkeeping.** Its code change was right, its `APP_VERSION` bump was necessary (pages load via `` import(`./pages/${name}.js?v=${APP_VERSION}`) ``, so without it live browsers keep the cached build and the guard survives the deploy), and inverting the §4 tests rather than deleting them was the right instinct — the new one asserts the block is **gone from source**, not merely softened. Three things it left: its tombstone comment pointed at `ink_backend/docs/…`, **a path in the backend repo that no reader of this one can open** (now ERR-186 here); `npm run build` was not run, and without restamping the admin HTML the browser never re-fetches `app.js` itself, so the bumped `APP_VERSION` never takes effect — *the exact failure its own note warned about, one level up*; and five records still asserting BF-052 was open.

- **Cleared, because a workaround that outlives its cause reads as a live limitation** (ERR-184/185's lesson, third time): the `…negative-line…test.js` header still said "WHAT IS STILL REFUSED IS THE DOCUMENT TOTAL"; `probe-invoice-quote.mjs`'s header still described an open 500; `admin-invoice-discount-aug2026.test.js` still cited it; the handoff's acceptance checklist was unticked; and the BF-052 todo was open. **One coupling to watch**: `…negative-line…test.js` §6 asserts the *probe's source* names where the below-zero case is measured instead — the probe has no write path by design, so its silence would otherwise read as coverage. That assertion was repointed at ERR-186 alongside the probe header, not deleted; the pairing is the point.

- **Still open, and deliberately left open**: the invoice **LIST** floors a negative `supplier_cost_excl_gst` while the **detail** endpoint stores it — visible on the very invoice used as evidence here (`cost_excl_gst: 0` on the list row). Same money, two surfaces, silent disagreement; ERR-068 one endpoint over. It was filed inside the BF-052 handoff and is now the only thing left of it.

- **Verified**: full suite **4309 tests, 4289 pass, 1 fail** — the one failure is `no-ghost-files.test.js` flagging a local `.DS_Store`, pre-existing and unrelated (identical before the change). `tests/admin-invoice-negative-line-aug2026.test.js` **43/43**. `npm run probe:invoice-quote` green. The live create-and-delete above. And the credit note driven through the real editor.

- **Lesson**: removing a guard needs the same standard of proof that installing it did — a measured server response, not a report of one. The patch's evidence was truthful and its conclusion was right, and it still would not have justified the removal on its own, because the artifact it pointed at answered a neighbouring question. **When a fix is dated after the proof it cites, the proof is about something else.**

---

## ERR-185 — Four refusals on the invoice editor, three of them ours, one of them silent — **RESOLVED (frontend)** (2026-08-29)

- **Date**: 2026-08-29 · **Context**: The owner sent a screenshot of invoice 3276 — one
  `-$36.08` credit line, the editor refusing to save with *"The credit lines exceed the charges —
  this invoice totals -$41.49"* — and asked to be able to type any value on an invoice and have it
  work. Most of that had landed the day before (ERR-184 / BF-050). What was left was four
  refusals, and only one of them belonged to the server.

- **The one that is not ours, and stays** — *superseded 2026-08-30: it did not stay. The server started accepting a below-zero total and the guard was deleted; see **ERR-186**. Everything below describes why it stood while it stood.* A below-zero invoice TOTAL. Exactly `$0.00` saves;
  one cent below returns **500 `Failed to create invoice`** (BF-052, measured 2026-08-29). The
  guard in `validateInvoice` is the only thing between the operator and an opaque crash, so it
  keeps standing — but its message was rewritten, because it was reading as a rule of ours about
  credit lines when it is a server limit. It now states the total, says the invoice **service**
  cannot store it, names BF-052, and names the shape that DOES work today: the original product
  code with a **negative quantity**, which reverses revenue and COGS together. *A refusal the
  operator cannot route around is just a wall.* The ask is
  `readfirst/invoice-negative-total-backend-handoff-aug2026.md`, and both the source comment and
  the test point at it so whoever sees it land can delete the block rather than soften it.

- **The silent one, which was the worst.** Typing a negative into "Our Cost" **vanished**.
  `costOrNull` answers "is this a plausible cost?" with `n >= 0 ? n : null`, so a typed `-5` became
  `null` — the box emptied on reopen, the Profit column fell back to "—", and nothing anywhere
  said a figure had been discarded. The fix is not to widen `costOrNull`: that function reads costs
  we DERIVED (catalogue `cost_price`, an order's `supplier_cost_snapshot`, the backend's
  `cost_excl_gst`) and a negative there is corruption, not a claim. A new `manualCostOrNull` answers
  the different question — *did a human put a number in this box?* — and `lineSupplierCost` picks
  between them on `cost_source`. ERR-068's absence-is-never-zero rule is untouched in both, and
  `costOrNull(-1) === null` is re-pinned as the control proving the split happened rather than the
  guard being deleted. *A value the operator authored is theirs: refuse it out loud or keep it,
  never swallow it.*

- **And that fix had a second half I nearly missed.** `normalizeInvoice` built its line objects
  without `costSource`, so a typed negative survived the first read and was then re-read further
  down (`computeInvoiceCogs` → `lineCostExGst` → `lineSupplierCost`) as though nobody had typed it —
  reporting the cost UNKNOWN on an invoice that knew exactly what it cost. Caught only because the
  new test asserted `allCostsKnown`, not just the number. Same shape as ERR-178: **presence
  standing in for provenance**. The provenance now rides along.

- **A zero quantity was refused, and it was our rule alone** — the service takes `quantity: 0`
  (now measured live, probe §6f: `1 × 100.00 ex + 0 × 80.00 ex → 115.00 incl`, so a zero-quantity
  row contributes nothing rather than being read as "unspecified" and substituted). Worse, the
  refusal said **"quantity required"** — the same words a blank box gets, so a rejected figure was
  indistinguishable from a missed one. That is precisely the defect ERR-181 fixed on the price box,
  recurring one column over. Blank and non-numeric are what is actually wrong.

- **Four `min="0"`-shaped leftovers, all residue of refusals already lifted.** `min="0"` on the
  freight and Our Cost boxes (inert — the editor is a `<div>`, nothing calls `checkValidity()`,
  `admin.css` has no `:invalid` rule; all it ever did was shape the spinner arrows and *tell the
  operator a limit existed*), plus the two caps refusing a discount larger than its line and a fold
  larger than the line above. Both caps named BF-050 as their reason in their own comments. **A
  workaround that outlives its cause reads as a live limitation** — ERR-184's lesson, one file
  over, one day later. The discount box keeps its `min="0"`, because that one is backed by a real
  check and means "how much to take OFF"; kept as an assertion so this is not read as "delete every
  min".

- **Lifting a cap exposed a real rendering bug.** `$100` off a `3 × $33.33` line lands the unit
  price a third of a cent below zero; `Math.round(-0.33)` is **`-0`**, and `Intl` formats that as
  **`-$0.00`** — a minus sign on a customer's invoice for a line worth nothing. Unreachable while
  the cap stood. `round2` now normalises it in all three copies. *Every cap you remove hands the
  arithmetic inputs it has never had.*

- **A test was reimplementing the code it tested.** `admin-invoice-discount-aug2026.test.js` kept a
  local `round2` that had drifted from the page's, which is how the `-0` stayed invisible while
  both were "passing". It now LIFTS the shipped one out of the source. Related: the custom-item
  suite's printed-vs-validated equality used "did the validator complain" as a proxy for "did the
  validator look" — the two coincided only because every considered row there was also incomplete,
  and a legal zero-quantity row broke the coincidence. It uses an explicit tripwire now.

- **Driving it through the real editor found a bug neither the tests nor the probe could.** An
  invoice carrying a zero-quantity line and a typed `-12.34` cost was created, read back and
  deleted. The line items round-trip perfectly (`quantity: 0` → `line_total_excl_gst: 0`;
  `supplier_cost_excl_gst: -12.34` with `cost_source: "manual"`; `freight_excl_gst: -20`), and the
  reopened editor reads `-$12.34 · 112.3%`. But `GET /api/admin/invoices` — the LIST — returns
  `cost_excl_gst: 0, profit_excl_gst: 100` for that same invoice: **the rollup floors the negative
  cost while the detail endpoint stores it.** So the list says `$100.00 · 100.0%` and opening the
  row says `-$12.34 · 112.3%`, with nothing to notice it. Added to the handoff as part of BF-052.
  *A negative and an absence are two different things, and neither of them is zero* — ERR-068 one
  endpoint over. **The tests were green and the probe was 17/17; only the round trip through the
  product showed it**, which is the argument for that last verification step, not a formality.

- **Verified**: full suite **4290 pass / 0 fail**; `npm run probe:invoice-quote` **17/17** with the
  new §6e/§6f pins; the live probe confirming the zero-quantity claim rather than taking the
  backend's word for it; and the end-to-end run above, with the test invoice deleted (`DELETE` →
  `{deleted:true}`, subsequent `GET` → gone). BF-052 is deliberately NOT probed — proving it needs
  a `POST /api/admin/invoices`, and that probe has no write path by design; the header says so, so
  its absence is not mistaken for coverage.

- **Lesson**: when an owner says "let me change anything", the answer is an audit of every refusal,
  not a fix for the one on screen — and each refusal has to be sorted into *theirs*, *ours*, and
  *ours but obsolete*. The dangerous category is none of those three: it is the refusal that does
  not announce itself at all.

---

## ERR-184 — BF-050 landed: credit lines save, and the workarounds came out — **RESOLVED** (2026-08-29)

- **Date**: 2026-08-29 · **Context**: The backend dev lifted the `>= 0` floor and sent
  `invoice-negative-zero-lines-backend-response-aug2026.md`. Verified against the deployed API
  before touching anything (commit `0c32a65`), then every workaround built around the old
  constraint was removed.

- **What is true now**, measured rather than taken on trust: a negative `unit_cost_excl_gst`, a
  negative `quantity`, a zero of either, a negative `supplier_cost_excl_gst` and a negative
  `freight_excl_gst` are all accepted on create, update and `/quote`; a credit **subtracts** from
  `goods_total_incl_gst`, so the free-shipping threshold is finally judged on what the customer
  pays; and `supplier_cost_excl_gst: 0` still round-trips as `0`, so the Paid toggle keeps working
  on a credit-bearing invoice.

- **Removed** — every one of these existed only because of the old floor, and a workaround that
  outlives its cause reads as a live limitation to the next person: the `price >= 0` guard in
  `quoteRequestBody`; `hasCreditLine` and the "Credit lines are not counted in the goods total"
  warning in the freight row; `validateInvoice`'s block on a credit row; and `saveErrorMessage`'s
  translation of the 400, whose own comment said "delete this branch when BF-050 lands, not
  before". The row note stopped saying a credit "can't be saved on its own" and now offers folding
  it into a discount as a **choice** about how the document reads.

- **Two claims in the response did not hold, and one is worth keeping.** §1 ask 3 says the backend
  accepts a negative-total document, deliberately unguarded so a **pure credit note** stays
  issuable. It does not: exactly $0 saves, one cent below returns **500 `Failed to create
  invoice`**. Isolated it properly first — negative prices, quantities and freight are all fine on
  their own, so it is the document total alone. Logged as BF-052. It blocks nobody, because
  `validateInvoice` already refuses a below-zero total — which is the guard the same response asked
  us to keep — but that guard is now the only thing between the operator and an opaque 500, and its
  test says so.

- **The negative-QUANTITY return model is real and correct.** Proved on a live invoice: 2 sold at
  $100 (cost $70) with one taken back reports `cost_excl_gst: 70`, `profit_excl_gst: 30` — revenue
  and COGS reversed together. Booking the same credit as `1 × -$100` would have subtracted the
  revenue while still adding $70 of cost. The editor's price box already sends `supplier_cost: 0`
  for a negative-price line, which is exactly what avoids the auto-snapshot trap the response warns
  about in §3.

- **Also fixed, and it was ours**: both document renderers tested `t.freight > 0`, so a negative
  freight printed as **"Free"** while still taking that money off the total. That render bug was
  the real reason negative freight was refused client-side; only zero is "Free" now, and the
  refusal went with it.

- **Owner action outstanding**: `sql/migrations/138_shadow_order_skip_non_positive_lines.sql` must
  be applied by hand in the Supabase SQL editor. Until then a credit line carrying a **resolvable
  product code** materialises in the shadow order as a `1 × SKU @ $0.00` sale, inflating
  product-level rankings and COGS for a product that came back. Description-only credit lines are
  unaffected either way, and that is what the editor sends.

- **Verified**: full suite **4286 pass / 0 fail**; `npm run probe:invoice-quote` **16/16** with §6d
  flipped back to "accepted and reduces the goods total" and a new §6e for negative quantities; the
  backend's own §7 acceptance list run against production; and the exemplar driven through the real
  editor — `$99.00` and `-$40.00` printing as two rows, `59.00 / 8.85 / 67.85`, saved and read back
  verbatim, with the freight row correctly reporting "$32.15 more for free shipping" off the
  post-credit total. Every test invoice deleted.

- **Lesson**: when a constraint is lifted, the workarounds are not optional cleanup — each one is a
  statement to the operator about what the system can do, and leaving them in keeps a limitation
  alive after it is gone. And verify the lift rather than the letter: two of the five claims in
  this response were wrong, and the one that mattered was only found by testing what the document
  did, not what a field accepted.

---

## ERR-183 — The credit line I shipped could not be saved; discounts now come off the line — **RESOLVED** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner tried to save an invoice with a −$40.00 credit row
  and was refused by the message ERR-181 had installed for exactly that case. The feature had
  shipped looking complete and could not reach the end of its own happy path.

- **My error, and where it was.** ERR-181's probe covered `POST /invoices/quote` and proved the
  quote endpoint refuses a negative price. I inferred the save path from that, wrote a translated
  error message for it, and shipped. What I did not do was ask whether the feature could be
  expressed AT ALL on a saved invoice — a question the probe I had already written was one case
  short of answering.

- **It cannot, by any route.** Probed against production:

  | shape | result |
  |---|---|
  | negative `unit_cost_excl_gst` | **400** — `must be greater than or equal to 0` |
  | negative `quantity` | **400** — `must be greater than or equal to 0` |
  | negative `line_total_excl_gst` | 200, **ignored** — goods total recomputed as `46` |
  | a `discount_excl_gst` key | 200, **ignored** — undiscounted goods total `113.85` |

  Every total is recomputed as `quantity × unit_cost_excl_gst` and both factors are floored at
  zero. A standalone credit row cannot exist on a saved invoice until BF-050 lands. No frontend
  arrangement changes that, and one that made the printed document disagree with the stored record
  would be worse than the bug.

- **Fix — the discount comes off the line it applies to**, which is the shape the service already
  stores, and is what the volume ladder has always done: write the net figure into `unitCost` and
  keep a display-only record of what came off. `discountSaving` + `discountNote` print as a
  sub-line under the description (the 5th slot of `invoiceDocRows`, already rendered by both the
  preview and the PDF). Totals, `buildPayload` and COGS needed no change at all, because
  `unit_cost_excl_gst` was already the net price.

- **The invariant the design rests on, and now a test**: for every line, what the document prints
  equals `quantity × what the payload sends`. The discount is rounded ONCE, into the price — never
  divided out at payload time, which is how a cent of drift between the customer's copy and the
  stored invoice would have got in. The recorded saving is then re-derived from what the price
  actually became, so a qty-3 line discounted by $10 reports the $9.99 that genuinely came off.

- **The typed credit row still works** — it is now an input gesture rather than a dead end. A
  negative line offers "Apply $40.00 to the line above", which folds it into a discount, inherits
  its description as the reason, and leaves the total untouched to the cent. `validateInvoice`
  blocks a leftover credit row naming that button, so the backend's 400 is never reached; the
  ERR-181 translation stays only as a backstop.

- **Three traps the exploration caught before they shipped.** (a) The discount could not reuse
  `volumePercent`/`volumeSaving`/`volumeQuantity`: `onFormInput` wipes that trio on every price
  keystroke and `applyQuoteToLines` wipes it again on the next quote, so a discount stored there
  would be erased by the keystroke that created it. (b) The `linePrice >= 0` guard that stops the
  volume ladder offering to overwrite a credit line stopped covering anything the moment discounts
  existed — a discounted line is manual AND positive, so "Apply volume price" reappeared and one
  click would silently undo the operator's discount. (c) `invoiceDocRows` hands its note callback a
  built object, never the line, so our supplier cost is structurally unable to reach a customer's
  invoice; widening that whitelist is the only way a new printable field gets through, and the test
  now also asserts nothing cost-shaped is ever in it.

- **A test of mine was passing for the wrong reason.** ERR-181's "the volume ladder never OFFERS to
  overwrite a credit line" used a quote fixture with `position: 1` against a draft line at index 0.
  The quote line matched no draft line, no badge was ever produced, and the assertion would have
  passed whether or not the guard existed. Found only because the discount version of the same test
  added a positive control. Both fixtures fixed, and the control kept.

- **Verified**: 25 new tests in `tests/admin-invoice-discount-aug2026.test.js`; full suite
  **4283 pass / 0 fail**; and proved end to end against production — an invoice with a discounted
  line **saved (201)** and read back `unit_cost_excl_gst: 59`, `line_total_excl_gst: 59`,
  `total_incl_gst: 67.85`, exactly the figures the document printed, then deleted (`DELETE` → 200).
  A side benefit visible in the browser: the discounted price now reaches the free-shipping
  calculation and correctly withdrew free shipping, which a credit row never could.

- **Lesson**: a probe that proves an endpoint rejects something is not the same as proving the
  feature can be expressed. Before shipping, ask what the *complete* successful path looks like and
  verify that, not just the error you expect to handle. And when a constraint turns out to be
  absolute, the answer is usually to change the shape of the data rather than to keep pushing on
  the constraint.

---

## ERR-182 — A custom product code was impossible, and the only way to find out was to be refused at Save — **RESOLVED (frontend)** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner asked whether products with a custom SKU can be
  added, and said they should be able to "enter anything within the invoice custom and it should
  work."

- **Two questions were tangled in one input box, with different answers.** Invoicing a
  NON-CATALOGUE item already worked — leave Product Code blank, type a description; that is how
  freight and labour lines have worked since ERR-071, and a control invoice saved last session
  with `product_code: ''` on every line proves it. What was blocked was typing text INTO the code
  box, and that is blocked by the API as well as the UI: `POST /api/admin/invoices` returns
  `400 VALIDATION_FAILED` with `details.unresolved` for a code that is not a real `products.sku`.

- **The block is load-bearing and stays.** The backend matches an invoice's line items **by SKU**
  when it materialises the shadow order, so a code that matches nothing drops the line and leaves
  a **paid order with zero line items** — ERR-071, invoices #3263/#3264 — which also resurfaces as
  a "no items recorded" DANGER card on the dashboard. Removing the gate was never an option.

- **The real defect was discoverability, not the rule.** The only way to learn that the box would
  not take your text was to fill in the entire invoice and be refused at Save. The escape hatch
  existed and was even written into the error ("or clear the code to keep it as a free-text
  line"), but it arrived at the worst possible moment and read as a rejection rather than an
  option.

- **Fix — split the two jobs the box was doing.** `code` (→ `product_code`) is the catalogue
  identity: a real SKU or empty, unchanged, still gated. `ref` (→ `product_ref`) is the operator's
  own reference: free text, never resolved, printed in the Product Code column by
  `invoiceDocRows()`. A custom line ships `product_code: ''`, so **nothing new can reach the SKU
  matcher** — which is why `utils/line-codes.js` needed no functional change and
  `admin-invoice-sku-integrity.test.js` still passes unmodified. Shipped with it: an **"Add custom
  item"** button mirroring "Add shipping charge"; the catalogue asked on **focusout** rather than
  at save, so an unknown code says so immediately and offers **"Keep as a custom item"** — one
  click, which MOVES the typed text into `ref` instead of asking the operator to delete it; and a
  cost box that says **"needs a cost"** rather than "auto", because nothing auto-fills a line with
  no product behind it and a blank cost prints the invoice at 100% margin on the list (BF-047).

- **Fail-soft, in both directions.** `resolveSkus` returns `null` when the catalogue is
  unreachable, which is "we could not ask" and not "not a SKU" — nothing is recorded and nothing
  is shown, so an outage of ours never accuses a perfectly good code. And the answers are keyed by
  the CODE STRING, never by row index: rows are added, removed and reordered, and an answer pinned
  to position 2 would end up describing whatever moved into position 2.

- **The storage gap is MEASURED, not assumed.** A live read showed line items carry exactly seven
  keys and no room for a reference, and unknown keys are dropped silently. Rather than hope, the
  editor compares what it sent against the echo (`refEchoMissing`) and shows a standing warning
  naming BF-051 when the key comes back missing. The check is by key PRESENCE, so a
  present-but-null ref reads as "column exists, empty" — meaning the warning **stops appearing on
  its own** the day the column ships, with no code change and nothing to remember to remove.

- **Caught in the browser, not by a test**: `markCreditRow` carried its own second copy of the
  cost-placeholder rules, so typing a price on a custom line silently reset the box from "needs a
  cost" back to "auto" — the right answer overwritten by a stale copy of the same question. Both
  now go through `costPlaceholder()`, pinned by a test that fails if any cost placeholder is set
  anywhere else.

- **Three source-pin tests had frozen an implementation rather than a rule** and were rewritten to
  say what they meant: `resetQuoteState` clearing a flag (was pinned as "that assignment is the
  last statement"), a freight line's cost placeholder (was pinned as the literal ternary, now the
  answer), and — the important one — "draftFromInvoice must not re-derive `kind`", which banned
  the word rather than the practice. A custom line IS restored from `product_ref`, and reading a
  stored field is the opposite of guessing a marker from prose the operator can rewrite. The test
  now pins that distinction.

- **Verified**: 26 new tests in `tests/admin-invoice-custom-item-aug2026.test.js`; full suite
  **4255 pass / 0 fail**; and driven in a real browser — typing `REFURB-01` into the code box
  answered "'REFURB-01' isn't a catalogue SKU · Keep as a custom item" on the row within seconds,
  one click moved it to the ref box, and the document printed
  `REFURB-01 · Refurbished drum unit · 1 · $180.00` with the internal margin reading
  `Cost of goods $120.00 · Gross profit $60.00 · 33.3%`. A real SKU typed on the next line still
  resolved and priced normally.

- **Confirmed by write, and cleaned up.** A test invoice carrying
  `product_code: ''` + `product_ref: 'REFURB-01'` **saved (201)** with its line, description and
  supplier cost all stored, and read back with the ref **dropped** — so the custom-item feature
  works end to end today and only the reference fails to persist. Deleted afterwards
  (`DELETE` → 200, `GET` → 404); no number left consumed.

- **The browser found a second flaw the tests could not.** The standing warning was rendered into
  the editor body, and `saveInvoice()` closes the drawer on success — so on the one path the
  operator uses most, it was painted into a body about to be thrown away and never seen. The flag
  is now read BEFORE `Drawer.close()` (whose `onClose` runs `resetQuoteState()` and clears it) and
  carried in the save toast; the standing note still serves Download PDF and Email, which auto-save
  without closing. Verified live: the toast reads "Invoice 3276 saved. Your refs print on this
  invoice and on the PDF the customer receives, but the invoice service isn't storing them yet
  (BF-051) — reopen this invoice and that column will be blank."

- **Lesson**: when one input is refused, ask what the field MEANS before asking whether the rule
  can be relaxed. This box was doing two unrelated jobs — backend identity and customer-facing
  display — and the request that looked like "remove a safety check" was really "these were never
  the same field." Splitting them delivered the feature and left the ERR-071 guard completely
  untouched.

---

## ERR-181 — An invoice could not carry a credit line, and the row that *could* printed without ever being validated — **RESOLVED (frontend)** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner asked to "allow negative values when I enter
  manually since they aren't allowed at the moment. It's just to show that the customer has
  already paid for one product and is getting another at a discounted price." That is a CREDIT
  LINE — its own row on the customer's document, rather than a quietly reduced price on the goods
  line with the reason lost.

- **The blocker was not the one it looked like.** `min="0"` on the Unit Price input is **inert**:
  the invoice editor is a `<div>`, not a `<form>`, nothing in `js/admin/` calls `checkValidity()`
  or `reportValidity()`, and `admin.css` carries no `:invalid` rule for `.admin-input`. `min` only
  shapes the spinner arrows — `t.value` has always returned `"-40"` and `onFormInput` has always
  written it into the draft. The real gate was one clause in `validateInvoice`,
  `if (!(num(l.unitCost) > 0))`, which every write path funnels through (`ensureInvoiceValid`
  gates Save, Email and Download). **It reported a refused negative with the same words an empty
  box gets — "unit cost required" — so a rejected figure was indistinguishable from a missing one.**

- **A live bug found on the way in.** `validateInvoice`'s phantom-row filter tested
  `num(l.unitCost) > 0`, while `invoiceDocRows()` — the single row projection shared by the live
  preview and the PDF — tests plain truthiness, and `num(-50)` is **truthy**. So a row whose only
  content was a negative amount **printed on the customer's invoice and landed in
  `preview_totals`**, while the validator skipped it and `realLines()` kept it out of
  `line_items`: the document the customer receives and the invoice on the server differing by the
  credit amount. It was unreachable only because the price could not be typed, and this feature
  would have made it routine. The two predicates are now pinned EQUAL by a test that enumerates
  candidate rows and asserts `printed === validated`.

- **Second bug, same family.** `min="0"` on the Freight box is inert for the same reason, and both
  document renderers print `t.freight > 0 ? money(t.freight) : 'Free'` — so a negative freight
  rendered on the customer's invoice as **"Free"** while still pulling that money out of the
  total. Now refused.

- **Fix (frontend).** The price rule became "a number of either sign" (`isPricedAmount` — blank
  and non-numeric are the only wrong answers; **$0 is now legal too**, an authored zero being a
  decision and an empty box an unfinished row). The `started` filter moved from `> 0` to `!== 0`.
  A new whole-document guard refuses a **total below $0** — an invoice that owes the customer
  money is a credit note — while **$0 stays legal**, since "you already paid for all of it" is the
  point of the feature. New `lineSupplierCost()` in `utils/invoice-math.js` says **a credit line
  has no goods behind it, so its cost is a KNOWN $0**; note the direction, because ERR-068's
  failure was reading an ABSENCE as zero and this reads a **SIGN** as zero, leaving `costOrNull`'s
  "an empty box is UNKNOWN" untouched for product lines (re-pinned to prove it). It is routed
  through `lineCostExGst`, `normalizeInvoice` and `buildPayload` so the editor's margin bar and
  the figure the backend stores cannot disagree.

- **Three silent wrong numbers caught in review, before shipping.** (a) Keying `lineSupplierCost`
  on "is there a cost here" rather than `cost_source === 'manual'` would let a *picked* product's
  auto-filled $30 cost stand against −$100 of revenue. (b) Reading only `unitCost` and not the
  saved `unit_cost_excl_gst` would make every reopened credit line read as cost-UNKNOWN,
  collapsing the invoice list's Profit column to "—" and reporting "nobody costed this", which is
  false. (c) `applyQuoteToLines` still pushed a **volume OFFER** onto a credit line built on a
  real product — one click on "Apply volume price $53.53" would turn "−$99.00 already paid" into a
  **+$53.53 charge** with a volume claim stamped on it.

- **The backend refuses it — measured, not assumed.** `POST /api/admin/invoices/quote` validates
  `unit_cost_excl_gst` as `must be greater than or equal to 0` and returns **400 over the whole
  request** for one negative line (`npm run probe:invoice-quote` §6d, added here). So
  `quoteRequestBody` keeps omitting negatives: a 400 would take down the courier dropdown and the
  free-shipping banner for every line, and `requestQuote` deliberately KEEPS the last good quote
  on failure, so it would freeze them displaying **stale pre-credit numbers**. The omission is
  therefore stated in the freight row — "Credit lines are not counted in the goods total above" —
  because an omission that changes a free-shipping decision must never be silent. The probe pins
  the refusal and **fires when it lifts**, since a probe that always fails is a probe nobody runs.
  Tracked as BF-050 with `readfirst/invoice-credit-line-backend-handoff-aug2026.md`.

- **The save path enforces the identical rule — confirmed by write.** `POST /api/admin/invoices`
  returns the same 400 with the same `details[0]`. The CONTROL is what makes that conclusive: the
  byte-identical payload with `+40` in place of `-40` created invoice **#3276**, which deleted
  cleanly (`DELETE` → 200 `{deleted:true}`, then `GET` → 404) — so it is the SIGN being refused,
  not the payload shape, and `DELETE /api/admin/invoices/:id` is live now (it 404'd in Jun 2026).
  The control also settled the open risk: `supplier_cost_excl_gst: 0` round-trips as **`0`**, not
  `null`, so `documentDrift()` stays quiet and the Paid toggle is safe on a credit-bearing invoice.
  `saveErrorMessage` translates that Joi string into plain English naming BF-050 rather than
  echoing `"line_items[1].unit_cost_excl_gst" must be greater than or equal to 0` at the
  operator — verified against the verbatim live response.

- **Verified**: 36 new tests in `tests/admin-invoice-negative-line-aug2026.test.js`; full suite
  4229 pass / 0 fail; `npm run probe:invoice-quote` 15/15; and driven in a real browser against
  the live API — `-40` accepted with no `min`, credit styling and the "0.00 — credit" cost
  placeholder applied live *while typing* (no re-render, per ERR-179), Internal margin
  `Cost of goods $54.00 · Gross profit $5.00 · 8.5%`, document rows `Ink Cartridge 1 $99.00` and
  `Already paid — invoice 3271 1 -$40.00`, Sub Total $59.00, GST $8.85, Total $67.85.

- **Lesson**: an attribute that looks like a guard may be enforcing nothing — `min="0"` on three
  inputs was cosmetic, because the form was never a `<form>`. Grep for what actually reads a
  constraint before believing it. And when two predicates both decide "is this row real", one for
  the customer's document and one for validation, they are the same question and belong in one
  test: while they disagreed, the invoice the customer received and the one on the server differed
  by the credit.

---

## ERR-180 — The Invoices SENT column could not show a resend of the one kind of invoice most likely to need one — **RESOLVED** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner asked whether the SENT column on the admin
  Invoices page shows that an invoice was *resent*, and counts the resends the way the Orders page
  now does (ERR-177). It half did. The answer took a live read to establish, and the live read is
  what found the bug.

- **What was already there**: the column has rendered a green check, a short date, and `×N` past
  one send since July 2026 (ERR-131), with a send-history modal behind a real server log
  (`GET /api/admin/invoices/:id/emails` — recipient, subject, delivery status, time). That is a
  *richer* record than Orders, which has to reconstruct sends from note sentinels on
  `order_events`. Nothing about it looked broken.

- **Why nothing looked broken**: `npm run probe:invoice-sent` (extended in this fix) reports
  **`email_count` is 0 or 1 on all 13 invoices — not one has ever been sent twice**. So `×N` had
  never rendered in production, not once. A counter nobody has seen fire is a counter nobody has
  seen fail.

- **The bug**: **5 of the 13 invoices carry a real `emailed_at` next to `email_count: 0`** (3267,
  3266, 3265, 3264, 3263 — sends that predate the log table). Resend one of those and the backend
  logs it, so `email_count` goes 0 → 1, `info.count > 1` stays false, and **the cell renders
  identically before and after the resend**. The one column whose job is to show a resend could
  not show it on the rows most likely to get one — an old unpaid invoice being chased.

- **The cause, and it is a repeat**: `sentInfo()` returned the server record and STOPPED —
  ```js
  const at = rec.emailed_at || rec.last_emailed_at;
  if (at) { return { at, ..., count: num(rec.email_count) || 0, source: 'server' }; }
  const local = readSentMap()[rec.id];      // unreachable for any stamped row
  ```
  So the localStorage backstop was dead code for every invoice the server had ever stamped, while
  `writeSent()` faithfully incremented a local `count` that nothing read. That is **exactly** the
  ERR-177 finding, unapplied one page over: **collapse at the point of DISPLAY, not at the point of
  READ.** Same family as ERR-167 — *if the fallback is the only branch that ever runs the guard is
  the bug*, inverted: if the fallback is the branch that NEVER runs, it is not a fallback.

- **The fix**:
  - `utils/send-history.js` (new) holds what both admin pages must agree on: `SAME_SEND_MS`,
    `mergeSends()` and `recordedSendsPhrase()`. `utils/order-invoice-sent.js` now imports the first
    two instead of keeping its own copies — one dedupe rule, not two that drift.
  - `sentInfo()` reads **both** sources, always, and returns `{at, to, source, sends[], count,
    floor}`. `count` is `max(email_count, locally recorded, sends.length)` — **a floor, never a
    total** — and `floor` is set whenever we know of sends we cannot enumerate.
  - The backstop became `inv_emailed_v2`: a LIST of sends plus a monotonic tally, migrated from v1
    on read (v1 is never written back, so a rollback still finds its data).
  - **The resend path hands `writeSent()` the count the cell claimed BEFORE the send.** That single
    argument is what carries a pre-log send across a resend the server cannot count for us, and
    what stops the tally rebuilding itself to 1 (ERR-177's near-miss, on this page).
  - Copy: `· sent 4 times` → `· 4 recorded sends`, `· or more` when it is a floor. Two pages on one
    admin must not describe one fact in two vocabularies (ERR-120/129/143). `—` now reads "No send
    on record", not "Not emailed yet" — the list row and this browser are all we asked.
  - The history panel lists a send this browser recorded that the log has not caught up on,
    labelled as such, and **stops** listing it the moment the log does — and shows those records
    inside the read-error branch as a floor, never promoted into a clean history.

- **Verified**: `node --test tests/*.test.js` (4213, 0 fail), including the 62 untouched Orders
  subtests proving the shared-module extraction changed nothing there. New
  `tests/admin-invoice-send-count-aug2026.test.js` (39) pins the legacy-resend case, the 2s dedupe,
  the v1→v2 migration, the append-not-rebuild rule, and the two pages' wording against each other.
  `npm run probe:invoice-sent` green, now reporting the `email_count` distribution and the legacy
  count as measured facts. Confirmed in the running admin at `localhost:3000/admin#invoices`:
  invoice 3267 seeded with the exact record one resend writes reads **`28 Aug ×2` · "2 recorded
  sends or more"**, survives a reload, and its history panel labels the local record and states the
  floor. No email was sent to any customer to test a counter.

- **Lesson**: **a counter that has never once incremented in production has never been tested.**
  `×N` had shipped a month earlier, had a passing unit test, and was unreachable in the case that
  mattered. Counting the live rows is what turned "it already does that" into a bug report — the
  same discipline as *count the non-null rows before designing against a column* (ERR-175).

---

## ERR-179 — Typing a product code was impossible: the quote reply rebuilt the grid and destroyed the input under the caret — **RESOLVED** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner reported that while typing into the Product Code
  box of the New Invoice editor, "the screen keeps refreshing or something and I get kicked out of
  the box and can't type anymore or see the dropdown." Screenshot showed a line with `lc` typed and
  no dropdown.

- **NOT a refresh.** Nothing on that page refreshes. Swept for it explicitly: no `setInterval`, no
  SWR poller, no autosave, no `visibilitychange`, no `window` focus listener anywhere in
  `js/admin/` that can fire while the drawer is open. The only two intervals in the admin are
  Control Center's 60s top-bar and cc-profit's reprice poll, neither mounted here. Believing the
  report's own words would have sent us hunting a timer that does not exist.

- **Cause**: the volume/freight quote. A keystroke in `code`, `qty` or `unitCost` arms
  `scheduleQuote()` (400ms, `invoices.js`), the reply lands in `applyQuote()`, and that called
  `renderLines()` — which is `host.innerHTML = lines.map(...)`. It replaced **every `<input>` in
  the grid, including the focused one**. So ~400ms after each pause, plus a round-trip, the node
  under the caret was discarded and rebuilt. Typing at a human pace re-armed it continuously.
  The `else` branch made it worse: it re-rendered even when `changed` was false, purely to repaint
  a badge.

- **The file already knew.** `renderLines()`'s `onPick` handler blurs the input first, with the
  comment "renderLines() below destroys the focused input". That mitigation was applied to the
  click-to-pick path and never to the quote reply — the one path that arrives unbidden.

- **Second fault, a leak.** Autocomplete menus are portalled to `<body>` (ERR-107), so they do not
  die with the row that owned their input; only `destroy()` removes them, and `blur` never fires
  for a node removed from the DOM, so the component's own hide-on-blur never ran either.
  `invoices.js` discarded every handle `attachProductAutocomplete()` returned and tore down nothing
  on close, so **every** re-render stranded two menus per product line in `<body>` permanently —
  and one that happened to be open when its row was wiped stayed on screen, unclosable. That is the
  "can't see the dropdown" half of the report.

- **Fix**: an async reply **patches cells, it does not re-render the container the operator is
  standing in** — the same ruling already recorded for the Orders profit column. New
  `utils/line-row-patch.js` (`patchQuotedLineRows`), shared by both editors. It is safe because of
  how narrow a quote is: `applyQuoteToLines` never adds, removes or reorders a row and never
  touches `code`, `description`, `qty`, `supplierCost`, `costSource` or `kind`. Price and badge are
  the entire surface, and both are cells.

- **Two guards, both tested by mutation**:
  1. **Never write the box under the caret** — `document.activeElement`, the rule `js/cart.js:2312`
     already applies to the cart quantity field. Extended to `setFreightValue()`, which had the
     same fault on the freight input, and to `renderShippingRow()`, which rebuilt the courier
     `<select>` out from under a keyboard user. The shipping row **defers and repaints on
     focusout** — a postponed render, not a skipped one.
  2. **A row-count mismatch returns `false`** and the caller does the full render. A patch that
     silently covered half a grid would describe the wrong lines.

- **Same bug, second surface**: `quick-order.js` had it verbatim (`renderLines()` unconditionally
  after a quote). It *did* keep `_acHandles` but in ONE list shared with the party picker, so
  draining on re-render would have destroyed that picker — which is why it never drained at all.
  Both editors now keep **two registers**: line handles die with the grid, top-level pickers with
  the drawer.

- **Also**: `refreshPreview()` ran on every keystroke and rebuilt the whole invoice document plus
  the COGS panel. It steals no focus (neither host holds an input) but it is the visible flicker
  that made the editor feel like it was reloading. Now coalesced to one paint per frame, cancelled
  on close.

- **Verified**: 24 new source assertions in `tests/admin-invoice-line-focus-aug2026.test.js`
  (mutation-tested — reintroducing the `renderLines()` call, dropping the `activeElement` guard, or
  moving the handle drain after the wipe each fail it), plus a real-Chromium run of
  `patchQuotedLineRows` against a fixture grid confirming **the caret stays at offset 1 between the
  `l` and the `c`** while prices and badges update around it. Full suite 4149 pass / 0 fail.

- **Tooling note**: `node --check inkcartridges/js/<file>.js`, the syntax gate named in MEMORY.md,
  **exits 0 even on a genuine syntax error** — Node 24 treats these ES modules as CommonJS because
  the package is not `"type": "module"`. Copy to a `.mjs` first. A green check there was proving
  nothing.

---

## ERR-178 — An invoice that qualified for free shipping was still billed for a courier: our own guess had been recorded as the operator's decision — **RESOLVED** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner raised a test invoice — one line at **$99.00 ex
  GST**, freight **$6.09**, total **$120.85**. The order qualifies for free shipping ($99.00 ex is
  **$113.85 incl**, over the $100 threshold), so it should have totalled **$113.85**. Their reading
  was that the threshold was being applied to the pre-GST figure.

- **The reported cause was NOT the cause, and checking that first mattered.** The threshold
  comparison is the BACKEND's, on `goods_total_incl_gst`, and it was correct. Measured read-only
  against production before writing a line of code:

  | typed (ex GST) | `goods_total_incl_gst` | `free_shipping_eligible` | `suggested_key` |
  |---|---|---|---|
  | $99.00 | 113.85 | ✅ true | `free` |
  | $87.00 | 100.05 | ✅ true | `free` |
  | $86.90 | 99.94 | ❌ false | `north-island:urban` |

  The frontend performs no threshold comparison anywhere — `freeShippingAvailable()` reads the
  backend's boolean verbatim. The green **"This order qualifies for free shipping — apply"** badge
  in the owner's screenshot was the CORRECT answer sitting beside the WRONG freight. Had the fix
  been made where the report pointed, it would have moved a correct comparison.

- **Actual root cause — WHEN freight is decided, and WHOSE decision it is recorded as.**
  `reconcileShipping()` adopted the backend's suggested courier rate the first time a quote returned
  with an empty freight box, and recorded it as `_freightChoice = suggested.key` — **the same field
  that means "the operator picked this"**. A quote fires on a line's **code or description alone**
  (`hasContent` is not about price) behind a 400 ms debounce, so the first quote of nearly every
  session lands with a goods total of **$0**: typing `99` passes through `9`, and an unrecognised
  code like the owner's `lc` never resolves a price at all. At $0 the backend correctly suggests a
  courier zone. From that moment `_freightChoice` was non-null, every later quote skipped the branch,
  and crossing $100 could only ever raise the small nudge button. **Reproduced exactly**: replaying
  the old branch over the owner's sequence yields freight $6.09 and a total of $120.85.

- **The same conflation had a second, older victim.** `resetQuoteState()` clears `_freightChoice` to
  `null`, and `draftFromInvoice`/`loadFromOrder` load an authored freight of **$0** for a record that
  **shipped free** — which is byte-identical to a blank draft. The first quote then dropped a courier
  rate onto an invoice that had shipped free. Same silent-overcharge family as ERR-174.

- **Fix — name the owner of the figure.** New `FREIGHT_OWNER_NONE|AUTO|OPERATOR` vocabulary and a
  pure `planFreightAutofill()` in `utils/invoice-quote.js`; `_freightOwner` in `pages/invoices.js`,
  session-only for exactly the reason `_freightChoice` is (`buildPayload`'s key set is walked by
  `setStatusViaFullUpdate` and diffed by `documentDrift`). **While the number is OURS it follows the
  quote** — crossing the threshold sets freight to $0 and toasts *"Free shipping now applies —
  $113.85 incl GST is over the $100 threshold"*. **The moment it is THEIRS we never touch it again**:
  picking from the dropdown, typing in the box, clicking "apply", billing freight as a LINE (the
  ERR-174 guard now disarms both halves), or opening a saved invoice / filling from an order all
  claim it, and they keep the offer-only nudge — they may be charging freight on purpose.

- **Made the basis legible.** `goodsTotalInclGst` and `freeShippingThreshold` were parsed by
  `normalizeQuote` and read by **nothing**. The row now prints *"…qualifies for free shipping
  ($113.85 incl GST) — apply"* and, below the threshold, *"$6.15 more (incl GST) for free shipping"*.
  The freight box and courier dropdown beside them are labelled ex-GST; **a row that mixed two bases
  without naming either is what made correct behaviour read as a GST bug.**

- **Two storefront threshold defects fixed alongside** (found while tracing, both pre-existing):
  `checkout-page.js` hard-coded `subtotal >= 100 ? 0 : 9.95` in its no-`Shipping` fallback — it
  bypassed the configurable threshold and quoted **$9.95, a fee in no rate table we have ever
  charged** (urban is $7.00 incl GST); now Config-driven, sourced from the cheapest loaded urban
  tier, and it logs that the calculator is missing. `legal-config.js` read
  `Config.FREE_SHIPPING_THRESHOLD`, **a property that does not exist** (it is
  `Config.settings.FREE_SHIPPING_THRESHOLD`), so the `$100` on `/shipping` and `/about` could never
  follow the API setting — and reading the right property eagerly would still have been too early,
  since the file evaluates before `Config.loadSettings()` resolves. Now a lazy getter, verified to
  track a changed setting. *Still literal in static page copy across nine HTML files — a threshold
  change is a copy change there.*

- **Verified**: full suite **4125 pass / 0 fail** (24 new in
  `tests/admin-invoice-free-shipping-autofill-aug2026.test.js`; the ERR-174 shape guard rewritten
  from a regex on the old inline condition to the behaviour it was really defending).
  `npm run probe:invoice-quote` **14/14**, including a new check 6c that straddles the boundary **in
  the gap between the two bases** — $87.00 ex ($100.05 incl) eligible, $86.90 ex ($99.94 incl) not —
  because checks 4 and 6 sat hundreds of dollars either side of $100 and would still pass if the
  backend switched to an ex-GST basis tomorrow. Then driven in a real browser: typed `lc`, watched
  freight auto-fill to **$6.09** at goods $0, typed `9` (held at $6.09), typed `99` → freight **0**,
  dropdown **"Free shipping (order over $100)"**, the toast naming **$113.85 incl GST**, and the
  document reading **Sub Total $99.00 · Freight Free · GST $14.85 · Total $113.85**. Then picked
  Auckland (Urban) by hand and re-quoted: freight held at **$6.09** with the nudge reading
  *"…qualifies for free shipping ($227.70 incl GST) — apply"*.

- **Lesson**: **an autofill recorded in the same field that means "the operator chose this" can never
  be revised** — presence was standing in for provenance, and the two diverge the moment a guess is
  made early. Related: the guess here was made *before the number it depends on existed*, because the
  trigger for re-pricing (a code or description) is not the input being priced. And: when a report
  names a cause, measure that cause first — the reported GST basis was correct, and the bug was one
  layer over.

## ERR-176 — The New Invoice pickers could not find a paying customer: one had never returned a row, the other never looked where he was — **RESOLVED (2026-08-28)**

- **Date**: 2026-08-28 · **Context**: Invoicing a customer normally starts from their order. Order
  `20260819000002` (Michael Wright, $922.99, sitting open in the Orders modal) could not be reached
  from **either** box at the top of the New Invoice editor: "Fill details from…" said *No matches*
  and "Existing order" found nothing either. Two independent causes, plus a third that only
  appeared once the first was fixed.

- **Root cause 1 — the order picker had never returned a row, for any query.**
  `GET /api/admin/orders` answers `{ok, data:[ …rows… ], meta}` — **`data` is a bare ARRAY** —
  and `AdminAPI.getOrders` hands `resp.data` straight back. The picker read
  `data?.orders || data?.items || []` off that array (`pages/invoices.js`), which is `[]` for
  every input ever typed, **a valid order number included**. Every other caller in the repo
  already normalised the shape (`pages/orders.js`, `pages/refunds.js`, `pages/customers.js`,
  dashboard's `firstArray`); this one call site and `loadFromCustomer`'s `od?.orders?.[0]` legacy
  address scrape were the two that didn't, so both were silently dead. Nothing logged, nothing
  threw: an unread envelope and an empty result look identical from the outside.

- **Root cause 2 — the party picker searched two of the three places a customer can exist.**
  Contacts (~9.4k rows) + Customers (33 rows), never Orders. Michael Wright is a **guest checkout**
  (`user_id: null`, details in `guest_email` / `guest_phone`): no account row, no contact row. He
  exists only as an order, so "No matches" was reporting **"not looked" as "not found"**.

- **Root cause 3 — found only by driving the real page: an order row is not a section, but it
  looked like one.** `components/autocomplete.js` decided flat-list-vs-sections by sniffing
  `Array.isArray(res[0].items)` — and an order row **carries `items`** (its line items). With the
  envelope fixed, the flat array of orders was read as sections and the dropdown rendered the first
  order's LINE ITEMS as pickable orders: one row reading `57ec187b-…-6f4a6c3ec947 · $0.00`. The
  duck-type had been harmless only because the array never reached the renderer. Sections are now
  required to look like sections all the way down — **every** element with a string `title` **and**
  an `items` array.

- **Two limits measured on the way, now stated instead of implied**:
  - `customers?search=` cannot match a multi-word name (`Mark Leask` → 0 rows, `Mark` → 1;
    first/last are separate columns). `searchParties` widens a multi-token query to its longest
    token for **Customers only** and re-filters on every token — Contacts and Orders both match
    multi-word server-side, measured, so they are left alone.
  - The order box's placeholder still promised **email**, which `AdminAPI.getOrders` routes to
    `customer_email=` — 0 rows for every real address (BF-046, unchanged here on purpose: refunds
    and Orders share that branch). The placeholder now offers order # / customer name, and an
    `@`-shaped query gets a message naming the limit instead of a bare "no matches". The request
    still goes out unchanged, so a backend fix needs no frontend change.

- **Fix**: new `js/admin/utils/party-search.js` owns ONE lookup for both surfaces —
  `ordersFrom`/`contactsFrom`/`customersFrom` envelope normalisers (the three endpoints do **not**
  share a shape), `searchParties(q, api)` returning Contacts / Customers / **Orders (incl. guest
  checkouts)** sections, and `orderToParty(order)` mapping an order to bill-to fields (flat
  `shipping_*` columns AND a `shipping_address` object AND the guest fallbacks). Picking an order
  there calls `loadFromOrderDetails` — details only: **no line items, no freight, no
  `source_order_id`** — and the toast says so, because importing the goods is what the separate
  "Existing order" picker does. Quick Order's byte-identical copy of the picker now calls the same
  search (that duplication is how the two came to share one blind spot), with a test pinning that
  neither page may re-grow its own contacts+customers fetch.
  `searchParties` returns `{sections, failed}`: a source that could not be asked is named in the
  empty state rather than counted as a miss.

- **Verified**: full suite **4101 pass / 0 fail** (15 new in
  `tests/admin-invoice-party-picker-aug2026.test.js`; the June contacts test now asserts the
  Contacts+Customers invariant where the search moved to). New read-only probe
  `npm run probe:invoice-pickers` — 10 hard checks green — which **imports the shipped module and
  drives it against the live API**, so it proves the code the admin actually runs reaches a guest
  order, and soft-notes the two backend limits above. Both pickers then driven in a real browser:
  the order box lists `20260819000002 Michael Wright · $922.99`, the email query explains itself,
  and the party box surfaces the same order under its own section.

## ERR-177 — The Invoice sent column kept only the newest send and threw the rest away, and a resend would have reset its own count to 1 — **RESOLVED** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: ERR-175 shipped an **Invoice sent** column that answers "when
  did this customer's invoice last go out?". The owner needed the fuller question: **every** time it
  went out, not just the last. The history was already being written — each resend appends its own
  `order_events` row — and then discarded at read time.

- **Root cause**: two deliberate "keep the newest" narrowings, one of which was about to become a
  visible lie. `getInvoiceSendEventsByOrderIds` collapsed each order's events with
  `if (!byOrderId.has(key)) byOrderId.set(key, row)`, and `newestSendEvent()` took the max — so the
  list column, the detail row and the resend path all saw exactly one send. Nothing was lost in the
  database; it was dropped on the way to the screen.

- **The finding that shaped it**: reading the live record back showed **the backend stores `note`
  and nothing else**. `recordInvoiceSend` wrote `payload: {kind, at, note}`; what came back was
  `{note}` alone — `kind` and `at` were silently dropped. Two consequences: the `[invoice-sent]`
  sentinel **in the note text** is the only thing identifying a send (the `payload.kind` branch is
  dead in practice, and kept only so it works the day the backend preserves payloads), and a send's
  time must always be the row's own `created_at` — the **server's** clock — never `payload.at`.
  The writer now stops sending `at` rather than writing a field it knows is discarded.

- **Fix**: `resolveSentInfo` takes `events` (plural) and returns `sends[]` + `count` alongside the
  existing state, merging the server `emailed_at` stamp with every recorded event, **deduped within
  2s** — because once BF-047 lands the backend will stamp the same resend we record ourselves, and
  one send would otherwise read as two. `at` is the newest send; the server still wins attribution
  at equal instants. The batched reader keeps an array per order and reports **`truncated`** when
  its 500-row scan fills, so a capped read can never quietly under-count.
  - Cell: `28 Aug ×3`, and now a **`<button>`** opening a send-history panel. `×N` only past one
    send (printing `×1` would invent a fact). `DataTable`'s row-click guard already skips
    `closest('button, a, input')` (`components/table.js:235`), so the click cannot also open the
    order behind it — verified in the browser, not assumed.
  - Panel: pure `renderOrderSendHistory`, rendered **from cache with no fetch** — which is why it
    carries none of the Invoices page's `_historyToken` machinery; there is no async response that
    could land in a stale modal. Reuses the existing `.inv-hist__*` CSS unchanged.
  - Detail row gains "2 recorded sends" opening the same panel, bound **delegated on the modal**
    because a successful resend replaces that cell's `innerHTML`.

- **The bug this was most likely to ship with**: the resend path rebuilt the state from the single
  send it had just written, which would have **reset the count to 1 on every resend** — the column
  contradicting itself immediately after the second send, correcting only on reload. It now merges
  into the cached `sends` list. Exercised for real in the browser with `window.API.post` stubbed on
  the two POST paths, so the true merge ran without sending a customer an email or writing a row:
  `28 Aug` → `28 Aug ×2`, both sends listed newest-first.

- **Counts are a FLOOR, never a total.** `emailed_at` is still NULL on all 126 invoices (BF-046), so
  the invoice emailed automatically at checkout is recorded nowhere. Every surface says "recorded
  sends", never "sent N times", and the panel states in as many words that earlier unrecorded sends
  may exist. Same discipline as ERR-175's "Not recorded" vs "Can't check".

- **Verified**: full suite **4100 pass / 0 fail** (62 in the invoice-sent file, up from 44).
  `npm run probe:invoice-sent` 9/9. Browser-driven end to end: single send has no `×N`; panel lists
  it with the caveat; the stubbed resend appends to `×2` with both rows; a failed lookup still shows
  the yellow "can't check" and renders no button at all. `APP_VERSION` was already bumped by a
  concurrent session (`2026.08.28-invoice-party-pickers`), which covers every page module.

- **Lesson**: "keep the newest" is a lossy read, and the loss is invisible until someone asks for the
  history that was there all along — **prefer collapsing at the point of display, not at the point of
  read**. And when a write's round-trip is never read back, silently-dropped fields go unnoticed:
  `{kind, at, note}` had been going in and `{note}` coming out since the day it shipped.

## ERR-175 — The Orders page could not say when a customer's invoice was last sent, and Resend Invoice recorded nothing at all — **RESOLVED (frontend) / OPEN (backend, BF-046)** (2026-08-28)

- **Date**: 2026-08-28 · **Context**: The owner needs to answer "when did this customer's invoice
  last go out?" — the first thing you check when a customer says they never received one. The
  Orders page had no answer anywhere, and its **Resend Invoice** button
  (`pages/orders.js`) fired `POST /api/admin/orders/:id/resend-invoice`, toasted, and
  **persisted nothing**: no record, no row repaint, and the response value discarded. Press it
  five times and the page looked exactly as it did before the first press.

- **Root cause (three layers, found by probing production, not by reading source)**:
  1. **The order payload has no send field at all.** Dumping the live keys of
     `GET /api/admin/orders` rows and `GET /api/admin/orders/:id` shows nothing resembling
     `emailed_at` / `invoice_sent_at`. There was nothing to render.
  2. **The field exists one table over, and nothing writes it.** `public.invoices` holds one row
     per order (`order_id`, `invoice_number` `INV-2026-0128`, `invoice_date`, **`emailed_at`**),
     created within seconds of purchase. `emailed_at` is **NULL on all 126 rows** — including for
     the invoice email the backend sends automatically at checkout. The column shipped; the write
     never did. Same shape as "mig 137 never landed" (ERR-170).
  3. **The obvious place to record a resend was closed.** `POST /api/admin/orders/:id/events`
     validates `type` against **exactly `[note]`** — a POST with `type: "invoice_sent"` returns
     `400 VALIDATION_FAILED`, `"type" must be [note]`. Discovered by probing, not assumed.

- **The trap that shaped the whole design**: `invoice_date`, `created_at` and `paid_at` all sit
  within seconds of one another, so any of them renders as a completely plausible "sent" date —
  and none is evidence that an email left the building. Showing one would have manufactured a
  record. **The resolver never reads them** (pinned by a test that feeds all four with
  `emailed_at: null` and demands `NOT_RECORDED`), and there is no backfill.

- **Fix**: new `js/admin/utils/order-invoice-sent.js` owns one vocabulary for the four surfaces
  that ask the question — a **five-state** resolver, because the ways to have no date are not one
  fact: `PENDING` / `SENT` / `NOT_RECORDED` / `NO_INVOICE` / `FAILED`. Precedence mirrors
  `sentInfo()` on the Invoices page: **server field wins**, our own record is the fallback. The
  rule that matters is that **an absence is only reportable when every source actually answered** —
  a hit still reports when the other source failed, but nothing-found while a source failed is
  `FAILED`, never `NOT_RECORDED`.
  - Data: `AdminAPI.getOrderInvoicesByOrderIds` / `getInvoiceSendEventsByOrderIds` — **two batched
    `in.(…)` reads for a whole page**, not two per row, over the existing `supabaseREST` helper.
    Both return `{ byOrderId, failed }`: the partial-ness is in the **return value**, so a caller
    cannot mistake "no row" for "couldn't look".
  - Write: `AdminAPI.recordInvoiceSend` writes `type: 'note'` with `payload.kind = 'invoice_sent'`
    **and** an `[invoice-sent]` sentinel in the note text — the text because it is the only payload
    field every existing row uses, and so the only one proven to survive; `kind` is read first so a
    real event type needs no reader change.
  - Surfaces: a non-sortable, non-owner-gated `Invoice sent` column (hydrated after paint, ERR-121);
    an **unconditional** row in the modal's Dates block (absence is the fact); and a Timeline entry
    that reads "Invoice email sent" with the sentinel stripped, rather than the literal word "note".
  - Resend: the record is written **outside** the send's `try`, gated on `if (sent)` — so a failed
    send can never stamp a date. Three outcomes, three messages: recorded → success; **sent but not
    recorded → `Toast.warning`** naming both facts; send failed → error. The cell only flips green
    when the record actually landed, so the column can't promise something the next load retracts.

- **Fixed alongside (latent, pre-existing)**: `AdminAPI.getOrderEvents` returns **`null` on failure**
  and `[]` when an order genuinely has no history; `buildOrderModalContent(modal, o, events || [], …)`
  collapsed the two, so **a failed history load rendered as "this order has no history"** — a clean
  empty state over a read error. Now passed through as `null` with its own loud branch. This became
  load-bearing the moment the send record started living in that list.

- **Caught only in the browser (and now pinned)**: `FAILED` is deliberately NOT cached, so a reload
  retries as its tooltip promises — but `patchSentCell` re-read the cache, found nothing for exactly
  those rows, and repainted them as "Checking…". A **spinner that never resolves hides a failed
  lookup even better than a wrong answer would**. The state is now handed to the repaint explicitly
  rather than looked up. Every unit test passed while this was live; only driving the real page with
  the two Supabase reads stubbed to 500 exposed it.

- **Verified**: full suite **4067 pass / 0 fail** (44 new in
  `tests/admin-order-invoice-sent-aug2026.test.js`). New read-only probe
  `npm run probe:invoice-sent` — 9 hard checks green; it confirms live that the frontend's exact
  five-column select works, that the four `admin_invoices` columns are correctly **400** on
  `public.invoices`, and reports the headline number: **0 of 126 invoices carry a send stamp**.
  `APP_VERSION` bumped to `2026.08.28-order-invoice-sent`.

- **Backend (open, BF-046…049)**: `readfirst/order-invoice-emailed-at-backend-brief-aug2026.md`.
  §1 asks for `emailed_at` to be stamped on the automatic checkout send — the root fix; everything
  else is reporting. It also asks the blunt question first: `emailed_at` being null on all 126 rows
  is equally consistent with "the backend sends and forgets to stamp" and "**it never sends at
  all**". If it is the latter, customers are not receiving invoices, which matters far more than
  this column.

- **Lesson**: when a feature's field already exists in the schema, that is not evidence anything
  writes it — **count the non-null rows before designing against it** (0 of 126 here). And when the
  observable truth is genuinely absent, the honest UI is a *distinguishable* blank: "Not recorded"
  and "Can't check" are different claims about the world, and a feature that renders them
  identically has quietly asserted an absence it never established.

## ERR-173 — The Orders page had a search that nothing could reach, and an email query that could only ever return nothing — **RESOLVED (2026-08-28)**

**Date**: 2026-08-28
**Context**: owner asked for "the ability to filter by name using a search bar" on `/admin#orders`. The
request read like a green-field feature. It was not: every part of the search except the input already
existed, and two of those parts were broken in ways nothing on screen could reveal.

**Root cause — three layers, all silent.**

1. **The box was never rendered.** `pages/orders.js` declared `let _search = ''` and sent it on every
   `AdminAPI.getOrders()` call, and the module exported `onSearch(query)` which synced
   `document.getElementById('order-search')`. That element had never existed in the SPA, and `onSearch`
   itself had no caller anywhere in the repo — the global admin search box it was written for had been
   removed at some point and took the only entry point with it. The same dead shape as ERR-167's
   `window.Security?.x` guards: the code reads as a working feature and executes as nothing.
   (`customers.js` and `products.js` still carry the identical dead `onSearch`; they at least render
   their own inputs, so only Orders was fully unreachable.)

2. **A `focus=` arrival filtered the list with nothing on screen saying so.** The one writer of
   `_search` was the `#orders?focus=<order_number>` deep-link from Tracking Requests. With no input to
   render the value into, an admin following that link saw a one-row Orders list and no indication it
   was filtered — indistinguishable from "the store has one order". Absence-as-zero, on the surface
   that is supposed to be the whole order book.

3. **Email search was a guaranteed-empty dead end.** `AdminAPI.getOrders` routes any query containing
   `@` to `customer_email=` instead of `search=`. Measured against production (`npm run
   probe:orders-search`, read-only): `customer_email=<any real address>` returns **0 rows** for every
   address in the table and **400s** when the row's `customer_email` is null; `search=<full address>`
   and `search=<local part>` both return 0 as well. Email is simply not searchable on this endpoint.
   The one apparent hit — `search=sean` returning a row for `sean@riderstudio.co.nz` — is a match on
   the **name** Sean Fleet, which is exactly the false confirmation that would have shipped the feature
   with an email promise in its placeholder.

**What the backend actually supports** (measured, not assumed): `search=` matches customer **name** and
**order number**, case-insensitively, as a **substring** (`search=ichi` → 3 Richie rows; `search=20260827`
→ 3 rows), and it **composes** with `status=` and the date range rather than overriding them. That is a
good filter — it just had no UI and one false promise attached.

**Fix.** Rendered the input into `.admin-page-header__actions` using the shared `.admin-search` wrapper
that already existed in `css/admin.css` (no new CSS), with `id="order-search"` — the id `onSearch()` had
been reaching for all along, so that method stopped being dead on arrival. 300ms debounce matching
Customers/Products/Invoices/Quick Order, but with the timer **module-scoped** so `destroyOrdersTab()` can
cancel it: switching to the Refunds tab tears down `_table` while the page stays mounted, and a keystroke
landing 300ms later would have called `loadOrders()` against a dead table (ERR-045 family; Customers and
Products both still leak a closure timer here). The query round-trips through the hash as `?q=`, merged
via a local `writeHashParams()` that preserves keys it does not own — the mirror of
`FilterState._writeToURL`'s `_OWN_KEYS` carry-through, so a date chip and a search no longer clobber each
other. `focus=` still wins over `q=`, and now renders into the visible box, which is what closes layer 2.

**The placeholder is load-bearing.** It says "Search customer name or order #…" and deliberately does
**not** say email, because the backend cannot do it. An email-shaped query still goes out (if the backend
ever gains email search it starts working with no code change) but the empty state names the reason —
`No match for "bob@example.com" — orders can't be searched by email address` — rather than the default
"No orders found", which on a customer search reads as the very different and false claim *this customer
has no orders*.

**Not fixed, deliberately.** The `@` → `customer_email=` branch in `AdminAPI.getOrders` is also behind
the Invoices editor's "Search order # / **email** to auto-fill…" box (`invoices.js:1896`, fed by
`getOrders({search:q})` at 2291) and refunds' order lookup. Changing it is a wider blast radius than this
request, and the visible outcome is identical either way (0 rows). Logged as a backend ask instead —
`customer_email=` returning 0 for every valid address is a broken param, not a frontend concern.

**Verified.** `npm run probe:orders-search` — new, read-only, 7 checks green with the email limit
recorded as an explicit note; it fails loudly if `search=` ever starts being ignored (the ERR-151 shape:
a nonsense token must return **fewer** rows than the unfiltered baseline, not the same 50).
`tests/admin-orders-search-aug2026.test.js` +14, including a pin that the placeholder never regains the
word "email" and that the hostile `?q=` case stays attribute-escaped. Full suite **4041 tests, 4022 pass,
0 fail**. A stale 10-day-old `.playwright-mcp/` directory was tripping `no-ghost-files` and was cleared.

**Lesson.** Dead plumbing is worse than missing plumbing: `_search`, `onSearch` and a `getOrders` param
all read as a finished feature during review, and the only thing that would have revealed the truth was
looking for the element the id pointed at. And when the backend contract behind a UI promise is
unverifiable from the repo, probe it before writing the UI — the probe here cost one script and caught a
promise ("search by email") that would have shipped as a box that silently returns nothing for every
address an operator typed. A green result from a *related* query (`search=sean`) is not evidence for the
query you actually mean.

---

## ERR-174 — Invoicing freight as a line item would have been charged TWICE: the courier-rate autofill fires on top of it — **RESOLVED (2026-08-28)**

**Date**: 2026-08-28
**Context**: owner asked for a way to invoice a shipping charge on its own, with no product —
"allow international freight for this", not just NZ zones. Found while building it, before it
could reach a customer.

**What the operator would have seen.** Click "Add shipping charge", type $150, fill the customer
in, save. The invoice totals $157.00 + GST, not $150.00 + GST. The extra $7.00 never appears in
the line items — it lands in the `Freight` box, which prints as one word in the totals block, and
nobody re-reads the totals of an invoice they just typed.

**Root cause.** `reconcileShipping()` (`pages/invoices.js`) has a convenience branch:

```js
} else if (_freightChoice == null && quote.shipping.hasOptions && !num(_draft.freight)) {
  // A brand-new draft with an untouched $0 freight box: adopt the backend's suggestion
```

It is correct for the case it was written for — a normal product invoice needs a courier rate and
should not need clicks to get one. But it reads "$0 freight + no option chosen" as *"the operator
hasn't decided yet"*, when on a freight-line invoice it means **"the operator has already decided,
somewhere else on the form"**. The quote is debounced, so it lands a second or two AFTER the
amount is typed: the autofill silently overwrites a deliberate $0 with a courier rate.

**Fix.** Adding a shipping line is itself the statement of freight intent, so it takes the choice
out of `null`:

```js
function suppressFreightAutofill() {
  if (_freightChoice == null) _freightChoice = FREIGHT_CUSTOM;
}
```

`FREIGHT_CUSTOM` is already what a hand-typed freight figure sets, and `renderShippingRow()`
already renders it as "Custom — typed above", so no new state and no new branch. An operator who
had already picked a courier keeps it — `== null` is the whole guard.

**Lesson.** An autofill's trigger is a GUESS ABOUT INTENT, and every new way to express that
intent invalidates the guess. `_freightChoice == null` meant "undecided" only while the freight
box was the single place freight could be entered. Adding a second surface for the same quantity
silently widened what "undecided" covered. **When you add a second way to say something, go and
re-read everything that infers meaning from the first one's absence.** Same family as ERR-150/160
(a feature that vanished at a whitelist parser and again at a call site).

**Verified live** (2026-08-28, localhost:3000 against the production API): one click on a fresh
draft → freight box held at `0` and the dropdown read "Custom — typed above" through a full quote
round-trip; document rendered Sub Total $150.00 / Freight Free / GST $22.50 / Total $172.50; saved
as #3275, reopened intact, PDF confirmed four columns; test invoice deleted afterwards.
Pinned by `tests/admin-invoice-shipping-line-aug2026.test.js` §1 (5 assertions).

**Also found, NOT fixed here** (logged as BF-046): the invoice LIST reports a freight line at
**100% margin**. The stored line correctly keeps `supplier_cost_excl_gst: null`, but the list
endpoint collapses that unknown to `cost_excl_gst: 0` / `profit_excl_gst: 150`, and
`normalizeInvoice` prefers server summary fields BY PRESENCE — so the frontend cannot honestly
override it. Mitigated at the source instead: a shipping row's "Our Cost" box now reads
`courier cost`, not `auto`, because nothing auto-fills a line with no product behind it.

**Observed once, not reproduced** (pre-existing, untouched): a `TypeError: Cannot read properties
of null (reading 'lines')` ×3 during a Playwright run that closed the drawer mid-autocomplete.
The quote path's `editorAlive(token)` guard is sound and the drawer's `onClose` bumps the token,
nulls `_draft` and `_editorRefs` atomically. The unguarded read is most likely
`attachProductAutocomplete`'s `onPick` (`invoices.js`, `const prev = _draft.lines[i] || {}`),
which touches `_draft` with no `editorAlive` check. Not in scope for this change; worth a guard
next time that file is open. See `project_admin_async_after_destroy_guard_jun2026`.

---

## ERR-172 — The Admin shortcut was `display:none` below 1100px, so an admin on a phone had no way into /admin but typing the URL — **RESOLVED (2026-08-18)**

**Date**: 2026-08-18
**Context**: owner reported "the admin centre button isn't available on phone UI".

**Root cause.** Not a bug — a deliberate trade-off that was never finished. The header shortcut is
injected into `.header-actions` by `main.js#initAdminHeaderLink()`, and `layout.css` carries a base
`.header-actions__item--admin { display: none }` that MODE D (`@media (min-width: 1100px)`) reverses.
The measurement behind it is real and still holds (ERR-148): below 1100px the cluster is icon-only
and every item holds its 48px `--tap-min` floor, so a fifth item measures 240px + gaps against a
~251px right track at 768px — it drives the cluster into the centred wordmark and, at 390px, wraps
the brand row outright. The four customer-facing items are not negotiable, so the owner-only one was
the one that went.

The half that was never built was the replacement. The CSS comment says "admins on a narrow viewport
can still type /admin", and that was accepted as the whole answer for six weeks. Typing a URL is not
an entry point; on a phone it is the least reachable action on the device. So the shortcut wasn't
broken, it was **absent with a rationale attached** — which is exactly the failure mode the
fail-soft rule names: the trade-off was recorded in a CSS comment and nowhere the user could see.

**Fix.** The same verified reveal now injects a second surface. `ensureNavItem()` (inside
`initAdminHeaderLink`, called from `ensureLink()`) appends an "Admin Centre" row to `#nav-menu`, the
mobile drawer — a vertical list, so it costs zero horizontal budget and the 1100px measurement is
untouched. `removeLink()` drops both nodes, so sign-out / role revocation clears the menu row too.

**The two surfaces are mutually exclusive by CSS, and that is the invariant to keep**: the drawer row
is `display:none` inside the same MODE D block that reveals the header shortcut. Exactly one Admin
entry at every width — never two, and never none. At ≥1100px the drawer has become the horizontal
five-link nav row and is already at its measured limit; a sixth link is precisely what clips (the
same measurement that set the 1100px gate in the first place).

Two details worth keeping: the row is JS-injected like its sibling, so no page ships `href="/admin"`
in static markup (the Jul 2026 Merchant Center rule — and `#nav-menu` lives *inside* `<header>`, so
the existing static-markup assertions already cover it); and the label is tinted
`--color-primary-light`, not `--color-primary`, because the drawer sits on `--steel-900` where
`#267FB5` measures **4.1:1** — under AA for a small uppercase label. The light tint clears ~14:1 and
still reads as the privileged colour the Business/Admin pair share.

**Verified.** Playwright at 390/1099/1200/1440px: at 390 the row renders last in the drawer, 48px
tall, fully inside the drawer's scroll bound, while `#header-admin-link` computes `display:none`; at
1099 the same; at 1200 the row is `none` and the header shortcut is `flex`, with the nav row not
clipping (`scrollWidth === clientWidth`); at 1440 MODE E's window-edge pin is unchanged. Stubbing
`Auth.isAuthenticated → false` and re-running removes both nodes. `tests/admin-header-link-may2026.test.js`
+4 (15/15), full suite 4001 green, `npm run build` restamped `main.js` + `layout.css`.

**Lesson.** A constraint that removes a feature owes a replacement on the surface it removed it from,
not a note in a comment explaining why the user can't have it. "They can still type the URL" is the
same shape as absence-as-zero: it reads as a decision in the source and as a missing button on the
device. When a measurement says an element can't fit *there*, ask where else it fits — the drawer had
room the whole time.

---

## ERR-171 — Loading an expense preset silently un-ticked "Already paid", so the one-click path was the only path that booked an unpaid bill — **RESOLVED (2026-08-18)**

**Date**: 2026-08-18
**Context**: owner reported it from the Add-expense drawer: save a preset, click the chip, and
"Already paid" comes back unticked every time — even though opening the drawer fresh has it ticked.

**Root cause.** Two code paths set the same checkbox and they disagreed. `freshDraft()`
(`js/admin/pages/expenses.js`) seeds `paid_date: todayInputValue()`, and the template renders the
box `${m.paid_date ? 'checked' : ''}` — so a blank Add-expense form is paid-by-default (that was the
deliberate change in `22ff120`). But `applyPreset()` ended its "re-anchor every date on today" block
with a hard `$('#e-paid').checked = false` plus `#e-paid-wrap` hidden. That line predates
paid-by-default and was never revisited when the default flipped, so the preset path kept the old
default while every other entry path moved on.

Consequence is quiet, not loud: `collectPayload()` only writes `paid_date` when `#e-paid` is
checked, so a preset-loaded expense saved with no `paid_date` — status `scheduled/overdue`, absent
from the cash-basis spend series and sitting in "Due (unpaid)" — while the operator believed they
had just recorded money that had already left the account. Nothing errored; the number simply
landed on the wrong side of the ledger.

**Fix.** `applyPreset()` now ticks the box and reveals the paid-date row
(`checked = true` + `classList.remove('hidden')`), matching `freshDraft()`. The paid date still
comes from the re-armed mirror — `paidDate.dataset.touched = ''; paidDate.value = $('#e-date').value`
— i.e. today's re-anchored expense date. **No date is read off the preset**: presets store none, by
design (`utils/expense-presets.js` strips `expense_date`/`due_date`/`paid_date`/`recurrence_end` on
the way in *and* out), because re-using an old bill's date on a cash-basis P&L books real money into
the wrong month. That rule is untouched here — this is a checkbox default, not a stored date.

A repeating preset also gets the tick, but the box lives inside `.exp-oneoff-only`, which `setType`
hides, and `collectPayload` reads it only when `type === 'none'` — so nothing leaks onto a series.

**Verified.** `tests/admin-expenses-presets.test.js` +3 (fresh draft is paid-by-default; applying a
preset leaves the box checked with its date row visible and never re-unchecks; the paid date
re-anchors on `#e-date` and `applyPreset` reads no date off the patch) — 26/26 in that file, and the
paid-mirror suite still green. `node --check` clean; `npm run build` restamped the admin bundle.

**Lesson.** When a default is flipped, the flip has to be chased into every path that *writes* the
same control, not just the one that renders it. A hardcoded `= false` sitting under a comment about
dates reads as date hygiene and survives the review that changed the default — grep the control's
id, not the feature's name.

---

## ERR-168 — Every discounted order overstated its profit, and reported $4.00 of GST on a $116.60 sale — **RESOLVED (2026-08-17)**

**Date**: 2026-08-17
**Context**: backend brief `order-profit-net-of-discount-aug2026.md`. Reported as a profit-column
overstatement; it was that, plus a GST row nobody had looked at.

**Root cause.** `utils/order-profit.js` built an order's revenue as `Σ(unit_price × qty)` over the
line items. Line items carry the price *before* any order-level discount. Since public volume
pricing shipped (Aug 2026) most orders also carry `orders.discount_amount` — the GST-INCLUSIVE
aggregate of volume + coupon + loyalty — and nothing in the admin read it. `discount_amount`
appeared **nowhere** under `js/admin/`. The data had been arriving on every payload and being
ignored: `AdminAPI.getOrder` returns the raw order row with no field whitelist.

So profit was overstated by `discount / 1.15` on every discounted order — $11.22 on the proof
order `20260817000002`.

**The half the brief did not mention.** `computeProfitBreakdown` derives
`gstCollected = customerPaid − revenue`. `customerPaid` (the order total) has ALWAYS been stored
net of the discount, while revenue was gross — so the two sides of that subtraction sat on
different bases. The waterfall reported **$4.00 of GST collected on a $116.60 sale**; the true
figure is $15.22. Netting the discount out of revenue puts both sides back on one basis and fixes
that row for free, which is the argument for treating a discount as a REVENUE REDUCTION rather
than as another deduction alongside the Stripe fee. Routing it through the cost side would have
fixed the profit line and left the GST line exactly as wrong.

**Fix.** `orderDiscountParts()` in `utils/profitability.js` (mirrors `absorbedShippingParts` — anchor
on the incl-GST figure, derive `gst = incl × 3/23`, derive `exGst = incl − gst` so the waterfall
foots regardless of rounding). `orderProfitFromDetail` nets it out and apportions it across the line
entries by ex-GST revenue share, BEFORE both `computeLineProfits` and `computeProfitBreakdown`, so
the per-line Profit column and the take-home cannot disagree (ERR-113). `totalRevenueExGst` is
re-totalled from the apportioned lines rather than computed as `gross − discount`: two
independently-derived totals drift by a float ulp, which is enough to break the
`Σ lineProfits === netProfit` invariant.

**Three UI decisions worth keeping:**
1. The items foot now shows `Line items $112.60` → `Order discount −$11.22` → `Revenue $101.38`.
   Without it the Price foot no longer relates to the unit prices above it.
2. **The cash waterfall gets NO discount row**, deliberately. It is anchored on `Customer paid`,
   which is already net of the discount; a `−discount` row there would double-count and stop
   Take-home footing. The brief's §4 mockup assumed a revenue-first breakdown and would have walked
   into exactly that. It is rendered as a qualifier on the opening figure instead.
3. Adjacent lie fixed: the UNKNOWN copy hardcoded "N of M items have no recorded supplier cost",
   but UNKNOWN is also reachable with `missingCostCount === 0` (the `!breakdown` branch, and now a
   discount at or above the line total). It printed "0 of 2 items have…". Now branches on the cause.

**Verification.** `npm run probe:order-discount` — a new READ-ONLY live probe. All four orders the
brief named reconcile: 12.90 / 8.15 / 6.62 / 2.40, and realised revenue reproduces the charged total
to within a cent. Confirmed in the real admin UI: revenue $101.38, take-home $37.91 → $26.69.

**Backend note:** `loyalty_discount_amount` is **absent** on the admin order route, though the brief
said it was exposed. Labelling only — the money comes from the aggregate — so it degrades to no
caption. Reported, not blocking.

**Tests**: `tests/admin-order-profit-discount-aug2026.test.js` (28), incl. an ENROLMENT sweep
asserting `order-profit.js` is the only place in `js/admin/` that accumulates order revenue — the
ERR-150/160 lesson that "every surface calls X" is a list nobody maintains.

---

## ERR-169 — A discount could be displayed and not deducted, and `Math.max(0, …)` was the silencer — **RESOLVED (2026-08-17)**

**Date**: 2026-08-17
**Context**: the owner reported "the discounts on bulk orders are showing, however they are not
added into the total price at the end." The backend investigated and concluded the cart was fine
and the screenshot showed a stale localStorage state. The cart *was* fine that day. The mechanism
that produces exactly that symptom was still there, and was invisible by construction.

**Root cause.** `cart.js` `computeDiscountBreakdown` ended with:

```js
other: Math.max(0, aggregate - loyalty - b2b)
```

The rows the shopper SEES are the components (`b2b`, `loyalty`). The total the shopper PAYS is
computed elsewhere as `subtotal − aggregate`. The whole design rests on `summary.discount`
containing the components — recorded as verified-live in a comment, and checked nowhere. The moment
it does not hold, the volume row still renders −$4.80 while the total deducts nothing, and the
clamp flattens the contradiction to a tidy zero on the way past. Absence read as a healthy zero,
the ERR-063/068/149 shape, with the clamp as the silencer.

**Second fault, same notice.** `serverSummary = null` was set at **eight** sites meaning two
different things — four genuine failures and four deliberate invalidations pending a mutation — and
carried no reason, so nothing downstream could tell "we could not price this cart" from "we are
about to re-price it". In production both were silent on every channel: `DebugLog` is a **no-op
outside localhost**, and `Cart.isUsingEstimatedPrices()` had **zero callers** in the entire repo
despite a docblock claiming checkout should be blocked on it. A shopper in that state is shown
local arithmetic, and local arithmetic contains no volume discount at all, because the ladder only
exists on the server response — so they see prices checkout will beat.

**Fix.** The clamp stays (a negative "You Save" row would be worse) but what it swallowed is
returned as `shortfall`. `PRICING.*` reasons replace the bare null, `_adoptServerSummary` /
`_losePricing` are the only writers, `_losePricing` takes **no default reason** so a new failure
path cannot inherit `PENDING` and vanish. One bounded re-fetch on a failed cart GET. A durable
`#cart-pricing-notice` (cloned from the ERR-136 removal-notice pattern) rendered from
`_renderDiscountRows` — the one function BOTH summary paths share, because those two drifted before
(ERR-110) and a gate wired into one of them passes by being skipped.

**Nothing is silently corrected.** The backend owns the money; a mismatch is disclosed, never
recomputed on screen. And the local fallback is kept — this makes it loud, it does not delete it.

**Tests**: `tests/cart-discount-footing-aug2026.test.js` (23).

---

## ERR-170 — Supplier cost was readable with the PUBLIC key, and the fix for it would have silently broken every curated ribbon rail — **RESOLVED (frontend) / OPEN (backend)** (2026-08-17)

**Date**: 2026-08-17
**Context**: backend brief §8 said migration 137 "revokes the column from `anon`" as done, and asked
the frontend to prepare for phase 2.

**Measured live, and the brief was wrong on the first point:** migration 137 has **not** landed.
`cost_price` was still readable with the anon key that ships in the frontend bundle — one
unauthenticated request returns **3,978 rows** of supplier cost and margin.

**And revoking `cost_price` alone would not close it.** `products` also carries `profit_ex_gst` and
`margin_pct`, both publicly readable, and each recovers the cost from the retail price
(`122.43 − 56.33 = $66.10`). All three columns have to go.

**The frontend trap.** `product-detail-page.js` resolved a ribbon's curated `related_product_skus`
with `select('*')`. Under column-level privileges PostgREST fails the WHOLE wildcard select with
42501 — so the moment the backend runs the revoke, that rail dies for **signed-out visitors only**
(signed-in users are the `authenticated` role and keep working). Worse, the query **discarded its
`error`**, so the failure rendered the empty state, which reads as "the owner curated nothing" — and
the error pane was gated on `info.category !== 'ribbon'`, so even once the flag was set the ribbon
path could never show it. Both halves fixed; the explicit column list was verified against the live
schema first, because **nine** plausible-sounding fields (`in_stock`, `average_rating`,
`review_count`, `canonical_url`, …) are API-computed and not table columns — an unknown column is a
hard 400, strictly worse than the wildcard.

**Ordering matters:** this fix must be DEPLOYED BEFORE the backend runs the revoke.

**Phase-2 unblocking.** Three of four admin `cost_price` reads are migrated:
`admin/api.js` `getRibbonProducts`/`getRibbonProduct` (both `select('*')`, both **unreferenced** —
narrowed rather than deleted so re-wiring one cannot reopen the hole; the brief listed only one of
them), and `components/product-search.js`, now REST-only — `/api/admin/products` returns
`cost_price` on list and detail, contradicting that file's own comment claiming no evidence it did.

**Still blocking (BF-044):** `pages/products.js` cannot drop it. Its Supabase branch exists because
`/api/admin/products` cannot express three of the page's filters (pack, supplier, product-type
group) and omits the sourcing fields the Supplier/Origin columns render. Dropping the column would
blank the owner's Cost column on the DEFAULT view or silently unfilter the list.

**Tests**: `tests/admin-supabase-cost-exposure-aug2026.test.js` (7, an enrolment sweep with one
documented exception that must justify itself), `tests/pdp-related-select-columns-aug2026.test.js` (12).

---

## ERR-167 — `window.Security` has never existed, so twelve escaping guards were an off switch — **RESOLVED (2026-08-17)**

**Date**: 2026-08-17
**Context**: found while mapping the admin invoice editor to add the volume-discount autofill. The
editor's `escA()` looked defensive. It was not defensive; it was off.

**Root cause.** `js/security.js:10` declares

```js
const Security = { … };          // and never assigns window.Security
```

A top-level `const` in a *classic* script creates a global **lexical** binding. It is reachable as a
bare `Security` from every other classic script and from the admin's ES modules — but it is **not a
property of `window`**. So `window.Security` is `undefined`, always, everywhere. Twelve call sites
were written as

```js
const escH = (s) => (window.Security?.escapeHtml ? Security.escapeHtml(String(s ?? '')) : String(s ?? ''));
```

and every one of them had taken the fallback branch since the day it was written.

**Severity is not uniform, and the worst one is in the invoice path.**
`js/admin/components/product-search.js:18` — the product picker used on every invoice and quick-order
line — had a fallback that returned the string **completely unescaped**, and its output goes straight
into `innerHTML`:

```js
<span class="admin-ac__pname">${escH(name)}</span>
```

Product names are catalogue data, editable in the admin and populated from supplier imports, so this
was a stored-HTML-injection path into the page the operator builds invoices on. The `escA` variants
degraded to `.replace(/"/g,'&quot;')`, which is adequate *inside* an attribute and wrong anywhere
else. `js/ink-finder.js:71` was the benign case — its fallback was a correct escaper, just a
narrower one than `Security.escapeHtml` (no `/`, no backtick).

**Why it stayed hidden.** The guard reads as good practice, the fallback is plausible, and the
output looks right for every product name that contains no markup — which is all of them, until one
does not. Nothing logs. Nothing throws. `js/account-settings-page.js` is the tell: line 9 guarded on
`window.Security`, and line 11 called `Security.escapeHtml` **bare** — two lines apart, one of them
wrong, both shipping.

**Fix.** All twelve now reference the binding directly, with no fallback:

```js
const escA = (s) => Security.escapeAttr(String(s ?? ''));
```

Files: `js/admin/components/{product-search,autocomplete}.js`,
`js/admin/pages/{invoices,quick-order,contacts,customers,expenses,business}.js`,
`js/account-settings-page.js`, `js/ink-finder.js`. Verified `security.js` is `defer`-loaded before
every consumer on all affected pages.

**Pinned by** `tests/security-escaping-guards-aug2026.test.js` — asserts `security.js` still declares
a bare const and never touches `window`, that no file anywhere under `inkcartridges/js` branches on
`window.Security`, and that no escaper helper has a fallback branch at all. Confirmed to fail (3 of
5 checks) when the old guard is reintroduced.

**Lesson**: the codebase already had this lesson written down, in `pages/invoices.js`, about a
`typeof AdminAuth` guard that silently deleted an entire column — *"A defensive typeof guard around
a missing import doesn't harden the feature, it deletes it. Import the thing and let it throw if
it's absent."* A guard that is always false is not a safety net; it is an off switch nobody can see.
The general form: **if the fallback branch is the only branch that ever runs, the guard is the bug.**
Grep for the guarded thing before trusting the guard.

---

## ERR-166 — The admin's "Delete Products" button calls an endpoint that does not exist — **OPEN (backend, BF-041)** (2026-08-14)

**Date**: 2026-08-14
**Context**: found while cleaning up `TEST-MBOX1`, a product created deliberately to verify the
`maintenance_box` create path (ERR-162). Creating it worked. Deleting it did not.

**What happens.** `DELETE /api/admin/products/:id` returns
`404 {"ok":false,"error":{"code":"NOT_FOUND","message":"Endpoint not found"}}` — note the message:
not "product not found", **"Endpoint not found"**. The route is not registered. Four plausible
alternatives were probed with a live owner token and all four 404 the same way:
`DELETE /api/admin/product/:id`, `POST /api/admin/products/:id/delete`,
`DELETE /api/admin/products?id=`, `DELETE /api/admin/products/sku/:sku`.

**So the UI is a button that cannot work.** `bulkDeleteProducts` (`js/admin/pages/products.js`
~4234) shows a confirm dialog saying "This will permanently delete N products. This action cannot
be undone", then calls `AdminAPI.deleteProduct(id)` per row → `API.delete('/api/admin/products/:id')`
(`js/api.js:3124`). Every call rejects. `Promise.allSettled` counts them, so the admin gets
`N deleted, 0 failed`… no: it gets `0 deleted, N failed` — the toast is honest. What is not honest
is offering the action at all, and phrasing the confirm as though the rows are about to go.

**Not fixed here.** The right fix is the backend route; hiding the button would remove the only
signal that products cannot be deleted, and stubbing a soft-delete would be inventing a contract.
Logged, and the FE-side follow-up (disable the action behind a capability check, or restate the
confirm) is queued rather than guessed at.

**Live residue.** `TEST-MBOX1` (`7f88d112-f0ad-4966-88b0-fdc6d66ae674`) could not be deleted, so it
was set `is_active: false` and renamed `ZZ DO NOT USE — FE acceptance probe 2026-08-14…` with the
reason in `internal_notes`. It is absent from `/api/products` and from anon Supabase reads (RLS
hides inactive rows). It needs one SQL `DELETE` whenever someone is next in the database.

**Lesson**: a destructive action's confirm dialog is a promise about what is about to happen. Nobody
had ever pressed it.

---

## ERR-165 — Every drum, fuser, belt and maintenance box on the site was headed "Ink Cartridges" — RESOLVED (2026-08-14)

**Date**: 2026-08-14
**Context**: found while checking where a `maintenance_box` surfaces on the storefront.

**Root cause**: `product-detail-page.js` `inferProductType()` bucketed Related Products into three
grids — ribbon, toner, ink — and *defaulted to ink*:

```js
return n.includes('toner') ? 'toner' : 'ink';
```

`buildTypeGrid` then titled the grid `${brand} ${label}` where label was `'Ink Cartridges'` for
everything that was not a ribbon or a toner. So the Related Products block on an OKI drum-unit page
read **"GENUINE OKI Ink Cartridges"** over a grid of drum units. Same for waste-toner bottles,
transfer belts, fuser kits — ~280 products, every one of them stating in an `<h3>` that it is
something it is not.

Invisible because it is *plausible*: a heading with the right brand and the right badge over the
right products. Only the noun is wrong, and nobody reads the noun on a page about a drum.

**Fix**: a fourth bucket. `DRUM_TYPES` (the drums family) → `'drum'` → **"Drums & Supplies"**, the
same words the customer clicked on the /shop tile. Name-led fallback added for rows with no
`product_type` (`drum`, `maintenance box/tank/cart`, `waste toner`, `fuser`, `transfer belt`).

**Verified live**: `GC5650BK` PDP heading now reads `GENUINE OKI Drums & Supplies` with 2 related
cards. `GT502` has no siblings, so its section stays correctly hidden — an empty section is the one
case where hiding is honest (ERR-134).

---

## ERR-164 — `createProduct` threw a bare Error, so the one write admins do least often told them least — RESOLVED (2026-08-14)

**Date**: 2026-08-14
**Context**: 2026-08-13, an admin creating the Epson T502 maintenance box typed the SUPPLIER's code
`E502` into SKU. The site SKU is `GT502`, which already existed. The toast said:

> Create failed: Failed to create product

They could not act on that, and neither could anyone reading it later.

**Root cause, two layers.**

1. The backend answered `500 "Failed to create product"` for a CHECK-constraint violation.
   `js/api.js:409` correctly returns 5xx as an envelope, so `resp.error` was that generic string and
   the toast faithfully repeated it. **Fixed backend-side**: it now returns `400 BAD_REQUEST` with a
   sentence naming the SKU, the grammar and examples.
2. `AdminAPI.createProduct` unwrapped the envelope with `throw new Error(msg)` — no `code`, no
   `status`, no `request_id`. `updateProduct` built its own Error by hand with all three plus the
   `(ref XXXXXXXX)` suffix. So the two sibling writes disagreed about how much of the failure
   survived, and create was the poorer one. This is the ERR-077/ERR-132 trap that
   `errorFromEnvelope()` was written to end — its own docstring says "Never construct a bare Error
   from an envelope again", eight hundred lines above two functions that did.

**Fix**:
- `productWriteError(resp, fallback)` in `js/admin/api.js` = `errorFromEnvelope` + the two things a
  product-write envelope carries: a `details` list appended as user copy (an object `details` is
  attached, never stringified — that is how a coupon suggestion once landed in an `alert()`), and
  the 8-char `(ref …)`. Both `createProduct` and `updateProduct` use it.
- `showProductWriteError(modal, prefix, e)` in `pages/products.js` for both save handlers. A
  ~250-char validation sentence gets 16s instead of the 6s default (the toast has no line-clamp, so
  it wraps in full), and when the rejection names a field the modal jumps to that field's tab and
  marks it with the same red border and inline note a blank required field gets. The tab index comes
  from `el.closest('.admin-product-modal__tab-panel')` — the New and Edit modals have **different**
  tab orders, so a hardcoded index would open the wrong one.

**Verified live**: creating with SKU `E502X` now shows the full grammar sentence in the toast AND
under a red-bordered `#edit-sku`. Screenshot in the FE response doc.

**Lesson**: two functions that do the same job in the same file will not stay the same. The one that
runs less often is the one that rots, and it rots where nobody is watching.

---

## ERR-163 — `maintenance_kit`: a filter option that had never matched a single row — RESOLVED (2026-08-14)

**Date**: 2026-08-14
**Context**: found by counting, while adding `maintenance_box`.

**Root cause**: `maintenance_kit` sat in `PRODUCT_TYPE_LABELS`, in the "All Types" filter menu, in
`PRODUCT_TYPE_TO_SHOP_CATEGORY`, in `API._CATEGORY_PRODUCT_TYPES.drums` and in three
`shop-page.js` consumable predicates. Live row count: **zero**. Not "few" — zero, and it is not in
the backend enum at all; the importer classifies "Maintenance Kit" / "Maint Kit" as `fuser_kit`.

This is `drum`/`paper` again (ERR-075), which the very module it lived in was created to prevent —
its header documents that exact lesson. A type filter with no matching rows does not error. It
returns an empty table, which is indistinguishable from "no products match your other filters".

**Fix**: `RETIRED_PRODUCT_TYPES = { maintenance_kit: 'Maintenance Kit (retired)' }` +
`productTypeLabel()` (canonical → retired → raw). Removed from every menu and every membership
list. **Retired loudly, not deleted**: a row that somehow still carries the value renders a human
label marked retired, and `buildSelect`'s legacy branch keeps it selectable so saving that row
cannot rewrite its type. Removing a fallback is a behaviour change, not cleanup (ERR-158).

**Gate**: `npm run audit:types` check `T8-retired-type-is-alive` fails if a retired type ever comes
back with rows, and `T1-offered-but-empty` fails for any *new* option that matches nothing.

---

## ERR-162 — A new backend product type was missing from all SIX frontend vocabularies, and nothing broke — RESOLVED (2026-08-14)

**Date**: 2026-08-14
**Context**: backend handoff `maintenance-box-product-type-aug2026.md`. On 2026-08-13 the catalog
gained `maintenance_box` for waste-ink collectors (Epson T502 / T366100, Epson S2100 tank, Canon
MC-G01 cart, Brother LEB445001). The brief scoped the frontend work as "**~2 small changes (one
`<option>`, one error-toast tweak)**".

**Root cause**: the frontend was carrying **six** independent product-type vocabularies. The new
value was in none of them:

| # | surface | what it silently did |
|---|---|---|
| 1 | `admin/utils/product-types.js` — the "All Types" filter | the 4 live boxes were unfilterable |
| 2 | `admin/pages/products.js` — New Product modal `<select>` | nobody could create one |
| 3 | `admin/pages/products.js` — Edit modal `<select>` (a byte-copy of #2) | GT502 rendered `maintenance_box (legacy)` |
| 4 | `admin/pages/products.js` — `generateSEO()`'s private label map | `typeLabel` fell to `''`: `Buy Epson T502␣␣NZ - Genuine \| …` |
| 5 | `js/api.js` — `_CATEGORY_PRODUCT_TYPES.drums` | manual code chips could not recover one |
| 6 | `js/shop-page.js` — three longhand `consumable` predicates | the brand facet counted 0 for products /shop was listing |

Plus `product-detail-page.js` `normalizeProductType` (fell through to `normalizeCategory('CON-INK')`
→ `'ink'`, so Related Products queried the wrong family — ERR-132, one line above the comment
describing ERR-132), `shipping.js` `maySplitShipment`, and
`PRODUCT_TYPE_TO_SHOP_CATEGORY` (which was also missing `fax_film`/`fax_film_refill`, live members
of `drums` since the IA reorg).

**Not broken — quiet.** None of those throw on an unknown type. A filter returns nothing, a
membership test returns false, a label map returns `undefined`. This is the fourth entry of this
exact shape: ERR-075, ERR-132, ERR-150, ERR-160. Every one was found by a person noticing.

**What was already right, and worth recording**: `buildSelect()` appends an unmatched value as a
pre-selected `"(legacy)"` option, so GT502 was **never** silently retyped to `ink_cartridge` on
save. The brief's data-corruption worry was already handled by a guard written for an unrelated
enum drift in May 2026. That guard is now covered by tests so it cannot be "tidied away".

**Fix**:
- `PRODUCT_TYPE_OPTIONS` in `admin/utils/product-types.js` = the backend enum verbatim, in backend
  order, `maintenance_box` after `waste_toner`. Both modals build from it; `generateSEO` takes its
  noun from it (`productTypeNoun`); the drawer labels through `productTypeLabel`.
- `CONSUMABLE_PRODUCT_TYPES` in `shop-page.js` replaces the three longhand predicates, and must
  stay identical to `API._CATEGORY_PRODUCT_TYPES.drums` — a facet count computed from a different
  list than the query it labels is a *wrong* number, not a missing one.
- While there: the meta-title fallback shortened in one jump from the full pattern to brand+code,
  throwing away the type noun even when it fitted. It now degrades one step at a time (drop the
  source qualifier first), so `Buy Epson T502 Maintenance Box NZ | InkCartridges.co.nz` (55 chars)
  survives where it used to collapse to `Buy Epson T502 NZ | …` (39).

**Two gates, because "every surface calls X" is a list nobody maintains (ERR-160)**:
- `tests/product-type-vocabulary-aug2026.test.js` — 26 tests. Declares the backend enum once and
  asserts every surface is enrolled; executes `buildSelect`, `generateSEO`, `normalizeProductType`,
  `inferProductType`, `maySplitShipment` and `productWriteError` rather than regexing them.
- `npm run audit:types` (`scripts/audit-product-types.mjs`) — READ-ONLY live oracle, no write path
  of any kind. Walks `/api/products` to exhaustion and fails **in both directions**: a type we offer
  with zero live rows, and a live type we do not offer. Negative-tested by temporarily adding a
  bogus type and removing a live one — both fired by name.

**Verified live** (admin, owner session, 2026-08-14): GT502's edit modal shows **Maintenance Box**
selected with no "(legacy)"; saving it untouched leaves `product_type = maintenance_box`; the New
Product modal offers it directly after Waste Toner; `TEST-MBOX1` was created as `maintenance_box`
and stored as such. 3843 tests / 3824 pass / 0 fail. `npm run audit:types`: 15 live types, all
enrolled.

**Lesson**: when a handoff says "one `<option>`", count the vocabularies first. The cost of the
missing option was zero errors and six wrong answers.

---

## ERR-161 — Customer order lines may not carry `source`, so order-detail badges went from wrong to absent — **OPEN (backend, BF-040)** (2026-08-12)

**Date**: 2026-08-12
**Context**: direct fallout of ERR-157. The genuine/compatible badge is tri-state now, so an order
line the backend does not classify renders nothing instead of asserting GENUINE. That is the
correct behaviour — but it may mean historical receipts lose a badge they used to show, and we
could not confirm either way before shipping.

**What is known.** `GET /api/admin/orders/:id` returns `order_items` with **no `source` field at
all** — keys are `id, product_name, name, sku, qty, quantity, sell_price, unit_price, price,
line_total, supplier_cost_snapshot, image_url, origin, suppliers`. Against that,
`order-confirmation-page.js` reads `item.product?.source || item.source` and gates on
`if (item.source)`, which is code written by someone who expected the field on the **customer**
route.

**What is not known.** The customer route `GET /api/orders/:id`. The admin test account has zero
orders of its own, and other customers' orders 403. Placing a real order to find out is not a
reasonable probe. So this is recorded as an open question rather than a verified state.

**Why we shipped anyway**: the alternative is keeping a default that says GENUINE — on an order
line, for a product we cannot classify. A missing badge is a smaller and more honest failure than a
false manufacturer claim, and it is *visible*, which a wrong badge is not.

**Asked**: BF-040 — project `source` onto `order_items` on the customer order routes, the same
one-field change already made for the cart. Filed in
`public-volume-pricing-FE-response-round2-aug2026.md`.

**Do not "fix" this by inferring from `product_name`.** That is precisely ERR-157, and
order-detail was its worst offender — an unanchored `.includes('compatible')` that also mislabels
genuine cartridges whose names mention printer compatibility.

---

## ERR-157 — The cart printed GENUINE on compatible cartridges for months, because a name regex broke and the badge had no third answer (2026-08-12)

**Date**: 2026-08-12
**Context**: the backend shipped `source` on the cart line (`items[].product.source` plus the
line-level sibling `items[].source`), answering ask 1 of `public-volume-pricing-FE-response-aug2026.md`.
Claiming it meant looking at what the field feeds.

**Two defects that were each survivable alone and were catastrophic together.**

### (a) The name fallback had been dead since May 2026 and nobody noticed

`Cart._isCompatible` read `product_source`, then a non-sentinel `source`, then — for legacy
localStorage rows — `/^compatible\b/i` on the stored **name**. That last branch was written when
compatible products were named "Compatible Ink Cartridge for …".

The May 2026 catalog rename moved the word out of first position. Live rows read
`"143ABK Compatible Toner Cartridge for HP 143A Black Neverstop Reload Kit"` — the word is *there*,
just not leading — so the regex returned **false for every compatible cartridge in the catalogue**.

A dead branch is not a bug on its own. This one was a bug because of what sat above it.

### (b) The badge was binary, so "cannot prove compatible" rendered as "GENUINE"

Four surfaces ended in `isCompatible ? 'COMPATIBLE' : 'GENUINE'` — cart, checkout, favourites and
order-detail. There was no unknown state. So the moment the field above the dead regex was empty,
the cart asserted an OEM manufacturer claim on third-party cartridges.

And it *was* empty, on the path that matters most: a locally-added row carried `product_source`
from the card's data attribute, but `GET /api/cart` did not project `source`, so `_parseServerCart`
wrote `product_source: null`. **One page reload after filling the cart, every compatible line
claimed to be genuine** — then `saveToLocalStorage` persisted the mislabelled row, so it stuck.

Measured on a real 11-line cart after a reload: 7 compatible lines badged GENUINE, 4 genuine lines
badged GENUINE. Every badge on the page said the same word, and four of them happened to be right.

**Why nothing caught it.** Three tests covered this area and all three passed, because they pinned
the *mechanism* rather than the *claim*: one asserted the regex was present and anchored, one
asserted the badge delegated to `_isCompatible`, one asserted the parser copied
`item.product.source`. Each was true. The parser was faithfully copying a field the backend wasn't
sending, into a helper whose fallback no longer matched anything, feeding a badge with no way to
say "I don't know". Nobody owned the sentence "the badge is correct".

**Why it looked right in review**: a name-based fallback for legacy rows is a reasonable idea, and
`/^compatible\b/i` is *carefully* written — anchored to the leading word specifically to avoid
overmatching description text. It is the conscientious version of the wrong instrument.

**Five rules for one question.** The audit found six surfaces classifying genuine-vs-compatible
and five distinct rules. The worst was `order-detail-page.js`:
`item.source === 'compatible' || (item.product_name || '').toLowerCase().includes('compatible')`
— unanchored, so it *also* labels a GENUINE cartridge COMPATIBLE when its name reads "compatible
with DCP-J1050DW". Two more (`shop-page.js` `adaptSuggestProduct`, `search.js` `adaptForCard`) read
`p.source || (p.is_genuine ? 'genuine' : 'compatible')`, which **invents `'compatible'`** for a row
carrying neither field, because `undefined ? a : b` takes the false branch. Only the PDP was right,
and it had been right all along: `source === 'genuine'` → GENUINE, `=== 'compatible'` → COMPATIBLE,
otherwise **hide the badge** — "we never assert a status we don't know".

**Fix**: `BrandSource` in `js/utils.js`, one vocabulary, tri-state.
`of(row)` → `'genuine' | 'compatible' | null`, reading `product_source` → `product.source` →
`source` (ignoring the cart's `core`/`cross-sell` namespace sentinels) → `is_genuine` *only when it
is a real boolean*. No name inspection at any level. `badgeHTML()` returns `''` for null, so the
four dishonest surfaces now render nothing rather than a claim. `_parseServerCart` reads both of the
backend's copies (`item.product.source || item.source`) so neither disappearing alone can dark it.

Note the two defaults point in **different directions on purpose**: the badge question resolves
unknown to *silence*, while the colour-tile question (`isCompatible()`) resolves unknown to *false*,
so an unproven row gets the neutral placeholder rather than a coloured gradient implying
third-party (the genuine-no-colour-tile invariant, ERR-143). Same field, two questions, two safe
directions. A single boolean could not express that, which is part of why it went wrong.

Also fixed while in there: `getColorPlaceholder` gated on `source && source !== 'compatible'`, so a
line with **no** source fell past the guard and painted a coloured tile — the invariant held for
proven-genuine rows and quietly failed for unproven ones, which is the population it most needed
to cover. Now `source !== 'compatible'`.

**Verified**: live guest cart, full page reload, signed out — 7/7 compatible lines COMPATIBLE, 4/4
genuine lines GENUINE. A line with `source` stripped from both copies renders no badge and the
string `GENUINE` does not appear.

**Test**: `tests/cart-line-source-aug2026.test.js`, built from the real payload captured that day —
including the exact product name that defeats the retired regex. It greps all of `js/` for the
three inference patterns that shipped and fails on any of them. Mutation-tested both directions:
restoring the binary badge fails 2 tests, sneaking the regex back into `favourites.js` fails the
fence and names the file.

**Lesson**: **a fallback is a claim, and a claim needs a way to say "I don't know."** The regex
failing was routine; what turned it into a compliance defect was a boolean with no third value, so
"unproven" and "genuine" were the same output. Where a label carries a factual assertion —
manufacturer, warranty, origin — the type must have an unknown, and the renderer must be willing
to print nothing. **And test the claim, not the mechanism**: three green tests each verified a
correct link in a chain that produced a false statement, because no test asked what the customer
saw. When a rule exists in more than one file it is not a rule, it is a coincidence — six surfaces,
five spellings, and the two that were right were right by accident.

---

## ERR-158 — Deleting a retired fallback is how a discount row goes dark silently, so we left a watchdog (2026-08-12)

**Date**: 2026-08-12
**Context**: the backend dropped the `b2b_discount` alias on 2026-08-10, as we'd cleared them to.
Confirmed absent from both the top level and `summary` on a live guest cart. Time to remove the
fallback readers in `cart.js` and `payment-page.js`.

**The near-miss**: the obvious change is to delete the `|| s.b2b_discount` arms and move on. But
that fallback existed precisely so a rollback on their side couldn't dark the row — and deleting it
restores exactly the failure it was insurance against, with the additional insult that it now
*looks* deliberate. A cart that loses its "Volume discount −$2.76" line still charges the discounted
total and still adds up. Nothing throws. The customer is simply never told why the number moved.
That is the ERR-063/068/073/149/150 shape: absence rendering as a confident nothing.

**Fix**: replace the silent fallback with a loud one. `_parseServerCart` no longer *reads* the alias
as a normal path, but it watches for an alias-only payload, logs it at **error** level naming the
date the backend dropped it, and honours it anyway. A rendered discount beats a correct-looking cart
that quietly lost a row.

**What was deliberately NOT changed**: `order-totals.js` still reads the alias. That file normalises
**orders**, not carts; the backend's note covered the cart response only, and an order stored before
the cutover keeps its spelling forever. Removing it there would zero the volume-discount row on
historical receipts — where nobody would notice, because the totals still add up. Commented in place
with the condition for removing it later (check a real pre-August order first).

**Also fixed**: `scripts/sweep-business-pricing.mjs` returned `null` when it couldn't read a cart, and
the consistency-gate test **skips** when the cart record is absent — so a hard cutover there would
have turned the gate off and gone green while checking nothing. Its own comment warned about this;
the warning would have been read *after* the cutover. It now returns a named reason
(`cart-empty`, `no-volume-discount-on-cart`, `no-credentials`) and the report says
"UNAVAILABLE (reason) — the consistency gate did NOT run" instead of "none".

**Lesson**: **removing a fallback is a behaviour change, not cleanup.** Before deleting one, ask what
it was insurance against and whether that risk expired — usually only the *likelihood* dropped, not
the *consequence*. The upgrade path is silent → loud, not present → absent. And a skip is not a pass:
any gate that can decline to run must say so by name, or its silence reads as agreement.

---

## ERR-159 — We reported a cache regression that did not exist, because `curl -I` sends HEAD (2026-08-12)

**Date**: 2026-08-12 (defect introduced 2026-08-09)
**Context**: our round-1 reply told the backend the catalog API was not being edge-cached at all,
with evidence:

```
curl -sI https://api.inkcartridges.co.nz/api/products?page=1&limit=20
→ cache-control: private, no-store, no-cache, must-revalidate, proxy-revalidate
→ cf-cache-status: DYNAMIC
```

**Root cause**: `curl -I` sends **HEAD**. The origin's cache-header middleware marked only `GET` as
cacheable; every other method got the hard `private, no-store` treatment. The header was real — for
a method no visitor ever uses. Real GETs were returning
`public, max-age=0, s-maxage=300, stale-while-revalidate=600` and going MISS → HIT the whole time.

**Why it was convincing**: the output was *specific*. A precise, plausible, correctly-transcribed
header, with `cf-cache-status: DYNAMIC` agreeing with it. Both facts were true and the conclusion
drawn from them was false. We also had a prior measurement to anchor against (ERR-124's
44 ms cached vs 205 ms uncached), which made "this regressed" the natural reading — the evidence
fitted a story we already had.

**Why it survived review**: `-I` is muscle memory for "just show me the headers", and it reads as a
formatting flag rather than a method change. Nothing in the output says HEAD.

**Fix**: `scripts/probe-edge-cache.mjs` + `npm run audit:edge-cache`. Real GETs, twice per endpoint,
asserting MISS→HIT, and it **refuses to issue HEAD** via a guard that throws — not a comment,
because a future edit adding `method: 'HEAD'` to make the probe cheaper would read like an
optimisation in review. It also separates two failures that look identical from outside: *header not
cacheable* (origin) versus *header cacheable but edge not storing* (Cache Rule).

**What the committed probe immediately found**, which the hand-typed one never could:
- `/api/search/smart` sends a fully cacheable header and is `DYNAMIC` on every request — the Cache
  Rule doesn't match `/api/search/*`. Search rows carry `quantity_breaks`, so the volume ladder is
  riding an uncached payload on every search. (BF-039)
- `/api/site/nav` sends `public, max-age=3600` and is also `DYNAMIC`. (BF-040)
- BF-014/BF-019 were **not** HEAD artefacts — `/api/ribbons`, `/api/printers/trending`,
  `/api/settings`, `/api/schema/site` genuinely return `private, no-store` to a real GET today.
- `/api/color-packs/config` now 404s while `js/api.js:1938` still calls it.

**Corrected**: the claim in `public-volume-pricing-FE-response-aug2026.md` §(a) (struck through
in place, with the correction beside it rather than rewritten away), the memory notes carrying it
forward, and — back to the backend — their "the same TTL the in-memory catalog cache already had":
`API.SWR_TTL_MS` is **60 s** for catalog GETs, not 5 minutes. The 5-minute TTL is taxonomy/schema/nav only.

**Lesson**: **measure the method your users use.** `-I`/HEAD, `OPTIONS` preflights and `?debug=1`
variants are all different requests than the one being debugged, and a server may legitimately
answer them differently. Deeper: a probe that lives in a document is a rumour — it cannot be re-run,
reviewed or regression-checked, and it outlives its own accuracy by being quoted. The correction is
not "be careful with flags", it is **commit the probe**. Ours has now found three real problems the
original was never capable of finding.

---

## ERR-160 — Every product surface but one showed the volume ladder, and the exception was invisible (2026-08-12)

**Date**: 2026-08-12
**Context**: found while verifying ERR-157. `js/search.js` — the smart-search typeahead dropdown —
renders product cards through `Products.renderCard`, the same component every grid uses.

**Root cause**: every other surface pairs its paint with `Products.decorateBusinessPricing(container,
products)`, which ingests the payload's `quantity_breaks` and overlays the bulk price:
`products.js`, `shop-page.js` (both browse and search-results), `landing.js`, `ribbons-page.js`,
`favourites.js`, the PDP. `search.js` contained **no reference to the pricing module at all** — the
string `Business.` appeared zero times in the file.

So a shopper saw "Bulk price $7.67 ea · Buy 3+" on `/shop` and nothing in the dropdown, for the same
SKU, one keystroke apart.

**Why it stayed hidden**: the card still rendered, with the correct retail price. The missing thing
was an *addition*, and an addition that is absent looks exactly like a product that has no volume
discount — which is a real and common state. There is no error, no gap in the layout, no console
warning. `Business.CARD_SELECTOR`'s own comment says listing the surfaces centrally is "what keeps a
shopper from seeing bulk pricing on /shop and not on /account/favourites" — the module had
anticipated this exact failure and still could not prevent it, because the selector only matches
cards someone has handed over.

**Fix**: one call after the dropdown paints, passing `renderedOrder` — the **raw** `/smart` rows, not
the `adaptForCard` copies. (`adaptForCard` spreads with `Object.assign` so the field does survive,
but handing a re-shaped copy to an ingester is precisely how ERR-150 happened.) Costs zero requests:
`/api/search/smart` already embeds `quantity_breaks`.

**Verified**: 13/13 dropdown cards decorated, signed out, with **zero** requests to `/api/business/*`.
Checked the footprint too — `search.css:836` hides `.product-card__badge` inside `.smart-ac__grid`,
but the overlay is a `.product-card__biz-price` in the price block, so it is unaffected and reads
cleanly in the tight grid.

**Lesson**: **"every surface calls X" is a claim about a list nobody maintains.** ERR-150 was the
same feature going missing at a *whitelist parser*; this was it going missing at a *call site*. Both
are silent because the surface still renders something plausible. When a capability is opt-in per
surface, the enrolment list belongs in a test — grep for the renderer and assert every caller also
calls the decorator — because the module's own selector cannot see the surfaces that never
introduced themselves.

---

## ERR-156 — A new analytics beacon passed 48 unit tests and sent nothing at all, because `window.Config` does not exist (2026-08-12)

**Date**: 2026-08-12
**Context**: the Aug 2026 search hand-off asked for one build — `POST /api/search/click` on
every search-results card click, so the backend can measure CTR by query and position. Pure
telemetry: no UI, no error state, no retry, and nothing on the page depends on it.

**Two defects, both invisible, both caught by a test rather than by reading the code.**

### (a) `Config` is not on `window`, and the beacon read `window.Config`

`js/config.js` declares `const Config = { API_URL: … }` at the top level of a classic
script. That binding lives in the global **lexical** environment: `Config` resolves as a bare
identifier from any other classic script, and `window.Config` is `undefined`. Verified in
the browser: `typeof window.Config` → `"undefined"`, bare `Config.API_URL` →
`"https://ink-backend-zaeq.onrender.com"`.

The first cut of `js/search-click-beacon.js` resolved its API base via `window.Config`, got
nothing, and returned `''` — so it never sent a single request. Every guard was correct, the
module armed, the listeners attached, the payload was built. Zero requests, no error.

**Why nothing noticed.** This is the worst possible failure mode for this specific feature,
because *every* signal that would normally reveal it is absent by design:
- fire-and-forget: nothing awaits a response, so there is nothing to log;
- `navigator.sendBeacon()` returns `true` once the request is **queued** — it reports nothing
  about the response, so 204 and "never sent" are indistinguishable;
- the only symptom is a table on a backend dashboard staying empty, which reads exactly like
  "customers aren't clicking search results."

**Why the tests missed it.** The vm sandbox did `sandbox.window = sandbox`, which is the
default reflex and is *wrong*: it makes `window.X` and bare `X` the same lookup, the one
thing a real page does **not** do for script-scoped `const`s. `window.Config` worked in the
sandbox and only in the sandbox. 48 tests passed against a global object shape that no
browser has.

**Fix**: read the bare identifier behind a `typeof` guard, exactly as `js/traffic-tracker.js:84`
already did — `if (typeof Config !== 'undefined' && Config.API_URL)`. `window.Config` is
still tried first, harmlessly, in case config.js ever starts exporting it. And the harness
now builds `window` as an object **distinct** from the sandbox global, carrying only what the
source actually assigns with `window.X = X` (`DebugLog`, `CompatSource`) — so the same class
of bug now fails the suite instead of passing it.

**Note the asymmetry that makes this a trap**: `DebugLog` and `CompatSource` *are* on
`window` (utils.js assigns them explicitly). `Config` is not. Three globals in the same app,
two reachable one way and one the other. Never assume — grep for the `window.X =` line.

### (b) Both card CTAs live *inside* the card's anchor, so "only the link counts" matched them

The guard was `target.closest('.product-card__link')`, on the reasoning that Add to Cart and
Contact us are not click-throughs and would therefore be excluded. They are not: they sit
**inside** `<a class="product-card__link">`, because `shop-page.js` keeps them `<button>`
elements precisely so a nested `<a>` won't auto-close the outer anchor. `closest()` walks
*up*, so it found the anchor and the beacon logged an add-to-cart as a click-through.

In the browser this was masked: those handlers call `stopPropagation()`, so the event never
reached the delegated container listener. A mask is not a guard — it made a real logic error
invisible at exactly the layer where it would have been caught.

**Fix**: `if (target.closest('button')) return false;` **before** the anchor test. Excludes
cart, contact, favourite and any control added later, by element type, independently of
whether anything calls `stopPropagation()`.

**Verified live** (localhost against the production API, which allow-lists
`http://localhost:3000`): click → one `POST /api/search/click` → **204**, body
`{"q":"toner","sku":"CC301BK","position":1,"page":2}`, request `Content-Type:
application/json`. Middle-click fires; right-click, Add to Cart and favourite do not. A
`/shop?printer_slug=` level painting 7 cards into the **same two grids** fired zero beacons.
The typeahead dropdown fired zero beacons **while the page beacon was armed**.

**Lessons**:
1. **A test harness that sets `window = globalThis` cannot see how a browser resolves
   script-scoped `const`s.** Model `window` as a separate object holding only what the source
   explicitly assigns to it. Otherwise the sandbox proves a global shape no browser has.
2. **For fire-and-forget telemetry, "the tests pass" is not evidence it works.** There is no
   runtime signal to fall back on, so one real end-to-end observation is mandatory before
   calling it done. Forcing the fetch fallback (`sendBeacon = () => false`) is the trick that
   makes the status code observable at all.
3. **`closest()` walks up, so "only element X counts" also matches everything nested inside
   X.** Check what the markup actually nests before trusting a `closest()` allow-list, and
   never let `stopPropagation()` elsewhere stand in for a guard here.

See `.claude/memory/project_search_click_beacon_aug2026.md`. Pinned by
`tests/search-click-beacon-aug2026.test.js` (50 tests); live contract guarded by
`npm run audit:searchclick`.

---

## ERR-151 — The business-applications endpoint accepts `user_id=`, ignores it, and returns the whole table, so a per-customer lookup would have named a stranger's company (2026-08-09)

**Context.** The one-click Business upgrade puts an "Upgrade to Business" button on the admin customer
drawer. Before offering it, the drawer should say what the customer's standing already is — already a
business account, application pending, or neither — because upgrading auto-closes any pending
application as superseded, and re-upgrading an existing account is a 409. The only readable evidence
is `GET /api/admin/business-applications`, which returns `user_id` on every row. The obvious call is
`?user_id=<the customer>`.

**Root cause.** That parameter is accepted and silently ignored. Measured against production:
`?user_id=00000000-0000-0000-0000-000000000000` — a UUID belonging to nobody — returns the full table,
and so does `?search=zzzznotreal`. Only `status=` filters, and it is Joi-validated, so a bogus *status*
400s loudly while a bogus *identity* returns everything quietly.

Had the frontend trusted it, `applications[0]` would have been treated as "this customer's
application" for every customer in the system. The drawer would have reported the first row's company
name — a real business, someone else's — as this customer's, marked them already upgraded, and hidden
the button. Every customer, one wrong answer, no error anywhere.

**Why it looked right.** The parameter is the obvious name, the endpoint returns 200, the payload has
the right shape, and the rows contain a `user_id` field — which reads as confirmation that the server
understood the question. Nothing in the response distinguishes "filtered to your customer" from "here
is everything".

**The fix.** `matchApplications(rows, userId, pagination)` in
`js/admin/utils/business-accounts.js` matches on `user_id` in the frontend, over rows fetched with no
identity parameter at all, and `AdminAPI.listBusinessApplications` refuses to send one — pinned by a
source-level test, because the trap is invisible at runtime.

The same function draws the line that matters afterwards: a page of rows can prove **presence**, but
only a complete read can prove **absence**. A partial or failed read that finds no match returns
`unknown`, never "not a business account", and the drawer renders that as a read problem rather than a
verdict. The endpoint caps `limit` at 100 with a 400 rather than clamping, so the read pages until it
has covered `pagination.total`.

**Verified:** live in the admin centre against production. The queue renders its one real row; a
customer with no application resolves to "Not a business account. No application on file."; a real
409 from the live endpoint renders "This customer already has a business account."

**The lesson.** ERR-075 was a filter whose bogus value returned **nothing**, silently. This is the
same defect pointing the other way, and the other way is worse: zero rows looks like a bug and gets
investigated, whereas a full table looks like data and gets rendered. **An accepted query parameter is
not an honoured one.** The test is one request with a value that must match nothing — if it comes back
full, the server is ignoring you. Run it before building anything on top of a filter, and do the
matching locally when the answer has to be right.

---

## ERR-152 — A fail-soft lookup pointed at a URL nobody had ever served, and "waiting for the endpoint" looked identical to asking the wrong question (2026-08-09)

**Context.** `standalone_invoices.business_account_id` is the one value that puts an invoice on a
customer's Business Centre. On 2026-08-03 no endpoint exposed a `business_accounts.id`, so
`AdminAPI.listBusinessAccounts()` was written to fail soft — resolve `null`, let the invoice editor
say the control is unavailable, and, in its own comment, "light up the moment the endpoint ships".

**Root cause.** It asked for `/api/admin/business-accounts`. Every admin business route the backend
actually serves sits under the `/api/admin/business/` prefix — `…/business/applications`,
`…/business/accounts`. The hyphenated path is in a namespace that has never existed for accounts, so
the call was not waiting for anything. It would have 404'd forever, and the day the real endpoint
shipped it would have kept on 404ing.

**Why it looked right.** Because a fail-soft read cannot tell you which failure it is having. `null`
meant "we could not ask", and "we could not ask" was true — the reason just wasn't the one written in
the comment. The UI state was correct, the tests were green, and the code was honest about its
uncertainty in every respect except the one that mattered. A promise that something will start working
later is only worth the URL it is pointed at, and nothing checks a URL that is expected to fail.

**The fix.** Repointed at `/api/admin/business/accounts` (still a 404 today — but now a 404 from the
namespace the backend uses, so it really will light up), with a test asserting the prefix so the guess
cannot come back. Accounts created through the new upgrade flow are merged in from the device-local
registry tagged `_source: 'device'`, and when every option carries that tag the invoice editor says so
in words rather than presenting a picker that implies the endpoint shipped.

**The lesson.** **A URL you expect to fail still has to be verified.** The whole point of fail-soft is
that nothing downstream notices, which is exactly why a typo, a wrong prefix or a retired path can sit
in one for months. When writing "this lights up when X ships", curl it once and record the status you
got and the date — a 404 from a real namespace and a 404 from a fictional one are the same response
and completely different facts. The sibling probe from ERR-140 is the tool: ask for a route you know
is bogus and compare.

---

## ERR-153 — The new business-account management endpoint is PATCH, and this API still refuses PATCH at CORS, so it cannot be called from a browser at all (2026-08-09)

**Context.** The one-click upgrade handoff pairs `POST /api/admin/business/accounts` with
`PATCH /api/admin/business/accounts/:id` for credit limit, Net 30 and suspend/close. Both were
verified live with curl before any code was written: 401 unauthenticated, correct 400/404 validation,
correct 404 for an unknown account id. Both work.

**Root cause.** Neither works from a browser. The API answers a PATCH preflight with

```
Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
```

— no PATCH — so Chrome kills the request before it is sent. This is **BF-021**, first measured
2026-07-25 for the invoice paid-toggle and still open. The invoice case had somewhere to go:
`PUT /api/admin/invoices/:id` exists, so `setStatusWithFallback` falls back to a full update. Here
there is nowhere: `PUT`, `POST` and `DELETE` on `…/business/accounts/:id` all 404, and
`X-HTTP-Method-Override` is not in `Access-Control-Allow-Headers`. PATCH is the only verb, and it is
the one verb the browser may not use.

**Why curl said it was fine.** curl does not do preflight. Every probe that verified this contract was
correct about the server and silent about the transport, because CORS is not a property of the
endpoint — it is a property of the browser's relationship to it. A route can be simultaneously live,
correct, and unreachable.

**The fix (frontend side).** The failure is named instead of dressed up. `isNetworkFailure()` — no
status and no code, because there was no response to read either out of — routes to copy that says the
request was **never sent**, that **nothing was changed**, and that it needs a one-line backend fix.
The generic `TypeError: Failed to fetch` would have read as a timeout, and a timeout is the single
interpretation under which the write might have landed. The local record is not mirrored on failure.

PATCH is still attempted first and directly, so the feature starts working the day BF-021 lands with
no frontend change — the invoices precedent.

**Still open, and now blocking a second feature.** Filed again in
`business-one-click-upgrade-FE-response-aug2026.md` as ask 1.

**The lesson.** **Verify a contract with the transport that will actually use it.** A curl probe
proves the route exists; it does not prove the browser may call it. When a handoff introduces a verb
this API has not used from the frontend before, send one `OPTIONS` with
`Access-Control-Request-Method` before writing the client — it costs one request and it is the
difference between shipping a feature and shipping a button that throws.

---

## ERR-154 — A slash-star inside a line comment swallowed 2.7kB of real code from the test suite's source stripper (2026-08-09)

**Context.** Structural tests in this repo assert against source with comments stripped, so a literal
in a docblock cannot satisfy an assertion. Two new source-level tests sliced
`AdminAPI.listBusinessAccounts` out of the stripped `js/admin/api.js` and both failed with
`Cannot read properties of null` — the regex had matched nothing.

**Root cause.** A comment written minutes earlier, explaining this very fix:

```js
// every admin business route lives under `/api/admin/business/*`. The comment
```

The stripper removes block comments with `/\/\*[\s\S]*?\*\//g` before line comments. That `/*` inside
backticks inside a `//` comment is, to a regex, a block-comment opener. It ran forward to the next
`*/` — the end of a JSDoc block 2,698 characters later — and deleted everything between: the whole of
`listBusinessAccounts`, `createBusinessAccount` and half of `updateBusinessAccount`.

**Why it was nearly missed.** The file was syntactically perfect and every runtime path worked; only
the test's *view* of it was mutilated. The failure mode is silent in the dangerous direction — a
stripped-away function makes `doesNotMatch` assertions **pass**. Had those two tests been written as
"this bad path must not appear" rather than "this good path must", the swallowed region would have
made them green, and the region a comment can eat is unbounded.

**The fix.** Write the prefix out (`the /api/admin/business/ prefix`) instead of glob-punctuating it,
with a note in place saying why. A repo-wide grep found no other instance.

**The lesson.** In a codebase whose tests read source as text, **`/*` inside a line comment is not
punctuation, it is an operator.** Prose in comments is normally free; here it can delete code from
every structural assertion in the suite. And the tell was available: a source regex returning `null`
means the anchor is gone, which is either a rename or — much more interesting — a stripper that ate
it. Print the stripped region before assuming the regex is wrong.

---

## ERR-155 — The portalled autocomplete sits below the modal backdrop on purpose, which makes it unclickable for the first autocomplete put inside a modal (2026-08-09)

**Context.** The new Business page picks a customer with `attachAutocomplete` inside a plain
`.admin-modal`. The menu rendered, the right customer appeared in it, and clicking did nothing.
Playwright named it exactly: `<div class="admin-form-help"> … intercepts pointer events`.

**Root cause.** ERR-107 portalled the menu to `<body>` at `position: fixed` to escape overflow
clipping, and pinned it at `z-index: 1150` — above `.admin-drawer` (1001) and
`.admin-product-modal` (1100), deliberately **below** `.admin-modal-backdrop` (1200) so a confirm
dialog would cover a menu left open behind it. That is right for every caller that existed. It is
exactly wrong for an input that lives *inside* the dialog: the menu paints, hit-testing hands every
click to the backdrop above it, and the control is inert.

**Why it looked right.** The menu was visible and correctly positioned. Nothing was hidden, nothing
errored, and a screenshot would have shown a working picker. Only a hit-test at the menu item's own
centre — `document.elementFromPoint` returning `admin-form-help` — showed what was on top.

**The fix.** `.admin-ac__menu--over-modal { z-index: 1250 }`, applied by `autocomplete.js` from
`input.closest('.admin-modal-backdrop')` — measured from the anchor rather than passed in by the
caller, so no future caller can forget it, and the default keeps holding for every autocomplete
outside a dialog. A test asserts all three z-indexes in relation to each other rather than by value.

**The lesson.** A stacking rule is written against the containers that exist when it is written, and
"below X so X can cover it" silently becomes "below X so X can *block* it" the first time the element
moves inside X. **When reusing a portalled component in a new container, hit-test it — do not look at
it.** `elementFromPoint` at the centre of the thing you mean to click is the one-line check, and it is
the only one that distinguishes visible from clickable.

---

## Scope note (no ERR number) — the homepage trust-stats band was removed; the footer one-liner is now the only mount point (2026-08-08)

**Not a defect.** ERR-125 shipped the trust stats deliberately invisible: `/api/site/trust` returned
`null` for all three counts because the backend's nightly sweep had never run, so both mount points
stayed `hidden` and would "switch themselves on later with no deploy". That is exactly what
happened — the sweep ran, and the homepage grew a band of three big-number tiles under the hero
trust bar reading `73+ CUSTOMERS SERVED · 81+ ORDERS SHIPPED · 100+ CARTRIDGES SOLD`, sitting
between the trust bar and the Ink Finder card. The owner did not want those counts that prominent
on the landing page and asked for the band gone.

**Removed** (homepage only, deleted outright rather than hidden — a permanently-hidden section is
dead code that the next reader has to re-derive): the `<section class="trust-stats">` and its
explanatory comment in `inkcartridges/index.html`; `loadTrustStats()` and its call site in
`js/landing.js`; the whole `.trust-stats*` block in `css/pages.css`. Also corrected the docblock on
`correctInkFinderScroll()` — it listed `#trust-stats` un-hiding as one of three things that shift
the Ink Finder scroll target mid-flight, and only two remain (header pins, mobile header collapses).
The scroll logic itself is generic and unchanged (ERR-137).

**Deliberately NOT removed.** The footer one-liner (`#footer-trust-stats` in `js/footer.js`,
`.footer-stats` in `css/layout.css`) renders the same three counts on every page and is now the
**only** surface — it survives by the owner's choice. `TrustStats` in `js/utils.js` is untouched:
`footer.js` and `seo-meta.js` (which delegates its `/api/site/trust` fetch to it so shared pages
issue one request, not two) both depend on it. Ripping the module out would have forced `seo-meta.js`
back onto its own fetch for no gain.

**Rule:** `TrustStats.band()` still returns `null` — never a string — for null/0/NaN, so the footer
can never read `0+` or `null+`. Absence is not zero (ERR-063/068/073/075/076). And re-adding a
homepage band is a **product decision, not a bug fix**: `traffic-conversion-jul2026.test.js` §2 now
asserts `index.html` contains no `trust-stats` and `landing.js` no `TrustStats`, so a well-meaning
"restore the missing social proof" fails the suite first.

**Verified:** full suite **3615 pass / 0 fail / 19 skipped**. Browser-verified (Playwright, bundled
Chromium) at 1400/1024/480px: band gone from the DOM, trust bar sits flush against the Ink Finder
band with a 0px gap and one clean divider (`.trust-bar` carries its own `border-bottom`, so nothing
had to be added back), no page errors, the hero "Find My Exact Cartridge" CTA still lands the finder
card correctly, and the footer line still reads `73+ customers served · 81+ orders shipped · 100+
cartridges sold` on both `/` and `/html/shop.html`. Cache tokens restamped (`npm run build`).

---

## ERR-150 — The cart's volume nudge was wired to a field the cart parser throws away, so it never rendered for anyone (2026-08-09)

**Context.** Volume pricing went public on 2026-08-08 (see ERR-149 and the public-volume-pricing
brief). `Business.ingest()` takes the ladder off the payload a page already fetched; six grids and the
PDP feed it, and so does the cart, because `/cart` is a surface a shopper can land on cold. The cart's
job is the per-line nudge — "add 1 more to reach 4+" — which is the entire point of a volume scheme.
It has never once rendered.

**Root cause.** `_parseServerCart` (`js/cart.js:1139`) maps each server line onto a **whitelist** of
14 named fields. It is not a spread; every field not named is discarded — `quantity_breaks`,
`price_snapshot`, `line_total`, `in_stock` and the line's own `id` all vanish at that boundary, by
design and for good reasons.

`decorateVolumeNudges` then read `i.quantity_breaks` off those parsed items. Always `undefined`.
`ingest()` correctly refuses anything without an array of rungs — its whole contract is that a missing
field means "not shipped yet", never "no discount" — so it skipped every line and returned 0. No
error, no warning, no nudge. The guard that exists precisely to stop absence being read as an answer
worked perfectly, on data that a layer above had quietly deleted.

Worse, the code *looked* careful. It mapped the lines explicitly and even carried a fallback,
`retail_price: i.retail_price ?? i.price`, with a comment justifying why `price` was a safe stand-in.
Both fields were undefined. The care was real and pointed at the wrong layer.

The same mistake was avoided one file away: for favourites I mapped from the RAW server payload
because I had noticed that `this.items` renames `retail_price` to `price`. Here I mapped from the
already-normalised local shape without checking what survived it — and the field I needed was
introduced by the backend the day *after* the parser was written.

**The fix.** Carry `quantity_breaks` and `retail_price` through the parser and hand the parsed lines
to `ingest()` unchanged — `Business.ingest(this.items)`, with no re-mapping to invent a shape. A test
asserts the parser preserves both fields, and a second one drives a realistic line through
`ingest` → `getLadderFor` → `nudgeMarkup` and asserts the rendered string says "Add 1 more to reach
4+", so the pipeline is checked end to end rather than one link at a time.

**The lesson.** A whitelist parser is a **silent** contract: adding a field upstream changes nothing
downstream, and nothing anywhere says so. When a new field has to reach a consumer, the boundary it
crosses is the thing to check first — not the consumer, which will look correct, and not the producer,
which will be sending it. The tell was available and I walked past it: I had already discovered, in
the neighbouring file, that this codebase renames and drops fields when it normalises. That is a
property of the layer, not a quirk of one function, and it should have sent me to read the cart parser
before writing a line against `this.items`.

Second tell, for next time: `ingest()` returns a **count**. Nothing called it in a context that looked
at the number. A fail-soft function that reports how much work it did is telling you to check, and
"0 of 3 lines" would have been visible from the first render.

---

## ERR-149 — An ungated summary row inherited a gated label, so widening volume pricing would have told every guest they had a "Business account" (2026-08-08)

**Context.** Work started on making volume pricing available to every shopper rather than approved
business accounts only. Before touching the pricing path, an audit of what the *cart* already does
turned up a row that needs no change to break: the B2B discount line.

**Root cause.** Two different things were gated by two different rules, and only one of them was
obvious. The **ladder** (PDP chips, card overlay, cart nudge) is gated hard — everything funnels
through `Business.getPricing()`, which returns nothing unless `getStatus().active`. The **summary
row** is gated by nothing at all: `js/cart.js:2124`, `js/checkout-page.js:559`,
`js/payment-page.js:297` and `js/order-totals.js:335` each print it whenever the server reports an
amount `> 0`. That was correct, and deliberately so — the server is the only thing that knows what it
charged.

The bug was in the label. `businessDiscountLabel()` (`js/cart.js:102`) read `company_name` off the
discount block and fell back to the bare string `'Business account'` when there wasn't one. That
fallback was only ever true by coincidence: while the backend applied this discount to business carts
exclusively, "discounted" and "business account" described the same set of people, so the label could
stand in for the gate. The moment the backend discounts a retail cart, a signed-out guest who adds
three of one item is shown **"Business account −$1.48"** — told they hold an account they never
opened, on the checkout page, in the totals block.

Note the shape: an **absent** `company_name` was read as evidence *about the shopper*. It means only
that the server declined to name a company. Same family as ERR-063/068/073/075/076 — absence read as
a value rather than as absence.

**The fix.** The fallback is now `Volume discount`, with `— {company}` still appended whenever the
server does supply a name, so a business customer still sees which account the discount landed
against. The four static defaults that ship in the markup (`html/cart.html:254`,
`html/checkout.html:410`, `html/payment.html:772`, `html/order-confirmation.html:145`) were changed
in lockstep — they are what a customer sees between first paint and the first cart response, so
leaving them would have reintroduced the same claim for a few hundred milliseconds. `order-totals.js`
carries its own copy of the fallback because the receipt PDF and order-detail do not load `cart.js`;
that one was changed too, and a test now asserts it.

Pinned by a dedicated test that loops the whole family of no-company inputs (`{}`, `null`,
`undefined`, a numeric `company_name`, a whitespace-only one) and asserts the result matches no
`/business/i` at all — so the next person to reach for a "sensible default" here has to argue with an
assertion that names the reason.

**The lesson.** When a renderer is deliberately ungated, its **copy** is part of the gate and inherits
none of the protection. This row was written to be driven purely by the server's number, which is
right — and then labelled with a claim that only the *other*, gated path had ever established. A
default string is an assertion; ours asserted the reader's account type from the absence of a field.
The tell was available in the diff-free state of the file: the row's condition mentions only an
amount, while its label mentions an account. Any time those two disagree about what they know, the
label is the one that's lying.

---

## ERR-145 — The Business Centre's "All" range asked for nothing, and the endpoint's no-parameter default is twelve months (2026-08-05)

**The change.** `/business` Overview was rebuilt into an admin-style **Performance overview**: one
banded SVG chart in place of two feature-less line charts, with range / bucket-width / per-period-vs-
running-total controls. For the first time the page sends `?from=&to=&granularity=` to
`/api/business/analytics/series` instead of the hardcoded `?granularity=month`.

**The bug.** `perfWindow()` returned `{from:'', to:''}` for the `all` preset and `seriesQuery()`
omitted both parameters — expressing "no filter" by sending no filter. That reads as obviously
correct, and it is wrong here: the endpoint documents its **no-parameter default as the last twelve
months** (backend brief §1). So pressing **All** returned a payload byte-identical to **12 months**,
under a button that said otherwise. Nothing errored, nothing looked broken, and the chart was simply
not showing two of the account's three years.

**It was caught by the feature's own honesty gates, on their first run against real fixtures.** Two
independent notes fired, neither written for this:

- `checkWindowAgainstLifetime()` — when the range is All and nothing is missing, the plotted buckets
  must add up to the lifetime totals, because both are the backend's own figures. It reported *"the
  periods plotted add up to $1,630.26 of bulk-order savings, but the all-time total reads
  $3,066.05 — a gap of $1,435.79."*
- The window echo — *"your first order was 13 Mar 2024, but this chart starts at 1 Sept 2025 — the
  server returned a narrower range than we asked for."*

The second sentence is slightly unfair to the server, which returned exactly what it was asked for.
That is the correct behaviour for the check: it names the observable discrepancy, and the reader
(here, the author) works out which side is wrong.

**The fix is not "send an old date".** Probed against production 2026-08-05, the endpoint neither
clamps nor rejects a wide floor: `from=2000-01-01` returns **320 monthly buckets**, nearly all empty,
and the chart becomes an unreadable smear. So **All** asks for `totals.first_order_at` — always known
by the time it can be clicked, because the first paint is the twelve-month default — and falls back
to a `2000-01-01` floor only when no payload has arrived yet. The unclamped behaviour is now printed
by `npm run verify:business` §1b as a measurement rather than hidden behind a threshold check that
would have quietly passed.

**Verified.** The live endpoint does honour all three parameters and echoes the window exactly;
`granularity=week` returns real weekly buckets. `npm run verify:business` 38 passed / 0 failed.

**The lesson.** "Send nothing" is not a neutral way to say "no filter" — it delegates the decision to
a server-side default, and that default may be a *narrow* one. A control whose off-state is an
omitted parameter is only as honest as the behaviour behind the omission: ask for what you mean. And
a consistency gate pays for itself the moment it catches the person who wrote it.

---

## ERR-146 — The demo fixture's daily base ran to `new Date()`, so after 11am it grew a row dated tomorrow (2026-08-05)

**Context.** `business-demo.js` was rebuilt onto a **daily** base that is aggregated up to monthly or
weekly buckets on request, so that switching bucket width cannot change the customer's totals — one
truth, two views. Lifetime totals are summed from the whole base; the chart plots whatever window was
asked for.

**The bug.** With ERR-145 fixed, the same consistency gate still fired, now with a $23.08 gap between
the all-time chart and the lifetime tiles. `buildBase()` measured its span as
`Math.round((new Date() - start) / 86400000)` against a **midnight** start. Run after about 11:00
local, the leftover fraction of a day rounds the span *up*, and the base gains one extra row dated
**tomorrow**. The lifetime totals include it; every window ends at `to=today` and clips it out. The
tiles therefore led the chart by exactly one day's trading — but only in the afternoon, which is the
kind of intermittence that gets blamed on the chart rather than the fixture.

**The fix.** Normalise to midnight before measuring:
`new Date(now.getFullYear(), now.getMonth(), now.getDate())`. `Math.round` is deliberately kept —
NZ daylight saving makes two days a year 23 or 25 hours long, and flooring would drop a day around
those transitions.

**Verified.** With `range=all`, the "In this range" line and all four lifetime tiles agree to the
cent, and the gate is silent.

**The lesson.** A "days between" span measured from `new Date()` is a time-of-day-dependent
off-by-one that is invisible every morning. Normalise both ends to midnight before subtracting. And a
fixture whose totals disagree with its own rows counterfeits a bug in shipped code — this one very
nearly sent someone hunting through `business-page.js` for arithmetic that was correct.

---

## ERR-148 — A header gap sized in `vw` inside a container capped at `1200px` got worse the wider the screen, and a fifth action item made it visible (2026-08-07)

**Context.** Three header changes shipped together: the IC brand mark took the left column's inner
edge, the Admin shortcut moved from that slot to the far right of `.header-actions`, and the action
cluster was re-centred in the white bar. The first two are a swap; only the third looked like a
layout change. In fact the *move* was the layout change.

**Root cause.** `.header-actions` had `gap: clamp(1rem, 3vw - 1rem, 2rem)` at ≥1100px. `.site-header`
deliberately re-locks `--container-max-width: 1200px`, so past a ~1230px viewport the container stops
growing while a `vw`-driven gap keeps growing. Measured: the right grid track is a flat **357px** from
1200px up, but the cluster's four gaps grew 109px → 128px. For an account that is both admin and B2B
the cluster is now **five** labelled items — 322px of items alone — so it ran 50px into the centred
wordmark at 1440px and **93px** at 1920px. The overlap got *worse* on bigger screens, which is the
opposite of where anyone tests.

A second, separate overflow sat below 1100px: there the cluster is icon-only and every item holds its
48px `--tap-min` floor, so five items measure 240px + gaps against a ~251px track at 768px, and at
390px they wrapped the brand row outright.

**The fix.** Two levers, both measured before being chosen (five candidates were diffed in a real
browser at six widths):

- Gap that tops out instead of running away — `clamp(var(--spacing-2), 1vw, var(--spacing-4))`.
- `padding-left/right: 0` and `min-width: 0` on `.header-actions__item` at ≥1100px only.
  `--tap-min` is a **touch** floor; ≥1100px is a pointer device, `min-height: 48px` is untouched, and
  the narrowest item (Cart, ~32px) still clears WCAG 2.5.8's 24×24 by a wide margin.

Worst-case clearance went from **−50px (overlapping)** to **+17px** at 1100 and ~+50px above it.
Below 1100px the fifth item is simply not affordable, so Admin is `display:none` there — shrinking
the items instead would put sub-48px touch targets on tablets, which is the worse trade.

**The lesson.** A `vw`-based length inside a max-width container is a bug waiting for a trigger: the
two stop agreeing at the cap, and the error grows without bound in the direction nobody checks.
Size against the container, not the viewport, or clamp to a real ceiling. And "move an element from
A to B" is never neutral when A and B have different width budgets — the element that left made room,
the one that arrived took it, and only one of those is visible in the diff.

---

## ERR-147 — `.visually-hidden` does not clip a `<table>`, so the screen-reader data table scrolled the whole page sideways (2026-08-05)

**Context.** The new chart module ships a `visually-hidden` table of buckets × series, so the figures
are readable without sight rather than locked inside an SVG. At a 375px viewport,
`document.body.scrollWidth` measured **555** against a client width of 375. Removing that one table
from the DOM restored it to exactly 375.

**Root cause.** `.visually-hidden` in `css/base.css` uses the standard recipe —
`position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0)` — and that recipe
works on a block box. **`overflow` does not apply to a `display:table` box.** The table laid itself
out at its full natural width and contributed that width to the page's scrollable overflow. Because
`clip` only suppresses *painting*, nothing was visible: the page simply scrolled sideways with
apparently nothing in the extra 180px.

**The fix.** Wrap it: `<div class="visually-hidden"><table>…</table></div>`. A div honours
`overflow:hidden`. A test pins the wrapper specifically, with the reason in the assertion message so
it does not get "tidied" back onto the table.

**The lesson.** The visually-hidden recipe is not element-agnostic. Anything that brings its own
layout mode needs a plain block wrapper to be clipped by it. And accessibility markup is still
layout — after adding any off-screen content, measure `body.scrollWidth` against
`documentElement.clientWidth` before assuming it costs nothing.

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
