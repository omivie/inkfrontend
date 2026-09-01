/**
 * Shipping Information — one carrier vocabulary, one merge rule, one send-count claim
 * ==================================================================================
 *
 * The order detail modal grew a **Shipping Information** section (Sep 2026,
 * ERR-200): carrier, tracking/ticket number, ticket product code and an optional
 * tracking-URL override, with their own Save and their own "Send to customer",
 * separate from the Update Status modal. This module is everything about that
 * panel that is not DOM — so the page renders it, the Update Status modal shares
 * its dropdown, and the tests and the probe can all read the same rules.
 *
 * THE FOUR RULES THIS MODULE EXISTS TO CARRY
 * ------------------------------------------
 *
 * 1. **RELABEL, DON'T BRANCH.** NZ Couriers calls its number a *ticket number*;
 *    everyone else calls it a *tracking number*. The backend ships the right word
 *    on every response as `tracking_number_label`, and the registry ships it per
 *    carrier as `number_label`. We render that string. There is deliberately NO
 *    `if (carrier === 'NZ Couriers')` anywhere in this repo, and a test greps for
 *    exactly that. Adding a carrier is a one-file change on the BACKEND
 *    (`src/utils/carriers.js`); if it costs a frontend edit, we built it wrong.
 *    Same family as BrandSource (`js/utils.js`): NEVER INFER FROM A NAME.
 *
 * 2. **THE URL INPUT IS THE OVERRIDE, NEVER THE DERIVED LINK.** The response
 *    carries two URLs that look alike and mean opposite things: `tracking_url` is
 *    where the customer gets sent (usually built from the carrier's template), and
 *    `tracking_url_override` is the raw thing an operator typed — `null` when the
 *    link is derived. Prefill the input from `tracking_url` and the very first
 *    save of an untouched form silently FREEZES today's derived link into a stored
 *    override, so the carrier's template can never correct it again. The input is
 *    bound to `tracking_url_override`. `formFromShipping()` is the only place that
 *    decision is made, and §4 of the test suite fails if it changes.
 *
 * 3. **A SEND COUNT IS A FLOOR.** Measured on live production the day this
 *    shipped: 4 of the 13 shipped orders report `email.send_count: 0` with
 *    `last_status: null` — while being shipped, and shipping auto-emails the
 *    customer. Those sends predate the log. `send_count: 0` on a shipped order is
 *    therefore UNKNOWN, not zero, and printing "Never sent" there talks an
 *    operator into emailing a customer twice. This is ERR-180 one page over, so
 *    the phrasing comes from the same place both other pages get it:
 *    `recordedSendsPhrase()` in utils/send-history.js — "1 recorded send", NEVER
 *    "sent once".
 *
 * 4. **ABSENT, NULL AND EMPTY ARE THREE CLAIMS.** `GET /api/admin/orders/:id`
 *    returns `shipping_information` with `email: null` — it skips the extra query,
 *    it is not saying the customer was never emailed. `GET /orders/:id/shipping`
 *    is the one that knows. Verified live: order 20260829000001 reads `email:
 *    null` on the first and `send_count: 1` on the second. So detection is
 *    `hasOwnProperty`, never truthiness, and "we haven't looked" has its own words
 *    on screen (ERR-199: `undefined !== null` and `undefined == null` are BOTH
 *    true, so both of the obvious gates are wrong, in opposite directions).
 *
 * Nothing here touches the network or the DOM, so tests load it in a vm and the
 * probe loads the SHIPPED derivation rather than re-implementing it.
 */

import { recordedSendsPhrase } from './send-history.js';

/* ─────────────────────────── vocabulary ─────────────────────────── */

/** Where a shipping block came from, and therefore what it is allowed to claim. */
export const SHIPPING_REGIME = Object.freeze({
    /** From `GET /orders/:id/shipping` — complete, including send history. */
    FULL: 'full',
    /** From the order detail payload — real, but `email` is null BY DESIGN. */
    PARTIAL: 'partial',
    /** No `shipping_information` key at all — an older payload, or a read that failed. */
    ABSENT: 'absent',
});

/** What we can honestly say about "has the customer been emailed?" */
export const EMAIL_STATE = Object.freeze({
    /** n >= 1 sends in the log. */
    RECORDED: 'recorded',
    /** Shipped, zero logged sends — an auto-send almost certainly happened pre-log. */
    UNLOGGED: 'unlogged',
    /** Not shipped yet, so there is nothing to have sent. A true zero. */
    NOT_APPLICABLE: 'not_applicable',
    /** We have not read the send history. Not a claim about sends at all. */
    UNKNOWN: 'unknown',
});

