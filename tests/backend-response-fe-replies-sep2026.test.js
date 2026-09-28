'use strict';

/**
 * The backend's answer to our four replies (2026-09-25), built on — ERR-291
 * ==========================================================================
 *
 * backend-docs/inbox/fe-replies-round-backend-response-sep2026.md answers
 * BF-068 (tier approval), BF-069 (site lock), BF-070 (bundle leftovers) and the
 * mobile-ATC reply. Every claim this repo builds on was measured in production
 * first (2026-09-28, backend a1c9c67 → 8d1b6f8): `npm run probe:bundle-response`
 * and `npm run probe:tier-approval` re-run those measurements.
 *
 * Suites that pin the individual surfaces live beside their older tests:
 *   tier approval        tests/tier-multiplier-approval-sep2026.test.js
 *   admin products brand tests/admin-products-fallback-filters-sep2026.test.js
 *   invoices portal      tests/admin-invoice-portal-link-sep2026.test.js
 *   image audit          tests/image-audit-restore-legacy-sep2026.test.js §6
 *   yield tier           tests/code-yield-grouping-may2026.test.js §2d
 *   site lock (peer)     tests/backend-move-sep2026.test.js §4a
 *
 * This file holds what had no home:
 *   §1 supplier feed import health (BF-070 h) — utils/importStatus.js
 *   §2 Product Review's brand filter (BF-070 c made a NAME a 400)
 *   §3 the site-lock admin copy (BF-069: 60 s edge TTL, no purge)
 *   §4 the paper trail: inbox doc, ERR entry, probes
 *
 * Red-proof: python3 scripts/redproof-backend-response-sep2026.py
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let S;
test.before(async () => {
  S = await import(path.join(ROOT, 'inkcartridges/js/admin/utils/importStatus.js'));
});

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Live GET /api/admin/supplier/import-status, 2026-09-28 (trimmed to the read
// fields). `latest` says completed; two of the five nights FAILED.
const run = (day, status, extra = {}) => ({
  script_name: 'genuine', status, dry_run: false, products_upserted: status === 'failed' ? 0 : 2595,
  errors: 0, feed_row_count: 4953,
  started_at: `2026-09-${day}T14:00:03Z`, finished_at: status === 'failed' ? `2026-09-${day + 1}T14:00:03Z` : `2026-09-${day}T14:33:36Z`,
  ...extra,
});
const LIVE = {
  genuine: { latest: run(27, 'completed'), recent_runs: [run(27, 'completed'), run(26, 'failed'), run(25, 'completed'), run(24, 'completed'), run(23, 'failed')] },
  compatible: { latest: run(27, 'completed'), recent_runs: [run(27, 'completed'), run(25, 'completed')] },
};
const NOW = Date.parse('2026-09-28T01:00:00Z');

// ── §1 import health ─────────────────────────────────────────────────────────

test('§1 a feed whose latest run passed but 2 of 5 failed is WARN, and says so', () => {
  const g = S.summarizeFeed(LIVE.genuine, NOW);
  assert.equal(g.tone, 'warn');
  assert.deepEqual(g.reasons, ['2 of the last 5 runs failed.']);
  assert.equal(S.summarizeFeed(LIVE.compatible, NOW).tone, 'ok');
});

test('§1 a failed latest run is BAD; a stale feed is BAD; a dry run is WARN', () => {
  const failedNow = { latest: run(27, 'failed'), recent_runs: [run(27, 'failed')] };
  assert.equal(S.summarizeFeed(failedNow, NOW).tone, 'bad');
  assert.match(S.summarizeFeed(failedNow, NOW).reasons.join(' '), /latest run failed/);
  // Four days without a run: two missed nights is the STALE_MS signal.
  const stale = { latest: run(24, 'completed'), recent_runs: [run(24, 'completed')] };
  assert.equal(S.summarizeFeed(stale, NOW).tone, 'bad');
  assert.match(S.summarizeFeed(stale, NOW).reasons.join(' '), /No real run in 3 days/);
  // A dry run moves no product: it must not count as the feed being fresh.
  const dry = { latest: run(27, 'completed', { dry_run: true }), recent_runs: [run(27, 'completed', { dry_run: true }), run(23, 'completed')] };
  const d = S.summarizeFeed(dry, NOW);
  assert.equal(d.tone, 'bad', 'the last REAL run is 4+ days old');
  assert.match(d.reasons.join(' '), /dry run/);
  assert.equal(S.STALE_MS, 48 * 3600 * 1000);
});

test('§1 absent is not zero: a failed read is null, a missing feed is "none"', () => {
  assert.equal(S.summarizeImportStatus(null), null);
  assert.equal(S.summarizeImportStatus('nope'), null);
  const sum = S.summarizeImportStatus({ genuine: LIVE.genuine }, NOW);
  assert.equal(sum.compatible.tone, 'none');
  assert.equal(S.summarizeFeed({ latest: null, recent_runs: [] }, NOW).tone, 'none');
});

test('§1 the card renders every run in the window, flags failures and dry runs, and escapes', () => {
  const html = S.importFeedsHtml(LIVE, esc, NOW);
  assert.equal((html.match(/cc2-infra__runfail/g) || []).length, 2, 'both failed nights are visible, not only `latest`');
  assert.match(html, /cc2-infra-card--warn/);
  assert.match(html, /2 of the last 5 runs failed\./);
  assert.match(html, /latest: completed/);
  const dry = S.importFeedsHtml({ genuine: { latest: run(27, 'completed', { dry_run: true }), recent_runs: [run(27, 'completed', { dry_run: true })] } }, esc, NOW);
  assert.match(dry, />dry run</);
  const evil = S.importFeedsHtml({ genuine: { latest: run(27, '<img src=x>'), recent_runs: [] } }, esc, NOW);
  assert.doesNotMatch(evil, /<img src=x>/, 'a status string is escaped');
});

test('§1 a failed read renders an ERROR card, never "no runs"', () => {
  const html = S.importFeedsHtml(null, esc, NOW);
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load import status/);
  assert.doesNotMatch(html, /No import run on record/);
});

test('§1 Site Health → Infra shows it (the only other page is not in the navigation)', () => {
  const infra = stripComments(read('inkcartridges/js/admin/pages/cc2-infra.js'));
  assert.match(infra, /AdminAPI\.getSupplierImportStatus\(\)/);
  assert.match(infra, /importFeedsHtml\(feeds, esc\)/);
  const inv = stripComments(read('inkcartridges/js/admin/pages/cc-inventory.js'));
  assert.match(inv, /importFeedsHtml\(data, esc\)/, 'one renderer for both surfaces');
  assert.doesNotMatch(inv, /d\.latest|No import data/, 'the latest-only card is gone');
  const css = read('inkcartridges/css/admin.css');
  for (const c of ['cc2-infra__bad', 'cc2-infra__runfail', 'cc2-infra__warn']) assert.ok(css.includes(`.${c}`), `.${c} is unstyled`);
});

// ── §2 Product Review ────────────────────────────────────────────────────────

test('§2 Product Review filters by brand SLUG — a brand NAME is 400 UNKNOWN_BRAND now', () => {
  // Measured 2026-09-28: is_reviewed=false&brand=hp → 200 (146);
  // is_reviewed=false&brand=HP → 400 UNKNOWN_BRAND.
  const page = stripComments(read('inkcartridges/js/admin/pages/product-review.js'));
  assert.match(page, /<option value="\$\{esc\(b\.slug\)\}">\$\{esc\(b\.name\)\}<\/option>/);
  assert.doesNotMatch(page, /b\.name \|\| b\.brand \|\| String\(b\)/, 'the name-as-value mapping is gone');
});

test('§2 a refused review read is an ERROR, never "All products reviewed"', () => {
  const api = read('inkcartridges/js/admin/api.js');
  const fn = api.slice(api.indexOf('async getUnreviewedProducts('), api.indexOf('async reviewProduct('));
  assert.match(fn, /if \(!resp \|\| resp\.ok === false\) throw invoiceError\(resp,/);
  const page = stripComments(read('inkcartridges/js/admin/pages/product-review.js'));
  const f = page.slice(page.indexOf('async function fetchAndRender'), page.indexOf('function updateCountBadge'));
  assert.ok(f.indexOf('if (data === null)') > -1 && f.indexOf('if (data === null)') < f.indexOf('_table.setData(products'));
  assert.match(f, /The count is unknown, not zero/);
  assert.match(f, /updateCountBadge\('\?'\)/);
});

// ── §3 site lock ─────────────────────────────────────────────────────────────

test('§3 the site-lock page says a change takes about a minute to reach shoppers', () => {
  // GET /api/site/lock: Cache-Control public, s-maxage=60, no purge on write
  // (measured MISS → HIT on api.inkcartridges.co.nz, 2026-09-28).
  const src = stripComments(read('inkcartridges/js/admin/pages/site-lock.js'));
  assert.equal((src.match(/within about a minute/g) || []).length, 4, 'lock, unlock, message save and the page header');
});

// ── §4 paper trail ───────────────────────────────────────────────────────────

test('§4 the backend document is filed, ERR-291 is logged, and the probes carry the checks', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'backend-docs/inbox/fe-replies-round-backend-response-sep2026.md')));
  const errors = read('errors.md');
  assert.ok(errors.includes('## ERR-291 '), 'errors.md must carry ERR-291');
  const probe = stripComments(read('scripts/probe-bundle-response-sep2026.mjs'));
  assert.match(probe, /UNKNOWN_BRAND/);
  assert.match(probe, /linked=true/);
  assert.match(probe, /recent_runs/);
  assert.match(probe, /G288BXLCMY/);
  assert.match(probe, /yield_tier: undefined/, '§6 measures the DETECTOR, not yieldTier() comparing the backend to itself');
  const posts = probe.match(/method: ['"](POST|PUT|PATCH|DELETE)['"]/g) || [];
  assert.equal(posts.length, 1, 'READ-ONLY: GETs plus the sign-in only');
  assert.match(probe, /auth\/v1\/token\?grant_type=password`, \{\s*method: 'POST'/, 'the one POST is the admin sign-in');
  const tier = stripComments(read('scripts/probe-tier-approval.mjs'));
  assert.doesNotMatch(tier, /reprice-jobs'\s*,\s*\{?\s*method: 'POST'/, 'the probe never queues a reprice');
  assert.doesNotMatch(tier + probe, /Snowflake|password\s*[:=]\s*['"][^'"]+['"]/i, 'credentials come from the environment only');
});

// ── §5 every local named import resolves ─────────────────────────────────────
// Found while verifying §2 in a real browser: #product-review answered "Page
// Not Found" because it imported `updateReviewBadge`, which app.js stopped
// exporting on 2026-04-09 (0764fdb). An ES module with an unresolved named
// import FAILS TO LINK — the whole page is gone, with one console line nobody
// reads. Source-grep tests passed the page for 5½ months. This checks the
// class, not the instance: every `import { x } from './local.js'` under js/
// names something the target actually exports.

function exportsOf(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
}

test('§5 every named import from a local module is actually exported by it', () => {
  const JS = path.join(ROOT, 'inkcartridges/js');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    }
  })(JS);
  const cache = new Map();
  const broken = [];
  let checked = 0;
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/import\s*(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.{1,2}\/[^'"?]+)(?:\?[^'"]*)?['"]/g)) {
      const target = path.resolve(path.dirname(file), m[3]);
      const rel = path.relative(ROOT, file);
      if (!fs.existsSync(target)) { broken.push(`${rel}: ${m[3]} does not exist`); continue; }
      if (!cache.has(target)) cache.set(target, exportsOf(target));
      const ex = cache.get(target);
      if (m[1] && !ex.has('default')) broken.push(`${rel}: default import from ${m[3]}, which has no default export`);
      for (const part of (m[2] || '').split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (!n) continue;
        checked++;
        if (!ex.has(n)) broken.push(`${rel}: imports { ${n} } from ${m[3]}, which does not export it — the module fails to link`);
      }
    }
  }
  assert.ok(checked > 300, `only ${checked} named imports seen — the scan is not reading the tree`);
  assert.deepEqual(broken, []);
});
