/**
 * Admin page modules must IMPORT what they use
 * ============================================
 *
 * The admin is ES modules. `AdminAuth`, `AdminAPI`, `FilterState`, `icon` and `esc`
 * are **exports of app.js**, not globals. `Auth`, `Security`, `DebugLog` and
 * `formatPrice` genuinely *are* globals (window.*), and referencing those bare is
 * fine.
 *
 * WHY THIS FILE EXISTS — a bug that shipped and hid an entire feature:
 *
 *     const canSeeCost = () =>
 *       (typeof AdminAuth !== 'undefined' && AdminAuth?.isOwner) ? AdminAuth.isOwner() : false;
 *
 * `AdminAuth` was never imported into invoices.js. So `typeof AdminAuth` was
 * `'undefined'`, the ternary took the `: false` branch, and the owner-only "Our
 * Cost" column — the entire point of that release — **never rendered for anybody**.
 * No error, no warning, no console noise. The defensive `typeof` guard, meant to
 * harden the feature, silently deleted it.
 *
 * The same shape can fail the other way. An access check written as
 *
 *     if (typeof AdminAuth !== 'undefined' && !AdminAuth.isOwner()) { deny(); }
 *
 * fails **OPEN** when the import is missing: the `&&` short-circuits, the deny
 * branch never runs, and a non-owner walks straight in.
 *
 * Rule: a `typeof` guard is for things that might genuinely be absent at runtime
 * (a global from another script). It is NOT a substitute for an import. Import the
 * thing, and let a missing import throw loudly at load time.
 *
 * Run with: node --test tests/admin-module-imports.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');

// Exports of app.js — must be imported, never assumed global.
const APP_EXPORTS = ['AdminAuth', 'AdminAPI', 'FilterState'];

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** The set of identifiers a module imports (from any specifier). */
function importedNames(src) {
  const names = new Set();
  const re = /import\s*\{([^}]*)\}\s*from/g;
  let m;
  while ((m = re.exec(src))) {
    for (const raw of m[1].split(',')) {
      const id = raw.trim().split(/\s+as\s+/).pop().trim();
      if (id) names.add(id);
    }
  }
  return names;
}

/** Strip comments only — prose about `AdminAuth` must not count as a usage. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Strip comments AND string literals, for checks that look for *references*.
 * NB: do NOT use this for the `typeof x === 'undefined'` check — it would eat the
 * `'undefined'` literal and the regex could never match. (It did, and the test
 * passed on code that was broken. A test that cannot fail is worse than none.)
 */
function code(src) {
  return stripComments(src)
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const files = jsFiles(ADMIN).filter(f => !/\/app\.js$/.test(f));

for (const sym of APP_EXPORTS) {
  test(`every module that uses ${sym} imports it from app.js`, () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const body = code(src);
      // A bare reference: `AdminAuth.` or `AdminAuth)` etc., not `window.AdminAuth`.
      const used = new RegExp(`(^|[^.\\w$])${sym}\\s*[.(]`).test(body);
      if (used && !importedNames(src).has(sym)) {
        offenders.push(path.relative(ADMIN, file));
      }
    }
    assert.deepEqual(offenders, [],
      `${sym} is an ES-module export of app.js, not a global. These files reference it ` +
      `without importing it, so it is \`undefined\` at runtime:\n  ${offenders.join('\n  ')}`);
  });
}

test('no admin module guards an app.js export behind `typeof` (it hides bugs both ways)', () => {
  const offenders = [];
  for (const file of files) {
    // Comments stripped, STRINGS KEPT — the pattern we're hunting ends in the
    // literal 'undefined', so stripping strings would make this unfalsifiable.
    const body = stripComments(fs.readFileSync(file, 'utf8'));
    for (const sym of APP_EXPORTS) {
      if (new RegExp(`typeof\\s+${sym}\\s*[!=]==?\\s*['"\`]undefined['"\`]`).test(body)) {
        offenders.push(`${path.relative(ADMIN, file)} (typeof ${sym})`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'A `typeof` guard around an app.js export is never right. If the import is present the ' +
    'guard is dead code; if it is missing the guard silently changes behaviour — hiding a ' +
    'feature (canSeeCost → false) or, worse, failing OPEN on an access check ' +
    '(`typeof AdminAuth !== "undefined" && !AdminAuth.isOwner()` lets everyone through).\n  ' +
    offenders.join('\n  '));
});

test('the invoice + quick-order cost column is genuinely owner-gated (and reachable)', () => {
  // The specific regression: canSeeCost() must resolve AdminAuth through an import.
  for (const page of ['invoices.js', 'quick-order.js']) {
    const src = fs.readFileSync(path.join(ADMIN, 'pages', page), 'utf8');
    assert.ok(importedNames(src).has('AdminAuth'),
      `${page} calls AdminAuth.isOwner() in canSeeCost() — it must IMPORT AdminAuth, or the ` +
      'entire "Our Cost" column silently never renders.');
    assert.ok(/const canSeeCost = \(\) => AdminAuth\.isOwner\(\);/.test(src),
      `${page}'s canSeeCost must call AdminAuth.isOwner() directly — no typeof guard`);
  }
});

test('genuine window globals are still allowed to be typeof-guarded', () => {
  // Auth / Security / DebugLog / formatPrice are set on window by non-module scripts,
  // so they CAN legitimately be absent. This test exists so the rule above is not
  // over-applied to them by a future reader.
  const productSearch = fs.readFileSync(path.join(ADMIN, 'components', 'product-search.js'), 'utf8');
  assert.ok(/typeof Auth !== 'undefined'/.test(productSearch),
    'Auth is a real window global — guarding it is correct and should not be "fixed"');
});
