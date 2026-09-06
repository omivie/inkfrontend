/**
 * The customer order pathway is THREE steps (Sep 2026, ERR-213)
 * ==============================================================
 *
 *   BEFORE  Order Placed → Order Confirmed → Processing → Shipped — In Transit → Delivered
 *   AFTER   Order Placed → Shipped — In Transit → Delivered
 *
 * ── READ THIS BEFORE ADDING A STEP-NAME TO THE FRONTEND ─────────────────────
 *
 * The pathway is the BACKEND's. `buildTimeline()` maps over `data.timeline[]`
 * and renders `step.label` verbatim; it does not know the names, the count, or
 * the order. Grep this repo for "Order Confirmed" and you get nothing but prose.
 *
 * That is the property these tests defend, and the tempting way to break it is
 * to "help": drop `confirmed` and `processing` client-side so the change appears
 * without waiting on a deploy. That would give a HALF fix — three dots under a
 * badge still reading "Order Confirmed", because the badge is `status_label`,
 * a different field — and it would leave the page asserting a pathway the order
 * itself disagrees with, with nothing able to reconcile them. So:
 *
 *   • the renderer must survive BOTH shapes (three today, five from a backend
 *     that has not deployed, two when cancelled), and
 *   • it must render every step it is given, including the retired two.
 *
 * The live shape is measured by `npm run probe:track-timeline`, never asserted
 * from here. A test in this repo cannot know what the server sends.
 *
 * Also pinned here, from the same change:
 *   • `delivered` is settable from admin. It is the final step the customer
 *     reads and the only terminal status the modal offered was `completed` —
 *     two vocabularies for one event, and the customer's word could not be set.
 *   • every settable status has a badge colour. `track-order-page.js`
 *     interpolates the RAW status into `order-status-badge--${status}`, so a
 *     missing rule is an invisible pill, not a fallback.
 *   • `.container--*` modifiers are declared in exactly ONE file. They were not:
 *     layout.css said `--narrow` was 800px, pages.css said 500px and loaded
 *     later, so the 800px rule had never once applied and /track-order rendered
 *     as a phone column on a desktop.
 *
 * Run with:
 *   node --test tests/order-pathway-three-step-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

const CTRL_SRC = read('js/track-order-page.js');
const ORDERS_SRC = read('js/admin/pages/orders.js');
const FILTERS_SRC = read('js/admin/filters.js');
const PAGES_CSS = read('css/pages.css');
const LAYOUT_CSS = read('css/layout.css');
const PUB_HTML = read('html/track-order.html');

/* ────────────────────────────────────────────────────────────────────────────
 * Load the REAL buildTimeline, rather than a copy of it.
 *
 * track-order-page.js is an IIFE that ends by calling init(), so the controller
 * never escapes its closure. Swap that tail for an export and run the file in a
 * vm with the two globals it touches. A test that re-implements the renderer
 * agrees with itself and with nothing else.
 * ──────────────────────────────────────────────────────────────────────────── */
