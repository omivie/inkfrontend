/**
 * Admin Centre IA overhaul (July 2026)
 * ====================================
 *
 * Pins the July 2026 admin information-architecture pass (see ADMIN_CENTRE_AUDIT.md):
 *
 *   1. The sidebar is grouped into business-workflow sections
 *      (Overview / Sales / Catalog / Data Operations / Finance / Marketing / System)
 *      rather than the old build-order sections (Sell / Analytics / Catalog & Data Ops).
 *
 *   2. Owner-only gating is derived from ONE source. The old bug: two lists governed
 *      access — the `ownerOnly` flags in NAV_ITEMS AND a hardcoded `ownerPages` array in
 *      navigate() that covered only 8 of the 16 owner pages. The other 8 were hidden from
 *      the sidebar but still LOADED via a direct hash. The array is gone; navigate() now
 *      gates through `isOwnerOnlyRoute()`. This test fails if the second list ever returns.
 *
 *   3. No route key was renamed — only labels/grouping changed — so every deep link,
 *      hub `?tab=` state and ROUTE_REDIRECTS entry keeps working. In particular the
 *      Control Center → "Site Health" rename kept the `control-center` key.
 *
 * These are SOURCE-TEXT assertions (the admin is a browser ES module that pulls in
 * window globals, so it can't be `require()`d in node) — same approach as
 * admin-module-imports.test.js. The token/APP_VERSION are deliberately NOT pinned
 * (asset-cache-tokens.test.js owns cache-bust freshness; a literal pin there is the
 * ERR-063 anti-pattern).
 *
 * Run with: node --test tests/admin-ia-overhaul-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'app.js');
const SRC = fs.readFileSync(APP, 'utf8');

// Every owner page that must be gated for non-owners. This is the union of the OLD
// hardcoded ownerPages array (8) and the 8 pages that were previously nav-hidden but
// ungated — i.e. every page carrying `ownerOnly:true` in NAV_ITEMS.
const OWNER_PAGES = [
  // formerly in the hardcoded array:
  'settings', 'control-center', 'sync-report', 'invoices', 'quick-order',
  'demand-ranking', 'expenses', 'product-codes',
  // formerly nav-hidden but reachable by direct hash without the central stub:
  'promotions', 'analytics', 'price-monitor', 'genuine-image-audit',
  'pending-changes', 'segments', 'abuse', 'recovery',
];

test('§1 sidebar uses the business-workflow section headers', () => {
  const sections = [...SRC.matchAll(/section:\s*'([^']+)'/g)].map(m => m[1]);
  for (const expected of ['Overview', 'Sales', 'Catalog', 'Data Operations', 'Finance', 'Marketing', 'System']) {
    assert.ok(sections.includes(expected), `NAV_ITEMS is missing the "${expected}" section — got: ${sections.join(', ')}`);
  }
  // The old build-order section names must be gone (they were the confusing ones).
  for (const retired of ['Sell', 'Catalog & Data Ops']) {
    assert.ok(!sections.includes(retired), `The retired section "${retired}" is still present in NAV_ITEMS`);
  }
});

test('§2 the divergent hardcoded ownerPages array is gone', () => {
  assert.ok(!/\bownerPages\b/.test(SRC),
    'A second owner-gate list (`ownerPages`) reappeared in app.js. Owner gating must derive ' +
    'from NAV_ITEMS via isOwnerOnlyRoute() — two lists drift and reopen the direct-hash hole.');
  assert.ok(/function isOwnerOnlyRoute\s*\(/.test(SRC),
    'isOwnerOnlyRoute() is missing — it is the single source of truth for owner gating.');
  assert.ok(/if\s*\(\s*isOwnerOnlyRoute\(pageName\)\s*&&\s*!AdminAuth\.isOwner\(\)\s*\)/.test(SRC),
    'navigate() must gate owner pages through isOwnerOnlyRoute(pageName) && !AdminAuth.isOwner().');
});

test('§3 every owner page is owner-gated by the derived rule', () => {
  // Parse NAV_ITEMS entries: { key: 'x', ..., ownerOnly: true }
  const ownerFlagged = new Set();
  for (const m of SRC.matchAll(/\{\s*key:\s*'([^']+)'[^}]*\}/g)) {
    if (/ownerOnly:\s*true/.test(m[0])) ownerFlagged.add(m[1]);
  }
  // EXTRA_OWNER_ROUTES covers owner routes not in the sidebar.
  const extra = new Set();
  const extraMatch = SRC.match(/EXTRA_OWNER_ROUTES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (extraMatch) for (const m of extraMatch[1].matchAll(/'([^']+)'/g)) extra.add(m[1]);

  const ungated = OWNER_PAGES.filter(p => !ownerFlagged.has(p) && !extra.has(p));
  assert.deepEqual(ungated, [],
    'These owner pages are no longer owner-gated (missing ownerOnly flag / not in ' +
    'EXTRA_OWNER_ROUTES) — a non-owner could reach them:\n  ' + ungated.join('\n  '));
});

test('§4 route keys preserved — no broken deep links', () => {
  // The overhaul relabelled/regrouped only; these keys must still exist as nav routes.
  const keys = new Set([...SRC.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]));
  for (const k of ['dashboard', 'orders', 'products', 'customers', 'invoices', 'analytics',
                   'control-center', 'promotions', 'expenses', 'demand-ranking', 'segments',
                   'tracking-requests', 'price-monitor', 'sync-report', 'pending-changes']) {
    assert.ok(keys.has(k), `Route key "${k}" disappeared from NAV_ITEMS — deep links to #${k} would break`);
  }
});

test('§5 Control Center renamed to "Site Health" but keeps the control-center key', () => {
  assert.ok(/key:\s*'control-center',\s*label:\s*'Site Health'/.test(SRC),
    'The control-center item must be labelled "Site Health" while keeping key:"control-center" ' +
    '(so #control-center?tab=… deep links and cc2-topbar keep working).');
  assert.ok(!/label:\s*'Control Center'/.test(SRC),
    'The old "Control Center" label is still present.');
});

test('§6 legacy ROUTE_REDIRECTS still map old hashes (bookmarks survive)', () => {
  const block = SRC.slice(SRC.indexOf('ROUTE_REDIRECTS'));
  for (const old of ['refunds', 'margin', 'coupons', 'website-traffic', 'financial-health', 'image-audit']) {
    assert.ok(new RegExp(`'${old}'\\s*:`).test(block),
      `ROUTE_REDIRECTS lost the "${old}" alias — an old bookmark to #${old} would 404 in-app`);
  }
});
