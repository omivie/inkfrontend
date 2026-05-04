# Admin Control Center (May 2026)

**Status:** shipped — frontend half of the spec at `/Users/matcha/Downloads/control-center-spec-may2026.md`.
**Backend route file:** `src/routes/adminControlCenter.js` · **Migration:** `057_admin_control_center.sql`.
**Access:** super-admin only (FE gate: `AdminAuth.isOwner()`; server gate: `requireRole('super_admin')`).
**URL:** `/admin/#control-center?tab=<overview|pricing|packs|integrity|seo|infra>`.

This document is the FE side of the contract. It maps every spec endpoint to a real file in this repo, lists the load-bearing assumptions, and explains how to test/extend without breaking the simulator math.

## TL;DR

| Spec area | Frontend file |
|---|---|
| 6-tab shell, keyboard nav, hash router | `inkcartridges/js/admin/pages/control-center.js` |
| Top bar (5 health tiles, 60s refresh, shared cache) | `inkcartridges/js/admin/pages/cc2-topbar.js` |
| Overview tab (HealthGrid) | `inkcartridges/js/admin/pages/cc2-overview.js` |
| Pricing tab (Margin Simulator) | `inkcartridges/js/admin/pages/cc2-pricing.js` |
| Packs tab (Bundle Health + Tree drawer + Bulk action) | `inkcartridges/js/admin/pages/cc2-packs.js` |
| Integrity tab (OrphanTracker, audit-script hint) | `inkcartridges/js/admin/pages/cc2-integrity.js` |
| SEO tab (Slug Health + Rename sheet) | `inkcartridges/js/admin/pages/cc2-seo-slug.js` |
| Infra tab (Prerender + Image pipeline) | `inkcartridges/js/admin/pages/cc2-infra.js` |
| Tier-based retail math (mirror of server) | `inkcartridges/js/admin/utils/pricingCalculator.js` |
| Pack health recommendation matrix | `inkcartridges/js/admin/utils/bundleLogic.js` |
| API client (11 endpoints) | `inkcartridges/js/admin/api.js` → `AdminAPI.controlCenter.*` |
| CSS | `inkcartridges/css/admin.css` (search for `cc2-`) |
| Tests | `tests/control-center-pricing.test.js` (32 tests, golden-pair pinned) |

## Endpoint → method map

All 11 endpoints land on `AdminAPI.controlCenter.*` and share the standard `{ ok, data }` envelope. Read methods swallow errors and return `null` (toast on failure); write methods throw with `error.code` so the caller can map `RATE_LIMITED` / `FORBIDDEN` / `VALIDATION_FAILED` to inline UX.

| Spec | HTTP | FE method |
|---|---|---|
| §5.1 | `GET /api/admin/health/summary` | `healthSummary()` |
| §5.2 | `POST /api/admin/pricing/simulate` | `simulatePricing(payload)` |
| (existing) | `GET /api/admin/pricing/tier-multipliers` | `getTierMultipliers()` |
| §5.3 | `GET /api/admin/packs/:skuOrId/health` | `getPackHealth(skuOrId)` |
| §5.4 | `GET /api/admin/packs/health/list` | `getPackHealthList({source, filter, page, limit})` |
| §5.5 | `POST /api/admin/packs/bulk-action` | `bulkPackAction({pack_ids, action, dry_run, reason})` |
| §5.6 | `GET /api/admin/compat/orphans` | `getOrphans()` |
| §5.7 | `GET /api/admin/seo/slug-health` | `getSlugHealth()` |
| §5.8 | `POST /api/admin/seo/slug-rename-preview` | `previewSlugRename({product_id, new_slug})` |
| §5.9 | `POST /api/admin/seo/slug-rename` | `commitSlugRename({product_id, new_slug, reason})` |
| §5.10 | `GET /api/admin/infra/prerender-health` | `getPrerenderHealth()` |
| §5.11 | `GET /api/admin/infra/image-pipeline` | `getImagePipeline()` |

