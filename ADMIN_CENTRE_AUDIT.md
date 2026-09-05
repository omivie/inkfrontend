# Admin Centre Audit — InkCartridges.co.nz

_Last updated: 2026-09-05. Reflects the **July 2026 IA overhaul** and the **September 2026
Analytics pass** as implemented (not proposals)._

The admin console is a hash-routed, vanilla-JS ES-module SPA served at `/admin`
(`inkcartridges/html/admin/index.html` → `inkcartridges/js/admin/app.js`). There is no
build framework; page controllers are lazy-loaded from `js/admin/pages/`. This document is
the human-readable companion to the durable contracts pinned in
`tests/admin-ia-overhaul-jul2026.test.js` (July) and
`tests/admin-analytics-section-sep2026.test.js` (September).

---

## 0. September 2026 — the Analytics section, and hub tabs became addressable

The owner's ask was one sentence: *"one dedicated section in the admin side bar instead of the
multiple which would hold all the analytics sections we have neatly organised and placed."*

**What changed**

1. **A dedicated `Analytics` section**, between Overview and Sales, holding every read-only
   reporting surface: the hub (`#analytics`), Demand Ranking, Catalogue Engagement and Price
   Monitor. They previously sat in three different sections (§3 below).
2. **Every section is now a collapsible group** — the deferred §8 item 9, below, is done.
3. **The hub's seven tabs render as indented sub-links** under it, from the same manifest the
   hub's own tab bar uses.
4. **`#analytics?tab=…` became a real address** in both directions (ERR-208).
5. **Labels**: `analytics` reads **"Performance"** in the sidebar (was "Finance"). Under an
   ANALYTICS header, "Finance" misnames a hub whose seven tabs include Traffic and Acquisition.
   The route key is unchanged, so every deep link and redirect still resolves.

**What did NOT move, and why.** *Expenses* stayed in Finance — its Overview tab reports, but its
other two tabs are data entry, and it is a ledger you write. *Supplier Prices* stayed in Catalog —
it reports, but its day job is mapping supplier lines to products. *Dashboard* stayed in Overview:
it is the landing page, and it is the only analytics surface a non-owner admin can see at all.

### The `?tab=` routing contract (read this before adding a hub tab)

Hubs record their active panel in the hash query (`#analytics?tab=traffic`). Until September 2026
that address worked in one direction only:

- `getRouteFromHash()` strips everything after `?`, and the hashchange listener returned when the
  route was unchanged;
- `pages/analytics.js` read `?tab=` **only inside `init()`**, which does not run again.

So a link to a hub tab was inert whenever you were already on that hub — silently, with no error.
The contract now:

| Direction | Mechanism |
|---|---|
| Address → page | The hashchange listener detects a query-only change and calls `_currentPage.onRouteChange(detail)`. A hub opts in by exporting `onRouteChange({ tab })`; there is no registry to keep in step. |
| Page → shell | A hub that switches panel itself dispatches `admin:tab-change` on `window`. It **must** be a DOM event, not a call: `app.js` is evaluated as two module instances (the versioned entry `<script>` vs. the bare `../app.js` that page modules import — see the `__ADMIN_BOOTED__` guard), and page modules hold the instance that does **not** own the sidebar. |

`writeTabToHash()` deliberately uses `history.replaceState`, so tab switches do not stack
back-button entries — which is exactly why the event, not the hash, is what tells the shell.

`onRouteChange` with **no** tab (a bare `#analytics` reached while already on the hub) must
re-announce rather than return: the hub keeps the panel it is showing, and if it says nothing the
sidebar falls back to marking the parent row while a named tab is still on screen.

**Only `analytics` implements this today.** `control-center`, `settings`, `orders`, `products`,
`customers`, `promotions` and `expenses` are all `?tab=` hubs with the same latent gap; each is a
~10-line opt-in when someone wants its tabs addressable.

### Collapsible sidebar groups

`renderSidebar()` buckets the flat `NAV_ITEMS` into sections **before** emitting anything — the
July rule (a section with no item this role may see renders nothing at all, header included) used
to be a "pending label" string emitted just before the first visible child, which only worked while
the header and the items were unrelated siblings. A wrapper has to be opened before its children,
so the decision moved up front. Same rule, decided earlier.

- State lives in `localStorage['admin_nav_groups']` and stores **only the ids explicitly
  collapsed**, so a section added in a later release defaults to open rather than inheriting a
  preference recorded before it existed.
