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
 * TWO REGIMES, ONE ANSWER (ERR-199)
 * ---------------------------------
 * The Sep-2026 backend handoff (readfirst/orders-invoice-sent-column-FE-handoff-
 * sep2026.md) says `GET /api/admin/orders` now ships `channel`, `invoice_id` and
 * `invoice_sent` per row, and that the column should read `invoice_sent` alone.
 * Measured against live production on 2026-09-01 (backend commit 01c29cba, db
 * connected): ALL THREE ARE ABSENT, on the list and on the detail endpoint, under
 * every opt-in param tried. `?channel=` is worse than absent — it is accepted and
 * ignored, returning the full unfiltered set for `zzznope` (the ERR-151/173 decoy
 * family). So this module answers under whichever regime is actually live:
 *
 *   SERVER   the `invoice_sent` KEY is present on the row. The backend has
 *            already applied the channel rule, so gate on `invoice_sent !== null`
 *            and never look at `channel` again (handoff Rule 1). No lookup of any
 *            kind is needed — the answer is on the payload.
 *
 *   LOCAL    the key is absent (today). The channel question is answered from
 *            `payment_method` instead (utils/order-profit.js `orderChannel`),
 *            measured correct on 146 of 146 live orders, and the send record is
 *            read the way it has been read since ERR-175.
 *
 * THE DETECTION IS `hasOwnProperty`, NEVER TRUTHINESS, and that is the whole bug
 * this guards. An absent field is `undefined`; `undefined !== null` is TRUE, so a
 * literal Rule-1 gate marks every website order "applicable" and prints an
 * outstanding task on all of them. The obvious correction — `invoice_sent == null`
 * — is worse, because it collapses ABSENT into NOT-APPLICABLE and blanks the whole
 * column, which looks exactly like the handoff's intended "after" table while
 * being a dead feature nobody would notice for a month. Absent, null and
 * `{sent_at: null}` are three different claims and stay three different states.
 *
 * WHAT WE CAN ACTUALLY KNOW (LOCAL regime)
 * ----------------------------------------
 *   public.invoices.emailed_at   the server's own record. Wins whenever present.
 *                                As of 2026-09-01 it is NULL on every row — the
 *                                column exists but nothing writes it, the
 *                                automatic checkout email included. That is
 *                                BF-046 (readfirst/order-invoice-emailed-at-
 *                                backend-brief-aug2026.md).
 *   order_events                 the resends fired from the admin Orders page.
 *                                The only sends we can observe ourselves.
 *
 * And one thing we know we CANNOT see: an invoice emailed from the Invoices page
 * lands in `standalone_invoice_emails` / `admin_invoices.emailed_at`, a different
 * table this page has never read. INV-3277 and INV-3276 were both genuinely
 * emailed (1 Sep 12:55 and 31 Aug 17:21 NZT, verified live) and read "Not
 * recorded" here. The join that would close it is `invoice_id`, which the backend
 * owns and has not shipped. Parsing `INV-3277` into invoice number 3277 would
 * work on all 15 live rows and is still refused — handoff Rule 2 forbids deriving
 * identity from the order number, and `public.invoices` and `admin_invoices` are
 * two systems this repo has a standing rule never to conflate. The gap is
 * reported in as many words instead (SENT_TIP, and `npm run probe:orders-invoice-sent`).
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
  NOT_APPLICABLE: 'not_applicable',// the question does not apply to this row at all
  NO_INVOICE: 'no_invoice',        // there is no invoice row that could be emailed
  FAILED: 'failed',                // a source failed — absence NOT established
});

/**
 * Which regime answered. Carried on every result so a renderer can pick its
 * wording from the SAME object it read the state from, rather than consulting a
 * second source that can disagree with the first.
 *
 * It is also the difference between two sentences that must never be confused:
 * under SERVER, "not sent" is an ACTIONABLE outstanding send the backend vouches
 * for; under LOCAL it is "we have no record", which is all we can honestly claim
 * while the checkout email is stamped nowhere.
 */
export const SEND_REGIME = Object.freeze({
  SERVER: 'server',
  LOCAL: 'local',
});

