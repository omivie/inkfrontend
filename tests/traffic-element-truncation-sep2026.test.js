/**
 * Click-tracking `element` truncation — ERR-204, job 1
 * ====================================================
 *
 * The backend's analytics hand-off (Sep 2026) opened with a one-line fix: the
 * storefront caps the click `element` value at 80 characters, which cuts the
 * SKU off a product link, and the backend can only recover 66% of those clicks
 * by slug prefix. "Change 80 → 200."
 *
 * The ask was right. What it did not say is how much was being lost, or that
 * there were FOUR caps rather than one. Measured 2026-09-03 across all 4,085
 * live products (`canonical_url` from /api/products):
 *
 *     max length of ("link:" + pathname) ......... 113 chars
 *     95th percentile ............................  99 chars
 *     truncated at the old cap of 80 ............. 2,380 (58.3%)
 *     ...of those, losing the ENTIRE SKU segment . 2,380 (all of them)
 *     truncated at 120 ...........................     0
 *
 * The cap was applied AFTER the 5-char "link:" prefix, so only 75 path
 * characters ever survived, and the SKU is the last path segment — the part the
 * backend resolves a click to a product with.
 *
 * labelFor() also had three caps at 80 (data-track, #id, link:) and one at 40
 * applied to button text BEFORE the prefix, a 44-char ceiling. One column, two
 * budgets, neither named. And its button fallback was dead code:
 * `('btn:' + text) || 'btn'` can never yield 'btn', because the left operand
 * always holds at least the truthy string 'btn:' — an empty-text button
 * recorded the literal "btn:".
 *
 * This file pins the fix and the reasoning, and runs labelFor() for real in a
 * sandbox rather than only reading the source, so a refactor that keeps the
 * constant but breaks the behaviour still fails.
 *
 *   1. one named constant, no stray literals
 *   2. the measured worst case survives, with headroom
 *   3. every branch obeys the same budget, applied after the prefix
 *   4. the dead button fallback is gone
 *   5. NEGATIVE CONTROL — the cap is genuinely applied, not just declared
 *   6. the /admin opt-out is a single test and still fires
 *
 * Run with: node --test tests/traffic-element-truncation-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const TRACKER = path.join(ROOT, 'inkcartridges', 'js', 'traffic-tracker.js');
const SRC = fs.readFileSync(TRACKER, 'utf8');

/** The longest real product path measured in production, 2026-09-03. */
const LONGEST_LIVE_PATH =
  '/products/ml2010bk-compatible-toner-cartridge-for-samsung-ml2010-ml1610-scx4521d3-cwaa0759-black/CCWAA0759BK';
const LONGEST_LIVE_ELEMENT_LEN = ('link:' + LONGEST_LIVE_PATH).length; // 113

/**
 * Pull labelFor() and its cap() out of the IIFE and run them for real.
 *
 * The tracker is a browser IIFE that returns early on `navigator.doNotTrack`
 * and touches localStorage at module scope, so it cannot simply be evaluated.
 * We lift the two pure functions plus the constant instead — the same
 * source-slicing trick the sibling admin suites use, and it still exercises the
 * REAL shipped bodies rather than a copy.
 */
