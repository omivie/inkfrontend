/**
 * GST-basis vocabulary — the ONE place the admin's "incl. GST" / "excl. GST"
 * sub-lines are spelled.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * NZ GST is 15%, and this admin shows money on both sides of it — often in
 * adjacent columns. On the Products list, `retail_price` is GST-INCLUSIVE and
 * `cost_price` is GST-EXCLUSIVE; they sit two columns apart with nothing to say
 * so. Same story on Orders (Total incl. / line Price excl.), Invoices, Expenses
 * and the Dashboard KPIs.
 *
 * So every money header now carries a small muted second line naming its basis.
 * Before this module there were FOUR spellings of that line already in the tree
 * — `(excl. GST)`, `(incl GST)`, `(ex GST)`, `(ex-GST)`/`Ex-GST` — because each
 * page invented its own. Twenty-odd files have to agree; one exported constant
 * per basis is the only thing that keeps them agreeing.
 * `tests/admin-gst-basis-labels.test.js` fails the build if a fifth spelling
 * appears.
 *
 * ── The load-bearing rule: ABSENCE MEANS "NOT DOCUMENTED" ───────────────────
 *
 * A column with no `gst` property renders NO sub-line, and that is a deliberate
 * signal — it means nobody has proven that field's basis, not that GST doesn't
 * apply. ~25 admin money fields are pure backend passthrough with zero GST
 * arithmetic anywhere in the frontend (all of Price Monitor, `total_spent` on
 * Customers, the Finance top KPI strip, the Dashboard's margin-by-brand
 * charts…). Two of them are worse than unknown: `pnl.revenue` is asserted
 * ex-GST by `utils/expense-math.js` and proven incl-GST by
 * `pages/financial-health.js`, and Stripe fees carry three mutually
 * incompatible conventions (ERR-114).
 *
 * Those stay blank on purpose. `gst-basis-backend-brief-jul2026.md` (repo root)
 * is the register of every blank and the ask that would let us fill it.
 *
 * DO NOT "helpfully" label one of them from a plausible guess. A wrong basis on
 * an admin money figure is worse than no basis — it is how a wrong GST return
 * gets filed.
 *
 * ── Why profit is `net of GST` and not `excl. GST` ──────────────────────────
 *
 * Order/invoice profit is GST-NEUTRAL: ex-GST on the revenue side AND the cost
 * side, so GST nets to zero rather than being stripped out (see
 * `utils/profitability.js`). Labelling it "excl. GST" would imply a further 15%
 * is still to come off. It isn't.
 */

/** Figure INCLUDES 15% GST (what the customer paid / what left the bank). */
export const GST_INCL = 'incl. GST';

/** Figure EXCLUDES GST (the ex-GST base). */
export const GST_EXCL = 'excl. GST';

/** A percentage whose DENOMINATOR is ex-GST (margin %, markup %). */
export const GST_BASE = 'excl. GST base';

/** GST-NEUTRAL: ex-GST both sides, GST passes through and nets to zero. */
export const GST_NET = 'net of GST';

/**
 * Not pure ex-GST. Claimable rows are netted, non-claimable rows (foreign SaaS
 * with no NZ GST to reclaim) enter at full gross — so the total is a mix.
 */
export const GST_MIXED = 'GST-netted (mixed basis)';

/** Per-row version of the above, where the mix is visible line by line. */
export const GST_CLAIM = 'excl. GST when claimable';

/** The figure IS the GST, not a base it was computed from. */
export const GST_AMOUNT = 'GST amount';

/**
 * Sub-line markup for the hand-written `<th>` / label sites that don't go
 * through `components/table.js` (which renders `col.gst` itself).
 *
 * NOT escaped — and it must never need to be. The only legal arguments are the
 * frozen constants above. Never pass a row value, a backend string, or anything
 * else user-influenced through here.
 *
 * @param {string} basis one of the GST_* constants; falsy renders nothing
 * @returns {string} `<span class="admin-th-sub">…</span>`, or '' when unknown
 */
export function gstSub(basis) {
  return basis ? `<span class="admin-th-sub">${basis}</span>` : '';
}