/** Reason codes. The first five mirror the backend's 400s so the operator meets them here first. */
export const SHIPPING_ISSUE = Object.freeze({
    TICKET_PRODUCT_CODE_REQUIRED: 'TICKET_PRODUCT_CODE_REQUIRED',
    INVALID_TRACKING_URL: 'INVALID_TRACKING_URL',
    NO_TRACKING_INFORMATION: 'NO_TRACKING_INFORMATION',
    UNKNOWN_CARRIER: 'UNKNOWN_CARRIER',
    NOTHING_TO_TRACK_BY: 'NOTHING_TO_TRACK_BY',
    /** Ours, not the backend's: a warning, never a block. See looksLikeUrl(). */
    NUMBER_LOOKS_LIKE_URL: 'NUMBER_LOOKS_LIKE_URL',
    /** Ours: the registry documents 2–4 chars. A nudge, never a block. */
    PRODUCT_CODE_UNUSUAL_LENGTH: 'PRODUCT_CODE_UNUSUAL_LENGTH',
});

/**
 * The word for the number field when NOBODY has told us one.
 *
 * Used only when both the response and the registry are silent — i.e. something
 * upstream is missing, and a blank label would be worse than the common case.
 * It is NOT a per-carrier default: see numberLabel().
 */
export const DEFAULT_NUMBER_LABEL = 'Tracking number';

const warn = (...a) => {
    // eslint-disable-next-line no-undef
    if (typeof DebugLog !== 'undefined' && DebugLog?.warn) DebugLog.warn('[shipping-info]', ...a);
};

const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => str(v).trim();
const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

/* ─────────────────────────── reading ─────────────────────────── */

/**
 * Pull the shipping block off whatever payload we happen to hold, and say which.
 *
 * Three payloads carry one: `GET /orders/:id` nests it as
 * `order.shipping_information` with `email: null`; `GET /orders/:id/shipping`
 * returns `data.shipping` complete; and a `PUT .../shipping` echoes `data.shipping`
 * back. The regime is returned rather than inferred later because the ONLY
 * difference between the first two is a field that is legitimately null in one and
 * meaningful in the other — exactly the pair a truthiness check folds together.
 *
 * @param {object|null} source an order, a /shipping envelope's data, or a raw block
 * @returns {{regime: string, shipping: object|null}}
 */
export function readShipping(source) {
    if (!source || typeof source !== 'object') return { regime: SHIPPING_REGIME.ABSENT, shipping: null };

    // `data.shipping` from the dedicated endpoint (or a PUT echo) — the complete one.
    if (has(source, 'shipping') && source.shipping && typeof source.shipping === 'object') {
        return { regime: SHIPPING_REGIME.FULL, shipping: source.shipping };
    }
    // The order-detail nesting. `email` is null here BY DESIGN, not by absence of sends.
    if (has(source, 'shipping_information')) {
        const block = source.shipping_information;
        if (!block || typeof block !== 'object') return { regime: SHIPPING_REGIME.ABSENT, shipping: null };
        return { regime: SHIPPING_REGIME.PARTIAL, shipping: block };
    }
    // Already unwrapped. Trust it only if it looks like the contract.
    if (has(source, 'tracking_number_label') || has(source, 'carrier_code')) {
        // A block that carries a real `email` object knows about sends; one whose
        // `email` is null or missing does not. Same test, stated once.
        const complete = has(source, 'email') && source.email && typeof source.email === 'object';
        return { regime: complete ? SHIPPING_REGIME.FULL : SHIPPING_REGIME.PARTIAL, shipping: source };
    }
    return { regime: SHIPPING_REGIME.ABSENT, shipping: null };
}

/** True when this block can answer "has the customer been emailed?" at all. */
export function knowsSendHistory(shipping) {
    return !!(shipping && has(shipping, 'email') && shipping.email && typeof shipping.email === 'object');
}

/* ─────────────────────────── the registry ─────────────────────────── */

/**
 * One carrier out of the server-driven registry, by code.
 *
 * Matching is on `code` only. Matching on `name` would re-admit exactly the
 * name-inference this module exists to forbid, and the display name is the half a
 * backend is free to reword.
 */
