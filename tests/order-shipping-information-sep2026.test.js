'use strict';

/**
 * Shipping Information section + NZ Couriers (Sep 2026, ERR-200)
 * ==============================================================================
 *
 * The backend hand-off (readfirst/shipping-information-section-FE-handoff-sep2026.md)
 * was, unusually, ACCURATE — every endpoint and field in it was measured against
 * live production before a line was written, and all of it was there. What it did
 * not describe is what the live DATA looks like, and that is where the traps are:
 *
 *   - 4 of the 13 shipped orders report `email.send_count: 0` with
 *     `last_status: null` while being shipped — and dispatch emails the customer
 *     automatically. Those sends predate the log. `send_count: 0` on a shipped
 *     order is UNKNOWN, not zero (ERR-180, one page over).
 *   - `GET /orders/:id` returns `shipping_information` with `email: null` BY
 *     DESIGN. Order 20260829000001 reads `email: null` there and `send_count: 1`
 *     on `/orders/:id/shipping`. Absent, null and a real object are three claims.
 *   - Order 20260809000002 has a URL pasted into `tracking_number`, so the derived
 *     link is `…/tracking/item/https%3A%2F%2F…` — live, today, in a customer's
 *     order page, and it can never find a parcel.
 *   - `tracking_url_source: "operator"` has never once rendered in production:
 *     all 13 shipped orders are `carrier_template`. An untested branch.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   §1  readShipping keeps ABSENT / PARTIAL / FULL apart via hasOwnProperty
 *   §2  RELABEL, DON'T BRANCH — the label comes off the payload, and no source
 *       file branches on a carrier name anywhere
 *   §3  validateShipping refuses exactly what the backend refuses, first
 *   §4  buildPayload merge semantics, and the tracking_url_override trap
 *   §5  emailState — four claims, four sentences; the live send_count:0 fixture
 *   §6  tracking_url_source: 'operator' — the branch production has never shown
 *   §7  the page is registry-driven; the hardcoded carrier list is GONE
 *   §8  storefront: the customer sees the carrier's word and the ticket code
 *   §9  POSITIVE CONTROL — the naive readings, and broken builds of the real
 *       module through the real loader, must FAIL
 *   §10 shipping hygiene — probe, npm script, APP_VERSION, CSS
 *
 * Siblings: tests/admin-orders-invoice-sent-channel-sep2026.test.js (the same
 * absent/null/present discipline on a different column),
 * tests/admin-invoice-send-count-aug2026.test.js (the send-count vocabulary),
 * tests/tracking-inline-lookup-jun2026.test.js + tracking-on-demand-may2026.test.js
 * (the storefront contract, which must keep passing UNMODIFIED).
 * Live counterpart: `npm run probe:shipping-info`.
 *
 * Run with: node --test tests/order-shipping-information-sep2026.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const JS = path.join(ROOT, 'inkcartridges', 'js');
const READ = (p) => fs.readFileSync(p, 'utf8');

const SHIP_UTIL = path.join(ADMIN, 'utils', 'shipping-info.js');
const SHARED = path.join(ADMIN, 'utils', 'send-history.js');
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');
const ADMIN_API = path.join(ADMIN, 'api.js');
const APP = path.join(ADMIN, 'app.js');
const TRACK_PAGE = path.join(JS, 'track-order-page.js');
const LEGAL_CONFIG = path.join(JS, 'legal-config.js');
const ADMIN_CSS = path.join(ROOT, 'inkcartridges', 'css', 'admin.css');
const PROBE = path.join(ROOT, 'scripts', 'probe-shipping-information.mjs');
const PKG = path.join(ROOT, 'package.json');

const shipSrc = READ(SHIP_UTIL);
const ordersSrc = READ(ORDERS_PAGE);
const apiSrc = READ(ADMIN_API);
const trackSrc = READ(TRACK_PAGE);
const cssSrc = READ(ADMIN_CSS);

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

/**
 * Source strings are PARAMETERS with defaults, deliberately: §9 feeds a
 * deliberately-broken build of the real module through this real loader, so a
 * positive control cannot drift away from the thing it controls.
 */
