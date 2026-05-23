/**
 * Admin Products — per-account column customization — May 2026
 * ============================================================
 *
 * The admin "All Products" table had a fixed column set. Admins who work with
 * ribbons want to see the device brands a ribbon fits ("For Use In"); admins
 * who work with ink/toner do not, and that column makes every row tall. The
 * fix gives each admin account its own column layout:
 *
 *   1. A new toggleable "For Use In" column — renders the device brands from
 *      the product_ribbon_brands junction as chips. Ships hidden by default
 *      (DEFAULT_HIDDEN_COLUMNS) because it is space-heavy.
 *
 *   2. A "Columns" popover in the products toolbar — one checkbox per column.
 *      The Name column is locked visible (LOCKED_VISIBLE_COLUMNS); everything
 *      else can be hidden. A Reset button restores the shipped layout.
 *
 *   3. Per-account persistence — the hidden-column list is stored under the
 *      "products.columns" key via AdminAPI.getUiPrefs / setUiPref, which is
 *      backed by the Supabase `admin_ui_prefs` table (RLS-locked to the
 *      account) with a localStorage cache + offline fallback. One admin can
 *      keep "For Use In" on while another keeps it off.
 *
 *   4. DataTable.setColumns() — swaps the visible column set and repaints
 *      without re-fetching; sort/selection state is preserved.
 *
 * This test executes the real pure logic (computeVisibleColumns,
 * renderColumnPickerPanel) extracted from source, and structurally pins the
 * wiring, the API surface, the CSS and the SQL migration.
 *
 * Run: node --test tests/admin-column-customization.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');
const API_SRC      = READ('inkcartridges/js/admin/api.js');
const APP_SRC      = READ('inkcartridges/js/admin/app.js');
const TABLE_SRC    = READ('inkcartridges/js/admin/components/table.js');
const CSS_SRC      = READ('inkcartridges/css/admin.css');

// ── Helper: extract a top-level function body by brace matching ──────────────
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The "For Use In" column
// ─────────────────────────────────────────────────────────────────────────────

test('buildColumns defines a for_use_in column with the right shape', () => {
  const build = extractFunction(PRODUCTS_SRC, 'function buildColumns(');
  assert.match(build, /key:\s*'for_use_in'/, 'for_use_in column must exist');
  assert.match(build, /className:\s*'col-w-fuin'/, 'must use the col-w-fuin width class');
  assert.match(build, /data-fuin-id="\$\{esc\(r\.id/, 'cell must carry data-fuin-id for async fill');
  assert.match(build, /admin-fuin-cell/, 'cell must use the .admin-fuin-cell container');
});

test('for_use_in ships hidden by default; Name is the only locked column', () => {
  const hidden = PRODUCTS_SRC.match(/const DEFAULT_HIDDEN_COLUMNS\s*=\s*\[([^\]]*)\]/);
  assert.ok(hidden, 'DEFAULT_HIDDEN_COLUMNS must be declared');
  const keys = hidden[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(keys, ['for_use_in'], 'only for_use_in is hidden by default');

  const locked = PRODUCTS_SRC.match(/const LOCKED_VISIBLE_COLUMNS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(locked, 'LOCKED_VISIBLE_COLUMNS must be declared');
  const lockedKeys = locked[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(lockedKeys, ['name'], 'only Name is locked visible');
});

test('every column gets picker metadata (pickerLabel + lockedVisible)', () => {
  const build = extractFunction(PRODUCTS_SRC, 'function buildColumns(');
  assert.match(build, /col\.pickerLabel\s*=\s*COLUMN_PICKER_LABELS\[col\.key\]/,
    'buildColumns must stamp pickerLabel onto every column');
  assert.match(build, /col\.lockedVisible\s*=\s*LOCKED_VISIBLE_COLUMNS\.has\(col\.key\)/,
    'buildColumns must stamp lockedVisible onto every column');
  // The picker-label map must name the new column.
  assert.match(PRODUCTS_SRC, /for_use_in:\s*'For Use In[^']*'/,
    'COLUMN_PICKER_LABELS must label for_use_in');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. computeVisibleColumns — executed for real
// ─────────────────────────────────────────────────────────────────────────────

const computeVisibleColumns = new Function(
  `${extractFunction(PRODUCTS_SRC, 'function computeVisibleColumns(')}; return computeVisibleColumns;`,
)();

const SAMPLE_COLUMNS = [
  { key: 'images', lockedVisible: false },
  { key: 'name', lockedVisible: true },
  { key: 'sku', lockedVisible: false },
  { key: 'cost_price', lockedVisible: false },
  { key: 'for_use_in', lockedVisible: false },
];

test('computeVisibleColumns hides columns in the hidden set', () => {
  const visible = computeVisibleColumns(SAMPLE_COLUMNS, new Set(['for_use_in', 'cost_price']));
  assert.deepEqual(visible.map(c => c.key), ['images', 'name', 'sku']);
});

test('computeVisibleColumns never hides a locked column, even if listed', () => {
  // A stale preference that somehow lists "name" must not blank the anchor col.
  const visible = computeVisibleColumns(SAMPLE_COLUMNS, new Set(['name', 'sku']));
  assert.ok(visible.some(c => c.key === 'name'), 'Name stays visible despite being in hidden set');
  assert.ok(!visible.some(c => c.key === 'sku'), 'sku is correctly hidden');
});

test('computeVisibleColumns accepts an array or a Set of hidden keys', () => {
  const fromArray = computeVisibleColumns(SAMPLE_COLUMNS, ['for_use_in']);
  const fromSet   = computeVisibleColumns(SAMPLE_COLUMNS, new Set(['for_use_in']));
  assert.deepEqual(fromArray.map(c => c.key), fromSet.map(c => c.key));
  assert.ok(!fromArray.some(c => c.key === 'for_use_in'));
});

test('computeVisibleColumns with an empty hidden set returns every column', () => {
  const visible = computeVisibleColumns(SAMPLE_COLUMNS, new Set());
  assert.equal(visible.length, SAMPLE_COLUMNS.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. renderColumnPickerPanel — executed for real against a fake panel
// ─────────────────────────────────────────────────────────────────────────────

const renderColumnPickerPanel = new Function(
  '_allColumns', '_hiddenColumns', 'esc',
  `${extractFunction(PRODUCTS_SRC, 'function renderColumnPickerPanel(')}; return renderColumnPickerPanel;`,
);

function runPicker(hiddenKeys) {
  const cols = [
    { key: 'name', pickerLabel: 'Name', lockedVisible: true },
    { key: 'sku', pickerLabel: 'SKU', lockedVisible: false },
    { key: 'for_use_in', pickerLabel: 'For Use In (device brands)', lockedVisible: false },
  ];
  const panel = { innerHTML: '' };
  const fn = renderColumnPickerPanel(cols, new Set(hiddenKeys), (s) => String(s));
  fn(panel);
  return panel.innerHTML;
}

test('renderColumnPickerPanel renders one checkbox per column', () => {
  const html = runPicker([]);
  for (const key of ['name', 'sku', 'for_use_in']) {
    assert.ok(html.includes(`data-col-key="${key}"`), `panel must have a checkbox for ${key}`);
  }
});

test('renderColumnPickerPanel checks visible columns and unchecks hidden ones', () => {
  const html = runPicker(['for_use_in']);
  assert.match(html, /data-col-key="for_use_in"(?![^>]*checked)/,
    'a hidden column checkbox must NOT be checked');
  assert.match(html, /data-col-key="sku"[^>]*checked/, 'a visible column checkbox must be checked');
});

test('renderColumnPickerPanel locks the Name checkbox (checked + disabled)', () => {
  const html = runPicker(['name']); // even if hidden-set lists it
  const nameCb = html.match(/<input[^>]*data-col-key="name"[^>]*>/)[0];
  assert.match(nameCb, /checked/, 'locked column is always checked');
  assert.match(nameCb, /disabled/, 'locked column cannot be unticked');
});

test('renderColumnPickerPanel includes a Reset control and account-sync note', () => {
  const html = runPicker([]);
  assert.match(html, /data-col-reset/, 'panel must have a Reset button');
  assert.match(html, /synced to every device/i, 'panel must explain the sync behaviour');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DataTable.setColumns
// ─────────────────────────────────────────────────────────────────────────────

test('DataTable exposes setColumns that swaps columns and repaints', () => {
  const fn = extractFunction(TABLE_SRC, 'setColumns(');
  assert.match(fn, /this\.config\.columns\s*=/, 'setColumns must replace config.columns');
  assert.match(fn, /this\._render\(\)/, 'setColumns must repaint');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Per-account preference API (admin_ui_prefs)
// ─────────────────────────────────────────────────────────────────────────────

test('AdminAPI exposes getUiPrefs and setUiPref', () => {
  assert.match(API_SRC, /\n {2}getUiPrefs\(\) \{/, 'getUiPrefs must exist');
  assert.match(API_SRC, /async setUiPref\(key, value\)/, 'setUiPref must exist');
});

test('UI prefs read + write the Supabase admin_ui_prefs table', () => {
  const get = extractFunction(API_SRC, 'getUiPrefs() {');
  const set = extractFunction(API_SRC, 'async setUiPref(');
  assert.match(get, /from\('admin_ui_prefs'\)\.select\('prefs'\)/, 'getUiPrefs must read admin_ui_prefs');
  assert.match(set, /from\('admin_ui_prefs'\)\.upsert\(/, 'setUiPref must upsert admin_ui_prefs');
  assert.match(set, /onConflict:\s*'user_id'/, 'upsert must conflict-target user_id');
});

test('UI prefs are scoped to the account id and cached in localStorage', () => {
  assert.match(API_SRC, /_uiPrefsLocalKey\(\)\s*\{[^}]*admin_ui_prefs:\$\{this\._uiPrefsAccountId\(\)\}/s,
    'localStorage key must be namespaced by the account id');
  const get = extractFunction(API_SRC, 'getUiPrefs() {');
  assert.match(get, /_uiPrefsReadLocal\(\)/, 'getUiPrefs must seed from the localStorage cache');
  const set = extractFunction(API_SRC, 'async setUiPref(');
  assert.match(set, /_uiPrefsWriteLocal\(next\)/, 'setUiPref must write the localStorage cache');
});

test('UI prefs fail open — getUiPrefs still returns local cache on error', () => {
  const get = extractFunction(API_SRC, 'getUiPrefs() {');
  assert.match(get, /catch\b[\s\S]*adminApiWarn/, 'getUiPrefs must swallow Supabase errors');
  assert.match(get, /resolved = this\._uiPrefsReadLocal\(\)/,
    'getUiPrefs must fall back to the local copy');
});

test('getUiPrefs is race-safe — concurrent callers share one in-flight promise', () => {
  // Regression guard: an earlier version published the local-only value to
  // _uiPrefsCache synchronously, so a second caller arriving mid-fetch got
  // stale per-browser defaults instead of the durable Supabase prefs.
  const get = extractFunction(API_SRC, 'getUiPrefs() {');
  assert.match(get, /if \(this\._uiPrefsPromise\) return this\._uiPrefsPromise/,
    'a second caller must reuse the in-flight promise');
  assert.match(get, /this\._uiPrefsCache = resolved/,
    'the cache must be published only after reconciliation completes');
  // _uiPrefsCache must NOT be assigned before the await — it would leak the
  // half-resolved state. The only assignment is the post-await publish.
  const assigns = get.match(/this\._uiPrefsCache\s*=/g) || [];
  assert.equal(assigns.length, 1, '_uiPrefsCache must be assigned exactly once, after the fetch');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Products page wiring
// ─────────────────────────────────────────────────────────────────────────────

test('the products toolbar mounts the Columns picker', () => {
  const render = extractFunction(PRODUCTS_SRC, 'async function renderProductsContent(');
  assert.match(render, /\$\{columnPickerMarkup\(\)\}/, 'toolbar must include the Columns button');
  assert.match(render, /wireColumnPicker\(header\)/, 'the picker must be wired');
});

test('renderProductsContent resolves the saved layout before building the table', () => {
  const render = extractFunction(PRODUCTS_SRC, 'async function renderProductsContent(');
  assert.match(render, /await AdminAPI\.getUiPrefs\(\)/, 'must load this admin\'s prefs');
  assert.match(render, /uiPrefs\[COLUMN_PREF_KEY\]/, 'must read the products.columns pref');
  assert.match(render, /columns:\s*computeVisibleColumns\(_allColumns, _hiddenColumns\)/,
    'the DataTable must be built from the visible column set');
});

test('COLUMN_PREF_KEY is the products.columns string', () => {
  assert.match(PRODUCTS_SRC, /const COLUMN_PREF_KEY\s*=\s*'products\.columns'/);
});

test('toggling a column persists via setUiPref and repaints the table', () => {
  const wire = extractFunction(PRODUCTS_SRC, 'function wireColumnPicker(');
  assert.match(wire, /admin-colpicker__cb/, 'must listen on the column checkboxes');
  assert.match(wire, /_hiddenColumns\.delete\(key\)/, 'ticking a box shows the column');
  assert.match(wire, /_hiddenColumns\.add\(key\)/, 'unticking a box hides the column');
  assert.match(wire, /applyColumnVisibility\(\)/, 'a toggle must repaint the table');
  assert.match(wire, /persistColumnPrefs\(\)/, 'a toggle must persist');
  assert.match(wire, /data-col-reset/, 'Reset must be handled');

  const persist = extractFunction(PRODUCTS_SRC, 'function persistColumnPrefs(');
  assert.match(persist, /AdminAPI\.setUiPref\(COLUMN_PREF_KEY/, 'persist must call setUiPref');

  const apply = extractFunction(PRODUCTS_SRC, 'function applyColumnVisibility(');
  assert.match(apply, /_table\.setColumns\(computeVisibleColumns\(/, 'apply must swap the columns');
  assert.match(apply, /loadRowExtras\(\)/, 'apply must refill async cells');
});

test('a locked column cannot be hidden through the picker', () => {
  const wire = extractFunction(PRODUCTS_SRC, 'function wireColumnPicker(');
  assert.match(wire, /if \(!col \|\| col\.lockedVisible\) return/,
    'the change handler must reject locked columns');
});

test('persistColumnPrefs is no-op guarded against redundant writes', () => {
  const persist = extractFunction(PRODUCTS_SRC, 'function persistColumnPrefs(');
  assert.match(persist, /if \(serialized === _lastPersistedColumns\) return/,
    'an unchanged layout must not round-trip to Supabase');
  assert.match(persist, /_lastPersistedColumns = serialized/,
    'persist must record what it wrote');
  // The loaded layout must seed the baseline so page-open never self-persists.
  const render = extractFunction(PRODUCTS_SRC, 'async function renderProductsContent(');
  assert.match(render, /_lastPersistedColumns = serializeHiddenColumns\(\)/,
    'renderProductsContent must seed the persist baseline from the loaded layout');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. "For Use In" data loading
// ─────────────────────────────────────────────────────────────────────────────

test('loadForUseInBrands batches one product_ribbon_brands query and chips it', () => {
  const fn = extractFunction(PRODUCTS_SRC, 'async function loadForUseInBrands(');
  assert.match(fn, /if \(_hiddenColumns\.has\('for_use_in'\)\) return/,
    'must no-op when the column is hidden');
  assert.match(fn, /from\('product_ribbon_brands'\)/, 'must query the junction table');
  assert.match(fn, /\.in\('product_id', ids\)/, 'must batch by the visible row ids');
  assert.match(fn, /admin-fuin-chip/, 'must render device brands as chips');
  assert.match(fn, /AbortController/, 'must be abortable like loadCompatCounts');
});

test('loadRowExtras drives both async columns and replaces loadCompatCounts callers', () => {
  const fn = extractFunction(PRODUCTS_SRC, 'function loadRowExtras(');
  assert.match(fn, /loadCompatCounts\(\)/);
  assert.match(fn, /loadForUseInBrands\(\)/);
  // loadProducts must funnel through loadRowExtras, not call loadCompatCounts raw.
  const load = extractFunction(PRODUCTS_SRC, 'async function loadProducts(');
  assert.ok(!/[^a-zA-Z]loadCompatCounts\(\)/.test(load),
    'loadProducts must call loadRowExtras, never loadCompatCounts directly');
  assert.match(load, /loadRowExtras\(\)/, 'loadProducts must call loadRowExtras');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. CSS + SQL
// ─────────────────────────────────────────────────────────────────────────────

test('admin.css carries the column-picker and For-Use-In styles', () => {
  for (const sel of ['.admin-colpicker__panel', '.admin-colpicker__row', '.admin-fuin-chip',
                      '.admin-fuin-cell', '.col-w-fuin']) {
    assert.ok(CSS_SRC.includes(sel), `admin.css must define ${sel}`);
  }
});

test('the admin_ui_prefs SQL migration exists with RLS locked to the account', () => {
  const sql = READ('inkcartridges/sql/admin_ui_prefs.sql');
  assert.match(sql, /create table if not exists public\.admin_ui_prefs/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /auth\.uid\(\) = user_id/, 'RLS must scope rows to the owning account');
  assert.match(sql, /grant select, insert, update on public\.admin_ui_prefs to authenticated/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Cache busting
// ─────────────────────────────────────────────────────────────────────────────

test('module cache keys are bumped so the new code ships', () => {
  // APP_VERSION is a moving cache key — every admin feature bumps it — so this
  // pins the dated-build-tag SHAPE, not any one feature's slug (see ERR-032:
  // never freeze a moving value to a literal).
  const m = APP_SRC.match(/APP_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'APP_VERSION must be declared');
  assert.match(m[1], /^2026\.\d{2}\.\d{2}-[a-z0-9-]+$/i,
    'APP_VERSION must be a dated build tag (YYYY.MM.DD-slug)');
  assert.notEqual(m[1], '2026.05.17-cogs',
    'APP_VERSION must change off the pre-column-customize build');
  assert.match(APP_SRC, /from '\.\/api\.js\?v=col-customize-may2026'|from '\.\/api\.js\?v=[a-z0-9-]+'/,
    'api.js import must carry a cache-bust query');
  assert.match(PRODUCTS_SRC, /from '\.\.\/components\/table\.js\?v=[a-z0-9-]+'/,
    'table.js import must be cache-busted');
});