export function carrierByCode(code, registry) {
    const want = trimmed(code).toLowerCase();
    if (!want || !Array.isArray(registry)) return null;
    return registry.find(c => trimmed(c?.code).toLowerCase() === want) || null;
}

/**
 * The stored carrier, resolved against the registry.
 *
 * `carrier_code` is the canonical field. `carrier` (the display name) is accepted
 * as a fallback ONLY as an exact, case-insensitive match against a registry name —
 * that is a lookup in a closed server-supplied set, not an inference from a name.
 * Rows written before the registry existed carry a name and no code.
 */
export function carrierOf(shipping, registry) {
    if (!shipping) return null;
    const byCode = carrierByCode(shipping.carrier_code, registry);
    if (byCode) return byCode;
    const name = trimmed(shipping.carrier).toLowerCase();
    if (!name || !Array.isArray(registry)) return null;
    return registry.find(c => trimmed(c?.name).toLowerCase() === name) || null;
}

/**
 * The word to put above the number input — "Ticket number" or "Tracking number".
 *
 * Order: what the response said for THIS order, then what the registry says for
 * the carrier now selected (the operator may have just changed the dropdown and
 * not saved), then the default with a warning. Never a carrier-name branch.
 */
export function numberLabel(shipping, carrier) {
    const fromResponse = trimmed(shipping?.tracking_number_label);
    if (fromResponse) return fromResponse;
    const fromRegistry = trimmed(carrier?.number_label);
    if (fromRegistry) return fromRegistry;

    // The fallback is only NOTEWORTHY when a label was owed to us. An order with
    // no carrier yet — a fresh one, or the first paint before the registry has
    // loaded — has nobody to ask, and the generic word is simply the placeholder
    // on an empty form. Warning there would cry wolf on every order the operator
    // opens, and a warning that fires constantly is one nobody reads when the
    // registry really is malformed.
    const carrierExpectsALabel = !!carrier && typeof carrier === 'object';
    const responseHasACarrier = !!trimmed(shipping?.carrier_code) || !!trimmed(shipping?.carrier);
    if (carrierExpectsALabel || responseHasACarrier) {
        warn('a carrier is set but neither the response nor the registry supplied its number label — falling back to the generic word');
    }
    return DEFAULT_NUMBER_LABEL;
}

/** Does the currently-selected carrier need a ticket product code? Unknown carrier ⇒ false. */
export function requiresProductCode(carrier) {
    return carrier?.requires_product_code === true;
}

/** Can the backend build a link from the number alone? Unknown carrier ⇒ false (assume not). */
export function buildsTrackingUrl(carrier) {
    return carrier?.builds_tracking_url === true;
}

/** Can this carrier's numbers be polled for scan events? Unknown ⇒ false. */
export function supportsLiveTracking(carrier) {
    return carrier?.supports_live_tracking === true;
}

/* ─────────────────────────── validation ─────────────────────────── */

/**
 * A tracking number that is actually a pasted URL.
 *
 * This is not hypothetical. Order 20260809000002 holds
 * `https://www.nzpost.co.nz/tools/tracking?trackid=00894210392912038227` in
 * `tracking_number`, so the backend dutifully template-built
 * `…/tracking/item/https%3A%2F%2Fwww.nzpost.co.nz%2F…` and that customer's order
 * page has linked to a parcel that cannot exist ever since. The backend cannot
 * refuse it — a tracking reference has no universal grammar and inventing one
 * would reject a legitimate carrier's format. The operator can see it, though, so
 * we say so: a WARNING that names the URL field as the right home for it, never a
 * block.
 */
export function looksLikeUrl(value) {
    const v = trimmed(value);
    if (!v) return false;
    return /^(https?:)?\/\//i.test(v) || /^www\./i.test(v);
}

/**
 * An https:// URL, or null.
 *
 * `http://` is rejected here because the backend rejects it (INVALID_TRACKING_URL)
 * — meeting that on the field beats meeting it as a toast after a round trip.
 */
export function normaliseTrackingUrl(value) {
    const v = trimmed(value);
    if (!v) return null;
    let parsed;
    try { parsed = new URL(v); } catch { return null; }
    return parsed.protocol === 'https:' ? parsed.href : null;
}

