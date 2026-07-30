/**
 * Order deletability — the single vocabulary for "may this order be deleted,
 * how, and if not, why not".
 *
 * ── Who decides ─────────────────────────────────────────────────────────────
 *
 * The BACKEND does. `GET /api/admin/orders` returns three additive fields on
 * every row, computed server-side from the caller's role AND the order:
 *
 *   deletable             boolean          may THIS admin delete THIS order?
 *   delete_method         'purge'|'delete'|null   which door to use
 *   delete_blocked_reason null|'invoice_link'|'not_cancelled'
 *
 * | Caller                  | Order                        | deletable | method   | reason        |
 * |-------------------------|------------------------------|-----------|----------|---------------|
 * | super_admin (owner)     | any status, not invoice-linked | true    | 'purge'  | null          |
 * | super_admin             | invoice / quick-order linked | false     | null     | invoice_link  |
 * | order_manager           | cancelled                    | true      | 'delete' | null          |
 * | order_manager           | anything else                | false     | null     | not_cancelled |
 *
 * The frontend NEVER re-derives this from `status` and NEVER infers it from the
 * admin's role. Until Jul 2026 it did exactly that — a hardcoded
 * `DELETABLE_STATUSES = ['cancelled']` — which was right while the only door was
 * the cancelled-only `DELETE /api/admin/orders/:id`, and became wrong the day the
 * owner-only hard purge shipped: every paid test order was reported "not
 * deletable" by a rule the server no longer held (ERR-120 → ERR-130).
 *
 * ── What this module is ─────────────────────────────────────────────────────
 *
 * Pure. No DOM, no globals, no `Security`, no `DebugLog`, no imports. It returns
 * PLAIN TEXT and plain data; the calling page escapes and renders. That is why it
 * unit-tests directly under `node --test` (see tests/admin-order-delete-gating.test.js)
 * — the branch that decides whether an irreversible purge fires is exercised for
 * real, not grepped for.
 *
 * ── The house rule it exists to enforce ─────────────────────────────────────
 *
 * Fail-soft must be LOUD, and fail-CLOSED. Every path that cannot prove an order
 * is deletable blocks it and says, in its own words, WHY it could not prove it.
 * There is no generic "cannot be deleted" — a sentence like that presents an
 * unknown as a known, which is how a silently-reverted backend contract, or a
 * `delete_method` this build has never heard of, would look exactly like a normal
 * refusal. FE-authored reasons are prefixed `fe_` so a console line or a
 * screenshot never leaves you guessing whose sentence you are reading.
 */

/** The two doors. Values are literally the wire values — no translation layer. */
export const DELETE_METHOD = Object.freeze({
  PURGE: 'purge',    // POST /api/admin/orders/purge  — owner-only hard purge
  DELETE: 'delete',  // DELETE /api/admin/orders/:id  — cancelled-only
});

const KNOWN_METHODS = Object.freeze([DELETE_METHOD.PURGE, DELETE_METHOD.DELETE]);

/**
 * Why an order is not deletable.
 *
 * The first two come off the wire. The `fe_` ones are ours: answers the wire
 * cannot express, each naming a DIFFERENT failure of proof. Collapsing them into
 * one would be the ERR-074 shape — "we don't know" rendered as "we do".
 */
export const BLOCK_REASON = Object.freeze({
  INVOICE_LINK: 'invoice_link',        // wire — order links to an invoice / quick order
  NOT_CANCELLED: 'not_cancelled',      // wire — non-owner admin, order isn't cancelled
  UNRESOLVED: 'fe_unresolved',         // we cannot find the order (or its status) at all
  UNKNOWN_METHOD: 'fe_unknown_method', // deletable:true but no/unrecognised delete_method
  UNSPECIFIED: 'fe_unspecified',       // deletable:false and the server gave no reason
});

// A wire reason this build has never heard of keeps its RAW token as `reason`
// (see blockedReasonCopy) rather than being folded into an `fe_unrecognised`
// bucket — so it groups on its own in blockedSummary and can be quoted back to
// the backend verbatim instead of being reported as "something unknown".