function loadModules(shipSource = READ(SHIP_UTIL)) {
  const sandbox = {
    console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp, Date, URL,
    DebugLog: { warn() {}, log() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(stripEsm(READ(SHARED)), ctx, { filename: 'send-history.js' });
  vm.runInContext(stripEsm(shipSource), ctx, { filename: 'shipping-info.js' });
  return sandbox;
}

const M = loadModules();
const {
  SHIPPING_REGIME, EMAIL_STATE, SHIPPING_ISSUE, DEFAULT_NUMBER_LABEL,
  readShipping, knowsSendHistory, carrierByCode, carrierOf, numberLabel,
  requiresProductCode, buildsTrackingUrl, supportsLiveTracking,
  looksLikeUrl, normaliseTrackingUrl, validateShipping,
  formFromShipping, buildPayload, hasChanges, changedFieldCount,
  emailState, sendability, SEND_BLOCKER, shippingErrorMessage,
  isConcurrencyConflict, isNotShippedRefusal, describeEmailOutcome, fieldIssuesFromError,
  reconcileCarrier, carrierWasDefaulted,
} = M;

const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Remove comments without mangling strings.
 *
 * A naive stripper eats `'https://…'`. The pins in §2 are about what the CODE
 * does, and every one of these files discusses carriers by name in prose, so the
 * scan has to tell a sentence from a branch.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Every carrier the registry ships today, by display name and by code. */
const CARRIER_LITERALS = [
  'NZ Post', 'CourierPost', 'NZ Couriers', 'Post Haste', 'Aramex', 'DHL',
  'nz_post', 'courierpost', 'nz_couriers', 'post_haste', 'aramex', 'dhl',
];

/* ─── live fixtures, frozen. Real rows, read from production 2026-09-01. ─── */

/** As GET /api/admin/orders/:id nests it. `email` is null BY DESIGN, not by absence of sends. */
const LIVE_DETAIL_ORDER = Object.freeze({
  id: '5c2db24d-65fa-4363-867f-41a2877e6d5f',
  order_number: '20260829000001',
  status: 'shipped',
  shipping_information: Object.freeze({
    carrier: 'NZ Post', carrier_code: 'nz_post',
    tracking_number: '00894210392918413790',
    tracking_number_label: 'Tracking number',
    ticket_product_code: null,
    tracking_url: 'https://www.nzpost.co.nz/tools/tracking/item/00894210392918413790',
    tracking_url_override: null,
    tracking_url_source: 'carrier_template',
    requires_product_code: false, builds_tracking_url: true, supports_live_tracking: true,
    shipped_at: '2026-08-31T06:13:21.481+00:00',
    is_shipped: true, can_send_email: true,
    email: null,
  }),
});

/** The SAME order from GET /orders/:id/shipping — where send_count is 1, not null. */
const LIVE_FULL_ENVELOPE = Object.freeze({
  order_id: '5c2db24d-65fa-4363-867f-41a2877e6d5f',
  order_number: '20260829000001',
  status: 'shipped',
  shipping: Object.freeze({
    ...LIVE_DETAIL_ORDER.shipping_information,
    email: Object.freeze({
      send_count: 1, last_status: 'sent',
      last_sent_at: '2026-08-31T06:13:24.099+00:00',
      last_queued_at: '2026-08-31T06:13:23.229978+00:00',
    }),
  }),
});

/**
 * Order 20260730000001 — shipped, and the send log does not reach back to it.
 * FOUR of the thirteen shipped orders look exactly like this.
 */
const LIVE_UNLOGGED = Object.freeze({
  carrier: 'NZ Post', carrier_code: 'nz_post',
  tracking_number: '00894210392918000000',
  tracking_number_label: 'Tracking number',
  ticket_product_code: null,
  tracking_url_source: 'carrier_template',
  is_shipped: true, can_send_email: true,
  email: Object.freeze({ send_count: 0, last_status: null, last_sent_at: null, last_queued_at: null }),
});

/** Order 20260809000002 — a URL typed into the number box. Live, today. */
const LIVE_URL_IN_NUMBER = Object.freeze({
  carrier: 'NZ Post', carrier_code: 'nz_post',
  tracking_number: 'https://www.nzpost.co.nz/tools/tracking?trackid=00894210392912038227',
  tracking_number_label: 'Tracking number',
  tracking_url: 'https://www.nzpost.co.nz/tools/tracking/item/https%3A%2F%2Fwww.nzpost.co.nz%2Ftools%2Ftracking%3Ftrackid%3D00894210392912038227',
  tracking_url_override: null,
  tracking_url_source: 'carrier_template',
  is_shipped: true, can_send_email: true,
  email: Object.freeze({ send_count: 1, last_status: 'sent', last_sent_at: '2026-08-10T05:27:09.124+00:00' }),
});

/** The registry exactly as GET /api/admin/shipping/carriers returns it. */
const REGISTRY = Object.freeze([
  { code: 'nz_post', name: 'NZ Post', number_label: 'Tracking number', requires_product_code: false, builds_tracking_url: true, supports_live_tracking: true },
  { code: 'courierpost', name: 'CourierPost', number_label: 'Tracking number', requires_product_code: false, builds_tracking_url: true, supports_live_tracking: true },
  { code: 'nz_couriers', name: 'NZ Couriers', number_label: 'Ticket number', requires_product_code: true, builds_tracking_url: true, supports_live_tracking: false },
  { code: 'post_haste', name: 'Post Haste', number_label: 'Tracking number', requires_product_code: false, builds_tracking_url: true, supports_live_tracking: false },
  { code: 'aramex', name: 'Aramex', number_label: 'Tracking number', requires_product_code: false, builds_tracking_url: true, supports_live_tracking: false },
  { code: 'dhl', name: 'DHL', number_label: 'Tracking number', requires_product_code: false, builds_tracking_url: false, supports_live_tracking: false },
  { code: 'other', name: 'Other', number_label: 'Tracking number', requires_product_code: false, builds_tracking_url: false, supports_live_tracking: false },
]);

const NZC = REGISTRY.find(c => c.code === 'nz_couriers');
const NZP = REGISTRY.find(c => c.code === 'nz_post');
const DHL = REGISTRY.find(c => c.code === 'dhl');

/** An NZ Couriers consignment, the shape the whole feature exists for. */
const NZC_SHIPPING = Object.freeze({
  carrier: 'NZ Couriers', carrier_code: 'nz_couriers',
  tracking_number: '16025241',
  tracking_number_label: 'Ticket number',
  ticket_product_code: 'LH',
  tracking_url: 'https://www.nzcouriers.co.nz/nzc/servlet/TAndTServlet?page=1&product_code=LH&serial_number=16025241&request_id=1',
  tracking_url_override: null,
  tracking_url_source: 'carrier_template',
  requires_product_code: true, builds_tracking_url: true, supports_live_tracking: false,
  is_shipped: true, can_send_email: true,
  email: Object.freeze({ send_count: 0, last_status: null, last_sent_at: null }),
});

/* ══════════════════════════════════════════════════════════════════════════ */

test('§1 readShipping keeps absent / partial / full apart', async (t) => {
  await t.test('the order-detail nesting is PARTIAL — email:null is by design', () => {
    const { regime, shipping } = readShipping(LIVE_DETAIL_ORDER);
    assert.equal(regime, SHIPPING_REGIME.PARTIAL,
      'the detail payload skips the email query; treating it as complete makes "never emailed" out of "not asked"');
    assert.equal(shipping.tracking_number, '00894210392918413790');
    assert.equal(knowsSendHistory(shipping), false,
      'this block cannot answer "has the customer been emailed?" and must not be asked to');
  });

  await t.test('the dedicated endpoint is FULL', () => {
    const { regime, shipping } = readShipping(LIVE_FULL_ENVELOPE);
    assert.equal(regime, SHIPPING_REGIME.FULL);
    assert.equal(knowsSendHistory(shipping), true);
    assert.equal(shipping.email.send_count, 1);
  });

  await t.test('THE SAME ORDER reads null on one endpoint and 1 on the other', () => {
    // Measured live. This is the trap: a panel rendered from the detail payload
    // that reads `email == null` as "never sent" invites a duplicate email.
    const a = readShipping(LIVE_DETAIL_ORDER).shipping;
    const b = readShipping(LIVE_FULL_ENVELOPE).shipping;
    assert.equal(a.tracking_number, b.tracking_number, 'same order');
    assert.equal(a.email, null);
    assert.equal(b.email.send_count, 1);
    assert.notEqual(emailState(a).state, emailState(b).state,
      'the two payloads must not produce the same claim about sends');
  });

  await t.test('no shipping block at all is ABSENT, not an empty one', () => {
    assert.equal(readShipping({ id: 'x', status: 'paid' }).regime, SHIPPING_REGIME.ABSENT);
    assert.equal(readShipping(null).regime, SHIPPING_REGIME.ABSENT);
    assert.equal(readShipping({ shipping_information: null }).regime, SHIPPING_REGIME.ABSENT);
  });

  await t.test('detection is hasOwnProperty, not truthiness', () => {
    assert.match(shipSrc, /Object\.prototype\.hasOwnProperty\.call/,
      'absent / null / present are three claims and only hasOwnProperty separates them (ERR-199)');
  });
});

test('§2 relabel, do not branch', async (t) => {
  await t.test('the label comes off the response', () => {
    assert.equal(numberLabel(NZC_SHIPPING, NZC), 'Ticket number');
    assert.equal(numberLabel(LIVE_DETAIL_ORDER.shipping_information, NZP), 'Tracking number');
  });

  await t.test('with no response label, the registry answers', () => {
    assert.equal(numberLabel(null, NZC), 'Ticket number');
    assert.equal(numberLabel({}, NZC), 'Ticket number');
  });

  await t.test('with neither, the generic word — and it is NOT a per-carrier default', () => {
    assert.equal(numberLabel(null, null), DEFAULT_NUMBER_LABEL);
    assert.equal(numberLabel({ carrier: null, carrier_code: null }, null), DEFAULT_NUMBER_LABEL);
    assert.equal(DEFAULT_NUMBER_LABEL, 'Tracking number');
  });

  await t.test('the fallback only WARNS when a label was actually owed', () => {
    // Caught in the browser: an order with no carrier yet warned on every open.
    // A warning that fires constantly is one nobody reads when the registry
    // really is malformed.
    const warned = [];
    const sandbox = loadModules();
    sandbox.DebugLog.warn = (...a) => warned.push(a.join(' '));
    sandbox.numberLabel(null, null);
    sandbox.numberLabel({ carrier: null, carrier_code: null }, null);
    assert.equal(warned.length, 0, 'no carrier means nobody was asked, so nothing is missing');
    sandbox.numberLabel({ carrier_code: 'nz_post' }, null);
    assert.equal(warned.length, 1, 'a carrier IS set and no label came with it — that is worth saying');
    sandbox.numberLabel(null, { code: 'nz_post', name: 'NZ Post' });
    assert.equal(warned.length, 2, 'a registry entry with no number_label is malformed');
  });

  await t.test('shipping-info.js names no carrier, anywhere in its code', () => {
    const code = stripComments(shipSrc);
    for (const lit of CARRIER_LITERALS) {
      assert.equal(code.includes(lit), false,
        `the shipping vocabulary must be carrier-agnostic, but it contains "${lit}". ` +
        'Adding a carrier has to stay a one-file change on the backend.');
    }
  });

  await t.test('no source file BRANCHES on a carrier name', () => {
    const files = { 'pages/orders.js': ordersSrc, 'admin/api.js': apiSrc, 'track-order-page.js': trackSrc };
    for (const [name, src] of Object.entries(files)) {
      const code = stripComments(src);
      for (const lit of CARRIER_LITERALS) {
        const esc = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // A comparison, a switch case, or a membership test against a carrier
        // literal. Prose that merely mentions a carrier is fine; a decision is not.
        const branch = new RegExp(
          `(===|!==|==(?!=)|!=(?!=))\\s*['"\`]${esc}['"\`]` +
          `|['"\`]${esc}['"\`]\\s*(===|!==|==(?!=)|!=(?!=))` +
          `|case\\s+['"\`]${esc}['"\`]` +
          `|\\.includes\\(\\s*['"\`]${esc}['"\`]\\s*\\)`,
          'i',
        );
        assert.equal(branch.test(code), false,
          `${name} branches on the carrier literal "${lit}". Every per-carrier behaviour must read ` +
          'a server-sent flag (requires_product_code / builds_tracking_url / supports_live_tracking / number_label).');
      }
    }
  });

  await t.test('the per-carrier flags are read, and read as strict booleans', () => {
    assert.equal(requiresProductCode(NZC), true);
    assert.equal(requiresProductCode(NZP), false);
    assert.equal(buildsTrackingUrl(DHL), false, 'DHL publishes no deep link — the operator pastes one');
    assert.equal(buildsTrackingUrl(NZP), true);
    assert.equal(supportsLiveTracking(NZC), false);
    assert.equal(supportsLiveTracking(NZP), true);
    // An unknown carrier must not inherit a permissive default.
    assert.equal(requiresProductCode(null), false);
    assert.equal(buildsTrackingUrl(null), false);
    assert.equal(supportsLiveTracking(undefined), false);
    assert.equal(requiresProductCode({ requires_product_code: 'yes' }), false,
      'a truthy non-boolean is not a yes — the flag is a boolean on the wire');
  });

  await t.test('carrierByCode matches on CODE, never on display name', () => {
    assert.equal(carrierByCode('nz_couriers', REGISTRY).name, 'NZ Couriers');
    assert.equal(carrierByCode('NZ_COURIERS', REGISTRY).code, 'nz_couriers', 'case-insensitive on the code');
    assert.equal(carrierByCode('NZ Couriers', REGISTRY), null,
      'a display name is not a code — matching it here would re-admit name inference');
    assert.equal(carrierByCode('', REGISTRY), null);
    assert.equal(carrierByCode('nz_post', null), null);
  });

  await t.test('carrierOf falls back to an EXACT registry-name match for legacy rows', () => {
    // Rows written before the registry existed carry a name and no code. Looking
    // that name up in a closed server-supplied set is not inference.
    assert.equal(carrierOf({ carrier_code: 'aramex' }, REGISTRY).code, 'aramex');
    assert.equal(carrierOf({ carrier: 'Aramex' }, REGISTRY).code, 'aramex');
    assert.equal(carrierOf({ carrier: 'aramex nz' }, REGISTRY), null, 'no fuzzy matching');
    assert.equal(carrierOf({ carrier: 'NZ Couriers Ltd' }, REGISTRY), null);
  });
});

test('§3 validateShipping refuses exactly what the backend refuses', async (t) => {
  await t.test('TICKET_PRODUCT_CODE_REQUIRED — NZ Couriers, a number, no code, no URL', () => {
    const r = validateShipping({ carrierCode: 'nz_couriers', number: '16025241', productCode: '', url: '' }, NZC);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, SHIPPING_ISSUE.TICKET_PRODUCT_CODE_REQUIRED);
    assert.equal(r.errors[0].field, 'productCode');
  });

  await t.test('…and a URL satisfies it, because there is nothing left to build', () => {
    const r = validateShipping(
      { carrierCode: 'nz_couriers', number: '16025241', productCode: '', url: 'https://example.co.nz/t/1' }, NZC);
    assert.equal(r.ok, true, 'the operator supplied the destination directly');
  });

  await t.test('…and a carrier that does not need one is not asked for one', () => {
    const r = validateShipping({ carrierCode: 'nz_post', number: '00894210392918413790', productCode: '', url: '' }, NZP);
    assert.equal(r.ok, true);
  });

  await t.test('INVALID_TRACKING_URL — http:// is rejected, as the backend rejects it', () => {
    const r = validateShipping({ carrierCode: 'dhl', number: 'X', url: 'http://track.dhl.com/x' }, DHL);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, SHIPPING_ISSUE.INVALID_TRACKING_URL);
    assert.match(r.errors[0].message, /https/, 'the message has to say what is wrong with it');
    assert.equal(normaliseTrackingUrl('http://x.co/1'), null);
    assert.equal(normaliseTrackingUrl('not a url'), null);
    assert.equal(normaliseTrackingUrl('https://x.co/1'), 'https://x.co/1');
    assert.equal(normaliseTrackingUrl(''), null);
  });

  await t.test('NO_TRACKING_INFORMATION — sending with neither a number nor a link', () => {
    const r = validateShipping({ carrierCode: 'nz_post', number: '', url: '' }, NZP, { sendEmail: true });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, SHIPPING_ISSUE.NO_TRACKING_INFORMATION);
  });

  await t.test('marking shipped with nothing to track by is refused too', () => {
    const r = validateShipping({ carrierCode: 'nz_post', number: '', url: '' }, NZP, { markShipped: true });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, SHIPPING_ISSUE.NOTHING_TO_TRACK_BY);
  });

  await t.test('UNKNOWN_CARRIER — a code the server-driven registry does not hold', () => {
    const r = validateShipping({ carrierCode: 'pigeon', number: 'X' }, null);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, SHIPPING_ISSUE.UNKNOWN_CARRIER);
  });

  await t.test('a URL pasted into the number box WARNS but never blocks', () => {
    // Live data, order 20260809000002. The backend cannot refuse this — a tracking
    // reference has no universal grammar — so the operator is told, and the save
    // still goes through, because a rule we invented must never refuse a save the
    // backend would have accepted.
    assert.equal(looksLikeUrl(LIVE_URL_IN_NUMBER.tracking_number), true);
    assert.equal(looksLikeUrl('00894210392918413790'), false);
    assert.equal(looksLikeUrl('www.nzpost.co.nz/x'), true);
    assert.equal(looksLikeUrl(''), false);
    assert.equal(looksLikeUrl('HB072035450NZ'), false);

    const r = validateShipping(
      { carrierCode: 'nz_post', number: LIVE_URL_IN_NUMBER.tracking_number, url: '' }, NZP);
    assert.equal(r.ok, true, 'a warning must not block the save');
    assert.equal(r.warnings.some(w => w.code === SHIPPING_ISSUE.NUMBER_LOOKS_LIKE_URL), true);
    assert.match(r.warnings.find(w => w.code === SHIPPING_ISSUE.NUMBER_LOOKS_LIKE_URL).message,
      /Tracking URL field/i, 'the warning has to name where the link actually belongs');
  });

  await t.test('an unusual product-code length warns, never blocks', () => {
    const r = validateShipping({ carrierCode: 'nz_couriers', number: '1', productCode: 'LONGCODE' }, NZC);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.some(w => w.code === SHIPPING_ISSUE.PRODUCT_CODE_UNUSUAL_LENGTH), true);
    assert.equal(validateShipping({ carrierCode: 'nz_couriers', number: '1', productCode: 'LH' }, NZC).warnings.length, 0);
  });
});