/**
 * Everything wrong with the form, before it costs a round trip.
 *
 * `errors` block the save; `warnings` are shown and saved through. The split
 * matters: every error here mirrors a documented backend 400, so this can only
 * ever refuse what the backend would refuse. The warnings are ours, and a warning
 * that could block would eventually refuse a save the backend would have accepted.
 *
 * @param {{carrierCode, number, productCode, url}} form
 * @param {object|null} carrier the registry entry for form.carrierCode
 * @param {{markShipped?: boolean, sendEmail?: boolean}} intent
 */
export function validateShipping(form, carrier, intent = {}) {
    const errors = [];
    const warnings = [];
    const number = trimmed(form?.number);
    const productCode = trimmed(form?.productCode);
    const rawUrl = trimmed(form?.url);
    const carrierCode = trimmed(form?.carrierCode);

    if (carrierCode && !carrier) {
        errors.push({
            field: 'carrier', code: SHIPPING_ISSUE.UNKNOWN_CARRIER,
            message: 'That carrier is not one the server recognises. Reload the page to refresh the list.',
        });
    }

    const url = rawUrl ? normaliseTrackingUrl(rawUrl) : null;
    if (rawUrl && !url) {
        errors.push({
            field: 'url', code: SHIPPING_ISSUE.INVALID_TRACKING_URL,
            message: /^http:\/\//i.test(rawUrl)
                ? 'Tracking links must be https:// — an http:// link is rejected.'
                : 'That is not a valid https:// link.',
        });
    }

    // The backend's rule, verbatim: a carrier that needs a product code, WITH a
    // number, and no product code AND no URL. A URL satisfies it because the
    // operator has supplied the destination directly — there is nothing left to
    // build. Refusing rather than saving is the point: a half-filled NZ Couriers
    // entry produces a track-and-trace URL that 404s, and a dead link in a
    // customer's email is worse than no link.
    if (requiresProductCode(carrier) && number && !productCode && !url) {
        errors.push({
            field: 'productCode', code: SHIPPING_ISSUE.TICKET_PRODUCT_CODE_REQUIRED,
            message: `${trimmed(carrier?.name) || 'This carrier'} needs the ticket product code as well as the ticket number — without it the track-and-trace link 404s.`,
        });
    }

    if ((intent.sendEmail || intent.markShipped) && !number && !url) {
        errors.push({
            field: 'number',
            code: intent.sendEmail ? SHIPPING_ISSUE.NO_TRACKING_INFORMATION : SHIPPING_ISSUE.NOTHING_TO_TRACK_BY,
            message: intent.sendEmail
                ? 'There is nothing to send: this order has neither a tracking number nor a tracking link.'
                : 'Marking an order shipped needs something for the customer to track by — a number or a link.',
        });
    }

    if (looksLikeUrl(number)) {
        warnings.push({
            field: 'number', code: SHIPPING_ISSUE.NUMBER_LOOKS_LIKE_URL,
            message: 'That looks like a web address, not a tracking number. A link belongs in the Tracking URL field below — pasted here, the carrier link is built around it and will not find the parcel.',
        });
    }

    if (productCode && (productCode.length < 2 || productCode.length > 4)) {
        warnings.push({
            field: 'productCode', code: SHIPPING_ISSUE.PRODUCT_CODE_UNUSUAL_LENGTH,
            message: 'Ticket product codes are normally 2–4 characters (e.g. LH). Saving anyway.',
        });
    }

    return { ok: errors.length === 0, errors, warnings };
}

/* ─────────────────────────── the payload ─────────────────────────── */

/**
 * The form values a shipping block should populate.
 *
 * The one non-obvious line is `url`, and rule 2 at the top of this file is why:
 * it reads `tracking_url_override`, the raw stored override, NOT `tracking_url`,
 * the link the customer is sent to. They are equal only when an operator typed
 * one. Bind the input to the derived link and every save of an untouched form
 * converts a template-built link into a frozen override.
 */
export function formFromShipping(shipping) {
    return {
        carrierCode: str(shipping?.carrier_code),
        number: str(shipping?.tracking_number),
        productCode: str(shipping?.ticket_product_code),
        url: str(shipping?.tracking_url_override),
    };
}