/**
 * Where a right came from. `'legacy'` means the row carried no contract fields
 * and we fell back to the pre-purge cancelled-only rule; a UI may surface that,
 * and `loadOrders()` warns when a whole page comes back that way.
 */
export const RIGHT_SOURCE = Object.freeze({ SERVER: 'server', LEGACY: 'legacy', NONE: 'none' });

// ── Copy ────────────────────────────────────────────────────────────────────
//
// These two sentences are the handoff's, verbatim, and they are defined ONCE.
// Each is reused by two different consumers that describe the SAME fact from
// opposite ends of the request:
//
//   invoice_link          the pre-flight HINT on the list row
//   ORDER_HAS_INVOICE_LINK the authoritative REFUSAL from the purge endpoint
//
// A second copy of either sentence is how the hint and the refusal start
// contradicting each other in front of the admin.

const INVOICE_LINK_COPY = 'Linked to an invoice / quick order — clear that first.';
const NOT_CANCELLED_COPY = 'Only cancelled orders can be deleted.';

/** Primary sentence for a block reason. Answers "why not?". */
export const BLOCK_REASON_COPY = Object.freeze({
  [BLOCK_REASON.INVOICE_LINK]: INVOICE_LINK_COPY,
  [BLOCK_REASON.NOT_CANCELLED]: NOT_CANCELLED_COPY,
  [BLOCK_REASON.UNRESOLVED]:
    "This order isn't on screen any more, so its delete permission can't be checked. Clear the selection and select it again.",
  [BLOCK_REASON.UNKNOWN_METHOD]:
    'The server says this order can be deleted but did not say how. Refusing to guess — reload the page; if it persists the backend contract has changed.',
  [BLOCK_REASON.UNSPECIFIED]:
    'The server refused this order without saying why. Refusing to guess a reason.',
});

/**
 * Second register: what to DO about it. Never a substitute for the primary
 * sentence — the old copy fused the two ('…can be deleted — change the status
 * first.') and the fused string then disagreed with the backend's own wording.
 */
export const BLOCK_REASON_HINT = Object.freeze({
  [BLOCK_REASON.INVOICE_LINK]: 'Open the linked invoice / quick order and unlink or delete it first.',
  [BLOCK_REASON.NOT_CANCELLED]: 'Change the order status to Cancelled first.',
});

/**
 * The sentence for a block reason.
 *
 * An unrecognised reason ECHOES ITS RAW TOKEN. That is deliberate: a backend
 * that starts sending `quarantined` must produce a message an admin can quote
 * back to us, not a bland "cannot be deleted" that hides a contract change.
 */
export function blockedReasonCopy(reason) {
  if (!reason) return BLOCK_REASON_COPY[BLOCK_REASON.UNSPECIFIED];
  const known = BLOCK_REASON_COPY[reason];
  if (known) return known;
  return `The server refused this order with a reason this admin build doesn't know: "${reason}". Refusing to guess what it means.`;
}

/** Actionable advice for a block reason, or '' when there is none to give. */
export function blockedReasonHint(reason) {
  return BLOCK_REASON_HINT[reason] || '';
}

// ── Reading the contract off a row ──────────────────────────────────────────

/**
 * The pre-purge rule, kept ONLY as a fallback for rows that carry no contract
 * fields (a backend rollback, or a `_seenOrders` entry cached before the deploy).
 *
 * Deliberately NOT named `DELETABLE_STATUSES`: the old name must not survive
 * anywhere in the tree, or the next reader will take it for the live rule.
 */
export const LEGACY_DELETABLE_STATUSES = Object.freeze(['cancelled']);

/**
 * The three contract fields, VERBATIM. No defaults, no coercion, no renaming.
 *
 * Absence must stay absent. Writing `deletable: !!row?.deletable` here would turn
 * every legacy row into a SERVER answer of "blocked, unspecified" and silently
 * kill the fallback for the whole page — the failure would look like a backend
 * that refuses everything rather than a frontend that guessed.
 */
