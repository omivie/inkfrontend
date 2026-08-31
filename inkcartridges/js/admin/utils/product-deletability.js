/**
 * Product deletability — the single vocabulary for "may this product be deleted,
 * what actually happened when we tried, and if it was refused, why".
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * From 2026-08-14 to 2026-08-31 the admin shipped a bulk Delete button against a
 * route that did not exist (ERR-166). That was known. What was NOT known is that
 * the button reported success anyway:
 *
 *   - `API.request()` RETURNS `{ok:false, …}` for 404/409/403 rather than throwing.
 *   - `AdminAPI.deleteProduct` was the one product write helper with no
 *     `resp.ok === false` check, so it RESOLVED with that envelope.
 *   - `bulkDelete()` counted `Promise.allSettled` `fulfilled` as a deletion.
 *
 * So every call failed, every promise settled, and the toast said "N products
 * deleted". Now that the endpoint is real, the same path would have reported a
 * product refused for having order history as successfully deleted — i.e. it would
 * have told the operator a customer's receipt line had been destroyed when it had
 * not, and vice versa. Counting settled promises is not counting deletions.
 *
 * ── What this module is ─────────────────────────────────────────────────────
 *
 * Pure. No DOM, no globals, no `Security`, no `DebugLog`, no imports. It returns
 * PLAIN TEXT and plain data; the calling page escapes and renders. That is why it
 * unit-tests directly under `node --test` — the branch that decides whether an
 * irreversible delete fires is exercised for real, not grepped for. Same shape and
 * same reasoning as `order-deletability.js`, which exists because this exact class
 * of bug already shipped once for orders (ERR-120 → ERR-130).
 *
 * ── The house rule it enforces ──────────────────────────────────────────────
 *
 * An outcome we cannot prove is NEVER reported as a success. `deleted_count` is
 * believed only when the per-row arithmetic reconciles; an id the server mentions
 * in neither list is `unaccounted`, which is its own bucket and never folded into
 * either side. After an irreversible delete, "we don't know" is the only honest
 * word for "we don't know" — folding it into success is the ERR-074 shape and
 * folding it into failure invites a second delete of something already gone.
 *
 * ── The wire contract (measured live 2026-08-31, not assumed) ───────────────
 *
 *   POST /api/admin/products/bulk-delete   {product_ids:[…], dry_run:bool}
 *     → {dry_run, requested, deleted_count, failed_count,
 *        deleted:[{id, sku}], failed:[{id, sku, code, reason}]}
 *   DELETE /api/admin/products/:id  → {deleted:true, id, sku}
 *
 * Note `failed[].reason` — NOT `message`, which is what the order endpoint uses.
 * Reading the wrong key yields empty prose for every refusal and the operator is
 * told a row failed with no reason given.
 *
 * Constraints: at least 1 id, at most 500 per call.
 */

'use strict';

/** Backend refusal codes we understand. Anything else is echoed, never guessed. */
export const PRODUCT_HAS_ORDER_HISTORY = 'PRODUCT_HAS_ORDER_HISTORY';
export const PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND';
export const PRODUCT_REFERENCED = 'PRODUCT_REFERENCED';

/** The server's own cap. Sending more is a 400, so the caller chunks. */
export const MAX_IDS_PER_CALL = 500;

/**
 * Chunk size for one bulk call. Deliberately well under MAX_IDS_PER_CALL: the
 * catalogue rate-limiter is shared with the storefront, and a 500-id delete that
 * trips it fails halfway through an irreversible operation. Orders chose 25
 * against the same limiter; 100 is the compromise for a table whose "select all"
 * is a realistic gesture.
 */
export const CHUNK_SIZE = 100;

/**
 * Copy for a refusal code.
 *
 * We render the server's prose but we BRANCH ONLY ON THE CODE. Prose-matching is
 * banned (ERR-077): the moment the backend rewords a message, a branch keyed on
 * its text goes quietly wrong.
 */
export const PRODUCT_DELETE_FAILURE_COPY = Object.freeze({
  [PRODUCT_HAS_ORDER_HISTORY]:
    'It appears on a customer order. Deleting it would tear a line out of a receipt '
    + 'that has already been sent, so the server refuses. Deactivate it instead — it '
    + 'disappears from the shop and the order history stays intact.',
  [PRODUCT_REFERENCED]:
    'Another record still points at this product.',
  // NOT a failure to act on: the row is already gone, which is the state the
  // operator asked for. Reporting it as an error makes a double-click look like a
  // problem and invites a retry of something that already succeeded.
  [PRODUCT_NOT_FOUND]:
    'Already gone — nothing to delete.',
  FORBIDDEN:
    'Your account is not allowed to delete products. This needs an owner account.',
  UNAUTHORIZED:
    'Your session has expired. Sign in again and retry.',
});

/**
 * True when the refusal is one the operator can act on with a single alternative.
 *
 * Exactly one code qualifies. Keeping this a function rather than an inline
 * comparison means the "Deactivate instead" affordance is decided in ONE place —
 * a second copy is how `costPlaceholder` silently disagreed with itself (ERR-182).
 */
export function offersDeactivate(code) {
  return String(code || '') === PRODUCT_HAS_ORDER_HISTORY;
}

