/**
 * "When did this order's invoice last go out?" — one vocabulary
 * =============================================================
 *
 * Three surfaces ask this question (the Orders table column, the order detail
 * modal's Dates block, and the Timeline) and one writer answers it. They share
 * this module for the same reason the bulk bar and the single-order delete
 * button share utils/order-deletability.js: separate copies of a vocabulary
 * drift, and then two places on one screen disagree about one order (ERR-120).
 *
 * WHAT WE CAN ACTUALLY KNOW
 * -------------------------
 *   public.invoices.emailed_at   the server's own record. Wins whenever present.
 *                                As of 2026-08-28 it is NULL on all 126 rows —
 *                                the column exists but nothing writes it, the
 *                                automatic checkout email included. That is
 *                                BF-046 (readfirst/order-invoice-emailed-at-
 *                                backend-brief-aug2026.md). The day it lands,
 *                                every surface fills in with no change here.
 *   order_events                 the resends fired from the admin Orders page.
 *                                The only sends we can observe ourselves.
 *
 * WHAT WE REFUSE TO INFER
 * -----------------------
 * `invoice_date`, `created_at` and `paid_at` all sit within seconds of purchase,
 * so any of them would make a plausible-looking "sent" date. None of them is
 * evidence that an email left the building. This module never reads them. An
 * order with nothing on record resolves to NOT_RECORDED, and NOT_RECORDED is a
 * different answer from FAILED — "we looked and found nothing" is not
 * "we could not look". Collapsing those two is the absence-as-zero family this
 * repo has now shipped seven times (ERR-063/068/073/075/076/149/150).
 */

export const SENT_STATE = Object.freeze({
  PENDING: 'pending',              // we have not asked yet
  SENT: 'sent',                    // a send is on record
  NOT_RECORDED: 'not_recorded',    // both sources answered; neither had anything
  NO_INVOICE: 'no_invoice',        // there is no invoice row that could be emailed
  FAILED: 'failed',                // a source failed — absence NOT established
});

/**
 * The backend's order-events endpoint validates `type` against exactly [note]
 * (probed 2026-08-28: POST type "invoice_sent" → 400 `"type" must be [note]`),
 * so an invoice send cannot have an event type of its own. It is written as a
 * note carrying a sentinel.
 *
 * The sentinel lives in the note TEXT because `note` is the one payload field
 * every existing row uses, and therefore the only one proven to survive the
 * write. `kind` is written too and read first, so if the backend later preserves
 * it — or grows a real event type — no reader needs to change.
 *
 * Changing either constant orphans every send already recorded: the reader would
 * silently stop finding them and every order would fall back to "Not recorded".
 */
export const INVOICE_SENT_KIND = 'invoice_sent';
export const INVOICE_SENT_MARK = '[invoice-sent]';

/** True when an order_events row is one of our invoice-send records. */
export function isInvoiceSendEvent(ev) {
  if (!ev) return false;
  const p = ev.payload || {};
  if (p.kind === INVOICE_SENT_KIND) return true;
  return typeof p.note === 'string' && p.note.startsWith(INVOICE_SENT_MARK);
}

/** The human-facing text of a send note, with the machine sentinel stripped. */
export function invoiceSendNoteText(ev) {
  const note = String(ev?.payload?.note || '');
  return note.startsWith(INVOICE_SENT_MARK) ? note.slice(INVOICE_SENT_MARK.length).trim() : note;
}

/** The most recent invoice-send record in an order's event list, if any. */
export function newestSendEvent(events) {
  if (!Array.isArray(events)) return null;
  let newest = null;
  for (const ev of events) {
    if (!isInvoiceSendEvent(ev) || !ev?.created_at) continue;
    if (!newest || new Date(ev.created_at) > new Date(newest.created_at)) newest = ev;
  }
  return newest;
}

/**
 * Resolve one order's send state.
 *
 * Server record beats our own — the same "SERVER FIELD WINS" rule sentInfo()
 * follows on the Invoices page, so the two surfaces answer the same question the
 * same way. And "we found nothing" never outranks "we could not look": a hit is
 * reportable even when the other source failed, but an ABSENCE is only
 * reportable when every source actually answered.
 */
export function resolveSentInfo({ invoice, event, invoiceFailed = false, eventFailed = false } = {}) {
  const invoiceNumber = invoice?.invoice_number || null;

  const serverAt = invoice?.emailed_at || null;
  if (serverAt) return { state: SENT_STATE.SENT, at: serverAt, source: 'server', invoiceNumber };

  if (event?.created_at) {
    return { state: SENT_STATE.SENT, at: event.created_at, source: 'admin', invoiceNumber };
  }

  // Nothing found — but "nothing found" only means something if we managed to look.
  if (invoiceFailed || eventFailed) {
    return { state: SENT_STATE.FAILED, at: null, source: null, invoiceNumber };
  }
  if (!invoice) return { state: SENT_STATE.NO_INVOICE, at: null, source: null, invoiceNumber };
  return { state: SENT_STATE.NOT_RECORDED, at: null, source: null, invoiceNumber };
}
