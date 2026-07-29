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