/**
 * True when this "failure" actually means the desired end state already holds.
 * Used so a results summary does not shout about rows that are gone.
 */
export function isAlreadyGone(code) {
  return String(code || '') === PRODUCT_NOT_FOUND;
}

/**
 * Human sentence for one refusal.
 *
 * An unknown code surfaces the code AND the server's own prose, so it is
 * reportable without being guessed at. A bland "delete failed" would present an
 * unknown as a known, which is the thing this file exists to prevent.
 */
export function productDeleteFailureCopy(code, reason) {
  const key = String(code || '');
  const known = PRODUCT_DELETE_FAILURE_COPY[key];
  if (known) return known;
  const prose = typeof reason === 'string' ? reason.trim() : '';
  if (key && prose) return `${prose} (server code: ${key})`;
  if (key) return `Refused for a reason this admin build doesn't know: ${key}`;
  if (prose) return prose;
  return 'Refused, and the server gave no reason we can read.';
}

/**
 * Can this admin delete products at all?
 *
 * The endpoints are super_admin-only. `AdminAccess.ROLE_MAP` already normalises the
 * backend's `super_admin` to this build's `owner`, so there is exactly one
 * vocabulary and no new spelling is introduced here.
 *
 * Fails CLOSED: an unknown or absent role is not an owner.
 */
export function canDeleteProducts(role) {
  return String(role || '') === 'owner';
}

/** Why the delete affordance is unavailable, in the operator's words. */
export function deleteBlockedReason(role) {
  if (canDeleteProducts(role)) return null;
  return 'Deleting products needs an owner account.';
}

/**
 * Turn one bulk-delete response into four disjoint buckets.
 *
 * @param {string[]} requestedIds  what we asked to delete
 * @param {object} payload         the response `data`
 * @returns {{deleted: Array, failed: Array, unaccounted: string[], unexpected: string[]}}
 *
 * Rules, each of which exists because its absence is a way to lie:
 *   - An id in BOTH lists counts as FAILED. "Refused" is the claim we can act on.
 *   - `deleted_count` is trusted only when it reconciles with the ids we can
 *     actually name. A bare number that disagrees names nobody, so it infers
 *     nothing and the remainder falls through to `unaccounted`.
 *   - An id the server mentions in neither list is `unaccounted` — never deleted.
 *   - An unreadable body makes EVERY id unaccounted, not every id deleted.
 */
export function normaliseBulkDeleteResult(requestedIds, payload) {
  const requested = [...new Set((requestedIds || []).map(String))];
  const out = { deleted: [], failed: [], unaccounted: [], unexpected: [] };

  if (!payload || typeof payload !== 'object') {
    out.unaccounted = requested;
    return out;
  }

  const requestedSet = new Set(requested);
  const failedIds = new Set();

  for (const f of Array.isArray(payload.failed) ? payload.failed : []) {
    if (!f || f.id == null) continue;
    const id = String(f.id);
    out.failed.push({
      id,
      sku: f.sku != null ? String(f.sku) : null,
      // `code` is never invented. A refusal we can't classify stays unclassified.
      code: f.code != null ? String(f.code) : null,
      reason: typeof f.reason === 'string' ? f.reason : '',
    });
    failedIds.add(id);
    if (!requestedSet.has(id)) out.unexpected.push(id);
  }

  const deletedIds = new Set();
  const raw = payload.deleted;
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if (d == null) continue;
      // The products endpoint returns objects; tolerate a bare id too rather than
      // silently reading `undefined` if that ever changes.
      const id = String(typeof d === 'object' ? d.id : d);
      const sku = (typeof d === 'object' && d.sku != null) ? String(d.sku) : null;
      if (!requestedSet.has(id)) { out.unexpected.push(id); continue; }
      if (failedIds.has(id)) continue;      // in both lists → fail closed
      if (deletedIds.has(id)) continue;
      deletedIds.add(id);
      out.deleted.push({ id, sku });
    }
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    const remainder = requested.filter((id) => !failedIds.has(id));
    if (raw === remainder.length) {
      for (const id of remainder) { deletedIds.add(id); out.deleted.push({ id, sku: null }); }
    }
    // else: the count names nobody. Infer nothing; the remainder is unaccounted.
  }

  const accounted = new Set([...deletedIds, ...failedIds]);
  out.unaccounted = requested.filter((id) => !accounted.has(id));
  out.unexpected = [...new Set(out.unexpected)];
  return out;
}

/**
 * One sentence summarising an outcome, for a toast.
 *
 * Never says "deleted" about anything not in `deleted`. When nothing was deleted
 * it says so first, because that is the operator's actual situation.
 */
export function summariseDeleteOutcome(result) {
  const d = result?.deleted?.length || 0;
  const f = result?.failed?.length || 0;
  const u = result?.unaccounted?.length || 0;
  const parts = [];
  parts.push(d === 1 ? '1 product deleted' : `${d} products deleted`);
  if (f) parts.push(`${f} refused`);
  if (u) parts.push(`${u} of unknown outcome`);
  return parts.join(' · ');
}

/** True when nothing at all was destroyed — lets the caller skip cache busting. */
export function nothingWasDeleted(result) {
  return !(result?.deleted?.length);
}