- **Auto-expanding to the active page does not persist.** Showing you where you are must not
  silently overwrite a section you chose to keep shut.
- **The 60px rail forces every group open** and hides the toggles and sub-links. Its headers are
  hidden, so a folded group there would be rows that vanished with no control left to unfold them.
  The rail is deliberately the flat top-level jump list it has always been.
- Below 768px the drawer is 280px with full labels, so headers and sub-links come back. Note the
  shared hide-list uses `display: revert`, which makes a `<button>` `inline-block`, not `flex` —
  the toggle restates it, as does the sub-row indent.

### `NAV_ITEMS` must stay flat

`admin-ia-overhaul-jul2026.test.js` §3 audits owner gating by parsing `{ key: '…' … }` with a
regex that stops at the first `}`. A nested `children: [...]` would make every entry after it
invisible to that audit and silently reopen the direct-hash hole the July pass closed. That is why
the hub marker is a flat string (`hubTabs: 'analytics'`) that *names* a manifest rather than
carrying the tabs inline.

### One list of tabs

`utils/analytics-tabs.js` is the single source: label **and** lazy module path in the same object,
imported by `pages/analytics.js` (tab bar + `import()`) and by `app.js` (sidebar sub-links +
command palette). It replaced a `TABS` array *and* a parallel `moduleMap` keyed by the same seven
ids — a tab present in the first and forgotten in the second rendered a permanent spinner, and the
sidebar would have been a third copy. The manifest imports nothing, so `app.js` can read it without
pulling in a page module (which imports `app.js` back) or defeating lazy page loading.

---

## 1. What this pass changed (summary)

Scope was deliberately **"Focused & safe"**: reorganise the information architecture, close a
real permission-safety gap, and document — **without** backend-dependent features or risky
churn. Every route hash (`key`) was preserved, so **no deep link, hub `?tab=` state, redirect,
keyboard shortcut, or command-palette entry broke.**

1. **Sidebar regrouped into business-workflow sections** — Overview / Sales / Catalog / Data
   Operations / Finance / Marketing / System (was: Overview / Sell / Analytics / Catalog & Data
   Ops / System / Settings). Items were relabelled and moved to sections that match how an
   ecommerce operation is run.
2. **"Control Center" → "Site Health"** (label only; route key stays `control-center`).
3. **Owner-permission gate unified to a single source of truth.** The old code kept **two
   out-of-sync lists** — the `ownerOnly` flags in `NAV_ITEMS` *and* a hardcoded `ownerPages`
   array in `navigate()`. The array covered only 8 of 16 owner pages, so the other 8 were hidden
   from the sidebar yet **still loaded via a direct `#hash`**. `navigate()` now gates through
   `isOwnerOnlyRoute()`, derived from `NAV_ITEMS` (plus a small `EXTRA_OWNER_ROUTES` set for
   owner surfaces reachable by direct hash but not in the sidebar). The two lists can never
   drift again.
4. **Regression test added** + the three tests that pinned the old IA updated to the new contract.
5. **Cache tokens bumped** (`APP_VERSION` + the `admin/app.js?v=` content hash in the shell).

Files changed: `inkcartridges/js/admin/app.js`, `inkcartridges/html/admin/index.html`,
`tests/admin-ia-overhaul-jul2026.test.js` (new), `tests/admin-expenses-page-contract.test.js`,
`tests/admin-product-codes-page.test.js`, `tests/demand-ranking-jul2026.test.js`,
`ADMIN_CENTRE_AUDIT.md` (this file).

---

## 2. Key architectural finding

The admin was **far more mature than a first glance suggests.** Consolidation is already done
through deep-linkable `?tab=` **hubs**, so most "pages" the brief listed are actually tabs:

| Hub (route) | Tabs |
|---|---|
| Orders (`#orders`) | Orders · Refunds · Compliance |
| Products (`#products`) | Products · Printers |
| Customers (`#customers`) | Directory · Contacts (owner) · Reviews |
| Promotions (`#promotions`) | Promotions · Coupons |
| **Finance** (`#analytics`) | Revenue · Health · Margins · Pricing · Market Intel · Traffic |
| **Site Health** (`#control-center`) | Overview · Pricing · Packs · Integrity · SEO · Links · Infra |
| Settings (`#settings`) | Notifications · Shipping Rates · Site Lock |
| Abuse (`#abuse`) | Flags · Coupon Signals · Blocked Domains |

