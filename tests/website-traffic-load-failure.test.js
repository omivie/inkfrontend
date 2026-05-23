/**
 * website-traffic-load-failure.test.js — categorised load-failure UX
 * ===================================================================
 *
 * Reported 2026-05-23 (second pass): even after the skeleton + render race-guard
 * shipped, the Website Traffic page still showed "Backend endpoint not
 * available yet" when the Render free-tier backend was cold-starting. The
 * endpoint IS deployed — it was just briefly unreachable. The old copy lied to
 * users and offered no recovery path.
 *
 * This test pins the replacement contract:
 *
 *   1. apiGet returns a tagged envelope:
 *        { ok: true,  data }
 *        { ok: false, status }      (HTTP non-2xx)
 *        { ok: false, aborted: true }
 *        { ok: false, network: true, message }
 *      Plain `null` is gone.
 *
 *   2. loadAll wraps non-requested promises in `{ok:true,data:null}` (not bare
 *      null) so the prev-range short-circuit doesn't look like a failure.
 *
 *   3. The "everything failed" branch only fires when none of summary / recent /
 *      timeseries were ok AND not every one of them was just aborted (so a
 *      legitimate stale-render abort doesn't trip the hero).
 *
 *   4. loadFailedHero(reason) picks copy by reason:
 *        'auth'      → "Sign-in expired" + Sign-in link
 *        'missing'   → endpoint-not-deployed copy (rare — only on a real 404)
 *        'transient' → friendly "couldn't load right now" + Retry button
 *      And the Retry button is wired to call render() again, not hard-reload.
 *
 *   5. partialFailure path: when some endpoints loaded and others didn't, the
 *      page still renders the available data and surfaces an inline yellow
 *      banner naming which buckets dropped, with a Retry button.
 *
 * Run with: node --test tests/website-traffic-load-failure.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/website-traffic.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'inkcartridges/css/admin.css'), 'utf8');

// ─── apiGet envelope shape ────────────────────────────────────────────────────

test('apiGet returns tagged envelope on success', () => {
  assert.match(SRC, /return\s*\{\s*ok:\s*true,\s*data:[^}]+\}/,
    'success branch must return { ok:true, data }');
});

test('apiGet differentiates HTTP non-2xx with status code', () => {
  assert.match(SRC, /if\s*\(!resp\.ok\)\s*return\s*\{\s*ok:\s*false,\s*status:\s*resp\.status\s*\}/,
    'non-2xx must surface the status code');
});

test('apiGet tags aborts so the renderer can ignore stale ones', () => {
  assert.match(SRC, /e\.name\s*===\s*['"]AbortError['"][^}]*return\s*\{\s*ok:\s*false,\s*aborted:\s*true\s*\}/,
    'AbortError must be tagged separately from network failures');
});

test('apiGet tags network failures distinctly', () => {
  assert.match(SRC, /return\s*\{\s*ok:\s*false,\s*network:\s*true,\s*message:\s*e\.message\s*\}/,
    'network/throw must be tagged so it can be retried');
});

test('apiGet never returns a bare null', () => {
  // The bug was conflating null=success-empty with null=failure. Scan the apiGet
  // function body for any `return null;` and assert none exist.
  const start = SRC.indexOf('async function apiGet(');
  const end = SRC.indexOf('}', SRC.indexOf('}', SRC.indexOf('catch', start))) + 1;
  const body = SRC.slice(start, end);
  assert.ok(!/return\s+null\s*;/.test(body),
    'apiGet must never return bare null — use the tagged envelope');
});

// ─── loadAll: not-requested slots are { ok:true, data:null }, not bare null ──

test('loadAll uses { ok:true, data:null } for unsent prev-range fetch', () => {
  assert.match(SRC, /const\s+okNull\s*=\s*\{\s*ok:\s*true,\s*data:\s*null\s*\}/,
    'must define a success-with-null sentinel for short-circuit slots');
  // Both short-circuit branches must resolve to okNull (not a bare null) so the
  // page doesn't read a not-requested slot as a failure.
  const promiseResolveOkNullCount = (SRC.match(/Promise\.resolve\(okNull\)/g) || []).length;
  assert.ok(promiseResolveOkNullCount >= 2,
    `both short-circuit slots must use Promise.resolve(okNull); saw ${promiseResolveOkNullCount}`);
  // Ensure we no longer fallback to `Promise.resolve(null)` here.
  // (Other files may still use it; we only check the website-traffic source.)
  assert.ok(!/Promise\.resolve\(null\)/.test(SRC),
    'no short-circuit slot may resolve to bare null — use okNull');
});

test('loadAll wraps any rejected promise as { ok:false, network:true } (allSettled fallback)', () => {
  assert.match(SRC, /const\s+flat\s*=\s*\(\s*r\s*\)\s*=>\s*r\.status\s*===\s*['"]fulfilled['"]\s*\?\s*r\.value\s*:\s*\{\s*ok:\s*false,\s*network:\s*true\s*\}/,
    'rejected allSettled entries must also be envelopes, not bare null');
});

// ─── loadFailedHero branches on reason ───────────────────────────────────────

test('loadFailedHero exists with three reason branches', () => {
  assert.match(SRC, /function\s+loadFailedHero\s*\(\s*reason/, 'function must exist');
  // The function must reference each of the three reason tokens.
  assert.match(SRC, /reason\s*===\s*['"]auth['"]/);
  assert.match(SRC, /reason\s*===\s*['"]missing['"]/);
  // 'transient' is the default — the function reads `= 'transient'` as default param.
  assert.match(SRC, /reason\s*=\s*['"]transient['"]/);
});

test('loadFailedHero("auth") renders a sign-in CTA (not Retry) so users can recover', () => {
  const start = SRC.indexOf('function loadFailedHero(');
  const end = SRC.indexOf('\n}', start);
  const body = SRC.slice(start, end);
  assert.match(body, /Sign-in expired/, 'auth branch must use the sign-in title');
  assert.match(body, /\/login\.html\?return=/,
    'auth CTA must deep-link to login with a return URL so the user lands back here');
});

test('loadFailedHero("transient") renders a Retry button — the default user path', () => {
  const start = SRC.indexOf('function loadFailedHero(');
  const end = SRC.indexOf('\n}', start);
  const body = SRC.slice(start, end);
  assert.match(body, /Couldn't load website traffic/,
    'transient branch must use friendly wording, NOT "Backend endpoint not available yet"');
  assert.match(body, /data-action="retry-traffic"/,
    'transient branch must wire a [data-action="retry-traffic"] button');
});

test('the page no longer carries the misleading "Backend endpoint not available yet" copy as user-visible text', () => {
  // The phrase is OK in comments (it documents the bug history). It must NOT
  // appear inside a string literal that ends up rendered to the user.
  // Strip line comments (// …) and block comments (/* … */) and re-check.
  const stripped = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Backend endpoint not available yet/.test(stripped),
    'the legacy user-facing copy must be retired from rendered strings');
  // The replacement copy (new, accurate phrasing) must be present in rendered code.
  assert.match(stripped, /Traffic endpoints not deployed yet/,
    'the new "missing" branch copy must be present');
});

