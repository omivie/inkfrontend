/**
 * "Has this customer asked us where their parcel is?" — one vocabulary
 * =====================================================================
 *
 * A customer who cannot see where their parcel is fills in the form at
 * /track-order. That writes an `order_tracking_requests` row (backend migration
 * 083), lights up the standalone Tracking Requests page and the sidebar badge —
 * and, until Sep 2026, nowhere else. The operator working the Orders list, which
 * is where orders are actually processed, got no signal at all: order 2026090203
 * looked identical to the four rows either side of it while that customer had
 * been waiting since 2 September.
 *
 * `readfirst/orders-tracking-requested-column-FE-handoff-sep2026.md` puts one
 * field on every order row and asks the Orders page to render it in the Invoice
 * sent cell — an em-dash on every website row, and website rows are the only
 * rows tracking requests ever come from. This module owns what that field means.
 *
 * WHY THIS IS NOT PART OF utils/order-invoice-sent.js
 * ---------------------------------------------------
 * The two modules render into the same table cell and answer two unrelated
 * questions off two unrelated backend tables — `order_tracking_requests` here,
 * `standalone_invoice_emails` there. Folding them would repeat the exact mistake
 * ERR-199 had to prise back apart, where one field called `source` was carrying
 * both "who sent it" and "where the record came from" and the modal rendered the
 * wrong sentence off it. Two questions, two modules, one cell.
 *
 * THE TRAP, WHICH IS THE SAME TRAP AS ERR-199
 * -------------------------------------------
 * The field is absent from any backend that has not deployed this change yet:
 *
 *     tracking_request absent  =>  undefined
 *     undefined !== null       =>  TRUE   // "there is a request" on every row
 *     undefined == null        =>  TRUE   // "nobody ever asked" on every row
 *
 * Both obvious readings are wrong, in opposite directions, and the second one is
 * the expensive kind: it renders exactly like a correct build, so a feature that
 * never works looks finished. ABSENT, `null` and `{state: …}` are three separate
 * claims and stay three separate states. Detection is `hasOwnProperty`, never
 * truthiness — the same rule, for the same reason, as `readServerInvoiceSent()`.
 *
 * WHAT WAS MEASURED BEFORE ANY OF THIS WAS WRITTEN (2026-09-03, backend commit
 * 90ca2496, `db: connected`)
 * --------------------------------------------------------------------------
 * Unlike ERR-198 and ERR-199, whose hand-offs opened with a sentence that was
 * false, THIS contract is live and every claim in it held:
 *
 *   - `tracking_request` present on 154/154 order rows, all four pages, and on
 *     `GET /api/admin/orders/:id` too (where `invoice_sent` is still absent —
 *     the two endpoints genuinely disagree about which fields they carry).
 *   - 7 open requests, all `state:"requested"`, all on website rows, reconciling
 *     7/7 against `GET /api/admin/tracking-requests`.
 *   - The oldest has been open since 22 June — 73 days. Hence `waitingDays`:
 *     the age is the number an operator actually needs, and it is not on screen
 *     anywhere else.
 *   - `20260714000001` is CANCELLED with an open request against it.
 *
 * TWO BRANCHES BELOW HAVE NEVER EXECUTED IN PRODUCTION. There has never been a
 * single `fulfilled` row (`?status=fulfilled` returns zero), so `SENT` and the
 * re-ask wording are held up by tests and positive controls alone. That is the
 * same standing this repo gave the Invoices `xN` indicator right up until it
 * turned out never to have rendered once (ERR-180), so it is written down here
 * rather than assumed, and `npm run probe:tracking-requested` reprints it on
 * every run until live data exists.
 *
 * AND THE GROUND TRUTH IS NOT READABLE FROM A BROWSER. `order_tracking_requests`
 * has RLS enabled with no permissive policies (sql/order_tracking_requests.sql),
 * so PostgREST answers a read with `200` and an empty array. That is a refusal
 * wearing the costume of an answer — the ERR-188 family — and anything that
 * reads that table to check this feature will certify a broken column green.
 * The only honest second opinion is `GET /api/admin/tracking-requests`.
 *
 * THIS MODULE IS PURE AND RETURNS PLAIN TEXT. It never escapes anything and
 * never touches the DOM: the renderer that interpolates `trackingChipCopy()`
 * owns the escaping, exactly as it does for every other vocabulary module here.
 */

