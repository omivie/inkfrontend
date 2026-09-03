/**
 * Orders list — "Invoice sent" column (Aug 2026)
 * ==============================================
 *
 * The Orders page gained a column answering "when did this customer's invoice
 * last go out?", and the Resend Invoice button — which until now fired an email
 * and recorded nothing at all — now writes that date down.
 *
 * Two things make this fragile, and this file pins both.
 *
 * 1. THE ANSWER IS NOT ON THE ORDER. `GET /api/admin/orders` and
 *    `/api/admin/orders/:id` carry no send field of any kind (dumped live
 *    2026-08-28). The date is assembled from two batched Supabase reads:
 *    `public.invoices.emailed_at` (the server's record) and `order_events` (the
 *    resends we fired ourselves). `public.invoices` is NOT `admin_invoices` —
 *    the standalone Invoicing page's table, with its own emailed_at and integer
 *    invoice numbers. Selecting an admin_invoices column off public.invoices is
 *    a hard 400 and would darken the whole column, so §"the select" pins the
 *    exact column list. `npm run probe:invoice-sent` re-checks it live.
 *
 * 2. FIVE WAYS TO HAVE NO DATE, AND THEY ARE NOT THE SAME FACT. Not asked yet,
 *    no invoice row, nothing recorded, and lookup-failed are distinct, and only
 *    one of them ("nothing recorded") is an absence we actually established.
 *    Rendering a failed lookup as "Not recorded" asserts something we never
 *    checked — the absence-as-zero family (ERR-063/068/073/075/076/149/150).
 *
 * The backend never stamps `emailed_at`, including for the invoice emailed
 * automatically at checkout (0 of 126 rows, verified live). So "Not recorded" is
 * the honest answer for almost every order today, and the copy has to say that
 * it means NO RECORD rather than "nothing was sent". BF-046 tracks the fix:
 * readfirst/order-invoice-emailed-at-backend-brief-aug2026.md
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const UTIL = path.join(ADMIN, 'utils', 'order-invoice-sent.js');
// order-invoice-sent.js imports the send-count vocabulary both admin pages share
// (SAME_SEND_MS / mergeSends). The stripEsm loader drops import statements, so
// the dependency has to be evaluated into the same context first.
const SHARED = path.join(ADMIN, 'utils', 'send-history.js');
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');
const API = path.join(ADMIN, 'api.js');
const APP = path.join(ADMIN, 'app.js');
const ADMIN_CSS = path.join(ROOT, 'inkcartridges', 'css', 'admin.css');
const PROBE = path.join(ROOT, 'scripts', 'probe-invoice-sent.mjs');

const ordersSrc = fs.readFileSync(ORDERS_PAGE, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const appSrc = fs.readFileSync(APP, 'utf8');
const cssSrc = fs.readFileSync(ADMIN_CSS, 'utf8');

// Same loader the other admin-util tests use.
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
  stripped = stripped.replace(/export\s+\{[^}]*\}\s*;?/g, '');
  stripped = stripped.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  return stripped + '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp, Date };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(SHARED, 'utf8')), ctx, { filename: 'send-history.js' });
vm.runInContext(stripEsm(fs.readFileSync(UTIL, 'utf8')), ctx, { filename: 'order-invoice-sent.js' });

const {
  SENT_STATE, resolveSentInfo, newestSendEvent,
  isInvoiceSendEvent, invoiceSendNoteText,
  INVOICE_SENT_KIND, INVOICE_SENT_MARK,
} = sandbox;

/** Slice a function body out of the page source, for the source-reading checks. */
function slice(src, startNeedle, endNeedle) {
  const i = src.indexOf(startNeedle);
  assert.ok(i !== -1, `could not find: ${startNeedle}`);
  const j = src.indexOf(endNeedle, i + startNeedle.length);
  assert.ok(j !== -1, `could not find: ${endNeedle}`);
  return src.slice(i, j);
}

