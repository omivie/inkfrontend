/**
 * Analytics hub tab manifest — the SINGLE source for what the Analytics hub contains.
 * ===================================================================================
 *
 * Two surfaces need this list and they must never disagree:
 *
 *   1. `pages/analytics.js` renders the in-page tab bar from it and lazy-imports
 *      the module named by `lazy`.
 *   2. `app.js` renders the sidebar's indented sub-links under the ANALYTICS group
 *      from it (Sep 2026 — ERR-208).
 *
 * Before this file existed, `analytics.js` already held TWO lists keyed by the same
 * ids — a `TABS` array for the bar and a separate `moduleMap` object for the lazy
 * import — so adding a tab meant remembering both. Adding the sidebar would have made
 * three. That is the exact shape of every drift bug in this repo's log: ERR-150/160
 * (a feature vanished at a whitelist parser, then again at a call site), and the July
 * 2026 owner gate, where two lists governed access and only one was maintained.
 *
 * So: `label` and `lazy` live here, together, once. A tab with no `lazy` is rendered
 * inline by analytics.js itself.
 *
 * `id` is a PUBLIC identifier — it is the `?tab=` value in `#analytics?tab=<id>`, it
 * appears in ROUTE_REDIRECTS (`website-traffic` → `analytics?tab=traffic`), and it is
 * bookmarked. Renaming one breaks links exactly the way renaming a NAV_ITEMS `key`
 * does. Don't.
 *
 * No imports, deliberately: app.js must be able to read this without pulling in a page
 * module (which imports app.js back — a cycle, and it would defeat lazy page loading).
 *
 * Pinned by tests/admin-analytics-section-sep2026.test.js §5.
 */

export const ANALYTICS_TABS = [
  { id: 'revenue',      label: 'Revenue' },
  { id: 'health',       label: 'Financial Health', lazy: './financial-health.js' },
  { id: 'margins',      label: 'Margins',          lazy: './margin.js' },
  { id: 'pricing',      label: 'Pricing',          lazy: './cc-profit.js' },
  { id: 'market-intel', label: 'Market Intel',     lazy: './cc-market-intel.js' },
  { id: 'traffic',      label: 'Traffic',          lazy: './website-traffic.js' },
  { id: 'acquisition',  label: 'Acquisition',      lazy: './acquisition.js' },
];

export const ANALYTICS_TAB_IDS = ANALYTICS_TABS.map(t => t.id);

/** The tab a bare `#analytics` (no `?tab=`) resolves to. */
export const ANALYTICS_DEFAULT_TAB = ANALYTICS_TABS[0].id;

/** `'traffic'` → `'Traffic'`; null for an unknown id (never throws on a stale bookmark). */
export function analyticsTabLabel(id) {
  return ANALYTICS_TABS.find(t => t.id === id)?.label ?? null;
}
