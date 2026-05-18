/**
 * Rich-text source view shows real HTML — May 2026
 * =================================================
 *
 * Pins the contract that the </> source toggle on the admin product drawer's
 * Description and For Use In editors reveals the underlying structural HTML.
 *
 * Before the fix, the source textarea simply mirrored `editor.innerHTML`,
 * which for content authored without explicit paragraphs was a single line
 * of `&nbsp;`-glued text — no `<p>` tags visible. The fix:
 *
 *   1. `normalizeBlocks()` wraps loose top-level inline / text runs in <p>
 *      and promotes browser-inserted <div> line wrappers to <p>.
 *   2. `prettyPrintHTML()` newline-breaks block tags so each <p>/<ul>/<li>
 *      sits on its own line in the textarea.
 *   3. `_toggleSource()` runs both before swapping to the textarea, and on
 *      the reverse path collapses cosmetic whitespace before pushing back.
 *   4. `setValue()` runs the same normalize so initial content from the
 *      backend round-trips cleanly the first time the editor opens.
 *
 * This is a static check (no jsdom in repo). It reads rich-text-editor.js
 * and asserts the wiring stays in place.
 *
 * Run: node --test tests/rich-text-source-real-html.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RTE_PATH = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'components', 'rich-text-editor.js'
);
const RTE = fs.readFileSync(RTE_PATH, 'utf8');

test('normalizeBlocks() exists and wraps loose runs in <p>', () => {
  assert.match(RTE, /function\s+normalizeBlocks\s*\(\s*html\s*\)/,
    'normalizeBlocks(html) must be defined');
  // The function must reference <p> wrapping behaviour.
  const fnBody = RTE.match(/function\s+normalizeBlocks[\s\S]*?\n\}\n/);
  assert.ok(fnBody, 'must extract normalizeBlocks body');
  assert.match(fnBody[0], /createElement\(\s*['"]p['"]\s*\)/,
    'normalizeBlocks must construct <p> elements for loose content');
  assert.match(fnBody[0], /BLOCK_TAGS/,
    'normalizeBlocks must consult BLOCK_TAGS to detect block-level children');
});

test('BLOCK_TAGS lists the standard structural set', () => {
  const m = RTE.match(/const\s+BLOCK_TAGS\s*=\s*new\s+Set\(\s*\[([^\]]+)\]/);
  assert.ok(m, 'BLOCK_TAGS set must be exported');
  const items = m[1];
  for (const tag of ['p', 'div', 'ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    assert.match(items, new RegExp(`['"]${tag}['"]`),
      `BLOCK_TAGS must include '${tag}'`);
  }
});

test('prettyPrintHTML() inserts newlines around block tags', () => {
  assert.match(RTE, /function\s+prettyPrintHTML\s*\(\s*html\s*\)/,
    'prettyPrintHTML(html) must be defined');
  const fnBody = RTE.match(/function\s+prettyPrintHTML[\s\S]*?\n\}\n/);
  assert.ok(fnBody, 'must extract prettyPrintHTML body');
  // Looks for the two replace() calls (open + close block tags).
  const opens = fnBody[0].match(/\\n\$1/g) || [];
  const closes = fnBody[0].match(/\$1\\n/g) || [];
  assert.ok(opens.length >= 1, 'must insert \\n before opening block tags');
  assert.ok(closes.length >= 1, 'must insert \\n after closing block tags');
});

test('_toggleSource normalizes + pretty-prints when entering source mode', () => {
  // Locate the if-branch that runs when source mode is being switched ON.
  const m = RTE.match(/if\s*\(\s*this\._sourceMode\s*\)\s*\{[\s\S]*?\}\s*else\s*\{/);
  assert.ok(m, 'must find the source-on branch of _toggleSource');
  const onBranch = m[0];
  assert.match(onBranch, /normalizeBlocks\(/,
    'entering source mode must run normalizeBlocks() on the editor HTML');
  assert.match(onBranch, /prettyPrintHTML\(/,
    'entering source mode must pretty-print before writing to the textarea');
  assert.match(onBranch, /this\._source\.value\s*=/,
    'entering source mode must write into the source textarea');
});

test('_toggleSource collapses cosmetic whitespace when leaving source mode', () => {
  // Anchor inside _toggleSource so we don't match the else-branch of
  // normalizeBlocks.
  const toggle = RTE.match(/_toggleSource\s*\(\s*\)\s*\{([\s\S]+?this\._fireChange\(\);)/);
  assert.ok(toggle, 'must locate _toggleSource() body');
  const body = toggle[1];
  const offBranch = body.match(/\}\s*else\s*\{([\s\S]*?)\}\s*\n\s*this\._fireChange/);
  assert.ok(offBranch, 'must find the source-off branch of _toggleSource');
  assert.match(offBranch[1], /replace\(\/>\\s\+</,
    'leaving source mode must collapse cosmetic >\\s+< whitespace');
  assert.match(offBranch[1], /this\._editor\.innerHTML\s*=/,
    'leaving source mode must write into the editor');
});

test('getValue() strips cosmetic whitespace from source-mode output', () => {
  const m = RTE.match(/getValue\s*\(\)\s*\{([\s\S]*?)\}\s*\n\s*setValue/);
  assert.ok(m, 'must find getValue() body');
  const body = m[1];
  assert.match(body, /this\._sourceMode/,
    'getValue must branch on sourceMode');
  assert.match(body, /replace\(\s*\/>\\s\+</,
    'source-mode getValue must collapse cosmetic whitespace before save');
});

test('setValue() round-trips through the same normalizer', () => {
  const m = RTE.match(/setValue\s*\(\s*html\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(m, 'must find setValue() body');
  const body = m[1];
  assert.match(body, /normalizeBlocks\(/,
    'setValue must normalize so subsequent source view shows real <p> tags');
  assert.match(body, /prettyPrintHTML\(/,
    'setValue must pretty-print so the textarea mirror is readable');
});

test('Enter key uses <p> as the default paragraph separator', () => {
  assert.match(RTE, /defaultParagraphSeparator['"]\s*,\s*false\s*,\s*['"]p['"]/,
    "execCommand('defaultParagraphSeparator', false, 'p') must fire so new lines become <p>, not <div>");
});

test('Source textarea uses a monospace font + whitespace:pre for readable HTML', () => {
  assert.match(RTE, /source\.style\.fontFamily\s*=\s*['"][^'"]*monospace/,
    'source textarea must be monospace');
  assert.match(RTE, /source\.style\.whiteSpace\s*=\s*['"]pre['"]/,
    'source textarea must use white-space: pre so newlines render');
});

test('products.js still imports rich-text-editor (cache-busted)', () => {
  // The cache-bust query string is required so editors load the new module
  // even when the page module itself is already cached.
  const PRODUCTS = fs.readFileSync(
    path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'products.js'),
    'utf8'
  );
  assert.match(PRODUCTS, /from\s+['"]\.\.\/components\/rich-text-editor\.js\?v=rich-text-persist-may2026['"]/,
    'products.js must import rich-text-editor.js with the current cache-bust query');
});
