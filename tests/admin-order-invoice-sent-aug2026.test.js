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

  await t.test('a server stamp is a send, and wins attribution', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: '2026-08-20T02:00:00Z', invoice_number: 'INV-2026-0100' },
      event: { created_at: '2026-08-21T02:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
    });
    assert.equal(info.state, SENT_STATE.SENT);
    assert.equal(info.source, 'server');
    assert.equal(info.at, '2026-08-20T02:00:00Z');
    assert.equal(info.invoiceNumber, 'INV-2026-0100');
  });

  await t.test('our own record answers when the server has none', () => {
    const info = resolveSentInfo({
      invoice: { emailed_at: null, invoice_number: 'INV-1' },
      event: { created_at: '2026-08-21T02:00:00Z', payload: { kind: INVOICE_SENT_KIND } },
    });
    assert.equal(info.state, SENT_STATE.SENT);
    assert.equal(info.source, 'admin');
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
    assert.match(col, /label:\s*'Invoice sent'/);
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
