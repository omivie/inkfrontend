/**
 * Rich-text product fields persist losslessly — May 2026
 * ======================================================
 *
 * THE BUG (reported 2026-05-18, reproduced live)
 * ----------------------------------------------
 * In the admin product drawer, applying Bold / Italic / Underline / a Link in
 * the Description or "For Use In" rich-text editor and saving looked fine —
 * but after a reload the formatting was gone, leaving plain text.
 *
 * ROOT CAUSE (probed live against the production backend)
 * -------------------------------------------------------
 * `PUT/POST /api/admin/products` runs an HTML-allowlist sanitiser that keeps
 * only `p, strong, em, br, ul, ol, li`. It STRIPS `b, i, u, a, span, h2`.
 * The editor toolbar's Bold/Italic/Underline buttons emit `<b>/<i>/<u>` via
 * document.execCommand, and the Link button emits `<a>` — precisely the tags
 * the backend discards. Every formatting change was silently destroyed on save.
 *
 *   Sent:  <p>P</p><b>B</b><strong>S</strong><i>I</i><em>E</em><u>U</u>
 *          <a href="x">A</a><span>SP</span><h2>H2</h2>
 *   Stored: <p>P</p>B<strong>S</strong>I<em>E</em>U<br/>...ASP...H2
 *
 * THE FIX (two layers, defence in depth)
 * --------------------------------------
 *   1. RTE sanitiseHTML() rewrites <b>→<strong> and <i>→<em>. These semantic
 *      tags are on the backend allowlist, so Bold/Italic survive even a plain
 *      backend round-trip. (Underline has no semantic tag; <u> is kept.)
 *   2. AdminAPI.persistRichTextColumns() re-writes `description_html` and
 *      `compatible_devices_html` straight to Supabase after every create/
 *      update. Supabase stores the editor HTML verbatim — including <u> and
 *      <a> — bypassing the lossy backend sanitiser entirely. The customer PDP
 *      reads these same columns directly from Supabase, so the formatting
 *      reaches the storefront intact.
 *
 * This is a static source check (the repo has no jsdom). It pins the wiring so
 * the fix cannot silently regress.
 *
 * Run: node --test tests/rich-text-persist-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const API_SRC      = READ('inkcartridges/js/admin/api.js');
const RTE_SRC      = READ('inkcartridges/js/admin/components/rich-text-editor.js');
const APP_SRC      = READ('inkcartridges/js/admin/app.js');
const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The rich-text column manifest
// ─────────────────────────────────────────────────────────────────────────────

test('RICH_TEXT_PRODUCT_COLUMNS lists both rich-text product columns', () => {
  const m = API_SRC.match(/const\s+RICH_TEXT_PRODUCT_COLUMNS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'RICH_TEXT_PRODUCT_COLUMNS const must be defined in api.js');
  const body = m[1];
  assert.match(body, /'description_html'/, 'must include description_html');
  assert.match(body, /'compatible_devices_html'/, 'must include compatible_devices_html');
});

test('the manifest is documented with the backend-sanitiser root cause', () => {
  // The comment block above the const is the institutional memory of WHY this
  // exists — keep it anchored so a future edit cannot quietly drop the reason.
  const m = API_SRC.match(/([\s\S]{0,900})const\s+RICH_TEXT_PRODUCT_COLUMNS/);
  assert.ok(m, 'must find the lead-in comment');
  const lead = m[1];
  assert.match(lead, /sanitiser|sanitizer/i, 'comment must name the backend sanitiser');
  assert.match(lead, /strips/i, 'comment must say the backend strips tags');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. persistRichTextColumns() — the Supabase repair write
// ─────────────────────────────────────────────────────────────────────────────

function persistFnBody() {
  // Method runs from `async persistRichTextColumns(` to the matching `},`.
  const m = API_SRC.match(/async\s+persistRichTextColumns\s*\([\s\S]*?\n\s{2}\},/);
  assert.ok(m, 'persistRichTextColumns(productId, data) must be defined');
  return m[0];
}

test('persistRichTextColumns() is defined on AdminAPI', () => {
  assert.match(API_SRC, /async\s+persistRichTextColumns\s*\(\s*productId\s*,\s*data\s*\)/,
    'persistRichTextColumns(productId, data) must exist');
});

test('persistRichTextColumns() writes to the Supabase products table', () => {
  const body = persistFnBody();
  assert.match(body, /this\._sb\(\)/, 'must obtain the Supabase client via _sb()');
  assert.match(body, /\.from\(\s*['"]products['"]\s*\)/, 'must target the products table');
  assert.match(body, /\.update\(\s*patch\s*\)/, 'must .update() the assembled patch');
  assert.match(body, /\.eq\(\s*['"]id['"]\s*,\s*productId\s*\)/, 'must scope the update to the product id');
});

test('persistRichTextColumns() only writes columns present on the payload', () => {
  const body = persistFnBody();
  // Iterates the manifest, gated on hasOwnProperty — a partial update (e.g. a
  // bulk price edit) must never blank a rich-text field it never touched.
  assert.match(body, /RICH_TEXT_PRODUCT_COLUMNS/, 'must iterate the column manifest');
  assert.match(body, /hasOwnProperty\.call\(\s*data\s*,\s*col\s*\)/,
    'must gate each column on data.hasOwnProperty(col)');
  assert.match(body, /if\s*\(\s*!Object\.keys\(patch\)\.length\s*\)\s*return/,
    'must early-return when the payload carries no rich-text columns');
});

test('persistRichTextColumns() is non-fatal — never throws past the caller', () => {
  const body = persistFnBody();
  assert.match(body, /try\s*\{/, 'must wrap the Supabase write in try/catch');
  assert.match(body, /catch\s*\(/, 'must catch Supabase write failures');
  assert.match(body, /DebugLog\.warn/, 'must log failures rather than surface them');
  // The function returns a boolean, never re-throws.
  assert.doesNotMatch(body, /throw\s/, 'persistRichTextColumns must not throw');
});

test('persistRichTextColumns() writes null through (an editor can clear a field)', () => {
  const body = persistFnBody();
  assert.match(body, /data\[col\]\s*==\s*null\s*\?\s*null\s*:\s*data\[col\]/,
    'a null/undefined value must persist as SQL NULL so cleared fields stick');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. updateProduct() / createProduct() call the repair
// ─────────────────────────────────────────────────────────────────────────────

test('updateProduct() repairs the rich-text columns after the backend PUT', () => {
  const m = API_SRC.match(/async\s+updateProduct\s*\([\s\S]*?\n\s{2}\},/);
  assert.ok(m, 'updateProduct must be defined');
  const body = m[0];
  assert.match(body, /window\.API\.put\(/, 'must still PUT to the backend');
  assert.match(body, /await\s+this\.persistRichTextColumns\(\s*productId\s*,\s*data\s*\)/,
    'must await persistRichTextColumns(productId, data) after the backend write');
  // The repair must run AFTER the ok===false guard — never on a rejected save.
  const guardIdx = body.indexOf('resp.ok === false');
  const repairIdx = body.indexOf('persistRichTextColumns');
  assert.ok(guardIdx !== -1 && repairIdx > guardIdx,
    'the repair must run after the error guard, not before it');
});

test('createProduct() repairs the rich-text columns using the new product id', () => {
  const m = API_SRC.match(/async\s+createProduct\s*\([\s\S]*?\n\s{2}\},/);
  assert.ok(m, 'createProduct must be defined');
  const body = m[0];
  assert.match(body, /window\.API\.post\(\s*['"]\/api\/admin\/products['"]/,
    'must still POST to the backend');
  assert.match(body, /result\?\.product\?\.id\s*\?\?\s*result\?\.id/,
    'must resolve the new product id from either envelope shape');
  assert.match(body, /await\s+this\.persistRichTextColumns\(\s*newId\s*,\s*data\s*\)/,
    'must await persistRichTextColumns(newId, data) for the freshly created row');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. RTE sanitiseHTML() normalises presentational tags to semantic ones
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeFnBody() {
  const m = RTE_SRC.match(/function\s+sanitizeHTML\s*\(\s*html\s*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'sanitizeHTML(html) must be defined');
  return m[0];
}

test('sanitizeHTML() retags <b> → <strong>', () => {
  const body = sanitizeFnBody();
  assert.match(body, /retag\(\s*['"]b['"]\s*,\s*['"]strong['"]\s*\)/,
    "sanitizeHTML must rewrite <b> to <strong>");
});

test('sanitizeHTML() retags <i> → <em>', () => {
  const body = sanitizeFnBody();
  assert.match(body, /retag\(\s*['"]i['"]\s*,\s*['"]em['"]\s*\)/,
    "sanitizeHTML must rewrite <i> to <em>");
});

test('sanitizeHTML() preserves <u> — underline has no semantic tag', () => {
  const body = sanitizeFnBody();
  // Underline must NOT be retagged away; <u> survives via the Supabase repair.
  assert.doesNotMatch(body, /retag\(\s*['"]u['"]/,
    '<u> must not be retagged — it has no semantic equivalent');
});

test('the retag helper moves child nodes, not just text', () => {
  const body = sanitizeFnBody();
  const m = body.match(/const\s+retag\s*=\s*\([\s\S]*?\};/);
  assert.ok(m, 'retag helper must be defined');
  assert.match(m[0], /while\s*\(\s*el\.firstChild\s*\)/,
    'retag must transplant every child node so nested formatting is kept');
  assert.match(m[0], /replaceWith\(/, 'retag must swap the old element for the new one');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cache busting — the new modules must actually ship
// ─────────────────────────────────────────────────────────────────────────────

test('app.js imports api.js with the rich-text-persist cache key', () => {
  // The api.js key is module-specific: this fix changed api.js, so its import
  // must carry the matching bust query (without it the old AdminAPI module is
  // served from cache and the repair never ships).
  assert.match(APP_SRC, /from\s+['"]\.\/api\.js\?v=rich-text-persist-may2026['"]/,
    'api.js import must carry the rich-text-persist cache-bust query');
});

test('app.js APP_VERSION is a valid bumped build tag', () => {
  // APP_VERSION is a SHARED moving key — every admin feature bumps it — so this
  // pins the dated-tag shape, not the rich-text-persist slug (see ERR-032).
  const m = APP_SRC.match(/APP_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'APP_VERSION must be declared');
  assert.match(m[1], /^2026\.\d{2}\.\d{2}-[a-z0-9-]+$/i,
    'APP_VERSION must be a dated build tag (YYYY.MM.DD-slug)');
  assert.notEqual(m[1], '2026.05.17-cogs',
    'APP_VERSION must advance off the pre-May-18 build so the shell reloads');
});

test('products.js imports rich-text-editor.js with the new cache key', () => {
  assert.match(PRODUCTS_SRC, /from\s+['"]\.\.\/components\/rich-text-editor\.js\?v=rich-text-persist-may2026['"]/,
    'rich-text-editor.js import must carry the rich-text-persist cache-bust query');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The product save still sends both rich-text fields through the drawer
// ─────────────────────────────────────────────────────────────────────────────

test('the product drawer save still emits description_html + compatible_devices_html', () => {
  // Both the create and the edit save handlers must put the editor output on
  // the payload — persistRichTextColumns only repairs keys that are present.
  const occurrences = (PRODUCTS_SRC.match(/description_html:\s*modal\._descEditor\?\.getValue\(\)/g) || []).length;
  assert.ok(occurrences >= 2,
    'both the create and edit handlers must send description_html from the editor');
  const compatOcc = (PRODUCTS_SRC.match(/compatible_devices_html:\s*modal\._compatEditor\?\.getValue\(\)/g) || []).length;
  assert.ok(compatOcc >= 2,
    'both the create and edit handlers must send compatible_devices_html from the editor');
});
