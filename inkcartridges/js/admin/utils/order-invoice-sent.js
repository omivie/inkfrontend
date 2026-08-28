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

import { mergeSends } from './send-history.js';

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

/** Every invoice-send record in an event list, newest first. */
export function allSendEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .filter(ev => isInvoiceSendEvent(ev) && ev?.created_at)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * Resolve one order's send state, and the full list of sends behind it.
 *
 * Server record beats our own — the same "SERVER FIELD WINS" rule sentInfo()
 * follows on the Invoices page, so the two surfaces answer the same question the
 * same way. And "we found nothing" never outranks "we could not look": a hit is
 * reportable even when the other source failed, but an ABSENCE is only
 * reportable when every source actually answered.
 *
 * `count` IS A FLOOR, NEVER A TOTAL. The invoice emailed automatically at
 * checkout is recorded nowhere (`emailed_at` is NULL on every row — BF-046), so
 * the only sends we can see are the ones this admin fired. Every surface that
 * shows the number must say "recorded sends", never "sent N times".
 */
export function resolveSentInfo({
  invoice, events, event, invoiceFailed = false, eventFailed = false, truncated = false,
} = {}) {
  const invoiceNumber = invoice?.invoice_number || null;

  // `event` (singular) is still accepted so a caller holding one record — the
  // resend path, which has just written exactly one — needs no list of its own.
  const list = Array.isArray(events) ? allSendEvents(events) : (event ? [event] : []);

  const serverAt = invoice?.emailed_at || null;
  // The server stamp goes in FIRST so it wins attribution against an event at
  // the same instant — mergeSends keeps whichever is already in the list, and
  // collapses anything within SAME_SEND_MS of it. Both constants live in
  // utils/send-history.js so the Invoicing page cannot drift from this one.
  const sends = mergeSends([
    ...(serverAt ? [{ at: serverAt, source: 'server' }] : []),
    ...list.map(ev => ({ at: ev.created_at, source: 'admin' })),
  ]);

  if (sends.length) {
    return {
      state: SENT_STATE.SENT,
      at: sends[0].at,
      source: sends[0].source,
      invoiceNumber, sends, count: sends.length, truncated,
    };
  }

  // Nothing found — but "nothing found" only means something if we managed to look.
  const none = { at: null, source: null, invoiceNumber, sends: [], count: 0, truncated };
  if (invoiceFailed || eventFailed) return { state: SENT_STATE.FAILED, ...none };
  if (!invoice) return { state: SENT_STATE.NO_INVOICE, ...none };
  return { state: SENT_STATE.NOT_RECORDED, ...none };
}
