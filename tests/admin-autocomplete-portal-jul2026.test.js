/**
 * Admin autocomplete — portalled dropdown — July 2026 (ERR-107)
 * ============================================================
 *
 * The shared admin autocomplete (components/autocomplete.js) rendered its
 * results menu as a `position: absolute` child of the `.admin-ac` wrapper it
 * injects around the input. That works only when no ancestor clips — and in the
 * product editor it does clip, twice over:
 *
 *     .admin-product-modal__inner   { overflow: hidden }   ← hard clip
 *       .admin-product-modal__tab-panels { overflow-y: auto }
 *         … For Use In → Related Products search input
 *
 * The Related Products field is the LAST block in that panel, and the product
 * menu is up to 620px tall opening downward with no collision check — so all
 * but the first two result rows were cut off and unreachable. z-index is no
 * help: the menu was clipped by an ancestor, not painted underneath one.
 *
 * The fix portals the menu to <body> and places it with `position: fixed`
 * against the input's measured rect, flipping up and shrinking to fit. That
 * frees it from EVERY clipping ancestor, so the Invoices and Quick Order
 * pickers (same component) are covered too.
 *
 * These are source-level assertions — autocomplete.js is a browser ES module
 * that needs a live DOM — matching the style of
 * tests/admin-related-products-picker-jul2026.test.js.
 *
 * Run: node --test tests/admin-autocomplete-portal-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const AC = stripComments(read('inkcartridges/js/admin/components/autocomplete.js'));
const PRODUCT_SEARCH = stripComments(read('inkcartridges/js/admin/components/product-search.js'));
const PRODUCTS = stripComments(read('inkcartridges/js/admin/pages/products.js'));
const CSS = read('inkcartridges/css/admin.css');

// The `.admin-ac__menu { ... }` rule body, comments stripped.
function menuRule(selector) {
  const re = new RegExp(`\\n${selector.replace(/[.\-]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = stripComments(CSS).match(re);
  assert.ok(m, `expected a ${selector} rule in css/admin.css`);
  return m[1];
}

// ── 1. The menu is portalled out of the clipping ancestors ─────────────────
test('the menu is appended to document.body, not the input wrapper', () => {
  assert.match(AC, /document\.body\.appendChild\(menu\)/);
  // The old bug: the menu parented to the wrapper, inheriting its clipping.
  assert.doesNotMatch(AC, /wrap\.appendChild\(menu\)/);
});

test('the menu element is created fresh rather than reused from the wrapper', () => {
  assert.doesNotMatch(AC, /wrap\.querySelector\(['"]\.admin-ac__menu['"]\)/);
});

// ── 2. It is placed against the input's measured rect ──────────────────────
test('positionMenu measures the input rect', () => {
  assert.match(AC, /function positionMenu\s*\(/);
  assert.match(AC, /input\.getBoundingClientRect\(\)/);
});

test('positionMenu can flip the menu above the input', () => {
  // A downward-only menu is exactly what got clipped at the bottom of the panel.
  assert.match(AC, /flipUp/);
  assert.match(AC, /menu\.style\.bottom\s*=/);
  assert.match(AC, /menu\.style\.top\s*=/);
});

test('positionMenu shrinks the menu to the space actually available', () => {
  // JS publishes the space; CSS min()s it against the variant's own ceiling.
  // Reading the ceiling back into JS instead would cache a `vh` value that goes
  // stale on the next window resize (caught in browser verification).
  assert.match(AC, /setProperty\('--admin-ac-fit'/);
  assert.doesNotMatch(AC, /menu\.style\.maxHeight\s*=/);
  assert.match(menuRule('.admin-ac__menu'), /max-height:\s*min\(var\(--admin-ac-fit/);
  assert.match(menuRule('.admin-ac__menu--product'), /max-height:\s*min\(var\(--admin-ac-fit/);
});

test('positionMenu clamps horizontally so the menu stays on screen', () => {
  assert.match(AC, /menu\.style\.left\s*=/);
  assert.match(AC, /window\.innerWidth/);
});

// ── 3. A fixed menu must be re-placed as things scroll ─────────────────────
test('the scroll listener is registered in the CAPTURE phase', () => {
  // The element that scrolls is .admin-product-modal__tab-panels, not the
  // window, and scroll events do not bubble — capture is the only way to see it.
  assert.match(AC, /addEventListener\('scroll',\s*reposition,\s*true\)/);
  assert.match(AC, /addEventListener\('resize',\s*reposition\)/);
});

test('the menu hides once its input scrolls out of view', () => {
  // Nothing clips a <body>-level fixed menu, so it would otherwise float over
  // unrelated UI after the operator scrolls the field away.
  assert.match(AC, /function inputStillVisible\s*\(/);
  assert.match(AC, /nearestScrollParent/);
  assert.match(AC, /if\s*\(!inputStillVisible\(\)\)\s*\{\s*hide\(\);/);
});

// ── 4. Teardown — an orphaned <body> menu is the new failure mode ──────────
test('hide() drops the scroll and resize listeners', () => {
  const hideBody = AC.match(/function hide\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(hideBody, 'expected a hide() function');
  assert.match(hideBody[1], /removeEventListener\('scroll',\s*reposition,\s*true\)/);
  assert.match(hideBody[1], /removeEventListener\('resize',\s*reposition\)/);
});

test('destroy() removes the body-level menu AND its window listeners', () => {
  // Slice from the returned api object — the early `return { destroy() {} }`
  // no-op guard at the top of the module is NOT the one under test.
  const at = AC.indexOf('const api = {');
  assert.ok(at > -1, 'expected the autocomplete to return an `api` object');
  const destroyBody = AC.slice(at);
  assert.match(destroyBody, /removeEventListener\('scroll',\s*reposition,\s*true\)/);
  assert.match(destroyBody, /removeEventListener\('resize',\s*reposition\)/);
  assert.match(destroyBody, /menu\.remove\(\)/);
});

test('re-attaching to the same input tears down the previous instance', () => {
  // Without this a second attach would strand the first menu in <body> forever.
  assert.match(AC, /input\._adminAc\?\.destroy\?\.\(\)/);
  assert.match(AC, /input\._adminAc\s*=\s*api/);
});

// ── 5. CSS matches the new positioning model ───────────────────────────────
test('.admin-ac__menu is position:fixed, never absolute', () => {
  const rule = menuRule('.admin-ac__menu');
  assert.match(rule, /position:\s*fixed/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
  // JS owns the geometry now; a hardcoded top/right would fight it.
  assert.doesNotMatch(rule, /top:\s*calc\(100%/);
});

test('.admin-ac__menu clears the product modal and drawer, but not the confirm backdrop', () => {
  const z = Number(menuRule('.admin-ac__menu').match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(z > 1100, `menu z-index ${z} must clear .admin-product-modal (1100)`);
  assert.ok(z < 1200, `menu z-index ${z} must stay under .admin-modal-backdrop (1200)`);
});

test('the base menu width tracks the input via the anchor custom property', () => {
  assert.match(menuRule('.admin-ac__menu'), /width:\s*var\(--admin-ac-anchor-w/);
  assert.match(AC, /setProperty\('--admin-ac-anchor-w'/);
  // The product variant overrides with its own fixed width — cascade decides,
  // so positionMenu never has to know which variant it is placing.
  assert.match(menuRule('.admin-ac__menu--product'), /width:\s*560px/);
});

// ── 6. The Related Products picker opts in to the focus scroll ─────────────
test('attachProductAutocomplete forwards extra options through', () => {
  assert.match(PRODUCT_SEARCH, /attachProductAutocomplete\(input,\s*\{\s*onPick,\s*\.\.\.rest\s*\}/);
  assert.match(PRODUCT_SEARCH, /\.\.\.rest,/);
});

test('the Related Products search scrolls itself into view on focus', () => {
  assert.match(PRODUCTS, /attachProductAutocomplete\(searchEl,\s*\{\s*scrollIntoViewOnFocus:\s*true/);
  assert.match(AC, /scrollIntoViewOnFocus/);
  // Opt-in only — invoice/quick-order line-item inputs must not jump mid-entry.
  assert.match(AC, /scrollIntoViewOnFocus = false/);
  assert.match(AC, /if \(scrollIntoViewOnFocus\) input\.addEventListener\('focus', onFocus\)/);
});
