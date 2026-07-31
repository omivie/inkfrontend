/**
 * Invoices: PAID toggle + SENT email history — ERR-131, July 2026
 * ================================================================
 *
 * Two operator-reported gaps on /admin#invoices, both caused by the frontend
 * addressing a backend that was never built the way the handoff said it would be.
 *
 *   1. THE PAID SLIDER DID NOTHING. The inline switch called
 *      `AdminAPI.markInvoicePaid()` → `POST /api/admin/invoices/:id/paid`.
 *      That route never existed. Probed live 2026-07-30:
 *
 *          POST  /api/admin/invoices/<id>/paid   → {"ok":false,"error":{"code":"NOT_FOUND",…}}
 *          PATCH /api/admin/invoices/<id>/status → {"ok":false,"error":{"code":"UNAUTHORIZED",…}}
 *
 *      (401 = the route is there and wants a token; 404 = it isn't.) Every flip
 *      hit the NOT_FOUND branch, sprang the checkbox back, and toasted "backend
 *      endpoint pending" — which read as a known-pending feature rather than a
 *      wrong URL, so it sat there for a month.
 *
 *   2. THE SENT COLUMN ALWAYS SHOWED "—". `sentInfo()` read `last_emailed_at` /
 *      `last_emailed_to` / `email_count`. The backend shipped `emailed_at` +
 *      `email_count` and no recipient field. Nothing matched, so every row fell
 *      through to the per-browser localStorage backstop — invisible to a second
 *      operator and empty on a fresh browser.
 *
 * What this file pins, and why each one is load-bearing:
 *
 *   §1  The dead route cannot come back. `markInvoicePaid` / `/paid` must not
 *       exist anywhere under inkcartridges/.
 *   §2  `API.patch()` exists and is shaped like its siblings — PATCH was simply
 *       absent from the HTTP client, which is why nobody reached for it.
 *   §3  `setInvoiceStatus()` targets the right URL and refuses 'void' locally.
 *       Voiding must also cancel the shadow order, so it stays on POST /:id/void;
 *       a paid/unpaid toggle that could void would cancel an order by accident.
 *   §4  `listInvoiceEmails()` returns null on failure and that null is NOT the
 *       same as `{count:0, emails:[]}`. Collapsing the two prints "never emailed"
 *       over a read error, which is how an operator double-sends an invoice.
 *       Sixth incident in the absence-as-zero family (ERR-063/068/073/075/076).
 *   §5  `sentInfo()` field precedence, and `email_count: 0` meaning UNKNOWN. A
 *       legacy invoice comes back with a real date and count 0; the old code
 *       coerced that to 1 and would have printed "sent 1 times" as a fact.
 *   §6  Date/label helpers.
 *   §7  The cell is a button (so DataTable's row-click guard suppresses the
 *       editor) and every interpolation is escaped.
 *   §8  The toggle re-renders from the SERVER's status, reverts on failure, and
 *       maps each error code to copy the operator can act on.
 *   §9  `renderSentHistory()` — the three branches stay distinct, hostile
 *       recipient/subject text comes out escaped, and the raw uuids are not
 *       printed.
 *   §10 The send history stays read-only to buildPayload().
 *   §11 Cache tokens moved, or returning browsers keep the broken build.
 *
 * Run: node --test tests/admin-invoice-status-email-log-jul2026.test.js
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
const API_SRC = READ('js/api.js');
const APP_SRC = READ('js/admin/app.js');
const TABLE_SRC = READ('js/admin/components/table.js');
const CSS_SRC = READ('css/admin.css');
const SHELL_SRC = READ('html/admin/index.html');

// ─────────────────────────────────────────────────────────────────────────────
// Harnesses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * invoices.js is an ES module (top-level `import`), so it cannot be required or
 * evaluated whole. Slice out the pure-helper prelude and run that. The slice is
 * delimited by source markers so a refactor that moves the helpers out fails
 * loudly here instead of silently skipping the behaviour.
 */
