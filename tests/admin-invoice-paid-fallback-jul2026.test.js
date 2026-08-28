/**
 * Invoices: the PAID toggle's PATCH→PUT fallback — ERR-138 / BF-021, July 2026
 * ===========================================================================
 *
 * ERR-131 (2026-07-30) rewired the toggle from a route that never existed
 * (`POST /:id/paid`) to the real one (`PATCH /:id/status`) — and found, in the
 * same audit, that the real route is unreachable from a browser: the API answers
 * a PATCH preflight with
 *
 *     Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
 *
 * i.e. no PATCH, from the production origin and from localhost alike. Chrome
 * kills the request before it is sent. That is BF-021.
 *
 * On 2026-07-31 a backend handoff declared the slider "shipped & live — no
 * further backend change needed". Re-probed warm, ×3, on both hosts and both
 * origins, BF-021 was STILL OPEN:
 *
 *     OPTIONS /:id/status  (Request-Method: PATCH) → Allow-Methods: …no PATCH
 *     PATCH   /:id/status                         → 401  (route is live)
 *     PUT     /:id/status                         → 404  (no alternate verb)
 *     POST    /:id/status                         → 404
 *     PUT     /api/admin/invoices/:id             → 401  (live AND CORS-allowed)
 *
 * So the toggle now falls back: when — and ONLY when — the PATCH fails as an
 * opaque transport error, it re-routes through `PUT /api/admin/invoices/:id`,
 * the same full-invoice update the editor drawer's Save already performs. PATCH
 * stays the preferred call, so the fallback retires itself the day BF-021 lands.
 *
 * What this file pins, and why each one is load-bearing:
 *
 *   §1  PATCH is TRIED FIRST and, when it works, nothing else is called. If the
 *       fallback ever became the primary path it would silently outlive BF-021,
 *       doing two writes forever.
 *   §2  The fallback preserves the invoice. `buildPayload` sends
 *       `invoice_number: d.invoice_number || null`, and null tells the backend to
 *       ASSIGN THE NEXT NUMBER IN SERIES — so a careless round-trip would
 *       renumber a document the customer already holds. Run for real against the
 *       actual draftFromInvoice → buildPayload chain, not a mock of it.
 *   §3  ONLY a bare transport failure falls back. A coded rejection
 *       (CONFLICT/NOT_FOUND/RATE_LIMITED/VALIDATION_FAILED) is the server saying
 *       no; replaying it through a heavier write route is trying to talk the
 *       backend out of an answer it already gave.
 *   §4  The guards each ABORT rather than write a rewritten record: void,
 *       missing invoice number, unreadable line items, unreadable invoice.
 *       A refused toggle is an inconvenience; a corrupted invoice is not
 *       recoverable.
 *   §5  A read that failed is not an empty invoice (absence-as-zero —
 *       ERR-063/068/073/075/076/127/131).
 *   §6  The degraded path is LOUD: it is in the return value, it is logged, and
 *       it is stated to the operator once per session. A fallback nobody can see
 *       makes BF-021 permanent.
 *   §7  Error copy no longer blames PATCH — that case is now handled — and a
 *       coded error keeps its own message.
 *   §8  No screen tells an operator that a LIVE route is "backend pending". Every
 *       admin invoice / contact / quick-order / expense write route was probed at
 *       401 on 2026-07-31. That reassuring-but-wrong excuse is exactly what hid
 *       ERR-131 for a month; this is its third recurrence, so it gets a scan.
 *   §9  The keyboard can see the toggle, and returning browsers get the new build.
 *
 * Run: node --test tests/admin-invoice-paid-fallback-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const INVOICES_SRC = READ('js/admin/pages/invoices.js');
const ADMIN_API_SRC = READ('js/admin/api.js');
const APP_SRC = READ('js/admin/app.js');
const CSS_SRC = READ('css/admin.css');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** The body of a named function, by brace matching (house idiom). */
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const fnBody = (src, sig) => extractFunction(src, sig);

/**
 * Build a live sandbox holding the REAL status-flip chain.
 *
 * The point of running it rather than grepping it: §2's renumber guard is only
 * meaningful if the actual `draftFromInvoice` → `buildPayload` round-trip is the
 * thing under test. A mocked payload builder would happily "preserve" a number
 * the real one drops.
 *
 * The whole pure-helper span of invoices.js (escA … just before the page
 * lifecycle) is evaluated, then the four flip functions on top of it. The span
 * markers are asserted, so a refactor that moves these helpers fails loudly here
 * instead of quietly testing nothing.
 */