export function deleteContractOf(row) {
  return {
    deletable: row?.deletable,
    delete_method: row?.delete_method,
    delete_blocked_reason: row?.delete_blocked_reason,
  };
}

/** True when a row carries the server's answer (as opposed to needing the fallback). */
export function hasDeleteContract(row) {
  // `typeof … === 'boolean'` and not `'deletable' in row`: it survives spread
  // copies and prototype-less objects, and a half-migrated backend sending
  // `deletable: null` correctly falls through to legacy instead of reading as
  // "server says false".
  return typeof row?.deletable === 'boolean';
}

function blocked(reason, source) {
  return {
    deletable: false,
    method: null,
    reason,
    copy: blockedReasonCopy(reason),
    hint: blockedReasonHint(reason),
    source,
  };
}

function allowed(method, source) {
  return { deletable: true, method, reason: null, copy: '', hint: '', source };
}

/**
 * The pre-purge cancelled-only rule.
 *
 * Two properties matter and both are pinned by tests:
 *
 *  1. It can NEVER return 'purge'. Purge is role-gated server-side and the
 *     frontend must not infer a role. `delete` on a cancelled order is honoured
 *     for every admin role, so a stale legacy row can only ever produce a
 *     request the backend already accepts.
 *  2. A row with NO status blocks as `fe_unresolved`, not `not_cancelled`.
 *     Telling an admin "only cancelled orders can be deleted" about a row whose
 *     status we never had is a lie dressed as a rule.
 */
function legacyDeleteRight(order) {
  const status = String(order?.status || '').trim().toLowerCase();
  if (!status) return blocked(BLOCK_REASON.UNRESOLVED, RIGHT_SOURCE.LEGACY);
  return LEGACY_DELETABLE_STATUSES.includes(status)
    ? allowed(DELETE_METHOD.DELETE, RIGHT_SOURCE.LEGACY)
    : blocked(BLOCK_REASON.NOT_CANCELLED, RIGHT_SOURCE.LEGACY);
}

/**
 * @typedef {{deletable: boolean, method: ('purge'|'delete'|null), reason: (string|null),
 *            copy: string, hint: string, source: ('server'|'legacy'|'none')}} DeleteRight
 */

/**
 * Resolve one order row to a delete right. Fail-closed by construction: the
 * rules run in an order that makes every disagreement inside a payload resolve
 * to BLOCKED, with the most specific reason available.
 *
 *   0. no order            → blocked, fe_unresolved
 *   1. no contract fields  → legacy fallback
 *   2. a blocked_reason    → blocked with THAT reason (even if deletable:true —
 *                            a contradictory payload gets the server's own words)
 *   3. deletable !== true  → blocked, fe_unspecified (server refused, said nothing)
 *   4. unknown method      → blocked, fe_unknown_method (never routed anywhere)
 *   5. otherwise           → deletable, via that method
 *
 * Rule 4 is also free forward-compatibility: a future `delete_method: 'archive'`
 * blocks loudly instead of being posted to whichever endpoint happened to be the
 * `else` branch.
 *
 * @returns {DeleteRight}
 */
export function orderDeleteRight(order) {
  if (!order) return blocked(BLOCK_REASON.UNRESOLVED, RIGHT_SOURCE.NONE);
  if (!hasDeleteContract(order)) return legacyDeleteRight(order);

  const wireReason = order.delete_blocked_reason;
  if (wireReason != null && wireReason !== '') {
    // The token is kept as-is, known or not: blockedReasonCopy() knows the two
    // contract reasons and echoes anything else verbatim.
    return blocked(String(wireReason), RIGHT_SOURCE.SERVER);
  }

  if (order.deletable !== true) return blocked(BLOCK_REASON.UNSPECIFIED, RIGHT_SOURCE.SERVER);

  const method = order.delete_method;
  if (!KNOWN_METHODS.includes(method)) return blocked(BLOCK_REASON.UNKNOWN_METHOD, RIGHT_SOURCE.SERVER);

  return allowed(method, RIGHT_SOURCE.SERVER);
}

