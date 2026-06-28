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
 * shipped frontend JS. The ONLY permitted raw console calls are the
 * DebugLog wrapper methods themselves (gated by `this._isDev`).
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
 * A raw console call is allowed only when it is a DebugLog wrapper body
 * (the line is gated by `this._isDev`) — that is the one place a real
 * console call must exist.
 */
function isDebugLogWrapper(line) {
  return /this\._isDev/.test(line);
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
      if (isDebugLogWrapper(line)) return; // DebugLog definition — legitimate
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
