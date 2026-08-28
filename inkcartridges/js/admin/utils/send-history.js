/**
 * "How many times has this document been emailed?" — one vocabulary
 * =================================================================
 *
 * TWO admin pages answer this question about TWO DIFFERENT TABLES:
 *
 *   Orders     -> public.invoices.emailed_at + our own order_events records
 *                 (utils/order-invoice-sent.js, which owns that table's rules)
 *   Invoicing  -> admin_invoices.emailed_at/email_count + the backend's
 *                 per-send log at GET /api/admin/invoices/:id/emails
 *                 (pages/invoices.js)
 *
 * Those two tables must never be conflated — order-invoice-sent.js opens with
 * that warning and it still stands. What they DO share is the arithmetic and
 * the wording for a send count, and that is all this module holds. Two copies
 * of a vocabulary drift, and then two pages on one admin disagree about the
 * same fact (ERR-120, ERR-129, ERR-143 — the repo has shipped that bug often
 * enough to stop writing the second copy).
 *
 * THE ONE RULE THIS MODULE EXISTS TO CARRY: a send count is a FLOOR, never a
 * total. Neither page can see every send that ever happened — the invoice
 * emailed automatically at checkout is stamped nowhere on Orders (BF-046), and
 * on Invoicing every send before July 2026 predates the log table and comes
 * back as `email_count: 0` next to a perfectly real `emailed_at`. So the copy
 * says "3 recorded sends", NEVER "sent 3 times", and where we know there are
 * sends we cannot enumerate it says so out loud.
 */

/**
 * Two timestamps close enough to be one send.
 *
 * Both pages record a send themselves AND read a server stamp for the same
 * send: Orders will get one from the backend the moment BF-047 lands, and
 * Invoicing gets one back from the very next list refetch. Without this window
 * the single send lists twice.
 *
 * It is deliberately NOT used to compute the count on the Invoicing page —
 * client and server clocks can differ by more than this, and a count that
 * double-reports under clock skew is worse than one derived from a counter.
 * See sentInfo() there: the window de-duplicates what is DISPLAYED; the count
 * comes from a monotonic tally.
 */
export const SAME_SEND_MS = 2000;

/**
 * Fold several sources' send records into one list, newest first.
 *
 * `entries` is `[{ at, source, ... }]` with the MOST AUTHORITATIVE first — an
 * entry is kept only if nothing already kept sits within SAME_SEND_MS of it,
 * so the server's account of a send wins attribution over our own record of
 * the same one. Extra keys on an entry are carried through untouched.
 *
 * An entry with a missing or unparseable `at` is dropped rather than kept: a
 * send whose time cannot be read renders as "Invalid Date" and sorts at random,
 * which is worse than not listing it. Callers that need to know something was
 * dropped should count what they passed in.
 */
export function mergeSends(entries) {
    const out = [];
    for (const e of (Array.isArray(entries) ? entries : [])) {
        const t = e?.at == null || e.at === '' ? NaN : new Date(e.at).getTime();
        if (Number.isNaN(t)) continue;
        if (out.some(s => Math.abs(new Date(s.at).getTime() - t) < SAME_SEND_MS)) continue;
        out.push(e);
    }
    out.sort((a, b) => new Date(b.at) - new Date(a.at));
    return out;
}

/**
 * "3 recorded sends" / "1 recorded send" — the only phrasing either page uses.
 *
 * `floor: true` means we KNOW of sends we cannot enumerate, so the number is a
 * lower bound and says so. `compact` is the same claim in the width of a button
 * ("3 recorded sends+"), for surfaces that have no room for a sentence.
 *
 * pages/orders.js still spells this inline; its own test greps the literal, and
 * this module is the definition both must agree with — the drift is pinned by
 * tests/admin-invoice-send-count-aug2026.test.js.
 */
export function recordedSendsPhrase(n, { floor = false, compact = false } = {}) {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const more = floor ? (compact ? '+' : ' or more') : '';
    return `${count} recorded send${count === 1 ? '' : 's'}${more}`;
}
