/**
 * filter-bar-busy-spinner-jul2026.test.js — pin the admin filter-bar activity spinner
 * ====================================================================================
 *
 * Reported 2026-07-27: with the reload dim retired (ERR-115/116) the Dashboard reload
 * had NO visible signal — the page looked identical while 13 requests were in flight,
 * so a period/granularity click read as "nothing happened".
 *
 * Fix (ERR-119): FilterState grows a generic `setBusy()` that toggles a blue spinner in
 * the bar's right-hand side, between the granularity segment ("Quarter") and "Clear".
 * The dashboard turns it on/off around its load; pages that never call it never show one.
 *
 * Source-read assertions (no DOM) pinning the regulators that keep it correct:
 *  - the spinner is emitted independently of the Clear button's hasFilters gate
 *  - _render() re-applies the busy class (it replaces innerHTML wholesale)
 *  - setBusy() does NOT call _render() (that would tear down an open dropdown)
 *  - only the newest load clears it (last-load-wins via _loadSeq)
 *  - destroy() clears it, so navigating away mid-load can't strand one
 *
 * Run with: node --test tests/filter-bar-busy-spinner-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILTERS_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/filters.js'), 'utf8');
const DASH_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/dashboard.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/css/admin.css'), 'utf8');

// ---------- filters.js ----------

test('filters.js: exposes setBusy() and backs it with _busy state', () => {
  assert.match(FILTERS_SRC, /_busy:\s*false/, 'must declare _busy so _render() can re-apply it');
  assert.match(FILTERS_SRC, /setBusy\(on\s*=\s*true\)\s*\{/, 'must expose setBusy(on = true)');
});

test('filters.js: setBusy() toggles the DOM class and never re-renders the bar', () => {
  const fn = FILTERS_SRC.match(/setBusy\(on\s*=\s*true\)\s*\{[\s\S]+?\n\s{2}\},/);
  assert.ok(fn, 'setBusy() body must be findable');
  assert.match(fn[0], /querySelector\(['"`]\.admin-filter-spinner['"`]\)/, 'must target .admin-filter-spinner');
  assert.match(fn[0], /classList\.toggle\(['"`]is-busy['"`]/, 'must toggle the is-busy class');
  // A _render() here would rebuild innerHTML and close an open multi-select dropdown.
  assert.ok(!/_render\(\)/.test(fn[0]), 'setBusy() must not call _render()');
});

test('filters.js: the spinner is emitted independently of the Clear button gate', () => {
  const right = FILTERS_SRC.match(/const rightHtml\s*=[\s\S]+?;\n/);
  assert.ok(right, 'rightHtml assignment must be findable');
  assert.match(right[0], /admin-filter-spinner/, 'spinner must be part of rightHtml');
  // hasFilters may only gate the Clear button — a filter-less page must still show activity.
  const gate = right[0].match(/hasFilters\s*\?([\s\S]+?):/);
  assert.ok(gate, 'hasFilters must remain a ternary over the Clear button only');
  assert.ok(!/admin-filter-spinner/.test(gate[1]),
    'the spinner must NOT sit inside the hasFilters branch');
  // Spinner before Clear in source order → renders left of it in the flex row.
  assert.ok(right[0].indexOf('admin-filter-spinner') < right[0].indexOf('admin-filter-reset'),
    'spinner must precede the Clear button');
});

test('filters.js: _render() re-applies the busy class (innerHTML is replaced wholesale)', () => {
  assert.match(FILTERS_SRC, /admin-filter-spinner\$\{this\._busy \? ' is-busy' : ''\}/,
    'the rendered markup must carry is-busy when _busy — else a mid-load re-render drops it');
});

// ---------- dashboard.js ----------

test('dashboard.js: loadDashboard() sets busy and clears it in a finally', () => {
  const wrapper = DASH_SRC.match(/async function loadDashboard\(\)\s*\{[\s\S]+?\n\}/);
  assert.ok(wrapper, 'loadDashboard() must be findable');
  assert.match(wrapper[0], /FilterState\.setBusy\(true\)/, 'must raise the spinner before fetching');
  assert.match(wrapper[0], /finally\s*\{/, 'must clear in a finally — early returns and throws included');
  // Last-load-wins: a superseded load finishing late must not signal "done".
  assert.match(wrapper[0], /if\s*\(mySeq === _loadSeq\)\s*FilterState\.setBusy\(false\)/,
    'only the newest load may clear the spinner');
});

test('dashboard.js: the sequence counter is bumped once, in the wrapper', () => {
  const bumps = DASH_SRC.match(/\+\+_loadSeq/g) || [];
  assert.equal(bumps.length, 1, 'exactly one ++_loadSeq (the wrapper) — the inner load takes mySeq as a param');
  assert.match(DASH_SRC, /async function runDashboardLoad\(mySeq\)/,
    'the load body must accept mySeq rather than allocating its own');
});

test('dashboard.js: destroy() clears the spinner', () => {
  const destroy = DASH_SRC.match(/\n\s{2}destroy\(\)\s*\{[\s\S]+?\n\s{2}\},/);
  assert.ok(destroy, 'destroy() must be findable');
  // destroy() bumps _loadSeq, so an in-flight load's finally declines to clear.
  assert.match(destroy[0], /FilterState\.setBusy\(false\)/,
    'navigating away mid-load must not strand a spinner in the next page bar');
});

// ---------- admin.css ----------

test('admin.css: the spinner is blue, hidden when idle, and reuses admin-spin', () => {
  const rule = CSS_SRC.match(/\.admin-filter-spinner\s*\{[\s\S]+?\}/);
  assert.ok(rule, '.admin-filter-spinner rule must exist');
  assert.match(rule[0], /display:\s*none/, 'idle spinner must take no space (no layout shift)');
  assert.match(rule[0], /border-top-color:\s*var\(--cyan\)/, 'accent must be the admin blue token');
  assert.match(rule[0], /animation:\s*admin-spin/, 'must reuse the existing admin-spin keyframes');
  assert.match(CSS_SRC, /@keyframes admin-spin/, 'admin-spin keyframes must still exist');
  assert.match(CSS_SRC, /\.admin-filter-spinner\.is-busy\s*\{\s*display:\s*block/,
    'is-busy must be what reveals it');
});