Shared infrastructure already exists and is good: `DataTable` (sort/paginate/select/keyboard/
column-swap), `Drawer`, `Modal.confirm`, `Toast`, `Charts` (Chart.js), `FilterState`
(URL-synced period/granularity/brand/supplier/status + reset), a Ctrl+K command palette,
`ROUTE_REDIRECTS`, and a COGS-honest, "action-needed" dashboard. **The right work was refining
IA and closing gaps — not a rebuild.**

---

## 3. Old → new navigation map

Route keys are unchanged; only **section** and **label** moved.

| Item (route key) | Old section | New section | Label change |
|---|---|---|---|
| Dashboard (`dashboard`) | Overview | Overview | — |
| Orders (`orders`) | Sell | **Sales** | — |
| Quick Order (`quick-order`) | Sell | **Sales** | — |
| Invoices (`invoices`) | Sell | **Sales** | — |
| Customers (`customers`) | Sell | **Sales** | — |
| Tracking Requests (`tracking-requests`) | Sell | **Sales** | — (kept top-level for its badge) |
| Products (`products`) | Sell | **Catalog** | — |
| Ribbon Brands (`ribbon-brands`) | Catalog & Data Ops | **Catalog** | — |
| Product Codes (`product-codes`) | Catalog & Data Ops | **Catalog** | — |
| Price Monitor (`price-monitor`) | Catalog & Data Ops | **Catalog** | — |
| Demand Ranking (`demand-ranking`) | Analytics | **Catalog** | — |
| Feed Sync (`sync-report`) | Catalog & Data Ops | **Data Operations** | — |
| Pending Changes (`pending-changes`) | Catalog & Data Ops | **Data Operations** | — |
| Image Audit (`genuine-image-audit`) | Catalog & Data Ops | **Data Operations** | — |
| Site Health (`control-center`) | Catalog & Data Ops | **Data Operations** | **Control Center → Site Health** |
| Finance (`analytics`) | Analytics | **Finance** | — (label already "Finance") |
| Expenses (`expenses`) | Analytics | **Finance** | — |
| Promotions (`promotions`) | Sell | **Marketing** | — |
| Segments (`segments`) | Catalog & Data Ops | **Marketing** | — |
| Abuse (`abuse`) | System | System | — |
| Recovery (`recovery`) | System | System | — |
| Planner (`planner`) | System | System | — |
| Settings (`settings`) | Settings | System | — (folded into System, kept last) |

### September 2026 — into the new `Analytics` section

| Item (route key) | Jul 2026 section | Now | Label change |
|---|---|---|---|
| Performance (`analytics`) | Finance | **Analytics** | **Finance → Performance** |
| Demand Ranking (`demand-ranking`) | Catalog | **Analytics** | — |
| Catalogue Engagement (`catalog-engagement`) | Catalog | **Analytics** | — |
| Price Monitor (`price-monitor`) | Catalog | **Analytics** | — |
| Expenses (`expenses`) | Finance | Finance | — (a one-item section now) |
| Supplier Prices (`supplier-prices`) | Catalog | Catalog | — |
| Dashboard (`dashboard`) | Overview | Overview | — |