function makeSandbox() {
  const START = 'const escA =';
  const END = '// =========================================================================\n//  Page lifecycle';
  const start = INVOICES_SRC.indexOf(START);
  const end = INVOICES_SRC.indexOf(END);
  assert.ok(start > -1 && end > start, 'helper-span markers must exist in invoices.js');

  const calls = [];
  const toasts = [];
  const warnings = [];

  const AdminAPI = {
    setInvoiceStatus: async () => { throw new Error('setInvoiceStatus not stubbed for this test'); },
    getInvoice: async () => { throw new Error('getInvoice not stubbed for this test'); },
    updateInvoice: async () => { throw new Error('updateInvoice not stubbed for this test'); },
  };
  // Record every call so a test can assert what did NOT happen, which is most of
  // what matters here.
  const record = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };

  const ctx = {
    window: { Security: null, DebugLog: { warn: (m, e) => warnings.push(`${m} ${e ?? ''}`) } },
    localStorage: { getItem: () => null, setItem: () => {} },
    console, Date, Math, JSON, Number, Object, String, Array, Boolean, Intl,
    isNaN, parseInt, parseFloat, Error, TypeError, Promise,
    // Module-level imports referenced inside the span.
    costOrNull: (v) => (v == null || v === '' ? null : Number(v)),
    computeInvoiceTotals: () => ({ subtotal: 0, gst: 0, total: 0 }),
    computeInvoiceCogs: () => ({}), computeInvoiceProfit: () => ({}),
    normalizeInvoice: (x) => x, invoiceDocRows: () => [],
    marginBadge: () => '', formatProfitDollars: () => '',
    GST_INCL: '', GST_EXCL: '', GST_NET: '', gstSub: () => '',
    esc: (s) => String(s ?? ''), icon: () => '',
    // Security is a bare top-level `const` in security.js, reachable as a global
    // lexical binding and NOT as window.Security (ERR-167) — mirror that here.
    Security: { escapeHtml: (s) => String(s ?? ''), escapeAttr: (s) => String(s ?? '') },
    // utils/invoice-quote.js — the volume-ladder half of the line model.
    PRICE_AUTO: 'auto', PRICE_MANUAL: 'manual', FREIGHT_CUSTOM: 'custom', MAX_QUOTE_LINES: 200,
    computeInvoiceVolumeSavings: () => 0, lineDocNote: () => '',
    quoteRequestBody: () => null, normalizeQuote: () => null,
    applyQuoteToLines: (lines) => ({ lines, applied: [], offers: [], changed: false }),
    clearVolume: (l) => l, volumeBadge: () => null, formatVolumePercent: () => '',
    resolveShippingSelection: () => ({ key: 'custom', option: null, isCustom: true, available: false }),
    freeShippingLost: () => ({ lost: false }), freeShippingAvailable: () => false,
    parcelWeightNote: () => '',
    // Freight ownership (ERR-178). The module-global block this sandbox evaluates
    // initialises _freightOwner from FREIGHT_OWNER_NONE, so the constant must
    // exist here or every test in this file dies before it starts.
    FREIGHT_OWNER_NONE: 'none', FREIGHT_OWNER_AUTO: 'auto', FREIGHT_OWNER_OPERATOR: 'operator',
    planFreightAutofill: () => ({ apply: false, key: null, option: null, owner: 'none', announce: null }),
    freeShippingGapNote: () => '',
    AdminAuth: { isOwner: () => true },
    AdminAPI,
    Toast: {
      success: (m) => toasts.push({ type: 'success', m }),
      error: (m) => toasts.push({ type: 'error', m }),
      warning: (m) => toasts.push({ type: 'warning', m }),
      info: (m) => toasts.push({ type: 'info', m }),
    },
    Modal: {}, Drawer: {}, DataTable: function () {},
    attachAutocomplete: () => {}, attachProductAutocomplete: () => {},
    productCostExGst: () => 0, resolveSkus: () => null,
    codesToVerify: () => [], applyResolvedCodes: () => [], unresolvedLineErrors: () => [],
    parseQuickOrderPrefill: () => null, flipTargetFrom: () => null,
  };
  vm.createContext(ctx);
  vm.runInContext(INVOICES_SRC.slice(start, end), ctx);
  vm.runInContext([
    fnBody(INVOICES_SRC, 'function isNetworkFailure(err)'),
    fnBody(INVOICES_SRC, 'function differs(stored, outgoing)'),
    fnBody(INVOICES_SRC, 'function documentDrift(rec, payload)'),
    fnBody(INVOICES_SRC, 'async function setStatusViaFullUpdate(id, wanted)'),
    fnBody(INVOICES_SRC, 'async function setStatusWithFallback(id, wanted)'),
    'let _fallbackAnnounced = false;',
    fnBody(INVOICES_SRC, 'function announceFallbackOnce()'),
    fnBody(INVOICES_SRC, 'function statusErrorMessage(err)'),
    fnBody(INVOICES_SRC, 'function saveErrorMessage(err)'),
    ';this.__x = { setStatusWithFallback, setStatusViaFullUpdate, announceFallbackOnce,'
      + ' statusErrorMessage, saveErrorMessage, isNetworkFailure, draftFromInvoice, buildPayload,'
      + ' documentDrift, differs };',
  ].join('\n'), ctx);

  return { api: ctx.__x, AdminAPI, calls, toasts, warnings, record };
}