/**
 * The error contract as PRODUCTION returns it, not as the hand-off documents it.
 *
 * Measured 2026-09-01 with a bracketed PUT against order 20260829000001 (read
 * before, read after, byte-identical): a bad `tracking_url` does NOT come back as
 * the documented `INVALID_TRACKING_URL`. Joi rejects it in the schema layer first,
 * so it arrives as VALIDATION_FAILED with the field named in details[]. Keying
 * only on the documented code left the input unmarked and showed the operator
 * '"tracking_url" must be a valid uri with a scheme matching the https pattern'.
 */
const LIVE_BAD_URL_ERROR = Object.freeze({
  code: 'VALIDATION_FAILED',
  message: 'Validation failed',
  status: 400,
  details: Object.freeze([Object.freeze({
    field: 'tracking_url',
    message: '"tracking_url" must be a valid uri with a scheme matching the https pattern',
  })]),
});

/** The whole-body rule, when nothing at all was sent. `field` is the empty string. */
const LIVE_EMPTY_BODY_ERROR = Object.freeze({
  code: 'VALIDATION_FAILED', message: 'Validation failed', status: 400,
  details: Object.freeze([Object.freeze({ field: '', message: '"value" must have at least 1 key' })]),
});

test('§3b the error contract as production actually returns it', async (t) => {
  await t.test('a bad tracking_url is VALIDATION_FAILED, and still marks the URL field', () => {
    const issues = fieldIssuesFromError(LIVE_BAD_URL_ERROR);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, 'url',
      'the documented INVALID_TRACKING_URL code never arrives; details[].field is the only signal');
    assert.equal(/must be a valid uri/i.test(issues[0].message), false,
      'Joi quotes the wire field name at a human — our copy replaces it');
    assert.match(issues[0].message, /https/);
  });

  await t.test('the headline points at the fields instead of repeating Joi', () => {
    assert.match(shippingErrorMessage(LIVE_BAD_URL_ERROR), /marked below/i);
    assert.match(shippingErrorMessage(LIVE_EMPTY_BODY_ERROR), /Nothing was sent to save/i,
      '"value must have at least 1 key" is not a sentence for an operator');
  });

  await t.test('a whole-body rule names no field, so nothing is falsely marked', () => {
    assert.deepEqual(plain(fieldIssuesFromError(LIVE_EMPTY_BODY_ERROR)), [],
      'field: "" is the body, not an input — marking one would point at the wrong thing');
  });

  await t.test('the documented codes still map, for the paths that do return them', () => {
    assert.equal(fieldIssuesFromError({ code: 'TICKET_PRODUCT_CODE_REQUIRED' })[0].field, 'productCode');
    assert.equal(fieldIssuesFromError({ code: 'UNKNOWN_CARRIER' })[0].field, 'carrier');
    assert.equal(fieldIssuesFromError({ code: 'CONFLICTING_TRACKING_NUMBER' })[0].field, 'number');
    assert.equal(fieldIssuesFromError({ code: 'INVALID_TRACKING_URL' })[0].field, 'url');
  });

  await t.test('`ticket_number` in a backend error still lands on the number input', () => {
    // We never SEND the alias, but the backend accepts it and may name it back.
    assert.equal(fieldIssuesFromError({ code: 'VALIDATION_FAILED', details: [{ field: 'ticket_number', message: 'x' }] })[0].field, 'number');
  });

  await t.test('nothing recognisable yields no issues, so the caller falls back', () => {
    assert.deepEqual(plain(fieldIssuesFromError({ code: 'INTERNAL_ERROR' })), []);
    assert.deepEqual(plain(fieldIssuesFromError(null)), []);
  });

  await t.test('AdminAPI carries details onto the thrown Error, or none of this can work', () => {
    assert.match(apiSrc, /if \(details !== undefined\) e\.details = details;/,
      'errorFromEnvelope dropped details[], which is where the offending field name lives');
  });

  await t.test('409 and ORDER_NOT_SHIPPED are told apart from the 400s', () => {
    assert.equal(isConcurrencyConflict({ status: 409 }), true);
    assert.equal(isConcurrencyConflict({ code: 'CONFLICT' }), true);
    assert.equal(isConcurrencyConflict({ code: 'VALIDATION_FAILED' }), false);
    assert.equal(isNotShippedRefusal({ code: 'ORDER_NOT_SHIPPED' }), true);
    assert.equal(isNotShippedRefusal({ code: 'NO_TRACKING_INFORMATION' }), false);
    assert.match(shippingErrorMessage({ message: 'Failed to fetch' }), /Couldn/,
      'a request that never reached the server must not be reported as a rejected save');
  });
});

