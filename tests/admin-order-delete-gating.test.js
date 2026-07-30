/**
 * Admin Orders — delete gating contract
 * =====================================
 *
 * HISTORY (why this file exists). The backend once enforced a cancelled-only
 * guard on `DELETE /api/admin/orders/:id` and rejected anything else with
 * "Only cancelled orders can be deleted". The frontend bug was ASYMMETRIC
 * gating: the single-order Delete button in the detail modal was gated to
 * cancelled-only, but the bulk bar rendered Delete for ANY selection and posted
 * every selected id — so deleting a paid test order produced
 * "0 deleted, 1 failed: Only cancelled orders can be deleted"
 * (ERR-119 here / ERR-120 in the memory log).
 *
 * NOW (ERR-132, 2026-07-30). The backend ships an owner-only hard purge
 * (`POST /api/admin/orders/purge`) and an authoritative per-row, per-caller
 * deletability signal on `GET /api/admin/orders`:
 *
 *   deletable              boolean
 *   delete_method          'purge' | 'delete' | null
 *   delete_blocked_reason  null | 'invoice_link' | 'not_cancelled'
 *
 * So the ONE list is no longer a list of statuses — it is a util that reads the
 * server's answer. The invariants this file has always defended are unchanged;
 * only the vocabulary moved:
 *
 *   1. Deletability comes from ONE place (utils/order-deletability.js), used by
 *      BOTH the single-order path and the bulk path.
 *   2. bulkDelete never sends a blocked id.
 *   3. Failures/skips are reported per-order, LOUDLY — never collapsed into one
 *      `firstError` string. And an id the server never accounted for is reported
 *      as UNKNOWN, which is neither a success nor a failure.
 *   4. The rejection message is never hardcoded as a client-side rule, and never
 *      branched on. Branch on the CODE.
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
const utilJs = read(path.join(ADMIN, 'utils', 'order-deletability.js'));

/** The util is a real ES module with no browser dependencies — import and run it. */
const loadUtil = () => import(
  'file://' + path.join(ADMIN, 'utils', 'order-deletability.js')
);

// The two sentences the backend handoff specifies, byte for byte. If either of
// these ever needs changing, it changes in the util and here, together — and
// nowhere else.
const INVOICE_LINK_COPY = 'Linked to an invoice / quick order — clear that first.';
const NOT_CANCELLED_COPY = 'Only cancelled orders can be deleted.';

// ═══════════════════════════════════════════════════════════════════════════
// 1. The wire contract, exactly as handed over
// ═══════════════════════════════════════════════════════════════════════════

test('super_admin + any status, not invoice-linked → deletable via purge', async () => {
  const { orderDeleteRight } = await loadUtil();
  for (const status of ['paid', 'processing', 'shipped', 'completed', 'pending', 'refunded']) {
    const r = orderDeleteRight({ status, deletable: true, delete_method: 'purge', delete_blocked_reason: null });
    assert.equal(r.deletable, true, `${status} must be deletable when the server says so`);
    assert.equal(r.method, 'purge');
    assert.equal(r.reason, null);
    assert.equal(r.source, 'server');
  }
});

test('super_admin + invoice-linked → blocked, with the handoff sentence verbatim', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'paid', deletable: false, delete_method: null, delete_blocked_reason: 'invoice_link' });
  assert.equal(r.deletable, false);
  assert.equal(r.method, null);
  assert.equal(r.reason, 'invoice_link');
  assert.equal(r.copy, INVOICE_LINK_COPY);
  assert.ok(r.hint.length > 0, 'and an actionable hint about clearing the link');
});

test('order_manager + cancelled → deletable via the ordinary delete door', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'cancelled', deletable: true, delete_method: 'delete', delete_blocked_reason: null });
  assert.equal(r.method, 'delete');
  assert.equal(r.source, 'server');
});

test('order_manager + anything else → blocked, with the handoff sentence verbatim', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'paid', deletable: false, delete_method: null, delete_blocked_reason: 'not_cancelled' });
  assert.equal(r.deletable, false);
  assert.equal(r.copy, NOT_CANCELLED_COPY);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Every unprovable case is LOUD, and blocks
// ═══════════════════════════════════════════════════════════════════════════

test('deletable:true with no delete_method blocks rather than guessing a door', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'paid', deletable: true, delete_method: null });
  assert.equal(r.deletable, false);
  assert.equal(r.reason, 'fe_unknown_method');
  assert.match(r.copy, /did not say how/i);
});

test('an unrecognised delete_method is never routed anywhere', async () => {
  const { orderDeleteRight, groupSelectionForDelete } = await loadUtil();
  const row = { status: 'paid', deletable: true, delete_method: 'incinerate' };
  assert.equal(orderDeleteRight(row).deletable, false);
  const g = groupSelectionForDelete(['x'], () => row);
  assert.deepEqual(g.purge, [], 'an unknown method must not fall into the purge bucket');
  assert.deepEqual(g.delete, [], 'nor into the delete bucket');
  assert.equal(g.blocked.length, 1);
});