/**
 * The smallest PUT body that expresses what the operator changed.
 *
 * Merge semantics, from the contract: an OMITTED field keeps its stored value; an
 * EMPTY STRING clears it to null. So sending only what changed is safe AND is the
 * only way a partial edit stays partial — a body that echoes every field turns an
 * unrelated concurrent change into a silent revert.
 *
 * Two things are deliberately never sent:
 *   - `ticket_number`. It is an accepted alias that writes to the same column, so
 *     sending both spellings with different values is a 400 by design
 *     (CONFLICTING_TRACKING_NUMBER). One spelling, chosen here, cannot conflict.
 *   - an unchanged value. `''` means CLEAR, so echoing an already-empty field back
 *     as `''` would be a no-op that reads as a deliberate erasure in the audit.
 *
 * @param {object|null} shipping the stored block (the baseline for "changed")
 * @param {{carrierCode, number, productCode, url}} form
 * @param {{markShipped?: boolean, sendEmail?: boolean, shippedAt?: string}} intent
 */
export function buildPayload(shipping, form, intent = {}) {
    const before = formFromShipping(shipping);
    const body = {};

    const put = (key, nextRaw, prevRaw) => {
        const next = trimmed(nextRaw);
        const prev = trimmed(prevRaw);
        if (next === prev) return;             // unchanged — omit, and it keeps its value
        body[key] = next;                      // '' is meaningful here: clear it to null
    };

    put('carrier', form?.carrierCode, before.carrierCode);
    put('tracking_number', form?.number, before.number);
    put('ticket_product_code', form?.productCode, before.productCode);
    put('tracking_url', form?.url, before.url);

    if (intent.markShipped) body.mark_shipped = true;
    if (intent.sendEmail) body.send_email = true;
    if (intent.shippedAt) body.shipped_at = intent.shippedAt;

    return body;
}

/**
 * Is there anything in this body worth sending?
 *
 * The endpoint requires at least one field. A save button that fires on an
 * untouched form spends a request to be told so; worse, with `mark_shipped` it
 * would flip a status the operator did not ask to flip.
 */
export function hasChanges(payload) {
    return !!payload && Object.keys(payload).length > 0;
}

/** Only the value fields — used to tell "nothing changed" from "only ticked a box". */
export function changedFieldCount(payload) {
    const VALUE_FIELDS = ['carrier', 'tracking_number', 'ticket_product_code', 'tracking_url'];
    return VALUE_FIELDS.filter(f => has(payload, f)).length;
}

/* ─────────────────────────── the send claim ─────────────────────────── */

/**
 * What we may honestly say about whether the customer has been emailed.
 *
 * See rule 3 at the top. The three non-trivial states all print DIFFERENT WORDS,
 * because the whole failure mode here is two different facts wearing one sentence:
 *
 *   UNKNOWN         we have not read the send history (the detail payload's
 *                   `email: null`). Says so. Claims nothing.
 *   UNLOGGED        shipped, zero logged sends. The auto-send on dispatch is not
 *                   in the log, so the customer probably HAS been emailed. Never
 *                   "never sent".
 *   NOT_APPLICABLE  not shipped. A true zero, and the only one.
 *   RECORDED        n >= 1, phrased by recordedSendsPhrase() — "recorded sends",
 *                   never "sent N times".
 *
 * @returns {{state, count: number|null, phrase: string, detail: string, lastSentAt: string|null, warnBeforeSend: boolean}}
 */
export function emailState(shipping) {
    const isShipped = shipping?.is_shipped === true;

    if (!knowsSendHistory(shipping)) {
        return {
            state: EMAIL_STATE.UNKNOWN, count: null, lastSentAt: null,
            phrase: 'Send history not loaded',
            detail: 'This view has not read the send log, so it cannot say whether the customer has been emailed. Reopen the order to check.',
            // We cannot rule out a previous send, so a send from here is still deliberate.
            warnBeforeSend: true,
        };
    }

    const email = shipping.email;
    const rawCount = Number(email.send_count);
    const count = Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : 0;
    const lastSentAt = email.last_sent_at || null;

    if (count > 0) {
        return {
            state: EMAIL_STATE.RECORDED, count, lastSentAt,
            phrase: recordedSendsPhrase(count),
            detail: 'Sending again will email the customer another copy.',
            warnBeforeSend: true,
        };
    }

    if (!isShipped) {
        return {
            state: EMAIL_STATE.NOT_APPLICABLE, count: 0, lastSentAt: null,
            phrase: 'Not sent',
            detail: 'This order has not shipped yet, so no shipping email has gone out.',
            warnBeforeSend: false,
        };
    }

    // Shipped, nothing in the log. Dispatch emails the customer automatically, so
    // the honest reading is "the log does not go back this far", not "zero".
    return {
        state: EMAIL_STATE.UNLOGGED, count: 0, lastSentAt: null,
        phrase: 'No recorded sends',
        detail: 'This order shipped before its sends were logged, so the customer may already have had these details. Sending will email them again.',
        warnBeforeSend: true,
    };
}