/** The `invoice_sent.source` values the handoff defines. `source` is diagnostic. */
export const SEND_SOURCE = Object.freeze({
  SEND_LOG: 'send_log',
  LEGACY_STAMP: 'legacy_stamp',
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
 * Read the backend's `invoice_sent` field off one order row.
 *
 * THE KEY'S PRESENCE IS THE REGIME SIGNAL, and it is tested with hasOwnProperty
 * rather than by looking at the value, because the value that means "not
 * applicable" (null) and the value that means "this backend has never heard of
 * the field" (undefined) are indistinguishable to `==` and back-to-front to
 * `!==`. See the module header.
 *
 * Returns, always, the same shape:
 *   present     the row carries the key at all — i.e. the SERVER regime is live
 *   malformed   the key is there but its value is not a shape we can read. NOT
 *               "not applicable": we could not read the answer, which resolves to
 *               FAILED ("Can't check"), never to a blank cell.
 *   applicable  the question applies to this row (`invoice_sent !== null`)
 *   at          the send timestamp, or null for "applies, never emailed"
 *   count       a FLOOR. A date with no usable count still proves ONE send.
 *   countKnown  whether `count` is a real logged tally. False for a legacy stamp
 *               or a zero count beside a real date — which is UNKNOWN, not zero
 *               (ERR-180 shipped that exact confusion on the Invoices page).
 *   floor       we know of sends we cannot enumerate, so the wording must say so.
 */
export function readServerInvoiceSent(order) {
  const absent = {
    present: false, malformed: false, applicable: false,
    at: null, count: 0, countKnown: false, floor: false, source: null,
  };
  if (!order || typeof order !== 'object') return absent;
  if (!Object.prototype.hasOwnProperty.call(order, 'invoice_sent')) return absent;

  const field = order.invoice_sent;

  // An explicit null is the backend saying "this question does not apply to this
  // row" — a website checkout or a quick order. `undefined` sitting on a key that
  // EXISTS is the same claim, made sloppily; it is not the absent case, because
  // the key is here.
  if (field === null || field === undefined) {
    return { ...absent, present: true };
  }

  // A string, a number, an array — the field is there and we cannot read it. The
  // one answer we must not give is the blank cell, which would assert "does not
  // apply" from a parse failure.
  if (typeof field !== 'object' || Array.isArray(field)) {
    return { ...absent, present: true, malformed: true, applicable: true };
  }

  const source = typeof field.source === 'string' ? field.source : null;
  const rawAt = field.sent_at;
  const at = (rawAt === null || rawAt === undefined || rawAt === '') ? null : rawAt;

  if (!at) {
    // Applies, and the answer is "not yet". This one IS an actionable outstanding
    // send, and it is a different cell from the em-dash above it.
    return { present: true, malformed: false, applicable: true, at: null, count: 0, countKnown: false, floor: false, source };
  }

  const n = Number(field.sent_count);
  const tallied = Number.isFinite(n) && n > 0;
  // A legacy stamp predates the send log, so its count was never recorded. A zero
  // count beside a real date says the same thing. Either way the number is not a
  // number we may print — but the date still proves at least one send happened.
  const countKnown = tallied && source !== SEND_SOURCE.LEGACY_STAMP;
  return {
    present: true,
    malformed: false,
    applicable: true,
    at,
    count: countKnown ? Math.floor(n) : 1,
    countKnown,
    floor: !countKnown,
    source,
  };
}

/**
 * Which regime a page of order rows is answering under.
 *
 * ANY row carrying the key puts the whole page in SERVER: the handoff says every
 * element of `data[]` gains the three fields, so one row that has it means the
 * deploy has landed. Asking "do ALL rows have it?" would be the wrong question —
 * it would drop the page back to LOCAL over a single malformed row and silently
 * change what every other cell means.
 */
export function orderSendRegime(rows) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const row of list) {
    if (row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, 'invoice_sent')) {
      return SEND_REGIME.SERVER;
    }
  }
  return SEND_REGIME.LOCAL;
}

