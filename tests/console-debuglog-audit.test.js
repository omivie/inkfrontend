/**
 * Console / DebugLog audit lockdown — May 2026
 * ============================================
 *
 * Pins the fix from the backend dev's 2026-05-18 frontend console/secret
 * audit (`console-audit-may2026.md`).
 *
 * The codebase routes every log through `DebugLog` (utils.js), which
 * silences output outside localhost / 127.0.0.1 so production users'
 * DevTools stay clean and no request metadata leaks. Any raw `console.*`
 * call bypasses that gate.
 *
 * The audit flagged 4 call sites in the homepage bundle (search.js ×2,
 * landing.js ×2). Verification found it UNDERCOUNTED: contact-page.js,
 * payment-page.js and admin/pages/contact-emails.js also bypassed
 * DebugLog — including `payment-page.js`'s PayPal flow, which logged the
 * full order payload (customer name, address, phone, guest email) via
 * `JSON.stringify` straight into production DevTools. That was a real
 * PII exposure, not a cosmetic one. All of it is now routed through
 * DebugLog.
 *
 * This test fails if anyone re-introduces a raw `console.*` call in the
 * shipped frontend JS. The ONLY permitted raw console calls are the bodies
 * of GATED LOG WRAPPERS — a one-line `if (<gate>) console.x(...)`.
 *
 * WIDENED ONCE, DELIBERATELY (ERR-268, 2026-09-20). There are now TWO such
 * wrappers, and the second one exists because of what the first one cost us:
 *
 *   1. `DebugLog` (utils.js), gated on `this._isDev` — localhost only.
 *   2. `PaymentPage.walletDiag.say` (payment-page.js), gated on
 *      `this.enabled` — opt-in via ?wallet-debug=1, and it DOES print on
 *      production, which is the entire point of it.
 *
 * Why that was necessary: DebugLog's gate means every wallet log in
 * payment-page.js is a NO-OP on the live site. Apple Pay and Google Pay
 * produced 0 of 173 live charges over six months, and the instrument we
 * were told to diagnose it with was switched off on the only host where
 * the bug existed. A log you cannot read on the host that has the problem
 * is not an instrument.
 *
 * THE PII BOUNDARY IS UNCHANGED AND STILL LOAD-BEARING. The reason this
 * file exists is that payment-page.js once printed the full order payload
 * — customer name, address, phone, guest email — into production DevTools.
 * The wallet channel prints wallet availability, an ECE lifecycle state
 * and refused URIs. It never touches the payload, the cart or the
 * customer, and `tests/stripe-wallet-csp-sep2026.test.js` pins that
 * separately. `DebugLog._isDev` is NEVER flipped to force production
 * logging: that would re-open the exact exposure this file closed, through
 * a flag that lives in a URL and therefore gets shared and screenshotted.
 *
 * The allowance is bounded by a test below that enumerates every gated
 * wrapper in the tree, so a third one cannot appear unremarked.
 *
 * Run with: node --test tests/console-debuglog-audit.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'inkcartridges', 'js');

/** Recursively collect every *.js file under inkcartridges/js. */
function collectJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const RAW_CONSOLE = /\bconsole\s*\.\s*(log|warn|error|info|debug|table|trace|dir|group|groupEnd|count|time|timeEnd)\s*\(/;

/**
 * The two permitted gates, by exact spelling. Keyed by the gate so the
 * enumeration test below can report which wrapper a line belongs to.
 *
 * Matching on the GATE, not on a filename, is deliberate: a guard that
 * allowlists a path stops guarding that path (ERR-258).
 */
const GATED_LOG_WRAPPERS = [
  { gate: /this\._isDev/,  name: 'DebugLog (utils.js) — localhost only' },
  { gate: /this\.enabled/, name: 'walletDiag.say (payment-page.js) — opt-in, ERR-268' },
];

/**
 * A raw console call is allowed only when it is the body of a gated log
 * wrapper — that is the one place a real console call must exist.
 */
function isGatedLogWrapper(line) {
  return GATED_LOG_WRAPPERS.some(w => w.gate.test(line));
}

/** Crude comment guard: skip whole-line // comments and block-comment bodies. */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('no raw console.* calls survive in shipped frontend JS', () => {
  const offenders = [];
  for (const file of collectJsFiles(JS_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (!RAW_CONSOLE.test(line)) return;
      if (isGatedLogWrapper(line)) return; // gated wrapper definition — legitimate
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    'Raw console.* calls bypass DebugLog (they leak into production ' +
    'DevTools). Route them through DebugLog.{log,warn,error,info}:\n  ' +
    offenders.join('\n  ')
  );
});

test('the raw-console escape hatch has exactly the two gated wrappers we know about', () => {
  // Without this, the exemption above is an open door: any future line that
  // happens to mention `this.enabled` next to a console call inherits it
  // silently. Enumerating them is what keeps the hatch a hatch.
  //
  // Counted PER FILE, not per line number. A guard pinned to line numbers goes
  // red every time someone edits the lines above it, and a check that cries
  // wolf is one debugging session away from being ignored (ERR-260).
  const counts = {};
  for (const file of collectJsFiles(JS_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line) => {
      if (isCommentLine(line)) return;
      if (!RAW_CONSOLE.test(line)) return;
      if (!isGatedLogWrapper(line)) return;
      const rel = path.relative(ROOT, file);
      counts[rel] = (counts[rel] || 0) + 1;
    });
  }
  assert.deepStrictEqual(
    counts,
    {
      // DebugLog defines log / warn / error / info — four gated console calls.
      'inkcartridges/js/utils.js': 4,
      // walletDiag.say — one, opt-in, ERR-268.
      'inkcartridges/js/payment-page.js': 1,
    },
    'The set of gated log wrappers changed. Every one of these is a raw console.* ' +
    'call that ships to production users, so each is a deliberate decision with a ' +
    'written reason — see this file\'s docstring. If you added one, say why there. ' +
    'Found:\n  ' + JSON.stringify(counts, null, 2)
  );
});

test('the wallet diagnosis channel is opt-in and never force-enables DebugLog', () => {
  const payment = read('inkcartridges/js/payment-page.js');
  // Flipping DebugLog._isDev would re-open the PII exposure this file closed,
  // via a flag that lives in a URL and therefore gets shared and screenshotted.
  assert.doesNotMatch(
    payment, /DebugLog\._isDev\s*=/,
    'payment-page.js must never write to DebugLog._isDev — that would turn the ' +
    'PayPal order-payload log (customer name, address, phone, guest email) back ' +
    'on in production DevTools for anyone holding the debug URL.'
  );
  assert.match(
    payment, /say\(\.\.\.parts\) \{ if \(this\.enabled\)/,
    'the wallet channel must stay a gated wrapper, not a bare console call'
  );
});

test('DebugLog still exists, gates on localhost, and exposes log/warn/error/info', () => {
  const utils = read('inkcartridges/js/utils.js');
  assert.match(utils, /const DebugLog = \{/, 'DebugLog object must exist in utils.js');
  // Gate: only emits on localhost / 127.0.0.1.
  assert.match(utils, /hostname === 'localhost'/, 'DebugLog must gate on localhost');
  assert.match(utils, /hostname === '127\.0\.0\.1'/, 'DebugLog must gate on 127.0.0.1');
  // All four methods present and each guarded by _isDev.
  for (const method of ['log', 'warn', 'error', 'info']) {
    assert.match(
      utils,
      new RegExp(`${method}\\(\\.\\.\\.args\\) \\{ if \\(this\\._isDev\\) console\\.${method}\\(\\.\\.\\.args\\); \\}`),
      `DebugLog.${method} must be an _isDev-gated console.${method} wrapper`
    );
  }
  assert.match(utils, /window\.DebugLog = DebugLog/, 'DebugLog must be exposed on window so module + non-module scripts share it');
});

test('audit Fix 1 — the 4 flagged homepage-bundle call sites use DebugLog', () => {
  const search = read('inkcartridges/js/search.js');
  assert.match(
    search,
    /DebugLog\.error\('\[SmartSearch\] Products\.renderCard not available/,
    'search.js renderCard guard must log via DebugLog.error'
  );
  assert.match(
    search,
    /DebugLog\.error\('\[SmartSearch\]', err\)/,
    'search.js suggest-fetch catch must log via DebugLog.error'
  );

  // The newsletter handler moved into the shared footer binder (Jun 2026,
  // ERR-049) so it runs on every page; the DebugLog contract moved with it.
  const footer = read('inkcartridges/js/footer.js');
  assert.match(
    footer,
    /DebugLog\.warn\('\[newsletter\] subscribe failed'/,
    'newsletter failed-envelope branch must log via DebugLog.warn'
  );
  assert.match(
    footer,
    /DebugLog\.warn\('\[newsletter\] subscribe threw'/,
    'newsletter catch must log via DebugLog.warn'
  );
});

test('audit undercount — contact + admin notification call sites use DebugLog', () => {
  const contact = read('inkcartridges/js/contact-page.js');
  assert.strictEqual(
    (contact.match(/DebugLog\.warn\('\[contact\] submit failed'/g) || []).length, 2,
    'contact-page.js must route both submit-failed logs (API helper + raw fetch fallback) through DebugLog.warn'
  );

  const notif = read('inkcartridges/js/admin/pages/contact-emails.js');
  assert.match(notif, /DebugLog\.warn\('\[NotifRecipients\] Failed to load preferences:'/);
  assert.match(notif, /DebugLog\.warn\('\[NotifRecipients\] Failed to ensure preferences:'/);
});

test('PII guard — payment-page.js PayPal flow logs only via DebugLog', () => {
  const payment = read('inkcartridges/js/payment-page.js');
  // The order payload carries customer name, address, phone and guest
  // email — it must NEVER reach a raw console in production.
  assert.match(
    payment,
    /DebugLog\.log\('\[PayPal\] Sending order payload:', JSON\.stringify\(orderPayload/,
    'PayPal order-payload log must go through DebugLog.log (it contains customer PII)'
  );
  assert.doesNotMatch(
    payment,
    /\bconsole\s*\.\s*\w+\s*\(\s*'\[PayPal\]/,
    'No raw console.* call may remain in the PayPal flow'
  );
  assert.doesNotMatch(
    payment,
    /\bconsole\s*\.\s*\w+\s*\(\s*'\[Payment\]/,
    'No raw console.* call may remain in the Stripe payment flow'
  );
});

test('audit Fix 2 + 3 — config.js key comments name the correct environment', () => {
  const config = read('inkcartridges/js/config.js');

  // Fix 2: Stripe key is a live publishable key — comment must say so.
  assert.match(config, /\/\/ Stripe publishable key \(live\)/, 'Stripe comment must read "(live)"');
  assert.doesNotMatch(config, /Stripe publishable key \(test mode\)/, 'stale "(test mode)" Stripe comment must be gone');
  assert.match(config, /STRIPE_PUBLISHABLE_KEY: 'pk_live_/, 'Stripe key must be a pk_live_ key, matching the comment');

  // Fix 3: PayPal client ID confirmed live against the PayPal dashboard
  // on 2026-05-18 — comment must say so.
  assert.match(config, /\/\/ PayPal client ID \(live\)/, 'PayPal comment must read "(live)"');
  assert.doesNotMatch(config, /PayPal client ID \(sandbox\)/, 'stale "(sandbox)" PayPal comment must be gone');
});