/** A realistic saved-invoice record as the backend serialises it. */
const INVOICE = Object.freeze({
  id: 'inv-1',
  invoice_number: 1042,
  status: 'unpaid',
  issue_date: '2026-07-14',
  order_date: '2026-07-12',
  payment_due: '2026-08-20',
  payment_due_pref: '20',
  show_due_date: true,
  customer: { name: 'Acme Ltd', company: 'Acme', email: 'ap@acme.example', address: ['1 Queen St', 'Auckland'] },
  line_items: [
    { product_code: 'CN045', description: 'Canon PG-545 Black', quantity: 2, unit_cost_excl_gst: 31.3 },
    { product_code: 'CN046', description: 'Canon CL-546 Colour', quantity: 1, unit_cost_excl_gst: 34.78 },
  ],
  freight_excl_gst: 5,
  emailed_at: '2026-07-15T02:00:00Z',
  email_count: 2,
});

const netErr = () => new TypeError('Failed to fetch');
const coded = (code, msg) => Object.assign(new Error(msg), { code });

/**
 * Values built inside the vm come back with that realm's Array/Object prototypes,
 * which deepStrictEqual refuses to match against this realm's. Round-trip through
 * JSON so the assertion compares the DATA — which is also exactly what the real
 * `API.put()` sends, since it JSON.stringify's the payload.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

// ─────────────────────────────────────────────────────────────────────────────
// §1  PATCH is the preferred path, and a working PATCH ends the story
// ─────────────────────────────────────────────────────────────────────────────

test('§1 a successful PATCH never touches the fallback routes', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = s.record('setInvoiceStatus', async () => ({ ...INVOICE, status: 'paid' }));
  s.AdminAPI.getInvoice = s.record('getInvoice', async () => INVOICE);
  s.AdminAPI.updateInvoice = s.record('updateInvoice', async () => INVOICE);

  const out = await s.api.setStatusWithFallback('inv-1', 'paid');

  assert.equal(out.via, 'patch', 'the caller is told which route actually ran');
  assert.equal(out.invoice.status, 'paid');
  assert.deepEqual(s.calls.map((c) => c.name), ['setInvoiceStatus'],
    'no GET and no PUT — one request, exactly as the endpoint was designed for');
});

test('§1 the day BF-021 lands, the fallback stops running with no code change', () => {
  // The guard is structural: PATCH is inside the try, the fallback only inside
  // the catch. Nothing schedules the PUT unconditionally.
  const body = fnBody(INVOICES_SRC, 'async function setStatusWithFallback(id, wanted)');
  const iTry = body.indexOf('AdminAPI.setInvoiceStatus');
  const iCatch = body.indexOf('} catch');
  const iFallback = body.indexOf('setStatusViaFullUpdate');
  assert.ok(iTry > -1 && iCatch > iTry, 'the PATCH is attempted first, inside the try');
  assert.ok(iFallback > iCatch, 'the fallback is reachable ONLY from the catch');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  A blocked preflight re-routes through PUT — without rewriting the invoice
// ─────────────────────────────────────────────────────────────────────────────

test('§2 a blocked PATCH preflight falls back to GET + PUT', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = s.record('setInvoiceStatus', async () => { throw netErr(); });
  s.AdminAPI.getInvoice = s.record('getInvoice', async () => INVOICE);
  s.AdminAPI.updateInvoice = s.record('updateInvoice', async (_id, payload) => ({ ...INVOICE, ...payload, status: payload.status }));

  const out = await s.api.setStatusWithFallback('inv-1', 'paid');

  assert.equal(out.via, 'put-fallback');
  assert.equal(out.invoice.status, 'paid');
  assert.deepEqual(s.calls.map((c) => c.name), ['setInvoiceStatus', 'getInvoice', 'updateInvoice']);
});

test('§2 the PUT preserves the invoice NUMBER — a flip must never renumber a document', async () => {
  // buildPayload sends `invoice_number: d.invoice_number || null`, and the backend
  // reads null as "assign the next in series". This is the single most dangerous
  // thing about the fallback, so it is asserted against the real payload builder.
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => INVOICE;
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, payload) => { sent = payload; return { ...INVOICE, status: payload.status }; };

  await s.api.setStatusWithFallback('inv-1', 'paid');

  assert.equal(sent.invoice_number, 1042, 'the existing number is sent back verbatim');
  assert.notEqual(sent.invoice_number, null, 'null would tell the backend to renumber it');
});

test('§2 the PUT preserves line items, freight and dates; only status moves', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => INVOICE;
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, payload) => { sent = payload; return { ...INVOICE, status: payload.status }; };

  await s.api.setStatusWithFallback('inv-1', 'paid');
  const put = plain(sent);

  assert.equal(put.status, 'paid', 'the one field that is supposed to change');
  assert.equal(put.line_items.length, 2, 'both lines survive the round-trip');
  assert.deepEqual(put.line_items.map((l) => l.product_code), ['CN045', 'CN046']);
  assert.deepEqual(put.line_items.map((l) => l.quantity), [2, 1]);
  assert.deepEqual(put.line_items.map((l) => l.unit_cost_excl_gst), [31.3, 34.78]);
  assert.equal(put.freight_excl_gst, 5);
  assert.equal(put.issue_date, '2026-07-14');
  assert.equal(put.order_date, '2026-07-12');
  assert.equal(put.customer.name, 'Acme Ltd');
  assert.deepEqual(put.customer.address, ['1 Queen St', 'Auckland']);
});

test('§2 the PUT does NOT echo server-owned send history back at the backend', async () => {
  // draftFromInvoice carries emailed_at/email_count for the SENT column; buildPayload
  // deliberately omits them, so a full-payload PUT can't wipe the send log (ERR-131 §10).
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => INVOICE;
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, payload) => { sent = payload; return INVOICE; };

  await s.api.setStatusWithFallback('inv-1', 'unpaid');

  for (const k of ['emailed_at', 'email_count', 'last_emailed_at', 'last_emailed_to']) {
    assert.equal(k in sent, false, `${k} is server-owned and must not be written back`);
  }
});

test('§2 unpaid flips too — the mapping is not paid-only', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => ({ ...INVOICE, status: 'paid' });
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, payload) => { sent = payload; return { ...INVOICE, status: 'unpaid' }; };

  const out = await s.api.setStatusWithFallback('inv-1', 'unpaid');
  assert.equal(sent.status, 'unpaid');
  assert.equal(out.invoice.status, 'unpaid');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2b  buildPayload is an EDITOR payload — it must not fill gaps here
//
// Caught on the FIRST live flip, not by any of the tests above: invoice #3267
// stored `payment_due: null`, and `effectiveDueDate()` obligingly derived
// 2026-08-20 from `payment_due_pref: '20'`. Flicking the switch gave an invoice
// that had already been emailed to a customer a due date it never had.
//
// That is correct behaviour for an operator editing the form and wrong behaviour
// for a status toggle. The server's record now wins for every field it stores.
// ─────────────────────────────────────────────────────────────────────────────

/** The real #3267: a due date that is stored as null, and no `show_due_date` key. */
const NO_DUE_DATE = Object.freeze({
  ...INVOICE,
  payment_due: null,
  payment_due_pref: '20',
  emailed_at: '2026-07-27T02:10:07.587+00:00',
});

