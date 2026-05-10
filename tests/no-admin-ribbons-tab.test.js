/**
 * Admin Ribbons tab removal — May 2026
 * ====================================
 *
 * Pins the May 2026 cleanup that removed the redundant "Ribbons" tab from
 * the admin /admin#products page. Ribbons are still products and are
 * managed from the All Products tab (filter by type = printer_ribbon /
 * typewriter_ribbon / correction_tape). The dedicated Ribbons tab and its
 * 1300-line page module had drifted into duplicate-of-Products territory.
 *
 * If a future change re-introduces any of the following, this test fails:
 *
 *   • The admin Ribbons tab button (data-prod-tab="ribbons")
 *   • A `tab === 'ribbons'` branch in switchProductTab
 *   • inkcartridges/js/admin/pages/ribbons.js (the deleted module)
 *   • A dynamic import of './ribbons.js' anywhere under js/admin/
 *
 * The /ribbons customer-facing browse page is intentionally untouched —
 * it is a real shopper surface, not what this cleanup targeted.
 *
 * Run with: node --test tests/no-admin-ribbons-tab.test.js
 *
 * Spec: readfirst/admin-ribbons-tab-removed-may2026.md
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PRODUCTS_JS = path.join(ROOT, 'inkcartridges/js/admin/pages/products.js');
const APP_JS = path.join(ROOT, 'inkcartridges/js/admin/app.js');
const RIBBONS_MODULE = path.join(ROOT, 'inkcartridges/js/admin/pages/ribbons.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

test('admin products.js has no Ribbons tab button', () => {
  const src = read(PRODUCTS_JS);
  assert.ok(
    !/data-prod-tab="ribbons"/.test(src),
    'products.js must not contain a data-prod-tab="ribbons" tab button',
  );
  assert.ok(
    !/>Ribbons<\/button>/.test(src),
    'products.js must not render a >Ribbons</button> tab label',
  );
});

test('admin products.js has no ribbons branch in switchProductTab', () => {
  const src = read(PRODUCTS_JS);
  assert.ok(
    !/tab\s*===\s*['"]ribbons['"]/.test(src),
    'switchProductTab must not branch on tab === "ribbons"',
  );
});

test('admin pages/ribbons.js is deleted', () => {
  assert.ok(
    !fs.existsSync(RIBBONS_MODULE),
    `${RIBBONS_MODULE} must not exist — the Ribbons admin page module was retired May 2026`,
  );
});

test('no admin code imports the deleted ribbons.js module', () => {
  const adminDir = path.join(ROOT, 'inkcartridges/js/admin');
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs)$/.test(entry.name)) continue;
      const txt = fs.readFileSync(full, 'utf8');
      if (/import\s*\(\s*['"]\.\/ribbons\.js['"]\s*\)/.test(txt) ||
          /from\s+['"]\.\/ribbons\.js['"]/.test(txt) ||
          /from\s+['"]\.\/pages\/ribbons(\.js)?['"]/.test(txt)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  }
  walk(adminDir);
  assert.deepEqual(offenders, [], `Stale ribbons.js import in: ${offenders.join(', ')}`);
});

test('legacy "ribbons" → "products" route redirect is preserved for old bookmarks', () => {
  // Deliberate: dropping the redirect would 404 anyone with an old #ribbons
  // bookmark. Cheap to keep, kind to keep.
  const src = read(APP_JS);
  assert.ok(
    /['"]ribbons['"]\s*:\s*['"]products['"]/.test(src),
    'app.js ROUTE_REDIRECTS must keep "ribbons":"products" for old bookmarks',
  );
});