test('§4 buildPayload — merge semantics, and the override trap', async (t) => {
  const stored = NZC_SHIPPING;

  await t.test('an unchanged form sends NOTHING', () => {
    const payload = buildPayload(stored, formFromShipping(stored));
    assert.deepEqual(plain(payload), {},
      'echoing unchanged fields turns a concurrent edit into a silent revert');
    assert.equal(hasChanges(payload), false);
  });

  await t.test('only the changed field is sent — a partial save stays partial', () => {
    const form = { ...formFromShipping(stored), productCode: 'AB' };
    assert.deepEqual(plain(buildPayload(stored, form)), { ticket_product_code: 'AB' });
  });

  await t.test('an empty string CLEARS; an already-empty field is not re-cleared', () => {
    assert.deepEqual(plain(buildPayload(stored, { ...formFromShipping(stored), productCode: '' })),
      { ticket_product_code: '' }, 'blanking a set field must reach the server as an explicit clear');
    // ticket_product_code is already null on this one, so blanking it is a no-op.
    const noCode = { ...stored, ticket_product_code: null };
    assert.deepEqual(plain(buildPayload(noCode, { ...formFromShipping(noCode), productCode: '' })), {},
      'an empty field left empty is not a deliberate erasure and must not be logged as one');
  });

  await t.test('THE OVERRIDE TRAP — the URL field is bound to tracking_url_override', () => {
    // tracking_url is where the customer is SENT (usually carrier-built);
    // tracking_url_override is what an operator TYPED, null when derived. Bind the
    // input to the first and the very first save of an untouched form freezes
    // today's generated link into a stored override for good.
    assert.equal(stored.tracking_url_override, null);
    assert.notEqual(stored.tracking_url, null);
    assert.equal(formFromShipping(stored).url, '',
      'the form starts EMPTY when the link is derived — it is an override box, not a mirror');
    assert.deepEqual(plain(buildPayload(stored, formFromShipping(stored))), {},
      'saving an untouched form must never convert a derived link into an override');

    const withOverride = { ...stored, tracking_url_override: 'https://ops.example/parcel/9' };
    assert.equal(formFromShipping(withOverride).url, 'https://ops.example/parcel/9',
      'an override an operator really typed IS shown back to them');
  });

  await t.test('`ticket_number` is never co-sent — CONFLICTING_TRACKING_NUMBER is unreachable', () => {
    const payload = buildPayload(stored, { ...formFromShipping(stored), number: '999' });
    assert.equal('tracking_number' in payload, true);
    assert.equal('ticket_number' in payload, false,
      'the alias writes to the same column; sending both spellings with different values is a 400 by design');
    // Pinned where it matters: the function that BUILDS the body. Reading the
    // alias back out of a backend error is fine (and fieldIssuesFromError does);
    // writing it into a request alongside tracking_number is the 400.
    const buildBody = stripComments(shipSrc).slice(
      stripComments(shipSrc).indexOf('export function buildPayload'),
      stripComments(shipSrc).indexOf('export function hasChanges'));
    assert.ok(buildBody.length > 100, 'buildPayload() not found — was it renamed?');
    assert.equal(buildBody.includes('ticket_number'), false,
      'buildPayload must never emit the alias — one spelling cannot conflict with itself');
    for (const form of [
      { carrierCode: 'nz_couriers', number: '1', productCode: 'LH', url: '' },
      { carrierCode: '', number: '', productCode: '', url: '' },
      { carrierCode: 'dhl', number: 'X', productCode: '', url: 'https://a.co/b' },
    ]) {
      assert.equal('ticket_number' in buildPayload(stored, form), false);
      assert.equal('ticket_number' in buildPayload(null, form), false);
    }
  });

  await t.test('values are trimmed, so whitespace is not a change', () => {
    assert.deepEqual(plain(buildPayload(stored, { ...formFromShipping(stored), number: '  16025241  ' })), {});
    assert.deepEqual(plain(buildPayload(stored, { ...formFromShipping(stored), number: ' 16025242 ' })),
      { tracking_number: '16025242' });
  });

  await t.test('intent flags ride along, and only when asked for', () => {
    assert.deepEqual(plain(buildPayload(stored, formFromShipping(stored), { markShipped: true })), { mark_shipped: true });
    assert.deepEqual(plain(buildPayload(stored, formFromShipping(stored), { sendEmail: true })), { send_email: true });
    assert.equal('mark_shipped' in buildPayload(stored, formFromShipping(stored), { markShipped: false }), false);
    assert.equal(changedFieldCount({ mark_shipped: true }), 0,
      'ticking a box is not editing a field — the confirm copy depends on telling those apart');
    assert.equal(changedFieldCount({ tracking_number: '1', mark_shipped: true }), 1);
  });

  await t.test('a null baseline (nothing stored yet) sends everything typed', () => {
    assert.deepEqual(plain(buildPayload(null, { carrierCode: 'nz_couriers', number: '16025241', productCode: 'LH', url: '' })),
      { carrier: 'nz_couriers', tracking_number: '16025241', ticket_product_code: 'LH' });
  });
});