/**
 * Pick the freshest authoritative answer among several representations of the
 * same order — a detail payload, a list row, a cached row.
 *
 * This exists because of a specific trap. The order-detail modal renders from
 * `fullOrder || order`, i.e. from `GET /api/admin/orders/:id`. The contract is
 * only promised on the LIST endpoint. If the detail payload doesn't echo the
 * three fields, gating on it alone silently takes the legacy path and an owner
 * opening a paid order sees NO delete button at all — the whole feature gone,
 * with no error anywhere. So: the first candidate that actually carries a server
 * contract wins, regardless of position.
 *
 * @returns {DeleteRight}
 */
export function resolveDeleteRight(...candidates) {
  const present = candidates.filter(Boolean);
  const authoritative = present.find(hasDeleteContract);
  if (authoritative) return orderDeleteRight(authoritative);
  if (present.length) return orderDeleteRight(present[0]);
  return blocked(BLOCK_REASON.UNRESOLVED, RIGHT_SOURCE.NONE);
}

// ── Selections ──────────────────────────────────────────────────────────────

/**
 * Split a bulk selection into the two doors and the blocked remainder.
 *
 * `resolve` is INJECTED (id → row|null). This module must never import a page —
 * utils importing pages is circular — and injection is also what lets the
 * grouping be tested against a plain Map.
 *
 * Bucket keys are literally the wire method values, so the routing is
 * inspectable: whatever ends up in `.purge` is what gets posted to the purge
 * endpoint. A method we do not know lands in NEITHER bucket (rule 4 above).
 *
 * @param {Iterable<string>} ids            selection order is preserved
 * @param {(id: string) => (object|null)} resolve
 * @returns {{purge: string[], delete: string[],
 *            blocked: Array<{id: string, reason: string, copy: string, hint: string, source: string}>,
 *            total: number, actionable: number, methods: string[]}}
 */
export function groupSelectionForDelete(ids, resolve) {
  const out = { purge: [], delete: [], blocked: [], total: 0, actionable: 0, methods: [] };
  const lookup = typeof resolve === 'function' ? resolve : () => null;

  for (const id of ids || []) {
    out.total++;
    const right = orderDeleteRight(lookup(id) || null);
    if (right.deletable && out[right.method]) {
      out[right.method].push(id);
    } else if (right.deletable) {
      // Defensive: a method that passed orderDeleteRight but has no bucket here
      // would otherwise vanish silently. It cannot happen today; if it ever can,
      // it blocks rather than disappears.
      out.blocked.push({ id, ...blockedFields(blocked(BLOCK_REASON.UNKNOWN_METHOD, right.source)) });
    } else {
      out.blocked.push({ id, ...blockedFields(right) });
    }
  }

  out.actionable = out.purge.length + out.delete.length;
  out.methods = KNOWN_METHODS.filter((m) => out[m].length > 0);
  return out;
}

function blockedFields(right) {
  return { reason: right.reason, copy: right.copy, hint: right.hint, source: right.source };
}

/**
 * Roll a blocked list up by reason, so a bulk bar can say "3 × Linked to an
 * invoice…" instead of repeating one order's tooltip N times.
 *
 * Sorted count-desc then reason-asc — a total order, so the output is stable
 * enough to assert in a test and stable enough that the tooltip doesn't reshuffle
 * between renders.
 *
 * @returns {Array<{reason: string, copy: string, hint: string, count: number, ids: string[]}>}
 */
export function blockedSummary(blockedList) {
  const byReason = new Map();
  for (const b of blockedList || []) {
    const reason = b?.reason || BLOCK_REASON.UNSPECIFIED;
    if (!byReason.has(reason)) {
      byReason.set(reason, { reason, copy: b?.copy || blockedReasonCopy(reason), hint: b?.hint || blockedReasonHint(reason), count: 0, ids: [] });
    }
    const entry = byReason.get(reason);
    entry.count++;
    if (b?.id) entry.ids.push(b.id);
  }
  return [...byReason.values()].sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));
}

