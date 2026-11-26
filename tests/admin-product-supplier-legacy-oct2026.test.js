/**
 * ERR-315 — the product drawer 500'd on Save for any product whose supplier
 * slug was not in SUPPLIER_LABELS.
 *
 * The Supplier <select> only listed dsnz + augmento. Live rows also hold okin,
 * unknown, internal and consumables_co_nz (measured 2026-10-08: 127 rows, and
 * zero rows with a NULL supplier). With no matching <option> the browser fell
 * back to "— not recorded —", Save sent `supplier: null`, and the backend
 * answered 500 "Failed to update product".
 *
 * These tests RENDER the shipped sourcingFieldsHtml() + buildSelect() and read
 * what the browser would select, rather than grepping for a call.
 *
 * Run: node --test tests/admin-product-supplier-legacy-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const PAGE = stripComments(fs.readFileSync(
  path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'products.js'), 'utf8'));

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// eslint-disable-next-line no-new-func
const { sourcingFieldsHtml } = new Function('esc', 'SUPPLIER_LABELS', 'PACK_PACK_TYPES', 'UNASSIGNED_LABEL', 'SUPPLIER_CHANGE_WARNING',
  `${extractFunction(PAGE, 'buildSelect')}\n${extractFunction(PAGE, 'supplierChoices')}\n${extractFunction(PAGE, 'sourcingFieldsHtml')}\nreturn { sourcingFieldsHtml };`
)(esc, { dsnz: 'DSNZ', augmento: 'Augmento', ribbon: 'Streamline' }, ['value_pack', 'multipack'], 'Unassigned', 'warning text');

const formGroup = (label, html) => html;

/** The value a browser would submit for #edit-supplier: the selected option, else the first. */
function submittedSupplier(html) {
  const select = html.match(/<select[^>]*id="edit-supplier"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, '#edit-supplier select must render');
  const options = [...select[1].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
  const chosen = options.find((o) => /\bselected\b/.test(o[2])) || options[0];
  return chosen[1];
}

for (const slug of ['consumables_co_nz', 'okin', 'unknown', 'internal']) {
  test(`an unlisted supplier "${slug}" survives a save untouched`, () => {
    assert.equal(submittedSupplier(sourcingFieldsHtml(formGroup, { supplier: slug })), slug);
  });
}

test('[CONTROL] listed suppliers and the create modal behave as before', () => {
  assert.equal(submittedSupplier(sourcingFieldsHtml(formGroup, { supplier: 'dsnz' })), 'dsnz');
  assert.equal(submittedSupplier(sourcingFieldsHtml(formGroup, { supplier: 'augmento' })), 'augmento');
  assert.equal(submittedSupplier(sourcingFieldsHtml(formGroup)), '', 'new product: "— not recorded —"');
  assert.match(sourcingFieldsHtml(formGroup), /class="admin-select" id="edit-supplier"/);
});

// ERR-399 (backend fe97a98, 2026-11-26): ribbons moved to key `ribbon`, shown as
// "Streamline"; the stored literal `unknown` is offered as "Unassigned" rather
// than kept as an unlabelled "(legacy)" leftover.
test('ERR-399: a ribbon product opens with Streamline selected, and saves `ribbon` back', () => {
  const html = sourcingFieldsHtml(formGroup, { supplier: 'ribbon' });
  assert.equal(submittedSupplier(html), 'ribbon');
  assert.match(html, /<option value="ribbon" selected>Streamline<\/option>/);
  assert.doesNotMatch(html, /\(legacy\)/);
});

test('ERR-399: `unknown` is a named choice ("Unassigned"), not a legacy leftover', () => {
  const html = sourcingFieldsHtml(formGroup, { supplier: 'unknown' });
  assert.equal(submittedSupplier(html), 'unknown');
  assert.match(html, /<option value="unknown" selected>Unassigned<\/option>/);
  assert.doesNotMatch(html, /\(legacy\)/);
});

test('ERR-399: the import warning ships hidden under the Supplier select', () => {
  const html = sourcingFieldsHtml(formGroup, { supplier: 'ribbon' });
  assert.match(html, /<p class="manual-price-override__hint" id="edit-supplier-warning" hidden>warning text<\/p>/);
});