/**
 * What we are able to say about one order, which is not the same list as the
 * states the backend has.
 *
 * UNKNOWN and NONE are the pair that must never merge. NONE is an answer — the
 * backend looked and this customer never asked. UNKNOWN is the absence of an
 * answer, and it renders as nothing at all *while saying so in the console*,
 * because a silent fallback that looks identical to "nobody asked" is how a
 * feature dies without anyone noticing.
 */
export const TRACK_STATE = Object.freeze({
  UNKNOWN: 'unknown',        // the key is absent — this backend has never heard of the field
  NONE: 'none',              // key present, null — the customer never asked
  REQUESTED: 'requested',    // outstanding: they asked, and no email has gone out since
  SENT: 'sent',              // answered: the shipping-information email went out
  DISMISSED: 'dismissed',    // resolved by hand — see the note on DISMISSED below
  UNREADABLE: 'unreadable',  // the key is here and we could not parse it. NOT "no request"
});

/**
 * DISMISSED is here BEFORE the backend can produce it, on purpose.
 *
 * A request against a cancelled order can never clear itself: nothing will ship,
 * so no email fires, so the row stays `pending` for ever (live example —
 * 20260714000001, cancelled 14 July with an open request). The backend offered
 * `POST /api/admin/orders/:orderId/tracking-request/dismiss` plus a `dismissed`
 * status, which needs a migration to widen a CHECK constraint; the owner asked
 * for it, and it is requested in orders-tracking-requested-column-FE-response-sep2026.md.
 *
 * Recognising the value now costs one array entry. Without it, the day that
 * migration lands every dismissed row renders as UNREADABLE — a "can't read this"
 * chip appearing across the Orders page as the *result of a backend fix*, which
 * is the worst possible moment for the frontend to start complaining.
 */
const KNOWN_BACKEND_STATES = Object.freeze({
  requested: TRACK_STATE.REQUESTED,
  sent: TRACK_STATE.SENT,
  dismissed: TRACK_STATE.DISMISSED,
});

/**
 * Which regime the page is answering under — the same shape, and the same
 * `hasOwnProperty` rule, as `orderSendRegime()` next door.
 *
 * ANY row carrying the key puts the whole page in SERVER. The hand-off says
 * every element of `data[]` gains the field, so one row that has it proves the
 * deploy landed; asking "do ALL rows have it?" would drop the page back to
 * UNAVAILABLE over a single malformed row and silently change what every other
 * cell means.
 */
export const TRACK_REGIME = Object.freeze({
  SERVER: 'server',
  UNAVAILABLE: 'unavailable',
});

/**
 * Order statuses on which an open request can never clear itself.
 *
 * Hand-off Rule 4: mute the chip on cancelled orders, using the row's own
 * `status`, because the backend deliberately does NOT fold order status into
 * `state` — "the customer asked" stays true either way, and that is the right
 * call. The muting is a display decision and it lives here so both surfaces
 * make it identically.
 *
 * `refunded` was considered and deliberately left out. It is not in the
 * hand-off's rule, and a refunded order may well have shipped first — muting it
 * would hide a request someone can still answer. The rule the backend wrote is
 * the rule we implement; inventing a second one is how two surfaces start
 * disagreeing about one order (ERR-120).
 */
const UNCLEARABLE_STATUSES = Object.freeze(['cancelled']);

/** Milliseconds in a day, for the one piece of arithmetic in this file. */
const DAY_MS = 86400000;