test('deletable:false with no reason says so, and does NOT claim "not cancelled"', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'paid', deletable: false });
  assert.equal(r.reason, 'fe_unspecified');
  assert.ok(!/cancelled/i.test(r.copy),
    'inventing the cancelled-only reason for an unexplained refusal presents a guess as a fact');
});

test('an unknown block reason echoes its raw token instead of a bland sentence', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'paid', deletable: false, delete_blocked_reason: 'quarantined' });
  assert.equal(r.reason, 'quarantined', 'the raw token survives so it groups on its own and can be quoted back');
  assert.match(r.copy, /quarantined/, 'and appears in the copy the admin reads');
});

test('a contradictory payload resolves to BLOCKED, with the server’s own reason', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ status: 'paid', deletable: true, delete_method: 'purge', delete_blocked_reason: 'invoice_link' });
  assert.equal(r.deletable, false, 'when a payload disagrees with itself, believe the block');
  assert.equal(r.copy, INVOICE_LINK_COPY);
});

test('a null order is unresolved — never deletable', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight(null);
  assert.equal(r.deletable, false);
  assert.equal(r.reason, 'fe_unresolved');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The legacy fallback — safe by construction
// ═══════════════════════════════════════════════════════════════════════════

test('a row without contract fields falls back to the cancelled-only rule', async () => {
  const { orderDeleteRight } = await loadUtil();
  for (const status of ['cancelled', 'Cancelled', 'CANCELLED']) {
    const r = orderDeleteRight({ status });
    assert.equal(r.deletable, true, `${status} stays deletable under the fallback`);
    assert.equal(r.method, 'delete');
    assert.equal(r.source, 'legacy');
  }
  const paid = orderDeleteRight({ status: 'paid' });
  assert.equal(paid.deletable, false);
  assert.equal(paid.reason, 'not_cancelled');
  assert.equal(paid.source, 'legacy');
});

test('the legacy path can NEVER hand back a purge, for any status', async () => {
  const { orderDeleteRight } = await loadUtil();
  // Purge is role-gated server-side. The frontend must not infer a role, and
  // `delete` on a cancelled order is honoured for every admin role — so a stale
  // legacy row can only ever produce a request the backend already accepts.
  const ALL_STATUSES = ['pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'];
  for (const status of ALL_STATUSES) {
    assert.notEqual(orderDeleteRight({ status }).method, 'purge', `${status} must not legacy-resolve to purge`);
  }
});

test('a row with no status at all is unresolved, not "not cancelled"', async () => {
  const { orderDeleteRight } = await loadUtil();
  const r = orderDeleteRight({ order_number: 'ORD-X' });
  assert.equal(r.reason, 'fe_unresolved',
    'claiming the cancelled-only rule about a row whose status we never had is a lie dressed as a rule');
});

test('deleteContractOf copies the three fields VERBATIM — it never fills a default', async () => {
  const { deleteContractOf, orderDeleteRight } = await loadUtil();
  const projected = deleteContractOf({});
  assert.deepEqual(Object.keys(projected).sort(), ['delete_blocked_reason', 'delete_method', 'deletable'].sort());
  assert.equal(projected.deletable, undefined);
  assert.equal(projected.delete_method, undefined);
  assert.equal(projected.delete_blocked_reason, undefined);
  // The whole point: a cached legacy row must still take the legacy path. A
  // `deletable: !!row.deletable` here would turn every one of them into a
  // SERVER answer of "blocked", killing the fallback across a rollback.
  const cached = { order_number: 'ORD-1', status: 'cancelled', ...deleteContractOf({}) };
  assert.equal(orderDeleteRight(cached).source, 'legacy');
  assert.equal(orderDeleteRight(cached).deletable, true);
});

test('deletable:null (a half-migrated backend) still takes the legacy path', async () => {
  const { orderDeleteRight } = await loadUtil();
  assert.equal(orderDeleteRight({ status: 'cancelled', deletable: null }).source, 'legacy');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. resolveDeleteRight — the detail-payload trap
// ═══════════════════════════════════════════════════════════════════════════

test('the modal resolves its right from whichever payload carries the contract', async () => {
  const { resolveDeleteRight } = await loadUtil();
  // GET /api/admin/orders/:id is not promised to echo the three fields. Gating
  // on the detail payload alone would legacy-resolve a paid order to BLOCKED and
  // the owner would find no delete button at all — the feature silently gone.
  const detail = { id: 'a', status: 'paid' };                                   // no contract
  const listRow = { id: 'a', status: 'paid', deletable: true, delete_method: 'purge' };
  const r = resolveDeleteRight(detail, listRow);
  assert.equal(r.deletable, true);
  assert.equal(r.method, 'purge');
  assert.equal(r.source, 'server');
});

test('resolveDeleteRight falls back to legacy when nothing carries a contract', async () => {
  const { resolveDeleteRight } = await loadUtil();
  assert.equal(resolveDeleteRight({ status: 'cancelled' }, null).method, 'delete');
  assert.equal(resolveDeleteRight(null, undefined).reason, 'fe_unresolved');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Grouping a selection — fail CLOSED, and never send a blocked id
// ═══════════════════════════════════════════════════════════════════════════

test('a mixed selection splits by door and preserves selection order', async () => {
  const { groupSelectionForDelete } = await loadUtil();
  const rows = {
    p1: { deletable: true, delete_method: 'purge' },
    d1: { deletable: true, delete_method: 'delete' },
    p2: { deletable: true, delete_method: 'purge' },
    b1: { deletable: false, delete_blocked_reason: 'invoice_link' },
  };
  const g = groupSelectionForDelete(['p1', 'd1', 'p2', 'b1', 'ghost'], (id) => rows[id] || null);
  assert.deepEqual(g.purge, ['p1', 'p2']);
  assert.deepEqual(g.delete, ['d1']);
  assert.deepEqual(g.blocked.map(b => b.id), ['b1', 'ghost']);
  assert.equal(g.total, 5);
  assert.equal(g.actionable, 3);
  assert.deepEqual(g.methods, ['purge', 'delete']);
});

test('an id that resolves to nothing is BLOCKED — the selection survives pagination', async () => {
  const { groupSelectionForDelete } = await loadUtil();
  // DataTable.setData does NOT clear selection, so a selected id may not be in
  // _table.data. Treating an unresolvable id as deletable would resurrect the
  // original bug — and under the purge door it would be irreversible.
  const g = groupSelectionForDelete(['gone'], () => null);
  assert.deepEqual(g.purge, []);
  assert.deepEqual(g.delete, []);
  assert.equal(g.blocked[0].reason, 'fe_unresolved');
  assert.equal(g.actionable, 0);
});

test('groupSelectionForDelete survives a resolver that returns undefined or is absent', async () => {
  const { groupSelectionForDelete } = await loadUtil();
  assert.equal(groupSelectionForDelete(['a'], () => undefined).blocked.length, 1);
  assert.equal(groupSelectionForDelete(['a']).blocked.length, 1);
  assert.equal(groupSelectionForDelete([], () => null).total, 0);
});

test('blockedSummary rolls up by reason, stably', async () => {
  const { blockedSummary } = await loadUtil();
  const rows = blockedSummary([
    { id: '1', reason: 'invoice_link', copy: INVOICE_LINK_COPY, hint: 'h' },
    { id: '2', reason: 'fe_unresolved', copy: 'x', hint: '' },
    { id: '3', reason: 'invoice_link', copy: INVOICE_LINK_COPY, hint: 'h' },
  ]);
  assert.deepEqual(rows.map(r => [r.reason, r.count]), [['invoice_link', 2], ['fe_unresolved', 1]]);
  assert.deepEqual(rows[0].ids, ['1', '3']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The purge response — an id the server never mentioned is NOT a success
// ═══════════════════════════════════════════════════════════════════════════

test('a partial purge splits deleted / failed / unaccounted', async () => {
  const { normalisePurgeResult } = await loadUtil();
  const r = normalisePurgeResult(['1', '2', '3'], {
    deleted: ['1'],
    failed: [{ id: '2', code: 'ORDER_HAS_INVOICE_LINK', message: 'linked' }],
  });
  assert.deepEqual(r.deleted, ['1']);
  assert.deepEqual(r.failed, [{ id: '2', code: 'ORDER_HAS_INVOICE_LINK', message: 'linked' }]);
  assert.deepEqual(r.unaccounted, ['3'], 'id 3 was never mentioned — its outcome is UNKNOWN');
});

test('a missing or unreadable body makes EVERY id unaccounted, never deleted', async () => {
  const { normalisePurgeResult } = await loadUtil();
  for (const payload of [null, undefined, 'nope', 42]) {
    const r = normalisePurgeResult(['1', '2'], payload);
    assert.deepEqual(r.deleted, [], 'nothing may be reported as deleted off a body we could not read');
    assert.deepEqual(r.unaccounted, ['1', '2']);
  }
});

test('`deleted` as a COUNT is only trusted when the arithmetic reconciles exactly', async () => {
  const { normalisePurgeResult } = await loadUtil();
  // The contract doc that would have settled array-vs-count was never delivered.
  const ok = normalisePurgeResult(['1', '2'], { deleted: 1, failed: [{ id: '2', code: 'X' }] });
  assert.deepEqual(ok.deleted, ['1']);
  assert.deepEqual(ok.unaccounted, []);

  const bad = normalisePurgeResult(['1', '2', '3'], { deleted: 1, failed: [] });
  assert.deepEqual(bad.deleted, [], 'a count we cannot map to ids names no order as deleted');
  assert.deepEqual(bad.unaccounted, ['1', '2', '3']);
});

test('an id in BOTH lists counts as failed, never as deleted', async () => {
  const { normalisePurgeResult } = await loadUtil();
  const r = normalisePurgeResult(['1'], { deleted: ['1'], failed: [{ id: '1', code: 'X', message: 'no' }] });
  assert.deepEqual(r.deleted, []);
  assert.equal(r.failed.length, 1);
});

test('a failure with no code keeps code:null — a code is never invented', async () => {
  const { normalisePurgeResult } = await loadUtil();
  const r = normalisePurgeResult(['1'], { deleted: [], failed: [{ id: '1', message: 'because' }] });
  assert.equal(r.failed[0].code, null);
  assert.equal(r.failed[0].message, 'because');
});

test('an id we never requested is surfaced as unexpected', async () => {
  const { normalisePurgeResult } = await loadUtil();
  const r = normalisePurgeResult(['1'], { deleted: ['1', '9'], failed: [] });
  assert.deepEqual(r.unexpected, ['9']);
  assert.deepEqual(r.deleted, ['1']);
});

test('every requested id is accounted for exactly once', async () => {
  const { normalisePurgeResult } = await loadUtil();
  const cases = [
    [['1', '2', '3'], { deleted: ['1'], failed: [{ id: '2', code: 'X' }] }],
    [['1', '2'], null],
    [['1'], { deleted: [], failed: [] }],
    [['1', '2'], { deleted: 2, failed: [] }],
  ];
  for (const [ids, payload] of cases) {
    const r = normalisePurgeResult(ids, payload);
    assert.equal(r.deleted.length + r.failed.length + r.unaccounted.length, ids.length,
      `every id must land in exactly one bucket (${JSON.stringify(payload)})`);
    for (const id of r.deleted) assert.ok(!r.unaccounted.includes(id));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Copy — ONE vocabulary, and codes not prose
// ═══════════════════════════════════════════════════════════════════════════

test('the pre-flight hint and the authoritative refusal are the SAME sentence', async () => {
  const { BLOCK_REASON_COPY, DELETE_FAILURE_COPY } = await loadUtil();
  // `invoice_link` (a hint on the row) and ORDER_HAS_INVOICE_LINK (the purge
  // endpoint's refusal) are the same fact. Two copies is how they start
  // contradicting each other in front of the admin.
  assert.equal(DELETE_FAILURE_COPY.ORDER_HAS_INVOICE_LINK, BLOCK_REASON_COPY.invoice_link);
  assert.equal(DELETE_FAILURE_COPY.ORDER_NOT_CANCELLED, BLOCK_REASON_COPY.not_cancelled);
  assert.equal(BLOCK_REASON_COPY.invoice_link, INVOICE_LINK_COPY);
  assert.equal(BLOCK_REASON_COPY.not_cancelled, NOT_CANCELLED_COPY);
});

test('an unknown failure code surfaces both the code and the server message', async () => {
  const { purgeFailureCopy } = await loadUtil();
  assert.equal(purgeFailureCopy('WEIRD_CODE', 'boom'), 'WEIRD_CODE — boom');
  assert.match(purgeFailureCopy('WEIRD_CODE'), /WEIRD_CODE/);
  assert.ok(purgeFailureCopy(null, '').length > 0, 'and there is always something to show');
});

test('ORDER_NOT_FOUND reads as already-gone, not as a failure to act on', async () => {
  const { purgeFailureCopy } = await loadUtil();
  assert.match(purgeFailureCopy('ORDER_NOT_FOUND'), /already gone/i);
});

test('the util emits no HTML and logs nothing — the page escapes and the page logs', () => {
  assert.doesNotMatch(utilJs, /innerHTML|<span|<li>|<div/, 'copy is plain text; markup belongs to the caller');
  assert.doesNotMatch(utilJs, /(^|[^.\w])console\./m, 'use DebugLog, never raw console.* (ERR-035)');
  assert.doesNotMatch(utilJs, /DebugLog\./, 'loudness lives in the RETURN VALUE here, not in a log line');
  assert.doesNotMatch(utilJs, /^import /m, 'the util must stay dependency-free so it unit-tests directly');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The confirm dialog is honest about what a purge does
// ═══════════════════════════════════════════════════════════════════════════

test('a purge plan states irreversibility, the cascade, and the audit-log snapshot', async () => {
  const { deletePlanCopy } = await loadUtil();
  const plan = deletePlanCopy({ purge: ['a', 'b'], delete: [], blocked: [] });
  const all = plan.warnings.join(' ');
  assert.match(all, /cannot be undone/i);
  assert.match(all, /audit log/i);
  assert.match(all, /line items/i, 'the cascade must be spelled out, not implied');
  assert.match(all, /only a hint/i, 'and the invoice-link pre-check must admit it is not the authority');
  assert.equal(plan.confirmLabel, 'Purge 2');
});

test('a delete-only plan never mentions purging', async () => {
  const { deletePlanCopy } = await loadUtil();
  const plan = deletePlanCopy({ purge: [], delete: ['a'], blocked: [] });
  assert.doesNotMatch(plan.warnings.join(' ') + plan.lines.join(' '), /purge/i);
  assert.equal(plan.confirmLabel, 'Delete 1');
});

test('a MIXED plan states both counts — never one number hiding a hard purge', async () => {
  const { deletePlanCopy, deleteActionLabel } = await loadUtil();
  const groups = { purge: ['a', 'b', 'c'], delete: ['d'], blocked: [] };
  assert.equal(deletePlanCopy(groups).confirmLabel, 'Purge 3 · Delete 1');
  assert.equal(deleteActionLabel(groups), 'Purge 3 · Delete 1');
  assert.equal(deletePlanCopy(groups).lines.length, 2, 'one line per door');
});

test('skipped orders are named, by reason, before the admin commits', async () => {
  const { deletePlanCopy } = await loadUtil();
  const plan = deletePlanCopy({
    purge: ['a'],
    delete: [],
    blocked: [
      { id: 'x', reason: 'invoice_link', copy: INVOICE_LINK_COPY, hint: 'Open it first.' },
      { id: 'y', reason: 'invoice_link', copy: INVOICE_LINK_COPY, hint: 'Open it first.' },
    ],
  });
  assert.equal(plan.skips.length, 1, 'rolled up by reason');
  assert.match(plan.skips[0], /^2 skipped/);
  assert.match(plan.skips[0], /invoice/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. The page reads the vocabulary — it never re-implements the rule
// ═══════════════════════════════════════════════════════════════════════════

test('orders.js imports the vocabulary and declares no status rule of its own', () => {
  assert.match(ordersJs, /from '\.\.\/utils\/order-deletability\.js'/,
    'the page must import the one vocabulary');
  assert.doesNotMatch(ordersJs, /const DELETABLE_STATUSES\s*=/,
    'the hardcoded status list is gone — deletability is a server answer now');
  assert.doesNotMatch(ordersJs, /function isDeletable\(/,
    'and so is the status predicate that read it');
  // The inline literal is what let the two paths drift apart in the first place.
  assert.doesNotMatch(ordersJs, /(o|order)\.status === 'cancelled'/,
    'no path may re-implement a delete rule inline');
});

test('neither contract sentence is duplicated into the page', () => {
  assert.ok(!ordersJs.includes(INVOICE_LINK_COPY),
    'the invoice-link sentence lives in the util only');
  assert.ok(!ordersJs.includes(NOT_CANCELLED_COPY),
    'the cancelled-only sentence lives in the util only');
});

test('BOTH delete paths read the same resolved right', () => {
  assert.match(ordersJs, /const deleteRight = resolveDeleteRight\(fullOrder, lookupOrder\(order\.id\), order\)/,
    'the modal must resolve across the detail AND list payloads, not gate on the detail alone');
  assert.match(ordersJs, /if \(right\.deletable\) \{/,
    'the modal Delete BUTTON is gated by the resolved right');
  assert.match(ordersJs, /const right = deleteRight \|\| orderDeleteRight\(order\)/,
    'and so is its handler, from the very same object');
});

test('a blocked order keeps a disabled button carrying its reason', () => {
  assert.match(ordersJs, /data-action="delete-blocked" disabled/,
    'hiding the control leaves "linked to an invoice" nowhere to be explained');
  assert.match(ordersJs, /esc\(right\.hint \? `\$\{right\.copy\}\\n\$\{right\.hint\}` : right\.copy\)/,
    'the tooltip carries the reason and, when there is one, the fix');
});

test('the single-order button names the door it will open', () => {
  assert.match(ordersJs, /methodVerb\(right\.method\)/,
    'Purge vs Delete must be visible before the click');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. The bulk path never sends a blocked id
// ═══════════════════════════════════════════════════════════════════════════

test('the bulk bar groups the selection and disables Delete when nothing qualifies', () => {
  const bulkBar = ordersJs.slice(ordersJs.indexOf('function updateBulkBar'), ordersJs.indexOf('function confirmDeletePlan'));
  assert.match(bulkBar, /groupSelection\(selected\)/,
    'updateBulkBar must group before rendering the action button');
  assert.match(bulkBar, /nothingDeletable \|\| _deleteInFlight \? ' disabled' : ''/,
    'the action must render disabled when nothing is actionable, and while a delete is running');
  assert.match(bulkBar, /blockedSummary\(groups\.blocked\)/,
    'blocked orders must be rolled up by reason for the tooltip');
  assert.match(bulkBar, /deleteActionLabel\(groups\)/,
    'and the label must name the door(s)');
});

test('the bulk bar breaks the count out by door', () => {
  const bulkBar = ordersJs.slice(ordersJs.indexOf('function updateBulkBar'), ordersJs.indexOf('function confirmDeletePlan'));
  assert.match(bulkBar, /\$\{groups\.purge\.length\} purge/);
  assert.match(bulkBar, /\$\{groups\.delete\.length\} delete/);
  assert.match(bulkBar, /\$\{groups\.blocked\.length\} blocked/);
});

test('bulkDelete acts on the GROUPED ids only, never on the raw selection', () => {
  const fn = ordersJs.slice(ordersJs.indexOf('async function bulkDelete'), ordersJs.indexOf('// ---- Full-page order modal ----'));
  assert.match(fn, /const groups = groupSelection\(selected\)/,
    'bulkDelete must group the selection up front');
  assert.match(fn, /if \(groups\.actionable === 0\)/,
    'bulkDelete must bail out (no request) when nothing is actionable');
  // The pre-fix bug: `const ids = [...selected]` sent every selected id.
  assert.doesNotMatch(fn, /const ids = \[\.\.\.selected\]/,
    'bulkDelete must never post the unfiltered selection');
  assert.match(fn, /batch\.map\(id => AdminAPI\.deleteOrder\(id\)\)/,
    'the batched Promise.allSettled delete is preserved, for the delete group');
  assert.match(fn, /groups\.delete\.slice\(i, i \+ 5\)/,
    'and it batches groups.delete, not the whole selection');
});

test('the purge is ONE call, not a per-id loop', () => {
  const fn = ordersJs.slice(ordersJs.indexOf('async function bulkDelete'), ordersJs.indexOf('// ---- Full-page order modal ----'));
  const calls = fn.match(/AdminAPI\.purgeOrders\(/g) || [];
  assert.equal(calls.length, 1, 'exactly one purge call site in the bulk path');
  assert.match(fn, /await AdminAPI\.purgeOrders\(groups\.purge\)/,
    'the whole purge group goes in one request — N calls would be N audit writes and N chances to half-succeed');
  const loopThenPurge = /for \([^)]*\)\s*\{[^}]*AdminAPI\.purgeOrders\(/s;
  assert.doesNotMatch(fn, loopThenPurge, 'and it is not inside a loop');
});

test('a second click cannot land while a delete is in flight', () => {
  assert.match(ordersJs, /let _deleteInFlight = false;/);
  assert.match(ordersJs, /if \(!_table \|\| _deleteInFlight\) return;/,
    'without this, the second pass reports already-purged orders as failures');
  assert.match(ordersJs, /\} finally \{\s*\n\s*_deleteInFlight = false;/,
    'and the flag must clear even when the work throws');
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Partial outcomes are LOUD, per order, and never rounded to a verdict
// ═══════════════════════════════════════════════════════════════════════════

test('outcomes are tracked per order, not collapsed into one firstError', () => {
  assert.doesNotMatch(ordersJs, /firstError/,
    'the single-firstError toast hid which orders failed — it must stay gone');
  assert.match(ordersJs, /failed\.push\(\{ id, label: label\(id\), code:/,
    'each rejection must be recorded with its own order label and CODE');
  assert.match(ordersJs, /function showDeleteResults\(/,
    'a results surface must list every order that was not deleted');
});

test('"outcome unknown" is its own bucket — neither a success nor a failure', () => {
  const fn = ordersJs.slice(ordersJs.indexOf('function showDeleteResults'), ordersJs.indexOf('let _deleteInFlight'));
  assert.match(fn, /section\('Outcome unknown'/,
    'an unaccounted id gets its own heading, separate from the refusals');
  assert.match(fn, /section\('Deleted'/);
  assert.match(fn, /section\('Refused by the server'/);
  assert.match(fn, /section\('Skipped/);
  assert.match(fn, /section\('Not attempted'/);
  // Folding "we don't know" into either verdict is the ERR-074 shape, and after
  // an irreversible purge it is the most dangerous lie available.
  const bulk = ordersJs.slice(ordersJs.indexOf('async function bulkDelete'));
  assert.match(bulk, /unknown\.push\(\{ id, label: label\(id\), message: UNACCOUNTED_COPY \}\)/,
    'unaccounted ids from the purge response become unknown outcomes');
  assert.match(bulk, /Toast\.warning\(msg\)/,
    'an unknown-only outcome warns rather than errors — nothing was proven to have failed');
});

test('labels are captured BEFORE the list reloads', () => {
  const bulk = ordersJs.slice(ordersJs.indexOf('async function bulkDelete'), ordersJs.indexOf('// ---- Full-page order modal ----'));
  assert.match(bulk, /const labels = new Map\(/,
    'every outcome record must carry a label captured up front');
  const results = ordersJs.slice(ordersJs.indexOf('function showDeleteResults'), ordersJs.indexOf('let _deleteInFlight'));
  const deferred = results.slice(results.indexOf('setTimeout'));
  assert.doesNotMatch(deferred, /orderLabel\(/,
    'resolving a label inside the deferred modal would print a purged order as a truncated UUID');
});

test('the results modal is still deferred past the dialog close', () => {
  // Modal.close() may be running from the confirm dialog's own click handler, so
  // a synchronous open would be closed immediately. Load-bearing, not cosmetic.
  const fn = ordersJs.slice(ordersJs.indexOf('function showDeleteResults'), ordersJs.indexOf('let _deleteInFlight'));
  assert.match(fn, /setTimeout\(\(\) => \{[\s\S]*Modal\.open\(/,
    'showDeleteResults must open its modal inside a setTimeout');
});

test('the confirm dialog is not Modal.confirm, and cannot resolve twice', () => {
  const fn = ordersJs.slice(ordersJs.indexOf('function confirmDeletePlan'), ordersJs.indexOf('function showDeleteResults'));
  // Modal.confirm escapes its message into one <p>, closes AFTER onConfirm
  // resolves, and swallows onConfirm exceptions — so a 403 would close the
  // dialog with no message at all.
  assert.doesNotMatch(fn, /Modal\.confirm\(/);
  assert.match(fn, /let settled = false;/, 'confirm-then-close must not settle the promise twice');
  assert.match(fn, /onClose: \(\) => finish\(false\)/,
    'backdrop, close button and Escape all mean NO');
});

test('a refused purge with FORBIDDEN aborts the rest instead of carrying on', () => {
  const bulk = ordersJs.slice(ordersJs.indexOf('async function bulkDelete'), ordersJs.indexOf('// ---- Full-page order modal ----'));
  assert.match(bulk, /e\?\.code === 'FORBIDDEN' \|\| e\?\.code === 'UNAUTHORIZED'/,
    'branch on the CODE — running the per-id deletes after an auth refusal would act on a permission model just disproved');
  assert.match(bulk, /notAttempted\.push\(/,
    'and the untried group is reported as NOT ATTEMPTED, distinct from failed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. The backend's message stays the backend's — branch on codes
// ═══════════════════════════════════════════════════════════════════════════

test('no delete path branches on the backend’s error prose', () => {
  // `js/api.js` request() DOES attach `e.code` on its throw path, and returns an
  // `{ok:false, code}` envelope for 401/403/404/429/5xx. The "there is no
  // err.code" folklore came from AdminAPI.deleteOrder rebuilding the envelope as
  // a bare `new Error(resp.error)` — which is what licensed prose-matching in
  // the first place (ERR-077 → ERR-132). Gate on the code, always.
  assert.doesNotMatch(ordersJs, /(includes|indexOf|match)\([^)]*Only cancelled/,
    'deletability must be decided by the contract, not by parsing the backend error text');
  assert.doesNotMatch(ordersJs, /\.message[\s\S]{0,20}\.(includes|match|indexOf)\(/,
    'no delete path may branch on a message string');
  assert.match(ordersJs, /purgeFailureCopy\(r\.reason\?\.code, r\.reason\?\.message\)/,
    'a rejection is classified by its code and only DISPLAYS its message');
});

test('AdminAPI rebuilds a non-ok envelope into an Error that KEEPS its code', () => {
  assert.match(apiJs, /function errorFromEnvelope\(resp, fallbackMessage\)/,
    'one module-level helper, so `this` binding can never matter');
  assert.match(apiJs, /e\.code = resp\?\.code \|\| \(err && typeof err === 'object' \? err\.code : null\) \|\| null;/,
    'the code is read from both envelope shapes — a string `error` and a `{code, message}` object');
  assert.match(apiJs, /e\.status = resp\?\.status \?\? null;/);
  assert.match(apiJs, /throw errorFromEnvelope\(resp, 'Delete failed'\)/,
    'deleteOrder must stop discarding the code');
  assert.match(apiJs, /const err = errorFromEnvelope\(resp, 'Purge failed'\)/);
});

test('the bare-Error construction is gone from EVERY AdminAPI method, not just the two doors', () => {
  // 28 methods carried the identical defect. Leaving 26 of them live would have
  // left the same trap set for whoever next needs to branch on a refusal.
  // The message is unchanged at every site, so no caller behaviour moved.
  assert.doesNotMatch(apiJs, /throw new Error\(resp\.error/,
    'an envelope must never be rebuilt as a bare Error — the code is the branchable part');
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. The purge wrapper
// ═══════════════════════════════════════════════════════════════════════════

test('purgeOrders posts the documented body to the documented route', () => {
  assert.match(apiJs, /window\.API\.post\('\/api\/admin\/orders\/purge', \{ order_ids: chunk \}\)/,
    'exact route and exact snake_case body key');
  assert.match(apiJs, /normalisePurgeResult\(chunk, resp\.data\)/,
    'the response is normalised by the shared util, not interpreted inline');
});

test('a 200 carrying failed[] is NOT treated as an error', () => {
  const fn = apiJs.slice(apiJs.indexOf('async purgeOrders'), apiJs.indexOf('// ---- Refunds ----'));
  assert.match(fn, /anySucceeded = true;\s*\n\s*const part = normalisePurgeResult/,
    'a resolved response goes straight to normalisation — partial failure is the documented success shape');
  assert.match(fn, /if \(!anySucceeded\) \{[\s\S]{0,220}throw err;/,
    'it throws only when NOTHING was accomplished, so an earlier chunk’s irreversible work is never discarded');
});

test('purgeOrders dedupes, chunks, and warns about ids it cannot account for', () => {
  const fn = apiJs.slice(apiJs.indexOf('async purgeOrders'), apiJs.indexOf('// ---- Refunds ----'));
  assert.match(fn, /\[\.\.\.new Set\(/, 'a doubled id would come back once and read as unaccounted');
  assert.match(fn, /i \+= PURGE_CHUNK/);
  assert.match(apiJs, /const PURGE_CHUNK = \d+;/);
  assert.match(fn, /in neither deleted nor failed/, 'unaccounted ids are logged as well as returned');
  assert.match(fn, /ids we never requested/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Cache lifetime — the map now holds a PERMISSION
// ═══════════════════════════════════════════════════════════════════════════

test('the seen-orders cache carries the delete contract verbatim', () => {
  assert.match(ordersJs, /const _seenOrders = new Map\(\)/,
    'a cache must survive page changes so a selection can still be resolved');
  assert.match(ordersJs, /\.\.\.deleteContractOf\(r\),/,
    'and it must carry the contract fields, projected verbatim so absence stays absence');
  assert.match(ordersJs, /rememberOrders\(rows\)/, 'loadOrders must feed the cache before setData');
});

test('every attempted id is evicted — refusals included', () => {
  assert.match(ordersJs, /function forgetOrderCache\(id\)/);
  assert.match(ordersJs, /for \(const rec of \[\.\.\.deleted, \.\.\.failed, \.\.\.unknown\]\) forgetOrderCache\(rec\.id\)/,
    'a refusal is NEWER information than the cached contract — it must not gate the next click');
});

test('leaving the tab clears the cached permissions', () => {
  const destroy = ordersJs.slice(ordersJs.indexOf('function destroyOrdersTab'), ordersJs.indexOf('// ---- Tab switching ----'));
  assert.match(destroy, /_seenOrders\.clear\(\)/,
    'the map now caches a role-dependent permission answer; session-lifetime retention is a staleness hazard');
  assert.match(destroy, /_deleteInFlight = false/);
});

test('a status change evicts the row — it flips deletability', () => {
  assert.match(ordersJs, /forgetOrderCache\(order\.id\);\s*\n\s*Toast\.success\(`Order updated to/,
    'a cancelled order becomes deletable for every role, and the bulk bar may still hold the id');
});

test('a page that arrives without the contract fields says so out loud', () => {
  assert.match(ordersJs, /if \(rows\.length > 0 && !rows\.some\(hasDeleteContract\)\)/,
    'a backend rollback would otherwise revert this whole surface in silence');
  assert.match(ordersJs, /falling back to the legacy cancelled-only rule/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Plumbing + cache busting
// ═══════════════════════════════════════════════════════════════════════════

test('deleteOrder encodes the id like its sibling admin API methods', () => {
  assert.match(apiJs, /API\.delete\(`\/api\/admin\/orders\/\$\{encodeURIComponent\(orderId\)\}`\)/,
    'the order id must be URL-encoded');
});

test('cache-busting tokens were bumped so the edited modules re-fetch', () => {
  const appVer = appJs.match(/const APP_VERSION = '([^']+)'/)[1];
  // The value being replaced. Asserting against it is the only way the check
  // means anything — note the tree already carried an unrelated same-day bump
  // ('2026.07.30-invoice-status-email-log'), so this had to advance past BOTH.
  assert.notEqual(appVer, '2026.07.29-gst-basis-labels', 'APP_VERSION must advance (pages/orders.js changed)');
  assert.notEqual(appVer, '2026.07.30-invoice-status-email-log', 'and past the same-day invoice bump');
  assert.match(appVer, /^\d{4}\.\d{2}\.\d{2}-[a-z0-9-]+$/, 'APP_VERSION keeps the date-prefixed format');
  // ERR-124: api.js is no longer imported with a per-call-site token — that forked
  // AdminAPI into two module instances. It is bare, and stays bare; consistency is
  // pinned by tests/asset-cache-tokens.test.js §4.
  assert.doesNotMatch(appJs, /from '\.\/api\.js\?v=/,
    'the api.js import must stay bare so AdminAPI is a single module instance');
  assert.doesNotMatch(apiJs, /from '\.\/utils\/order-deletability\.js\?v=/,
    'and the new util is imported bare for the same reason');
});

test('no raw console.* was introduced (ERR-035)', () => {
  assert.doesNotMatch(ordersJs, /(^|[^.\w])console\./m, 'use DebugLog, never raw console.*');
});
