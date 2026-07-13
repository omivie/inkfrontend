# Errors Log — InkCartridges.co.nz

Log every error encountered here. Before editing a file, scan for known issues. When a familiar error reappears, apply the known fix immediately.

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
first. Deliberately left inert during the appeal window (owner's call, 2026-07-14). See
`.claude/memory/todos.md`.

**Mitigation already shipped:** `legal-page.js` now screens every override against
`LegalConfig.BANNED_CLAIM_PATTERNS` before the `innerHTML` write, so whenever the CMS *is*
repaired it cannot reintroduce a banned claim. Proven end-to-end in Chromium: a malicious
override carrying the banned paragraph is rejected and the vetted static copy survives, while a
benign edit still applies.

**Wider lesson:** a `curl`-based compliance check cannot see SPA-injected copy. Any "prove it's
fixed" grep must be run against the **rendered DOM**, not just the served HTML — AdsBot executes
JavaScript.

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