test('§2b a null payment_due stays null — the flip must not mint a due date', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => NO_DUE_DATE;
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, p) => { sent = p; return { ...NO_DUE_DATE, status: 'paid' }; };

  await s.api.setStatusWithFallback('inv-1', 'paid');

  assert.equal(plain(sent).payment_due, null,
    'the editor would derive 2026-08-20 here; a status toggle must not put a date on the document');
});

test('§2b the server record wins for every stored field; only status comes from the draft', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => NO_DUE_DATE;
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, p) => { sent = p; return { ...NO_DUE_DATE, status: 'paid' }; };

  await s.api.setStatusWithFallback('inv-1', 'paid');
  const put = plain(sent);

  for (const k of ['invoice_number', 'issue_date', 'order_date', 'payment_due', 'freight_excl_gst']) {
    assert.deepEqual(put[k], NO_DUE_DATE[k], `${k} must come from the server record, not the draft`);
  }
  assert.equal(put.status, 'paid', 'status is the one field the draft supplies');
});

test('§2b a payload that would change any other field is REFUSED, not sent', async () => {
  // Force the drift by handing back a record whose stored value cannot survive the
  // pin — `documentDrift` re-derives its comparison from the payload's own keys, so
  // this is the tripwire for a future buildPayload field the pin loop doesn't know.
  const s = makeSandbox();
  const drift = s.api.documentDrift(
    { invoice_number: 1042, notes: 'original note', status: 'unpaid' },
    { invoice_number: 1042, notes: 'REWRITTEN', status: 'paid' },
  );
  assert.deepEqual(drift, ['notes'], 'a changed document field is named');
  assert.equal(s.api.documentDrift({ status: 'unpaid' }, { status: 'paid' }).length, 0,
    'status itself is the point of the write, never drift');
});