/**
 * Whether "Send to customer" may be pressed at all, and why not.
 *
 * `can_send_email` is the backend's own answer (`is_shipped && (tracking_number ||
 * tracking_url)`) and is preferred whenever it is present, so the button and the
 * endpoint cannot disagree. The reconstruction is only for a block that predates
 * the field — and it says which of the two halves is missing, because "disabled"
 * with no reason is the thing an operator files a bug about.
 */
export function sendability(shipping) {
    if (!shipping) return { canSend: false, reason: 'No shipping details have been loaded for this order.' };

    const hasTarget = !!trimmed(shipping.tracking_number) || !!trimmed(shipping.tracking_url);
    const isShipped = shipping.is_shipped === true;

    if (has(shipping, 'can_send_email') && typeof shipping.can_send_email === 'boolean') {
        if (shipping.can_send_email) return { canSend: true, reason: '' };
        return {
            canSend: false,
            reason: !isShipped
                ? 'The order has to be marked shipped first — the email says "your order has shipped", and the customer\'s own order page hides tracking until then.'
                : 'Add a tracking number or a tracking link first — there is nothing to tell the customer.',
        };
    }

    if (!isShipped) return { canSend: false, reason: 'The order has to be marked shipped first.' };
    if (!hasTarget) return { canSend: false, reason: 'Add a tracking number or a tracking link first.' };
    return { canSend: true, reason: '' };
}

/* ─────────────────────────── failures ─────────────────────────── */

/**
 * Operator-facing copy for a failed save or send.
 *
 * Every message names what to do next, because each of these is recoverable at
 * the keyboard. `ORDER_NOT_SHIPPED` in particular is not really an error — it is
 * the backend asking a question the panel can answer with a checkbox, so the page
 * offers the retry rather than printing this.
 */
export function shippingErrorMessage(err) {
    switch (err?.code) {
        case SHIPPING_ISSUE.UNKNOWN_CARRIER:
        case 'UNKNOWN_CARRIER':
            return 'The server does not recognise that carrier. Reload the page — the carrier list comes from the server and yours may be stale.';
        case 'TICKET_PRODUCT_CODE_REQUIRED':
            return 'This carrier needs the ticket product code as well as the ticket number — without both, the tracking link 404s.';
        case 'CONFLICTING_TRACKING_NUMBER':
            return 'The tracking number was sent twice with two different values. That is a bug in this page, not something you did — please report it.';
        case 'INVALID_TRACKING_URL':
            return 'The tracking link must be a valid https:// address.';
        case 'ORDER_NOT_SHIPPED':
            return 'The order has to be marked shipped before the customer can be emailed.';
        case 'NO_TRACKING_INFORMATION':
            return 'There is nothing to send — add a tracking number or a tracking link first.';
        case 'VALIDATION_ERROR':
        case 'VALIDATION_FAILED': {
            // The backend's message here is 'Validation failed' with the substance
            // in details[] — and its detail text is Joi's, which quotes the wire
            // field name at a human ('"tracking_url" must be a valid uri…').
            const named = Array.isArray(err?.details)
                ? err.details.map(d => trimmed(d?.field)).filter(Boolean)
                : [];
            if (named.length) return 'Some of those details were rejected — see the fields marked below.';
            const only = Array.isArray(err?.details) && err.details.length === 1 ? trimmed(err.details[0]?.message) : '';
            if (/at least 1 key/i.test(only)) return 'Nothing was sent to save. Change a field first.';
            return only || err?.message || 'Some of those details were rejected.';
        }
        case 'CONFLICT':
            return 'Someone else changed this order while you were editing. Your typing has been kept — check the details below and save again.';
        case 'NOT_FOUND':
            return 'That order no longer exists. Refresh the list.';
        case 'RATE_LIMITED':
            return 'Too many changes at once. Give it a few seconds and try again.';
        case 'FORBIDDEN':
            return 'Your account cannot edit shipping details. This needs super admin or order manager.';
        default:
            break;
    }
    // Same test the Invoices page uses — a fetch that never reached the server has
    // no code, and telling someone their change "failed" when it was never sent is
    // how a save gets repeated until it duplicates.
    if (!err?.code && /failed to fetch|networkerror|load failed|network request failed/i.test(err?.message || '')) {
        return 'Couldn’t reach the server, so nothing was saved. Check your connection and try again.';
    }
    return err?.message || 'Could not save the shipping details.';
}