// ---------------------------------------------------------------------------
test('resolveSentInfo — the state machine', async (t) => {

  await t.test('a server stamp is a send', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: '2026-08-20T02:00:00Z', invoice_number: 'INV-2026-0100' },
      events: [],
    });
    assert.equal(info.state, SENT_STATE.SENT);
    assert.equal(info.source, 'server');
    assert.equal(info.at, '2026-08-20T02:00:00Z');
    assert.equal(info.invoiceNumber, 'INV-2026-0100');
    assert.equal(info.count, 1);
  });

  await t.test('a later resend is the LATEST send, and both are kept', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: '2026-08-20T02:00:00Z', invoice_number: 'INV-2026-0100' },
      events: [{ created_at: '2026-08-21T02:00:00Z', payload: { kind: INVOICE_SENT_KIND } }],
    });
    assert.equal(info.count, 2);
    assert.equal(info.at, '2026-08-21T02:00:00Z', 'the newest send is the headline date');
    assert.deepEqual([...info.sends.map(x => x.source)], ['admin', 'server'], 'newest first');
  });

  // Once BF-047 lands the backend will stamp emailed_at on the same resend we
  // record ourselves. Without the dedupe, one send would read as two and the
  // count — the whole point of this feature — would double.
  await t.test('a server stamp and our record of the SAME send collapse to one', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: '2026-08-20T02:00:00Z' },
      events: [{ created_at: '2026-08-20T02:00:01Z', payload: { kind: INVOICE_SENT_KIND } }],
    });
    assert.equal(info.count, 1, 'one send, not two');
    assert.equal(info.source, 'server', 'the server stamp wins attribution at the same instant');
  });

  await t.test('our own record answers when the server has none', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: null, invoice_number: 'INV-1' },
      events: [{ created_at: '2026-08-21T02:00:00Z', payload: { kind: INVOICE_SENT_KIND } }],
    });
    assert.equal(info.state, SENT_STATE.SENT);
    assert.equal(info.source, 'admin');
    assert.equal(info.count, 1);
  });

  await t.test('every recorded send is kept, newest first', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: null },
      events: [
        { created_at: '2026-08-10T00:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
        { created_at: '2026-08-28T00:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
        { created_at: '2026-08-19T00:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
        { created_at: '2026-08-01T00:00:00Z', payload: { note: 'an unrelated note' } },
      ],
    });
    assert.equal(info.count, 3, 'the unrelated note is not a send');
    assert.equal(info.sends.length, info.count, 'count IS the list length');
    assert.deepEqual([...info.sends.map(x => x.at)], [
      '2026-08-28T00:00:00Z', '2026-08-19T00:00:00Z', '2026-08-10T00:00:00Z',
    ]);
  });

  // The backend stores `note` and nothing else — a record written as
  // {kind, at, note} came back as {note} alone (read live 2026-08-28). A reader
  // that trusted payload.at would get undefined for every send.
  await t.test('a send is timed by created_at, never by payload.at', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: null },
      events: [{
        created_at: '2026-08-28T05:00:00Z',
        payload: { note: '[invoice-sent] x', at: '2020-01-01T00:00:00Z' },
      }],
    });
    assert.equal(info.at, '2026-08-28T05:00:00Z');
  });

  await t.test('both sources answered and neither had anything → NOT_RECORDED', () => {
    const info = resolveSentInfo({ invoice: { emailed_at: null }, event: null });
    assert.equal(info.state, SENT_STATE.NOT_RECORDED);
  });

  // THE HEADLINE TEST. A lookup we could not complete is not an absence.
  await t.test('a failed invoice lookup is FAILED, never NOT_RECORDED', () => {
    const info = resolveSentInfo({ invoice: null, event: null, invoiceFailed: true });
    assert.equal(info.state, SENT_STATE.FAILED);
    assert.notEqual(info.state, SENT_STATE.NOT_RECORDED);
  });

  await t.test('a failed EVENT lookup is FAILED too', () => {
    const info = resolveSentInfo({ invoice: { emailed_at: null }, event: null, eventFailed: true });
    assert.equal(info.state, SENT_STATE.FAILED);
  });

  await t.test('a real hit still reports even when the other source failed', () => {
    const info = resolveSentInfo({
      invoice: null, event: { created_at: '2026-08-21T02:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
      invoiceFailed: true,
    });
    assert.equal(info.state, SENT_STATE.SENT);
  });

  await t.test('no invoice row at all is its own state, not "not recorded"', () => {
    const info = resolveSentInfo({ invoice: null, event: null });
    assert.equal(info.state, SENT_STATE.NO_INVOICE);
  });

  // Pins the user's explicit decision: no inference, no backfill.
  await t.test('NEVER infers a send from invoice_date / created_at / paid_at / pdf_url', () => {
    const info = resolveSentInfo({
      invoice: {
        emailed_at: null,
        invoice_date: '2026-08-20T02:00:00Z',
        created_at: '2026-08-20T02:00:01Z',
        paid_at: '2026-08-20T02:00:02Z',
        pdf_url: 'https://example.test/x.pdf',
      },
      event: null,
    });
    assert.equal(info.state, SENT_STATE.NOT_RECORDED);
    assert.equal(info.at, null);
  });

  await t.test('every no-send state reports an empty list and a zero count', () => {
    for (const args of [
      { invoice: { emailed_at: null }, events: [] },                    // NOT_RECORDED
      { invoice: null, events: [] },                                    // NO_INVOICE
      { invoice: null, events: [], invoiceFailed: true },               // FAILED
    ]) {
      const info = resolveSentInfo(args);
      assert.deepEqual([...info.sends], []);
      assert.equal(info.count, 0);
    }
  });
});

