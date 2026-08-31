/**
 * Product delete — the button that reported success while deleting nothing
 * =======================================================================
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * From 2026-08-14 the admin shipped a bulk "Delete Products" button against
 * `DELETE /api/admin/products/:id`, a route that did not exist. ERR-166 recorded
 * the dead route and decided to leave the button visible, on the grounds that
 * "hiding the button would remove the only signal that products cannot be
 * deleted" — and stated the toast was honest: `0 deleted, N failed`.
 *
 * It was not honest. Three facts compose:
 *
 *   1. `API.request()` RETURNS an `{ok:false, code}` envelope for 404/409/403
 *      rather than throwing (js/api.js — the return-don't-throw ladder).
 *   2. `AdminAPI.deleteProduct` was the ONLY product write helper with no
 *      `resp.ok === false` check, so it RESOLVED with that envelope.
 *   3. `bulkDelete()` counted `Promise.allSettled` results, treating every
 *      `fulfilled` as a deletion.
 *
 * So every call failed, every promise settled, and the toast said
 * "N products deleted". For seventeen days the admin reported destroying
 * products it had never touched.
 *
 * On 2026-08-31 the endpoints went live — which made the same path DANGEROUS
 * rather than merely wrong. `PRODUCT_HAS_ORDER_HISTORY` (409) is the server
 * refusing to tear a line out of a customer's receipt; the old code would have
 * reported that refusal as a successful deletion.
 *
 * ── Why the catching test has to RUN code ───────────────────────────────────
 *
 * Nothing here *looks* wrong. `Promise.allSettled` + `fulfilled` is idiomatic;
 * the defect is that a sibling function resolves where the caller assumed it
 * rejects. No amount of source-grepping finds that. §1 therefore loads the real
 * `AdminAPI` and drives every write method with a resolved `{ok:false}` envelope.
 * That table is the durable fix: it catches the NEXT `deleteProduct`-shaped
 * omission before it ships, rather than catching this one afterwards.
 *
 * Run with: node --test tests/admin-product-delete-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(p, 'utf8');

const productsJs = read(path.join(SITE, 'js', 'admin', 'pages', 'products.js'));
const adminApiJs = read(path.join(SITE, 'js', 'admin', 'api.js'));
const apiJs = read(path.join(SITE, 'js', 'api.js'));

/** The pure module under test. */
let D;
test.before(async () => {
  D = await import('../inkcartridges/js/admin/utils/product-deletability.js');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE REGRESSION. A write helper handed {ok:false} must REJECT, never resolve.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the real AdminAPI with a stubbed window.API, so each wrapper is driven
 * for real. This is the layer the bug lived in.
 */
async function loadAdminAPI(stubResponses) {
  const calls = [];
  const respond = (name) => async (...args) => {
    calls.push({ name, args });
    const r = stubResponses[name];
    return typeof r === 'function' ? r(...args) : r;
  };
  global.window = {
    API: {
      get: respond('get'), post: respond('post'), put: respond('put'),
      patch: respond('patch'), delete: respond('delete'),
      deleteProduct: respond('deleteProduct'),
      deleteProductsBulk: respond('deleteProductsBulk'),
      uploadProductImage: respond('uploadProductImage'),
    },
    location: { origin: 'http://localhost' },
    addEventListener() {}, dispatchEvent() {},
  };
  global.DebugLog = { warn() {}, error() {}, log() {}, info() {} };
  global.document = { addEventListener() {}, querySelector: () => null, createElement: () => ({ style: {}, classList: { add() {} } }) };
  const mod = await import('../inkcartridges/js/admin/api.js?delete-test=' + Math.random());
  return { AdminAPI: mod.AdminAPI ?? mod.default, calls };
}

test('deleteProduct REJECTS on an {ok:false} envelope — the exact 2026-08 miscount', async () => {
  // This is the assertion that would have caught it. `API.request()` resolves
  // with this shape for a 404; if deleteProduct resolves too, every caller that
  // treats "settled" as "deleted" reports a destruction that never happened.
  const { AdminAPI } = await loadAdminAPI({
    deleteProduct: { ok: false, code: 'NOT_FOUND', server_code: 'PRODUCT_NOT_FOUND', error: 'Product not found' },
  });
  await assert.rejects(
    () => AdminAPI.deleteProduct('some-id'),
    /not found/i,
    'deleteProduct resolved on a failure envelope — this is ERR-166s silent success, back again'
  );
});

test('deleteProduct RESOLVES on success (positive control)', async () => {
  // A test that only ever asserts rejection can pass because the function throws
  // for the wrong reason. Keep the positive control (ERR-186s lesson).
  const { AdminAPI } = await loadAdminAPI({
    deleteProduct: { ok: true, data: { deleted: true, id: 'x', sku: 'CXYZ' } },
  });
  const out = await AdminAPI.deleteProduct('x');
  assert.equal(out.deleted, true, 'a successful delete must resolve with the server payload');
});

test('every AdminAPI product write rejects on {ok:false} — the durable table', async () => {
  // The point of a table: the next helper added without an ok-check fails HERE,
  // not in production seventeen days later.
  const envelope = { ok: false, code: 'FORBIDDEN', error: 'Nope' };
  const { AdminAPI } = await loadAdminAPI({
    post: envelope, put: envelope, delete: envelope,
    deleteProduct: envelope, deleteProductsBulk: envelope,
  });
  const cases = [
    ['createProduct', () => AdminAPI.createProduct({ sku: 'CX' })],
    ['updateProduct', () => AdminAPI.updateProduct('id', { retail_price: 1 })],
    ['deleteProduct', () => AdminAPI.deleteProduct('id')],
    ['deleteProductsBulk', () => AdminAPI.deleteProductsBulk(['id'])],
  ];
  for (const [name, run] of cases) {
    await assert.rejects(run, new RegExp('.'), `${name} must reject on an {ok:false} envelope, not resolve`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. normaliseBulkDeleteResult — an outcome we cannot prove is never a success.
// ─────────────────────────────────────────────────────────────────────────────

test('a refusal-only response reports ZERO deleted', () => {
  const r = D.normaliseBulkDeleteResult(['a'], {
    requested: 1, deleted_count: 0, failed_count: 1,
    deleted: [],
    failed: [{ id: 'a', sku: 'CTN2445BK', code: 'PRODUCT_HAS_ORDER_HISTORY', reason: 'Appears in 5 order lines' }],
  });
  assert.equal(r.deleted.length, 0, 'nothing was deleted and nothing may be reported as deleted');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].sku, 'CTN2445BK', 'the SKU must survive so the operator knows which row');
  assert.equal(r.failed[0].code, 'PRODUCT_HAS_ORDER_HISTORY');
});

test('an id the server mentions in neither list is UNACCOUNTED, never deleted', () => {
  const r = D.normaliseBulkDeleteResult(['a', 'b'], {
    deleted: [{ id: 'a', sku: 'CA' }], failed: [],
  });
  assert.deepEqual(r.deleted.map(d => d.id), ['a']);
  assert.deepEqual(r.unaccounted, ['b'],
    'an unmentioned id is an unknown outcome — folding it into either bucket is a lie');
});

test('an id in BOTH lists fails closed', () => {
  const r = D.normaliseBulkDeleteResult(['a'], {
    deleted: [{ id: 'a', sku: 'CA' }],
    failed: [{ id: 'a', sku: 'CA', code: 'PRODUCT_REFERENCED', reason: 'x' }],
  });
  assert.equal(r.deleted.length, 0, '"refused" is the claim we can act on');
  assert.equal(r.failed.length, 1);
});

test('a deleted_count that names nobody infers nothing', () => {
  const r = D.normaliseBulkDeleteResult(['a', 'b', 'c'], { deleted: 2, failed: [] });
  assert.equal(r.deleted.length, 0, 'a bare count that disagrees with the ids must not be trusted');
  assert.equal(r.unaccounted.length, 3);
});

test('an unreadable body makes every id unaccounted, not deleted', () => {
  const r = D.normaliseBulkDeleteResult(['a', 'b'], null);
  assert.equal(r.deleted.length, 0);
  assert.deepEqual(r.unaccounted, ['a', 'b']);
});

test('duplicate requested ids are counted once', () => {
  const r = D.normaliseBulkDeleteResult(['a', 'a'], { deleted: [{ id: 'a', sku: 'CA' }], failed: [] });
  assert.equal(r.deleted.length, 1);
  assert.equal(r.unaccounted.length, 0, 'a doubled id comes back once and must not read as unaccounted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Vocabulary — one place decides, and an unknown code is echoed, not guessed.
// ─────────────────────────────────────────────────────────────────────────────

test('PRODUCT_HAS_ORDER_HISTORY is the only code offering Deactivate instead', () => {
  assert.equal(D.offersDeactivate('PRODUCT_HAS_ORDER_HISTORY'), true);
  for (const c of ['PRODUCT_NOT_FOUND', 'PRODUCT_REFERENCED', 'FORBIDDEN', '', null, undefined]) {
    assert.equal(D.offersDeactivate(c), false, `${c} must not offer deactivate`);
  }
});

test('PRODUCT_NOT_FOUND reads as already gone, not as a failure to act on', () => {
  assert.equal(D.isAlreadyGone('PRODUCT_NOT_FOUND'), true);
  assert.match(D.PRODUCT_DELETE_FAILURE_COPY.PRODUCT_NOT_FOUND, /already gone/i);
  assert.equal(D.isAlreadyGone('PRODUCT_HAS_ORDER_HISTORY'), false);
});

test('an unknown code is echoed verbatim, never flattened to "delete failed"', () => {
  const copy = D.productDeleteFailureCopy('SOME_NEW_CODE', 'Server said something specific');
  assert.match(copy, /Server said something specific/, "the server's own prose must reach the operator");
  assert.match(copy, /SOME_NEW_CODE/, 'the unknown code must be reportable');
  const bare = D.productDeleteFailureCopy('WEIRD', '');
  assert.match(bare, /WEIRD/, 'even with no prose the code is surfaced');
  assert.doesNotMatch(bare, /^Delete failed\.?$/i, 'a bland failure presents an unknown as a known');
});

test('the order-history copy points at deactivation and says why', () => {
  const c = D.PRODUCT_DELETE_FAILURE_COPY.PRODUCT_HAS_ORDER_HISTORY;
  assert.match(c, /receipt|order/i, 'it must say WHY the server refuses');
  assert.match(c, /[Dd]eactivate/, 'and name the alternative that works');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Owner gating — fails closed.
// ─────────────────────────────────────────────────────────────────────────────

test('only owner may delete, and an unknown role fails CLOSED', () => {
  assert.equal(D.canDeleteProducts('owner'), true);
  for (const r of ['admin', 'super_admin', 'stock_manager', '', null, undefined, 'Owner']) {
    assert.equal(D.canDeleteProducts(r), false,
      `${r} must not pass — the FE vocabulary is the normalised 'owner' (AdminAccess.ROLE_MAP)`);
  }
});

test('the blocked reason is a sentence, not a shrug', () => {
  assert.equal(D.deleteBlockedReason('owner'), null);
  assert.match(D.deleteBlockedReason('admin'), /owner/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Summary copy never claims a deletion it cannot name.
// ─────────────────────────────────────────────────────────────────────────────

test('the summary never says N deleted when N were refused', () => {
  const r = D.normaliseBulkDeleteResult(['a', 'b', 'c'], {
    deleted: [{ id: 'a', sku: 'CA' }],
    failed: [{ id: 'b', sku: 'CB', code: 'PRODUCT_HAS_ORDER_HISTORY', reason: 'x' }],
  });
  const s = D.summariseDeleteOutcome(r);
  assert.match(s, /1 product deleted/, 'exactly what the server confirmed');
  assert.match(s, /1 refused/);
  assert.match(s, /1 of unknown outcome/, 'the unaccounted row must be visible in the summary');
});

test('nothingWasDeleted is true only when the deleted list is empty', () => {
  assert.equal(D.nothingWasDeleted({ deleted: [] }), true);
  assert.equal(D.nothingWasDeleted({ deleted: [{ id: 'a' }] }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Source backstops. Each carries a positive control so it cannot pass by
//    matching nothing.
// ─────────────────────────────────────────────────────────────────────────────

test('bulkDelete no longer counts settled promises', () => {
  const start = productsJs.indexOf('async function bulkDelete()');
  assert.notEqual(start, -1, 'bulkDelete must still exist');
  const body = productsJs.slice(start, start + 2600);
  assert.doesNotMatch(body, /allSettled/,
    'counting settled promises is the ERR-166 miscount — outcomes come from the server payload');
  assert.match(body, /canDeleteProducts\(AdminAuth\.role\)/, 'the owner gate must be present');
  // Positive control: the matcher above must be capable of failing.
  assert.match('const results = await Promise.allSettled(x)', /allSettled/,
    'positive control — the allSettled matcher works, so its absence above is meaningful');
});

test('the delete pipeline dry-runs before destroying anything', () => {
  assert.match(productsJs, /deleteProductsBulk\([^)]*\{\s*dryRun:\s*true\s*\}/,
    'a dry run must precede the real delete so refusals are known first');
  assert.match(productsJs, /runProductDelete/,
    'single and bulk delete must share one pipeline — asymmetric gating is ERR-119/120');
});

test('AdminAPI.deleteProduct keeps its ok-check', () => {
  const i = adminApiJs.indexOf('async deleteProduct(productId)');
  assert.notEqual(i, -1);
  const body = adminApiJs.slice(i, i + 700);
  assert.match(body, /resp\.ok === false/,
    'without this check the promise resolves on failure and every caller mis-reports');
  assert.match(body, /productWriteError/, 'it must carry details and request_id like its siblings');
});

test('the 404 branch carries the server code additively', () => {
  const i = apiJs.indexOf("if (response.status === 404 || errorCode === 'NOT_FOUND')");
  assert.notEqual(i, -1);
  const body = apiJs.slice(i, i + 400);
  assert.match(body, /server_code/, 'PRODUCT_NOT_FOUND must survive the transport');
  assert.match(body, /code: 'NOT_FOUND'/,
    "`code` must STAY generic — fourteen call sites compare against that literal");
});

test('bulkSetActiveFor never guesses a price', () => {
  const i = productsJs.indexOf('async function bulkSetActiveFor');
  assert.notEqual(i, -1, 'the shared activate/deactivate path must exist');
  const body = productsJs.slice(i, i + 2000);
  assert.doesNotMatch(body, /retail_price\s*\?\?\s*0/,
    'defaulting a missing price to 0 would zero the price of a product being deactivated');
  assert.match(body, /unpriced/, 'a product whose price cannot be read must be skipped and named');
});