Sections are now, in order: Overview · **Analytics** · Sales · Catalog · Data Operations ·
Finance · Marketing · Content · System. Route keys are still unchanged — `#analytics`,
`#demand-ranking`, `#catalog-engagement` and `#price-monitor` all resolve exactly as before, and
`website-traffic`/`margin`/`financial-health` still redirect into the hub (now onto their own
tabs — see §4's redirect list).

The hub kept the route `#analytics` and lost only its **label**: it is no longer "the finance
surface" now that it also owns Traffic and Acquisition, and it sits under a header that already
says Analytics.

---

## 4. Full route & feature inventory (classification)

Legend: **Keep** = standalone page kept; **Tab** = already a tab inside a hub; **Redirect** =
legacy hash aliased via `ROUTE_REDIRECTS`; **Backend** = improvement needs the separate backend
repo. `(o)` = owner-only.

### Standalone pages (nav)
| Route | Page file | Classification |
|---|---|---|
| `dashboard` | `pages/dashboard.js` | Keep — decision-making landing; KPIs + charts + action-needed cards |
| `orders` | `pages/orders.js` | Keep (hub: Orders/Refunds/Compliance) |
| `quick-order` (o) | `pages/quick-order.js` | Keep — phone/walk-in register; also a `+ New`-style workflow |
| `invoices` (o) | `pages/invoices.js` | Keep — invoice list + drawer editor |
| `customers` | `pages/customers.js` | Keep (hub: Directory/Contacts/Reviews) |
| `tracking-requests` | `pages/tracking-requests.js` | Keep — fulfilment queue with pending badge |
| `products` | `pages/products.js` | Keep (hub: Products/Printers) |
| `ribbon-brands` | `pages/ribbon-brands.js` | Keep |
| `product-codes` (o) | `pages/product-codes.js` | Keep |
| `price-monitor` (o) | `pages/price-monitor.js` | Keep — competitor prices, margin floors, repricing (**Analytics** since Sep 2026) |
| `demand-ranking` (o) | `pages/demand-ranking.js` | Keep — what to stock for same-day (**Analytics** since Sep 2026) |
| `catalog-engagement` (o) | `pages/catalog-engagement.js` | Keep — measured product/brand views (**Analytics**; ERR-204) |
| `supplier-prices` (o) | `pages/supplier-prices.js` | Keep — cheapest-supplier comparison, saving split by price age (ERR-190) |
| `business` (o) | `pages/business.js` | Keep — B2B accounts |
| `page-copy` (o) | `pages/page-copy.js` | Keep — Content; a GUI over a git commit, **not** a CMS |
| `sync-report` (o) | `pages/sync-report.js` | Keep — Feed Sync |
| `pending-changes` (o) | `pages/pending-changes.js` | Keep — feed proposals (ADD/UPDATE/DEACTIVATE) |
| `genuine-image-audit` (o) | `pages/genuine-image-audit.js` | Keep — Image Audit |
| `control-center` (o) | `pages/control-center.js` | Keep — **relabelled "Site Health"** (hub, 7 tabs) |
| `analytics` (o) | `pages/analytics.js` | Keep — **"Performance"** hub, 7 tabs, each with its own `?tab=` address and a sidebar sub-link (§0) |
| `expenses` (o) | `pages/expenses.js` | Keep — dedicated expense management (real persistence) |
| `promotions` (o) | `pages/promotions.js` | Keep (hub: Promotions/Coupons) |
| `segments` (o) | `pages/segments.js` | Keep — customer segments + campaign email |
| `abuse` (o) | `pages/abuse.js` | Keep (hub: Flags/Coupon-Signals/Blocked-Domains) |
| `recovery` (o) | `pages/recovery.js` | Keep — data-integrity |
| `planner` | `pages/planner.js` | Keep |
| `settings` (o) | `pages/settings.js` | Keep (hub: Notifications/Shipping/Site-Lock) |

### Tabs inside hubs (not standalone nav)
`refunds.js`, `cc-compliance.js` (under Orders); `printers.js` (under Products); `contacts.js`
(o, under Customers), `reviews.js` (under Customers); `coupons.js` (o, under Promotions);
`financial-health.js` (o), `margin.js` (o), `cc-profit.js` (o), `cc-market-intel.js` (o),
`website-traffic.js` (o), `acquisition.js` (o) (under Performance — the manifest is
`utils/analytics-tabs.js`, and each of these is also a sidebar sub-link); `cc2-overview/pricing/packs/integrity/seo-slug/links/
infra.js` + `cc2-topbar.js` (under Site Health); `contact-emails.js` (o), `shipping-rates.js`
(o), `site-lock.js` (o) (under Settings).

### Redirects (`ROUTE_REDIRECTS`) — old bookmarks still resolve
`refunds→orders`, `ribbons→products`, `reviews→customers`, **`margin→analytics?tab=margins`**,
**`financial-health→analytics?tab=health`**, `coupons→promotions`,
`website-traffic→analytics?tab=traffic`,
`image-audit→genuine-image-audit`, `contact-emails→settings?tab=notifications`,
`shipping-rates→settings?tab=shipping`, `legal-content→settings`, `site-lock→settings?tab=site-lock`.

---

## 5. Problems found

| # | Problem | Status |
|---|---|---|
| P1 | Nav didn't match business workflows (Products under "Sell"; Expenses/Demand under "Analytics"; Segments in "Catalog & Data Ops"; section "Analytics" routed to a page titled "Finance"). | **Fixed** (§3) |
| P2 | Vague "Control Center" name (brief flagged it). | **Fixed** → "Site Health" |
| P3 | **Owner gate enforced by two out-of-sync lists** → 8 owner pages loadable by direct hash. | **Fixed** — single-source `isOwnerOnlyRoute()` |
| P4 | `formatPrice` re-declared in **18 files**; `fmtDate`/`fmtRelative` in several. | Documented — see §8 (deferred) |
| P5 | Dead/orphan files: `product-review.js` (imports a non-exported `updateReviewBadge` → cannot load), `cc-inventory.js`, `cc-monitoring.js`, `cc-seo.js` (unreferenced CC-v1 tabs). | Documented — see §8 (deferred; kept to honour "don't remove functionality") |
| P6 | `--tap-min` referenced once but not defined in `:root` (always the 48px fallback). | Documented — see §8 |

---

## 6. Overlap matrix (mostly intentional)

- **Financials**: Dashboard money rows ↔ Finance→Revenue (both call `getDashboardKPIs`);
  Expenses ↔ Finance→Health (both call `expenses.list` + `getAdminAnalyticsPnL`). _Summary vs
  drill-down — intentional; same shared endpoints, no divergent maths._
- **Margin/pricing (4-way)**: Dashboard worst-margin ↔ Performance→Margins ↔ Performance→Pricing
  ↔ Site Health→Pricing (writes prices) ↔ Price Monitor (writes prices). _Different endpoints;
  the two writers are the ones to watch._ Since Sep 2026 Price Monitor sits in **Analytics**,
  next to the margin analysis it feeds — it is read far more often than it is repriced from, but
  it is still a writer, so it stays on this list.
- **Manual sales (3-way, guarded)**: Quick Order → Invoices → Orders. A `sessionStorage` bridge
  (`utils/quick-order-bridge.js`) flips a converted Quick Order to `invoiced` to prevent
  double-count (ERR-077). _Intentional._
- **Catalog data-ops**: Feed Sync ↔ Pending Changes (both feed-import review queues, different
  backends); Image Audit ↔ Site Health→Infra (summary vs detail). _Candidate for a future
  merge; left as-is this pass._
- **Tracking**: Tracking Requests ↔ Dashboard alert ↔ Orders (where the number is entered).

---

## 7. Permission model (as implemented)

- Admin identity is **backend-enforced**: `AdminAuth.init()` → `GET /api/admin/verify`. Roles
  normalise to `owner` (superadmin/owner) or `admin`.
- **Owner gating (frontend) is now single-source.** `isOwnerOnlyRoute(pageName)` returns true
  when the `NAV_ITEMS` entry has `ownerOnly: true`, or the route is in `EXTRA_OWNER_ROUTES`
  (`contacts`, `cc-profit`, `cc-market-intel` — owner tabs reachable by direct hash). Non-owners
  get the central "Access Restricted" stub instead of a bare page load.
- In-page `isOwner()` checks (cost/margin/profit columns, etc.) remain as belt-and-braces.
- **The real authority is the backend**: owner-only endpoints must enforce `super_admin`
  server-side. That enforcement lives in the separate backend repo and is unverified from here —
  see §8.

---

## 8. Backend dependencies & recommended next (deferred, not done this pass)

_Item 9 is done (Sep 2026); the rest stand._ None of these were touched because they need the
**separate backend repo** (building them here
would mean fabricated frontend state, which the project forbids) or carry more churn/risk than
the "Focused & safe" scope allowed.

1. **Suppliers & Procurement page** — suppliers currently exist only as a global filter. A real
   page needs supplier list, feed status, cost/stock, dispatch expectations — all backend data.
2. **Returns/Refunds workflow** — Refunds is an Orders tab today; a dedicated review queue with
   states needs backend endpoints.
3. **Action Centre page** — the dashboard already aggregates action-needed cards; a standalone
   aggregator would largely re-derive that. Low marginal value until more signals exist.
4. **Audit log & Team/Permissions capability model** — both require backend storage/APIs.
5. **Saved views** — URL-param presets already cover most needs; a stored-view system is backend work.
6. **Verify server-side owner enforcement** on every owner-only endpoint (backend repo).
7. **Dead-file removal** — `product-review.js`, `cc-inventory.js`, `cc-monitoring.js`,
   `cc-seo.js` are confirmed unreferenced and safe to delete (verified via repo-wide grep).
8. **Shared `js/admin/utils/format.js`** — one `formatMoney`/`formatDate`/`formatRelative` to
   replace the copy in 18 files (P4). Pure refactor; do it incrementally to keep diffs reviewable.
9. ~~**Collapsible, auto-expanding sidebar groups**~~ — **DONE, Sep 2026.** Landed exactly where
   this predicted: `renderSidebar()` + CSS + `localStorage['admin_nav_groups']`. Two things the
   estimate did not foresee: the July empty-section rule had to be decided *before* the group
   wrapper is opened rather than lazily at its first visible child, and the 60px rail must force
   every group open because the header that would unfold one is hidden there. See §0.
10. **Define `--tap-min` in `:root`** (P6).

---

## 9. Migration risks & how they were contained

- **Broken deep links** — avoided by never renaming a route `key`; only labels/sections moved.
  Pinned by `admin-ia-overhaul-jul2026.test.js §4/§5` and the preserved `ROUTE_REDIRECTS` (§6 there).
- **Permission regression** — the single-source gate is pinned (`§2/§3`); a reintroduced second
  list fails the suite.
- **Stale cache** — `APP_VERSION` bumped and the shell's `admin/app.js?v=` restamped to the new
  content hash (asset-cache-tokens `§3`).
- **Contract tests that pinned the old IA** — updated in lockstep (expenses/product-codes/
  demand-ranking) to assert the new sections + derived gate.

---

## 10. Verification performed

### September 2026 pass

- `node --test tests/*.test.js` — **5242 pass**, 0 unexpected failures. (The one red is
  `no-ghost-files` flagging a gitignored `.playwright-mcp/` debug directory that a concurrent
  session had left in the working tree; removed after this pass's own browser run.)
  `tests/admin-analytics-section-sep2026.test.js` is new (+28, §1–§10, with positive controls on
  both CSS slices so a mis-aimed `slice()` cannot pass vacuously).
- Six tests updated in lockstep, none weakened: `demand-ranking-jul2026`,
  `catalog-engagement-sep2026` and `admin-ia-overhaul-jul2026` follow the section move;
  `acquisition-analytics-sep2026` now asserts the shared manifest instead of the two lists it
  replaced; `order-shipping-information-sep2026` and `orders-tracking-requested-column-sep2026`
  had pinned a **literal inside `APP_VERSION`** — the ERR-063 anti-pattern, which had already
  forced the constant to accrete one slug per feature (`…-invoice-header-total-spacing` →
  `…-shipping-information-tracking-requested-catalog-engagement-acquisition-ship-bridge` in four
  days). Both now assert what they mean: `notEqual` against the value that shipped before them.
- **Live, in the running admin, signed in as the owner** (not just in tests): all nine groups
  fold and persist across a reload; a fresh profile defaults to open; a deep link into a collapsed
  group auto-expands it *without* rewriting the stored preference; the 60px rail shows all 27
  top-level rows and no sub-rows; the 375px drawer restores headers, sub-rows and the indent; the
  command palette finds "Performance › Traffic"/"Acquisition" and navigates to the tab; `g a`
  still works. All seven hub tabs render live data — Revenue $24,062.88, Health cash $19,770.49,
  the Pricing heatmap, Traffic 6,811 sessions, Acquisition with Search Console at 15,699 rows and
  Google Ads correctly reported *not connected*. The four console errors are backend-side
  (`market-intel/*` 404, `traffic/summary` 504, `daily-revenue` 400, a Supabase `get_suppliers`
  403), each rendering a named error state rather than a blank.
- **ERR-208 reproduced and fixed under observation**: from `#analytics?tab=revenue`, clicking the
  sidebar's **Traffic** now switches the panel, moves the highlight and retitles the document;
  clicking **Acquisition** *inside* the page moves the sidebar highlight back. `#margin` and
  `#financial-health` now land on Margins and Financial Health — they had been landing on Revenue.
- `npm run build` restamped `html/admin/index.html`; `asset-cache-tokens` green.

### July 2026 pass

- `node --check inkcartridges/js/admin/app.js` — passes.
- `node --test` full suite — **2322 pass**. The only failures are two **pre-existing, unrelated**
  items, both independent of this change: (a) `tests/no-ghost-files.test.js` flags a gitignored
  `.playwright-mcp/` debug directory present in the working tree; (b)
  `tests/pdp-ribbon-related-by-code-jul2026.test.js` fails on **unstaged WIP** in
  `inkcartridges/js/product-detail-page.js` (a storefront file this pass never touched).
- Admin-specific guards green: `admin-ia-overhaul-jul2026`, `admin-module-imports`,
  `asset-cache-tokens` (incl. the staged-freshness `§3`), `admin-expenses-page-contract`,
  `admin-product-codes-page`, `demand-ranking-jul2026`.