function loadHelpers() {
  const start = INVOICES_SRC.indexOf('const escA =');
  const end = INVOICES_SRC.indexOf('// The "Date order placed" line');
  assert.ok(start > -1 && end > start, 'helper prelude markers must exist in invoices.js');
  const prelude = INVOICES_SRC.slice(start, end);

  const store = new Map();
  const ctx = {
    window: { Security: null, DebugLog: { warn: () => {} } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    console, Date, Math, JSON, Number, Object, String, isNaN, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(`${prelude}\n;this.__api = { sentInfo, sentShort, sentTitle, sentDateTime, writeSent, formatInvoiceDate };`, ctx);
  return ctx.__api;
}

/** Extract a top-level function body by brace matching (house idiom). */
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

/**
 * renderSentHistory() is deliberately pure so it can be run for real. It calls
 * esc() / formatInvoiceDate() / sentDateTime(), which are injected here.
 */
function loadRenderSentHistory() {
  const { sentDateTime, formatInvoiceDate } = loadHelpers();
  const esc = (s) => String(s ?? '').replace(/[&<>"'/`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '/': '&#x2F;', '`': '&#96;',
  }[c]));
  return new Function(
    'esc', 'sentDateTime', 'formatInvoiceDate',
    `${extractFunction(INVOICES_SRC, 'function renderSentHistory(')}; return renderSentHistory;`,
  )(esc, sentDateTime, formatInvoiceDate);
}

/** The body of a named function, for source-level assertions. */
const fnBody = (src, sig) => extractFunction(src, sig);

// ─────────────────────────────────────────────────────────────────────────────
// §1  The dead route is gone for good
// ─────────────────────────────────────────────────────────────────────────────

test('§1 markInvoicePaid() and POST /:id/paid appear nowhere in the frontend', () => {
  const dir = path.join(ROOT, 'inkcartridges');
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|html)$/.test(entry.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (src.includes('markInvoicePaid')) offenders.push(`${path.relative(ROOT, p)}: markInvoicePaid`);
      // Only a real URL counts — a prose mention of the dead route in a comment is
      // documentation, and banning that would push the history out of the code.
      // So: the path has to appear inside a string or template literal.
      if (/`[^`\n]*invoices\/[^`\n]*\/paid[^`\n]*`|['"][^'"\n]*invoices\/[^'"\n]*\/paid[^'"\n]*['"]/.test(src)) {
        offenders.push(`${path.relative(ROOT, p)}: a /invoices/.../paid URL`);
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [],
    'POST /api/admin/invoices/:id/paid is a 404 — it must not survive as a second way to flip paid:\n'
    + offenders.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  The HTTP client learned PATCH
// ─────────────────────────────────────────────────────────────────────────────

test('§2 API.patch() exists and mirrors the other verb helpers', () => {
  const patch = fnBody(API_SRC, 'async patch(endpoint, body)');
  assert.match(patch, /method:\s*'PATCH'/, 'sends the PATCH verb');
  assert.match(patch, /body:\s*JSON\.stringify\(body\)/, 'JSON-encodes the body like post/put');
  assert.match(patch, /this\.request\(/, 'goes through request() so it gets the envelope + auth handling');
});

test('§2 patch() sits with the other verbs, not off on its own', () => {
  const iPut = API_SRC.indexOf('async put(endpoint');
  const iPatch = API_SRC.indexOf('async patch(endpoint');
  const iDelete = API_SRC.indexOf('async delete(endpoint');
  assert.ok(iPut > -1 && iPatch > -1 && iDelete > -1, 'put, patch and delete all exist');
  assert.ok(iPut < iPatch && iPatch < iDelete, 'verb helpers stay grouped: put → patch → delete');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  setInvoiceStatus() — right URL, and 'void' can never leave the browser
// ─────────────────────────────────────────────────────────────────────────────

test('§3 setInvoiceStatus() PATCHes /:id/status with an encoded id and a {status} body', () => {
  const fn = fnBody(ADMIN_API_SRC, 'async setInvoiceStatus(invoiceId, status)');
  assert.match(fn, /window\.API\.patch\(/, 'uses the PATCH verb, not post/put');
  assert.match(fn, /\/api\/admin\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/status/, 'correct URL, id encoded');
  assert.match(fn, /\{\s*status\s*\}/, 'body is { status }');
  assert.match(fn, /throw invoiceError\(resp,/, 'a non-OK envelope throws with .code attached');
});

test('§3 setInvoiceStatus() returns the SERVER invoice so the caller can re-render from it', () => {
  const fn = fnBody(ADMIN_API_SRC, 'async setInvoiceStatus(invoiceId, status)');
  assert.match(fn, /resp\?\.data\?\.invoice/, 'unwraps data.invoice — the handoff calls it the source of truth');
});

test('§3 the accepted-status list is frozen and excludes void', () => {
  assert.match(ADMIN_API_SRC, /const INVOICE_STATUSES = Object\.freeze\(\['draft', 'unpaid', 'paid'\]\)/,
    'one frozen vocabulary for the route');
  assert.ok(!/INVOICE_STATUSES = Object\.freeze\(\[[^\]]*'void'/.test(ADMIN_API_SRC),
    "'void' must NOT be in the list — voiding also cancels the shadow order and lives on POST /:id/void");
});

test('§3 an invalid status throws BEFORE any request is dispatched', () => {
  const fn = fnBody(ADMIN_API_SRC, 'async setInvoiceStatus(invoiceId, status)');
  const iGuard = fn.indexOf('INVOICE_STATUSES.includes(status)');
  const iSend = fn.indexOf('window.API.patch(');
  assert.ok(iGuard > -1 && iSend > -1, 'both the guard and the call exist');
  assert.ok(iGuard < iSend, 'the guard runs first — a bad status never reaches the network');
  assert.match(fn, /err\.code = 'VALIDATION_FAILED'/, 'carries a code so callers can branch');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4  A failed read is not "never sent"
// ─────────────────────────────────────────────────────────────────────────────

test('§4 listInvoiceEmails() GETs /:id/emails and fails soft to null', () => {
  const fn = fnBody(ADMIN_API_SRC, 'async listInvoiceEmails(invoiceId)');
  assert.match(fn, /\/api\/admin\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}\/emails/, 'correct URL, id encoded');
  assert.match(fn, /adminApiWarn\(/, 'a read failure warns rather than throwing at the UI');
  assert.match(fn, /return null;?\s*\n?\s*\}\s*(,|\n)/, 'the catch returns null');
});

test('§4 null (read failed) is a DIFFERENT value from {count:0} (nothing sent)', () => {
  const fn = fnBody(ADMIN_API_SRC, 'async listInvoiceEmails(invoiceId)');
  // The absent-payload path must NOT synthesise an empty result — that would
  // render as "never emailed" over a backend hiccup.
  assert.match(fn, /if \(!d\) return null;/,
    'a missing data envelope returns null, never a fabricated { count: 0, emails: [] }');
  assert.ok(!/catch[\s\S]*return \{\s*count:\s*0/.test(fn),
    'the catch must not invent an empty result set');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5  sentInfo() — field precedence and the meaning of count 0
// ─────────────────────────────────────────────────────────────────────────────

test('§5 sentInfo() reads emailed_at — the field the backend actually returns', () => {
  const { sentInfo } = loadHelpers();
  const info = sentInfo({ id: 'a', emailed_at: '2026-07-08T04:23:22.379Z', email_count: 2 });
  assert.ok(info, 'a row carrying emailed_at must render as sent');
  assert.equal(info.at, '2026-07-08T04:23:22.379Z');
  assert.equal(info.count, 2);
  assert.equal(info.source, 'server');
});

test('§5 the legacy last_emailed_at name is still honoured as an alias', () => {
  const { sentInfo } = loadHelpers();
  assert.equal(sentInfo({ id: 'a', last_emailed_at: '2026-07-01T00:00:00Z' }).at, '2026-07-01T00:00:00Z');
});

test('§5 emailed_at wins over the legacy alias when both are present', () => {
  const { sentInfo } = loadHelpers();
  const info = sentInfo({ id: 'a', emailed_at: '2026-07-08T00:00:00Z', last_emailed_at: '2026-01-01T00:00:00Z' });
  assert.equal(info.at, '2026-07-08T00:00:00Z');
});

test('§5 a server email_count of 0 stays 0 — it means UNKNOWN, not one send', () => {
  const { sentInfo, sentTitle } = loadHelpers();
  // The handoff: "Legacy invoices emailed before this feature have emailed_at
  // set but email_count: 0 — still render the date (just no count)."
  const info = sentInfo({ id: 'a', emailed_at: '2026-07-08T04:23:22.379Z', email_count: 0 });
  assert.equal(info.count, 0, 'must NOT be coerced to 1 — that invents a fact about a legacy send');
  assert.ok(info.at, 'the date still renders');
  assert.doesNotMatch(sentTitle(info), /sent \d+ times/, 'no count phrase when the count is unknown');
});

test('§5 the server row wins over a local record; a local record only fills a gap', () => {
  const { sentInfo, writeSent } = loadHelpers();
  writeSent('inv-1', 'local@example.com');
  assert.equal(sentInfo({ id: 'inv-1', emailed_at: '2026-07-08T00:00:00Z' }).source, 'server');
  assert.equal(sentInfo({ id: 'inv-1' }).source, 'local', 'the backstop shows only when the server says nothing');
  assert.equal(sentInfo({ id: 'never-sent' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

test('§6 sentDateTime() renders a full date plus a 12-hour clock', () => {
  const { sentDateTime } = loadHelpers();
  // Built from local-time components, so assert the shape rather than a fixed
  // hour — the suite must not depend on the machine's timezone.
  assert.match(sentDateTime('2026-07-08T04:23:22.379Z'), /^\d{1,2}(st|nd|rd|th) \w+ \d{4} · \d{1,2}:\d{2} (am|pm)$/);
});

test('§6 sentDateTime() renders midnight and noon as 12, never 0', () => {
  const { sentDateTime } = loadHelpers();
  for (const iso of ['2026-07-08T00:00:00', '2026-07-08T12:00:00']) {
    assert.doesNotMatch(sentDateTime(iso), /\b0:\d{2}/, `${iso} must not render an hour of 0`);
  }
});

test('§6 sentDateTime() returns "" on junk rather than "Invalid Date"', () => {
  const { sentDateTime } = loadHelpers();
  assert.equal(sentDateTime('not-a-date'), '');
  assert.equal(sentDateTime(null), '');
});

test('§6 sentTitle() tells the operator the cell is clickable', () => {
  const { sentTitle } = loadHelpers();
  assert.match(sentTitle({ at: '2026-07-08T00:00:00Z', to: '', count: 0 }), /click for the send log$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  The cell: a button, and everything escaped
// ─────────────────────────────────────────────────────────────────────────────

const SENT_CELL = INVOICES_SRC.slice(INVOICES_SRC.indexOf("key: 'sent'"), INVOICES_SRC.indexOf("key: 'actions'"));

test('§7 both Sent states are buttons carrying the sent-history action', () => {
  assert.match(SENT_CELL, /<button type="button" class="inv-sent"/, 'the sent state is a button');
  assert.match(SENT_CELL, /<button type="button" class="inv-sent__none"/, 'the never-sent state is a button');
  assert.match(SENT_CELL, /data-row-action="sent-history"/, 'both route to the history handler');
  assert.match(TABLE_SRC, /closest\('button, a, input'\)/,
    "DataTable's row-click guard is what stops the editor opening — it must still list button");
});

test('§7 the cell escapes the id, the number, the tooltip and the date', () => {
  assert.match(SENT_CELL, /data-id="\$\{escA\(r\.id\)\}"/);
  assert.match(SENT_CELL, /data-num="\$\{escA\(r\.invoice_number\)\}"/);
  assert.match(SENT_CELL, /title="\$\{escA\(sentTitle\(info\)\)\}"/);
  assert.match(SENT_CELL, /\$\{esc\(sentShort\(info\.at\)\)\}/);
});

test('§7 the ×N count renders only past one send', () => {
  assert.match(SENT_CELL, /info\.count > 1 \?/,
    'count 0 (unknown) and count 1 must not print a multiplier');
  assert.match(SENT_CELL, /\$\{esc\(info\.count\)\}/, 'the count is escaped too');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8  The toggle
// ─────────────────────────────────────────────────────────────────────────────

const TOGGLE = INVOICES_SRC.slice(
  INVOICES_SRC.indexOf("if (action === 'toggle-paid')"),
  INVOICES_SRC.indexOf("} else if (action === 'download')"),
);

test('§8 the toggle sets a paid/unpaid STATUS, never a boolean', () => {
  // The direct AdminAPI.setInvoiceStatus() call moved one level down, into
  // setStatusWithFallback(), when BF-021 stayed open and the toggle gained a
  // PUT fallback (ERR-138). That wrapper still tries PATCH first — asserted in
  // tests/admin-invoice-paid-fallback-jul2026.test.js §1 — and the vocabulary
  // the checkbox maps to is unchanged, which is what this section is about.
  assert.match(TOGGLE, /setStatusWithFallback\(id, wanted\)/);
  assert.match(TOGGLE, /btn\.checked \? 'paid' : 'unpaid'/, 'the checkbox maps to the status vocabulary');
  assert.match(
    fnBody(INVOICES_SRC, 'async function setStatusWithFallback(id, wanted)'),
    /AdminAPI\.setInvoiceStatus\(id, wanted\)/,
    'and PATCH /:id/status is still the call that is actually attempted',
  );
});

test('§8 the row is repainted from the server response, not from the checkbox', () => {
  assert.match(TOGGLE, /applyRowStatus\(id, inv, wanted\)/, 'the server invoice is handed to the repaint');
  const apply = fnBody(INVOICES_SRC, 'function applyRowStatus(id, inv, wanted)');
  assert.match(apply, /inv\?\.status \|\| wanted/, "the server's status wins; `wanted` is only the no-body fallback");
  assert.match(apply, /if \(!_table\) return;/, 'guarded against the page being destroyed mid-flight');
  assert.match(apply, /_table\.setData\(_table\.data, _table\.pagination\)/, 'repaint preserves pagination');
});

test('§8 a row that no longer matches an active status filter triggers a reload', () => {
  const apply = fnBody(INVOICES_SRC, 'function applyRowStatus(id, inv, wanted)');
  assert.match(apply, /_filters\.status && _filters\.status !== status/,
    'marking paid while filtered to Unpaid must not leave the row sitting in the wrong view');
  assert.match(apply, /loadData\(\)/);
});

test('§8 a failure reverts the checkbox to the last known-good value', () => {
  const iCatch = TOGGLE.indexOf('} catch');
  const iRevert = TOGGLE.indexOf('btn.checked = ');
  assert.ok(iCatch > -1 && iRevert > iCatch, 'the revert lives in the catch, not the try');
  assert.match(TOGGLE, /btn\.checked = wanted === 'unpaid'/, 'reverts to the opposite of what was attempted');
});

test('§8 each failure code gets copy the operator can act on', () => {
  const msg = fnBody(INVOICES_SRC, 'function statusErrorMessage(err)');
  assert.match(msg, /case 'CONFLICT':/, '409 = the invoice is void');
  assert.match(msg, /case 'NOT_FOUND':/, '404 = it is gone, refresh');
  assert.match(msg, /case 'RATE_LIMITED':/, '429 = the shared 10/min invoice write limiter');
  assert.doesNotMatch(msg, /backend endpoint pending/i,
    'the "pending" excuse is retired — the route exists now, so a 404 means something else');
});

test('§8 an opaque network/CORS failure is explained, not shown as "Failed to fetch"', () => {
  // Measured 2026-07-30 and STILL TRUE on 2026-07-31: the API answers a PATCH
  // preflight with Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS —
  // no PATCH — from BOTH localhost and the production origin, so the browser
  // kills the request before it is sent and fetch rejects with a bare TypeError.
  //
  // That case no longer reaches the operator: setStatusWithFallback() absorbs it
  // by re-routing through the CORS-allowed PUT (ERR-138). So arriving in this
  // branch now means the PUT failed to connect TOO — real connectivity loss —
  // and the copy must stop blaming a method that is no longer the obstacle.
  const statusErrorMessage = new Function(
    'isNetworkFailure',
    `${fnBody(INVOICES_SRC, 'function statusErrorMessage(err)')}; return statusErrorMessage;`,
  )(new Function(`${fnBody(INVOICES_SRC, 'function isNetworkFailure(err)')}; return isNetworkFailure;`)());

  const out = statusErrorMessage(new TypeError('Failed to fetch'));
  assert.doesNotMatch(out, /^Failed to fetch$/, 'the raw TypeError must not be the whole message');
  assert.match(out, /wasn’t saved|was not saved/, 'it states plainly that nothing was written');
  assert.doesNotMatch(out, /PATCH/,
    'the blocked-PATCH case is handled by the fallback now — naming it here would misdirect');

  // A coded envelope error must NOT be swallowed by the network branch.
  const coded = Object.assign(new Error('Invoice is void'), { code: 'CONFLICT' });
  assert.match(statusErrorMessage(coded), /void/);
  assert.doesNotMatch(statusErrorMessage(coded), /connection/i, 'a real API error keeps its own message');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9  renderSentHistory() — run for real
// ─────────────────────────────────────────────────────────────────────────────

test('§9 a failed read renders an error with a retry, and never says "not sent"', () => {
  const html = loadRenderSentHistory()(null, null);
  assert.match(html, /inv-hist__error/);
  assert.match(html, /data-action="retry-history"/, 'the operator can retry without reopening');
  assert.doesNotMatch(html, /hasn’t been emailed|never emailed/i,
    'a read error must never be painted as "never emailed" — that is how an invoice gets double-sent');
});

test('§9 a genuinely empty log says so, and offers the send action', () => {
  const html = loadRenderSentHistory()({ count: 0, emails: [] }, null);
  assert.match(html, /inv-hist__empty/);
  assert.match(html, /hasn’t been emailed yet/);
  assert.doesNotMatch(html, /inv-hist__error/, 'empty is not an error');
});

test('§9 a legacy send (date known, no logged rows) is its own third branch', () => {
  const html = loadRenderSentHistory()({ count: 0, emails: [] }, { at: '2026-07-08T04:23:22.379Z', to: '', count: 0 });
  assert.match(html, /8th July 2026/, 'the date we DO know is shown');
  assert.match(html, /weren’t logged individually/, 'and the reason there is no detail is explained');
  assert.doesNotMatch(html, /hasn’t been emailed yet/,
    'an invoice with a real emailed_at must never read as never-sent');
});

test('§9 each logged send prints its time, recipient and subject', () => {
  const html = loadRenderSentHistory()({
    count: 2,
    emails: [
      { recipient_email: 'ian@mcgrath.co.nz', subject: 'Invoice No. 3265', status: 'sent', sent_at: '2026-07-08T04:23:22.379Z' },
      { recipient_email: 'ian@mcgrath.co.nz', subject: 'Invoice No. 3265', status: 'sent', sent_at: '2026-07-05T02:00:00.000Z' },
    ],
  }, null);
  assert.equal((html.match(/inv-hist__row/g) || []).length, 2, 'one row per send');
  assert.match(html, /ian@mcgrath\.co\.nz/);
  assert.match(html, /Invoice No\. 3265/);
  assert.doesNotMatch(html, /inv-hist__status/, 'a plain successful send needs no status chip');
});

test('§9 a non-sent delivery status gets a chip', () => {
  const html = loadRenderSentHistory()({
    count: 1,
    emails: [{ recipient_email: 'a@b.co', subject: 'x', status: 'failed', sent_at: '2026-07-08T04:23:22.379Z' }],
  }, null);
  assert.match(html, /inv-hist__status inv-hist__status--failed/);
  assert.match(html, />failed</);
});

test('§9 a hostile recipient or subject cannot inject markup', () => {
  const html = loadRenderSentHistory()({
    count: 1,
    emails: [{
      recipient_email: '<img src=x onerror=alert(1)>',
      subject: '</ul><script>alert(2)</script>',
      status: 'sent',
      sent_at: '2026-07-08T04:23:22.379Z',
    }],
  }, null);
  assert.doesNotMatch(html, /<img/, 'recipient is escaped');
  assert.doesNotMatch(html, /<script/, 'subject is escaped');
  assert.match(html, /&lt;img/, 'and it is still legible as text');
});

test('§9 the raw uuids the backend sends are not printed at the operator', () => {
  const html = loadRenderSentHistory()({
    count: 1,
    emails: [{
      recipient_email: 'a@b.co', subject: 'x', status: 'sent', sent_at: '2026-07-08T04:23:22.379Z',
      sent_by: '11111111-2222-3333-4444-555555555555',
      email_queue_id: '66666666-7777-8888-9999-000000000000',
    }],
  }, null);
  assert.doesNotMatch(html, /11111111-2222/, 'sent_by is a bare uuid with no name to resolve it to');
  assert.doesNotMatch(html, /66666666-7777/, 'email_queue_id is a cross-reference, not display data');
});

test('§9 unlogged earlier sends are declared rather than silently dropped', () => {
  const html = loadRenderSentHistory()({
    count: 5,
    emails: [{ recipient_email: 'a@b.co', subject: 'x', status: 'sent', sent_at: '2026-07-08T04:23:22.379Z' }],
  }, null);
  assert.match(html, /Earlier sends aren’t logged/, 'count > rows must be owned up to, not hidden');
});

test('§9 a send with no timestamp says so instead of rendering an empty line', () => {
  const html = loadRenderSentHistory()({
    count: 1, emails: [{ recipient_email: 'a@b.co', subject: 'x', status: 'sent', sent_at: null }],
  }, null);
  assert.match(html, /Date unknown/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §10  The history stays read-only
// ─────────────────────────────────────────────────────────────────────────────

test('§10 draftFromInvoice() carries emailed_at; buildPayload() sends none of it back', () => {
  const from = fnBody(INVOICES_SRC, 'function draftFromInvoice(rec)');
  assert.match(from, /d\.emailed_at = rec\.emailed_at/, 'the drawer hint needs the real field name');

  const payload = fnBody(INVOICES_SRC, 'function buildPayload(d)');
  for (const f of ['emailed_at', 'last_emailed_at', 'last_emailed_to', 'email_count']) {
    assert.ok(!payload.includes(f),
      `buildPayload() must NOT write ${f} — a full-body PUT would wipe the server's send history`);
  }
});