/**
 * Which FORM field each backend field name belongs to.
 *
 * `ticket_number` is here even though this module never sends it: the backend
 * accepts the alias, and an error naming it still has to land on the one input
 * that holds the number.
 */
const BACKEND_FIELD_TO_FORM = Object.freeze({
    carrier: 'carrier',
    carrier_code: 'carrier',
    tracking_number: 'number',
    ticket_number: 'number',
    ticket_product_code: 'productCode',
    tracking_url: 'url',
});

/** Our own words for the refusals we can recognise; the backend's for the rest. */
const BACKEND_FIELD_COPY = Object.freeze({
    tracking_url: 'The tracking link must be a valid https:// address.',
    ticket_product_code: 'This carrier needs the ticket product code as well as the ticket number.',
});

/**
 * Field-level problems out of a rejected save.
 *
 * MEASURED, not cited (2026-09-01). The hand-off's §6 table lists
 * `INVALID_TRACKING_URL` for a bad tracking URL; production actually answers
 * `VALIDATION_FAILED` with `details: [{ field: 'tracking_url', message: '"tracking_url"
 * must be a valid uri with a scheme matching the https pattern' }]` — the schema
 * layer rejects it before the handler's own check is ever reached. Keying only on
 * the documented code would have left the field unmarked and shown the operator
 * raw Joi prose, so both are read: the documented codes AND details[].
 *
 * Returns [] when there is nothing field-specific to say, so the caller falls
 * back to a whole-form message rather than rendering an empty box.
 */
export function fieldIssuesFromError(err) {
    const out = [];
    const details = err?.details;

    if (Array.isArray(details)) {
        for (const d of details) {
            const backendField = trimmed(d?.field);
            const form = BACKEND_FIELD_TO_FORM[backendField];
            if (!form) continue;   // '' is the whole-body rule ("must have at least 1 key")
            out.push({
                field: form,
                code: err?.code || 'VALIDATION_FAILED',
                // Joi's message quotes the wire field name at a human. Ours does not.
                message: BACKEND_FIELD_COPY[backendField] || trimmed(d?.message) || 'That value was rejected.',
            });
        }
    }

    if (out.length) return out;

    // The documented codes, for the paths that really do return them.
    const CODE_TO_FIELD = {
        TICKET_PRODUCT_CODE_REQUIRED: 'productCode',
        INVALID_TRACKING_URL: 'url',
        UNKNOWN_CARRIER: 'carrier',
        NO_TRACKING_INFORMATION: 'number',
        CONFLICTING_TRACKING_NUMBER: 'number',
    };
    const field = CODE_TO_FIELD[err?.code];
    return field ? [{ field, code: err.code, message: shippingErrorMessage(err) }] : [];
}

/**
 * Was this a lost race rather than a bad request?
 *
 * A 409 arrives from API.request() as a RESOLVED envelope (code preserved), not a
 * throw — so a page that only inspects thrown errors never sees one. The panel
 * refetches and KEEPS every typed value on this; it must not be folded in with
 * the 400s, which mean "fix the field".
 */
export function isConcurrencyConflict(err) {
    return err?.status === 409 || err?.code === 'CONFLICT' || err?.code === 409;
}

/** Did the backend refuse only because the order has not shipped yet? Offer the retry. */
export function isNotShippedRefusal(err) {
    return err?.code === 'ORDER_NOT_SHIPPED';
}

/**
 * What the response says actually happened to the email.
 *
 * `mark_shipped` without `send_email` STILL EMAILS ONCE — the dispatch
 * notification, same as the Update Status modal has always done — and reports
 * `reason: "auto_on_ship"`. An operator who did not tick the box has still just
 * emailed a customer, so the toast has to say so; silence here is how someone
 * learns about it from the customer.
 */
export function describeEmailOutcome(email) {
    if (!email || typeof email !== 'object') return null;
    if (email.sent === true) {
        return email.reason === 'auto_on_ship'
            ? 'The customer was emailed their shipping details automatically, because the order was marked shipped.'
            : 'The customer was emailed their shipping details.';
    }
    if (email.requested === true) {
        return email.reason
            ? `The email was not sent (${String(email.reason).replace(/_/g, ' ')}).`
            : 'The email was not sent.';
    }
    return null;
}