test('§5 emailState — four claims, four sentences', async (t) => {
  await t.test('RECORDED uses the shared "recorded sends" vocabulary', () => {
    const s = emailState(readShipping(LIVE_FULL_ENVELOPE).shipping);
    assert.equal(s.state, EMAIL_STATE.RECORDED);
    assert.equal(s.count, 1);
    assert.equal(s.phrase, '1 recorded send');
    assert.equal(/sent\s+1\s+time/i.test(s.phrase), false, 'never "sent N times" — the count is a floor');
    assert.equal(s.warnBeforeSend, true);
  });

  await t.test('UNLOGGED — shipped with send_count 0 is UNKNOWN, never "never sent"', () => {
    // 4 of the 13 shipped orders live are exactly this. Dispatch emails the
    // customer automatically, so a zero here is a log that does not reach back.
    const s = emailState(LIVE_UNLOGGED);
    assert.equal(s.state, EMAIL_STATE.UNLOGGED);
    assert.equal(/never/i.test(s.phrase + ' ' + s.detail), false,
      'claiming "never sent" here talks the operator into emailing a customer twice (ERR-180)');
    assert.match(s.detail, /may already have/i, 'the honest reading has to be on screen');
    assert.equal(s.warnBeforeSend, true);
  });

  await t.test('NOT_APPLICABLE — an unshipped order is the only true zero', () => {
    const s = emailState({ is_shipped: false, email: { send_count: 0 } });
    assert.equal(s.state, EMAIL_STATE.NOT_APPLICABLE);
    assert.equal(s.warnBeforeSend, false, 'nothing has gone out, so a send needs no confirmation');
  });

  await t.test('UNKNOWN — we have not looked, and say so', () => {
    const s = emailState(readShipping(LIVE_DETAIL_ORDER).shipping);
    assert.equal(s.state, EMAIL_STATE.UNKNOWN);
    assert.equal(s.count, null, 'a count we did not read is not a count of zero');
    assert.equal(s.warnBeforeSend, true, 'we cannot rule out an earlier send');
  });

  await t.test('all four states print DIFFERENT words', () => {
    const phrases = [
      emailState(readShipping(LIVE_FULL_ENVELOPE).shipping).phrase,
      emailState(LIVE_UNLOGGED).phrase,
      emailState({ is_shipped: false, email: { send_count: 0 } }).phrase,
      emailState(readShipping(LIVE_DETAIL_ORDER).shipping).phrase,
    ];
    assert.equal(new Set(phrases).size, 4,
      'two different facts wearing one sentence is the whole failure mode here');
  });

  await t.test('sendability prefers the backend\'s own can_send_email', () => {
    assert.equal(sendability(readShipping(LIVE_FULL_ENVELOPE).shipping).canSend, true);
    const refused = sendability({ can_send_email: false, is_shipped: false, tracking_number: '1' });
    assert.equal(refused.canSend, false);
    assert.match(refused.reason, /shipped/i, 'a disabled button with no reason is a bug report waiting to happen');
    const noTarget = sendability({ can_send_email: false, is_shipped: true, tracking_number: '' });
    assert.match(noTarget.reason, /tracking number or a tracking link/i);
    assert.equal(sendability(null).canSend, false);
  });

  // ERR-205. The page has to add "so do THIS next" to the reason, and it must pick
  // the advice off a code rather than off the sentence — a copy edit that reworded
  // the reason would otherwise silently switch the advice off.
  await t.test('sendability names WHICH refusal, not just that there is one', () => {
    // Positive control: the enabled block must report no blocker at all. Without
    // this, `blocker` could be a constant string and every assertion below passes.
    const allowed = sendability(readShipping(LIVE_FULL_ENVELOPE).shipping);
    assert.equal(allowed.canSend, true);
    assert.equal(allowed.blocker, null, 'a permitted send has nothing blocking it');

    assert.equal(sendability(null).blocker, SEND_BLOCKER.NOT_LOADED);
    assert.equal(sendability({ can_send_email: false, is_shipped: false, tracking_number: '1' }).blocker,
      SEND_BLOCKER.NOT_SHIPPED);
    assert.equal(sendability({ can_send_email: false, is_shipped: true, tracking_number: '' }).blocker,
      SEND_BLOCKER.NO_TARGET);
    // The reconstruction for blocks predating can_send_email has to agree.
    assert.equal(sendability({ is_shipped: false, tracking_number: '1' }).blocker, SEND_BLOCKER.NOT_SHIPPED);
    assert.equal(sendability({ is_shipped: true, tracking_number: '', tracking_url: '' }).blocker,
      SEND_BLOCKER.NO_TARGET);

    assert.equal(new Set(Object.values(SEND_BLOCKER)).size, Object.values(SEND_BLOCKER).length,
      'two blockers sharing a code would make the advice unpickable');
  });

  await t.test('ERR-205 — the refusal is in the DOM as text, not only in a title', () => {
    // The coupling this test exists to hold: a disabled .admin-btn cannot be
    // hovered, so `btn.title` is write-only for exactly the state that needs it.
    assert.match(cssSrc, /\.admin-btn:disabled \{[^}]*pointer-events: none/,
      'if this rule ever goes, the tooltip works again and the note below becomes optional — '
      + 'until then, a reason kept only in a title is a reason nobody can read');

    assert.match(ordersSrc, /why: 'om-ship-why'/, 'the refusal needs an element of its own');
    assert.match(ordersSrc, /id="\$\{SHIP_IDS\.why\}"/, 'and that element has to be rendered');

    const render = ordersSrc.slice(
      ordersSrc.indexOf('function shipRenderSendState()'),
      ordersSrc.indexOf('function buildShippingSection('));
    assert.ok(render.includes('shipNode(SHIP_IDS.why)'), 'shipRenderSendState must write the visible note');
    assert.match(render, /why\.innerHTML = /, 'the reason goes into the node, not just onto the button');
    assert.match(render, /why\.hidden = true/, 'and it disappears when the send is allowed');
    assert.match(render, /btn\.title = canSend/, 'the title stays — it is right for the ENABLED button');

    // Ticking the box must repaint the advice. Nothing listened to this checkbox
    // at all, so the panel went on telling operators to tick what they had ticked.
    assert.match(ordersSrc, /shipNode\(SHIP_IDS\.mark\)\?\.addEventListener\('change', shipRenderSendState\)/,
      'the checkbox has to re-render the advice');

    // ...and must NOT change the verdict. sendability() reads the saved server
    // block; a ticked box is an intention. The advice reads the checkbox, the
    // decision never does.
    assert.ok(!shipSrc.includes('om-ship-mark'), 'the util must not know the checkbox exists');
    const setBusy = ordersSrc.slice(
      ordersSrc.indexOf('function shipSetBusy('),
      ordersSrc.indexOf('function shipRememberSavedCarrier('));
    assert.ok(setBusy.includes('shipRenderSendState()'),
      'one writer for disabled + title + note, or a busy disable strands a stale reason');
    assert.ok(!/send\.disabled = busy/.test(setBusy),
      'shipSetBusy re-deriving disabled on its own is how the three drifted apart');
  });

  await t.test('auto_on_ship is announced — the operator did not tick a Send box', () => {
    assert.match(describeEmailOutcome({ requested: false, sent: true, reason: 'auto_on_ship' }),
      /automatically/i, 'marking shipped emails the customer; silence is how you hear it from the customer');
    assert.match(describeEmailOutcome({ requested: true, sent: true, reason: null }), /emailed/i);
    assert.match(describeEmailOutcome({ requested: true, sent: false, reason: 'not_shipped' }), /not sent/i);
    assert.equal(describeEmailOutcome(null), null);
  });
});

test('§6 tracking_url_source — including the branch production has never shown', async (t) => {
  await t.test('every live shipped order is carrier_template', () => {
    assert.equal(LIVE_DETAIL_ORDER.shipping_information.tracking_url_source, 'carrier_template');
  });

  await t.test('the operator branch is rendered, and captioned differently', () => {
    // Zero of the 13 shipped orders are 'operator', so this path had never once
    // executed in production. ERR-180 shipped a feature that had never rendered.
    assert.match(ordersSrc, /source === 'operator'/,
      'the operator-supplied branch must exist in the renderer');
    assert.match(ordersSrc, /carrier_template/);
    assert.match(ordersSrc, /source not stated/,
      'a third, honest branch for a source the backend did not send');
  });

  await t.test('the derived link is sanitised, never trusted raw', () => {
    assert.match(ordersSrc, /Security\.sanitizeUrl\(s\.tracking_url\)/,
      'the URL comes off the wire and lands in an href');
  });
});

