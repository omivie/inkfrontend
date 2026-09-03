'use strict';

/**
 * Orders list — "Tracking requested" in the Invoice / tracking cell (Sep 2026, ERR-201)
 * =====================================================================================
 *
 * A customer who cannot see where their parcel is fills in the form at
 * /track-order. That writes an `order_tracking_requests` row, lights up the
 * standalone Tracking Requests page and the sidebar badge — and, until now,
 * nowhere else. The operator working the Orders list, which is where orders are
 * actually processed, got no signal: `2026090203` looked identical to the four
 * rows either side of it while that customer had been waiting since 2 September.
 *
 * THE HAND-OFF WAS TRUE THIS TIME, AND MEASURING IT WAS STILL THE JOB.
 * ---------------------------------------------------------------------
 * Unlike ERR-198 and ERR-199, whose hand-offs opened with a sentence that was
 * false, `readfirst/orders-tracking-requested-column-FE-handoff-sep2026.md`
 * described a contract that was live. Measured 2026-09-03, backend commit
 * 90ca2496, `db: connected`:
 *
 *   - `tracking_request` present on 154/154 order rows across all four pages,
 *     and on `GET /api/admin/orders/:id` too.
 *   - 7 open requests, all `state:"requested"`, all on website rows,
 *     reconciling 7/7 against `GET /api/admin/tracking-requests`.
 *   - `20260714000001` is CANCELLED with an open request against it.
 *   - The oldest has been open since 22 June.
 *
 * What the hand-off did not say is where the work is, and all three of those
 * things are pinned below:
 *
 *   1. TWO BRANCHES HAVE NEVER EXECUTED IN PRODUCTION. There has never been one
 *      `fulfilled` row (`?status=fulfilled` returns zero), so `Tracking sent`
 *      and the re-ask wording are held up by this file alone. That is exactly
 *      the standing the Invoices `xN` indicator had right up until it turned out
 *      never to have rendered once (ERR-180). §5 exists to say so out loud.
 *   2. EVERY FILTER PARAM IS A DECOY. `?tracking_request=`, `?tracking_requested=`,
 *      `?has_tracking_request=`, `?tracking_state=` and `?tracking=` are all
 *      accepted and ignored — `zzznope` returns the full 50-row page, while
 *      `?status=cancelled` really does filter to 16. So there is no server-side
 *      filter and the page must not pretend otherwise. Watched by the probe.
 *   3. THE GROUND TRUTH IS UNREADABLE FROM A BROWSER. `order_tracking_requests`
 *      has RLS on with no permissive policies, so PostgREST answers 200 with an
 *      empty array — a refusal wearing the costume of an answer (ERR-188).
 *
 * AND THE TRAP IS ERR-199's TRAP, AGAIN
 * -------------------------------------
 *     tracking_request absent  =>  undefined
 *     undefined !== null       =>  TRUE   // "there is a request" on every row
 *     undefined == null        =>  TRUE   // "nobody ever asked" on every row
 *
 * Both obvious readings are wrong in opposite directions, and the second is the
 * expensive one: it renders identically to a correct build, so a feature that
 * never works looks finished. §1 and §9 hold that shut.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   §1  the three-way parse — ABSENT / null / object, with both wrong gates named
 *   §2  the count rule and the re-ask rule (a 0 count is UNKNOWN, not zero)
 *   §3  `state` is the authority; order status only ever MUTES
 *   §4  the cell — every combination, including the stacking that must not
 *       suppress the invoice answer, and the rows that must be unchanged
 *   §5  the two branches with no live data
 *   §6  structural safety — the chip and the invoice cell cannot clobber each other
 *   §7  the page never reads `tracking_request` itself, and never infers state
 *   §8  escaping
 *   §9  POSITIVE CONTROLS — the wrong readings must FAIL
 *   §10 shipping hygiene — probe, npm script, APP_VERSION, CSS, both error logs
 *
 * Siblings: tests/admin-orders-invoice-sent-channel-sep2026.test.js (the other
 * half of this cell), tests/tracking-request-may2026.test.js (the queue page).
 * Live counterpart: `npm run probe:tracking-requested`.
 *
 * Run with: node --test tests/orders-tracking-requested-column-sep2026.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const READ = (p) => fs.readFileSync(p, 'utf8');

const TRACK_UTIL = path.join(ADMIN, 'utils', 'order-tracking-request.js');
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');
const APP = path.join(ADMIN, 'app.js');
const SECURITY = path.join(ROOT, 'inkcartridges', 'js', 'security.js');
const ADMIN_CSS = path.join(ROOT, 'inkcartridges', 'css', 'admin.css');
const TRACK_PAGE = path.join(ADMIN, 'pages', 'tracking-requests.js');
const SQL_DOC = path.join(ROOT, 'inkcartridges', 'sql', 'order_tracking_requests.sql');
const PROBE = path.join(ROOT, 'scripts', 'probe-tracking-requested-column.mjs');
const PKG = path.join(ROOT, 'package.json');
const HANDOFF = path.join(ROOT, 'readfirst', 'orders-tracking-requested-column-FE-handoff-sep2026.md');

const ordersSrc = READ(ORDERS_PAGE);
const utilSrc = READ(TRACK_UTIL);

/** The same stripEsm loader the sibling admin-util tests use. */
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
  stripped = stripped.replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*$/gm, '');
  stripped = stripped.replace(/export\s+\{[^}]*\}\s*;?/g, '');
  stripped = stripped.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  return stripped + '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
}