// ── The purge response ──────────────────────────────────────────────────────

/**
 * `POST /api/admin/orders/purge` returns **200 even on partial failure**:
 *   { ok: true, data: { deleted: [...ids], failed: [{id, code, message}] } }
 *
 * Normalise that against what we actually asked for.
 *
 * The rule that matters: **an id the server did not mention is NOT a success.**
 * It goes to `unaccounted` and is reported to the admin as an unknown outcome.
 * Counting it as deleted is `Unknown ≠ 0` applied to an irreversible operation —
 * it would tell the owner an order is gone when it may still be there, which is
 * the one lie this whole surface exists to avoid.
 *
 * `deleted` as a NUMBER is handled because the contract document that would have
 * settled array-vs-count (`docs/admin/order-hard-purge-backend-response-jul2026.md`)
 * was never delivered. The count is only trusted when the arithmetic reconciles
 * exactly; otherwise the remainder is unaccounted rather than guessed at.
 *
 * @param {string[]} requestedIds
 * @param {object|null} payload  the `data` object from the envelope
 * @returns {{deleted: string[], failed: Array<{id: string, code: (string|null), message: string}>,
 *            unaccounted: string[], unexpected: string[]}}
 */
export function normalisePurgeResult(requestedIds, payload) {
  const requested = [...new Set((requestedIds || []).map(String))];
  const out = { deleted: [], failed: [], unaccounted: [], unexpected: [] };

  if (!payload || typeof payload !== 'object') {
    // No body we can read. Every id's outcome is unknown — never deleted.
    out.unaccounted = requested;
    return out;
  }

  const requestedSet = new Set(requested);
  const failedIds = new Set();

  for (const f of Array.isArray(payload.failed) ? payload.failed : []) {
    if (!f || f.id == null) continue;
    const id = String(f.id);
    // `code` is never invented. A refusal we can't classify must stay unclassified.
    out.failed.push({ id, code: f.code != null ? String(f.code) : null, message: typeof f.message === 'string' ? f.message : '' });
    failedIds.add(id);
    if (!requestedSet.has(id)) out.unexpected.push(id);
  }

  const raw = payload.deleted;
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if (d == null) continue;
      const id = String(d);
      if (!requestedSet.has(id)) { out.unexpected.push(id); continue; }
      // In BOTH lists → fail closed. "Refused" is the claim we can act on.
      if (failedIds.has(id)) continue;
      if (!out.deleted.includes(id)) out.deleted.push(id);
    }
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    const remainder = requested.filter((id) => !failedIds.has(id));
    if (raw === remainder.length) out.deleted = remainder;
    // else: the count disagrees with the ids we can account for. We cannot say
    // WHICH ones it refers to, so nothing is inferred — the remainder falls
    // through to `unaccounted` below.
  }

  const accounted = new Set([...out.deleted, ...failedIds]);
  out.unaccounted = requested.filter((id) => !accounted.has(id));
  out.unexpected = [...new Set(out.unexpected)];
  return out;
}

/**
 * Copy for a refusal code, from either door.
 *
 * We render the server's prose but we BRANCH ONLY ON THE CODE. Prose-matching is
 * banned (ERR-077): the moment the backend rewords a message, a branch keyed on
 * its text goes quietly wrong. An unknown code surfaces the code AND the message
 * so it is reportable without being guessed at.
 */
export const DELETE_FAILURE_COPY = Object.freeze({
  ORDER_HAS_INVOICE_LINK: INVOICE_LINK_COPY,
  ORDER_NOT_CANCELLED: NOT_CANCELLED_COPY,
  ORDER_NOT_FOUND: 'Already gone — nothing to delete.',
  FORBIDDEN: 'Your account is not allowed to purge orders.',
  UNAUTHORIZED: 'Your admin session has expired. Sign in again.',
  RATE_LIMITED: 'Too many requests — wait a moment and try the rest again.',
});