/**
 * Parse a timestamp defensively.
 *
 * `new Date('nonsense')` does NOT throw — it returns an Invalid Date, whose
 * `toLocaleDateString()` is the literal string "Invalid Date". A try/catch
 * around the format call therefore catches nothing and prints that string into
 * the cell. Every date that reaches a renderer goes through here first.
 *
 * The live values are shaped `2026-09-02T07:29:38.364216+00:00` — six fractional
 * digits where ECMAScript specifies three, and a `+00:00` offset rather than
 * `Z`. Every current engine parses it via its implementation-defined fallback,
 * but "every engine happens to" is not a thing to rely on silently, so an
 * unparseable value degrades to null and the chip simply loses its date rather
 * than the row losing its chip.
 */
export function parseStamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2 Sept" — the cell-width date. The full timestamp lives in the tooltip. */
export function shortStamp(value) {
  const d = parseStamp(value);
  if (!d) return null;
  try {
    return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
  } catch {
    return null;
  }
}

/** "2 Sept 2026, 07:29" — the tooltip date. */
export function fullStamp(value) {
  const d = parseStamp(value);
  if (!d) return null;
  try {
    return d.toLocaleString('en-NZ', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return null;
  }
}

/**
 * Read the backend's `tracking_request` field off one order row.
 *
 * THE KEY'S PRESENCE IS THE REGIME SIGNAL and it is tested with hasOwnProperty,
 * because the value meaning "never asked" (null) and the value meaning "this
 * backend has never heard of the field" (undefined) are indistinguishable to
 * `==` and back-to-front to `!==`. See the module header.
 *
 * Returns, always, the same shape:
 *   present      the row carries the key at all — i.e. the field has shipped
 *   malformed    the key is there and its value is not a shape we can read. NOT
 *                "no request": we could not read the answer, which renders as a
 *                visible "can't read" chip and never as a blank cell.
 *   state        TRACK_STATE. The BACKEND's `state` is the authority (Rule 1) —
 *                nothing here consults `order.status` or `tracking_number`, and
 *                nothing may: an order can be shipped with tracking and still
 *                have an open request, and vice versa.
 *   requestedAt  the OPEN request's date (Rule 3), not the newest row's
 *   sentAt       when we last answered, or null
 *   count        a FLOOR. There is at least one ask whenever there is a request
 *   countKnown   whether `count` is a real tally. False for 0 / missing / NaN /
 *                negative beside a real request — that is UNKNOWN, not zero, and
 *                it is the confusion ERR-180 shipped on the Invoices page
 *   repeat       they were answered once and have asked again (Rule 2)
 */
export function readTrackingRequest(order) {
  const absent = Object.freeze({
    present: false, malformed: false, state: TRACK_STATE.UNKNOWN,
    requestedAt: null, sentAt: null, count: 0, countKnown: false, repeat: false,
  });
  if (!order || typeof order !== 'object') return { ...absent };
  if (!Object.prototype.hasOwnProperty.call(order, 'tracking_request')) return { ...absent };

  const field = order.tracking_request;

  // An explicit null is the backend saying "this customer never asked". A key
  // that exists holding `undefined` is the same claim made sloppily; it is not
  // the absent case, because the key is here.
  if (field === null || field === undefined) {
    return { ...absent, present: true, state: TRACK_STATE.NONE };
  }

  // A string, a number, an array — the field is here and we cannot read it. The
  // one answer we must not give is silence, which would assert "nobody asked"
  // out of a parse failure.
  if (typeof field !== 'object' || Array.isArray(field)) {
    return { ...absent, present: true, malformed: true, state: TRACK_STATE.UNREADABLE };
  }

  const raw = typeof field.state === 'string' ? field.state.trim().toLowerCase() : null;
  const state = raw && Object.prototype.hasOwnProperty.call(KNOWN_BACKEND_STATES, raw)
    ? KNOWN_BACKEND_STATES[raw]
    : null;
  if (!state) {
    // A state we do not have wording for. Reading it as "requested" would invent
    // an outstanding task; reading it as "none" would hide a real one. Neither
    // is ours to guess.
    return { ...absent, present: true, malformed: true, state: TRACK_STATE.UNREADABLE };
  }

  const requestedAt = parseStamp(field.requested_at) ? field.requested_at : null;
  const sentAt = parseStamp(field.sent_at) ? field.sent_at : null;

  const n = Number(field.request_count);
  const countKnown = Number.isFinite(n) && n >= 1;

  // "Answered once, and asked again." Either signal proves it: an explicit
  // sent_at underneath an open request, or a tally of two or more. The table
  // carries a unique index allowing only ONE pending row per order, so a second
  // pending ask can only exist as a second ROW — which is what makes the count
  // meaningful here rather than decorative.
  const repeat = state === TRACK_STATE.REQUESTED
    && (sentAt !== null || (countKnown && n >= 2));

  return {
    present: true,
    malformed: false,
    state,
    requestedAt,
    sentAt,
    // A floor: there is at least one ask on record whenever there is a request
    // at all, even when the tally itself is unusable.
    count: countKnown ? Math.floor(n) : 1,
    countKnown,
    repeat,
  };
}

/**
 * Which regime a page of order rows is answering under. See TRACK_REGIME.
 */
export function trackingRequestRegime(rows) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const row of list) {
    if (row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, 'tracking_request')) {
      return TRACK_REGIME.SERVER;
    }
  }
  return TRACK_REGIME.UNAVAILABLE;
}

