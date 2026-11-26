/**
 * Bulk "Set supplier" — the pure half (ERR-399, backend fe97a98, 2026-11-26).
 *
 *   POST /api/admin/products/bulk-supplier
 *     { product_ids: [uuid…], supplier: "ribbon", dry_run: true|false }
 *
 * The endpoint PREVIEWS unless told `dry_run: false`, so the page always sends
 * `dry_run` explicitly (api.js) and applies with the SAME ids it previewed.
 *
 * ── The wire contract, measured live 2026-11-26 (not assumed) ───────────────
 *   preview → {dry_run:true, would_change:<n>, supplier, requested:<n>,
 *              not_found:<n>, unchanged:<n>, refused_genuine:[sku…],
 *              products:[{id, sku, name, product_type, from, to}]}
 *   `unchanged` and `not_found` are COUNTS (no ids). `refused_genuine` is SKUs:
 *   genuine products are always DSNZ and the server never moves them.
 *   Applied replies say `changed` instead of `would_change` (handoff); both a
 *   number and an array are accepted so a shape change cannot zero a count.
 *   400 VALIDATION_FAILED for an empty list or a key outside /^[a-z0-9_]+$/.
 *   1..500 ids per call. super_admin + stock_manager only.
 *
 * Pure: no DOM, no globals — unit-tested under `node --test`. Returns plain
 * data; the page escapes and renders. Same reasoning as product-deletability.js.
 *
 * ── The house rule ──────────────────────────────────────────────────────────
 * Nothing is skipped silently. Every requested id must land in exactly one
 * bucket — changes, unchanged, not found, refused genuine. When the server's
 * counts do not add up to what was asked, the gap is `unaccounted` and the UI
 * says so; it is never folded into "unchanged".
 */

/** The server's cap per request. */
export const MAX_IDS_PER_CALL = 500;

/** The backend's confirm-step warning, verbatim from the handoff. */
export const SUPPLIER_CHANGE_WARNING = "Changing a product's supplier puts it under that supplier's import. "
  + "If that supplier's feed doesn't list it, the next import can deactivate it.";

/**
 * Who may call it. The server allows super_admin + stock_manager; the admin UI
 * only recognises 'owner' (super_admin) and 'admin' (AdminAccess.ROLE_MAP), and a
 * stock_manager cannot sign in to it at all — so in this UI it is owner-only.
 */
export function canSetSupplier(role) {
  return String(role || '') === 'owner';
}

export function setSupplierBlockedReason(role) {
  return canSetSupplier(role) ? null : 'Changing suppliers needs an owner account.';
}

/** A field that may arrive as a count or as a list: its size, or null if absent/garbage. */
function sizeOf(v) {
  if (Array.isArray(v)) return v.length;
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Merge one or more chunk replies into one plan/result.
 *
 * @param {string[]} requestedIds  every id asked about (all chunks)
 * @param {object[]} payloads      each chunk's response `data`
 * @returns {{dryRun: boolean|null, supplier: string|null, requested: number,
 *   changes: Array<{id,sku,name,product_type,from,to}>, changeCount: number,
 *   unchangedCount: number, notFoundCount: number, refusedGenuine: string[],
 *   unaccounted: number, countMismatch: boolean}}
 *
 *   dryRun  true / false only when EVERY chunk said so; otherwise null (unknown —
 *           the UI must never report an unconfirmed reply as "applied").
 *   changeCount  the server's count; `countMismatch` when it disagrees with the
 *           rows it listed in `products[]`.
 */
export function normaliseBulkSupplierResult(requestedIds, payloads) {
  const list = Array.isArray(payloads) ? payloads : [payloads];
  const requested = new Set((requestedIds || []).map(String)).size;
  const changes = [];
  const refusedGenuine = [];
  let changeCount = 0;
  let unchangedCount = 0;
  let notFoundCount = 0;
  let countMismatch = false;
  const flags = new Set();
  let supplier = null;

  for (const raw of list) {
    const d = raw && typeof raw === 'object' ? raw : {};
    flags.add(d.dry_run === true ? 'true' : d.dry_run === false ? 'false' : 'unknown');
    if (typeof d.supplier === 'string' && !supplier) supplier = d.supplier;
    const rows = Array.isArray(d.products) ? d.products.filter((r) => r && typeof r === 'object') : [];
    changes.push(...rows.map((r) => ({
      id: r.id == null ? null : String(r.id),
      sku: r.sku == null ? null : String(r.sku),
      name: r.name == null ? null : String(r.name),
      product_type: r.product_type == null ? null : String(r.product_type),
      from: r.from == null ? null : String(r.from),
      to: r.to == null ? null : String(r.to),
    })));
    // `would_change` on a preview, `changed` once applied. Neither present ⇒
    // fall back to the listed rows rather than claim zero.
    const counted = sizeOf(d.would_change ?? d.changed);
    if (counted != null && counted !== rows.length) countMismatch = true;
    changeCount += counted ?? rows.length;
    unchangedCount += sizeOf(d.unchanged) ?? 0;
    notFoundCount += sizeOf(d.not_found) ?? 0;
    if (Array.isArray(d.refused_genuine)) refusedGenuine.push(...d.refused_genuine.map(String));
  }

  const accounted = changeCount + unchangedCount + notFoundCount + refusedGenuine.length;
  return {
    dryRun: flags.size === 1 && !flags.has('unknown') ? flags.has('true') : null,
    supplier,
    requested,
    changes,
    changeCount,
    unchangedCount,
    notFoundCount,
    refusedGenuine,
    unaccounted: Math.max(0, requested - accounted),
    countMismatch,
  };
}

/** Split ids into server-sized chunks, de-duplicated, order kept. */
export function chunkIds(ids, size = MAX_IDS_PER_CALL) {
  const unique = [...new Set((ids || []).filter((v) => v != null && v !== '').map(String))];
  const out = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}