/**
 * Resolve one order's send state, and the full list of sends behind it.
 *
 * Under SERVER the answer is `serverSent` and nothing else: the backend has
 * already applied the channel rule and already merged its own two sources
 * (standalone_invoice_emails, falling back to standalone_invoices.emailed_at), so
 * re-deriving any part of it here would create a second place to get it wrong —
 * which is the handoff's Rule 1, and the reason the note-scraping is not consulted.
 *
 * Under LOCAL, `applicable === false` is the channel answer from the payload's
 * `payment_method`, and everything below it is unchanged from ERR-175/177.
 * Server record beats our own — the same "SERVER FIELD WINS" rule sentInfo()
 * follows on the Invoices page, so the two surfaces answer the same question the
 * same way. And "we found nothing" never outranks "we could not look": a hit is
 * reportable even when the other source failed, but an ABSENCE is only
 * reportable when every source actually answered.
 *
 * `count` IS A FLOOR, NEVER A TOTAL, under both regimes. Every surface that shows
 * the number must say "recorded sends", never "sent N times".
 */
export function resolveSentInfo({
  invoice, events, event, invoiceFailed = false, eventFailed = false, truncated = false,
  serverSent = null, applicable = null,
} = {}) {
  const invoiceNumber = invoice?.invoice_number || null;

  // ── SERVER regime ────────────────────────────────────────────────────────
  if (serverSent && serverSent.present) {
    // TWO FIELDS, BECAUSE THERE ARE TWO QUESTIONS, and folding both into
    // `source` is a bug that renders. It did: the detail modal picks its
    // attribution sentence off `source === 'server'`, so a backend-logged send
    // arrived captioned "recorded when resent from this page" \u2014 a claim about
    // WHO sent the email, made from a field describing where the RECORD came from.
    //
    //   source      WHO sent it, in the vocabulary every surface renders:
    //               'server' (the backend) | 'admin' (us, from this page).
    //               Identical under both regimes, which is the whole point.
    //   sourceKind  the handoff's diagnostic: 'send_log' | 'legacy_stamp'. It
    //               decides whether a count may be printed and NOTHING else \u2014
    //               "`source` is diagnostic \u2026 don't surface the string" (\u00a72).
    const base = {
      invoiceNumber, truncated: false, regime: SEND_REGIME.SERVER,
      source: 'server', sourceKind: serverSent.source || null,
    };

    if (serverSent.malformed) {
      // We could not read the answer. That is "Can't check", never a blank cell.
      return { state: SENT_STATE.FAILED, at: null, sends: [], count: 0, countKnown: false, floor: false, ...base };
    }
    if (!serverSent.applicable) {
      return { state: SENT_STATE.NOT_APPLICABLE, at: null, sends: [], count: 0, countKnown: false, floor: false, ...base };
    }
    if (!serverSent.at) {
      return { state: SENT_STATE.NOT_RECORDED, at: null, sends: [], count: 0, countKnown: false, floor: false, ...base };
    }
    return {
      state: SENT_STATE.SENT,
      at: serverSent.at,
      // ONE entry, because one timestamp is all the field carries. The count can
      // exceed it, which is exactly what `floor`/`countKnown` are for — the
      // history panel must never imply the list IS the tally.
      sends: [{ at: serverSent.at, source: 'server' }],
      count: serverSent.count,
      countKnown: serverSent.countKnown,
      floor: serverSent.floor,
      ...base,
    };
  }

  // ── LOCAL regime ─────────────────────────────────────────────────────────
  // `sourceKind` is null here: the LOCAL regime has no send-log diagnostic to
  // report. Present-and-null rather than absent, so every return from this
  // function has one shape and no consumer has to guard on key presence.
  const base = { invoiceNumber, truncated, regime: SEND_REGIME.LOCAL, sourceKind: null };

  // The channel answer from payment_method. `null` means nobody asked, which is
  // NOT the same as "asked, and it does not apply" — an unasked question must
  // never blank a cell.
  if (applicable === false) {
    return {
      state: SENT_STATE.NOT_APPLICABLE,
      at: null, source: null, sends: [], count: 0, countKnown: false, floor: false, ...base,
    };
  }

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
      sends,
      count: sends.length,
      // Every send here was enumerated one by one, so the number is as known as
      // this regime can make it. `truncated` is the one case where it is not.
      countKnown: !truncated,
      floor: !!truncated,
      ...base,
    };
  }

  // Nothing found — but "nothing found" only means something if we managed to look.
  const none = { at: null, source: null, sends: [], count: 0, countKnown: false, floor: false, ...base };
  if (invoiceFailed || eventFailed) return { state: SENT_STATE.FAILED, ...none };
  if (!invoice) return { state: SENT_STATE.NO_INVOICE, ...none };
  return { state: SENT_STATE.NOT_RECORDED, ...none };
}