test('§2b key ORDER and server-computed extras are not mistaken for drift', () => {
  // Measured live: seller/customer/footer come back with different key order, and
  // each line carries a server-computed `line_total_excl_gst` the payload omits.
  // A plain JSON.stringify comparison calls all four of those a change and would
  // have made the toggle refuse on every real invoice.
  const s = makeSandbox();
  const rec = {
    customer: { attn: 'A', name: 'Acme', email: 'e@x.co' },
    line_items: [{ product_code: 'X1', quantity: 1, unit_cost_excl_gst: 5, line_total_excl_gst: 5 }],
  };
  const payload = {
    customer: { name: 'Acme', email: 'e@x.co', attn: 'A' },        // same data, different order
    line_items: [{ product_code: 'X1', quantity: 1, unit_cost_excl_gst: 5 }],  // no server total
  };
  assert.deepEqual(s.api.documentDrift(rec, payload), [], 'neither is a real change');

  payload.line_items[0].quantity = 9;
  assert.deepEqual(s.api.documentDrift(rec, payload), ['line_items'], 'a real line change still trips it');
});

test('§2b fields the server does not store cannot be "drift"', () => {
  const s = makeSandbox();
  // show_due_date / preview_totals are client-side; source_order_id may be absent.
  const drift = s.api.documentDrift(
    { invoice_number: 7 },
    { invoice_number: 7, show_due_date: true, preview_totals: { total: 1 }, delivery: null },
  );
  assert.deepEqual(drift, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  Only an opaque transport failure earns a second attempt
// ─────────────────────────────────────────────────────────────────────────────

for (const code of ['CONFLICT', 'NOT_FOUND', 'RATE_LIMITED', 'VALIDATION_FAILED', 'FORBIDDEN']) {
  test(`§3 a ${code} rejection is NOT retried through the PUT route`, async () => {
    const s = makeSandbox();
    s.AdminAPI.setInvoiceStatus = s.record('setInvoiceStatus', async () => { throw coded(code, `${code} from server`); });
    s.AdminAPI.getInvoice = s.record('getInvoice', async () => INVOICE);
    s.AdminAPI.updateInvoice = s.record('updateInvoice', async () => INVOICE);

    await assert.rejects(() => s.api.setStatusWithFallback('inv-1', 'paid'), (e) => e.code === code);
    assert.deepEqual(s.calls.map((c) => c.name), ['setInvoiceStatus'],
      'the server already answered — do not go looking for a different answer');
  });
}

test('§3 the trigger is isNetworkFailure, not "any error"', () => {
  const s = makeSandbox();
  assert.equal(s.api.isNetworkFailure(new TypeError('Failed to fetch')), true);
  assert.equal(s.api.isNetworkFailure(new TypeError('Load failed')), true, 'Safari wording');
  assert.equal(s.api.isNetworkFailure(new TypeError('NetworkError when attempting to fetch')), true, 'Firefox wording');
  assert.equal(s.api.isNetworkFailure(coded('CONFLICT', 'Failed to fetch')), false,
    'a coded error is a server answer even if its message looks like a transport failure');
  assert.equal(s.api.isNetworkFailure(new Error('Update invoice status failed')), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4  The guards abort rather than write a rewritten record
// ─────────────────────────────────────────────────────────────────────────────

test('§4 a VOID invoice is refused, and nothing is written', async () => {
  // The PATCH route 409s on void because voiding also cancelled the shadow order.
  // PUT holds no such opinion and would happily un-void it.
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = s.record('getInvoice', async () => ({ ...INVOICE, status: 'void' }));
  s.AdminAPI.updateInvoice = s.record('updateInvoice', async () => INVOICE);

  await assert.rejects(() => s.api.setStatusWithFallback('inv-1', 'paid'), (e) => e.code === 'CONFLICT');
  assert.equal(s.calls.some((c) => c.name === 'updateInvoice'), false, 'a void invoice is never PUT back');
});

test('§4 the void check reads the SERVER copy, not the row that was clicked', () => {
  const body = fnBody(INVOICES_SRC, 'async function setStatusViaFullUpdate(id, wanted)');
  const iGet = body.indexOf('getInvoice');
  const iVoid = body.indexOf("=== 'void'");
  assert.ok(iGet > -1 && iVoid > iGet, 'the void re-check happens AFTER the fetch, against rec');
  assert.match(body, /rec\.status === 'void'/);
});

test('§4 an invoice with NO NUMBER is refused — re-saving it could renumber it', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = s.record('getInvoice', async () => ({ ...INVOICE, invoice_number: null }));
  s.AdminAPI.updateInvoice = s.record('updateInvoice', async () => INVOICE);

  await assert.rejects(() => s.api.setStatusWithFallback('inv-1', 'paid'), /renumber/i);
  assert.equal(s.calls.some((c) => c.name === 'updateInvoice'), false);
});

test('§4 an invoice whose lines could not be read back is refused', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  // Lines present on the server, but in a shape draftFromInvoice can't map to
  // anything with a code or description — realLines() would drop them all.
  s.AdminAPI.getInvoice = s.record('getInvoice', async () => ({
    ...INVOICE, line_items: [{ quantity: 1 }, { quantity: 3 }],
  }));
  s.AdminAPI.updateInvoice = s.record('updateInvoice', async () => INVOICE);

  await assert.rejects(() => s.api.setStatusWithFallback('inv-1', 'paid'), /empty it/i);
  assert.equal(s.calls.some((c) => c.name === 'updateInvoice'), false,
    'a lossy round-trip must never blank an invoice');
});

test('§4 a genuinely empty invoice is still flippable — the guard is about LOSS, not emptiness', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => ({ ...INVOICE, line_items: [] });
  let sent = null;
  s.AdminAPI.updateInvoice = async (_id, p) => { sent = p; return { ...INVOICE, status: 'paid' }; };

  const out = await s.api.setStatusWithFallback('inv-1', 'paid');
  assert.equal(out.via, 'put-fallback');
  assert.equal(plain(sent).line_items.length, 0, 'nothing was there to lose');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5  A failed read is not an empty invoice
// ─────────────────────────────────────────────────────────────────────────────

test('§5 getInvoice() returning null throws — it never PUTs a blank draft', async () => {
  // getInvoice fails soft to null (adminApiWarn + return null). Treating that as
  // "an invoice with no fields" would PUT a fresh draft over a real record and
  // erase it. Eighth entry in the absence-as-zero family.
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = s.record('getInvoice', async () => null);
  s.AdminAPI.updateInvoice = s.record('updateInvoice', async () => INVOICE);

  await assert.rejects(() => s.api.setStatusWithFallback('inv-1', 'paid'), /read that invoice/i);
  assert.equal(s.calls.some((c) => c.name === 'updateInvoice'), false,
    'absence is not an empty invoice — nothing is written');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  The degraded path is loud
// ─────────────────────────────────────────────────────────────────────────────

test('§6 the route used is in the RETURN VALUE, not just a log line', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => INVOICE;
  s.AdminAPI.updateInvoice = async () => ({ ...INVOICE, status: 'paid' });

  const out = await s.api.setStatusWithFallback('inv-1', 'paid');
  assert.equal(out.via, 'put-fallback', 'the caller can act on how the write happened');
});

test('§6 every fallback use is logged, naming BF-021', async () => {
  const s = makeSandbox();
  s.AdminAPI.setInvoiceStatus = async () => { throw netErr(); };
  s.AdminAPI.getInvoice = async () => INVOICE;
  s.AdminAPI.updateInvoice = async () => ({ ...INVOICE, status: 'paid' });

  await s.api.setStatusWithFallback('inv-1', 'paid');
  assert.equal(s.warnings.some((w) => /BF-021/.test(w)), true,
    'the log names the tracked backend bug, not just "something failed"');
});

test('§6 the operator is told ONCE per session, not once per click', () => {
  const s = makeSandbox();
  s.api.announceFallbackOnce();
  s.api.announceFallbackOnce();
  s.api.announceFallbackOnce();
  const infos = s.toasts.filter((t) => t.type === 'info');
  assert.equal(infos.length, 1, 'a per-click nag would train the operator to ignore it');
  assert.match(infos[0].m, /BF-021/, 'it names the bug so it can actually be chased');
  assert.match(infos[0].m, /saved/i, 'and reassures them the change did land');
});

test('§6 the toggle announces the fallback and repaints from the server', () => {
  const TOGGLE = INVOICES_SRC.slice(
    INVOICES_SRC.indexOf("if (action === 'toggle-paid')"),
    INVOICES_SRC.indexOf("} else if (action === 'sent-history')"),
  );
  assert.match(TOGGLE, /setStatusWithFallback\(id, wanted\)/, 'the toggle goes through the fallback wrapper');
  assert.match(TOGGLE, /via === 'put-fallback'/, 'and reacts to which route ran');
  assert.match(TOGGLE, /announceFallbackOnce\(\)/);
  assert.match(TOGGLE, /applyRowStatus\(id, inv, wanted\)/, 'still repaints from the server invoice');
  const iCatch = TOGGLE.indexOf('} catch');
  assert.ok(TOGGLE.indexOf('btn.checked = ') > iCatch, 'the revert still lives in the catch');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  Error copy tells the truth about which thing failed
// ─────────────────────────────────────────────────────────────────────────────

test('§7 a transport failure no longer blames PATCH — that case is handled now', () => {
  const s = makeSandbox();
  const out = s.api.statusErrorMessage(new TypeError('Failed to fetch'));
  assert.doesNotMatch(out, /^Failed to fetch$/, 'never paint the raw TypeError at an operator');
  assert.doesNotMatch(out, /PATCH/,
    'reaching here means the CORS-allowed PUT failed too, i.e. connectivity — not the method gap');
  assert.match(out, /wasn’t saved|was not saved/, 'it says plainly that nothing was written');
});

test('§7 coded errors keep their own, actionable copy', () => {
  const s = makeSandbox();
  assert.match(s.api.statusErrorMessage(coded('CONFLICT', 'x')), /void/i);
  assert.match(s.api.statusErrorMessage(coded('NOT_FOUND', 'x')), /no longer exists|refresh/i);
  assert.match(s.api.statusErrorMessage(coded('RATE_LIMITED', 'x')), /too many/i);
  assert.doesNotMatch(s.api.statusErrorMessage(coded('CONFLICT', 'x')), /connection/i,
    'a real API answer must not be swallowed by the network branch');
});

test('§7 a guard refusal reaches the operator as its own explanation', () => {
  const s = makeSandbox();
  const out = s.api.statusErrorMessage(new Error('That invoice has no number on the server, so re-saving it could renumber it — refusing to change its status.'));
  assert.match(out, /renumber/, 'the guard explains itself rather than being flattened to a generic failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7b  saveInvoice() surfaces what the backend actually said
// ─────────────────────────────────────────────────────────────────────────────

test('§7b a save rejection surfaces error.message AND details.reason', () => {
  const s = makeSandbox();
  const err = Object.assign(new Error('Invoice could not be saved'), {
    code: 'VALIDATION_FAILED',
    details: { reason: 'customer.name must not be blank' },
  });
  const out = s.api.saveErrorMessage(err);
  assert.match(out, /Invoice could not be saved/);
  assert.match(out, /customer\.name must not be blank/, 'the reason is what tells the operator what to FIX');
});

test('§7b per-field details arrays are surfaced, not dropped', () => {
  const s = makeSandbox();
  const out = s.api.saveErrorMessage(Object.assign(new Error('Validation failed'), {
    details: ['line 2: unknown product code', 'customer.name is required'],
  }));
  assert.match(out, /unknown product code/);
  assert.match(out, /customer\.name is required/);
});

test('§7b a duplicated reason is not printed twice', () => {
  const s = makeSandbox();
  const out = s.api.saveErrorMessage(Object.assign(new Error('customer.name is required'), {
    details: { reason: 'customer.name is required' },
  }));
  assert.equal(out.match(/customer\.name is required/g).length, 1);
});

test('§7b a silent server failure says so instead of inventing a cause', () => {
  const s = makeSandbox();
  const out = s.api.saveErrorMessage(new Error(''));
  assert.doesNotMatch(out, /may not be live|backend pending|not.{0,10}built/i,
    'the invoicing routes are live (probed 401, 2026-07-31) — never blame an unbuilt backend');
  assert.match(out, /didn’t say why|did not say why/, 'unknown is reported as unknown');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8  No screen calls a LIVE route "backend pending"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments so prose may still QUOTE the retired copy (errors.md and the
 * code comments both need to, or the lesson is unrecorded) while the strings an
 * operator can actually read stay clean.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

test('§8 no operator-facing copy blames an unbuilt backend for a live route', () => {
  // Probed warm on 2026-07-31, all 401 (route live) — never 404:
  //   invoices: GET/POST/PUT/DELETE /:id, /:id/void, /:id/email, /:id/pdf, /:id/emails
  //   contacts: GET/POST/PUT/DELETE      quick-orders: GET/POST/PUT/DELETE
  //   customers/:id/invoicing (PUT)      expenses: GET/POST
  const BANNED = [
    /may not be live yet/i,
    /\(backend pending\)/i,
    /available yet \(backend endpoint pending\)/i,
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) {
        const clean = stripComments(fs.readFileSync(p, 'utf8'));
        for (const re of BANNED) {
          if (re.test(clean)) offenders.push(`${path.relative(ROOT, p)} :: ${re}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'inkcartridges', 'js'));
  assert.deepEqual(offenders, [],
    'a reassuring, wrong explanation stops anyone from looking — it is why ERR-131 sat broken for a month');
});

test('§8 a NOT_FOUND on delete means the record is gone, not the route', () => {
  const src = stripComments(INVOICES_SRC);
  const i = src.indexOf("action === 'delete'");
  assert.ok(i > -1);
  const block = src.slice(i, i + 900);
  assert.match(block, /NOT_FOUND/);
  assert.match(block, /no longer exists/i);
});

test('§8 the dead POST /:id/paid route has still not come back', () => {
  // Kept alongside the ERR-131 file's own §1: this file is where a future edit to
  // the fallback would most plausibly reintroduce a hand-rolled status route.
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.js$/.test(e.name)) {
        // Comments stripped: the ERR-131 note in admin/api.js has to be able to
        // NAME the route it deleted, or the reason it was deleted goes unrecorded.
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        assert.doesNotMatch(src, /markInvoicePaid/, `${p} resurrects the dead helper`);
        assert.doesNotMatch(src, /invoices\/[^'"`]*\/paid/, `${p} resurrects the dead route`);
      }
    }
  };
  scan(path.join(ROOT, 'inkcartridges', 'js'));
});

test('§8 setInvoiceStatus() stays a pure PATCH — the fallback lives in the page', () => {
  const body = fnBody(ADMIN_API_SRC, 'async setInvoiceStatus(invoiceId, status)');
  assert.match(body, /window\.API\.patch\(/, 'the API helper still speaks PATCH and only PATCH');
  assert.doesNotMatch(body, /window\.API\.put\(/,
    'the fallback must not hide inside the transport helper, or PATCH stops being the preferred path');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9  The keyboard can see the toggle; browsers get the new build
// ─────────────────────────────────────────────────────────────────────────────

test('§9 the Paid toggle has a visible focus ring on both decks', () => {
  // The <input> is opacity:0, so its own ring is invisible — the ring has to be
  // painted on the slider that is actually on screen.
  assert.match(CSS_SRC, /\.inv-paid input:focus-visible \+ \.inv-paid__slider\s*\{[^}]*outline:/,
    'keyboard focus must be visible on the element the operator can see');
  assert.match(CSS_SRC, /\[data-theme="light"\][^{]*\.inv-paid input:focus-visible \+ \.inv-paid__slider/,
    'the light deck needs its own contrast-safe outline colour');
});

test('§9 APP_VERSION advanced so the edited invoices.js module is re-fetched', () => {
  const m = APP_SRC.match(/const APP_VERSION = '([^']+)'/);
  assert.ok(m, 'APP_VERSION must exist');
  assert.notEqual(m[1], '2026.07.30-order-hard-purge',
    'admin page modules are imported with ?v=APP_VERSION — a stale token serves the old build');
});
