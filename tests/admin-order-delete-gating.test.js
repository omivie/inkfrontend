/**
 * Admin Orders — delete gating contract (ERR-119, Jul 2026)
 * ========================================================
 *
 * The backend enforces a cancelled-only guard on `DELETE /api/admin/orders/:id`
 * and rejects anything else with "Only cancelled orders can be deleted". That
 * string lives ONLY on the backend.
 *
 * The frontend bug was ASYMMETRIC gating: the single-order Delete button in the
 * detail modal was gated to cancelled-only, but the bulk bar rendered Delete for
 * ANY selection and posted every selected id — so deleting a paid test order
 * produced "0 deleted, 1 failed: Only cancelled orders can be deleted".
 *
 * This pins the invariants that stop it recurring:
 *   1. Deletability comes from ONE list (DELETABLE_STATUSES / isDeletable),
 *      used by BOTH the single-order path and the bulk path.
 *   2. bulkDelete never sends a blocked id.
 *   3. Failures/skips are reported per-order, LOUDLY — not collapsed into one
 *      `firstError` string.
 *   4. The rejection message is never hardcoded as a client-side rule.
 *
 * Run with: node --test tests/admin-order-delete-gating.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

const ordersJs = read(path.join(ADMIN, 'pages', 'orders.js'));
const apiJs = read(path.join(ADMIN, 'api.js'));
const appJs = read(path.join(ADMIN, 'app.js'));

// ---- 1. One source of truth for deletability ----

test('DELETABLE_STATUSES is the single list and holds only "cancelled"', () => {
  const m = ordersJs.match(/const DELETABLE_STATUSES = \[([^\]]*)\]/);
  assert.ok(m, 'orders.js must declare DELETABLE_STATUSES');
  assert.equal(m[1].replace(/['"\s]/g, ''), 'cancelled',
    'while the backend guard stands, only cancelled orders are deletable');
  assert.match(ordersJs, /function isDeletable\(order\)/,
    'a shared isDeletable() predicate must exist');
});

test('BOTH delete paths read from isDeletable() — no inline status comparison', () => {
  assert.match(ordersJs, /if \(isDeletable\(o\)\)/,
    'the detail-modal Delete BUTTON must be gated by isDeletable()');
  assert.match(ordersJs, /if \(isDeletable\(order\)\)/,
    'the detail-modal Delete HANDLER must be gated by isDeletable()');
  // The old inline literal is what let the two paths drift apart.
  assert.doesNotMatch(ordersJs, /(o|order)\.status === 'cancelled'/,
    'no path may re-implement the cancelled-only rule inline');
});

// ---- 2. The bulk path never sends a blocked id ----

test('the bulk bar partitions the selection and disables Delete when nothing qualifies', () => {
  assert.match(ordersJs, /function partitionSelection\(selected\)/,
    'partitionSelection() must split a selection into deletable/blocked');
  const bulkBar = ordersJs.slice(ordersJs.indexOf('function updateBulkBar'), ordersJs.indexOf('async function bulkDelete'));
  assert.match(bulkBar, /partitionSelection\(selected\)/,
    'updateBulkBar must partition before rendering the Delete button');
  assert.match(bulkBar, /nothingDeletable \? ' disabled' : ''/,
    'Delete must render disabled when no selected order is deletable');
  assert.match(bulkBar, /NOT_DELETABLE_REASON/,
    'the disabled button must explain why via its title');
});

test('bulkDelete iterates the DELETABLE ids only, never the raw selection', () => {
  const fn = ordersJs.slice(ordersJs.indexOf('async function bulkDelete'), ordersJs.indexOf('// ---- Full-page order modal ----'));
  assert.match(fn, /const \{ deletable: ids, blocked: skipped \} = partitionSelection\(selected\)/,
    'bulkDelete must partition the selection up front');
  assert.match(fn, /if \(ids\.length === 0\)/,
    'bulkDelete must bail out (no request) when nothing is deletable');
  // The pre-fix bug: `const ids = [...selected]` sent every selected id.
  assert.doesNotMatch(fn, /const ids = \[\.\.\.selected\]/,
    'bulkDelete must never post the unfiltered selection');
  assert.match(fn, /batch\.map\(id => AdminAPI\.deleteOrder\(id\)\)/,
    'batched Promise.allSettled delete is preserved');
});

// ---- 3. Partial failure is LOUD and per-order ----

test('failures are tracked per order, not collapsed into one firstError', () => {
  assert.doesNotMatch(ordersJs, /firstError/,
    'the single-firstError toast hid which orders failed — it must be gone');
  assert.match(ordersJs, /failures\.push\(\{ label: orderLabel\(batch\[j\]\), message:/,
    'each rejection must be recorded with its own order label + message');
  assert.match(ordersJs, /function showDeleteResults\(/,
    'a results surface must list every order that was not deleted');
  assert.match(ordersJs, /if \(failures\.length > 0 \|\| skipped\.length > 0\)/,
    'skipped orders count as "not deleted" and must be surfaced too');
});

test('the results modal is deferred past Modal.confirm self-close', () => {
  // Modal.confirm calls Modal.close() AFTER onConfirm resolves, so a synchronous
  // open would be closed immediately. The timeout is load-bearing, not cosmetic.
  const fn = ordersJs.slice(ordersJs.indexOf('function showDeleteResults'), ordersJs.indexOf('async function bulkDelete'));
  assert.match(fn, /setTimeout\(\(\) => \{[\s\S]*Modal\.open\(/,
    'showDeleteResults must open its modal inside a setTimeout');
});

test('the confirm dialog states how many are skipped and why', () => {
  assert.match(ordersJs, /not cancelled and will be skipped/,
    'the confirm copy must disclose skipped orders before the admin commits');
});

// ---- 4. The backend message stays the backend's ----

test('the backend rejection string is never used as a client-side branch', () => {
  // Our own advisory copy may mirror the backend wording — what must NOT happen is
  // BRANCHING on the message text. `js/api.js` does not attach `err.code` on the
  // generic throw path, so string-matching a human message is the only (fragile)
  // way to do it — the same trap as ERR-077. Gate on status, never on prose.
  assert.doesNotMatch(ordersJs, /(includes|indexOf|test|match)\([^)]*Only cancelled/,
    'deletability must be decided by status, not by parsing the backend error text');
  // NB the source stores the em-dash as a — escape, matching `const MISSING`.
  assert.match(ordersJs, /const NOT_DELETABLE_REASON = 'Only cancelled orders can be deleted .{1,8} change the status first\.'/,
    'our advisory copy explains the fix (change status), unlike the bare backend string');
});

test('selection surviving pagination can still be resolved to a status', () => {
  // DataTable.setData does NOT clear selection, so a selected id may not be in
  // _table.data. Treating an unresolvable id as deletable would resurrect the bug.
  assert.match(ordersJs, /const _seenOrders = new Map\(\)/,
    'a status cache must survive page changes');
  assert.match(ordersJs, /rememberOrders\(rows\)/,
    'loadOrders must feed the cache before setData');
  const fn = ordersJs.slice(ordersJs.indexOf('function partitionSelection'), ordersJs.indexOf('function channelBadge'));
  assert.match(fn, /if \(order && isDeletable\(order\)\) deletable\.push\(id\);\s*\n\s*else blocked\.push\(id\);/,
    'an unresolvable id must be treated as BLOCKED, never deletable');
});

// ---- 5. Plumbing + cache busting ----

test('deleteOrder encodes the id like its sibling admin API methods', () => {
  assert.match(apiJs, /API\.delete\(`\/api\/admin\/orders\/\$\{encodeURIComponent\(orderId\)\}`\)/,
    'the order id must be URL-encoded');
});

test('cache-busting tokens were bumped so the edited modules re-fetch', () => {
  const appVer = appJs.match(/const APP_VERSION = '([^']+)'/)[1];
  assert.notEqual(appVer, '2026.07.24-order-items-visible-fix', 'APP_VERSION must advance (pages/orders.js changed)');
  assert.match(appVer, /^\d{4}\.\d{2}\.\d{2}-[a-z0-9-]+$/, 'APP_VERSION keeps the date-prefixed format');
  // ERR-124: api.js is no longer imported with a per-call-site token — that forked
  // AdminAPI into two module instances. It is bare, and stays bare; consistency is
  // pinned by tests/asset-cache-tokens.test.js §4.
  assert.doesNotMatch(appJs, /from '\.\/api\.js\?v=/,
    'the api.js import must stay bare so AdminAPI is a single module instance');
});

test('no raw console.* was introduced (ERR-035)', () => {
  assert.doesNotMatch(ordersJs, /(^|[^.\w])console\./m, 'use DebugLog, never raw console.*');
});