/**
 * Pick the reading from whichever payload actually carries the field.
 *
 * The list endpoint and the detail endpoint do not agree about their own
 * contract — measured 2026-09-03, `/orders/:id` carries `tracking_request` and
 * does NOT carry `invoice_sent`. Rather than hard-code which one to trust, take
 * candidates in preference order and use the first that has the key at all.
 * Same shape, same reason, as `resolveDeleteRight(fullOrder, listRow, row)` on
 * the Orders page: an absent contract is a reason to look at the next payload,
 * not a reason to answer from a payload that never had it.
 */
export function readTrackingRequestFrom(...candidates) {
  for (const candidate of candidates) {
    const read = readTrackingRequest(candidate);
    if (read.present) return read;
  }
  return readTrackingRequest(null);
}

/**
 * Everything a renderer needs, including the two facts the backend refuses to
 * fold in for us: whether this request can still be cleared, and how long the
 * customer has actually been waiting.
 *
 * `now` is injectable so the age is testable without freezing the clock.
 */
export function resolveTrackingInfo({ tr = null, order = null, orderStatus = null, now = null } = {}) {
  const read = tr || readTrackingRequest(order);
  const status = String(
    orderStatus !== null && orderStatus !== undefined ? orderStatus : (order?.status || ''),
  ).trim().toLowerCase();

  // Rule 4. Only an OUTSTANDING request can be un-clearable — a sent or
  // dismissed one is already resolved and has nothing left to mute.
  const muted = read.state === TRACK_STATE.REQUESTED && UNCLEARABLE_STATUSES.includes(status);

  const from = parseStamp(read.requestedAt);
  const at = now instanceof Date ? now : (now ? parseStamp(now) : new Date());
  // Clamped at zero: a request timestamped a few seconds into the future by
  // clock skew is not "-1 days waiting".
  const waitingDays = from && at ? Math.max(0, Math.floor((at.getTime() - from.getTime()) / DAY_MS)) : null;

  return { ...read, muted, orderStatus: status, waitingDays };
}

/**
 * "3 days waiting" / "1 day waiting" — the age, in the one phrasing both
 * surfaces use. Null for "today" so a same-day request reads as just its date
 * rather than "0 days waiting", which sounds like a bug.
 */
export function waitingPhrase(days) {
  if (days === null || days === undefined) return null;
  const n = Math.max(0, Math.floor(Number(days) || 0));
  if (n < 1) return null;
  return `${n} day${n === 1 ? '' : 's'} waiting`;
}

/**
 * The chip's words — label, sub-line, tooltip and modifier class — for every
 * state that renders one. Returns null when there is nothing to say.
 *
 * ONE VOCABULARY. The list cell and the order modal both read this, so the two
 * surfaces cannot describe one customer's request in two sets of words. That is
 * the rule utils/send-history.js exists to hold for send counts, and the repo
 * has shipped the failure often enough (ERR-120/129/143/180) to stop writing
 * the second copy.
 *
 * Plain text, deliberately — see the module header on escaping.
 */
