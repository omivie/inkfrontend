# Ghost-file cleanup — May 2026

**Date shipped:** 2026-05-08
**Lockdown test:** `tests/no-ghost-files.test.js`

---

## What this is

A one-shot cleanup that removed every artefact in the repo that wasn't
needed for the website or VS Code: ad-hoc screenshots, one-off PDFs,
Playwright MCP debug logs, macOS `.DS_Store` junk, and a stale
duplicate of a backend handoff doc.

The cleanup also hardened `.gitignore` and `.claudeignore` so the same
files cannot drift back in, and added a `node --test` lockdown that
fails if any of them reappear.

## What was removed

### Tracked files (`git rm`)

| Path | Why it was ghost |
|---|---|
| `backend-passover.md` (root) | Older, smaller duplicate of `readfirst/backend-passover.md` (canonical). |
| `products-2026-03-10 (14).pdf` | One-off product-data export from March; nothing references it. |
| `ribbon-products-report.html` | One-off ribbon audit from March; nothing references it. |

### Untracked files (`rm`)

| Path | Why it was ghost |
|---|---|
| `7col-1500.png` | Playwright capture for shop-grid-width work. |
| `brand-hp-clean.png`, `brand-hp-fullpage.png`, `brand-hp-mobile.png` | Brand-page Playwright captures. |
| `pdp-incl-gst-only.png` | Playwright capture proving the GST trust-label change. |
| `tn150-search-after.png` | Playwright capture validating a search fix. |
| `audit-output/hp-975-after-color-sort.png` | Stray screenshot the audit script wrote out. |
| `.playwright-mcp/` (whole dir, ~32 MB, 833 files) | Playwright-MCP rolling debug output (logs + screenshots). Gitignored, but had been allowed to build up in the working tree. |
| `.DS_Store` × 4 | macOS Finder junk at root and in three nested dirs. |

## What was kept

These look superficially similar but were left in place:

- **`BACKEND_PRINTER_PRERENDER_SPEC.md`, `BACKEND_URL_MIGRATION.md`** — active backend handoffs.
- **`audit-output/report.json`** — the audit script's tracked output (still useful, blanket-ignored except for this re-include).
- **`scripts/*.js`** — debug-search, mobile-audit, nav-check, etc.; on-demand audit tooling that writes back into `audit-output/`.
- **All `inkcartridges/assets/**/*.png`** — brand logos, favicons, image assets. Never matched the root-only `/*.png` rule.
- **`readfirst/backend-passover.md`** — the canonical version that the JS comments and tests already reference.

## Hardened ignore rules

`.gitignore` now uses **root-anchored** patterns (`/*.png`, `/*.pdf`,
`/*-report.html`) so accidental captures dumped at the repo root are
caught while legitimate assets under `inkcartridges/assets/` and the
two tracked favicons stay tracked.

`audit-output/*` is blanket-ignored with a single re-include for
`report.json`, so future audit runs can't pollute the tree.

`.claudeignore` now also drops `.playwright-mcp/` and
`audit-output/*.png` so Claude Code doesn't try to read them as
context.

## Why the test exists

Without a test the cleanup decays — someone takes a debugging
screenshot, leaves it at root, and three months later the noise is
back. `tests/no-ghost-files.test.js` runs in the regular `node --test`
suite and fails CI / pre-commit if any of the patterns above reappear.

If you're hitting the test legitimately (e.g. you genuinely need a new
top-level binary), update the lockdown rules and `.gitignore` together
in the same PR — don't suppress the test in isolation.

## How to apply

- **New screenshot for a PR demo?** Drop it in `inkcartridges/assets/screenshots/` (and add an entry to that dir's gitignore exception if you want it tracked), or paste it into the PR description and don't commit it.
- **One-off audit script output?** Write it to `audit-output/` — the dir is gitignored except for `report.json`, so noise stays local.
- **Backend handoff doc?** Add to `readfirst/`, not the repo root. Never duplicate.
- **Random `.DS_Store` showing up?** Just delete it; the global ignore catches it but Finder will recreate it whenever you open the dir in macOS.
