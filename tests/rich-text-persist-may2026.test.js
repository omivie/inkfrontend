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
 * ── ONE OF THE TWO COLUMNS IS GONE (ERR-244, 2026-09-12) ──────────────────
 *
 * Backend migration 132 DROPPED `products.compatible_devices_html` on
 * 2026-09-10. The machine list moved to `product_compat_devices` (RLS,
 * service-role only), readable at GET /api/products/:sku/for-use-in.
 *
 * That turned layer 2 of the fix above into the bug it was built to prevent.
 * `persistRichTextColumns` sent BOTH columns in ONE `update(patch)`, and
 * PostgREST refuses the whole statement for a single unknown name:
 *
 *     {"code":"42703","message":"column products.compatible_devices_html does not exist"}
 *
 * So `description_html`'s repair — the ONLY thing keeping <b>/<i>/<u>/<a>
 * alive past the backend sanitiser — died with it. Silently: the failure was
 * reported through DebugLog.warn, a no-op off localhost (ERR-193). Every
 * product save from 2026-09-10 was quietly stripping the operator's
 * formatting, which is the EXACT SYMPTOM this suite was written for in May.
 *
 * Four tests below asserted the two-column shape. They were right for four
 * months and they are wrong now, so they are inverted rather than deleted —
 * and the property they now pin is STRONGER: one statement per column, so a
 * name that dies takes only itself with it. Deleting them would leave nothing
 * standing between here and a re-batched update the next time someone tidies
 * the loop.
 *
 * The "For Use In" editor is read-only for the same reason: no admin route
 * can write the new table (measured 2026-09-10 — every plausible path 404s
 * against a control where /api/admin/orders 401s), and the product PUT
 * answers 200 for the field and discards it.
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

test('RICH_TEXT_PRODUCT_COLUMNS lists description_html — and NOT the dropped column', () => {
  const m = API_SRC.match(/const\s+RICH_TEXT_PRODUCT_COLUMNS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'RICH_TEXT_PRODUCT_COLUMNS const must be defined in api.js');
  const body = m[1];
  assert.match(body, /'description_html'/, 'must include description_html');
  // Inverted (ERR-244). The column was dropped by backend migration 132; a
  // name in this list that the schema does not have is not a harmless leftover,
  // it is a 42703 that kills the statement its live siblings ride in.
  assert.doesNotMatch(body, /'compatible_devices_html'/,
    'compatible_devices_html was DROPPED by backend mig 132 — naming it here 42703s the repair write');
});

test('the manifest is documented with the backend-sanitiser root cause', () => {
  // The comment block above the const is the institutional memory of WHY this
  // exists — keep it anchored so a future edit cannot quietly drop the reason.
  const m = API_SRC.match(/([\s\S]{0,900})const\s+RICH_TEXT_PRODUCT_COLUMNS/);
  assert.ok(m, 'must find the lead-in comment');
  const lead = m[1];
  assert.match(lead, /sanitiser|sanitizer/i, 'comment must name the backend sanitiser');
  assert.match(lead, /strips/i, 'comment must say the backend strips tags');
  // And now also WHY the manifest shrank, so the next reader does not "restore"
  // the missing column on the reasonable-looking theory that it was lost.
  assert.match(lead, /ERR-244/, 'comment must explain why compatible_devices_html left the list');
  assert.match(lead, /132/, 'comment must name the migration that dropped it');
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
  // Was: `if (!Object.keys(patch).length) return` — the early-return of a
  // single assembled patch. There is no single patch any more (ERR-244); the
  // equivalent guard is on the filtered column list.
  assert.match(body, /if\s*\(\s*!cols\.length\s*\)/,
    'must short-circuit when the payload carries no rich-text columns');
});