/** Slice a whole `function name(...) { … }` out of a source file, brace-matched. */
function functionSource(src, name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm'));
  assert.ok(start !== -1, `function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * The REAL escapeHtml, lifted out of js/security.js rather than re-typed.
 *
 * A hand-written stand-in would let §8 pass against an escaper that is not the
 * one production uses — which is how `window.Security` guards turned out to be
 * off switches (ERR-167). This one escapes `/` and backtick too, and the tests
 * below assert against that exact output.
 */
function loadEsc() {
  const src = READ(SECURITY);
  const ctx = { console, String, Object, JSON, RegExp, Array, Number, window: {}, document: undefined };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src.replace(/^\s*export\s+/gm, '') + '\n;this.__esc = (s) => Security.escapeHtml(String(s));',
    ctx, { filename: 'security.js' });
  assert.equal(typeof ctx.__esc, 'function', 'security.js did not yield an escaper');
  return ctx.__esc;
}
const ESC = loadEsc();

/**
 * Load the util, and — in the same context — the two renderers lifted verbatim
 * out of pages/orders.js. The renderers are evaluated as SOURCE from the shipped
 * file, never re-implemented, so a change to the page that this file does not
 * know about still runs through every assertion below.
 */
function loadAll(trackSource = utilSrc) {
  const sandbox = {
    console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp, Date,
    esc: ESC,
    MISSING: '—',
    window: { DebugLog: { warn() {}, log() {}, error() {} } },
    DebugLog: { warn() {}, log() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(stripEsm(trackSource), ctx, { filename: 'order-tracking-request.js' });
  vm.runInContext(functionSource(ordersSrc, 'trackingChipHtml'), ctx, { filename: 'trackingChipHtml' });
  vm.runInContext(functionSource(ordersSrc, 'modalTrackingValue'), ctx, { filename: 'modalTrackingValue' });
  vm.runInContext(functionSource(ordersSrc, 'noteTrackingRegime'), ctx, { filename: 'noteTrackingRegime' });
  return sandbox;
}

const M = loadAll();
const {
  TRACK_STATE, TRACK_REGIME, readTrackingRequest, readTrackingRequestFrom,
  trackingRequestRegime, resolveTrackingInfo, trackingChipCopy, waitingPhrase,
  parseStamp, shortStamp, fullStamp, trackingChipHtml, modalTrackingValue,
} = M;

/** Fixed clock, so "N days waiting" is a fact rather than a moving target. */
const NOW = new Date('2026-09-03T12:00:00.000Z');
const at = (order, orderStatus) => resolveTrackingInfo({ order, orderStatus, now: NOW });

// Rows exactly as live production returns them (verified 2026-09-03).
const LIVE_OPEN = Object.freeze({
  id: '8be265ca-b6ad-4565-a4c7-bf33dd9f7bbe', order_number: '2026090203', status: 'paid',
  channel: 'web', invoice_sent: null,
  tracking_request: Object.freeze({
    state: 'requested', requested_at: '2026-09-02T07:29:38.364216+00:00',
    sent_at: null, request_count: 1,
  }),
});
const LIVE_CANCELLED = Object.freeze({
  id: 'cancelled-row', order_number: '20260714000001', status: 'cancelled',
  channel: 'web', invoice_sent: null,
  tracking_request: Object.freeze({
    state: 'requested', requested_at: '2026-07-13T19:57:54.015444+00:00',
    sent_at: null, request_count: 1,
  }),
});
const LIVE_QUIET = Object.freeze({
  id: 'quiet-row', order_number: '2026090205', status: 'paid',
  channel: 'web', invoice_sent: null, tracking_request: null,
});
const LIVE_INVOICE = Object.freeze({
  id: 'invoice-row', order_number: 'INV-3278', status: 'paid', channel: 'invoice',
  invoice_sent: Object.freeze({ sent_at: '2026-09-01T22:47:59.523351+00:00', sent_count: 1, source: 'send_log' }),
  tracking_request: null,
});
/** A backend that has not deployed the change: the key is not there at all. */
const PRE_DEPLOY_ROW = Object.freeze({ id: 'old', order_number: '2026090205', status: 'paid' });

// ═══ §1  THE THREE-WAY PARSE ═══════════════════════════════════════════════
test('§1 absent, null and an object are three different claims', async (t) => {
  await t.test('ABSENT key — we know nothing, and it is not "nobody asked"', () => {
    const r = readTrackingRequest(PRE_DEPLOY_ROW);
    assert.equal(r.present, false, 'the key is not on the row');
    assert.equal(r.state, TRACK_STATE.UNKNOWN);
    assert.notEqual(r.state, TRACK_STATE.NONE, 'UNKNOWN must never collapse into NONE');
    assert.notEqual(r.state, TRACK_STATE.REQUESTED, 'and must never invent a request');
  });

  await t.test('null — the backend looked, and this customer never asked', () => {
    const r = readTrackingRequest(LIVE_QUIET);
    assert.equal(r.present, true, 'the key IS on the row — that is the regime signal');
    assert.equal(r.state, TRACK_STATE.NONE);
  });

  await t.test('an object — the answer itself', () => {
    const r = readTrackingRequest(LIVE_OPEN);
    assert.equal(r.present, true);
    assert.equal(r.state, TRACK_STATE.REQUESTED);
    assert.equal(r.requestedAt, '2026-09-02T07:29:38.364216+00:00');
    assert.equal(r.sentAt, null);
  });

  await t.test('`undefined !== null` is TRUE — the literal Rule-1 gate is wrong', () => {
    assert.equal(undefined !== null, true, 'the language fact this whole file guards');
    // Written out literally, that gate would mark the pre-deploy row as carrying
    // a request and print an outstanding task on all 154 of them.
    assert.equal(PRE_DEPLOY_ROW.tracking_request !== null, true, 'the naive gate says "has a request"');
    assert.equal(readTrackingRequest(PRE_DEPLOY_ROW).state, TRACK_STATE.UNKNOWN, 'the real reader does not');
  });

  await t.test('`undefined == null` is ALSO TRUE — and its correction is worse', () => {
    assert.equal(undefined == null, true);   // eslint-disable-line eqeqeq
    // This one collapses ABSENT into "nobody asked", which renders EXACTLY like
    // a working build. It is the reading that ships a dead feature.
    assert.equal(PRE_DEPLOY_ROW.tracking_request == null, true);   // eslint-disable-line eqeqeq
    assert.equal(LIVE_QUIET.tracking_request == null, true);       // eslint-disable-line eqeqeq
    // Same answer from the naive gate, two different truths from the real one.
    assert.notEqual(
      readTrackingRequest(PRE_DEPLOY_ROW).state,
      readTrackingRequest(LIVE_QUIET).state,
      'ABSENT and null must not resolve to the same state',
    );
  });

  await t.test('the detection is hasOwnProperty, in the source, not truthiness', () => {
    assert.match(utilSrc, /Object\.prototype\.hasOwnProperty\.call\(order, 'tracking_request'\)/);
  });

  await t.test('a key holding undefined is the PRESENT case, sloppily made', () => {
    const r = readTrackingRequest({ tracking_request: undefined });
    assert.equal(r.present, true, 'the key exists, so the field has shipped');
    assert.equal(r.state, TRACK_STATE.NONE);
  });

  await t.test('unreadable values are UNREADABLE, never "no request"', () => {
    for (const bad of ['yes', 7, true, [], [{ state: 'requested' }]]) {
      const r = readTrackingRequest({ tracking_request: bad });
      assert.equal(r.malformed, true, `${JSON.stringify(bad)} must be malformed`);
      assert.equal(r.state, TRACK_STATE.UNREADABLE);
      assert.notEqual(r.state, TRACK_STATE.NONE, 'a parse failure must not assert an absence');
    }
  });

  await t.test('a state we have no wording for is UNREADABLE, not a guess', () => {
    const r = readTrackingRequest({ tracking_request: { state: 'escalated' } });
    assert.equal(r.state, TRACK_STATE.UNREADABLE);
  });

  await t.test('`dismissed` is recognised BEFORE the backend can send it', () => {
    // Pre-shaped deliberately: the day the dismiss migration lands, an
    // unrecognised value would splash "Tracking unknown" across the Orders page
    // as the RESULT of a backend fix.
    const r = readTrackingRequest({ tracking_request: { state: 'dismissed', requested_at: '2026-07-13T19:57:54Z' } });
    assert.equal(r.state, TRACK_STATE.DISMISSED);
    assert.equal(r.malformed, false);
  });

  await t.test('state is matched case- and whitespace-insensitively', () => {
    assert.equal(readTrackingRequest({ tracking_request: { state: ' Requested ' } }).state, TRACK_STATE.REQUESTED);
  });

  await t.test('a garbage row is UNKNOWN, and never throws', () => {
    for (const junk of [null, undefined, 'order', 42, []]) {
      assert.equal(readTrackingRequest(junk).state, TRACK_STATE.UNKNOWN);
    }
  });

  await t.test('the regime is decided by ANY row carrying the key', () => {
    assert.equal(trackingRequestRegime([PRE_DEPLOY_ROW, LIVE_QUIET]), TRACK_REGIME.SERVER,
      'one row with the key proves the deploy landed');
    assert.equal(trackingRequestRegime([PRE_DEPLOY_ROW]), TRACK_REGIME.UNAVAILABLE);
    assert.equal(trackingRequestRegime([]), TRACK_REGIME.UNAVAILABLE);
    assert.equal(trackingRequestRegime(LIVE_OPEN), TRACK_REGIME.SERVER, 'a bare row is accepted too');
  });

  await t.test('readTrackingRequestFrom walks candidates until one HAS the key', () => {
    // The live shape of the disagreement: the detail payload carries
    // tracking_request, the list row carries invoice_sent, neither carries both.
    assert.equal(readTrackingRequestFrom(PRE_DEPLOY_ROW, LIVE_OPEN).state, TRACK_STATE.REQUESTED,
      'an absent contract is a reason to look at the next payload');
    assert.equal(readTrackingRequestFrom(LIVE_QUIET, LIVE_OPEN).state, TRACK_STATE.NONE,
      'but a payload that HAS the key answers, even when the answer is null');
    assert.equal(readTrackingRequestFrom(null, undefined).state, TRACK_STATE.UNKNOWN);
  });
});

// ═══ §2  THE COUNT, AND THE RE-ASK ═════════════════════════════════════════
test('§2 a count we cannot trust is UNKNOWN, not zero', async (t) => {
  const withCount = (request_count, extra = {}) => readTrackingRequest({
    tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: null, request_count, ...extra },
  });

  await t.test('0 / missing / NaN / negative beside a real request ⇒ countKnown false', () => {
    for (const bad of [0, undefined, null, 'two', NaN, -3]) {
      const r = withCount(bad);
      assert.equal(r.countKnown, false, `request_count ${JSON.stringify(bad)} must not be believed`);
      // …and the FLOOR still stands: there is demonstrably one ask on record.
      assert.equal(r.count, 1, 'a request proves at least one ask even when the tally is unusable');
    }
  });

  await t.test('a real tally is believed, and floored to an integer', () => {
    assert.deepEqual(
      [withCount(1).countKnown, withCount(1).count, withCount(3).count, withCount(2.7).count],
      [true, 1, 3, 2],
    );
  });

  await t.test('re-ask: sent_at underneath an OPEN request (hand-off Rule 2)', () => {
    const r = readTrackingRequest({
      tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: '2026-08-02T03:04:05Z', request_count: 2 },
    });
    assert.equal(r.repeat, true);
    assert.equal(r.state, TRACK_STATE.REQUESTED, 'still outstanding — sent_at does not close it');
  });

  await t.test('re-ask: a tally of 2+ proves it too', () => {
    assert.equal(withCount(2).repeat, true, 'one pending row max, so 2 asks means one was answered');
    assert.equal(withCount(1).repeat, false);
  });

  await t.test('a SENT request is never a re-ask', () => {
    const r = readTrackingRequest({
      tracking_request: { state: 'sent', requested_at: '2026-08-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 2 },
    });
    assert.equal(r.repeat, false, 'repeat describes an OUTSTANDING ask, not a closed one');
  });

  await t.test('the ordinal is printed only from a tally we trust', () => {
    const trusted = trackingChipCopy(at({ status: 'paid', tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 3 } }));
    assert.match(trusted.tip, /ask number 3/);

    const untrusted = trackingChipCopy(at({ status: 'paid', tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 0 } }));
    assert.equal(untrusted.label, 'Tracking requested again', 'still a re-ask — sent_at proves it');
    assert.doesNotMatch(untrusted.tip, /ask number/, 'but the number itself was never recorded');
    assert.doesNotMatch(untrusted.tip, /\b0\b/, '"ask number 0" is a number we would be inventing');
  });
});

// ═══ §3  STATE IS THE AUTHORITY ════════════════════════════════════════════
test('§3 `state` is the authority; order status only ever mutes', async (t) => {
  await t.test('a shipped order WITH tracking can still have an open request', () => {
    // Hand-off Rule 1, spelled out: the email is what closes a request, not the
    // presence of a tracking number.
    const r = at({ status: 'shipped', tracking_number: 'ABC123', carrier: 'nz_couriers',
      tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: null, request_count: 1 } });
    assert.equal(r.state, TRACK_STATE.REQUESTED);
    assert.equal(r.muted, false, 'a shipped order can still be answered');
  });

  await t.test('an unshipped order with NO tracking can already be answered', () => {
    const r = at({ status: 'paid', tracking_number: null,
      tracking_request: { state: 'sent', requested_at: '2026-08-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 1 } });
    assert.equal(r.state, TRACK_STATE.SENT);
  });

  await t.test('CANCELLED mutes an outstanding request — and does not change its state', () => {
    const r = at(LIVE_CANCELLED);
    assert.equal(r.muted, true, 'hand-off Rule 4');
    assert.equal(r.state, TRACK_STATE.REQUESTED, '"the customer asked" stays true either way');
  });

  await t.test('CANCELLED does not mute an already-answered request', () => {
    const r = at({ status: 'cancelled',
      tracking_request: { state: 'sent', requested_at: '2026-08-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 1 } });
    assert.equal(r.muted, false, 'there is nothing left to mute');
  });

  await t.test('refunded is NOT muted — the rule the backend wrote names cancelled', () => {
    const r = at({ status: 'refunded',
      tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: null, request_count: 1 } });
    assert.equal(r.muted, false, 'a refunded order may well have shipped first');
  });

  await t.test('status is compared case-insensitively', () => {
    assert.equal(at({ ...LIVE_CANCELLED, status: 'Cancelled' }).muted, true);
  });

  await t.test('waitingDays measures the OPEN request (Rule 3), clamped at zero', () => {
    assert.equal(at(LIVE_OPEN).waitingDays, 1);
    assert.ok(at(LIVE_CANCELLED).waitingDays > 40, 'the live cancelled one is weeks old');
    // Clock skew must not produce "-1 days waiting".
    const future = at({ status: 'paid', tracking_request: { state: 'requested', requested_at: '2026-09-04T00:00:00Z', sent_at: null, request_count: 1 } });
    assert.equal(future.waitingDays, 0);
  });

  await t.test('an unparseable date loses the date, never the request', () => {
    const r = at({ status: 'paid', tracking_request: { state: 'requested', requested_at: 'not-a-date', sent_at: null, request_count: 1 } });
    assert.equal(r.state, TRACK_STATE.REQUESTED, 'the chip must still render');
    assert.equal(r.requestedAt, null);
    assert.equal(r.waitingDays, null);
  });

  await t.test('the six-digit-fraction +00:00 stamps live production sends do parse', () => {
    // 2026-09-02T07:29:38.364216+00:00 — six fractional digits where ECMAScript
    // specifies three. Every engine handles it; none of them promise to.
    assert.ok(parseStamp('2026-09-02T07:29:38.364216+00:00') instanceof Date);
    assert.ok(shortStamp('2026-09-02T07:29:38.364216+00:00'));
    assert.ok(fullStamp('2026-09-02T07:29:38.364216+00:00'));
  });

  await t.test('"Invalid Date" is never returned as a date string', () => {
    for (const bad of ['nonsense', '', null, undefined, {}]) {
      assert.equal(shortStamp(bad), null, `shortStamp(${JSON.stringify(bad)})`);
      assert.equal(fullStamp(bad), null, `fullStamp(${JSON.stringify(bad)})`);
    }
  });

  await t.test('waitingPhrase pluralises, and says nothing on day zero', () => {
    assert.equal(waitingPhrase(0), null, '"0 days waiting" reads as a bug');
    assert.equal(waitingPhrase(1), '1 day waiting');
    assert.equal(waitingPhrase(73), '73 days waiting');
    assert.equal(waitingPhrase(null), null);
  });
});

// ═══ §4  THE CELL ══════════════════════════════════════════════════════════
test('§4 the cell — both facts render, and the quiet rows do not change', async (t) => {
  await t.test('an outstanding request: amber pill, dated, aged', () => {
    const html = trackingChipHtml(LIVE_OPEN, NOW);
    assert.match(html, /order-track--requested/);
    assert.match(html, /Tracking requested</);
    assert.match(html, /1 day waiting/);
    assert.match(html, /data-order-track="8be265ca-b6ad-4565-a4c7-bf33dd9f7bbe"/);
  });

  await t.test('a cancelled row is MUTED, not hidden', () => {
    const html = trackingChipHtml(LIVE_CANCELLED, NOW);
    assert.match(html, /order-track--stuck/);
    assert.match(html, /Tracking requested</, 'the customer really did ask');
    assert.doesNotMatch(html, /order-track--empty/, 'muting is not hiding');
    assert.match(html, /cannot clear itself/, 'and the cell says why there is nothing to do');
  });

  await t.test('no request, and a backend that has not deployed, both render nothing', () => {
    for (const row of [LIVE_QUIET, PRE_DEPLOY_ROW]) {
      const html = trackingChipHtml(row);
      assert.match(html, /order-track--empty/);
      assert.doesNotMatch(html, /Tracking/, 'no words at all on a row with nothing to say');
      assert.match(html, /data-order-track=/, 'but the hook is still addressable');
    }
  });

  await t.test('STACKING — an invoice send is never suppressed by a tracking chip', () => {
    // The hand-off offered precedence, where the chip hides the invoice answer.
    // Both facts are true; one does not cancel the other.
    const both = { ...LIVE_INVOICE, tracking_request: LIVE_OPEN.tracking_request };
    const html = trackingChipHtml(both);
    assert.match(html, /Tracking requested</);
    // The invoice half is a separate root, so it is untouched by construction —
    // pinned structurally in §6 rather than by re-rendering sentCellHtml here.
    assert.doesNotMatch(html, /data-order-sent/, 'the chip must not own the invoice hook');
  });

  await t.test('a same-day request shows its date and no age', () => {
    const html = trackingChipHtml({ id: 'x', status: 'paid',
      tracking_request: { state: 'requested', requested_at: NOW.toISOString(), sent_at: null, request_count: 1 } }, NOW);
    assert.match(html, /Tracking requested</);
    // Checked on the SUB-LINE, not the whole cell: the tooltip legitimately uses
    // the word "waiting" in its sentence, and matching the raw HTML would make
    // this assertion pass or fail on the prose rather than on the age.
    const when = (html.match(/order-track__when">([^<]*)</) || [])[1] || '';
    // Compared against the util's own formatting rather than a hard-coded
    // '3 Sept': the runner's timezone decides which calendar day a UTC instant
    // falls on, so pinning the literal would fail in London for reasons that
    // have nothing to do with this feature. What is asserted is that the
    // sub-line is the date ALONE, with no age appended to it.
    assert.equal(when, shortStamp(NOW.toISOString()), 'the date, and nothing about days');
    assert.doesNotMatch(when, /waiting/, 'nobody has been waiting days yet');
  });

  await t.test('unreadable renders visibly, and never as a blank cell', () => {
    const html = trackingChipHtml({ id: 'x', status: 'paid', tracking_request: 'yes' });
    assert.match(html, /order-track--unreadable/);
    assert.match(html, /Tracking unknown/);
    assert.doesNotMatch(html, /order-track--empty/, 'a parse failure must not look like "nobody asked"');
  });

  await t.test('the modal spells the same sentence the tooltip carries', () => {
    const info = at(LIVE_OPEN);
    const copy = trackingChipCopy(info);
    const modal = modalTrackingValue(info);
    assert.match(modal, /order-track__pill/, 'the same pill the list cell renders');
    assert.match(modal, /order-track--requested/);
    assert.ok(modal.includes(ESC(copy.tip)), 'ONE vocabulary — the modal prints the tooltip, not a paraphrase');
  });

  await t.test('the modal always answers, including "nobody asked" and "cannot check"', () => {
    const none = modalTrackingValue(at(LIVE_QUIET));
    assert.match(none, /no tracking request/);

    const unknown = modalTrackingValue(at(PRE_DEPLOY_ROW));
    assert.match(unknown, /Can.{0,8}t check/, 'an unanswered question is not an answer of no');
    assert.doesNotMatch(unknown, /no tracking request/, 'and must not be worded as one');

    assert.match(modalTrackingValue(null), /Can.{0,8}t check/, 'a missing info object is still not "no"');
  });

  await t.test('the column is renamed, keeps its key, and stays unsortable and gst-free', () => {
    const col = ordersSrc.slice(ordersSrc.indexOf("key: '_invoice_sent'"));
    const body = col.slice(0, col.indexOf('},'));
    assert.match(body, /label: 'Invoice \/ tracking'/);
    assert.match(body, /className: 'cell-invoice-track'/);
    assert.doesNotMatch(body, /\bgst:/, 'a date must not borrow the money vocabulary');
    assert.doesNotMatch(body, /sortable/, 'the tracking date is not a backend sort key either');
    assert.match(body, /trackingChipHtml\(r\) \+ sentCellHtml\(r/, 'chip first — it is the actionable half');
  });
});

// ═══ §5  THE BRANCHES WITH NO LIVE DATA ════════════════════════════════════
test('§5 two branches have never executed in production', async (t) => {
  // As of 2026-09-03 there has never been a single `fulfilled` tracking request:
  // GET /api/admin/tracking-requests?status=fulfilled returns zero rows, and all
  // 7 live requests are `pending` with request_count 1. So everything below is
  // held up by this file and nothing else — the same standing the Invoices `xN`
  // indicator had for the eight months it never once rendered (ERR-180).
  // `npm run probe:tracking-requested` reprints this fact on every run.

  await t.test('Tracking sent — NO LIVE DATA', () => {
    const html = trackingChipHtml({ id: 'x', status: 'shipped',
      tracking_request: { state: 'sent', requested_at: '2026-08-01T00:00:00Z', sent_at: '2026-08-02T03:04:05Z', request_count: 1 } });
    assert.match(html, /order-track--done/);
    assert.match(html, /Tracking sent</);
    assert.doesNotMatch(html, /waiting/, 'nobody is waiting on an answered request');
  });

  await t.test('Tracking requested again — NO LIVE DATA', () => {
    const html = trackingChipHtml({ id: 'x', status: 'paid',
      tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: '2026-08-02T03:04:05Z', request_count: 2 } });
    assert.match(html, /Tracking requested again/);
    assert.match(html, /order-track--requested/, 'a re-ask is still outstanding, so still amber');
  });

  await t.test('Tracking dismissed — NO LIVE DATA, and no backend that can produce it yet', () => {
    const html = trackingChipHtml({ id: 'x', status: 'cancelled',
      tracking_request: { state: 'dismissed', requested_at: '2026-07-13T19:57:54Z', sent_at: null, request_count: 1 } });
    assert.match(html, /order-track--done/);
    assert.match(html, /Tracking dismissed/);
  });

  await t.test('the fact is written down where someone will read it', () => {
    assert.match(utilSrc, /NEVER EXECUTED IN PRODUCTION/,
      'the module header must keep saying which branches are unproven');
  });
});

// ═══ §6  STRUCTURAL SAFETY ═════════════════════════════════════════════════
test('§6 the chip and the invoice cell cannot clobber one another', async (t) => {
  const chipFn = functionSource(ordersSrc, 'trackingChipHtml');
  const sentFn = functionSource(ordersSrc, 'sentCellHtml');
  const patchFn = functionSource(ordersSrc, 'patchSentCell');

  await t.test('patchSentCell replaces `[data-order-sent]` by outerHTML', () => {
    // This is the constraint the whole split exists to respect. If it ever stops
    // being an outerHTML swap, re-read trackingChipHtml's header before merging
    // the two renderers back together.
    assert.match(patchFn, /data-order-sent="\$\{CSS\.escape/);
    assert.match(patchFn, /cell\.outerHTML = sentCellHtml/);
  });

  await t.test('the chip never emits the invoice hook, and vice versa', () => {
    assert.doesNotMatch(chipFn, /data-order-sent/, 'the chip must not be patchable as the invoice cell');
    assert.doesNotMatch(sentFn, /data-order-track/, 'and the invoice cell must not own the chip hook');
  });

  await t.test('every chip is exactly one root element carrying exactly one hook', () => {
    for (const row of [LIVE_OPEN, LIVE_CANCELLED, LIVE_QUIET, PRE_DEPLOY_ROW,
      { id: 'u', status: 'paid', tracking_request: 'yes' },
      { id: 's', status: 'shipped', tracking_request: { state: 'sent', requested_at: '2026-08-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 1 } }]) {
      const html = trackingChipHtml(row, NOW);
      assert.equal((html.match(/data-order-track=/g) || []).length, 1,
        `exactly one hook for ${row.id}`);
      assert.ok(html.startsWith('<span class="order-track'), `single root for ${row.id}`);
      assert.equal((html.match(/<span/g) || []).length, (html.match(/<\/span>/g) || []).length,
        `balanced spans for ${row.id}`);
    }
  });

  await t.test('the age is computed from an injectable clock, not the wall clock', () => {
    // Otherwise "N days waiting" is untestable and the assertions become a coin
    // toss that occasionally reports a bug that is not there.
    assert.match(chipFn, /function trackingChipHtml\(row, now = null\)/);
    assert.match(chipFn, /resolveTrackingInfo\(\{ order: row, now \}\)/);
  });

  await t.test('the chip needs no cache, no fetch and no abort controller', () => {
    // Copying hydrateInvoiceSent's fan-out here would issue one pointless request
    // per row for a field already on the payload.
    assert.doesNotMatch(chipFn, /await|AdminAPI|fetch|AbortController|_trackCache/);
  });

  await t.test('the regime is reported loudly when the field is absent', () => {
    const noteFn = functionSource(ordersSrc, 'noteTrackingRegime');
    assert.match(noteFn, /DebugLog\?\.warn/);
    assert.match(noteFn, /probe:tracking-requested/, 'a warning must name the way to check');
    assert.match(noteFn, /NOT "nobody asked"/, 'and must name what it is NOT');
    assert.match(ordersSrc, /^\s*noteTrackingRegime\(rows\);/m, 'and it is actually called');
  });
});

// ═══ §7  THE PAGE DOES NOT KEEP ITS OWN COPY ═══════════════════════════════
test('§7 one vocabulary — the page reads the util, never the field', async (t) => {
  await t.test('pages/orders.js never touches `tracking_request` directly', () => {
    // A second reader is a second place for the absent/null/object distinction to
    // be got wrong, and it would be got wrong in a file where nobody is looking
    // for it. Every read goes through utils/order-tracking-request.js.
    const codeOnly = ordersSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
      .replace(/^\s*\/\/.*$/gm, '');          // line comments
    assert.doesNotMatch(codeOnly, /\.tracking_request\b/,
      'read it through readTrackingRequest / readTrackingRequestFrom');
    assert.doesNotMatch(codeOnly, /\['tracking_request'\]/);
  });

  await t.test('nothing derives tracking state from order.status or tracking_number', () => {
    // Hand-off Rule 1. The util is the only file allowed an opinion about
    // order status, and its only opinion is MUTING.
    const utilCode = utilSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(utilCode, /tracking_number/,
      'a tracking number on the order proves nothing about the request');
    assert.match(utilCode, /UNCLEARABLE_STATUSES/, 'the one status rule is named and scoped');
  });

  await t.test('the util is imported bare — a `?v=` token would double-boot it', () => {
    assert.match(ordersSrc, /from '\.\.\/utils\/order-tracking-request\.js'/);
    assert.doesNotMatch(ordersSrc, /order-tracking-request\.js\?v=/);
  });

  await t.test('the sidebar count is refreshed by every path that can clear a request', () => {
    assert.match(ordersSrc, /refreshTrackingRequestsBadge/, 'imported from app.js');
    assert.match(ordersSrc, /function refreshTrackingCount\(\)/);
    // Four call sites: shipSave, the mark-shipped-and-send retry, the explicit
    // send, and the Update Status transition to shipped.
    assert.ok((ordersSrc.match(/refreshTrackingCount\(\);/g) || []).length >= 4,
      'every send path that can fulfil a request must refresh the badge');
  });

  await t.test('the explicit send now reloads the list — it did not have to before', () => {
    // A pure send used to change nothing on the row. It can now clear a tracking
    // request, so the row has to be re-read. From the BACKEND, not patched here:
    // the backend gates fulfilment on the send returning true, and assuming the
    // transition would be asserting an outcome we did not witness.
    const send = functionSource(ordersSrc, 'shipSend');
    assert.match(send, /loadOrders\(\);/);
    assert.match(send, /refreshTrackingCount\(\);/);
    assert.match(send, /data\?\.email\?\.sent === false/, 'and only when the email actually went');
  });
});

// ═══ §8  ESCAPING ══════════════════════════════════════════════════════════
test('§8 everything interpolated is escaped', async (t) => {
  await t.test('a hostile id cannot break out of the hook attribute', () => {
    const html = trackingChipHtml({ id: '"><script>alert(1)</script>', status: 'paid', tracking_request: null });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&quot;/);
  });

  await t.test('a hostile order status cannot reach the markup', () => {
    const html = trackingChipHtml({ id: 'x', status: '"><img src=x onerror=1>',
      tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: null, request_count: 1 } });
    assert.doesNotMatch(html, /<img/);
  });

  await t.test('the renderers call esc on every interpolation', () => {
    const chipFn = functionSource(ordersSrc, 'trackingChipHtml');
    // Every `${…}` in the returned template literals is either a literal esc(…)
    // call or a pre-escaped local.
    const interps = chipFn.match(/\$\{[^}]*\}/g) || [];
    for (const i of interps) {
      assert.ok(/esc\(|^\$\{id\}$|^\$\{sub\}$/.test(i), `unescaped interpolation: ${i}`);
    }
  });

  await t.test('the util emits plain text and never escapes or marks up', () => {
    // The renderer owns escaping. A util that half-escaped would produce
    // double-escaped text the moment a renderer did its job.
    assert.doesNotMatch(utilSrc.replace(/\/\*[\s\S]*?\*\//g, ''), /&amp;|&quot;|<span|escapeHtml/);
  });
});

// ═══ §9  POSITIVE CONTROLS ═════════════════════════════════════════════════
test('§9 POSITIVE CONTROL — the wrong readings must FAIL', async (t) => {
  /** Rebuild the real module with one line broken, through the real loader. */
  const broken = (find, replace, label) => {
    assert.ok(utilSrc.includes(find), `positive control [${label}] no longer matches the source`);
    return loadAll(utilSrc.replace(find, replace));
  };
  const mustFail = (fn, why) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert.ok(threw, `POSITIVE CONTROL DID NOT FIRE: ${why}`);
  };

  await t.test('the `!== null` gate must fail §1', () => {
    const B = broken(
      `if (!Object.prototype.hasOwnProperty.call(order, 'tracking_request')) return { ...absent };`,
      `if (order.tracking_request === null || order.tracking_request === undefined) { /* wrong */ }`,
      '!== null gate');
    mustFail(() => {
      assert.equal(B.readTrackingRequest(PRE_DEPLOY_ROW).state, TRACK_STATE.UNKNOWN);
    }, 'an absent field read as a real value');
  });

  await t.test('the `== null` gate must fail §1 — it collapses ABSENT into NONE', () => {
    const B = broken(
      `if (!Object.prototype.hasOwnProperty.call(order, 'tracking_request')) return { ...absent };`,
      `if (order.tracking_request == null) return { ...absent, present: true, state: TRACK_STATE.NONE };`,
      '== null gate');
    mustFail(() => {
      assert.notEqual(
        B.readTrackingRequest(PRE_DEPLOY_ROW).state,
        B.readTrackingRequest(LIVE_QUIET).state,
      );
    }, 'ABSENT and null resolved to the same state — the reading that ships a dead feature');
  });

  await t.test('believing any finite count must fail §2', () => {
    const B = broken(
      `const countKnown = Number.isFinite(n) && n >= 1;`,
      `const countKnown = Number.isFinite(n);`,
      'countKnown floor');
    mustFail(() => {
      assert.equal(B.readTrackingRequest({
        tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 0 },
      }).countKnown, false);
    }, 'a zero count was believed — ERR-180, printed as an ordinal');
  });

  await t.test('muting from the request instead of the order must fail §3', () => {
    const B = broken(
      `const muted = read.state === TRACK_STATE.REQUESTED && UNCLEARABLE_STATUSES.includes(status);`,
      `const muted = false;`,
      'cancelled muting');
    mustFail(() => {
      assert.equal(B.resolveTrackingInfo({ order: LIVE_CANCELLED, now: NOW }).muted, true);
    }, 'a cancelled order kept an actionable amber chip nobody can action');
  });

  await t.test('dropping the re-ask signal must fail §2', () => {
    const B = broken(
      `    && (sentAt !== null || (countKnown && n >= 2));`,
      `    && false;`,
      'repeat detection');
    mustFail(() => {
      assert.equal(B.readTrackingRequest({
        tracking_request: { state: 'requested', requested_at: '2026-09-01T00:00:00Z', sent_at: '2026-08-02T00:00:00Z', request_count: 2 },
      }).repeat, true);
    }, 'a customer asking a second time read as a first ask');
  });

  await t.test('the controls are running against the REAL module, not a stub', () => {
    // If loadAll ever stopped evaluating the source, every mustFail above would
    // pass vacuously. Prove the loader still produces working functions.
    assert.equal(typeof readTrackingRequest, 'function');
    assert.equal(readTrackingRequest(LIVE_OPEN).state, TRACK_STATE.REQUESTED);
    assert.equal(typeof trackingChipHtml, 'function');
  });
});

// ═══ §10  SHIPPING HYGIENE ═════════════════════════════════════════════════
test('§10 shipping hygiene', async (t) => {
  await t.test('the hand-off is committed where the next reader will find it', () => {
    assert.ok(fs.existsSync(HANDOFF), 'readfirst/orders-tracking-requested-column-FE-handoff-sep2026.md');
  });

  await t.test('the probe exists and is wired to an npm script', () => {
    assert.ok(fs.existsSync(PROBE), 'scripts/probe-tracking-requested-column.mjs');
    const pkg = JSON.parse(READ(PKG));
    assert.equal(pkg.scripts['probe:tracking-requested'], 'node scripts/probe-tracking-requested-column.mjs');
  });

  await t.test('the probe is READ-ONLY and says so', () => {
    const probe = READ(PROBE);
    assert.match(probe, /MODE: READ-ONLY/, 'the mode is printed on every run');
    // Checked as "there is no flag parsing at all" rather than "the string
    // --record is absent": the prose has to be able to EXPLAIN why no such mode
    // exists (sweep:b2b ate a committed fixture on 2026-08-12 and that is the
    // reason), and a grep for the literal would forbid saying so. Looking for
    // argv is also the stricter check — it catches a recording mode spelled any
    // other way.
    assert.doesNotMatch(probe, /process\.argv/, 'no flags: a probe that can record can overwrite what it compares against');
    // Every request is a GET except the Supabase sign-in.
    const posts = probe.match(/method:\s*'POST'/g) || [];
    assert.equal(posts.length, 1, 'exactly one POST — the sign-in');
  });

  await t.test('the probe refuses the RLS-shadowed table by name', () => {
    const probe = READ(PROBE);
    assert.match(probe, /order_tracking_requests/);
    assert.match(probe, /ERR-188|RLS/, 'and explains why a 200 with zero rows is not an absence');
  });

  await t.test('APP_VERSION moved — it is the only thing that busts pages/*.js', () => {
    assert.match(READ(APP), /const APP_VERSION = '[^']*tracking-requested/);
  });

  await t.test('the CSS states exist, in both decks', () => {
    const css = READ(ADMIN_CSS);
    for (const cls of ['.order-track', '.order-track--empty', '.order-track__pill', '.order-track__when',
      '.order-track--requested', '.order-track--stuck', '.order-track--done', '.order-track--unreadable',
      '.cell-invoice-track']) {
      assert.ok(css.includes(cls), `missing ${cls}`);
    }
    assert.match(css, /\[data-theme="light"\] \.order-track--done/,
      '--success under-contrasts on the light deck');
  });

  await t.test('a chip suppresses the invoice em-dash, and nothing else', () => {
    const css = READ(ADMIN_CSS);
    // Only the "not applicable" dash, only when a chip is present. Done as a
    // sibling selector so neither renderer has to know about the other's state.
    assert.match(css, /\.order-track:not\(\.order-track--empty\) \+ \.order-sent--na \{ display: none; \}/);
    // FAILED must never be hidden by anything — a lookup that did not complete
    // has to stay visible however busy the cell gets.
    assert.doesNotMatch(css, /\.order-track[^\n]*\+ \.order-sent--failed/);
    assert.doesNotMatch(css, /\.order-track[^\n]*\+ \.order-sent--none/);
  });

  await t.test('the empty chip occupies no space but stays in the DOM', () => {
    const css = READ(ADMIN_CSS);
    assert.match(css, /\.order-track--empty \{ display: none; \}/);
  });

  await t.test('ERR-201 is written up in BOTH error logs, under one number', () => {
    const pub = READ(path.join(ROOT, 'errors.md'));
    assert.match(pub, /ERR-201/, 'errors.md');
    const mem = path.join(ROOT, '.claude', 'memory', 'errors.md');
    if (fs.existsSync(mem)) assert.match(READ(mem), /ERR-201/, '.claude/memory/errors.md');
  });

  await t.test('the FE response to the backend is written', () => {
    const resp = path.join(ROOT, 'orders-tracking-requested-column-FE-response-sep2026.md');
    assert.ok(fs.existsSync(resp), 'the dismiss endpoint has to be asked for somewhere durable');
    assert.match(READ(resp), /dismiss/i);
  });

  await t.test('the stale "clears itself" promises are corrected', () => {
    // Fulfilment is gated on an email ACTUALLY going out — flipping an order to
    // shipped with no tracking number emails nothing and leaves the request open.
    assert.match(READ(SQL_DOC), /GATED ON AN EMAIL ACTUALLY GOING OUT/);
    assert.match(READ(TRACK_PAGE), /ONLY\s*\n?\s*\*?\s*IF THE EMAIL ACTUALLY GOES OUT/);
  });
});