test('§10 the history modal is guarded against painting into a closed modal', () => {
  const open = fnBody(INVOICES_SRC, 'function openSentHistory(id, invoiceNumber, row)');
  assert.match(open, /const token = \+\+_historyToken/, 'each open takes a token');
  assert.match(open, /if \(token !== _historyToken\) return;/, 'a stale response is dropped');
  assert.match(open, /onClose: \(\) => \{ _historyToken\+\+; \}/, 'closing invalidates any in-flight read');
});

test('§10 "Send again" reuses the one email composer', () => {
  const open = fnBody(INVOICES_SRC, 'function openSentHistory(id, invoiceNumber, row)');
  assert.match(open, /openEmailDialog\(draftFromInvoice\(rec\)\)/,
    'no second composer — the history reuses the existing one');
});

// ─────────────────────────────────────────────────────────────────────────────
// §11  Cache busting
// ─────────────────────────────────────────────────────────────────────────────

test('§11 APP_VERSION advanced so the edited invoices.js module is re-fetched', () => {
  assert.match(APP_SRC, /APP_VERSION\s*=\s*'2026\.\d{2}\.\d{2}-[a-z0-9-]+'/, 'date-stamped token');
  assert.doesNotMatch(APP_SRC, /APP_VERSION\s*=\s*'2026\.07\.29-gst-basis-labels'/,
    'APP_VERSION must move off the previous build or cached browsers keep the broken module');
});