// ─── render: route to the right hero, never fire on stale aborts ─────────────

test('render() bails when everythingFailed AND not everythingAborted', () => {
  // The guard must require BOTH conditions — an all-aborted state means the
  // newer render's data is en route, so painting a hero would be wrong.
  assert.match(
    SRC,
    /const\s+everythingFailed\s*=\s*!summary\.ok\s*&&\s*!recent\.ok\s*&&\s*!timeseries\.ok/,
    'must compute everythingFailed across the three core endpoints'
  );
  assert.match(
    SRC,
    /const\s+everythingAborted\s*=\s*summary\.aborted\s*&&\s*recent\.aborted\s*&&\s*timeseries\.aborted/,
    'must compute everythingAborted so stale renders never paint the hero'
  );
  assert.match(
    SRC,
    /if\s*\(\s*everythingFailed\s*&&\s*!everythingAborted\s*\)/,
    'the hero-paint branch must require failed && !aborted'
  );
});

test('render() wires the Retry button to call render() again (no hard reload)', () => {
  // The retry click handler must call render(), not location.reload().
  assert.match(
    SRC,
    /retry\.addEventListener\(\s*['"]click['"]\s*,\s*\(\s*\)\s*=>\s*\{\s*render\(\)\s*;?\s*\}\s*\)/,
    'Retry button must call render(), not reload the page'
  );
});

test('render() uses the per-endpoint .ok flag everywhere — never the raw envelope as truthy', () => {
  // Sanity check that we don't accidentally re-introduce the old `if (!summary && !recent && !timeseries)`
  // shape — that would treat `{ok:false}` (truthy object) as success.
  assert.ok(
    !/if\s*\(\s*!summary\s*&&\s*!recent\s*&&\s*!timeseries\s*\)/.test(SRC),
    'must not test envelopes for truthiness — always .ok'
  );
});

// ─── Partial-failure banner ──────────────────────────────────────────────────

test('render() surfaces a partial-failure banner when some endpoints loaded and others did not', () => {
  assert.match(SRC, /admin-traffic-partial-banner/, 'banner class must be emitted');
  assert.match(SRC, /partialFailure/, 'partialFailure boolean must exist');
  // The banner must list which buckets dropped (so it's actionable, not just a vague warning).
  assert.match(SRC, /summary[\s\S]*recent events[\s\S]*time series/,
    'banner must name each dropped bucket');
});

test('CSS: .admin-traffic-partial-banner + .admin-btn--small are defined', () => {
  assert.match(CSS, /\.admin-traffic-partial-banner\s*\{/);
  assert.match(CSS, /\.admin-btn--small/);
});

// ─── categoriseFailure: pure routing helper ──────────────────────────────────

test('categoriseFailure() exists and routes 401 → auth, 404 on summary → missing, else → transient', () => {
  assert.match(SRC, /function\s+categoriseFailure\(\s*\{\s*summary,\s*recent,\s*timeseries\s*\}\s*\)/,
    'helper must destructure the three envelopes');
  // 401 on any → auth
  assert.match(SRC,
    /results\.some\(\s*r\s*=>\s*r\s*&&\s*r\.status\s*===\s*401\s*\)\)\s*return\s*['"]auth['"]/,
    'any 401 must map to "auth"');
  // 404 on summary → missing
  assert.match(SRC,
    /summary\s*&&\s*summary\.status\s*===\s*404[\s\S]*return\s*['"]missing['"]/,
    'a 404 on /summary specifically must map to "missing"');
  // default → transient
  assert.match(SRC, /return\s*['"]transient['"]/, 'default branch must be "transient"');
});
