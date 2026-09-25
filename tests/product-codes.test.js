/**
 * Product Codes — manual /shop categorisation codes (May 2026)
 * ============================================================
 *
 * A product is categorised brand > type > CODE. The /shop drilldown groups
 * products into "code" chips (Brother › Ink › LC40). Until now those codes
 * were derived only — the backend extracts `series_codes` from each product's
 * name/SKU/part-number at query time, with no way for an admin to correct or
 * extend them.
 *
 * This feature adds a MANUAL OVERRIDE layer:
 *
 *   • Supabase `product_codes` table  — one row per (product, code).
 *   • Admin product drawer → For Use In → "Product Codes" picker — assigns
 *     codes, pre-filled from the product's current codes.
 *   • Customer /shop honours the table: a product tagged LC40 + LC57 shows
 *     under BOTH chips; a purely-manual code gets its own chip.
 *
 * SEMANTICS — "manual fully replaces auto": a product with any product_codes
 * rows has its derived series_codes fully overridden on the storefront; a
 * product with none is untouched (the table is a pure override layer).
 *
 * This suite pins:
 *   1. the SQL migration shape (table, constraint, RLS, views)
 *   2. the AdminAPI surface (getProductCodes / setProductCodes / getCodeCatalogue)
 *   3. the admin drawer shell + save wiring
 *   4. wireProductCodesSection behaviour (seed, edit, save-diff gate)
 *   5. api.js _applyManualCodes — override, chip injection, code recovery
 *   6. the getShopData integration is fail-open
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SQL_SRC      = READ('sql/product_codes.sql');
const ADMIN_API    = READ('inkcartridges/js/admin/api.js');
const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');
const UTIL_SRC     = READ('inkcartridges/js/admin/utils/product-codes.js');
const APP_SRC      = READ('inkcartridges/js/admin/app.js');
const CSS_SRC      = READ('inkcartridges/css/admin.css');
const API_JS       = path.join(ROOT, 'inkcartridges/js/api.js');
const API_SRC      = fs.readFileSync(API_JS, 'utf8');

// Extract a top-level function body by brace matching.
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

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// api.js runs inside a vm realm, so objects it produces have a foreign
// prototype that deepStrictEqual rejects. plain() re-homes a value into this
// realm for comparison.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ─────────────────────────────────────────────────────────────────────────────
// 1. SQL migration — sql/product_codes.sql
// ─────────────────────────────────────────────────────────────────────────────

test('SQL: product_codes table — (product_id, code) PK, cascade delete', () => {
  assert.match(SQL_SRC, /create table if not exists public\.product_codes/);
  assert.match(SQL_SRC, /product_id\s+uuid\s+not null\s+references public\.products \(id\) on delete cascade/);
  assert.match(SQL_SRC, /primary key \(product_id, code\)/);
});

test('SQL: CHECK constraint enforces UPPERCASE codes, 2-24 chars, slash allowed', () => {
  assert.match(SQL_SRC, /constraint product_codes_code_format/);
  assert.match(SQL_SRC, /code = upper\(code\)/);
  assert.match(SQL_SRC, /char_length\(code\) between 2 and 24/);
  // The segment regex admits the backend's merged pair codes (PG40/CL41) while
  // still rejecting a bare "/", a trailing "PG40/", and a doubled "PG40//CL41".
  assert.match(SQL_SRC, /code ~ '\^\[A-Z0-9\]\+\(\/\[A-Z0-9\]\+\)\*\$'/);
  assert.doesNotMatch(SQL_SRC, /\^\[A-Z0-9\]\{2,24\}\$/,
    'the old alphanumeric-only rule made slash codes unstorable — it must be gone');
});

test('SQL: the slash migration ALTERs the live table, not just CREATE TABLE', () => {
  // product_codes already exists on live, so `create table if not exists` is a
  // no-op there and its inline CHECK never applies. Without an explicit swap the
  // migration would appear to run and change nothing.
  assert.match(SQL_SRC, /alter table public\.product_codes\s+drop constraint if exists product_codes_code_format/);
  assert.match(SQL_SRC, /alter table public\.product_codes\s+add constraint product_codes_code_format/);
});

test('SQL: the new CHECK regex accepts pair codes and rejects malformed ones', () => {
  // Exercise the actual regex from the file, so the test can't drift from the DDL.
  const m = SQL_SRC.match(/code ~ '(\^\[A-Z0-9\]\+\(\/\[A-Z0-9\]\+\)\*\$)'/);
  assert.ok(m, 'CHECK regex not found in the SQL');
  const re = new RegExp(m[1]);
  const ok = (c) => re.test(c) && c.length >= 2 && c.length <= 24;

  for (const good of ['CI3', 'PG40/CL41', 'PGI5/CLI8', 'PGI520/CLI521', 'CL511CLR']) {
    assert.ok(ok(good), `${good} must be storable`);
  }
  for (const bad of ['/', 'PG40/', '/CL41', 'PG40//CL41', 'pg40', 'PG 40', 'P']) {
    assert.ok(!ok(bad), `${bad} must be rejected`);
  }
});

test('SQL: a reverse index on code backs the ?code= recovery + chip views', () => {
  assert.match(SQL_SRC, /create index if not exists product_codes_code_idx on public\.product_codes \(code\)/);
});

test('SQL: RLS — public read, authenticated-only writes, no UPDATE', () => {
  assert.match(SQL_SRC, /alter table public\.product_codes enable row level security/);
  assert.match(SQL_SRC, /for select using \(true\)/);
  assert.match(SQL_SRC, /for insert to authenticated/);
  assert.match(SQL_SRC, /for delete to authenticated/);
  assert.doesNotMatch(SQL_SRC, /for update/, 'codes are insert/delete only — no UPDATE policy');
  assert.match(SQL_SRC, /grant select\s+on public\.product_codes to anon, authenticated/);
  assert.match(SQL_SRC, /grant insert, delete\s+on public\.product_codes to authenticated/);
});

test('SQL: product_code_catalogue view — distinct code + product_count', () => {
  assert.match(SQL_SRC, /create or replace view public\.product_code_catalogue as/);
  assert.match(SQL_SRC, /count\(distinct product_id\)::int as product_count/);
  assert.match(SQL_SRC, /grant select on public\.product_code_catalogue\s+to anon, authenticated/);
});

test('SQL: product_code_chip_counts view — keyed by brand slug + product_type', () => {
  assert.match(SQL_SRC, /create or replace view public\.product_code_chip_counts as/);
  assert.match(SQL_SRC, /b\.slug\s+as brand_slug/);
  assert.match(SQL_SRC, /p\.product_type/);
  assert.match(SQL_SRC, /join public\.products p on p\.id = pc\.product_id and p\.is_active = true/);
  assert.match(SQL_SRC, /join public\.brands\s+b on b\.id = p\.brand_id/);
  assert.match(SQL_SRC, /grant select on public\.product_code_chip_counts to anon, authenticated/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AdminAPI — admin/api.js
// ─────────────────────────────────────────────────────────────────────────────

test('AdminAPI exposes every product-code method the picker depends on', () => {
  for (const m of ['getProductCodes', 'setProductCodes', 'getCodeCatalogue',
                   'normalizeProductCode', 'applyBrandCodeChange']) {
    assert.match(ADMIN_API, new RegExp(`\\b${m}\\b`), `AdminAPI.${m} must exist`);
  }
});

test('AdminAPI.applyBrandCodeChange gathers affected products then rewrites each', () => {
  // extractFunction is fooled by the `({ … toCode = null })` destructured arg,
  // so slice the method span explicitly (see errors.md ERR-PC3).
  const start = ADMIN_API.indexOf('async applyBrandCodeChange(');
  const end = ADMIN_API.indexOf('// ---- Printer Models', start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'applyBrandCodeChange span found');
  const fn = ADMIN_API.slice(start, end);
  // Finds every product carrying the code via the shared /shop walk…
  assert.match(fn, /this\._walkShopProducts\(\{ brandSlug, category, code: from \}\)/);
  // …then writes a fresh override on each via setProductCodes.
  assert.match(fn, /this\.setProductCodes\(id, next[,)]/);
  // delete = drop the code; rename = swap it for `to`.
  assert.match(fn, /codes\.filter\(c => c !== from\)/);
  assert.match(fn, /next\.push\(to\)/);
  // A new code must pass the same 2–24 char rule as the table constraint.
  assert.match(fn, /to\.length < 2 \|\| to\.length > 24/);
});

test('_walkShopProducts returns EFFECTIVE codes — the override trap', () => {
  // product_codes is an override layer: persisting a partial set erases a
  // product's other chips. Every write path starts from what getShopData says
  // the product's codes effectively ARE, so the walk must carry them.
  // Destructured-arg methods fool extractFunction's brace matching (ERR-PC3) —
  // slice the span explicitly.
  const start = ADMIN_API.indexOf('async _walkShopProducts(');
  const end = ADMIN_API.indexOf('async listProductsForCode(', start);
  assert.ok(start !== -1 && end > start, '_walkShopProducts span found');
  const fn = ADMIN_API.slice(start, end);
  assert.match(fn, /window\.API\.getShopData\(q\)/);
  assert.match(fn, /p\.series_codes/, 'reads the effective code list off the product');
  assert.match(fn, /codes,/, 'and returns it with each product');
  assert.match(fn, /page <= 30/, 'pages the drilldown rather than taking page 1');
});

// Sep 2026 — API.request() RESOLVES a structured 5xx as { ok:false }. The walk
// used to read that as "no more pages", so a failed brand+type came back EMPTY
// and the membership drawer listed nothing without saying so. Run the SHIPPING
// method, not a replica.
test('_walkShopProducts THROWS on a resolved { ok:false } — a failure is not an empty type', async () => {
  const start = ADMIN_API.indexOf('async _walkShopProducts(');
  const end = ADMIN_API.indexOf('async listProductsForCode(', start);
  const body = ADMIN_API.slice(start, end).trim().replace(/,\s*$/, '');
  const run = (shop) => {
    const ctx = { window: { API: { getShopData: shop } } };
    vm.createContext(ctx);
    const obj = vm.runInContext(`({ normalizeProductCode: (c) => String(c).toUpperCase(), ${body} })`, ctx);
    return obj._walkShopProducts({ brandSlug: 'brother', category: 'drums' });
  };
  await assert.rejects(run(async () => ({ ok: false, code: 'RATE_LIMITED' })), /RATE_LIMITED/);
  // Positive control: a healthy answer still resolves to its products.
  const ok = await run(async () => ({ ok: true, data: { products: [{ id: 'd1', series_codes: ['DR150'] }] } }));
  assert.deepEqual([...ok.keys()], ['d1']);
});

test('setCodeMembership adds/removes ONE code, preserving each product’s others', () => {
  const start = ADMIN_API.indexOf('async setCodeMembership(');
  const end = ADMIN_API.indexOf('async applyBrandCodeChange(', start);
  assert.ok(start !== -1 && end > start, 'setCodeMembership span found');
  const fn = ADMIN_API.slice(start, end);

  // Re-reads effective codes at write time rather than trusting the UI's ids.
  assert.match(fn, /this\._walkShopProducts\(\{ brandSlug, category \}\)/);
  // Drops the code, then re-adds it only for the ticked products — everything
  // else on the product survives.
  assert.match(fn, /entry\.codes\.filter\(x => x !== c\)/);
  assert.match(fn, /addSet\.has\(id\)/);
  assert.match(fn, /this\.setProductCodes\(id, next[,)]/);
  // Same 2–24 rule as the table.
  assert.match(fn, /c\.length < 2 \|\| c\.length > 24/);
});

test('every write clears the storefront’s 60s manual-code cache', () => {
  // js/api.js caches product_codes reads for 60s. Without a flush the admin
  // saves, reloads /shop, and sees the old chips — and concludes it didn't work.
  assert.match(ADMIN_API, /_clearStorefrontCodeCache\(\)\s*\{[\s\S]*?_manualCodeCache\.clear\(\)/);
  for (const method of ['async setCodeMembership(', 'async applyBrandCodeChange(']) {
    const start = ADMIN_API.indexOf(method);
    const chunk = ADMIN_API.slice(start, start + 2600);
    assert.match(chunk, /this\._clearStorefrontCodeCache\(\)/, `${method} must flush the cache`);
  }
});

test('AdminAPI.setProductCodes replaces the set (delete-then-insert) on product_codes', () => {
  const fn = ADMIN_API.slice(ADMIN_API.indexOf('async setProductCodes('), ADMIN_API.indexOf('async getCodeCatalogue('));
  assert.match(fn, /from\('product_codes'\)[\s\S]*\.delete\(\)\.eq\('product_id', productId\)/);
  assert.match(fn, /from\('product_codes'\)\.insert\(rows\)/);
  // Codes are normalised + de-duped before they can reach the DB constraint.
  assert.match(fn, /normalizeProductCode/);
  assert.match(fn, /new Set\(/);
});

test('AdminAPI.getProductCodes / getCodeCatalogue read the right relations', () => {
  assert.match(extractFunction(ADMIN_API, 'async getProductCodes('), /from\('product_codes'\)/);
  assert.match(extractFunction(ADMIN_API, 'async getCodeCatalogue('), /from\('product_code_catalogue'\)/);
});

test('AdminAPI.normalizeProductCode uppercases, strips junk, and KEEPS the slash', () => {
  const fn = extractFunction(ADMIN_API, 'normalizeProductCode(');
  const norm = vm.runInNewContext(`(${fn.replace(/^normalizeProductCode/, 'function')})`)
    .bind({});

  assert.equal(norm('ci3'), 'CI3', 'uppercases');
  assert.equal(norm('lc-40'), 'LC40', 'strips hyphens');
  assert.equal(norm('LC 40'), 'LC40', 'strips spaces');

  // The Jul 2026 fix. The backend emits merged pair codes verbatim as /shop
  // chips; stripping the slash turned PG40/CL41 into PG40CL41, which matches no
  // product — so renaming or deleting such a chip silently touched 0 products.
  assert.equal(norm('PG40/CL41'), 'PG40/CL41', 'a pair code survives intact');
  assert.equal(norm('pg40 / cl41'), 'PG40/CL41', 'normalises around the slash');

  // Slashes are collapsed and trimmed so the result can never trip the CHECK.
  assert.equal(norm('//PG40//CL41//'), 'PG40/CL41');
  assert.equal(norm('/'), '', 'a bare slash is not a code');
  assert.equal(norm(null), '');
});

test('the customer API normalises codes the same way — or admin writes are unfindable', () => {
  // AdminAPI writes the code; js/api.js looks it up. If the two normalisers
  // disagree on "/", a code the admin saves can never be read back on /shop.
  const fn = extractFunction(API_SRC, '_normManualCode(');
  const norm = vm.runInNewContext(`(${fn.replace(/^_normManualCode/, 'function')})`);
  assert.equal(norm('PG40/CL41'), 'PG40/CL41');
  assert.equal(norm('pg40 / cl41'), 'PG40/CL41');
  assert.equal(norm('/'), '');
  // And no stale stripper is left behind at either call site.
  assert.doesNotMatch(API_SRC, /replace\(\/\[\^A-Z0-9\]\/g, ''\)/,
    'js/api.js must not strip slashes out of a code any more');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Admin drawer shell + wiring — admin/pages/products.js
// ─────────────────────────────────────────────────────────────────────────────

test('drawer emits the Product Codes shell — brand/type context, filter, add, grid', () => {
  for (const id of ['product-codes-group', 'product-codes-count', 'pc-brand', 'pc-type',
                     'pc-filter', 'pc-add-btn', 'pc-add-label', 'product-codes-grid', 'pc-seed-note']) {
    assert.match(PRODUCTS_SRC, new RegExp(`id="${id}"`), `#${id} must be in the shell`);
  }
});

test('Product Codes is its own tab, emitted for EVERY product type', () => {
  // 'Product Codes' sits in the unconditional part of the tabs array — before
  // the `...(isManualCompat ? …)` spread — so every product type gets the tab.
  const m = PRODUCTS_SRC.match(/const tabs = \[([^\]]*)\]/);
  assert.ok(m, 'tabs array literal found');
  const beforeSpread = m[1].split('...(isManualCompat')[0];
  assert.match(beforeSpread, /'Product Codes'/, "'Product Codes' is an unconditional tab");
  // Its panel is its own variable, wired into panelContents — NOT appended to
  // the For Use In panel.
  assert.match(PRODUCTS_SRC, /const productCodesHtml = `/, 'codes panel is a standalone variable');
  assert.match(PRODUCTS_SRC, /const panelContents = \[[^\]]*productCodesHtml/,
    'productCodesHtml is mounted in panelContents');
  assert.doesNotMatch(PRODUCTS_SRC, /forUseInHtml \+= `[^`]*id="product-codes-group"/,
    'codes shell must NOT be appended to the For Use In panel');
});

test('wireProductCodesSection is invoked from openProductDrawer', () => {
  assert.match(PRODUCTS_SRC, /wireProductCodesSection\(modal, full\)/);
});

test('save handler persists codes — gated on the load flag AND a baseline diff', () => {
  const save = PRODUCTS_SRC.slice(PRODUCTS_SRC.indexOf("data-action=\"save\""));
  assert.match(save, /modal\._productCodesLoaded/, 'guarded by the clean-load flag');
  assert.match(save, /modal\._productCodesBaseline/, 'diff-checked against the opened-with baseline');
  assert.match(save, /AdminAPI\.setProductCodes\(product\.id/, 'writes via setProductCodes');
});

test('describeCodesWriteError maps the RLS error codes to friendly copy', () => {
  // Backend migration 104 applied the live insert/delete policies + grants, so
  // 42501 now means "not a signed-in admin" — the message must NOT tell the
  // admin to run the .sql migration for THAT.
  const fn = extractFunction(UTIL_SRC, 'export function describeCodesWriteError(');
  assert.match(fn, /'42501'/, 'permission (42501) is mapped');
  assert.match(fn, /signed in as an admin/i, '42501 copy names the admin-session cause');
  assert.match(fn, /'23514'/, 'check_violation (23514) is mapped');
  assert.match(fn, /'23503'/, 'foreign_key_violation (23503) is mapped');
  assert.match(fn, /'23505'/, 'unique_violation (23505) is mapped');

  // 23514 IS the migration's error: it's what a slash code returns against a
  // database still on the old A-Z0-9-only rule. That copy must name the fix,
  // because deploying the frontend before running the SQL is the likely order.
  const m = fn.match(/'23514'[\s\S]*?return '([^']+)'/);
  assert.ok(m, '23514 branch returns a message');
  assert.match(m[1], /product_codes\.sql/, '23514 copy points at the migration');
});

test('the shared util is the single source of truth — products.js does not fork it', () => {
  // Both the drawer tab and the page write codes; a forked error map or category
  // map is how the two surfaces drift.
  assert.match(PRODUCTS_SRC,
    /import \{[^}]*describeCodesWriteError[^}]*\} from '\.\.\/utils\/product-codes\.js'/,
    'products.js imports the shared helpers');
  assert.doesNotMatch(PRODUCTS_SRC, /^function describeCodesWriteError\(/m,
    'no local copy left in products.js');
  assert.doesNotMatch(PRODUCTS_SRC, /^const PRODUCT_TYPE_TO_SHOP_CATEGORY = \{/m,
    'no local category map left in products.js');
});

test('isValidProductCode matches the DB CHECK exactly', () => {
  const fn = extractFunction(UTIL_SRC, 'export function isValidProductCode(');
  const valid = vm.runInNewContext(`(${fn.replace(/^export function isValidProductCode/, 'function')})`);
  for (const good of ['CI3', 'PG40/CL41', 'PGI520/CLI521']) assert.ok(valid(good), good);
  for (const bad of ['/', 'P', 'PG40/', 'PG40//CL41', 'pg40', 'A'.repeat(25)]) {
    assert.ok(!valid(bad), bad);
  }
});

test('setProductCodes treats a 23505 duplicate as a no-op, not a failure', () => {
  const fn = ADMIN_API.slice(ADMIN_API.indexOf('async setProductCodes('), ADMIN_API.indexOf('async getCodeCatalogue('));
  assert.match(fn, /insErr\.code !== '23505'/,
    'a duplicate (product_id, code) must not abort the write');
});

test('APP_VERSION is a valid dated build tag', () => {
  // APP_VERSION is a single moving cache key shared by every admin feature, so
  // pin only its SHAPE — not the slug of whichever feature bumped it last (it
  // legitimately advances each release; this test must not break on the bump).
  const m = APP_SRC.match(/APP_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'APP_VERSION must be declared');
  assert.match(m[1], /^2026\.\d{2}\.\d{2}-[a-z0-9-]+$/i, 'valid dated build tag (YYYY.MM.DD-slug)');
});

test('admin.css styles the Product Codes grid', () => {
  assert.match(CSS_SRC, /\.admin-pc-context\b/);
  assert.match(CSS_SRC, /\.admin-pc-grid\b/);
  assert.match(CSS_SRC, /\.admin-pc-code\b/);
  assert.match(CSS_SRC, /\.admin-pc-code\.is-on/);
  assert.match(CSS_SRC, /\.admin-pc-seed-note/);
  // The retired combobox-picker classes must be gone.
  assert.doesNotMatch(CSS_SRC, /\.admin-code-chip\b/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. wireProductCodesSection — functional, against a minimal DOM
// ─────────────────────────────────────────────────────────────────────────────

function makeEl(id) {
  return {
    id, innerHTML: '', value: '', textContent: '', hidden: false,
    disabled: false, isConnected: true, _listeners: {}, _attrs: {},
    focus() {}, scrollIntoView() {},
    setAttribute(n, v) { this._attrs[n] = String(v); },
    getAttribute(n) { return this._attrs[n]; },
    contains() { return false; },
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    fire(t, e) { return Promise.all((this._listeners[t] || []).map(fn => fn(e))); },
  };
}

const CODE_IDS = ['product-codes-group', 'product-codes-count', 'pc-brand', 'pc-type',
  'pc-filter', 'pc-add-btn', 'pc-add-label', 'product-codes-grid', 'pc-seed-note'];

function makeModal(ids) {
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  if (els['pc-seed-note']) els['pc-seed-note'].hidden = true;
  return {
    isConnected: true, _els: els,
    querySelector(sel) { return els[sel.replace(/^#/, '')] || null; },
  };
}

function makeToast() {
  const calls = [];
  return { calls, success: (m) => calls.push(['success', m]),
    error: (m) => calls.push(['error', m]), info: (m) => calls.push(['info', m]),
    warning: (m) => calls.push(['warning', m]) };
}

// A fake `window` carrying the API surface wireProductCodesSection touches:
// getShopData (the code universe) and _enrichSeriesCodes (the seed fallback).
function makeWindow({ series = [], products = [], enrich = null, shopThrows = false } = {}) {
  return {
    API: {
      getShopData: async () => {
        if (shopThrows) throw new Error('shop down');
        return { ok: true, data: { series, products } };
      },
      _enrichSeriesCodes: enrich || (() => false),
    },
  };
}

function clickEvent(map) {
  return { target: { closest: (sel) => map[sel] || null }, preventDefault() {} };
}
function keyEvent(key, target) {
  return { key, target, preventDefault() {} };
}

// ERR-216 — the REAL partitionDerivedCodes, lifted out of the shipped module
// rather than stubbed. The drawer uses it to decide which SKU-derived codes are
// safe to pre-tick; a stub here would let the drawer pass a test while the
// shipped reconciliation was broken, which is the whole failure mode this
// guards against.
const PATHWAY_SRC = READ('inkcartridges/js/admin/utils/catalogue-pathway.js');
const PARTITION_DERIVED_CODES = new Function(
  `${extractFunction(PATHWAY_SRC, 'export function normCode(').replace(/^export /, '')};
   ${extractFunction(PATHWAY_SRC, 'export function partitionDerivedCodes(').replace(/^export /, '')};
   return partitionDerivedCodes;`)();

// The drawer's normaliser, verbatim from AdminAPI — it KEEPS "/" (ERR-061).
const NORMALIZE = (raw) => String(raw == null ? '' : raw)
  .toUpperCase().replace(/[^A-Z0-9/]/g, '')
  .replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

// The shared scope formatter (utils/product-codes.js), which the drawer imports.
const CAT_LABELS = { ink: 'Ink', toner: 'Toner', ribbons: 'Ribbons' };
const DESCRIBE_SCOPES = (scopes, brandName = (s) => s) => {
  const parts = (scopes || []).map(s => `${brandName(s.brandSlug)} · ${CAT_LABELS[s.category] || s.category}`);
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};

// Build a runnable copy of wireProductCodesSection with its free globals injected.
// AdminAPI gets the two members every path needs, so a test only stubs what it
// asserts on: normalizeProductCode (the drawer has no local norm any more) and
// getCodeUniverse (the catalogue behind the "every other code" section — an empty
// one by default, so a test about THIS product's chips isn't about the catalogue).
// The real pager helpers, lifted verbatim from utils/product-codes.js so the
// reconstructed drawer pages exactly as the shipped one does.
const loadUtilFn = (name) => vm.runInNewContext(
  `(${extractFunction(UTIL_SRC, `export function ${name}(`).replace(/^export /, '')})`);
const PAGINATE = loadUtilFn('paginate');
const PAGER_HTML = loadUtilFn('pagerHtml');

function loadWire() {
  const src = extractFunction(PRODUCTS_SRC, 'async function wireProductCodesSection(');
  const factory = new Function(
    'AdminAPI', 'Toast', 'esc', 'DebugLog', 'window',
    'extractBrandName', '_brands', 'productTypeLabel', 'PRODUCT_TYPE_TO_SHOP_CATEGORY',
    'describeScopes', 'describeCodesWriteError', 'paginate', 'pagerHtml', 'RIBBON_PRODUCT_TYPES',
    // ERR-216 — the drawer now reconciles SKU-derived codes against the live
    // chip universe before pre-ticking any of them, so the real
    // partitionDerivedCodes has to be injected here too. Injecting the REAL one
    // (not a stub) is the point: a stub would let the drawer pass while the
    // shipped reconciliation was broken.
    'partitionDerivedCodes',
    `${src}; return wireProductCodesSection;`);
  return (deps) => factory(
    { normalizeProductCode: NORMALIZE,
      getCodeUniverse: async () => ({ codes: [], missed: [] }),
      ...deps.AdminAPI },
    deps.Toast || makeToast(), esc, deps.DebugLog || { warn() {} },
    deps.window || makeWindow(),
    deps.extractBrandName || ((p) => (p && p.brand && p.brand.name) || (p && p.brand_name) || ''),
    deps._brands || [{ id: 'b1', name: 'Brother', slug: 'brother' }],
    // Aug 2026: the drawer resolves its type label through the shared
    // productTypeLabel() (canonical → retired → raw) rather than indexing a
    // label map directly, so the injected dependency is the function.
    deps.productTypeLabel || ((t) => ({ ink_cartridge: 'Ink Cartridges', toner_cartridge: 'Toner Cartridges' }[t] || t || '')),
    deps.PRODUCT_TYPE_TO_SHOP_CATEGORY || { ink_cartridge: 'ink', toner_cartridge: 'toner' },
    DESCRIBE_SCOPES,
    deps.describeCodesWriteError || ((e) => (e && e.message) || 'unknown error'),
    PAGINATE, PAGER_HTML,
    deps.RIBBON_PRODUCT_TYPES || ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'],
    PARTITION_DERIVED_CODES);
}

// A representative Brother ink product.
const PROD = (over = {}) => ({
  id: 'p1', sku: 's', name: 'n', series_codes: [],
  product_type: 'ink_cartridge', brand: { name: 'Brother', slug: 'brother' }, ...over,
});

test('header shows the product brand + type; grid renders the whole code universe', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async () => ['LC40'] };
  const win = makeWindow({ series: [{ code: 'LC37', count: 5 }, { code: 'LC40', count: 9 }, { code: 'LC59', count: 2 }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD());
  assert.equal(modal._els['pc-brand'].textContent, 'Brother');
  assert.equal(modal._els['pc-type'].textContent, 'Ink Cartridges');
  const grid = modal._els['product-codes-grid'].innerHTML;
  for (const code of ['LC37', 'LC40', 'LC59']) {
    assert.match(grid, new RegExp(`data-code="${code}"`), `${code} tile rendered`);
  }
  assert.match(grid, /data-code="LC40"[^>]*aria-pressed="true"/, 'the assigned code is marked on');
  assert.match(grid, /data-code="LC37"[^>]*aria-pressed="false"/, 'unassigned codes are off');
});

test('the whole catalogue is reachable — a code from another brand is offered, scope and all', async () => {
  // The point of the Jul 2026 widening: before it, this drawer could only ever
  // show Brother+ink's chips, so ~1,200 of the ~1,344 codes that exist were
  // unassignable from here.
  const modal = makeModal(CODE_IDS);
  const AdminAPI = {
    getProductCodes: async () => ['LC40'],
    getCodeUniverse: async () => ({
      codes: [
        { code: 'LC40', count: 9, scopes: [{ brandSlug: 'brother', category: 'ink' }] },
        { code: 'PG40/CL41', count: 4, scopes: [{ brandSlug: 'canon', category: 'ink' }] },
      ],
      missed: [],
    }),
  };
  const win = makeWindow({ series: [{ code: 'LC40', count: 9 }] });
  const brands = [{ id: 'b1', name: 'Brother', slug: 'brother' }, { id: 'b2', name: 'Canon', slug: 'canon' }];
  await loadWire()({ AdminAPI, window: win, _brands: brands })(modal, PROD());

  const grid = modal._els['product-codes-grid'].innerHTML;
  assert.match(grid, /data-code="LC40"/, "the product's own chip is still there");
  assert.match(grid, /data-code="PG40\/CL41"/,
    'a code from another brand must be offered — with its slash intact (ERR-061)');
  assert.match(grid, /Canon · Ink/, 'and labelled with the scope it belongs to');
  assert.ok(!grid.includes('PG40CL41"'), 'the slash must never be stripped — PG40CL41 matches no product');
});

test('an incomplete catalogue says so instead of passing for the whole thing', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = {
    getProductCodes: async () => [],
    getCodeUniverse: async () => ({
      codes: [{ code: 'CI3', count: 2, scopes: [{ brandSlug: 'canon', category: 'ink' }] }],
      missed: [{ brandSlug: 'canon', category: 'toner' }],
    }),
  };
  const win = makeWindow({ series: [{ code: 'LC40', count: 9 }] });
  const brands = [{ id: 'b2', name: 'Canon', slug: 'canon' }];
  await loadWire()({ AdminAPI, window: win, _brands: brands })(modal, PROD());

  const grid = modal._els['product-codes-grid'].innerHTML;
  assert.match(grid, /Canon · Toner/, 'the scope that failed must be named');
  assert.match(grid, /didn’t load/, 'and the gap admitted — a short list must not read as a complete one');
});

test('seed: a product with no saved codes is pre-selected from backend series_codes', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async () => [] };
  const win = makeWindow({ series: [{ code: 'LC40', count: 3 }, { code: 'LC57', count: 1 }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ series_codes: ['LC40'] }));
  assert.equal(modal._productCodesLoaded, true);
  assert.deepEqual([...modal._productCodesSelection.keys()], ['LC40']);
  assert.equal(modal._els['pc-seed-note'].hidden, false, 'seed note is visible');
});

test('seed: with no series_codes, it derives via window.API._enrichSeriesCodes', async () => {
  const modal = makeModal(CODE_IDS);
  const win = makeWindow({ series: [], enrich: (p) => { p.series_codes = ['LC57']; return true; } });
  const AdminAPI = { getProductCodes: async () => [] };
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'p2', series_codes: [] }));
  assert.deepEqual([...modal._productCodesSelection.keys()], ['LC57']);
});

test('seed: a RIBBON is NEVER machine-seeded — starts empty (owner-manual, ERR-086)', async () => {
  const modal = makeModal(CODE_IDS);
  // Backend series_codes AND an enrich heuristic that WOULD fire — both must be
  // ignored for a ribbon, so the owner picks from scratch.
  const win = makeWindow({ series: [], enrich: (p) => { p.series_codes = ['02']; return true; } });
  const AdminAPI = { getProductCodes: async () => [] };
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'rib1', product_type: 'typewriter_ribbon', series_codes: ['02'] }));
  assert.equal(modal._productCodesLoaded, true);
  assert.equal(modal._productCodesSelection.size, 0, 'ribbon seeds no codes — no backend/heuristic pre-tick');
  assert.equal(modal._els['pc-seed-note'].hidden, true, 'no seed note — nothing was pre-selected');
});

test('a product WITH saved codes loads them and shows no seed note', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async (pid) => { assert.equal(pid, 'p3'); return ['LC40', 'LC57']; } };
  const win = makeWindow({ series: [{ code: 'LC40' }, { code: 'LC57' }, { code: 'LC73' }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'p3', series_codes: ['LC40'] }));
  assert.deepEqual([...modal._productCodesSelection.keys()].sort(), ['LC40', 'LC57']);
  assert.equal(modal._els['pc-seed-note'].hidden, true, 'no seed note when codes were saved');
  assert.equal(modal._productCodesBaseline, 'LC40,LC57', 'baseline = the opened-with set');
});

test('typing a code not in the grid and pressing Enter adds it', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async () => ['LC40'] };
  const win = makeWindow({ series: [{ code: 'LC40' }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'p4' }));
  const filter = modal._els['pc-filter'];
  filter.value = 'lc-57';                       // lower-case + hyphen → normalises to LC57
  await filter.fire('keydown', keyEvent('Enter', filter));
  assert.ok(modal._productCodesSelection.has('LC57'), 'normalised code added');
  assert.deepEqual([...modal._productCodesSelection.keys()].sort(), ['LC40', 'LC57']);
  assert.match(modal._els['product-codes-grid'].innerHTML, /data-code="LC57"/, 'new code joins the grid');
});

test('a 1-character code is rejected with an error toast', async () => {
  const modal = makeModal(CODE_IDS);
  const Toast = makeToast();
  const AdminAPI = { getProductCodes: async () => [] };
  await loadWire()({ AdminAPI, Toast, window: makeWindow({ series: [] }) })(modal, PROD({ id: 'p5' }));
  const filter = modal._els['pc-filter'];
  filter.value = 'L';
  await filter.fire('keydown', keyEvent('Enter', filter));
  assert.equal(modal._productCodesSelection.size, 0, 'no code added');
  assert.ok(Toast.calls.some(c => c[0] === 'error'), 'an error toast fired');
});

test('clicking a code tile toggles it on, then off', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async () => [] };
  const win = makeWindow({ series: [{ code: 'TN253', count: 4 }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'p6', product_type: 'toner_cartridge' }));
  const grid = modal._els['product-codes-grid'];
  await grid.fire('click', clickEvent({ '[data-toggle]': { dataset: { code: 'TN253' } } }));
  assert.ok(modal._productCodesSelection.has('TN253'), 'toggled on');
  await grid.fire('click', clickEvent({ '[data-toggle]': { dataset: { code: 'TN253' } } }));
  assert.ok(!modal._productCodesSelection.has('TN253'), 'toggled back off');
});

test('clicking an already-assigned tile removes the code', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async () => ['LC40', 'LC57'] };
  const win = makeWindow({ series: [{ code: 'LC40' }, { code: 'LC57' }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'p7' }));
  await modal._els['product-codes-grid'].fire('click',
    clickEvent({ '[data-toggle]': { dataset: { code: 'LC40' } } }));
  assert.deepEqual([...modal._productCodesSelection.keys()], ['LC57']);
});

test('a failed load leaves the gate false so save cannot wipe codes', async () => {
  const modal = makeModal(CODE_IDS);
  // getProductCodes rejecting is the unrecoverable signal (the getShopData
  // call is .catch-guarded inside the function).
  const AdminAPI = { getProductCodes: async () => { throw new Error('down'); } };
  await loadWire()({ AdminAPI, window: makeWindow({ shopThrows: true }) })(modal, PROD({ id: 'p8' }));
  assert.notEqual(modal._productCodesLoaded, true, 'gate stays false on load failure');
  assert.equal(modal._els['pc-filter'].disabled, true, 'the filter input is disabled');
});

test('the ⋯ menu opens Rename / Delete actions on a tile', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getProductCodes: async () => [] };
  const win = makeWindow({ series: [{ code: 'LC40', count: 3 }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'pm' }));
  const grid = modal._els['product-codes-grid'];
  await grid.fire('click', clickEvent({ '[data-act]': { dataset: { act: 'menu', code: 'LC40' } } }));
  assert.match(grid.innerHTML, /data-act="rename"[^>]*data-code="LC40"/, 'Rename action shown');
  assert.match(grid.innerHTML, /data-act="delete"[^>]*data-code="LC40"/, 'Delete action shown');
});

test('brand-wide delete removes the code everywhere and from the grid', async () => {
  const modal = makeModal(CODE_IDS);
  let called = null;
  const AdminAPI = {
    getProductCodes: async () => ['LC40', '57CLR'],
    applyBrandCodeChange: async (args) => { called = args; return { changed: 4, failed: 0, products: 4 }; },
  };
  const win = makeWindow({ series: [{ code: 'LC40' }, { code: '57CLR', count: 4 }] });
  const Toast = makeToast();
  await loadWire()({ AdminAPI, Toast, window: win })(modal, PROD({ id: 'pd' }));
  await modal._els['product-codes-grid'].fire('click',
    clickEvent({ '[data-act]': { dataset: { act: 'delete-go', code: '57CLR' } } }));
  assert.deepEqual(called, { brandSlug: 'brother', category: 'ink', fromCode: '57CLR', toCode: null });
  assert.ok(!modal._productCodesSelection.has('57CLR'), 'code dropped from this product');
  assert.doesNotMatch(modal._els['product-codes-grid'].innerHTML, /data-code="57CLR"/, 'tile gone from the grid');
  assert.ok(Toast.calls.some(c => c[0] === 'success'), 'a success toast fired');
});

test('brand-wide rename rewrites the code across products and in the grid', async () => {
  const modal = makeModal(CODE_IDS);
  let called = null;
  const AdminAPI = {
    getProductCodes: async () => ['57CLR'],
    applyBrandCodeChange: async (args) => { called = args; return { changed: 2, failed: 0, products: 2 }; },
  };
  const win = makeWindow({ series: [{ code: '57CLR', count: 2 }] });
  await loadWire()({ AdminAPI, window: win })(modal, PROD({ id: 'pr' }));
  const grid = modal._els['product-codes-grid'];
  await grid.fire('click', clickEvent({ '[data-act]': { dataset: { act: 'rename', code: '57CLR' } } }));
  await grid.fire('input', { target: { matches: () => true, value: '57' } });
  await grid.fire('click', clickEvent({ '[data-act]': { dataset: { act: 'rename-go', code: '57CLR' } } }));
  assert.deepEqual(called, { brandSlug: 'brother', category: 'ink', fromCode: '57CLR', toCode: '57' });
  assert.ok(modal._productCodesSelection.has('57'), 'product now carries the renamed code');
  assert.ok(!modal._productCodesSelection.has('57CLR'), 'old code dropped');
  assert.match(grid.innerHTML, /data-code="57"/, 'renamed tile is in the grid');
  assert.doesNotMatch(grid.innerHTML, /data-code="57CLR"/, 'old tile is gone');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. api.js — _applyManualCodes (override / chip injection / recovery)
// ─────────────────────────────────────────────────────────────────────────────

function loadAPI({ debugLog } = {}) {
  const win = {};
  const ctx = {
    window: win, console,
    URLSearchParams, TextEncoder, AbortController,
    setTimeout, clearTimeout,
    fetch: async () => ({ ok: false, json: async () => null }),
    Config: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k',
      API_BASE_URL: 'https://api.example', getSetting: (k, d) => d },
    DebugLog: debugLog || { warn() {}, error() {}, log() {}, info() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Security: { escapeHtml: (s) => s, escapeAttr: (s) => s },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
  assert.ok(win.API, 'api.js must expose window.API');
  return win.API;
}

test('api.js loads cleanly and exposes the manual-code helpers', () => {
  const API = loadAPI();
  for (const m of ['_applyManualCodes', '_fetchManualCodesByProduct', '_fetchManualChipCounts',
                   '_fetchProductIdsForCode', '_supabaseSelect', '_CATEGORY_PRODUCT_TYPES']) {
    assert.ok(API[m] !== undefined, `API.${m} must exist`);
  }
});

test('_CATEGORY_PRODUCT_TYPES maps each /shop category to its product_types', () => {
  const API = loadAPI();
  assert.deepEqual(plain(API._CATEGORY_PRODUCT_TYPES.ink), ['ink_cartridge', 'ink_bottle']);
  assert.deepEqual(plain(API._CATEGORY_PRODUCT_TYPES.toner), ['toner_cartridge']);
  assert.ok(API._CATEGORY_PRODUCT_TYPES.ribbons.includes('typewriter_ribbon'));
});

test('(1) override — a product with manual codes has series_codes fully replaced', async () => {
  const API = loadAPI();
  API._supabaseSelect = async (q) => {
    assert.match(q, /^product_codes\?select=product_id,code/);
    return [{ product_id: 'p1', code: 'LC57' }, { product_id: 'p1', code: 'LC40' }];
  };
  const primary = { ok: true, data: { products: [
    { id: 'p1', series_codes: ['LC40'] },     // auto said LC40; manual says LC40+LC57
    { id: 'p2', series_codes: ['TN253'] },     // no manual rows → untouched
  ] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'ink' });
  assert.deepEqual(plain(primary.data.products[0].series_codes).sort(), ['LC40', 'LC57']);
  assert.deepEqual(plain(primary.data.products[1].series_codes), ['TN253'], 'uncoded product untouched');
});

test('(2) chip injection — a purely-manual code gains its own drilldown chip', async () => {
  const API = loadAPI();
  API._supabaseSelect = async (q) => {
    if (q.startsWith('product_code_chip_counts')) {
      return [{ code: 'LC57', product_count: 2 }, { code: 'LC40', product_count: 9 }];
    }
    return [];
  };
  const primary = { ok: true, data: {
    products: [],
    series: [{ code: 'LC40', count: 9 }, { code: 'TN253', count: 4 }],
  } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'ink' });
  const codes = primary.data.series.map(s => s.code);
  assert.ok(codes.includes('LC57'), 'manual-only code LC57 was injected as a chip');
  const lc40 = primary.data.series.find(s => s.code === 'LC40');
  assert.equal(lc40.count, 9, 'an already-present chip keeps its backend count');
});

test('(3) recovery — a manually-tagged product is merged into the ?code= grid', async () => {
  const API = loadAPI();
  API._supabaseSelect = async (q) => {
    if (q.startsWith('product_codes?select=product_id&code=eq.LC57')) return [{ product_id: 'pX' }];
    if (q.startsWith('product_codes?select=product_id,code')) return [{ product_id: 'pX', code: 'LC57' }];
    return [];
  };
  API.getWithSWR = async () => ({ ok: true, data: { products: [
    { id: 'pX', name: 'Manually tagged', series_codes: [] },
    { id: 'pZ', name: 'Unrelated', series_codes: [] },
  ] } });
  const primary = { ok: true, data: { products: [] }, meta: { total: 0 } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'ink', code: 'LC57' });
  const ids = primary.data.products.map(p => p.id);
  assert.deepEqual(plain(ids), ['pX'], 'only the LC57-tagged product is recovered');
  assert.equal(primary.meta.total, 1, 'meta.total reflects the recovered row');
  assert.deepEqual(plain(primary.data.products[0].series_codes), ['LC57']);
});

// Sep 2026 — an admin can tick a product of ANOTHER type into a code (a drum
// under the TN155 toner chip). That row stores chip_category='toner'; /shop
// crosses types ONLY for such rows. A code match alone is a collision: live
// data has HP ink tagged "61" at home while HP Toner has its own "61" chip —
// a code-only first cut put 3 HP 61 INK cartridges under HP > Toner > 61.
//
// World: brother drum (tags DR150 at home, TN155 visiting toner);
//        brother drum2 (tag FOO visiting toner; toners carry FOO at home, 3 of them);
//        hp ink61 (tag 61 at home).
function crossTypeFixture({ visitorsDown = false } = {}) {
  const warned = [];
  const API = loadAPI({ debugLog: { warn: (...a) => warned.push(a.join(' ')), error() {}, log() {}, info() {} } });
  const tags = [
    { product_id: 'drum', code: 'TN155', chip_category: 'toner' },
    { product_id: 'drum', code: 'DR150', chip_category: null },
    { product_id: 'drum2', code: 'FOO', chip_category: 'toner' },
    { product_id: 'ink61', code: '61', chip_category: null },
  ];
  API._supabaseSelect = async (q) => {
    const visit = q.match(/^product_codes\?select=product_id&code=eq\.(\w+)&chip_category=eq\.(\w+)/);
    if (visit) {
      if (visitorsDown) return null;
      return tags.filter(t => t.code === visit[1] && t.chip_category === visit[2]).map(t => ({ product_id: t.product_id }));
    }
    const byCode = q.match(/^product_codes\?select=product_id&code=eq\.(\w+)$/);
    if (byCode) return tags.filter(t => t.code === byCode[1]).map(t => ({ product_id: t.product_id }));
    if (q.startsWith('product_codes?select=product_id,code')) return tags.map(({ product_id, code }) => ({ product_id, code }));
    if (q.startsWith('product_code_visitors')) {
      if (visitorsDown) return null;
      return q.includes('brand_slug=eq.brother')
        ? [{ code: 'TN155', product_type: 'drum_unit', chip_category: 'toner', product_count: 1 },
           { code: 'FOO', product_type: 'drum_unit', chip_category: 'toner', product_count: 1 }]
        : [];
    }
    if (q.startsWith('product_code_chip_counts')) {
      if (q.includes('brand_slug=eq.brother') && q.includes('drum_unit')) {
        return [{ code: 'TN155', product_count: 1 }, { code: 'DR150', product_count: 1 }, { code: 'FOO', product_count: 1 }];
      }
      if (q.includes('brand_slug=eq.brother') && q.includes('toner_cartridge')) return [{ code: 'FOO', product_count: 3 }];
      if (q.includes('brand_slug=eq.hp') && q.includes('ink_cartridge')) return [{ code: '61', product_count: 2 }];
      return [];
    }
    return [];
  };
  const POOLS = { 'brother|drums': [{ id: 'drum', series_codes: ['DR150'] }, { id: 'drum2', series_codes: [] }],
                  'hp|ink': [{ id: 'ink61', series_codes: ['61'] }] };
  const asked = [];
  API.getWithSWR = async (endpoint) => {
    const u = new URL(endpoint, 'https://x');
    const key = `${u.searchParams.get('brand')}|${u.searchParams.get('category')}`;
    asked.push(key);
    return { ok: true, data: { products: POOLS[key] || [{ id: 'other', series_codes: [] }] } };
  };
  return { API, asked, warned };
}

test('(3) recovery — a product ticked in from ANOTHER type joins the ?code= grid', async () => {
  const { API, asked } = crossTypeFixture();
  const primary = { ok: true, data: { products: [{ id: 't1', series_codes: ['TN155'] }] }, meta: { total: 1 } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'toner', code: 'TN155' });
  assert.deepEqual(plain(primary.data.products.map(p => p.id)), ['t1', 'drum'], 'the drum shows under Toner · TN155');
  assert.deepEqual(plain(primary.data.products[1].series_codes).sort(), ['DR150', 'TN155']);
  assert.equal(asked[0], 'brother|toner', 'the own category is searched first');
  assert.ok(!asked.includes('brother|paper'), 'the search stops once every visitor is found');
});

test('(3) recovery — a product that shares the code AT HOME never crosses (HP ink 61 ≠ HP toner 61)', async () => {
  const { API, asked } = crossTypeFixture();
  const primary = { ok: true, data: { products: [{ id: 'toner61', series_codes: ['61'] }] } };
  await API._applyManualCodes(primary, { brand: 'hp', category: 'toner', code: '61' });
  assert.deepEqual(plain(primary.data.products.map(p => p.id)), ['toner61'], 'no ink cartridge leaks into Toner · 61');
  assert.deepEqual(plain(asked), ['hp|toner'], 'no visitor rows ⇒ no other type is fetched');
});

test('(3) recovery — an unreadable visitor list keeps everyone home and SAYS so', async () => {
  const { API, warned } = crossTypeFixture({ visitorsDown: true });
  const primary = { ok: true, data: { products: [] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'toner', code: 'TN155' });
  assert.equal(primary.data.products.length, 0, 'unknown ⇒ do not cross over');
  assert.ok(warned.some(w => /product_code_visitors failed to load/.test(w)), `got ${JSON.stringify(warned)}`);
});

test('(3) recovery — no other type is fetched when the own category already holds every tagged id', async () => {
  const { API, asked } = crossTypeFixture();
  const primary = { ok: true, data: { products: [{ id: 'drum', series_codes: ['TN155'] }] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'toner', code: 'TN155' });
  assert.deepEqual(plain(asked), [], 'nothing missing ⇒ zero pool requests');
});

test('(3) recovery — a failed pool is LOGGED, not silent', async () => {
  const warned = [];
  const API = loadAPI({ debugLog: { warn: (...a) => warned.push(a.join(' ')), error() {}, log() {}, info() {} } });
  API._supabaseSelect = async (q) => (q.includes('code=eq.TN155') ? [{ product_id: 'drum' }] : []);
  API.getWithSWR = async (endpoint) => {
    const cat = new URL(endpoint, 'https://x').searchParams.get('category');
    return cat === 'toner' ? { ok: false, code: 'SERVER_ERROR' } : { ok: true, data: { products: [] } };
  };
  const primary = { ok: true, data: { products: [] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'toner', code: 'TN155' });
  assert.equal(primary.data.products.length, 0);
  assert.ok(warned.some(w => /toner failed to load/.test(w) && /1 hand-tagged/.test(w)),
    `expected a warning naming the failed pool, got: ${JSON.stringify(warned)}`);
});

test('(2) chips — a visitor grows NO tile at home: the drum makes no TN155 or FOO chip under Drums', async () => {
  const { API } = crossTypeFixture();
  const primary = { ok: true, data: { products: [], series: [{ code: 'DR150', count: 1 }] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'drums' });
  assert.deepEqual(plain(primary.data.series.map(s => s.code)), ['DR150']);
});

test('(2) chips — the visited tile counts its visitor: Toner · TN155 says 7, not 6', async () => {
  const { API } = crossTypeFixture();
  const primary = { ok: true, data: { products: [], series: [{ code: 'TN155', count: 6 }] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'toner' });
  assert.equal(primary.data.series.find(s => s.code === 'TN155').count, 7);
});

test('(2) chips — a brand-new manual code: ONE tile, in the visited type, counting everyone', async () => {
  const { API } = crossTypeFixture();
  const toner = { ok: true, data: { products: [], series: [] } };
  await API._applyManualCodes(toner, { brand: 'brother', category: 'toner' });
  const foo = toner.data.series.find(s => s.code === 'FOO');
  assert.ok(foo, 'FOO tile exists under Toner');
  assert.equal(foo.count, 4, '3 toners at home + the visiting drum');
});

test('(2) chips — a product at home elsewhere is NOT counted: HP Toner · 61 keeps its count', async () => {
  const { API } = crossTypeFixture();
  const primary = { ok: true, data: { products: [], series: [{ code: '61', count: 3 }] } };
  await API._applyManualCodes(primary, { brand: 'hp', category: 'toner' });
  assert.equal(primary.data.series[0].count, 3);
});

test('(2) chips — an unreadable visitor list falls back to the old tiles and SAYS so', async () => {
  const { API, warned } = crossTypeFixture({ visitorsDown: true });
  const primary = { ok: true, data: { products: [], series: [{ code: 'TN155', count: 6 }] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'toner' });
  assert.equal(primary.data.series.find(s => s.code === 'TN155').count, 6);
  assert.ok(warned.some(w => /product_code_visitors did not load/.test(w)), `got ${JSON.stringify(warned)}`);
});

// setProductCodes is a delete-then-insert: whatever it doesn't carry forward is
// lost. Run the SHIPPING method against a fake Supabase client.
function loadSetProductCodes({ prev = [], prevErr = null } = {}) {
  const start = ADMIN_API.indexOf('async setProductCodes(');
  const end = ADMIN_API.indexOf('async getCodeCatalogue(', start);
  let body = ADMIN_API.slice(start, end).trim();
  body = body.slice(0, body.lastIndexOf('/**')).trim().replace(/,\s*$/, '');
  const log = [];
  const chain = (result) => {
    const c = { eq: () => c, not: () => c, then: (r, j) => Promise.resolve(result).then(r, j) };
    return c;
  };
  const sb = { from: () => ({
    select: () => chain({ data: prevErr ? null : prev, error: prevErr }),
    delete: () => { log.push(['delete']); return chain({ error: null }); },
    insert: (rows) => { log.push(['insert', rows]); return Promise.resolve({ error: null }); },
  }) };
  const ctx = { DebugLog: { warn() {} } };
  vm.createContext(ctx);
  const obj = vm.runInContext(`({ normalizeProductCode: (c) => String(c).toUpperCase(),
    _clearStorefrontCodeCache() {}, ${body} })`, ctx);
  obj._sb = () => sb;
  return { obj, log };
}

test('setProductCodes keeps a visitor row’s chip_category when the codes are rewritten', async () => {
  const { obj, log } = loadSetProductCodes({ prev: [{ code: 'TN155', chip_category: 'toner' }] });
  await obj.setProductCodes('drum', ['DR150', 'TN155', 'LC57']);
  const rows = plain(log.find(l => l[0] === 'insert')[1]);
  assert.deepEqual(rows, [
    { product_id: 'drum', code: 'DR150' },
    { product_id: 'drum', code: 'TN155', chip_category: 'toner' },
    { product_id: 'drum', code: 'LC57' },
  ]);
});

test('setProductCodes carries chip_category across a rename, and can set/clear it', async () => {
  const { obj, log } = loadSetProductCodes({ prev: [{ code: 'TN155', chip_category: 'toner' }] });
  await obj.setProductCodes('drum', ['TN155X', 'DR150'], { renamed: { from: 'TN155', to: 'TN155X' }, chipCategory: { DR150: 'toner' } });
  assert.deepEqual(plain(log.find(l => l[0] === 'insert')[1]), [
    { product_id: 'drum', code: 'TN155X', chip_category: 'toner' },
    { product_id: 'drum', code: 'DR150', chip_category: 'toner' },
  ]);
  const b = loadSetProductCodes({ prev: [{ code: 'TN155', chip_category: 'toner' }] });
  await b.obj.setProductCodes('drum', ['TN155'], { chipCategory: { TN155: null } });
  assert.deepEqual(plain(b.log.find(l => l[0] === 'insert')[1]), [{ product_id: 'drum', code: 'TN155' }]);
});

test('setProductCodes REFUSES a visitor write before deleting when the column is missing', async () => {
  const { obj, log } = loadSetProductCodes({ prevErr: { code: '42703', message: 'column does not exist' } });
  await assert.rejects(obj.setProductCodes('drum', ['TN155'], { chipCategory: { TN155: 'toner' } }), /nothing was changed/);
  assert.deepEqual(log, [], 'no delete, no insert — the product keeps its codes');
  // Positive control: an ordinary write still works before the migration.
  const b = loadSetProductCodes({ prevErr: { code: '42703' } });
  await b.obj.setProductCodes('p1', ['LC40']);
  assert.deepEqual(plain(b.log.find(l => l[0] === 'insert')[1]), [{ product_id: 'p1', code: 'LC40' }]);
});

test('_applyManualCodes is fail-open — a Supabase outage leaves the response intact', async () => {
  const API = loadAPI();
  API._supabaseSelect = async () => { throw new Error('supabase unreachable'); };
  const primary = { ok: true, data: { products: [{ id: 'p1', series_codes: ['LC40'] }],
    series: [{ code: 'LC40', count: 1 }] } };
  const out = await API._applyManualCodes(primary, { brand: 'brother', category: 'ink' });
  assert.equal(out, primary, 'the same response object is returned');
  assert.deepEqual(primary.data.products[0].series_codes, ['LC40'], 'untouched on failure');
});

test('_fetchManualChipCounts sums product_count across product_types of a category', async () => {
  const API = loadAPI();
  API._supabaseSelect = async () => ([
    { code: 'LC40', product_count: 3 },   // ink_cartridge rows
    { code: 'LC40', product_count: 1 },   // ink_bottle rows — same chip
  ]);
  const chips = await API._fetchManualChipCounts('brother', ['ink_cartridge', 'ink_bottle']);
  assert.deepEqual(plain(chips), [{ code: 'LC40', count: 4 }]);
});

test('_fetchProductIdsForCode normalises the code before the lookup', async () => {
  const API = loadAPI();
  let seen = '';
  API._supabaseSelect = async (q) => { seen = q; return [{ product_id: 'p1' }]; };
  const ids = await API._fetchProductIdsForCode('lc-40');
  assert.match(seen, /code=eq\.LC40/, 'code is upper-cased and stripped before query');
  assert.deepEqual(ids, ['p1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. getShopData integration
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData routes BOTH return paths through _finalizeShopData', () => {
  // extractFunction is fooled by the `params = {}` default arg, so slice the
  // method span explicitly: getShopData ends where _finalizeShopData (the
  // post-processing hook it delegates to) is declared.
  const start = API_SRC.indexOf('async getShopData(');
  const end = API_SRC.indexOf('async _finalizeShopData(', start);
  assert.ok(start !== -1 && end !== -1 && end > start);
  const fn = API_SRC.slice(start, end);
  // The compat-recovery skip and the merged return must BOTH post-process —
  // the skip is the common path, so a hook only on the merged return would
  // leave manual codes and truncated-chip repair off for most requests.
  const hooks = fn.match(/_finalizeShopData\(primary, params\)/g) || [];
  assert.equal(hooks.length, 2, 'the early-skip and the final return both post-process');
  assert.doesNotMatch(fn, /\n\s*return primary;/, 'no raw `return primary` bypasses the hook');

  // And the hook itself still applies manual codes.
  assert.match(API_SRC, /async _finalizeShopData\([\s\S]{0,400}_applyManualCodes\(primary, params/,
    '_finalizeShopData must run the manual-code layer');
});
