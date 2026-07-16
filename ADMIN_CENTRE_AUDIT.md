# Admin Centre Audit — InkCartridges.co.nz

_Last updated: 2026-07-16. Reflects the **July 2026 IA overhaul** as implemented (not a proposal)._

The admin console is a hash-routed, vanilla-JS ES-module SPA served at `/admin`
(`inkcartridges/html/admin/index.html` → `inkcartridges/js/admin/app.js`). There is no
build framework; page controllers are lazy-loaded from `js/admin/pages/`. This document is
the human-readable companion to the durable contract pinned in
`tests/admin-ia-overhaul-jul2026.test.js`.

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

`analytics` deliberately keeps the label **"Finance"** with the route `#analytics` — the
analytics hub _is_ the finance surface, and `website-traffic`/`margin`/`financial-health`
redirect into it.

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
| `price-monitor` (o) | `pages/price-monitor.js` | Keep — competitor prices, margin floors, repricing |
| `demand-ranking` (o) | `pages/demand-ranking.js` | Keep — what to stock for same-day |
| `sync-report` (o) | `pages/sync-report.js` | Keep — Feed Sync |
| `pending-changes` (o) | `pages/pending-changes.js` | Keep — feed proposals (ADD/UPDATE/DEACTIVATE) |
| `genuine-image-audit` (o) | `pages/genuine-image-audit.js` | Keep — Image Audit |
| `control-center` (o) | `pages/control-center.js` | Keep — **relabelled "Site Health"** (hub, 7 tabs) |
| `analytics` (o) | `pages/analytics.js` | Keep — **"Finance"** hub (6 tabs) |
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
`website-traffic.js` (o) (under Finance); `cc2-overview/pricing/packs/integrity/seo-slug/links/
infra.js` + `cc2-topbar.js` (under Site Health); `contact-emails.js` (o), `shipping-rates.js`
(o), `site-lock.js` (o) (under Settings).

### Redirects (`ROUTE_REDIRECTS`) — old bookmarks still resolve
`refunds→orders`, `ribbons→products`, `reviews→customers`, `margin→analytics`,
`financial-health→analytics`, `coupons→promotions`, `website-traffic→analytics?tab=traffic`,
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
- **Margin/pricing (4-way)**: Dashboard worst-margin ↔ Finance→Margins ↔ Finance→Pricing ↔
  Site Health→Pricing (writes prices) ↔ Price Monitor (writes prices). _Different endpoints;
  the two writers are the ones to watch._
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

None of these were touched because they need the **separate backend repo** (building them here
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
9. **Collapsible, auto-expanding sidebar groups** — reduce the owner's ~23-item wall; contained
   to `renderSidebar()` + CSS + a `localStorage` group-state key.
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

- `node --check inkcartridges/js/admin/app.js` — passes.
- `node --test` full suite — **2322 pass**. The only failures are two **pre-existing, unrelated**
  items, both independent of this change: (a) `tests/no-ghost-files.test.js` flags a gitignored
  `.playwright-mcp/` debug directory present in the working tree; (b)
  `tests/pdp-ribbon-related-by-code-jul2026.test.js` fails on **unstaged WIP** in
  `inkcartridges/js/product-detail-page.js` (a storefront file this pass never touched).
- Admin-specific guards green: `admin-ia-overhaul-jul2026`, `admin-module-imports`,
  `asset-cache-tokens` (incl. the staged-freshness `§3`), `admin-expenses-page-contract`,
  `admin-product-codes-page`, `demand-ranking-jul2026`.
