/**
 * admin-skeleton-load-may2026.test.js — pin the loading contract
 * ==============================================================
 *
 * Reported 2026-05-23: navigating to /admin#website-traffic (or to /admin#dashboard
 * from elsewhere) briefly painted the "Backend endpoint not available yet"
 * empty-hero card BEFORE the real data finished loading.
 *
 * Root cause: a previous render()'s in-flight fetches got aborted by FilterState's
 * new AbortController, resolved to all-null inside apiGet's AbortError catch, and
 * then wrote emptyHero() into the NEW render's #traffic-body — clobbering the
 * fresh spinner with stale "endpoint missing" copy.
 *
 * Fix shipped:
 *   1. Each render() captures a monotonic sequence number and bails after its
 *      awaits if a newer render has been kicked off (or the page destroyed).
 *   2. First-load shows a matched-layout SKELETON, not a bare spinner — so
 *      what users see during the parallel fetch matches the eventual layout.
 *   3. Re-loads (filter changes) keep existing content visible and dim it via
 *      `.admin-page--reloading` — never blow away real data we just rendered.
 *   4. destroy() bumps the seq so any in-flight render's await stale-checks.
 *
 * This test reads the source files directly (no DOM) and pins the regulators
 * that make the fix robust against future edits.
 *
 * Run with: node --test tests/admin-skeleton-load-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WT_SRC   = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/website-traffic.js'), 'utf8');
const DASH_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/dashboard.js'),       'utf8');
const CSS_SRC  = fs.readFileSync(path.join(ROOT, 'inkcartridges/css/admin.css'),                     'utf8');

// ─── Website Traffic — skeleton + race guard ─────────────────────────────────

test('website-traffic.js: defines a monotonic _renderSeq and a _hasRenderedSuccessfully flag', () => {
  assert.match(WT_SRC, /let\s+_renderSeq\s*=\s*0/, 'must declare the render sequence counter');
  assert.match(WT_SRC, /let\s+_hasRenderedSuccessfully\s*=\s*false/, 'must declare first-load flag');
});

test('website-traffic.js: render() captures the seq before the first await', () => {
  // The seq increment must come BEFORE loadAll() — otherwise the "newer render"
  // would see the same seq and the guard wouldn't fire.
  const seqIncrement = /const\s+mySeq\s*=\s*\+\+_renderSeq;/;
  const loadAll      = /await\s+loadAll\(/;
  const beforeSeq    = WT_SRC.search(seqIncrement);
  const beforeLoad   = WT_SRC.search(loadAll);
  assert.ok(beforeSeq >= 0, 'render() must declare mySeq');
  assert.ok(beforeLoad >= 0, 'render() must await loadAll()');
  assert.ok(beforeSeq < beforeLoad, 'mySeq must be set BEFORE awaiting loadAll()');
});

test('website-traffic.js: render() race-guard bails when superseded', () => {
  // After the await, the function must check mySeq vs _renderSeq AND _container,
  // returning early if either is stale. Without this the bug recurs.
  assert.match(
    WT_SRC,
    /if\s*\(\s*mySeq\s*!==\s*_renderSeq\s*\|\|\s*!_container\s*\)\s*return/,
    'must early-return if a newer render is in flight or the page was destroyed'
  );
});

test('website-traffic.js: first load renders skeleton(), re-loads use --reloading dim', () => {
  assert.match(WT_SRC, /function\s+skeleton\(\)/, 'skeleton() must exist');
  // The first-load branch must inject skeleton() into #traffic-body.
  assert.match(
    WT_SRC,
    /if\s*\(\s*!\s*_hasRenderedSuccessfully\s*\)[\s\S]{0,400}skeleton\(\)/,
    'first-load branch must render the skeleton'
  );
  assert.match(
    WT_SRC,
    /_container\.classList\.add\(\s*['"]admin-page--reloading['"]\s*\)/,
    're-load branch must apply the --reloading dim class'
  );
  assert.match(
    WT_SRC,
    /_container\.classList\.remove\(\s*['"]admin-page--reloading['"]\s*\)/,
    'render() must remove --reloading once data lands'
  );
});

test('website-traffic.js: skeleton() emits the matched-layout 6 KPI tiles + chart shell', () => {
  const skelStart = WT_SRC.indexOf('function skeleton()');
  assert.ok(skelStart > -1);
  const skelChunk = WT_SRC.slice(skelStart, skelStart + 2000);
  // Tiles are emitted via a `const tile = '<div ...>'` placeholder repeated with
  // ${tile}; count the substitutions (+ any inline literals just in case).
  const tileCount = (skelChunk.match(/\$\{tile\}/g) || []).length
                  + (skelChunk.match(/<div[^>]*admin-skel__tile/g) || []).length;
  assert.ok(tileCount >= 6, `skeleton must include ≥6 KPI tile placeholders, saw ${tileCount}`);
  assert.match(skelChunk, /admin-kpi-grid--6/, 'KPI skeleton row must use the --6 grid');
  assert.match(skelChunk, /admin-chart-box--tall/, 'chart skeleton must use the tall chart box');
  assert.match(skelChunk, /admin-skel__chart/, 'chart skeleton placeholder must exist');
  assert.match(skelChunk, /admin-skel__stat/, 'summary-strip skeleton placeholders must exist');
  // Five summary stat placeholders to match the real layout.
  const statCount = (skelChunk.match(/\$\{stat\}/g) || []).length
                  + (skelChunk.match(/<div[^>]*admin-skel__stat/g) || []).length;
  assert.ok(statCount >= 5, `skeleton must include ≥5 summary-stat placeholders, saw ${statCount}`);
});

test('website-traffic.js: destroy() bumps the seq + resets the first-load flag', () => {
  const destroyBlock = WT_SRC.match(/destroy\(\)\s*\{[\s\S]+?\},/);
  assert.ok(destroyBlock, 'destroy() must exist');
  const body = destroyBlock[0];
  assert.match(body, /_hasRenderedSuccessfully\s*=\s*false/, 'reset first-load flag');
  assert.match(body, /_renderSeq\s*\+\+/,                    'bump seq to stale-check in-flight renders');
});

// ─── Dashboard — same pattern ─────────────────────────────────────────────────

test('dashboard.js: declares _loadSeq + _hasRenderedSuccessfully', () => {
  assert.match(DASH_SRC, /let\s+_loadSeq\s*=\s*0/);
  assert.match(DASH_SRC, /let\s+_hasRenderedSuccessfully\s*=\s*false/);
});

test('dashboard.js: loadDashboard() captures seq before awaiting and bails when stale', () => {
  const seqIdx  = DASH_SRC.indexOf('const mySeq = ++_loadSeq');
  const awaitIdx = DASH_SRC.indexOf('await Promise.allSettled(promises)');
  assert.ok(seqIdx >= 0, 'must capture mySeq');
  assert.ok(awaitIdx >= 0, 'must await the parallel fetch');
  assert.ok(seqIdx < awaitIdx, 'mySeq must be captured before the await');
  assert.match(
    DASH_SRC,
    /if\s*\(\s*mySeq\s*!==\s*_loadSeq\s*\|\|\s*!_container\s*\)\s*return/,
    'must early-return if stale'
  );
});

test('dashboard.js: first load shows dashboardSkeleton(), re-loads dim via --reloading', () => {
  assert.match(DASH_SRC, /function\s+dashboardSkeleton\(\)/, 'skeleton helper must exist');
  assert.match(
    DASH_SRC,
    /if\s*\(\s*!\s*_hasRenderedSuccessfully\s*\)[\s\S]{0,400}dashboardSkeleton\(\)/,
    'first-load branch must paint the skeleton'
  );
  assert.match(
    DASH_SRC,
    /_container\.classList\.add\(\s*['"]admin-page--reloading['"]\s*\)/,
    're-load branch must apply --reloading'
  );
});

test('dashboard.js: dashboardSkeleton() includes 8 KPI tile placeholders + chart cards', () => {
  const start = DASH_SRC.indexOf('function dashboardSkeleton()');
  const chunk = DASH_SRC.slice(start, start + 2500);
  const tileCount = (chunk.match(/\$\{tile\}/g) || []).length
                  + (chunk.match(/<div[^>]*admin-skel__tile/g) || []).length;
  assert.ok(tileCount >= 8, `expected ≥8 KPI tile placeholders, saw ${tileCount}`);
  const chartCount = (chunk.match(/admin-skel__chart/g) || []).length;
  assert.ok(chartCount >= 2, `expected ≥2 chart skeletons (trend + forecast), saw ${chartCount}`);
});

test('dashboard.js: destroy() bumps _loadSeq + resets first-load flag', () => {
  const destroyBlock = DASH_SRC.match(/destroy\(\)\s*\{[\s\S]+?\},/);
  assert.ok(destroyBlock, 'destroy() must exist');
  const body = destroyBlock[0];
  assert.match(body, /_hasRenderedSuccessfully\s*=\s*false/);
  assert.match(body, /_loadSeq\s*\+\+/);
});

// ─── CSS contract ─────────────────────────────────────────────────────────────

test('admin.css: defines the admin-skel shimmer + .admin-page--reloading dim', () => {
  assert.match(CSS_SRC, /@keyframes\s+admin-skel-shimmer/, 'shimmer keyframes must exist');
  assert.match(CSS_SRC, /\.admin-skel\s*\{/,                'base .admin-skel class must exist');
  assert.match(CSS_SRC, /\.admin-skel__tile/,               'tile variant must exist');
  assert.match(CSS_SRC, /\.admin-skel__chart/,              'chart variant must exist');
  assert.match(CSS_SRC, /\.admin-skel__row/,                'row variant must exist');
  assert.match(CSS_SRC, /\.admin-skel__line--title/,        'title-line variant must exist');
  assert.match(CSS_SRC, /\.admin-page--reloading/,          'reloading dim class must exist');
});

test('admin.css: shimmer + reload dim respect prefers-reduced-motion', () => {
  // Find the reduced-motion block that covers .admin-skel and check it disables animation.
  assert.match(
    CSS_SRC,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.admin-skel\s*\{\s*animation:\s*none/,
    'shimmer must disable under prefers-reduced-motion'
  );
});

test('admin.css: dark-theme skeleton has its own tonal range', () => {
  assert.match(
    CSS_SRC,
    /\[data-theme="dark"\]\s+\.admin-skel/,
    'dark-mode override must exist so the skeleton isn\'t washed-out on dark surfaces'
  );
});

// ─── No stale load-failed copy can paint during load ─

test('website-traffic.js: loadFailedHero() only fires AFTER the race-guard has passed', () => {
  // The load-failed hero must live below the seq guard so a stale render
  // can never trip the empty-state copy onto a fresh page.
  const guardIdx = WT_SRC.indexOf('if (mySeq !== _renderSeq');
  const heroCallIdx = WT_SRC.indexOf('body.innerHTML = loadFailedHero(');
  assert.ok(guardIdx > 0 && heroCallIdx > 0, 'both the guard and the hero call must exist');
  assert.ok(guardIdx < heroCallIdx,
    'loadFailedHero() call must come AFTER the seq guard so stale renders never paint it');
});