export function trackingChipCopy(info) {
  if (!info) return null;

  const when = shortStamp(info.requestedAt);
  const whenFull = fullStamp(info.requestedAt);
  const sentShort = shortStamp(info.sentAt);
  const sentFull = fullStamp(info.sentAt);
  const waiting = waitingPhrase(info.waitingDays);
  const askedOn = whenFull ? `The customer asked for tracking on ${whenFull}.` : 'The customer asked for tracking.';

  if (info.state === TRACK_STATE.UNREADABLE) {
    return {
      cls: 'order-track--unreadable',
      label: 'Tracking unknown',
      sub: null,
      tip: 'The backend sent a tracking-request field this page could not read, so we cannot say '
        + 'whether this customer has asked for tracking. This is NOT "nobody asked" — it is a '
        + 'value we failed to parse. Reload, and if it persists run: npm run probe:tracking-requested',
    };
  }

  if (info.state === TRACK_STATE.DISMISSED) {
    return {
      cls: 'order-track--done',
      label: 'Tracking dismissed',
      sub: when,
      tip: `${askedOn} The request was resolved by hand rather than by an email going out, so the `
        + 'customer was not necessarily contacted.',
    };
  }

  if (info.state === TRACK_STATE.SENT) {
    return {
      cls: 'order-track--done',
      label: 'Tracking sent',
      sub: sentShort || when,
      tip: `${askedOn}`
        + (sentFull ? ` The shipping-information email went out on ${sentFull}.` : ' The shipping-information email has gone out.')
        + (info.countKnown && info.count > 1 ? ` They asked ${info.count} times in total.` : ''),
    };
  }

  if (info.state !== TRACK_STATE.REQUESTED) return null;   // NONE and UNKNOWN render nothing

  // ---- OUTSTANDING ---------------------------------------------------------
  // The sub-line carries the date AND the age, because the age is the whole
  // point: some of these are months old and a bare date does not read as urgent.
  const sub = [when, waiting].filter(Boolean).join(' · ') || null;

  if (info.muted) {
    // Rule 4, and the hand-off's own "Known gap". Muted, not hidden: the
    // customer really did ask, and hiding it would be the frontend deciding a
    // fact stopped being true because it became inconvenient.
    return {
      cls: 'order-track--stuck',
      label: 'Tracking requested',
      sub,
      tip: `${askedOn} This order is cancelled, so nothing will ever ship and no shipping-information `
        + 'email will ever fire — which means this request cannot clear itself and will stay open '
        + 'indefinitely. There is no dismiss action yet; the backend exposes none.',
    };
  }

  if (info.repeat) {
    // Rule 2. The ordinal is printed ONLY from a tally we can trust: a zero or
    // missing request_count beside a real request is UNKNOWN, not zero, and
    // "this is ask 0" would be a number we invented (ERR-180).
    const ordinal = info.countKnown && info.count > 1 ? ` This is ask number ${info.count}.` : '';
    return {
      cls: 'order-track--requested',
      label: 'Tracking requested again',
      sub,
      tip: `${askedOn}`
        + (sentFull
          ? ` They were answered once already — the last shipping-information email went out on ${sentFull} — and have asked again since.`
          : ' They have been answered once already and have asked again since.')
        + ordinal
        + (waiting ? ` The open request has been waiting ${waiting.replace(' waiting', '')}.` : '')
        + ' Send tracking from the Shipping Information section on the order.',
    };
  }

  return {
    cls: 'order-track--requested',
    label: 'Tracking requested',
    sub,
    tip: `${askedOn} No shipping-information email has gone out since, so they are still waiting`
      + (waiting ? ` — ${waiting.replace(' waiting', '')} so far` : '')
      + '. Send tracking from the Shipping Information section on the order; the request clears '
      + 'itself when the email actually goes out.',
  };
}