function loadLabelFor() {
  const constMatch = SRC.match(/const ELEMENT_MAX_CHARS = (\d+);/);
  assert.ok(constMatch, 'ELEMENT_MAX_CHARS must be declared');

  const slice = (startNeedle, endNeedle) => {
    const a = SRC.indexOf(startNeedle);
    assert.notEqual(a, -1, `could not find ${startNeedle}`);
    const b = SRC.indexOf(endNeedle, a);
    assert.notEqual(b, -1, `could not find ${endNeedle} after ${startNeedle}`);
    return SRC.slice(a, b);
  };

  const capFn = slice('    function cap(value) {', '\n    function labelFor');
  const labelFn = slice('    function labelFor(el) {', '\n    function onClick');

  const sandbox = {
    console, Math, Number, String, Boolean, Object, Array, JSON, URL, RegExp, Error,
    location: { hostname: 'www.inkcartridges.co.nz', href: 'https://www.inkcartridges.co.nz/shop' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `const ELEMENT_MAX_CHARS = ${constMatch[1]};\n${capFn}\n${labelFn}\n` +
    'this.__labelFor = labelFor; this.__cap = cap; this.__MAX = ELEMENT_MAX_CHARS;',
    sandbox, { filename: 'traffic-tracker-labelFor.js' },
  );
  return { labelFor: sandbox.__labelFor, cap: sandbox.__cap, MAX: sandbox.__MAX };
}

/** Minimal element stubs — only what labelFor() actually touches. */
function anchorEl(href) {
  const el = { dataset: {}, id: '', href, closest: (sel) => (sel === 'a[href]' ? el : null) };
  return el;
}
function buttonEl(text) {
  const el = { dataset: {}, id: '', textContent: text, closest: (sel) => (sel === 'button' ? el : null) };
  return el;
}
function trackEl(value) {
  return { dataset: { track: value }, id: '', closest: () => null };
}
function idEl(id) {
  return { dataset: {}, id, closest: () => null };
}

const { labelFor, cap, MAX } = loadLabelFor();

// ── 1. one named constant ───────────────────────────────────────────────────

test('ELEMENT_MAX_CHARS is 200', () => {
  assert.equal(MAX, 200, 'the hand-off asked for 200; the API accepts 512 and the column is unlimited');
});

test('no stray truncation literals remain in the tracking path', () => {
  // The old caps were 80 (x3) and 40 (x1). A leftover would silently reinstate
  // the bug on one branch while the constant claimed otherwise.
  assert.doesNotMatch(SRC, /\.slice\(0,\s*80\)/, 'an 80-char cap survived');
  assert.doesNotMatch(SRC, /\.slice\(0,\s*40\)/, 'a 40-char cap survived');
});

test('every branch of labelFor goes through cap(), not a raw slice', () => {
  const start = SRC.indexOf('    function labelFor(el) {');
  const body = SRC.slice(start, SRC.indexOf('\n    function onClick'));
  assert.doesNotMatch(body, /\.slice\(0,\s*\d+\)/,
    'labelFor must not carry its own numeric slice — one constant, one meaning');
  // cap() appears once per capped branch: data-track, #id, link:, btn:
  assert.equal((body.match(/cap\(/g) || []).length, 4,
    'all four element branches must be capped');
});

// ── 2. the measured worst case survives ─────────────────────────────────────

test('the longest real product URL survives intact', () => {
  const out = labelFor(anchorEl('https://www.inkcartridges.co.nz' + LONGEST_LIVE_PATH));
  assert.equal(out, 'link:' + LONGEST_LIVE_PATH);
  assert.equal(out.length, LONGEST_LIVE_ELEMENT_LEN, 'measured at 113 chars on 2026-09-03');
  assert.ok(out.endsWith('/CCWAA0759BK'), 'the SKU — the last segment — must survive');
});

test('the old cap would have destroyed that SKU (the bug being fixed)', () => {
  // Not a test of current behaviour; a test of WHY the number changed. If this
  // ever stops holding, the 200 needs re-justifying rather than inheriting.
  const full = 'link:' + LONGEST_LIVE_PATH;
  const atOld = full.slice(0, 80);
  assert.ok(!atOld.endsWith('/CCWAA0759BK'), 'at 80 the SKU segment was lost');
  assert.ok(full.length > 80 && full.length <= 200,
    'the real worst case sits between the old cap and the new one');
});

test('200 clears the measured maximum with real headroom', () => {
  assert.ok(MAX - LONGEST_LIVE_ELEMENT_LEN >= 80,
    `only ${MAX - LONGEST_LIVE_ELEMENT_LEN} chars of headroom over the longest live product URL`);
});

// ── 3. the cap is applied AFTER the prefix, on every branch ─────────────────

test('link: — the cap counts the prefix', () => {
  const longPath = '/products/' + 'a'.repeat(400);
  const out = labelFor(anchorEl('https://www.inkcartridges.co.nz' + longPath));
  assert.equal(out.length, MAX, 'the whole value, prefix included, is capped at the constant');
  assert.ok(out.startsWith('link:/products/'));
});

test('an off-site link records the HOSTNAME, not the path', () => {
  assert.equal(labelFor(anchorEl('https://example.com/some/deep/path')), 'link:example.com');
});

test('data-track and #id obey the same budget', () => {
  assert.equal(labelFor(trackEl('x'.repeat(400))).length, MAX);
  assert.equal(labelFor(idEl('y'.repeat(400))).length, MAX);
  assert.ok(labelFor(idEl('checkout')).startsWith('#'), 'the # prefix is part of the value');
});

test('btn: is capped after the prefix, not before it', () => {
  // The old form capped the TEXT at 40 and then added 'btn:', so this branch
  // could never exceed 44 while its siblings ran to 80. Same column, two rules.
  const out = labelFor(buttonEl('z'.repeat(400)));
  assert.equal(out.length, MAX);
  assert.ok(out.startsWith('btn:'));
});

test('a button label of ordinary length is untouched', () => {
  assert.equal(labelFor(buttonEl('  Add to cart  ')), 'btn:Add to cart', 'and it is trimmed');
});

// ── 4. the dead fallback ────────────────────────────────────────────────────

test('an empty-text button records "btn", never the literal "btn:"', () => {
  assert.equal(labelFor(buttonEl('')), 'btn');
  assert.equal(labelFor(buttonEl('   ')), 'btn', 'whitespace-only counts as empty');
});

test('the unreachable `|| \'btn\'` form is gone from the CODE', () => {
  // Comments are stripped first: the fix's own comment quotes the old form to
  // explain why it went, and a naive whole-file scan would flag that quotation
  // as the bug it documents.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\|\|\s*'btn'/,
    "`('btn:' + text) || 'btn'` can never take its right branch — the left is always truthy");
  // ...and the explanation is still there, so the next reader does not
  // "simplify" the ternary back into the broken form.
  assert.match(SRC, /never run: the left operand always held at least the truthy/,
    'the reason the ternary exists must stay written down');
});

// ── 5. NEGATIVE CONTROL ─────────────────────────────────────────────────────
// Everything above would still pass if cap() returned its input unchanged and
// no real value happened to be long enough. These prove the cap bites.

test('NEGATIVE CONTROL — cap() actually truncates', () => {
  assert.equal(cap('q'.repeat(MAX + 50)).length, MAX, 'cap must not be a pass-through');
  assert.equal(cap('short'), 'short', 'and must not touch a value under the limit');
});

test('NEGATIVE CONTROL — a value one char over the limit is trimmed', () => {
  assert.equal(cap('w'.repeat(MAX + 1)).length, MAX);
});

test('NEGATIVE CONTROL — labelFor returns null for an untrackable element', () => {
  assert.equal(labelFor({ dataset: {}, id: '', closest: () => null }), null);
  assert.equal(labelFor(null), null);
});

// ── 6. the /admin opt-out ───────────────────────────────────────────────────

test('the /admin guard is a single test, not the same one twice', () => {
  const guard = SRC.match(/if \(location\.pathname\.startsWith\('\/admin'\)[^\n]*\) return;/);
  assert.ok(guard, 'the /admin opt-out must still exist');
  assert.equal((guard[0].match(/startsWith/g) || []).length, 1,
    "the condition tested startsWith('/admin') twice — the second arm was dead");
});

test('the live admin URL is /admin, so that guard really fires', () => {
  // The duplicated condition looked like it might have been covering a second
  // prefix such as /html/admin. It was not needed: vercel.json 301s /html/* to
  // /*, so the admin SPA is served at /admin and the single test covers it.
  // Pinned here so nobody re-derives the scare from the removed line.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));
  const htmlRedirect = (vercel.redirects || []).find((r) => r.source === '/html/:path*');
  assert.ok(htmlRedirect, '/html/:path* must redirect, or /html/admin would be trackable');
  assert.equal(htmlRedirect.destination, '/:path*');
});

// ── 7. what did NOT change ──────────────────────────────────────────────────

test('the utm_rid URL-bomb guard is untouched at 512', () => {
  // A different field, a different job — it defends against a hostile URL, not
  // a long product slug. Sweeping it into the element constant would conflate
  // two unrelated limits.
  assert.match(SRC, /\.slice\(0,\s*512\)/, 'getUtmRid must keep its own 512 cap');
});

test('path, referrer and user_agent are still sent untruncated', () => {
  const start = SRC.indexOf('function baseEvent(');
  const body = SRC.slice(start, SRC.indexOf('function trackPageview'));
  assert.match(body, /path: location\.pathname \+ location\.search,/);
  assert.doesNotMatch(body, /\.slice\(/, 'baseEvent must not start capping fields');
});
