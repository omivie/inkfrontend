/**
 * Admin centre on an iPhone (ERR-338, owner 2026-10-15)
 * =====================================================
 * Owner screenshot, iPhone SE 375x667, #analytics?tab=pricing: the Tier Price
 * Multipliers table was cut off at the right edge with no way to scroll it, and
 * the floating hamburger sat on top of the filter bar.
 *
 * probe:admin-mobile measured 248 findings across 46 routes x 2 iPhone widths
 * before the fix. These assertions pin the SHARED rules that fixed them, so a
 * page cannot regress by being written without a wrapper. Real boxes are
 * measured by `npm run probe:admin-mobile`, not here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments');

const INK = path.join(__dirname, '..', 'inkcartridges');
const css = stripComments(fs.readFileSync(path.join(INK, 'css/admin.css'), 'utf8'));

/** Bodies of every `@media (max-width: 768px)` block, joined. */
const phone = (() => {
  const out = [];
  const re = /@media \(max-width: 768px\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1; let i = re.lastIndex;
    while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out.join('\n');
})();

test('§1 every raw admin table scrolls sideways on a phone (the owner\'s screenshot)', () => {
  assert.match(phone, /\.admin-main table:not\(\.admin-table-wrap > table\)\s*\{[^}]*display:\s*block[^}]*overflow-x:\s*auto/);
});

test('§2 the menu button is a full-width bar and the content starts below it', () => {
  assert.match(phone, /\.admin-mobile-menu\s*\{[^}]*width:\s*100%[^}]*z-index:\s*798/);
  assert.match(phone, /\.admin-content-wrapper\s*\{\s*padding-top:\s*48px/);
  // The old padding sat on .admin-main, BELOW #filter-bar, so the bar was covered.
  assert.doesNotMatch(phone, /\.admin-main\s*\{\s*padding-top:\s*52px/);
});

test('§3 inputs are 16px on a phone (iOS Safari zooms on focus below that)', () => {
  assert.match(phone, /\.admin-shell select, \.admin-shell textarea,[\s\S]*?\{\s*font-size:\s*16px;\s*\}/);
  for (const f of ['js/admin/pages/cc-profit.js', 'js/admin/pages/cc-market-intel.js']) {
    const src = fs.readFileSync(path.join(INK, f), 'utf8');
    assert.doesNotMatch(src, /id="(cc-margin-min-gap|mi-brand-filter|mi-variance-input)"[^>]*font-size:\s*13px/, `${f}: an inline font-size beats the phone rule`);
  }
});

test('§4 tab strips scroll, action rows wrap', () => {
  assert.match(phone, /\.admin-tabs, \.admin-analytics-tabs, \.cc-heatmap\s*\{\s*overflow-x:\s*auto/);
  assert.match(phone, /\.admin-page-header__actions, \.cc2-pack-controls__actions, \.admin-pagination\s*\{\s*flex-wrap:\s*wrap/);
});

test('§5 no auto-fit grid demands a column wider than a phone', () => {
  const bad = [...css.matchAll(/minmax\((\d+)px,\s*1fr\)/g)].filter((m) => Number(m[1]) > 300).map((m) => m[0]);
  assert.deepEqual(bad, [], 'wrap the minimum as minmax(min(Npx, 100%), 1fr)');
});