test('🚨 ERR-244: ONE STATEMENT PER COLUMN — a dead name must take only itself', () => {
  // THE REGRESSION THIS SUITE NOW EXISTS TO PREVENT.
  //
  // A single `update({a, b})` is a JOINT claim about the schema: PostgREST
  // refuses it entirely if either name is unknown. When migration 132 dropped
  // `compatible_devices_html`, that one dead name stopped `description_html`
  // from being repaired at all — reinstating the very May-2026 bug this file
  // was written for, with no symptom, for two days.
  //
  // Batching the loop back up would look like a tidy-up and would re-arm it.
  const body = persistFnBody();
  assert.match(body, /for\s*\(const col of cols\)/, 'must loop the columns');
  assert.match(body, /const patch = \{ \[col\]: /,
    'each update() must carry exactly ONE column, built inside the loop');
  const updates = (body.match(/\.update\(/g) || []).length;
  assert.equal(updates, 1, 'exactly one .update() call, inside the per-column loop');
  assert.ok(
    body.indexOf('.update(') > body.indexOf('for (const col of cols)'),
    'the update must be INSIDE the loop, not a batched one before it'
  );
});

test('🚨 ERR-244: a failed repair is reported by column, not as a bare false', () => {
  // The old function answered `false` for "no Supabase client", "the write
  // failed" and — indistinguishably — was never called at all. The operator's
  // formatting had just been stripped and nothing on screen said so, because
  // DebugLog is a no-op off localhost (ERR-193). Partial-ness belongs in the
  // RETURN VALUE and in the UI, not only in a log.
  const body = persistFnBody();
  for (const key of ['attempted', 'written', 'failed', 'skipped']) {
    assert.ok(body.includes(key), `the result must report \`${key}\``);
  }
  assert.match(API_SRC, /function describeRichTextRepair\(/,
    'there must be ONE owner for the operator-facing sentence');
  assert.match(PRODUCTS_SRC, /describeRichTextRepair\(/,
    'and the product page must actually show it');
  const shown = (PRODUCTS_SRC.match(/describeRichTextRepair\(/g) || []).length;
  assert.ok(shown >= 2, 'both the create and the edit save handlers must report it');
});

test('persistRichTextColumns() is non-fatal — never throws past the caller', () => {
  const body = persistFnBody();
  assert.match(body, /try\s*\{/, 'must wrap the Supabase write in try/catch');
  assert.match(body, /catch\s*\(/, 'must catch Supabase write failures');
  assert.match(body, /DebugLog\.warn/, 'must log failures rather than surface them');
  // The function returns a RESULT OBJECT (ERR-244), never re-throws.
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

test('app.js imports admin/api.js under exactly one URL', () => {
  // ERR-124: static ES imports deliberately carry NO ?v= token. A module's
  // identity is its URL, so `X.js` and `X.js?v=t` are two modules — both
  // fetched, both evaluated, exports not identical. The old token here had
  // products.js loading its own copy while 27 other pages shared another.
  // Busting is handled by `/js/*` being `max-age=0, must-revalidate` plus
  // APP_VERSION on the dynamic page imports. Consistency is pinned by
  // tests/asset-cache-tokens.test.js §4.
  assert.match(APP_SRC, /from\s+['"]\.\/api\.js['"]/,
    'admin/api.js must be imported bare so AdminAPI is a single module instance');
  assert.doesNotMatch(APP_SRC, /from\s+['"]\.\/api\.js\?v=/,
    're-adding a token here forks AdminAPI in two (pages/planner.js imports it bare)');
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

test('products.js imports rich-text-editor.js under the same URL as page-copy.js', () => {
  // ERR-124: static ES imports deliberately carry NO ?v= token. A module's
  // identity is its URL, so `X.js` and `X.js?v=t` are two modules — both
  // fetched, both evaluated, exports not identical. The old token here had
  // products.js loading its own copy while 27 other pages shared another.
  // Busting is handled by `/js/*` being `max-age=0, must-revalidate` plus
  // APP_VERSION on the dynamic page imports. Consistency is pinned by
  // tests/asset-cache-tokens.test.js §4.
  assert.match(PRODUCTS_SRC, /from\s+['"]\.\.\/components\/rich-text-editor\.js['"]/,
    'must import rich-text-editor.js bare, matching pages/page-copy.js');
  assert.doesNotMatch(PRODUCTS_SRC, /rich-text-editor\.js\?v=/,
    'a token here loads the editor twice — once for products, once for page-copy');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The product save still sends both rich-text fields through the drawer
// ─────────────────────────────────────────────────────────────────────────────

test('the product drawer save still emits description_html from the editor', () => {
  // Both the create and the edit save handlers must put the editor output on
  // the payload — persistRichTextColumns only repairs keys that are present.
  const occurrences = (PRODUCTS_SRC.match(/description_html:\s*modal\._descEditor\?\.getValue\(\)/g) || []).length;
  assert.ok(occurrences >= 2,
    'both the create and edit handlers must send description_html from the editor');
});

test('🚨 ERR-244: the save must NOT send compatible_devices_html any more', () => {
  // Inverted. It is not merely useless now — it is actively dishonest.
  // Measured 2026-09-12 with an owner JWT against ADMIN-INK-001:
  //
  //   PUT /api/admin/products/:id  {"compatible_devices_html": "<b>x</b>"}  → 200
  //   PUT /api/admin/products/:id  {"for_use_in_html": "<b>x</b>"}          → 200
  //
  // Both accepted, both discarded — the ERR-151 decoy signature. Sending a
  // field we have measured as ignored manufactures the appearance of a save,
  // and an editor whose Save silently drops the operator's typing is strictly
  // worse than no editor: they walk away believing the work is done.
  assert.ok(
    !/compatible_devices_html:\s*modal\._compatEditor/.test(PRODUCTS_SRC),
    'the dropped column must not be sent — the PUT 200s and discards it'
  );
  assert.ok(
    !/_compatEditor\s*=\s*new RichTextEditor/.test(PRODUCTS_SRC),
    'and no editable rich-text editor may be mounted for a field that cannot be saved'
  );
  // Positive control: the OTHER editor must still be mounted, or this test
  // would pass just as well on a file where both editors had been deleted.
  assert.match(PRODUCTS_SRC, /_descEditor\s*=\s*new RichTextEditor/,
    'the description editor must still exist — this is a targeted removal, not a purge');
});