/** The one sentence for "we asked, and the server never said what happened". */
export const UNACCOUNTED_COPY =
  'The server did not say whether this order was deleted. Reload the list before assuming either way.';

export function purgeFailureCopy(code, serverMessage) {
  const known = code ? DELETE_FAILURE_COPY[code] : null;
  if (known) return known;
  const msg = typeof serverMessage === 'string' ? serverMessage.trim() : '';
  if (code && msg) return `${code} — ${msg}`;
  if (code) return `Refused by the server (code ${code}).`;
  if (msg) return msg;
  return 'Refused by the server, with no reason given.';
}

// ── Confirm-dialog copy ─────────────────────────────────────────────────────

const PURGE_WARNINGS = Object.freeze([
  'This is a hard purge. It is permanent and cannot be undone.',
  'The order and everything attached to it — line items, invoice links, loyalty ledger entries, tracking and refunds — are removed.',
  'A snapshot of each order is written to the admin audit log before it is removed.',
  'The invoice-link check shown here is only a hint. The server re-checks it and may still refuse.',
]);

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * The confirm dialog's words, as plain sentences.
 *
 * They live here, not in a template, so the honesty of the purge warning is
 * unit-testable — a test asserts the purge plan says "cannot be undone" and
 * names the audit log, which means nobody can soften it in passing.
 *
 * A MIXED plan states BOTH counts and labels the button `Purge N · Delete M`.
 * Mixed is not hypothetical: a selection survives pagination, so legacy-resolved
 * rows (`delete`) and fresh contract rows (`purge`) coexist during any rollout —
 * and a single "Delete 12" that quietly hard-purges 9 of them is the UX version
 * of the bug this whole change exists to fix.
 */
export function deletePlanCopy(groups) {
  const purgeN = groups?.purge?.length || 0;
  const deleteN = groups?.delete?.length || 0;
  const mixed = purgeN > 0 && deleteN > 0;

  const lines = [];
  const warnings = [];

  if (purgeN > 0) {
    lines.push(`${purgeN} ${plural(purgeN, 'order', 'orders')} will be PURGED.`);
    warnings.push(...PURGE_WARNINGS);
  }
  if (deleteN > 0) {
    lines.push(`${deleteN} cancelled ${plural(deleteN, 'order', 'orders')} will be deleted.`);
    warnings.push(`Deleting a cancelled ${plural(deleteN, 'order is', 'orders is')} permanent and cannot be undone.`);
  }

  const skips = blockedSummary(groups?.blocked || []).map(
    (s) => `${s.count} skipped — ${s.copy}${s.hint ? ` ${s.hint}` : ''}`,
  );

  let title;
  let confirmLabel;
  if (mixed) {
    title = 'Delete orders';
    confirmLabel = `Purge ${purgeN} · Delete ${deleteN}`;
  } else if (purgeN > 0) {
    title = plural(purgeN, 'Purge order', 'Purge orders');
    confirmLabel = `Purge ${purgeN}`;
  } else {
    title = plural(deleteN, 'Delete order', 'Delete orders');
    confirmLabel = `Delete ${deleteN}`;
  }

  return { title, confirmLabel, lines, warnings, skips };
}

/**
 * The bulk bar's action label. The METHOD must be visible before the click —
 * a button that just says "Delete" and fires an irreversible hard purge is
 * exactly the confusion this module exists to remove.
 */
export function deleteActionLabel(groups) {
  const purgeN = groups?.purge?.length || 0;
  const deleteN = groups?.delete?.length || 0;
  if (purgeN > 0 && deleteN > 0) return `Purge ${purgeN} · Delete ${deleteN}`;
  if (purgeN > 0) return `Purge ${purgeN}`;
  if (deleteN > 0) return `Delete ${deleteN}`;
  return 'Delete';
}

/** 'Purge' / 'Delete' for a single order's button. */
export function methodVerb(method) {
  return method === DELETE_METHOD.PURGE ? 'Purge' : 'Delete';
}