// ---------------------------------------------------------------------------
test('the send-record sentinel', async (t) => {
  await t.test('matches on payload.kind AND on the note-text marker', () => {
    assert.ok(isInvoiceSendEvent({ payload: { kind: INVOICE_SENT_KIND } }));
    assert.ok(isInvoiceSendEvent({ payload: { note: `${INVOICE_SENT_MARK} Invoice email sent.` } }));
  });

  await t.test('an ordinary note is not a send record', () => {
    assert.equal(isInvoiceSendEvent({ payload: { note: 'Sent from Computerfood' } }), false);
    assert.equal(isInvoiceSendEvent(null), false);
    assert.equal(isInvoiceSendEvent({}), false);
  });

  await t.test('the machine sentinel never reaches the operator', () => {
    const text = invoiceSendNoteText({ payload: { note: `${INVOICE_SENT_MARK} Invoice email sent.` } });
    assert.equal(text, 'Invoice email sent.');
    assert.doesNotMatch(text, /\[invoice-sent\]/);
  });

  await t.test('newestSendEvent picks the latest, ignores other notes, tolerates null', () => {
    const events = [
      { created_at: '2026-08-01T00:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
      { created_at: '2026-08-09T00:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
      { created_at: '2026-08-20T00:00:00Z', payload: { note: 'unrelated note' } },
    ];
    assert.equal(newestSendEvent(events).created_at, '2026-08-09T00:00:00Z');
    assert.equal(newestSendEvent(null), null);
    assert.equal(newestSendEvent([]), null);
  });
});

// ---------------------------------------------------------------------------
test('the Supabase select', async (t) => {
  await t.test('names only columns that exist on public.invoices', () => {
    assert.match(apiSrc, /ORDER_INVOICE_COLUMNS:\s*'id,order_id,invoice_number,invoice_date,emailed_at'/);
  });

  // These are admin_invoices columns. On public.invoices each one is a hard 400,
  // which would blank the column for every order — verified live by the probe.
  await t.test('never selects an admin_invoices column off public.invoices', () => {
    const sel = slice(apiSrc, 'async getOrderInvoicesByOrderIds', 'async getInvoiceSendEventsByOrderIds');
    for (const bad of ['emailed_to', 'email_count', 'last_emailed_at']) {
      assert.doesNotMatch(sel, new RegExp(bad), `${bad} is not a public.invoices column`);
    }
  });

  await t.test('the batched reader reports partial-ness in its RETURN VALUE', () => {
    const fn = slice(apiSrc, 'async getOrderInvoicesByOrderIds', 'async getInvoiceSendEventsByOrderIds');
    assert.match(fn, /failed\s*=\s*true/, 'a failed chunk must set failed');
    assert.match(fn, /return\s*\{\s*byOrderId,\s*failed\s*\}/, 'callers need the flag, not just a console warning');
  });

  await t.test('an aborted read is rethrown, not swallowed as a failure', () => {
    const fn = slice(apiSrc, 'async getOrderInvoicesByOrderIds', 'async getInvoiceSendEventsByOrderIds');
    assert.match(fn, /AbortError/);
  });
});

// ---------------------------------------------------------------------------
test('the write path', async (t) => {
  const handler = slice(
    ordersSrc,
    "modal.querySelector('[data-action=\"resend-invoice\"]')",
    '// Same vocabulary as the button');

  // The marquee ordering rule, mirroring tests/admin-invoice-sent-indicator.test.js
  // for the Invoices page: a stamp must never date an email that did not go out.
  await t.test('recordInvoiceSend runs only AFTER resendInvoice resolves', () => {
    const send = handler.indexOf('await AdminAPI.resendInvoice(');
    const rec = handler.indexOf('AdminAPI.recordInvoiceSend(');
    assert.ok(send !== -1 && rec !== -1, 'both calls present');
    assert.ok(send < rec, 'the record must come after the send');
    assert.match(handler, /if\s*\(sent\)/, 'the record is gated on the send having succeeded');
  });

  await t.test('the backend only accepts type "note", so that is what we write', () => {
    const fn = slice(apiSrc, 'async recordInvoiceSend', '\n  },');
    assert.match(fn, /type:\s*'note'/);
    assert.doesNotMatch(fn, /type:\s*'invoice_sent'/, 'a custom type is rejected with a 400');
    assert.match(fn, /kind:\s*INVOICE_SENT_KIND/);
  });

  // A green "sent" over a cell that still reads "Not recorded" teaches the owner
  // to distrust the column. Both facts, one message.
  await t.test('a send whose record failed does not report a bare success', () => {
    assert.match(handler, /Toast\.warning/);
    assert.match(handler, /could not be recorded/i);
  });

  await t.test('an unrecorded send does NOT optimistically flip the cell', () => {
    assert.match(handler, /if\s*\(recordedAt\)/);
  });

  await t.test('the resend repaints in place and never reloads the list', () => {
    assert.match(handler, /patchSentCell\(/);
    // A comment explaining why we don't reload is not a reload.
    assert.doesNotMatch(handler, /^\s*loadOrders\(\);/m, 'a reload would drop the bulk selection');
  });
});

// ---------------------------------------------------------------------------
test('the three surfaces', async (t) => {
  await t.test('the column exists and carries NO gst slot', () => {
    const col = slice(ordersSrc, "key: '_invoice_sent'", '},');
    // RENAMED 2026-09-03 (ERR-201). The cell answers two questions now — has the
    // invoice been emailed, and is a customer waiting on tracking — and a header
    // naming only one of them makes the other look like a rendering fault. The
    // key stays `_invoice_sent` because the invoice half is still what owns the
    // cell's hydration; only the human-facing label widened.
    assert.match(col, /label:\s*'Invoice \/ tracking'/);
    // Blank `gst` means "basis undocumented" for a MONEY header (utils/gst-basis.js).
    // A date must not borrow that vocabulary.
    assert.doesNotMatch(col, /\bgst:/);
    assert.doesNotMatch(col, /sortable/, 'the data is not on the list payload');
  });

  await t.test('the column is not owner-gated — an invoice is not cost data', () => {
    const gate = slice(ordersSrc, 'AdminAuth.isOwner() ? COLUMNS', ',');
    assert.match(gate, /_profit/);
    assert.doesNotMatch(gate, /_invoice_sent/);
  });

  await t.test('hydration runs after setData and is never awaited', () => {
    const call = ordersSrc.search(/^\s*hydrateInvoiceSent\(rows\);/m);
    assert.ok(call !== -1, 'the hydration is actually called');
    assert.ok(ordersSrc.indexOf('_table.setData(rows, pagination)') < call,
      'the table must paint from the list payload first (ERR-121)');
    assert.doesNotMatch(ordersSrc, /await\s+hydrateInvoiceSent/);
  });

  await t.test('the lookup is abortable and cleared on teardown', () => {
    const destroy = slice(ordersSrc, 'function destroyOrdersTab', '\n}');
    assert.match(destroy, /_sentAbort\?\.abort\(\)/);
    assert.match(destroy, /_sentCache\.clear\(\)/);
  });

  // Found in the browser, not by these tests: FAILED is deliberately not cached
  // (so a reload retries), and patchSentCell used to re-read the cache — so it
  // found nothing for exactly those rows and repainted them as "Checking…".
  // A spinner that never resolves hides a failed lookup even better than a wrong
  // answer would. The info must be handed in, not looked up.
  await t.test('the cell repaint takes its state explicitly, not from the cache', () => {
    assert.match(ordersSrc, /function patchSentCell\(row, info = _sentCache\.get\(row\?\.id\)\)/);
    const hyd = slice(ordersSrc, 'async function hydrateInvoiceSent', '\n}');
    assert.match(hyd, /patchSentCell\(row, info\)/, 'hydration must pass the resolved state through');
  });

  await t.test('a FAILED lookup is never cached as an answer', () => {
    const hyd = slice(ordersSrc, 'async function hydrateInvoiceSent', '\n}');
    assert.match(hyd, /!==\s*SENT_STATE\.FAILED/);
  });

  await t.test('the modal row is unconditional — absence IS the fact', () => {
    assert.match(ordersSrc, /<span>Invoice sent<\/span>/);
    const region = slice(ordersSrc, "if (o.cancelled_at) datesRows", 'Shipping address');
    assert.doesNotMatch(region, /if\s*\([^)]*\)\s*datesRows \+= `<div class="om-meta-row"><span>Invoice sent/);
  });

  // The latent bug this work uncovered: getOrderEvents returns null on failure
  // and [] when there is genuinely no history. `events || []` collapsed them, so
  // a failed load rendered as "nothing ever happened to this order".
  await t.test('a failed history load is told apart from an empty one', () => {
    assert.match(ordersSrc, /if\s*\(events === null\)/);
    assert.doesNotMatch(ordersSrc, /buildOrderModalContent\(modal, o, events \|\| \[\]/);
    assert.match(ordersSrc, /not proof that nothing\s*\n?\s*\*?\s*happened|read error, not proof/);
  });

  await t.test('a send in the timeline reads as a send, not as "note"', () => {
    const tl = slice(ordersSrc, 'const isSend = isInvoiceSendEvent(ev)', 'timelineHtml += `</div></div>`');
    assert.match(tl, /Invoice email sent/);
    assert.match(tl, /invoiceSendNoteText\(ev\)/, 'the sentinel must be stripped');
  });
});

// ---------------------------------------------------------------------------
test('the send history', async (t) => {

  await t.test('the count renders only past one send', () => {
    const cell = slice(ordersSrc, 'function sentCellHtml', 'function renderOrderSendHistory');
    assert.match(cell, /n > 1 \?/, '×1 over a single send states a fact we would be inventing');
    assert.match(cell, /order-sent__times/);
  });

  await t.test('the SENT cell is a button; the other states are not', () => {
    const cell = slice(ordersSrc, 'function sentCellHtml', 'function renderOrderSendHistory');
    assert.match(cell, /<button type="button" class="order-sent order-sent--yes"/);
    assert.match(cell, /data-action="sent-history"/);
    // The three no-send states share the `open()` span helper — nothing to open.
    const tail = cell.slice(cell.indexOf('// FAILED is styled apart'));
    assert.doesNotMatch(tail, /<button/);
  });

  await t.test('the button gets its chrome stripped and a focus ring', () => {
    assert.match(cssSrc, /button\.order-sent\s*\{[^}]*background:\s*none/);
    assert.match(cssSrc, /button\.order-sent:focus-visible/);
    assert.match(cssSrc, /\.order-sent__times\s*\{/);
  });

  // "3 recorded sends" is a floor, not a total: the checkout email is recorded
  // nowhere, so claiming a total would assert something never established.
  await t.test('the copy says "recorded sends", never "sent N times"', () => {
    const cell = slice(ordersSrc, 'function sentCellHtml', 'function renderOrderSendHistory');
    assert.match(cell, /recorded send/);
    assert.doesNotMatch(ordersSrc, /sent \$\{[^}]*\} times/);
  });

  await t.test('a failed read never renders as "no sends"', () => {
    const fn = slice(ordersSrc, 'function renderOrderSendHistory', 'function openOrderSendHistory');
    assert.match(fn, /SENT_STATE\.FAILED/);
    assert.match(fn, /not proof that nothing went out/);
    // The error branch must come BEFORE the empty branch, or a FAILED lookup
    // with an empty list would fall through and read as "never sent".
    assert.ok(fn.indexOf('inv-hist__error') < fn.indexOf('inv-hist__empty'));
  });

  await t.test('the panel always names the unrecorded checkout email', () => {
    const fn = slice(ordersSrc, 'function renderOrderSendHistory', 'function openOrderSendHistory');
    assert.match(fn, /automatically at checkout/);
    // The caveat rides both the populated list and the empty state.
    assert.equal((fn.match(/\$\{caveat\}/g) || []).length, 2);
  });

  await t.test('a truncated scan is surfaced, never silently under-counted', () => {
    const fn = slice(ordersSrc, 'function renderOrderSendHistory', 'function openOrderSendHistory');
    assert.match(fn, /info\.truncated/);
    assert.match(fn, /may be incomplete/);
  });

  await t.test('the panel renders from cache — no fetch, so no stale-modal guard', () => {
    const fn = slice(ordersSrc, 'function openOrderSendHistory', '\n}');
    assert.doesNotMatch(fn, /await|AdminAPI\./, 'info.sends is already in hand');
  });

  await t.test('the batch reader keeps every send and reports truncation', () => {
    const fn = slice(apiSrc, 'async getInvoiceSendEventsByOrderIds', 'async recordInvoiceSend');
    assert.match(fn, /bucket\.push\(row\)/, 'an array per order, not the first hit');
    assert.doesNotMatch(fn, /if \(!byOrderId\.has\(key\)\) byOrderId\.set/);
    assert.match(fn, /truncated = true/);
    assert.match(fn, /return \{ byOrderId, failed, truncated \}/);
  });

  // Rebuilding from the one new send would reset the count to 1 on every
  // resend — the column would contradict itself until the next reload.
  await t.test('a resend APPENDS to the send list rather than replacing it', () => {
    const handler = slice(
      ordersSrc,
      "modal.querySelector('[data-action=\"resend-invoice\"]')",
      '// Same vocabulary as the button');
    assert.match(handler, /_sentCache\.get\(order\.id\)/, 'the prior state is read back');
    assert.match(handler, /\.\.\.\(prior\?\.sends \|\| \[\]\)/, 'and spread into the new one');
  });

  await t.test('the writer no longer sends a field the backend discards', () => {
    const fn = slice(apiSrc, 'async recordInvoiceSend', '\n  },');
    assert.doesNotMatch(fn, /payload: \{ kind: INVOICE_SENT_KIND, at,/);
    assert.match(fn, /stores `note` AND NOTHING ELSE/i, 'and says why, so nobody re-adds them');
  });

  await t.test('the detail panel opens the same panel as the list', () => {
    assert.match(ordersSrc, /data-action="om-sent-history"/);
    // Delegated on the modal: a resend replaces the cell's innerHTML, which
    // would discard a listener bound to the button itself.
    assert.match(ordersSrc, /modal\.addEventListener\('click'[\s\S]{0,220}om-sent-history/);
  });
});

// ---------------------------------------------------------------------------
test('the copy and the styling keep the states apart', async (t) => {
  await t.test('"Not recorded" says it means no record, never "nothing was sent"', () => {
    const tip = slice(ordersSrc, 'const SENT_TIP', '});');
    assert.match(tip, /does NOT mean none was sent/);
  });

  await t.test('a failed lookup says so, and says it is not "never sent"', () => {
    const tip = slice(ordersSrc, 'const SENT_TIP', '});');
    assert.match(tip, /lookup failed/i);
    assert.match(tip, /NOT "never sent"/);
  });

  await t.test('"Not recorded" and the failed state are different colours', () => {
    assert.match(cssSrc, /\.order-sent--none[^{]*\{[^}]*var\(--text-muted\)/);
    assert.match(cssSrc, /\.order-sent--failed\s*\{[^}]*var\(--yellow-text\)/);
  });

  await t.test('the sent cell is legible on the light deck', () => {
    assert.match(cssSrc, /\.admin\[data-theme="light"\]\s*\.order-sent--yes/);
  });
});

// ---------------------------------------------------------------------------
test('shipping hygiene', async (t) => {
  await t.test('APP_VERSION advanced so the edited page module is re-fetched', () => {
    // Never pin a literal version (ERR-067) — pin the shape and that it moved.
    assert.match(appSrc, /const APP_VERSION = '20\d\d\.\d\d\.\d\d-[a-z0-9-]+'/);
    assert.doesNotMatch(appSrc, /APP_VERSION = '2026\.08\.28-invoice-shipping-line'/);
  });

  await t.test('no `?v=` token was added to a static import (ERR-124)', () => {
    assert.doesNotMatch(ordersSrc, /from '\.\.\/(api|utils\/order-invoice-sent)\.js\?v=/);
  });

  await t.test('the probe is read-only and lives outside the served tree', () => {
    assert.ok(fs.existsSync(PROBE), 'scripts/probe-invoice-sent.mjs exists');
    const probe = fs.readFileSync(PROBE, 'utf8');
    assert.match(probe, /MODE: READ-ONLY/, 'the mode is printed on every run');
    // Assert the BEHAVIOUR, not the prose: the doc-comment legitimately mentions
    // --record in order to say it has none. What must not exist is a non-GET.
    assert.doesNotMatch(probe, /method:\s*'(PATCH|PUT|DELETE)'/,
      'a read-only probe never mutates');
    assert.equal((probe.match(/method:\s*'POST'/g) || []).length, 1,
      'exactly one POST, and it is the admin sign-in');
    assert.ok(!fs.existsSync(path.join(ROOT, 'inkcartridges', 'scripts', 'probe-invoice-sent.mjs')),
      'must not be in the publicly served tree — it reads .env');
  });
});