`commitSlugRename` automatically sets `confirm: true` (the server's accidental-click guard). Callers don't have to remember it.

## Pricing simulator — the centerpiece

The Margin Simulator (`cc2-pricing.js`) is the single most expensive surface in the Control Center. It calls `POST /pricing/simulate` (rate-limited 10/min in spec §4) with up to 2,000 product IDs and 5,000 preview rows. To keep it snappy:

- **Local preview** of per-tier example retail uses `pricingCalculator.calcRetail(cost, source, tiers)` — *the same math the server runs* (see §12 golden pairs). When the user nudges a multiplier, the example "cost $50 → $71.49" updates instantly with no round-trip.
- **Authoritative numbers** (affected count, aggregate margin, sample rows) come from the server response. We never display per-SKU previews from local math.
- **Validation pre-flight**: `validateTierMap` enforces `1.05 ≤ m ≤ 5` *before* hitting the network so 422s are rare and the user gets immediate feedback.
- **Commit path is unchanged**: the simulator is preview-only. Users copy the proposed JSON (Copy button) and paste it into the existing tier-multipliers commit form elsewhere in admin.

### Golden cost/source pairs (spec §12)

These six pairs are pinned in `tests/control-center-pricing.test.js` and must match the backend Jest suite. If one drifts, the simulator misrepresents commit-time prices.

| cost | source | expected retail | tier key | multiplier |
|---:|---|---:|---|---:|
| $20.00 | genuine | $32.49 | `15-20` | 1.40 |
| $50.00 | genuine | $71.49 | `40-70` | 1.24 |
| $200.00 | genuine | $262.49 | `150-200` | 1.14 |
| $4.00 | compatible | $8.79 | `<=5` | 1.87 |
| $12.00 | compatible | $23.49 | `10-20` | 1.67 |
| $100.00 | compatible | $146.49 | `80-120` | 1.27 |

Run `node --test tests/control-center-pricing.test.js` after any change to `pricingCalculator.js` or `bundleLogic.js`.

## Pack health — recommendation matrix

`bundleLogic.recommendAction(p)` mirrors the server's packHealthService precedence:

1. `isBroken && missing.length > 0 && inactive.length === 0` → **deactivate** (constituent doesn't exist)
2. `isBroken && inactive.length > 0` → **regenerate** (we have material; CLI will rebuild)
3. `drifted` → **reprice** (structurally fine, retail just stale)
4. otherwise → **none**

`regenerate` returns per-row `ok: false` from the server with a CLI hint pointing at `scripts/genuine.js` / `scripts/compatible.js` — full regeneration is intentionally not exposed via API (spec §5.5). The Packs tab surfaces this as a Toast.info after a bulk run.

## Drift severity (colour-blind safe)

`bundleLogic.driftSeverity(delta)` buckets absolute dollar drift:

- `≤ $0.01` → green (✓ tick) — "No drift"
- `≤ $0.50` → yellow (▲ triangle) — "Minor drift"
- `> $0.50` → red (✕ cross) — "Significant drift"

Every drift indicator pairs colour with a glyph and an `aria-label` so colour-blind operators don't lose information. See `cc2-pack-drift--{green,yellow,red}` and `cc2-drift-banner--{...}` in `admin.css`.

## Slug rename flow

Spec §5.8 / §5.9 split the rename into preview + commit, and the FE preserves that:

1. Operator types a new slug into the Rename drawer and clicks **Preview**.
2. `previewSlugRename` returns one of: `ok: true` (with `new_slug_canonical`, `affected_redirects`, `new_redirect_required`) or `ok: false` with a `reason` of `invalid_slug_shape` / `product_not_found` / `slug_conflict`.
3. The drawer renders the result and *enables the Confirm button only on `ok: true`*.
4. **Confirm** calls `commitSlugRename` (which always sends `confirm: true`) and toasts the redirect-inserted bool from the server response.

If the slug-rename endpoint returns `error.code === 'slug_conflict'` post-preview (race), we surface it as a structured Toast instead of a generic "rename failed" — see `commitSlugRename`'s error-code mapping.

## Keyboard shortcuts

Layered on top of the existing global shortcuts in `js/admin/app.js`:

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette (existing, unchanged) |
| `g h` | Tab → Overview |
| `g p` | Tab → Pricing |
| `g k` | Tab → Packs |
| `g i` | Tab → Integrity |
| `g s` | Tab → SEO |
| `g f` | Tab → Infra |
| `Esc` | Close drawer / modal |
| `?` | Global shortcuts help (existing) |

The control-center page installs its own `keydown` listener on init and removes it on destroy, so the tab shortcuts only apply when you're actually on that page. Every tab button also carries `aria-keyshortcuts="g <letter>"` so screen readers announce the shortcut.

## URL state

The active tab is persisted to the hash query string: `#control-center?tab=pricing`. We use `history.replaceState` (not push) for tab switches so the browser's back button takes you out of the Control Center, not through every tab you visited. Deep links work — opening `/admin/#control-center?tab=infra` lands directly on the Infra tab.

## Health summary cache

`cc2-topbar.js` exports a tiny shared cache (`getHealthSummary({ force })`) that both the topbar and the Overview tab read from. TTL is 30s with an in-flight promise dedupe, so flipping between Overview and (say) the Pricing tab doesn't re-hit `/health/summary`. The topbar refreshes every 60s on a `setInterval`.

`null` from any counter means "not measurable in this deployment" — never zero. The UI renders an em-dash for `null`. The `fallback: true` flag toggles a "degraded data" warning in the topbar meta row.

## Spec sections we deliberately don't ship

- **`recharts` heatmap (spec §1 Pricing tab):** not implemented in this pass; the Pricing tab focuses on the simulator (the centerpiece). The heatmap can be added later as another card alongside the simulator without touching the API.
- **shadcn / TanStack table primitives:** the spec is Next.js + React + Tailwind. This codebase is vanilla-JS with no build step (see `readfirst/CLAUDE.md`), so we use the existing `DataTable`, `Drawer`, `Modal`, `Toast` components. Behaviour and information density match the spec; the visual idiom is "InkCartridges admin" not "shadcn".
- **Storybook fixtures:** the spec ships `__fixtures__/control-center.ts`. Our fixture-equivalent is the test suite — golden values are inlined where they matter (golden cost pairs in `control-center-pricing.test.js`).

## Adding a new tab

1. Create `inkcartridges/js/admin/pages/cc2-<name>.js` that exports `default { init(host, ctx), destroy() }`.
2. Add a row to the `TABS` array in `control-center.js` (`{ id, label, shortcut, module }`).
3. If you want a topbar tile, edit the `TILES` array in `cc2-topbar.js` and pick a tab `id` for the click target.
4. Add CSS under the `cc2-` namespace in `admin.css`.

## Performance budgets (spec §11)

| Metric | Spec budget | Notes |
|---|---|---|
| LCP on Overview | < 1.5s | Topbar + Overview share one `/health/summary` fetch |
| Simulator preview p95 (1k SKUs) | < 800ms | Server-side; FE just renders |
| Pack tree drawer open | < 400ms | Lazy module load + single endpoint |
| Bundle size for control-center | < 280KB gzip | We're vanilla JS — payload is well under this |

## Smoke-testing locally

```bash
# Start the dev server
npx serve inkcartridges -l 3000

# Open in browser, sign in as super-admin, then:
open http://localhost:3000/admin/#control-center
open http://localhost:3000/admin/#control-center?tab=pricing
open http://localhost:3000/admin/#control-center?tab=packs

# Run the FE math tests
node --test tests/control-center-pricing.test.js
```

## Related docs

- `readfirst/search-enrichment-may2026.md` — adjacent May 2026 spec, same envelope conventions
- `readfirst/value-pack-and-product-url-contract.md` — pack URL / canonical contract
- `readfirst/CLAUDE.md` — overall FE conventions (no build, vanilla JS, security rules)