test('§7 the page is registry-driven', async (t) => {
  await t.test('THE HARDCODED CARRIER LIST IS GONE', () => {
    for (const lit of ['NZ Post', 'CourierPost', 'Aramex', 'DHL']) {
      assert.equal(new RegExp(`<option value="${lit}"`).test(ordersSrc), false,
        `orders.js still hand-writes an <option> for ${lit}. That list could not express NZ Couriers ` +
        'or Post Haste at all, and drifted from the backend registry the moment one was added.');
    }
  });

  await t.test('both dropdowns are filled from GET /api/admin/shipping/carriers', () => {
    assert.match(apiSrc, /\/api\/admin\/shipping\/carriers/);
    const calls = ordersSrc.match(/AdminAPI\.getShippingCarriers\(/g) || [];
    assert.ok(calls.length >= 2,
      'the Shipping Information section AND the Update Status modal must read the same registry, ' +
      `found ${calls.length} call site(s)`);
  });

  await t.test('the four endpoints are wired', () => {
    for (const [name, re] of Object.entries({
      read: /\/api\/admin\/orders\/\$\{orderId\}\/shipping`/,
      send: /\/shipping\/send-email`/,
    })) assert.match(apiSrc, re, `${name} endpoint missing`);
    assert.match(apiSrc, /window\.API\.put\(`\/api\/admin\/orders\/\$\{orderId\}\/shipping`/);
  });

  await t.test('the dead updateTracking() second write path is removed', () => {
    assert.equal(/async updateTracking\s*\(/.test(apiSrc), false,
      'two writers to the same four columns is how they drift');
  });

  await t.test('a failed registry fetch is LOUD and guesses nothing', () => {
    assert.match(ordersSrc, /Couldn’t load the carrier list/,
      'fail-soft must be loud: a guessed list would be missing the one carrier this feature exists for');
    assert.match(apiSrc, /_carrierRegistryPromise = null;/,
      'a transient failure must not be cached, or it poisons the whole session');
  });

  await t.test('the panel PATCHES; it never re-renders under the caret', () => {
    assert.match(ordersSrc, /dataset\.dirty/,
      'a field the operator has touched must never be written to by a late async read (ERR-179)');
    assert.match(ordersSrc, /function shipPatchPristine/);
  });

  await t.test('a stale async read cannot write into the next order\'s panel', () => {
    assert.match(ordersSrc, /_shipState\.token !== token/);
    assert.match(ordersSrc, /_shipToken\+\+;/, 'closing the modal must invalidate in-flight reads');
  });

  await t.test('the section is UNCONDITIONAL — it is where details are entered', () => {
    assert.match(ordersSrc, /const shippingInfoHtml = buildShippingSection\(o\);/);
    assert.equal(/if \(o\.carrier \|\| o\.tracking_number\)/.test(ordersSrc), false,
      'gating the section on already having details hid it from the one order that needed it');
  });

  await t.test('marking shipped warns that it emails the customer', () => {
    assert.match(ordersSrc, /this emails the customer/i,
      'mark_shipped sends the dispatch email even without send_email (reason: auto_on_ship)');
  });

  await t.test('the Update Status modal ships through the shipping endpoint', () => {
    // The dropdown holds registry CODES; only the shipping endpoint documents
    // accepting a code, and it is the only one that knows ticket_product_code.
    // Pinned by BEHAVIOUR, not by the shape of the expression: the body carries
    // mark_shipped and goes to updateOrderShipping, however it is built. (It was
    // an object literal until §11 replaced it with buildPayload — a pin on the
    // literal broke on a refactor that changed nothing about the contract.)
    assert.match(ordersSrc, /shippingBody = buildPayload\(null, form, \{ markShipped: true \}\)/);
    assert.match(ordersSrc, /if \(shippingBody\) \{\s*\n\s*const data = await AdminAPI\.updateOrderShipping\(order\.id, shippingBody\)/,
      'a shipped status must not go through the legacy status endpoint');
  });

  await t.test('a 409 keeps the operator\'s typing', () => {
    assert.match(ordersSrc, /isConcurrencyConflict/);
    assert.match(ordersSrc, /rebaseline: false/,
      'a lost race refreshes the server view WITHOUT discarding the correction being typed');
  });
});

test('§8 the storefront speaks the carrier\'s language', async (t) => {
  await t.test('the number is labelled from the response', () => {
    assert.match(trackSrc, /data\.tracking_number_label \|\| 'Tracking number'/,
      'an NZ Couriers customer must see "Ticket number", or they are holding a reference under the wrong name');
  });

  await t.test('the ticket product code is shown', () => {
    assert.match(trackSrc, /data\.ticket_product_code/);
    assert.match(trackSrc, /'Ticket product code'/,
      'the ticket number alone does not resolve to a tracking page — the customer needs both');
  });

  await t.test('the frontend still builds NO tracking URL', () => {
    assert.equal(/nzpost\.co\.nz\/tools\/tracking/.test(trackSrc), false);
    assert.match(trackSrc, /Security\.sanitizeUrl\(data\.tracking_url\)/,
      'the link is the backend\'s, sanitised — never concatenated here');
  });

  await t.test('the shipping policy names every carrier we actually use', () => {
    const legal = READ(LEGAL_CONFIG);
    assert.match(legal, /carriers:\s*\['NZ Post', 'Aramex \(CourierPost network\)', 'NZ Couriers'\]/,
      'a policy page naming two carriers while parcels go out on a third is untrue');
  });

  await t.test('three carriers read as "A, B and C", not "A and B and C"', () => {
    const legalPage = READ(path.join(JS, 'legal-page.js'));
    assert.equal(/carriers.*\.join\(' and '\)/s.test(legalPage.slice(legalPage.indexOf('legal-bind="carriers"'), legalPage.indexOf('legal-bind="carriers"') + 400)), false,
      'join(" and ") was written for two and reads badly for three');
  });
});

test('§9 POSITIVE CONTROL — the wrong readings must fail', async (t) => {
  await t.test('the naive "send_count > 0 else never sent" gate is WRONG on live data', () => {
    const naive = (s) => (s?.email?.send_count > 0 ? 'sent' : 'never sent');
    assert.equal(naive(LIVE_UNLOGGED), 'never sent',
      'this is the answer the obvious gate gives for 4 of the 13 live shipped orders');
    assert.notEqual(emailState(LIVE_UNLOGGED).state, EMAIL_STATE.NOT_APPLICABLE,
      'and it is the answer this module must NOT give');
    assert.equal(emailState(LIVE_UNLOGGED).state, EMAIL_STATE.UNLOGGED);
  });

  await t.test('the naive "email == null means never emailed" gate is WRONG', () => {
    const naive = (s) => (s?.email == null ? 'never emailed' : 'emailed');
    const detail = readShipping(LIVE_DETAIL_ORDER).shipping;
    assert.equal(naive(detail), 'never emailed',
      '…for an order the other endpoint reports as having had 1 send');
    assert.equal(emailState(detail).state, EMAIL_STATE.UNKNOWN);
  });

  await t.test('a build that drops the is_shipped test collapses two states', () => {
    // Fed through the REAL loader, so the control cannot drift from the thing it controls.
    const broken = shipSrc.replace(
      'const isShipped = shipping?.is_shipped === true;',
      'const isShipped = true;',
    );
    assert.notEqual(broken, shipSrc, 'the positive control must actually change the source');
    const B = loadModules(broken);
    assert.equal(B.emailState({ is_shipped: false, email: { send_count: 0 } }).state, 'unlogged',
      'the broken build calls an unshipped order "may already have been emailed"');
    assert.equal(emailState({ is_shipped: false, email: { send_count: 0 } }).state, EMAIL_STATE.NOT_APPLICABLE,
      'the real one does not — so §5 would catch this regression');
  });

  await t.test('a build that binds the URL box to the DERIVED link freezes it', () => {
    const broken = shipSrc.replace(
      "url: str(shipping?.tracking_url_override),",
      "url: str(shipping?.tracking_url),",
    );
    assert.notEqual(broken, shipSrc);
    const B = loadModules(broken);
    const payload = B.buildPayload(NZC_SHIPPING, B.formFromShipping(NZC_SHIPPING));
    assert.equal('tracking_url' in payload, false,
      'sanity: an untouched form is still equal to itself under the broken build');
    // The damage shows the moment anything else on the form changes: the derived
    // link rides along and is stored as an operator override for good.
    const changed = B.buildPayload({ ...NZC_SHIPPING, tracking_url_override: null },
      { ...B.formFromShipping(NZC_SHIPPING), number: '999' });
    assert.equal(changed.tracking_url, undefined,
      'the field itself is unchanged, but the FORM now shows a link the operator never typed');
    assert.equal(B.formFromShipping(NZC_SHIPPING).url, NZC_SHIPPING.tracking_url,
      'the broken build prefills the derived link…');
    assert.equal(formFromShipping(NZC_SHIPPING).url, '',
      '…and the real one leaves the override box empty, which is the whole point');
  });

  await t.test('a build that matches carriers by NAME re-admits name inference', () => {
    const broken = shipSrc.replace(
      "return registry.find(c => trimmed(c?.code).toLowerCase() === want) || null;",
      "return registry.find(c => trimmed(c?.code).toLowerCase() === want || trimmed(c?.name).toLowerCase() === want) || null;",
    );
    assert.notEqual(broken, shipSrc);
    const B = loadModules(broken);
    assert.notEqual(B.carrierByCode('NZ Couriers', REGISTRY), null, 'the broken build resolves a display name');
    assert.equal(carrierByCode('NZ Couriers', REGISTRY), null, 'the real one refuses to');
  });

  await t.test('the loader really is loading the real module', () => {
    assert.equal(typeof emailState, 'function');
    assert.equal(typeof buildPayload, 'function');
    assert.equal(typeof SHIPPING_REGIME, 'object');
    // If stripEsm silently produced nothing, every assertion above would vacuously
    // pass against `undefined`. This is the control on the control.
    assert.throws(() => loadModules('export function emailState( {'), /./,
      'a module that cannot parse must not load silently');
  });
});

test('§11 Update Status reaches parity, without a second copy of the rules', async (t) => {
  // The status modal used to hand-write its own refusals while the section asked
  // utils/shipping-info.js the same questions. Two copies of a rule drift, and
  // then one surface refuses what the other accepts. It also hand-built its
  // request body — and that hand-built object is exactly what FORGOT the tracking
  // URL, which is the defect this section exists to pin shut.
  const statusModalSrc = ordersSrc.slice(
    ordersSrc.indexOf('function showStatusModal'),
    ordersSrc.indexOf('function showNoteModal'));

  await t.test('the Tracking URL field exists in Update Status', () => {
    assert.ok(statusModalSrc.includes('id="modal-url"'),
      'without it, shipping a DHL or Other parcel from this modal emails the customer no link at all — ' +
      'those two carriers publish nothing we can build a link from');
    assert.ok(statusModalSrc.includes('id="modal-url-help"'));
  });

  await t.test('the URL help goes loud for carriers that build no link', () => {
    assert.match(statusModalSrc, /buildsTrackingUrl\(c\)/,
      'the emphasis must read the server flag, never a carrier name');
    assert.match(statusModalSrc, /om-ship-help--loud/,
      'reuses the section\'s class so the two surfaces cannot look different');
    assert.match(statusModalSrc, /om-ship-input--wanted/);
  });

  await t.test('it calls validateShipping — the shared refusal vocabulary', () => {
    assert.match(statusModalSrc, /validateShipping\(form, carrier, \{ markShipped: true \}\)/,
      'markShipped is the intent: this save WILL flip the status, so "nothing to track by" is an error here');
  });

  await t.test('THE HAND-WRITTEN REFUSALS ARE GONE', () => {
    assert.equal(/Toast\.warning\(`\$\{numberLabel\(null, carrier\)\} is required/.test(statusModalSrc), false,
      'the "tracking number is required" check is validateShipping\'s job now');
    assert.equal(/requiresProductCode\(carrier\) && !pcode/.test(statusModalSrc), false,
      'the ticket-product-code check is validateShipping\'s job now — a second copy is how the two surfaces drift');
  });

  await t.test('the body is built by buildPayload, not by hand', () => {
    assert.match(statusModalSrc, /shippingBody = buildPayload\(null, form, \{ markShipped: true \}\)/);
    assert.equal(/shippingBody = \{ carrier:/.test(statusModalSrc), false,
      'the hand-built object literal is what forgot the tracking URL');
  });

  await t.test('buildPayload(null, …) emits exactly the typed non-empty fields, URL included', () => {
    assert.deepEqual(plain(buildPayload(null, {
      carrierCode: 'dhl', number: 'JD0123', productCode: '', url: 'https://track.dhl.com/x',
    }, { markShipped: true })), {
      carrier: 'dhl', tracking_number: 'JD0123', tracking_url: 'https://track.dhl.com/x', mark_shipped: true,
    });
    // Empty fields are OMITTED, not sent as '' — on a fresh ship there is nothing
    // to clear, and '' would read as a deliberate erasure in the audit.
    assert.deepEqual(plain(buildPayload(null, {
      carrierCode: 'nz_post', number: 'HB1', productCode: '', url: '',
    }, { markShipped: true })), { carrier: 'nz_post', tracking_number: 'HB1', mark_shipped: true });
  });

  await t.test('problems are shown ON the fields, not only in a vanishing toast', () => {
    assert.ok(statusModalSrc.includes('id="modal-ship-issues"'));
    assert.match(statusModalSrc, /om-ship-issue--/, 'reuses the section\'s issue styling');
    assert.match(statusModalSrc, /focus\(\{ preventScroll: true \}\)/,
      'the house scroll+focus pairing (pages/invoices.js) — focus must not fight the scroll');
  });

  await t.test('POSITIVE CONTROL — losing the URL from the form read is catchable', () => {
    // If a future edit drops `url` from readStatusForm(), the body silently loses
    // tracking_url again and DHL customers get no link. Prove the shape differs.
    const withUrl = buildPayload(null, { carrierCode: 'dhl', number: 'X', productCode: '', url: 'https://a.co/b' }, { markShipped: true });
    const without = buildPayload(null, { carrierCode: 'dhl', number: 'X', productCode: '', url: '' }, { markShipped: true });
    assert.equal('tracking_url' in withUrl, true);
    assert.equal('tracking_url' in without, false,
      'the two must be distinguishable, or this test could not tell a dropped field from an empty one');
  });

  await t.test('the dead `canCancel` local is gone', () => {
    assert.equal(/const canCancel/.test(statusModalSrc), false, 'assigned and never used');
  });
});

test('§12 the header Shipping button and the jump', async (t) => {
  await t.test('the button is rendered AND wired', () => {
    assert.match(ordersSrc, /data-action="shipping-info"[^`]*Shipping<\/button>/,
      'the section sits below the fold after Dates; every other primary action has a header button');
    assert.match(ordersSrc, /\[data-action="shipping-info"\]'\)\?\.addEventListener/,
      'a button rendered but never bound looks identical to one that works');
  });

  await t.test('the icon key actually exists in the registry', () => {
    // icon() returns an EMPTY <svg> for an unknown name with no error (app.js),
    // so a typo renders an invisible button. Parse the real registry rather than
    // hard-coding the list here, or this test drifts from it.
    const appSrc = READ(APP);
    const used = ordersSrc.match(/data-action="shipping-info"[\s\S]{0,200}?icon\('([a-z-]+)'/);
    assert.ok(used, 'could not find the icon() call for the Shipping button');
    const registry = appSrc.slice(appSrc.indexOf('const I = {'), appSrc.indexOf('function icon('));
    assert.ok(new RegExp(`['"]?${used[1]}['"]?\\s*:`).test(registry),
      `icon('${used[1]}') is not a key in the registry — it would render an empty <svg> silently`);
  });

  await t.test('the jump targets the HEADING, not the section body', () => {
    // .om-section-title is a SIBLING of .om-shipping, so scrolling to the body
    // lands below the words "Shipping Information".
    assert.match(ordersSrc, /title: 'om-ship-title'/);
    assert.match(ordersSrc, /const title = shipNode\(SHIP_IDS\.title\)/);
    assert.match(ordersSrc, /id="\$\{SHIP_IDS\.title\}"/, 'the title must carry the id it is looked up by');
  });

  await t.test('focus does not fight the scroll, and does not mark the field dirty', () => {
    const fn = ordersSrc.slice(ordersSrc.indexOf('function focusShippingSection'),
                               ordersSrc.indexOf('/** Wire the section.'));
    assert.match(fn, /focus\(\{ preventScroll: true \}\)/);
    assert.equal(/dataset\.dirty\s*=/.test(fn), false,
      'a field marked dirty by a BUTTON PRESS would stop the send-history read correcting it (ERR-179 family)');
  });

  await t.test('the flash restarts on a second press and always clears', () => {
    const fn = ordersSrc.slice(ordersSrc.indexOf('function focusShippingSection'),
                               ordersSrc.indexOf('/** Wire the section.'));
    assert.match(fn, /classList\.remove\('om-shipping--flash'\)[\s\S]*offsetWidth/,
      'without removing the class and forcing reflow, a second press animates nothing');
    assert.match(fn, /animationend/);
    assert.match(fn, /setTimeout\(clear/,
      'under prefers-reduced-motion there is no animation, so animationend never fires — the cue would stick');
  });

  await t.test('the CSS exists, in theme tokens, with a reduced-motion cue that is still visible', () => {
    assert.match(cssSrc, /@keyframes omShipFlash/);
    assert.match(cssSrc, /\.om-shipping--flash/);
    assert.match(cssSrc, /#om-ship-title \{ scroll-margin-top/,
      'without it the heading lands flush against #om-content\'s padding and reads as cut off');
    const reduced = cssSrc.slice(cssSrc.indexOf('@media (prefers-reduced-motion: reduce) {\n  .om-shipping--flash'));
    assert.match(reduced.slice(0, 300), /outline/,
      'reduced motion must still SHOW something — removing the cue makes the button look broken');
  });

  await t.test('the header survives a sixth button', () => {
    // .om-header-btns is absolutely positioned inside an overflow:hidden parent,
    // so anything too wide is CLIPPED with no scrollbar to reveal it.
    const block = cssSrc.slice(cssSrc.indexOf('.om-header-btns {'), cssSrc.indexOf('.om-section-title'));
    assert.match(block, /flex-wrap: wrap/, 'six buttons must wrap, not slide under the title and badge');
    assert.match(block, /max-width:/, 'unconstrained width in an overflow:hidden parent means silent clipping');
    assert.match(block, /@media \(max-width: \d+px\)/,
      'below some width the centred group cannot fit beside the title at all and must leave absolute flow');
    assert.match(block, /position: static/);
  });
});

test('§13 the backend invents a carrier, and the panel must not repeat it', async (t) => {
  // MEASURED 2026-09-01: shipping_information reports carrier "NZ Post" /
  // carrier_code "nz_post" on orders whose orders.carrier column is NULL — 25 of
  // 25 sampled, and 136 of 149 live orders have a null carrier. Left alone, the
  // panel pre-selects NZ Post on every order that has no carrier: the UI
  // asserting a fact the database does not hold. Reported as BF-049.
  const ROW_NO_CARRIER = Object.freeze({ order_number: '2026090102', status: 'paid', carrier: null });
  const BLOCK_DEFAULTED = Object.freeze({
    carrier: 'NZ Post', carrier_code: 'nz_post',
    tracking_number: null, tracking_number_label: 'Tracking number',
    tracking_url: null, tracking_url_override: null, tracking_url_source: null,
    is_shipped: false, can_send_email: false, email: null,
  });

  await t.test('a claimed carrier is removed when the order column says none', () => {
    const fixed = reconcileCarrier(BLOCK_DEFAULTED, ROW_NO_CARRIER);
    assert.equal(fixed.carrier_code, null);
    assert.equal(fixed.carrier, null);
    assert.equal(carrierWasDefaulted(fixed), true);
  });

  await t.test('a REAL carrier is left completely alone', () => {
    // Order 20260829000001: the column says "NZ Post" and so does the block.
    const row = { carrier: 'NZ Post' };
    const block = { ...BLOCK_DEFAULTED, is_shipped: true };
    const out = reconcileCarrier(block, row);
    assert.equal(out.carrier_code, 'nz_post');
    assert.equal(carrierWasDefaulted(out), false);
    assert.equal(out, block, 'an untouched block must be the SAME object — no silent copying');
  });

  await t.test('it only ever corrects DOWNWARD, and never invents one itself', () => {
    const honest = { carrier: null, carrier_code: null };
    assert.equal(reconcileCarrier(honest, { carrier: 'Aramex' }), honest,
      'a row carrier must never be written INTO a block that has none — that would be the same bug, ours');
  });

  await t.test('with no order row, nothing is changed — we cannot tell', () => {
    assert.equal(reconcileCarrier(BLOCK_DEFAULTED, null), BLOCK_DEFAULTED);
    assert.equal(reconcileCarrier(BLOCK_DEFAULTED, {}), BLOCK_DEFAULTED,
      'a payload with no `carrier` KEY is not a payload saying the carrier is null (hasOwnProperty, ERR-199)');
    assert.equal(reconcileCarrier(BLOCK_DEFAULTED, { carrier: undefined }), BLOCK_DEFAULTED,
      'present-but-undefined is still not an authoritative null');
  });

  await t.test('the correction reaches the SAVE BASELINE, not just the screen', () => {
    // If only the rendering were corrected, buildPayload would compare a blank
    // dropdown against a phantom `nz_post` and send a pointless `carrier: ""`.
    const fixed = reconcileCarrier(BLOCK_DEFAULTED, ROW_NO_CARRIER);
    assert.equal(formFromShipping(fixed).carrierCode, '');
    assert.deepEqual(plain(buildPayload(fixed, formFromShipping(fixed))), {},
      'an untouched form on a carrier-less order must still send nothing');
    // And choosing one really does send it.
    assert.deepEqual(plain(buildPayload(fixed, { ...formFromShipping(fixed), carrierCode: 'nz_couriers' })),
      { carrier: 'nz_couriers' });
  });

  await t.test('the page applies it on first paint AND on every later read', () => {
    assert.match(ordersSrc, /const shipping = reconcileCarrier\(raw, o\);/,
      'first paint must not flash a carrier that is not recorded');
    assert.match(ordersSrc, /rowCarrier: Object\.prototype\.hasOwnProperty\.call\(o, 'carrier'\)/,
      'the authoritative column is captured while we still hold the order row');
    assert.match(ordersSrc, /reconcileCarrier\(rawShipping, \{ carrier: _shipState\.rowCarrier \}\)/,
      '/shipping responses and PUT echoes carry no row, so the correction must be re-applied');
  });

  await t.test('a carrier the operator just saved is NOT corrected away', () => {
    assert.match(ordersSrc, /function shipRememberSavedCarrier/);
    assert.match(ordersSrc, /shipRememberSavedCarrier\(payload, shipping\);[\s\S]{0,120}shipAdoptShipping\(shipping, \{ rebaseline: true \}\)/,
      'the column must be updated BEFORE the echo is adopted, or the next read blanks what was just chosen');
  });

  await t.test('POSITIVE CONTROL — without the correction the panel shows a phantom carrier', () => {
    const broken = shipSrc.replace(
      "    if (!orderRow || !has(orderRow, 'carrier')) return shipping;  // nothing authoritative to check against",
      '    return shipping;',
    );
    assert.notEqual(broken, shipSrc);
    const B = loadModules(broken);
    assert.equal(B.reconcileCarrier(BLOCK_DEFAULTED, ROW_NO_CARRIER).carrier_code, 'nz_post',
      'the broken build keeps the invented carrier…');
    assert.equal(B.formFromShipping(B.reconcileCarrier(BLOCK_DEFAULTED, ROW_NO_CARRIER)).carrierCode, 'nz_post',
      '…and it reaches the dropdown, which is the bug');
    assert.equal(reconcileCarrier(BLOCK_DEFAULTED, ROW_NO_CARRIER).carrier_code, null,
      'the real one does not');
  });
});

test('§10 shipping hygiene', async (t) => {
  await t.test('the live probe exists and is wired to an npm script', () => {
    assert.equal(fs.existsSync(PROBE), true, 'scripts/probe-shipping-information.mjs must exist');
    const pkg = JSON.parse(READ(PKG));
    assert.equal(pkg.scripts['probe:shipping-info'], 'node scripts/probe-shipping-information.mjs');
  });

  await t.test('the probe is read-only and says so before it does anything', () => {
    const probe = READ(PROBE);
    assert.match(probe, /MODE: READ-ONLY/, 'the mode is PRINTED so it can never be assumed');
    // The rule is that the probe cannot RECORD, not that the word may not appear
    // — its own header explains why there is no such mode. So pin the absence of
    // an implementation: no argv reading, no flag set, no write to disk.
    const code = stripComments(probe);
    assert.equal(/process\.argv/.test(code), false,
      'a probe that reads flags can grow a --record mode, and then a green run may be green because it overwrote the baseline');
    assert.equal(/fs\.writeFileSync|fs\.appendFileSync|fs\.promises\.write/.test(code), false,
      'this probe must not write to disk at all');
    assert.match(probe, /No --record mode exists/,
      'and the header must say so, since the mode line is what a reader trusts');
    assert.match(probe, /process\.exit\(2\)/, 'a run that could not run must not exit 0 — a skip is not a pass');
  });

  await t.test('the probe never sends a real customer an email', () => {
    const probe = stripComments(READ(PROBE));
    assert.equal(/send_email\s*:\s*true/.test(probe), false);
    assert.equal(/mark_shipped\s*:\s*true/.test(probe), false);
    assert.equal(/shipping\/send-email/.test(probe), false,
      'the send endpoint emails a real customer; a probe must never call it');
  });

  await t.test('probes live in scripts/, never in the publicly-served tree', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'inkcartridges', 'scripts', 'probe-shipping-information.mjs')), false,
      'inkcartridges/ is the Vercel output directory — a file there that reads .env is one URL from the internet');
  });

  await t.test('APP_VERSION was bumped for the admin change', () => {
    const app = READ(APP);
    const m = app.match(/const APP_VERSION = '([^']+)'/);
    assert.ok(m, 'APP_VERSION must exist');
    assert.match(m[1], /shipping-information/, 'lazily-imported page modules are busted by this constant alone');
    assert.match(m[1], /^2026\.\d{2}\.\d{2}-[a-z0-9-]+$/, 'and it must keep the dated build-tag grammar');
  });

  await t.test('the section\'s CSS is defined, in theme tokens', () => {
    for (const cls of [
      '.om-shipping', '.om-ship-grid', '.om-ship-issue--error', '.om-ship-issue--warn',
      '.om-ship-sendstate--unlogged', '.om-ship-sendstate--unknown', '.om-ship-registry-error',
      '.om-ship-why', '.om-ship-why__next',
      '.om-ship-input--bad', '.om-ship-link',
    ]) {
      assert.ok(cssSrc.includes(cls), `admin.css is missing ${cls}`);
    }
    const block = cssSrc.slice(cssSrc.indexOf('.om-shipping {'), cssSrc.indexOf('@media (max-width: 720px)', cssSrc.indexOf('.om-shipping {')));
    assert.equal(/#[0-9a-f]{6}(?![^(]*\))/i.test(block.replace(/var\([^)]*\)/g, '')), false,
      'colours must come from the theme tokens, or the section only reads correctly in one deck');

    // A var() naming a token nobody defines is not an error anywhere — the
    // property just falls back to inherited and the text quietly wears the wrong
    // colour in one deck. `--text-primary` is not a token in this stylesheet; it
    // reads like one, and it is used elsewhere in the file to this day.
    const used = new Set([...block.matchAll(/var\((--[a-z0-9-]+)/gi)].map(m => m[1]));
    for (const token of used) {
      assert.ok(new RegExp(`\\${token}\\s*:`).test(cssSrc),
        `${token} is used in the shipping section but never defined — silent fallback, wrong colour`);
    }
  });

  await t.test('the handoff is filed where incoming briefs live', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'readfirst', 'shipping-information-section-FE-handoff-sep2026.md')), true);
  });
});