function loadController() {
  const TAIL = /if \(document\.readyState === 'loading'\)[\s\S]*?\n    \}\n\}\)\(\);?\s*$/;
  assert.match(CTRL_SRC, TAIL, 'the IIFE tail moved — this loader needs updating');
  const src = CTRL_SRC.replace(TAIL, 'globalThis.__TrackOrderPage = TrackOrderPage;\n})();');

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const sandbox = {
    document: { readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    window: {},
    Security: { escapeHtml: esc, escapeAttr: esc, sanitizeUrl: (u) => u },
    API: {},
    Auth: {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.ok(sandbox.__TrackOrderPage, 'controller failed to load');
  return sandbox.__TrackOrderPage;
}

const CTRL = loadController();

const step = (s, label, completed, date) => ({ step: s, label, completed, date });
const THREE = [
  step('placed', 'Order Placed', true, '2026-09-03T01:17:50Z'),
  step('shipped', 'Shipped — In Transit', true, '2026-09-04T14:39:31Z'),
  step('delivered', 'Delivered', false, null),
];
/** Exactly what production returned on 2026-09-06, before the backend change. */
const FIVE = [
  step('placed', 'Order Placed', true, '2026-09-03T01:17:50Z'),
  step('confirmed', 'Order Confirmed', true, '2026-09-03T01:17:59Z'),
  step('processing', 'Processing', true, null),
  step('shipped', 'Shipped — In Transit', true, '2026-09-04T14:39:31Z'),
  step('delivered', 'Delivered', false, null),
];
const CANCELLED = [
  step('placed', 'Order Placed', true, '2026-09-03T01:17:50Z'),
  step('cancelled', 'Cancelled', true, '2026-09-03T09:00:00Z'),
];

// The outer element only: .timeline-step__dot / __label / __date share the prefix.
const countSteps = (html) => (html.match(/<div class="timeline-step/g) || []).length;

// ─── The renderer follows the backend, in both directions ───────────────────

test('renders the three-step pathway', () => {
  const html = CTRL.buildTimeline(THREE);
  assert.equal(countSteps(html), 3);
  for (const label of ['Order Placed', 'Shipped — In Transit', 'Delivered']) {
    assert.ok(html.includes(label), `missing "${label}"`);
  }
});

test('STILL renders five steps when the backend sends five', () => {
  // The frontend must not go out of step with a backend that has not deployed.
  // Rendering three of five would put a stepper on screen that disagrees with
  // the order's own status, and nothing on the page could reconcile them.
  const html = CTRL.buildTimeline(FIVE);
  assert.equal(countSteps(html), 5, 'must render every step it is handed');
  assert.ok(html.includes('Order Confirmed'), 'must not filter a retired step out client-side');
  assert.ok(html.includes('Processing'), 'must not filter a retired step out client-side');
});

test('the cancelled shape is two steps and paints the cancelled modifier', () => {
  const html = CTRL.buildTimeline(CANCELLED);
  assert.equal(countSteps(html), 2);
  assert.ok(html.includes('timeline-step--cancelled'), 'cancelled step must carry its modifier');
});

test('an absent or empty timeline renders nothing, not an empty stepper', () => {
  for (const v of [undefined, null, [], 'nope', {}]) {
    assert.equal(CTRL.buildTimeline(v), '', `buildTimeline(${JSON.stringify(v)}) must return ''`);
  }
});

test('a step label is escaped, never interpolated raw', () => {
  const html = CTRL.buildTimeline([step('placed', '<img src=x onerror=alert(1)>', true, null)]);
  assert.ok(!html.includes('<img'), 'label must be escaped');
  assert.ok(html.includes('&lt;img'), 'label must be escaped');
});

test('buildTimeline names no step but `cancelled`, which is a RENDERING rule', () => {
  // `cancelled` earns its mention: it paints a different colour. Any other step
  // name appearing here would mean the frontend had started deciding what the
  // pathway is — the exact thing that makes the two surfaces drift.
  const fn = CTRL_SRC.slice(CTRL_SRC.indexOf('buildTimeline(timeline)')).slice(0, 1200);
  for (const name of ['confirmed', 'processing', 'placed', 'shipped', 'delivered']) {
    assert.ok(
      !new RegExp(`['"\`]${name}['"\`]`).test(fn),
      `buildTimeline must not mention the step "${name}" — the pathway is the backend's`,
    );
  }
  assert.ok(!/length\s*===\s*[0-9]|timeline\[[0-9]\]/.test(fn), 'must not assume a step count');
});

// ─── Admin can set the status the customer reads ─────────────────────────────

/**
 * Read a literal out of a source file without importing it.
 *
 * The spread is not decoration: a value built in a vm realm carries THAT realm's
 * Array.prototype, and assert/strict compares prototypes — so `deepEqual([], [])`
 * fails with two empty arrays printed side by side. Copy into this realm first.
 */
function arrayLiteral(src, name) {
  const m = new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(src);
  assert.ok(m, `${name} not found`);
  return [...vm.runInNewContext(m[1])];
}

test('ALL_STATUSES can set `delivered` — the customer stepper\'s final step', () => {
  const all = arrayLiteral(ORDERS_SRC, 'ALL_STATUSES');
  assert.ok(all.includes('delivered'),
    'Update Status must offer `delivered`. Until auto-delivery exists it is the only manual '
    + 'path to the last dot on the customer\'s stepper, and `completed` is a different word '
    + 'for the same event on a surface the customer never sees.');
  assert.ok(all.includes('shipped'), 'sanity: `shipped` must remain settable');
});

test('every settable status has a display label, and the label is rendered not branched on', () => {
  const all = arrayLiteral(ORDERS_SRC, 'ALL_STATUSES');
  const m = /const STATUS_LABELS = Object\.freeze\((\{[\s\S]*?\})\);/.exec(ORDERS_SRC);
  assert.ok(m, 'STATUS_LABELS must exist');
  const labels = { ...vm.runInNewContext(`(${m[1]})`) };
  for (const s of all) {
    assert.ok(labels[s], `STATUS_LABELS is missing "${s}" — the dropdown would show it lowercase`);
  }
  assert.equal(labels.delivered, 'Delivered');
  // Rendered through one helper, and escaped like every other dynamic string.
  assert.match(ORDERS_SRC, /esc\(statusOptionLabel\(s\)\)/,
    'the option label must go through statusOptionLabel() and be escaped');
  // Nothing may key off the display string.
  assert.ok(!/===\s*'Delivered'|===\s*"Delivered"/.test(ORDERS_SRC),
    'nothing may compare against a display label — branch on the status, render the label');
});

test('the filter facet can filter every status the modal can set', () => {
  const all = arrayLiteral(ORDERS_SRC, 'ALL_STATUSES');
  // Anchored to _options — FilterState also carries a live `statuses: []`, and
  // matching that one would let this test pass by comparing against nothing.
  const m = /_options:\s*\{[\s\S]*?statuses:\s*(\[[^\]]*\])/.exec(FILTERS_SRC);
  assert.ok(m, 'filters.js _options.statuses not found');
  const facet = [...vm.runInNewContext(m[1])];
  assert.ok(facet.length > 0, 'sanity: the facet must not be the empty live-state array');
  const missing = all.filter((s) => !facet.includes(s));
  assert.deepEqual(missing, [],
    `settable but unfilterable: ${missing.join(', ')} — an operator can set a status and then `
    + 'lose the order, because no view lists it.');
});

test('every settable status has a badge colour — a missing rule is an invisible pill', () => {
  // track-order-page.js interpolates the RAW status into the class name, so an
  // unstyled status renders as transparent text in a transparent pill. This is
  // not a fallback; there is no default rule to fall back to.
  const all = arrayLiteral(ORDERS_SRC, 'ALL_STATUSES');
  const missing = all.filter((s) => !new RegExp(`\\.order-status-badge--${s}\\b`).test(PAGES_CSS));
  assert.deepEqual(missing, [], `no .order-status-badge-- rule for: ${missing.join(', ')}`);
});

// ─── The layout trap ─────────────────────────────────────────────────────────

test('every .container--* modifier is declared in exactly one stylesheet', () => {
  // `.container--narrow` was declared in BOTH layout.css (800px) and pages.css
  // (500px). pages.css loads later at equal specificity, so 500px silently won
  // and the 800px rule had never applied to anything. Two declarations of one
  // class in two files is not a duplicate — it is a rule that looks live and is
  // not, and the only symptom is a page that is the wrong width.
  const files = { 'layout.css': LAYOUT_CSS, 'pages.css': PAGES_CSS, 'components.css': read('css/components.css') };
  const seen = new Map();
  for (const [file, src] of Object.entries(files)) {
    // Declarations only — `.container--x {` at the start of a selector, never a
    // mention inside a comment.
    for (const m of src.matchAll(/^\s*(\.container--[a-z0-9-]+)\s*(?:,|\{)/gm)) {
      if (!seen.has(m[1])) seen.set(m[1], []);
      if (!seen.get(m[1]).includes(file)) seen.get(m[1]).push(file);
    }
  }
  assert.ok(seen.size > 0, 'sanity: some .container--* modifier must exist');
  const dupes = [...seen].filter(([, files_]) => files_.length > 1);
  assert.deepEqual(dupes, [],
    dupes.map(([sel, f]) => `${sel} declared in ${f.join(' AND ')}`).join('; '));
});

/**
 * Split a stylesheet into top-level rules: the selector list, where it starts,
 * and which properties it sets. Nested at-rules are skipped by brace counting.
 */
function topLevelRules(src) {
  const out = [];
  for (let i = 0, selStart = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    const sel = src.slice(selStart, i).split('}').pop().split('*/').pop().trim();
    let j = i + 1;
    for (let d = 1; j < src.length && d > 0; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') d--;
    }
    const body = src.slice(i + 1, j - 1);
    const props = new Set(
      body.split(';').filter((d) => d.includes(':') && !d.includes('{'))
        .map((d) => d.slice(0, d.indexOf(':')).trim()),
    );
    out.push({ sel, pos: i, props });
    i = j - 1;
    selStart = j;
  }
  return out;
}

test('a BEM modifier never redeclares a property its base sets LATER in the file', () => {
  // `.track-result--tracking { text-align: left }` sat ~150 lines ABOVE
  // `.track-result { text-align: center }`. One class each, so the later rule
  // won and the modifier had NEVER applied — the tracking rows had always
  // rendered centred. Nothing errors, nothing warns; the override is simply not
  // one. Same shape as the .container--narrow double declaration.
  //
  // The check is the real defect, not the pattern: a modifier declared early is
  // harmless until it and its base set the SAME property. That is why this needs
  // no allowlist — it is currently at zero across every stylesheet.
  const violations = [];
  let scanned = 0;
  for (const file of ['css/pages.css', 'css/layout.css', 'css/components.css', 'css/admin.css']) {
    const rules = topLevelRules(read(file));
    const firstPos = new Map();
    const propsOf = new Map();
    for (const { sel, pos, props } of rules) {
      for (const one of sel.split(',').map((x) => x.trim())) {
        if (!/^\.[A-Za-z0-9_-]+$/.test(one)) continue;
        if (!firstPos.has(one)) firstPos.set(one, pos);
        if (!propsOf.has(one)) propsOf.set(one, new Set());
        for (const p of props) propsOf.get(one).add(p);
      }
    }
    for (const [sel, pos] of firstPos) {
      if (!sel.includes('--')) continue;
      scanned++;
      const base = sel.slice(0, sel.indexOf('--'));
      // `<=`, not `<`: `.x, .x--y { … }` is ONE rule and both selectors record the
      // same position. Grouped like that the modifier is not overridden, it is the
      // same declaration — flagging it would be a false positive (.cart-addon__img).
      if (!firstPos.has(base) || firstPos.get(base) <= pos) continue;
      const shared = [...propsOf.get(sel)].filter((p) => propsOf.get(base).has(p));
      if (shared.length) {
        violations.push(`${file}: ${sel} is declared before ${base}, and both set ${shared.join(', ')} — the modifier loses`);
      }
    }
  }
  assert.ok(scanned > 100, `sanity: only ${scanned} modifiers scanned — the parser is not finding rules`);
  assert.deepEqual(violations, [], violations.join('\n'));

  // POSITIVE CONTROL — the bug this test was written for, in miniature. A green
  // run above means "no violations"; it must not be able to mean "the parser
  // stopped finding them". Reproduces the exact shape of .track-result--tracking:
  // modifier first with text-align, base second with text-align.
  const controlRules = topLevelRules(
    '.a--m { text-align: left; padding: 0; }\n.a { text-align: center; margin: 1rem; }\n',
  );
  assert.equal(controlRules.length, 2, 'the parser must see both control rules');
  const [mod, base] = controlRules;
  assert.equal(mod.sel, '.a--m');
  assert.ok(base.pos > mod.pos, 'control: the base must come second');
  assert.deepEqual([...mod.props].filter((pp) => base.props.has(pp)), ['text-align'],
    'control: the overlapping property must be detected — if this stops working, so does the scan above');
});

test('/track-order is not a phone column: --content, while the auth cards keep --narrow', () => {
  assert.match(PUB_HTML, /class="container container--content"/,
    'the public track page must use --content (900px) — its result card holds a horizontal '
    + 'stepper and a detail table, and at 500px the last step label clips.');
  assert.ok(!/class="container container--narrow"/.test(PUB_HTML),
    'the public track page must no longer use --narrow');

  // The four auth cards genuinely want 500px. Widening the shared class instead
  // of moving one page would have changed all of them.
  for (const p of ['html/account/login.html', 'html/account/forgot-password.html',
                   'html/account/reset-password.html', 'html/account/verify-email.html']) {
    assert.match(read(p), /container--narrow/, `${p} must keep --narrow`);
  }
  assert.match(LAYOUT_CSS, /\.container--narrow\s*\{[^}]*max-width:\s*500px/,
    '--narrow must stay 500px — the width those pages have always rendered at');
});

// ─── The probe exists, is read-only, and cannot pass by accident ─────────────

test('probe:track-timeline is wired, read-only, and carries a positive control', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['probe:track-timeline'], 'node scripts/probe-track-timeline.mjs');

  const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-track-timeline.mjs'), 'utf8');
  assert.match(SRC, /MODE: READ-ONLY/, 'the mode must be PRINTED, never assumed');
  assert.ok(!/process\.argv/.test(SRC), 'this probe takes no flags, so it can have no --record mode');
  // It may only ever issue the lookup. A write here would touch a live order.
  const methods = [...SRC.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ['POST'], 'only the lookup POST is allowed');
  // The probe NAMES the endpoints it refuses to touch, so grep the calls, not the
  // prose: every fetch URL, and every key it could put in a body.
  const urls = [...SRC.matchAll(/fetch\(`?\$\{BASE\}([^`'"]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(urls)], ['/api/orders/track-lookup'],
    'the lookup is the only endpoint this probe may call');
  assert.ok(!/\b(mark_shipped|send_email)\s*:/.test(SRC),
    'must never build a body that emails a customer');

  // A probe that has stopped checking must not report green.
  assert.match(SRC, /FIVE_STEP_CONTROL/, 'must keep the pre-change payload as a positive control');
  assert.match(SRC, /the 5-step control is rejected/, 'must assert the control FAILS');
  // And a run that could not look anything up must say so by name.
  assert.match(SRC, /skip\(\s*'the live timeline shape'/, 'a missing order must SKIP loudly, never pass');
});