test('§11 the shell carries tokens for the assets this change touched', () => {
  // Shape is NOT pinned — stamp-versions.js rewrites these to md5(content)[:8] at
  // deploy, so an era-literal assertion here would pin a value production never
  // serves (ERR-067). Sitewide consistency is owned by asset-cache-tokens.test.js.
  assert.match(SHELL_SRC, /admin\.css\?v=[^"']+/);
  assert.match(SHELL_SRC, /admin\/app\.js\?v=[^"']+/);
  assert.match(SHELL_SRC, /\/js\/api\.js\?v=[^"']+/);
});

test('§11 the new styles exist and stay legible on the light deck', () => {
  assert.match(CSS_SRC, /\.inv-sent__times \{/, 'the ×N count has a style');
  assert.match(CSS_SRC, /\.admin-modal--invoice-history \{/, 'the history modal is sized');
  assert.match(CSS_SRC, /\.admin\[data-theme="light"\] \.inv-hist__when \{\s*color: #15803d/,
    '--success under-contrasts on white — the light deck needs the darker green');
  // The buttons must not inherit default button chrome inside a table cell.
  assert.match(CSS_SRC, /\.inv-sent,\s*\n\.inv-sent__none \{[^}]*background: none/,
    'button chrome is reset so the cell still looks like a label');
  assert.match(CSS_SRC, /\.inv-sent__none:focus-visible \{[^}]*outline/,
    'keyboard focus must be visible on an otherwise unstyled button');
});
